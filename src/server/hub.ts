/**
 * Runtime-neutral connection handling for one session.
 *
 * Both adapters wrap their sockets in a `HubHost` and forward every incoming
 * frame and every close to a `Hub`, which owns everything SPEC.md lists under
 * "Connection handling": the `hello` handshake and presenter check, message
 * size limits, the audience rate limit, ping/pong, applying messages to the
 * Room, and coalesced broadcasts plus persistence. Adapters only move bytes
 * and store data.
 */
import { PROTOCOL_VERSION, type ErrorCode, type Role, type ServerMessage } from "../shared/protocol";
import { keyMatches } from "./auth";
import { AUDIENCE_LIMIT, TokenBucket } from "./ratelimit";
import type { Room } from "./room";
import { parseMessage } from "./validate";

/** Exact heartbeat strings. Cloudflare answers these without waking the object. */
export const PING = '{"t":"ping"}';
export const PONG = '{"t":"pong"}';

/** Maximum frame size in UTF-8 bytes, by role (sockets that have not said hello count as audience). */
export const MAX_BYTES: Record<Role, number> = { audience: 4 * 1024, deck: 32 * 1024 };

/** At most one `deck` and one `audience` broadcast per session per interval. */
export const BROADCAST_INTERVAL_MS = 200;

/** WebSocket close code for an unsupported protocol version. */
export const CLOSE_VERSION = 4000;

/** What a socket established with `hello`. */
export interface PeerInfo {
  role: Role;
  voter: string;
  presenter: boolean;
}

/** The adapter's side of the contract. `P` is the adapter's socket handle. */
export interface HubHost<P extends object> {
  /** Every open socket in this session (hello'd or not). */
  peers(): Iterable<P>;
  /** The info stored by `setInfo`, or null before `hello`. */
  info(peer: P): PeerInfo | null;
  setInfo(peer: P, info: PeerInfo): void;
  /** Send a text frame. May throw if the socket is closing; the hub catches. */
  send(peer: P, data: string): void;
  close(peer: P, code: number, reason: string): void;
  /**
   * Store the room after it changed: all of it (`room.dump()`) or only the
   * changes (`room.takeChanges()`). Called from the broadcast flush; must
   * not throw.
   */
  persist(room: Room): void;
  /** Run `fn` after `ms` milliseconds. */
  schedule(fn: () => void, ms: number): void;
  now(): number;
  /** PRESENTER_KEY; unset means nobody is a presenter. */
  readonly presenterKey: string | undefined;
}

const encoder = new TextEncoder();

function byteLength(s: string): number {
  // Cheap bounds first: UTF-16 length <= bytes <= 3 * UTF-16 length.
  return s.length * 3 <= MAX_BYTES.audience ? s.length : encoder.encode(s).length;
}

export class Hub<P extends object> {
  private readonly buckets = new WeakMap<P, TokenBucket>();
  private scheduled = false;
  private lastFlush = Number.NEGATIVE_INFINITY;
  private dirtyRoom = false;
  private dirtyMineAll = false;
  /** Last broadcast payloads, so unchanged states are not re-sent. */
  private sent: { deck?: string; presenter?: string; audience?: string } = {};
  /** voter → their audience sockets, so `you` doesn't scan every socket. Built on first use. */
  private byVoter: Map<string, Set<P>> | null = null;

  constructor(
    readonly room: Room,
    private readonly host: HubHost<P>,
  ) {}

  /** Handle one incoming frame. */
  message(peer: P, data: string | ArrayBuffer | ArrayBufferView): void {
    if (typeof data !== "string") return this.error(peer, "bad-message", "binary frames are not supported");
    if (data === PING) return this.send(peer, PONG);
    const info = this.host.info(peer);
    const role = info?.role ?? "audience";
    if (data.length > MAX_BYTES[role] || byteLength(data) > MAX_BYTES[role]) {
      return this.error(peer, "bad-message", `messages are limited to ${MAX_BYTES[role]} bytes`);
    }
    if (role !== "deck") {
      let bucket = this.buckets.get(peer);
      if (!bucket) this.buckets.set(peer, (bucket = new TokenBucket(AUDIENCE_LIMIT, this.host.now())));
      if (!bucket.take(this.host.now())) return this.error(peer, "limit", "too many messages; slow down");
    }
    const parsed = parseMessage(data);
    if (!parsed.ok) return this.error(peer, "bad-message", parsed.message);
    const msg = parsed.msg;
    if (msg.t === "ping") return this.send(peer, PONG);
    if (msg.t === "hello") {
      if (info) return this.error(peer, "bad-message", "hello was already sent on this socket");
      if (msg.v !== PROTOCOL_VERSION) {
        this.error(peer, "version", `server speaks protocol version ${PROTOCOL_VERSION}`);
        try {
          this.host.close(peer, CLOSE_VERSION, "unsupported protocol version");
        } catch {
          // already closing
        }
        return;
      }
      const presenter = msg.role === "deck" && keyMatches(msg.key, this.host.presenterKey);
      const next: PeerInfo = { role: msg.role, voter: msg.voter, presenter };
      this.host.setInfo(peer, next);
      if (next.role === "audience") this.addVoter(peer, next.voter);
      this.send(peer, JSON.stringify({ t: "welcome", v: PROTOCOL_VERSION, presenter } satisfies ServerMessage));
      if (next.role === "deck") {
        this.send(peer, this.deckPayload(presenter, this.audienceCount()));
      } else {
        this.send(peer, this.audiencePayload());
        this.send(peer, this.minePayload(next.voter));
        this.schedule(); // decks show the audience count
      }
      return;
    }
    if (!info) return this.error(peer, "not-hello", "send hello first");
    const outcome = this.room.apply(info, msg);
    if (!outcome.ok) return this.error(peer, outcome.code, outcome.message);
    if (outcome.mineChanged && info.role === "audience") this.sendMine(info.voter);
    if (outcome.allMineChanged) this.dirtyMineAll = true;
    if (outcome.changed) {
      this.dirtyRoom = true;
      this.schedule();
    }
  }

  /** A socket closed. Decks get a new audience count. */
  disconnected(peer: P): void {
    const info = this.host.info(peer);
    if (info?.role !== "audience") return;
    const sockets = this.byVoter?.get(info.voter);
    if (sockets?.delete(peer) && sockets.size === 0) this.byVoter!.delete(info.voter);
    this.schedule();
  }

  /** Broadcast changed states and persist. Normally called by the scheduler. */
  flush(): void {
    this.scheduled = false;
    this.lastFlush = this.host.now();
    if (this.dirtyRoom) {
      this.dirtyRoom = false;
      this.host.persist(this.room);
    }
    const decks: Array<[P, PeerInfo]> = [];
    const phones: Array<[P, PeerInfo]> = [];
    for (const peer of this.host.peers()) {
      const info = this.host.info(peer);
      if (info?.role === "deck") decks.push([peer, info]);
      else if (info?.role === "audience") phones.push([peer, info]);
    }
    const viewer = this.deckPayload(false, phones.length);
    const presenter = this.deckPayload(true, phones.length);
    const audience = this.audiencePayload();
    const sendDeck = viewer !== this.sent.deck;
    const sendPresenter = presenter !== this.sent.presenter;
    const sendAudience = audience !== this.sent.audience;
    this.sent = { deck: viewer, presenter, audience };
    for (const [peer, info] of decks) {
      if (info.presenter ? sendPresenter : sendDeck) this.send(peer, info.presenter ? presenter : viewer);
    }
    const mine = new Map<string, string>();
    const sendMineAll = this.dirtyMineAll;
    this.dirtyMineAll = false;
    for (const [peer, info] of phones) {
      if (sendAudience) this.send(peer, audience);
      if (sendMineAll) {
        let payload = mine.get(info.voter);
        if (payload === undefined) mine.set(info.voter, (payload = this.minePayload(info.voter)));
        this.send(peer, payload);
      }
    }
  }

  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    const wait = Math.max(0, this.lastFlush + BROADCAST_INTERVAL_MS - this.host.now());
    this.host.schedule(() => this.flush(), wait);
  }

  private audienceCount(): number {
    let n = 0;
    for (const peer of this.host.peers()) if (this.host.info(peer)?.role === "audience") n++;
    return n;
  }

  private deckPayload(presenter: boolean, audience: number): string {
    return JSON.stringify({ t: "deck", state: this.room.deckState(presenter, audience) } satisfies ServerMessage);
  }

  private audiencePayload(): string {
    return JSON.stringify({ t: "audience", state: this.room.audienceState() } satisfies ServerMessage);
  }

  private minePayload(voter: string): string {
    return JSON.stringify({ t: "you", mine: this.room.mine(voter) } satisfies ServerMessage);
  }

  private sendMine(voter: string): void {
    const sockets = this.voters().get(voter);
    if (!sockets) return;
    const payload = this.minePayload(voter);
    for (const peer of sockets) this.send(peer, payload);
  }

  /**
   * The voter index. Built from `peers()` the first time, because a Durable
   * Object waking from hibernation gets a new Hub with sockets that already
   * said hello; `hello` and `disconnected` keep it current after that.
   */
  private voters(): Map<string, Set<P>> {
    if (!this.byVoter) {
      this.byVoter = new Map();
      for (const peer of this.host.peers()) {
        const info = this.host.info(peer);
        if (info?.role === "audience") this.addVoter(peer, info.voter);
      }
    }
    return this.byVoter;
  }

  private addVoter(peer: P, voter: string): void {
    const index = this.voters();
    let sockets = index.get(voter);
    if (!sockets) index.set(voter, (sockets = new Set()));
    sockets.add(peer);
  }

  private error(peer: P, code: ErrorCode, message: string): void {
    this.send(peer, JSON.stringify({ t: "error", code, message } satisfies ServerMessage));
  }

  private send(peer: P, data: string): void {
    try {
      this.host.send(peer, data);
    } catch {
      // The socket is closing; its close event will follow.
    }
  }
}

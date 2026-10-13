import { beforeEach, describe, expect, test } from "bun:test";
import type { ServerMessage } from "../shared/protocol";
import { BROADCAST_INTERVAL_MS, Hub, PING, PONG, type HubHost, type PeerInfo } from "./hub";
import { Room, type RoomData } from "./room";

class FakePeer {
  inbox: string[] = [];
  closed: number | null = null;
  messages(): ServerMessage[] {
    return this.inbox.filter((m) => m !== PONG).map((m) => JSON.parse(m));
  }
  take(): ServerMessage[] {
    const m = this.messages();
    this.inbox = [];
    return m;
  }
}

class FakeHost implements HubHost<FakePeer> {
  presenterKey: string | undefined = "secret";
  clock = 0;
  timers: Array<{ at: number; fn: () => void }> = [];
  saved: RoomData[] = [];
  readonly all = new Set<FakePeer>();
  private readonly infos = new Map<FakePeer, PeerInfo>();
  peers() {
    return this.all;
  }
  info(p: FakePeer) {
    return this.infos.get(p) ?? null;
  }
  setInfo(p: FakePeer, i: PeerInfo) {
    this.infos.set(p, i);
  }
  send(p: FakePeer, data: string) {
    p.inbox.push(data);
  }
  close(p: FakePeer, code: number) {
    p.closed = code;
  }
  persist(d: RoomData) {
    this.saved.push(d);
  }
  schedule(fn: () => void, ms: number) {
    this.timers.push({ at: this.clock + ms, fn });
  }
  now() {
    return this.clock;
  }
  /** Advance the clock, running due timers. */
  advance(ms: number) {
    this.clock += ms;
    const due = this.timers.filter((t) => t.at <= this.clock);
    this.timers = this.timers.filter((t) => t.at > this.clock);
    for (const t of due) t.fn();
  }
}

let host: FakeHost;
let hub: Hub<FakePeer>;
const connect = () => {
  const p = new FakePeer();
  host.all.add(p);
  return p;
};
const send = (p: FakePeer, msg: unknown) => hub.message(p, typeof msg === "string" ? msg : JSON.stringify(msg));
const hello = (p: FakePeer, role: "deck" | "audience", voter: string, key?: string) =>
  send(p, { t: "hello", v: 1, role, voter, key });
const poll = { type: "poll", id: "q1", prompt: "P", options: ["a", "b"] };

beforeEach(() => {
  host = new FakeHost();
  hub = new Hub(Room.create("s1"), host);
});

describe("Hub", () => {
  test("hello: welcome plus initial state, presenter by key only", () => {
    const deck = connect();
    hello(deck, "deck", "d1", "secret");
    const [welcome, state] = deck.take();
    expect(welcome).toEqual({ t: "welcome", v: 1, presenter: true });
    expect(state?.t).toBe("deck");

    const viewer = connect();
    hello(viewer, "deck", "d2", "wrong");
    expect(viewer.take()[0]).toEqual({ t: "welcome", v: 1, presenter: false });

    const phone = connect();
    hello(phone, "audience", "v1", "secret");
    expect(phone.take().map((m) => m.t)).toEqual(["welcome", "audience", "you"]);
  });

  test("no presenter when PRESENTER_KEY is unset", () => {
    host.presenterKey = undefined;
    const deck = connect();
    hello(deck, "deck", "d1", "");
    expect(deck.take()[0]).toEqual({ t: "welcome", v: 1, presenter: false });
  });

  test("errors: not-hello, version, bad-message, forbidden", () => {
    const p = connect();
    send(p, { t: "vote", id: "q1", choice: 0 });
    expect(p.take()[0]).toMatchObject({ t: "error", code: "not-hello" });
    send(p, "{not json");
    expect(p.take()[0]).toMatchObject({ t: "error", code: "bad-message" });
    send(p, { t: "hello", v: 2, role: "audience", voter: "v" });
    expect(p.take()[0]).toMatchObject({ t: "error", code: "version" });
    expect(p.closed).toBe(4000);

    const q = connect();
    hello(q, "audience", "v1");
    q.take();
    send(q, { t: "open", question: poll });
    expect(q.take()[0]).toMatchObject({ t: "error", code: "forbidden" });
    hello(q, "audience", "v1");
    expect(q.take()[0]).toMatchObject({ t: "error", code: "bad-message" });
  });

  test("ping strings get pong", () => {
    const p = connect();
    hub.message(p, PING);
    send(p, { t: "ping" });
    expect(p.inbox).toEqual([PONG, PONG]);
  });

  test("size limits: 4 KB audience, 32 KB deck", () => {
    const phone = connect();
    hello(phone, "audience", "v1");
    phone.take();
    send(phone, { t: "answer", id: "q1", text: "x".repeat(5000) });
    expect(phone.take()[0]).toMatchObject({ t: "error", code: "bad-message" });
    const deck = connect();
    hello(deck, "deck", "d1", "secret");
    deck.take();
    send(deck, { t: "open", question: { ...poll, prompt: "x".repeat(400), options: Array(20).fill("é".repeat(200)) } });
    // ~8 KB: allowed for decks (fails validation only on option length, not size)
    expect(deck.take().find((m) => m.t === "error")).toBeUndefined();
    send(deck, { t: "hide", id: "q1", text: "x".repeat(40_000), hidden: true });
    expect(deck.take()[0]).toMatchObject({ t: "error", code: "bad-message", message: expect.stringContaining("32768") });
  });

  test("audience rate limit: burst 20 then limit errors", () => {
    const deck = connect();
    hello(deck, "deck", "d1", "secret");
    send(deck, { t: "open", question: poll });
    const phone = connect();
    hello(phone, "audience", "v1"); // 1 token
    phone.take();
    for (let i = 0; i < 19; i++) send(phone, { t: "vote", id: "q1", choice: i % 2 });
    expect(phone.messages().some((m) => m.t === "error")).toBe(false);
    phone.take();
    send(phone, { t: "vote", id: "q1", choice: 0 });
    expect(phone.take()[0]).toMatchObject({ t: "error", code: "limit" });
    host.clock += 1000;
    send(phone, { t: "vote", id: "q1", choice: 1 });
    expect(phone.take().map((m) => m.t)).toEqual(["you"]);
  });

  test("broadcasts are coalesced to one per interval and persisted in the flush", () => {
    const deck = connect();
    hello(deck, "deck", "d1", "secret");
    send(deck, { t: "open", question: poll });
    const phones = Array.from({ length: 3 }, (_, i) => {
      const p = connect();
      hello(p, "audience", `v${i}`);
      return p;
    });
    host.advance(0);
    expect(host.saved.length).toBe(1);
    deck.take();
    for (const p of phones) p.take();

    phones.forEach((p, i) => send(p, { t: "vote", id: "q1", choice: i % 2 }));
    // `you` goes out immediately, only to the voter
    expect(phones[0]!.take()).toEqual([{ t: "you", mine: { votes: { q1: 0 }, answers: {}, ratings: {} } }]);
    expect(deck.take()).toEqual([]);
    host.advance(BROADCAST_INTERVAL_MS - 1);
    expect(deck.take()).toEqual([]);
    host.advance(1);
    const decks = deck.take();
    expect(decks.length).toBe(1);
    expect(decks[0]).toMatchObject({ t: "deck", state: { audience: 3, questions: { q1: { results: { counts: [2, 1] } } } } });
    // Audience state is unchanged while voting is open (results withheld), so phones get nothing.
    expect(phones[1]!.take()).toEqual([{ t: "you", mine: { votes: { q1: 1 }, answers: {}, ratings: {} } }]);
    expect(host.saved.length).toBe(2);

    phones[2]!.take();
    send(deck, { t: "close", id: "q1" });
    host.advance(BROADCAST_INTERVAL_MS);
    expect(phones[2]!.take()).toMatchObject([{ t: "audience", state: { live: { status: "closed" } } }]);
  });

  test("reset sends every phone a fresh `you`", () => {
    const deck = connect();
    hello(deck, "deck", "d1", "secret");
    send(deck, { t: "open", question: poll });
    const phone = connect();
    hello(phone, "audience", "v1");
    send(phone, { t: "vote", id: "q1", choice: 1 });
    host.advance(1000);
    phone.take();
    send(deck, { t: "reset", id: "q1" });
    host.advance(1000);
    expect(phone.take().filter((m) => m.t === "you")).toEqual([{ t: "you", mine: { votes: {}, answers: {}, ratings: {} } }]);
  });

  test("ratings: `you` right away, results to decks in the next flush", () => {
    const likert = { type: "likert", id: "l1", prompt: "P", statements: ["s1", "s2"], labels: ["0", "1", "2"], numeric: true, anchors: null };
    const deck = connect();
    hello(deck, "deck", "d1", "secret");
    send(deck, { t: "open", question: likert });
    const phone = connect();
    hello(phone, "audience", "v1");
    host.advance(1000);
    deck.take();
    phone.take();
    send(phone, { t: "rate", id: "l1", statement: 1, choice: 2 });
    expect(phone.take()).toEqual([{ t: "you", mine: { votes: {}, answers: {}, ratings: { l1: [null, 2] } } }]);
    host.advance(BROADCAST_INTERVAL_MS);
    expect(deck.take()).toMatchObject([{ t: "deck", state: { questions: { l1: { results: { counts: [[0, 0, 0], [0, 0, 1]], voters: 1 } } } } }]);
  });

  test("audience count updates when phones leave", () => {
    const deck = connect();
    hello(deck, "deck", "d1");
    const phone = connect();
    hello(phone, "audience", "v1");
    host.advance(1000);
    expect(deck.take().at(-1)).toMatchObject({ t: "deck", state: { audience: 1 } });
    host.all.delete(phone);
    hub.disconnected(phone);
    host.advance(1000);
    expect(deck.take()).toMatchObject([{ t: "deck", state: { audience: 0 } }]);
  });
});

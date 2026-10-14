/**
 * Cloudflare entry: a Worker running the shared Hono routes, and one
 * `SessionRoom` Durable Object per session holding that session's sockets and
 * Room. The object uses the WebSocket hibernation API, so an idle session
 * costs nothing and heartbeats never wake it.
 */
import { DurableObject } from "cloudflare:workers";
import { createApp } from "../app";
import { Hub, PING, PONG, type HubHost, type PeerInfo } from "../hub";
import { Room, type QuestionData, type RoomData } from "../room";
import type { QuestionId } from "../../shared/protocol";
import { isSession } from "../validate";

export interface Env {
  ROOMS: DurableObjectNamespace<SessionRoom>;
  ASSETS: Fetcher;
  PRESENTER_KEY?: string;
}

/** Header carrying the session name from the Worker to its Durable Object. */
const SESSION_HEADER = "x-live-questions-session";

/**
 * Storage layout: a small index plus one key per question, and each flush
 * writes only what changed. Cloudflare caps a stored key and value at 2 MB,
 * so one whole-room value stopped saving at a few thousand voters.
 */
const INDEX_KEY = "index";
const QUESTION_PREFIX = "q:";
/** The whole room as one value, as stored by 1.1.1 and earlier. Migrated on load. */
const LEGACY_KEY = "room";
/** Most keys one storage `put` or `delete` call accepts. */
const MAX_KEYS = 128;

interface StoredIndex {
  v: 2;
  live: QuestionId | null;
  order: QuestionId[];
}

const questionKey = (id: QuestionId) => QUESTION_PREFIX + id;

function chunks<T>(items: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += MAX_KEYS) out.push(items.slice(i, i + MAX_KEYS));
  return out;
}

/** Per-socket state kept across hibernation via `serializeAttachment`. */
interface Attachment {
  session: string;
  info: PeerInfo | null;
}

function toRoom(env: Env, session: string, path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  headers.set(SESSION_HEADER, session);
  return env.ROOMS.getByName(session).fetch(new Request(`https://room${path}`, { ...init, headers }));
}

const app = createApp<{ Bindings: Env }>({
  presenterKey: (c) => c.env.PRESENTER_KEY || undefined,
  socket: (c, session) => toRoom(c.env, session, "/ws", { headers: c.req.raw.headers }),
  exportRoom: async (c, session) => (await toRoom(c.env, session, "/export")).json(),
  asset: (c, path) => c.env.ASSETS.fetch(new URL(path, c.req.url)),
});

export default {
  fetch: (request, env, ctx) => app.fetch(request, env, ctx),
} satisfies ExportedHandler<Env>;

export class SessionRoom extends DurableObject<Env> implements HubHost<WebSocket> {
  /** What `load` read, for `Room.restore`. */
  private stored: unknown;
  private hub: Hub<WebSocket> | undefined;
  /** Decoded attachments, so broadcasts don't deserialize every socket each time. */
  private readonly attachments = new Map<WebSocket, Attachment>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
    void ctx.blockConcurrencyWhile(async () => {
      this.stored = await this.load();
    });
  }

  /** Read the room in the shape `Room.restore` accepts, migrating the legacy layout. */
  private async load(): Promise<unknown> {
    const storage = this.ctx.storage;
    const index = await storage.get<StoredIndex>(INDEX_KEY);
    if (index) {
      const stored = await storage.list<QuestionData>({ prefix: QUESTION_PREFIX });
      const order = Array.isArray(index.order) ? index.order : [];
      return { live: index.live, questions: order.map((id) => stored.get(questionKey(id))) };
    }
    const legacy = await storage.get<RoomData>(LEGACY_KEY);
    if (legacy) await this.migrate(legacy);
    return legacy;
  }

  /** Rewrite a legacy whole-room value as index plus questions. */
  private async migrate(legacy: RoomData): Promise<void> {
    const questions = Array.isArray(legacy.questions) ? legacy.questions : [];
    const entries: Array<[string, unknown]> = [];
    const order: QuestionId[] = [];
    for (const q of questions) {
      const id = q?.question?.id;
      if (typeof id !== "string") continue; // restore drops it too
      order.push(id);
      entries.push([questionKey(id), q]);
    }
    const index: StoredIndex = { v: 2, live: legacy.live ?? null, order };
    entries.push([INDEX_KEY, index]);
    // No await between these, so the writes commit together.
    const writes = chunks(entries).map((c) => this.ctx.storage.put(Object.fromEntries(c)));
    writes.push(this.ctx.storage.delete(LEGACY_KEY).then(() => undefined));
    await Promise.all(writes);
  }

  get presenterKey(): string | undefined {
    return this.env.PRESENTER_KEY || undefined;
  }

  private hubFor(session: string): Hub<WebSocket> {
    this.hub ??= new Hub(Room.restore(session, this.stored), this);
    return this.hub;
  }

  override async fetch(request: Request): Promise<Response> {
    const session = request.headers.get(SESSION_HEADER);
    if (!isSession(session)) return new Response("missing session", { status: 400 });
    const { pathname } = new URL(request.url);
    if (pathname === "/export") return Response.json(this.hubFor(session).room.export());
    if (pathname !== "/ws" || request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("not found", { status: 404 });
    }
    if (!this.presenterKey && !this.hub) console.warn("live-questions: PRESENTER_KEY is not set, so nobody can present.");
    this.hubFor(session);
    const { 0: client, 1: server } = new WebSocketPair();
    // Role and voter arrive later in `hello`, and tags are fixed at accept
    // time, so per-socket state lives in the attachment instead.
    this.ctx.acceptWebSocket(server);
    this.setAttachment(server, { session, info: null });
    return new Response(null, { status: 101, webSocket: client });
  }

  override webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    const a = this.attachment(ws);
    if (a) this.hubFor(a.session).message(ws, message);
  }

  override webSocketClose(ws: WebSocket, code: number, reason: string): void {
    this.closed(ws);
    try {
      ws.close(code, reason);
    } catch {
      // already closed
    }
  }

  override webSocketError(ws: WebSocket): void {
    this.closed(ws);
  }

  private closed(ws: WebSocket): void {
    const a = this.attachment(ws);
    if (a) this.hubFor(a.session).disconnected(ws);
    this.attachments.delete(ws);
  }

  private attachment(ws: WebSocket): Attachment | null {
    let a = this.attachments.get(ws);
    if (!a) {
      const raw = ws.deserializeAttachment() as Attachment | null;
      if (!raw || !isSession(raw.session)) return null;
      a = raw;
      this.attachments.set(ws, a);
    }
    return a;
  }

  private setAttachment(ws: WebSocket, a: Attachment): void {
    ws.serializeAttachment(a);
    this.attachments.set(ws, a);
  }

  // HubHost

  peers(): Iterable<WebSocket> {
    return this.ctx.getWebSockets().filter((ws) => ws.readyState === WebSocket.OPEN);
  }
  info(ws: WebSocket): PeerInfo | null {
    return this.attachment(ws)?.info ?? null;
  }
  setInfo(ws: WebSocket, info: PeerInfo): void {
    const a = this.attachment(ws);
    if (a) this.setAttachment(ws, { ...a, info });
  }
  send(ws: WebSocket, data: string): void {
    ws.send(data);
  }
  close(ws: WebSocket, code: number, reason: string): void {
    ws.close(code, reason);
  }
  persist(room: Room): void {
    const { index, questions, removed } = room.takeChanges();
    const entries: Array<[string, unknown]> = questions.map((q) => [questionKey(q.question.id), q]);
    if (index) entries.push([INDEX_KEY, { v: 2, ...index } satisfies StoredIndex]);
    const storage = this.ctx.storage;
    const writes: Array<Promise<unknown>> = chunks(entries).map((c) => storage.put(Object.fromEntries(c)));
    for (const keys of chunks(removed.map(questionKey))) writes.push(storage.delete(keys));
    Promise.all(writes).catch((err: unknown) => {
      console.error(`live-questions: failed to save session ${room.session}:`, err);
    });
  }
  schedule(fn: () => void, ms: number): void {
    setTimeout(fn, ms);
  }
  now(): number {
    return Date.now();
  }
}

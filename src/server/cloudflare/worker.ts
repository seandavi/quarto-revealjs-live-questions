/**
 * Cloudflare entry: a Worker running the shared Hono routes, and one
 * `SessionRoom` Durable Object per session holding that session's sockets and
 * Room. The object uses the WebSocket hibernation API, so an idle session
 * costs nothing and heartbeats never wake it.
 */
import { DurableObject } from "cloudflare:workers";
import { createApp } from "../app";
import { Hub, PING, PONG, type HubHost, type PeerInfo } from "../hub";
import { Room, type RoomData } from "../room";
import { isSession } from "../validate";

export interface Env {
  ROOMS: DurableObjectNamespace<SessionRoom>;
  ASSETS: Fetcher;
  PRESENTER_KEY?: string;
}

/** Header carrying the session name from the Worker to its Durable Object. */
const SESSION_HEADER = "x-live-poll-session";

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
  private stored: RoomData | undefined;
  private hub: Hub<WebSocket> | undefined;
  /** Decoded attachments, so broadcasts don't deserialize every socket each time. */
  private readonly attachments = new Map<WebSocket, Attachment>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
    void ctx.blockConcurrencyWhile(async () => {
      this.stored = await ctx.storage.get<RoomData>("room");
    });
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
    if (!this.presenterKey && !this.hub) console.warn("live-poll: PRESENTER_KEY is not set, so nobody can present.");
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
  persist(data: RoomData): void {
    this.stored = data;
    this.ctx.storage.put("room", data).catch((err: unknown) => {
      console.error("live-poll: failed to save room:", err);
    });
  }
  schedule(fn: () => void, ms: number): void {
    setTimeout(fn, ms);
  }
  now(): number {
    return Date.now();
  }
}

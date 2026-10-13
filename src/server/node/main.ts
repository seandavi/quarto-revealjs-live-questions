/**
 * Node entry point (Docker). Bundled by `bun run build:node` to dist/server.js
 * and run with plain `node`.
 *
 * Environment:
 *   PORT           listen port (default 8787)
 *   PRESENTER_KEY  presenter secret; unset means nobody can present
 *   DATA_DIR       where <session>.json files live (default /data)
 *   PUBLIC_DIR     audience page files (default: ../public next to this file)
 */
import { serve, upgradeWebSocket, type WebSocketLike } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import type { WSContext } from "hono/ws";
import { createApp } from "../app";
import { Hub, MAX_BYTES, type HubHost, type PeerInfo } from "../hub";
import { Room, type RoomData } from "../room";

const PORT = Number(process.env.PORT ?? 8787);
const PRESENTER_KEY = process.env.PRESENTER_KEY || undefined;
const DATA_DIR = resolve(process.env.DATA_DIR ?? "/data");
const PUBLIC_DIR = resolve(
  process.env.PUBLIC_DIR ?? join(dirname(fileURLToPath(import.meta.url)), "..", "public"),
);
/** Unload a session this long after its last socket closes. */
const IDLE_UNLOAD_MS = 5 * 60 * 1000;

type Peer = WSContext<WebSocketLike>;

/** One session in memory: its hub, sockets and file writer. */
class Session implements HubHost<Peer> {
  readonly presenterKey = PRESENTER_KEY;
  readonly hub: Hub<Peer>;
  private readonly sockets = new Set<Peer>();
  private readonly infos = new WeakMap<Peer, PeerInfo>();
  private writing: Promise<void> = Promise.resolve();
  private pending: RoomData | null = null;
  private unloadTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    readonly name: string,
    room: Room,
  ) {
    this.hub = new Hub(room, this);
  }

  get file(): string {
    return join(DATA_DIR, `${this.name}.json`);
  }

  peers(): Iterable<Peer> {
    return this.sockets;
  }
  info(peer: Peer): PeerInfo | null {
    return this.infos.get(peer) ?? null;
  }
  setInfo(peer: Peer, info: PeerInfo): void {
    this.infos.set(peer, info);
  }
  send(peer: Peer, data: string): void {
    if (peer.readyState === 1) peer.send(data);
  }
  close(peer: Peer, code: number, reason: string): void {
    peer.close(code, reason);
  }
  schedule(fn: () => void, ms: number): void {
    setTimeout(fn, ms);
  }
  now(): number {
    return Date.now();
  }

  /** Atomic write (temp file + rename), serialized, latest state wins. */
  persist(data: RoomData): void {
    const idle = this.pending === null;
    this.pending = data;
    if (!idle) return; // a queued write will pick up the newer data
    this.writing = this.writing.then(async () => {
      const next = this.pending;
      this.pending = null;
      if (!next) return;
      const tmp = `${this.file}.${process.pid}.tmp`;
      try {
        await writeFile(tmp, JSON.stringify(next));
        await rename(tmp, this.file);
      } catch (err) {
        console.error(`live-questions: failed to save session ${this.name}:`, err);
      }
    });
  }

  /** Flush pending broadcasts and wait for the last write. */
  async drain(): Promise<void> {
    this.hub.flush();
    await this.writing;
  }

  attach(peer: Peer): void {
    clearTimeout(this.unloadTimer);
    this.sockets.add(peer);
  }

  detach(peer: Peer): void {
    if (!this.sockets.delete(peer)) return;
    this.hub.disconnected(peer);
    this.infos.delete(peer);
    if (this.sockets.size === 0) this.scheduleUnload();
  }

  scheduleUnload(): void {
    clearTimeout(this.unloadTimer);
    this.unloadTimer = setTimeout(async () => {
      if (this.sockets.size > 0) return;
      await this.drain();
      const current = sessions.get(this.name);
      if (this.sockets.size === 0 && current && (await current) === this) sessions.delete(this.name);
    }, IDLE_UNLOAD_MS);
    this.unloadTimer.unref?.();
  }
}

const sessions = new Map<string, Promise<Session>>();

async function load(name: string): Promise<Session> {
  const file = join(DATA_DIR, `${name}.json`);
  let data: unknown;
  try {
    data = JSON.parse(await readFile(file, "utf8"));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      // Keep the damaged file for inspection rather than overwriting it.
      const aside = `${file}.corrupt-${Date.now()}`;
      console.error(`live-questions: cannot read ${file} (${String(err)}); moving it to ${aside}`);
      await rename(file, aside).catch(() => {});
    }
  }
  return new Session(name, Room.restore(name, data));
}

/** The session's in-memory state, loading it from disk on first use. */
function getSession(name: string): Promise<Session> {
  let s = sessions.get(name);
  if (!s) {
    s = load(name);
    sessions.set(name, s);
    s.catch(() => sessions.delete(name));
  }
  return s;
}

const app = createApp({
  presenterKey: () => PRESENTER_KEY,
  socket: (c, name) => openSocket(c, name),
  exportRoom: async (_c, name) => {
    const s = await getSession(name);
    if (s.peers()[Symbol.iterator]().next().done) s.scheduleUnload();
    return s.hub.room.export();
  },
  asset: (c, path) =>
    serveStatic({ root: PUBLIC_DIR, path })(c, async () => {}).then((r) => r ?? c.text("Not found.", 404)),
});

/**
 * Upgrade with the session already loaded, so the first `hello` is never
 * processed against a room that is still being read from disk.
 */
async function openSocket(c: Parameters<typeof upgradeWebSocket>[0], name: string): Promise<Response> {
  const session = await getSession(name);
  return upgradeWebSocket(c, {
    onOpen: (_evt, ws) => session.attach(ws),
    onMessage: (evt, ws) => session.hub.message(ws, evt.data as string | ArrayBuffer),
    onClose: (_evt, ws) => session.detach(ws),
    onError: (_evt, ws) => session.detach(ws),
  });
}

await mkdir(DATA_DIR, { recursive: true });
if (!PRESENTER_KEY) {
  console.warn("live-questions: PRESENTER_KEY is not set, so nobody can present. Set it to enable the presenter.");
}

// Frames above the deck limit are refused by `ws` itself (close 1009);
// anything between the role limit and this gets a `bad-message` error.
const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_BYTES.deck * 2 });
const server = serve({ fetch: app.fetch, port: PORT, websocket: { server: wss } }, (info) => {
  console.log(`live-questions: listening on http://localhost:${info.port} (data: ${DATA_DIR})`);
});

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log(`live-questions: ${signal}, saving sessions`);
  const all = await Promise.allSettled([...sessions.values()]);
  await Promise.allSettled(all.map((r) => (r.status === "fulfilled" ? r.value.drain() : undefined)));
  for (const client of wss.clients) client.close(1001, "server shutting down");
  server.close();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

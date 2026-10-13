/**
 * One WebSocket to the session room, with reconnect (exponential backoff with
 * jitter) and a 25 s `{"t":"ping"}` heartbeat. A socket that has heard nothing
 * for a few heartbeats is assumed dead and replaced.
 */

import type { ClientMessage, ServerMessage } from "../shared/protocol";
import type { LinkStatus } from "./types";

const PING = '{"t":"ping"}';
const HEARTBEAT_MS = 25_000;
const STALE_MS = 2 * HEARTBEAT_MS + 10_000;
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

export interface ConnectionHandlers {
  /** The `hello` to send each time a socket opens. */
  hello(): ClientMessage;
  message(msg: ServerMessage): void;
  status(status: LinkStatus): void;
}

export class Connection {
  private ws: WebSocket | null = null;
  private attempts = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private lastHeard = 0;
  private stopped = false;
  private welcomed = false;

  constructor(
    private readonly url: string,
    private readonly handlers: ConnectionHandlers,
  ) {
    window.addEventListener("online", () => this.reconnectNow());
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  /** Give up for good (e.g. a protocol version mismatch). */
  stop(): void {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    this.ws?.close();
  }

  /** Send a message if the room has welcomed us. Returns whether it was sent. */
  send(msg: ClientMessage): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.welcomed) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  private connect(): void {
    if (this.stopped) return;
    this.handlers.status("connecting");
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch (err) {
      console.warn("[live-questions] cannot open socket", err);
      this.scheduleRetry();
      return;
    }
    this.ws = ws;
    this.welcomed = false;

    ws.addEventListener("open", () => {
      this.lastHeard = Date.now();
      ws.send(JSON.stringify(this.handlers.hello()));
      clearInterval(this.heartbeat);
      this.heartbeat = setInterval(() => this.beat(ws), HEARTBEAT_MS);
    });

    ws.addEventListener("message", (event) => {
      this.lastHeard = Date.now();
      if (typeof event.data !== "string") return;
      let msg: ServerMessage;
      try {
        msg = JSON.parse(event.data) as ServerMessage;
      } catch {
        return;
      }
      if (msg.t === "pong") return;
      if (msg.t === "welcome") {
        this.welcomed = true;
        this.attempts = 0;
        this.handlers.status("online");
      }
      if (msg.t === "error" && msg.code === "version") {
        console.error(`[live-questions] server speaks a different protocol version: ${msg.message}`);
        this.stop();
      }
      this.handlers.message(msg);
    });

    ws.addEventListener("close", () => {
      if (this.ws !== ws) return;
      clearInterval(this.heartbeat);
      this.ws = null;
      this.welcomed = false;
      this.handlers.status("offline");
      this.scheduleRetry();
    });
    // An "error" event is always followed by "close", which handles retry.
  }

  private beat(ws: WebSocket): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (Date.now() - this.lastHeard > STALE_MS) {
      ws.close(); // half-open after sleep or a network change; "close" reconnects
      return;
    }
    ws.send(PING);
  }

  private scheduleRetry(): void {
    if (this.stopped) return;
    clearTimeout(this.retryTimer);
    const base = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** this.attempts);
    const delay = base / 2 + Math.random() * (base / 2);
    this.attempts++;
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }

  private reconnectNow(): void {
    if (this.stopped || this.ws) return;
    clearTimeout(this.retryTimer);
    this.attempts = 0;
    this.connect();
  }
}

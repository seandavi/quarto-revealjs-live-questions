/**
 * HTTP routes shared by the Worker and the Node server (SPEC.md "Routes").
 *
 * Each runtime injects what differs: how a WebSocket upgrade is handled, how
 * a room is exported, and how static files are read.
 */
import { Hono, type Context, type Env } from "hono";
import { bearerMatches } from "./auth";
import { isSession } from "./validate";

export interface AppDeps<E extends Env> {
  /** PRESENTER_KEY for this request (Workers read it from `c.env`). */
  presenterKey(c: Context<E>): string | undefined;
  /** Handle `GET /api/s/:session/ws` (already checked: valid session, upgrade header). */
  socket(c: Context<E>, session: string): Response | Promise<Response>;
  /** Full room state for `GET /api/s/:session/export` (already authorized). */
  exportRoom(c: Context<E>, session: string): Promise<unknown>;
  /** Serve a file from `public/`, e.g. "/index.html". Unknown paths resolve to 404. */
  asset(c: Context<E>, path: string): Response | Promise<Response>;
}

/** Headers for the HTML pages: no third-party anything. */
const PAGE_HEADERS: Record<string, string> = {
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
    "connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "no-cache",
};

async function page<E extends Env>(deps: AppDeps<E>, c: Context<E>, path: string, status = 200): Promise<Response> {
  const res = await deps.asset(c, path);
  const out = new Response(res.body, { status: res.ok ? status : res.status, headers: res.headers });
  for (const [k, v] of Object.entries(PAGE_HEADERS)) out.headers.set(k, v);
  return out;
}

export function createApp<E extends Env = Env>(deps: AppDeps<E>): Hono<E> {
  const app = new Hono<E>();

  app.get("/healthz", (c) => c.text("ok"));

  app.get("/", (c) => page(deps, c, "/index.html"));

  app.get("/s/:session", async (c) => {
    const session = c.req.param("session");
    if (!isSession(session)) return c.text("Not a valid session name.", 404);
    return page(deps, c, "/vote.html");
  });
  app.get("/s/:session/", (c) => c.redirect(`/s/${encodeURIComponent(c.req.param("session"))}`, 301));

  app.get("/api/s/:session/ws", async (c) => {
    const session = c.req.param("session");
    if (!isSession(session)) return c.text("Not a valid session name.", 404);
    if (c.req.header("upgrade")?.toLowerCase() !== "websocket") {
      return c.text("Expected a WebSocket upgrade.", 426);
    }
    return deps.socket(c, session);
  });

  // The export is fetched with a bearer token, possibly from a deck page on
  // another origin, so it answers CORS preflights. The key still gates it.
  app.options("/api/s/:session/export", (c) => {
    c.header("Access-Control-Allow-Origin", "*");
    c.header("Access-Control-Allow-Headers", "Authorization");
    c.header("Access-Control-Allow-Methods", "GET, OPTIONS");
    c.header("Access-Control-Max-Age", "86400");
    return c.body(null, 204);
  });
  app.get("/api/s/:session/export", async (c) => {
    c.header("Access-Control-Allow-Origin", "*");
    c.header("Cache-Control", "no-store");
    const session = c.req.param("session");
    if (!isSession(session)) return c.json({ error: "invalid session name" }, 404);
    if (!bearerMatches(c.req.header("authorization"), deps.presenterKey(c))) {
      c.header("WWW-Authenticate", 'Bearer realm="live-poll"');
      return c.json({ error: "presenter key required" }, 401);
    }
    return c.json(await deps.exportRoom(c, session));
  });

  // Everything else (vote.js, vote.css, ...) comes from public/.
  app.get("*", async (c) => deps.asset(c, c.req.path));

  app.notFound((c) => c.text("Not found.", 404));
  app.onError((err, c) => {
    console.error("live-poll:", err);
    return c.text("Internal error.", 500);
  });

  return app;
}

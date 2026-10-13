/** Reading the filter's config and deciding which mode the deck runs in. */

import { LIMITS, type Question } from "../shared/protocol";
import type { LpConfig, LpQuestion } from "./types";

export function readConfig(doc: Document = document): LpConfig | null {
  const el = doc.getElementById("lp-config");
  if (!el?.textContent) return null;
  try {
    const raw = JSON.parse(el.textContent) as Partial<LpConfig>;
    return {
      server: typeof raw.server === "string" && raw.server ? raw.server.replace(/\/+$/, "") : undefined,
      session: typeof raw.session === "string" ? raw.session : "deck",
      closeOnLeave: raw.closeOnLeave !== false,
      results: raw.results === "hidden" ? "hidden" : "live",
      qr: raw.qr !== false,
    };
  } catch (err) {
    console.warn("[live-poll] could not parse #lp-config", err);
    return null;
  }
}

/** `?session=<name>` in the deck URL overrides the configured session. */
export function sessionOverride(search: string): string | null {
  const value = new URLSearchParams(search).get("session");
  if (value === null || value === "") return null;
  if (!LIMITS.sessionPattern.test(value)) {
    console.warn(`[live-poll] ignoring ?session=${value}: it must match ${LIMITS.sessionPattern}`);
    return null;
  }
  return value;
}

/** Inside an iframe, or the reveal speaker view's `receiver` previews. */
export function isEmbedded(win: Window = window): boolean {
  if (new URLSearchParams(win.location.search).has("receiver")) return true;
  try {
    return win.self !== win.top;
  } catch {
    return true; // cross-origin parent
  }
}

export function isPrint(search: string): boolean {
  return /print-pdf/i.test(search);
}

export function readQuestion(el: HTMLElement): LpQuestion | null {
  const raw = el.dataset.lp;
  if (!raw) return null;
  try {
    const q = JSON.parse(raw) as LpQuestion;
    if (q.type !== "poll" && q.type !== "wordcloud" && q.type !== "likert") return null;
    return q;
  } catch (err) {
    console.warn(`[live-poll] bad data-lp on #${el.id}`, err);
    return null;
  }
}

/** The definition sent in `open`: no `correct`, no `results`. */
export function definition(q: LpQuestion): Question {
  switch (q.type) {
    case "poll":
      return { type: q.type, id: q.id, prompt: q.prompt, options: q.options };
    case "wordcloud":
      return { type: q.type, id: q.id, prompt: q.prompt, maxWords: q.maxWords, maxAnswers: q.maxAnswers };
    case "likert":
      return {
        type: q.type,
        id: q.id,
        prompt: q.prompt,
        statements: q.statements,
        labels: q.labels,
        numeric: q.numeric,
        anchors: q.anchors ?? null,
      };
  }
}

/** Audience URL encoded in the QR code. */
export function audienceUrl(server: string, path: string): string {
  return server + path;
}

/** The audience URL without the scheme, for display. */
export function shortUrl(url: string): string {
  return url.replace(/^https?:\/\//, "");
}

export function socketUrl(server: string, path: string): string {
  return server.replace(/^http/, "ws") + path;
}

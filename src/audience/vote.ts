/**
 * Audience page: `/` (join form) and `/s/<session>` (voting).
 *
 * One WebSocket per page. The phone follows whatever question the deck makes
 * live. All server-provided text reaches the DOM through `textContent` only.
 */
import { normalizeAnswer } from "../shared/normalize";
import {
  LIMITS,
  PROTOCOL_VERSION,
  socketPath,
  type AudienceState,
  type ClientMessage,
  type ErrorCode,
  type Mine,
  type PollResults,
  type ServerMessage,
  type WordcloudResults,
} from "../shared/protocol";

// ---------------------------------------------------------------- helpers

type Child = Node | string | null | undefined | false;

/** Build an element. Strings become text nodes; never parses HTML. */
function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number | boolean | undefined> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k === "class") el.className = String(v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return el;
}

const letter = (i: number) => String.fromCharCode(65 + i);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const pct = (n: number, total: number) => (total > 0 ? Math.round((100 * n) / total) : 0);

function storage(): Storage | null {
  try {
    const s = window.localStorage;
    s.setItem("lp:test", "1");
    s.removeItem("lp:test");
    return s;
  } catch {
    return null;
  }
}

function randomId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  // randomUUID needs a secure context; plain-http LAN servers fall back to this.
  const b = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

function voterId(): string {
  const s = storage();
  const existing = s?.getItem("lp:voter");
  if (existing && /^[\x21-\x7e]{1,64}$/.test(existing)) return existing;
  const id = randomId();
  s?.setItem("lp:voter", id);
  return id;
}

// ---------------------------------------------------------------- join page

function initJoin(form: HTMLFormElement): void {
  const input = form.querySelector<HTMLInputElement>("#join-session")!;
  const error = form.querySelector<HTMLElement>("#join-error")!;
  const fromQuery = new URLSearchParams(location.search).get("session");
  if (fromQuery) input.value = fromQuery;
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const name = input.value.trim();
    if (!LIMITS.sessionPattern.test(name)) {
      error.textContent = name
        ? "Session names use letters, numbers, - and _ only. Check the name on the slide."
        : "Type the session name shown on the slide.";
      input.setAttribute("aria-invalid", "true");
      input.focus();
      return;
    }
    location.assign(`/s/${encodeURIComponent(name)}`);
  });
  input.addEventListener("input", () => {
    error.textContent = "";
    input.removeAttribute("aria-invalid");
  });
}

// ---------------------------------------------------------------- voting page

type Conn = "connecting" | "live" | "offline" | "outdated";

class VotePage {
  private ws: WebSocket | null = null;
  private conn: Conn = "connecting";
  private retry = 0;
  private retryTimer: number | undefined;
  private heartbeat: number | undefined;
  private state: AudienceState | null = null;
  private mine: Mine = { votes: {}, answers: {} };
  /** Optimistic poll choice while the server confirms it. */
  private pendingVote: { id: string; choice: number } | null = null;
  /** Identity of the view currently in the DOM; rebuilt only when it changes. */
  private viewKey = "";
  private toastTimer: number | undefined;
  private readonly voter = voterId();

  private readonly main = document.getElementById("main")!;
  private readonly connEl = document.getElementById("conn")!;
  private readonly toastEl = document.getElementById("toast")!;

  constructor(private readonly session: string) {
    const label = document.getElementById("session")!;
    label.textContent = session;
    document.title = `${session} · Live poll`;
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && this.conn === "offline") this.connectNow();
    });
    window.addEventListener("online", () => this.conn === "offline" && this.connectNow());
    this.connect();
  }

  // -------------------------------------------------------------- socket

  private connect(): void {
    clearTimeout(this.retryTimer);
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}${socketPath(this.session)}`);
    this.ws = ws;
    ws.addEventListener("open", () => {
      this.send({ t: "hello", v: PROTOCOL_VERSION, role: "audience", voter: this.voter });
    });
    ws.addEventListener("message", (e) => {
      if (typeof e.data !== "string") return;
      let msg: ServerMessage;
      try {
        msg = JSON.parse(e.data) as ServerMessage;
      } catch {
        return;
      }
      this.onMessage(msg);
    });
    ws.addEventListener("close", (e) => {
      if (this.ws !== ws) return;
      this.ws = null;
      clearInterval(this.heartbeat);
      if (this.conn === "outdated" || e.code === 4000) return this.setConn("outdated");
      this.setConn("offline");
      // Backoff: 0.5 s, 1 s, 2 s ... capped at 15 s, with jitter.
      const delay = Math.min(15_000, 500 * 2 ** this.retry) * (0.75 + Math.random() * 0.5);
      this.retry = Math.min(this.retry + 1, 6);
      this.retryTimer = window.setTimeout(() => this.connect(), delay);
    });
  }

  private connectNow(): void {
    if (this.ws) return;
    this.retry = 0;
    this.connect();
  }

  private send(msg: ClientMessage): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  private onMessage(msg: ServerMessage): void {
    switch (msg.t) {
      case "welcome":
        this.retry = 0;
        this.setConn("live");
        clearInterval(this.heartbeat);
        this.heartbeat = window.setInterval(() => this.ws?.send('{"t":"ping"}'), 25_000);
        return;
      case "audience":
        this.state = msg.state;
        if (this.pendingVote && this.pendingVote.id !== msg.state.live?.question.id) this.pendingVote = null;
        return this.render();
      case "you":
        this.mine = msg.mine;
        if (this.pendingVote && this.mine.votes[this.pendingVote.id] === this.pendingVote.choice) {
          this.pendingVote = null;
        }
        return this.render();
      case "error":
        return this.onError(msg.code, msg.message);
      case "deck":
      case "pong":
        return;
    }
  }

  private onError(code: ErrorCode, message: string): void {
    this.pendingVote = null;
    switch (code) {
      case "closed":
        this.toast("Voting has closed for this question.");
        break;
      case "limit":
        this.toast(/answers/.test(message) ? "You've used all your answers for this question." : "Slow down a little, then try again.");
        break;
      case "version":
        this.setConn("outdated");
        break;
      case "bad-message":
        this.toast(/empty/.test(message) ? "Type a word or two first." : "That didn't go through. Try again.");
        break;
      default:
        this.toast("That didn't go through. Try again.");
    }
    this.render();
  }

  private setConn(conn: Conn): void {
    this.conn = conn;
    this.connEl.dataset.state = conn;
    const text = this.connEl.querySelector(".conn-text")!;
    text.textContent = { connecting: "Connecting", live: "Live", offline: "Reconnecting", outdated: "Reload needed" }[conn];
    document.body.classList.toggle("is-offline", conn === "offline" || conn === "outdated");
    if (conn === "outdated") {
      this.viewKey = "outdated";
      this.main.replaceChildren(
        h(
          "section",
          { class: "view view-center" },
          h("h1", { class: "prompt" }, "This page is out of date"),
          h("p", { class: "hint" }, "The poll server was updated. Reload to keep voting."),
          h("button", { class: "send wide", type: "button", id: "reload" }, "Reload page"),
        ),
      );
      document.getElementById("reload")!.addEventListener("click", () => location.reload());
      return;
    }
    if (conn === "live" && !this.state) return;
    this.render();
  }

  private toast(text: string): void {
    this.toastEl.textContent = text;
    this.toastEl.classList.add("show");
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toastEl.classList.remove("show"), 3200);
  }

  // -------------------------------------------------------------- rendering

  private render(): void {
    if (this.conn === "outdated") return;
    const live = this.state?.live ?? null;
    if (!this.state) return; // still showing "Connecting"
    let key: string;
    if (!live) key = "waiting";
    else if (live.status === "open") key = `open|${JSON.stringify(live.question)}`;
    else {
      // Closed views are static: rebuild only when what they show changes.
      const id = live.question.id;
      key = `closed|${JSON.stringify([live, this.mine.votes[id], this.mine.answers[id]])}`;
    }
    const rebuild = key !== this.viewKey;
    this.viewKey = key;
    this.main.classList.toggle("is-disabled", this.conn !== "live");

    if (!live) {
      if (rebuild) this.main.replaceChildren(this.waitingView());
      return;
    }
    if (live.status === "open" && live.question.type === "poll") {
      if (rebuild) this.main.replaceChildren(this.pollView(live.question.id, live.question.prompt, live.question.options));
      this.updatePoll(live.question.id);
    } else if (live.status === "open" && live.question.type === "wordcloud") {
      if (rebuild) this.main.replaceChildren(this.cloudView(live.question));
      this.updateCloud(live.question.id, live.question.maxAnswers);
    } else if (rebuild) {
      this.main.replaceChildren(this.resultsView(live));
    }
    if (rebuild) this.main.focus({ preventScroll: true });
  }

  private header(prompt: string, status: "open" | "closed", note: string): HTMLElement {
    return h(
      "header",
      { class: "q-head" },
      h("p", { class: `q-status ${status}` }, status === "open" ? "Voting open" : "Voting closed"),
      h("h1", { class: "prompt" }, prompt || "Untitled question"),
      h("p", { class: "hint" }, note),
    );
  }

  private waitingView(): HTMLElement {
    return h(
      "section",
      { class: "view view-center" },
      h("div", { class: "pulse", "aria-hidden": "true" }),
      h("h1", { class: "lead" }, "Waiting for the next question"),
      h("p", { class: "hint" }, "Keep this page open. It changes on its own when your presenter asks something."),
    );
  }

  // ---- poll

  private pollView(id: string, prompt: string, options: string[]): HTMLElement {
    const list = h("div", { class: "options", role: "radiogroup", "aria-label": prompt || "Options" });
    options.forEach((label, i) => {
      const btn = h(
        "button",
        { class: "option", type: "button", role: "radio", "aria-checked": "false", "data-choice": i },
        h("span", { class: "opt-letter", "aria-hidden": "true" }, letter(i)),
        h("span", { class: "opt-label" }, h("span", { class: "mark" }, label)),
        h("span", { class: "opt-tag" }, "Your vote"),
      );
      btn.addEventListener("click", () => this.vote(id, i));
      list.append(btn);
    });
    // Arrow keys move between options, as in a native radio group.
    list.addEventListener("keydown", (e) => {
      const buttons = [...list.querySelectorAll<HTMLButtonElement>(".option")];
      const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
      if (at < 0) return;
      const step = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1 : 0;
      if (!step) return;
      e.preventDefault();
      buttons[(at + step + buttons.length) % buttons.length]!.focus();
    });
    return h(
      "section",
      { class: "view" },
      this.header(prompt, "open", "Tap one. You can change your vote until voting closes."),
      list,
      h("p", { class: "saved", id: "saved", "aria-live": "polite" }),
    );
  }

  private vote(id: string, choice: number): void {
    if (this.mine.votes[id] === choice && !this.pendingVote) return;
    if (!this.send({ t: "vote", id, choice })) {
      this.toast("You're offline. Tap again once you're reconnected.");
      return;
    }
    this.pendingVote = { id, choice };
    this.updatePoll(id);
  }

  private updatePoll(id: string): void {
    const confirmed = this.mine.votes[id];
    const shown = this.pendingVote?.id === id ? this.pendingVote.choice : confirmed;
    const multiple = this.main.querySelectorAll<HTMLButtonElement>(".option");
    let tabbable = false;
    multiple.forEach((btn) => {
      const i = Number(btn.dataset.choice);
      const on = i === shown;
      btn.setAttribute("aria-checked", String(on));
      btn.classList.toggle("selected", on);
      btn.classList.toggle("pending", on && this.pendingVote !== null);
      btn.tabIndex = on || (shown === undefined && i === 0) ? 0 : -1;
      tabbable ||= on;
    });
    if (!tabbable && multiple[0]) multiple[0].tabIndex = 0;
    const saved = this.main.querySelector("#saved");
    if (saved) {
      saved.textContent =
        this.pendingVote?.id === id ? "Sending…" : confirmed !== undefined ? `Vote saved: ${letter(confirmed)}` : "";
    }
  }

  // ---- word cloud

  private cloudView(q: { id: string; prompt: string; maxWords: number; maxAnswers: number }): HTMLElement {
    const input = h("input", {
      class: "text-input",
      id: "answer",
      type: "text",
      autocomplete: "off",
      autocapitalize: "sentences",
      enterkeyhint: "send",
      maxlength: LIMITS.answerInputChars,
      placeholder: q.maxWords === 1 ? "One word" : `Up to ${q.maxWords} words`,
      "aria-describedby": "remaining",
    });
    const button = h("button", { class: "send", type: "submit" }, "Send");
    const form = h(
      "form",
      { class: "answer-form", novalidate: true },
      h("label", { class: "field-label visually-hidden", for: "answer" }, "Your answer"),
      h("div", { class: "answer-row" }, input, button),
      h("p", { class: "remaining", id: "remaining", "aria-live": "polite" }),
    );
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      this.answer(q.id, q.maxWords, q.maxAnswers, input);
    });
    const words = q.maxWords === 1 ? "one word" : `up to ${q.maxWords} words`;
    return h(
      "section",
      { class: "view" },
      this.header(
        q.prompt,
        "open",
        q.maxAnswers === 1 ? `Answer in ${words}.` : `Answer in ${words}. You can send ${q.maxAnswers} different answers.`,
      ),
      form,
      h("div", { class: "chips-wrap" }, h("h2", { class: "sub", id: "chips-title" }, "Your answers"), h("ul", { class: "chips", id: "chips", "aria-labelledby": "chips-title" })),
    );
  }

  private answer(id: string, maxWords: number, maxAnswers: number, input: HTMLInputElement): void {
    const n = normalizeAnswer(input.value, maxWords);
    if (!n) {
      this.toast("Type a word or two first.");
      input.focus();
      return;
    }
    // The server truncates long answers as a backstop; catching it here lets
    // the voter rephrase instead of having "confusing at times" land as
    // "confusing at".
    const words = normalizeAnswer(input.value, Number.MAX_SAFE_INTEGER)?.text.split(" ").length ?? 0;
    if (words > maxWords) {
      this.toast(maxWords === 1 ? "Just one word, please." : `Keep it to ${maxWords} words, please.`);
      input.select();
      return;
    }
    const sent = this.mine.answers[id] ?? [];
    if (sent.some((a) => a.toLowerCase() === n.key)) {
      this.toast("You already sent that one.");
      input.select();
      return;
    }
    if (sent.length >= maxAnswers) {
      this.toast("You've used all your answers for this question.");
      return;
    }
    if (!this.send({ t: "answer", id, text: input.value })) {
      this.toast("You're offline. Send again once you're reconnected.");
      return;
    }
    input.value = "";
    input.focus();
  }

  private updateCloud(id: string, maxAnswers: number): void {
    const sent = this.mine.answers[id] ?? [];
    const chips = this.main.querySelector("#chips");
    if (chips) {
      const before = chips.children.length;
      chips.replaceChildren(...sent.map((a, i) => h("li", { class: i >= before ? "chip new" : "chip" }, a)));
      chips.parentElement!.hidden = sent.length === 0;
    }
    const left = maxAnswers - sent.length;
    const remaining = this.main.querySelector("#remaining");
    if (remaining) {
      remaining.textContent =
        left > 0 ? (sent.length ? `${plural(left, "answer")} left.` : "") : "That's all your answers. Watch the screen.";
    }
    const input = this.main.querySelector<HTMLInputElement>("#answer");
    const button = this.main.querySelector<HTMLButtonElement>(".answer-form .send");
    if (input) input.disabled = left <= 0;
    if (button) button.disabled = left <= 0;
  }

  // ---- results

  private resultsView(live: NonNullable<AudienceState["live"]>): HTMLElement {
    const q = live.question;
    const results = live.results;
    if (q.type === "poll") {
      const r = results?.type === "poll" ? results : ({ type: "poll", counts: q.options.map(() => 0), voters: 0 } satisfies PollResults);
      const total = r.counts.reduce((a, b) => a + b, 0);
      const max = Math.max(1, ...r.counts);
      const revealed = live.revealed;
      const mineVote = this.mine.votes[q.id];
      const note = revealed
        ? mineVote === undefined
          ? "Here's the answer."
          : revealed.includes(mineVote)
            ? "You got it right."
            : "Not this time. The correct answer is highlighted."
        : `${plural(r.voters, "person", "people")} voted.`;
      const rows = h("ol", { class: "bars", "aria-label": "Results" });
      q.options.forEach((label, i) => {
        const n = r.counts[i] ?? 0;
        const correct = revealed?.includes(i) ?? false;
        const cls = ["bar-row", correct ? "correct" : revealed ? "dim" : "", mineVote === i ? "mine" : ""].join(" ").trim();
        const tags: Child[] = [
          correct ? h("span", { class: "tag tag-correct" }, "Correct") : null,
          mineVote === i ? h("span", { class: "tag" }, "Your vote") : null,
        ];
        const fill = h("span", { class: "bar-fill" });
        fill.style.setProperty("--w", `${(100 * n) / max}%`);
        rows.append(
          h(
            "li",
            { class: cls },
            h(
              "div",
              { class: "bar-top" },
              h("span", { class: "opt-letter small", "aria-hidden": "true" }, letter(i)),
              h("span", { class: "bar-label" }, h("span", { class: "mark" }, label)),
              h("span", { class: "bar-num" }, `${pct(n, total)}%`, h("span", { class: "visually-hidden" }, `, ${plural(n, "vote")}`)),
            ),
            h("div", { class: "bar-track", "aria-hidden": "true" }, fill),
            h("div", { class: "bar-meta" }, ...tags, h("span", { class: "bar-count", "aria-hidden": "true" }, plural(n, "vote"))),
          ),
        );
      });
      return h("section", { class: "view" }, this.header(q.prompt, "closed", note), rows);
    }

    const r: WordcloudResults = results?.type === "wordcloud" ? results : { type: "wordcloud", words: [], voters: 0 };
    const mineKeys = new Set((this.mine.answers[q.id] ?? []).map((a) => a.toLowerCase()));
    const top = Math.max(1, ...r.words.map((w) => w.count));
    const list = h("ol", { class: "ranked", "aria-label": "Answers, most common first" });
    r.words.slice(0, 30).forEach((w) => {
      const fill = h("span", { class: "rank-fill", "aria-hidden": "true" });
      fill.style.setProperty("--w", `${(100 * w.count) / top}%`);
      const mine = mineKeys.has(w.text.toLowerCase());
      list.append(
        h(
          "li",
          { class: mine ? "rank mine" : "rank" },
          fill,
          h("span", { class: "rank-word" }, w.text),
          mine ? h("span", { class: "tag" }, "Yours") : null,
          h("span", { class: "rank-count" }, String(w.count), h("span", { class: "visually-hidden" }, w.count === 1 ? " person" : " people")),
        ),
      );
    });
    const note = r.words.length
      ? `${plural(r.voters, "person", "people")} answered. Most common first.`
      : "No answers came in for this one.";
    return h("section", { class: "view" }, this.header(q.prompt, "closed", note), r.words.length ? list : null);
  }
}

// ---------------------------------------------------------------- boot

function boot(): void {
  const form = document.getElementById("join-form");
  if (form instanceof HTMLFormElement) return initJoin(form);
  const m = /^\/s\/([^/]+)\/?$/.exec(location.pathname);
  const session = m ? decodeURIComponent(m[1]!) : "";
  if (!LIMITS.sessionPattern.test(session)) {
    location.replace("/");
    return;
  }
  new VotePage(session);
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
else boot();

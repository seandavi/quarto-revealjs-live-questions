/**
 * The controller: decides the mode, owns the socket, follows the deck's
 * slides (presenter lifecycle), routes server state to the question views and
 * handles the Q / A / T keys.
 */

import {
  PROTOCOL_VERSION,
  audiencePath,
  socketPath,
  type ClientMessage,
  type DeckState,
  type ServerMessage,
} from "../shared/protocol";
import {
  audienceUrl,
  definition,
  isEmbedded,
  isPrint,
  readConfig,
  readQuestion,
  sessionOverride,
  shortUrl,
  socketUrl,
} from "./config";
import { Connection } from "./connection";
import { QrOverlay, Toast } from "./overlay";
import { storedKey, takeKeyFromUrl } from "./presenter-key";
import { QuestionView } from "./question";
import type { LinkStatus, LpConfig, LpQuestion, Mode, RevealApi } from "./types";

const KEY_Q = 81;
const KEY_A = 65;
const KEY_T = 84;

function randomId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  // randomUUID needs a secure context; plain http on a LAN address is not one.
  const b = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

function sameDefinition(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export class LivePoll {
  private mode: Mode = "static";
  private config!: LpConfig;
  private conn: Connection | null = null;
  private views: QuestionView[] = [];
  private state: DeckState | null = null;
  private link: LinkStatus = "connecting";
  private presenter = false;
  private welcomes = 0;
  private resyncPending = false;
  /** The question this deck last opened, for close-on-leave. */
  private openedId: string | null = null;
  private overlay: QrOverlay | null = null;
  private toast: Toast | null = null;
  private key: string | null = null;

  constructor(private readonly deck: RevealApi) {}

  init(): void {
    const config = readConfig();
    const elements = Array.from(document.querySelectorAll<HTMLElement>(".lp-question[data-lp]"));
    const embedded = isEmbedded();
    takeKeyFromUrl(config?.server, !embedded);

    const print = isPrint(window.location.search) || this.deck.isPrintView();
    if (!config || !config.server || print) {
      for (const el of elements) el.classList.add("lp-static");
      document.documentElement.dataset.lpMode = "static";
      return;
    }
    this.config = config;
    this.mode = embedded ? "embedded" : "viewer";
    document.documentElement.dataset.lpMode = this.mode;
    document.documentElement.dataset.lpTone = themeTone(this.deck.getRevealElement());

    const server = config.server;
    const session = sessionOverride(window.location.search) ?? config.session;
    const url = audienceUrl(server, audiencePath(session));
    const short = shortUrl(url);

    const reveal = this.deck.getRevealElement();
    this.toast = new Toast(reveal);
    this.overlay = new QrOverlay(reveal, url, short);

    const ctx = {
      qr: config.qr,
      audienceUrl: url,
      shortUrl: short,
      send: (msg: ClientMessage) => this.send(msg),
      open: (q: LpQuestion) => this.openQuestion(q, true),
    };
    const seen = new Set<string>();
    for (const el of elements) {
      const q = readQuestion(el);
      if (!q) continue;
      if (seen.has(q.id)) console.warn(`[live-poll] duplicate question id "${q.id}"`);
      seen.add(q.id);
      this.views.push(new QuestionView(el, q, ctx));
    }

    this.key = embedded ? null : storedKey(server);
    const voter = randomId();
    this.conn = new Connection(socketUrl(server, socketPath(session)), {
      hello: () => ({
        t: "hello",
        v: PROTOCOL_VERSION,
        role: "deck",
        voter,
        ...(this.key ? { key: this.key } : {}),
      }),
      message: (msg) => this.onMessage(msg),
      status: (status) => this.onLink(status),
    });

    this.registerKeys();
    this.deck.on("ready", () => this.onSlide());
    this.deck.on("slidechanged", () => this.onSlide());
    this.deck.on("resize", () => this.refreshCurrent());
    void document.fonts?.ready.then(() => this.refreshCurrent());

    this.render();
    this.conn.start();
  }

  // --- server ---------------------------------------------------------------

  private send(msg: ClientMessage): boolean {
    if (!this.presenter && msg.t !== "ping") return false;
    const sent = this.conn?.send(msg) ?? false;
    if (!sent) this.toast?.show("Not connected to the live poll server");
    return sent;
  }

  private onLink(status: LinkStatus): void {
    this.link = status;
    if (status !== "online") this.setPresenter(false);
    this.render();
  }

  private onMessage(msg: ServerMessage): void {
    switch (msg.t) {
      case "welcome": {
        this.welcomes++;
        this.setPresenter(msg.presenter);
        if (this.key && !msg.presenter && this.welcomes === 1) {
          this.toast?.show("Presenter key not accepted: viewing only", 5000);
        }
        if (msg.presenter) {
          if (this.welcomes === 1) this.syncSlide(true);
          else this.resyncPending = true;
        }
        break;
      }
      case "deck":
        this.state = msg.state;
        this.render();
        if (this.resyncPending) {
          this.resyncPending = false;
          this.syncSlide(false);
        }
        break;
      case "error":
        console.warn(`[live-poll] server error ${msg.code}: ${msg.message}`);
        if (this.presenter) this.toast?.show(`Live poll: ${msg.message || msg.code}`);
        break;
      default:
        break;
    }
  }

  private setPresenter(on: boolean): void {
    this.presenter = on;
    const mode: Mode = on ? "presenter" : this.mode === "embedded" ? "embedded" : "viewer";
    document.documentElement.dataset.lpMode = mode;
    for (const v of this.views) v.setPresenter(on);
  }

  // --- lifecycle --------------------------------------------------------------

  private currentView(): QuestionView | null {
    const slide = this.deck.getCurrentSlide();
    if (!slide) return null;
    return this.views.find((v) => slide.contains(v.el)) ?? null;
  }

  private onSlide(): void {
    this.refreshCurrent();
    this.overlay?.hide();
    this.syncSlide(true);
  }

  /**
   * Make the server match the current slide. `force` (slide changes and the
   * first connection) always sends `open`; after a reconnect it is skipped if
   * the server already has this question live with the same definition, so a
   * question the presenter closed stays closed.
   */
  private syncSlide(force: boolean): void {
    if (!this.presenter || this.link !== "online") return;
    const view = this.currentView();
    if (view) {
      this.openQuestion(view.q, force);
      return;
    }
    const id = this.openedId;
    if (!id || !this.config.closeOnLeave) return;
    const qs = this.state?.questions[id];
    if (!this.state || (this.state.live === id && qs?.status === "open")) {
      this.conn?.send({ t: "close", id });
    }
    this.openedId = null;
  }

  private openQuestion(q: LpQuestion, force: boolean): void {
    const def = definition(q);
    const known = this.state?.questions[q.id];
    if (!force && this.state?.live === q.id && known && sameDefinition(known.question, def)) {
      this.openedId = q.id;
      return;
    }
    if (this.send({ t: "open", question: def })) this.openedId = q.id;
  }

  // --- rendering ----------------------------------------------------------------

  private render(): void {
    for (const v of this.views) {
      v.update({
        question: this.state?.questions[v.q.id] ?? null,
        live: this.state?.live ?? null,
        link: this.link,
        audience: this.state?.audience ?? 0,
      });
    }
  }

  private refreshCurrent(): void {
    const slide = this.deck.getCurrentSlide();
    if (!slide) return;
    const height = Number(this.deck.getConfig().height) || 700;
    for (const v of this.views) {
      if (!slide.contains(v.el)) continue;
      fitHeight(v.el, slide, height);
      v.refresh();
    }
  }

  // --- keys -------------------------------------------------------------------

  private registerKeys(): void {
    this.deck.addKeyBinding(
      { keyCode: KEY_Q, key: "Q", description: "Live poll: full-screen QR code" },
      () => this.overlay?.toggle(),
    );
    this.deck.addKeyBinding(
      { keyCode: KEY_A, key: "A", description: "Live poll: reveal the correct answer" },
      () => this.revealAnswer(),
    );
    this.deck.addKeyBinding(
      { keyCode: KEY_T, key: "T", description: "Live poll: show or hide results" },
      () => {
        const view = this.currentView();
        if (view) view.toggleResults();
        else this.toast?.show("No live poll on this slide");
      },
    );
  }

  private revealAnswer(): void {
    const view = this.currentView();
    if (!view) return this.toast?.show("No live poll on this slide");
    if (!this.presenter) return this.toast?.show("Only the presenter can reveal answers");
    const q = view.q;
    if (q.type === "likert") return this.toast?.show("Rating scales have no answer to reveal");
    if (q.type !== "poll" || !q.correct?.length) {
      return this.toast?.show("This question has no correct answer marked");
    }
    if (this.send({ t: "reveal", id: q.id, correct: q.correct })) view.showResults();
  }
}

/**
 * "dark" when the reveal theme's background is dark. The likert palette
 * picks its dark-surface steps from this (CSS cannot compare colors).
 */
function themeTone(reveal: HTMLElement): "light" | "dark" {
  const probe = document.createElement("span");
  probe.style.color = "var(--r-background-color, #fff)";
  reveal.append(probe);
  const rgb = getComputedStyle(probe).color.match(/[\d.]+/g)?.map(Number) ?? [255, 255, 255];
  probe.remove();
  const [r = 255, g = 255, b = 255] = rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128 ? "dark" : "light";
}

/**
 * Give the question the slide height left below it, so it sits next to the
 * heading without overflowing. Uses layout offsets, which ignore reveal's
 * scaling transform.
 */
function fitHeight(el: HTMLElement, slide: HTMLElement, slideHeight: number): void {
  let top = 0;
  let node: HTMLElement | null = el;
  while (node && node !== slide) {
    top += node.offsetTop;
    const parent = node.offsetParent as HTMLElement | null;
    if (!parent || !slide.contains(parent) && parent !== slide) break;
    node = parent;
  }
  const available = slideHeight - top - 24;
  el.style.height = `${Math.round(Math.max(280, Math.min(620, available)))}px`;
}

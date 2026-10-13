/** The word cloud: spans positioned by cloud-layout, plus the hidden-word tray. */

import type { CloudWord, WordcloudResults } from "../shared/protocol";
import { button, h } from "./dom";
import { hash, layoutCloud, newMemory } from "./cloud-layout";

const MAX_WORDS = 70;

/** Hide or unhide a word (presenter only). */
export type HideWord = (text: string, hidden: boolean) => void;

export class WordCloud {
  readonly el: HTMLElement;
  private readonly area: HTMLElement;
  private readonly tray: HTMLElement;
  private readonly spans = new Map<string, HTMLElement>();
  private readonly memory = newMemory();
  private canvas: CanvasRenderingContext2D | null = null;
  private words: CloudWord[] = [];
  private hidden: string[] = [];
  private moderated = false;

  constructor(private readonly onHide: HideWord) {
    this.area = h("div", { class: "lp-cloud-area" });
    this.tray = h("div", { class: "lp-tray" });
    this.tray.hidden = true;
    this.el = h("div", { class: "lp-cloud" }, this.area, this.tray);
  }

  /** In presenter mode words are clickable (hide) and the tray is shown. */
  setModerated(on: boolean): void {
    if (on === this.moderated) return;
    this.moderated = on;
    this.el.classList.toggle("lp-moderated", on);
    for (const span of this.spans.values()) this.decorate(span);
    this.renderTray();
  }

  update(results: WordcloudResults | null): void {
    this.words = results ? results.words.slice(0, MAX_WORDS) : [];
    this.hidden = results?.hidden ?? [];
    this.renderTray();
    this.layout();
  }

  /** Lay the words out. Needs the slide to be displayed (for its size). */
  layout(): void {
    const width = this.area.clientWidth;
    const height = this.area.clientHeight;
    if (width === 0 || height === 0) return;

    const style = getComputedStyle(this.area);
    const family = style.fontFamily;
    const weight = style.fontWeight;
    const measure = (text: string, size: number) => {
      const ctx = this.context();
      if (!ctx) return { w: text.length * size * 0.6, h: size * 1.2 };
      ctx.font = `${weight} ${size}px ${family}`;
      return { w: ctx.measureText(text).width + size * 0.2, h: size * 1.12 };
    };

    const maxFont = Math.min(96, height / 3.2);
    const placed = layoutCloud(
      this.words.map((w) => ({ key: w.text.toLowerCase(), text: w.text, count: w.count })),
      this.memory,
      { width, height, minFont: Math.min(22, maxFont / 2), maxFont, gap: 5, measure },
    );

    const seen = new Set<string>();
    placed.forEach((p, rank) => {
      seen.add(p.key);
      let span = this.spans.get(p.key);
      const isNew = !span;
      if (!span) {
        span = this.createSpan();
        this.spans.set(p.key, span);
        this.area.append(span);
      }
      span.textContent = p.text;
      span.dataset.text = p.text;
      span.dataset.count = String(p.count);
      this.decorate(span);
      // The leaders in the accent color; the rest vary, with the muted tone
      // kept for one-off answers so big words never look washed out.
      const tone = rank < 3 ? 0 : p.count <= 1 && placed.length > 12 ? 4 : 1 + (hash(p.key) % 3);
      span.dataset.tone = String(tone);
      span.style.fontSize = `${p.size.toFixed(1)}px`;
      span.style.transform = `translate(-50%, -50%) translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px)`;
      if (isNew) {
        span.classList.add("lp-enter");
        requestAnimationFrame(() => requestAnimationFrame(() => span!.classList.remove("lp-enter")));
      }
    });

    for (const [key, span] of this.spans) {
      if (seen.has(key)) continue;
      span.remove();
      this.spans.delete(key);
    }
    this.el.classList.toggle("lp-empty", placed.length === 0);
  }

  private createSpan(): HTMLElement {
    const span = h("span", { class: "lp-word" });
    const hide = (e: Event) => {
      if (!this.moderated) return;
      e.preventDefault();
      e.stopPropagation();
      this.onHide(span.dataset.text ?? "", true);
    };
    span.addEventListener("click", hide);
    span.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") hide(e);
    });
    return span;
  }

  private decorate(span: HTMLElement): void {
    const text = span.dataset.text ?? "";
    const tip = `${span.dataset.count ?? "?"} × “${text}”`;
    if (this.moderated) {
      span.tabIndex = 0;
      span.setAttribute("role", "button");
      span.title = `${tip} (click to hide)`;
    } else {
      span.removeAttribute("tabindex");
      span.removeAttribute("role");
      span.title = tip;
    }
  }

  private renderTray(): void {
    if (!this.moderated || this.hidden.length === 0) {
      this.tray.replaceChildren();
      this.tray.hidden = true;
      return;
    }
    this.tray.hidden = false;
    this.tray.replaceChildren(
      h("span", { class: "lp-tray-label", text: "Hidden" }),
      ...this.hidden.map((text) => {
        const b = button(text, () => this.onHide(text, false), "lp-chip");
        b.title = `Show “${text}” again`;
        return b;
      }),
    );
  }

  private context(): CanvasRenderingContext2D | null {
    if (!this.canvas) this.canvas = document.createElement("canvas").getContext("2d");
    return this.canvas;
  }
}

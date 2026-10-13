/**
 * One question on a slide: results on the left (bars, cloud or likert), and on the
 * right the QR code, short URL, response count and status pill. Presenter
 * mode adds a control strip and word-cloud moderation.
 */

import type { ClientMessage, LikertResults, PollResults, QuestionState, WordcloudResults } from "../shared/protocol";
import { BarChart } from "./bars";
import { LikertChart } from "./likert";
import { WordCloud } from "./cloud";
import { button, h } from "./dom";
import { qrSvg } from "./qr";
import type { LinkStatus, LpQuestion } from "./types";

export interface ViewContext {
  /** Show the QR code and short URL. */
  qr: boolean;
  audienceUrl: string;
  shortUrl: string;
  send(msg: ClientMessage): boolean;
  /** Ask the controller to re-open this question (presenter "Reopen voting"). */
  open(q: LpQuestion): void;
}

export interface ViewState {
  question: QuestionState | null;
  /** Id of the question the audience is looking at. */
  live: string | null;
  link: LinkStatus;
  audience: number;
}

type Pill = "live" | "closed" | "offline";

const PILL_TEXT: Record<Pill, string> = { live: "LIVE", closed: "CLOSED", offline: "OFFLINE" };

export class QuestionView {
  private readonly chart: BarChart | WordCloud | LikertChart;
  private readonly main: HTMLElement;
  private readonly pill: HTMLElement;
  private readonly count: HTMLElement;
  private readonly countLabel: HTMLElement;
  private readonly joined: HTMLElement;
  private readonly controls: HTMLElement;
  private readonly toggleBtn: HTMLButtonElement;
  private presenter = false;
  private resultsOverride: boolean | null = null;
  private last: ViewState = { question: null, live: null, link: "connecting", audience: 0 };

  constructor(
    readonly el: HTMLElement,
    readonly q: LpQuestion,
    private readonly ctx: ViewContext,
  ) {
    el.classList.add("lq-active");
    const text = el.querySelector<HTMLElement>(":scope > .lq-text");
    const list = el.querySelector<HTMLElement>(":scope > ul, :scope > ol");
    list?.classList.add("lq-source");

    if (q.type === "poll") {
      this.chart = new BarChart(q.options, list ? Array.from(list.children) : []);
    } else if (q.type === "likert") {
      this.chart = new LikertChart(q, list ? Array.from(list.children) : []);
    } else {
      this.chart = new WordCloud((t, hidden) => ctx.send({ t: "hide", id: q.id, text: t, hidden }));
    }

    // Shown while results are hidden: under the options for a poll or likert,
    // centered over the (empty) cloud for a word cloud.
    const veil = h("div", { class: "lq-veil", text: "Results hidden" });
    if (!(this.chart instanceof WordCloud)) this.chart.el.append(veil);
    this.main = h("div", { class: "lq-main" }, text, this.chart.el,
      this.chart instanceof WordCloud ? veil : null);

    this.pill = h("span", { class: "lq-pill", attrs: { "data-state": "offline" }, text: "OFFLINE" });
    this.count = h("span", { class: "lq-count-n", text: "0" });
    this.countLabel = h("span", { class: "lq-count-label", text: "responses" });
    this.joined = h("span", { class: "lq-joined" });

    this.toggleBtn = button("Close voting", () => this.toggleVoting());
    this.controls = h(
      "div",
      { class: "lq-controls", attrs: { role: "toolbar", "aria-label": "Question controls" } },
      this.toggleBtn,
      button("Reset", () => this.reset(), "lq-danger"),
    );

    const side = h(
      "div",
      { class: "lq-side" },
      ctx.qr
        ? h("div", { class: "lq-qr" }, qrSvg(ctx.audienceUrl, `QR code for ${ctx.shortUrl}`))
        : null,
      ctx.qr ? h("div", { class: "lq-url", text: ctx.shortUrl }) : null,
      h("div", { class: "lq-count" }, this.count, this.countLabel),
      h("div", { class: "lq-meta" }, this.pill, this.joined),
      this.controls,
    );

    el.append(h("div", { class: "lq-body" }, this.main, side));
    this.applyResultsVisibility();
  }

  setPresenter(on: boolean): void {
    this.presenter = on;
    this.el.classList.toggle("lq-presenter", on);
    if (this.chart instanceof WordCloud) this.chart.setModerated(on);
  }

  update(state: ViewState): void {
    this.last = state;
    const qs = state.question;
    const results = qs?.results ?? null;

    if (this.chart instanceof BarChart) {
      this.chart.update(results?.type === "poll" ? (results as PollResults) : null, qs?.revealed ?? null);
    } else if (this.chart instanceof LikertChart) {
      this.chart.update(results?.type === "likert" ? (results as LikertResults) : null);
    } else {
      this.chart.update(results?.type === "wordcloud" ? (results as WordcloudResults) : null);
    }

    const voters = results?.voters ?? 0;
    this.count.textContent = String(voters);
    this.countLabel.textContent = voters === 1 ? "response" : "responses";
    this.joined.textContent = state.link === "online" ? `${state.audience} connected` : "";

    const pill: Pill = state.link !== "online"
      ? "offline"
      : state.live === this.q.id && qs?.status === "open" ? "live" : "closed";
    this.pill.dataset.state = pill;
    this.pill.textContent = PILL_TEXT[pill];
    this.el.dataset.status = pill;
    this.toggleBtn.textContent = pill === "live" ? "Close voting" : "Reopen voting";
    this.toggleBtn.disabled = pill === "offline";
    this.applyResultsVisibility();
  }

  /** `T`: flip results visibility on this slide. */
  toggleResults(): void {
    this.resultsOverride = !this.resultsVisible();
    this.applyResultsVisibility();
    this.refresh();
  }

  /** Force results visible (after revealing the answer). */
  showResults(): void {
    this.resultsOverride = true;
    this.applyResultsVisibility();
  }

  /** Re-measure: call when the slide becomes visible or its size changes. */
  refresh(): void {
    if (this.el.offsetParent === null) return;
    if (this.chart instanceof WordCloud) this.chart.layout();
    else this.fitBars();
  }

  /** Shrink bar or likert text until all rows fit in the results column. */
  private fitBars(): void {
    const bars = this.chart.el;
    let scale = 1;
    bars.style.setProperty("--lq-fit", "1");
    while (scale > 0.6 && bars.scrollHeight > this.main.clientHeight - this.textHeight() + 1) {
      scale -= 0.05;
      bars.style.setProperty("--lq-fit", scale.toFixed(2));
    }
  }

  private textHeight(): number {
    const text = this.main.querySelector<HTMLElement>(":scope > .lq-text");
    return text ? text.offsetHeight : 0;
  }

  private resultsVisible(): boolean {
    if (this.resultsOverride !== null) return this.resultsOverride;
    return this.q.results === "live" || (this.last.question?.revealed ?? null) !== null;
  }

  private applyResultsVisibility(): void {
    const visible = this.resultsVisible();
    this.el.classList.toggle("lq-results-hidden", !visible);
  }

  private toggleVoting(): void {
    if (this.el.dataset.status === "live") this.ctx.send({ t: "close", id: this.q.id });
    else this.ctx.open(this.q);
  }

  private reset(): void {
    const ok = window.confirm(`Clear all responses to “${this.q.prompt}”?`);
    if (ok) this.ctx.send({ t: "reset", id: this.q.id });
  }
}

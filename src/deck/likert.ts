/**
 * The likert chart. Labeled scales get one diverging stacked bar per
 * statement, centered on the neutral point; numeric scales get one small
 * histogram per statement with the mean marked.
 */

import type { LikertQuestion, LikertResults } from "../shared/protocol";
import { labelNodes } from "./bars";
import { h } from "./dom";

/** Which side of the scale a point is on, and how far from the middle (1 = nearest). */
export interface Tone {
  side: "neg" | "mid" | "pos";
  /** Step in a 5-step ramp, 1 (light, near the middle) to 5 (strong, at the end). */
  step: number;
}

/** Ramp steps used for each arm length, so a 3-point scale is not all pastel. */
const STEPS: Record<number, number[]> = { 1: [3], 2: [2, 4], 3: [1, 3, 5], 4: [1, 2, 4, 5], 5: [1, 2, 3, 4, 5] };

/** Color slot for each point of an n-point labeled scale. Odd scales have a neutral middle. */
export function tones(n: number): Tone[] {
  const arm = Math.floor(n / 2);
  const steps = STEPS[arm] ?? STEPS[5]!;
  return Array.from({ length: n }, (_, i) => {
    if (n % 2 === 1 && i === arm) return { side: "mid", step: 0 };
    const away = i < arm ? arm - i : i - (n - arm) + 1; // 1 = next to the middle
    return { side: i < arm ? "neg" : "pos", step: steps[away - 1]! };
  });
}

/**
 * One statement's diverging bar, as shares of its responses: where each
 * segment starts (relative to the center line, negative = left) and how wide
 * it is, plus the share left and right of the middle.
 */
export function diverging(counts: number[]): { start: number[]; width: number[]; neg: number; pos: number; total: number } {
  const n = counts.length;
  const total = counts.reduce((a, b) => a + b, 0);
  const share = counts.map((c) => (total > 0 ? c / total : 0));
  const arm = Math.floor(n / 2);
  const neutral = n % 2 === 1 ? share[arm]! : 0;
  const neg = share.slice(0, arm).reduce((a, b) => a + b, 0);
  const pos = share.slice(n - arm).reduce((a, b) => a + b, 0);
  let at = 0 - (neg + neutral / 2);
  const start = share.map((s) => {
    const x = at;
    at += s;
    return x;
  });
  return { start, width: share, neg, pos, total };
}

/**
 * The axis domain shared by every statement: how far the bars reach left and
 * right of the center line, rounded up to 10% (at least 20% a side). The
 * center sits at `left / (left + right)` of the track, so a lopsided result
 * uses the whole width instead of leaving one half empty.
 */
export function extent(rows: Array<{ start: number[]; width: number[] }>): { left: number; right: number } {
  let left = 0;
  let right = 0;
  for (const r of rows) {
    const last = r.start.length - 1;
    left = Math.max(left, -(r.start[0] ?? 0));
    right = Math.max(right, (r.start[last] ?? 0) + (r.width[last] ?? 0));
  }
  const round = (x: number) => Math.min(1, Math.max(0.2, Math.ceil(x * 10 - 1e-9) / 10));
  return { left: round(left), right: round(right) };
}

/** Mean and median scale value of a numeric statement, or null without responses. */
export function summary(counts: number[], values: number[]): { mean: number; median: number; total: number } | null {
  const total = counts.reduce((a, b) => a + b, 0);
  if (total === 0) return null;
  let sum = 0;
  counts.forEach((c, i) => (sum += c * values[i]!));
  // Median: the middle response, or the mean of the two middle ones.
  const nth = (k: number) => {
    let seen = 0;
    for (let i = 0; i < counts.length; i++) {
      seen += counts[i]!;
      if (seen > k) return values[i]!;
    }
    return values[values.length - 1]!;
  };
  const median = (nth(Math.floor((total - 1) / 2)) + nth(Math.ceil((total - 1) / 2))) / 2;
  return { mean: sum / total, median, total };
}

const pctText = (x: number) => `${Math.round(x * 100)}%`;
const responses = (n: number) => `${n} ${n === 1 ? "response" : "responses"}`;

interface DivergingRow {
  segs: HTMLElement[];
  pcts: HTMLElement[];
  neg: HTMLElement;
  pos: HTMLElement;
  n: HTMLElement;
}

interface HistRow {
  bars: HTMLElement[];
  counts: HTMLElement[];
  mean: HTMLElement;
  stats: HTMLElement;
  n: HTMLElement;
}

export class LikertChart {
  readonly el: HTMLElement;
  private readonly diverging: DivergingRow[] = [];
  private readonly axes: HTMLElement[] = [];
  private readonly hist: HistRow[] = [];
  private readonly values: number[];

  constructor(private readonly q: LikertQuestion, items: Element[]) {
    const n = q.labels.length;
    this.values = q.labels.map(Number);
    // A single statement taken from the prompt is already the slide's question.
    const showLabels = !(q.statements.length === 1 && q.statements[0] === q.prompt);
    const label = (i: number) => {
      const el = h("div", { class: "lq-lk-label" });
      el.append(...labelNodes(items[i], q.statements[i] ?? ""));
      return showLabels ? el : null;
    };

    const rows = h("div", { class: "lq-lk-rows" });
    if (!q.numeric) {
      const palette = tones(n);
      for (let s = 0; s < q.statements.length; s++) {
        const segs: HTMLElement[] = [];
        const pcts: HTMLElement[] = [];
        for (let p = 0; p < n; p++) {
          const pct = h("span", { class: "lq-lk-pct" });
          const seg = h("div", {
            class: "lq-lk-seg",
            attrs: { "data-side": palette[p]!.side, "data-step": String(palette[p]!.step), title: q.labels[p]! },
          }, pct);
          segs.push(seg);
          pcts.push(pct);
        }
        const neg = h("span", { class: "lq-lk-total lq-lk-neg" });
        const pos = h("span", { class: "lq-lk-total lq-lk-pos" });
        const count = h("span", { class: "lq-lk-n" });
        const axis = h("div", { class: "lq-lk-axis" });
        this.axes.push(axis);
        rows.append(
          h(
            "div",
            { class: "lq-lk-row" },
            h("div", { class: "lq-lk-head" }, label(s), count),
            h("div", { class: "lq-lk-line" }, neg, h("div", { class: "lq-lk-track" }, axis, ...segs), pos),
          ),
        );
        this.diverging.push({ segs, pcts, neg, pos, n: count });
      }
    } else {
      for (let s = 0; s < q.statements.length; s++) {
        const bars: HTMLElement[] = [];
        const counts: HTMLElement[] = [];
        const cols = q.labels.map(() => {
          const c = h("span", { class: "lq-hist-n" });
          const bar = h("div", { class: "lq-hist-bar" }, c);
          bars.push(bar);
          counts.push(c);
          return h("div", { class: "lq-hist-col" }, bar);
        });
        const mean = h("div", { class: "lq-hist-mean", attrs: { "aria-hidden": "true" } });
        const axis = h("div", { class: "lq-hist-axis" }, ...q.labels.map((l) => h("span", { text: l })));
        const stats = h("span", { class: "lq-lk-stats" });
        const count = h("span", { class: "lq-lk-n" });
        rows.append(
          h(
            "div",
            { class: "lq-lk-row" },
            h("div", { class: "lq-lk-head" }, label(s), h("span", { class: "lq-lk-meta" }, stats, count)),
            h("div", { class: "lq-hist" }, ...cols, mean),
            axis,
          ),
        );
        this.hist.push({ bars, counts, mean, stats, n: count });
      }
    }

    this.el = h(
      "div",
      {
        // With one point per side, the side totals would repeat the segment percentages.
        class: `lq-likert ${q.numeric ? "lq-lk-numeric" : "lq-lk-labeled"}${n <= 3 ? " lq-lk-short" : ""}`,
        attrs: { "data-statements": String(q.statements.length) },
      },
      this.legend(),
      rows,
    );
    this.el.style.setProperty("--lq-points", String(n));
  }

  /** Labeled: swatch and label per point. Numeric: the end anchors, if any. */
  private legend(): HTMLElement | null {
    const q = this.q;
    if (q.numeric) {
      const end = (value: string, text: string | undefined) =>
        text ? h("span", { class: "lq-lk-anchor" }, h("b", { text: value }), ` ${text}`) : null;
      const anchored = !!(q.anchors?.[0] || q.anchors?.[1]);
      return h(
        "div",
        { class: "lq-lk-legend lq-lk-anchors" },
        end(q.labels[0]!, q.anchors?.[0]),
        anchored ? h("span", { class: "lq-lk-dash", attrs: { "aria-hidden": "true" } }) : null,
        end(q.labels[q.labels.length - 1]!, q.anchors?.[1]),
        h("span", { class: "lq-lk-key lq-lk-mean-key" }, h("i", { class: "lq-lk-mean-icon" }), "mean"),
      );
    }
    const palette = tones(q.labels.length);
    return h(
      "div",
      { class: "lq-lk-legend" },
      ...q.labels.map((l, i) =>
        h(
          "span",
          { class: "lq-lk-key" },
          h("i", { class: "lq-lk-swatch", attrs: { "data-side": palette[i]!.side, "data-step": String(palette[i]!.step) } }),
          l,
        ),
      ),
    );
  }

  update(results: LikertResults | null): void {
    const counts = this.q.statements.map((_, s) => this.q.labels.map((__, p) => results?.counts[s]?.[p] ?? 0));
    if (!this.q.numeric) this.updateDiverging(counts);
    else this.updateHist(counts);
  }

  private updateDiverging(counts: number[][]): void {
    const bars = counts.map((c) => diverging(c));
    const { left, right } = extent(bars);
    // Percent of the track for a position relative to the center line.
    const span = left + right;
    const at = (x: number) => ((x + left) / span) * 100;
    for (const axis of this.axes) axis.style.left = `${at(0).toFixed(3)}%`;
    bars.forEach((b, s) => {
      const row = this.diverging[s]!;
      row.segs.forEach((seg, p) => {
        const w = b.width[p] ?? 0;
        seg.style.left = `${at(b.start[p] ?? 0).toFixed(3)}%`;
        seg.style.width = `${((w / span) * 100).toFixed(3)}%`;
        seg.classList.toggle("lq-lk-zero", w === 0);
        row.pcts[p]!.textContent = w > 0 ? pctText(w) : "";
      });
      row.neg.textContent = b.total > 0 ? pctText(b.neg) : "";
      row.pos.textContent = b.total > 0 ? pctText(b.pos) : "";
      row.n.textContent = responses(b.total);
    });
  }

  private updateHist(counts: number[][]): void {
    const max = Math.max(0, ...counts.flat());
    const n = this.q.labels.length;
    counts.forEach((c, s) => {
      const row = this.hist[s]!;
      c.forEach((count, p) => {
        row.bars[p]!.style.height = max > 0 ? `${((count / max) * 100).toFixed(2)}%` : "0%";
        row.bars[p]!.classList.toggle("lq-hist-empty", count === 0);
        row.counts[p]!.textContent = count > 0 ? String(count) : "";
      });
      const sum = summary(c, this.values);
      row.n.textContent = responses(sum?.total ?? 0);
      row.stats.textContent = sum ? `mean ${sum.mean.toFixed(1)} \u00b7 median ${sum.median}` : "";
      row.mean.hidden = !sum;
      if (sum) {
        // Column centers sit at (i + 0.5) / n of the width (the columns' gaps are equal).
        const x = ((sum.mean - this.values[0]! + 0.5) / n) * 100;
        row.mean.style.left = `${x.toFixed(3)}%`;
      }
    });
  }
}

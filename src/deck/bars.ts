/** The bar chart: one row per option, label HTML taken from the original list. */

import type { PollResults } from "../shared/protocol";
import { h } from "./dom";

interface Row {
  el: HTMLElement;
  fill: HTMLElement;
  pct: HTMLElement;
  count: HTMLElement;
}

/** The option's label content, cloned from its <li> (unwrapping a lone <p>). */
export function labelNodes(li: Element | undefined, fallback: string): Node[] {
  if (!li) return [document.createTextNode(fallback)];
  const only = li.children.length === 1 && li.firstElementChild?.tagName === "P"
    && li.textContent?.trim() === li.firstElementChild.textContent?.trim();
  const source = only ? li.firstElementChild! : li;
  return Array.from(source.childNodes, (n) => n.cloneNode(true));
}

export class BarChart {
  readonly el: HTMLElement;
  private readonly rows: Row[];

  constructor(options: string[], items: Element[]) {
    this.rows = options.map((text, i) => {
      const fill = h("div", { class: "lq-fill" });
      const pct = h("span", { class: "lq-pct", text: "0%" });
      const count = h("span", { class: "lq-n", text: "0" });
      const label = h("div", { class: "lq-label" });
      label.append(...labelNodes(items[i], text));
      const el = h(
        "div",
        { class: "lq-row" },
        label,
        h("div", { class: "lq-track" }, fill),
        h("div", { class: "lq-stat" }, count, pct),
      );
      return { el, fill, pct, count };
    });
    this.el = h("div", { class: "lq-bars" }, ...this.rows.map((r) => r.el));
  }

  update(results: PollResults | null, correct: number[] | null): void {
    const counts = this.rows.map((_, i) => results?.counts[i] ?? 0);
    const total = counts.reduce((a, b) => a + b, 0);
    const max = Math.max(0, ...counts);
    this.rows.forEach((row, i) => {
      const n = counts[i] ?? 0;
      const share = total > 0 ? n / total : 0;
      // Widths are relative to the leading option so differences stay visible.
      row.fill.style.width = max > 0 ? `${((n / max) * 100).toFixed(2)}%` : "0%";
      row.pct.textContent = `${Math.round(share * 100)}%`;
      row.count.textContent = String(n);
      row.el.classList.toggle("lq-lead", max > 0 && n === max);
      row.el.classList.toggle("lq-correct", !!correct && correct.includes(i));
      row.el.classList.toggle("lq-dim", !!correct && !correct.includes(i));
    });
    this.el.classList.toggle("lq-revealed", !!correct);
  }
}

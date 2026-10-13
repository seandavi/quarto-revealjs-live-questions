/** The full-screen QR overlay (`Q`) and short status toasts. */

import { h } from "./dom";
import { qrSvg } from "./qr";

export class QrOverlay {
  private readonly el: HTMLElement;

  constructor(parent: HTMLElement, url: string, short: string) {
    this.el = h(
      "div",
      { class: "lq-overlay", attrs: { role: "dialog", "aria-label": "Scan to join" } },
      h(
        "div",
        { class: "lq-overlay-card" },
        h("div", { class: "lq-overlay-title", text: "Scan to join" }),
        h("div", { class: "lq-overlay-qr" }, qrSvg(url, `QR code for ${short}`)),
        h("div", { class: "lq-overlay-url", text: short }),
      ),
    );
    this.el.hidden = true;
    this.el.addEventListener("click", () => this.hide());
    parent.append(this.el);
    // Escape closes the overlay instead of opening reveal's overview.
    document.addEventListener(
      "keydown",
      (e) => {
        if (!this.el.hidden && e.key === "Escape") {
          e.preventDefault();
          e.stopImmediatePropagation();
          this.hide();
        }
      },
      true,
    );
  }

  get open(): boolean {
    return !this.el.hidden;
  }

  toggle(): void {
    if (this.open) this.hide();
    else this.el.hidden = false;
  }

  hide(): void {
    this.el.hidden = true;
  }
}

export class Toast {
  private readonly el: HTMLElement;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(parent: HTMLElement) {
    this.el = h("div", { class: "lq-toast", attrs: { role: "status", "aria-live": "polite" } });
    parent.append(this.el);
  }

  show(text: string, ms = 2600): void {
    this.el.textContent = text;
    this.el.classList.add("lq-show");
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.el.classList.remove("lq-show"), ms);
  }
}

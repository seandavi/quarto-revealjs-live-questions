/** Types local to the deck plugin. Wire types live in src/shared/protocol.ts. */

import type { Question } from "../shared/protocol";

/** The part of the reveal.js API this plugin uses. */
export interface RevealApi {
  on(event: string, callback: (event: Event) => void): void;
  getCurrentSlide(): HTMLElement | undefined;
  getRevealElement(): HTMLElement;
  getConfig(): { width: number | string; height: number | string; [key: string]: unknown };
  getScale(): number;
  isPrintView(): boolean;
  addKeyBinding(
    binding: { keyCode: number; key: string; description: string },
    callback: () => void,
  ): void;
}

export type ResultsMode = "live" | "hidden";

/** What the Lua filter writes into `data-lq`. */
export type LpQuestion = Question & {
  /** Poll only: correct option indices; absent if the poll has no right answer. */
  correct?: number[];
  results: ResultsMode;
};

/** What the Lua filter writes into `script#lq-config`. */
export interface LpConfig {
  server?: string;
  session: string;
  closeOnLeave: boolean;
  results: ResultsMode;
  qr: boolean;
}

export type Mode = "static" | "viewer" | "presenter" | "embedded";

/** Connection state as the slide shows it. */
export type LinkStatus = "connecting" | "online" | "offline";

/**
 * Entry point, bundled to _extensions/live-poll/live-poll.js as an IIFE.
 * Quarto lists `RevealLivePoll` in Reveal.initialize({ plugins: [...] }), so
 * the global must be a function returning the plugin object.
 */

import { LivePoll } from "./live-poll";
import type { RevealApi } from "./types";

function RevealLivePoll() {
  return {
    id: "RevealLivePoll",
    init(deck: RevealApi) {
      try {
        new LivePoll(deck).init();
      } catch (err) {
        // Never take the deck down with us.
        console.error("[live-poll] failed to start", err);
      }
    },
  };
}

(window as unknown as { RevealLivePoll: typeof RevealLivePoll }).RevealLivePoll = RevealLivePoll;

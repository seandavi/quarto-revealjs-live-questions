/**
 * Entry point, bundled to _extensions/live-questions/live-questions.js as an IIFE.
 * Quarto lists `RevealLiveQuestions` in Reveal.initialize({ plugins: [...] }), so
 * the global must be a function returning the plugin object.
 */

import { LiveQuestions } from "./live-questions";
import type { RevealApi } from "./types";

function RevealLiveQuestions() {
  return {
    id: "RevealLiveQuestions",
    init(deck: RevealApi) {
      try {
        new LiveQuestions(deck).init();
      } catch (err) {
        // Never take the deck down with us.
        console.error("[live-questions] failed to start", err);
      }
    },
  };
}

(window as unknown as { RevealLiveQuestions: typeof RevealLiveQuestions }).RevealLiveQuestions = RevealLiveQuestions;

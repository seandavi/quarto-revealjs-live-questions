/**
 * Parse and validate raw client messages against the protocol and LIMITS.
 *
 * Hand-rolled (no schema library) to keep the Worker bundle small. Every
 * validator returns a fresh object holding only known fields, so extra
 * properties a client sends (for example a deck that forwards its `correct`
 * answers inside a question) never reach the room, storage or other clients.
 */
import {
  DEFAULTS,
  LIMITS,
  type ClientMessage,
  type Question,
  type Role,
} from "../shared/protocol";

/**
 * Voter ids are client-generated (the audience page uses a UUID). Anything
 * printable without spaces, up to 64 characters, is accepted.
 */
export const VOTER_PATTERN = /^[\x21-\x7e]{1,64}$/;
/** Presenter keys longer than this are rejected outright. */
export const MAX_KEY_CHARS = 256;

export type Parsed = { ok: true; msg: ClientMessage } | { ok: false; message: string };

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
const isId = (v: unknown): v is string => typeof v === "string" && LIMITS.questionIdPattern.test(v);
const isText = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;

export const isSession = (v: unknown): v is string =>
  typeof v === "string" && LIMITS.sessionPattern.test(v);

/** Validate a question definition. Returns the clean question or an error string. */
export function validateQuestion(v: unknown): Question | string {
  if (!isObj(v)) return "question must be an object";
  if (!isId(v.id)) return "invalid question id";
  if (!isText(v.prompt, LIMITS.promptChars)) return `prompt must be a string of at most ${LIMITS.promptChars} characters`;
  if (v.type === "poll") {
    const options = v.options;
    if (!Array.isArray(options) || options.length < 1 || options.length > LIMITS.pollOptions) {
      return `a poll needs 1 to ${LIMITS.pollOptions} options`;
    }
    if (!options.every((o) => isText(o, LIMITS.optionChars))) {
      return `options must be strings of at most ${LIMITS.optionChars} characters`;
    }
    return { type: "poll", id: v.id, prompt: v.prompt, options: [...(options as string[])] };
  }
  if (v.type === "wordcloud") {
    const maxWords = v.maxWords ?? DEFAULTS.maxWords;
    const maxAnswers = v.maxAnswers ?? DEFAULTS.maxAnswers;
    if (!isInt(maxWords) || maxWords < 1 || maxWords > LIMITS.maxWordsCeiling) {
      return `maxWords must be an integer from 1 to ${LIMITS.maxWordsCeiling}`;
    }
    if (!isInt(maxAnswers) || maxAnswers < 1 || maxAnswers > LIMITS.maxAnswersCeiling) {
      return `maxAnswers must be an integer from 1 to ${LIMITS.maxAnswersCeiling}`;
    }
    return { type: "wordcloud", id: v.id, prompt: v.prompt, maxWords, maxAnswers };
  }
  return "question type must be 'poll' or 'wordcloud'";
}

/** Validate an already-decoded message. */
export function validateMessage(v: unknown): Parsed {
  const bad = (message: string): Parsed => ({ ok: false, message });
  const good = (msg: ClientMessage): Parsed => ({ ok: true, msg });
  if (!isObj(v)) return bad("message must be a JSON object");
  switch (v.t) {
    case "hello": {
      if (typeof v.v !== "number") return bad("hello.v must be a number");
      if (v.role !== "deck" && v.role !== "audience") return bad("hello.role must be 'deck' or 'audience'");
      if (typeof v.voter !== "string" || !VOTER_PATTERN.test(v.voter)) return bad("invalid voter id");
      if (v.key !== undefined && !isText(v.key, MAX_KEY_CHARS)) return bad("invalid key");
      const msg: ClientMessage = { t: "hello", v: v.v, role: v.role as Role, voter: v.voter };
      if (typeof v.key === "string") msg.key = v.key;
      return good(msg);
    }
    case "open": {
      const question = validateQuestion(v.question);
      return typeof question === "string" ? bad(question) : good({ t: "open", question });
    }
    case "close":
      return isId(v.id) ? good({ t: "close", id: v.id }) : bad("invalid question id");
    case "reveal": {
      if (!isId(v.id)) return bad("invalid question id");
      const c = v.correct;
      if (!Array.isArray(c) || c.length > LIMITS.pollOptions || !c.every((i) => isInt(i) && i >= 0)) {
        return bad("correct must be an array of option indices");
      }
      return good({ t: "reveal", id: v.id, correct: [...(c as number[])] });
    }
    case "reset":
      if (v.id === undefined || v.id === null) return good({ t: "reset" });
      return isId(v.id) ? good({ t: "reset", id: v.id }) : bad("invalid question id");
    case "hide":
      if (!isId(v.id)) return bad("invalid question id");
      if (!isText(v.text, LIMITS.answerInputChars)) return bad("invalid text");
      if (typeof v.hidden !== "boolean") return bad("hidden must be a boolean");
      return good({ t: "hide", id: v.id, text: v.text, hidden: v.hidden });
    case "vote":
      if (!isId(v.id)) return bad("invalid question id");
      if (!isInt(v.choice)) return bad("choice must be an integer");
      return good({ t: "vote", id: v.id, choice: v.choice });
    case "answer":
      if (!isId(v.id)) return bad("invalid question id");
      if (!isText(v.text, LIMITS.answerInputChars)) {
        return bad(`answers are at most ${LIMITS.answerInputChars} characters`);
      }
      return good({ t: "answer", id: v.id, text: v.text });
    case "ping":
      return good({ t: "ping" });
    default:
      return bad("unknown message type");
  }
}

/** Decode and validate a raw WebSocket text frame. */
export function parseMessage(raw: string): Parsed {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, message: "message is not valid JSON" };
  }
  return validateMessage(value);
}

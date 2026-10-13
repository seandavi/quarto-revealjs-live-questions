/**
 * Wire protocol shared by the deck plugin, the audience page and the server.
 *
 * Every client holds one WebSocket to `/api/s/<session>/ws` and exchanges
 * JSON-encoded messages. The first message a client sends must be `hello`.
 * The server answers `welcome`, then pushes state whenever it changes:
 *
 * - deck sockets receive `deck` (every question in the session, with results)
 * - audience sockets receive `audience` (only the live question) and `you`
 *   (that voter's own votes, answers and ratings)
 *
 * Only a deck socket whose `hello` carried the server's presenter key may send
 * `open`, `close`, `reveal`, `reset` or `hide`. Only audience sockets vote.
 */

export const PROTOCOL_VERSION = 1;

/** Limits enforced by the server. The Lua filter and deck plugin respect them too. */
export const LIMITS = {
  /** Session names: also the Durable Object name and part of the audience URL. */
  sessionPattern: /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/,
  /** Question ids: the fenced div's id, or a generated one. */
  questionIdPattern: /^[A-Za-z0-9][A-Za-z0-9_:.-]{0,63}$/,
  promptChars: 500,
  pollOptions: 26,
  optionChars: 200,
  /** Raw answer text accepted from a phone, before normalization. */
  answerInputChars: 200,
  /** A normalized word-cloud entry is cut to this many characters. */
  answerChars: 40,
  maxWordsCeiling: 10,
  maxAnswersCeiling: 10,
  /** Word-cloud entries included in broadcast results (most frequent first). */
  cloudWords: 100,
  /** Statements in one likert question. */
  likertStatements: 6,
  likertStatementChars: 200,
  /** Points on a likert scale: at least 2, at most this many. */
  likertPoints: 11,
  /** One scale label, and one numeric-scale anchor. */
  likertLabelChars: 40,
} as const;

export const DEFAULTS = {
  maxWords: 3,
  maxAnswers: 3,
} as const;

export type QuestionId = string;

/** Multiple choice. Results render as a bar chart. */
export interface PollQuestion {
  type: "poll";
  id: QuestionId;
  /** Plain text. */
  prompt: string;
  /** Plain-text option labels, in slide order. */
  options: string[];
}

/** Short free-text answers. Results render as a word cloud. */
export interface WordcloudQuestion {
  type: "wordcloud";
  id: QuestionId;
  prompt: string;
  /** Words kept per answer; longer answers are truncated. */
  maxWords: number;
  /** Distinct answers one voter may submit to this question. */
  maxAnswers: number;
}

/**
 * Rating scale. Every statement is rated on the same ordered scale. Results
 * render as one diverging stacked bar per statement (labeled scales) or one
 * small histogram per statement (numeric scales).
 *
 * The Lua filter resolves scale presets (`agree-5`, `agree-7`, `0-10`, ...)
 * into explicit labels, so the server never knows preset names. A labeled
 * scale with an odd number of points has a neutral middle point; an even one
 * has none.
 */
export interface LikertQuestion {
  type: "likert";
  id: QuestionId;
  prompt: string;
  /** Plain-text statements, 1 to LIMITS.likertStatements, in slide order. */
  statements: string[];
  /** Scale point labels, low to high, 2 to LIMITS.likertPoints. */
  labels: string[];
  /**
   * A numeric scale: `labels` are consecutive integers as strings
   * ("0", "1", ... "10"), so a mean is meaningful. Never split at a neutral
   * point.
   */
  numeric: boolean;
  /**
   * Numeric scales only: optional words for the two ends, e.g.
   * ["Not at all", "Completely"]. Always null for labeled scales.
   */
  anchors: [string, string] | null;
}

/**
 * A question as the deck sends it to the server. Correct answers are never
 * part of the definition; the presenter discloses them with `reveal`.
 */
export type Question = PollQuestion | WordcloudQuestion | LikertQuestion;

export type Status = "open" | "closed";

export interface PollResults {
  type: "poll";
  /** One count per option, same order as `options`. */
  counts: number[];
  /** Distinct voters with a current vote. */
  voters: number;
}

export interface CloudWord {
  /** Display form: the first spelling the server saw for this entry. */
  text: string;
  count: number;
}

export interface WordcloudResults {
  type: "wordcloud";
  /** Most frequent first, at most LIMITS.cloudWords, hidden entries removed. */
  words: CloudWord[];
  /** Distinct voters who submitted at least one answer. */
  voters: number;
  /**
   * Display forms the presenter has hidden. Only present in the presenter's
   * `deck` message; omitted for everyone else.
   */
  hidden?: string[];
}

export interface LikertResults {
  type: "likert";
  /**
   * `counts[s][p]`: voters whose current rating of statement `s` is scale
   * point `p`. One row per statement, one column per label.
   */
  counts: number[][];
  /** Distinct voters who rated at least one statement. */
  voters: number;
}

export type Results = PollResults | WordcloudResults | LikertResults;

export interface QuestionState {
  question: Question;
  status: Status;
  results: Results;
  /** Poll only: correct option indices once the presenter has revealed them. */
  revealed: number[] | null;
}

/** What every deck (presenter or viewer) is told. */
export interface DeckState {
  session: string;
  /** The question the audience is looking at, open or just closed. */
  live: QuestionId | null;
  questions: Record<QuestionId, QuestionState>;
  /** Audience sockets currently connected. */
  audience: number;
}

/** What phones are told: only the live question. */
export interface AudienceState {
  session: string;
  live: {
    question: Question;
    status: Status;
    /** Withheld (null) while the question is open, to avoid bandwagoning. */
    results: Results | null;
    revealed: number[] | null;
  } | null;
}

/** One voter's own submissions, so a reloaded phone shows what it already sent. */
export interface Mine {
  /** Poll question id → chosen option index. */
  votes: Record<QuestionId, number>;
  /** Word-cloud question id → normalized answers, in submission order. */
  answers: Record<QuestionId, string[]>;
  /**
   * Likert question id → this voter's scale point per statement, null where
   * the statement is not rated yet. Only questions with at least one rating.
   */
  ratings: Record<QuestionId, Array<number | null>>;
}

export type Role = "deck" | "audience";

export type ClientMessage =
  /** First message on every socket. `voter` is a random id the client keeps. */
  | { t: "hello"; v: number; role: Role; voter: string; key?: string }
  // Presenter only.
  /**
   * Make this question live, closing whichever was live before. Re-opening
   * a known question keeps its votes unless its definition changed, in which
   * case its votes are cleared.
   */
  | { t: "open"; question: Question }
  | { t: "close"; id: QuestionId }
  | { t: "reveal"; id: QuestionId; correct: number[] }
  /** Clear votes for one question, or for the whole session if `id` is omitted. */
  | { t: "reset"; id?: QuestionId }
  /** Hide or unhide a word-cloud entry; `text` is matched after normalization. */
  | { t: "hide"; id: QuestionId; text: string; hidden: boolean }
  // Audience only. Rejected unless `id` is the live question and it is open.
  /** Poll: last vote wins. */
  | { t: "vote"; id: QuestionId; choice: number }
  /** Word cloud. */
  | { t: "answer"; id: QuestionId; text: string }
  /** Likert: rate statement `statement` at scale point `choice`. Last rating per statement wins. */
  | { t: "rate"; id: QuestionId; statement: number; choice: number }
  | { t: "ping" };

export type ErrorCode =
  | "bad-message" // unparseable, unknown type, or fails validation
  | "not-hello" // a message arrived before `hello`
  | "version" // `hello.v` is not PROTOCOL_VERSION
  | "forbidden" // presenter-only message without presenter rights, or wrong role
  | "unknown-question"
  | "closed" // vote/answer/rate for a question that is not live and open
  | "limit"; // too many answers, or a rate limit

export type ServerMessage =
  | { t: "welcome"; v: number; presenter: boolean }
  | { t: "deck"; state: DeckState }
  | { t: "audience"; state: AudienceState }
  | { t: "you"; mine: Mine }
  | { t: "error"; code: ErrorCode; message: string }
  | { t: "pong" };

/** Path of the audience page for a session, relative to the server origin. */
export const audiencePath = (session: string) => `/s/${encodeURIComponent(session)}`;

/** Path of the WebSocket endpoint for a session, relative to the server origin. */
export const socketPath = (session: string) => `/api/s/${encodeURIComponent(session)}/ws`;

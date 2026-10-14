/**
 * Room core: one session's questions, votes, answers and ratings.
 *
 * Pure TypeScript with no I/O, timers or runtime APIs, so it type-checks for
 * both Node and Workers and every rule in SPEC.md "Room rules" is unit-tested
 * here once. Adapters feed it validated client messages (see validate.ts) and
 * ship the states it produces.
 */
import {
  LIMITS,
  type AudienceState,
  type ClientMessage,
  type CloudWord,
  type DeckState,
  type ErrorCode,
  type Mine,
  type Question,
  type QuestionId,
  type QuestionState,
  type Results,
  type Role,
  type Status,
} from "../shared/protocol";
import { normalizeAnswer } from "../shared/normalize";
import { validateQuestion } from "./validate";

/** Who sent a message, as established by that socket's `hello`. */
export interface Sender {
  role: Role;
  voter: string;
  presenter: boolean;
}

/** Messages the room handles (everything except `hello` and `ping`). */
export type RoomMessage = Exclude<ClientMessage, { t: "hello" } | { t: "ping" }>;

export type Outcome =
  | {
      ok: true;
      /** Room state changed: broadcast and persist. */
      changed: boolean;
      /** The sender's own `Mine` changed: send them `you`. */
      mineChanged: boolean;
      /** Other voters' `Mine` may have changed too (reset, redefinition). */
      allMineChanged: boolean;
    }
  | { ok: false; code: ErrorCode; message: string };

interface Answer {
  key: string;
  text: string;
}

interface Entry {
  question: Question;
  status: Status;
  revealed: number[] | null;
  /** voter → option index (polls). */
  votes: Map<string, number>;
  /** voter → answers in submission order (word clouds). */
  answers: Map<string, Answer[]>;
  /** voter → scale point per statement, null where unrated (likert). */
  ratings: Map<string, Array<number | null>>;
  /** key → first spelling seen; insertion order breaks count ties. */
  display: Map<string, string>;
  /** key → display form of hidden entries. */
  hidden: Map<string, string>;
}

/** Serialized room, as stored by both adapters. Plain JSON. */
export interface RoomData {
  v: 1;
  session: string;
  live: QuestionId | null;
  questions: Array<{
    question: Question;
    status: Status;
    revealed: number[] | null;
    votes: Array<[string, number]>;
    answers: Array<[string, Answer[]]>;
    /** Absent in rooms stored before likert questions existed. */
    ratings?: Array<[string, Array<number | null>]>;
    display: Array<[string, string]>;
    hidden: Array<[string, string]>;
  }>;
}

/** One stored question. */
export type QuestionData = RoomData["questions"][number];

/**
 * What changed since the last `takeChanges()`, for an adapter that stores
 * each question under its own key (Cloudflare, where one stored value is
 * capped at 2 MB).
 */
export interface RoomChanges {
  /** `live` and the question order, when either may have changed. */
  index: { live: QuestionId | null; order: QuestionId[] } | null;
  /** Questions created or changed. */
  questions: QuestionData[];
  /** Questions that existed at the last `takeChanges()` and are now gone. */
  removed: QuestionId[];
}

const ok = (changed: boolean, mineChanged = false, allMineChanged = false): Outcome => ({
  ok: true,
  changed,
  mineChanged,
  allMineChanged,
});
const fail = (code: ErrorCode, message: string): Outcome => ({ ok: false, code, message });

const PRESENTER_ONLY = new Set(["open", "close", "reveal", "reset", "hide"]);

function sameQuestion(a: Question, b: Question): boolean {
  if (a.type !== b.type || a.id !== b.id || a.prompt !== b.prompt) return false;
  if (a.type === "poll" && b.type === "poll") {
    return a.options.length === b.options.length && a.options.every((o, i) => o === b.options[i]);
  }
  if (a.type === "wordcloud" && b.type === "wordcloud") {
    return a.maxWords === b.maxWords && a.maxAnswers === b.maxAnswers;
  }
  if (a.type === "likert" && b.type === "likert") {
    return (
      a.numeric === b.numeric &&
      sameStrings(a.statements, b.statements) &&
      sameStrings(a.labels, b.labels) &&
      (a.anchors === null ? b.anchors === null : b.anchors !== null && sameStrings(a.anchors, b.anchors))
    );
  }
  return false;
}

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function newEntry(question: Question): Entry {
  return {
    question,
    status: "open",
    revealed: null,
    votes: new Map(),
    answers: new Map(),
    ratings: new Map(),
    display: new Map(),
    hidden: new Map(),
  };
}

function clearResults(e: Entry): void {
  e.revealed = null;
  e.votes.clear();
  e.answers.clear();
  e.ratings.clear();
  e.display.clear();
  e.hidden.clear();
}

export class Room {
  readonly session: string;
  private live: QuestionId | null = null;
  private readonly questions = new Map<QuestionId, Entry>();
  /** Change tracking for `takeChanges()`. */
  private readonly dirty = new Set<QuestionId>();
  private indexDirty = false;
  private stored = new Set<QuestionId>();

  private constructor(session: string) {
    this.session = session;
  }

  /** An empty room for `session`. */
  static create(session: string): Room {
    return new Room(session);
  }

  /**
   * Rebuild a room from `dump()` output. Tolerates missing or malformed data
   * (skipping bad entries) so a damaged file never takes a session down.
   */
  static restore(session: string, data?: unknown): Room {
    const room = new Room(session);
    if (!data || typeof data !== "object") return room;
    const d = data as Partial<RoomData>;
    for (const q of Array.isArray(d.questions) ? d.questions : []) {
      const question = validateQuestion(q?.question);
      if (typeof question === "string") continue;
      const e = newEntry(question);
      e.status = q.status === "closed" ? "closed" : "open";
      if (question.type === "poll") {
        const n = question.options.length;
        if (Array.isArray(q.revealed)) {
          e.revealed = q.revealed.filter((i) => Number.isInteger(i) && i >= 0 && i < n);
        }
        for (const [voter, choice] of pairs(q.votes)) {
          if (typeof voter === "string" && typeof choice === "number" && Number.isInteger(choice) && choice >= 0 && choice < n) {
            e.votes.set(voter, choice);
          }
        }
      } else if (question.type === "likert") {
        const n = question.labels.length;
        const valid = (r: unknown) => r === null || (typeof r === "number" && Number.isInteger(r) && r >= 0 && r < n);
        for (const [voter, list] of pairs(q.ratings)) {
          if (typeof voter !== "string" || !Array.isArray(list) || list.length !== question.statements.length) continue;
          if (!list.every(valid) || list.every((r) => r === null)) continue;
          e.ratings.set(voter, list as Array<number | null>);
        }
      } else {
        for (const [key, text] of pairs(q.display)) {
          if (typeof key === "string" && typeof text === "string") e.display.set(key, text);
        }
        for (const [key, text] of pairs(q.hidden)) {
          if (typeof key === "string" && typeof text === "string") e.hidden.set(key, text);
        }
        for (const [voter, list] of pairs(q.answers)) {
          if (typeof voter !== "string" || !Array.isArray(list)) continue;
          const answers = list
            .filter((a): a is Answer => typeof a?.key === "string" && typeof a?.text === "string")
            .slice(0, question.maxAnswers);
          if (answers.length) e.answers.set(voter, answers);
          for (const a of answers) if (!e.display.has(a.key)) e.display.set(a.key, a.text);
        }
      }
      room.questions.set(question.id, e);
    }
    if (typeof d.live === "string" && room.questions.has(d.live)) room.live = d.live;
    room.stored = new Set(room.questions.keys());
    return room;
  }

  /** Serialize for storage. `Room.restore(session, room.dump())` round-trips. */
  dump(): RoomData {
    return {
      v: 1,
      session: this.session,
      live: this.live,
      questions: [...this.questions.values()].map(dumpEntry),
    };
  }

  /**
   * The changes since the last call (or since `restore`/`create`), then
   * forget them. Only an adapter that stores questions separately calls it.
   */
  takeChanges(): RoomChanges {
    const questions: QuestionData[] = [];
    for (const id of this.dirty) {
      const e = this.questions.get(id);
      if (e) questions.push(dumpEntry(e));
    }
    const removed = [...this.stored].filter((id) => !this.questions.has(id));
    const index = this.indexDirty ? { live: this.live, order: [...this.questions.keys()] } : null;
    this.dirty.clear();
    this.indexDirty = false;
    this.stored = new Set(this.questions.keys());
    return { index, questions, removed };
  }

  /** Apply one validated message from `sender`. Never throws. */
  apply(sender: Sender, msg: RoomMessage): Outcome {
    if (PRESENTER_ONLY.has(msg.t)) {
      if (!sender.presenter || sender.role !== "deck") {
        return fail("forbidden", `'${msg.t}' requires the presenter key`);
      }
    } else if (sender.role !== "audience") {
      return fail("forbidden", `'${msg.t}' is for audience sockets only`);
    }
    const previousLive = this.live;
    const outcome = this.dispatch(sender, msg);
    if (outcome.ok && outcome.changed) this.track(msg, previousLive);
    return outcome;
  }

  /** Record which stored parts a change touched. */
  private track(msg: RoomMessage, previousLive: QuestionId | null): void {
    if (msg.t === "open") {
      // Opening also closes the previously live question.
      this.dirty.add(msg.question.id);
      if (previousLive !== null) this.dirty.add(previousLive);
      this.indexDirty = true;
    } else if (msg.id === undefined) {
      // `reset` of the whole session
      this.dirty.clear();
      this.indexDirty = true;
    } else {
      this.dirty.add(msg.id);
    }
  }

  private dispatch(sender: Sender, msg: RoomMessage): Outcome {
    switch (msg.t) {
      case "open":
        return this.open(msg.question);
      case "close":
        return this.close(msg.id);
      case "reveal":
        return this.reveal(msg.id, msg.correct);
      case "reset":
        return this.reset(msg.id);
      case "hide":
        return this.hide(msg.id, msg.text, msg.hidden);
      case "vote":
        return this.vote(sender.voter, msg.id, msg.choice);
      case "answer":
        return this.answer(sender.voter, msg.id, msg.text);
      case "rate":
        return this.rate(sender.voter, msg.id, msg.statement, msg.choice);
    }
  }

  private open(question: Question): Outcome {
    const existing = this.questions.get(question.id);
    let changed = false;
    let cleared = false;
    if (!existing) {
      this.questions.set(question.id, newEntry(question));
      changed = true;
    } else if (!sameQuestion(existing.question, question)) {
      cleared = hasResponses(existing);
      clearResults(existing);
      existing.question = question;
      changed = true;
    }
    const entry = this.questions.get(question.id)!;
    if (this.live !== null && this.live !== question.id) {
      const previous = this.questions.get(this.live);
      if (previous && previous.status === "open") previous.status = "closed";
      changed = true;
    }
    if (entry.status !== "open" || this.live !== question.id) changed = true;
    entry.status = "open";
    this.live = question.id;
    return ok(changed, cleared, cleared);
  }

  private close(id: QuestionId): Outcome {
    const e = this.questions.get(id);
    if (!e) return fail("unknown-question", `no question '${id}'`);
    if (e.status === "closed") return ok(false);
    e.status = "closed";
    return ok(true);
  }

  private reveal(id: QuestionId, correct: number[]): Outcome {
    const e = this.questions.get(id);
    if (!e) return fail("unknown-question", `no question '${id}'`);
    if (e.question.type !== "poll") return fail("bad-message", "only polls can be revealed");
    const n = e.question.options.length;
    if (correct.some((i) => i < 0 || i >= n)) return fail("bad-message", "correct index out of range");
    const revealed = [...new Set(correct)].sort((a, b) => a - b);
    const same =
      e.status === "closed" &&
      e.revealed !== null &&
      e.revealed.length === revealed.length &&
      e.revealed.every((v, i) => v === revealed[i]);
    e.revealed = revealed;
    e.status = "closed";
    return ok(!same);
  }

  private reset(id: QuestionId | undefined): Outcome {
    if (id === undefined) {
      const changed = this.questions.size > 0 || this.live !== null;
      this.questions.clear();
      this.live = null;
      return ok(changed, changed, changed);
    }
    const e = this.questions.get(id);
    if (!e) return fail("unknown-question", `no question '${id}'`);
    const hadVotes = hasResponses(e);
    clearResults(e);
    return ok(true, hadVotes, hadVotes);
  }

  private hide(id: QuestionId, text: string, hidden: boolean): Outcome {
    const e = this.questions.get(id);
    if (!e) return fail("unknown-question", `no question '${id}'`);
    if (e.question.type !== "wordcloud") return fail("bad-message", "only word-cloud entries can be hidden");
    const n = normalizeAnswer(text, e.question.maxWords);
    if (!n) return fail("bad-message", "empty text");
    if (hidden) {
      if (e.hidden.has(n.key)) return ok(false);
      e.hidden.set(n.key, e.display.get(n.key) ?? n.text);
    } else if (!e.hidden.delete(n.key)) {
      return ok(false);
    }
    return ok(true);
  }

  /** The live, open entry `id`, or the error to send. */
  private votable(id: QuestionId): Entry | Outcome {
    const e = this.questions.get(id);
    if (!e) return fail("unknown-question", `no question '${id}'`);
    if (this.live !== id || e.status !== "open") return fail("closed", "voting is closed for this question");
    return e;
  }

  private vote(voter: string, id: QuestionId, choice: number): Outcome {
    const e = this.votable(id);
    if (!("question" in e)) return e;
    if (e.question.type !== "poll") return fail("bad-message", "not a poll");
    if (choice < 0 || choice >= e.question.options.length) return fail("bad-message", "choice out of range");
    if (e.votes.get(voter) === choice) return ok(false);
    e.votes.set(voter, choice);
    return ok(true, true);
  }

  private answer(voter: string, id: QuestionId, text: string): Outcome {
    const e = this.votable(id);
    if (!("question" in e)) return e;
    if (e.question.type !== "wordcloud") return fail("bad-message", "not a word cloud");
    const n = normalizeAnswer(text, e.question.maxWords);
    if (!n) return fail("bad-message", "empty answer");
    const mine = e.answers.get(voter) ?? [];
    if (mine.some((a) => a.key === n.key)) return ok(false);
    if (mine.length >= e.question.maxAnswers) {
      return fail("limit", `at most ${e.question.maxAnswers} answers per person`);
    }
    mine.push(n);
    e.answers.set(voter, mine);
    if (!e.display.has(n.key)) e.display.set(n.key, n.text);
    return ok(true, true);
  }

  private rate(voter: string, id: QuestionId, statement: number, choice: number): Outcome {
    const e = this.votable(id);
    if (!("question" in e)) return e;
    if (e.question.type !== "likert") return fail("bad-message", "not a rating scale");
    const q = e.question;
    if (statement < 0 || statement >= q.statements.length) return fail("bad-message", "statement out of range");
    if (choice < 0 || choice >= q.labels.length) return fail("bad-message", "choice out of range");
    const mine = e.ratings.get(voter) ?? q.statements.map(() => null);
    if (mine[statement] === choice) return ok(false);
    mine[statement] = choice;
    e.ratings.set(voter, mine);
    return ok(true, true);
  }

  private results(e: Entry, presenter: boolean): Results {
    const q = e.question;
    if (q.type === "poll") {
      const counts: number[] = q.options.map(() => 0);
      for (const choice of e.votes.values()) counts[choice] = (counts[choice] ?? 0) + 1;
      return { type: "poll", counts, voters: e.votes.size };
    }
    if (q.type === "likert") {
      const counts = q.statements.map(() => q.labels.map(() => 0));
      for (const list of e.ratings.values()) {
        list.forEach((choice, s) => {
          if (choice !== null) counts[s]![choice]!++;
        });
      }
      return { type: "likert", counts, voters: e.ratings.size };
    }
    const tally = new Map<string, number>();
    for (const list of e.answers.values()) {
      for (const a of list) tally.set(a.key, (tally.get(a.key) ?? 0) + 1);
    }
    const order = [...e.display.keys()];
    const rank = new Map(order.map((k, i) => [k, i]));
    const words: CloudWord[] = [...tally]
      .filter(([key]) => !e.hidden.has(key))
      .sort(([ka, a], [kb, b]) => b - a || (rank.get(ka) ?? 0) - (rank.get(kb) ?? 0))
      .slice(0, LIMITS.cloudWords)
      .map(([key, count]) => ({ text: e.display.get(key) ?? key, count }));
    const results: Results = { type: "wordcloud", words, voters: e.answers.size };
    if (presenter) results.hidden = [...e.hidden.values()];
    return results;
  }

  private questionState(e: Entry, presenter: boolean): QuestionState {
    return {
      question: e.question,
      status: e.status,
      results: this.results(e, presenter),
      revealed: e.revealed,
    };
  }

  /** The `deck` payload. Only the presenter variant includes hidden words. */
  deckState(presenter: boolean, audience: number): DeckState {
    const questions: Record<QuestionId, QuestionState> = {};
    for (const [id, e] of this.questions) questions[id] = this.questionState(e, presenter);
    return { session: this.session, live: this.live, questions, audience };
  }

  /**
   * The `audience` payload: only the live question. Results and the revealed
   * answer are withheld while it is open.
   */
  audienceState(): AudienceState {
    const e = this.live === null ? undefined : this.questions.get(this.live);
    if (!e) return { session: this.session, live: null };
    const open = e.status === "open";
    return {
      session: this.session,
      live: {
        question: e.question,
        status: e.status,
        results: open ? null : this.results(e, false),
        revealed: open ? null : e.revealed,
      },
    };
  }

  /** One voter's own votes and answers across the session. */
  mine(voter: string): Mine {
    const mine: Mine = { votes: {}, answers: {}, ratings: {} };
    for (const [id, e] of this.questions) {
      const vote = e.votes.get(voter);
      if (vote !== undefined) mine.votes[id] = vote;
      const answers = e.answers.get(voter);
      if (answers?.length) mine.answers[id] = answers.map((a) => a.text);
      const ratings = e.ratings.get(voter);
      if (ratings) mine.ratings[id] = [...ratings];
    }
    return mine;
  }

  /** Full state for `GET /api/s/:session/export`. */
  export(): { session: string; live: QuestionId | null; questions: Record<QuestionId, QuestionState> } {
    const { session, live, questions } = this.deckState(true, 0);
    return { session, live, questions };
  }
}

function dumpEntry(e: Entry): QuestionData {
  return {
    question: e.question,
    status: e.status,
    revealed: e.revealed,
    votes: [...e.votes],
    answers: [...e.answers],
    ratings: [...e.ratings],
    display: [...e.display],
    hidden: [...e.hidden],
  };
}

function hasResponses(e: Entry): boolean {
  return e.votes.size > 0 || e.answers.size > 0 || e.ratings.size > 0;
}

function pairs(value: unknown): Array<[unknown, unknown]> {
  if (!Array.isArray(value)) return [];
  return value.filter((p): p is [unknown, unknown] => Array.isArray(p) && p.length === 2);
}

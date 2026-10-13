import { describe, expect, test } from "bun:test";
import type { PollQuestion, WordcloudQuestion, WordcloudResults } from "../shared/protocol";
import { Room, type Outcome, type Sender } from "./room";

const presenter: Sender = { role: "deck", voter: "deck-1", presenter: true };
const viewer: Sender = { role: "deck", voter: "deck-2", presenter: false };
const phone = (voter: string): Sender => ({ role: "audience", voter, presenter: false });

const poll: PollQuestion = { type: "poll", id: "lang", prompt: "Language?", options: ["R", "Python", "Julia"] };
const cloud: WordcloudQuestion = { type: "wordcloud", id: "mood", prompt: "Mood?", maxWords: 2, maxAnswers: 2 };

function expectOk(o: Outcome) {
  if (!o.ok) throw new Error(`expected ok, got ${o.code}: ${o.message}`);
  return o;
}
function expectErr(o: Outcome, code: string) {
  expect(o.ok).toBe(false);
  if (!o.ok) expect(o.code).toBe(code as never);
}

function roomWith(...questions: Array<PollQuestion | WordcloudQuestion>) {
  const room = Room.create("s1");
  for (const question of questions) expectOk(room.apply(presenter, { t: "open", question }));
  return room;
}

const cloudResults = (room: Room, presenterView = false) =>
  room.deckState(presenterView, 0).questions.mood!.results as WordcloudResults;

describe("permissions", () => {
  test("presenter-only messages need the presenter key", () => {
    const room = Room.create("s1");
    expectErr(room.apply(viewer, { t: "open", question: poll }), "forbidden");
    expectErr(room.apply(phone("a"), { t: "open", question: poll }), "forbidden");
    expectErr(room.apply(phone("a"), { t: "reset" }), "forbidden");
  });
  test("only audience sockets vote", () => {
    const room = roomWith(poll);
    expectErr(room.apply(presenter, { t: "vote", id: "lang", choice: 0 }), "forbidden");
    expectErr(room.apply(viewer, { t: "vote", id: "lang", choice: 0 }), "forbidden");
  });
});

describe("open", () => {
  test("makes the question live and open", () => {
    const room = roomWith(poll);
    const s = room.deckState(false, 3);
    expect(s.live).toBe("lang");
    expect(s.audience).toBe(3);
    expect(s.questions.lang!.status).toBe("open");
    expect(s.questions.lang!.results).toEqual({ type: "poll", counts: [0, 0, 0], voters: 0 });
  });
  test("closes the previously live question", () => {
    const room = roomWith(poll, cloud);
    const s = room.deckState(false, 0);
    expect(s.live).toBe("mood");
    expect(s.questions.lang!.status).toBe("closed");
    expect(s.questions.mood!.status).toBe("open");
  });
  test("is idempotent and keeps votes when the definition is unchanged", () => {
    const room = roomWith(poll);
    expectOk(room.apply(phone("a"), { t: "vote", id: "lang", choice: 1 }));
    const again = expectOk(room.apply(presenter, { t: "open", question: { ...poll, options: [...poll.options] } }));
    expect(again.changed).toBe(false);
    expect(room.deckState(false, 0).questions.lang!.results).toMatchObject({ counts: [0, 1, 0] });
  });
  test("re-opening a closed question keeps votes and reopens voting", () => {
    const room = roomWith(poll);
    expectOk(room.apply(phone("a"), { t: "vote", id: "lang", choice: 1 }));
    expectOk(room.apply(presenter, { t: "close", id: "lang" }));
    const o = expectOk(room.apply(presenter, { t: "open", question: poll }));
    expect(o.changed).toBe(true);
    expect(room.deckState(false, 0).questions.lang!.status).toBe("open");
    expect(room.mine("a").votes).toEqual({ lang: 1 });
  });
  test("a changed definition clears votes, reveal and hidden words", () => {
    const room = roomWith(poll);
    expectOk(room.apply(phone("a"), { t: "vote", id: "lang", choice: 1 }));
    expectOk(room.apply(presenter, { t: "reveal", id: "lang", correct: [1] }));
    const o = expectOk(room.apply(presenter, { t: "open", question: { ...poll, prompt: "Edited?" } }));
    expect(o.allMineChanged).toBe(true);
    const q = room.deckState(false, 0).questions.lang!;
    expect(q.question.prompt).toBe("Edited?");
    expect(q.results).toMatchObject({ counts: [0, 0, 0], voters: 0 });
    expect(q.revealed).toBeNull();
    expect(q.status).toBe("open");

    const room2 = roomWith(cloud);
    expectOk(room2.apply(phone("a"), { t: "answer", id: "mood", text: "tired" }));
    expectOk(room2.apply(presenter, { t: "hide", id: "mood", text: "tired", hidden: true }));
    expectOk(room2.apply(presenter, { t: "open", question: { ...cloud, maxAnswers: 3 } }));
    expect(cloudResults(room2, true)).toEqual({ type: "wordcloud", words: [], voters: 0, hidden: [] });
  });
});

describe("close", () => {
  test("closes but keeps live, so phones see results", () => {
    const room = roomWith(poll);
    expectOk(room.apply(phone("a"), { t: "vote", id: "lang", choice: 2 }));
    expectOk(room.apply(presenter, { t: "close", id: "lang" }));
    const a = room.audienceState();
    expect(a.live?.status).toBe("closed");
    expect(a.live?.results).toEqual({ type: "poll", counts: [0, 0, 1], voters: 1 });
    expect(room.deckState(false, 0).live).toBe("lang");
  });
  test("unknown question", () => {
    expectErr(Room.create("s1").apply(presenter, { t: "close", id: "nope" }), "unknown-question");
  });
});

describe("reveal", () => {
  test("stores the correct answers and closes", () => {
    const room = roomWith(poll);
    expectOk(room.apply(presenter, { t: "reveal", id: "lang", correct: [2, 0, 2] }));
    const q = room.deckState(false, 0).questions.lang!;
    expect(q.revealed).toEqual([0, 2]);
    expect(q.status).toBe("closed");
    expect(room.audienceState().live?.revealed).toEqual([0, 2]);
  });
  test("polls only, indices in range", () => {
    const room = roomWith(poll, cloud);
    expectErr(room.apply(presenter, { t: "reveal", id: "mood", correct: [0] }), "bad-message");
    expectErr(room.apply(presenter, { t: "reveal", id: "lang", correct: [3] }), "bad-message");
    expectErr(room.apply(presenter, { t: "reveal", id: "nope", correct: [0] }), "unknown-question");
  });
});

describe("reset", () => {
  test("one question: clears results, keeps status", () => {
    const room = roomWith(poll);
    expectOk(room.apply(phone("a"), { t: "vote", id: "lang", choice: 0 }));
    const o = expectOk(room.apply(presenter, { t: "reset", id: "lang" }));
    expect(o.allMineChanged).toBe(true);
    const q = room.deckState(false, 0).questions.lang!;
    expect(q.status).toBe("open");
    expect(q.results).toMatchObject({ counts: [0, 0, 0], voters: 0 });
    expect(room.mine("a")).toEqual({ votes: {}, answers: {} });
  });
  test("whole session: drops all questions", () => {
    const room = roomWith(poll, cloud);
    expectOk(room.apply(presenter, { t: "reset" }));
    expect(room.deckState(false, 0)).toEqual({ session: "s1", live: null, questions: {}, audience: 0 });
    expect(room.audienceState()).toEqual({ session: "s1", live: null });
  });
  test("unknown question", () => {
    expectErr(Room.create("s1").apply(presenter, { t: "reset", id: "nope" }), "unknown-question");
  });
});

describe("vote", () => {
  test("last vote wins; voters counts distinct voters", () => {
    const room = roomWith(poll);
    expectOk(room.apply(phone("a"), { t: "vote", id: "lang", choice: 0 }));
    expectOk(room.apply(phone("b"), { t: "vote", id: "lang", choice: 0 }));
    const change = expectOk(room.apply(phone("a"), { t: "vote", id: "lang", choice: 1 }));
    expect(change.mineChanged).toBe(true);
    const same = expectOk(room.apply(phone("a"), { t: "vote", id: "lang", choice: 1 }));
    expect(same.changed).toBe(false);
    expect(room.deckState(false, 0).questions.lang!.results).toEqual({ type: "poll", counts: [1, 1, 0], voters: 2 });
    expect(room.mine("a")).toEqual({ votes: { lang: 1 }, answers: {} });
  });
  test("requires the live, open question and a choice in range", () => {
    const room = roomWith(poll);
    expectErr(room.apply(phone("a"), { t: "vote", id: "lang", choice: 3 }), "bad-message");
    expectErr(room.apply(phone("a"), { t: "vote", id: "lang", choice: -1 }), "bad-message");
    expectErr(room.apply(phone("a"), { t: "vote", id: "nope", choice: 0 }), "unknown-question");
    expectOk(room.apply(presenter, { t: "close", id: "lang" }));
    expectErr(room.apply(phone("a"), { t: "vote", id: "lang", choice: 0 }), "closed");
    expectOk(room.apply(presenter, { t: "open", question: cloud }));
    expectOk(room.apply(presenter, { t: "open", question: poll }));
    expectErr(room.apply(phone("a"), { t: "vote", id: "mood", choice: 0 }), "closed");
    expectErr(room.apply(phone("a"), { t: "answer", id: "lang", text: "x" }), "bad-message");
  });
});

describe("answer", () => {
  test("normalizes, dedupes per voter, counts distinct voters", () => {
    const room = roomWith(cloud);
    expectOk(room.apply(phone("a"), { t: "answer", id: "mood", text: "  Sleepy!! " }));
    expectOk(room.apply(phone("b"), { t: "answer", id: "mood", text: "sleepy" }));
    expectOk(room.apply(phone("b"), { t: "answer", id: "mood", text: "Happy days ahead" }));
    const dup = expectOk(room.apply(phone("a"), { t: "answer", id: "mood", text: "SLEEPY." }));
    expect(dup.changed).toBe(false);
    expect(dup.mineChanged).toBe(false);
    const r = cloudResults(room);
    expect(r.words).toEqual([
      { text: "Sleepy", count: 2 },
      { text: "Happy days", count: 1 },
    ]);
    expect(r.voters).toBe(2);
    expect(room.mine("b").answers).toEqual({ mood: ["sleepy", "Happy days"] });
  });
  test("maxAnswers is a limit; empty answers are rejected", () => {
    const room = roomWith(cloud);
    expectOk(room.apply(phone("a"), { t: "answer", id: "mood", text: "one" }));
    expectOk(room.apply(phone("a"), { t: "answer", id: "mood", text: "two" }));
    expectOk(room.apply(phone("a"), { t: "answer", id: "mood", text: "one" })); // duplicate still a no-op
    expectErr(room.apply(phone("a"), { t: "answer", id: "mood", text: "three" }), "limit");
    expectErr(room.apply(phone("b"), { t: "answer", id: "mood", text: " ?!… " }), "bad-message");
  });
  test("ties keep first-seen order; at most LIMITS.cloudWords words", () => {
    const room = roomWith({ ...cloud, maxAnswers: 10 });
    for (let v = 0; v < 12; v++) {
      for (let w = 0; w < 10; w++) room.apply(phone(`v${v}`), { t: "answer", id: "mood", text: `w${v * 10 + w}` });
    }
    room.apply(phone("z"), { t: "answer", id: "mood", text: "w119" });
    const r = cloudResults(room);
    expect(r.words.length).toBe(100);
    expect(r.words[0]).toEqual({ text: "w119", count: 2 });
    expect(r.words[1]).toEqual({ text: "w0", count: 1 });
  });
  test("results are withheld from phones while open", () => {
    const room = roomWith(cloud);
    expectOk(room.apply(phone("a"), { t: "answer", id: "mood", text: "x" }));
    expect(room.audienceState().live?.results).toBeNull();
    expectOk(room.apply(presenter, { t: "close", id: "mood" }));
    expect(room.audienceState().live?.results).toMatchObject({ words: [{ text: "x", count: 1 }] });
  });
});

describe("hide", () => {
  test("hides and unhides normalized entries; only the presenter sees the list", () => {
    const room = roomWith(cloud);
    expectOk(room.apply(phone("a"), { t: "answer", id: "mood", text: "Rude Word" }));
    expectOk(room.apply(phone("b"), { t: "answer", id: "mood", text: "fine" }));
    expect(expectOk(room.apply(presenter, { t: "hide", id: "mood", text: "rude word!", hidden: true })).changed).toBe(true);
    expect(cloudResults(room).words).toEqual([{ text: "fine", count: 1 }]);
    expect(cloudResults(room).hidden).toBeUndefined();
    expect(cloudResults(room, true).hidden).toEqual(["Rude Word"]);
    expect(room.export().questions.mood!.results).toMatchObject({ hidden: ["Rude Word"] });
    expect(expectOk(room.apply(presenter, { t: "hide", id: "mood", text: "Rude Word", hidden: false })).changed).toBe(true);
    expect(cloudResults(room).words.length).toBe(2);
  });
  test("word clouds only", () => {
    const room = roomWith(poll);
    expectErr(room.apply(presenter, { t: "hide", id: "lang", text: "R", hidden: true }), "bad-message");
  });
});

describe("dump / restore", () => {
  test("round-trips", () => {
    const room = roomWith(poll, cloud);
    room.apply(phone("a"), { t: "answer", id: "mood", text: "Hello" });
    room.apply(phone("b"), { t: "answer", id: "mood", text: "hello" });
    room.apply(presenter, { t: "hide", id: "mood", text: "secret", hidden: true });
    room.apply(presenter, { t: "open", question: poll });
    room.apply(phone("a"), { t: "vote", id: "lang", choice: 2 });
    room.apply(presenter, { t: "reveal", id: "lang", correct: [2] });
    const copy = Room.restore("s1", JSON.parse(JSON.stringify(room.dump())));
    expect(copy.deckState(true, 0)).toEqual(room.deckState(true, 0));
    expect(copy.audienceState()).toEqual(room.audienceState());
    expect(copy.mine("a")).toEqual(room.mine("a"));
    expect(copy.dump()).toEqual(room.dump());
  });
  test("tolerates garbage", () => {
    expect(Room.restore("s1", "nope").deckState(false, 0).questions).toEqual({});
    const r = Room.restore("s1", { live: "x", questions: [{ question: { type: "bogus" } }, null, 7] });
    expect(r.deckState(false, 0)).toEqual({ session: "s1", live: null, questions: {}, audience: 0 });
  });
});

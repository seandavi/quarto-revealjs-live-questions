import { describe, expect, test } from "bun:test";
import { LIMITS } from "../shared/protocol";
import { parseMessage, validateQuestion } from "./validate";

const parse = (v: unknown) => parseMessage(typeof v === "string" ? v : JSON.stringify(v));
const okMsg = (v: unknown) => {
  const p = parse(v);
  if (!p.ok) throw new Error(p.message);
  return p.msg;
};
const rejects = (v: unknown) => expect(parse(v).ok).toBe(false);

describe("parseMessage", () => {
  test("rejects non-JSON, non-objects and unknown types", () => {
    rejects("{nope");
    rejects("[]");
    rejects("42");
    rejects({ t: "explode" });
  });
  test("hello", () => {
    expect(okMsg({ t: "hello", v: 1, role: "audience", voter: "abc-123" })).toEqual({
      t: "hello",
      v: 1,
      role: "audience",
      voter: "abc-123",
    });
    expect(okMsg({ t: "hello", v: 99, role: "deck", voter: "d", key: "k", extra: 1 })).toEqual({
      t: "hello",
      v: 99,
      role: "deck",
      voter: "d",
      key: "k",
    });
    rejects({ t: "hello", v: "1", role: "audience", voter: "a" });
    rejects({ t: "hello", v: 1, role: "admin", voter: "a" });
    rejects({ t: "hello", v: 1, role: "audience", voter: "" });
    rejects({ t: "hello", v: 1, role: "audience", voter: "has space" });
    rejects({ t: "hello", v: 1, role: "audience", voter: "x".repeat(65) });
    rejects({ t: "hello", v: 1, role: "deck", voter: "a", key: 5 });
  });
  test("vote and answer", () => {
    expect(okMsg({ t: "vote", id: "q1", choice: 2 })).toEqual({ t: "vote", id: "q1", choice: 2 });
    rejects({ t: "vote", id: "q1", choice: 1.5 });
    rejects({ t: "vote", id: "q1", choice: "1" });
    rejects({ t: "vote", id: "-bad", choice: 1 });
    expect(okMsg({ t: "answer", id: "q1", text: "hi" })).toEqual({ t: "answer", id: "q1", text: "hi" });
    rejects({ t: "answer", id: "q1", text: "x".repeat(LIMITS.answerInputChars + 1) });
    rejects({ t: "answer", id: "q1" });
  });
  test("presenter messages", () => {
    expect(okMsg({ t: "close", id: "q1" })).toEqual({ t: "close", id: "q1" });
    expect(okMsg({ t: "reveal", id: "q1", correct: [0, 2] })).toEqual({ t: "reveal", id: "q1", correct: [0, 2] });
    rejects({ t: "reveal", id: "q1", correct: [-1] });
    rejects({ t: "reveal", id: "q1", correct: "0" });
    expect(okMsg({ t: "reset" })).toEqual({ t: "reset" });
    expect(okMsg({ t: "reset", id: "q1" })).toEqual({ t: "reset", id: "q1" });
    rejects({ t: "reset", id: "" });
    expect(okMsg({ t: "hide", id: "q1", text: "w", hidden: true })).toEqual({ t: "hide", id: "q1", text: "w", hidden: true });
    rejects({ t: "hide", id: "q1", text: "w", hidden: "yes" });
    expect(okMsg({ t: "ping" })).toEqual({ t: "ping" });
  });
  test("open strips unknown fields such as correct answers", () => {
    const msg = okMsg({
      t: "open",
      question: { type: "poll", id: "q1", prompt: "P", options: ["a", "b"], correct: [1], results: "live" },
    });
    expect(msg).toEqual({ t: "open", question: { type: "poll", id: "q1", prompt: "P", options: ["a", "b"] } });
  });
});

describe("validateQuestion", () => {
  const poll = { type: "poll", id: "q1", prompt: "P", options: ["a", "b"] };
  const cloud = { type: "wordcloud", id: "w1", prompt: "P", maxWords: 2, maxAnswers: 3 };
  test("accepts valid questions", () => {
    expect(validateQuestion(poll)).toEqual(poll as never);
    expect(validateQuestion(cloud)).toEqual(cloud as never);
    expect(validateQuestion({ type: "wordcloud", id: "w1", prompt: "" })).toEqual({
      type: "wordcloud",
      id: "w1",
      prompt: "",
      maxWords: 3,
      maxAnswers: 3,
    });
  });
  test("enforces LIMITS", () => {
    const bad = (q: object) => expect(typeof validateQuestion(q)).toBe("string");
    bad({ ...poll, id: "has space" });
    bad({ ...poll, id: "x".repeat(65) });
    bad({ ...poll, prompt: "x".repeat(LIMITS.promptChars + 1) });
    bad({ ...poll, options: [] });
    bad({ ...poll, options: Array.from({ length: LIMITS.pollOptions + 1 }, (_, i) => `o${i}`) });
    bad({ ...poll, options: ["x".repeat(LIMITS.optionChars + 1)] });
    bad({ ...poll, options: [1, 2] });
    bad({ ...cloud, maxWords: 0 });
    bad({ ...cloud, maxWords: LIMITS.maxWordsCeiling + 1 });
    bad({ ...cloud, maxAnswers: 2.5 });
    bad({ ...poll, type: "quiz" });
  });
});

import { describe, expect, test } from "bun:test";
import { normalizeAnswer } from "../shared/normalize";

const text = (raw: string, maxWords = 3) => normalizeAnswer(raw, maxWords)?.text ?? null;

describe("normalizeAnswer", () => {
  test("collapses whitespace and trims", () => {
    expect(text("  big \t  data\n ")).toBe("big data");
    expect(text("a\nb")).toBe("a b");
  });
  test("applies NFKC and removes control and zero-width characters", () => {
    expect(text("ｆｕｌｌ")).toBe("full");
    expect(text("ze​ro\u0007")).toBe("zero");
    expect(text("ﬁne")).toBe("fine");
  });
  test("strips edge punctuation and quotes but keeps symbols", () => {
    expect(text("Hello, world!!")).toBe("Hello, world");
    expect(text('"quoted"')).toBe("quoted");
    expect(text("“curly” ‘quotes’")).toBe("curly” ‘quotes");
    expect(text("(R)")).toBe("R");
    expect(text("[{x}]…")).toBe("x");
    expect(text("C++")).toBe("C++");
    expect(text("C#")).toBe("C#");
    expect(text("#rstats")).toBe("#rstats");
  });
  test("keeps the first maxWords words, then strips again", () => {
    expect(text("one two three four", 3)).toBe("one two three");
    expect(text("hello, world", 1)).toBe("hello");
    expect(text("a b c d e f g h i j k l", 10)).toBe("a b c d e f g h i j");
  });
  test("cuts to LIMITS.answerChars characters", () => {
    expect(text("x".repeat(60))).toBe("x".repeat(40));
    expect(Array.from(text("😀".repeat(50))!).length).toBe(40);
    expect(text(`${"y".repeat(39)} z`)).toBe("y".repeat(39));
  });
  test("returns null when nothing is left", () => {
    expect(normalizeAnswer("", 3)).toBeNull();
    expect(normalizeAnswer("  ?!... ", 3)).toBeNull();
    expect(normalizeAnswer("\u0000\u0001", 3)).toBeNull();
  });
  test("key is the lowercased display text", () => {
    expect(normalizeAnswer("  Big DATA ", 3)).toEqual({ text: "Big DATA", key: "big data" });
  });
});

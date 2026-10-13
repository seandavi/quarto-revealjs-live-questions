import { describe, expect, test } from "bun:test";
import { rawParam } from "./presenter-key";

describe("rawParam", () => {
  test("keeps + in keys instead of turning it into a space", () => {
    expect(rawParam("?presenter=ab+cd/ef==", "presenter")).toBe("ab+cd/ef==");
  });
  test("decodes percent-escapes", () => {
    expect(rawParam("?x=1&presenter=a%2Bb%20c", "presenter")).toBe("a+b c");
  });
  test("empty and bare parameters read as empty", () => {
    expect(rawParam("?presenter=", "presenter")).toBe("");
    expect(rawParam("?presenter", "presenter")).toBe("");
  });
  test("malformed escapes are returned undecoded", () => {
    expect(rawParam("?presenter=a%zz", "presenter")).toBe("a%zz");
  });
});

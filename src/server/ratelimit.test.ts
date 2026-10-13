import { describe, expect, test } from "bun:test";
import { AUDIENCE_LIMIT, TokenBucket } from "./ratelimit";

describe("TokenBucket", () => {
  test("allows a burst of 20, then refills 5 per second", () => {
    const b = new TokenBucket(AUDIENCE_LIMIT, 0);
    for (let i = 0; i < 20; i++) expect(b.take(0)).toBe(true);
    expect(b.take(0)).toBe(false);
    expect(b.take(199)).toBe(false); // 0.995 tokens
    expect(b.take(200)).toBe(true); // 1 token after 200 ms
    expect(b.take(200)).toBe(false);
    for (let i = 0; i < 5; i++) expect(b.take(1200)).toBe(true);
    expect(b.take(1200)).toBe(false);
  });
  test("never exceeds the burst after idling", () => {
    const b = new TokenBucket(AUDIENCE_LIMIT, 0);
    let n = 0;
    while (b.take(3_600_000)) n++;
    expect(n).toBe(20);
  });
  test("ignores clocks that go backwards", () => {
    const b = new TokenBucket({ burst: 1, refillPerSecond: 1 }, 1000);
    expect(b.take(1000)).toBe(true);
    expect(b.take(0)).toBe(false);
    expect(b.take(1999)).toBe(false);
    expect(b.take(2000)).toBe(true);
  });
});

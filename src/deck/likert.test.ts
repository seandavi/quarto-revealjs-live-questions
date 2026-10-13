import { describe, expect, test } from "bun:test";
import { diverging, extent, summary, tones } from "./likert";

describe("tones", () => {
  test("odd scales have a neutral middle; steps grow toward the ends", () => {
    expect(tones(5)).toEqual([
      { side: "neg", step: 4 },
      { side: "neg", step: 2 },
      { side: "mid", step: 0 },
      { side: "pos", step: 2 },
      { side: "pos", step: 4 },
    ]);
    expect(tones(7).map((t) => `${t.side}${t.step}`)).toEqual(["neg5", "neg3", "neg1", "mid0", "pos1", "pos3", "pos5"]);
  });
  test("even scales have none", () => {
    expect(tones(2)).toEqual([{ side: "neg", step: 3 }, { side: "pos", step: 3 }]);
    expect(tones(4).map((t) => t.side)).toEqual(["neg", "neg", "pos", "pos"]);
    expect(tones(11).filter((t) => t.side === "mid").length).toBe(1);
  });
});

describe("diverging", () => {
  test("splits the neutral share half each side of the center", () => {
    const d = diverging([1, 1, 2, 4, 2]); // 10 responses
    expect(d.total).toBe(10);
    expect(d.neg).toBeCloseTo(0.2);
    expect(d.pos).toBeCloseTo(0.6);
    expect(d.start[0]).toBeCloseTo(-0.3); // disagree 0.2 + half of neutral 0.2
    expect(d.start[2]).toBeCloseTo(-0.1);
    expect(d.start[3]).toBeCloseTo(0.1);
    expect(d.width).toEqual([0.1, 0.1, 0.2, 0.4, 0.2]);
  });
  test("even scales split at the boundary; no responses is all zero", () => {
    const d = diverging([1, 3, 0, 0]);
    expect(d.start[0]).toBeCloseTo(-1);
    expect(d.start[2]).toBeCloseTo(0);
    expect(diverging([0, 0, 0])).toEqual({ start: [0, 0, 0], width: [0, 0, 0], neg: 0, pos: 0, total: 0 });
  });
});

describe("extent", () => {
  test("widest reach per side, rounded up to 10%, at least 20%", () => {
    expect(extent([diverging([1, 1, 2, 4, 2]), diverging([0, 0, 0, 1, 9])])).toEqual({ left: 0.3, right: 1 });
    expect(extent([diverging([0, 0, 0])])).toEqual({ left: 0.2, right: 0.2 });
  });
});

describe("summary", () => {
  test("mean and median of a numeric scale", () => {
    expect(summary([0, 1, 0, 3], [1, 2, 3, 4])).toEqual({ mean: 3.5, median: 4, total: 4 });
    expect(summary([2, 0, 2], [0, 1, 2])?.median).toBe(1); // mean of the two middle responses
    expect(summary([1, 1, 1], [0, 1, 2])?.median).toBe(1);
    expect(summary([0, 0], [0, 1])).toBeNull();
  });
});

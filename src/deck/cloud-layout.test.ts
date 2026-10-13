import { describe, expect, test } from "bun:test";
import { layoutCloud, newMemory, type CloudInput, type LayoutOptions, type Placed } from "./cloud-layout";

const opts: LayoutOptions = {
  width: 700,
  height: 450,
  minFont: 22,
  maxFont: 90,
  gap: 4,
  measure: (text, size) => ({ w: text.length * size * 0.55, h: size * 1.1 }),
};

const words = (counts: Record<string, number>): CloudInput[] =>
  Object.entries(counts)
    .map(([text, count]) => ({ key: text.toLowerCase(), text, count }))
    .sort((a, b) => b.count - a.count);

function assertValid(placed: Placed[]) {
  for (const p of placed) {
    expect(Math.abs(p.x) * 2 + p.w).toBeLessThanOrEqual(opts.width + 0.01);
    expect(Math.abs(p.y) * 2 + p.h).toBeLessThanOrEqual(opts.height + 0.01);
  }
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      const a = placed[i]!;
      const b = placed[j]!;
      const apart = Math.abs(a.x - b.x) * 2 >= a.w + b.w || Math.abs(a.y - b.y) * 2 >= a.h + b.h;
      expect(apart).toBe(true);
    }
  }
}

describe("layoutCloud", () => {
  const base = { inspiring: 9, fun: 7, challenging: 6, useful: 5, long: 4, clear: 2, meh: 1, wow: 1 };

  test("places every word inside the area without overlaps", () => {
    const placed = layoutCloud(words(base), newMemory(), opts);
    expect(placed).toHaveLength(Object.keys(base).length);
    assertValid(placed);
  });

  test("keeps positions when nothing changes", () => {
    const memory = newMemory();
    const first = layoutCloud(words(base), memory, opts);
    const second = layoutCloud(words(base), memory, opts);
    expect(second.map((p) => [p.key, p.x, p.y])).toEqual(first.map((p) => [p.key, p.x, p.y]));
  });

  test("keeps positions when all counts grow in proportion", () => {
    const memory = newMemory();
    const first = layoutCloud(words(base), memory, opts);
    const doubled = Object.fromEntries(Object.entries(base).map(([k, v]) => [k, v * 2]));
    const second = layoutCloud(words(doubled), memory, opts);
    const at = new Map(first.map((p) => [p.key, [p.x, p.y]]));
    for (const p of second) expect([p.x, p.y]).toEqual(at.get(p.key)!);
  });

  test("a new word does not move existing ones", () => {
    const memory = newMemory();
    const first = layoutCloud(words(base), memory, opts);
    const second = layoutCloud(words({ ...base, novel: 1 }), memory, opts);
    const at = new Map(first.map((p) => [p.key, [p.x, p.y]]));
    for (const p of second) if (at.has(p.key)) expect([p.x, p.y]).toEqual(at.get(p.key)!);
    assertValid(second);
  });

  test("drops the least frequent words when they cannot fit", () => {
    const many = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`entry-number-${i}`, 200 - i]));
    const placed = layoutCloud(words(many), newMemory(), opts);
    expect(placed.length).toBeGreaterThan(0);
    expect(placed.length).toBeLessThan(200);
    expect(placed[0]!.key).toBe("entry-number-0");
    assertValid(placed);
  });

  test("an empty list resets the memory", () => {
    const memory = newMemory();
    layoutCloud(words(base), memory, opts);
    expect(layoutCloud([], memory, opts)).toEqual([]);
    expect(memory.positions.size).toBe(0);
    expect(memory.scale).toBe(1);
  });
});

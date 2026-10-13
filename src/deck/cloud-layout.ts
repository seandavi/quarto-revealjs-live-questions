/**
 * Word cloud layout: an elliptical spiral search with remembered positions.
 *
 * Coordinates are word-box centers relative to the middle of the cloud area.
 * A word keeps its remembered position as long as it still fits there; only
 * when it grows into a neighbor (or the edge) does it search again, starting
 * from where it was. New words search outward from the center, each along a
 * spiral rotated by a hash of the word so they spread out evenly.
 *
 * This module is pure (measurement is injected) so it can be unit-tested.
 */

export interface CloudInput {
  /** Stable identity (the normalized text). */
  key: string;
  text: string;
  count: number;
}

export interface Placed extends CloudInput {
  /** Font size in px. */
  size: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LayoutOptions {
  width: number;
  height: number;
  minFont: number;
  maxFont: number;
  /** Gap kept between word boxes, in px. */
  gap: number;
  measure: (text: string, size: number) => { w: number; h: number };
}

/** What the cloud remembers between renders. */
export interface Memory {
  positions: Map<string, { x: number; y: number }>;
  /** Uniform font scale last used. It only shrinks, unless it can grow back without moving anything. */
  scale: number;
}

export function newMemory(): Memory {
  return { positions: new Map(), scale: 1 };
}

export function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Font size for a count: square-root scaling of count / maxCount between min
 * and max. Depending only on the ratio means that when every count grows in
 * proportion (the usual case as more people answer) sizes stay put.
 */
export function fontSize(count: number, maxCount: number, minFont: number, maxFont: number): number {
  const t = Math.sqrt(Math.max(0, count) / Math.max(1, maxCount));
  return minFont + (maxFont - minFont) * t;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

function overlaps(a: Box, b: Box, gap: number): boolean {
  return (
    Math.abs(a.x - b.x) * 2 < a.w + b.w + gap * 2 &&
    Math.abs(a.y - b.y) * 2 < a.h + b.h + gap * 2
  );
}

function inside(b: Box, width: number, height: number): boolean {
  return Math.abs(b.x) * 2 + b.w <= width && Math.abs(b.y) * 2 + b.h <= height;
}

function fits(b: Box, placed: Box[], o: LayoutOptions): boolean {
  if (!inside(b, o.width, o.height)) return false;
  for (const p of placed) if (overlaps(b, p, o.gap)) return false;
  return true;
}

/** Walk an elliptical spiral out from (x0, y0) and return the first free spot. */
function search(
  w: number,
  h: number,
  x0: number,
  y0: number,
  phase: number,
  placed: Box[],
  o: LayoutOptions,
): { x: number; y: number } | null {
  const aspect = o.width / o.height;
  const maxR = Math.hypot(o.width, o.height);
  const step = 0.12;
  for (let t = 0; ; t += step) {
    const r = 1.6 * t;
    if (r / Math.max(1, aspect) > maxR) return null;
    const x = x0 + r * Math.cos(t + phase) * aspect;
    const y = y0 + r * Math.sin(t + phase);
    if (fits({ x, y, w, h }, placed, o)) return { x, y };
  }
}

interface Attempt {
  placed: Placed[];
  /** Remembered words that had to move. */
  moved: number;
}

function attempt(
  words: CloudInput[],
  memory: Memory["positions"],
  scale: number,
  o: LayoutOptions,
): Attempt | null {
  const maxCount = Math.max(1, ...words.map((w) => w.count));
  const sized = words.map((w) => {
    const size = fontSize(w.count, maxCount, o.minFont, o.maxFont) * scale;
    return { ...w, size, ...o.measure(w.text, size) };
  });

  const placed: Placed[] = [];
  const pending: { word: (typeof sized)[number]; from: { x: number; y: number } | null }[] = [];

  // 1. Remembered words stay put if they still fit (biggest first).
  for (const word of sized) {
    const at = memory.get(word.key);
    if (!at) {
      pending.push({ word, from: null });
      continue;
    }
    const box = { x: at.x, y: at.y, w: word.w, h: word.h };
    if (fits(box, placed, o)) placed.push({ ...word, x: at.x, y: at.y });
    else pending.push({ word, from: at });
  }

  // 2. Displaced words search from their old spot, new words from the center.
  for (const { word, from } of pending) {
    const phase = (hash(word.key) % 628) / 100;
    const spot = search(word.w, word.h, from?.x ?? 0, from?.y ?? 0, phase, placed, o)
      ?? (from ? search(word.w, word.h, 0, 0, phase, placed, o) : null);
    if (!spot) return null;
    placed.push({ ...word, ...spot });
  }
  return { placed, moved: pending.filter((p) => p.from).length };
}

const SHRINK = 0.88;
const MIN_SCALE = 0.6;

/**
 * Place `words` (most frequent first). Shrinks every font uniformly until all
 * words fit; if even the smallest scale fails, the least frequent words are
 * dropped. Updates `memory` with the final positions and scale.
 */
export function layoutCloud(words: CloudInput[], memory: Memory, o: LayoutOptions): Placed[] {
  const accept = (r: Attempt, scale: number) => {
    memory.scale = scale;
    const keep = new Set(r.placed.map((p) => p.key));
    for (const key of memory.positions.keys()) if (!keep.has(key)) memory.positions.delete(key);
    for (const p of r.placed) memory.positions.set(p.key, { x: p.x, y: p.y });
    return r.placed;
  };

  if (words.length === 0) {
    memory.positions.clear();
    memory.scale = 1;
    return [];
  }

  // Grow back a step if that moves nothing (e.g. after the leader pulled ahead).
  const up = Math.min(1, memory.scale / SHRINK);
  if (up > memory.scale) {
    const r = attempt(words, memory.positions, up, o);
    if (r && r.moved === 0) return accept(r, up);
  }

  let list = words;
  while (list.length > 0) {
    for (let scale = memory.scale; scale >= MIN_SCALE; scale *= SHRINK) {
      const r = attempt(list, memory.positions, scale, o);
      if (r) return accept(r, scale);
    }
    list = list.slice(0, Math.floor(list.length * 0.8));
  }
  return [];
}

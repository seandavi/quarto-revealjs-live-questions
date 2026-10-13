/** Presenter-key checks shared by the WebSocket hub and the HTTP routes. */

const encoder = new TextEncoder();

/**
 * Constant-time string comparison (time depends only on the length of the
 * expected value). Returns false when `expected` is unset or empty, so a
 * server without PRESENTER_KEY has no presenter at all.
 */
export function keyMatches(given: string | undefined | null, expected: string | undefined): boolean {
  if (!expected || typeof given !== "string") return false;
  const a = encoder.encode(given);
  const b = encoder.encode(expected);
  let diff = a.length ^ b.length;
  for (let i = 0; i < b.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

/** Check an `Authorization: Bearer <key>` header. */
export function bearerMatches(header: string | undefined | null, expected: string | undefined): boolean {
  const m = /^Bearer\s+(.+)$/i.exec(header ?? "");
  return keyMatches(m?.[1]?.trim(), expected);
}

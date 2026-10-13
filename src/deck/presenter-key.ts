/**
 * The presenter key: taken from `?presenter=<key>` once, kept in localStorage
 * per server origin, and removed from the address bar. `?presenter=` (empty)
 * forgets it.
 */

const storageKey = (server: string) => {
  let origin = server;
  try {
    origin = new URL(server).origin;
  } catch {
    // keep the raw value
  }
  return `lp:key:${origin}`;
};

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Consume `?presenter=` from the URL. The parameter is always stripped from
 * the address bar; it is only stored when `store` is true (not embedded).
 */
export function takeKeyFromUrl(server: string | undefined, store: boolean): void {
  const url = new URL(window.location.href);
  if (!url.searchParams.has("presenter")) return;
  const value = rawParam(url.search, "presenter");
  url.searchParams.delete("presenter");
  window.history.replaceState(window.history.state, "", url.toString());
  if (!server || !store) return;
  const s = storage();
  if (!s) return;
  try {
    if (value === "") s.removeItem(storageKey(server));
    else s.setItem(storageKey(server), value);
  } catch {
    // storage full or blocked: the key is lost on reload, nothing else to do
  }
}

/**
 * A query parameter's value with percent-escapes decoded but `+` kept as is.
 * URLSearchParams follows form encoding and turns `+` into a space, which
 * silently breaks keys from generators that use base64.
 */
export function rawParam(search: string, name: string): string {
  for (const part of search.replace(/^\?/, "").split("&")) {
    const eq = part.indexOf("=");
    const key = eq < 0 ? part : part.slice(0, eq);
    if (key !== name) continue;
    const value = eq < 0 ? "" : part.slice(eq + 1);
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return "";
}

export function storedKey(server: string): string | null {
  try {
    return storage()?.getItem(storageKey(server)) ?? null;
  } catch {
    return null;
  }
}

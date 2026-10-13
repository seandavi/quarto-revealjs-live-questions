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
  const value = url.searchParams.get("presenter") ?? "";
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

export function storedKey(server: string): string | null {
  try {
    return storage()?.getItem(storageKey(server)) ?? null;
  } catch {
    return null;
  }
}

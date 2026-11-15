import { useState } from "react";

// localStorage, which can be missing, blocked or full: on this PC only. What it could not keep
// lasts until UnknownAlt closes, and is read first: storage that still reads but no longer writes holds
// an older value.
const unsaved = new Map<string, string | null>();

/** Compatibility lookup only: older builds used this namespace for local view preferences. */
const legacyKey = (key: string) => key.startsWith("UnknownAlt.") ? `roalt.${key.slice("UnknownAlt.".length)}` : null;

/** The text stored under `key`; null when there is none. */
export function readStored(key: string): string | null {
  if (unsaved.has(key)) return unsaved.get(key) ?? null;
  try {
    const current = localStorage.getItem(key);
    if (current !== null) return current;
    const oldKey = legacyKey(key);
    const legacy = oldKey === null ? null : localStorage.getItem(oldKey);
    if (oldKey !== null && legacy !== null) {
      // Keep the old copy if storage is blocked/full; migration must never lose a preference.
      try {
        localStorage.setItem(key, legacy);
        localStorage.removeItem(oldKey);
      } catch { /* Reading the old value still works for this session. */ }
    }
    return legacy;
  } catch {
    return null;
  }
}

/** Stores `text` under `key`; null removes it. */
export function writeStored(key: string, text: string | null) {
  try {
    if (text === null) localStorage.removeItem(key);
    else localStorage.setItem(key, text);
    const oldKey = legacyKey(key);
    if (oldKey !== null) localStorage.removeItem(oldKey);
    unsaved.delete(key);
  } catch {
    unsaved.set(key, text);
  }
}

/** Stored JSON, parsed; null when there is none or it doesn't parse. */
export function json(text: string | null): unknown {
  try {
    return JSON.parse(text ?? "null");
  } catch {
    return null;
  }
}

/** State kept under `key`. Each key keeps its own format on disk: `parse` reads it (null: nothing
 * stored), `text` writes it. */
export function useStored<T>(key: string, parse: (text: string | null) => T, text: (v: T) => string): [T, (v: T) => void] {
  const [value, setValue] = useState(() => parse(readStored(key)));
  return [value, (next) => {
    setValue(next);
    writeStored(key, text(next));
  }];
}

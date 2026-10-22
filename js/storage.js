// localStorage wrapper that never throws (private mode, quota, disabled storage).

const PREFIX = 'holdem.v1.';

export function load(key, fallback = null) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (raw == null) return clone(fallback);
    const value = JSON.parse(raw);
    if (fallback && typeof fallback === 'object' && !Array.isArray(fallback)) return { ...clone(fallback), ...value };
    return value;
  } catch {
    return clone(fallback);
  }
}

export function save(key, value) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // Storage unavailable: the game still works, it just won't remember.
  }
}

export function remove(key) {
  try {
    localStorage.removeItem(PREFIX + key);
  } catch {
    // ignore
  }
}

function clone(v) {
  return v == null ? v : JSON.parse(JSON.stringify(v));
}

/**
 * SMALL JSON FILES READ ON HOT PATHS, cached briefly.
 *
 * /config (every app launch) read data/apk/latest.json and
 * /quote-cards/today read the day's day.json with readFileSync on every
 * request — a blocking syscall each time, the top file-system cost in the
 * 2026-11-20 CPU profile. The TEXT is kept for `ttlMs` and parsed per call,
 * so callers still get their own object to mutate. Writers in this process
 * call invalidate(); writers in another process (the `docker compose exec
 * … publish()` path) are seen within ttlMs.
 */
const fs = require("fs");

const cache = new Map(); // file -> { at, text|null }
const MAX = 256;

function readJson(file, fallback = null, ttlMs = 5000) {
  const now = Date.now();
  let e = cache.get(file);
  if (!e || now - e.at > ttlMs) {
    let text = null;
    try { text = fs.readFileSync(file, "utf8"); } catch (_) {}
    if (cache.size >= MAX && !cache.has(file)) cache.delete(cache.keys().next().value);
    e = { at: now, text };
    cache.set(file, e);
  }
  if (e.text === null) return fallback;
  try { return JSON.parse(e.text); } catch (_) { return fallback; }
}

function invalidate(file) {
  if (file === undefined) cache.clear(); else cache.delete(file);
}

module.exports = { readJson, invalidate };

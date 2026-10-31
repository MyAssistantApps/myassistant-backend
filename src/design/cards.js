/**
 * CUSTOM CARDS, FILLED IN (2026-10-31). A card the Design agent built
 * says WHAT to show ("my reminders today", "the weather"); this fills it
 * with the person's own data by running the matching READ-ONLY tool — the
 * same one the assistant would use — so a card can never act, only show.
 * Results are cached per person for five minutes.
 */
const registry = require("../tools/registry");

// source -> the read tool and its arguments
const SOURCE_TOOL = {
  reminders: ["list_reminders", { day: "today" }],
  calendar: ["list_calendar_events", {}],
  shopping: ["shopping_list_show", {}],
  habits: ["momentum_status", {}],
  weather: ["get_weather", {}],
  news: ["get_news", {}],
  brief: ["daily_brief", {}],
};
const CACHE_MS = 5 * 60_000;
const TIMEOUT_MS = 6000;
const cache = new Map(); // `${uid}:${source}` -> { at, lines }

const short = (s) => String(s || "").replace(/\s+/g, " ").trim().slice(0, 120);

/** A tool's answer as short lines, whatever shape it came in. */
function linesOf(res) {
  if (!res || res.ok === false) return [];
  if (typeof res.result === "string") {
    return res.result.split(/\n+|(?<=\.)\s+(?=[A-Z])/).map(short).filter(Boolean);
  }
  for (const v of Object.values(res)) {
    if (Array.isArray(v) && v.length) {
      return v.map((x) => short(typeof x === "string" ? x
        : x && (x.title || x.text || x.name || x.summary || x.headline || x.label || ""))).filter(Boolean);
    }
  }
  if (typeof res.summary === "string") return [short(res.summary)];
  return [];
}

async function linesFor(uid, source, tzOffsetMin) {
  const key = `${uid}:${source}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.lines;
  const [tool, args] = SOURCE_TOOL[source] || [];
  if (!tool || !registry.get(tool) || !registry.isParallelSafe(tool) && tool !== "daily_brief") return [];
  let lines = [];
  try {
    const res = await Promise.race([
      registry.execute(tool, args, {
        source: "design-card", userId: uid, tzOffsetMin, background: true,
        userText: `Home card: ${source}`, intent: `Home card: ${source}`,
      }),
      new Promise((_, no) => setTimeout(() => no(new Error("timeout")), TIMEOUT_MS)),
    ]);
    lines = linesOf(res);
  } catch (_) {
    lines = [];
  }
  cache.set(key, { at: Date.now(), lines });
  return lines;
}

/** [cards] with each list/stat block's `items` filled in. */
async function fill(uid, cards, { tzOffsetMin = 330 } = {}) {
  return Promise.all((cards || []).map(async (c) => ({
    ...c,
    blocks: await Promise.all(c.blocks.map(async (b) => {
      if (b.type !== "list" && b.type !== "stat") return b;
      const lines = await linesFor(uid, b.source, tzOffsetMin);
      return b.type === "stat"
        ? { ...b, value: lines[0] || "—" }
        : { ...b, items: lines.slice(0, b.limit) };
    })),
  })));
}

function forget(uid) {
  for (const k of cache.keys()) if (k.startsWith(`${uid}:`)) cache.delete(k);
}

module.exports = { fill, linesOf, forget, SOURCE_TOOL };

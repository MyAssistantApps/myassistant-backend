/**
 * TODAY'S HOROSCOPE FOR ALL TWELVE SIGNS (2026-11-24) — the carousel on
 * the app's Jyotish card: each sign's reading for the day, a lucky colour
 * and a lucky number.
 *
 * Written once a day for everyone by the model and kept in the database
 * (jyotish_daily, no user data). THE DAY TURNS AT 4 AM INDIA TIME: before
 * 4 AM the app still gets yesterday's set, and the new set is written as
 * soon as 4 AM passes — by the background job (every 10 minutes, one
 * replica, infra/leader.js) or, if no one has made it yet, by the first
 * request. Should the model fail, a plain reading is composed from a seed
 * so the carousel is never empty; the job tries the model again later.
 *
 *   GET /jyotish/today → { day: "2026-11-24", signs: [{ id, name, symbol, dates,
 *                          reading, colour, colourHex, number }] }
 */
const { run, query } = require("../db");

const SIGNS = [
  ["aries", "Aries", "♈", "21 Mar – 19 Apr"],
  ["taurus", "Taurus", "♉", "20 Apr – 20 May"],
  ["gemini", "Gemini", "♊", "21 May – 20 Jun"],
  ["cancer", "Cancer", "♋", "21 Jun – 22 Jul"],
  ["leo", "Leo", "♌", "23 Jul – 22 Aug"],
  ["virgo", "Virgo", "♍", "23 Aug – 22 Sep"],
  ["libra", "Libra", "♎", "23 Sep – 22 Oct"],
  ["scorpio", "Scorpio", "♏", "23 Oct – 21 Nov"],
  ["sagittarius", "Sagittarius", "♐", "22 Nov – 21 Dec"],
  ["capricorn", "Capricorn", "♑", "22 Dec – 19 Jan"],
  ["aquarius", "Aquarius", "♒", "20 Jan – 18 Feb"],
  ["pisces", "Pisces", "♓", "19 Feb – 20 Mar"],
].map(([id, name, symbol, dates]) => ({ id, name, symbol, dates }));

/** The colours a reading may name, with the dot the app draws. */
const COLOURS = {
  "Royal Blue": "#4169E1", "Sky Blue": "#87CEEB", "Navy Blue": "#1F3A93", "Turquoise": "#30D5C8",
  "Emerald Green": "#2ECC71", "Olive Green": "#808000", "Mint Green": "#98FF98", "Lemon Yellow": "#FFF44F",
  "Golden Yellow": "#FFC000", "Saffron": "#F4C430", "Orange": "#FF8C00", "Coral": "#FF7F50",
  "Red": "#E53935", "Maroon": "#800000", "Pink": "#FF69B4", "Rose": "#FF007F",
  "Lavender": "#B57EDC", "Purple": "#8E44AD", "Violet": "#8F00FF", "White": "#F5F5F5",
  "Silver": "#C0C0C0", "Cream": "#FFFDD0", "Brown": "#8B5A2B", "Grey": "#9E9E9E",
};
const COLOUR_NAMES = Object.keys(COLOURS);

const IST_MS = 330 * 60_000;
const TURN_HOUR = 4;

/** The horoscope day (YYYY-MM-DD) at `now`: India's date, turning at 4 AM. */
function horoscopeDay(now = Date.now()) {
  return new Date(now + IST_MS - TURN_HOUR * 3_600_000).toISOString().slice(0, 10);
}

let migrated = null;
function migrate() {
  if (!migrated) {
    migrated = run(`
      CREATE TABLE IF NOT EXISTS jyotish_daily (
        day         TEXT    NOT NULL,
        sign        TEXT    NOT NULL,
        reading     TEXT    NOT NULL,
        colour      TEXT    NOT NULL,
        colour_hex  TEXT    NOT NULL,
        number      INTEGER NOT NULL,
        source      TEXT    NOT NULL DEFAULT 'model',
        created_at  BIGINT  NOT NULL,
        PRIMARY KEY (day, sign)
      );
    `).catch((e) => {
      migrated = null;
      throw e;
    });
  }
  return migrated;
}

/** A small deterministic random from a string (the fallback's seed). */
function seeded(str) {
  let h = 2166136261;
  for (const c of String(str)) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 3266489909) >>> 0;
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

const FALLBACK_LINES = [
  "Your influence is strong today. Lead the discussion and set the agenda.",
  "A calm, steady pace serves you best. Finish what you started before taking on more.",
  "An honest conversation clears the air. Say what you mean, kindly.",
  "Good news may come through a friend. Stay open to an unexpected invitation.",
  "Focus on your health and routine today; small habits bring big rewards.",
  "Money matters look brighter. Review your plans before you commit.",
  "Creativity flows easily. Make time for something you enjoy.",
  "Patience pays off today. Let others come to you rather than pushing.",
  "A fresh start is possible. Clear out what no longer serves you.",
  "Family and home bring comfort. Spend time with the people who matter.",
  "Your hard work is noticed. Share your ideas with confidence.",
  "Trust your instincts in a tricky choice; your intuition is sharp today.",
];

/** The plain reading for every sign on `day` (same day, same set). */
function fallbackSet(day) {
  return SIGNS.map((s) => {
    const r = seeded(`${day}:${s.id}`);
    const colour = COLOUR_NAMES[Math.floor(r() * COLOUR_NAMES.length)];
    return {
      sign: s.id,
      reading: FALLBACK_LINES[Math.floor(r() * FALLBACK_LINES.length)],
      colour, colourHex: COLOURS[colour], number: 1 + Math.floor(r() * 9), source: "fallback",
    };
  });
}

/**
 * The model's answer → one clean entry per sign, or null when any sign is
 * missing or unusable (the whole set is then written by the fallback).
 */
function parseSet(text, day) {
  let data;
  try {
    const m = /\{[\s\S]*\}/.exec(String(text || ""));
    data = m ? JSON.parse(m[0]) : null;
  } catch (_) {
    return null;
  }
  const list = Array.isArray(data?.signs) ? data.signs : [];
  const backup = fallbackSet(day);
  const out = [];
  for (const [i, s] of SIGNS.entries()) {
    const e = list.find((x) => String(x?.sign || "").trim().toLowerCase() === s.id);
    const reading = String(e?.reading || "").replace(/\s+/g, " ").trim().slice(0, 240);
    if (!e || reading.length < 12) return null;
    const colourName = COLOUR_NAMES.find((c) => c.toLowerCase() === String(e.colour || "").trim().toLowerCase());
    const n = Math.round(Number(e.number));
    out.push({
      sign: s.id,
      reading,
      colour: colourName || backup[i].colour,
      colourHex: COLOURS[colourName || backup[i].colour],
      number: n >= 1 && n <= 99 ? n : backup[i].number,
      source: "model",
    });
  }
  return out;
}

function prompt(day) {
  return `Write today's horoscope (${day}) for each of the twelve zodiac signs, for readers in India.
For each sign: "reading" — one or two short, warm, specific sentences of practical guidance for the day (at most 25 words, no emojis, no fear or medical/financial promises); "colour" — the lucky colour, exactly one of: ${COLOUR_NAMES.join(", ")}; "number" — the lucky number, 1 to 9.
Make each sign's reading different from the others. Answer with ONLY this JSON:
{"signs": [{"sign": "aries", "reading": "", "colour": "", "number": 1}, … all twelve: ${SIGNS.map((s) => s.id).join(", ")}]}`;
}

async function writeSet(day, set) {
  const now = Date.now();
  for (const e of set) {
    await run(
      `INSERT INTO jyotish_daily (day, sign, reading, colour, colour_hex, number, source, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (day, sign) DO UPDATE SET reading=EXCLUDED.reading, colour=EXCLUDED.colour,
         colour_hex=EXCLUDED.colour_hex, number=EXCLUDED.number, source=EXCLUDED.source, created_at=EXCLUDED.created_at`,
      [day, e.sign, e.reading, e.colour, e.colourHex, e.number, e.source, now],
    );
  }
}

async function readSet(day) {
  await migrate();
  return query(`SELECT * FROM jyotish_daily WHERE day=$1`, [day]);
}

const running = new Map(); // day → promise, so twelve taps make one set

/**
 * Makes `day`'s set if it is missing — or only the fallback, when `retry`
 * is set (the background job asks the model again). `ask` is the model
 * call, replaced in tests.
 */
function ensureDay(day, { retry = false, ask } = {}) {
  if (running.has(day)) return running.get(day);
  const p = (async () => {
    const rows = await readSet(day);
    const complete = rows.length === SIGNS.length;
    if (complete && !(retry && rows.some((r) => r.source === "fallback"))) return rows;
    let set = null;
    try {
      const call = ask || (async (text) => (await require("../services/ai/router").generateReply(
        [{ role: "user", content: text }],
        { system: "You are a kind, careful astrologer writing short daily horoscopes. Answer with JSON only.", json: true, timeoutMs: 60_000 },
      )).reply);
      set = parseSet(await call(prompt(day)), day);
      if (!set) console.warn(`jyotish daily ${day}: the model's answer was incomplete; using the plain reading`);
    } catch (e) {
      console.warn(`jyotish daily ${day}: model failed (${e.message}); using the plain reading`);
    }
    // Never replace a model-written set with the fallback.
    if (!set && complete) return rows;
    await writeSet(day, set || fallbackSet(day));
    return readSet(day);
  })().finally(() => running.delete(day));
  running.set(day, p);
  return p;
}

/** Today's twelve, in zodiac order, as the app reads them. */
async function today({ now = Date.now(), ask } = {}) {
  const day = horoscopeDay(now);
  const rows = await ensureDay(day, { ask });
  const by = new Map(rows.map((r) => [r.sign, r]));
  return {
    day,
    signs: SIGNS.map((s) => {
      const r = by.get(s.id);
      return {
        ...s,
        reading: r ? r.reading : "",
        colour: r ? r.colour : "",
        colourHex: r ? r.colour_hex : "",
        number: r ? Number(r.number) : 0,
      };
    }),
  };
}

let timer = null;
/** Every 10 minutes: the current day's set (so 4 AM brings the new one at once). */
function start() {
  if (timer || process.env.NODE_ENV === "test") return;
  const once = () => require("../infra/leader")
    .exclusive("jyotish.daily", () => ensureDay(horoscopeDay(), { retry: true }))
    .catch((e) => console.warn("jyotish daily job:", e.message));
  setTimeout(once, 30_000).unref();
  timer = setInterval(once, 10 * 60_000);
  timer.unref();
}

module.exports = { today, ensureDay, start, horoscopeDay, migrate, SIGNS, COLOURS, _test: { parseSet, fallbackSet, prompt } };

/**
 * JYOTISH AI — the two places the model is used, both through the OpenAI
 * router (src/services/ai/router.js; it retries a transient failure once
 * and moves to the fallback model when the main one is busy).
 *
 *   extract(conversation)       → birth details pulled from chat, plus a follow-up question
 *   predictionContext(…)        → the structured facts a reading may use
 *   streamPrediction(ctx, …)    → the reading, text deltas
 *   fallbackReading(ctx)        → a plain, rule-based reading when the model is down
 *
 * The model never computes astrology: every planet, house, dasha and yoga
 * it mentions comes from engine.js, handed over as data.
 */
const crypto = require("crypto");
const ai = require("../services/ai/router");
const engine = require("./engine");

let generateReply = (...a) => ai.generateReply(...a);
let generateReplyStream = (...a) => ai.generateReplyStream(...a);
/** Test seam: replace the model calls. */
function _setModel({ reply, stream } = {}) {
  generateReply = reply || ((...a) => ai.generateReply(...a));
  generateReplyStream = stream || ((...a) => ai.generateReplyStream(...a));
}

const LANGUAGES = { en: "English", hi: "Hindi (Devanagari script)", kn: "Kannada (Kannada script)" };

// ── extraction ──────────────────────────────────────────────────────────

const EXTRACT_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string", description: "The person's name, or empty" },
    date: { type: "string", description: "Birth date as YYYY-MM-DD, or empty when not given or unclear" },
    time: { type: "string", description: "Birth time as HH:MM in 24-hour clock, or empty" },
    timeStatus: { type: "string", enum: ["exact", "approximate", "unknown", "not_given"], description: "exact: a clock time; approximate: 'around 6:30' still counts as given; unknown: the person said they don't know; not_given: not mentioned yet, or only vague like 'morning'" },
    place: { type: "string", description: "Birth place as the person said it (town, district, state, country), or empty" },
    gender: { type: "string", enum: ["male", "female", "other", ""] },
    followUp: { type: "string", description: "ONE short, friendly question for the most important missing or unclear detail, in the user's language; empty when everything needed is present" },
  },
  required: ["name", "date", "time", "timeStatus", "place", "gender", "followUp"],
};

function extractSystem(today) {
  return [
    "You read a conversation in which someone gives their birth details for a Vedic horoscope, and you extract them.",
    `Today is ${today}. Resolve the date exactly; never invent one. Two-digit years: pick the one that is not in the future.`,
    "Time: '6:30 in the morning' = 06:30; '7 pm' = 19:00. Vague ('morning', 'night', 'after lunch') is NOT a time: leave it empty, timeStatus not_given, and ask for the clock time, saying they can answer 'I don't know'.",
    "If they say they don't know the time, timeStatus = unknown and do not ask again.",
    "Ask follow-ups in this order of importance: date, place, time. Name is nice to have; gender is optional and never asked for.",
    "Later messages correct earlier ones.",
    "Reply only with the JSON object.",
  ].join("\n");
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** A YYYY-MM-DD that is a real calendar date between 1800 and today, or null. */
function cleanDate(s, today = new Date()) {
  const m = DATE_RE.exec(String(s || "").trim());
  if (!m) return null;
  const [y, mo, d] = [+m[1], +m[2], +m[3]];
  const t = Date.UTC(y, mo - 1, d);
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  if (y < 1800 || t > today.getTime() + 86_400_000) return null;
  return m[0];
}
const cleanTime = (s) => {
  const v = String(s || "").trim();
  const m = /^(\d{1,2}):(\d{2})$/.exec(v);
  const padded = m ? `${m[1].padStart(2, "0")}:${m[2]}` : v;
  return TIME_RE.test(padded) ? padded : null;
};

/** conversation: [{ role:"user"|"assistant", text }]. Returns { fields, followUp, complete }. */
async function extract(conversation, { today = new Date() } = {}) {
  const messages = conversation.map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.text }));
  const { reply } = await generateReply(messages, {
    system: extractSystem(today.toISOString().slice(0, 10)),
    json: true, schema: EXTRACT_SCHEMA, temperature: 0, maxTokens: 400, timeoutMs: 20_000,
  });
  let j;
  try { j = JSON.parse(reply); } catch { j = {}; }
  const date = cleanDate(j.date, today);
  const time = cleanTime(j.time);
  let timeStatus = ["exact", "approximate", "unknown", "not_given"].includes(j.timeStatus) ? j.timeStatus : "not_given";
  if (!time && (timeStatus === "exact" || timeStatus === "approximate")) timeStatus = "not_given";
  const fields = {
    name: String(j.name || "").trim().slice(0, 80) || null,
    date,
    time: timeStatus === "unknown" ? null : time,
    timeStatus,
    place: String(j.place || "").trim().slice(0, 160) || null,
    gender: ["male", "female", "other"].includes(j.gender) ? j.gender : null,
  };
  // Complete = enough to cast a chart: a date, a place, and either a time or a clear "don't know".
  const complete = !!(fields.date && fields.place && (fields.time || timeStatus === "unknown"));
  let followUp = String(j.followUp || "").trim().slice(0, 300) || null;
  if (!complete && !followUp) {
    followUp = !fields.date ? "What is your date of birth?"
      : !fields.place ? "Which town or city were you born in?"
        : "Do you know your birth time? If not, just say \"I don't know\".";
  }
  if (complete) followUp = null;
  return { fields, followUp, complete };
}

// ── predictions ─────────────────────────────────────────────────────────

const RANGES = ["today", "week", "month", "year", "custom"];
const CATEGORIES = ["overall", "career", "love", "money", "health", "education"];

/** The period a reading covers: { start, end, key } (key = what makes two requests the same). */
function periodOf(range, now = new Date(), customDate = null) {
  const day = (d) => d.toISOString().slice(0, 10);
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (range === "today") return { start, end: start, key: day(start) };
  if (range === "week") {
    const mon = new Date(start.getTime() - ((start.getUTCDay() + 6) % 7) * 86_400_000);
    return { start: mon, end: new Date(mon.getTime() + 6 * 86_400_000), key: `w${day(mon)}` };
  }
  if (range === "month") {
    const s = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
    const e = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0));
    return { start: s, end: e, key: `m${day(s).slice(0, 7)}` };
  }
  if (range === "year") {
    const s = new Date(Date.UTC(start.getUTCFullYear(), 0, 1));
    return { start: s, end: new Date(Date.UTC(start.getUTCFullYear(), 11, 31)), key: `y${s.getUTCFullYear()}` };
  }
  const c = new Date(`${customDate}T00:00:00Z`);
  return { start: c, end: c, key: `d${customDate}` };
}

const brief = (p) => `${p.name} in ${p.signName} ${p.degree.toFixed(1)}° (${p.nakshatra} pada ${p.pada})${p.retrograde && !["Rahu", "Ketu"].includes(p.name) ? " retrograde" : ""}${p.house ? `, house ${p.house}` : ""}`;

/** Everything a reading may use, as plain lines; nothing else is given to the model. */
function predictionContext(natal, period, category) {
  const mid = new Date((period.start.getTime() + period.end.getTime()) / 2 + 12 * 3_600_000);
  const tr = engine.transits(natal, mid);
  const cur = currentDasha(natal, mid);
  const lines = [];
  lines.push(`BIRTH TIME KNOWN: ${natal.timeKnown ? "yes" : "no — do not mention the ascendant, houses from the lagna, or Raj Yoga"}`);
  lines.push(`MOON SIGN (RASHI): ${natal.rashi.signName} (${natal.rashi.signNameHi}); BIRTH NAKSHATRA: ${natal.nakshatra.name} pada ${natal.nakshatra.pada}${natal.moonUncertain ? " (uncertain without birth time)" : ""}`);
  if (natal.lagna) lines.push(`ASCENDANT (LAGNA): ${natal.lagna.signName} ${natal.lagna.degree.toFixed(1)}°`);
  lines.push("NATAL PLANETS:");
  for (const p of natal.planets) lines.push(`  ${brief(p)}`);
  if (cur) lines.push(`RUNNING DASHA during the period: ${cur.mahadasha} mahadasha (${cur.mdStart.slice(0, 10)} to ${cur.mdEnd.slice(0, 10)}), ${cur.antardasha} antardasha (${String(cur.adStart).slice(0, 10)} to ${String(cur.adEnd).slice(0, 10)})`);
  lines.push(`TRANSITS (gochar) around ${mid.toISOString().slice(0, 10)}, house counted from the natal Moon${natal.lagna ? " / from the lagna" : ""}:`);
  for (const p of tr.planets) lines.push(`  ${p.name} in ${p.signName}${p.retrograde && !["Rahu", "Ketu"].includes(p.name) ? " retrograde" : ""}: house ${p.houseFromMoon} from Moon${p.houseFromLagna ? ` / ${p.houseFromLagna} from lagna` : ""}`);
  const s = tr.saturn;
  lines.push(`SADE SATI: ${s.sadeSati.active ? `active, ${s.sadeSati.phase} phase (about ${s.sadeSati.start} to ${s.sadeSati.end})` : `not active${s.sadeSati.next ? `; next begins about ${s.sadeSati.next}` : ""}`}`);
  lines.push(`ASHTAMA SHANI (Saturn 8th from Moon): ${s.ashtamaShani.active ? `active (about ${s.ashtamaShani.start} to ${s.ashtamaShani.end})` : "not active"}`);
  const present = natal.yogas.filter((y) => y.present);
  lines.push(`YOGAS PRESENT: ${present.length ? present.map((y) => `${y.name} — ${y.reason}`).join("; ") : "none of the checked yogas"}`);
  const mg = natal.manglik;
  lines.push(`MANGLIK: ${mg.present ? "yes" : "no"}${mg.partial ? " (checked from the Moon only)" : ""}${mg.mitigated ? `, mitigated: ${mg.mitigations.join(", ")}` : ""}`);
  lines.push(`PERIOD: ${period.start.toISOString().slice(0, 10)} to ${period.end.toISOString().slice(0, 10)}; FOCUS: ${category}`);
  return lines.join("\n");
}

function currentDasha(natal, at) {
  const t = at.getTime();
  const md = natal.dasha.mahadashas.find((m) => Date.parse(m.start) <= t && t < Date.parse(m.end));
  if (!md) return null;
  const ad = md.antardashas.find((a) => Date.parse(a.start) <= t && t < Date.parse(a.end));
  return { mahadasha: md.lord, antardasha: ad?.lord || null, mdStart: md.start, mdEnd: md.end, adStart: ad?.start || null, adEnd: ad?.end || null };
}

function predictSystem(language, name) {
  return [
    "You are a thoughtful Vedic astrologer writing a short personal reading.",
    "Use ONLY the astrological data given by the user message. Never add planets, positions, houses, yogas or dates that are not in it, and never compute your own.",
    "Name the specific planetary reasons for each point (e.g. 'with Jupiter transiting your 5th from the Moon…', 'in your Saturn–Mercury period…').",
    "Give practical, kind, specific advice. Be balanced and hopeful; never frighten. Present challenges as things to handle, with a remedy-like habit or attitude.",
    "Never give medical, legal or financial guarantees or instructions; for health, money or legal matters suggest consulting a qualified professional. No gemstone sales, no fixed outcomes, no dates of death or illness.",
    "Shape: a one-line headline, then 3–5 short paragraphs or bullet points, then one line 'Focus:' with the single most useful thing to do. Under 280 words. Plain text with simple '-' bullets; no markdown headings or bold.",
    `Write in ${LANGUAGES[language] || "English"}.${name ? ` Address the person as ${name}.` : ""}`,
  ].join("\n");
}

async function* streamPrediction(context, { language = "en", name = null } = {}) {
  yield* generateReplyStream([{ role: "user", content: context }], {
    system: predictSystem(language, name), timeoutMs: 60_000,
  });
}

const FALLBACK = {
  en: (c, s) => `The detailed reading is unavailable right now, so here is the outline from your chart.\n\n- You are in your ${c?.mahadasha || "current"} mahadasha with the ${c?.antardasha || "current"} sub-period.\n- ${s.sadeSati.active ? `Saturn's Sade Sati is active (${s.sadeSati.phase} phase): favour patience, routine and steady effort.` : "Saturn's Sade Sati is not active now."}\n- ${s.ashtamaShani.active ? "Saturn is 8th from your Moon: keep plans simple and look after your rest." : "Saturn is not in the 8th from your Moon."}\n\nPlease try again in a little while for the full reading.`,
  hi: (c, s) => `विस्तृत फल अभी उपलब्ध नहीं है, इसलिए आपकी कुंडली की रूपरेखा:\n\n- अभी ${c?.mahadasha || ""} महादशा में ${c?.antardasha || ""} अंतर्दशा चल रही है।\n- ${s.sadeSati.active ? "शनि की साढ़ेसाती चल रही है: धैर्य और नियमित प्रयास रखें।" : "अभी साढ़ेसाती नहीं है।"}\n\nपूरा फल कुछ देर बाद फिर देखें।`,
  kn: (c, s) => `ವಿವರವಾದ ಫಲ ಈಗ ಲಭ್ಯವಿಲ್ಲ, ನಿಮ್ಮ ಜಾತಕದ ಸಾರಾಂಶ:\n\n- ಈಗ ${c?.mahadasha || ""} ಮಹಾದಶೆಯಲ್ಲಿ ${c?.antardasha || ""} ಅಂತರ್ದಶೆ ನಡೆಯುತ್ತಿದೆ.\n- ${s.sadeSati.active ? "ಶನಿಯ ಸಾಡೇಸಾತಿ ನಡೆಯುತ್ತಿದೆ: ತಾಳ್ಮೆ ಮತ್ತು ನಿಯಮಿತ ಪ್ರಯತ್ನ ಇರಲಿ." : "ಈಗ ಸಾಡೇಸಾತಿ ಇಲ್ಲ."}\n\nಸ್ವಲ್ಪ ಸಮಯದ ನಂತರ ಮತ್ತೆ ಪ್ರಯತ್ನಿಸಿ.`,
};

function fallbackReading(natal, period, language = "en") {
  const mid = new Date((period.start.getTime() + period.end.getTime()) / 2);
  const s = engine.saturnStatus(natal.rashi.sign, mid);
  return (FALLBACK[language] || FALLBACK.en)(currentDasha(natal, mid), s);
}

/** Which chart a birth record makes (the cache and the voice tools key on it). */
const chartHash = (b) => crypto.createHash("sha256").update([b.date, b.time || "-", b.lat, b.lng, b.tz].join("|")).digest("hex").slice(0, 32);

/** One cache entry per user, chart, range, category, language and period. */
const readingKey = (userId, birth, range, category, language, period) => crypto.createHash("sha256")
  .update([userId, chartHash(birth), range, category, language, period.key].join("|")).digest("hex");

/**
 * The whole reading at once (the voice tools; the app streams instead).
 * Tries twice, then the plain reading. Returns { text, fallback }.
 */
async function wholeReading(natal, period, category, { language = "en", name = null } = {}) {
  const context = predictionContext(natal, period, category);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      let text = "";
      for await (const d of streamPrediction(context, { language, name })) text += d;
      if (text.trim()) return { text: text.trim(), fallback: false };
    } catch (e) {
      console.warn(`jyotish reading attempt ${attempt + 1} failed:`, e.message);
      if (attempt === 0) await new Promise((r) => setTimeout(r, 600));
    }
  }
  return { text: fallbackReading(natal, period, language), fallback: true };
}

module.exports = {
  chartHash, readingKey, wholeReading,
  extract, cleanDate, cleanTime, predictionContext, streamPrediction, fallbackReading, periodOf, currentDasha,
  RANGES, CATEGORIES, LANGUAGES, EXTRACT_SCHEMA, _setModel,
};

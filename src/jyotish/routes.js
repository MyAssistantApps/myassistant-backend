/**
 * JYOTISH ROUTES (behind appAuth and the limiters in ./index.js).
 * Errors are { ok:false, error:<code>, message:<sentence> }; every request
 * already carries a request id (observability.requestId in server.js).
 *
 *   POST   /jyotish/extract    { messages:[{ role:"user"|"assistant", text }] }
 *                              -> { fields:{ name, date, time, timeStatus, place, gender }, followUp, complete, places? }
 *   GET    /jyotish/places     ?q=<place>  -> { places:[{ name, lat, lng, tz }] }   (top five, Nominatim)
 *   POST   /jyotish/chart      { birth, transitDate? } -> { birth, chart, transits }
 *   POST   /jyotish/predict    { birth, range, category, language, date? }  -> text/event-stream:
 *                              data:{"meta":{period, disclaimer, cached}}  data:{"t":"…"}…  [data:{"fallback":true}]  data:[DONE]
 *   GET    /jyotish/profiles   -> { profiles:[{ id, name, birth }] }
 *   POST   /jyotish/profiles   { name, birth } -> { profile }   (same name updates)
 *   DELETE /jyotish/profiles/:id -> { ok:true }
 *
 * birth = { name?, date:"YYYY-MM-DD", time:"HH:MM"|null, place?, lat, lng, tz?, gender? }
 * (time null = birth time unknown; tz is looked up from lat/lng when absent).
 */
const router = require("express").Router();
const engine = require("./engine");
const geo = require("./geo");
const jai = require("./ai");
const store = require("./store");

const DISCLAIMER = "For entertainment and self-reflection only.";
const MAX_BODY = 32 * 1024;

const fail = (res, status, error, message) => res.status(status).json({ ok: false, error, message });

function uid(req, res) {
  const id = Number(req.user?.sub);
  if (!Number.isInteger(id) || id <= 0) {
    fail(res, 400, "no_account", "A signed-in account is required");
    return null;
  }
  return id;
}

// The server's JSON parser allows 2 MB; nothing here needs more than a few KB.
router.use((req, res, next) => {
  const len = Number(req.headers["content-length"] || 0);
  if (len > MAX_BODY) return fail(res, 413, "too_large", "The request is too large");
  next();
});

/** A validated, normalised birth record, or a string saying what is wrong. */
function cleanBirth(b, today = new Date()) {
  if (!b || typeof b !== "object") return "Birth details are required";
  const date = jai.cleanDate(b.date, today);
  if (!date) return "The date of birth must be a real date (YYYY-MM-DD), not in the future";
  let time = null;
  if (b.time != null && b.time !== "") {
    time = jai.cleanTime(b.time);
    if (!time) return "The birth time must be HH:MM (24-hour)";
  }
  const lat = Number(b.lat), lng = Number(b.lng);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180) {
    return "Choose the birth place from the list so its location is known";
  }
  const tz = b.tz ? String(b.tz) : geo.zoneOf(lat, lng);
  if (!geo.validZone(tz)) return "The birth place's timezone is not known";
  const { utc, offsetMinutes } = geo.localToUtc(date, time, tz);
  if (utc.getTime() > today.getTime() + 86_400_000) return "The date of birth cannot be in the future";
  const str = (v, n) => (typeof v === "string" && v.trim() ? v.trim().slice(0, n) : null);
  return {
    name: str(b.name, 80),
    date, time, tz,
    place: str(b.place, 200),
    lat: Math.round(lat * 1e5) / 1e5,
    lng: Math.round(lng * 1e5) / 1e5,
    gender: ["male", "female", "other"].includes(b.gender) ? b.gender : null,
    utc: utc.toISOString(),
    offsetMinutes,
  };
}

const natalOf = (b, at = new Date()) => engine.chart({ utc: new Date(b.utc), lat: b.lat, lng: b.lng, timeKnown: !!b.time, at });

router.post("/extract", async (req, res) => {
  if (!uid(req, res)) return;
  const msgs = req.body?.messages;
  if (!Array.isArray(msgs) || !msgs.length || msgs.length > 20) {
    return fail(res, 400, "bad_messages", "Send between 1 and 20 messages");
  }
  const conversation = [];
  for (const m of msgs) {
    const text = typeof m?.text === "string" ? m.text.trim() : "";
    if (!text || text.length > 1000) return fail(res, 400, "bad_messages", "Each message must be 1–1000 characters");
    conversation.push({ role: m.role === "assistant" ? "assistant" : "user", text });
  }
  try {
    const out = await jai.extract(conversation);
    if (out.fields.place) {
      try { out.places = await geo.searchPlaces(out.fields.place); } catch { out.places = []; }
    }
    res.json(out);
  } catch (e) {
    console.warn("jyotish/extract failed:", e.message);
    fail(res, 502, "ai_unavailable", "Unable to read the details right now. You can fill in the form instead.");
  }
});

router.get("/places", async (req, res) => {
  if (!uid(req, res)) return;
  const q = String(req.query.q || "").trim();
  if (q.length < 2 || q.length > 160) return fail(res, 400, "bad_query", "Type at least two letters of the place");
  try {
    res.json({ places: await geo.searchPlaces(q) });
  } catch (e) {
    console.warn("jyotish/places failed:", e.message);
    fail(res, 502, "geocode_unavailable", "Unable to look up places right now. Please try again.");
  }
});

function transitDateOf(v) {
  if (v == null || v === "") return new Date();
  const m = /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? new Date(`${v}T12:00:00Z`) : null;
  if (!m || Number.isNaN(m.getTime()) || m.getUTCFullYear() < 1900 || m.getUTCFullYear() > 2100) return null;
  return m;
}

router.post("/chart", (req, res) => {
  if (!uid(req, res)) return;
  const birth = cleanBirth(req.body?.birth);
  if (typeof birth === "string") return fail(res, 400, "bad_birth", birth);
  const at = transitDateOf(req.body?.transitDate);
  if (!at) return fail(res, 400, "bad_date", "The transit date must be YYYY-MM-DD between 1900 and 2100");
  try {
    const chart = natalOf(birth, at);
    res.json({ birth, chart, transits: engine.transits(chart, at), disclaimer: DISCLAIMER });
  } catch (e) {
    console.error("jyotish/chart failed:", e.stack || e.message);
    fail(res, 500, "chart_failed", "Unable to calculate the chart");
  }
});

router.post("/predict", async (req, res) => {
  const userId = uid(req, res);
  if (!userId) return;
  const body = req.body || {};
  const birth = cleanBirth(body.birth);
  if (typeof birth === "string") return fail(res, 400, "bad_birth", birth);
  const range = jai.RANGES.includes(body.range) ? body.range : null;
  const category = jai.CATEGORIES.includes(body.category) ? body.category : null;
  const language = jai.LANGUAGES[body.language] ? body.language : "en";
  if (!range) return fail(res, 400, "bad_range", `range must be one of ${jai.RANGES.join(", ")}`);
  if (!category) return fail(res, 400, "bad_category", `category must be one of ${jai.CATEGORIES.join(", ")}`);
  let custom = null;
  if (range === "custom") {
    custom = transitDateOf(body.date);
    if (!custom || !body.date) return fail(res, 400, "bad_date", "Choose a date between 1900 and 2100");
  }
  const period = jai.periodOf(range, new Date(), custom ? String(body.date) : null);
  const key = jai.readingKey(userId, birth, range, category, language, period);

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  const send = (j) => res.write(`data: ${JSON.stringify(j)}\n\n`);
  const meta = { period: { start: period.start.toISOString().slice(0, 10), end: period.end.toISOString().slice(0, 10) }, disclaimer: DISCLAIMER };

  let natal;
  try {
    natal = natalOf(birth);
    const hit = await store.cachedPrediction(key);
    if (hit) {
      send({ meta: { ...meta, cached: true } });
      send({ t: hit });
      res.write("data: [DONE]\n\n");
      return res.end();
    }
  } catch (e) {
    console.error("jyotish/predict setup failed:", e.stack || e.message);
    send({ error: { message: "Unable to prepare the reading. Please try again." } });
    res.write("data: [DONE]\n\n");
    return res.end();
  }

  send({ meta: { ...meta, cached: false } });
  let closed = false;
  req.on("close", () => { closed = true; });
  const context = jai.predictionContext(natal, period, category);
  let text = "";
  // One retry when nothing has been sent yet; after that a partial reading stays as it is.
  for (let attempt = 0; attempt < 2 && !closed; attempt++) {
    try {
      for await (const d of jai.streamPrediction(context, { language, name: birth.name })) {
        if (closed) break;
        text += d;
        send({ t: d });
      }
      break;
    } catch (e) {
      console.warn(`jyotish/predict attempt ${attempt + 1} failed:`, e.message);
      if (text) break;
      if (attempt === 1) {
        send({ fallback: true });
        send({ t: jai.fallbackReading(natal, period, language) });
      } else {
        await new Promise((r) => setTimeout(r, 600));
      }
    }
  }
  if (text.trim().length > 40 && !closed) {
    store.savePrediction(key, userId, text.trim()).catch((e) => console.warn("jyotish cache save failed:", e.message));
  }
  res.write("data: [DONE]\n\n");
  res.end();
});

router.get("/profiles", async (req, res) => {
  const userId = uid(req, res);
  if (!userId) return;
  res.json({ profiles: await store.listProfiles(userId) });
});

router.post("/profiles", async (req, res) => {
  const userId = uid(req, res);
  if (!userId) return;
  const name = typeof req.body?.name === "string" ? req.body.name.trim().slice(0, 80) : "";
  if (!name) return fail(res, 400, "bad_name", "Give the profile a name");
  const birth = cleanBirth(req.body?.birth);
  if (typeof birth === "string") return fail(res, 400, "bad_birth", birth);
  const profile = await store.saveProfile(userId, name, { ...birth, name });
  if (!profile) return fail(res, 409, "limit", `You can save up to ${store.PROFILE_LIMIT} profiles. Delete one first.`);
  res.json({ profile });
});

router.delete("/profiles/:id", async (req, res) => {
  const userId = uid(req, res);
  if (!userId) return;
  const s = String(req.params.id || "");
  const id = /^\d{1,15}$/.test(s) ? Number(s) : NaN;
  if (!Number.isSafeInteger(id) || id <= 0) return fail(res, 400, "bad_id", "The profile id must be a positive whole number");
  if (!(await store.deleteProfile(userId, id))) return fail(res, 404, "not_found", "No such profile");
  res.json({ ok: true });
});

// Anything thrown in the async routes lands here in the same shape.
router.use((err, req, res, _next) => {
  console.error("jyotish:", err.stack || err.message);
  if (res.headersSent) return res.end();
  fail(res, 500, "server_error", "Something went wrong. Please try again.");
});

module.exports = router;
module.exports.cleanBirth = cleanBirth;
module.exports.DISCLAIMER = DISCLAIMER;

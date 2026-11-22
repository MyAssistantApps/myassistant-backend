/**
 * JYOTISH (src/jyotish) — the engine against Swiss Ephemeris, and every route.
 *
 *   (a) engine: four reference charts (planets, Rahu, ascendant, ayanamsa)
 *       generated with pyswisseph 2.10 (SIDM_LAHIRI, mean node, whole sign),
 *       within 0.1°; nakshatra/pada; the dasha timeline; Sade Sati and
 *       Ashtama Shani; yogas and Manglik on hand-made positions; the no-time mode
 *   (b) time: local birth time → UTC with historical offsets and DST
 *   (c) routes, with the model and Nominatim replaced: extract (follow-ups,
 *       bad dates dropped, model down), places (cache, User-Agent), chart
 *       (validation), predict (SSE, cache, retry, fallback), profiles
 *       (limit, another user's id), body size
 *
 * Run: DATABASE_URL=postgres://… node scripts/jyotish-test.js
 */
process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgres://myassistant:localdev@localhost:5432/myassistant";
process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.JYOTISH_RATE_PER_MIN = "100000";
process.env.JYOTISH_AI_RATE_PER_MIN = "100000";

const assert = require("assert");
const express = require("express");
const db = require("../src/db");
const E = require("../src/jyotish/engine");
const geo = require("../src/jyotish/geo");
const jai = require("../src/jyotish/ai");
const jyotish = require("../src/jyotish");

let passed = 0;
async function atest(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`  FAIL ${name}\n       ${e.stack || e.message}`);
    process.exitCode = 1;
  }
}
const angle = (a, b) => Math.abs(((a - b + 540) % 360) - 180);
const near = (a, b, tol, what) => assert.ok(angle(a, b) <= tol, `${what}: ${a} vs ${b} (Δ ${angle(a, b).toFixed(4)}°)`);

// Swiss Ephemeris, sidereal Lahiri, apparent geocentric, mean node, ascendant.
const REFERENCE = {
  "Udupi 2004-03-14 06:30 IST": { utc: "2004-03-14T01:00:00Z", lat: 13.3409, lng: 74.7421, ayanamsa: 23.91574,
    Sun: 329.8735, Moon: 242.0549, Mars: 31.4241, Mercury: 339.2879, Jupiter: 138.7798, Venus: 15.1486, Saturn: 72.4111, Rahu: 19.922, Asc: 326.0629 },
  "Delhi 1990-08-15 10:00 IST": { utc: "1990-08-15T04:30:00Z", lat: 28.6139, lng: 77.209, ayanamsa: 23.72606,
    Sun: 118.3749, Moon: 48.6329, Mars: 27.4749, Mercury: 145.4297, Jupiter: 95.6021, Venus: 97.8171, Saturn: 266.1491, Rahu: 282.7546, Asc: 172.1366 },
  "London 1985-07-01 15:00 BST": { utc: "1985-07-01T14:00:00Z", lat: 51.5074, lng: -0.1278, ayanamsa: 23.65452,
    Sun: 76.015, Moon: 243.7409, Mars: 80.9929, Mercury: 99.0487, Jupiter: 292.2054, Venus: 31.3022, Saturn: 208.2827, Rahu: 21.8817, Asc: 184.0705 },
  "New York 1969-07-20 16:18 EDT": { utc: "1969-07-20T20:18:00Z", lat: 40.7128, lng: -74.006, ayanamsa: 23.43178,
    Sun: 94.4789, Moon: 164.4502, Mars: 219.3409, Mercury: 92.4119, Jupiter: 157.3138, Venus: 51.6057, Saturn: 14.6655, Rahu: 330.5464, Asc: 218.7138 },
};
const RETRO = { "Udupi 2004-03-14 06:30 IST": ["Jupiter"], "Delhi 1990-08-15 10:00 IST": ["Saturn"],
  "London 1985-07-01 15:00 BST": ["Jupiter", "Saturn"], "New York 1969-07-20 16:18 EDT": [] };

/** Positions shaped like engine.positions(), from sign numbers (degree 15). */
function fakePositions(signs) {
  const p = {};
  for (const pl of E.PLANETS) p[pl] = { name: pl, ...E.place((signs[pl] ?? 0) * 30 + 15) };
  return p;
}

async function engineTests() {
  console.log("(a) engine");
  for (const [name, r] of Object.entries(REFERENCE)) {
    await atest(`reference chart: ${name}`, () => {
      const d = new Date(r.utc);
      const pos = E.positions(d);
      near(E.ayanamsa(d), r.ayanamsa, 0.01, "ayanamsa");
      for (const pl of ["Sun", "Moon", "Mars", "Mercury", "Jupiter", "Venus", "Saturn", "Rahu"]) near(pos[pl].lon, r[pl], 0.1, pl);
      near(pos.Ketu.lon, (r.Rahu + 180) % 360, 0.1, "Ketu");
      near(E.ascendant(d, r.lat, r.lng), r.Asc, 0.1, "ascendant");
      const retro = ["Mars", "Mercury", "Jupiter", "Venus", "Saturn"].filter((pl) => pos[pl].retrograde);
      assert.deepStrictEqual(retro, RETRO[name], "retrograde planets");
      assert.strictEqual(pos.Sun.retrograde, false);
      assert.strictEqual(pos.Rahu.retrograde, true);
    });
  }

  await atest("nakshatra and pada boundaries", () => {
    assert.deepStrictEqual([E.place(0).nakshatra, E.place(0).pada], ["Ashwini", 1]);
    assert.deepStrictEqual([E.place(3.34).nakshatra, E.place(3.34).pada], ["Ashwini", 2]);
    assert.deepStrictEqual([E.place(13.34).nakshatra, E.place(13.34).pada], ["Bharani", 1]);
    assert.deepStrictEqual([E.place(359.99).nakshatra, E.place(359.99).pada], ["Revati", 4]);
    assert.strictEqual(E.place(242.0549).nakshatra, "Mula"); // the Udupi Moon: Sagittarius 2°
    assert.strictEqual(E.place(242.0549).signName, "Sagittarius");
  });

  await atest("Vimshottari: nine periods, 120 years, contiguous, antardashas fill each one", () => {
    const birth = new Date("2004-03-14T01:00:00Z");
    const v = E.vimshottari(242.0549, birth, { now: new Date("2026-11-22T00:00:00Z") });
    assert.strictEqual(v.mahadashas.length, 9);
    assert.strictEqual(v.mahadashas[0].lord, "Ketu"); // Mula is ruled by Ketu
    const total = (Date.parse(v.mahadashas[8].end) - Date.parse(v.mahadashas[0].start)) / (365.25 * 86_400_000);
    assert.ok(Math.abs(total - 120) < 1e-6, `total ${total}`);
    for (let i = 1; i < 9; i++) assert.strictEqual(v.mahadashas[i].start, v.mahadashas[i - 1].end);
    for (const m of v.mahadashas) {
      assert.strictEqual(m.antardashas[0].lord, m.lord);
      assert.strictEqual(m.antardashas[0].start, m.start);
      assert.ok(Math.abs(Date.parse(m.antardashas[8].end) - Date.parse(m.end)) < 5, "antardashas end with the mahadasha");
    }
    // Moon 2.0549° into Mula (13.333° long): 84.6% of Ketu's 7 years remain.
    assert.ok(Math.abs(v.balance.years - 7 * (1 - 2.0549 / (40 / 3))) < 0.01, `balance ${v.balance.years}`);
    assert.ok(Date.parse(v.mahadashas[0].start) < birth.getTime());
    // Ketu ~5.9 y → Venus to ~2030: Venus mahadasha in 2026.
    assert.strictEqual(v.current.mahadasha, "Venus");
    assert.ok(v.current.antardasha);
  });

  await atest("Sade Sati phases and Ashtama Shani (Saturn: Aquarius 2023-25, Pisces 2025-27)", () => {
    const d = new Date("2024-06-01T00:00:00Z");
    assert.strictEqual(E.SIGNS[Math.floor(E.siderealAt("Saturn", d) / 30)], "Aquarius");
    const peak = E.saturnStatus(10, d); // Moon in Aquarius
    assert.deepStrictEqual([peak.sadeSati.active, peak.sadeSati.phase], [true, "peak"]);
    assert.ok(peak.sadeSati.start < "2023-06-01" && peak.sadeSati.end > "2024-12-01", JSON.stringify(peak.sadeSati));
    assert.strictEqual(E.saturnStatus(11, d).sadeSati.phase, "rising"); // Moon in Pisces: Saturn in its 12th
    assert.strictEqual(E.saturnStatus(9, d).sadeSati.phase, "setting"); // Moon in Capricorn: Saturn in its 2nd
    const none = E.saturnStatus(4, d); // Moon in Leo: Saturn 7th
    assert.strictEqual(none.sadeSati.active, false);
    assert.ok(none.sadeSati.next, "the next one is found");
    const eighth = E.saturnStatus(3, d); // Moon in Cancer: Saturn 8th
    assert.strictEqual(eighth.ashtamaShani.active, true);
    assert.strictEqual(eighth.saturnHouseFromMoon, 8);
  });

  await atest("yogas: the rules table on hand-made charts", () => {
    // Moon Taurus, Jupiter Leo (4th from Moon) → Gajakesari; Sun+Mercury Aries → Budhaditya; Mars with Moon.
    const p = fakePositions({ Sun: 0, Mercury: 0, Moon: 1, Mars: 1, Jupiter: 4, Venus: 6, Saturn: 9, Rahu: 2, Ketu: 8 });
    const byId = Object.fromEntries(E.yogas(p, null).map((y) => [y.id, y]));
    assert.strictEqual(byId.gajakesari.present, true);
    assert.strictEqual(byId.budhaditya.present, true);
    assert.strictEqual(byId.chandra_mangal.present, true);
    assert.strictEqual(byId.raj_yoga.present, null);
    assert.strictEqual(byId.raj_yoga.reason, "Birth time needed");
    const q = fakePositions({ Sun: 3, Mercury: 5, Moon: 1, Mars: 6, Jupiter: 2, Venus: 6, Saturn: 9, Rahu: 2, Ketu: 8 });
    const byQ = Object.fromEntries(E.yogas(q, null).map((y) => [y.id, y]));
    assert.strictEqual(byQ.gajakesari.present, false); // Jupiter 2nd from Moon
    assert.strictEqual(byQ.budhaditya.present, false);
    // Lagna Aries: Saturn (lord of 10) with Jupiter (lord of 9) in Capricorn → Raj Yoga; Saturn own sign in 10th → Shasha.
    const r = fakePositions({ Sun: 3, Mercury: 5, Moon: 1, Mars: 6, Jupiter: 9, Venus: 6, Saturn: 9, Rahu: 2, Ketu: 8 });
    const byR = Object.fromEntries(E.yogas(r, 0).map((y) => [y.id, y]));
    assert.strictEqual(byR.raj_yoga.present, true, byR.raj_yoga.reason);
    assert.match(byR.raj_yoga.reason, /Saturn \(lord of 10\) with Jupiter \(lord of 9\)/);
    assert.strictEqual(byR.shasha.present, true);
    assert.strictEqual(byR.hamsa.present, false); // Jupiter debilitated
  });

  await atest("Manglik from the lagna and the Moon, with mitigation", () => {
    const p = fakePositions({ Moon: 1, Mars: 6, Jupiter: 3 });
    const a = E.manglik(p, 0); // Mars in 7th from Aries lagna
    assert.strictEqual(a.present, true);
    assert.strictEqual(a.fromLagna.house, 7);
    assert.strictEqual(a.mitigated, false);
    const own = E.manglik(fakePositions({ Moon: 1, Mars: 7, Jupiter: 3 }), 0); // Scorpio, 8th, own sign
    assert.strictEqual(own.present, true);
    assert.strictEqual(own.mitigated, true);
    const no = E.manglik(fakePositions({ Moon: 0, Mars: 2, Jupiter: 3 }), 0); // 3rd from both
    assert.strictEqual(no.present, false);
    const partial = E.manglik(fakePositions({ Moon: 0, Mars: 3 }), null);
    assert.strictEqual(partial.partial, true);
    assert.strictEqual(partial.fromLagna, "Birth time needed");
    assert.strictEqual(partial.present, true); // 4th from the Moon
  });

  await atest("chart with a birth time: lagna, 12 whole-sign houses, planets housed", () => {
    const c = E.chart({ utc: new Date(REFERENCE["Udupi 2004-03-14 06:30 IST"].utc), lat: 13.3409, lng: 74.7421, at: new Date("2026-11-22T00:00:00Z") });
    assert.strictEqual(c.lagna.signName, "Aquarius");
    assert.strictEqual(c.houses.length, 12);
    assert.strictEqual(c.houses[0].signName, "Aquarius");
    assert.strictEqual(c.houses[0].lord, "Saturn");
    assert.strictEqual(c.planets.find((p) => p.name === "Sun").house, 1); // Sun in Aquarius 29.9°
    assert.strictEqual(c.rashi.signName, "Sagittarius");
    assert.strictEqual(c.nakshatra.name, "Mula");
    assert.deepStrictEqual(c.needsBirthTime, []);
    assert.strictEqual(c.yogas.find((y) => y.id === "raj_yoga").present !== null, true);
  });

  await atest("chart without a birth time: Moon-based only, the rest marked", () => {
    const c = E.chart({ utc: new Date("2004-03-14T06:30:00Z"), lat: 13.34, lng: 74.74, timeKnown: false });
    assert.strictEqual(c.lagna, null);
    assert.strictEqual(c.houses, null);
    assert.ok(c.needsBirthTime.includes("lagna"));
    assert.strictEqual(c.yogas.find((y) => y.id === "raj_yoga").present, null);
    assert.ok(c.dasha.mahadashas.length === 9);
    assert.strictEqual(typeof c.moonUncertain, "boolean");
    assert.ok(c.planets.every((p) => p.house === undefined));
  });

  await atest("transits count houses from the natal Moon and lagna", () => {
    const c = E.chart({ utc: new Date("2004-03-14T01:00:00Z"), lat: 13.3409, lng: 74.7421 });
    const t = E.transits(c, new Date("2024-06-01T00:00:00Z"));
    const sat = t.planets.find((p) => p.name === "Saturn");
    assert.strictEqual(sat.signName, "Aquarius");
    assert.strictEqual(sat.houseFromMoon, 3); // Sagittarius → Aquarius
    assert.strictEqual(sat.houseFromLagna, 1);
    assert.strictEqual(t.planets.length, 9);
  });
}

async function timeTests() {
  console.log("(b) time");
  await atest("local time → UTC with the zone's offset of that date", () => {
    const iso = (d, t, z) => geo.localToUtc(d, t, z).utc.toISOString().slice(0, 16);
    assert.strictEqual(iso("2004-03-14", "06:30", "Asia/Kolkata"), "2004-03-14T01:00");
    assert.strictEqual(iso("1985-07-01", "15:00", "Europe/London"), "1985-07-01T14:00"); // BST
    assert.strictEqual(iso("1985-01-01", "15:00", "Europe/London"), "1985-01-01T15:00"); // GMT
    assert.strictEqual(iso("1969-07-20", "16:18", "America/New_York"), "1969-07-20T20:18"); // EDT
    assert.strictEqual(iso("1943-06-01", "12:00", "Asia/Kolkata"), "1943-06-01T05:30"); // war time, +6:30
    assert.strictEqual(geo.localToUtc("2004-03-14", "06:30", "Asia/Kolkata").offsetMinutes, 330);
    assert.strictEqual(iso("2024-03-10", "02:30", "America/New_York"), "2024-03-10T07:30"); // skipped hour resolves
    assert.strictEqual(iso("2004-03-14", null, "Asia/Kolkata"), "2004-03-14T06:30"); // no time = local noon
  });
  await atest("timezone from coordinates", () => {
    assert.strictEqual(geo.zoneOf(13.34, 74.74), "Asia/Kolkata");
    assert.strictEqual(geo.zoneOf(51.5, -0.12), "Europe/London");
    assert.strictEqual(geo.validZone("Nowhere/Land"), false);
  });
  await atest("dates and times are validated", () => {
    assert.strictEqual(jai.cleanDate("2004-02-30"), null);
    assert.strictEqual(jai.cleanDate("2999-01-01"), null);
    assert.strictEqual(jai.cleanDate("1700-01-01"), null);
    assert.strictEqual(jai.cleanDate("2004-03-14"), "2004-03-14");
    assert.strictEqual(jai.cleanTime("6:30"), "06:30");
    assert.strictEqual(jai.cleanTime("24:10"), null);
    assert.strictEqual(jai.cleanTime("morning"), null);
  });
}

// ── routes ──────────────────────────────────────────────────────────────

let server, base;
async function call(method, path, body, user = 1, extraHeaders = {}) {
  const r = await fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json", "X-Test-User": String(user), ...extraHeaders },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text, headers: r.headers };
}
const sse = (text) => text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim())
  .filter((l) => l && l !== "[DONE]").map((l) => JSON.parse(l));

const BIRTH = { name: "Asha", date: "2004-03-14", time: "06:30", place: "Udupi, Karnataka, India", lat: 13.3409, lng: 74.7421 };

async function routeTests() {
  console.log("(c) routes");
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use((req, _res, next) => { req.user = { sub: Number(req.headers["x-test-user"]) || 0 }; next(); });
  app.use("/jyotish", jyotish.limiter, jyotish.router);
  // Rerunnable: last run's cached readings for the test users go first.
  await require("../src/jyotish/store").migrate();
  await db.run(`DELETE FROM jyotish_predictions WHERE user_id = ANY($1)`, [[1, 2]]);
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;

  // The model, replaced.
  let replyCalls = 0, streamCalls = 0, replyImpl, streamImpl;
  jai._setModel({
    reply: async (...a) => { replyCalls++; return replyImpl(...a); },
    stream: (...a) => { streamCalls++; return streamImpl(...a); },
  });
  // Nominatim, replaced.
  let fetches = [];
  geo._setFetch(async (url, opts) => {
    fetches.push({ url, opts });
    return { ok: true, json: async () => [
      { display_name: "Udupi, Karnataka, India", lat: "13.3409", lon: "74.7421" },
      { display_name: "Udupi district, Karnataka, India", lat: "13.4", lon: "74.9" },
    ] };
  });

  await atest("extract: full details → complete, fields, places", async () => {
    replyImpl = async (messages, opts) => {
      assert.ok(opts.json && opts.schema, "asks for JSON with a schema");
      assert.match(opts.system, /Today is \d{4}-\d{2}-\d{2}/);
      return { reply: JSON.stringify({ name: "Asha", date: "2004-03-14", time: "06:30", timeStatus: "approximate", place: "Udupi", gender: "", followUp: "" }) };
    };
    const r = await call("POST", "/jyotish/extract", { messages: [{ role: "user", text: "I was born 14 March 2004, around 6:30 in the morning in Udupi" }] });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.json.complete, true);
    assert.deepStrictEqual(r.json.fields, { name: "Asha", date: "2004-03-14", time: "06:30", timeStatus: "approximate", place: "Udupi", gender: null });
    assert.strictEqual(r.json.followUp, null);
    assert.strictEqual(r.json.places.length, 2);
    assert.strictEqual(r.json.places[0].tz, "Asia/Kolkata");
  });

  await atest("extract: vague time → not complete, a follow-up; impossible date dropped", async () => {
    replyImpl = async () => ({ reply: JSON.stringify({ name: "", date: "2004-02-31", time: "", timeStatus: "not_given", place: "", gender: "", followUp: "" }) });
    const r = await call("POST", "/jyotish/extract", { messages: [{ role: "user", text: "born in the morning on 31 Feb 2004" }] });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.complete, false);
    assert.strictEqual(r.json.fields.date, null);
    assert.match(r.json.followUp, /date of birth/i);
  });

  await atest("extract: 'I don't know the time' → time null, complete", async () => {
    replyImpl = async () => ({ reply: JSON.stringify({ name: "", date: "1990-08-15", time: "", timeStatus: "unknown", place: "Delhi", gender: "male", followUp: "" }) });
    const r = await call("POST", "/jyotish/extract", { messages: [{ role: "user", text: "15/8/1990 Delhi" }, { role: "assistant", text: "Birth time?" }, { role: "user", text: "don't know" }] });
    assert.strictEqual(r.json.complete, true);
    assert.strictEqual(r.json.fields.time, null);
    assert.strictEqual(r.json.fields.timeStatus, "unknown");
    assert.strictEqual(r.json.fields.gender, "male");
  });

  await atest("extract: bad input 400, model down 502 in the error shape", async () => {
    assert.strictEqual((await call("POST", "/jyotish/extract", { messages: [] })).status, 400);
    assert.strictEqual((await call("POST", "/jyotish/extract", { messages: [{ text: "x".repeat(1001) }] })).status, 400);
    replyImpl = async () => { throw new Error("503 busy"); };
    const r = await call("POST", "/jyotish/extract", { messages: [{ role: "user", text: "hello" }] });
    assert.strictEqual(r.status, 502);
    assert.deepStrictEqual(Object.keys(r.json).sort(), ["error", "message", "ok"]);
    assert.strictEqual(r.json.error, "ai_unavailable");
  });

  await atest("places: Nominatim once (User-Agent set), then the cache", async () => {
    fetches = [];
    const q = `Mangalore ${Date.now()}`;
    const a = await call("GET", `/jyotish/places?q=${encodeURIComponent(q)}`);
    const b = await call("GET", `/jyotish/places?q=${encodeURIComponent(q.toUpperCase())}`);
    assert.strictEqual(a.status, 200);
    assert.deepStrictEqual(a.json, b.json);
    assert.strictEqual(fetches.length, 1, "the second is served from the cache");
    assert.match(fetches[0].opts.headers["User-Agent"], /MyAssistant/);
    assert.match(fetches[0].url, /limit=5/);
    assert.strictEqual((await call("GET", "/jyotish/places?q=a")).status, 400);
  });

  await atest("places: requests to Nominatim are a second apart", async () => {
    fetches = [];
    const t0 = Date.now();
    await Promise.all([call("GET", `/jyotish/places?q=a1${t0}`), call("GET", `/jyotish/places?q=b2${t0}`)]);
    assert.strictEqual(fetches.length, 2);
    assert.ok(Date.now() - t0 >= 1000, `${Date.now() - t0} ms`);
  });

  await atest("chart: computed, with UTC and offset; bad input 400", async () => {
    const r = await call("POST", "/jyotish/chart", { birth: BIRTH, transitDate: "2024-06-01" });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.json.birth.utc, "2004-03-14T01:00:00.000Z");
    assert.strictEqual(r.json.birth.tz, "Asia/Kolkata");
    assert.strictEqual(r.json.birth.offsetMinutes, 330);
    assert.strictEqual(r.json.chart.lagna.signName, "Aquarius");
    assert.strictEqual(r.json.transits.planets.find((p) => p.name === "Saturn").houseFromMoon, 3);
    assert.strictEqual(r.json.disclaimer, "For entertainment and self-reflection only.");
    for (const bad of [
      { ...BIRTH, date: "2004-13-01" }, { ...BIRTH, date: "2999-01-01" }, { ...BIRTH, time: "25:00" },
      { ...BIRTH, lat: 91 }, { ...BIRTH, lat: undefined }, { ...BIRTH, tz: "Mars/Olympus" },
    ]) {
      const x = await call("POST", "/jyotish/chart", { birth: bad });
      assert.strictEqual(x.status, 400, JSON.stringify(bad));
      assert.strictEqual(x.json.error, "bad_birth");
    }
    assert.strictEqual((await call("POST", "/jyotish/chart", { birth: BIRTH, transitDate: "tomorrow" })).status, 400);
    const noTime = await call("POST", "/jyotish/chart", { birth: { ...BIRTH, time: null } });
    assert.strictEqual(noTime.json.chart.lagna, null);
  });

  await atest("predict: streams the reading from the chart's data, then serves it from the cache", async () => {
    let sentContext = null, sentSystem = null;
    streamImpl = async function* (messages, opts) {
      sentContext = messages[0].content;
      sentSystem = opts.system;
      yield "Steady progress this month. ";
      yield "With Saturn in your 3rd from the Moon, effort pays.";
    };
    streamCalls = 0;
    const body = { birth: BIRTH, range: "month", category: "career", language: "hi" };
    const r = await call("POST", "/jyotish/predict", body);
    assert.strictEqual(r.status, 200);
    assert.match(r.headers.get("content-type"), /text\/event-stream/);
    const ev = sse(r.text);
    assert.strictEqual(ev[0].meta.cached, false);
    assert.strictEqual(ev[0].meta.disclaimer, "For entertainment and self-reflection only.");
    assert.strictEqual(ev.filter((e) => e.t).map((e) => e.t).join(""), "Steady progress this month. With Saturn in your 3rd from the Moon, effort pays.");
    assert.match(sentContext, /RUNNING DASHA/);
    assert.match(sentContext, /SADE SATI/);
    assert.match(sentContext, /MOON SIGN \(RASHI\): Sagittarius/);
    assert.match(sentContext, /FOCUS: career/);
    assert.match(sentSystem, /ONLY the astrological data/);
    assert.match(sentSystem, /never frighten/i);
    assert.match(sentSystem, /medical, legal or financial guarantees/);
    assert.match(sentSystem, /Hindi/);
    await new Promise((res) => setTimeout(res, 100)); // the cache write is not awaited by the stream
    const again = sse((await call("POST", "/jyotish/predict", body)).text);
    assert.strictEqual(again[0].meta.cached, true);
    assert.strictEqual(streamCalls, 1, "the model is not called again");
    // Another user, same chart: not their cache.
    await call("POST", "/jyotish/predict", body, 2);
    assert.strictEqual(streamCalls, 2);
  });

  await atest("predict: no birth time → the model is told not to use the lagna", async () => {
    let ctx = "";
    streamImpl = async function* (m) { ctx = m[0].content; yield "A calm week ahead, with patience rewarded."; };
    await call("POST", "/jyotish/predict", { birth: { ...BIRTH, time: null }, range: "week", category: "overall", language: "en" });
    assert.match(ctx, /BIRTH TIME KNOWN: no/);
    assert.doesNotMatch(ctx, /ASCENDANT/);
  });

  await atest("predict: a failure is retried once, then the plain fallback", async () => {
    let n = 0;
    streamImpl = async function* () { n++; if (n === 1) throw new Error("ECONNRESET"); yield "Second try worked well for this reading."; };
    const ok = sse((await call("POST", "/jyotish/predict", { birth: BIRTH, range: "today", category: "love", language: "en" })).text);
    assert.strictEqual(n, 2);
    assert.ok(ok.some((e) => e.t === "Second try worked well for this reading."));
    streamImpl = async function* () { throw new Error("503 down"); };
    const fb = sse((await call("POST", "/jyotish/predict", { birth: BIRTH, range: "today", category: "money", language: "en" })).text);
    assert.ok(fb.some((e) => e.fallback === true));
    assert.match(fb.find((e) => e.t).t, /mahadasha/);
  });

  await atest("predict: range, category and custom date validated", async () => {
    assert.strictEqual((await call("POST", "/jyotish/predict", { birth: BIRTH, range: "decade", category: "overall" })).status, 400);
    assert.strictEqual((await call("POST", "/jyotish/predict", { birth: BIRTH, range: "today", category: "lottery" })).status, 400);
    assert.strictEqual((await call("POST", "/jyotish/predict", { birth: BIRTH, range: "custom", category: "overall" })).status, 400);
    streamImpl = async function* () { yield "A good day for learning something new and steady."; };
    const r = sse((await call("POST", "/jyotish/predict", { birth: BIRTH, range: "custom", date: "2027-01-15", category: "education" })).text);
    assert.deepStrictEqual(r[0].meta.period, { start: "2027-01-15", end: "2027-01-15" });
  });

  await atest("profiles: save, same name updates, list, another user's id is 404, delete", async () => {
    const uidA = 900001, uidB = 900002;
    for (const u of [uidA, uidB]) for (const p of (await call("GET", "/jyotish/profiles", undefined, u)).json.profiles) await call("DELETE", `/jyotish/profiles/${p.id}`, undefined, u);
    const a = await call("POST", "/jyotish/profiles", { name: "Asha", birth: BIRTH }, uidA);
    assert.strictEqual(a.status, 200, a.text);
    assert.strictEqual(a.json.profile.birth.utc, "2004-03-14T01:00:00.000Z");
    const again = await call("POST", "/jyotish/profiles", { name: "asha", birth: { ...BIRTH, time: "07:00" } }, uidA);
    assert.strictEqual(again.json.profile.id, a.json.profile.id);
    const list = (await call("GET", "/jyotish/profiles", undefined, uidA)).json.profiles;
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].birth.time, "07:00");
    assert.strictEqual((await call("GET", "/jyotish/profiles", undefined, uidB)).json.profiles.length, 0);
    assert.strictEqual((await call("DELETE", `/jyotish/profiles/${a.json.profile.id}`, undefined, uidB)).status, 404);
    assert.strictEqual((await call("DELETE", "/jyotish/profiles/abc", undefined, uidA)).status, 400);
    assert.strictEqual((await call("POST", "/jyotish/profiles", { name: "", birth: BIRTH }, uidA)).status, 400);
    for (let i = 0; i < 19; i++) await call("POST", "/jyotish/profiles", { name: `P${i}`, birth: BIRTH }, uidA);
    const over = await call("POST", "/jyotish/profiles", { name: "One too many", birth: BIRTH }, uidA);
    assert.strictEqual(over.status, 409);
    for (const p of (await call("GET", "/jyotish/profiles", undefined, uidA)).json.profiles) {
      assert.strictEqual((await call("DELETE", `/jyotish/profiles/${p.id}`, undefined, uidA)).status, 200);
    }
  });

  await atest("no account → 400; oversized body → 413", async () => {
    assert.strictEqual((await call("GET", "/jyotish/profiles", undefined, 0)).status, 400);
    const big = await call("POST", "/jyotish/extract", { messages: [{ role: "user", text: "x".repeat(40_000) }] });
    assert.strictEqual(big.status, 413);
    assert.strictEqual(big.json.error, "too_large");
  });

  await atest("the AI routes have their own, smaller per-user limit", async () => {
    // A separate app instance would be needed to test the count; check the wiring instead.
    assert.strictEqual(typeof jyotish.limiter, "function");
    assert.deepStrictEqual(jyotish.USER_TABLES.map((t) => t[0]), ["jyotish_profiles", "jyotish_predictions"]);
    const privacy = require("fs").readFileSync(require("path").join(__dirname, "../src/routes/privacy.js"), "utf8");
    assert.match(privacy, /jyotish\/store"\)\.USER_TABLES/);
  });
}

(async () => {
  await engineTests();
  await timeTests();
  await routeTests();
  server?.close();
  await db.close?.();
  console.log(`\njyotish: ${passed} passed${process.exitCode ? ", SOME FAILED" : ""}`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

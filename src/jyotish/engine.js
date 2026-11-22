/**
 * JYOTISH ENGINE — sidereal (Lahiri) Vedic chart maths, all local.
 *
 * Positions come from astronomy-engine (MIT, VSOP87/ELP based, ~1 arcsec
 * for the Sun and planets, a few arcsec for the Moon); scripts/jyotish-test.js
 * checks them against Swiss Ephemeris output for four charts within 0.1°.
 * Swiss Ephemeris itself is AGPL and needs a native build, so it is used
 * only to make the test fixtures, never shipped.
 *
 *   chart({ utc, lat, lng, timeKnown, at? })   → the whole natal chart
 *   positions(date)                            → sidereal planets at a moment
 *   transits(natal, date)                      → gochar from the natal Moon (and lagna)
 *   vimshottari(moonLon, birth)                → 120-year dasha timeline
 *   saturnStatus(moonSign, date)               → Sade Sati / Ashtama Shani
 *
 * Conventions: longitudes in degrees 0–360, signs 0 = Aries … 11 = Pisces,
 * houses 1–12 (whole sign), dates as JS Date (UTC).
 */
const A = require("astronomy-engine");

const SIGNS = ["Aries", "Taurus", "Gemini", "Cancer", "Leo", "Virgo", "Libra", "Scorpio",
  "Sagittarius", "Capricorn", "Aquarius", "Pisces"];
const SIGNS_HI = ["Mesha", "Vrishabha", "Mithuna", "Karka", "Simha", "Kanya", "Tula", "Vrishchika",
  "Dhanu", "Makara", "Kumbha", "Meena"];
const NAKSHATRAS = ["Ashwini", "Bharani", "Krittika", "Rohini", "Mrigashira", "Ardra", "Punarvasu",
  "Pushya", "Ashlesha", "Magha", "Purva Phalguni", "Uttara Phalguni", "Hasta", "Chitra", "Swati",
  "Vishakha", "Anuradha", "Jyeshtha", "Mula", "Purva Ashadha", "Uttara Ashadha", "Shravana",
  "Dhanishta", "Shatabhisha", "Purva Bhadrapada", "Uttara Bhadrapada", "Revati"];
const PLANETS = ["Sun", "Moon", "Mars", "Mercury", "Jupiter", "Venus", "Saturn", "Rahu", "Ketu"];
const SIGN_LORD = ["Mars", "Venus", "Mercury", "Moon", "Sun", "Mercury", "Venus", "Mars",
  "Jupiter", "Saturn", "Saturn", "Jupiter"];
const EXALTED = { Sun: 0, Moon: 1, Mars: 9, Mercury: 5, Jupiter: 3, Venus: 11, Saturn: 6 };
const DEBILITATED = { Sun: 6, Moon: 7, Mars: 3, Mercury: 11, Jupiter: 9, Venus: 5, Saturn: 0 };
const OWN = { Sun: [4], Moon: [3], Mars: [0, 7], Mercury: [2, 5], Jupiter: [8, 11], Venus: [1, 6], Saturn: [9, 10] };

const DASHA_ORDER = ["Ketu", "Venus", "Sun", "Moon", "Mars", "Rahu", "Jupiter", "Saturn", "Mercury"];
const DASHA_YEARS = { Ketu: 7, Venus: 20, Sun: 6, Moon: 10, Mars: 7, Rahu: 18, Jupiter: 16, Saturn: 19, Mercury: 17 };
const YEAR_MS = 365.25 * 86_400_000;
const NAK = 360 / 27;
const PADA = NAK / 4;

const norm = (x) => ((x % 360) + 360) % 360;
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;
const jdOf = (date) => date.getTime() / 86_400_000 + 2440587.5;
const round = (x, n = 4) => Math.round(x * 10 ** n) / 10 ** n;

/**
 * Lahiri ayanamsa (Swiss Ephemeris SIDM_LAHIRI): 23.245524743° at
 * JD 2435553.5, carried by the IAU 2006 general precession in longitude.
 * Measured from the MEAN equinox of date, as Swiss Ephemeris does.
 */
function ayanamsa(date) {
  const p = (jd) => {
    const T = (jd - 2451545.0) / 36525;
    return (5028.796195 * T + 1.1054348 * T * T + 0.00007964 * T ** 3) / 3600;
  };
  return 23.245524743 + p(jdOf(date)) - p(2435553.5);
}

/** Tropical longitude of a body against the mean equinox of date. */
function tropical(body, time, dpsiDeg) {
  if (body === "Moon") return norm(A.EclipticGeoMoon(time).lon - dpsiDeg);
  if (body === "Sun") return norm(A.SunPosition(time).elon - dpsiDeg);
  return norm(A.Ecliptic(A.GeoVector(body, time, true)).elon - dpsiDeg);
}

/** Mean lunar node (Meeus 47.7), mean equinox of date. */
function meanNode(date) {
  const T = (jdOf(date) - 2451545.0) / 36525;
  return norm(125.0445479 - 1934.1362891 * T + 0.0020754 * T * T + T ** 3 / 467441 - T ** 4 / 60616000);
}

function siderealAt(body, date) {
  const time = A.MakeTime(date);
  const ay = ayanamsa(date);
  if (body === "Rahu") return norm(meanNode(date) - ay);
  if (body === "Ketu") return norm(meanNode(date) + 180 - ay);
  const dpsi = A.e_tilt(time).dpsi / 3600;
  return norm(tropical(body, time, dpsi) - ay);
}

/** Where a longitude falls: sign, degree in sign, nakshatra and pada. */
function place(lon) {
  const l = norm(lon);
  const sign = Math.floor(l / 30);
  const nak = Math.floor(l / NAK);
  return {
    lon: round(l),
    sign,
    signName: SIGNS[sign],
    signNameHi: SIGNS_HI[sign],
    degree: round(l - sign * 30),
    nakshatra: NAKSHATRAS[nak],
    nakshatraIndex: nak,
    nakshatraLord: DASHA_ORDER[nak % 9],
    pada: Math.floor((l - nak * NAK) / PADA) + 1,
  };
}

/** All nine grahas at a moment, sidereal, with daily speed and retrograde flag. */
function positions(date) {
  const out = {};
  const before = new Date(date.getTime() - 43_200_000);
  const after = new Date(date.getTime() + 43_200_000);
  for (const p of PLANETS) {
    const lon = siderealAt(p, date);
    let speed = norm(siderealAt(p, after) - siderealAt(p, before) + 180) - 180;
    out[p] = {
      name: p,
      ...place(lon),
      speed: round(speed),
      // The nodes always move backwards; that is their nature, not a retrogression to read.
      retrograde: p === "Rahu" || p === "Ketu" ? true : speed < 0,
    };
  }
  return out;
}

/**
 * Sidereal ascendant for a place: the ecliptic degree rising in the east.
 * RAMC from the apparent sidereal time; true obliquity; the result moved to
 * the mean equinox and then to sidereal, as for the planets.
 */
function ascendant(date, lat, lng) {
  const time = A.MakeTime(date);
  const tilt = A.e_tilt(time);
  const ramc = rad(norm(A.SiderealTime(time) * 15 + lng));
  const eps = rad(tilt.tobl);
  const phi = rad(lat);
  let asc = deg(Math.atan2(Math.cos(ramc), -(Math.sin(ramc) * Math.cos(eps) + Math.tan(phi) * Math.sin(eps))));
  return norm(asc - tilt.dpsi / 3600 - ayanamsa(date));
}

/** House of a sign counted from a reference sign (whole sign): same sign = 1. */
const houseFrom = (sign, fromSign) => ((sign - fromSign + 12) % 12) + 1;

// ── Vimshottari ─────────────────────────────────────────────────────────

function vimshottari(moonLon, birth, { now = new Date() } = {}) {
  const l = norm(moonLon);
  const nak = Math.floor(l / NAK);
  const startIdx = nak % 9;
  const elapsed = (l - nak * NAK) / NAK;
  const firstLord = DASHA_ORDER[startIdx];
  // The first mahadasha began before birth by the part of it already run.
  let t = birth.getTime() - elapsed * DASHA_YEARS[firstLord] * YEAR_MS;
  const mahadashas = [];
  for (let i = 0; i < 9; i++) {
    const lord = DASHA_ORDER[(startIdx + i) % 9];
    const len = DASHA_YEARS[lord] * YEAR_MS;
    const start = t;
    const antardashas = [];
    let a = start;
    for (let j = 0; j < 9; j++) {
      const sub = DASHA_ORDER[(startIdx + i + j) % 9];
      const subLen = (len * DASHA_YEARS[sub]) / 120;
      antardashas.push({ lord: sub, start: new Date(a).toISOString(), end: new Date(a + subLen).toISOString() });
      a += subLen;
    }
    mahadashas.push({ lord, years: DASHA_YEARS[lord], start: new Date(start).toISOString(), end: new Date(start + len).toISOString(), antardashas });
    t += len;
  }
  const at = now.getTime();
  const md = mahadashas.find((m) => Date.parse(m.start) <= at && at < Date.parse(m.end)) || null;
  const ad = md ? md.antardashas.find((x) => Date.parse(x.start) <= at && at < Date.parse(x.end)) || null : null;
  return {
    balance: { lord: firstLord, years: round((1 - elapsed) * DASHA_YEARS[firstLord], 3) },
    mahadashas,
    current: md ? { mahadasha: md.lord, antardasha: ad?.lord || null, mdStart: md.start, mdEnd: md.end, adStart: ad?.start || null, adEnd: ad?.end || null } : null,
  };
}

// ── Saturn over the Moon ────────────────────────────────────────────────

const SATURN_PHASE = { 12: "rising", 1: "peak", 2: "setting" };

function saturnSignAt(date) {
  return Math.floor(siderealAt("Saturn", date) / 30);
}

/** The status of one sign-run of Saturn: which house from the Moon, and the run's dates. */
function saturnStatus(moonSign, date = new Date()) {
  const step = 5 * 86_400_000;
  const h = houseFrom(saturnSignAt(date), moonSign);
  const inSade = (d) => [12, 1, 2].includes(houseFrom(saturnSignAt(d), moonSign));
  const inEighth = (d) => houseFrom(saturnSignAt(d), moonSign) === 8;
  // Walk out to where the condition stops being true (Saturn retrogrades in and out; ±1 step accuracy).
  const span = (test) => {
    let s = date.getTime();
    while (test(new Date(s - step)) && date.getTime() - s < 12 * YEAR_MS) s -= step;
    let e = date.getTime();
    while (test(new Date(e + step)) && e - date.getTime() < 12 * YEAR_MS) e += step;
    return { start: new Date(s).toISOString().slice(0, 10), end: new Date(e + step).toISOString().slice(0, 10) };
  };
  const out = {
    saturnHouseFromMoon: h,
    sadeSati: { active: false, phase: null, start: null, end: null, next: null },
    ashtamaShani: { active: false, start: null, end: null },
  };
  if (inSade(date)) out.sadeSati = { active: true, phase: SATURN_PHASE[h], ...span(inSade), next: null };
  else {
    // The next one: Saturn into the 12th from the Moon, within 30 years.
    for (let t = date.getTime(); t < date.getTime() + 30 * YEAR_MS; t += 15 * 86_400_000) {
      if (inSade(new Date(t))) { out.sadeSati.next = new Date(t).toISOString().slice(0, 10); break; }
    }
  }
  if (inEighth(date)) out.ashtamaShani = { active: true, ...span(inEighth) };
  return out;
}

// ── Yogas and doshas ────────────────────────────────────────────────────

const KENDRA = [1, 4, 7, 10];
const TRIKONA = [1, 5, 9];

/**
 * The rules table. Each rule: id, name, needsLagna, test(ctx) → reason or null.
 * ctx: { p: positions, lagna: sign|null, h(planet) house from lagna, hm(planet) house from Moon }.
 */
const YOGA_RULES = [
  {
    id: "gajakesari", name: "Gajakesari Yoga", needsLagna: false,
    test: ({ hm }) => KENDRA.includes(hm("Jupiter"))
      ? `Jupiter is in house ${hm("Jupiter")} from the Moon (a kendra)` : null,
  },
  {
    id: "budhaditya", name: "Budhaditya Yoga", needsLagna: false,
    test: ({ p }) => p.Sun.sign === p.Mercury.sign ? `Sun and Mercury together in ${p.Sun.signName}` : null,
  },
  {
    id: "chandra_mangal", name: "Chandra-Mangal Yoga", needsLagna: false,
    test: ({ p }) => {
      if (p.Moon.sign === p.Mars.sign) return `Moon and Mars together in ${p.Moon.signName}`;
      if (houseFrom(p.Mars.sign, p.Moon.sign) === 7) return "Moon and Mars face each other (7th from each other)";
      return null;
    },
  },
  {
    id: "raj_yoga", name: "Raj Yoga (kendra–trikona lords)", needsLagna: true,
    test: ({ p, lagna }) => {
      const lordOf = (house) => SIGN_LORD[(lagna + house - 1) % 12];
      const pairs = [];
      for (const k of [4, 7, 10]) {
        for (const t of [5, 9]) {
          const a = lordOf(k), b = lordOf(t);
          if (a === b) { pairs.push(`${a} rules both house ${k} and house ${t}`); continue; }
          const sa = p[a].sign, sb = p[b].sign;
          if (sa === sb) pairs.push(`${a} (lord of ${k}) with ${b} (lord of ${t}) in ${p[a].signName}`);
          else if (houseFrom(sa, sb) === 7) pairs.push(`${a} (lord of ${k}) faces ${b} (lord of ${t})`);
        }
      }
      return pairs.length ? pairs.join("; ") : null;
    },
  },
  ...[["Mars", "Ruchaka"], ["Mercury", "Bhadra"], ["Jupiter", "Hamsa"], ["Venus", "Malavya"], ["Saturn", "Shasha"]].map(([pl, nm]) => ({
    id: nm.toLowerCase(), name: `${nm} Yoga (Pancha Mahapurusha)`, needsLagna: true,
    test: ({ p, h }) => {
      const strong = OWN[pl].includes(p[pl].sign) || EXALTED[pl] === p[pl].sign;
      return strong && KENDRA.includes(h(pl)) ? `${pl} is strong in ${p[pl].signName}, house ${h(pl)}` : null;
    },
  })),
];

function yogas(p, lagna) {
  const ctx = {
    p, lagna,
    h: (pl) => houseFrom(p[pl].sign, lagna),
    hm: (pl) => houseFrom(p[pl].sign, p.Moon.sign),
  };
  return YOGA_RULES.map((r) => {
    if (r.needsLagna && lagna == null) return { id: r.id, name: r.name, present: null, reason: "Birth time needed" };
    const reason = r.test(ctx);
    return { id: r.id, name: r.name, present: !!reason, reason: reason || null };
  });
}

const MANGLIK_HOUSES = [1, 2, 4, 7, 8, 12];

function manglik(p, lagna) {
  const fromMoon = houseFrom(p.Mars.sign, p.Moon.sign);
  const fromLagna = lagna == null ? null : houseFrom(p.Mars.sign, lagna);
  const byMoon = MANGLIK_HOUSES.includes(fromMoon);
  const byLagna = fromLagna == null ? null : MANGLIK_HOUSES.includes(fromLagna);
  const mitigations = [];
  if (OWN.Mars.includes(p.Mars.sign)) mitigations.push(`Mars is in its own sign (${p.Mars.signName})`);
  if (EXALTED.Mars === p.Mars.sign) mitigations.push("Mars is exalted in Capricorn");
  if (p.Jupiter.sign === p.Mars.sign) mitigations.push("Jupiter is with Mars");
  const present = byLagna == null ? byMoon : byLagna || byMoon;
  return {
    present,
    fromLagna: byLagna == null ? "Birth time needed" : { house: fromLagna, manglik: byLagna },
    fromMoon: { house: fromMoon, manglik: byMoon },
    mitigated: present && mitigations.length > 0,
    mitigations,
    partial: lagna == null,
  };
}

// ── The chart ───────────────────────────────────────────────────────────

/**
 * The natal chart. `utc` is the birth instant; with timeKnown false it is
 * local noon and only Moon-based results are given (the Moon moves ~6.5°
 * either side, so the nakshatra is flagged when it could differ).
 */
function chart({ utc, lat, lng, timeKnown = true, at = new Date() }) {
  if (!(utc instanceof Date) || Number.isNaN(utc.getTime())) throw new Error("bad birth instant");
  const p = positions(utc);
  let lagna = null;
  let houses = null;
  if (timeKnown) {
    const asc = place(ascendant(utc, lat, lng));
    lagna = asc;
    houses = Array.from({ length: 12 }, (_, i) => {
      const sign = (asc.sign + i) % 12;
      return { house: i + 1, sign, signName: SIGNS[sign], lord: SIGN_LORD[sign], planets: PLANETS.filter((pl) => p[pl].sign === sign) };
    });
    for (const pl of PLANETS) p[pl].house = houseFrom(p[pl].sign, asc.sign);
  }
  let moonUncertain = false;
  if (!timeKnown) {
    const early = place(siderealAt("Moon", new Date(utc.getTime() - 12 * 3_600_000)));
    const late = place(siderealAt("Moon", new Date(utc.getTime() + 12 * 3_600_000)));
    moonUncertain = early.nakshatra !== late.nakshatra || early.sign !== late.sign;
  }
  return {
    timeKnown,
    ayanamsa: round(ayanamsa(utc)),
    planets: PLANETS.map((pl) => p[pl]),
    lagna,
    houses,
    rashi: { sign: p.Moon.sign, signName: SIGNS[p.Moon.sign], signNameHi: SIGNS_HI[p.Moon.sign] },
    nakshatra: { name: p.Moon.nakshatra, pada: p.Moon.pada, lord: p.Moon.nakshatraLord },
    moonUncertain,
    dasha: vimshottari(p.Moon.lon, utc, { now: at }),
    yogas: yogas(p, lagna ? lagna.sign : null),
    manglik: manglik(p, lagna ? lagna.sign : null),
    saturn: saturnStatus(p.Moon.sign, at),
    needsBirthTime: timeKnown ? [] : ["lagna", "houses", "raj_yoga", "pancha_mahapurusha", "manglik_from_lagna"],
  };
}

/** Gochar: where the grahas are on `date`, by house from the natal Moon (and lagna when known). */
function transits(natal, date) {
  const now = positions(date);
  const moonSign = natal.rashi.sign;
  const lagnaSign = natal.lagna ? natal.lagna.sign : null;
  return {
    date: date.toISOString(),
    planets: PLANETS.map((pl) => ({
      ...now[pl],
      houseFromMoon: houseFrom(now[pl].sign, moonSign),
      houseFromLagna: lagnaSign == null ? null : houseFrom(now[pl].sign, lagnaSign),
    })),
    saturn: saturnStatus(moonSign, date),
  };
}

module.exports = {
  chart, transits, positions, ascendant, ayanamsa, vimshottari, saturnStatus, yogas, manglik,
  place, houseFrom, siderealAt,
  SIGNS, SIGNS_HI, NAKSHATRAS, PLANETS, SIGN_LORD, DASHA_ORDER, DASHA_YEARS, YOGA_RULES,
};

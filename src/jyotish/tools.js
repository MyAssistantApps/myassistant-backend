/**
 * JYOTISH BY VOICE — the assistant takes birth details from what the user
 * says, casts the chart, saves it, and explains it; and gives readings.
 *
 *   jyotish_chart     "I was born 14 March 2004 at 6:30 in the morning in Udupi — what's my kundli?"
 *                     "what's my rashi / nakshatra / which dasha am I in / do I have Sade Sati?"
 *   jyotish_reading   "how is my career this month?", "what does this year look like for my health?"
 *
 * The same engine, cache and saved profiles as the Jyotish screen (routes.js):
 * a chart cast by voice is there in the app, and the other way round.
 */
const engine = require("./engine");
const geo = require("./geo");
const jai = require("./ai");
const store = require("./store");
const { cleanBirth, DISCLAIMER } = require("./routes");

const userOf = (ctx) => {
  const id = Number(ctx && ctx.userId);
  return Number.isInteger(id) && id > 0 ? id : null;
};

/** A saved person by name (any case, or a first-name match), else the most recent; null when none. */
async function savedProfile(userId, name) {
  const list = await store.listProfiles(userId);
  if (!list.length) return null;
  const n = String(name || "").trim().toLowerCase();
  if (!n || ["me", "my", "mine", "myself", "i"].includes(n)) return list[0];
  return list.find((p) => p.name.toLowerCase() === n)
    || list.find((p) => p.name.toLowerCase().split(/\s+/)[0] === n.split(/\s+/)[0])
    || null;
}

/** The chart as a few plain facts for the model to explain (it is told to use only these). */
function summary(birth, c, at = new Date()) {
  const cur = jai.currentDasha(c, at);
  const s = c.saturn;
  const p = (n) => c.planets.find((x) => x.name === n);
  return {
    person: birth.name || null,
    born: `${birth.date}${birth.time ? ` ${birth.time}` : " (time unknown)"}${birth.place ? `, ${birth.place}` : ""}`,
    birthTimeKnown: c.timeKnown,
    lagna: c.lagna ? `${c.lagna.signName} (${c.lagna.degree.toFixed(1)}°)` : "needs the birth time",
    moonSign: `${c.rashi.signName} (${c.rashi.signNameHi})`,
    nakshatra: `${c.nakshatra.name}, pada ${c.nakshatra.pada}${c.moonUncertain ? " (could differ with the exact birth time)" : ""}`,
    sunSign: p("Sun").signName,
    planets: c.planets.map((x) => `${x.name} in ${x.signName}${x.house ? ` (house ${x.house})` : ""}${x.retrograde && !["Rahu", "Ketu"].includes(x.name) ? ", retrograde" : ""}`),
    dashaNow: cur ? `${cur.mahadasha} mahadasha until ${cur.mdEnd.slice(0, 10)}, ${cur.antardasha} antardasha until ${String(cur.adEnd).slice(0, 10)}` : null,
    sadeSati: s.sadeSati.active ? `running, ${s.sadeSati.phase} phase, about ${s.sadeSati.start} to ${s.sadeSati.end}` : `not running${s.sadeSati.next ? `; next from about ${s.sadeSati.next}` : ""}`,
    ashtamaShani: s.ashtamaShani.active ? `running, about ${s.ashtamaShani.start} to ${s.ashtamaShani.end}` : "not running",
    yogas: c.yogas.filter((y) => y.present).map((y) => `${y.name}: ${y.reason}`),
    manglik: c.manglik.present ? `yes${c.manglik.mitigated ? `, mitigated (${c.manglik.mitigations.join("; ")})` : ""}${c.manglik.partial ? ", checked from the Moon only" : ""}` : "no",
  };
}

const EXPLAIN =
  "Explain it warmly in plain words, as a knowledgeable friend, in 4–6 short spoken sentences: " +
  "the lagna (or that it needs the birth time), Moon sign and nakshatra and what they say about their nature, " +
  "the dasha running now and what it is good for, Sade Sati if relevant, and one yoga if any. " +
  "Use ONLY these facts; never invent positions or dates. No fear, no guarantees. " +
  "End by offering a reading (career, love, money, health, education — today, this week, month or year) " +
  `or to open the full chart in the app. Mention once, briefly: "${DISCLAIMER}"`;

function registerJyotishTools(registry) {
  registry.register({
    name: "jyotish_chart",
    risk: "medium",
    effects: ["write:record"],
    description:
      "The user's (or someone's) VEDIC BIRTH CHART — kundli / janma kundali: lagna, rashi (Moon sign), " +
      "nakshatra, planets, the running dasha, Sade Sati, yogas, Manglik — cast from their birth details " +
      "and explained. Use it whenever they tell you when and where they were born, or ask 'what is my " +
      "rashi / nakshatra / lagna', 'which dasha am I in', 'do I have Sade Sati', 'am I manglik', " +
      "'make my kundli'. Pass the details exactly as they said them; leave out what they did not say " +
      "(it asks for what is missing). With no details it uses their saved chart. Not for the generic " +
      "daily sun-sign horoscope (get_horoscope).",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Whose chart: their name as said, or 'me'. Used to save it and to find a saved one." },
        date: { type: "string", description: "Birth date as YYYY-MM-DD." },
        time: { type: "string", description: "Birth time as HH:MM, 24-hour ('6:30 in the morning' = 06:30). Leave out if vague ('morning') or not said." },
        time_unknown: { type: "boolean", description: "True only when they said they do not know the birth time." },
        place: { type: "string", description: "Birth place as they said it: town, plus district/state/country if given." },
        gender: { type: "string", enum: ["male", "female", "other"] },
      },
    },
    async execute(args, ctx) {
      const userId = userOf(ctx);
      if (!userId) return { ok: false, error: "not signed in" };
      const said = ["date", "time", "place"].some((k) => args[k]) || args.time_unknown === true;
      if (!said) {
        const saved = await savedProfile(userId, args.name);
        if (!saved) {
          return {
            ok: false,
            needsArgs: ["date", "place", "time"],
            note: "No chart is saved yet. Ask for their date of birth, birth place and birth time (one question at a time; they may not know the time).",
          };
        }
        const c = engine.chart({ utc: new Date(saved.birth.utc), lat: saved.birth.lat, lng: saved.birth.lng, timeKnown: !!saved.birth.time });
        return { ok: true, data: { saved: true, ...summary(saved.birth, c) }, note: EXPLAIN };
      }
      const missing = [];
      const date = jai.cleanDate(args.date);
      if (!date) missing.push("date");
      if (!args.place || String(args.place).trim().length < 2) missing.push("place");
      const time = args.time_unknown === true ? null : jai.cleanTime(args.time);
      if (!time && args.time_unknown !== true) missing.push("time");
      if (missing.length) {
        return {
          ok: false,
          needsArgs: missing,
          note: `Still needed: ${missing.join(", ")}. Ask ONE short question for the first of them` +
            (missing[0] === "time" ? " — the clock time, and say it is fine if they don't know it." : ".") +
            (args.date && !date ? " The date they gave is not a real date; ask again." : ""),
        };
      }
      let places;
      try {
        places = await geo.searchPlaces(String(args.place));
      } catch {
        return { ok: false, error: "the place lookup is not answering — ask them to try again in a moment" };
      }
      if (!places.length) {
        return { ok: false, needsArgs: ["place"], note: `No place called "${String(args.place).slice(0, 60)}" was found. Ask for the district or state too.` };
      }
      const where = places[0];
      const birth = cleanBirth({
        name: args.name && !["me", "my", "myself"].includes(String(args.name).toLowerCase()) ? args.name : (ctx.userName || "Me"),
        date, time, place: where.name, lat: where.lat, lng: where.lng, tz: where.tz,
        gender: args.gender,
      });
      if (typeof birth === "string") return { ok: false, error: birth };
      const c = engine.chart({ utc: new Date(birth.utc), lat: birth.lat, lng: birth.lng, timeKnown: !!birth.time });
      const saved = await store.saveProfile(userId, birth.name, birth).catch(() => null);
      const others = places.slice(1, 3).map((p) => p.name);
      return {
        ok: true,
        data: { saved: !!saved, placeUsed: where.name, otherPlaces: others, ...summary(birth, c) },
        note: EXPLAIN + (others.length
          ? ` First say in a few words which place you used (${where.name.split(",").slice(0, 2).join(",")}) so they can correct it.`
          : "") + (saved ? " It is saved in the Jyotish screen." : ""),
      };
    },
  });

  registry.register({
    name: "jyotish_reading",
    risk: "low",
    effects: ["read"],
    description:
      "A personal VEDIC READING (prediction) from the user's saved birth chart: 'how is my career this " +
      "month', 'what does this year hold for my health', 'how is today for me', 'my love life this week', " +
      "'how will 15 January go'. Written from their chart, dasha and transits only. Needs a saved chart: " +
      "if there is none, use jyotish_chart first with their birth details.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Whose saved chart (default: theirs, the most recent)." },
        range: { type: "string", enum: jai.RANGES, description: "today | week | month | year | custom (with date)." },
        date: { type: "string", description: "YYYY-MM-DD, only with range=custom." },
        category: { type: "string", enum: jai.CATEGORIES, description: "What about; overall when not said." },
        language: { type: "string", enum: Object.keys(jai.LANGUAGES), description: "en, hi or kn — the language they are speaking." },
      },
      required: ["range"],
    },
    async execute(args, ctx) {
      const userId = userOf(ctx);
      if (!userId) return { ok: false, error: "not signed in" };
      const saved = await savedProfile(userId, args.name);
      if (!saved) {
        return {
          ok: false,
          needsArgs: ["date", "place", "time"],
          note: args.name
            ? `There is no saved chart for ${String(args.name).slice(0, 40)}. Ask for their birth date, place and time, then use jyotish_chart.`
            : "No chart is saved yet. Ask for their birth date, place and time, then use jyotish_chart.",
        };
      }
      const range = jai.RANGES.includes(args.range) ? args.range : "today";
      const category = jai.CATEGORIES.includes(args.category) ? args.category : "overall";
      const language = jai.LANGUAGES[args.language] ? args.language : "en";
      let custom = null;
      if (range === "custom") {
        custom = jai.cleanDate(args.date, new Date("2100-12-31T00:00:00Z"));
        if (!custom) return { ok: false, needsArgs: ["date"], note: "Ask which date they want the reading for." };
      }
      const period = jai.periodOf(range, new Date(), custom);
      const key = jai.readingKey(userId, saved.birth, range, category, language, period);
      const natal = engine.chart({ utc: new Date(saved.birth.utc), lat: saved.birth.lat, lng: saved.birth.lng, timeKnown: !!saved.birth.time });
      let text = await store.cachedPrediction(key);
      let fallback = false;
      if (!text) {
        ({ text, fallback } = await jai.wholeReading(natal, period, category, { language, name: saved.birth.name }));
        if (!fallback) await store.savePrediction(key, userId, text).catch(() => {});
      }
      return {
        ok: true,
        data: {
          person: saved.name,
          period: { start: period.start.toISOString().slice(0, 10), end: period.end.toISOString().slice(0, 10) },
          category, reading: text, fallback,
        },
        note: "Say the reading naturally for the ear: keep its planetary reasons and its advice, drop bullet marks, " +
          "and keep it under about 45 seconds unless they asked for detail. " +
          (fallback ? "The full reading was unavailable, so this is the short outline; say so in a few words. " : "") +
          `End with one short line: "${DISCLAIMER}" Offer to open it in the Jyotish screen to read or hear again.`,
      };
    },
  });
}

module.exports = { registerJyotishTools, savedProfile, summary };

/**
 * Today's horoscope for all twelve signs (src/jyotish/daily.js): the day
 * turns at 4 AM India time; the model's answer is used only when every
 * sign is there, colours come from the list (with their dot), numbers are
 * sane; the fallback is the same for the same day. No network or database.
 */
const assert = require("assert");
const daily = require("../src/jyotish/daily");
const { parseSet, fallbackSet, prompt } = daily._test;

// 4 AM IST = 22:30 UTC the day before.
assert.strictEqual(daily.horoscopeDay(Date.parse("2026-11-23T22:29:00Z")), "2026-11-23", "3:59 AM IST is still yesterday");
assert.strictEqual(daily.horoscopeDay(Date.parse("2026-11-23T22:31:00Z")), "2026-11-24", "4:01 AM IST is today");
assert.strictEqual(daily.horoscopeDay(Date.parse("2026-11-24T18:00:00Z")), "2026-11-24", "11:30 PM IST is today");

assert.strictEqual(daily.SIGNS.length, 12);
const p = prompt("2026-11-24");
for (const s of daily.SIGNS) assert.ok(p.includes(s.id), s.id);

const full = { signs: daily.SIGNS.map((s, i) => ({ sign: s.name.toUpperCase(), reading: `A good day for ${s.name} to plan ahead.`, colour: i === 0 ? "royal blue" : "Not A Colour", number: i === 1 ? 42 : i === 2 ? 0 : 5 })) };
const set = parseSet("Here:\n" + JSON.stringify(full), "2026-11-24");
assert.ok(set && set.length === 12);
assert.strictEqual(set[0].sign, "aries");
assert.strictEqual(set[0].colour, "Royal Blue");
assert.strictEqual(set[0].colourHex, daily.COLOURS["Royal Blue"]);
assert.ok(daily.COLOURS[set[1].colour], "an unknown colour is replaced by a listed one");
assert.strictEqual(set[1].number, 42);
assert.ok(set[2].number >= 1 && set[2].number <= 9, "0 is not a lucky number");
assert.ok(set.every((e) => e.source === "model"));

const missing = { signs: full.signs.slice(1) };
assert.strictEqual(parseSet(JSON.stringify(missing), "2026-11-24"), null, "a missing sign → fallback");
assert.strictEqual(parseSet("not json", "2026-11-24"), null);
const short = { signs: full.signs.map((e, i) => (i === 3 ? { ...e, reading: "ok" } : e)) };
assert.strictEqual(parseSet(JSON.stringify(short), "2026-11-24"), null, "an empty reading → fallback");

const a = fallbackSet("2026-11-24"), b = fallbackSet("2026-11-24"), c = fallbackSet("2026-11-25");
assert.deepStrictEqual(a, b, "same day, same fallback");
assert.notDeepStrictEqual(a, c);
assert.ok(a.every((e) => e.reading && daily.COLOURS[e.colour] === e.colourHex && e.number >= 1 && e.number <= 9));

console.log("jyotish daily: all passed");

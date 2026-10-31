/**
 * THE DESIGNER — `npm run test:design`.
 *
 *   (a) the design document (v2): the default is today's app; colours,
 *       contrast (only for pairs it set), gradients that show, ranges,
 *       fonts, sections, custom cards; v1 looks convert
 *   (b) the store: per person, undo, reset (undoable), saved looks
 *   (c) ask_designer: undo, reset, darker/lighter with no model; a change
 *       merged from the Designer's JSON; an unreadable answer sent back
 *       once, then refused; "none"; save/use a look; a failed model says
 *       so and does not loop
 *   (d) Home layout from a strict first/last/hide/show answer, applied
 *       exactly, and summed up by what really changed
 *   (e) /ui routes: the look back after a reinstall, undo, reset
 *   (f) custom card data: short lines, read-only tools only
 *
 * Needs Postgres (DATABASE_URL); the models are stubs.
 */
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://myassistant:localdev@localhost:5432/myassistant_test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "design-test-0123456789012345678901234567890";
process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.OPENAI_API_KEY = "sk-test-stub";

const assert = require("assert");
const express = require("express");
const db = require("../src/db");
require("../src/agents/runtime");
const registry = require("../src/tools/registry");
const S = require("../src/design/spec");
const store = require("../src/design/store");
const cards = require("../src/design/cards");
const router = require("../src/services/ai/router");
const tools = require("../src/design/tools");

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { process.exitCode = 1; console.error(`FAIL  ${name}\n      ${e.stack.split("\n").slice(0, 3).join("\n      ")}`); }
}

const OCEAN = {
  page: "#061B2D", card: "#0B2A40", cardRaised: "#0F3453", pageText: "#EAF6FF", pageMuted: "#A8C6DA",
  pageFaint: "#7FA3BB", cardText: "#EAF6FF", cardMuted: "#A8C6DA", primary: "#1E88E5", partner: "#00B3FF",
  secondary: "#4FC3F7", tertiary: "#7C4DFF",
};

// The models, stubbed: the Designer's answers and the layout answers are
// separate queues (the layout call is the one with a strict schema).
const designer = [];
const layouts = [];
let calls = 0;
router.generateReply = async (_m, opts = {}) => {
  calls++;
  const q = opts.schema ? layouts : designer;
  const next = q.shift();
  if (next instanceof Error) throw next;
  return { reply: JSON.stringify(next || {}) };
};

(async () => {
  await db.init();
  await store.migrate();
  const U = 900000 + Math.floor(Math.random() * 90000);
  const U2 = U + 1;
  const ask = (request, uid = U) => registry.execute("ask_designer", { request },
    { userId: uid, source: "test", userText: request, turnId: `t-${Math.random()}` });

  console.log("(a) the design document");
  await test("the default is today's app; the schema file is the Designer's guide", () => {
    const v = S.validate(S.defaults());
    assert.ok(v.ok);
    assert.deepStrictEqual(v.spec.colors, {});
    assert.strictEqual(v.spec.header.title, "MyAssistant");
    assert.deepStrictEqual(v.spec.home.sections.map((s) => s.id), S.SECTION_IDS);
    assert.ok(S.SCHEMA.colors.cardText && /cardText/.test(S.SCHEMA_TEXT));
  });
  await test("one colour alone is enough, and checked against what it sits on", () => {
    assert.ok(S.validate({ colors: { cardText: "#FF5A5F" } }).ok, "red on the dark card is readable");
    const bad = S.validate({ colors: { cardText: "#0C1440" } });
    assert.ok(!bad.ok && /cardText #0C1440 on card/.test(bad.errors[0]), bad.errors.join(";"));
  });
  await test("a light page with light text is refused; alone, its text turns dark by itself", () => {
    assert.ok(S.validate({ colors: { page: "#FFFFFF" } }).ok, "the app's light text set follows a light page");
    const v = S.validate({ colors: { page: "#FFFFFF", pageText: "#F3F6FF" } });
    assert.ok(!v.ok && v.errors.some((e) => /pageText/.test(e)), v.errors.join(";"));
    assert.ok(S.validate({ colors: { page: "#FFFFFF", pageText: "#111111", pageMuted: "#555555" } }).ok);
    assert.strictEqual(S.validate({ colors: { page: "#FFFFFF", pageText: "#111111", pageMuted: "#555555" } }).spec.dark, false);
  });
  await test("a gradient must be visible", () => {
    assert.ok(!S.validate({ background: { style: "gradient", from: "#06314F", to: "#003B66" } }).ok);
    assert.ok(S.validate({ background: { style: "gradient", from: "#0B3D91", to: "#00B3D6" } }).ok);
  });
  await test("ranges, fonts and sections", () => {
    const v = S.validate({ cards: { radius: 99 }, typography: { scale: 3, font: "manrope" }, home: { sections: [{ id: "born", visible: false }, { id: "nope" }] } });
    assert.ok(v.ok, v.errors.join(";"));
    assert.deepStrictEqual([v.spec.cards.radius, v.spec.typography.scale, v.spec.typography.font], [32, 1.3, "Manrope"]);
    assert.strictEqual(v.spec.home.sections[0].id, "born");
    assert.ok(!S.validate({ typography: { font: "Comic Sans" } }).ok);
  });
  await test("custom cards: only known blocks and sources", () => {
    assert.ok(S.validate({ customCards: [{ title: "Water", blocks: [{ type: "stat", source: "habits" }] }] }).ok);
    assert.ok(!S.validate({ customCards: [{ title: "X", blocks: [{ type: "script" }] }] }).ok);
    assert.ok(!S.validate({ customCards: [{ title: "X", blocks: [{ type: "list", source: "https://evil" }] }] }).ok);
  });
  await test("a v1 look converts", () => {
    const v = S.validate({ palette: { bg: "#061B2D", surface: "#0B2A40", textHi: "#EAF6FF", textLo: "#A8C6DA", primary: "#1E88E5" },
      shape: { radius: 12, cardStyle: "solid" }, type: { font: "Roboto" }, background: "plain" });
    assert.ok(v.ok, v.errors.join(";"));
    assert.deepStrictEqual([v.spec.colors.page, v.spec.colors.card, v.spec.cards.style, v.spec.typography.font, v.spec.background.style],
      ["#061B2D", "#0B2A40", "solid", "Roboto", "plain"]);
  });

  console.log("(b) the store");
  await test("per person; undo walks back; reset is undoable", async () => {
    await store.save(U, { ...S.defaults(), cards: { radius: 8 } });
    await store.save(U, { ...S.defaults(), cards: { radius: 20 } });
    assert.strictEqual((await store.get(U2)).cards.radius, null, "another person is untouched");
    assert.strictEqual((await store.undo(U)).cards.radius, 8);
    await store.reset(U);
    assert.strictEqual((await store.undo(U)).cards.radius, 8);
  });

  console.log("(c) ask_designer");
  await test("one tool, acting on the phone", () => {
    assert.ok(registry.get("ask_designer") && registry.get("ask_designer").deviceAction);
    assert.ok(!registry.get("design_app"), "the thirteen tools are gone");
  });
  await test("a change merged from the Designer's JSON", async () => {
    await store.reset(U);
    designer.push({ action: "change", changes: { colors: { cardText: "#FF5A5F" } }, summary: "Card text is red now." });
    const r = await ask("make the card text red");
    assert.ok(r.ok, r.error);
    assert.strictEqual(r.deviceAction.type, "apply_ui_spec");
    assert.strictEqual(r.deviceAction.spec.colors.cardText, "#FF5A5F");
    assert.strictEqual(r.result, "Card text is red now.");
  });
  await test("a whole look; then darker with no model", async () => {
    designer.push({ action: "change", name: "Ocean", changes: { colors: OCEAN, background: { style: "gradient", from: "#0B3D91", to: "#00B3D6" } }, summary: "Ocean." });
    const r = await ask("ocean blue gradient theme");
    assert.ok(r.ok, r.error);
    assert.strictEqual(r.deviceAction.spec.name, "Ocean");
    const n = calls;
    const d = await ask("make it darker");
    assert.ok(d.ok, d.error);
    assert.strictEqual(calls, n, "no model call");
    assert.ok(S.contrast(d.deviceAction.spec.colors.page, "#FFFFFF") > S.contrast(OCEAN.page, "#FFFFFF"));
  });
  await test("an unreadable answer is sent back once, then refused with nothing changed", async () => {
    const before = await store.get(U);
    designer.push({ action: "change", changes: { colors: { cardText: "#0B2A40" } } },
      { action: "change", changes: { colors: { cardText: "#FF5A5F" } }, summary: "Red." });
    assert.ok((await ask("card text navy")).ok, "fixed on the second answer");
    designer.push({ action: "change", changes: { colors: { cardText: "#0B2A40" } } }, { action: "change", changes: { colors: { cardText: "#0B2A40" } } });
    const r = await ask("card text navy again");
    assert.ok(!r.ok && /not readable/.test(r.error), r.error);
    assert.strictEqual((await store.get(U)).colors.cardText, "#FF5A5F");
    assert.ok(before);
  });
  await test("undo and reset need no model", async () => {
    const n = calls;
    assert.ok((await ask("undo")).ok);
    const r = await ask("reset the design");
    assert.ok(r.ok);
    assert.deepStrictEqual(r.deviceAction.spec.colors, {});
    assert.strictEqual(calls, n);
  });
  await test("save and use a named look", async () => {
    designer.push({ action: "change", changes: { colors: { primary: "#F59E0B" } }, summary: "Amber." });
    await ask("amber buttons");
    designer.push({ action: "save", name: "Amber" });
    assert.ok((await ask("save this as Amber")).ok);
    await ask("reset the design");
    designer.push({ action: "use_saved", name: "amber" });
    const r = await ask("use my Amber look");
    assert.ok(r.ok, r.error);
    assert.strictEqual(r.deviceAction.spec.colors.primary, "#F59E0B");
  });
  await test("not about the look: said so, nothing changed", async () => {
    designer.push({ action: "none", summary: "that is a phone setting" });
    const r = await ask("make the phone louder");
    assert.ok(!r.ok && /isn't something the app's design can do/.test(r.error));
  });
  await test("a model that fails: nothing changes, and no retry loop", async () => {
    designer.push(new Error("fetch failed"));
    const r = await ask("something lovely");
    assert.ok(!r.ok && /do not call ask_designer again/.test(r.error), r.error);
  });

  console.log("(d) Home layout");
  await test("first/hide applied exactly, summed up by what changed", async () => {
    await ask("reset the design");
    layouts.push({ first: ["today", "play", "agents"], last: [], hide: ["born"], show: ["play"] });
    const r = await ask("hide born today and put my reminders first");
    assert.ok(r.ok, r.error);
    const sec = r.deviceAction.spec.home.sections;
    assert.deepStrictEqual(sec.slice(0, 3).map((x) => x.id), ["today", "play", "agents"]);
    assert.strictEqual(sec.find((x) => x.id === "born").visible, false);
    assert.strictEqual(r.result, "Put Today's cards at the top, hid Born today.");
  });
  await test("the arrange helper: unknown ids ignored, last goes to the end", () => {
    const out = tools.arrange(S.defaults().home.sections, { first: ["nope"], last: ["play"], hide: ["x"] });
    assert.strictEqual(out[out.length - 1].id, "play");
    assert.strictEqual(out.length, S.SECTION_IDS.length);
  });
  await test("layout and colour in one request: both, one summary", async () => {
    layouts.push({ first: [], last: [], hide: ["extras"], show: [] });
    designer.push({ action: "change", changes: { colors: { cardText: "#FF5A5F" } }, summary: "Set card text to red." });
    const r = await ask("hide the tips and make the card text red");
    assert.ok(r.ok, r.error);
    assert.strictEqual(r.deviceAction.spec.home.sections.find((x) => x.id === "extras").visible, false);
    assert.strictEqual(r.deviceAction.spec.colors.cardText, "#FF5A5F");
    assert.strictEqual(r.result, "Hid Tips and extra cards; set card text to red.");
  });

  console.log("(e) /ui");
  const app = express();
  app.use(express.json());
  app.use("/ui", (req, _res, next) => { req.user = { sub: String(req.get("x-test-user") || "") }; next(); }, require("../src/design/routes"));
  const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}/ui`;
  const call = (method, p, uid = U) => fetch(base + p, { method, headers: { "x-test-user": String(uid) } })
    .then(async (r) => ({ status: r.status, body: await r.json() }));
  await test("a reinstalled app gets the same look back; undo and reset over HTTP", async () => {
    const r = await call("GET", "/spec");
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.spec.colors.cardText, "#FF5A5F");
    assert.ok(Array.isArray(r.body.cards));
    assert.deepStrictEqual((await call("POST", "/reset")).body.spec.colors, {});
    assert.strictEqual((await call("POST", "/undo")).body.spec.colors.cardText, "#FF5A5F");
    assert.strictEqual((await call("GET", "/spec", "")).status, 401);
  });
  server.close();

  console.log("(f) custom card data");
  await test("a tool's answer becomes short lines; sources are read tools only", () => {
    assert.deepStrictEqual(cards.linesOf({ ok: true, result: "Milk\nEggs" }), ["Milk", "Eggs"]);
    assert.deepStrictEqual(cards.linesOf({ ok: true, items: [{ title: "Call bank" }, "Pay rent"] }), ["Call bank", "Pay rent"]);
    for (const [, [tool]] of Object.entries(cards.SOURCE_TOOL)) {
      assert.ok(registry.isParallelSafe(tool) || tool === "daily_brief", `${tool} must be a read`);
    }
  });

  for (const t of ["ui_specs", "ui_spec_history", "ui_themes"]) await db.run(`DELETE FROM ${t} WHERE user_id = ANY($1)`, [[U, U2]]);
  console.log(`\n${passed} passed${process.exitCode ? " — FAILURES above" : ""}`);
  await db.close().catch(() => {});
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); process.exit(1); });

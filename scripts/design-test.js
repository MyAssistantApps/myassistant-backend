/**
 * THE DESIGN AGENT — `npm run test:design`.
 *
 *   (a) the spec: defaults are today's app; colours, contrast, ranges,
 *       fonts, sections and custom cards are checked; bad input is refused
 *       with words the agent can act on
 *   (b) the store: saved on the server, undo walks back, reset is
 *       undoable, named looks, per person
 *   (c) the tools, through the registry: design_app (one colour on top of
 *       the app's palette), arrange_home, add/remove_home_card, undo,
 *       reset, save/apply/list themes, preview + pick (model stubbed)
 *   (d) generate_theme retries when its first palette is unreadable
 *   (e) /ui routes: the spec back after a "reinstall", undo, reset
 *   (f) custom card data: a tool's answer becomes short lines
 *
 * Needs Postgres (DATABASE_URL); the model is a stub.
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

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { process.exitCode = 1; console.error(`FAIL  ${name}\n      ${e.stack.split("\n").slice(0, 3).join("\n      ")}`); }
}

const GOOD = {
  name: "Sunset", bg: "#1A0E14", surface: "#2A1620", surfaceHigh: "#3A1E2C", primary: "#FF7A45",
  partner: "#FF3D7F", secondary: "#FFC15E", tertiary: "#9BE15D", textHi: "#FFF4EC", textLo: "#E8C7B8", textDim: "#B8958A",
};
const UNREADABLE = { ...GOOD, textHi: "#2A1620", textLo: "#2A1620" };

// The model, stubbed: a queue of JSON answers.
const answers = [];
router.generateReply = async () => ({ reply: JSON.stringify(answers.shift()) });
const look = (palette, extra = {}) => ({ palette, cardStyle: "glass", radius: 24, font: "Manrope", background: "gradient", ...extra });

(async () => {
  await db.init();
  await store.migrate();
  const U = 900000 + Math.floor(Math.random() * 90000);
  const U2 = U + 1;
  const run = (name, args = {}, uid = U) => registry.execute(name, args, { userId: uid, source: "test", userText: "test", turnId: `t-${Math.random()}` });

  console.log("(a) the spec");
  await test("a fresh spec is today's app", () => {
    const v = S.validate(S.defaults());
    assert.ok(v.ok);
    assert.strictEqual(v.spec.palette, null);
    assert.strictEqual(v.spec.header.title, "MyAssistant");
    assert.deepStrictEqual(v.spec.home.sections.map((s) => s.id), S.SECTION_IDS);
  });
  await test("a readable palette passes; dark follows the page", () => {
    const v = S.validate({ palette: { ...GOOD, dark: false } });
    assert.ok(v.ok, v.errors.join(";"));
    assert.strictEqual(v.spec.palette.dark, true);
  });
  await test("unreadable words are refused, saying which and by how much", () => {
    const v = S.validate({ palette: UNREADABLE });
    assert.ok(!v.ok);
    assert.ok(v.errors.some((e) => /textHi on bg is 1\.\d:1/.test(e)), v.errors.join(";"));
  });
  await test("colours must be colours; fonts only what the app carries", () => {
    assert.ok(!S.validate({ palette: { ...GOOD, bg: "orange" } }).ok);
    assert.ok(!S.validate({ type: { font: "Comic Sans" } }).ok);
    assert.ok(S.validate({ type: { font: "manrope" } }).ok, "case does not matter");
  });
  await test("numbers are clamped, titles cut", () => {
    const v = S.validate({ shape: { radius: 99 }, type: { scale: 3 }, header: { title: "x".repeat(60) } });
    assert.deepStrictEqual([v.spec.shape.radius, v.spec.type.scale, v.spec.header.title.length], [32, 1.3, 24]);
  });
  await test("sections: each once, unknown dropped, missing appended visible", () => {
    const v = S.validate({ home: { sections: [{ id: "born", visible: false }, { id: "nope" }, { id: "born" }, { id: "play" }] } });
    const ids = v.spec.home.sections.map((s) => s.id);
    assert.strictEqual(ids[0], "born");
    assert.strictEqual(ids.length, S.SECTION_IDS.length);
    assert.strictEqual(v.spec.home.sections[0].visible, false);
  });
  await test("custom cards: only known blocks and sources; a button needs what it asks", () => {
    const ok = S.validate({ customCards: [{ title: "Water", blocks: [{ type: "stat", source: "habits" }, { type: "button", label: "Log", ask: "I drank water" }] }] });
    assert.ok(ok.ok, ok.errors.join(";"));
    assert.ok(ok.spec.home.sections.some((s) => s.id === `card:${ok.spec.customCards[0].id}`));
    assert.ok(!S.validate({ customCards: [{ title: "X", blocks: [{ type: "script", value: "x" }] }] }).ok);
    assert.ok(!S.validate({ customCards: [{ title: "X", blocks: [{ type: "list", source: "https://evil" }] }] }).ok);
    assert.ok(!S.validate({ customCards: [{ title: "X", blocks: [{ type: "button", label: "Go" }] }] }).ok);
  });

  console.log("(b) the store");
  await test("saved per person; undo walks back; reset is undoable", async () => {
    assert.deepStrictEqual(await store.get(U), S.validate(S.defaults()).spec);
    await store.save(U, { ...S.defaults(), shape: { radius: 8 } });
    await store.save(U, { ...S.defaults(), shape: { radius: 20 } });
    assert.strictEqual((await store.get(U)).shape.radius, 20);
    assert.strictEqual((await store.get(U2)).shape.radius, null, "another person is untouched");
    assert.strictEqual((await store.undo(U)).shape.radius, 8);
    await store.reset(U);
    assert.strictEqual((await store.get(U)).shape.radius, null);
    assert.strictEqual((await store.undo(U)).shape.radius, 8, "reset can be undone");
  });
  await test("an invalid spec is not saved", async () => {
    const before = await store.get(U);
    const r = await store.save(U, { palette: UNREADABLE });
    assert.ok(!r.ok);
    assert.deepStrictEqual(await store.get(U), before);
  });

  console.log("(c) the tools");
  await test("all thirteen are registered; the changing ones act on the phone", () => {
    for (const n of require("../src/design/tools").DESIGN_TOOLS) assert.ok(registry.get(n), n);
    assert.ok(registry.get("design_app").deviceAction);
  });
  await test("design_app: one colour on top of the app's own palette", async () => {
    await store.reset(U);
    const r = await run("design_app", { palette: { primary: "#14B8A6" }, cardStyle: "solid", radius: 12 });
    assert.ok(r.ok, r.error);
    assert.strictEqual(r.deviceAction.type, "apply_ui_spec");
    const s = r.deviceAction.spec;
    assert.deepStrictEqual([s.palette.primary, s.palette.bg, s.shape.cardStyle, s.shape.radius], ["#14B8A6", "#070B2B", "solid", 12]);
  });
  await test("design_app refuses an unreadable change and keeps the old look", async () => {
    const r = await run("design_app", { palette: { textHi: "#0C1440" } });
    assert.ok(!r.ok && /textHi on/.test(r.error), r.error);
    assert.strictEqual((await store.get(U)).palette.textHi, "#F3F6FF");
  });
  await test("design_app: title, font, text size", async () => {
    const r = await run("design_app", { title: "Dhanush HQ", font: "Space Grotesk", textScale: 1.15 });
    assert.deepStrictEqual([r.deviceAction.spec.header.title, r.deviceAction.spec.type.font, r.deviceAction.spec.type.scale],
      ["Dhanush HQ", "Space Grotesk", 1.15]);
  });
  await test("arrange_home: by the owner's words; unknown sections named back", async () => {
    const r = await run("arrange_home", { order: ["today"], hide: ["Born today"] });
    assert.ok(r.ok, r.error);
    const sec = r.deviceAction.spec.home.sections;
    assert.strictEqual(sec[0].id, "today");
    assert.strictEqual(sec.find((x) => x.id === "born").visible, false);
    const bad = await run("arrange_home", { hide: ["the moon"] });
    assert.ok(!bad.ok && /the moon/.test(bad.error));
  });
  await test("add_home_card at the top, then remove it by title", async () => {
    const r = await run("add_home_card", { title: "My water", position: "top",
      blocks: [{ type: "stat", source: "habits", label: "Today" }, { type: "button", label: "Log", ask: "I drank a glass of water" }] });
    assert.ok(r.ok, r.error);
    const s = r.deviceAction.spec;
    assert.strictEqual(s.home.sections[0].id, `card:${s.customCards[0].id}`);
    const gone = await run("remove_home_card", { title: "water" });
    assert.ok(gone.ok, gone.error);
    assert.strictEqual(gone.deviceAction.spec.customCards.length, 0);
    assert.ok(!gone.deviceAction.spec.home.sections.some((x) => x.id.startsWith("card:")));
  });
  await test("undo_design and reset_design", async () => {
    const before = (await store.get(U)).home.sections.length;
    const u = await run("undo_design");
    assert.ok(u.ok && u.deviceAction.spec.customCards.length === 1, "the card is back");
    assert.ok(before >= 8);
    const r = await run("reset_design", {}, U);
    assert.ok(r.ok);
    assert.strictEqual(r.deviceAction.spec.palette, null);
  });
  await test("save, list and apply a named look", async () => {
    await run("design_app", { palette: { primary: "#F59E0B" } });
    assert.ok((await run("save_theme", { name: "Amber" })).ok);
    await run("reset_design");
    const list = await run("list_themes");
    assert.deepStrictEqual(list.saved, ["Amber"]);
    const a = await run("apply_theme", { name: "amber" });
    assert.ok(a.ok, a.error);
    assert.strictEqual(a.deviceAction.spec.palette.primary, "#F59E0B");
    assert.ok(!(await run("apply_theme", { name: "Nope" })).ok);
  });
  await test("preview_designs shows options; pick_preview applies the chosen one", async () => {
    answers.push(look({ ...GOOD, name: "Dawn" }), look({ ...GOOD, name: "Dusk", primary: "#FF9F1C" }));
    const p = await run("preview_designs", { description: "warm", count: 2 });
    assert.ok(p.ok, p.error);
    assert.strictEqual(p.deviceAction.type, "preview_ui_specs");
    assert.deepStrictEqual(p.deviceAction.options.map((o) => o.label), ["Dawn", "Dusk"]);
    const k = await run("pick_preview", { option: 2 });
    assert.ok(k.ok, k.error);
    assert.strictEqual(k.deviceAction.spec.palette.primary, "#FF9F1C");
    assert.ok(!(await run("pick_preview", { option: 9 })).ok);
  });

  console.log("(d) generate_theme");
  await test("an unreadable first answer is sent back and fixed", async () => {
    answers.push(look(UNREADABLE), look(GOOD));
    const r = await run("generate_theme", { description: "sunset" });
    assert.ok(r.ok, r.error);
    assert.strictEqual(r.deviceAction.spec.palette.name, "Sunset");
    assert.strictEqual(answers.length, 0, "asked twice");
  });
  await test("three unreadable answers: nothing is applied", async () => {
    answers.push(look(UNREADABLE), look(UNREADABLE), look(UNREADABLE));
    const before = await store.get(U);
    const r = await run("generate_theme", { description: "invisible" });
    assert.ok(!r.ok);
    assert.deepStrictEqual(await store.get(U), before);
  });

  console.log("(e) /ui");
  const app = express();
  app.use(express.json());
  app.use("/ui", (req, _res, next) => { req.user = { sub: String(req.get("x-test-user") || "") }; next(); }, require("../src/design/routes"));
  const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}/ui`;
  const call = (method, p, uid = U) => fetch(base + p, { method, headers: { "x-test-user": String(uid) } })
    .then(async (r) => ({ status: r.status, body: await r.json() }));
  await test("a reinstalled app gets the same look back", async () => {
    const r = await call("GET", "/spec");
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.spec.palette.name, "Sunset");
    assert.ok(Array.isArray(r.body.cards));
  });
  await test("undo and reset over HTTP; no user, no design", async () => {
    assert.strictEqual((await call("POST", "/reset")).body.spec.palette, null);
    assert.strictEqual((await call("POST", "/undo")).body.spec.palette.name, "Sunset");
    assert.strictEqual((await call("GET", "/spec", "")).status, 401);
  });
  server.close();

  console.log("(f) custom card data");
  await test("a tool's answer becomes short lines, whatever its shape", () => {
    assert.deepStrictEqual(cards.linesOf({ ok: true, result: "Milk\nEggs" }), ["Milk", "Eggs"]);
    assert.deepStrictEqual(cards.linesOf({ ok: true, items: [{ title: "Call bank" }, "Pay rent"] }), ["Call bank", "Pay rent"]);
    assert.deepStrictEqual(cards.linesOf({ ok: false, error: "x" }), []);
  });
  await test("a card's sources run only read tools", () => {
    for (const [, [tool]] of Object.entries(cards.SOURCE_TOOL)) {
      assert.ok(registry.get(tool), tool);
      assert.ok(registry.isParallelSafe(tool) || tool === "daily_brief", `${tool} must be a read`);
    }
  });

  for (const t of ["ui_specs", "ui_spec_history", "ui_themes"]) await db.run(`DELETE FROM ${t} WHERE user_id = ANY($1)`, [[U, U2]]);
  console.log(`\n${passed} passed${process.exitCode ? " — FAILURES above" : ""}`);
  await db.close().catch(() => {});
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); process.exit(1); });

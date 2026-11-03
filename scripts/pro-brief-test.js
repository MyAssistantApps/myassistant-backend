/**
 * THE PROFESSIONAL ASSISTANT'S "TODAY" (2026-11-03) —
 * `node scripts/pro-brief-test.js`.
 *
 * Pins:
 *   (a) pure: when() labels, the template, clean() holds the model's reply
 *       to shape;
 *   (b) against the database: stats and needs come from the user's own
 *       recalls, ledger and clients (never the model) — overdue first,
 *       the right totals, nobody else's data;
 *   (c) the model: a good reply is used, a bad one or a failure falls back
 *       to the template, and the cache saves a second call;
 *   (d) the route: kind is checked, dev sessions get the empty state.
 *
 * Nothing leaves the machine: the model is a stub and any request to a
 * non-local host fails the run.
 */
process.env.DATABASE_URL = process.env.DATABASE_URL ||
  "postgres://myassistant:localdev@127.0.0.1:56432/myassistant";
process.env.NODE_ENV = process.env.NODE_ENV || "test";

const assert = require("assert");
const express = require("express");

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

const realFetch = global.fetch;
global.fetch = async (url, opts) => {
  const u = String(url && url.url ? url.url : url);
  if (/^http:\/\/127\.0\.0\.1[:/]/.test(u)) return realFetch(url, opts);
  throw new Error(`blocked in test: ${u}`);
};

const router = require("../src/services/ai/router");
let modelCalls = 0;
let modelReply = null; // string | Error
router.generateReply = async () => {
  modelCalls++;
  if (modelReply instanceof Error) throw modelReply;
  return { reply: modelReply, provider: "stub" };
};

const pro = require("../src/pro/brief");
const DAY = 24 * 60 * 60 * 1000;
const TZ = 330;

(async () => {
  console.log("pure");
  await atest("when(): overdue, today, tomorrow, a weekday", () => {
    const now = Date.UTC(2026, 10, 3, 6, 0); // 11:30 IST, a Tuesday
    assert.strictEqual(pro.when(now - 2 * DAY, TZ, now).tone, "overdue");
    assert.strictEqual(pro.when(now - 60 * 60 * 1000, TZ, now).label, "today"); // earlier today is not "overdue"
    assert.strictEqual(pro.when(now + 60 * 60 * 1000, TZ, now).label, "today");
    assert.strictEqual(pro.when(now + DAY, TZ, now).label, "tomorrow");
    assert.strictEqual(pro.when(now + 3 * DAY, TZ, now).label, "Fri");
  });

  await atest("the template names what is due, and a calm line when nothing is", () => {
    const empty = pro.template({ kind: "doctor", visits: [], owed: [], owedTotal: 0, people: 4 });
    assert.match(empty.headline, /caught up/);
    assert.match(empty.summary, /4 patients/);
    const busy = pro.template({ kind: "advocate", people: 2, owedTotal: 5000,
      visits: [{ tone: "overdue" }], owed: [{ name: "A", balance: 5000 }] });
    assert.match(busy.headline, /1 hearing overdue/i);
    assert.match(busy.summary, /₹5,000 owed by 1 client/);
    assert.ok(busy.suggestions.length >= 2);
  });

  await atest("clean() keeps the shape and drops a reply that lacks it", () => {
    assert.strictEqual(pro.clean(null), null);
    assert.strictEqual(pro.clean({ headline: "x" }), null);
    const c = pro.clean({ headline: "  Two follow-ups  ", summary: "s",
      suggestions: [{ label: "a", ask: "b" }, { label: "" }, 3, { label: "c", ask: "d" }, { label: "e", ask: "f" }, { label: "g", ask: "h" }] });
    assert.strictEqual(c.headline, "Two follow-ups");
    assert.strictEqual(c.suggestions.length, 3);
  });

  console.log("\nagainst the database");
  const db = require("../src/db");
  await db.init();
  const practice = require("../src/practice/store");
  await practice.migrate();
  const stamp = String(Date.now()).slice(-8);
  const U = (await db.createUser({ email: `pro-a-${stamp}@example.test`, name: "Dr Nimmy" })).id;
  const U2 = (await db.createUser({ email: `pro-b-${stamp}@example.test`, name: "Other" })).id;
  const now = Date.now();
  const mk = async (uid, name) => (await db.one(
    `INSERT INTO clients (user_id, name, kind, created_at, updated_at) VALUES ($1,$2,'patient',$3,$3) RETURNING id`,
    [uid, name, now])).id;
  const ramesh = await mk(U, "Ramesh");
  const sita = await mk(U, "Sita");
  await mk(U, "Arun");
  const stranger = await mk(U2, "Stranger");
  await practice.createRecall(U, { clientId: sita, note: "BP check", dueAt: now + 2 * DAY });
  await practice.createRecall(U, { clientId: ramesh, note: "Dressing change", dueAt: now - 3 * DAY });
  await practice.createRecall(U2, { clientId: stranger, note: "nope", dueAt: now - DAY });
  await practice.addLedger(U, { clientId: ramesh, amount: 2000, kind: "due" });
  await practice.addLedger(U, { clientId: ramesh, amount: 500, kind: "paid" });
  await practice.addLedger(U, { clientId: sita, amount: 800, kind: "due" });
  await practice.addLedger(U2, { clientId: stranger, amount: 9999, kind: "due" });

  modelReply = new Error("model down");
  const b = await pro.buildProBrief(U, "doctor", { tzOffsetMin: TZ, now });

  await atest("stats are the user's own numbers", () => {
    const s = Object.fromEntries(b.stats.map((x) => [x.key, x]));
    assert.strictEqual(s.people.value, "3");
    assert.strictEqual(s.owed.value, "₹2,300");
    assert.match(s.owed.label, /owed by 2/);
    assert.strictEqual(s.visits.value, "1"); // only the overdue one is "due"
    assert.strictEqual(s.visits.alert, true);
  });

  await atest("needs: overdue first, then upcoming, then money — each with a request", () => {
    assert.deepStrictEqual(b.needs.map((n) => n.tone), ["overdue", "soon", "money", "money"]);
    assert.match(b.needs[0].title, /Ramesh/);
    assert.match(b.needs[0].ask, /overdue/);
    assert.match(b.needs[2].title, /Ramesh owes ₹1,500/);
    assert.ok(b.needs.every((n) => !/Stranger|9,999/.test(n.title + n.ask)), "another user's data leaked");
  });

  await atest("a failed model call falls back to the template", () => {
    assert.strictEqual(b.source, "template");
    assert.match(b.headline, /overdue/i);
    assert.strictEqual(b.empty, false);
  });

  console.log("\nthe model");
  await atest("a good reply is used, then cached for the same facts", async () => {
    pro._cache.clear();
    modelReply = JSON.stringify({ headline: "Ramesh is overdue", summary: "Ramesh missed his dressing change.",
      suggestions: [{ label: "Call Ramesh", ask: "Call Ramesh about his dressing change." }] });
    modelCalls = 0;
    const one = await pro.buildProBrief(U, "doctor", { tzOffsetMin: TZ, now });
    assert.strictEqual(one.source, "model");
    assert.strictEqual(one.headline, "Ramesh is overdue");
    const two = await pro.buildProBrief(U, "doctor", { tzOffsetMin: TZ, now });
    assert.strictEqual(two.headline, "Ramesh is overdue");
    assert.strictEqual(modelCalls, 1, "the second load should not call the model");
  });

  await atest("a reply that is not the shape is thrown away", async () => {
    pro._cache.clear();
    modelReply = "not json";
    const r = await pro.buildProBrief(U, "doctor", { tzOffsetMin: TZ, now });
    assert.strictEqual(r.source, "template");
  });

  console.log("\nthe route");
  const app = express();
  const fakeAuth = (req, _res, next) => { req.user = { sub: String(req.get("x-test-user") || "") }; next(); };
  app.use("/pro", fakeAuth, require("../src/routes/pro"));
  const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (path, user) => {
    const r = await fetch(base + path, { headers: { "x-test-user": String(user), "x-tz-offset": String(TZ) } });
    return { status: r.status, body: await r.json() };
  };

  await atest("an unknown kind is refused", async () => {
    assert.strictEqual((await get("/pro/brief?kind=chef", U)).status, 400);
  });
  await atest("a real user gets their brief", async () => {
    const r = await get("/pro/brief?kind=doctor", U);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.kind, "doctor");
    assert.ok(r.body.needs.length >= 3);
  });
  await atest("a dev session gets the calm empty state, not an error", async () => {
    const r = await get("/pro/brief?kind=business", "dev");
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.empty, true);
    assert.strictEqual(r.body.needs.length, 0);
  });

  server.close();
  for (const u of [U, U2]) {
    await db.run("DELETE FROM client_ledger WHERE user_id = $1", [u]).catch(() => {});
    await db.run("DELETE FROM client_recalls WHERE user_id = $1", [u]).catch(() => {});
    await db.run("DELETE FROM clients WHERE user_id = $1", [u]).catch(() => {});
    await db.run("DELETE FROM users WHERE id = $1", [u]).catch(() => {});
  }
  console.log(`\n${passed} passed${process.exitCode ? " — SOME FAILED" : ""}`);
  await db.pool?.end?.().catch?.(() => {});
  process.exit(process.exitCode || 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

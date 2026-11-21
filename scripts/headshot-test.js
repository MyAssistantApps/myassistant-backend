/**
 * ONBOARDING HEADSHOT TESTS — `npm run test:headshot`.
 *
 * POST /studio/headshot against a THROWAWAY database (DATABASE_URL), with
 * the image model replaced by a stub so nothing is spent:
 *   - consent is required before a face is processed
 *   - the call asks for medium quality + high input fidelity
 *   - the profession reaches the instruction
 *   - the per-account cap holds (default 2)
 *   - GET /studio/headshot reports what is left
 * Without DATABASE_URL it skips (and says so) instead of failing.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://test:test@localhost:5432/test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "headshot-test-secret-headshot-test-000001";
process.env.DATA_DIR = process.env.DATA_DIR || require("path").join(require("os").tmpdir(), `headshot-test-${Date.now()}`);
delete process.env.HEADSHOT_ONBOARDING_MAX;

const assert = require("assert");
const express = require("express");

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`  FAIL ${name}\n       ${e && (e.stack || e.message)}`);
    process.exitCode = 1;
  }
}

// A real 1x1 PNG, so every image step downstream accepts it.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64");

(async () => {
  if (!hasDb) {
    console.log("headshot tests: skipped (set DATABASE_URL to a throwaway database)");
    return;
  }
  const db = require("../src/db");
  await db.init();
  const store = require("../src/studio/store");
  await store.migrate();

  // The model stub records what it was asked.
  const imageEdit = require("../src/services/imageEdit");
  const calls = [];
  imageEdit.editImage = async (o) => {
    calls.push(o);
    return { buffer: PNG, mime: "image/png", provider: "stub", ms: 1, width: 1, height: 1, notes: [] };
  };

  const u = await db.one(
    `INSERT INTO users (email, name, created_at) VALUES ($1,'Head Shot',$2) RETURNING id`,
    [`headshot-${Date.now()}@example.test`, Date.now()]);
  const uid = String(u.id);

  const app = express();
  app.use((req, _res, next) => { req.user = { sub: uid }; next(); });
  app.use("/studio", require("../src/routes/studio"));
  const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}/studio/headshot`;
  const post = (profession = "Chartered Accountant") => {
    const form = new FormData();
    form.append("photo", new Blob([PNG], { type: "image/png" }), "me.png");
    form.append("profession", profession);
    return fetch(base, { method: "POST", body: form });
  };

  try {
    await test("no consent yet → 451, and the model is never called", async () => {
      const r = await post();
      assert.strictEqual(r.status, 451);
      assert.strictEqual((await r.json()).code, "consent_required");
      assert.strictEqual(calls.length, 0);
    });

    await store.setConsent(Number(uid));

    await test("GET reports two headshots available", async () => {
      assert.deepStrictEqual(await (await fetch(base)).json(), { used: 0, remaining: 2 });
    });

    await test("a headshot: medium quality, high fidelity, profession in the instruction", async () => {
      const r = await post("Chartered Accountant");
      assert.strictEqual(r.status, 200, await r.clone().text());
      const j = await r.json();
      assert.strictEqual(j.remaining, 1);
      assert.ok(j.document && j.document.id, "the result is saved as a document");
      const c = calls.at(-1);
      assert.strictEqual(c.quality, "medium");
      assert.strictEqual(c.inputFidelity, "high");
      assert.match(c.instruction, /Chartered Accountant/);
      assert.match(c.instruction, /SAME person/);
    });

    await test("the retry is allowed, then the cap answers 429", async () => {
      assert.strictEqual((await post()).status, 200);
      const r = await post();
      assert.strictEqual(r.status, 429);
      const j = await r.json();
      assert.strictEqual(j.code, "headshot_limit");
      assert.strictEqual(calls.length, 2, "no third paid call");
      assert.deepStrictEqual(await (await fetch(base)).json(), { used: 2, remaining: 0 });
    });

    await test("a request without a photo is refused", async () => {
      const r = await fetch(base, { method: "POST", body: new FormData() });
      assert.strictEqual(r.status, 400);
    });
  } finally {
    await new Promise((r) => server.close(r));
  }

  console.log(`\n${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
  await db.close();
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
}).finally(() => setTimeout(() => process.exit(process.exitCode || 0), 100).unref());

/**
 * SECURITY HARDENING TESTS (2026-11-15) — `npm run test:hardening`.
 *
 * One test per control added after the OpenAI-key incident, written so the
 * hole cannot quietly reopen. No database and no network: the db module's
 * functions are stubbed per test, routes are mounted on throwaway express
 * apps, and global fetch is replaced wherever money would be spent.
 */
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://test:test@localhost:5432/test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "hardening-test-secret-hardening-test-secret-01";
process.env.NODE_ENV = process.env.NODE_ENV || "test";

const assert = require("assert");
const express = require("express");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const db = require("../src/db");

let passed = 0;
async function atest(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`  FAIL ${name}\n       ${e && (e.stack || e.message)}`);
    process.exitCode = 1;
  }
}

/** Replace db functions for one test; returns a restore(). */
function stubDb(fns) {
  const saved = {};
  for (const [k, v] of Object.entries(fns)) { saved[k] = db[k]; db[k] = v; }
  return () => { for (const [k, v] of Object.entries(saved)) db[k] = v; };
}

function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) saved[k] = process.env[k];
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = String(v);
  }
  const restore = () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  };
  return Promise.resolve().then(fn).finally(restore);
}

async function serve(app) {
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

const realFetch = global.fetch;
const post = (url, body, headers = {}) =>
  realFetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body || {}) });

/** A db.one stub that answers ai_spend sums. */
function spendDb({ global = 0, user = 0, sessions = 0, fail = false } = {}) {
  return {
    one: async (sql) => {
      if (fail) throw new Error("connection refused");
      if (/user_id = \$1/.test(sql)) return { usd: user, sessions };
      return { usd: global };
    },
  };
}

(async () => {
  const budget = require("../src/ops/budget");

  console.log("\nSpend circuit-breaker (ops/budget.js)");

  await atest("under every cap, a call is allowed", async () => {
    budget._reset();
    const restore = stubDb(spendDb({ global: 1, user: 0.5 }));
    try { await budget.check({ path: "/chat/completions", userId: 7 }); } finally { restore(); }
  });

  await atest("over the GLOBAL daily cap, every call is refused with 402", async () => {
    budget._reset();
    const restore = stubDb(spendDb({ global: 41 }));
    try {
      await withEnv({ SPEND_DAILY_USD_GLOBAL: 40 }, async () => {
        await assert.rejects(budget.check({ path: "/chat/completions", userId: null }),
          (e) => e.code === "budget_exceeded" && e.status === 402 && e.scope === "global");
      });
    } finally { restore(); }
  });

  await atest("over the PER-USER cap, only that user's calls are refused", async () => {
    budget._reset();
    const restore = stubDb(spendDb({ global: 5, user: 3.5 }));
    try {
      await withEnv({ SPEND_DAILY_USD_USER: 3 }, async () => {
        await assert.rejects(budget.check({ path: "/images/generations", userId: 9 }), (e) => e.scope === "user");
        // Background work with no user is not held to a user's cap.
        await budget.check({ path: "/images/generations", userId: null });
      });
    } finally { restore(); }
  });

  await atest("realtime voice sessions have their own daily count", async () => {
    budget._reset();
    const restore = stubDb(spendDb({ sessions: 150 }));
    try {
      await withEnv({ REALTIME_DAILY_SESSIONS_USER: 150 }, async () => {
        await assert.rejects(budget.check({ path: "/realtime/client_secrets", userId: 3 }), (e) => e.scope === "realtime");
        budget._reset();
        await budget.check({ path: "/chat/completions", userId: 3 }); // other features unaffected
      });
    } finally { restore(); }
  });

  await atest("a database outage fails OPEN (availability), not closed", async () => {
    budget._reset();
    const restore = stubDb(spendDb({ fail: true }));
    try { await budget.check({ path: "/chat/completions", userId: 1 }); } finally { restore(); }
  });

  await atest("the OpenAI client checks the budget BEFORE any request leaves", async () => {
    budget._reset();
    const restore = stubDb(spendDb({ global: 999 }));
    let calls = 0;
    global.fetch = async () => { calls++; throw new Error("network must not be reached"); };
    try {
      await withEnv({ OPENAI_API_KEY: "sk-test-not-real", SPEND_DAILY_USD_GLOBAL: 40 }, async () => {
        const openai = require("../src/services/ai/openai");
        await assert.rejects(openai.imageGenerate("a cat", { width: 512, height: 512 }), (e) => e.code === "budget_exceeded");
        await assert.rejects(openai.realtimeClientSecret({ voice: "marin" }), (e) => e.code === "budget_exceeded");
      });
      assert.strictEqual(calls, 0, "a paid request was sent despite the cap");
    } finally { global.fetch = realFetch; restore(); }
  });

  await atest("embeddings (a direct fetch) are held to the same budget", async () => {
    budget._reset();
    const restore = stubDb(spendDb({ global: 999 }));
    let calls = 0;
    global.fetch = async () => { calls++; throw new Error("network must not be reached"); };
    try {
      await withEnv({ OPENAI_API_KEY: "sk-test-not-real", SPEND_DAILY_USD_GLOBAL: 40, EMBEDDING_PROVIDER: "openai" }, async () => {
        await require("../src/memory/embeddings").embed(["hello"]).catch(() => {});
      });
      assert.strictEqual(calls, 0, "an embedding request was sent despite the cap");
    } finally { global.fetch = realFetch; restore(); }
  });

  console.log("\nNo internals in error responses (infra/safeErrors.js)");
  const safe = require("../src/infra/safeErrors");

  await atest("provider bodies, keys, SQL, stacks and paths are recognised", async () => {
    for (const leak of [
      "openai /chat/completions 401: Incorrect API key provided: sk-proj-****u6AA",
      'relation "users" does not exist',
      "duplicate key value violates unique constraint \"users_email_key\"",
      "connect ECONNREFUSED 172.18.0.2:5432",
      "at fn (/app/src/routes/docs.js:12:5)",
      '{"error":{"message":"quota","type":"insufficient_quota"}}',
      "proj-AbCdEf123456 not allowed",
    ]) assert.ok(safe.looksInternal(leak), `not caught: ${leak}`);
    for (const fine of [
      "Please enter a valid email address.",
      "This number is already registered to another account.",
      "Too many attempts today. Please try again tomorrow.",
      "The daily usage limit has been reached. Please try again tomorrow.",
    ]) assert.ok(!safe.looksInternal(fine), `wrongly caught: ${fine}`);
  });

  await atest("a leaky error is replaced; a validation message and a 200 pass through", async () => {
    const app = express();
    app.use(safe.middleware());
    app.get("/leak", (_q, r) => r.status(502).json({ error: "openai /responses 401: Incorrect API key provided: sk-abc…u6AA" }));
    app.get("/valid", (_q, r) => r.status(400).json({ error: "Please enter a valid email address." }));
    app.get("/ok", (_q, r) => r.json({ error: "sk-should-not-be-touched-on-200" }));
    app.get("/admin-panel/api/x", (_q, r) => r.status(500).json({ error: 'relation "x" does not exist' }));
    const s = await serve(app);
    try {
      const leak = await (await realFetch(`${s.url}/leak`)).json();
      assert.ok(!/sk-|openai|401/.test(leak.error), leak.error);
      assert.strictEqual((await (await realFetch(`${s.url}/valid`)).json()).error, "Please enter a valid email address.");
      assert.match((await (await realFetch(`${s.url}/ok`)).json()).error, /sk-should/);
      // The admin panel (behind ADMIN_KEY) keeps the real reason.
      assert.match((await (await realFetch(`${s.url}/admin-panel/api/x`)).json()).error, /relation/);
    } finally { await s.close(); }
  });

  console.log("\nPassword sign-in: per-account throttle, revocation");
  const guard = require("../src/services/loginGuard");

  await atest("after repeated failures the ACCOUNT is locked, even for the right password and from new IPs", async () => {
    guard._reset();
    const hash = await bcrypt.hash("right-password-1", 4);
    const user = { id: 11, email: "victim@example.com", password_hash: hash, status: "active" };
    const restore = stubDb({ findByEmail: async (e) => (String(e).toLowerCase() === user.email ? user : null) });
    const app = express(); app.use(express.json()); app.use("/auth", require("../src/routes/auth"));
    const s = await serve(app);
    try {
      for (let i = 0; i < guard.MAX_FAILS; i++) {
        const r = await post(`${s.url}/auth/login`, { email: user.email, password: `wrong-${i}` });
        assert.strictEqual(r.status, 401);
      }
      const locked = await post(`${s.url}/auth/login`, { email: "VICTIM@example.com", password: "right-password-1" });
      assert.strictEqual(locked.status, 429, "the account was not locked");
      // An unknown email locks the same way (the lock reveals nothing).
      for (let i = 0; i < guard.MAX_FAILS; i++) await post(`${s.url}/auth/login`, { email: "nobody@example.com", password: "x" });
      assert.strictEqual((await post(`${s.url}/auth/login`, { email: "nobody@example.com", password: "x" })).status, 429);
      guard._reset();
      assert.strictEqual((await post(`${s.url}/auth/login`, { email: user.email, password: "right-password-1" })).status, 200);
    } finally { await s.close(); restore(); guard._reset(); }
  });

  await atest("non-string credentials are refused without reaching bcrypt", async () => {
    const app = express(); app.use(express.json()); app.use("/auth", require("../src/routes/auth"));
    const s = await serve(app);
    try {
      const r = await post(`${s.url}/auth/login`, { email: { $ne: "" }, password: ["x"] });
      assert.strictEqual(r.status, 400);
    } finally { await s.close(); }
  });

  await atest("POST /auth/logout-all ends every earlier token; keepThisDevice gets a working one", async () => {
    const { verifySession } = require("../src/middleware/auth");
    const user = { id: 21, email: "a@b.c", status: "active", sessions_valid_after: 0 };
    let updates = 0;
    const restore = stubDb({
      findById: async (id) => (Number(id) === user.id ? { ...user } : null),
      run: async (sql, params) => {
        if (/sessions_valid_after/.test(sql)) { updates++; user.sessions_valid_after = params[1]; }
        return { rowCount: 1 };
      },
    });
    const old = jwt.sign({ uid: user.id, iat: Math.floor(Date.now() / 1000) - 60 }, process.env.JWT_SECRET, { expiresIn: "30d" });
    const app = express(); app.use(express.json()); app.use("/auth", require("../src/routes/auth"));
    const s = await serve(app);
    try {
      assert.ok(!(await verifySession(old)).error, "the old token should work before");
      const r = await post(`${s.url}/auth/logout-all`, { keepThisDevice: true }, { authorization: `Bearer ${old}` });
      assert.strictEqual(r.status, 200);
      const j = await r.json();
      assert.strictEqual(updates, 1);
      assert.ok((await verifySession(old)).error, "the old token still works after sign-out-everywhere");
      assert.ok(j.token && !(await verifySession(j.token)).error, "the fresh token does not work");
    } finally { await s.close(); restore(); }
  });

  await atest("connected-app (mya_) keys die with sign-out-everywhere", async () => {
    const store = require("../src/platform/store");
    const realResolve = store.resolveKey;
    const realBump = store.bump;
    const nowMs = Date.now();
    const user = { id: 31, email: "dev@x.y", status: "active", sessions_valid_after: Math.floor(nowMs / 1000) };
    store.bump = () => {};
    const restore = stubDb({ findById: async () => ({ ...user }) });
    const { platformAuth } = require("../src/platform/auth");
    const run = async (keyCreatedAt) => {
      store.resolveKey = async () => ({ keyId: 1, keyCreatedAt, app: { id: 1, userId: user.id, status: "active", name: "t", scopes: [] } });
      let status = 200;
      const res = { status(c) { status = c; return this; }, json() { return this; } };
      let nexted = false;
      await platformAuth({ get: (h) => (h === "Authorization" ? `Bearer mya_${"a".repeat(40)}` : "") }, res, () => { nexted = true; });
      return nexted ? 200 : status;
    };
    try {
      assert.strictEqual(await run(nowMs - 3600_000), 401, "a key made before the revocation still works");
      assert.strictEqual(await run(nowMs + 2000), 200, "a key made after the revocation was refused");
    } finally { store.resolveKey = realResolve; store.bump = realBump; restore(); }
  });

  console.log("\nAdmin-only and dev-only switches");

  await atest("admin-key gate (/admin): no key, a wrong key and a short key are all 404", async () => {
    const { requireAdminKey } = require("../src/middleware/adminKey");
    const app = express(); app.get("/a", requireAdminKey, (_q, r) => r.json({ ok: true }));
    const s = await serve(app);
    try {
      await withEnv({ ADMIN_KEY: "correct-admin-key-0123456789" }, async () => {
        assert.strictEqual((await realFetch(`${s.url}/a`)).status, 404);
        assert.strictEqual((await realFetch(`${s.url}/a`, { headers: { "X-Admin-Key": "nope" } })).status, 404);
        assert.strictEqual((await realFetch(`${s.url}/a`, { headers: { "X-Admin-Key": "correct-admin-key-0123456789" } })).status, 200);
      });
      await withEnv({ ADMIN_KEY: "short" }, async () => {
        assert.strictEqual((await realFetch(`${s.url}/a`, { headers: { "X-Admin-Key": "short" } })).status, 404);
      });
    } finally { await s.close(); }
  });

  await atest("typed phone claims can be narrowed to listed testers", async () => {
    const { devVerifyAllowedFor } = require("../src/routes/phone");
    await withEnv({ ALLOW_DEV_PHONE_VERIFY: "false", DEV_PHONE_VERIFY_USERS: undefined }, () => {
      assert.strictEqual(devVerifyAllowedFor({ id: 1 }), false);
    });
    await withEnv({ ALLOW_DEV_PHONE_VERIFY: "true", DEV_PHONE_VERIFY_USERS: "5, tester@x.com" }, () => {
      assert.strictEqual(devVerifyAllowedFor({ id: 5 }), true);
      assert.strictEqual(devVerifyAllowedFor({ id: 6, email: "Tester@X.com" }), true);
      assert.strictEqual(devVerifyAllowedFor({ id: 7, email: "attacker@x.com" }), false);
      assert.strictEqual(devVerifyAllowedFor(null), false);
    });
  });

  console.log("\nUploads and logs");

  await atest("a zip bomb disguised as a .docx is refused before any parser inflates it", async () => {
    const JSZip = require("jszip");
    const extract = require("../src/docs/extract");
    const bomb = new JSZip();
    bomb.file("word/document.xml", Buffer.alloc(90 * 1024 * 1024, 0x20)); // 90 MB of spaces
    const buf = await bomb.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 9 } });
    assert.ok(buf.length < 2 * 1024 * 1024, "the bomb should be small on the wire");
    assert.strictEqual(await extract.zipLooksSafe(buf), false);
    assert.strictEqual(await extract.extractText(buf, extract.DOCX, "x.docx"), null);
    const ok = new JSZip();
    ok.file("ppt/slides/slide1.xml", "<p><a:t>Quarterly results</a:t></p>");
    const okBuf = await ok.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    assert.strictEqual(await extract.zipLooksSafe(okBuf), true);
    assert.match(await extract.extractText(okBuf, extract.PPTX, "x.pptx"), /Quarterly results/);
  });

  await atest("webhook secrets are masked in access logs", async () => {
    const { redactPath } = require("../src/infra/observability");
    assert.ok(!/0123456789abcdef0123456789abcdef/.test(redactPath("/agent-call/bolna/0123456789abcdef0123456789abcdef/x")));
  });

  // ---- launch readiness, 2026-11-25 ----
  await atest("the general limit counts a signed-in request against its ACCOUNT; a forged or scoped token stays on the address", async () => {
    const { rateKey } = require("../src/infra/rateKey");
    const key = require("../src/infra/jwtKey").sessionKey();
    const req = (auth, ip = "203.0.113.9") => ({ ip, get: (n) => (String(n).toLowerCase() === "authorization" ? auth : undefined) });
    const mine = jwt.sign({ uid: 41 }, key, { algorithm: "HS256", expiresIn: "1h" });
    assert.strictEqual(rateKey(req(`Bearer ${mine}`)), "u:41");
    assert.strictEqual(rateKey(req(`Bearer ${mine}`, "198.51.100.7")), "u:41", "the same account from another address is one bucket");
    const forged = jwt.sign({ uid: 41 }, "not-our-key-not-our-key-not-our-key-0001", { algorithm: "HS256" });
    assert.strictEqual(rateKey(req(`Bearer ${forged}`)), "ip:203.0.113.9", "a token we did not sign cannot pick a bucket");
    const expired = jwt.sign({ uid: 41, exp: Math.floor(Date.now() / 1000) - 60 }, key, { algorithm: "HS256" });
    assert.strictEqual(rateKey(req(`Bearer ${expired}`)), "ip:203.0.113.9");
    const scoped = jwt.sign({ uid: 41, scope: "console" }, key, { algorithm: "HS256" });
    assert.strictEqual(rateKey(req(`Bearer ${scoped}`)), "ip:203.0.113.9");
    assert.strictEqual(rateKey(req(undefined)), "ip:203.0.113.9");
  });

  await atest("phones behind one address no longer share one limit, and health checks are never counted", async () => {
    const rateLimit = require("express-rate-limit");
    const { rateKey } = require("../src/infra/rateKey");
    const key = require("../src/infra/jwtKey").sessionKey();
    const app = express();
    const notCounted = (r) => r.path === "/health";
    app.use(rateLimit({ windowMs: 60_000, max: 3, keyGenerator: rateKey, skip: notCounted }));
    app.get("/health", (_q, r) => r.json({ ok: true }));
    app.get("/x", (_q, r) => r.json({ ok: true }));
    const s = await serve(app);
    const get = (path, token) => realFetch(`${s.url}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
    try {
      const a = jwt.sign({ uid: 1 }, key, { algorithm: "HS256" });
      const b = jwt.sign({ uid: 2 }, key, { algorithm: "HS256" });
      for (let i = 0; i < 3; i++) assert.strictEqual((await get("/x", a)).status, 200);
      assert.strictEqual((await get("/x", a)).status, 429, "account 1 is over its own limit");
      assert.strictEqual((await get("/x", b)).status, 200, "account 2, same address, is not");
      assert.strictEqual((await get("/x")).status, 200, "nor is someone not signed in yet");
      for (let i = 0; i < 10; i++) assert.strictEqual((await get("/health", a)).status, 200);
    } finally { await s.close(); }
  });

  await atest("pictures are made on a model the account has (gpt-image-1 no longer exists)", async () => {
    const openai = require("../src/services/ai/openai");
    const before = [process.env.OPENAI_IMAGE_MODEL, process.env.OPENAI_IMAGE_EDIT_MODEL];
    delete process.env.OPENAI_IMAGE_MODEL; delete process.env.OPENAI_IMAGE_EDIT_MODEL;
    try {
      assert.strictEqual(openai.models.image(), "gpt-image-1.5");
      assert.strictEqual(openai.models.imageEdit(), "gpt-image-1.5");
    } finally {
      if (before[0] !== undefined) process.env.OPENAI_IMAGE_MODEL = before[0];
      if (before[1] !== undefined) process.env.OPENAI_IMAGE_EDIT_MODEL = before[1];
    }
  });

  await atest("after outside content, placing an order, booking a cab or sending a parcel asks first", async () => {
    const src = require("fs").readFileSync(require("path").join(__dirname, "../src/tools/registry.js"), "utf8");
    const list = src.slice(src.indexOf("const TAINT_SENSITIVE"), src.indexOf("]);", src.indexOf("const TAINT_SENSITIVE")));
    for (const t of ["order_food", "order_groceries", "order_medicines", "book_ride", "send_parcel", "pay_by_upi", "place_phone_call"]) {
      assert.ok(list.includes(`"${t}"`), `${t} is confirmed after outside content`);
    }
  });

  console.log(`\n${passed} passed${process.exitCode ? ", SOME FAILED" : ""}`);
  // Stray handles (pg pool, timers) must not keep the run alive.
  setTimeout(() => process.exit(process.exitCode || 0), 50).unref();
})();

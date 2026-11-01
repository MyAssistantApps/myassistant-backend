/**
 * THE SERVER, WITH PRODUCTION'S OWN SETTINGS (2026-11-01).
 *
 * Every other suite runs with test defaults. Production runs one specific
 * combination (deploy/vps/production.flags: GPT_LIVE=off, OpenAI as the
 * provider, app builds 175+) and that combination went untested: the voice
 * picker offered GPT-Live voices while the server spoke only "coral", and
 * nothing failed until the owner tried it.
 *
 * This boots the real server with those flags (secrets replaced by dummies,
 * nothing leaves this machine) and checks what the app actually gets:
 *
 *   1. GET /ai/config for every supported build matches a snapshot
 *      (scripts/fixtures/production-config.json). A refactor that changes
 *      what the phone receives fails here. After an INTENDED change run
 *      `UPDATE_SNAPSHOT=1 npm run test:production` and commit the diff.
 *   2. Voices agree end to end: what the picker lists is what the config
 *      offers, what the conversation and spoken replies use, and every
 *      voice has a playable sample. A pick changes all of them.
 *   3. The assistant is one: no agents reach the phone.
 *   4. Safety: auth on, no app-key bypass; a warning while the demo phone
 *      sign-in is on.
 *
 * Run: npm run test:production (needs the test Postgres, like the others).
 */
"use strict";

const os = require("os");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const assert = require("assert");

const BACKEND = path.resolve(__dirname, "..");
const FLAGS_FILE = path.join(BACKEND, "deploy/vps/production.flags");
const SNAPSHOT = path.join(__dirname, "fixtures/production-config.json");
// The oldest build production still serves, and the newest in the field.
const BUILDS = [175, 179];

// ── production's settings, secrets as dummies ─────────────────────────
const TEST_DB = process.env.DATABASE_URL || "postgres://myassistant:localdev@127.0.0.1:55432/myassistant";
const flags = {};
for (const line of fs.readFileSync(FLAGS_FILE, "utf8").split("\n")) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m) flags[m[1]] = m[2];
}
// Start clean: nothing from the developer's shell may leak in.
for (const k of Object.keys(process.env)) {
  if (/^(AI_|GPT_LIVE|OPENAI_|GEMINI_|ALLOW_|AUTH_|APP_API|PLIVO_|SHORTCUTS|VOICE_)/.test(k)) delete process.env[k];
}
for (const [k, v] of Object.entries(flags)) {
  process.env[k] = v === "<secret>" ? `dummy-${k.toLowerCase()}` : v;
}
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "prod-config-"));
Object.assign(process.env, {
  DATABASE_URL: TEST_DB,
  JWT_SECRET: "prod-config-" + crypto.randomBytes(16).toString("hex"),
  DATA_DIR: path.join(TMP, "data"),
  MEDIA_DIR: path.join(TMP, "media"),
  MEDIA_BACKEND: "local",
  LIVE_RECORD: "0",
  LOG_LEVEL: "error",
});
process.chdir(TMP); // no .env here

// Nothing leaves this machine.
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url && url.url ? url.url : url);
  if (/^http:\/\/127\.0\.0\.1:\d+\//.test(u)) return realFetch(url, opts);
  return new Response(JSON.stringify({ error: "offline in production-config-test" }),
    { status: 503, headers: { "content-type": "application/json" } });
};

// OpenAI's speech and realtime key, recorded instead of called.
const openai = require(path.join(BACKEND, "src/services/ai/openai"));
const spoken = [];
const realtime = [];
openai.speak = async (text, { voice } = {}) => {
  spoken.push({ text, voice });
  return Buffer.alloc(24000 * 2); // one second of 24 kHz PCM
};
openai.realtimeClientSecret = async (opts) => {
  realtime.push(opts);
  return { value: "ek_test", expiresAt: 0, model: "gpt-realtime-test" };
};

const db = require(path.join(BACKEND, "src/db"));
const jwt = require("jsonwebtoken");
const { freePort } = require("./_free-port");

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) {
    failed++;
    console.error(`  FAIL ${name}\n       ${String(e && (e.stack || e.message) || e).split("\n").slice(0, 8).join("\n       ")}`);
    process.exitCode = 1;
  }
}

let BASE = "";
async function api(method, p, { token, build, body, raw = false } = {}) {
  const h = {};
  if (token) h.Authorization = `Bearer ${token}`;
  if (build) h["X-App-Build"] = String(build);
  if (body !== undefined) h["content-type"] = "application/json";
  const r = await realFetch(BASE + p, {
    method, headers: h, body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  if (raw) return { status: r.status, bytes: Buffer.from(await r.arrayBuffer()), type: r.headers.get("content-type") };
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) {}
  return { status: r.status, json, text };
}

/** The config with what differs per user or per run taken out. */
function stable(cfg) {
  const out = JSON.parse(JSON.stringify(cfg));
  if (out.routing) out.routing.shortcutNames = [];
  return out;
}

(async () => {
  process.env.PORT = String(await freePort());
  BASE = `http://127.0.0.1:${process.env.PORT}`;
  require(path.join(BACKEND, "src/server"));
  const end = Date.now() + 30_000;
  for (;;) {
    try { if ((await api("GET", "/health")).status === 200) break; } catch (_) {}
    if (Date.now() > end) throw new Error("server did not start");
    await new Promise((r) => setTimeout(r, 100));
  }

  const stamp = Date.now();
  const mk = async (tag, extra = {}) => {
    const u = await db.createUser({ email: `prod-cfg-${tag}-${stamp}@example.test`, name: "Dhanush K", gender: "male", ...extra });
    return { id: u.id, token: jwt.sign({ uid: u.id }, process.env.JWT_SECRET, { expiresIn: "1h" }) };
  };
  const A = await mk("a");

  console.log("(1) what every supported build receives");
  const configs = {};
  for (const build of BUILDS) {
    const r = await api("GET", "/ai/config", { token: A.token, build });
    assert.strictEqual(r.status, 200, r.text);
    configs[build] = stable(r.json);
  }
  await test("GET /ai/config matches the snapshot for every supported build", () => {
    if (process.env.UPDATE_SNAPSHOT === "1" || !fs.existsSync(SNAPSHOT)) {
      fs.mkdirSync(path.dirname(SNAPSHOT), { recursive: true });
      fs.writeFileSync(SNAPSHOT, JSON.stringify(configs, null, 2) + "\n");
      console.log(`      (snapshot written: ${path.relative(BACKEND, SNAPSHOT)})`);
      return;
    }
    const want = JSON.parse(fs.readFileSync(SNAPSHOT, "utf8"));
    assert.deepStrictEqual(configs, want,
      "the phone would receive a different config. If intended: UPDATE_SNAPSHOT=1 npm run test:production");
  });
  await test("the phone talks to our server (OpenAI), never to a provider directly", () => {
    for (const b of BUILDS) assert.strictEqual(configs[b].provider, "openai", `build ${b}`);
  });

  console.log("(2) voices agree end to end");
  const voices = await api("GET", "/ai/voices", { token: A.token, build: 179 });
  const ids = (voices.json && voices.json.voices || []).map((v) => v.id);
  const cfg = configs[179];
  await test("the picker lists only voices the config offers, at most twelve", () => {
    assert.ok(ids.length > 0 && ids.length <= 12, ids.join(","));
    assert.deepStrictEqual([...ids].sort(), [...cfg.live.voices].sort());
    for (const v of voices.json.voices) assert.ok(["male", "female"].includes(v.gender), v.id);
    assert.ok(ids.includes(voices.json.default), "the default is one of them");
  });
  await test("with no pick, conversation and spoken replies use the same listed voice", () => {
    assert.ok(ids.includes(cfg.live.voice), cfg.live.voice);
    assert.strictEqual(cfg.models.ttsVoice, cfg.live.voice);
  });
  await test("every listed voice has a playable sample, made in that voice", async () => {
    for (const id of ids) {
      const r = await api("GET", `/ai/voices/${id}/sample`, { token: A.token, raw: true });
      assert.strictEqual(r.status, 200, `${id}: ${r.status}`);
      assert.strictEqual(r.bytes.slice(0, 4).toString(), "RIFF", id);
      assert.strictEqual(r.bytes.readUInt16LE(22), 1, `${id}: mono`);
      assert.strictEqual(r.bytes.readUInt16LE(34), 16, `${id}: 16-bit`);
      assert.ok(spoken.some((s) => s.voice === id), `${id} was spoken in ${id}`);
    }
  });
  const pick = ids.find((v) => v !== cfg.live.voice && ["female"].includes(voices.json.voices.find((x) => x.id === v).gender));
  await test(`a pick (${pick}) changes the conversation, spoken replies and greeting`, async () => {
    const saved = await api("PUT", "/profile/assistant", { token: A.token, body: { voice: pick } });
    assert.strictEqual(saved.status, 200, saved.text);
    const after = (await api("GET", "/ai/config", { token: A.token, build: 179 })).json;
    assert.strictEqual(after.live.voice, pick, "conversation voice");
    assert.strictEqual(after.models.ttsVoice, pick, "spoken replies voice");
    realtime.length = 0;
    const rt = await api("POST", "/ai/realtime/secret", { token: A.token, build: 179, body: { instructions: "", tools: [] } });
    assert.strictEqual(rt.status, 200, rt.text);
    assert.strictEqual(realtime[0].voice, pick, "the realtime session is opened in the pick");
    spoken.length = 0;
    const g = await api("GET", `/ai/voices/${pick}/greeting-v5?line=${encodeURIComponent("Hello Sir.")}`, { token: A.token, raw: true });
    assert.strictEqual(g.status, 200);
    assert.ok(spoken.some((s) => s.voice === pick), "the greeting is in the pick");
  });
  await test("a voice production cannot speak is never used", async () => {
    realtime.length = 0;
    await api("POST", "/ai/realtime/secret", { token: A.token, build: 179, body: { voice: "gleam" } });
    assert.ok(ids.includes(realtime[0].voice), realtime[0].voice);
  });

  console.log("(3) one assistant on screen");
  await test("no agents reach the phone", async () => {
    const r = await api("POST", "/ai/context", { token: A.token, build: 179,
      body: { text: "order biryani and tell Ravi I'm running late", mode: "voice" } });
    assert.strictEqual(r.status, 200, r.text.slice(0, 200));
    assert.deepStrictEqual(r.json.manager.agents, []);
    assert.deepStrictEqual(r.json.manager.toolAgent, {});
    assert.ok(!r.json.tools.some((t) => t.name === "talk_as_agent"));
    assert.ok(!/\[MANAGER\]|specialist agents/i.test(r.json.system), "no team in the prompt");
  });

  await test("'talk to your manager': the Manager pops up, with the internet, apps and every tool", async () => {
    const r = await api("POST", "/ai/context", { token: A.token, build: 179,
      body: { text: "I want to talk to your manager", mode: "voice" } });
    assert.strictEqual(r.status, 200, r.text.slice(0, 200));
    assert.deepStrictEqual(r.json.manager.addressed, { id: "manager", label: "Manager" });
    const names = r.json.tools.map((t) => t.name);
    for (const n of ["web_search", "read_webpage", "open_named_app", "phone_control"]) assert.ok(names.includes(n), n);
    assert.ok(names.length > 40, `${names.length} tools`);
    assert.match(r.json.system, /you ARE the Manager/);
    const after = await api("POST", "/ai/context", { token: A.token, build: 179,
      body: { text: "thanks manager, back to Maya", mode: "voice", sessionId: r.json.sessionId } });
    assert.strictEqual(after.json.manager.addressed, undefined, "handed back");
  });

  console.log("(4) safety");
  await test("auth is on and the shared app key cannot sign anyone in", async () => {
    assert.notStrictEqual(process.env.AUTH_DISABLED, "true");
    assert.strictEqual(process.env.ALLOW_APP_KEY, "false");
    assert.strictEqual((await api("GET", "/ai/config", { build: 179 })).status, 401);
  });
  if (process.env.ALLOW_DEV_PHONE_VERIFY === "true") {
    console.log("  !!  ALLOW_DEV_PHONE_VERIFY=true in production: anyone can sign in as any number. Turn it off before a public release.");
  }
  console.log(`production-config: ${passed} passed${failed ? `, ${failed} FAILED` : ""}`);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error("production-config-test crashed:", e);
  process.exit(1);
});

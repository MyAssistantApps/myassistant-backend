/**
 * LINK YOUR ACCOUNT (2026-11-21) — `npm run test:accounts`.
 *
 * The whole OAuth round trip against a FAKE Uber and Swiggy sign-in server
 * on localhost: the sign-in URL (state; PKCE for Swiggy), the company's
 * redirect back with a code, the code exchanged and the token stored
 * ENCRYPTED, the provider reading it, refresh when expired, a replayed or
 * forged state refused, Unlink, and the status the app shows.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || "accounts-test-secret-accounts-test-secret-01";
process.env.NODE_ENV = process.env.NODE_ENV || "test";

const assert = require("assert");
const crypto = require("crypto");
const express = require("express");
const db = require("../src/db");

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

(async () => {
  await db.init();
  // A fake company: authorise page (not visited), token endpoint, metadata.
  const issued = [];
  const fake = express();
  fake.use(express.urlencoded({ extended: false }));
  let pkceSeen = null;
  fake.get("/.well-known/oauth-authorization-server", (req, res) => {
    const base = `http://127.0.0.1:${server.address().port}`;
    res.json({ authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token` });
  });
  fake.post(["/token", "/oauth/v2/token"], (req, res) => {
    issued.push(req.body);
    if (req.body.code_verifier) pkceSeen = req.body.code_verifier;
    if (req.body.grant_type === "refresh_token") {
      return res.json({ access_token: "access-refreshed", expires_in: 3600 });
    }
    if (req.body.code !== "good-code") return res.status(400).json({ error: "invalid_grant" });
    res.json({ access_token: `access-${req.body.client_id}`, refresh_token: "refresh-1", expires_in: 3600 });
  });
  const server = fake.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  Object.assign(process.env, {
    UBER_CLIENT_ID: "uber-client", UBER_CLIENT_SECRET: "uber-secret", UBER_AUTH_BASE: base,
    SWIGGY_CLIENT_ID: "swiggy-client", SWIGGY_OAUTH_ISSUER: base,
    PUBLIC_BASE_URL: "https://backend.example.test",
  });

  const accounts = require("../src/accounts/service");
  await accounts.migrate();
  const u = await db.one(
    `INSERT INTO users (name, email, password_hash, created_at) VALUES ('Link Tester', $1, 'x', $2) RETURNING id`,
    [`link-${Date.now()}@test.local`, Date.now()]);
  const me = Number(u.id);

  // The public callback, mounted like server.js does.
  const app = express();
  app.use("/link", require("../src/accounts/routes").link);
  const appSrv = app.listen(0);
  const callback = (provider, q) =>
    fetch(`http://127.0.0.1:${appSrv.address().port}/link/${provider}/callback?${new URLSearchParams(q)}`);

  let uberState;
  await test("Link Uber: the sign-in URL carries our client, redirect, scope and a state", async () => {
    const url = new URL(await accounts.connectUrl(me, "uber"));
    assert.strictEqual(url.origin + url.pathname, `${base}/oauth/v2/authorize`);
    assert.strictEqual(url.searchParams.get("client_id"), "uber-client");
    assert.strictEqual(url.searchParams.get("redirect_uri"), "https://backend.example.test/link/uber/callback");
    assert.match(url.searchParams.get("scope"), /request/);
    uberState = url.searchParams.get("state");
    assert.ok(uberState.length >= 30);
  });
  await test("Uber redirects back: the code becomes a token, stored encrypted, page says Linked", async () => {
    const r = await callback("uber", { code: "good-code", state: uberState });
    assert.strictEqual(r.status, 200);
    assert.match(await r.text(), /Uber Linked/);
    const row = await db.one(`SELECT access_token FROM ride_accounts WHERE user_id = $1 AND provider = 'uber'`, [me]);
    assert.ok(row && !row.access_token.includes("access-uber-client"), "the token is not stored in clear");
    assert.strictEqual(await accounts.tokenFor(me, "uber"), "access-uber-client");
  });
  await test("a used or forged state is refused", async () => {
    const replay = await callback("uber", { code: "good-code", state: uberState });
    assert.strictEqual(replay.status, 400);
    assert.match(await replay.text(), /expired/);
    const forged = await callback("uber", { code: "good-code", state: "made-up" });
    assert.strictEqual(forged.status, 400);
  });
  await test("Link Swiggy uses PKCE: the verifier sent at the exchange matches the challenge", async () => {
    const url = new URL(await accounts.connectUrl(me, "swiggy"));
    assert.strictEqual(url.searchParams.get("code_challenge_method"), "S256");
    const challenge = url.searchParams.get("code_challenge");
    const r = await callback("swiggy", { code: "good-code", state: url.searchParams.get("state") });
    assert.strictEqual(r.status, 200);
    const expected = crypto.createHash("sha256").update(pkceSeen).digest("base64")
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    assert.strictEqual(expected, challenge);
    assert.strictEqual(await accounts.tokenFor(me, "swiggy"), "access-swiggy-client");
  });
  await test("an expired token is refreshed with the refresh token", async () => {
    await db.run(`UPDATE ride_accounts SET expires_at = $2 WHERE user_id = $1 AND provider = 'uber'`, [me, Date.now() - 1000]);
    assert.strictEqual(await accounts.tokenFor(me, "uber"), "access-refreshed");
    assert.strictEqual(issued.at(-1).grant_type, "refresh_token");
  });
  await test("the app's list: Uber and Swiggy linked, Ola available soon", async () => {
    const s = await accounts.status(me);
    assert.deepStrictEqual([s.uber.linked, s.swiggy.linked, s.ola.linked, s.ola.available], [true, true, false, false]);
  });
  await test("a cancelled sign-in says so; Ola cannot be started yet", async () => {
    const url = new URL(await accounts.connectUrl(me, "uber"));
    const r = await callback("uber", { error: "access_denied", state: url.searchParams.get("state") });
    assert.strictEqual(r.status, 400);
    assert.match(await r.text(), /cancelled/);
    await assert.rejects(accounts.connectUrl(me, "ola"), (e) => e.code === "not_configured");
  });
  await test("Unlink removes the token; booking then asks to link again", async () => {
    await accounts.unlink(me, "uber");
    await assert.rejects(accounts.tokenFor(me, "uber"), (e) => e.code === "link_required");
  });

  await test("booking with Uber live but not linked: the assistant opens Linked Accounts", async () => {
    process.env.UBER_RIDES_ENABLED = "on";
    delete process.env.RIDES_TEST_PROVIDER;
    require("../src/tools/builtins").registerBuiltins();
    const r = await require("../src/tools/registry").execute("book_ride",
      { pickup: "Yeshwanthpur", destination: "Majestic" }, { userId: me, lat: 13.02, lng: 77.54 });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, "link_required");
    assert.match(r.speak, /link your Uber account/);
    assert.deepStrictEqual(r.deviceAction, { type: "open_app_screen", screen: "linked_accounts" });
    delete process.env.UBER_RIDES_ENABLED;
  });

  server.close();
  appSrv.close();
  await db.run(`DELETE FROM ride_accounts WHERE user_id = $1`, [me]);
  await db.run(`DELETE FROM order_accounts WHERE user_id = $1`, [me]);
  await db.run(`DELETE FROM users WHERE id = $1`, [me]);
  console.log(`\n${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
  process.exit(process.exitCode || 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

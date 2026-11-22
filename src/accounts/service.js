/**
 * LINK YOUR ACCOUNT — Uber, Swiggy, Ola (owner, 2026-11-21).
 *
 * A cab or an order is placed on the USER'S OWN account with the company,
 * so each user links it once:
 *
 *   app  →  GET /accounts/:provider/connect      (signed in)
 *        ←  { url }  the company's sign-in page, with our state (+ PKCE)
 *   user signs in at the company and allows MyAssistant
 *   company → GET /link/:provider/callback?code&state   (public)
 *        →  code exchanged for tokens, stored ENCRYPTED, page says "linked"
 *   app (on return) → GET /accounts → { uber: { linked: true } … }
 *
 * Tokens are encrypted at rest (the MCP secret box), refreshed when they
 * expire (tokenFor), and deleted on Unlink and with the account.
 *
 * Endpoints:
 * - Uber: OAuth 2.0 authorisation code, auth.uber.com (documented).
 * - Swiggy: OAuth 2.1 + PKCE for its MCP servers; the endpoints are read
 *   from Swiggy's published metadata (/.well-known/oauth-authorization-server)
 *   unless SWIGGY_AUTH_URL / SWIGGY_TOKEN_URL are set.
 * - Ola: not offered until Ola shares its authorisation flow
 *   (docs/OWNER_ACTIONS.md).
 *
 * Linked tokens live in ride_accounts (Uber, Ola) and order_accounts
 * (Swiggy), which the providers read through tokenFor().
 */
const crypto = require("crypto");
const { one, run } = require("../db");
const { encryptSecrets, decryptSecrets } = require("../mcp/schema");

const BASE = () => (process.env.PUBLIC_BASE_URL || "https://backend.envisionsit.in").replace(/\/$/, "");
const STATE_TTL_MS = 15 * 60_000;

const PROVIDERS = {
  uber: {
    label: "Uber",
    table: "ride_accounts",
    configured: () => Boolean(process.env.UBER_CLIENT_ID && process.env.UBER_CLIENT_SECRET),
    clientId: () => process.env.UBER_CLIENT_ID,
    clientSecret: () => process.env.UBER_CLIENT_SECRET,
    scope: () => process.env.UBER_SCOPES || "profile request request_receipt",
    pkce: false,
    async endpoints() {
      const auth = process.env.UBER_AUTH_BASE || "https://auth.uber.com";
      return { authorize: `${auth}/oauth/v2/authorize`, token: `${auth}/oauth/v2/token` };
    },
  },
  swiggy: {
    label: "Swiggy",
    table: "order_accounts",
    configured: () => Boolean(process.env.SWIGGY_CLIENT_ID),
    clientId: () => process.env.SWIGGY_CLIENT_ID,
    clientSecret: () => process.env.SWIGGY_CLIENT_SECRET || "",
    scope: () => process.env.SWIGGY_SCOPES || "",
    pkce: true,
    async endpoints() {
      if (process.env.SWIGGY_AUTH_URL && process.env.SWIGGY_TOKEN_URL) {
        return { authorize: process.env.SWIGGY_AUTH_URL, token: process.env.SWIGGY_TOKEN_URL };
      }
      const issuer = (process.env.SWIGGY_OAUTH_ISSUER || "https://mcp.swiggy.com").replace(/\/$/, "");
      const r = await fetch(`${issuer}/.well-known/oauth-authorization-server`, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) throw new Error(`swiggy metadata ${r.status}`);
      const m = await r.json();
      return { authorize: m.authorization_endpoint, token: m.token_endpoint };
    },
  },
  ola: {
    label: "Ola",
    table: "ride_accounts",
    // Ola's rider authorisation is shared with partners only; until then
    // the app shows Ola as "available soon".
    configured: () => false,
  },
};

let migrated = null;
function migrate() {
  if (!migrated) {
    migrated = (async () => {
      await require("../rides/service").migrate();
      await require("../orders/service").migrate();
      await run(`
        CREATE TABLE IF NOT EXISTS account_link_states (
          state       TEXT PRIMARY KEY,
          user_id     INTEGER NOT NULL,
          provider    TEXT NOT NULL,
          verifier    TEXT NOT NULL DEFAULT '',
          created_at  BIGINT NOT NULL
        );
      `);
    })().catch((e) => {
      migrated = null;
      throw e;
    });
  }
  return migrated;
}

const redirectUri = (provider) =>
  process.env[`${provider.toUpperCase()}_REDIRECT_URI`] || `${BASE()}/link/${provider}/callback`;
const b64url = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** The company's sign-in URL for this user. */
async function connectUrl(userId, provider) {
  await migrate();
  const p = PROVIDERS[provider];
  if (!p) throw Object.assign(new Error("unknown provider"), { status: 404 });
  if (!p.configured()) throw Object.assign(new Error(`${p.label} linking is not available yet`), { status: 409, code: "not_configured" });
  const state = b64url(crypto.randomBytes(24));
  const verifier = p.pkce ? b64url(crypto.randomBytes(48)) : "";
  await run(`DELETE FROM account_link_states WHERE created_at < $1`, [Date.now() - STATE_TTL_MS]);
  await run(`INSERT INTO account_link_states (state, user_id, provider, verifier, created_at) VALUES ($1,$2,$3,$4,$5)`,
    [state, userId, provider, verifier, Date.now()]);
  const { authorize } = await p.endpoints();
  const u = new URL(authorize);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", p.clientId());
  u.searchParams.set("redirect_uri", redirectUri(provider));
  u.searchParams.set("state", state);
  if (p.scope()) u.searchParams.set("scope", p.scope());
  if (p.pkce) {
    u.searchParams.set("code_challenge", b64url(crypto.createHash("sha256").update(verifier).digest()));
    u.searchParams.set("code_challenge_method", "S256");
  }
  return u.toString();
}

async function exchange(p, provider, params) {
  const { token } = await p.endpoints();
  const body = new URLSearchParams({ client_id: p.clientId(), redirect_uri: redirectUri(provider), ...params });
  if (p.clientSecret()) body.set("client_secret", p.clientSecret());
  const r = await fetch(token, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body,
    signal: AbortSignal.timeout(12_000),
  });
  if (!r.ok) throw new Error(`token ${r.status}`);
  return r.json();
}

async function save(userId, provider, tok) {
  const p = PROVIDERS[provider];
  const blob = encryptSecrets({ access: tok.access_token, refresh: tok.refresh_token || "" });
  const expires = tok.expires_in ? Date.now() + Number(tok.expires_in) * 1000 : 0;
  await run(
    `INSERT INTO ${p.table} (user_id, provider, access_token, refresh_token, expires_at, created_at)
     VALUES ($1,$2,$3,'',$4,$5)
     ON CONFLICT (user_id, provider) DO UPDATE SET access_token = EXCLUDED.access_token, expires_at = EXCLUDED.expires_at`,
    [userId, provider, blob, expires, Date.now()]);
}

/** The company's redirect back to us. Returns { ok, provider, label } or throws. */
async function callback(provider, { code, state, error }) {
  await migrate();
  const p = PROVIDERS[provider];
  if (!p || !p.configured()) throw new Error("unknown provider");
  const row = await one(`DELETE FROM account_link_states WHERE state = $1 AND provider = $2 RETURNING *`, [String(state || ""), provider]);
  if (!row || Date.now() - Number(row.created_at) > STATE_TTL_MS) throw new Error("this link has expired; please start again from the app");
  if (error || !code) throw new Error("the sign-in was cancelled");
  const tok = await exchange(p, provider, {
    grant_type: "authorization_code", code: String(code), ...(p.pkce ? { code_verifier: row.verifier } : {}),
  });
  if (!tok.access_token) throw new Error("no token was returned");
  await save(Number(row.user_id), provider, tok);
  return { ok: true, provider, label: p.label, userId: Number(row.user_id) };
}

/** A usable access token, refreshed when it has expired. Throws link_required. */
async function tokenFor(userId, provider) {
  const p = PROVIDERS[provider];
  if (!p?.table) throw Object.assign(new Error("unknown provider"), { code: "link_required" });
  const row = await one(`SELECT access_token, expires_at FROM ${p.table} WHERE user_id = $1 AND provider = $2`, [userId, provider]);
  if (!row) throw Object.assign(new Error(`${p.label} account not linked`), { code: "link_required" });
  let secrets;
  try {
    secrets = decryptSecrets(row.access_token);
  } catch {
    secrets = { access: row.access_token, refresh: "" }; // stored before encryption
  }
  const expired = Number(row.expires_at) > 0 && Number(row.expires_at) < Date.now() + 60_000;
  if (!expired) return secrets.access;
  if (!secrets.refresh) throw Object.assign(new Error(`${p.label} sign-in expired`), { code: "link_required" });
  const tok = await exchange(p, provider, { grant_type: "refresh_token", refresh_token: secrets.refresh });
  await save(userId, provider, { refresh_token: secrets.refresh, ...tok });
  return tok.access_token;
}

async function status(userId) {
  await migrate();
  const out = {};
  for (const [id, p] of Object.entries(PROVIDERS)) {
    const row = p.table
      ? await one(`SELECT created_at FROM ${p.table} WHERE user_id = $1 AND provider = $2`, [userId, id]).catch(() => null)
      : null;
    out[id] = { label: p.label, available: p.configured(), linked: Boolean(row), linkedAt: row ? Number(row.created_at) : null };
  }
  return out;
}

async function unlink(userId, provider) {
  await migrate();
  const p = PROVIDERS[provider];
  if (!p?.table) return false;
  await run(`DELETE FROM ${p.table} WHERE user_id = $1 AND provider = $2`, [userId, provider]);
  return true;
}

const USER_TABLES = [["account_link_states", "user_id"]];

module.exports = { migrate, connectUrl, callback, tokenFor, status, unlink, PROVIDERS, USER_TABLES, redirectUri };

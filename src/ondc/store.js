/**
 * WHAT WE SENT AND WHAT CAME BACK (2026-11-04). ONDC is asynchronous: we
 * send search/select/init/confirm and the sellers' apps answer later on
 * our callback URL. Every request and every answer is kept here, keyed by
 * transaction and message, so the app can read the answers as they land.
 */
const { query, one, run } = require("../db");

let ready = null;
function migrate() {
  if (!ready) {
    ready = (async () => {
      await run(`
        CREATE TABLE IF NOT EXISTS ondc_requests (
          message_id     TEXT PRIMARY KEY,
          transaction_id TEXT NOT NULL,
          user_id        INTEGER,
          action         TEXT NOT NULL,
          bpp_id         TEXT,
          bpp_uri        TEXT,
          payload        JSONB NOT NULL,
          ack            TEXT,
          created_at     BIGINT NOT NULL
        )`);
      await run(`CREATE INDEX IF NOT EXISTS idx_ondc_requests_txn ON ondc_requests(transaction_id)`);
      await run(`
        CREATE TABLE IF NOT EXISTS ondc_responses (
          id             BIGSERIAL PRIMARY KEY,
          transaction_id TEXT NOT NULL,
          message_id     TEXT,
          action         TEXT NOT NULL,
          bpp_id         TEXT,
          bpp_uri        TEXT,
          payload        JSONB NOT NULL,
          created_at     BIGINT NOT NULL
        )`);
      await run(`CREATE INDEX IF NOT EXISTS idx_ondc_responses_txn ON ondc_responses(transaction_id, action)`);
      await run(`
        CREATE TABLE IF NOT EXISTS ondc_orders (
          id             BIGSERIAL PRIMARY KEY,
          user_id        INTEGER NOT NULL,
          transaction_id TEXT NOT NULL,
          domain         TEXT NOT NULL,
          bpp_id         TEXT NOT NULL,
          bpp_uri        TEXT NOT NULL,
          provider_id    TEXT NOT NULL,
          provider_name  TEXT,
          items          JSONB NOT NULL,
          quote          JSONB,
          billing        JSONB,
          fulfillment    JSONB,
          order_id       TEXT,
          state          TEXT NOT NULL DEFAULT 'cart',
          payment        JSONB,
          created_at     BIGINT NOT NULL,
          updated_at     BIGINT NOT NULL
        )`);
      await run(`CREATE INDEX IF NOT EXISTS idx_ondc_orders_user ON ondc_orders(user_id, updated_at DESC)`);
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

async function saveRequest({ messageId, transactionId, userId, action, bppId, bppUri, payload, ack }) {
  await migrate();
  await run(
    `INSERT INTO ondc_requests (message_id, transaction_id, user_id, action, bpp_id, bpp_uri, payload, ack, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (message_id) DO NOTHING`,
    [messageId, transactionId, userId || null, action, bppId || null, bppUri || null,
      JSON.stringify(payload), ack || null, Date.now()]);
}

async function requestOf(messageId) {
  await migrate();
  return one("SELECT * FROM ondc_requests WHERE message_id = $1", [messageId]);
}

async function saveResponse(body) {
  await migrate();
  const c = body.context || {};
  await run(
    `INSERT INTO ondc_responses (transaction_id, message_id, action, bpp_id, bpp_uri, payload, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [c.transaction_id, c.message_id || null, c.action, c.bpp_id || null, c.bpp_uri || null,
      JSON.stringify(body), Date.now()]);
}

async function responses(transactionId, action, { since = 0 } = {}) {
  await migrate();
  return query(
    `SELECT * FROM ondc_responses WHERE transaction_id = $1 AND action = $2 AND created_at > $3
     ORDER BY created_at ASC`, [transactionId, action, since]);
}

module.exports = { migrate, saveRequest, requestOf, saveResponse, responses };

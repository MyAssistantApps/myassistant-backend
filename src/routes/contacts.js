/**
 * The user's address book, mirrored so server-side tools can resolve a name.
 *
 *   POST /contacts/sync  { contacts: [{name, phone}, …] }  → { stored }
 *
 * WHY THIS EXISTS: "tell mom I'll be late" is resolved by a tool running on
 * the server, inside the live model's turn. It cannot pause to ask the
 * handset who "mom" is, so the mapping has to be here already.
 *
 * WHAT IS STORED: names and numbers only, nothing else the address book
 * holds — no emails, photos, addresses or notes. Numbers are normalised to
 * E.164 on the way in, because matching them against registered users is an
 * exact-string comparison. Entries without a usable number are dropped
 * rather than stored as junk that can never match.
 *
 * This is kept separate from `clients`, which is the user's own curated
 * case-file list. Merging a whole phonebook into it would bury the handful
 * of records they actually maintain.
 */
const express = require("express");
const db = require("../db");
const { normalizePhone } = require("../users/phone");

const router = express.Router();

/// Bound on one sync so a large address book cannot become a huge request.
const MAX_CONTACTS = 5000;

async function migrate() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS contacts (
      id         BIGSERIAL PRIMARY KEY,
      user_id    INTEGER NOT NULL,
      name       TEXT NOT NULL,
      phone      TEXT NOT NULL,
      updated_at BIGINT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_user_phone
      ON contacts (user_id, phone);
    CREATE INDEX IF NOT EXISTS idx_contacts_user_name
      ON contacts (user_id, lower(name));
  `);
}

router.post("/sync", async (req, res) => {
  const uid = Number(req.user?.sub);
  if (!Number.isFinite(uid)) return res.status(401).json({ error: "unauthorized" });

  const list = Array.isArray(req.body?.contacts) ? req.body.contacts : null;
  if (!list) return res.status(400).json({ error: "contacts array required" });

  await migrate();

  // Collapse by number first: one person is often several address-book rows
  // (mobile, home, WhatsApp), and inserting each would fight the unique
  // index row by row.
  const byPhone = new Map();
  for (const c of list.slice(0, MAX_CONTACTS)) {
    const phone = normalizePhone(c?.phone);
    const name = String(c?.name ?? "").trim().slice(0, 120);
    if (!phone || !name) continue;
    byPhone.set(phone, name);
  }
  if (byPhone.size === 0) return res.json({ stored: 0 });

  const now = Date.now();
  const values = [];
  const params = [];
  let i = 1;
  for (const [phone, name] of byPhone) {
    values.push(`($${i++}, $${i++}, $${i++}, $${i++})`);
    params.push(uid, name, phone, now);
  }

  // A re-sync should reflect renames, so the name is refreshed on conflict.
  await db.query(
    `INSERT INTO contacts (user_id, name, phone, updated_at)
     VALUES ${values.join(",")}
     ON CONFLICT (user_id, phone)
     DO UPDATE SET name = EXCLUDED.name, updated_at = EXCLUDED.updated_at`,
    params
  );

  res.json({ stored: byPhone.size });
});

// GET /contacts/resolve?name=… — server-side name→number resolution, used
// by the app when the DEVICE contact lookup finds nothing (contact saved
// under a nickname). Checks the caller's own synced address book and their
// clients, and nothing else.
router.get("/resolve", async (req, res) => {
  const uid = Number(req.user?.sub);
  const name = String(req.query.name || "").trim();
  if (!Number.isInteger(uid) || uid <= 0 || !name) {
    return res.json({ match: null, candidates: [] });
  }
  try {
    const out = await require("../users/resolve").resolveContact(uid, name, { limit: 4 });
    // ONLY THE CALLER'S OWN CONTACTS AND CLIENTS (owner, 2026-11-28). There
    // used to be a fallback here to every app user: a name that matched
    // exactly one account returned that person's mobile number to anyone
    // who asked. A number is given out by the person it belongs to, when
    // they share their contact — never by a search.
    res.json(out);
  } catch (e) {
    console.error("contacts resolve failed:", e.message);
    res.json({ match: null, candidates: [] });
  }
});

module.exports = router;
module.exports.migrate = migrate;

/**
 * PRO STORE — the advocate's case diary and the business owner's deals
 * and invoices. (The doctor's clinic lives in src/clinic; the shared
 * pieces — clients, follow-ups, dues ledger, appointments — are reused.)
 * -------------------------------------------------------------------------
 *   pro_cases      one matter per row: client, title, case number, court,
 *                  opposite party, stage, open/closed
 *   pro_hearings   dated hearings of a case; remind_client → the assistant
 *                  phones the client the day before (proactive sweep)
 *   pro_invoices   invoices AND quotes: numbered per user and kind
 *                  (INV-0001, QT-0001), items, optional GST, total, status,
 *                  and the payment link that settles it
 *   pro_leads      deals in the pipeline: new → contacted → proposal →
 *                  won / lost, with a follow-up date
 *
 * Money is stored in PAISE (integers). Self-migrating like practice/store.
 */
const { query, one, run } = require("../db");

let migrated = null;
function migrate() {
  if (!migrated) {
    migrated = run(`
      CREATE TABLE IF NOT EXISTS pro_cases (
        id             BIGSERIAL PRIMARY KEY,
        user_id        INTEGER NOT NULL,
        client_id      BIGINT,
        title          TEXT NOT NULL,
        case_number    TEXT NOT NULL DEFAULT '',
        court          TEXT NOT NULL DEFAULT '',
        opposite_party TEXT NOT NULL DEFAULT '',
        stage          TEXT NOT NULL DEFAULT '',
        status         TEXT NOT NULL DEFAULT 'open',
        notes          TEXT NOT NULL DEFAULT '',
        created_at     BIGINT NOT NULL,
        updated_at     BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_pro_cases_user ON pro_cases(user_id, status, updated_at DESC);
      CREATE TABLE IF NOT EXISTS pro_hearings (
        id            BIGSERIAL PRIMARY KEY,
        user_id       INTEGER NOT NULL,
        case_id       BIGINT NOT NULL,
        at            BIGINT NOT NULL,
        purpose       TEXT NOT NULL DEFAULT '',
        outcome       TEXT NOT NULL DEFAULT '',
        status        TEXT NOT NULL DEFAULT 'upcoming',
        remind_client INTEGER NOT NULL DEFAULT 1,
        reminded_at   BIGINT NOT NULL DEFAULT 0,
        created_at    BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_pro_hearings_user ON pro_hearings(user_id, at);
      CREATE INDEX IF NOT EXISTS idx_pro_hearings_remind ON pro_hearings(status, remind_client, reminded_at, at);
      CREATE TABLE IF NOT EXISTS pro_invoices (
        id                 BIGSERIAL PRIMARY KEY,
        user_id            INTEGER NOT NULL,
        client_id          BIGINT,
        kind               TEXT NOT NULL DEFAULT 'invoice',
        number             TEXT NOT NULL,
        items              TEXT NOT NULL DEFAULT '[]',
        subtotal_paise     BIGINT NOT NULL DEFAULT 0,
        gst_rate           NUMERIC NOT NULL DEFAULT 0,
        gst_paise          BIGINT NOT NULL DEFAULT 0,
        total_paise        BIGINT NOT NULL DEFAULT 0,
        notes              TEXT NOT NULL DEFAULT '',
        status             TEXT NOT NULL DEFAULT 'issued',
        due_at             BIGINT,
        payment_request_id BIGINT,
        payment_url        TEXT NOT NULL DEFAULT '',
        document_id        BIGINT,
        created_at         BIGINT NOT NULL,
        updated_at         BIGINT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_pro_invoices_number ON pro_invoices(user_id, kind, number);
      CREATE INDEX IF NOT EXISTS idx_pro_invoices_pay ON pro_invoices(payment_request_id);
      CREATE TABLE IF NOT EXISTS pro_leads (
        id              BIGSERIAL PRIMARY KEY,
        user_id         INTEGER NOT NULL,
        name            TEXT NOT NULL,
        company         TEXT NOT NULL DEFAULT '',
        phone           TEXT NOT NULL DEFAULT '',
        value_paise     BIGINT NOT NULL DEFAULT 0,
        stage           TEXT NOT NULL DEFAULT 'new',
        next_follow_up  BIGINT,
        note            TEXT NOT NULL DEFAULT '',
        client_id       BIGINT,
        created_at      BIGINT NOT NULL,
        updated_at      BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_pro_leads_user ON pro_leads(user_id, stage, next_follow_up);
    `).catch((e) => {
      console.error("pro migration failed:", e.message);
      migrated = null;
    });
  }
  return migrated;
}

const clean = (s, n) => String(s ?? "").trim().slice(0, n);
const toPaise = (rupees) => Math.round(Number(rupees || 0) * 100);
const toRupees = (paise) => Math.round(Number(paise || 0)) / 100;

/* ================================================================== */
/* Cases + hearings (advocates)                                        */
/* ================================================================== */

function caseShape(r) {
  return {
    id: Number(r.id),
    clientId: r.client_id == null ? null : Number(r.client_id),
    clientName: r.client_name || "",
    clientPhone: r.client_phone || "",
    title: r.title,
    caseNumber: r.case_number || "",
    court: r.court || "",
    oppositeParty: r.opposite_party || "",
    stage: r.stage || "",
    status: r.status,
    notes: r.notes || "",
    nextHearingAt: r.next_hearing_at == null ? null : Number(r.next_hearing_at),
    nextHearingPurpose: r.next_hearing_purpose || "",
    updatedAt: Number(r.updated_at),
  };
}

function hearingShape(r) {
  return {
    id: Number(r.id),
    caseId: Number(r.case_id),
    caseTitle: r.case_title || "",
    caseNumber: r.case_number || "",
    court: r.court || "",
    clientName: r.client_name || "",
    clientPhone: r.client_phone || "",
    at: Number(r.at),
    purpose: r.purpose || "",
    outcome: r.outcome || "",
    status: r.status,
    remindClient: Number(r.remind_client) === 1,
    reminded: Number(r.reminded_at) > 0,
  };
}

const CASE_SELECT = `
  SELECT c.*, cl.name AS client_name, cl.phone AS client_phone,
         h.at AS next_hearing_at, h.purpose AS next_hearing_purpose
    FROM pro_cases c
    LEFT JOIN clients cl ON cl.id = c.client_id AND cl.user_id = c.user_id
    LEFT JOIN LATERAL (
      SELECT at, purpose FROM pro_hearings
       WHERE case_id = c.id AND user_id = c.user_id AND status = 'upcoming' AND at >= $2
       ORDER BY at ASC LIMIT 1
    ) h ON TRUE`;

async function listCases(userId, { status = "open", now = Date.now() } = {}) {
  await migrate();
  const rows = await query(
    `${CASE_SELECT} WHERE c.user_id = $1 ${status ? "AND c.status = $3" : ""}
      ORDER BY h.at ASC NULLS LAST, c.updated_at DESC LIMIT 300`,
    status ? [userId, now, status] : [userId, now]
  );
  return rows.map(caseShape);
}

async function getCase(userId, id, now = Date.now()) {
  await migrate();
  const r = await one(`${CASE_SELECT} WHERE c.user_id = $1 AND c.id = $3`, [userId, now, Number(id)]);
  return r ? caseShape(r) : null;
}

async function createCase(userId, c) {
  await migrate();
  const title = clean(c.title, 200);
  if (!title) throw new Error("case title required");
  const now = Date.now();
  const r = await one(
    `INSERT INTO pro_cases (user_id, client_id, title, case_number, court, opposite_party, stage, notes, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) RETURNING id`,
    [userId, c.clientId ? Number(c.clientId) : null, title, clean(c.caseNumber, 80),
     clean(c.court, 160), clean(c.oppositeParty, 200), clean(c.stage, 80), clean(c.notes, 4000), now]
  );
  return getCase(userId, r.id);
}

async function updateCase(userId, id, patch = {}) {
  await migrate();
  const sets = [];
  const vals = [Number(id), userId];
  const add = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
  const map = { title: ["title", 200], caseNumber: ["case_number", 80], court: ["court", 160],
    oppositeParty: ["opposite_party", 200], stage: ["stage", 80], notes: ["notes", 4000] };
  for (const [k, [col, n]] of Object.entries(map)) if (patch[k] !== undefined) add(col, clean(patch[k], n));
  if (patch.status === "open" || patch.status === "closed") add("status", patch.status);
  if (patch.clientId !== undefined) add("client_id", patch.clientId ? Number(patch.clientId) : null);
  if (!sets.length) return getCase(userId, id);
  add("updated_at", Date.now());
  const r = await one(`UPDATE pro_cases SET ${sets.join(", ")} WHERE id = $1 AND user_id = $2 RETURNING id`, vals);
  return r ? getCase(userId, id) : null;
}

const HEARING_SELECT = `
  SELECT h.*, c.title AS case_title, c.case_number, c.court,
         cl.name AS client_name, cl.phone AS client_phone
    FROM pro_hearings h
    JOIN pro_cases c ON c.id = h.case_id AND c.user_id = h.user_id
    LEFT JOIN clients cl ON cl.id = c.client_id AND cl.user_id = c.user_id`;

async function addHearing(userId, caseId, { at, purpose, remindClient }) {
  await migrate();
  const when = Number(at);
  if (!Number.isFinite(when)) throw new Error("hearing date required");
  const c = await one("SELECT id FROM pro_cases WHERE id = $1 AND user_id = $2", [Number(caseId), userId]);
  if (!c) return null;
  const r = await one(
    `INSERT INTO pro_hearings (user_id, case_id, at, purpose, remind_client, created_at)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [userId, c.id, when, clean(purpose, 200), remindClient === false ? 0 : 1, Date.now()]
  );
  await run("UPDATE pro_cases SET updated_at = $1 WHERE id = $2", [Date.now(), c.id]);
  return one(`${HEARING_SELECT} WHERE h.id = $1`, [r.id]).then(hearingShape);
}

async function listHearings(userId, { caseId, from, to, limit = 200 } = {}) {
  await migrate();
  const vals = [userId];
  let where = "h.user_id = $1";
  if (caseId) { vals.push(Number(caseId)); where += ` AND h.case_id = $${vals.length}`; }
  if (from != null) { vals.push(Number(from)); where += ` AND h.at >= $${vals.length}`; }
  if (to != null) { vals.push(Number(to)); where += ` AND h.at < $${vals.length}`; }
  vals.push(Math.min(Number(limit) || 200, 500));
  const rows = await query(`${HEARING_SELECT} WHERE ${where} ORDER BY h.at ASC LIMIT $${vals.length}`, vals);
  return rows.map(hearingShape);
}

async function updateHearing(userId, id, patch = {}) {
  await migrate();
  const sets = [];
  const vals = [Number(id), userId];
  const add = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
  if (["upcoming", "done", "adjourned", "cancelled"].includes(patch.status)) add("status", patch.status);
  if (patch.outcome !== undefined) add("outcome", clean(patch.outcome, 1000));
  if (patch.at !== undefined && Number.isFinite(Number(patch.at))) { add("at", Number(patch.at)); add("reminded_at", 0); }
  if (!sets.length) return null;
  const r = await one(`UPDATE pro_hearings SET ${sets.join(", ")} WHERE id = $1 AND user_id = $2 RETURNING id`, vals);
  return r ? one(`${HEARING_SELECT} WHERE h.id = $1`, [r.id]).then(hearingShape) : null;
}

/** Hearings whose CLIENT should be called: upcoming, 2–20 h away, a number on file. */
async function hearingsNeedingReminder(now = Date.now()) {
  await migrate();
  return query(
    `SELECT h.*, c.title AS case_title, c.court, cl.name AS client_name, cl.phone AS client_phone,
            u.name AS advocate_name
       FROM pro_hearings h
       JOIN pro_cases c ON c.id = h.case_id AND c.user_id = h.user_id
       JOIN clients cl ON cl.id = c.client_id AND cl.user_id = c.user_id
       JOIN users u ON u.id = h.user_id
      WHERE h.status = 'upcoming' AND h.remind_client = 1 AND h.reminded_at = 0
        AND cl.phone <> ''
        AND h.at >= $1::bigint + 2 * 3600 * 1000 AND h.at <= $1::bigint + 20 * 3600 * 1000
      ORDER BY h.at ASC LIMIT 25`,
    [now]
  );
}

/** Claims the one reminder call. False when another sweep already did. */
async function markHearingReminded(id) {
  await migrate();
  const n = await run(
    "UPDATE pro_hearings SET reminded_at = $1 WHERE id = $2 AND reminded_at = 0",
    [Date.now(), Number(id)]);
  return n > 0;
}

/* ================================================================== */
/* Invoices + quotes (business; advocates may bill too)                */
/* ================================================================== */

/**
 * Totals from items, in paise. Pure — unit-tested.
 * items: [{description, qty, rate}] (rate in rupees)
 */
function computeTotals(items, gstRate = 0) {
  const clean = (Array.isArray(items) ? items : [])
    .map((i) => ({
      description: String(i?.description ?? "").trim().slice(0, 200),
      qty: Math.max(0, Math.min(Number(i?.qty) || 0, 1e6)),
      ratePaise: Math.max(0, toPaise(i?.rate)),
    }))
    .filter((i) => i.description && i.qty > 0)
    .slice(0, 50);
  const lines = clean.map((i) => ({ ...i, amountPaise: Math.round(i.qty * i.ratePaise) }));
  const subtotal = lines.reduce((s, l) => s + l.amountPaise, 0);
  const rate = [0, 5, 12, 18, 28].includes(Number(gstRate)) ? Number(gstRate) : 0;
  const gst = Math.round((subtotal * rate) / 100);
  return { lines, subtotalPaise: subtotal, gstRate: rate, gstPaise: gst, totalPaise: subtotal + gst };
}

function invoiceShape(r) {
  let items = [];
  try { items = JSON.parse(r.items || "[]"); } catch (_) {}
  return {
    id: Number(r.id),
    clientId: r.client_id == null ? null : Number(r.client_id),
    clientName: r.client_name || "",
    kind: r.kind,
    number: r.number,
    items: items.map((l) => ({ description: l.description, qty: l.qty, rate: toRupees(l.ratePaise), amount: toRupees(l.amountPaise) })),
    subtotal: toRupees(r.subtotal_paise),
    gstRate: Number(r.gst_rate),
    gst: toRupees(r.gst_paise),
    total: toRupees(r.total_paise),
    notes: r.notes || "",
    status: r.status,
    dueAt: r.due_at == null ? null : Number(r.due_at),
    paymentUrl: r.payment_url || "",
    documentId: r.document_id == null ? null : Number(r.document_id),
    createdAt: Number(r.created_at),
  };
}

async function nextNumber(userId, kind) {
  const prefix = kind === "quote" ? "QT" : "INV";
  const r = await one(
    `SELECT COUNT(*)::int AS n FROM pro_invoices WHERE user_id = $1 AND kind = $2`, [userId, kind]);
  return `${prefix}-${String((r?.n || 0) + 1).padStart(4, "0")}`;
}

async function createInvoice(userId, { clientId, kind, items, gstRate, notes, dueAt }) {
  await migrate();
  const k = kind === "quote" ? "quote" : "invoice";
  const t = computeTotals(items, gstRate);
  if (!t.lines.length) throw new Error("add at least one item with a quantity");
  const now = Date.now();
  // Retry once on a numbering race (two invoices created at the same time).
  for (let attempt = 0; attempt < 2; attempt++) {
    const number = await nextNumber(userId, k);
    try {
      const r = await one(
        `INSERT INTO pro_invoices (user_id, client_id, kind, number, items, subtotal_paise, gst_rate, gst_paise,
           total_paise, notes, status, due_at, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13) RETURNING *`,
        [userId, clientId ? Number(clientId) : null, k, number, JSON.stringify(t.lines), t.subtotalPaise,
         t.gstRate, t.gstPaise, t.totalPaise, clean(notes, 1000), k === "quote" ? "sent" : "issued",
         dueAt ? Number(dueAt) : null, now]
      );
      return r;
    } catch (e) {
      if (attempt === 1 || !/duplicate key/i.test(e.message)) throw e;
    }
  }
  return null;
}

async function getInvoiceRow(userId, id) {
  await migrate();
  return one(
    `SELECT i.*, cl.name AS client_name FROM pro_invoices i
       LEFT JOIN clients cl ON cl.id = i.client_id AND cl.user_id = i.user_id
      WHERE i.id = $1 AND i.user_id = $2`, [Number(id), userId]);
}

async function listInvoices(userId, { kind, status, limit = 200 } = {}) {
  await migrate();
  const vals = [userId];
  let where = "i.user_id = $1";
  if (kind) { vals.push(kind); where += ` AND i.kind = $${vals.length}`; }
  if (status) { vals.push(status); where += ` AND i.status = $${vals.length}`; }
  vals.push(Math.min(Number(limit) || 200, 500));
  const rows = await query(
    `SELECT i.*, cl.name AS client_name FROM pro_invoices i
       LEFT JOIN clients cl ON cl.id = i.client_id AND cl.user_id = i.user_id
      WHERE ${where} ORDER BY i.created_at DESC LIMIT $${vals.length}`, vals);
  return rows.map(invoiceShape);
}

async function setInvoiceFields(userId, id, fields) {
  await migrate();
  const sets = [];
  const vals = [Number(id), userId];
  const add = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
  if (fields.status && ["issued", "sent", "paid", "cancelled", "accepted"].includes(fields.status)) add("status", fields.status);
  if (fields.paymentRequestId !== undefined) add("payment_request_id", fields.paymentRequestId);
  if (fields.paymentUrl !== undefined) add("payment_url", clean(fields.paymentUrl, 300));
  if (fields.documentId !== undefined) add("document_id", fields.documentId);
  if (!sets.length) return getInvoiceRow(userId, id);
  add("updated_at", Date.now());
  await run(`UPDATE pro_invoices SET ${sets.join(", ")} WHERE id = $1 AND user_id = $2`, vals);
  return getInvoiceRow(userId, id);
}

/**
 * Razorpay said a payment link was paid: settle the invoice it belongs to
 * and record the payment in the client's ledger. Idempotent — an invoice
 * already marked paid is left alone (Razorpay retries webhooks).
 */
async function onPaymentPaid(paymentRow) {
  if (!paymentRow?.id) return null;
  await migrate();
  const inv = await one(
    `UPDATE pro_invoices SET status = 'paid', updated_at = $2
      WHERE payment_request_id = $1 AND status <> 'paid' RETURNING *`,
    [Number(paymentRow.id), Date.now()]
  ).catch(() => null);
  if (inv && inv.client_id) {
    try {
      await require("../practice/store").addLedger(inv.user_id, {
        clientId: inv.client_id, amount: toRupees(inv.total_paise), kind: "paid", note: `${inv.number} paid online`,
      });
    } catch (_) {}
  }
  return inv;
}

/* ================================================================== */
/* Leads (business)                                                    */
/* ================================================================== */

const STAGES = ["new", "contacted", "proposal", "won", "lost"];

function leadShape(r) {
  return {
    id: Number(r.id),
    name: r.name,
    company: r.company || "",
    phone: r.phone || "",
    value: toRupees(r.value_paise),
    stage: r.stage,
    nextFollowUp: r.next_follow_up == null ? null : Number(r.next_follow_up),
    note: r.note || "",
    clientId: r.client_id == null ? null : Number(r.client_id),
    updatedAt: Number(r.updated_at),
  };
}

async function listLeads(userId, { open = true } = {}) {
  await migrate();
  const rows = await query(
    `SELECT * FROM pro_leads WHERE user_id = $1 ${open ? "AND stage NOT IN ('won','lost')" : ""}
      ORDER BY next_follow_up ASC NULLS LAST, updated_at DESC LIMIT 300`, [userId]);
  return rows.map(leadShape);
}

async function createLead(userId, l) {
  await migrate();
  const name = clean(l.name, 120);
  if (!name) throw new Error("lead name required");
  const now = Date.now();
  const r = await one(
    `INSERT INTO pro_leads (user_id, name, company, phone, value_paise, stage, next_follow_up, note, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) RETURNING *`,
    [userId, name, clean(l.company, 160), clean(l.phone, 40), Math.max(0, toPaise(l.value)),
     STAGES.includes(l.stage) ? l.stage : "new", l.nextFollowUp ? Number(l.nextFollowUp) : null,
     clean(l.note, 1000), now]
  );
  return leadShape(r);
}

async function updateLead(userId, id, patch = {}) {
  await migrate();
  const sets = [];
  const vals = [Number(id), userId];
  const add = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
  if (patch.name !== undefined) add("name", clean(patch.name, 120));
  if (patch.company !== undefined) add("company", clean(patch.company, 160));
  if (patch.phone !== undefined) add("phone", clean(patch.phone, 40));
  if (patch.value !== undefined) add("value_paise", Math.max(0, toPaise(patch.value)));
  if (STAGES.includes(patch.stage)) add("stage", patch.stage);
  if (patch.nextFollowUp !== undefined) add("next_follow_up", patch.nextFollowUp ? Number(patch.nextFollowUp) : null);
  if (patch.note !== undefined) add("note", clean(patch.note, 1000));
  if (patch.clientId !== undefined) add("client_id", patch.clientId ? Number(patch.clientId) : null);
  if (!sets.length) return null;
  add("updated_at", Date.now());
  const r = await one(`UPDATE pro_leads SET ${sets.join(", ")} WHERE id = $1 AND user_id = $2 RETURNING *`, vals);
  return r ? leadShape(r) : null;
}

/** USER_TABLES rows for privacy export / erase (routes/privacy.js). */
const USER_TABLES = [
  ["pro_cases", "user_id"],
  ["pro_hearings", "user_id"],
  ["pro_invoices", "user_id"],
  ["pro_leads", "user_id"],
];

module.exports = {
  migrate, USER_TABLES, STAGES,
  listCases, getCase, createCase, updateCase,
  addHearing, listHearings, updateHearing, hearingsNeedingReminder, markHearingReminded,
  computeTotals, createInvoice, getInvoiceRow, listInvoices, setInvoiceFields, invoiceShape, onPaymentPaid,
  listLeads, createLead, updateLead, leadShape,
  toPaise, toRupees,
};

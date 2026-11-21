/**
 * ACTION AUDIT LOG (Phase 1, item 1.7 · ADR-004 "audit before autonomy")
 * ---------------------------------------------------------------------
 * Every externally-visible or destructive thing the assistant does gets one
 * row here: orders placed, calls dialed, calendar events created, email
 * drafts written, documents saved/deleted, reminders set/removed. The user
 * can export it (/privacy/export) and erase it with their account
 * (/privacy/account) — it is THEIR data.
 *
 * Design rules:
 *   • record() NEVER throws and never blocks the action path — a broken
 *     audit write must not turn a successful food order into a 500. Failures
 *     are logged to stderr for ops visibility instead. (Trade-off noted in
 *     ADR-004: we fail open on logging, closed on autonomy — new autonomous
 *     features may not ship unless their happy path calls record().)
 *   • `detail` is a short human sentence for the privacy screen. Callers
 *     must not put secrets, tokens or full message bodies in it.
 *   • Append-only by convention: this module exposes no update/delete;
 *     erasure happens only via the privacy transaction.
 *
 * Action name convention: '<noun>.<verb past-tense>' — 'reminder.created',
 * 'document.deleted', 'call.placed', 'clinic.appointment.created'.
 */
const { run } = require("../db");

const MAX_DETAIL = 300;

/**
 * Fire-and-forget audit write.
 * @param {string|number} userId
 * @param {string} action  dotted past-tense name, e.g. 'reminder.created'
 * @param {string} [detail] short human-readable summary (truncated to 300 chars)
 * @returns {Promise<void>} resolves even on failure (see design rules)
 */
async function record(userId, action, detail = "") {
  try {
    const uid = Number(userId);
    if (!Number.isFinite(uid)) return; // dev/anonymous sessions are not audited
    await run(
      `INSERT INTO actions_log (user_id, action, detail, created_at)
       VALUES ($1, $2, $3, $4)`,
      [uid, String(action).slice(0, 100), String(detail).slice(0, MAX_DETAIL), Date.now()]
    );
  } catch (e) {
    console.error("audit: write failed (action continued):", e.message);
  }
}

module.exports = { record };

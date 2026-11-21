/**
 * BOOKINGS MADE THROUGH A CONTACT'S ASSISTANT (owner, 2026-11-21: "book an
 * appointment with any doctor or advocate … it should register on their
 * end and send back the time … and I should see it at the top").
 *
 * One row per booking ties the two sides together:
 *   host side   a clinic appointment (doctor / advocate / business: their
 *               real hours and slots) or a reminder (anyone else)
 *   caller side a reminder, a confirmation in their inbox, and the
 *               "Next Appointment" strip on Home (GET /brief → appointments)
 *
 * Cancel and reschedule work from either end: the caller through the
 * host's assistant (guest tools) or Home; the host by changing the clinic
 * appointment, which tells the caller (onClinicChange).
 */
const { one, query, run, tx } = require("../db");

const PRO = new Set(["doctor", "advocate", "business"]);
const ACTIVE = "booked";
const MODE_WORDS = { in_person: "In person", online: "Online", phone: "Phone call" };

let migrated = null;
function migrate() {
  if (!migrated) {
    migrated = run(`
      CREATE TABLE IF NOT EXISTS connect_bookings (
        id               BIGSERIAL PRIMARY KEY,
        caller_id        INTEGER NOT NULL,
        host_id          INTEGER NOT NULL,
        starts_at        BIGINT NOT NULL,
        minutes          INTEGER NOT NULL DEFAULT 30,
        mode             TEXT NOT NULL DEFAULT 'in_person',
        purpose          TEXT NOT NULL DEFAULT '',
        details          TEXT NOT NULL DEFAULT '',
        kind             TEXT NOT NULL DEFAULT 'meeting',   -- clinic | meeting
        clinic_appt_id   BIGINT,
        host_reminder_id BIGINT,
        caller_reminder_id BIGINT,
        urgent           INTEGER NOT NULL DEFAULT 0,
        status           TEXT NOT NULL DEFAULT 'booked',    -- booked | cancelled | done | no_show
        cancelled_by     TEXT NOT NULL DEFAULT '',
        tz_offset_min    INTEGER NOT NULL DEFAULT 330,
        created_at       BIGINT NOT NULL,
        updated_at       BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_connect_bookings_caller ON connect_bookings(caller_id, starts_at);
      CREATE INDEX IF NOT EXISTS idx_connect_bookings_host ON connect_bookings(host_id, starts_at);
      CREATE INDEX IF NOT EXISTS idx_connect_bookings_appt ON connect_bookings(clinic_appt_id);
    `).catch((e) => {
      migrated = null;
      throw e;
    });
  }
  return migrated;
}

const firstName = (s) => String(s || "").trim().split(/\s+/)[0] || "";
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Mon 24 Nov, 1:00 pm" in the given timezone. */
function when(ms, tz = 330) {
  const d = new Date(Number(ms) + tz * 60_000);
  const h = d.getUTCHours(), m = d.getUTCMinutes();
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}, ` +
    `${h12}:${String(m).padStart(2, "0")} ${h < 12 ? "am" : "pm"}`;
}

/** A display name for the host: "Dr Meera" for a doctor. */
function hostLabel(host) {
  const name = String(host.contact_name || host.name || "").trim() || "your contact";
  return host.persona === "doctor" && !/^dr\.?\s/i.test(name) ? `Dr ${name}` : name;
}

async function record(b) {
  await migrate();
  const t = Date.now();
  return one(
    `INSERT INTO connect_bookings
       (caller_id, host_id, starts_at, minutes, mode, purpose, details, kind, clinic_appt_id,
        host_reminder_id, caller_reminder_id, urgent, tz_offset_min, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14) RETURNING *`,
    [b.callerId, b.hostId, b.startsAt, b.minutes, b.mode, b.purpose || "", b.details || "",
     b.kind, b.clinicApptId || null, b.hostReminderId || null, b.callerReminderId || null,
     b.urgent ? 1 : 0, b.tz ?? 330, t]);
}

/** The caller's active booking with this host on that local day, if any. */
async function sameDay(callerId, hostId, dayStart, dayEnd) {
  await migrate();
  return one(
    `SELECT * FROM connect_bookings WHERE caller_id=$1 AND host_id=$2 AND status=$3
       AND starts_at >= $4 AND starts_at < $5 ORDER BY starts_at LIMIT 1`,
    [callerId, hostId, ACTIVE, dayStart, dayEnd]);
}

/** The caller's upcoming bookings with this host. */
async function withHost(callerId, hostId) {
  await migrate();
  return query(
    `SELECT * FROM connect_bookings WHERE caller_id=$1 AND host_id=$2 AND status=$3
       AND starts_at > $4 ORDER BY starts_at LIMIT 10`,
    [callerId, hostId, ACTIVE, Date.now() - 30 * 60_000]);
}

/** What Home's top strip shows: my next bookings, with whom and where. */
async function upcomingFor(userId, { days = 14, limit = 5 } = {}) {
  await migrate();
  const rows = await query(
    `SELECT b.*, u.name AS host_name, u.persona AS host_persona, u.profession AS host_profession
       FROM connect_bookings b JOIN users u ON u.id = b.host_id
      WHERE b.caller_id=$1 AND b.status=$2 AND b.starts_at > $3 AND b.starts_at < $4
      ORDER BY b.starts_at LIMIT $5`,
    [userId, ACTIVE, Date.now() - 15 * 60_000, Date.now() + days * 86_400_000, limit]);
  return rows.map(shape);
}

function shape(r) {
  const persona = r.host_persona || "";
  const name = String(r.host_name || "").trim();
  return {
    id: Number(r.id),
    with: persona === "doctor" && name && !/^dr\.?\s/i.test(name) ? `Dr ${name}` : name,
    profession: r.host_profession || "",
    at: Number(r.starts_at),
    minutes: Number(r.minutes),
    mode: r.mode,
    modeLabel: MODE_WORDS[r.mode] || "",
    purpose: r.purpose || "",
    details: r.details || "",
    when: when(r.starts_at, Number(r.tz_offset_min) || 330),
  };
}

/** Message + push to one user, from another (the inbox their assistant reads). */
async function notify(toUserId, fromUserId, text, title) {
  const to = await one(`SELECT phone_number, fcm_token FROM users WHERE id=$1`, [toUserId]);
  if (!to?.phone_number) return;
  await run(
    `INSERT INTO agent_messages (from_user_id, to_phone_number, message, created_at) VALUES ($1,$2,$3,$4)`,
    [fromUserId, to.phone_number, text, Date.now()]);
  if (to.fcm_token) {
    await require("../services/push").sendNotification(to.fcm_token, title, text.slice(0, 140),
      { kind: "agent_message" }).catch(() => false);
  }
}

/** The caller's confirmation: what, with whom, when, how. */
async function confirmToCaller(booking, host, place) {
  const label = hostLabel(host);
  const text = `Confirmed: ${booking.purpose || "Appointment"} with ${label} on ` +
    `${when(booking.starts_at, booking.tz_offset_min)} (${MODE_WORDS[booking.mode] || booking.mode}` +
    `${place ? `, ${place}` : ""}).`;
  await notify(booking.caller_id, booking.host_id, text, `Appointment Confirmed With ${label}`);
}

async function findActive(callerId, hostId, id) {
  const list = await withHost(callerId, hostId);
  if (id) return list.find((b) => Number(b.id) === Number(id)) || null;
  return list.length === 1 ? list[0] : list.length ? { ambiguous: list } : null;
}

/** Cancels on the host's side (clinic appointment or reminder) and the caller's reminder. */
async function undoSides(b) {
  if (b.clinic_appt_id) {
    await require("../clinic/store").updateAppointment(Number(b.host_id), b.clinic_appt_id, { status: "cancelled" }).catch(() => null);
  }
  const reminders = require("../reminders/store");
  if (b.host_reminder_id) await reminders.remove(Number(b.host_id), Number(b.host_reminder_id)).catch(() => false);
  if (b.caller_reminder_id) await reminders.remove(Number(b.caller_id), Number(b.caller_reminder_id)).catch(() => false);
}

/** The caller cancels (via the host's assistant or Home). */
async function cancelByCaller(callerId, bookingId, { hostId = null } = {}) {
  await migrate();
  const b = await one(
    `UPDATE connect_bookings SET status='cancelled', cancelled_by='caller', updated_at=$3
      WHERE id=$1 AND caller_id=$2 AND status='booked' ${hostId ? "AND host_id=$4" : ""} RETURNING *`,
    hostId ? [bookingId, callerId, Date.now(), hostId] : [bookingId, callerId, Date.now()]);
  if (!b) return null;
  await undoSides(b);
  const caller = await one(`SELECT name FROM users WHERE id=$1`, [callerId]);
  const who = caller?.name || "A caller";
  await notify(b.host_id, b.caller_id,
    `${who} cancelled: ${b.purpose || "appointment"} on ${when(b.starts_at, b.tz_offset_min)}.`,
    `${firstName(who)} Cancelled an Appointment`);
  return b;
}

/**
 * The caller moves a booking to a new time the host has free. The host's
 * side moves (clinic appointment or reminder), the caller's reminder too,
 * and both are told. `isFree(startsAt)` checks the host's calendar.
 */
async function reschedule(callerId, b, startsAt, { isFree, host, tz }) {
  await migrate();
  const reminders = require("../reminders/store");
  const caller = await one(`SELECT name FROM users WHERE id=$1`, [callerId]);
  const ok = await tx(async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtext('connect_slot'), $1)", [Number(b.host_id)]);
    if (!(await isFree(startsAt))) return false;
    if (b.clinic_appt_id) {
      await require("../clinic/store").updateAppointment(Number(b.host_id), b.clinic_appt_id, { startsAt });
    } else if (b.host_reminder_id) {
      await reminders.remove(Number(b.host_id), Number(b.host_reminder_id)).catch(() => false);
      const r = await reminders.create(Number(b.host_id),
        `Meeting with ${caller?.name || "a caller"}: ${b.purpose} | ${b.details} (moved by your assistant)`,
        startsAt, b.urgent ? "alarm" : "gentle", { tzOffsetMin: tz });
      b.host_reminder_id = r?.id || null;
    }
    return true;
  });
  if (!ok) return null;
  if (b.caller_reminder_id) await reminders.remove(Number(callerId), Number(b.caller_reminder_id)).catch(() => false);
  const mine = await reminders.create(Number(callerId),
    `Meeting with ${hostLabel(host)}: ${b.purpose} | ${b.details}`, startsAt, "gentle", { tzOffsetMin: tz });
  const row = await one(
    `UPDATE connect_bookings SET starts_at=$2, host_reminder_id=$3, caller_reminder_id=$4, tz_offset_min=$5, updated_at=$6
      WHERE id=$1 RETURNING *`,
    [b.id, startsAt, b.host_reminder_id || null, mine?.id || null, tz, Date.now()]);
  const who = caller?.name || "A caller";
  await notify(b.host_id, b.caller_id,
    `${who} moved ${b.purpose || "the appointment"} to ${when(startsAt, tz)}.`,
    `${firstName(who)} Moved an Appointment`);
  await confirmToCaller(row, host, "");
  return row;
}

/**
 * The host changed a clinic appointment (cancelled, no-show, done, moved):
 * the booking follows, and the caller is told when it affects them.
 */
async function onClinicChange(hostId, appt) {
  await migrate();
  if (!appt) return;
  const b = await one(`SELECT * FROM connect_bookings WHERE clinic_appt_id=$1 AND host_id=$2`, [appt.id, hostId]);
  if (!b || b.status !== ACTIVE) return;
  const host = await one(`SELECT id, name, persona FROM users WHERE id=$1`, [hostId]);
  const label = hostLabel(host || {});
  if (appt.status === "cancelled") {
    await run(`UPDATE connect_bookings SET status='cancelled', cancelled_by='host', updated_at=$2 WHERE id=$1`, [b.id, Date.now()]);
    if (b.caller_reminder_id) {
      await require("../reminders/store").remove(Number(b.caller_id), Number(b.caller_reminder_id)).catch(() => false);
    }
    await notify(b.caller_id, hostId,
      `${label} cancelled your appointment on ${when(b.starts_at, b.tz_offset_min)}. Talk to their assistant to book another time.`,
      `Appointment Cancelled by ${label}`);
  } else if (appt.status === "done" || appt.status === "no_show") {
    await run(`UPDATE connect_bookings SET status=$2, updated_at=$3 WHERE id=$1`, [b.id, appt.status, Date.now()]);
  } else if (Number(appt.starts_at) !== Number(b.starts_at)) {
    await run(`UPDATE connect_bookings SET starts_at=$2, updated_at=$3 WHERE id=$1`, [b.id, Number(appt.starts_at), Date.now()]);
    await notify(b.caller_id, hostId,
      `${label} moved your appointment to ${when(appt.starts_at, b.tz_offset_min)}.`,
      `Appointment Moved by ${label}`);
  }
}

const USER_TABLES = [["connect_bookings", "caller_id"]];

module.exports = {
  migrate, record, sameDay, withHost, upcomingFor, findActive, cancelByCaller, reschedule,
  onClinicChange, confirmToCaller, when, hostLabel, PRO, MODE_WORDS, USER_TABLES,
};

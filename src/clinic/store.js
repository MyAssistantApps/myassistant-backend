/**
 * CLINIC STORE — the doctor's clinic profile and appointment book.
 * -------------------------------------------------------------------------
 *   clinic_profiles      one row per doctor: clinic name, address, phone,
 *                        consultation fee, registration number,
 *                        qualifications, weekly timings, slot length, and
 *                        whether the phone receptionist may book.
 *   clinic_appointments  the appointment book. Booked from the app, by
 *                        voice, or by the receptionist on a live call.
 *
 * The slot engine (freeSlots) is a pure function: timings minus what is
 * already booked, in the DOCTOR's timezone. The receptionist offers only
 * slots it produced, and re-checks the slot is still free at the moment of
 * booking, so two callers can never be given the same 10:15.
 *
 * Self-migrating like practice/store.js — no db.js change needed.
 */
const { query, one, run } = require("../db");

const DAY = 24 * 3600 * 1000;
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/** Mon–Sat 10–1 and 5–8: the commonest Indian OPD pattern, editable. */
const DEFAULT_HOURS = {
  mon: [["10:00", "13:00"], ["17:00", "20:00"]],
  tue: [["10:00", "13:00"], ["17:00", "20:00"]],
  wed: [["10:00", "13:00"], ["17:00", "20:00"]],
  thu: [["10:00", "13:00"], ["17:00", "20:00"]],
  fri: [["10:00", "13:00"], ["17:00", "20:00"]],
  sat: [["10:00", "13:00"]],
  sun: [],
};

const STATUSES = new Set(["booked", "arrived", "done", "cancelled", "no_show"]);
const ACTIVE = ["booked", "arrived"]; // these occupy a slot

let migrated = null;
function migrate() {
  if (!migrated) {
    migrated = run(`
      CREATE TABLE IF NOT EXISTS clinic_profiles (
        user_id            INTEGER PRIMARY KEY,
        clinic_name        TEXT NOT NULL DEFAULT '',
        address            TEXT NOT NULL DEFAULT '',
        phone              TEXT NOT NULL DEFAULT '',
        fee                NUMERIC NOT NULL DEFAULT 0,
        reg_no             TEXT NOT NULL DEFAULT '',
        qualification      TEXT NOT NULL DEFAULT '',
        hours              TEXT NOT NULL DEFAULT '',
        slot_min           INTEGER NOT NULL DEFAULT 15,
        receptionist_books INTEGER NOT NULL DEFAULT 0,
        updated_at         BIGINT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS clinic_appointments (
        id             BIGSERIAL PRIMARY KEY,
        user_id        INTEGER NOT NULL,
        client_id      BIGINT,
        patient_name   TEXT NOT NULL,
        patient_phone  TEXT NOT NULL DEFAULT '',
        starts_at      BIGINT NOT NULL,
        duration_min   INTEGER NOT NULL DEFAULT 15,
        reason         TEXT NOT NULL DEFAULT '',
        status         TEXT NOT NULL DEFAULT 'booked',
        source         TEXT NOT NULL DEFAULT 'app',
        remind_patient INTEGER NOT NULL DEFAULT 1,
        reminded_at    BIGINT NOT NULL DEFAULT 0,
        created_at     BIGINT NOT NULL,
        updated_at     BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_appts_user_time ON clinic_appointments(user_id, starts_at);
      CREATE INDEX IF NOT EXISTS idx_appts_remind ON clinic_appointments(status, remind_patient, reminded_at, starts_at);
    `).catch((e) => {
      console.error("clinic migration failed:", e.message);
      migrated = null;
    });
  }
  return migrated;
}

const clean = (s, n) => String(s ?? "").trim().slice(0, n);

/* ------------------------------------------------------------------ */
/* Timings                                                             */
/* ------------------------------------------------------------------ */

const HM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const toMin = (hm) => {
  const m = HM.exec(hm);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/**
 * Validates a weekly timetable. Bad days or ranges are DROPPED, never
 * guessed at — a wrong guess is a patient turning up to a shut door.
 */
function cleanHours(h) {
  const out = {};
  const src = h && typeof h === "object" ? h : {};
  for (const d of DAYS) {
    const ranges = Array.isArray(src[d]) ? src[d] : [];
    out[d] = ranges
      .filter((r) => Array.isArray(r) && r.length === 2)
      .map(([a, b]) => [String(a), String(b)])
      .filter(([a, b]) => toMin(a) !== null && toMin(b) !== null && toMin(a) < toMin(b))
      .sort((x, y) => toMin(x[0]) - toMin(y[0]))
      .slice(0, 4);
  }
  return out;
}

function parseHours(text) {
  try {
    const h = JSON.parse(text || "");
    return cleanHours(h);
  } catch (_) {
    return cleanHours(DEFAULT_HOURS);
  }
}

/** "Mon–Fri 10am–1pm, 5pm–8pm; Sat 10am–1pm; Sun closed" — for callers. */
function describeHours(hours) {
  const fmt = (hm) => {
    const m = toMin(hm);
    const h = Math.floor(m / 60);
    const mm = m % 60;
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${h12}${mm ? `:${String(mm).padStart(2, "0")}` : ""}${h < 12 ? "am" : "pm"}`;
  };
  const label = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };
  const order = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
  const key = (d) => JSON.stringify(hours[d] || []);
  const groups = [];
  for (const d of order) {
    const last = groups[groups.length - 1];
    if (last && last.key === key(d)) last.days.push(d);
    else groups.push({ key: key(d), days: [d] });
  }
  return groups.map((g) => {
    const days = g.days.length > 1
      ? `${label[g.days[0]]}–${label[g.days[g.days.length - 1]]}`
      : label[g.days[0]];
    const r = hours[g.days[0]] || [];
    return r.length ? `${days} ${r.map(([a, b]) => `${fmt(a)}–${fmt(b)}`).join(", ")}` : `${days} closed`;
  }).join("; ");
}

/* ------------------------------------------------------------------ */
/* Slot engine (pure)                                                  */
/* ------------------------------------------------------------------ */

/** Local midnight (epoch ms) of the day containing `t`. */
function localMidnight(t, tzOffsetMin) {
  const off = tzOffsetMin * 60 * 1000;
  return Math.floor((t + off) / DAY) * DAY - off;
}

/**
 * Free slot start times on the local day beginning at `dayStart`.
 *   hours    cleaned timetable
 *   slotMin  slot length
 *   booked   [{starts_at, duration_min}] ACTIVE appointments that day
 *   now      slots starting before now + leadMin are not offered
 */
function freeSlots({ hours, slotMin = 15, booked = [], dayStart, tzOffsetMin = 330, now = Date.now(), leadMin = 30 }) {
  const off = tzOffsetMin * 60 * 1000;
  const dow = DAYS[new Date(dayStart + off).getUTCDay()];
  const ranges = hours[dow] || [];
  const step = Math.max(5, Math.min(Number(slotMin) || 15, 120)) * 60 * 1000;
  const busy = booked.map((b) => [Number(b.starts_at), Number(b.starts_at) + (Number(b.duration_min) || 15) * 60 * 1000]);
  const earliest = now + leadMin * 60 * 1000;
  const out = [];
  for (const [a, b] of ranges) {
    const startMs = dayStart + toMin(a) * 60 * 1000;
    const endMs = dayStart + toMin(b) * 60 * 1000;
    for (let t = startMs; t + step <= endMs; t += step) {
      if (t < earliest) continue;
      const clash = busy.some(([s, e]) => t < e && t + step > s);
      if (!clash) out.push(t);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Profile                                                             */
/* ------------------------------------------------------------------ */

function profileShape(r, userId) {
  return {
    userId: Number(r?.user_id || userId),
    clinicName: r?.clinic_name || "",
    address: r?.address || "",
    phone: r?.phone || "",
    fee: Number(r?.fee || 0),
    regNo: r?.reg_no || "",
    qualification: r?.qualification || "",
    hours: r ? parseHours(r.hours) : cleanHours(DEFAULT_HOURS),
    slotMin: Number(r?.slot_min || 15),
    receptionistBooks: Number(r?.receptionist_books || 0) === 1,
    configured: Boolean(r),
  };
}

async function getProfile(userId) {
  await migrate();
  const r = await one("SELECT * FROM clinic_profiles WHERE user_id = $1", [userId]);
  if (r) return profileShape(r, userId);
  // First open: seed the clinic name from the registration step.
  const u = await one("SELECT organisation FROM users WHERE id = $1", [userId]).catch(() => null);
  return { ...profileShape(null, userId), clinicName: u?.organisation || "" };
}

async function saveProfile(userId, patch = {}) {
  await migrate();
  const cur = await getProfile(userId);
  const next = {
    clinicName: patch.clinicName !== undefined ? clean(patch.clinicName, 120) : cur.clinicName,
    address: patch.address !== undefined ? clean(patch.address, 300) : cur.address,
    phone: patch.phone !== undefined ? clean(patch.phone, 40) : cur.phone,
    fee: patch.fee !== undefined ? Math.max(0, Math.min(Number(patch.fee) || 0, 1e6)) : cur.fee,
    regNo: patch.regNo !== undefined ? clean(patch.regNo, 60) : cur.regNo,
    qualification: patch.qualification !== undefined ? clean(patch.qualification, 120) : cur.qualification,
    hours: patch.hours !== undefined ? cleanHours(patch.hours) : cur.hours,
    slotMin: patch.slotMin !== undefined
      ? Math.max(5, Math.min(Math.round(Number(patch.slotMin) || 15), 120)) : cur.slotMin,
    receptionistBooks: patch.receptionistBooks !== undefined ? patch.receptionistBooks === true : cur.receptionistBooks,
  };
  await run(
    `INSERT INTO clinic_profiles
       (user_id, clinic_name, address, phone, fee, reg_no, qualification, hours, slot_min, receptionist_books, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (user_id) DO UPDATE SET
       clinic_name=$2, address=$3, phone=$4, fee=$5, reg_no=$6, qualification=$7,
       hours=$8, slot_min=$9, receptionist_books=$10, updated_at=$11`,
    [userId, next.clinicName, next.address, next.phone, next.fee, next.regNo,
     next.qualification, JSON.stringify(next.hours), next.slotMin,
     next.receptionistBooks ? 1 : 0, Date.now()]
  );
  return getProfile(userId);
}

/* ------------------------------------------------------------------ */
/* Appointments                                                        */
/* ------------------------------------------------------------------ */

function apptShape(r) {
  return {
    id: Number(r.id),
    clientId: r.client_id == null ? null : Number(r.client_id),
    patientName: r.patient_name,
    patientPhone: r.patient_phone || "",
    startsAt: Number(r.starts_at),
    durationMin: Number(r.duration_min),
    reason: r.reason || "",
    status: r.status,
    source: r.source,
    remindPatient: Number(r.remind_patient) === 1,
    reminded: Number(r.reminded_at) > 0,
  };
}

async function listAppointments(userId, { from, to, includeClosed = true, limit = 200 } = {}) {
  await migrate();
  const params = [userId, Number(from), Number(to)];
  const statusClause = includeClosed ? "" : `AND status IN ('booked','arrived')`;
  params.push(Math.min(Number(limit) || 200, 500));
  return query(
    `SELECT * FROM clinic_appointments
      WHERE user_id = $1 AND starts_at >= $2 AND starts_at < $3 ${statusClause}
      ORDER BY starts_at ASC LIMIT $4`,
    params
  );
}

async function activeOnDay(userId, dayStart) {
  return listAppointments(userId, { from: dayStart, to: dayStart + DAY, includeClosed: false });
}

async function slotsFor(userId, dayStart, { tzOffsetMin = 330, now = Date.now() } = {}) {
  const [p, booked] = await Promise.all([getProfile(userId), activeOnDay(userId, dayStart)]);
  return freeSlots({ hours: p.hours, slotMin: p.slotMin, booked, dayStart, tzOffsetMin, now });
}

/** Next `max` free slots from now, across up to `days` days. */
async function nextFreeSlots(userId, { tzOffsetMin = 330, days = 3, max = 12, now = Date.now() } = {}) {
  const out = [];
  let day = localMidnight(now, tzOffsetMin);
  for (let i = 0; i < days && out.length < max; i++, day += DAY) {
    const s = await slotsFor(userId, day, { tzOffsetMin, now });
    out.push(...s.slice(0, max - out.length));
  }
  return out;
}

class SlotTakenError extends Error {
  constructor() { super("that time is no longer free"); this.code = "slot_taken"; }
}

/**
 * Books an appointment. With `requireFreeSlot` (the receptionist path) the
 * time must be one the slot engine would offer RIGHT NOW — re-checked here,
 * not trusted from the conversation.
 */
async function createAppointment(userId, a, { requireFreeSlot = false, tzOffsetMin = 330 } = {}) {
  await migrate();
  const starts = Number(a.startsAt);
  if (!Number.isFinite(starts)) throw new Error("startsAt required");
  const name = clean(a.patientName, 120);
  if (!name) throw new Error("patient name required");
  const p = await getProfile(userId);
  if (requireFreeSlot) {
    const free = await slotsFor(userId, localMidnight(starts, tzOffsetMin), { tzOffsetMin });
    if (!free.includes(starts)) throw new SlotTakenError();
  }
  const now = Date.now();
  const row = await one(
    `INSERT INTO clinic_appointments
       (user_id, client_id, patient_name, patient_phone, starts_at, duration_min, reason,
        status, source, remind_patient, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'booked',$8,$9,$10,$10) RETURNING *`,
    [userId, a.clientId ? Number(a.clientId) : null, name, clean(a.patientPhone, 40), starts,
     Math.max(5, Math.min(Number(a.durationMin) || p.slotMin, 240)), clean(a.reason, 200),
     ["app", "voice", "receptionist"].includes(a.source) ? a.source : "app",
     a.remindPatient === false ? 0 : 1, now]
  );
  return row;
}

async function getAppointment(userId, id) {
  await migrate();
  return one("SELECT * FROM clinic_appointments WHERE id = $1 AND user_id = $2", [Number(id), userId]);
}

async function updateAppointment(userId, id, patch = {}) {
  await migrate();
  const cur = await getAppointment(userId, id);
  if (!cur) return null;
  const sets = [];
  const vals = [Number(id), userId];
  const add = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
  if (patch.status !== undefined && STATUSES.has(patch.status)) add("status", patch.status);
  if (patch.startsAt !== undefined && Number.isFinite(Number(patch.startsAt))) {
    add("starts_at", Number(patch.startsAt));
    add("reminded_at", 0); // a moved appointment deserves a fresh reminder
  }
  if (patch.reason !== undefined) add("reason", clean(patch.reason, 200));
  if (patch.clientId !== undefined) add("client_id", patch.clientId ? Number(patch.clientId) : null);
  if (!sets.length) return cur;
  add("updated_at", Date.now());
  return one(`UPDATE clinic_appointments SET ${sets.join(", ")} WHERE id = $1 AND user_id = $2 RETURNING *`, vals);
}

/**
 * Appointments whose patient should get a reminder call now: booked,
 * reminders on, never reminded, a number on file, starting 2–16 hours from
 * now. Not closer than 2 h — a call 20 minutes before is a nuisance, not a
 * reminder — and never for the past.
 */
async function appointmentsNeedingReminder(now = Date.now()) {
  await migrate();
  return query(
    `SELECT a.*, u.name AS doctor_name
       FROM clinic_appointments a JOIN users u ON u.id = a.user_id
      WHERE a.status = 'booked' AND a.remind_patient = 1 AND a.reminded_at = 0
        AND a.patient_phone <> ''
        AND a.starts_at >= $1 + 2 * 3600 * 1000
        AND a.starts_at <= $1 + 16 * 3600 * 1000
      ORDER BY a.starts_at ASC LIMIT 25`,
    [now]
  );
}

async function markReminded(id) {
  await migrate();
  await run("UPDATE clinic_appointments SET reminded_at = $1 WHERE id = $2", [Date.now(), Number(id)]);
}

module.exports = {
  migrate, DEFAULT_HOURS, DAYS,
  cleanHours, parseHours, describeHours, toMin,
  localMidnight, freeSlots, slotsFor, nextFreeSlots,
  getProfile, saveProfile,
  apptShape, listAppointments, createAppointment, getAppointment, updateAppointment,
  appointmentsNeedingReminder, markReminded,
  SlotTakenError, ACTIVE,
};

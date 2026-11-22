/**
 * WORKSPACE STORE — which pack routines a user switched on, and the day
 * plan made for them.
 *
 *   workspace_routines  one row per routine switched on: the repeating
 *                       reminder it created, so switching it off removes
 *                       exactly that reminder (and a deleted reminder reads
 *                       as "off" — the reminder is the truth).
 *   workspace_days      the plan of the day (JSON blocks), one per local day,
 *                       so reopening the workspace does not pay for it again.
 *
 * Both are per user: listed in routes/privacy.js USER_TABLES (export and
 * account erase), and migrated by the privacy tests.
 */
const { one, query, run } = require("../db");

let migrated = null;
/** Idempotent and memoised; every function below awaits it. */
function migrate() {
  if (!migrated) {
    migrated = run(`
    CREATE TABLE IF NOT EXISTS workspace_routines (
      user_id     BIGINT  NOT NULL,
      pack        TEXT    NOT NULL,
      routine     TEXT    NOT NULL,
      reminder_id BIGINT  NOT NULL,
      time        TEXT    NOT NULL DEFAULT '',
      created_at  BIGINT  NOT NULL,
      PRIMARY KEY (user_id, pack, routine)
    );
    CREATE TABLE IF NOT EXISTS workspace_days (
      user_id     BIGINT  NOT NULL,
      day         TEXT    NOT NULL,
      pack        TEXT    NOT NULL,
      plan        TEXT    NOT NULL DEFAULT '{}',
      created_at  BIGINT  NOT NULL,
      PRIMARY KEY (user_id, day)
    );
  `).catch((e) => {
      migrated = null;
      throw e;
    });
  }
  return migrated;
}

/** Routines switched on for this pack, whose reminder still exists. */
async function routinesOn(userId, pack) {
  await migrate();
  const rows = await query(
    `SELECT w.routine, w.reminder_id, w.time, r.due_at
       FROM workspace_routines w
       JOIN reminders r ON r.id = w.reminder_id AND r.user_id = w.user_id
      WHERE w.user_id = $1 AND w.pack = $2`,
    [userId, pack]);
  return rows.map((x) => ({
    routine: x.routine,
    reminderId: Number(x.reminder_id),
    time: x.time,
    nextAt: x.due_at == null ? null : Number(x.due_at),
  }));
}

async function getRoutine(userId, pack, routine) {
  await migrate();
  return one(
    `SELECT reminder_id, time FROM workspace_routines WHERE user_id=$1 AND pack=$2 AND routine=$3`,
    [userId, pack, routine]);
}

async function saveRoutine(userId, pack, routine, reminderId, time) {
  await migrate();
  await run(
    `INSERT INTO workspace_routines (user_id, pack, routine, reminder_id, time, created_at)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (user_id, pack, routine)
     DO UPDATE SET reminder_id = EXCLUDED.reminder_id, time = EXCLUDED.time, created_at = EXCLUDED.created_at`,
    [userId, pack, routine, reminderId, time, Date.now()]);
}

async function dropRoutine(userId, pack, routine) {
  await migrate();
  await run(`DELETE FROM workspace_routines WHERE user_id=$1 AND pack=$2 AND routine=$3`,
    [userId, pack, routine]);
}

async function dayPlan(userId, day) {
  await migrate();
  const row = await one(`SELECT pack, plan, created_at FROM workspace_days WHERE user_id=$1 AND day=$2`,
    [userId, day]);
  if (!row) return null;
  try {
    return { pack: row.pack, ...JSON.parse(row.plan), createdAt: Number(row.created_at) };
  } catch {
    return null;
  }
}

async function saveDayPlan(userId, day, pack, plan) {
  await migrate();
  await run(
    `INSERT INTO workspace_days (user_id, day, pack, plan, created_at) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (user_id, day) DO UPDATE SET pack = EXCLUDED.pack, plan = EXCLUDED.plan,
       created_at = EXCLUDED.created_at`,
    [userId, day, pack, JSON.stringify(plan), Date.now()]);
}

const USER_TABLES = [
  ["workspace_routines", "user_id"],
  ["workspace_days", "user_id"],
];

module.exports = {
  migrate, routinesOn, getRoutine, saveRoutine, dropRoutine, dayPlan, saveDayPlan, USER_TABLES,
};

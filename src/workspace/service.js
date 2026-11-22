/**
 * WORKSPACE SERVICE — the day of a non-Pro professional, in one answer.
 *
 *   overview(userId, tz)        pack + routines on/off + today's priorities,
 *                               focus, reminders, promises and the day plan
 *   setRoutine(userId, id, on)  a pack routine ⇄ a repeating reminder
 *   planDay(userId, tz)         the AI plan of the day (cached per day), built
 *                               from the pack's day shape and the user's real
 *                               reminders, promises and Today's 3; the pack's
 *                               own day is the fallback, so it never fails
 */
const { one, query } = require("../db");
const packs = require("./packs");
const store = require("./store");
const S = require("../momentum/streak");

class WorkspaceError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

async function userPack(userId) {
  const u = await one(`SELECT profession, persona, name FROM users WHERE id = $1`, [userId]);
  if (!u) throw new WorkspaceError(404, "account not found");
  return { user: u, pack: packs.packFor(u) };
}

/**
 * The next time a routine fires, in epoch ms: today at `time` (user's
 * clock) if still ahead, else the next matching day.
 */
function nextAt(routine, { time = routine.time, tz = 330, now = Date.now() } = {}) {
  const m = HHMM.exec(time);
  if (!m) throw new WorkspaceError(400, "time must be HH:MM");
  const offset = tz * 60_000;
  const local = new Date(now + offset); // fields read in UTC = user's clock
  const at = (y, mo, d) => Date.UTC(y, mo, d, Number(m[1]), Number(m[2])) - offset;
  let y = local.getUTCFullYear(), mo = local.getUTCMonth(), d = local.getUTCDate();
  for (let i = 0; i < 400; i++) {
    const ms = at(y, mo, d);
    const dt = new Date(ms + offset);
    const okDay = routine.repeat === "weekly" ? dt.getUTCDay() === (routine.weekday ?? 1)
      : routine.repeat === "monthly" ? dt.getUTCDate() === Math.min(routine.monthDay ?? 1, 28)
      : true;
    if (okDay && ms > now) return ms;
    const next = new Date(Date.UTC(y, mo, d + 1));
    y = next.getUTCFullYear(); mo = next.getUTCMonth(); d = next.getUTCDate();
  }
  throw new WorkspaceError(500, "could not schedule the routine");
}

/** Today's bounds in epoch ms, by the user's clock. */
function todayBounds(tz, now = Date.now()) {
  const offset = tz * 60_000;
  const l = new Date(now + offset);
  const start = Date.UTC(l.getUTCFullYear(), l.getUTCMonth(), l.getUTCDate()) - offset;
  return { start, end: start + 86_400_000 };
}

async function todayItems(userId, tz) {
  const { start, end } = todayBounds(tz);
  const [rem, prom] = await Promise.all([
    query(
      `SELECT id, text, due_at FROM reminders
        WHERE user_id = $1 AND done = 0 AND due_at >= $2 AND due_at < $3
        ORDER BY due_at LIMIT 20`, [userId, start, end]).catch(() => []),
    query(
      `SELECT id, text, owed_to, due_at FROM commitments
        WHERE user_id = $1 AND status = 'open'
        ORDER BY due_at NULLS LAST LIMIT 10`, [userId]).catch(() => []),
  ]);
  return {
    reminders: rem.map((r) => ({ id: Number(r.id), text: r.text, at: Number(r.due_at) })),
    promises: prom.map((p) => ({
      id: Number(p.id), text: p.text, owedTo: p.owed_to || "",
      dueAt: p.due_at == null ? null : Number(p.due_at),
    })),
  };
}

async function overview(userId, tz = 330) {
  const { user, pack } = await userPack(userId);
  const day = S.localDay(Date.now(), tz);
  const momentum = require("../momentum/service");
  const [on, items, mom, plan] = await Promise.all([
    store.routinesOn(userId, pack.id),
    todayItems(userId, tz),
    momentum.summary(userId, day, { tz }).catch(() => null),
    store.dayPlan(userId, day),
  ]);
  const byId = new Map(on.map((x) => [x.routine, x]));
  return {
    day,
    profession: user.profession || "",
    persona: user.persona || "",
    pack: packs.toClient(pack),
    routines: pack.routines.map((r) => {
      const o = byId.get(r.id);
      return { id: r.id, on: !!o, time: o?.time || r.time, nextAt: o?.nextAt ?? null };
    }),
    today: items,
    momentum: mom,
    plan: plan && plan.pack === pack.id ? plan : null,
  };
}

async function setRoutine(userId, routineId, { on, time } = {}, tz = 330) {
  const { pack } = await userPack(userId);
  const routine = pack.routines.find((r) => r.id === routineId);
  if (!routine) throw new WorkspaceError(404, "unknown routine");
  const reminders = require("../reminders/store");
  const existing = await store.getRoutine(userId, pack.id, routine.id);
  if (existing) {
    await reminders.remove(userId, Number(existing.reminder_id)).catch(() => {});
    await store.dropRoutine(userId, pack.id, routine.id);
  }
  if (on) {
    const t = time && HHMM.test(String(time)) ? String(time) : routine.time;
    const due = nextAt(routine, { time: t, tz });
    const rem = await reminders.create(userId, routine.text, due, "gentle",
      { repeat: routine.repeat, tzOffsetMin: tz });
    if (!rem) throw new WorkspaceError(500, "could not create the reminder");
    await store.saveRoutine(userId, pack.id, routine.id, Number(rem.id), t);
  }
  return overview(userId, tz);
}

const BLOCK_KINDS = new Set(["focus", "meeting", "admin", "break", "task", "personal"]);

function cleanBlocks(list) {
  const out = [];
  for (const x of Array.isArray(list) ? list : []) {
    const start = String(x?.start || ""), end = String(x?.end || "");
    const title = String(x?.title || "").replace(/\s+/g, " ").trim().slice(0, 90);
    if (!HHMM.test(start) || !HHMM.test(end) || !title || end <= start) continue;
    out.push({ start, end, title, kind: BLOCK_KINDS.has(x.kind) ? x.kind : "task" });
  }
  out.sort((p, q) => p.start.localeCompare(q.start));
  return out.slice(0, 12);
}

/**
 * AI plan of the day. `ai` is injectable for tests:
 *   async ({system, prompt}) => ({ blocks:[...], note })
 */
async function planDay(userId, tz = 330, { force = false, ai = askAi } = {}) {
  const { user, pack } = await userPack(userId);
  const day = S.localDay(Date.now(), tz);
  if (!force) {
    const cached = await store.dayPlan(userId, day);
    if (cached && cached.pack === pack.id) return cached;
  }
  const momentum = require("../momentum/service");
  const [items, mom] = await Promise.all([
    todayItems(userId, tz),
    momentum.summary(userId, day, { tz }).catch(() => null),
  ]);
  const fmt = (ms) => {
    const d = new Date(ms + tz * 60_000);
    return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
  };
  const priorities = (mom?.priorities || []).filter((p) => !p.done).map((p) => p.title);
  const nowLocal = fmt(Date.now());
  const prompt = [
    `Profession: ${user.profession || pack.title}. Today is ${day}; the time now is ${nowLocal}.`,
    `Typical day for this profession:\n${pack.day.map((b) => `${b.start}-${b.end} ${b.title} (${b.kind})`).join("\n")}`,
    priorities.length ? `Today's top priorities:\n- ${priorities.join("\n- ")}` : "No priorities set yet.",
    items.reminders.length
      ? `Fixed items today (keep their times):\n${items.reminders.map((r) => `${fmt(r.at)} ${r.text}`).join("\n")}`
      : "No fixed items today.",
    items.promises.length
      ? `Open promises to others:\n${items.promises.map((p) => `- ${p.text}${p.owedTo ? ` (to ${p.owedTo})` : ""}`).join("\n")}`
      : "",
  ].filter(Boolean).join("\n\n");

  let blocks = [];
  let note = "";
  let source = "template";
  try {
    const out = await ai({ system: PLAN_SYSTEM, prompt });
    blocks = cleanBlocks(out?.blocks);
    note = String(out?.note || "").trim().slice(0, 240);
    if (blocks.length) source = "ai";
  } catch { /* the pack's own day below */ }
  if (!blocks.length) {
    blocks = cleanBlocks(pack.day);
    note = "";
  }
  const plan = { day, blocks, note, source };
  await store.saveDayPlan(userId, day, pack.id, plan);
  return { pack: pack.id, ...plan, createdAt: Date.now() };
}

const PLAN_SYSTEM = [
  "You plan one working day as time blocks for a busy person.",
  "Start from their profession's typical day. Put fixed items at their exact times.",
  "Give each top priority a focus block in their best hours, and fit open promises into short task blocks.",
  "Keep breaks. Do not schedule anything before the current time unless it is a fixed item.",
  "Titles: short, specific, in Title Case-free plain English (e.g. \"Finish the payment API tests\").",
  'kind is one of: focus, meeting, admin, break, task, personal. Times are 24-hour "HH:MM".',
  'Also give "note": one sentence of practical advice for the day, no greeting.',
  'Answer JSON only: {"blocks":[{"start":"09:00","end":"10:00","title":"...","kind":"focus"}],"note":"..."}',
].join("\n");

const PLAN_SCHEMA = {
  name: "day_plan",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      blocks: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            start: { type: "string" }, end: { type: "string" },
            title: { type: "string" }, kind: { type: "string", enum: [...BLOCK_KINDS] },
          },
          required: ["start", "end", "title", "kind"],
        },
      },
      note: { type: "string" },
    },
    required: ["blocks", "note"],
  },
};

async function askAi({ system, prompt }) {
  const { generateReply } = require("../services/ai/router");
  const r = await generateReply([{ role: "user", content: prompt }], {
    system, json: true, schema: PLAN_SCHEMA, timeoutMs: 20_000, temperature: 0.3, maxTokens: 900,
  });
  return JSON.parse(r.reply || "{}");
}

module.exports = { overview, setRoutine, planDay, nextAt, cleanBlocks, WorkspaceError };

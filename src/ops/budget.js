/**
 * ─────────────────────────────────────────────────────────────────────────
 *  THE SPEND CIRCUIT-BREAKER (2026-11-15, security hardening).
 *
 *  ops/spend.js has metered every paid call since 2026-10-09, but nothing
 *  read the meter back: one scripted account — or a stolen key used
 *  through us — could spend until OpenAI's own monthly limit stopped it.
 *  On 2026-11-15 an outsider drained most of the month's credit in a day.
 *
 *  check() runs before EVERY server-side OpenAI call (services/ai/openai.js
 *  call()) and refuses it when today's (UTC) metered spend is over:
 *    SPEND_DAILY_USD_GLOBAL   whole server            (default 40, 0 = off)
 *    SPEND_DAILY_USD_USER     one signed-in user      (default 3,  0 = off)
 *  and refuses a NEW realtime voice session past
 *    REALTIME_DAILY_SESSIONS_USER                     (default 150, 0 = off)
 *  — those sessions are billed to the phone's connection, so the meter sees
 *  them only as a count.
 *
 *  The sums are cached for CACHE_MS so a voice turn never waits on them;
 *  spend that lands inside that window can overshoot a cap by one window's
 *  worth, which is the point of a circuit-breaker, not an accountant.
 *
 *  If the database cannot be read the call is ALLOWED (availability over
 *  thrift) and the failure is logged; OpenAI's own project budget is the
 *  backstop for that case (see SECURITY.md).
 *
 *  The admin inbox (feedback/store.alert) hears about the global budget at
 *  50 %, 80 % and 100 %, once per level per day.
 * ─────────────────────────────────────────────────────────────────────────
 */
const CACHE_MS = 30_000;
const DAY_MS = 24 * 3600_000;

class BudgetError extends Error {
  constructor(scope) {
    super("The daily usage limit has been reached. Please try again tomorrow.");
    this.name = "BudgetError";
    // 402, deliberately: not 429/503, which the AI router reads as "the
    // provider is busy" and would retry on the fallback model.
    this.status = 402;
    this.code = "budget_exceeded";
    this.scope = scope; // "global" | "user" | "realtime"
  }
}

function num(name, dflt) {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === "") return dflt;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}

const limits = () => ({
  global: num("SPEND_DAILY_USD_GLOBAL", 40),
  user: num("SPEND_DAILY_USD_USER", 3),
  sessions: num("REALTIME_DAILY_SESSIONS_USER", 150),
});

function dayStart(now = Date.now()) {
  return now - (now % DAY_MS); // 00:00 UTC
}

// key -> { at, day, value }
const cache = new Map();
async function cached(key, now, load) {
  const day = dayStart(now);
  const hit = cache.get(key);
  if (hit && hit.day === day && now - hit.at < CACHE_MS) return hit.value;
  const value = await load(day);
  cache.set(key, { at: now, day, value });
  if (cache.size > 5000) {
    for (const [k, v] of cache) if (now - v.at > CACHE_MS) cache.delete(k);
  }
  return value;
}

function db() {
  return require("../db");
}

async function globalSpend(now) {
  return cached("g", now, async (day) => {
    const r = await db().one(`SELECT COALESCE(SUM(cost_usd),0)::float AS usd FROM ai_spend WHERE at >= $1`, [day]);
    return Number(r && r.usd) || 0;
  });
}

async function userSpend(uid, now) {
  return cached(`u${uid}`, now, async (day) => {
    const r = await db().one(
      `SELECT COALESCE(SUM(cost_usd),0)::float AS usd,
              COUNT(*) FILTER (WHERE feature = 'voice_session')::int AS sessions
         FROM ai_spend WHERE user_id = $1 AND at >= $2`,
      [uid, day]
    );
    return { usd: Number(r && r.usd) || 0, sessions: Number(r && r.sessions) || 0 };
  });
}

// One alert per level per UTC day.
const alerted = new Map(); // level -> day
function maybeAlert(spent, cap, now) {
  if (!cap) return;
  const day = dayStart(now);
  for (const level of [100, 80, 50]) {
    if (spent < (cap * level) / 100) continue;
    if (alerted.get(level) === day) return;
    alerted.set(level, day);
    const summary = level >= 100
      ? `AI spending has reached today's limit ($${cap}). Paid AI features are paused until 00:00 UTC.`
      : `AI spending has reached ${level}% of today's limit ($${spent.toFixed(2)} of $${cap}).`;
    console.warn(`[budget] ${summary}`);
    require("../feedback/store")
      .alert(summary, {
        details: "Check the admin panel's spend page for who and what. If this is unexpected, " +
          "rotate OPENAI_API_KEY (SECURITY.md, incident response).",
        windowMs: DAY_MS,
      })
      .catch(() => {});
    return;
  }
}

/**
 * Throws BudgetError when a call must not be made.
 * @param {{path?: string, userId?: number|null, now?: number}} opts
 */
async function check({ path = "", userId, now = Date.now() } = {}) {
  const lim = limits();
  if (!lim.global && !lim.user && !lim.sessions) return;
  const uid = userId === undefined ? require("./spend").currentUser() : userId;
  try {
    if (lim.global) {
      const g = await globalSpend(now);
      maybeAlert(g, lim.global, now);
      if (g >= lim.global) throw new BudgetError("global");
    }
    if (uid && (lim.user || lim.sessions)) {
      const u = await userSpend(uid, now);
      if (lim.user && u.usd >= lim.user) throw new BudgetError("user");
      if (lim.sessions && String(path).startsWith("/realtime") && u.sessions >= lim.sessions) {
        throw new BudgetError("realtime");
      }
    }
  } catch (e) {
    if (e instanceof BudgetError) {
      console.warn(`[budget] refused ${path || "call"} (${e.scope}${uid ? `, user ${uid}` : ""})`);
      throw e;
    }
    console.warn("[budget] could not read today's spend — allowing:", e && e.message);
  }
}

module.exports = { check, BudgetError, limits, _reset() { cache.clear(); alerted.clear(); } };

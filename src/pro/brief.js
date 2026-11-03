/**
 * THE PROFESSIONAL ASSISTANT'S "TODAY" (2026-11-03).
 *
 * The Doctor's / Advocate's / Business page opens on what needs the busy
 * professional NOW, from their own data — not a menu:
 *   - stats:  follow-ups (or hearings) due, money owed, people on file
 *   - needs:  the specific items, most urgent first, each with the request
 *             that handles it ("Send Ramesh a reminder about the ₹1,500")
 *   - headline / summary / suggestions: one short model call reads the
 *             facts and says what matters and what to do next.
 *
 * Everything factual (stats, needs) is computed here, never by the model,
 * so a number on the card is always the ledger's number. The model only
 * writes the words; when it fails or is slow, a template writes them.
 */
const crypto = require("crypto");
const db = require("../db");
const practice = require("../practice/store");

const DAY_MS = 24 * 60 * 60 * 1000;
const KINDS = ["doctor", "advocate", "business"];
const MODEL_TIMEOUT_MS = 6000;
const CACHE_MS = 30 * 60 * 1000;

/** Words per profession, so every line reads in the user's own trade. */
const WORDS = {
  doctor: { person: "patient", people: "patients", visit: "follow-up", visits: "follow-ups" },
  advocate: { person: "client", people: "clients", visit: "hearing", visits: "hearings" },
  business: { person: "customer", people: "customers", visit: "follow-up", visits: "follow-ups" },
};

const inr = (n) =>
  "₹" + Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 });

function localParts(ms, tzOffsetMin) {
  const d = new Date(ms + tzOffsetMin * 60_000);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth(), day: d.getUTCDate(), wd: d.getUTCDay() };
}

/** "overdue" | "today" | "tomorrow" | "Mon" … — and how urgent it is. */
function when(dueMs, tzOffsetMin, now = Date.now()) {
  if (dueMs < now - 60_000) {
    const a = localParts(now, tzOffsetMin);
    const b = localParts(dueMs, tzOffsetMin);
    const sameDay = a.y === b.y && a.m === b.m && a.day === b.day;
    return sameDay ? { label: "today", tone: "today" } : { label: "overdue", tone: "overdue" };
  }
  const a = localParts(now, tzOffsetMin);
  const b = localParts(dueMs, tzOffsetMin);
  const days = Math.round((Date.UTC(b.y, b.m, b.day) - Date.UTC(a.y, a.m, a.day)) / DAY_MS);
  if (days <= 0) return { label: "today", tone: "today" };
  if (days === 1) return { label: "tomorrow", tone: "soon" };
  return { label: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][b.wd], tone: "soon" };
}

/** The user's own data for the page. Each source fails soft to empty. */
async function factsOf(uid, kind, tzOffsetMin, now = Date.now()) {
  const soft = (p, fallback) => p.catch(() => fallback);
  const [recalls, dues, clientCount, recentNotes, money] = await Promise.all([
    soft(practice.listRecalls(uid, { dueBefore: now + 7 * DAY_MS, limit: 20 }), []),
    soft(practice.pendingDues(uid, 100), []),
    soft(
      db.one(
        "SELECT COUNT(*)::int AS n FROM clients WHERE user_id = $1 AND archived = 0 " +
          "AND kind IN ('patient','client','student','customer')",
        [uid]
      ),
      null
    ),
    soft(
      db.query(
        `SELECT c.name, n.text, n.created_at FROM client_notes n
           JOIN clients c ON c.id = n.client_id AND c.user_id = n.user_id
          WHERE n.user_id = $1 ORDER BY n.created_at DESC LIMIT 3`,
        [uid]
      ),
      []
    ),
    kind === "business"
      ? soft(
          (async () => {
            const fin = require("../routes/finance");
            return fin.summarize(await fin.listItems(uid));
          })(),
          null
        )
      : Promise.resolve(null),
  ]);

  const names = new Map();
  const ids = [...new Set(recalls.map((r) => Number(r.client_id)))];
  if (ids.length) {
    const rows = await soft(
      db.query("SELECT id, name FROM clients WHERE user_id = $1 AND id = ANY($2::bigint[])", [uid, ids]),
      []
    );
    for (const r of rows) names.set(Number(r.id), r.name);
  }

  const visits = recalls
    .filter((r) => names.has(Number(r.client_id)))
    .map((r) => {
      const dueAt = Number(r.due_at);
      return { clientId: Number(r.client_id), name: names.get(Number(r.client_id)),
        note: String(r.note || "").slice(0, 160), dueAt, ...when(dueAt, tzOffsetMin, now) };
    });

  const owed = dues.map((d) => ({ clientId: Number(d.client_id), name: d.name,
    balance: Math.round(Number(d.balance) * 100) / 100 }));
  const owedTotal = Math.round(owed.reduce((s, d) => s + d.balance, 0) * 100) / 100;

  return {
    kind,
    visits,
    owed,
    owedTotal,
    people: Number(clientCount?.n || 0),
    recentNotes: recentNotes.map((n) => ({ name: n.name, text: String(n.text || "").slice(0, 160) })),
    money: money && (money.monthly_income || money.monthly_emi || money.monthly_expense) ? money : null,
  };
}

/** The deterministic part of the page: numbers and the to-do list. */
function cardsOf(f) {
  const w = WORDS[f.kind];
  const dueNow = f.visits.filter((v) => v.tone !== "soon");
  const stats = [
    { key: "visits", label: dueNow.length ? `${w.visits} due` : `${w.visits} this week`,
      value: String(dueNow.length || f.visits.length), alert: dueNow.some((v) => v.tone === "overdue") },
    { key: "owed", label: f.owed.length ? `owed by ${f.owed.length}` : "dues pending",
      value: f.owed.length ? inr(f.owedTotal) : "₹0", alert: false },
    { key: "people", label: f.people === 1 ? w.person : w.people, value: String(f.people), alert: false },
  ];

  const needs = [];
  const rank = { overdue: 0, today: 1, soon: 2 };
  for (const v of [...f.visits].sort((a, b) => rank[a.tone] - rank[b.tone] || a.dueAt - b.dueAt)) {
    const what = v.note || w.visit;
    needs.push({
      kind: "visit",
      tone: v.tone,
      title: f.kind === "advocate" ? `${v.name} — ${w.visit}` : `Follow up with ${v.name}`,
      detail: `${what} · ${v.label}`,
      ask: v.tone === "overdue"
        ? `${v.name}'s ${w.visit} (${what}) is overdue. Help me reschedule it and let ${v.name} know.`
        : `${v.name} has a ${w.visit} ${v.label === "today" || v.label === "tomorrow" ? v.label : "on " + v.label}: ${what}. What should I prepare, and should I remind them?`,
    });
  }
  for (const d of f.owed.slice(0, 3)) {
    needs.push({
      kind: "due",
      tone: "money",
      title: `${d.name} owes ${inr(d.balance)}`,
      detail: "Payment pending",
      ask: `Send ${d.name} a polite reminder about the ${inr(d.balance)} they owe me.`,
    });
  }
  return { stats, needs: needs.slice(0, 5) };
}

/** What the page says when the model is not there. */
function template(f) {
  const w = WORDS[f.kind];
  const overdue = f.visits.filter((v) => v.tone === "overdue").length;
  const today = f.visits.filter((v) => v.tone === "today").length;
  const parts = [];
  if (overdue) parts.push(`${overdue} ${overdue === 1 ? w.visit : w.visits} overdue`);
  if (today) parts.push(`${today} due today`);
  if (f.owed.length) parts.push(`${inr(f.owedTotal)} owed by ${f.owed.length} ${f.owed.length === 1 ? w.person : w.people}`);

  if (!parts.length) {
    return {
      headline: f.people ? "You're all caught up" : `Let's set up your ${w.people}`,
      summary: f.people
        ? `Nothing is due right now across your ${f.people} ${f.people === 1 ? w.person : w.people}. Tell me about a visit, a payment or a note and I'll file it.`
        : `Add your first ${w.person} — just say their name, or type a note below and I'll create their file.`,
      suggestions: f.people
        ? [{ label: `Plan my week`, ask: `Help me plan my week as a ${f.kind === "business" ? "business owner" : f.kind}.` }]
        : [{ label: `Add a ${w.person}`, ask: `I want to add a new ${w.person}.` }],
    };
  }
  const first = parts[0][0].toUpperCase() + parts[0].slice(1);
  const suggestions = [];
  if (overdue || today) suggestions.push({ label: `Plan today's ${w.visits}`, ask: `Go through today's and overdue ${w.visits} with me and help me plan them.` });
  if (f.owed.length) suggestions.push({ label: "Chase pending dues", ask: `Help me remind everyone with pending dues, one by one.` });
  return {
    headline: first,
    summary: parts.length > 1 ? `${first}, and ${parts.slice(1).join(", ")}.` : `${first}.`,
    suggestions,
  };
}

const SYSTEM =
  "You are the assistant on a busy professional's dashboard. You get JSON facts about their " +
  "practice (follow-ups or hearings due, money owed, recent notes). Reply with JSON only: " +
  '{"headline": string, "summary": string, "suggestions": [{"label": string, "ask": string}]}. ' +
  "headline: at most 7 words, the single most important thing right now. " +
  "summary: one or two short sentences, plain and warm, naming real people and amounts from the facts; never invent anyone or any number. " +
  "suggestions: 1 to 3 next steps that save them time; label at most 5 words; ask is the full request in first person, as the professional would say it to their assistant (e.g. \"Draft a reminder to Ravi about his ₹2,000 due\"). " +
  "Use Indian rupees (₹). If nothing is due, say so briefly and suggest something genuinely useful.";

const cache = new Map(); // `${uid}:${kind}` → { hash, at, words }

async function wordsOf(uid, f, now = Date.now()) {
  const facts = {
    profession: f.kind,
    visits: f.visits.slice(0, 8).map((v) => ({ name: v.name, about: v.note, when: v.label })),
    owed: f.owed.slice(0, 6).map((d) => ({ name: d.name, amount: d.balance })),
    owedTotal: f.owedTotal,
    people: f.people,
    recentNotes: f.recentNotes,
    money: f.money,
  };
  const hash = crypto.createHash("sha1").update(JSON.stringify(facts)).digest("hex");
  const key = `${uid}:${f.kind}`;
  const hit = cache.get(key);
  if (hit && hit.hash === hash && now - hit.at < CACHE_MS) return hit.words;

  let words = null;
  try {
    const router = require("../services/ai/router");
    const { reply } = await router.generateReply(
      [{ role: "user", content: JSON.stringify(facts) }],
      { system: SYSTEM, json: true, model: router.envModel("PRO_BRIEF_MODEL", null),
        timeoutMs: MODEL_TIMEOUT_MS, noRetry: true, temperature: 0.4, maxTokens: 400 }
    );
    words = clean(JSON.parse(reply));
  } catch (_) {
    words = null;
  }
  const out = words ? { ...words, source: "model" } : { ...template(f), source: "template" };
  if (words) cache.set(key, { hash, at: now, words: out });
  if (cache.size > 2000) cache.delete(cache.keys().next().value);
  return out;
}

/** The model's reply, held to the shape the app draws. Null if unusable. */
function clean(o) {
  if (!o || typeof o !== "object") return null;
  const str = (s, n) => (typeof s === "string" ? s.trim().slice(0, n) : "");
  const headline = str(o.headline, 70);
  const summary = str(o.summary, 280);
  if (!headline || !summary) return null;
  const suggestions = (Array.isArray(o.suggestions) ? o.suggestions : [])
    .map((s) => ({ label: str(s?.label, 40), ask: str(s?.ask, 300) }))
    .filter((s) => s.label && s.ask)
    .slice(0, 3);
  return { headline, summary, suggestions };
}

async function buildProBrief(uid, kind, { tzOffsetMin = 330, now = Date.now() } = {}) {
  const f = await factsOf(uid, kind, tzOffsetMin, now);
  const { stats, needs } = cardsOf(f);
  const words = await wordsOf(uid, f, now);
  return {
    kind,
    headline: words.headline,
    summary: words.summary,
    suggestions: words.suggestions,
    stats,
    needs,
    source: words.source,
    empty: !f.visits.length && !f.owed.length && !f.people,
  };
}

module.exports = { KINDS, buildProBrief, cardsOf, template, clean, when, _cache: cache };

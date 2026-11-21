/**
 * CONNECT — talk to another person's assistant (owner, 2026-11-21).
 * -------------------------------------------------------------------------
 * "Connect me to Alan's assistant": the caller's app opens a live voice
 * session in which THE MODEL IS ALAN'S ASSISTANT — Alan's assistant name,
 * Alan's chosen voice, Alan's photo in the orb — and it can act for Alan
 * within strict limits:
 *
 *   leave_message      a message waiting in Alan's inbox, read to him by his
 *                      own assistant (agent_messages + a push)
 *   urgent_ping        the same, flagged URGENT with a loud push; capped per
 *                      caller per day so it cannot be used to harass
 *   check_availability free / busy windows on a day — never WHAT he is doing
 *   book_appointment   doctors: a real clinic appointment in a free slot;
 *                      everyone else: an appointment on Alan's reminders and
 *                      the caller's, with Alan told at once
 *   end_call           the caller is done
 *
 * WHO MAY CONNECT. Discovery is the caller's own address book (contacts,
 * synced by the app) matched to VERIFIED app numbers — the same rule the
 * agent messages use: knowing someone's number is what lets you reach
 * their assistant. Each user controls it (users.assistant_open):
 *   'everyone' (default) any app user who has your number
 *   'contacts'           only people whose number is in YOUR contacts too
 *   'off'                nobody
 *
 * PRIVACY. The guest assistant knows only what this file hands it: the
 * owner's first name, profession, assistant name and busy/free times. It
 * never sees their memories, messages, documents or reminder titles.
 */
const { one, query, run, tx } = require("../db");

class ConnectError extends Error {
  constructor(status, message, code = "") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const OPEN_MODES = ["everyone", "contacts", "off"];
const URGENT_PER_DAY = Number(process.env.CONNECT_URGENT_PER_DAY) || 3;
// Messages, bookings and summaries from one caller to one host, per day.
const DELIVER_PER_DAY = Number(process.env.CONNECT_DELIVER_PER_DAY) || 20;
const DAY_START = 9, DAY_END = 18; // working-hours window for free/busy

let migrated = null;
function migrate() {
  if (!migrated) {
    migrated = run(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS assistant_open TEXT NOT NULL DEFAULT 'everyone';
    `).then(() => require("../routes/contacts").migrate()) // contacts is joined; a fresh DB may not have it yet
      .catch((e) => {
      migrated = null;
      throw e;
    });
  }
  return migrated;
}

const firstName = (s) => String(s || "").trim().split(/\s+/)[0] || "";

/** People in my contacts who use the app and accept connections. */
async function people(callerId) {
  await migrate();
  const rows = await query(
    `SELECT DISTINCT ON (u.id)
            u.id, u.name, u.persona, u.profession, u.assistant_open, u.phone_number,
            c.name AS contact_name, a.name AS assistant_name, a.voice
       FROM contacts c
       JOIN users u ON u.phone_number = c.phone AND u.phone_verified_at IS NOT NULL
       LEFT JOIN assistant_profiles a ON a.user_id = u.id
      WHERE c.user_id = $1 AND u.id <> $1 AND u.assistant_open <> 'off'
      ORDER BY u.id, c.updated_at DESC`,
    [callerId]);
  const me = await one(`SELECT phone_number FROM users WHERE id = $1`, [callerId]);
  const out = [];
  for (const r of rows) {
    if (r.assistant_open === "contacts" && !(await hasMyNumber(r.id, me?.phone_number))) continue;
    out.push(await cardFrom(r));
  }
  out.sort((x, y) => x.ownerName.localeCompare(y.ownerName));
  return out;
}

async function hasMyNumber(hostId, myPhone) {
  if (!myPhone) return false;
  const r = await one(`SELECT 1 FROM contacts WHERE user_id = $1 AND phone = $2 LIMIT 1`, [hostId, myPhone]);
  return !!r;
}

async function cardFrom(r) {
  const studio = require("../studio/store");
  const photo = await studio.defaultModel(Number(r.id)).catch(() => null);
  const { nameOrDefault } = require("../users/context");
  return {
    id: Number(r.id),
    // How the CALLER saved them ("Alan Lobo"), else the name on the account.
    ownerName: String(r.contact_name || r.name || "").trim() || "Your contact",
    assistantName: nameOrDefault(r.assistant_name),
    voice: require("../ai/proxy").voiceFor(r.voice),
    profession: r.profession || "",
    persona: r.persona || "",
    hasPhoto: !!photo,
  };
}

/** The host, if the caller may reach them; a ConnectError otherwise. */
async function host(callerId, hostId) {
  await migrate();
  hostId = Number(hostId);
  if (!Number.isInteger(hostId) || hostId <= 0 || hostId === Number(callerId)) {
    throw new ConnectError(404, "That assistant is not available.");
  }
  const r = await one(
    `SELECT u.id, u.name, u.persona, u.profession, u.assistant_open, u.phone_number, u.fcm_token, u.tz_offset_min,
            c.name AS contact_name, a.name AS assistant_name, a.voice
       FROM users u
       JOIN contacts c ON c.user_id = $1 AND c.phone = u.phone_number
       LEFT JOIN assistant_profiles a ON a.user_id = u.id
      WHERE u.id = $2 AND u.phone_verified_at IS NOT NULL
      LIMIT 1`,
    [callerId, hostId]);
  if (!r) throw new ConnectError(404, "That person is not in your contacts on MyAssistant.");
  if (r.assistant_open === "off") throw new ConnectError(403, "This person is not taking assistant calls.", "closed");
  if (r.assistant_open === "contacts") {
    const me = await one(`SELECT phone_number FROM users WHERE id = $1`, [callerId]);
    if (!(await hasMyNumber(hostId, me?.phone_number))) {
      throw new ConnectError(403, "This person only takes assistant calls from their own contacts.", "closed");
    }
  }
  return { row: r, card: await cardFrom(r) };
}

async function caller(callerId) {
  const u = await one(`SELECT id, name, phone_number FROM users WHERE id = $1`, [callerId]);
  if (!u) throw new ConnectError(401, "sign in required");
  return u;
}

/** The guest assistant's instructions: who it is, who it serves, its limits. */
function guestInstructions(card, callerName, nowLine) {
  const owner = firstName(card.ownerName) || "my owner";
  const who = callerName ? firstName(callerName) : "the caller";
  const job = card.profession ? ` ${owner} is a ${card.profession}.` : "";
  return [
    `You are ${card.assistantName}, the personal assistant of ${owner}.${job}`,
    `You are speaking with ${who}, who has ${owner} in their contacts and called ${owner}'s assistant from their own MyAssistant app. ${nowLine}`,
    `Start by introducing yourself in one short sentence, for example: "Hello ${who}, I am ${card.assistantName}, ${owner}'s assistant. How can I help you?"`,
    "",
    // FAST, FOR BUSY PEOPLE (owner, 2026-11-21, after "ask more questions"
    // proved irritating: "much faster ... no confirmation needed ... 'ask
    // Alan to call me' should go directly"). Act at once on anything clear;
    // infer the obvious; ask only for what cannot be guessed, all in ONE
    // question; never read back or ask "are you sure".
    `SPEED FIRST: ${who} is busy. Act IMMEDIATELY when the request is clear. Never read a request back, never ask "shall I go ahead" or "are you sure". Just do it, then say in one short sentence what you did.`,
    "Infer what is obvious instead of asking. Ask a question ONLY when a detail truly cannot be guessed, and then ask for ALL missing details in ONE short question.",
    "",
    `MESSAGES (leave_message): send at once. "Ask ${owner} to call me" → message "Please call ${who} back", action "call back", by_when "as soon as possible", reply_via "call". Fill action, by_when and reply_via yourself from the wording; use "as soon as possible" when no time is given. No questions.`,
    "",
    `URGENT ALERTS (urgent_ping): when ${who} says urgent or emergency, send at once with what they said; infer the action and "right now". No questions.`,
    "",
    "MEETINGS (book_appointment): the only things you may need to ask are the time and the mode. Everything else has a default:",
    "  - date/time: if not given, call check_availability and offer the two earliest free times in ONE question",
    "  - mode: if not given, ask \"Online, in person or a phone call?\" (combine with the time question if both are missing)",
    "  - purpose: from what they said (e.g. \"Meeting\" if nothing more)",
    "  - length 30 minutes, attendees \"just the caller\", place: the link or address they gave, else leave it empty",
    `  - "urgent meeting": earliest free time today or tomorrow, urgent true (${owner} is alerted at once)`,
    "Book as soon as you have a time and a mode.",
    "",
    `AVAILABILITY (check_availability): times only, never what ${owner} is doing.`,
    "End the conversation when they say goodbye (end_call), after a brief, warm goodbye.",
    "",
    "RULES:",
    `- You work for ${owner}. Be warm and VERY brief: one short sentence per reply.`,
    `- You do NOT know ${owner}'s private life: no messages, contacts, documents, location, health, money or plans. If asked, say politely that you cannot share that, and offer to take a message.`,
    `- Never pretend to be ${owner}. Never invent ${owner}'s answers or promises; take a message instead.`,
    "- If a tool answers needs_details, ask for exactly those details in one question, then call it again.",
    "- Never claim something is done unless the tool said ok.",
    "- Speak the caller's language if they switch languages.",
  ].join("\n");
}

const GUEST_TOOLS = [
  {
    name: "leave_message",
    description: "Leave a message for your owner; their own assistant reads it to them. Collect every field and read it back first.",
    parameters: {
      type: "object",
      properties: {
        message: { type: "string", description: "The message, in the caller's words." },
        action_needed: { type: "string", description: "What the owner should do: reply, call back, a specific task, or 'nothing, just informing'." },
        by_when: { type: "string", description: "When the owner should act, e.g. 'today by 5 pm', or 'no deadline'." },
        reply_via: { type: "string", description: "How to reply: call, message, email (with the address), or 'not needed'." },
      },
      required: ["message"],
    },
  },
  {
    name: "urgent_ping",
    description: "Alert your owner's phone at once. Only when the caller says it is urgent. Collect what happened, what the owner must do and by when.",
    parameters: {
      type: "object",
      properties: {
        what_happened: { type: "string", description: "What is urgent, in one or two sentences." },
        action_needed: { type: "string", description: "What the owner must do." },
        by_when: { type: "string", description: "How soon, e.g. 'within 30 minutes', 'right now'." },
      },
      required: ["what_happened"],
    },
  },
  {
    name: "check_availability",
    description: "Free and busy times for your owner on a day, during working hours. Never reveals what they are doing.",
    parameters: {
      type: "object",
      properties: { date: { type: "string", description: "The day, as YYYY-MM-DD." } },
      required: ["date"],
    },
  },
  {
    name: "book_appointment",
    description: "Book a meeting or appointment with your owner, once EVERY detail is collected and the caller said yes to your summary.",
    parameters: {
      type: "object",
      properties: {
        purpose: { type: "string", description: "What the meeting is about." },
        date: { type: "string", description: "YYYY-MM-DD" },
        time: { type: "string", description: "24-hour HH:MM, a free time from check_availability." },
        minutes: { type: "number", description: "Length in minutes." },
        mode: { type: "string", enum: ["in_person", "online", "phone"], description: "How they will meet." },
        place: { type: "string", description: "Address (in person), meeting link or app (online), or the number to call (phone)." },
        attendees: { type: "string", description: "Who attends besides the caller, or 'just the caller'." },
        prepare: { type: "string", description: "What the owner should prepare or bring, or 'nothing'." },
        urgent: { type: "boolean", description: "true when the caller said it is urgent: the owner is alerted at once." },
      },
      required: ["date", "time", "mode"],
    },
  },
  {
    name: "end_call",
    description: "End the conversation after saying goodbye.",
    parameters: { type: "object", properties: {} },
  },
];

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const at = (date, time, tz) => {
  const [y, mo, d] = date.split("-").map(Number);
  const [h, m] = time.split(":").map(Number);
  return Date.UTC(y, mo - 1, d, h, m) - tz * 60_000;
};
const hhmm = (ms, tz) => {
  const d = new Date(ms + tz * 60_000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
};

/** Busy epochs (reminders + promises) for the host in [start, end). */
async function busyTimes(hostId, start, end) {
  // Each source on its own: a failing one must not make the whole day look free.
  const read = (sql) => query(sql, [hostId, start, end]).catch((e) => {
    console.warn("[connect] busy times:", e.message);
    return [];
  });
  const rows = [
    ...(await read(`SELECT due_at FROM reminders WHERE user_id=$1 AND done=0 AND due_at >= $2 AND due_at < $3`)),
    ...(await read(`SELECT due_at FROM commitments WHERE user_id=$1 AND status='open' AND due_at >= $2 AND due_at < $3`)),
  ];
  return rows.map((r) => Number(r.due_at));
}

/** Free 30-minute starts in working hours, skipping the hour of anything booked. */
async function freeSlots(hostRow, date, tz) {
  const hostId = Number(hostRow.id);
  if (hostRow.persona === "doctor") {
    const clinic = require("../clinic/store");
    const startMs = at(date, "00:00", tz);
    const slots = await clinic.slotsFor(hostId, clinic.localMidnight(startMs + 12 * 3600_000, tz), { tzOffsetMin: tz }).catch(() => []);
    return slots.filter((ms) => ms > Date.now()).map((ms) => hhmm(ms, tz));
  }
  const start = at(date, `${String(DAY_START).padStart(2, "0")}:00`, tz);
  const end = at(date, `${String(DAY_END).padStart(2, "0")}:00`, tz);
  const busy = await busyTimes(hostId, start - 3600_000, end);
  const out = [];
  for (let t = start; t < end; t += 30 * 60_000) {
    if (t <= Date.now()) continue;
    if (busy.some((b) => b > t - 60 * 60_000 && b < t + 60 * 60_000)) continue;
    out.push(hhmm(t, tz));
  }
  return out;
}

async function deliver(hostRow, callerRow, text, { urgent = false } = {}) {
  const toPhone = hostRow.phone_number;
  await run(
    `INSERT INTO agent_messages (from_user_id, to_phone_number, message, created_at) VALUES ($1,$2,$3,$4)`,
    [callerRow.id, toPhone, text, Date.now()]);
  if (hostRow.fcm_token) {
    const name = firstName(callerRow.name) || "Someone";
    await require("../services/push").sendNotification(
      hostRow.fcm_token,
      urgent ? `Urgent: ${name} Needs You` : `${name} Left a Message With Your Assistant`,
      urgent ? String(text).replace(/^\[URGENT\]\s*/, "").slice(0, 140)
        : "Please open the app to have your assistant read it to you.",
      { kind: urgent ? "agent_message_urgent" : "agent_message" },
    ).catch(() => false);
  }
}

/** Missing required details → a needs_details answer the model must act on. */
function missing(args, fields) {
  const gone = fields.filter(([k]) => {
    const v = args[k];
    return v === undefined || v === null || String(v).trim() === "";
  });
  if (!gone.length) return null;
  return {
    ok: false,
    needs_details: gone.map(([k]) => k),
    error: `Not done yet. Ask the caller for: ${gone.map(([, q]) => q).join("; ")}. Then call again.`,
  };
}
const clean = (v, n = 200) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const MODE_WORDS = { in_person: "In person", online: "Online", phone: "Phone call" };

/**
 * Runs one guest tool for the caller, acting on the host's behalf.
 * Returns {ok, data?, error?, speak?, end?}.
 */
/** The host's own clock: the times offered and booked are the host's. */
const hostTz = (h, fallback = 330) =>
  h && h.tz_offset_min !== null && h.tz_offset_min !== undefined && Number.isFinite(Number(h.tz_offset_min))
    ? Number(h.tz_offset_min) : fallback;

async function countSent(me, h, { urgentOnly = false } = {}) {
  const r = await one(
    `SELECT COUNT(*)::int AS n FROM agent_messages
      WHERE from_user_id=$1 AND to_phone_number=$2 AND created_at > $3
        ${urgentOnly ? "AND message LIKE '[URGENT]%'" : ""}`,
    [me.id, h.phone_number, Date.now() - 86_400_000]);
  return r?.n || 0;
}

async function runGuestTool(callerId, hostId, name, args = {}, { tz: _callerTz = 330 } = {}) {
  const { row: h, card } = await host(callerId, hostId);
  const me = await caller(callerId);
  const owner = firstName(card.ownerName) || "them";
  const tz = hostTz(h, _callerTz);
  if (["leave_message", "urgent_ping", "book_appointment"].includes(name) &&
      (await countSent(me, h)) >= DELIVER_PER_DAY) {
    return { ok: false, error: `you have reached today's limit of messages to ${owner}; try again tomorrow` };
  }
  switch (name) {
    case "leave_message": {
      // Only the message is required; the rest is filled in, never asked for.
      const need = missing(args, [["message", "the message itself"]]);
      if (need) return need;
      const extra = [
        clean(args.action_needed) && `Action: ${clean(args.action_needed)}`,
        clean(args.by_when, 80) && `By: ${clean(args.by_when, 80)}`,
        clean(args.reply_via, 120) && `Reply via: ${clean(args.reply_via, 120)}`,
      ].filter(Boolean).join(" | ");
      await deliver(h, me,
        `(Left with your assistant ${card.assistantName}) ${clean(args.message, 1000)}` + (extra ? `\n${extra}` : ""));
      return { ok: true, data: { delivered: true }, speak: `Done, ${owner} has your message.` };
    }
    case "urgent_ping": {
      // An older session sends one "message" field.
      if (args.message && !args.what_happened) args = { ...args, what_happened: args.message };
      const need = missing(args, [["what_happened", "what is urgent"]]);
      if (need) return need;
      const msg = [
        clean(args.what_happened, 400),
        clean(args.action_needed) && `Action: ${clean(args.action_needed)}`,
        `By: ${clean(args.by_when, 80) || "right now"}`,
      ].filter(Boolean).join(" | ");
      if ((await countSent(me, h, { urgentOnly: true })) >= URGENT_PER_DAY) {
        return { ok: false, error: `urgent alerts to ${owner} are limited to ${URGENT_PER_DAY} a day; offer to leave a normal message` };
      }
      await deliver(h, me, `[URGENT] ${msg}`, { urgent: true });
      return { ok: true, data: { alerted: true }, speak: `I have alerted ${owner} that this is urgent.` };
    }
    case "check_availability": {
      const date = String(args.date || "");
      if (!DAY_RE.test(date)) return { ok: false, error: "date must be YYYY-MM-DD" };
      const free = await freeSlots(h, date, tz);
      return {
        ok: true,
        data: {
          date,
          free_times: free.slice(0, 16),
          note: free.length ? "Offer two or three of these times." : `No free time that day; suggest another day.`,
        },
      };
    }
    case "book_appointment": {
      // Only the time and the mode can't be guessed; everything else has a
      // default (30 min, "just the caller", place to be shared).
      const need = missing(args, [
        ["date", "the date"],
        ["time", "the time (offer the two earliest free times)"],
        ["mode", "whether it is online, in person or a phone call"],
      ]);
      if (need) return need;
      const date = String(args.date || ""), time = String(args.time || "");
      if (!DAY_RE.test(date) || !TIME_RE.test(time)) return { ok: false, error: "date must be YYYY-MM-DD and time HH:MM" };
      const mode = MODE_WORDS[args.mode] ? args.mode : null;
      if (!mode) return { ok: false, needs_details: ["mode"], error: "Ask whether it is in person, online or a phone call." };
      const startsAt = at(date, time, tz);
      if (startsAt <= Date.now()) return { ok: false, error: "that time has passed; offer the next free time" };
      const minutes = Math.max(10, Math.min(480, Math.round(Number(args.minutes) || 30)));
      const purpose = clean(args.purpose) || "Meeting";
      // An urgent booking rings the host's alarm: it shares the urgent cap.
      const urgent = (args.urgent === true || args.urgent === "true") &&
        (await countSent(me, h, { urgentOnly: true })) < URGENT_PER_DAY;
      const callerName = me.name || "A caller";
      const prep = clean(args.prepare);
      const details =
        `${MODE_WORDS[mode]} | ${minutes} min | ` +
        `${mode === "online" ? "Link" : mode === "phone" ? "Call" : "Place"}: ` +
        `${clean(args.place) || (mode === "phone" ? `${me.phone_number || "caller's number"}` : "to be shared")} | ` +
        `With: ${clean(args.attendees, 120) || "just the caller"}` +
        (prep && !/^(nothing|none|no)$/i.test(prep) ? ` | Prepare: ${prep}` : "");
      if (h.persona === "doctor") {
        const clinic = require("../clinic/store");
        try {
          await clinic.createAppointment(Number(h.id), {
            patientName: callerName, patientPhone: me.phone_number || "", startsAt, source: "assistant",
            reason: `${purpose} (${details})`, durationMin: minutes,
          }, { requireFreeSlot: true, tzOffsetMin: tz });
        } catch (e) {
          if (e instanceof clinic.SlotTakenError) return { ok: false, error: "that slot is no longer free; check availability again" };
          throw e;
        }
      } else {
        // Serialised per host, so two callers can't both take one free time.
        const took = await tx(async (c) => {
          await c.query("SELECT pg_advisory_xact_lock(hashtext('connect_slot'), $1)", [Number(h.id)]);
          const free = await freeSlots(h, date, tz);
          if (!free.includes(time)) return false;
          await require("../reminders/store").create(Number(h.id),
            `${urgent ? "URGENT meeting" : "Meeting"} with ${callerName}: ${purpose} | ${details} (booked by your assistant)`,
            startsAt, urgent ? "alarm" : "gentle", { tzOffsetMin: tz });
          return true;
        });
        if (!took) return { ok: false, error: "that time is not free; check availability and offer another" };
      }
      // The caller's own reminder, and the host told at once (loudly if urgent).
      await require("../reminders/store").create(Number(me.id),
        `Meeting with ${card.ownerName}: ${purpose} | ${details}`, startsAt, "gentle", { tzOffsetMin: tz });
      await deliver(h, me,
        `${urgent ? "[URGENT] " : ""}(Booked by your assistant ${card.assistantName}) ${purpose} on ${date} at ${time} | ${details}`,
        { urgent });
      return {
        ok: true,
        data: { booked: true, date, time, minutes, mode, urgent },
        speak: `Done. You are booked with ${owner} on ${date} at ${time}${urgent ? ", and I have alerted them that it is urgent" : ""}.`,
      };
    }
    case "end_call":
      return { ok: true, data: { ended: true }, end: true };
    default:
      return { ok: false, error: `unknown tool ${name}` };
  }
}

/** What the caller's phone needs to open the session. */
async function sessionFor(callerId, hostId, { tz: _callerTz = 330 } = {}) {
  const { row: h, card } = await host(callerId, hostId);
  const tz = hostTz(h, _callerTz);
  const me = await caller(callerId);
  const now = new Date(Date.now() + tz * 60_000);
  const nowLine = `Today is ${now.toISOString().slice(0, 10)} and the time is ${hhmm(Date.now(), tz)}.`;
  return {
    card,
    instructions: guestInstructions(card, me.name, nowLine),
    tools: GUEST_TOOLS,
    greeting: `[SYSTEM] ${firstName(me.name) || "The caller"} has just connected. Introduce yourself now in one short sentence.`,
  };
}

/** After the call: a short summary for the host, from the transcript. */
async function finish(callerId, hostId, transcript, { ai = summarise } = {}) {
  const { row: h, card } = await host(callerId, hostId);
  const me = await caller(callerId);
  const lines = (Array.isArray(transcript) ? transcript : [])
    .map((t) => `${t.role === "assistant" ? card.assistantName : firstName(me.name) || "Caller"}: ${String(t.text || "").trim()}`)
    .filter((l) => !/:\s*$/.test(l))
    .slice(-40);
  if (lines.length < 2) return { ok: true, summarised: false };
  if ((await countSent(me, h)) >= DELIVER_PER_DAY) return { ok: true, summarised: false };
  let summary = "";
  try {
    summary = String(await ai(lines.join("\n"), firstName(card.ownerName))).trim().slice(0, 600);
  } catch { /* no summary is fine */ }
  if (!summary) return { ok: true, summarised: false };
  await deliver(h, me, `(Call with your assistant ${card.assistantName}) ${summary}`);
  return { ok: true, summarised: true };
}

async function summarise(text, owner) {
  const { generateReply } = require("../services/ai/router");
  const r = await generateReply([{ role: "user", content: text }], {
    system: `Summarise this conversation between ${owner}'s assistant and a caller for ${owner}, in two sentences: what the caller wanted and what was done. No greeting.`,
    timeoutMs: 15_000, temperature: 0.2, maxTokens: 160,
  });
  return r.reply;
}

async function getOpen(userId) {
  await migrate();
  const r = await one(`SELECT assistant_open FROM users WHERE id=$1`, [userId]);
  return r?.assistant_open || "everyone";
}

async function setOpen(userId, mode) {
  if (!OPEN_MODES.includes(mode)) throw new ConnectError(400, "mode must be everyone, contacts or off");
  await migrate();
  await run(`UPDATE users SET assistant_open=$2 WHERE id=$1`, [userId, mode]);
  return mode;
}

/** The host's photo (their default Style Studio photo), if allowed. */
async function photo(callerId, hostId) {
  await host(callerId, hostId);
  const studio = require("../studio/store");
  const p = await studio.defaultModel(Number(hostId));
  if (!p) throw new ConnectError(404, "no photo");
  return require("../studio/run").readDocument(Number(hostId), p.document_id);
}

module.exports = {
  migrate, people, host, sessionFor, runGuestTool, finish, photo, getOpen, setOpen,
  guestInstructions, GUEST_TOOLS, OPEN_MODES, ConnectError,
};

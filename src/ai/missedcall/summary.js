/**
 * MISSED-CALL CALLBACK — THE SUMMARY (2026-11-01).
 *
 * After a callback ends, what was said becomes a summary for the owner.
 * THE MAIN OUTPUT is `summary`: 2 to 5 plain English sentences written to
 * the owner — who called (their name, or "an unknown caller"), exactly why,
 * what they want from the owner, how urgent and why, and any deadline,
 * number or time they mentioned; when they gave no detail, it says so.
 * Secondary data beside it: caller_name, callback_number, urgency,
 * callback_requested, ai_commitments, reply_message, language — null when
 * not said.
 *
 * FROM THE TRANSCRIPT ONLY. Checked here, not just asked for: a name or a
 * phone number that is not in the words, or a vague word ("about
 * business") the caller never used, makes the reply invalid.
 *
 * INPUT is the transcript session.js keeps: [{ role: "caller"|"assistant",
 * text, atMs?, interrupted? }].
 *
 * MODEL: the backend's "smart" text model (openai.models.smart(),
 * OPENAI_SMART_MODEL), overridable with MISSED_CALL_SUMMARY_MODEL — the same
 * envModel pattern as services/docgen.js. The call goes through
 * router.generateReply (as agents/callOutcome.js does): its transient retry
 * and busy fallback apply.
 *
 * STRUCTURED OUTPUT: a fixed JSON schema (openai.chat sends it as
 * response_format json_schema, not strict), so every reply is ALSO checked
 * here (validate). Invalid → one retry with the problems listed → else a
 * clear error. Nothing is stored; summarizeSession() keeps the result on the
 * session object only.
 */
const router = require("../../services/ai/router");
const openai = require("../../services/ai/openai");

const model = () => router.envModel("MISSED_CALL_SUMMARY_MODEL", openai.models.smart());
const MIN_CALLER_WORDS = 2; // fewer words from the caller: nothing to summarize, no model call
const MAX_TRANSCRIPT_CHARS = 20_000; // a 5-minute call is far below this
const MAX_ENTRIES = 500;
const MAX_ENTRY_CHARS = 4_000;
const URGENCY = ["low", "normal", "high"];
const MIN_SENTENCES = 2;
const MAX_SENTENCES = 5;

const str = { type: "string" };
const strOrNull = { type: ["string", "null"] };
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "summary", "caller_name", "callback_number", "urgency", "callback_requested",
    "ai_commitments", "reply_message", "language",
  ],
  properties: {
    summary: {
      ...str,
      description: "2 to 5 plain English sentences to the owner: who called, exactly why, what they want, how urgent and why, any deadline, number or time mentioned.",
    },
    caller_name: { ...strOrNull, description: "The caller's name exactly as said or confirmed by the caller, else null." },
    callback_number: { ...strOrNull, description: "A number the caller said to call back on, digits exactly as said, else null." },
    urgency: { type: ["string", "null"], enum: [...URGENCY, null], description: "From what the caller said only; null if nothing to judge by." },
    callback_requested: { type: "boolean", description: "True only if the caller asked the owner to call or contact them." },
    ai_commitments: { type: "array", items: str, description: "Anything the AI assistant promised on the owner's behalf. Normally empty." },
    reply_message: { ...str, description: "A ready-to-send text from the owner to the caller, in the caller's language; promises nothing." },
    language: { ...strOrNull, description: "The language the caller spoke (e.g. English, Hindi, Kannada), or null if unclear." },
  },
};

const SYSTEM =
  "You summarize the transcript of a phone call. The owner of a phone number missed a call; their AI assistant " +
  "then called the person back to take a message. 'CALLER' is that person; 'AI' is the owner's assistant. " +
  "Answer with ONE JSON object that matches the schema, nothing else.\n" +
  "RULES — everything comes ONLY from the transcript. If something was not said, do not write it, and its field is null. " +
  "Never guess or fill in a name, number, date, time, amount, reason or promise.\n" +
  "summary — the main output, read by the owner:\n" +
  "- 2 to 5 plain sentences, always in English (translate what the caller said), written to the owner.\n" +
  "- Who called: their name exactly as it appears in the transcript, or \"an unknown caller\" if they gave none.\n" +
  "- Exactly why they called and what they want from the owner, with their specific details. Never write vague words " +
  "such as \"about business\", \"a matter\", \"something important\" or \"a general enquiry\" unless the caller used them.\n" +
  "- How urgent it is and why, from their own words. If they gave no sign of urgency, say they did not say it was urgent.\n" +
  "- Every deadline, phone number, time, date or amount they mentioned, exactly as said.\n" +
  "- If the caller gave no detail, say so plainly (for example \"The caller didn't say what it was about.\").\n" +
  "- Refer to the caller by name, as \"the caller\" or as \"they\". Never guess their gender.\n" +
  "- Do not add advice, guesses or anything the AI said that the caller did not confirm.\n" +
  "Secondary fields:\n" +
  "- caller_name: only a name the CALLER said or clearly confirmed. A name the AI suggested and the caller did not confirm is null.\n" +
  "- callback_number: only a number the caller said, written exactly as in the transcript.\n" +
  "- callback_requested is true only if the caller asked to be called or contacted back.\n" +
  "- urgency: from the caller's own words (an emergency, a deadline, 'urgent', 'whenever') — null if they gave nothing to judge by.\n" +
  "- ai_commitments: list every promise the AI made on the owner's behalf (a call back, a time, a payment, a decision, " +
  "an answer). Saying it will pass the message on is NOT a commitment. Normally the list is empty.\n" +
  "- reply_message: a short, polite text the owner could send the caller, in the caller's language and script. It may " +
  "thank them and acknowledge their message. It must NOT promise anything (no call back, no time, no payment, no " +
  "decision): the owner has said nothing yet. Do not use a name the caller did not give.\n" +
  "- language: the language the caller spoke.";

// ---------------------------------------------------------------- transcript

/** A transcript as session.js keeps it, checked; problems listed, never thrown. */
function checkTranscript(t) {
  if (!Array.isArray(t)) return { ok: false, problems: ["transcript must be an array"] };
  if (t.length > MAX_ENTRIES) return { ok: false, problems: [`transcript has more than ${MAX_ENTRIES} entries`] };
  const problems = [];
  const clean = [];
  t.forEach((e, i) => {
    if (!e || typeof e !== "object") return problems.push(`[${i}] is not an object`);
    if (e.role !== "caller" && e.role !== "assistant") problems.push(`[${i}].role must be "caller" or "assistant"`);
    if (typeof e.text !== "string") problems.push(`[${i}].text must be a string`);
    else if (e.text.length > MAX_ENTRY_CHARS) problems.push(`[${i}].text is longer than ${MAX_ENTRY_CHARS} characters`);
    if (!problems.length) clean.push({ role: e.role, text: e.text, interrupted: e.interrupted === true });
  });
  return problems.length ? { ok: false, problems } : { ok: true, transcript: clean };
}

const words = (s) => String(s || "").trim().split(/\s+/u).filter(Boolean);
const callerText = (t) => t.filter((e) => e.role === "caller").map((e) => e.text).join(" ");

function asText(t) {
  const lines = t
    .filter((e) => e.text.trim())
    .map((e) => `${e.role === "caller" ? "CALLER" : "AI"}: ${e.text.replace(/\s+/g, " ").trim()}${e.interrupted ? " [cut off by the caller]" : ""}`);
  let out = lines.join("\n");
  if (out.length > MAX_TRANSCRIPT_CHARS) out = out.slice(0, MAX_TRANSCRIPT_CHARS) + "\n[transcript truncated]";
  return out;
}

// ---------------------------------------------------------------- validation

// Spoken digits, so "nine eight four five…" in a transcript still matches "9845…".
const DIGIT_WORDS = { zero: "0", oh: "0", o: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9" };
function spokenDigits(text) {
  const toks = String(text || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  let out = "";
  for (let i = 0; i < toks.length; i++) {
    const tk = toks[i];
    const rep = tk === "double" ? 2 : tk === "triple" ? 3 : 0;
    if (rep && i + 1 < toks.length) {
      const d = DIGIT_WORDS[toks[i + 1]] || (/^\d$/.test(toks[i + 1]) ? toks[i + 1] : "");
      if (d) { out += d.repeat(rep); i++; continue; }
    }
    if (/^\d+$/.test(tk)) out += tk;
    else if (DIGIT_WORDS[tk] !== undefined) out += DIGIT_WORDS[tk];
    else out += " ";
  }
  return out.replace(/\s+/g, " ");
}
const norm = (s) => String(s || "").toLowerCase().normalize("NFKC").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** Sentences in a paragraph, not fooled by "Mr.", "e.g." or "2.5". */
function sentenceCount(text) {
  const t = String(text || "")
    .replace(/\b(Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|No|vs|etc|approx|Rs)\./gi, "$1")
    .replace(/\b(e\.g|i\.e|a\.m|p\.m)\./gi, (m) => m.replace(/\./g, ""))
    .replace(/(\d)\.(\d)/g, "$1$2");
  return t.split(/[.!?]+(?=\s|$)/).map((s) => s.trim()).filter((s) => /\p{L}/u.test(s)).length;
}

/** Share of letters in Latin script: an English summary is mostly Latin (a name in another script is fine). */
function latinShare(text) {
  const letters = String(text || "").match(/\p{L}/gu) || [];
  if (!letters.length) return 0;
  return letters.filter((c) => /\p{Script=Latin}/u.test(c)).length / letters.length;
}

/**
 * VAGUE WORDS the summary may use only if the caller did: each phrase is
 * allowed when its key word is in what the caller said.
 */
const VAGUE = [
  { re: /\b(?:about|regarding|concerning|re)\s+(?:some\s+|a\s+|his\s+|her\s+|their\s+)?business\b/i, key: "business" },
  { re: /\b(?:some|a|certain|an?\s+important|a\s+personal|a\s+private)\s+matters?\b/i, key: "matter" },
  { re: /\bsome\s+(?:issue|work|thing|stuff)s?\b/i, key: null },
  { re: /\bsomething\s+(?:important|urgent)\b/i, key: null },
  { re: /\bgeneral\s+(?:enquiry|inquiry|query|matter)\b/i, key: null },
  { re: /\bwork[- ]related\b/i, key: "work" },
];

/**
 * Checks a model reply against the schema, then against the transcript.
 * Returns { ok, summary, problems, warnings }: problems make it invalid
 * (retry); warnings are grounding fixes already applied.
 */
function validate(raw, transcript) {
  const problems = [];
  const warnings = [];
  let j = raw;
  if (typeof raw === "string") {
    try { j = JSON.parse(raw.replace(/```json|```/g, "").trim()); } catch (_) { return { ok: false, problems: ["reply is not valid JSON"], warnings }; }
  }
  if (!j || typeof j !== "object" || Array.isArray(j)) return { ok: false, problems: ["reply is not a JSON object"], warnings };

  const extra = Object.keys(j).filter((k) => !(k in SCHEMA.properties));
  if (extra.length) warnings.push(`ignored unknown fields: ${extra.join(", ")}`);
  for (const k of SCHEMA.required) if (!(k in j)) problems.push(`missing field ${k}`);

  const cap = (v, n) => String(v).replace(/\s+/g, " ").trim().slice(0, n);
  const s = {};
  const reqStr = (k, n) => {
    if (typeof j[k] !== "string" || !j[k].trim()) problems.push(`${k} must be a non-empty string`);
    else s[k] = cap(j[k], n);
  };
  const optStr = (k, n) => {
    if (j[k] === null || j[k] === undefined) s[k] = null;
    else if (typeof j[k] !== "string") problems.push(`${k} must be a string or null`);
    else s[k] = j[k].trim() ? cap(j[k], n) : null; // "" counts as not said
  };
  reqStr("summary", 1200);
  optStr("caller_name", 80);
  optStr("callback_number", 40);
  if (j.urgency === null || j.urgency === undefined) s.urgency = null;
  else if (!URGENCY.includes(String(j.urgency).toLowerCase())) problems.push(`urgency must be one of ${URGENCY.join(", ")} or null`);
  else s.urgency = String(j.urgency).toLowerCase();
  if (typeof j.callback_requested !== "boolean") problems.push("callback_requested must be a boolean");
  else s.callback_requested = j.callback_requested;
  if (!Array.isArray(j.ai_commitments) || j.ai_commitments.some((x) => typeof x !== "string")) {
    problems.push("ai_commitments must be an array of strings");
  } else {
    s.ai_commitments = j.ai_commitments.map((x) => cap(x, 300)).filter(Boolean).slice(0, 10);
  }
  reqStr("reply_message", 700);
  optStr("language", 40);
  if (problems.length) return { ok: false, problems, warnings };

  // THE SUMMARY'S SHAPE: 2 to 5 sentences, in English.
  const n = sentenceCount(s.summary);
  if (n < MIN_SENTENCES || n > MAX_SENTENCES) problems.push(`summary must be ${MIN_SENTENCES} to ${MAX_SENTENCES} sentences (it has ${n})`);
  if (latinShare(s.summary) < 0.7) problems.push("summary must be written in English");

  // GROUNDING. A name not in the words is invalid (the summary would carry it too).
  const all = transcript.map((e) => e.text).join(" ");
  const said = norm(callerText(transcript));
  if (s.caller_name && !norm(all).includes(norm(s.caller_name))) {
    problems.push(`caller_name "${s.caller_name}" is not in the transcript: use null and call them "an unknown caller"`);
  } else if (s.caller_name && !norm(s.summary).includes(norm(s.caller_name))) {
    problems.push(`summary must name the caller as "${s.caller_name}"`);
  } else if (!s.caller_name && !/\bunknown caller\b/i.test(s.summary)) {
    problems.push('caller_name is null, so the summary must call them "an unknown caller"');
  }
  // A phone-length number (8+ digits, groups joined by one space or hyphen)
  // in the summary must have been said. Shorter numbers (times, dates,
  // amounts said in words) are left to the prompt.
  const spokenAll = spokenDigits(all).replace(/\s/g, "");
  for (const m of s.summary.match(/\+?\d+(?:[ -]\d+)*/g) || []) {
    const digits = m.replace(/\D/g, "");
    if (digits.length >= 8 && !spokenAll.includes(digits)) problems.push(`the number ${m.trim()} in the summary is not in the transcript`);
  }
  for (const v of VAGUE) {
    const hit = v.re.exec(s.summary);
    if (hit && !(v.key && said.includes(v.key))) problems.push(`summary is vague ("${hit[0]}"): say exactly what the caller said, or that they didn't say`);
  }
  // callback_number: kept only if the caller said it (a secondary field: nulled, not retried).
  if (s.callback_number) {
    const digits = s.callback_number.replace(/\D/g, "");
    const fromCaller = spokenDigits(callerText(transcript)).replace(/\s/g, "");
    if (digits.length < 3 || !fromCaller.includes(digits)) {
      warnings.push(`callback_number "${s.callback_number}" was not said by the caller; set to null`);
      s.callback_number = null;
    }
  }
  if (problems.length) return { ok: false, problems, warnings };
  return { ok: true, summary: s, problems: [], warnings };
}

// ---------------------------------------------------------------- summarize

/**
 * summarize(transcript) →
 *   { empty: true, reason }                                caller said (almost) nothing; no model call
 *   { summary, caller_name, callback_number, urgency, callback_requested,
 *     ai_commitments, reply_message, language, ai_committed, _meta }
 *   { error: "invalid_transcript"|"summary_invalid"|"model_failed", message, problems? }
 * Never throws.
 */
async function summarize(transcript, { timeoutMs = 45_000 } = {}) {
  const checked = checkTranscript(transcript);
  if (!checked.ok) return { error: "invalid_transcript", message: "The transcript is not in the session's format.", problems: checked.problems };
  const t = checked.transcript;
  const n = words(callerText(t)).length;
  if (n < MIN_CALLER_WORDS) return { empty: true, reason: n ? "the caller said almost nothing" : "the caller said nothing" };

  const text = asText(t);
  const m = model();
  const started = Date.now();
  let last = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const ask = attempt === 1
      ? `Transcript:\n${text}`
      : `Transcript:\n${text}\n\nYour previous answer was rejected: ${last.problems.join("; ")}. Answer again with one JSON object that follows the schema and the rules exactly.`;
    let reply, used;
    try {
      ({ reply, model: used } = await router.generateReply([{ role: "user", content: ask }], {
        system: SYSTEM, json: true, schema: SCHEMA, model: m, maxTokens: 1500, timeoutMs,
      }));
    } catch (e) {
      return { error: "model_failed", message: `The summary model call failed: ${String(e.message || e).slice(0, 200)}` };
    }
    last = validate(reply, t);
    if (last.ok) {
      const s = last.summary;
      return {
        ...s,
        // FLAGGED: the AI must not promise anything for the owner (prompt.js).
        ai_committed: s.ai_commitments.length > 0,
        // The model that answered: the router falls back to another when the asked one is busy.
        _meta: { model: used || m, requestedModel: m, attempts: attempt, ms: Date.now() - started, warnings: last.warnings, generatedAt: new Date().toISOString() },
      };
    }
    console.warn(`missed-call summary: attempt ${attempt} invalid — ${last.problems.join("; ").slice(0, 300)}`);
  }
  return { error: "summary_invalid", message: "The model's summary failed validation twice.", problems: last.problems };
}

/**
 * The summary of a finished call, kept on the session object (in memory
 * only). Computed once; an error is not kept, so a retry can succeed.
 */
async function summarizeSession(session, opts) {
  if (!session || !Array.isArray(session.transcript)) return { error: "invalid_transcript", message: "No such call transcript." };
  if (session.state !== "ended") return { error: "call_not_ended", message: "The call is still in progress." };
  if (session.summary) return session.summary;
  if (!session._summarizing) {
    session._summarizing = summarize(session.transcript, opts).finally(() => { session._summarizing = null; });
  }
  const out = await session._summarizing;
  if (!out.error) session.summary = out;
  return out;
}

module.exports = { summarize, summarizeSession, validate, checkTranscript, spokenDigits, sentenceCount, SCHEMA, model, MIN_CALLER_WORDS };

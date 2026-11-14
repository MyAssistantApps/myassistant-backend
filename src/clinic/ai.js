/**
 * CLINICAL AI — structured drafting for the doctor's workspace.
 * -------------------------------------------------------------------------
 * Consult notes and prescription parsing run through the app's own AI
 * router (services/ai/router.js — OpenAI on this branch):
 *
 *   1. gpt-4.1 — the same model the phone-call agent uses (via Bolna) —
 *      with the reply pinned to a JSON schema.
 *   2. If that fails or returns something that isn't the JSON asked for,
 *      once more on the app's default chat model (the router already
 *      retries a busy 429/503 on its own fallback model).
 *
 * Every result carries `provider` (the model that answered). Nothing here is
 * ever saved without the doctor reviewing it — these are DRAFTS.
 */
const router = require("../services/ai/router");

const OPENAI_MODEL = "gpt-4.1";

/** Pulls the first JSON object out of a model reply. */
function parseJsonLoose(text) {
  const s = String(text || "").replace(/```json|```/g, "").trim();
  try { return JSON.parse(s); } catch (_) {}
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a >= 0 && b > a) {
    try { return JSON.parse(s.slice(a, b + 1)); } catch (_) {}
  }
  return null;
}

async function attempt({ system, user, schema }, model) {
  try {
    // router.generateReply is looked up per call so tests can stub it.
    const out = await router.generateReply(
      [{ role: "user", content: user }],
      {
        system,
        model: model || undefined,
        json: true,
        schema,
        temperature: 0.1, // transcription, not creativity
        timeoutMs: 90_000, // a long consult transcript takes a while
      }
    );
    const data = parseJsonLoose(out?.reply);
    if (!data) {
      console.warn(`clinical ai: ${model || "default model"} returned no valid JSON`);
      return null;
    }
    return { data, provider: out.model || model || out.provider || "openai" };
  } catch (e) {
    console.error(`clinical ai: ${model || "default model"} failed:`, e.message);
    return null;
  }
}

/**
 * Structured clinical draft: gpt-4.1 first, then the app's default model.
 * Throws when both fail — the caller reports that honestly instead of
 * saving a half-parsed draft.
 */
async function clinicalJson({ system, user, schema }) {
  const first = await attempt({ system, user, schema }, OPENAI_MODEL);
  if (first) return first;
  const second = await attempt({ system, user, schema }, null);
  if (second) return second;
  throw new Error("the AI could not draft this right now");
}

/* ------------------------------------------------------------------ */
/* Consult note (SOAP)                                                 */
/* ------------------------------------------------------------------ */

const SOAP_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    chief_complaint: { type: "string" },
    subjective: { type: "string" },
    objective: { type: "string" },
    assessment: { type: "string" },
    plan: { type: "string" },
    medications: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          dose: { type: "string" },
          frequency: { type: "string" },
          duration: { type: "string" },
          instructions: { type: "string" },
        },
        required: ["name", "dose", "frequency", "duration", "instructions"],
      },
    },
    follow_up_days: { type: "integer", description: "Review interval in days the doctor stated; 0 if not stated." },
    red_flags: { type: "array", items: { type: "string" } },
  },
  required: [
    "chief_complaint", "subjective", "objective", "assessment", "plan",
    "medications", "follow_up_days", "red_flags",
  ],
};

const SOAP_SYSTEM = [
  "You are a medical scribe drafting a consultation note for a doctor in India.",
  "You receive the transcript (or the doctor's dictation) of ONE consultation.",
  "",
  "Write a concise SOAP note in clinical English, the way the doctor would.",
  "",
  "ABSOLUTE RULES — this goes into a medical record:",
  "- Record ONLY what was said. Never add a finding, vital sign, diagnosis,",
  "  test result or drug that is not in the transcript. If a section has",
  "  nothing, write \"Not discussed.\"",
  "- Medications: list ONLY drugs the DOCTOR prescribed or told the patient",
  "  to continue, with dose/frequency/duration exactly as said. Use \"\" for",
  "  anything not stated. Never suggest, correct or complete a dose.",
  "- assessment = the doctor's own stated impression only. Do not diagnose.",
  "- follow_up_days = the review interval the doctor stated, else 0.",
  "- red_flags = warning signs the doctor told the patient to watch for, if any.",
  "- Speakers may mix English with Hindi, Kannada, Tamil, Telugu or Malayalam:",
  "  translate the meaning into English; keep drug names as spoken.",
].join("\n");

async function draftConsultNote({ transcript, patientName = "", context = "" }) {
  const text = String(transcript || "").trim();
  if (text.length < 20) throw new Error("the consultation was too short to write a note from");
  const user =
    (patientName ? `Patient: ${patientName}\n` : "") +
    (context ? `Known background (from the case file): ${context}\n` : "") +
    `\nTRANSCRIPT:\n${text}`;
  const { data, provider } = await clinicalJson({ system: SOAP_SYSTEM, user, schema: SOAP_SCHEMA });
  return { note: normalizeSoap(data), provider };
}

function str(v, n = 4000) {
  return String(v ?? "").trim().slice(0, n);
}

function normalizeMed(m) {
  return {
    name: str(m?.name, 120),
    dose: str(m?.dose, 60),
    frequency: str(m?.frequency, 60),
    duration: str(m?.duration, 60),
    instructions: str(m?.instructions, 200),
  };
}

function normalizeSoap(d) {
  const fu = Number(d?.follow_up_days);
  return {
    chiefComplaint: str(d?.chief_complaint, 300),
    subjective: str(d?.subjective),
    objective: str(d?.objective),
    assessment: str(d?.assessment),
    plan: str(d?.plan),
    medications: (Array.isArray(d?.medications) ? d.medications : [])
      .map(normalizeMed).filter((m) => m.name).slice(0, 20),
    followUpDays: Number.isInteger(fu) && fu > 0 && fu <= 730 ? fu : null,
    redFlags: (Array.isArray(d?.red_flags) ? d.red_flags : []).map((x) => str(x, 200)).filter(Boolean).slice(0, 10),
  };
}

/** The SOAP draft as the plain-text note filed in the case file. */
function soapToText(n) {
  const lines = [];
  if (n.chiefComplaint) lines.push(`CC: ${n.chiefComplaint}`);
  lines.push(`S: ${n.subjective || "Not discussed."}`);
  lines.push(`O: ${n.objective || "Not discussed."}`);
  lines.push(`A: ${n.assessment || "Not discussed."}`);
  lines.push(`P: ${n.plan || "Not discussed."}`);
  if (n.medications?.length) {
    lines.push("Rx:");
    for (const m of n.medications) lines.push(`  • ${medLine(m)}`);
  }
  if (n.redFlags?.length) lines.push(`Watch for: ${n.redFlags.join("; ")}`);
  if (n.followUpDays) lines.push(`Review in ${n.followUpDays} day${n.followUpDays === 1 ? "" : "s"}.`);
  return lines.join("\n");
}

function medLine(m) {
  return [m.name, m.dose, m.frequency, m.duration && `× ${m.duration}`, m.instructions && `(${m.instructions})`]
    .filter(Boolean).join(" ");
}

/* ------------------------------------------------------------------ */
/* Prescription dictation → structured items                           */
/* ------------------------------------------------------------------ */

const RX_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    diagnosis: { type: "string" },
    medications: SOAP_SCHEMA.properties.medications,
    advice: { type: "string" },
    follow_up_days: { type: "integer", description: "Review interval in days the doctor stated; 0 if not stated." },
  },
  required: ["diagnosis", "medications", "advice", "follow_up_days"],
};

const RX_SYSTEM = [
  "You convert a doctor's spoken or typed prescription into structured fields.",
  "The doctor is dictating; you are a transcriptionist, not a clinician.",
  "",
  "ABSOLUTE RULES:",
  "- Include ONLY drugs the doctor named. Never add, remove or substitute one.",
  "- Copy dose, frequency and duration as said. Expand common shorthand",
  "  faithfully (OD = once daily, BD = twice daily, TDS = three times daily,",
  "  QID = four times daily, HS = at bedtime, SOS = when needed, 1-0-1 = morning",
  "  and night). Leave a field \"\" when it was not said — never guess a dose.",
  "- instructions = food timing or other directions the doctor gave (\"after food\").",
  "- diagnosis and advice only if the doctor said them, else \"\".",
  "- follow_up_days = the review interval stated, else 0.",
].join("\n");

async function parsePrescription(dictation) {
  const text = String(dictation || "").trim();
  if (text.length < 3) throw new Error("nothing to parse");
  const { data, provider } = await clinicalJson({
    system: RX_SYSTEM,
    user: `DICTATION:\n${text}`,
    schema: RX_SCHEMA,
  });
  const fu = Number(data?.follow_up_days);
  return {
    diagnosis: str(data?.diagnosis, 300),
    medications: (Array.isArray(data?.medications) ? data.medications : [])
      .map(normalizeMed).filter((m) => m.name).slice(0, 20),
    advice: str(data?.advice, 1000),
    followUpDays: Number.isInteger(fu) && fu > 0 && fu <= 730 ? fu : null,
    provider,
  };
}

module.exports = {
  clinicalJson,
  draftConsultNote, parsePrescription,
  soapToText, medLine, normalizeSoap, normalizeMed, parseJsonLoose,
  SOAP_SCHEMA, RX_SCHEMA, OPENAI_MODEL,
};

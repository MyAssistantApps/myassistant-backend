/**
 * LEGAL DRAFTING — an advocate describes what they need ("legal notice to
 * the tenant for 4 months' unpaid rent, ₹60,000, vacate in 15 days") and
 * gets an editable draft to review, then a PDF on their letterhead.
 * -------------------------------------------------------------------------
 * Grounded, not remembered: the facts are matched against the app's own
 * Indian-law pack (knowledge/engine.retrieve, domain "legal") and the model
 * may cite ONLY the provisions handed to it. Repealed IPC/CrPC/Evidence Act
 * numbers in the facts are mapped to BNS/BNSS/BSA first (legal/guard), so a
 * notice never goes out under a section that no longer exists.
 *
 * Drafted through the app's OpenAI router (gpt-4.1, then the default
 * model), like the doctor's consult notes. It is a DRAFT: the advocate
 * edits and signs it; nothing is sent from here.
 */
const router = require("../services/ai/router");

const KINDS = {
  notice: "Legal notice",
  reply: "Reply to a legal notice",
  affidavit: "Affidavit",
  agreement: "Agreement",
  letter: "Legal letter",
};

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: "string" },
    body: { type: "string", description: "The full document text, paragraphs separated by a blank line." },
    provisions_cited: { type: "array", items: { type: "string" } },
    advocate_checks: {
      type: "array",
      items: { type: "string" },
      description: "Facts the advocate must verify or fill before sending (dates, amounts, addresses).",
    },
  },
  required: ["title", "body", "provisions_cited", "advocate_checks"],
};

function systemFor(kindLabel, provisions) {
  return [
    `You draft a ${kindLabel} for an Indian advocate, in formal Indian legal English.`,
    "",
    "RULES — the advocate will sign this:",
    "- Use ONLY the facts given. Where a needed fact is missing (a date, an address, an",
    "  amount), write a clear placeholder like [DATE OF AGREEMENT] and list it in",
    "  advocate_checks. Never invent names, dates, amounts or events.",
    "- Cite a statute or section ONLY if it appears in the PROVISIONS list below, worded",
    "  as given. If none fits, cite nothing. The IPC, CrPC and Evidence Act were replaced",
    "  on 1 July 2024 by the BNS, BNSS and BSA — never cite the old numbers.",
    "- Structure appropriately for the document type (for a notice: addressee, \"Under",
    "  instructions from my client…\", numbered facts, the demand, the time limit, the",
    "  consequence). Paragraphs separated by a blank line. No markdown.",
    "",
    provisions.length
      ? "PROVISIONS YOU MAY CITE:\n" + provisions.map((p) => `- ${p}`).join("\n")
      : "PROVISIONS YOU MAY CITE: none were found for these facts — cite no section.",
  ].join("\n");
}

function parseJsonLoose(text) {
  const s = String(text || "").replace(/```json|```/g, "").trim();
  try { return JSON.parse(s); } catch (_) {}
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch (_) {} }
  return null;
}

/** Provisions from the legal pack relevant to the facts, as citation lines. */
async function groundingFor(facts) {
  const lines = [];
  try {
    const { findRepealedRefs } = require("../legal/guard");
    for (const r of findRepealedRefs(facts)) {
      if (r.act && r.section) lines.push(`${r.act} ${r.section}${r.title ? ` — ${r.title}` : ""} (replaces ${r.cited})`);
    }
  } catch (_) {}
  try {
    const { retrieve } = require("../knowledge/engine");
    const { entries } = await retrieve(facts, { domain: "legal", limit: 6 });
    for (const e of entries || []) {
      const cite = [e.source_short || e.source_title, e.ref].filter(Boolean).join(" ");
      if (cite) lines.push(`${cite}${e.title ? ` — ${e.title}` : ""}`);
    }
  } catch (_) {}
  return [...new Set(lines)].slice(0, 10);
}

async function attempt({ system, user }, model) {
  try {
    const out = await router.generateReply([{ role: "user", content: user }], {
      system, model: model || undefined, json: true, schema: SCHEMA,
      temperature: 0.2, timeoutMs: 90_000,
    });
    const d = parseJsonLoose(out?.reply);
    if (!d || typeof d.body !== "string" || d.body.trim().length < 40) return null;
    return { d, provider: out.model || model || "openai" };
  } catch (e) {
    console.error(`legal draft: ${model || "default model"} failed:`, e.message);
    return null;
  }
}

/**
 * @returns {{title, body, provisionsCited[], advocateChecks[], provider}}
 */
async function draftLegal({ kind, facts, clientName = "", caseTitle = "" }) {
  const label = KINDS[kind] || KINDS.letter;
  const f = String(facts || "").trim();
  if (f.length < 15) throw new Error("describe the facts in a sentence or two first");
  const provisions = await groundingFor(f);
  const system = systemFor(label, provisions);
  const user =
    (clientName ? `Client (our side): ${clientName}\n` : "") +
    (caseTitle ? `Matter: ${caseTitle}\n` : "") +
    `\nFACTS AND INSTRUCTIONS:\n${f.slice(0, 6000)}`;
  const r = (await attempt({ system, user }, "gpt-4.1")) || (await attempt({ system, user }, null));
  if (!r) throw new Error("the AI could not draft this right now");
  const allowed = provisions.map((p) => p.toLowerCase());
  return {
    title: String(r.d.title || label).slice(0, 160),
    body: String(r.d.body).slice(0, 20000),
    // Only citations that trace back to the grounding list survive.
    provisionsCited: (Array.isArray(r.d.provisions_cited) ? r.d.provisions_cited : [])
      .map((x) => String(x).slice(0, 200))
      .filter((x) => allowed.some((a) => a.includes(x.toLowerCase()) || x.toLowerCase().includes(a.split(" — ")[0])))
      .slice(0, 10),
    advocateChecks: (Array.isArray(r.d.advocate_checks) ? r.d.advocate_checks : []).map((x) => String(x).slice(0, 200)).slice(0, 15),
    provider: r.provider,
  };
}

module.exports = { draftLegal, groundingFor, KINDS, SCHEMA, systemFor, parseJsonLoose };

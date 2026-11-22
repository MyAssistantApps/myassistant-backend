/**
 * PROFESSION → WORKSPACE.
 * -------------------------------------------------------------------------
 * The onboarding step lets people type what they do in their own words
 * ("chartered accountant", "runs a bakery", "cab driver") instead of
 * forcing them into six boxes. This maps that free text onto one of the
 * six workspace keys in users/persona.js, which still gate the server.
 *
 *   1. Rules: a keyword table, so the common answers cost nothing.
 *   2. AI: a small JSON call for everything else (5 s budget).
 *   3. Fallback: "professional" (people with a job), so a slow or
 *      missing AI never blocks sign-up.
 *
 * The Pro workspaces carry duties (doctors and advocates go through
 * registration checks before publishing), so the AI may only suggest one
 * of them when the text plainly says so. Anything else stays on the safe
 * side (professional, business, student or personal).
 */
const { PERSONAS, cleanPersona } = require("./persona");

// Order matters: the first match wins. A "medical student" is a student,
// not a doctor, so student goes first; a "business analyst" is employed.
const RULES = [
  ["student", /\b(student|studying|undergrad|phd scholar|research scholar|intern|aspirant|upsc|neet|jee)\b/i],
  ["personal", /\b(home ?maker|house ?wife|house ?husband|stay[- ]at[- ]home|retired|pensioner|not working|unemployed|between jobs|personal use)\b/i],
  ["doctor", /\b(doctor|dr|physician|surgeon|dentist|paediatrician|pediatrician|gynaecologist|gynecologist|dermatologist|orthopaedic|orthopedic|cardiologist|ent specialist|ophthalmologist|psychiatrist|physiotherapist|physio|radiologist|neurologist|oncologist|urologist|anaesthetist|anesthesiologist|homeopath|ayurvedic|ayurveda|vaidya|veterinarian|vet|mbbs|bds|bams|bhms)\b/i],
  ["advocate", /\b(advocate|lawyer|attorney|barrister|solicitor|legal practitioner|litigator|notary)\b/i],
  // Owning or running something beats any job title in the same sentence.
  ["business", /\b(business ?(owner|man|woman|person)|own (a|my) business|run (a|my) business|entrepreneur|founder|co-?founder|ceo|managing director|proprietor|owner|self[- ]employed|startup)\b/i],
  ["professional", /\b(engineer|developer|programmer|software|designer|manager|consultant|accountant|ca|auditor|analyst|teacher|professor|lecturer|tutor|nurse|pharmacist|architect|banker|sales|marketing|executive|officer|employee|hr|recruiter|journalist|writer|photographer|artist|musician|freelancer|driver|pilot|police|army|government|clerk|technician|electrician|plumber|mechanic|chef|scientist|researcher|coach|trainer|content creator|influencer)\b/i],
  // A place of trade with no job title: they most likely run it.
  ["business", /\b(business|shop|store|retailer|wholesaler|trader|dealer|distributor|merchant|restaurant|cafe|bakery|hotel|agency|manufacturer|factory|contractor|builder|real estate|realtor|broker|franchise|vendor|exporter|importer)\b/i],
];

/** { persona, label } from rules alone, or null. */
function byRules(text) {
  for (const [persona, re] of RULES) if (re.test(text)) return persona;
  return null;
}

const SYSTEM = [
  "You map a person's description of their work to exactly ONE workspace key.",
  "Keys:",
  "- doctor: licensed medical practitioners who see patients (doctors, dentists, physiotherapists, vets, AYUSH doctors).",
  "- advocate: practising lawyers/advocates/attorneys.",
  "- business: people who own or run a business, shop, practice-as-a-firm, agency or trade.",
  "- professional: people employed or freelancing in any other job (engineers, teachers, nurses, drivers, accountants, artists, government staff...).",
  "- student: anyone studying or preparing for exams.",
  "- personal: homemakers, retired people, or anyone not describing paid work.",
  "Choose doctor or advocate ONLY when the text clearly states that profession. When unsure, choose professional.",
  'Also return "label": the profession in 1-4 words, Title Case, in English (e.g. "Chartered Accountant").',
  'Answer JSON only: {"persona":"...","label":"..."}',
].join("\n");

const SCHEMA = {
  name: "profession",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      persona: { type: "string", enum: PERSONAS },
      label: { type: "string" },
    },
    required: ["persona", "label"],
  },
};

function titleCase(s) {
  return s.replace(/\s+/g, " ").trim().replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Free text → { persona, label, source: "rules" | "ai" | "fallback" }.
 * `ai` is injectable for tests: async (text) => ({ persona, label }).
 */
async function resolveProfession(raw, { ai = askAi } = {}) {
  const text = String(raw ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
  if (!text) return { persona: "", label: "", source: "empty" };
  const label = titleCase(text);
  const ruled = byRules(text);
  if (ruled) return { persona: ruled, label, source: "rules" };
  try {
    const out = await ai(text);
    const persona = cleanPersona(out && out.persona);
    if (persona) {
      const l = String(out.label || "").trim().slice(0, 60);
      return { persona, label: l ? titleCase(l) : label, source: "ai" };
    }
  } catch { /* fall through: never block onboarding on the AI */ }
  return { persona: "professional", label, source: "fallback" };
}

async function askAi(text) {
  const { generateReply } = require("../services/ai/router");
  const r = await generateReply([{ role: "user", content: text }], {
    system: SYSTEM, json: true, schema: SCHEMA, timeoutMs: 5000, noRetry: true,
    temperature: 0, maxTokens: 60,
  });
  return JSON.parse(r.reply || "{}");
}

module.exports = { resolveProfession, byRules };

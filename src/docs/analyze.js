/**
 * DOCUMENT ANALYZER — one Gemini multimodal call per saved document.
 * Runs ONCE at upload time; every later recall is a pure DB lookup,
 * so remembering costs one AI call ever, not one per question.
 */
// Sanitized: a stray inline comment in .env must not become the model name.
const { envModel } = require("../services/ai/router");
const { extractText } = require("./extract");
// Unset, the alias Google keeps current: gemini-2.5-flash, the old
// default, answers new users 404 (2026-09-25).

// What the multimodal call can read as BYTES. Everything else (Word,
// Excel, PowerPoint, CSV, plain text) is turned into text first — see
// docs/extract.js — because handing a ZIP-based Office file to
// inline_data returns nothing usable, which is why a shared spreadsheet
// used to land in the documents list with no title and no searchable
// content at all.
const NATIVE = new Set([
  "image/jpeg", "image/png", "image/webp", "image/heic", "image/heif",
  "application/pdf",
]);

const PROMPT = `You are filing a document into a personal assistant's memory.
Look at the attached file and reply with STRICT JSON only (no markdown fences):
{"title": "<short human title, e.g. 'Blood test report — City Hospital'>",
 "category": "medical" | "prescription" | "receipt" | "bill" | "id" | "ticket" | "other",
 "doc_date": "<yyyy-mm-dd printed on the document, or empty string>",
 "expires_on": "<yyyy-mm-dd the document EXPIRES or must be RENEWED — insurance policy end, driving licence / passport / visa / ID validity, vehicle registration or PUC, warranty, subscription, lease or contract end. Empty string if it has no expiry.>",
 "summary": "<3-6 plain sentences: what this is, key values/amounts, and anything the person must act on (medicines + dosage, follow-up dates, totals, deadlines). Keep the document's language for names.>",
 "tags": ["<5-10 lowercase search keywords: place names, doctor names, test names, illnesses, shops>"],
 "full_text": "<complete transcription of ALL text in the document, in reading order, original language and script, line breaks as \\n. For very long documents (many pages) transcribe the substantive content and totals; skip only boilerplate.>"}`;

/**
 * @returns {Promise<object|null>} parsed metadata, or null on any failure —
 * the caller keeps filename-based placeholders so saving NEVER fails just
 * because analysis did.
 */
async function analyzeDocument(buffer, mime, filename = "") {
  const openai = require("../services/ai/openai");
  if (!openai.ready()) return null;

  // A PDF or a picture goes to the model as itself; anything else as text.
  let message;
  if (NATIVE.has(mime)) {
    message = { role: "user", content: PROMPT, images: [{ mime, data: buffer, filename: filename || "document" }] };
  } else {
    const text = await extractText(buffer, mime, filename);
    if (!text) return null;
    message = { role: "user", content: `The document is named "${filename || "document"}". Its full contents follow.\n\n${text.slice(0, 120000)}\n\n${PROMPT}` };
  }

  try {
    const { text: reply } = await openai.chat({
      messages: [message], system: "You read documents and answer with the JSON asked for, nothing else.",
      json: true, temperature: 0.2, timeoutMs: 45_000, model: openai.models.smart(),
    });
    const j = JSON.parse(reply);
    return {
      title: j.title,
      category: j.category,
      docDate: j.doc_date,
      expiresOn: j.expires_on,
      summary: j.summary,
      tags: j.tags,
      fullText: j.full_text,
    };
  } catch (e) {
    console.error("doc analyze failed:", e.message);
    return null;
  }
}

module.exports = { analyzeDocument };

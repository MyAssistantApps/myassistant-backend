/**
 * EDIT A PHOTO BY VOICE — edit_my_photo: "remove the background", "change
 * the colour", "make this look professional", "put this person in a formal
 * setting" — on the photo they just shared (or photo_doc_id). The result is
 * a NEW document, shown with the existing show_image action; the original
 * is never overwritten. The edit itself is services/photoEdit.js.
 */
const fs = require("fs");

const IMAGE_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);

/** The photo to edit: the one named, else the newest image they saved or
 *  shared (never an emailed attachment). */
async function photoDocument(uid, docId) {
  const docs = require("../docs/store");
  if (Number(docId) > 0) {
    const d = await docs.getDocument(uid, Number(docId));
    return d && IMAGE_MIME.has(d.mime) ? d : null;
  }
  const rows = await docs.listDocuments(uid, 30);
  return rows.find((d) => IMAGE_MIME.has(d.mime) && d.source !== "email") || null;
}

async function runEditMyPhoto(args, ctx) {
  if (!ctx.userId) return { ok: false, error: "not signed in" };
  const uid = Number(ctx.userId);
  const instruction = String(args.instruction || "").trim().slice(0, 600);
  if (!instruction) return { ok: false, error: "need_instruction", note: "Ask what to change in the photo." };
  const photoEdit = require("../services/photoEdit");
  const doc = await photoDocument(uid, args.photo_doc_id);
  if (!doc) {
    return {
      ok: false,
      error: "no_photo",
      note: "There is no photo to edit yet. Ask them to share or save the photo first, in one short line.",
    };
  }
  let buffer;
  try {
    buffer = fs.readFileSync(doc.path);
  } catch (_) {
    return { ok: false, error: "no_photo", note: "That photo's file isn't here any more. Ask them to share it again." };
  }
  let out;
  try {
    out = await photoEdit.editPhoto({ buffer, mime: doc.mime, instruction });
  } catch (e) {
    if (e instanceof photoEdit.PhotoEditError) {
      return {
        ok: false,
        error: e.message,
        data: { code: e.code, photo_doc_id: doc.id },
        note: e.code === "identity"
          ? "Say this kindly in one or two lines and offer the edits you can do. Nothing was changed."
          : "Say this in one short line. Nothing was changed, the original is untouched, and it is " +
            "not the photo's fault.",
      };
    }
    console.error("edit_my_photo:", e && (e.stack || e.message));
    return { ok: false, error: "That edit didn't come back this time — ask me to try again in a moment." };
  }

  const docs = require("../docs/store");
  const ext = out.mime === "image/png" ? "png" : "jpg";
  const row = await docs.createDocument(uid, {
    buffer: out.buffer,
    filename: `photo-edit-${Date.now()}.${ext}`,
    mime: out.mime,
    note: `edited: ${instruction}`,
  });
  const title = out.op === "remove_background"
    ? `Photo, background removed${out.transparent ? "" : " (white)"}`
    : `Edited photo - ${instruction.slice(0, 60)}`;
  const updated = await docs.setMetadata(uid, row.id, {
    title,
    category: "other",
    docDate: new Date().toISOString().slice(0, 10),
    summary: `An AI edit of "${doc.title || doc.filename}": ${instruction}. The original is kept unchanged.`,
    tags: ["edited", "ai-edit", ...(out.transparent ? ["transparent"] : [])],
    fullText: `AI photo edit of document ${doc.id}. Instruction: ${instruction}`,
  }).catch(() => null);
  return {
    ok: true,
    data: {
      edited: true,
      documentId: row.id,
      from_document_id: doc.id,
      title,
      transparent: out.transparent,
      note:
        "The edited photo EXISTS, is saved as a new document and is on the screen now; the " +
        "original is unchanged." +
        (out.op === "remove_background" && !out.transparent
          ? " The background is plain white, not transparent — say so if they need a cut-out."
          : ""),
    },
    deviceAction: {
      type: "show_image",
      doc_id: row.id,
      prompt: instruction,
      title,
      document: docs.toClient(updated || row),
    },
    speak: "Here it is — the edited photo is on the screen, and your original is kept as it was.",
  };
}

function registerEditMyPhoto(registry) {
  registry.register({
    name: "edit_my_photo",
    deviceAction: true,
    risk: "low",
    timeoutMs: 60_000,
    description:
      "EDIT A PHOTO THEY SHARED OR SAVED — 'remove the background', 'make the background " +
      "transparent', 'change the shirt colour to blue', 'make this look professional', 'put this " +
      "person in a formal setting', 'brighten it'. Uses the newest photo they shared unless " +
      "photo_doc_id names one. The edit is saved as a NEW document and shown; the original is kept. " +
      "It never changes anyone's face or body (no face swaps, no 'make me fairer / younger / " +
      "slimmer'). For their OWN saved Style Studio selfie (outfits, hairstyles, passport photos) use " +
      "try_a_look.",
    inputSchema: {
      type: "object",
      properties: {
        instruction: { type: "string", description: "What to change, in the user's words." },
        photo_doc_id: { type: "integer", description: "The photo's document id. Omit for the photo they just shared." },
      },
      required: ["instruction"],
    },
    execute: runEditMyPhoto,
  });
}

module.exports = { registerEditMyPhoto, runEditMyPhoto };

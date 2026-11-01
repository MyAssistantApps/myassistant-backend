/**
 * THE VOICES THE APP OFFERS (owner, 2026-10-31: "more than 12 voices …
 * when I click it's not playing … not even changing").
 *
 * She talks through OpenAI Realtime and reads replies with gpt-4o-mini-tts;
 * these ten voices exist in BOTH, so a pick is the voice of the greeting,
 * the conversation and every spoken reply. Each voice's sample and each
 * greeting line is spoken once by gpt-4o-mini-tts in that voice and kept
 * in DATA_DIR/voice-samples, shared by every phone.
 *
 * GPT-Live (its 22 voices, samples recorded over its socket) was removed
 * on 2026-11-01: production never ran it (GPT_LIVE=off).
 */
const fs = require("fs");
const path = require("path");

const CATALOG = [
  { id: "marin", gender: "female", accent: "North American", tagline: "Natural and clear" },
  { id: "cedar", gender: "male", accent: "North American", tagline: "Open and upbeat" },
  { id: "coral", gender: "female", accent: "North American", tagline: "Warm and friendly" },
  { id: "shimmer", gender: "female", accent: "North American", tagline: "Bright and gentle" },
  { id: "sage", gender: "female", accent: "North American", tagline: "Calm and thoughtful" },
  { id: "alloy", gender: "female", accent: "North American", tagline: "Balanced and neutral" },
  { id: "ash", gender: "male", accent: "North American", tagline: "Clear and confident" },
  { id: "ballad", gender: "male", accent: "British", tagline: "Smooth and expressive" },
  { id: "echo", gender: "male", accent: "North American", tagline: "Steady and resonant" },
  { id: "verse", gender: "male", accent: "North American", tagline: "Lively and versatile" },
].map((v) => ({ ...v, name: v.id[0].toUpperCase() + v.id.slice(1) }));

const CLASSIC_VOICES = CATALOG.map((v) => v.id);

const byId = (id) => CATALOG.find((v) => v.id === String(id || "").trim().toLowerCase()) || null;

/** What the picker offers: every voice she can speak in. */
const offered = () => CATALOG.slice();

// Under DATA_DIR like every other file the server keeps (/app/data in the
// Docker image). A fixed "/app/data" broke the greeting and the samples on
// a host without /app (the VPS, 2026-10-31: EACCES, mkdir '/app').
const DIR = process.env.VOICE_SAMPLE_DIR ||
  path.join(path.resolve(process.env.DATA_DIR || path.join(__dirname, "..", "..", "data")), "voice-samples");
const making = new Map();

const sampleLine = (v) => `Hi, I'm ${v.name}. This is how I'll sound when we talk.`;

/** A line in a voice, from gpt-4o-mini-tts, as a 24 kHz mono WAV. */
async function speakWav(v, line) {
  const openai = require("../services/ai/openai");
  const out = await openai.speak(line, { voice: v.id, format: "pcm" });
  const pcm = Buffer.isBuffer(out) ? out : Buffer.from(out.buffer || out.audio || out);
  if (pcm.length < 4800) throw new Error("no speech audio");
  return openai.wavWrap(pcm, 24000);
}

/** Made once, kept on disk, shared by every phone; one maker per file. */
async function kept(file, make) {
  try {
    return await fs.promises.readFile(file);
  } catch (_) {}
  if (!making.has(file)) {
    making.set(file, (async () => {
      const wav = await make();
      await fs.promises.mkdir(DIR, { recursive: true });
      await fs.promises.writeFile(file, wav);
      return wav;
    })().finally(() => making.delete(file)));
  }
  return making.get(file);
}

/** The voice's sample as a WAV; null for a voice she cannot speak in. */
async function sample(id) {
  const v = byId(id);
  if (!v) return null;
  return kept(path.join(DIR, `tts-${v.id}.wav`), () => speakWav(v, sampleLine(v)));
}

/**
 * THE ORB'S HELLO, IN HER VOICE (owner, 2026-10-04: "hello sir every time
 * I tap, in the exact same voice"): the line spoken once per voice and
 * wording, kept on disk, played by the phone the instant the orb is
 * tapped. A voice she cannot speak in gets the default voice's hello.
 */
const GREETING_LINE = /^[\p{L} .,!?'’-]{2,60}$/u;
async function greeting(id, line) {
  const text = String(line || "").trim();
  if (!GREETING_LINE.test(text)) return null;
  const v = byId(id) || byId(require("./proxy").DEFAULT_VOICE);
  const key = require("crypto").createHash("sha1").update(`tts-v1|${v.id}|${text}`).digest("hex").slice(0, 16);
  return kept(path.join(DIR, `greet-tts-${key}.wav`), () => speakWav(v, text));
}

module.exports = { CATALOG, CLASSIC_VOICES, offered, byId, sample, greeting, sampleLine };

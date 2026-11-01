/**
 * GET /ai/config — how the app runs its assistant: the models our server
 * answers with (ai/proxy.js, OpenAI behind it), the voice for spoken
 * replies and for the realtime conversation, the speech language, and the
 * words the app's router uses to pick a route.
 *
 * ONE PATH (2026-11-01). It used to build a Gemini config for Firebase AI
 * Logic and then overwrite most of it with OpenAI's names, with build
 * gates for apps older than 146. Production runs OpenAI and only builds
 * 175+ reach it, so only that path is left; scripts/production-config-test.js
 * snapshots exactly what the phone receives.
 *
 * Nothing here is secret: the app never sees an API key.
 */
const { envModel } = require("../services/ai/router");

// The languages the assistant speaks (agents/language.js), as BCP-47 for
// the speech engine. Tulu is written in Kannada script; Konkani is left
// as its own tag and the phone may fall back if its voice has none.
const BCP47 = {
  English: "en-IN", Hindi: "hi-IN", Kannada: "kn-IN", Tamil: "ta-IN",
  Telugu: "te-IN", Malayalam: "ml-IN", Marathi: "mr-IN", Konkani: "kok-IN",
  Tulu: "tcy-IN", Bengali: "bn-IN", Gujarati: "gu-IN", Punjabi: "pa-IN",
  Odia: "or-IN",
};

// The actions and personal-data words that always need the cloud and its
// tools (docs/ai-logic design, "Routing" §3), on top of the tool names.
const TOOL_VERBS = [
  "remind", "reminder", "call", "message", "send", "email", "mail", "book",
  "order", "open", "play", "set", "alarm", "timer", "schedule", "calendar",
  "meeting", "note", "remember", "forget", "pay", "navigate", "directions",
  "weather", "news", "near me", "nearby", "my", "download", "install",
  "whatsapp", "text", "photo", "camera", "document", "search", "find",
  // The shopping list and the kitchen (2026-09-29).
  "shopping list", "shopping", "to my list", "need to buy", "buy", "cart",
  "pantry", "recipe", "cook", "grocery", "groceries", "kirana",
];

// Fresh public facts with no tool word: cloud with Google Search grounding.
const FRESH_WORDS = [
  "today", "tonight", "tomorrow", "yesterday", "latest", "now", "current",
  "currently", "live", "score", "scores", "price", "prices", "rate", "rates",
  "who won", "won", "result", "results", "news of", "headlines", "this week",
  "this year", "recent", "recently", "breaking", "update", "election",
  "stock", "share price", "gold rate", "petrol price",
];

// Google Search grounding through AI Logic (the app's "search" route). Off
// unless AI_GROUNDING=on since 2026-09-29: the project's grounding quota
// ran out (429 on every fresh question) while the server's own web_search
// and get_weather tools answer the same questions on the cloud route. The
// app reads an empty list as "use your own", so a word nobody says is
// what switches the route off.
const NO_GROUNDING = "__grounding_off__";
const groundingOn = () => /^(on|1|true|yes)$/i.test(String(process.env.AI_GROUNDING || "off").trim());
// How hard the conversation model thinks before answering (minimal, low,
// medium, high). Gemini 3's own default is high, far too slow to talk to.
const THINKING = new Set(["minimal", "low", "medium", "high"]);
const thinkingLevel = () => {
  const v = envModel("AI_CLOUD_THINKING", "low").toLowerCase();
  return THINKING.has(v) ? v : "low";
};
// The delivery a spoken reply gets when its model gave no tone of its own.
const ttsStyle = () => envModel("AI_TTS_STYLE", "warm, friendly and natural");
const liveOn = () => !/^(off|0|false|no)$/i.test(String(process.env.AI_LIVE || "on").trim());
function liveSilenceMs() {
  const n = Math.round(Number(process.env.AI_LIVE_SILENCE_MS));
  // 800 since 2026-10-01: the client's think-pauses ("Tell me the …",
  // "Can you tell me about Dr. …") ended his turn at 500 and two answers
  // came back to half a sentence. Costs ~300 ms per turn.
  return Number.isFinite(n) && n >= 200 && n <= 3000 ? n : 800;
}
function liveHangoverMs() {
  const n = Math.round(Number(process.env.AI_LIVE_VAD_HANGOVER_MS));
  return Number.isFinite(n) && n >= 200 && n <= 3000 ? n : 700;
}
/**
 * HOW THE CLASSIC (non-Live) VOICE HEARS. "device" = the phone's own
 * recogniser (fast captions, one locale, "Kannada" heard as "Canada");
 * "record" = the phone records the turn and Gemini transcribes it in
 * whatever language was spoken — and the recording is kept for review,
 * so every turn can be heard in the admin panel (the owner, 2026-10-01).
 * AI_CLOUD_STT=device switches back.
 */
function cloudSttMode() {
  return process.env.AI_CLOUD_STT === "device" ? "device" : "record";
}

/**
 * The realtime conversation (OpenAI Realtime, opened by the phone with a
 * key from POST /ai/realtime/secret): model, voice, and how it hears —
 * how long a pause ends their turn, how much audio before speech is kept,
 * how readily speech starts and ends a turn, how long an idle session
 * stays open. AI_LIVE=off turns it off (the app keeps the cascade).
 */
function liveBlock(userId, profile = null) {
  const proxy = require("./proxy");
  return {
    on: liveOn(),
    model: proxy.servedModels().live,
    voice: proxy.voiceOf(profile),
    silenceMs: liveSilenceMs(),
    prefixMs: 100,
    // LOW since 2026-10-01 (client: "other persons' voice should not
    // interfere"): faint background speech does not open a turn. End
    // stays high, so the user's own pause still ends one.
    startSensitivity: "low",
    endSensitivity: "high",
    idleCloseSec: 900, // keep the prewarmed session ready across app use
    affectiveDialog: false,
    // The phone's own end-of-speech hangover and the half-sentence guard
    // (2026-10-01, the client's cut-off think-pauses), served so either
    // can be taken back without a release: AI_LIVE_VAD_HANGOVER_MS,
    // AI_LIVE_FRAGMENT_GUARD=off.
    vadHangoverMs: liveHangoverMs(),
    fragmentGuard: process.env.AI_LIVE_FRAGMENT_GUARD !== "off",
    voices: proxy.REALTIME_VOICES.slice(),
  };
}

/** BCP-47 for a stored preferred language ("Kannada", "ಕನ್ನಡ", "kn"…). */
function speechLanguage(preferred) {
  const raw = String(preferred || "").trim();
  if (!raw) return "en-IN";
  if (/^[a-z]{2,3}(-[A-Za-z]{2})?$/.test(raw)) {
    const two = raw.slice(0, raw.indexOf("-") > 0 ? raw.indexOf("-") : raw.length).toLowerCase();
    const hit = Object.values(BCP47).find((t) => t.startsWith(two + "-"));
    if (hit) return hit;
  }
  const name = require("../agents/language").canonical(raw);
  return BCP47[name] || "en-IN";
}

async function forUser(userId) {
  const uid = Number(userId);
  const profile = await require("../users/context").getProfile(uid).catch(() => null);
  const registry = require("../tools/registry");
  const proxy = require("./proxy");
  const offered = registry.declarations({ userId: uid });
  const toolWords = require("../tools/relevance").triggerWords(offered, TOOL_VERBS);
  // Names as match.js keys them (the app normalises what was said the
  // same way).
  const shortcutNames = process.env.SHORTCUTS === "off" ? []
    : [...new Set(await require("../shortcuts/match").keysFor(uid).catch(() => []))];
  const served = proxy.servedModels();
  const voice = proxy.voiceOf(profile);
  const out = {
    models: {
      cloud: served.cloud,
      cloudFast: served.cloudFast,
      cloudFallback: served.cloudFallback,
      thinking: thinkingLevel(),
      tts: served.tts,
      ttsVoice: voice,
      ttsStyle: ttsStyle(),
      ttsLanguage: speechLanguage(profile && profile.user && profile.user.preferred_language),
    },
    routing: { toolWords, freshWords: groundingOn() ? FRESH_WORDS.slice() : [NO_GROUNDING], shortcutNames },
    limits: { maxToolRounds: 6 },
    live: liveBlock(uid, profile),
    listen: { cloudStt: cloudSttMode() },
  };
  out.provider = "openai";
  return out;
}

module.exports = {
  forUser, speechLanguage, thinkingLevel, ttsStyle, cloudSttMode, liveBlock, liveOn,
  TOOL_VERBS, FRESH_WORDS, NO_GROUNDING, groundingOn,
};

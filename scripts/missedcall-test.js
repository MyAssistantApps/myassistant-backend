/**
 * MISSED-CALL CALLBACK — LAPTOP E2E (dev only, real OpenAI, a few cents).
 *
 *   npm run e2e:missedcall -- <caller.wav> [--out out.wav] [--timeout 90] [--token <JWT>] [--name "Anil"] [--no-summary]
 *
 * Starts the dev route (src/ai/missedcall/route.js) on a free local port
 * and connects a fake caller to ws://…/ai/missed-call/stream?source=laptop,
 * speaking its protocol exactly (see route.js):
 *   1. {"type":"start"} — with --token it is checked like the app's sessions
 *      (needs the database); without one this process runs AUTH_DISABLED=true;
 *   2. silence while the AI says its opening line;
 *   3. the WAV, converted to the route's format (PCM16 mono 24000 Hz,
 *      session.js FORMAT), paced in real time, 100 ms a frame;
 *   4. silence until the AI's reply has played out; then {"type":"stop"}.
 * Audio flows the whole time, as the phone's GPT-Live client does.
 *
 * Prints the transcript of both sides, the time to the first AI audio
 * (from the start message) and to the first reply audio (from the end of
 * the WAV), and saves every chunk of AI audio received to --out. Then the
 * finished call is summarized (summary.js summarizeSession, one more model
 * call; --no-summary skips it) and the summary printed with them.
 * Exit 0 only when the AI answered after the WAV, nothing errored and the
 * summary (when asked for) is not an error.
 * NOT part of test:all.
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");

if (process.env.NODE_ENV === "production") {
  console.error("missedcall-test: refused — NODE_ENV is production (the route is dev only).");
  process.exit(2);
}

// ---------------------------------------------------------------- args
const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return dflt;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
};
const OUT = path.resolve(opt("out", "out.wav"));
const TIMEOUT_S = Math.max(15, Number(opt("timeout", 90)) || 90);
const TOKEN = opt("token", process.env.MISSED_CALL_TOKEN || "");
const CALLER_NAME = opt("name", "");
const NO_SUMMARY = argv.includes("--no-summary");
if (NO_SUMMARY) argv.splice(argv.indexOf("--no-summary"), 1);
const WAV = argv[0];
if (!WAV) {
  console.error("usage: npm run e2e:missedcall -- <caller.wav> [--out out.wav] [--timeout 90] [--token <JWT>] [--name <caller>]");
  process.exit(2);
}
if (!String(process.env.OPENAI_API_KEY || "").trim()) {
  console.error("missedcall-test: OPENAI_API_KEY is not set (.env or environment).");
  process.exit(2);
}
if (!TOKEN) process.env.AUTH_DISABLED = "true"; // this process only; the route then skips the session check
// The auth middleware loads the db module, which needs a URL to load; with
// AUTH_DISABLED nothing queries it.
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://unused:unused@127.0.0.1:1/unused";

const B = path.join(__dirname, "..", "src");
const WebSocket = require("ws");
const { FORMAT } = require(`${B}/ai/missedcall/session`);
const route = require(`${B}/ai/missedcall/route`);
const { summarizeSession } = require(`${B}/ai/missedcall/summary`);
const { wavWrap } = require(`${B}/services/ai/openai`);

const RATE = FORMAT.rate; // 24000
const FRAME_MS = 100;
const FRAME_BYTES = (RATE / 1000) * FRAME_MS * 2;
const BYTES_PER_MS = (RATE * 2) / 1000;
const OPENING_WAIT_MS = 15_000; // no opening by then: speak anyway
const QUIET_AFTER_MS = 1_200; // the AI is done once its audio has played out plus this

// ---------------------------------------------------------------- WAV → PCM16 mono 24 kHz
function readWav(file) {
  const b = fs.readFileSync(file);
  if (b.toString("ascii", 0, 4) !== "RIFF" || b.toString("ascii", 8, 12) !== "WAVE") throw new Error(`${file}: not a RIFF/WAVE file`);
  let fmt = null, data = null;
  for (let p = 12; p + 8 <= b.length;) {
    const id = b.toString("ascii", p, p + 4);
    const size = b.readUInt32LE(p + 4);
    const body = b.subarray(p + 8, Math.min(b.length, p + 8 + size));
    if (id === "fmt ") {
      let code = body.readUInt16LE(0);
      if (code === 0xfffe && body.length >= 26) code = body.readUInt16LE(24); // WAVE_FORMAT_EXTENSIBLE
      fmt = { code, channels: body.readUInt16LE(2), rate: body.readUInt32LE(4), bits: body.readUInt16LE(14) };
    } else if (id === "data") data = body;
    p += 8 + size + (size % 2);
  }
  if (!fmt || !data) throw new Error(`${file}: no fmt or data chunk`);
  const { code, channels, rate, bits } = fmt;
  const bytes = bits / 8;
  const read =
    code === 1 && bits === 16 ? (o) => data.readInt16LE(o) / 32768 :
    code === 1 && bits === 8 ? (o) => (data.readUInt8(o) - 128) / 128 :
    code === 1 && bits === 24 ? (o) => data.readIntLE(o, 3) / 8388608 :
    code === 1 && bits === 32 ? (o) => data.readInt32LE(o) / 2147483648 :
    code === 3 && bits === 32 ? (o) => data.readFloatLE(o) :
    null;
  if (!read || !channels || !rate) throw new Error(`${file}: unsupported WAV (format ${code}, ${bits}-bit, ${channels} ch)`);
  const n = Math.floor(data.length / (bytes * channels));
  const mono = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let c = 0; c < channels; c++) s += read((i * channels + c) * bytes);
    mono[i] = s / channels;
  }
  // Linear resample to the route's rate.
  const outN = Math.floor((n * RATE) / rate);
  const pcm = Buffer.alloc(outN * 2);
  const step = rate / RATE;
  for (let j = 0; j < outN; j++) {
    const x = j * step, i = Math.floor(x), f = x - i;
    const v = i + 1 < n ? mono[i] * (1 - f) + mono[i + 1] * f : mono[Math.min(i, n - 1)];
    pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * 32767), j * 2);
  }
  return { pcm, src: fmt, seconds: n / rate };
}

// ---------------------------------------------------------------- the call
(async () => {
  const caller = readWav(WAV);
  const { src } = caller;
  console.log(`caller: ${WAV} — ${caller.seconds.toFixed(1)} s, ${src.rate} Hz ${src.bits}-bit ${src.channels} ch → PCM16 mono ${RATE} Hz`);

  const server = route.listen(0);
  if (!server) throw new Error("route did not start");
  await new Promise((r) => (server.listening ? r() : server.once("listening", r)));
  const url = `ws://127.0.0.1:${server.address().port}${route.PATH}?source=laptop`;

  const ws = new WebSocket(url);
  const ai = [];
  let phase = "connecting"; // connecting → opening → speaking → listening → stopping
  let tStart = 0, tReady = 0, tFirstAudio = 0, tWavEnd = 0, tFirstReply = 0;
  let playbackEnds = 0, sentFrom = 0, clears = 0, ended = null, callId = null;
  const silence = Buffer.alloc(FRAME_BYTES);
  const ms = (t) => `${Math.round(t)} ms`;

  let finished = false;
  const finish = async (code) => {
    if (finished) return;
    finished = true;
    clearInterval(pump);
    clearTimeout(cap);
    // The summary of the call as the route keeps it (in memory, on the session).
    const call = callId ? route.sessions.get(callId) : null;
    let summary = null, summaryMs = 0;
    if (!NO_SUMMARY && call) {
      const t = Date.now();
      // The session reaches "ended" a moment after the route's message.
      for (let i = 0; i < 50 && call.state !== "ended"; i++) await new Promise((r) => setTimeout(r, 100));
      summary = await summarizeSession(call);
      summaryMs = Date.now() - t;
    }
    if (ai.length) {
      fs.writeFileSync(OUT, wavWrap(Buffer.concat(ai), RATE));
      console.log(`\nAI audio saved: ${OUT} (${(Buffer.concat(ai).length / BYTES_PER_MS / 1000).toFixed(1)} s)`);
    } else console.log("\nno AI audio received; nothing saved");
    console.log("\nTRANSCRIPT");
    for (const t of (ended && ended.transcript) || []) {
      console.log(`  ${t.role === "caller" ? "CALLER" : "AI    "} ${t.text.trim()}${t.interrupted ? "  [interrupted]" : ""}`);
    }
    console.log("\nTIMINGS");
    console.log(`  start → ready:              ${tReady ? ms(tReady - tStart) : "—"}`);
    console.log(`  start → first AI audio:     ${tFirstAudio ? ms(tFirstAudio - tStart) : "— (none)"}`);
    console.log(`  end of WAV → first reply:   ${tFirstReply ? ms(tFirstReply - tWavEnd) : "— (none)"}`);
    console.log(`  barge-in clears:            ${clears}`);
    console.log(`  ended:                      ${ended ? ended.reason : "no 'ended' message"}`);
    for (const e of (ended && ended.errors) || []) console.log(`  error: ${e}`);
    if (NO_SUMMARY) console.log("\nSUMMARY  (skipped: --no-summary)");
    else if (!summary) console.log("\nSUMMARY  — no session to summarize");
    else if (summary.empty) console.log(`\nSUMMARY  nothing to summarize: ${summary.reason}`);
    else if (summary.error) console.log(`\nSUMMARY  FAILED (${summary.error}): ${summary.message}${(summary.problems || []).length ? ` — ${summary.problems.join("; ")}` : ""}`);
    else {
      // The paragraph first, as the owner reads it; everything else is details.
      console.log(`\nSUMMARY  (${summaryMs} ms)`);
      const wrap = (t, w = 92) => t.split(" ").reduce((ls, word) => {
        if (ls.length && (ls[ls.length - 1] + " " + word).length <= w) ls[ls.length - 1] += " " + word;
        else ls.push(word);
        return ls;
      }, []);
      for (const line of wrap(summary.summary)) console.log(`  ${line}`);
      if (summary.ai_committed) console.log(`  !! The AI promised something on the owner's behalf: ${summary.ai_commitments.join("; ")}`);
      const { summary: _, ...details } = summary;
      console.log(`\n  details: ${JSON.stringify(details)}`);
    }
    const summaryOk = NO_SUMMARY || (summary && !summary.error);
    const ok = code === 0 && tFirstReply > 0 && !((ended && ended.errors) || []).length && summaryOk;
    console.log(ok ? "\nMISSED-CALL E2E PASSED" : "\nMISSED-CALL E2E FAILED");
    server.close();
    setTimeout(() => process.exit(ok ? 0 : 1), 200);
  };
  const stop = (why) => {
    if (phase === "stopping") return;
    console.log(`  … stopping: ${why}`);
    phase = "stopping";
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "stop" }));
    // The route answers with "ended" and closes; don't hang if it doesn't.
    setTimeout(() => finish(1), 20_000).unref();
  };
  const cap = setTimeout(() => stop(`timeout ${TIMEOUT_S}s`), TIMEOUT_S * 1000);

  // One frame every 100 ms, the whole call: silence, or the WAV while speaking.
  const pump = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN || phase === "connecting" || phase === "stopping") return;
    const now = Date.now();
    const aiQuiet = playbackEnds && now > playbackEnds + QUIET_AFTER_MS;
    if (phase === "opening" && (aiQuiet || now - tReady > OPENING_WAIT_MS)) {
      console.log(tFirstAudio ? "  … opening done; caller speaks" : "  … no opening heard; caller speaks anyway");
      phase = "speaking";
    }
    if (phase === "speaking") {
      const chunk = caller.pcm.subarray(sentFrom, sentFrom + FRAME_BYTES);
      sentFrom += chunk.length;
      ws.send(chunk.length === FRAME_BYTES ? chunk : Buffer.concat([chunk, silence.subarray(chunk.length)]), { binary: true });
      if (sentFrom >= caller.pcm.length) { phase = "listening"; tWavEnd = Date.now(); console.log("  … WAV sent; listening"); }
      return;
    }
    ws.send(silence, { binary: true });
    if (phase === "listening" && tFirstReply && aiQuiet) stop("AI reply finished");
  }, FRAME_MS);

  ws.on("open", () => {
    tStart = Date.now();
    ws.send(JSON.stringify({ type: "start", token: TOKEN, callerName: CALLER_NAME }));
  });
  ws.on("message", (data, isBinary) => {
    const now = Date.now();
    if (isBinary) {
      ai.push(Buffer.from(data));
      if (!tFirstAudio) tFirstAudio = now;
      if (phase === "listening" && !tFirstReply) tFirstReply = now;
      playbackEnds = Math.max(playbackEnds, now) + data.length / BYTES_PER_MS;
      return;
    }
    const m = JSON.parse(String(data));
    if (m.type === "ready") { tReady = now; callId = m.id; phase = "opening"; console.log(`  ready: ${m.id}, voice ${m.voice}, ${m.format.type} ${m.format.rate} Hz`); }
    else if (m.type === "transcript") process.stdout.write(m.role === "caller" ? `\x1b[36m${m.delta}\x1b[0m` : m.delta);
    else if (m.type === "clear") { clears++; playbackEnds = now; console.log("\n  [barge-in: clear]"); }
    else if (m.type === "ended") { ended = m; process.stdout.write("\n"); }
    else if (m.type === "error") console.log(`\n  route error: ${m.error}`);
  });
  ws.on("close", () => finish(ended ? 0 : 1));
  ws.on("error", (e) => { console.error(`socket error: ${e.message}`); finish(1); });
})().catch((e) => {
  console.error(`missedcall-test: ${e.message}`);
  process.exit(1);
});

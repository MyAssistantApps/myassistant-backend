/**
 * MISSED-CALL CALLBACK — ONE CALL: source → GPT-Live → sink (2026-11-01).
 *
 * Talk only: gpt-live-1, no delegation, no tools (liveVoices.record starts
 * gpt-live-1 the same way, without delegation).
 *
 * PROTOCOL — only what OpenAI's WebSocket guide for GPT-Live
 * (developers.openai.com/api/docs/guides/voice-websockets?api=live) and
 * our own working code (liveVoices.js, scripts/gpt-live-e2e.js, the
 * phone's gpt_live.dart) use:
 *   client: session.start, session.input_audio.append,
 *           session.instructions.append, session.close
 *   server: session.started, session.output_audio.delta,
 *           session.input_transcript.delta, session.output_transcript.delta,
 *           error, session.closed
 *
 * AUDIO FORMAT. One format for input AND output, fixed at session.start:
 * audio/pcm 24000 or 16000 (mono PCM16 LE), or audio/pcmu / audio/pcma
 * 8000. The laptop page captures and plays 24 kHz PCM16, so no resampler.
 *
 * BARGE-IN. The guide names NO interruption event and NO clear command for
 * WebSocket sessions; GPT-Live is full duplex and the client tracks its
 * own playback. Our rule (owner, 2026-11-01): the caller speaking while AI
 * audio is still playing on their end → sink.clear(), and the AI's audio is
 * dropped while the caller keeps talking (and for a short pause after).
 * Speech is seen at once in the caller's own audio (callerVoice, by
 * loudness) and also from their words (session.input_transcript.delta,
 * which come later). How long audio plays is computed from the bytes sent,
 * since the API gives no timing.
 *
 * THE TRANSCRIPT of both sides stays on this object (`transcript`), in
 * memory only, for the summary endpoint later. Nothing is stored. A caller
 * who never spoke leaves only the AI's lines in it, which summary.js treats
 * as empty (no model call, no invented summary).
 *
 * THE AI SPEAKS FIRST: on session.started its exact opening line is asked
 * for with session.instructions.append (as the phone asks for its opening).
 * A caller who stays silent gets one prompt, then a goodbye, then the call
 * ends (SILENCE_* below). Talking over any of it is the usual barge-in.
 */
const WebSocket = require("ws");
const openai = require("../../services/ai/openai");
const gptLive = require("../gptLive");
const prompt = require("./prompt");

const LIVE_URL = "wss://api.openai.com/v1/live/sessions";
const FORMAT = { type: "audio/pcm", rate: 24000 };
const BYTES_PER_MS = (FORMAT.rate * 2) / 1000; // PCM16 mono
const MAX_CALL_MS = 5 * 60_000; // hard cap per call
const WRAP_UP_BEFORE_MS = 30_000; // ask it to say goodbye this long before the cap
const START_TIMEOUT_MS = 30_000; // as in the guide's example
const CLOSE_WAIT_MS = 15_000; // as in the guide's example
const BARGE_QUIET_MS = 500; // the caller's pause after which AI audio flows again
// THE CALLER'S VOICE, FROM THEIR AUDIO (immediate; the transcript comes a
// second or more later). A chunk louder than VOICE_RMS counts as speech once
// VOICE_MIN_MS of it has come in a row: the AI stops and listens, and the
// silence prompts never fire while they talk.
const VOICE_RMS = 700; // PCM16 RMS; background noise with the browser's noise suppression sits well below
const VOICE_MIN_MS = 150;
// A SILENT CALLER (until they first speak). Quiet is counted from the end of
// the AI's audio, and reset whenever anyone speaks.
const SILENCE_FIRST_MS = 2_000; // quiet after the opening → "Hello? … May I know who's calling?" (once)
const SILENCE_SECOND_MS = 2_000; // still quiet after that → "I can't hear you… Goodbye." and end
const GOODBYE_TAIL_MS = 600; // after the goodbye has played, then hang up
const GOODBYE_MAX_MS = 10_000; // hang up even if the goodbye never comes
const SILENCE_TICK_MS = 250;
// THE NUDGE THAT MAKES IT SPEAK FIRST. GPT-Live answers what it HEARS; a
// "say this now" instruction alone often leaves it silent (seen 2026-11-01;
// liveVoices.js says the same). So with each line the AI must say by
// itself, it hears a short spoken "Hello?" — as if the person just picked
// up — and answers it with that line. The same trick liveVoices.record and
// scripts/gpt-live-e2e.js use (a spoken hello sent as input audio). Only
// GPT-Live hears it; the caller never does, and it is kept out of the
// transcript. If the caller starts talking, the nudge stops and their audio
// goes through at once.
const HELLO_TEXT = "Hello?";
const FRAME_BYTES = 4800; // 100 ms of PCM16 mono 24 kHz
const NUDGE_MAX_MS = 4_000; // no answer by then: give up this nudge
const NUDGE_TRANSCRIPT_GRACE_MS = 1_500; // the hello's own transcript can come late: ignored this long
const NUDGE_BUFFER_MS = 500; // the caller's audio held while nudging (sent on if they start talking)

/** The spoken "Hello?" as 24 kHz PCM, made once per process (openai.speak "pcm" is 24 kHz 16-bit mono). */
let helloPcm = null;
function helloAudio() {
  if (!helloPcm) {
    helloPcm = openai.speak(HELLO_TEXT, { format: "pcm" })
      .then((o) => (Buffer.isBuffer(o) ? o : Buffer.from(o.buffer || o.audio || o)))
      .catch((e) => { helloPcm = null; throw e; });
  }
  return helloPcm;
}

let seq = 0;

/**
 * @param {object} o
 * @param {{start:Function,onAudio:Function,stop:Function}} o.source
 * @param {{sendAudio:Function,clear:Function,close:Function}} o.sink
 * @param {object|null} [o.profile] users/context.getProfile() of the owner
 * @param {string} [o.callerName] the caller's saved name, if any
 * @param {number} [o.maxMs] cap (never above 5 minutes)
 * @param {(s:object)=>void} [o.onEnd]
 * @param {(role:string, delta:string)=>void} [o.onTranscript] each piece of the transcript as it is kept
 */
function createMissedCallSession({ source, sink, profile = null, callerName = "", maxMs = MAX_CALL_MS, onEnd, onTranscript } = {}) {
  const user = (profile && profile.user) || {};
  const assistant = (profile && profile.assistant) || {};
  const cap = Math.min(MAX_CALL_MS, Math.max(10_000, Number(maxMs) || MAX_CALL_MS));
  const voice = gptLive.voiceFor(assistant.voice);
  const instructions = prompt.callbackInstructions({ assistantName: assistant.name, ownerName: user.name, callerName });
  const opening = prompt.openingInstruction({ ownerName: user.name });

  const s = {
    id: `mc_${Date.now().toString(36)}_${++seq}`,
    state: "new", // new → connecting → live → closing → ended
    startedAt: 0,
    endedAt: 0,
    endReason: "",
    voice,
    /** [{ role: "caller"|"assistant", text, atMs, interrupted? }] — in memory only. */
    transcript: [],
    bargeIns: 0,
    errors: [],
    usage: null,
    start,
    stop,
  };

  let ws = null;
  let ev = 0;
  let playbackEndsAt = 0; // when the audio already sent finishes playing on the caller's end
  let dropping = false; // AI audio is being dropped after a barge-in
  let lastCallerAt = 0;
  // Silent-caller ladder: 0 opening said, 1 prompted once, 2 goodbye said.
  let callerSpoke = false;
  let silenceStage = 0;
  let lastActivityAt = 0;
  let goodbyeAt = 0;
  let audioSinceGoodbye = false;
  let voicedMs = 0; // the caller's speech so far, in a row
  let lastVoiceAt = 0; // last time their audio had speech in it
  let nudging = null; // { timer, buffered[], started } while the "Hello?" nudge plays to GPT-Live
  let ignoreHeardUntil = 0; // the nudge's own transcript is not the caller's
  const timers = [];
  let endedResolve;
  s.ended = new Promise((r) => { endedResolve = r; });

  const now = () => Date.now();
  const atMs = () => (s.startedAt ? now() - s.startedAt : 0);
  const send = (o) => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ event_id: `${s.id}_${++ev}`, ...o }));
  };

  function note(role, delta) {
    if (!delta) return;
    const last = s.transcript[s.transcript.length - 1];
    if (last && last.role === role && !last.interrupted) last.text += delta;
    else s.transcript.push({ role, text: delta, atMs: atMs() });
    try { if (onTranscript) onTranscript(role, delta); } catch (_) {}
  }

  /** Still dropping the AI's output after a barge-in? Ends once the caller has paused. */
  function stillDropping() {
    if (dropping && now() - lastCallerAt >= BARGE_QUIET_MS) dropping = false;
    return dropping;
  }

  function bargeIn() {
    s.bargeIns++;
    dropping = true;
    playbackEndsAt = now();
    sink.clear();
    for (let i = s.transcript.length - 1; i >= 0; i--) {
      if (s.transcript[i].role === "assistant") { s.transcript[i].interrupted = true; break; }
    }
  }

  /**
   * Is the caller speaking right now? From their AUDIO only: their words
   * arrive after they have stopped, and counting those would cut the start
   * of the AI's reply.
   */
  const callerTalking = () => lastVoiceAt > 0 && now() - lastVoiceAt < BARGE_QUIET_MS;

  /** The caller's audio chunk: speech in it stops the AI at once and resets the silence wait. */
  function callerVoice(chunk) {
    const n = Math.floor(chunk.length / 2);
    if (!n) return;
    let sum = 0;
    for (let i = 0; i < n; i++) { const x = chunk.readInt16LE(i * 2); sum += x * x; }
    if (Math.sqrt(sum / n) < VOICE_RMS) { voicedMs = 0; return; }
    voicedMs += chunk.length / BYTES_PER_MS;
    if (voicedMs < VOICE_MIN_MS) return;
    lastVoiceAt = now();
    lastCallerAt = lastVoiceAt;
    ignoreHeardUntil = 0; // from here on, what is heard is them
    lastActivityAt = lastCallerAt;
    callerSpoke = true; // the silence prompts stop for good
    if (!dropping && now() < playbackEndsAt) bargeIn(); // the AI was speaking: stop and listen
  }

  /** Has the AI something to say: the same event as the opening (session.instructions.append). */
  const say = (content) => send({ type: "session.instructions.append", delegation_id: null, content });
  const sendAudio = (chunk) => send({ type: "session.input_audio.append", audio: chunk.toString("base64") });

  /**
   * A line the AI must say by itself: the instruction, then the "Hello?"
   * nudge so it actually speaks (see HELLO_TEXT). Without the hello audio
   * (text-to-speech failed) the instruction alone is still sent.
   */
  function speakFirst(content) {
    say(content);
    if (nudging) return;
    helloAudio().then(startNudge, (e) => console.warn(`missed-call ${s.id}: no hello nudge (${String(e.message || e).slice(0, 120)})`));
  }

  function startNudge(pcm) {
    if (s.state !== "live" || nudging || callerTalking()) return;
    const n = { buffered: [], started: now(), sent: 0, timer: null };
    nudging = n;
    const quiet = Buffer.alloc(FRAME_BYTES);
    n.timer = setInterval(() => {
      if (nudging !== n) return clearInterval(n.timer);
      if (n.sent < pcm.length) {
        const c = pcm.subarray(n.sent, n.sent + FRAME_BYTES);
        n.sent += c.length;
        sendAudio(c);
      } else {
        sendAudio(quiet); // its turn ends on the quiet after the hello
        if (now() - n.started > NUDGE_MAX_MS) endNudge({ answered: false });
      }
    }, 100);
  }

  /** The nudge is over: the AI answered it, or no answer came in time. */
  function endNudge({ answered }) {
    if (!nudging) return;
    clearInterval(nudging.timer);
    nudging = null;
    if (answered) ignoreHeardUntil = now() + NUDGE_TRANSCRIPT_GRACE_MS;
    else lastActivityAt = now();
  }

  /** The caller started talking during the nudge: stop it and send their audio on, nothing lost. */
  function cancelNudge() {
    if (!nudging) return;
    clearInterval(nudging.timer);
    const held = nudging.buffered;
    nudging = null;
    ignoreHeardUntil = 0;
    for (const c of held) sendAudio(c);
  }

  /**
   * A caller who never speaks: one prompt after SILENCE_FIRST_MS of quiet,
   * the goodbye after SILENCE_SECOND_MS more, then the call ends. Quiet is
   * measured from the later of the last activity and the end of the AI's
   * audio. Disarmed for good once the caller says anything.
   */
  function silenceTick() {
    if (s.state !== "live" || callerSpoke || nudging) return;
    const t = now();
    if (silenceStage === 2) {
      const played = audioSinceGoodbye && t > playbackEndsAt + GOODBYE_TAIL_MS;
      if (played || t - goodbyeAt > GOODBYE_MAX_MS) stop("caller silent");
      return;
    }
    if (t < playbackEndsAt) return; // the AI is still speaking
    const quiet = t - Math.max(lastActivityAt, playbackEndsAt);
    if (silenceStage === 0 && quiet >= SILENCE_FIRST_MS) {
      silenceStage = 1;
      lastActivityAt = t;
      speakFirst(prompt.silencePromptInstruction({ ownerName: user.name }));
    } else if (silenceStage === 1 && quiet >= SILENCE_SECOND_MS) {
      silenceStage = 2;
      goodbyeAt = t;
      speakFirst(prompt.SILENCE_GOODBYE_INSTRUCTION);
    }
  }

  function onEvent(raw) {
    let e;
    try { e = JSON.parse(String(raw)); } catch (_) { return; }
    switch (e.type) {
      case "session.started":
        if (s.state !== "connecting") return;
        s.state = "live";
        s.startedAt = now();
        source.onAudio((chunk) => {
          callerVoice(chunk);
          if (nudging) {
            // Held while GPT-Live hears the nudge; sent on the moment they start talking.
            nudging.buffered.push(chunk);
            let ms = nudging.buffered.reduce((a, c) => a + c.length / BYTES_PER_MS, 0);
            while (ms > NUDGE_BUFFER_MS && nudging.buffered.length > 1) ms -= nudging.buffered.shift().length / BYTES_PER_MS;
            if (callerTalking()) cancelNudge();
            return;
          }
          sendAudio(chunk);
        });
        source.start();
        // The AI speaks first: the exact opening line, with the "Hello?" nudge.
        speakFirst(opening);
        lastActivityAt = now();
        timers.push(setInterval(silenceTick, SILENCE_TICK_MS));
        timers.push(setTimeout(() => say(prompt.WRAP_UP_INSTRUCTION), cap - WRAP_UP_BEFORE_MS));
        timers.push(setTimeout(() => stop("time cap"), cap));
        console.log(`missed-call ${s.id}: live, voice=${voice}, cap=${Math.round(cap / 1000)}s`);
        break;
      case "session.output_audio.delta": {
        if (!e.delta || s.state !== "live") return;
        if (nudging) endNudge({ answered: true }); // it is answering the nudge: the caller's audio flows again
        // The caller is talking (even before the opening came): the AI listens, nothing plays.
        if (!dropping && callerTalking()) bargeIn();
        if (stillDropping()) return;
        const buf = Buffer.from(e.delta, "base64");
        playbackEndsAt = Math.max(playbackEndsAt, now()) + buf.length / BYTES_PER_MS;
        if (silenceStage === 2) audioSinceGoodbye = true;
        sink.sendAudio(buf);
        break;
      }
      case "session.input_transcript.delta":
        if (!e.delta) return;
        // The nudge's "Hello?" coming back as words: not the caller.
        if (nudging || now() < ignoreHeardUntil) return;
        lastCallerAt = now();
        lastActivityAt = lastCallerAt;
        if (String(e.delta).trim()) callerSpoke = true; // the silence ladder stops for good
        if (now() < playbackEndsAt) bargeIn();
        note("caller", String(e.delta));
        break;
      case "session.output_transcript.delta":
        if (e.delta && !stillDropping()) note("assistant", String(e.delta));
        break;
      case "error": {
        const msg = String((e.error && (e.error.message || e.error.code)) || "GPT-Live error").slice(0, 300);
        s.errors.push(msg);
        console.warn(`missed-call ${s.id}: ${msg}`);
        if (s.state === "connecting") stop("start failed");
        break;
      }
      case "session.closed":
        s.usage = e.usage || null;
        finish(s.endReason || `closed by OpenAI${e.reason ? `: ${e.reason}` : ""}`);
        break;
      default:
        break;
    }
  }

  function start() {
    if (s.state !== "new") return s.ended;
    if (!openai.ready()) {
      s.errors.push("OPENAI_API_KEY is not set");
      finish("not configured");
      return s.ended;
    }
    s.state = "connecting";
    helloAudio().catch(() => {}); // ready before the session starts
    ws = new WebSocket(LIVE_URL, { headers: { Authorization: `Bearer ${openai.key()}` } });
    timers.push(setTimeout(() => { if (s.state === "connecting") stop("start timed out"); }, START_TIMEOUT_MS));
    ws.on("open", () => send({
      type: "session.start",
      session: {
        model: gptLive.MODEL,
        instructions,
        audio: { format: FORMAT, output: { voice } },
      },
    }));
    ws.on("message", onEvent);
    ws.on("error", (err) => {
      s.errors.push(`socket: ${String(err && err.message || err).slice(0, 200)}`);
      finish(s.endReason || "socket error");
    });
    ws.on("close", () => finish(s.endReason || "socket closed"));
    return s.ended;
  }

  /** Ends the call: the caller's audio stops, GPT-Live is closed, the sink closes. */
  function stop(reason = "stopped") {
    if (s.state === "closing" || s.state === "ended") return s.ended;
    s.endReason = s.endReason || reason;
    s.state = "closing";
    try { source.stop(); } catch (_) {}
    if (ws && ws.readyState === WebSocket.OPEN) {
      send({ type: "session.close" });
      // session.closed carries the final usage; don't wait for it forever.
      timers.push(setTimeout(() => finish(s.endReason), CLOSE_WAIT_MS));
    } else {
      finish(s.endReason);
    }
    return s.ended;
  }

  function finish(reason) {
    if (s.state === "ended") return;
    s.state = "ended";
    s.endReason = s.endReason || reason;
    s.endedAt = now();
    for (const t of timers) { clearTimeout(t); clearInterval(t); }
    if (nudging) { clearInterval(nudging.timer); nudging = null; }
    try { source.stop(); } catch (_) {}
    // Before the sink closes, so the route can still tell the browser.
    try { if (onEnd) onEnd(s); } catch (_) {}
    try { sink.close(); } catch (_) {}
    if (ws) {
      ws.removeAllListeners("message");
      ws.on("error", () => {});
      try { ws.close(); } catch (_) {}
    }
    const secs = s.startedAt ? Math.round((s.endedAt - s.startedAt) / 1000) : 0;
    console.log(`missed-call ${s.id}: ended (${s.endReason}) after ${secs}s, ${s.transcript.length} turns, ${s.bargeIns} barge-ins`);
    endedResolve(s);
  }

  return s;
}

module.exports = { createMissedCallSession, FORMAT, MAX_CALL_MS, SILENCE_FIRST_MS, SILENCE_SECOND_MS };

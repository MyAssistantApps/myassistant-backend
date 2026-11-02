/**
 * MISSED-CALL CALLBACK — AUDIO SOURCE: EXOTEL (not built yet).
 *
 * Interface every source keeps: start(), onAudio(cb), stop().
 *
 * TODO(exotel): NOTHING BELOW IS VERIFIED. Before writing this, read
 * Exotel's own Voice Streaming / Voicebot applet documentation and record
 * here, with the link:
 *   - how Exotel connects (it dials our WebSocket, or we dial it) and how
 *     that connection is authenticated;
 *   - the message envelope (event names for start / media / stop, and the
 *     field that carries the audio, e.g. base64 payload);
 *   - the audio encoding and sample rate it sends.
 * GPT-Live accepts, for input and output alike (one format per session,
 * fixed at session.start): audio/pcm 24000 or 16000 (mono PCM16 LE), or
 * audio/pcmu / audio/pcma 8000 (G.711). If Exotel's format is one of
 * those, session.js can be started with it and needs no resampler; if
 * not, a resampler goes between this source and the session.
 */
function exotelSource() {
  throw new Error("exotel source is not configured");
}

module.exports = { exotelSource };

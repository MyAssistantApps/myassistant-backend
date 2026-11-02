/**
 * MISSED-CALL CALLBACK — AUDIO SINK: EXOTEL (not built yet).
 *
 * Interface every sink keeps: sendAudio(chunk), clear(), close().
 *
 * TODO(exotel): NOTHING BELOW IS VERIFIED. Before writing this, read
 * Exotel's Voice Streaming / Voicebot documentation and record here, with
 * the link:
 *   - the message that plays audio to the caller (envelope, encoding,
 *     sample rate, any chunk-size rule);
 *   - whether Exotel has a message that flushes audio already sent
 *     (needed by clear() for barge-in) — and if it has none, say so;
 *   - how our side ends the call.
 * The session's output format equals its input format (GPT-Live fixes one
 * format per session), so this sink receives what exotelSource receives.
 */
function exotelSink() {
  throw new Error("exotel sink is not configured");
}

module.exports = { exotelSink };

/**
 * MISSED-CALL CALLBACK — AUDIO SOURCE: A LAPTOP BROWSER (dev, 2026-11-01).
 *
 * Interface every source keeps: start(), onAudio(cb), stop().
 *
 * The browser sends the caller's microphone on the same WebSocket as
 * BINARY frames: raw PCM, mono, signed 16-bit little-endian, 24000 Hz —
 * exactly the session's format (session.js FORMAT), so nothing is
 * resampled. Text frames are control messages and belong to the route,
 * not to the source.
 */
const MAX_CHUNK = 96_000; // 2 s of 24 kHz PCM16; a larger frame is not a mic chunk

function laptopSource(ws) {
  let listener = null;
  let running = false;
  const onMessage = (data, isBinary) => {
    if (!running || !isBinary || !listener) return;
    const buf = Buffer.isBuffer(data) ? data : Buffer.concat(Array.isArray(data) ? data : [Buffer.from(data)]);
    // PCM16 is whole samples: an odd byte or an oversized frame is dropped.
    if (!buf.length || buf.length % 2 || buf.length > MAX_CHUNK) return;
    listener(buf);
  };
  return {
    kind: "laptop",
    start() {
      if (running) return;
      running = true;
      ws.on("message", onMessage);
    },
    onAudio(cb) {
      listener = typeof cb === "function" ? cb : null;
    },
    stop() {
      running = false;
      listener = null;
      ws.off("message", onMessage);
    },
  };
}

module.exports = { laptopSource };

/**
 * MISSED-CALL CALLBACK — AUDIO SINK: A LAPTOP BROWSER (dev, 2026-11-01).
 *
 * Interface every sink keeps: sendAudio(chunk), clear(), close().
 *
 * The AI's voice goes back on the browser's WebSocket as BINARY frames of
 * PCM16 mono 24000 Hz (session.js FORMAT). clear() is a text frame
 * {"type":"clear"}: the page drops every chunk it has queued but not yet
 * played (the caller talked over the AI).
 */
const WebSocket = require("ws");

function laptopSink(ws) {
  const open = () => ws.readyState === WebSocket.OPEN;
  return {
    kind: "laptop",
    sendAudio(chunk) {
      if (open() && chunk && chunk.length) ws.send(chunk, { binary: true });
    },
    clear() {
      if (open()) ws.send(JSON.stringify({ type: "clear" }));
    },
    close() {
      if (open()) ws.close(1000, "call ended");
    },
  };
}

module.exports = { laptopSink };

/**
 * MISSED-CALL CALLBACK — DEV ROUTE (2026-11-01).
 *
 *   WebSocket  ws://127.0.0.1:<port>/ai/missed-call/stream?source=laptop
 *   Test page  http://127.0.0.1:<port>/dev/missed-call-test  (devpage.html)
 *   Summary    POST http://127.0.0.1:<port>/ai/missed-call/summary  (summary.js; see onSummary)
 *
 * NOT IN PRODUCTION: listen() does nothing when NODE_ENV is "production",
 * and server.js only calls it outside production. Its own port (default
 * 3001, MISSED_CALL_DEV_PORT), bound to 127.0.0.1 only: the main server's
 * upgrade handler (ai/gone.js attachUpgrade) destroys every WebSocket
 * other than /live/ws, so this cannot share the main port without
 * changing that file.
 *
 * PROTOCOL WITH THE BROWSER
 *   → text  {"type":"start","token":"<session JWT>","callerName":"optional"}
 *           first, within 10 s. The token is checked by the app's own
 *           verifySession (middleware/auth.js); AUTH_DISABLED=true skips it,
 *           as appAuth does.
 *   → bin   the caller's microphone, PCM16 mono 24 kHz (laptopSource)
 *   → text  {"type":"stop"}  hang up
 *   ← text  {"type":"ready","id","voice","format","maxSec"}
 *   ← bin   the AI's voice, PCM16 mono 24 kHz (laptopSink)
 *   ← text  {"type":"transcript","role":"caller"|"assistant","delta"}  live, as it is heard/said
 *   ← text  {"type":"clear"}  drop queued audio (barge-in)
 *   ← text  {"type":"ended","reason","transcript"}  then the socket closes
 */
const http = require("http");
const WebSocket = require("ws");
const { verifySession } = require("../../middleware/auth");
const { laptopSource } = require("./laptopSource");
const { laptopSink } = require("./laptopSink");
const { exotelSource } = require("./exotelSource");
const { exotelSink } = require("./exotelSink");
const { createMissedCallSession, FORMAT, MAX_CALL_MS } = require("./session");

const PATH = "/ai/missed-call/stream";
const PAGE = "/dev/missed-call-test";
const SUMMARY_PATH = "/ai/missed-call/summary";
const PAGE_FILE = require("path").join(__dirname, "devpage.html");
const MAX_LIVE = 2; // calls at once on a dev box
const START_MSG_MS = 10_000;
const KEEP_ENDED = 20; // ended calls kept in memory (their transcripts and summaries)

/** Calls by id, live and recently ended. In memory only; nothing is stored. */
const sessions = new Map();
const liveCount = () => [...sessions.values()].filter((s) => s.state !== "ended").length;
function remember(s) {
  sessions.set(s.id, s);
  const ended = [...sessions.values()].filter((x) => x.state === "ended");
  for (const old of ended.slice(0, Math.max(0, ended.length - KEEP_ENDED))) sessions.delete(old.id);
}

const SOURCES = {
  laptop: (ws) => ({ source: laptopSource(ws), sink: laptopSink(ws) }),
  exotel: () => ({ source: exotelSource(), sink: exotelSink() }), // throws: not configured
};

const say = (ws, o) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(o)); };
const refuse = (ws, msg, code = 1008) => { say(ws, { type: "error", error: msg }); ws.close(code, msg.slice(0, 120)); };

async function owner(token) {
  if (process.env.AUTH_DISABLED === "true") return { uid: null, profile: null };
  const v = await verifySession(token);
  if (v.error) throw Object.assign(new Error(v.error), { auth: true });
  const profile = await require("../../users/context").getProfile(v.user.id).catch(() => null);
  return { uid: v.user.id, profile };
}

function onConnection(ws, kind) {
  ws.on("error", () => {});
  let made;
  try {
    made = SOURCES[kind](ws);
  } catch (e) {
    return refuse(ws, String(e.message || e), 1011);
  }
  let call = null;
  const wait = setTimeout(() => refuse(ws, "send {type:start} first"), START_MSG_MS);

  ws.on("message", async (data, isBinary) => {
    if (isBinary) return; // audio: the source's
    let m;
    try { m = JSON.parse(String(data)); } catch (_) { return; }
    if (m.type === "stop") { if (call) call.stop("caller hung up"); return; }
    if (m.type !== "start" || call) return;
    clearTimeout(wait);
    if (liveCount() >= MAX_LIVE) return refuse(ws, "too many calls at once", 1013);
    let who;
    try {
      who = await owner(typeof m.token === "string" ? m.token : "");
    } catch (e) {
      return refuse(ws, e.auth ? e.message : "could not check the session", e.auth ? 1008 : 1011);
    }
    if (ws.readyState !== WebSocket.OPEN || call) return;
    call = createMissedCallSession({
      source: made.source,
      sink: made.sink,
      profile: who.profile,
      callerName: typeof m.callerName === "string" ? m.callerName : "",
      onEnd: (s) => say(ws, { type: "ended", reason: s.endReason, errors: s.errors, transcript: s.transcript }),
      onTranscript: (role, delta) => say(ws, { type: "transcript", role, delta }),
    });
    call.uid = who.uid;
    remember(call);
    say(ws, { type: "ready", id: call.id, voice: call.voice, format: FORMAT, maxSec: MAX_CALL_MS / 1000 });
    call.start();
  });

  ws.on("close", () => {
    clearTimeout(wait);
    if (call) call.stop("caller disconnected");
  });
}

/**
 * POST /ai/missed-call/summary — body { sessionId } (a finished call's
 * in-memory transcript; the summary is kept on that session) or
 * { transcript: [...] } in the session's format (summarized, not kept).
 * Same session check as the stream: Authorization: Bearer <token>, skipped
 * under AUTH_DISABLED=true; a call is summarized only for its own owner.
 */
const MAX_BODY = 256 * 1024;
const STATUS = { invalid_transcript: 400, call_not_ended: 409, model_failed: 502, summary_invalid: 502 };
function onSummary(req, res) {
  const reply = (status, body) => {
    if (res.headersSent) return;
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify(body));
  };
  let size = 0;
  const parts = [];
  req.on("data", (c) => {
    size += c.length;
    if (size > MAX_BODY) { reply(413, { error: "body too large" }); req.destroy(); }
    else parts.push(c);
  });
  req.on("end", async () => {
    if (size > MAX_BODY) return;
    let body;
    try { body = JSON.parse(Buffer.concat(parts).toString("utf8") || "{}"); } catch (_) { return reply(400, { error: "invalid JSON body" }); }
    if (!body || typeof body !== "object") return reply(400, { error: "invalid JSON body" });
    let who;
    try {
      const authz = String(req.headers.authorization || "");
      who = await owner(authz.startsWith("Bearer ") ? authz.slice(7) : "");
    } catch (e) {
      return reply(e.auth ? 401 : 503, { error: e.auth ? e.message : "could not check the session" });
    }
    const summary = require("./summary");
    let out;
    if (typeof body.sessionId === "string" && body.sessionId) {
      const call = sessions.get(body.sessionId);
      if (!call || (call.uid != null && who.uid != null && String(call.uid) !== String(who.uid))) {
        return reply(404, { error: "no such call" });
      }
      out = await summary.summarizeSession(call);
    } else if (Array.isArray(body.transcript)) {
      out = await summary.summarize(body.transcript);
    } else {
      return reply(400, { error: "send { sessionId } or { transcript: [...] }" });
    }
    reply(out.error ? STATUS[out.error] || 500 : 200, out);
  });
  req.on("error", () => {});
}

/** Starts the dev server. Returns the http.Server, or null in production. */
function listen(port = 3001, host = "127.0.0.1") {
  if (process.env.NODE_ENV === "production") return null;
  const wss = new WebSocket.Server({ noServer: true, maxPayload: 256 * 1024 });
  const server = http.createServer((req, res) => {
    const path = new URL(req.url, "http://localhost").pathname;
    if (req.method === "POST" && path === SUMMARY_PATH && process.env.NODE_ENV !== "production") {
      return onSummary(req, res);
    }
    if (req.method === "GET" && path === PAGE && process.env.NODE_ENV !== "production") {
      // Read per request: an edit to the page shows on reload.
      return require("fs").readFile(PAGE_FILE, (err, html) => {
        if (err) { res.writeHead(500); return res.end("devpage.html missing"); }
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        res.end(html);
      });
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
  server.on("upgrade", (req, socket, head) => {
    socket.on("error", () => {});
    let url;
    try { url = new URL(req.url, "http://localhost"); } catch (_) { return socket.destroy(); }
    const kind = url.searchParams.get("source") || "";
    if (url.pathname !== PATH || !Object.prototype.hasOwnProperty.call(SOURCES, kind)) {
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, kind));
  });
  server.on("error", (e) => console.warn(`  missed-call (dev): not started — ${e.message}`));
  server.listen(port, host, () => console.log(`  missed-call (dev): http://${host}:${port}${PAGE}`));
  return server;
}

module.exports = { listen, sessions, PATH };

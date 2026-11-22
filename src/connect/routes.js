/**
 * CONNECT ROUTES (behind appAuth) — talk to a contact's assistant.
 *
 *   GET  /connect/people              contacts who use the app and take assistant calls
 *   GET  /connect/settings            → {open: everyone|contacts|off}
 *   PUT  /connect/settings            {open}
 *   GET  /connect/:id                 the host's card (assistant name, voice, photo?)
 *   GET  /connect/:id/photo           the host's photo (image)
 *   POST /connect/:id/secret          a realtime key for a session AS the host's assistant
 *   POST /connect/:id/tool            {name, args} → run a guest tool for the host
 *   POST /connect/:id/end             {transcript:[{role,text}]} → summary to the host
 *
 * The realtime session's voice, instructions and tools are set HERE, from
 * the host's own settings; anything the phone sends for them is ignored,
 * so a modified client cannot give itself the host's private tools.
 */
const router = require("express").Router();
const rateLimit = require("express-rate-limit");
const { tzFromReq } = require("../services/tz");
const svc = require("./service");

function uid(req, res) {
  const id = Number(req.user?.sub);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(401).json({ error: "sign in required" });
    return null;
  }
  return id;
}

function fail(res, e, where) {
  if (e instanceof svc.ConnectError) return res.status(e.status).json({ error: e.message, code: e.code });
  console.error(`connect ${where}:`, e.stack || e.message);
  return res.status(500).json({ error: "The connection could not be made. Please try again." });
}

// A session is a paid realtime call: a few per minute is plenty for a person.
const sessionLimit = rateLimit({
  windowMs: 10 * 60_000,
  limit: 10,
  keyGenerator: (req) => `connect:${req.user?.sub}`,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many assistant calls in a short time. Please wait a few minutes." },
});

// My bookings made through contacts' assistants (Home's top strip).
router.get("/bookings", async (req, res) => {
  const me = uid(req, res);
  if (!me) return;
  res.json({ bookings: await require("./bookings").upcomingFor(me).catch(() => []) });
});

router.post("/bookings/:bid(\\d+)/cancel", async (req, res) => {
  const me = uid(req, res);
  if (!me) return;
  const b = await require("./bookings").cancelByCaller(me, Number(req.params.bid)).catch(() => null);
  if (!b) return res.status(404).json({ error: "That booking was not found or is already cancelled." });
  res.json({ ok: true });
});

// The host has seen an urgent alert (tapped it): the pings stop.
router.post("/urgent/ack", async (req, res) => {
  const me = uid(req, res);
  if (!me) return;
  const id = Number(req.body?.id) || null;
  const n = await require("./urgent").ack(me, { id }).catch(() => 0);
  res.json({ ok: true, acknowledged: n });
});

router.get("/people", async (req, res) => {
  const id = uid(req, res);
  if (id === null) return;
  try {
    res.json({ people: await svc.people(id) });
  } catch (e) {
    fail(res, e, "GET /people");
  }
});

router.get("/settings", async (req, res) => {
  const id = uid(req, res);
  if (id === null) return;
  try {
    res.json({ open: await svc.getOpen(id), modes: svc.OPEN_MODES });
  } catch (e) {
    fail(res, e, "GET /settings");
  }
});

router.put("/settings", async (req, res) => {
  const id = uid(req, res);
  if (id === null) return;
  try {
    res.json({ open: await svc.setOpen(id, String(req.body?.open || "")) });
  } catch (e) {
    fail(res, e, "PUT /settings");
  }
});

router.get("/:id(\\d+)", async (req, res) => {
  const id = uid(req, res);
  if (id === null) return;
  try {
    res.json((await svc.host(id, req.params.id)).card);
  } catch (e) {
    fail(res, e, "GET /:id");
  }
});

router.get("/:id(\\d+)/photo", async (req, res) => {
  const id = uid(req, res);
  if (id === null) return;
  try {
    const p = await svc.photo(id, req.params.id);
    res.set("Content-Type", p.mime).set("Cache-Control", "private, max-age=600").send(p.buffer);
  } catch (e) {
    if (e.code === "missing_photo" || e.code === "missing_file") return res.status(404).json({ error: "no photo" });
    fail(res, e, "GET /:id/photo");
  }
});

router.post("/:id(\\d+)/secret", sessionLimit, async (req, res) => {
  const id = uid(req, res);
  if (id === null) return;
  try {
    const tz = tzFromReq(req);
    const s = await svc.sessionFor(id, req.params.id, { tz });
    const openai = require("../services/ai/openai");
    const cfg = require("../ai/config");
    const profile = await require("../users/context").getProfile(id).catch(() => null);
    const language = cfg.speechLanguage(profile?.user?.preferred_language).slice(0, 2);
    const out = await openai.realtimeClientSecret({
      language,
      silenceMs: cfg.liveBlock(id).silenceMs,
      user: id,
      parallelTools: false,
      voice: s.card.voice,
      instructions: s.instructions,
      tools: s.tools,
    });
    res.json({
      value: out.value, expiresAt: out.expiresAt, model: out.model,
      card: s.card, greeting: s.greeting,
    });
  } catch (e) {
    if (e instanceof svc.ConnectError) return fail(res, e, "POST /secret");
    res.status(502).json({ error: String(e.message || e).slice(0, 200) });
  }
});

router.post("/:id(\\d+)/tool", async (req, res) => {
  const id = uid(req, res);
  if (id === null) return;
  try {
    const b = req.body || {};
    const args = b.args && typeof b.args === "object" ? b.args : {};
    res.json(await svc.runGuestTool(id, req.params.id, String(b.name || ""), args, { tz: tzFromReq(req) }));
  } catch (e) {
    fail(res, e, "POST /tool");
  }
});

router.post("/:id(\\d+)/end", async (req, res) => {
  const id = uid(req, res);
  if (id === null) return;
  try {
    res.json(await svc.finish(id, req.params.id, req.body?.transcript));
  } catch (e) {
    fail(res, e, "POST /end");
  }
});

module.exports = router;

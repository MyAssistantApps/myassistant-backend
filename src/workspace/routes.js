/**
 * WORKSPACE ROUTES (behind appAuth) — the dashboard for every profession
 * without a Pro workspace (engineers, teachers, CAs, drivers, students…).
 *
 *   GET  /workspace                     → overview (pack, routines, today, momentum, plan)
 *   PUT  /workspace/routines/:id        {on, time?} → overview
 *   POST /workspace/plan                {force?}    → plan of the day
 *
 * Time zone from X-TZ-Offset, like every dated route.
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
  if (e instanceof svc.WorkspaceError) return res.status(e.status).json({ error: e.message });
  console.error(`workspace ${where}:`, e.stack || e.message);
  return res.status(500).json({ error: "The workspace could not be loaded. Please try again." });
}

router.get("/", async (req, res) => {
  const id = uid(req, res);
  if (id === null) return;
  try {
    res.json(await svc.overview(id, tzFromReq(req)));
  } catch (e) {
    fail(res, e, "GET /");
  }
});

router.put("/routines/:id", async (req, res) => {
  const id = uid(req, res);
  if (id === null) return;
  try {
    const b = req.body || {};
    res.json(await svc.setRoutine(id, String(req.params.id), { on: b.on === true, time: b.time }, tzFromReq(req)));
  } catch (e) {
    fail(res, e, "PUT /routines");
  }
});

// A plan is one AI call; a forced re-plan is the only way to repeat it.
const planLimit = rateLimit({
  windowMs: 60 * 60_000,
  limit: 12,
  keyGenerator: (req) => `ws-plan:${req.user?.sub}`,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "You have re-planned many times this hour. Please try again later." },
});

router.post("/plan", planLimit, async (req, res) => {
  const id = uid(req, res);
  if (id === null) return;
  try {
    res.json(await svc.planDay(id, tzFromReq(req), { force: req.body?.force === true }));
  } catch (e) {
    fail(res, e, "POST /plan");
  }
});

module.exports = router;

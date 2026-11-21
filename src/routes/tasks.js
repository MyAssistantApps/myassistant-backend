/**
 * TASK ROUTES (behind appAuth).
 *
 *   POST   /tasks/quick        → { queued } hand over a job and walk away
 *
 * The home-screen widget's fire-and-forget job: one instruction, queued as
 * a background turn whose outcome arrives as a push.
 */
const router = require("express").Router();

function uid(req, res) {
  const id = Number(req.user?.sub === "anonymous-dev" ? 0 : req.user?.sub);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "sign in required" });
    return null;
  }
  return id;
}

/**
 * HAND OVER A TASK AND WALK AWAY.
 *
 * His ask, 2026-09-21: a home-screen widget where "it's not like a
 * realtime communication — I will click on that mic orb and assign tasks
 * that the agent should properly analyse and do completely."
 *
 * So this is not a conversation. It takes one instruction, answers 202
 * immediately, and the queue runs the SAME background turn a scheduled
 * task runs — full tool access, the long timeout, and a push at the end
 * with what actually happened. The phone can be locked in a pocket by
 * then; nothing here needs it.
 *
 * Deliberately reusing `scheduled_task` rather than inventing a second
 * execution path: that handler already knows how to run a turn nobody is
 * watching, report honestly when it fails, and not double-run on a
 * restart.
 */
router.post("/quick", async (req, res) => {
  const id = uid(req, res);
  if (id === null) return;
  const task = String(req.body?.task || "").trim().slice(0, 800);
  if (!task) return res.status(400).json({ error: "task required" });

  const { one } = require("../db");
  // The same ceiling the scheduler uses — a widget that can be tapped
  // forty times while the phone is in a pocket must not become forty
  // agent turns.
  const pending = await one(
    `SELECT COUNT(*)::int AS n FROM jobs
      WHERE user_id=$1 AND kind='scheduled_task' AND status IN ('pending','running')`,
    [id]
  ).catch(() => ({ n: 0 }));
  if (pending.n >= 25) {
    return res.status(429).json({ error: "too many tasks already queued" });
  }

  const tz = Number(req.get("X-TZ-Offset"));
  try {
    const jobId = await require("../infra/jobs").enqueue(
      "scheduled_task",
      { task, tzOffsetMin: Number.isFinite(tz) ? tz : 330, source: "widget" },
      { userId: id, delayMs: 0 }
    );
    res.status(202).json({ queued: true, id: jobId });
  } catch (e) {
    console.error("quick task enqueue:", e.message);
    res.status(502).json({ error: "could not queue that" });
  }
});

module.exports = router;

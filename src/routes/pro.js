/**
 * GET /pro/brief?kind=doctor|advocate|business — the professional
 * assistant page's "Today": the AI summary, the numbers and what needs
 * the user now (src/pro/brief.js).
 * Header: X-TZ-Offset (minutes east of UTC; defaults to IST 330).
 * → { kind, headline, summary, suggestions[{label, ask}],
 *     stats[{key, label, value, alert}],
 *     needs[{kind, tone, title, detail, ask}], source, empty }
 */
const router = require("express").Router();
const { tzFromReq } = require("../services/tz");
const { KINDS, buildProBrief, template, cardsOf } = require("../pro/brief");

router.get("/brief", async (req, res) => {
  const kind = String(req.query.kind || "").toLowerCase();
  if (!KINDS.includes(kind)) {
    return res.status(400).json({ error: `kind must be one of ${KINDS.join(", ")}` });
  }
  const uid = Number(req.user?.sub);
  if (!Number.isInteger(uid) || uid <= 0) {
    // Dev/appKey sessions have no user row: the page's calm, empty state.
    const f = { kind, visits: [], owed: [], owedTotal: 0, people: 0, recentNotes: [], money: null };
    return res.json({ kind, ...template(f), ...cardsOf(f), source: "template", empty: true });
  }
  try {
    res.json(await buildProBrief(uid, kind, { tzOffsetMin: tzFromReq(req) }));
  } catch (e) {
    console.error("pro brief failed:", e.message);
    res.status(500).json({ error: "pro brief failed" });
  }
});

module.exports = router;

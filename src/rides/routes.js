/** /rides — the Home strip's view of a booked cab, and its Cancel. */
const express = require("express");
const svc = require("./service");

const router = express.Router();
const uid = (req) => Number(req.user?.sub);

router.get("/active", async (req, res) => {
  const ride = await svc.active(uid(req)).catch(() => null);
  res.json({ ride, canBook: svc.canBook() });
});

router.post("/:id(\\d+)/cancel", async (req, res) => {
  const ride = await svc.cancel(uid(req), Number(req.params.id)).catch(() => null);
  if (!ride) return res.status(404).json({ error: "No active ride to cancel." });
  res.json({ ride });
});

module.exports = router;

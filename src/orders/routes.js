/** /orders — the Home card's view of orders in progress, and Cancel. */
const express = require("express");
const svc = require("./service");

const router = express.Router();
const uid = (req) => Number(req.user?.sub);

router.get("/active", async (req, res) => {
  const orders = await svc.activeList(uid(req)).catch(() => []);
  res.json({ orders, canOrder: Object.fromEntries(svc.KINDS.map((k) => [k, svc.canOrder(k)])) });
});

router.post("/:id(\\d+)/cancel", async (req, res) => {
  const r = await svc.cancel(uid(req), Number(req.params.id)).catch(() => ({ ok: false }));
  if (!r.ok) {
    return res.status(r.error === "too_late" ? 409 : 404).json({
      error: r.error === "too_late" ? "This order can no longer be cancelled." : "No order to cancel.",
    });
  }
  res.json({ order: r.order });
});

module.exports = router;

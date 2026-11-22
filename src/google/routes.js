/**
 * GOOGLE LINK ROUTES (behind appAuth)
 * POST   /google/connect  { serverAuthCode }  → { ok }
 * GET    /google/status                       → { connected }
 * DELETE /google                              → { ok }   (revokes at Google)
 */
const router = require("express").Router();
const tokens = require("./tokens");

function uid(req, res) {
  let sub = req.user?.sub;
  if (sub === "anonymous-dev") sub = 0;
  const id = Number(sub);
  if (!Number.isInteger(id) || id < 0) {
    res.status(400).json({ error: "requires a signed-in account" });
    return null;
  }
  return id;
}

router.post("/connect", async (req, res) => {
  const id = uid(req, res);
  if (id === null) return;
  const code = req.body?.serverAuthCode;
  if (!code) return res.status(400).json({ error: "serverAuthCode required" });
  if (!process.env.GOOGLE_WEB_CLIENT_SECRET) {
    return res.status(500).json({ error: "server missing GOOGLE_WEB_CLIENT_SECRET" });
  }
  try {
    await tokens.connect(id, code);
    res.json({ ok: true });
  } catch (e) {
    console.warn("google connect failed:", e.message);
    res.status(400).json({ error: "could not link Google account" });
  }
});

router.get("/status", async (req, res) => {
  const id = uid(req, res);
  if (id === null) return;
  res.json({ connected: await tokens.isConnected(id) });
});

router.delete("/", async (req, res) => {
  const id = uid(req, res);
  if (id === null) return;
  await tokens.disconnect(id);
  res.json({ ok: true });
});

module.exports = router;

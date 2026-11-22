/**
 * Linked accounts: /accounts (signed in) and /link/:provider/callback
 * (public: the company redirects the user's browser here).
 */
const express = require("express");
const svc = require("./service");

const accounts = express.Router();
const uid = (req) => Number(req.user?.sub);

accounts.get("/", async (req, res) => {
  res.json({ accounts: await svc.status(uid(req)) });
});

accounts.get("/:provider/connect", async (req, res) => {
  try {
    res.json({ url: await svc.connectUrl(uid(req), String(req.params.provider)) });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.status ? e.message : "Unable to start linking. Please try again." });
  }
});

accounts.delete("/:provider", async (req, res) => {
  res.json({ ok: await svc.unlink(uid(req), String(req.params.provider)) });
});

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
function page(title, text, ok) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>body{font-family:system-ui,sans-serif;background:#140b24;color:#f3eefc;display:flex;
min-height:100vh;align-items:center;justify-content:center;margin:0}main{max-width:420px;padding:32px;text-align:center}
.i{font-size:56px}h1{font-size:22px}p{color:#b9acd3;line-height:1.5}</style></head><body><main>
<div class="i">${ok ? "&#10004;" : "&#9888;"}</div><h1>${esc(title)}</h1><p>${esc(text)}</p></main></body></html>`;
}

const link = express.Router();
link.get("/:provider/callback", async (req, res) => {
  res.set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'");
  try {
    const r = await svc.callback(String(req.params.provider), req.query || {});
    res.send(page(`${r.label} Linked`, `Your ${r.label} account is now linked to MyAssistant. Please return to the app.`, true));
  } catch (e) {
    res.status(400).send(page("Unable to Link", `${e.message || "Something went wrong"}. Please return to the app and try again.`, false));
  }
});

module.exports = { accounts, link };

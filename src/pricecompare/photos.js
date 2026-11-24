/**
 * PRODUCT PHOTOS FOR PRICE COMPARE (2026-11-24).
 *
 * The product search is a model's answer, and a model cannot see pictures
 * in a web search: the "image" URLs it wrote were missing or made up, so
 * the results grid and the product page showed empty boxes. This finds
 * real photos for a product NAME with Bing's image search (no key), and
 * hands back Bing's own thumbnails — served from its CDN, they load on
 * any phone, where a store's image server often refuses an app.
 *
 *   GET /price/photos?q=boAt Airdopes 141&n=4 → { photos: ["https://…", …] }
 *
 * Answers (an empty one included) are kept per name for a day, so a grid
 * of twelve costs its lookups once.
 */
const express = require("express");

const TIMEOUT_MS = 5000;
const FOUND_TTL_MS = 24 * 60 * 60_000;
const EMPTY_TTL_MS = 30 * 60_000;
const MAX_ENTRIES = 3000;
const MAX_PHOTOS = 8;
const UA = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36";

const cache = new Map(); // normalised name → { ts, photos }

function norm(q) {
  return String(q || "").replace(/\s+/g, " ").trim().toLowerCase().slice(0, 160);
}

/**
 * The thumbnails in a Bing image results page, largest-first size asked
 * for (Bing resizes on its CDN). Only its own https thumbnail host.
 */
function parseBing(html, n = 4) {
  const out = [];
  const seen = new Set();
  const re = /turl&quot;:&quot;(https:\/\/[a-z0-9.-]*\.mm\.bing\.net\/th[^&"]*)/gi;
  let m;
  while ((m = re.exec(String(html || ""))) && out.length < n) {
    const id = /[?&]id=([^&]+)/.exec(m[1]);
    if (!id || seen.has(id[1])) continue;
    seen.add(id[1]);
    out.push(`https://tse1.mm.bing.net/th?id=${id[1]}&w=600&h=600&c=7`);
  }
  return out;
}

async function bingPhotos(q, n) {
  const url = `https://www.bing.com/images/search?q=${encodeURIComponent(q)}&form=HDRSC2&first=1&safeSearch=Strict`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "en-IN,en;q=0.9" }, signal: ctrl.signal });
    if (!r.ok) return [];
    return parseBing(await r.text(), n);
  } finally {
    clearTimeout(timer);
  }
}

/** Photos of the product called `q`, at most `n`; [] when none are found. */
async function photosFor(q, n = 4, { search = bingPhotos } = {}) {
  const key = norm(q);
  if (key.length < 2) return [];
  const want = Math.max(1, Math.min(MAX_PHOTOS, Number(n) || 4));
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < (hit.photos.length ? FOUND_TTL_MS : EMPTY_TTL_MS) && (hit.photos.length >= want || hit.all)) {
    return hit.photos.slice(0, want);
  }
  let photos = [];
  try {
    photos = await search(key, MAX_PHOTOS);
  } catch (e) {
    console.warn("price photos: search failed:", e.message);
  }
  if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value);
  cache.set(key, { ts: Date.now(), photos, all: true });
  return photos.slice(0, want);
}

const router = express.Router();

router.get("/photos", async (req, res) => {
  const q = String(req.query.q || "").trim();
  if (!q) return res.status(400).json({ error: "Enter the product name." });
  const photos = await photosFor(q, req.query.n);
  res.json({ photos });
});

module.exports = { router, photosFor, parseBing, _cache: cache };

/**
 * LISTINGS — a professional's public page (doctor / advocate / business).
 * -------------------------------------------------------------------------
 *   pro_listings       one row per professional: what the public sees —
 *                      name, what they do, the place, exact address and
 *                      map pin, phone/WhatsApp, about, services, and
 *                      whether it is published. Timings, fee, registration
 *                      number and qualification are NOT copied: they are
 *                      read live from clinic_profiles so the page never
 *                      disagrees with the clinic settings.
 *   listing_photos     the cover photo (base64 JPEG/PNG, ≤ 400 KB).
 *   listing_posts      short posts / offers shown on the page and to
 *                      nearby users browsing. Never pushed to anyone.
 *   listing_requests   "Request a booking" from the public page or the
 *                      in-app search. The professional confirms (→ a real
 *                      appointment) or declines.
 *
 * Publishing rules (owner, 2026-11-14): doctors need a medical registration
 * number, advocates an enrolment number, before going public. Everyone
 * needs a name, an address, a map pin and a phone number.
 *
 * Self-migrating like clinic/store.js — no db.js change needed.
 */
const crypto = require("crypto");
const { query, one, run } = require("../db");

const DAY = 24 * 3600 * 1000;
const PERSONAS = ["doctor", "advocate", "business"];
const MAX_PHOTO_BYTES = 400 * 1024;
const POST_DAYS_DEFAULT = 14;
const POST_DAYS_MAX = 60;

let migrated = null;
function migrate() {
  if (!migrated) {
    migrated = run(`
      CREATE TABLE IF NOT EXISTS pro_listings (
        user_id       INTEGER PRIMARY KEY,
        persona       TEXT NOT NULL,
        slug          TEXT NOT NULL UNIQUE,
        display_name  TEXT NOT NULL DEFAULT '',
        headline      TEXT NOT NULL DEFAULT '',
        place_name    TEXT NOT NULL DEFAULT '',
        address       TEXT NOT NULL DEFAULT '',
        area          TEXT NOT NULL DEFAULT '',
        city          TEXT NOT NULL DEFAULT '',
        pincode       TEXT NOT NULL DEFAULT '',
        lat           DOUBLE PRECISION,
        lng           DOUBLE PRECISION,
        phone         TEXT NOT NULL DEFAULT '',
        whatsapp      TEXT NOT NULL DEFAULT '',
        about         TEXT NOT NULL DEFAULT '',
        services      TEXT NOT NULL DEFAULT '[]',
        languages     TEXT NOT NULL DEFAULT '',
        accepts_requests INTEGER NOT NULL DEFAULT 1,
        published     INTEGER NOT NULL DEFAULT 0,
        published_at  BIGINT NOT NULL DEFAULT 0,
        has_photo     INTEGER NOT NULL DEFAULT 0,
        views         INTEGER NOT NULL DEFAULT 0,
        created_at    BIGINT NOT NULL,
        updated_at    BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_listings_pub ON pro_listings(published, persona);
      CREATE INDEX IF NOT EXISTS idx_listings_geo ON pro_listings(published, lat, lng);
      CREATE TABLE IF NOT EXISTS listing_photos (
        user_id     INTEGER PRIMARY KEY,
        mime        TEXT NOT NULL,
        data        TEXT NOT NULL,
        updated_at  BIGINT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS listing_posts (
        id          BIGSERIAL PRIMARY KEY,
        user_id     INTEGER NOT NULL,
        kind        TEXT NOT NULL DEFAULT 'update',
        title       TEXT NOT NULL DEFAULT '',
        body        TEXT NOT NULL DEFAULT '',
        created_at  BIGINT NOT NULL,
        expires_at  BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_listing_posts_user ON listing_posts(user_id, expires_at);
      CREATE TABLE IF NOT EXISTS listing_requests (
        id          BIGSERIAL PRIMARY KEY,
        user_id     INTEGER NOT NULL,
        name        TEXT NOT NULL,
        phone       TEXT NOT NULL,
        preferred   TEXT NOT NULL DEFAULT '',
        message     TEXT NOT NULL DEFAULT '',
        source      TEXT NOT NULL DEFAULT 'web',
        from_user   INTEGER,
        status      TEXT NOT NULL DEFAULT 'new',
        appointment_id BIGINT,
        ip_hash     TEXT NOT NULL DEFAULT '',
        created_at  BIGINT NOT NULL,
        updated_at  BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_listing_req_user ON listing_requests(user_id, status, created_at);
      CREATE INDEX IF NOT EXISTS idx_listing_req_ip ON listing_requests(ip_hash, created_at);
    `).catch((e) => {
      console.error("listings migration failed:", e.message);
      migrated = null;
    });
  }
  return migrated;
}

/* ---------------- pure helpers (unit-tested) ---------------- */

const clean = (s, n) => String(s ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim().slice(0, n);

/** "Dr. Asha Rao" + "Mangaluru" → "dr-asha-rao-mangaluru". ASCII only. */
function slugBase(...parts) {
  const s = parts
    .filter(Boolean)
    .join(" ")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return s || "listing";
}

/** Indian mobile/landline, kept as digits with an optional leading +. */
function cleanPhone(v) {
  const s = String(v ?? "").trim();
  const plus = s.startsWith("+");
  const d = s.replace(/\D/g, "").slice(0, 15);
  if (d.length < 8) return "";
  // A 10-digit Indian mobile gets its country code, so tel: and wa.me agree.
  if (!plus && d.length === 10 && /^[6-9]/.test(d)) return "+91" + d;
  return (plus ? "+" : "") + d;
}

/** wa.me wants the full number without + — assume India for 10 digits. */
function waNumber(v) {
  const d = String(v ?? "").replace(/\D/g, "");
  if (d.length === 10) return "91" + d;
  if (d.length === 11 && d.startsWith("0")) return "91" + d.slice(1);
  return d.length >= 11 ? d : "";
}

function validLatLng(lat, lng) {
  const a = Number(lat), b = Number(lng);
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a) <= 90 && Math.abs(b) <= 180 &&
    !(a === 0 && b === 0);
}

/** Great-circle distance in km. */
function distanceKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

function cleanServices(v) {
  const arr = Array.isArray(v) ? v : String(v ?? "").split(/[\n,]/);
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    const s = clean(x, 60);
    if (s && !seen.has(s.toLowerCase())) {
      seen.add(s.toLowerCase());
      out.push(s);
    }
    if (out.length >= 20) break;
  }
  return out;
}

/**
 * What still stops this listing from going public, as stable codes the app
 * turns into words. Empty = ready. `prof` is the clinic profile (regNo).
 */
function missingForPublish(l, prof, persona) {
  const miss = [];
  if (!l.displayName) miss.push("name");
  if (!l.address) miss.push("address");
  if (!validLatLng(l.lat, l.lng)) miss.push("location");
  if (!l.phone) miss.push("phone");
  if ((persona === "doctor" || persona === "advocate") && !String(prof?.regNo || "").trim()) {
    miss.push(persona === "doctor" ? "reg_no" : "enrolment_no");
  }
  return miss;
}

/** Words a search box might use for each profession (English + common Indian). */
const PERSONA_WORDS = {
  doctor: ["doctor", "doctors", "dr", "clinic", "hospital", "physician", "vaidya", "daktar", "medical"],
  advocate: ["advocate", "advocates", "lawyer", "lawyers", "legal", "vakil", "attorney", "notary", "chamber", "court"],
  business: ["business", "shop", "store", "office", "company", "services", "agency"],
};

/**
 * "dentist near me" → {persona: 'doctor'?, terms: ['dentist']}. A word that
 * names a profession picks it; the rest search name/headline/services.
 */
function parseQuery(q) {
  const words = String(q ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9ऀ-ൿ\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .filter((w) => !["near", "me", "nearby", "around", "in", "best", "the", "a", "an", "my", "good", "top", "find", "for"].includes(w));
  let persona = null;
  const terms = [];
  for (const w of words) {
    const hit = Object.entries(PERSONA_WORDS).find(([, list]) => list.includes(w));
    if (hit && !persona) persona = hit[0];
    else if (!hit) terms.push(w);
  }
  return { persona, terms: terms.slice(0, 5) };
}

/* ---------------- shapes ---------------- */

function parseJsonArr(t) {
  try {
    const v = JSON.parse(t || "[]");
    return Array.isArray(v) ? v : [];
  } catch (_) {
    return [];
  }
}

function listingShape(r) {
  if (!r) return null;
  return {
    userId: Number(r.user_id),
    persona: r.persona,
    slug: r.slug,
    displayName: r.display_name,
    headline: r.headline,
    placeName: r.place_name,
    address: r.address,
    area: r.area,
    city: r.city,
    pincode: r.pincode,
    lat: r.lat == null ? null : Number(r.lat),
    lng: r.lng == null ? null : Number(r.lng),
    phone: r.phone,
    whatsapp: r.whatsapp,
    about: r.about,
    services: parseJsonArr(r.services),
    languages: r.languages,
    acceptsRequests: Number(r.accepts_requests) === 1,
    published: Number(r.published) === 1,
    publishedAt: Number(r.published_at) || null,
    hasPhoto: Number(r.has_photo) === 1,
    views: Number(r.views) || 0,
    updatedAt: Number(r.updated_at),
  };
}

function postShape(r) {
  return {
    id: Number(r.id),
    kind: r.kind,
    title: r.title,
    body: r.body,
    createdAt: Number(r.created_at),
    expiresAt: Number(r.expires_at),
  };
}

function requestShape(r) {
  return {
    id: Number(r.id),
    name: r.name,
    phone: r.phone,
    preferred: r.preferred,
    message: r.message,
    source: r.source,
    status: r.status,
    appointmentId: r.appointment_id == null ? null : Number(r.appointment_id),
    createdAt: Number(r.created_at),
  };
}

/* ---------------- listing ---------------- */

async function getRow(userId) {
  await migrate();
  return one("SELECT * FROM pro_listings WHERE user_id = $1", [Number(userId)]);
}

async function uniqueSlug(base, userId) {
  let slug = base;
  for (let i = 0; i < 20; i++) {
    const hit = await one("SELECT user_id FROM pro_listings WHERE slug = $1", [slug]);
    if (!hit || Number(hit.user_id) === Number(userId)) return slug;
    slug = `${base}-${i < 8 ? i + 2 : crypto.randomBytes(2).toString("hex")}`;
  }
  return `${base}-${crypto.randomBytes(4).toString("hex")}`;
}

/**
 * The professional's listing, or a draft prefilled from what the app
 * already knows (name, clinic profile) — never saved until they save.
 */
async function getListing(userId, persona, prof) {
  const r = await getRow(userId);
  if (r) return { ...listingShape(r), persona };
  const u = await one("SELECT name, phone_number FROM users WHERE id = $1", [Number(userId)]).catch(() => null);
  return {
    userId: Number(userId),
    persona,
    slug: null,
    displayName: clean(u?.name, 120),
    headline: "",
    placeName: prof?.clinicName || "",
    address: prof?.address || "",
    area: "",
    city: "",
    pincode: "",
    lat: null,
    lng: null,
    phone: cleanPhone(prof?.phone || u?.phone_number || ""),
    whatsapp: "",
    about: "",
    services: [],
    languages: "",
    acceptsRequests: true,
    published: false,
    publishedAt: null,
    hasPhoto: false,
    views: 0,
    updatedAt: null,
    draft: true,
  };
}

async function saveListing(userId, persona, patch, prof) {
  await migrate();
  const cur = await getListing(userId, persona, prof);
  const pick = (k, n) => (patch[k] !== undefined ? clean(patch[k], n) : cur[k]);
  const next = {
    displayName: pick("displayName", 120),
    headline: pick("headline", 140),
    placeName: pick("placeName", 140),
    address: pick("address", 300),
    area: pick("area", 80),
    city: pick("city", 80),
    pincode: patch.pincode !== undefined ? clean(patch.pincode, 10).replace(/\D/g, "").slice(0, 6) : cur.pincode,
    phone: patch.phone !== undefined ? cleanPhone(patch.phone) : cur.phone,
    whatsapp: patch.whatsapp !== undefined ? cleanPhone(patch.whatsapp) : cur.whatsapp,
    about: pick("about", 1500),
    services: patch.services !== undefined ? cleanServices(patch.services) : cur.services,
    languages: pick("languages", 120),
    acceptsRequests: patch.acceptsRequests !== undefined ? patch.acceptsRequests !== false : cur.acceptsRequests,
    lat: cur.lat,
    lng: cur.lng,
  };
  if (patch.lat !== undefined || patch.lng !== undefined) {
    if (patch.lat === null && patch.lng === null) {
      next.lat = null;
      next.lng = null;
    } else if (validLatLng(patch.lat, patch.lng)) {
      next.lat = Math.round(Number(patch.lat) * 1e6) / 1e6;
      next.lng = Math.round(Number(patch.lng) * 1e6) / 1e6;
    } else {
      const e = new Error("That map location isn't valid.");
      e.status = 400;
      throw e;
    }
  }
  const now = Date.now();
  const slug = cur.slug || (await uniqueSlug(slugBase(next.displayName || next.placeName, next.area || next.city), userId));
  await run(
    `INSERT INTO pro_listings
       (user_id, persona, slug, display_name, headline, place_name, address, area, city, pincode,
        lat, lng, phone, whatsapp, about, services, languages, accepts_requests, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$19)
     ON CONFLICT (user_id) DO UPDATE SET
       persona=$2, display_name=$4, headline=$5, place_name=$6, address=$7, area=$8, city=$9,
       pincode=$10, lat=$11, lng=$12, phone=$13, whatsapp=$14, about=$15, services=$16,
       languages=$17, accepts_requests=$18, updated_at=$19`,
    [Number(userId), persona, slug, next.displayName, next.headline, next.placeName, next.address,
     next.area, next.city, next.pincode, next.lat, next.lng, next.phone, next.whatsapp, next.about,
     JSON.stringify(next.services), next.languages, next.acceptsRequests ? 1 : 0, now]
  );
  // Still public but no longer complete (e.g. the pin was cleared)? Take it down.
  const saved = listingShape(await getRow(userId));
  if (saved.published && missingForPublish(saved, prof, persona).length) {
    await run("UPDATE pro_listings SET published = 0 WHERE user_id = $1", [Number(userId)]);
    saved.published = false;
  }
  return saved;
}

/** Publishes or unpublishes. Returns {ok, missing?, listing}. */
async function setPublished(userId, persona, on, prof) {
  const r = await getRow(userId);
  if (!r) return { ok: false, missing: ["name", "address", "location", "phone"], listing: null };
  const l = listingShape(r);
  if (on) {
    const missing = missingForPublish(l, prof, persona);
    if (missing.length) return { ok: false, missing, listing: l };
  }
  await run(
    `UPDATE pro_listings SET published = $2, persona = $3,
       published_at = CASE WHEN $2 = 1 AND published = 0 THEN $4 ELSE published_at END,
       updated_at = $4 WHERE user_id = $1`,
    [Number(userId), on ? 1 : 0, persona, Date.now()]
  );
  return { ok: true, listing: listingShape(await getRow(userId)) };
}

/** The persona changed away from a profession: the page must go down. */
async function unpublishIfNotPro(userId, persona) {
  if (PERSONAS.includes(persona)) return;
  await migrate();
  await run("UPDATE pro_listings SET published = 0 WHERE user_id = $1", [Number(userId)]);
}

/* ---------------- photo ---------------- */

function sniffImage(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length > 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buf.length > 12 && buf.slice(0, 4).toString() === "RIFF" && buf.slice(8, 12).toString() === "WEBP") return "image/webp";
  return null;
}

async function setPhoto(userId, base64) {
  await migrate();
  if (!(await getRow(userId))) {
    const e = new Error("Save your listing first.");
    e.status = 409;
    throw e;
  }
  const buf = Buffer.from(String(base64 || "").replace(/^data:[^,]*,/, ""), "base64");
  const mime = sniffImage(buf);
  if (!mime) {
    const e = new Error("Use a JPEG, PNG or WebP photo.");
    e.status = 400;
    throw e;
  }
  if (buf.length > MAX_PHOTO_BYTES) {
    const e = new Error("That photo is too large (400 KB max).");
    e.status = 413;
    throw e;
  }
  const now = Date.now();
  await run(
    `INSERT INTO listing_photos (user_id, mime, data, updated_at) VALUES ($1,$2,$3,$4)
     ON CONFLICT (user_id) DO UPDATE SET mime=$2, data=$3, updated_at=$4`,
    [Number(userId), mime, buf.toString("base64"), now]
  );
  await run("UPDATE pro_listings SET has_photo = 1, updated_at = $2 WHERE user_id = $1", [Number(userId), now]);
}

async function deletePhoto(userId) {
  await migrate();
  await run("DELETE FROM listing_photos WHERE user_id = $1", [Number(userId)]);
  await run("UPDATE pro_listings SET has_photo = 0, updated_at = $2 WHERE user_id = $1", [Number(userId), Date.now()]);
}

async function getPhoto(userId) {
  await migrate();
  const r = await one("SELECT mime, data, updated_at FROM listing_photos WHERE user_id = $1", [Number(userId)]);
  return r ? { mime: r.mime, buf: Buffer.from(r.data, "base64"), updatedAt: Number(r.updated_at) } : null;
}

/* ---------------- posts ---------------- */

async function listPosts(userId, { activeOnly = true, now = Date.now(), limit = 20 } = {}) {
  await migrate();
  const rows = await query(
    `SELECT * FROM listing_posts WHERE user_id = $1 ${activeOnly ? "AND expires_at > $2" : "AND $2::bigint IS NOT NULL"}
     ORDER BY created_at DESC LIMIT ${Math.max(1, Math.min(Number(limit) || 20, 50))}`,
    [Number(userId), now]
  );
  return rows.map(postShape);
}

async function createPost(userId, p) {
  await migrate();
  const title = clean(p.title, 100);
  const body = clean(p.body, 600);
  if (!title && !body) {
    const e = new Error("Write something to post.");
    e.status = 400;
    throw e;
  }
  const live = await one("SELECT COUNT(*)::int AS n FROM listing_posts WHERE user_id = $1 AND expires_at > $2", [Number(userId), Date.now()]);
  if ((live?.n || 0) >= 10) {
    const e = new Error("You already have 10 live posts — remove one first.");
    e.status = 409;
    throw e;
  }
  const days = Math.max(1, Math.min(Math.round(Number(p.days) || POST_DAYS_DEFAULT), POST_DAYS_MAX));
  const now = Date.now();
  const row = await one(
    `INSERT INTO listing_posts (user_id, kind, title, body, created_at, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [Number(userId), p.kind === "offer" ? "offer" : "update", title, body, now, now + days * DAY]
  );
  return postShape(row);
}

async function deletePost(userId, id) {
  await migrate();
  const r = await one("DELETE FROM listing_posts WHERE user_id = $1 AND id = $2 RETURNING id", [Number(userId), Number(id)]);
  return Boolean(r);
}

/* ---------------- requests ---------------- */

const hashIp = (ip) => crypto.createHash("sha256").update(`listing:${ip || ""}`).digest("hex").slice(0, 32);

async function createRequest(ownerId, r, { ip = "", source = "web", fromUser = null } = {}) {
  await migrate();
  const name = clean(r.name, 80);
  const phone = cleanPhone(r.phone);
  if (!name || !phone) {
    const e = new Error("Please give your name and a phone number.");
    e.status = 400;
    throw e;
  }
  const ipHash = ip ? hashIp(ip) : "";
  const now = Date.now();
  // Abuse guard: 5 requests per IP per day across all listings, and one
  // open request per phone number per listing.
  if (ipHash) {
    const n = await one("SELECT COUNT(*)::int AS n FROM listing_requests WHERE ip_hash = $1 AND created_at > $2", [ipHash, now - DAY]);
    if ((n?.n || 0) >= 5) {
      const e = new Error("Too many requests today. Please call instead.");
      e.status = 429;
      throw e;
    }
  }
  const dup = await one(
    "SELECT id FROM listing_requests WHERE user_id = $1 AND phone = $2 AND status = 'new' AND created_at > $3",
    [Number(ownerId), phone, now - DAY]
  );
  if (dup) return { duplicate: true, id: Number(dup.id) };
  const row = await one(
    `INSERT INTO listing_requests (user_id, name, phone, preferred, message, source, from_user, ip_hash, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) RETURNING *`,
    [Number(ownerId), name, phone, clean(r.preferred, 120), clean(r.message, 500),
     source === "app" ? "app" : "web", fromUser ? Number(fromUser) : null, ipHash, now]
  );
  return requestShape(row);
}

async function listRequests(userId, { status = null, limit = 100 } = {}) {
  await migrate();
  const rows = await query(
    `SELECT * FROM listing_requests WHERE user_id = $1 ${status ? "AND status = $2" : "AND $2::text IS NULL"}
     ORDER BY (status = 'new') DESC, created_at DESC LIMIT ${Math.max(1, Math.min(Number(limit) || 100, 200))}`,
    [Number(userId), status]
  );
  return rows.map(requestShape);
}

async function getRequest(userId, id) {
  await migrate();
  const r = await one("SELECT * FROM listing_requests WHERE user_id = $1 AND id = $2", [Number(userId), Number(id)]);
  return r ? requestShape(r) : null;
}

async function setRequestStatus(userId, id, status, appointmentId = null) {
  await migrate();
  const r = await one(
    `UPDATE listing_requests SET status = $3, appointment_id = COALESCE($4, appointment_id), updated_at = $5
     WHERE user_id = $1 AND id = $2 RETURNING *`,
    [Number(userId), Number(id), status, appointmentId, Date.now()]
  );
  return r ? requestShape(r) : null;
}

async function countNewRequests(userId) {
  await migrate();
  const r = await one("SELECT COUNT(*)::int AS n FROM listing_requests WHERE user_id = $1 AND status = 'new'", [Number(userId)]);
  return r?.n || 0;
}

/* ---------------- public reads ---------------- */

async function getPublishedBySlug(slug) {
  await migrate();
  const r = await one("SELECT * FROM pro_listings WHERE slug = $1 AND published = 1", [String(slug || "").toLowerCase().slice(0, 80)]);
  return listingShape(r);
}

async function bumpViews(userId) {
  await run("UPDATE pro_listings SET views = views + 1 WHERE user_id = $1", [Number(userId)]).catch(() => {});
}

async function listPublishedForSitemap(limit = 5000) {
  await migrate();
  return query(
    `SELECT slug, updated_at FROM pro_listings WHERE published = 1 ORDER BY updated_at DESC LIMIT ${Math.max(1, Math.min(limit, 50000))}`
  );
}

/**
 * Published listings near a point, nearest first. A bounding box narrows
 * the scan; the exact distance is computed here. `terms` match the name,
 * headline, place, services or the clinic specialty.
 */
async function searchNear({ lat, lng, radiusKm = 15, persona = null, terms = [], limit = 30 }) {
  await migrate();
  if (!validLatLng(lat, lng)) return [];
  const r = Math.max(1, Math.min(Number(radiusKm) || 15, 100));
  const dLat = r / 111;
  const dLng = r / (111 * Math.max(0.2, Math.cos((Number(lat) * Math.PI) / 180)));
  const params = [Number(lat) - dLat, Number(lat) + dLat, Number(lng) - dLng, Number(lng) + dLng];
  let where = "l.published = 1 AND l.lat BETWEEN $1 AND $2 AND l.lng BETWEEN $3 AND $4";
  if (persona && PERSONAS.includes(persona)) {
    params.push(persona);
    where += ` AND l.persona = $${params.length}`;
  }
  for (const t of terms.slice(0, 5)) {
    params.push(`%${String(t).replace(/[%_\\]/g, "")}%`);
    const p = `$${params.length}`;
    where += ` AND (l.display_name ILIKE ${p} OR l.headline ILIKE ${p} OR l.place_name ILIKE ${p}
               OR l.services ILIKE ${p} OR l.area ILIKE ${p} OR COALESCE(u.specialty,'') ILIKE ${p})`;
  }
  const rows = await query(
    `SELECT l.*, u.specialty FROM pro_listings l LEFT JOIN users u ON u.id = l.user_id
     WHERE ${where} LIMIT 300`,
    params
  );
  return rows
    .map((row) => ({ ...listingShape(row), specialty: row.specialty || "", distanceKm: distanceKm(Number(lat), Number(lng), Number(row.lat), Number(row.lng)) }))
    .filter((x) => x.distanceKm <= r)
    .sort((a, b) => a.distanceKm - b.distanceKm)
    .slice(0, Math.max(1, Math.min(Number(limit) || 30, 50)));
}

/** Live posts for many listings at once (search results). */
async function activePostsFor(userIds, now = Date.now()) {
  await migrate();
  if (!userIds.length) return {};
  const rows = await query(
    `SELECT * FROM listing_posts WHERE user_id = ANY($1::int[]) AND expires_at > $2 ORDER BY created_at DESC`,
    [userIds.map(Number), now]
  );
  const out = {};
  for (const r of rows) (out[r.user_id] ||= []).length < 3 && out[r.user_id].push(postShape(r));
  return out;
}

/** USER_TABLES rows for privacy export / erase (routes/privacy.js). */
const USER_TABLES = [
  ["pro_listings", "user_id"],
  ["listing_photos", "user_id"],
  ["listing_posts", "user_id"],
  ["listing_requests", "user_id"],
];

module.exports = {
  migrate, USER_TABLES, PERSONAS, MAX_PHOTO_BYTES,
  slugBase, cleanPhone, waNumber, validLatLng, distanceKm, cleanServices, missingForPublish, parseQuery,
  listingShape, getListing, saveListing, setPublished, unpublishIfNotPro,
  setPhoto, deletePhoto, getPhoto,
  listPosts, createPost, deletePost,
  createRequest, listRequests, getRequest, setRequestStatus, countNewRequests,
  getPublishedBySlug, bumpViews, listPublishedForSitemap, searchNear, activePostsFor,
};

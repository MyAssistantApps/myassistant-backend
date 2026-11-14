/**
 * LISTINGS API — three routers:
 *
 *  proRouter (mounted /listing, appAuth + doctor/advocate/business)
 *    GET    /listing                   my listing (or a prefilled draft) + what's missing
 *    PUT    /listing                   save fields
 *    POST   /listing/publish           {on: true|false}
 *    PUT    /listing/photo             {image: base64}      DELETE /listing/photo
 *    GET    /listing/posts             POST /listing/posts   DELETE /listing/posts/:id
 *    GET    /listing/requests          booking requests (new first)
 *    POST   /listing/requests/:id/accept  {startsAt} → a real appointment
 *    POST   /listing/requests/:id/decline
 *
 *  searchRouter (mounted /listings, appAuth, any user)
 *    GET    /listings/near?q=&persona=&lat=&lng=&radius=   nearest first
 *    GET    /listings/:slug            one listing (in-app view)
 *    POST   /listings/:slug/request    request a booking from the app
 *
 *  publicRouter (mounted at /, no auth) — what Google indexes
 *    GET    /p/:slug                   the public page (schema.org JSON-LD)
 *    GET    /p/:slug/photo             the cover photo
 *    POST   /p/:slug/request           the page's booking form
 *    GET    /sitemap.xml   GET /robots.txt
 *
 * Professional rules (India): advocates may not advertise or solicit (BCI
 * Rule 36) — their page is factual only, with no posts and no fee; doctors
 * post updates, not offers (NMC conduct rules). Businesses may post offers.
 */
const express = require("express");
const { requirePersona } = require("../users/persona");
const store = require("./store");
const clinicStore = require("../clinic/store");
const audit = require("../audit/log");
const { one } = require("../db");

const PRO = ["doctor", "advocate", "business"];
const uidOf = (req) => Number(req.user.sub);

/** Which kinds of post each profession may publish. */
function postKindsFor(persona) {
  if (persona === "business") return ["update", "offer"];
  if (persona === "doctor") return ["update"];
  return [];
}

const MISSING_WORDS = {
  name: "Your name",
  address: "The full address",
  location: "The map pin",
  phone: "A phone number",
  reg_no: "Your medical registration number (Clinic settings)",
  enrolment_no: "Your Bar Council enrolment number (Chamber settings)",
};

function baseUrl(req) {
  const env = String(process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
  return env || `${req.protocol}://${req.get("host")}`;
}

async function notifyOwner(ownerId, title, body, data) {
  try {
    const u = await one("SELECT fcm_token FROM users WHERE id = $1", [Number(ownerId)]);
    const strData = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)]));
    const r = await require("../services/push").send(u?.fcm_token, title, body, strData);
    if (!r.ok && !r.stale) {
      await require("../services/pendingPush").queue(ownerId, title, body, strData).catch(() => {});
    }
  } catch (_) { /* a push never fails the request */ }
}

const fail = (res, e) => res.status(e.status || 400).json({ error: e.message });

/* ======================= the professional's side ======================= */

const proRouter = express.Router();
proRouter.use(requirePersona(PRO));

async function listingPayload(req) {
  const uid = uidOf(req);
  const prof = await clinicStore.getProfile(uid);
  const listing = await store.getListing(uid, req.persona, prof);
  return {
    listing,
    url: listing.slug ? `${baseUrl(req)}/p/${listing.slug}` : null,
    missing: store.missingForPublish(listing, prof, req.persona),
    postKinds: postKindsFor(req.persona),
    newRequests: await store.countNewRequests(uid),
    clinic: { regNo: prof.regNo, qualification: prof.qualification, fee: prof.fee, hours: clinicStore.describeHours(prof.hours) },
  };
}

proRouter.get("/", async (req, res) => {
  try {
    res.json(await listingPayload(req));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

proRouter.put("/", async (req, res) => {
  try {
    const prof = await clinicStore.getProfile(uidOf(req));
    await store.saveListing(uidOf(req), req.persona, req.body || {}, prof);
    audit.record(uidOf(req), "listing.updated", "public listing");
    res.json(await listingPayload(req));
  } catch (e) {
    fail(res, e);
  }
});

proRouter.post("/publish", async (req, res) => {
  try {
    const on = req.body?.on !== false;
    const prof = await clinicStore.getProfile(uidOf(req));
    const r = await store.setPublished(uidOf(req), req.persona, on, prof);
    if (!r.ok) {
      return res.status(409).json({
        error: "incomplete",
        missing: r.missing,
        message: `Before going public, add: ${r.missing.map((m) => MISSING_WORDS[m] || m).join(", ")}.`,
      });
    }
    audit.record(uidOf(req), on ? "listing.published" : "listing.unpublished", "public listing");
    res.json(await listingPayload(req));
  } catch (e) {
    fail(res, e);
  }
});

proRouter.put("/photo", express.json({ limit: "1mb" }), async (req, res) => {
  try {
    await store.setPhoto(uidOf(req), req.body?.image);
    res.json(await listingPayload(req));
  } catch (e) {
    fail(res, e);
  }
});

proRouter.delete("/photo", async (req, res) => {
  try {
    await store.deletePhoto(uidOf(req));
    res.json(await listingPayload(req));
  } catch (e) {
    fail(res, e);
  }
});

proRouter.get("/posts", async (req, res) => {
  try {
    res.json({ posts: await store.listPosts(uidOf(req)), postKinds: postKindsFor(req.persona) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

proRouter.post("/posts", async (req, res) => {
  try {
    const kinds = postKindsFor(req.persona);
    if (!kinds.length) {
      return res.status(403).json({ error: "Bar Council rules don't allow advocates to advertise, so posts are off for chambers." });
    }
    const kind = kinds.includes(req.body?.kind) ? req.body.kind : "update";
    const post = await store.createPost(uidOf(req), { ...(req.body || {}), kind });
    audit.record(uidOf(req), "listing.post.created", post.title || "post");
    res.json({ post });
  } catch (e) {
    fail(res, e);
  }
});

proRouter.delete("/posts/:id", async (req, res) => {
  try {
    const ok = await store.deletePost(uidOf(req), req.params.id);
    if (!ok) return res.status(404).json({ error: "not found" });
    res.json({ ok: true });
  } catch (e) {
    fail(res, e);
  }
});

proRouter.get("/requests", async (req, res) => {
  try {
    res.json({ requests: await store.listRequests(uidOf(req)) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

proRouter.post("/requests/:id/accept", async (req, res) => {
  try {
    const uid = uidOf(req);
    const r = await store.getRequest(uid, req.params.id);
    if (!r) return res.status(404).json({ error: "not found" });
    if (r.status !== "new") return res.status(409).json({ error: `Already ${r.status}.` });
    const startsAt = Number(req.body?.startsAt);
    if (!Number.isFinite(startsAt) || startsAt < Date.now() - 3600_000) {
      return res.status(400).json({ error: "Pick a time for the appointment." });
    }
    const appt = await clinicStore.createAppointment(uid, {
      patientName: r.name,
      patientPhone: r.phone,
      startsAt,
      reason: [r.preferred && `Asked for: ${r.preferred}`, r.message].filter(Boolean).join(" — ").slice(0, 200),
      source: "web",
      remindPatient: req.body?.remindPatient !== false,
    });
    const updated = await store.setRequestStatus(uid, r.id, "accepted", Number(appt.id));
    audit.record(uid, "listing.request.accepted", `request #${r.id} → appointment #${appt.id}`);
    res.json({ request: updated, appointment: clinicStore.apptShape(appt) });
  } catch (e) {
    fail(res, e);
  }
});

proRouter.post("/requests/:id/decline", async (req, res) => {
  try {
    const r = await store.getRequest(uidOf(req), req.params.id);
    if (!r) return res.status(404).json({ error: "not found" });
    if (r.status !== "new") return res.status(409).json({ error: `Already ${r.status}.` });
    const updated = await store.setRequestStatus(uidOf(req), r.id, "declined");
    audit.record(uidOf(req), "listing.request.declined", `request #${r.id}`);
    res.json({ request: updated });
  } catch (e) {
    fail(res, e);
  }
});

/* ======================= anyone in the app ======================= */

const searchRouter = express.Router();

function geoOf(req) {
  let lat = parseFloat(req.query.lat);
  let lng = parseFloat(req.query.lng);
  if (!store.validLatLng(lat, lng)) {
    lat = parseFloat(req.get("X-Geo-Lat"));
    lng = parseFloat(req.get("X-Geo-Lng"));
  }
  return store.validLatLng(lat, lng) ? { lat, lng } : null;
}

/** Public-safe card for search results (no counters, no internals). */
function card(req, l, posts = []) {
  return {
    slug: l.slug,
    persona: l.persona,
    displayName: l.displayName,
    headline: l.headline || l.specialty || "",
    placeName: l.placeName,
    address: l.address,
    area: l.area,
    city: l.city,
    lat: l.lat,
    lng: l.lng,
    phone: l.phone,
    whatsapp: l.whatsapp,
    acceptsRequests: l.acceptsRequests,
    photoUrl: l.hasPhoto ? `${baseUrl(req)}/p/${l.slug}/photo?v=${l.updatedAt}` : null,
    url: `${baseUrl(req)}/p/${l.slug}`,
    distanceKm: l.distanceKm == null ? null : Math.round(l.distanceKm * 10) / 10,
    posts,
  };
}

/** Shared by the route and the voice tool. */
async function searchNearby({ lat, lng, q = "", persona = null, radiusKm = 15, limit = 30 }) {
  const parsed = store.parseQuery(q);
  const p = PRO.includes(persona) ? persona : parsed.persona;
  let results = await store.searchNear({ lat, lng, radiusKm, persona: p, terms: parsed.terms, limit });
  // "dentist" might be written in the headline OR not at all — fall back to
  // the profession alone rather than showing nothing.
  let relaxed = false;
  if (!results.length && parsed.terms.length && p) {
    results = await store.searchNear({ lat, lng, radiusKm, persona: p, terms: [], limit });
    relaxed = results.length > 0;
  }
  return { results, persona: p, terms: parsed.terms, relaxed };
}

searchRouter.get("/near", async (req, res) => {
  try {
    const g = geoOf(req);
    if (!g) return res.status(400).json({ error: "location_required", message: "Turn on location to see who's nearby." });
    const r = await searchNearby({
      ...g,
      q: String(req.query.q || "").slice(0, 100),
      persona: String(req.query.persona || ""),
      radiusKm: Number(req.query.radius) || 15,
    });
    const posts = await store.activePostsFor(r.results.map((x) => x.userId));
    res.json({
      results: r.results.map((l) => card(req, l, posts[l.userId] || [])),
      persona: r.persona,
      relaxed: r.relaxed,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

searchRouter.get("/:slug", async (req, res) => {
  try {
    const l = await store.getPublishedBySlug(req.params.slug);
    if (!l) return res.status(404).json({ error: "not found" });
    const prof = await clinicStore.getProfile(l.userId);
    const g = geoOf(req);
    const posts = postKindsFor(l.persona).length ? await store.listPosts(l.userId, { limit: 10 }) : [];
    res.json({
      listing: {
        ...card(req, { ...l, distanceKm: g ? store.distanceKm(g.lat, g.lng, l.lat, l.lng) : null }, posts),
        about: l.about,
        services: l.services,
        languages: l.languages,
        pincode: l.pincode,
        hours: clinicStore.describeHours(prof.hours),
        regNo: l.persona === "business" ? "" : prof.regNo,
        qualification: prof.qualification,
        fee: l.persona === "advocate" ? 0 : prof.fee,
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

searchRouter.post("/:slug/request", async (req, res) => {
  try {
    const l = await store.getPublishedBySlug(req.params.slug);
    if (!l || !l.acceptsRequests) return res.status(404).json({ error: "This listing isn't taking requests." });
    if (l.userId === uidOf(req)) return res.status(400).json({ error: "That's your own listing." });
    const r = await store.createRequest(l.userId, req.body || {}, { ip: req.ip, source: "app", fromUser: uidOf(req) });
    if (!r.duplicate) {
      notifyOwner(l.userId, "New booking request", `${r.name} asked for ${r.preferred || "an appointment"}`, { kind: "listing_request", id: r.id });
    }
    res.json({ ok: true, duplicate: Boolean(r.duplicate) });
  } catch (e) {
    fail(res, e);
  }
});

/* ======================= the public web ======================= */

const publicRouter = express.Router();

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
/** JSON inside <script>: escape what could close the tag. */
const ldJson = (o) => JSON.stringify(o).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");

const SCHEMA_TYPE = { doctor: "Physician", advocate: "Attorney", business: "LocalBusiness" };
const KIND_WORD = { doctor: "Doctor", advocate: "Advocate", business: "Business" };
const DAY_NAMES = { mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday", sun: "Sunday" };

function openingHours(hours) {
  const out = [];
  for (const [d, ranges] of Object.entries(hours || {})) {
    for (const [opens, closes] of ranges || []) {
      out.push({ "@type": "OpeningHoursSpecification", dayOfWeek: DAY_NAMES[d], opens, closes });
    }
  }
  return out;
}

/** schema.org data Google reads for local results. Pure (unit-tested). */
function jsonLd(l, prof, { url, photoUrl }) {
  const d = {
    "@context": "https://schema.org",
    "@type": SCHEMA_TYPE[l.persona] || "LocalBusiness",
    name: l.placeName && l.persona === "business" ? l.placeName : l.displayName,
    url,
    telephone: l.phone || undefined,
    description: (l.headline || l.about || "").slice(0, 300) || undefined,
    image: photoUrl || undefined,
    address: {
      "@type": "PostalAddress",
      streetAddress: l.address,
      addressLocality: l.city || l.area || undefined,
      postalCode: l.pincode || undefined,
      addressCountry: "IN",
    },
    geo: l.lat != null ? { "@type": "GeoCoordinates", latitude: l.lat, longitude: l.lng } : undefined,
    openingHoursSpecification: openingHours(prof?.hours),
  };
  if (l.persona === "doctor" && l.headline) d.medicalSpecialty = l.headline;
  if (l.persona !== "business" && l.placeName) d.workLocation = { "@type": "Place", name: l.placeName };
  if (!d.openingHoursSpecification.length) delete d.openingHoursSpecification;
  return JSON.parse(JSON.stringify(d)); // drops undefined
}

function pageCss() {
  return `
  :root{--ink:#0f1222;--lo:#5b6175;--line:#e6e8ef;--brand:#4f46e5;--brand2:#7c3aed;--ok:#0f9d58;--bg:#f6f7fb;--card:#fff}
  @media (prefers-color-scheme:dark){:root{--ink:#eef0f7;--lo:#a3a9bb;--line:#272b3a;--bg:#0d0f17;--card:#151826}}
  *{box-sizing:border-box;margin:0}
  body{font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--ink);line-height:1.55}
  a{color:inherit}
  .wrap{max-width:760px;margin:0 auto;padding:0 16px 64px}
  .hero{background:linear-gradient(135deg,var(--brand),var(--brand2));color:#fff;padding:28px 0 72px}
  .hero .wrap{display:flex;gap:16px;align-items:center;padding-bottom:0}
  .ph{width:84px;height:84px;border-radius:22px;object-fit:cover;background:rgba(255,255,255,.18);flex:none;display:grid;place-items:center;font-size:34px;font-weight:800}
  .kind{font-size:12px;letter-spacing:.08em;text-transform:uppercase;opacity:.85;font-weight:700}
  h1{font-size:26px;line-height:1.2;font-weight:800;letter-spacing:-.01em}
  .sub{opacity:.92;font-size:15px;margin-top:2px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:18px;margin-top:14px}
  .lift{margin-top:-52px}
  .acts{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px}
  .btn{display:flex;align-items:center;justify-content:center;gap:8px;padding:13px 12px;border-radius:14px;font-weight:700;font-size:15px;text-decoration:none;border:1px solid var(--line);background:var(--card)}
  .btn.p{background:var(--brand);color:#fff;border-color:var(--brand)}
  .btn.wa{background:#25d366;color:#06331a;border-color:#25d366}
  h2{font-size:16px;font-weight:800;margin-bottom:8px}
  .row{display:flex;gap:10px;padding:8px 0;border-top:1px solid var(--line);font-size:15px}
  .row:first-of-type{border-top:0}
  .row b{min-width:110px;color:var(--lo);font-weight:600}
  .chips{display:flex;flex-wrap:wrap;gap:8px}
  .chip{padding:6px 12px;border-radius:999px;background:var(--bg);border:1px solid var(--line);font-size:13.5px}
  .post{padding:12px 0;border-top:1px solid var(--line)} .post:first-of-type{border-top:0}
  .tag{display:inline-block;font-size:11px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;padding:2px 8px;border-radius:6px;background:#fff3cd;color:#7a5600;margin-right:6px}
  .map{width:100%;height:240px;border:0;border-radius:14px;margin-top:10px;background:var(--bg)}
  form{display:grid;gap:10px}
  label{font-size:13px;font-weight:600;color:var(--lo)}
  input,textarea{width:100%;padding:12px;border-radius:12px;border:1px solid var(--line);background:var(--bg);color:var(--ink);font:inherit;font-size:16px}
  .hp{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}
  .note{font-size:12.5px;color:var(--lo);margin-top:10px}
  footer{text-align:center;color:var(--lo);font-size:13px;margin-top:28px}
  footer a{color:var(--brand);font-weight:700;text-decoration:none}
  `;
}

function securityHeaders(res) {
  res.setHeader("Content-Security-Policy",
    "default-src 'self'; img-src 'self' data:; style-src 'unsafe-inline'; " +
    "frame-src https://maps.google.com https://www.google.com; form-action 'self'; base-uri 'none'; script-src 'none'");
}

function renderPage(l, prof, posts, { url, photoUrl, base }) {
  const title = l.persona === "business" && l.placeName
    ? `${l.placeName}${l.area || l.city ? ` — ${l.area || l.city}` : ""}`
    : `${l.displayName}${l.headline ? `, ${l.headline}` : ""}${l.area || l.city ? ` in ${l.area || l.city}` : ""}`;
  const desc = (l.headline ? `${l.headline}. ` : "") + (l.placeName ? `${l.placeName}, ` : "") + l.address;
  const where = [l.address, l.area, l.city, l.pincode].filter(Boolean).join(", ");
  const dir = `https://www.google.com/maps/dir/?api=1&destination=${l.lat},${l.lng}`;
  const wa = store.waNumber(l.whatsapp);
  const hours = clinicStore.describeHours(prof.hours);
  const initial = esc((l.displayName || l.placeName || "?").replace(/^dr\.?\s*/i, "").charAt(0).toUpperCase());
  const facts = [
    l.placeName && l.persona !== "business" ? ["Practice at", l.placeName] : null,
    prof.qualification ? ["Qualification", prof.qualification] : null,
    l.persona === "doctor" && prof.regNo ? ["Reg. no.", prof.regNo] : null,
    l.persona === "advocate" && prof.regNo ? ["Enrolment no.", prof.regNo] : null,
    hours ? ["Timings", hours] : null,
    l.persona === "doctor" && prof.fee > 0 ? ["Consultation", `₹${Math.round(prof.fee)}`] : null,
    l.languages ? ["Languages", l.languages] : null,
    ["Address", where],
  ].filter(Boolean);
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc.slice(0, 160))}">
<link rel="canonical" href="${esc(url)}">
<meta property="og:type" content="profile"><meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc.slice(0, 200))}"><meta property="og:url" content="${esc(url)}">
${photoUrl ? `<meta property="og:image" content="${esc(photoUrl)}">` : ""}
<script type="application/ld+json">${ldJson(jsonLd(l, prof, { url, photoUrl }))}</script>
<style>${pageCss()}</style>
</head><body>
<div class="hero"><div class="wrap">
  ${photoUrl ? `<img class="ph" src="${esc(photoUrl)}" alt="${esc(l.displayName)}">` : `<div class="ph" aria-hidden="true">${initial}</div>`}
  <div><div class="kind">${esc(KIND_WORD[l.persona] || "")}</div>
  <h1>${esc(l.persona === "business" && l.placeName ? l.placeName : l.displayName)}</h1>
  <div class="sub">${esc(l.persona === "business" ? [l.displayName, l.headline].filter(Boolean).join(" · ") : l.headline)}</div></div>
</div></div>
<main class="wrap">
  <div class="card lift"><div class="acts">
    ${l.phone ? `<a class="btn p" href="tel:${esc(l.phone)}">📞 Call</a>` : ""}
    ${wa ? `<a class="btn wa" href="https://wa.me/${esc(wa)}" rel="nofollow">💬 WhatsApp</a>` : ""}
    <a class="btn" href="${esc(dir)}" rel="nofollow">🧭 Directions</a>
    ${l.acceptsRequests ? `<a class="btn" href="#book">🗓️ Request booking</a>` : ""}
  </div></div>
  ${l.about ? `<section class="card"><h2>About</h2><p>${esc(l.about).replace(/\n/g, "<br>")}</p></section>` : ""}
  <section class="card"><h2>Details</h2>
    ${facts.map(([k, v]) => `<div class="row"><b>${esc(k)}</b><span>${esc(v)}</span></div>`).join("")}
  </section>
  ${l.services.length ? `<section class="card"><h2>${l.persona === "advocate" ? "Areas of practice" : "Services"}</h2><div class="chips">${l.services.map((s) => `<span class="chip">${esc(s)}</span>`).join("")}</div></section>` : ""}
  ${posts.length ? `<section class="card"><h2>Updates</h2>${posts.map((p) => `<div class="post">${p.kind === "offer" ? '<span class="tag">Offer</span>' : ""}<strong>${esc(p.title)}</strong>${p.body ? `<p>${esc(p.body).replace(/\n/g, "<br>")}</p>` : ""}</div>`).join("")}</section>` : ""}
  <section class="card"><h2>Location</h2><p>${esc(where)}</p>
    <iframe class="map" loading="lazy" referrerpolicy="no-referrer" title="Map"
      src="https://maps.google.com/maps?q=${l.lat},${l.lng}&z=16&output=embed"></iframe>
  </section>
  ${l.acceptsRequests ? `<section class="card" id="book"><h2>Request a booking</h2>
    <form method="post" action="${esc(base)}/p/${esc(l.slug)}/request">
      <div><label for="n">Your name</label><input id="n" name="name" required maxlength="80" autocomplete="name"></div>
      <div><label for="ph">Phone</label><input id="ph" name="phone" required inputmode="tel" maxlength="20" autocomplete="tel"></div>
      <div><label for="pr">Preferred day / time</label><input id="pr" name="preferred" maxlength="120" placeholder="e.g. Tomorrow evening"></div>
      <div><label for="m">Message (optional)</label><textarea id="m" name="message" rows="3" maxlength="500"></textarea></div>
      <div class="hp" aria-hidden="true"><label>Website<input name="website" tabindex="-1" autocomplete="off"></label></div>
      <button class="btn p" type="submit">Send request</button>
    </form>
    <p class="note">${esc(l.displayName)} will confirm a time with you by phone. Your number is shared only with them.</p>
  </section>` : ""}
  ${l.persona === "advocate" ? `<p class="note">This page is published by the advocate for information only, as permitted by the Bar Council of India rules. It is not an advertisement or solicitation.</p>` : ""}
  <footer>Listed on <b>MyAssistant</b></footer>
</main>
</body></html>`;
}

function simplePage(title, msg, back) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)}</title><style>${pageCss()}</style></head><body>
<main class="wrap" style="padding-top:48px"><section class="card"><h2>${esc(title)}</h2><p>${esc(msg)}</p>
${back ? `<p style="margin-top:14px"><a class="btn" href="${esc(back)}">Back</a></p>` : ""}</section></main></body></html>`;
}

publicRouter.get("/p/:slug", async (req, res) => {
  try {
    const l = await store.getPublishedBySlug(req.params.slug);
    securityHeaders(res);
    if (!l) {
      return res.status(404).send(simplePage("Not found", "This page isn't available. It may have been taken down."));
    }
    const prof = await clinicStore.getProfile(l.userId);
    const posts = postKindsFor(l.persona).length ? await store.listPosts(l.userId, { limit: 10 }) : [];
    const base = baseUrl(req);
    const url = `${base}/p/${l.slug}`;
    const photoUrl = l.hasPhoto ? `${url}/photo?v=${l.updatedAt}` : null;
    store.bumpViews(l.userId);
    res.setHeader("Cache-Control", "public, max-age=300");
    res.send(renderPage(l, prof, posts, { url, photoUrl, base }));
  } catch (e) {
    res.status(500).send(simplePage("Something went wrong", "Please try again in a moment."));
  }
});

publicRouter.get("/p/:slug/photo", async (req, res) => {
  try {
    const l = await store.getPublishedBySlug(req.params.slug);
    const p = l && l.hasPhoto ? await store.getPhoto(l.userId) : null;
    if (!p) return res.status(404).end();
    res.setHeader("Content-Type", p.mime);
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.send(p.buf);
  } catch (_) {
    res.status(500).end();
  }
});

publicRouter.post("/p/:slug/request", express.urlencoded({ extended: false, limit: "10kb" }), async (req, res) => {
  securityHeaders(res);
  const back = `${baseUrl(req)}/p/${encodeURIComponent(req.params.slug)}`;
  try {
    const l = await store.getPublishedBySlug(req.params.slug);
    if (!l || !l.acceptsRequests) return res.status(404).send(simplePage("Not available", "This page isn't taking requests.", back));
    // Honeypot: real people never see or fill this field. Pretend success.
    if (String(req.body?.website || "").trim()) {
      return res.send(simplePage("Request sent", "Thank you.", back));
    }
    const r = await store.createRequest(l.userId, req.body || {}, { ip: req.ip, source: "web" });
    if (!r.duplicate) {
      notifyOwner(l.userId, "New booking request", `${r.name} asked for ${r.preferred || "an appointment"} (from your web page)`, { kind: "listing_request", id: r.id });
    }
    res.send(simplePage("Request sent",
      `Thank you${r.name ? `, ${r.name}` : ""}. ${l.displayName} will call you to confirm a time.`, back));
  } catch (e) {
    res.status(e.status || 400).send(simplePage("Couldn't send", e.message || "Please try again.", back));
  }
});

publicRouter.get("/sitemap.xml", async (req, res) => {
  try {
    const rows = await store.listPublishedForSitemap();
    const base = baseUrl(req);
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${rows.map((r) => `  <url><loc>${esc(`${base}/p/${r.slug}`)}</loc><lastmod>${new Date(Number(r.updated_at)).toISOString().slice(0, 10)}</lastmod></url>`).join("\n")}
</urlset>`;
    res.setHeader("Content-Type", "application/xml; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.send(xml);
  } catch (e) {
    res.status(500).end();
  }
});

publicRouter.get("/robots.txt", (req, res) => {
  res.type("text/plain").send(
    `User-agent: *\nAllow: /p/\nAllow: /legal/\nDisallow: /\n\nSitemap: ${baseUrl(req)}/sitemap.xml\n`
  );
});

module.exports = { proRouter, searchRouter, publicRouter, searchNearby, card, postKindsFor, jsonLd, renderPage, baseUrl };

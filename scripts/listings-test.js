/**
 * LISTINGS TESTS — `npm run test:listings`.
 *
 * Part 1 (always): the pure decisions — slugs, phone/WhatsApp numbers,
 * distance, "doctors near me" parsing, what blocks publishing, and the
 * schema.org data Google reads.
 *
 * Part 2 (only when DATABASE_URL is set, against a THROWAWAY database):
 * the whole flow over HTTP — a doctor can't go public without a
 * registration number; publish; a nearby user finds them, a far one
 * doesn't; the public page and sitemap; the booking form lands in the
 * doctor's requests; accepting makes a real appointment; advocates can't
 * post; a changed profession takes the page down; privacy erase.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://test:test@localhost:5432/test";

const assert = require("assert");
const store = require("../src/listings/store");
const routes = require("../src/listings/routes");

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`  FAIL ${name}\n       ${e.stack || e.message}`);
    process.exitCode = 1;
  }
}

(async () => {
  console.log("\nlistings — pure");

  await test("slugs are readable ASCII", () => {
    assert.strictEqual(store.slugBase("Dr. Asha Rao", "Kadri, Mangaluru"), "dr-asha-rao-kadri-mangaluru");
    assert.strictEqual(store.slugBase("Café Délice"), "cafe-delice");
    assert.strictEqual(store.slugBase("", ""), "listing");
    assert.strictEqual(store.slugBase("डॉ. राव"), "listing");
    assert.ok(store.slugBase("x".repeat(200)).length <= 60);
  });

  await test("phones keep digits; WhatsApp assumes India for 10 digits", () => {
    assert.strictEqual(store.cleanPhone("+91 98450-12345"), "+919845012345");
    assert.strictEqual(store.cleanPhone("12345"), "");
    assert.strictEqual(store.cleanPhone("98450 12345"), "+919845012345");
    assert.strictEqual(store.cleanPhone("0824 2423456"), "08242423456");
    assert.strictEqual(store.waNumber("98450 12345"), "919845012345");
    assert.strictEqual(store.waNumber("09845012345"), "919845012345");
    assert.strictEqual(store.waNumber("+919845012345"), "919845012345");
    assert.strictEqual(store.waNumber("123"), "");
  });

  await test("distance: Mangaluru → Udupi is ~50 km", () => {
    const d = store.distanceKm(12.9141, 74.856, 13.3409, 74.7421);
    assert.ok(d > 45 && d < 52, String(d));
  });

  await test("map pins: rejects 0,0 and out-of-range", () => {
    assert.ok(store.validLatLng(12.9, 74.8));
    assert.ok(!store.validLatLng(0, 0));
    assert.ok(!store.validLatLng(91, 10));
    assert.ok(!store.validLatLng("x", 10));
  });

  await test('"doctors near me" picks the profession; other words search', () => {
    assert.deepStrictEqual(store.parseQuery("doctors near me"), { persona: "doctor", terms: [] });
    assert.deepStrictEqual(store.parseQuery("best dentist nearby"), { persona: null, terms: ["dentist"] });
    assert.deepStrictEqual(store.parseQuery("lawyer for property"), { persona: "advocate", terms: ["property"] });
    assert.deepStrictEqual(store.parseQuery("ENT doctor"), { persona: "doctor", terms: ["ent"] });
  });

  await test("doctors need a reg. no., advocates an enrolment no., businesses neither", () => {
    const l = { displayName: "A", address: "B", lat: 12.9, lng: 74.8, phone: "9845012345" };
    assert.deepStrictEqual(store.missingForPublish(l, { regNo: "" }, "doctor"), ["reg_no"]);
    assert.deepStrictEqual(store.missingForPublish(l, { regNo: "" }, "advocate"), ["enrolment_no"]);
    assert.deepStrictEqual(store.missingForPublish(l, { regNo: "" }, "business"), []);
    assert.deepStrictEqual(store.missingForPublish(l, { regNo: "KMC 1234" }, "doctor"), []);
    assert.deepStrictEqual(
      store.missingForPublish({ displayName: "", address: "", lat: null, lng: null, phone: "" }, {}, "business"),
      ["name", "address", "location", "phone"]
    );
  });

  await test("services: trimmed, de-duplicated, capped", () => {
    assert.deepStrictEqual(store.cleanServices("Root canal, root canal,\nBraces, "), ["Root canal", "Braces"]);
    assert.strictEqual(store.cleanServices(Array.from({ length: 40 }, (_, i) => `s${i}`)).length, 20);
  });

  await test("post kinds: advocates none, doctors updates, businesses offers too", () => {
    assert.deepStrictEqual(routes.postKindsFor("advocate"), []);
    assert.deepStrictEqual(routes.postKindsFor("doctor"), ["update"]);
    assert.deepStrictEqual(routes.postKindsFor("business"), ["update", "offer"]);
  });

  await test("JSON-LD: Physician with address, geo and opening hours", () => {
    const l = {
      persona: "doctor", displayName: "Dr. Asha Rao", headline: "Dentist", placeName: "Smile Clinic",
      address: "2nd floor, KS Rao Road", city: "Mangaluru", pincode: "575001", lat: 12.87, lng: 74.84, phone: "+919845012345",
    };
    const d = routes.jsonLd(l, { hours: { mon: [["10:00", "13:00"]], sun: [] } }, { url: "https://x/p/a", photoUrl: null });
    assert.strictEqual(d["@type"], "Physician");
    assert.strictEqual(d.address.addressLocality, "Mangaluru");
    assert.strictEqual(d.geo.latitude, 12.87);
    assert.strictEqual(d.openingHoursSpecification[0].dayOfWeek, "Monday");
    assert.strictEqual(d.medicalSpecialty, "Dentist");
    assert.ok(!("image" in d));
  });

  await test("public page escapes what the professional typed", () => {
    const l = {
      persona: "business", slug: "s", displayName: "<script>x</script>", headline: "", placeName: "A&B",
      address: "\"q\"", area: "", city: "", pincode: "", lat: 1, lng: 2, phone: "123456789", whatsapp: "",
      about: "<img onerror=1>", services: ["<b>"], languages: "", acceptsRequests: true,
    };
    const html = routes.renderPage(l, { hours: {}, regNo: "", fee: 0, qualification: "" }, [], { url: "u", photoUrl: null, base: "b" });
    assert.ok(!html.includes("<script>x"), "name not escaped");
    assert.ok(!html.includes("<img onerror"), "about not escaped");
    assert.ok(html.includes("A&amp;B"));
  });

  if (!hasDb) {
    console.log(`\n${passed} passed (set DATABASE_URL to a throwaway DB for the HTTP flow)`);
    return;
  }

  /* ---------------- Part 2: HTTP against a throwaway DB ---------------- */
  console.log("\nlistings — HTTP flow (throwaway DB)");
  const express = require("express");
  const db = require("../src/db");
  const clinicStore = require("../src/clinic/store");
  await db.init?.();
  await store.migrate();
  await clinicStore.migrate();

  const mk = async (name, persona) => {
    const email = `l${Date.now()}${Math.random().toString(36).slice(2, 7)}@test.local`;
    const r = await db.one(
      `INSERT INTO users (email, name, persona, created_at) VALUES ($1,$2,$3,$4) RETURNING id`,
      [email, name, persona, Date.now()]
    ).catch(async () => db.one(`INSERT INTO users (email, name, persona) VALUES ($1,$2,$3) RETURNING id`, [email, name, persona]));
    return Number(r.id);
  };
  const doc = await mk("Dr. Test Rao", "doctor");
  const adv = await mk("Adv. Test Shetty", "advocate");
  const shopper = await mk("Visitor", "personal");

  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json());
  const fakeAuth = (req, res, next) => {
    const id = Number(req.get("X-Test-User"));
    if (!id) return res.status(401).end();
    req.user = { sub: id };
    next();
  };
  app.use(routes.publicRouter);
  app.use("/listing", fakeAuth, routes.proRouter);
  app.use("/listings", fakeAuth, routes.searchRouter);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, user, body, headers = {}) => {
    const r = await fetch(base + path, {
      method,
      headers: { ...(user ? { "X-Test-User": String(user) } : {}), ...(body ? { "Content-Type": "application/json" } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) { /* html */ }
    return { status: r.status, json, text };
  };
  const HERE = { lat: 12.8714, lng: 74.8432 }; // Mangaluru

  try {
    await test("a non-professional can't open /listing", async () => {
      assert.strictEqual((await call("GET", "/listing", shopper)).status, 403);
    });

    await test("first open is a prefilled draft, nothing saved", async () => {
      const r = await call("GET", "/listing", doc);
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.json.listing.draft, true);
      assert.strictEqual(r.json.listing.displayName, "Dr. Test Rao");
      assert.ok(r.json.missing.includes("reg_no"));
    });

    let slug;
    await test("save → slug + public URL", async () => {
      const r = await call("PUT", "/listing", doc, {
        displayName: "Dr. Test Rao", headline: "Dentist", placeName: "Smile Dental", address: "KS Rao Road",
        area: "Hampankatta", city: "Mangaluru", phone: "98450 12345", whatsapp: "9845012345",
        lat: HERE.lat + 0.01, lng: HERE.lng, services: "Root canal, Braces", about: "20 years.",
      });
      assert.strictEqual(r.status, 200, r.text);
      slug = r.json.listing.slug;
      assert.ok(/^dr-test-rao-hampankatta/.test(slug), slug);
      assert.ok(r.json.url.endsWith(`/p/${slug}`));
      assert.deepStrictEqual(r.json.missing, ["reg_no"]);
    });

    await test("a bad map pin is refused", async () => {
      assert.strictEqual((await call("PUT", "/listing", doc, { lat: 999, lng: 1 })).status, 400);
    });

    await test("publishing without a reg. no. is refused and says why", async () => {
      const r = await call("POST", "/listing/publish", doc, { on: true });
      assert.strictEqual(r.status, 409);
      assert.deepStrictEqual(r.json.missing, ["reg_no"]);
      assert.ok(/registration number/.test(r.json.message));
      assert.strictEqual((await call("GET", `/p/${slug}`)).status, 404);
    });

    await test("with a reg. no. it goes public", async () => {
      await clinicStore.saveProfile(doc, { regNo: "KMC 98765", fee: 400, qualification: "BDS, MDS" });
      const r = await call("POST", "/listing/publish", doc, { on: true });
      assert.strictEqual(r.status, 200, r.text);
      assert.strictEqual(r.json.listing.published, true);
    });

    await test("the public page has JSON-LD, call/WhatsApp/directions and the form", async () => {
      const r = await call("GET", `/p/${slug}`);
      assert.strictEqual(r.status, 200);
      assert.ok(r.text.includes('"@type":"Physician"'));
      assert.ok(r.text.includes("tel:+919845012345"));
      assert.ok(r.text.includes("wa.me/919845012345"));
      assert.ok(r.text.includes("google.com/maps/dir"));
      assert.ok(r.text.includes("KMC 98765"));
      assert.ok(r.text.includes(`/p/${slug}/request`));
    });

    await test("sitemap lists it; robots points at the sitemap", async () => {
      assert.ok((await call("GET", "/sitemap.xml")).text.includes(`/p/${slug}</loc>`));
      assert.ok((await call("GET", "/robots.txt")).text.includes("Sitemap:"));
    });

    await test('"doctors near me" finds them nearby, not from 60 km away', async () => {
      const near = await call("GET", `/listings/near?q=doctors%20near%20me&lat=${HERE.lat}&lng=${HERE.lng}`, shopper);
      assert.strictEqual(near.status, 200, near.text);
      const hit = near.json.results.find((x) => x.slug === slug);
      assert.ok(hit, "not found nearby");
      assert.ok(hit.distanceKm > 0.5 && hit.distanceKm < 2, String(hit.distanceKm));
      const far = await call("GET", `/listings/near?q=doctors&lat=13.3409&lng=74.7421`, shopper);
      assert.ok(!far.json.results.some((x) => x.slug === slug));
    });

    await test("the location header works too; no location → a clear error", async () => {
      const r = await call("GET", "/listings/near?q=dentist", shopper, null, { "X-Geo-Lat": String(HERE.lat), "X-Geo-Lng": String(HERE.lng) });
      assert.ok(r.json.results.some((x) => x.slug === slug));
      assert.strictEqual((await call("GET", "/listings/near?q=dentist", shopper)).status, 400);
    });

    await test("doctors may post updates but offers become updates", async () => {
      const r = await call("POST", "/listing/posts", doc, { kind: "offer", title: "Free dental camp Sunday" });
      assert.strictEqual(r.status, 200, r.text);
      assert.strictEqual(r.json.post.kind, "update");
      assert.ok((await call("GET", `/p/${slug}`)).text.includes("Free dental camp Sunday"));
    });

    let reqId;
    await test("the web booking form lands in the doctor's requests", async () => {
      const r = await fetch(`${base}/p/${slug}/request`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "name=Asha&phone=9900112233&preferred=Tomorrow+evening",
      });
      assert.strictEqual(r.status, 200);
      const list = await call("GET", "/listing/requests", doc);
      const it = list.json.requests.find((x) => x.name === "Asha");
      assert.ok(it, "request missing");
      assert.strictEqual(it.source, "web");
      reqId = it.id;
    });

    await test("the honeypot silently drops bots", async () => {
      await fetch(`${base}/p/${slug}/request`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "name=Bot&phone=9000000000&website=spam.example",
      });
      const list = await call("GET", "/listing/requests", doc);
      assert.ok(!list.json.requests.some((x) => x.name === "Bot"));
    });

    await test("accepting a request books a real appointment", async () => {
      const at = Date.now() + 2 * 86400_000;
      const r = await call("POST", `/listing/requests/${reqId}/accept`, doc, { startsAt: at });
      assert.strictEqual(r.status, 200, r.text);
      assert.strictEqual(r.json.request.status, "accepted");
      const appt = await clinicStore.getAppointment(doc, r.json.appointment.id);
      assert.strictEqual(appt.patient_name || appt.patientName, "Asha");
      assert.strictEqual((await call("POST", `/listing/requests/${reqId}/accept`, doc, { startsAt: at })).status, 409);
    });

    await test("an in-app user can request a booking", async () => {
      const r = await call("POST", `/listings/${slug}/request`, shopper, { name: "Visitor", phone: "9811122233", preferred: "Sat morning" });
      assert.strictEqual(r.status, 200, r.text);
      assert.strictEqual((await call("POST", `/listings/${slug}/request`, doc, { name: "Me", phone: "9811122234" })).status, 400);
    });

    await test("advocates: enrolment no. required, no posts, no fee on the page", async () => {
      await call("PUT", "/listing", adv, { displayName: "Adv. Test Shetty", headline: "Civil & property", placeName: "Shetty Chambers", address: "Court Road", city: "Mangaluru", phone: "9845000011", lat: HERE.lat, lng: HERE.lng + 0.01 });
      assert.deepStrictEqual((await call("POST", "/listing/publish", adv, { on: true })).json.missing, ["enrolment_no"]);
      await clinicStore.saveProfile(adv, { regNo: "KAR/1234/2010", fee: 2000 });
      const p = await call("POST", "/listing/publish", adv, { on: true });
      assert.strictEqual(p.status, 200, p.text);
      assert.strictEqual((await call("POST", "/listing/posts", adv, { title: "Hi" })).status, 403);
      const page = await call("GET", `/p/${p.json.listing.slug}`);
      assert.ok(page.text.includes('"@type":"Attorney"'));
      assert.ok(page.text.includes("Enrolment no."));
      assert.ok(!page.text.includes("₹2000"));
      assert.ok(page.text.includes("Bar Council"));
      const near = await call("GET", `/listings/near?q=lawyer&lat=${HERE.lat}&lng=${HERE.lng}`, shopper);
      assert.ok(near.json.results.some((x) => x.persona === "advocate"));
      assert.ok(!near.json.results.some((x) => x.persona === "doctor"));
    });

    await test("changing profession takes the page down", async () => {
      await db.run("UPDATE users SET persona = 'personal' WHERE id = $1", [adv]);
      await store.unpublishIfNotPro(adv, "personal");
      const near = await call("GET", `/listings/near?q=lawyer&lat=${HERE.lat}&lng=${HERE.lng}`, shopper);
      assert.ok(!near.json.results.some((x) => x.persona === "advocate"));
    });

    await test("unpublish hides the page and the search result", async () => {
      await call("POST", "/listing/publish", doc, { on: false });
      assert.strictEqual((await call("GET", `/p/${slug}`)).status, 404);
      const near = await call("GET", `/listings/near?q=doctors&lat=${HERE.lat}&lng=${HERE.lng}`, shopper);
      assert.ok(!near.json.results.some((x) => x.slug === slug));
    });

    await test("photo: only real images, size-capped", async () => {
      const png = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex").toString("base64");
      assert.strictEqual((await call("PUT", "/listing/photo", doc, { image: png })).status, 200);
      assert.strictEqual((await call("PUT", "/listing/photo", doc, { image: Buffer.from("hello").toString("base64") })).status, 400);
    });
  } finally {
    server.close();
    for (const [t, c] of store.USER_TABLES) {
      await db.run(`DELETE FROM ${t} WHERE ${c} = ANY($1::int[])`, [[doc, adv, shopper]]).catch(() => {});
    }
    await db.run("DELETE FROM clinic_appointments WHERE user_id = ANY($1::int[])", [[doc, adv]]).catch(() => {});
    await db.run("DELETE FROM clinic_profiles WHERE user_id = ANY($1::int[])", [[doc, adv]]).catch(() => {});
    await db.run("DELETE FROM users WHERE id = ANY($1::int[])", [[doc, adv, shopper]]).catch(() => {});
  }
  console.log(`\n${passed} passed`);
  process.exit(process.exitCode || 0);
})();

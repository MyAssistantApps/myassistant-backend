/**
 * CASHBACK TESTS — `npm run test:cashback`.
 *
 * Part 1 (always): the decisions — rupees to paise, a network's status
 * words, which partners earn cashback, the sub-id on the tracked link, the
 * report URL's secret.
 *
 * Part 2 (only with DATABASE_URL, against a THROWAWAY database): the money,
 * end to end — a click, the purchase the network reports, the same report
 * again, validation, cancellation, the balance, a withdrawal (once, even
 * when asked twice at the same moment), the owner paying or refusing it,
 * and what the phone and the network see over HTTP.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://test:test@localhost:5432/test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "cashback-test-secret-cashback-test-secret-01";

const assert = require("assert");
const express = require("express");

const ENV = ["CASHBACK", "CASHBACK_SHARE_PCT", "CASHBACK_MIN_PAYOUT_INR", "CASHBACK_REVIEW_ABOVE_INR",
  "CASHBACK_HOOK_SECRET", "CASHBACK_HOOK_FIELDS", "CASHBACK_SANDBOX", "CUELINKS_CID", "CUELINKS_SUBID_PARAM",
  "AMAZON_ASSOCIATE_TAG"];
function env(set) {
  for (const k of ENV) delete process.env[k];
  Object.assign(process.env, set);
}

const merchants = require("../src/affiliate/merchants");
const service = require("../src/cashback/service");
const store = require("../src/cashback/store");
const routes = require("../src/cashback/routes");

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
  console.log("\ncashback — the decisions");

  await test("rupees become paise, whatever the network's spelling", () => {
    assert.strictEqual(service.toPaise("1,299.50"), 129950);
    assert.strictEqual(service.toPaise("₹ 45"), 4500);
    assert.strictEqual(service.toPaise(12.345), 1235);
    assert.strictEqual(service.toPaise(""), null);
    assert.strictEqual(service.toPaise("n/a"), null);
    assert.strictEqual(service.rupees(129950), "₹1,299.50");
    assert.strictEqual(service.rupees(10000000), "₹1,00,000");
  });

  await test("a network's word for the state of a purchase", () => {
    for (const w of ["pending", "new", "tracked", ""]) assert.strictEqual(service.statusOf(w), "pending", w);
    for (const w of ["validated", "Approved", "confirmed", "payable", "paid"]) assert.strictEqual(service.statusOf(w), "confirmed", w);
    for (const w of ["rejected", "Cancelled", "declined", "invalid", "returned", "refunded"]) assert.strictEqual(service.statusOf(w), "rejected", w);
    // "invalid" must not read as "valid".
    assert.strictEqual(service.statusOf("invalid"), "rejected");
  });

  await test("a report is read under the network's own field names", () => {
    env({});
    const r = service.readReport("Cuelinks", { subid: "abc", transaction_id: "T1", sale_amount: "999", commission: "49.95", status: "validated", store: "Myntra" });
    assert.deepStrictEqual(
      [r.network, r.clickId, r.networkTxnId, r.salePaise, r.commissionPaise, r.status, r.merchantName],
      ["cuelinks", "abc", "T1", 99900, 4995, "confirmed", "Myntra"]);
    env({ CASHBACK_HOOK_FIELDS: JSON.stringify({ click: "p1", txn: ["oid"], commission: "pub_earning" }) });
    const c = service.readReport("x1", { p1: "zz", oid: "O-7", pub_earning: "10", amount: "200" });
    assert.deepStrictEqual([c.clickId, c.networkTxnId, c.commissionPaise, c.salePaise], ["zz", "O-7", 1000, 20000]);
    env({});
  });

  await test("the click id rides on a network link as its sub-id; Amazon's tag carries none", () => {
    env({ CUELINKS_CID: "777" });
    const myntra = merchants.BY_ID.get("myntra");
    const t = merchants.trackedUrl(myntra, null, { clickId: "c0ffee" });
    const u = new URL(t.url);
    assert.strictEqual(u.hostname, "linksredirect.com");
    assert.strictEqual(u.searchParams.get("subid"), "c0ffee");
    assert.strictEqual(u.searchParams.get("url"), "https://www.myntra.com/");
    assert.strictEqual(t.network, "cuelinks");
    env({ CUELINKS_CID: "777", CUELINKS_SUBID_PARAM: "subid2" });
    assert.strictEqual(new URL(merchants.trackedUrl(myntra, null, { clickId: "c0ffee" }).url).searchParams.get("subid2"), "c0ffee");
    env({ AMAZON_ASSOCIATE_TAG: "ours-21" });
    const a = merchants.trackedUrl(merchants.BY_ID.get("amazon"), null, { clickId: "c0ffee" });
    assert.ok(!a.url.includes("c0ffee"));
    assert.strictEqual(a.network, "amazon");
    env({});
    assert.strictEqual(merchants.trackedUrl(myntra).tracked, false, "no account, no earning");
  });

  await test("who earns cashback: on, tracked, not Amazon, not switched off by the owner", () => {
    const myntra = merchants.BY_ID.get("myntra"), amazon = merchants.BY_ID.get("amazon"), swiggy = merchants.BY_ID.get("swiggy");
    env({ CUELINKS_CID: "777", AMAZON_ASSOCIATE_TAG: "ours-21" });
    assert.strictEqual(service.eligible(myntra, null), false, "the feature is off by default");
    env({ CASHBACK: "on", CUELINKS_CID: "777", AMAZON_ASSOCIATE_TAG: "ours-21" });
    assert.strictEqual(service.eligible(myntra, null), true);
    assert.strictEqual(service.eligible(myntra, { enabled: false }), false);
    assert.strictEqual(service.eligible(amazon, null), false, "Amazon forbids rewarding its links");
    assert.strictEqual(service.eligible(swiggy, null), false, "no commission on Swiggy's link, so nothing to give back");
    env({ CASHBACK: "on" });
    assert.strictEqual(service.eligible(myntra, null), false, "no affiliate account, no earning");
    env({ CASHBACK: "on", CASHBACK_SANDBOX: "on" });
    assert.strictEqual(service.eligible(myntra, null), true, "a development server can pretend");
    assert.strictEqual(service.eligible(swiggy, null), false);
    env({});
  });

  await test("the report URL exists only with a strong secret, and only for the right one", () => {
    env({});
    assert.strictEqual(routes._secretOk(""), false);
    env({ CASHBACK_HOOK_SECRET: "short" });
    assert.strictEqual(routes._secretOk("short"), false, "a weak secret is no secret");
    const s = "a".repeat(40);
    env({ CASHBACK_HOOK_SECRET: s });
    assert.strictEqual(routes._secretOk(s), true);
    assert.strictEqual(routes._secretOk("b".repeat(40)), false);
    assert.strictEqual(routes._secretOk(s + "a"), false);
    env({});
  });

  await test("a UPI ID is shown masked", () => {
    assert.strictEqual(service.maskUpi("ramesh.k@okaxis"), "ra••••••@okaxis");
    assert.strictEqual(service.maskUpi("ab@upi"), "ab•••@upi");
    assert.strictEqual(service.maskUpi("nonsense"), "");
  });

  if (!hasDb) {
    console.log(`\n${passed} passed (database part skipped: set DATABASE_URL to a throwaway database)`);
    return;
  }

  // ───────────────────────── with a database ─────────────────────────
  console.log("\ncashback — the money, end to end");
  const db = require("../src/db");
  await db.init();
  await store.migrate();
  const tag = String(Date.now()).slice(-7);
  const mkUser = async (name, { verified = true } = {}) => Number((await db.one(
    `INSERT INTO users (email, name, phone_number, phone_verified_at, persona, profession, created_at)
     VALUES ($1,$2,$3,$4,'professional','',$5) RETURNING id`,
    [`cb-${tag}-${name}@example.test`, name, `+9198${tag}${String(Math.floor(Math.random() * 90) + 10)}`,
      verified ? Date.now() : null, Date.now()])).id);
  const ON = { CASHBACK: "on", CASHBACK_SANDBOX: "on", CASHBACK_HOOK_SECRET: "s".repeat(40) };
  const click = async (userId, merchant = "myntra") => {
    const id = store.newClickId();
    await store.recordClick({ userId, merchant, tracked: true, network: "sandbox", clickId: id });
    return id;
  };
  const report = (clickId, txn, commissionInr, status = "pending", extra = {}) =>
    service.recordConversion({ network: "sandbox", networkTxnId: `${tag}-${txn}`, clickId,
      salePaise: 200000, commissionPaise: Math.round(commissionInr * 100), status, ...extra }, { notifyUser: false });

  env(ON);
  const asha = await mkUser("asha");
  const ravi = await mkUser("ravi");

  await test("a reported purchase becomes pending cashback for the person who clicked: all of our commission", async () => {
    const c = await click(asha);
    const out = await report(c, "A1", 80);
    assert.strictEqual(out.created, true);
    assert.strictEqual(out.txn.userId, asha);
    assert.strictEqual(out.txn.merchant, "myntra");
    assert.strictEqual(out.txn.status, "pending");
    assert.strictEqual(out.txn.cashbackPaise, 8000, "100% of an ₹80 commission");
    const b = await store.balance(asha);
    assert.deepStrictEqual([b.pendingPaise, b.availablePaise], [8000, 0], "pending is not yet spendable");
    assert.strictEqual((await store.balance(ravi)).pendingPaise, 0, "nobody else's");
  });

  await test("the same report again changes nothing; validation makes it available", async () => {
    const rows = await store.listTxns({ userId: asha });
    const c = rows[0].clickId;
    const again = await report(c, "A1", 80);
    assert.deepStrictEqual([again.created, again.changed], [false, false]);
    assert.strictEqual((await store.listTxns({ userId: asha })).length, 1, "one purchase, one row");
    const ok = await report(c, "A1", 80, "confirmed");
    assert.deepStrictEqual([ok.changed, ok.from, ok.txn.status], [true, "pending", "confirmed"]);
    assert.ok(ok.txn.confirmedAt > 0);
    const b = await store.balance(asha);
    assert.deepStrictEqual([b.pendingPaise, b.confirmedPaise, b.availablePaise], [0, 8000, 8000]);
    // A confirmed amount is never resized by a later report.
    const resize = await report(c, "A1", 500, "confirmed");
    assert.strictEqual(resize.txn.cashbackPaise, 8000);
  });

  await test("a pending amount can be corrected; a cancelled order takes its cashback away", async () => {
    const c = await click(asha, "ajio");
    await report(c, "A2", 60);
    const partly = await report(c, "A2", 45);
    assert.strictEqual(partly.txn.cashbackPaise, 4500, "part of the order was returned");
    assert.strictEqual((await store.balance(asha)).pendingPaise, 4500);
    const gone = await report(c, "A2", 45, "rejected");
    assert.strictEqual(gone.txn.status, "rejected");
    const b = await store.balance(asha);
    assert.deepStrictEqual([b.pendingPaise, b.availablePaise], [0, 8000]);
  });

  await test("the share is the owner's setting, and a partner's own rule beats it", async () => {
    env({ ...ON, CASHBACK_SHARE_PCT: "50" });
    const c1 = await click(ravi);
    assert.strictEqual((await report(c1, "R1", 81)).txn.cashbackPaise, 4050);
    await store.setRule("nykaa", { enabled: true, rateText: "Up to 6%", sharePct: 25 });
    const c2 = await click(ravi, "nykaa");
    assert.strictEqual((await report(c2, "R2", 80)).txn.cashbackPaise, 2000);
    // Switched off by the owner: the purchase is recorded, nothing accrues.
    await store.setRule("purplle", { enabled: false });
    const c3 = await click(ravi, "purplle");
    const off = await report(c3, "R3", 80);
    assert.strictEqual(off.txn.cashbackPaise, 0);
    assert.match(off.txn.note, /not eligible/);
    env(ON);
  });

  await test("Amazon, an unknown click and a very large amount are never paid on a report's word alone", async () => {
    env({ ...ON, AMAZON_ASSOCIATE_TAG: "ours-21" });
    const ca = await click(ravi, "amazon");
    assert.strictEqual((await report(ca, "R4", 100)).txn.cashbackPaise, 0, "Amazon earns no cashback");
    env(ON);
    const lost = await report("no-such-click", "X1", 50, "confirmed");
    assert.strictEqual(lost.txn.userId, null);
    assert.deepStrictEqual([lost.txn.review, lost.txn.status], [true, "pending"], "nobody is paid for an unmatched purchase");
    const c = await click(ravi);
    const big = await report(c, "R5", 5000, "confirmed");
    assert.deepStrictEqual([big.txn.review, big.txn.status], [true, "pending"], "above the review line a person confirms it");
    const done = await store.setTxnStatus(big.txn.id, "confirmed", { note: "checked the order" });
    assert.deepStrictEqual([done.status, done.review], ["confirmed", false]);
    await store.setTxnStatus(big.txn.id, "rejected", { note: "test over" });
  });

  await test("with cashback switched off a purchase is still recorded, and nothing accrues", async () => {
    env({ CASHBACK_SANDBOX: "on" });
    const c = await click(ravi);
    const out = await report(c, "R6", 70);
    assert.strictEqual(out.txn.commissionPaise, 7000);
    assert.strictEqual(out.txn.cashbackPaise, 0);
    assert.deepStrictEqual(await service.summary(ravi), { enabled: false });
    await assert.rejects(service.requestPayout(ravi, { upiId: "ravi@okaxis" }), /not available/);
    env(ON);
  });

  await test("a withdrawal needs the minimum, a real UPI ID and a verified phone", async () => {
    await assert.rejects(service.requestPayout(asha, { upiId: "asha@okaxis" }), /reaches ₹100/, "₹80 is below ₹100");
    const c = await click(asha);
    await report(c, "A3", 150, "confirmed");
    await assert.rejects(service.requestPayout(asha, { upiId: "not a upi id" }), /valid UPI ID/);
    const guest = await mkUser("guest", { verified: false });
    await assert.rejects(service.requestPayout(guest, { upiId: "guest@okaxis" }), /verify your phone/);
  });

  await test("the whole available balance is asked for once, even when asked twice at the same moment", async () => {
    const before = await store.balance(asha);
    assert.strictEqual(before.availablePaise, 23000);
    const tries = await Promise.allSettled([1, 2, 3, 4].map(() => service.requestPayout(asha, { upiId: "asha.k@okaxis" })));
    const won = tries.filter((t) => t.status === "fulfilled");
    assert.strictEqual(won.length, 1, "one request, however many taps");
    assert.strictEqual(won[0].value.amountPaise, 23000);
    assert.strictEqual(won[0].value.upiId, "as••••@okaxis", "the phone gets it masked");
    for (const t of tries.filter((x) => x.status === "rejected")) assert.match(t.reason.message, /already being processed/);
    const b = await store.balance(asha);
    assert.deepStrictEqual([b.heldPaise, b.availablePaise], [23000, 0], "asked-for money cannot be asked for again");
  });

  await test("the owner pays it once; a refused one goes back to the balance", async () => {
    const open = (await store.listPayouts({ userId: asha, status: "requested" }))[0];
    const paid = await service.decidePayout(open.id, { status: "paid", reference: "UTR123456" });
    assert.deepStrictEqual([paid.status, paid.reference], ["paid", "UTR123456"]);
    assert.strictEqual(await service.decidePayout(open.id, { status: "rejected" }), null, "decided once");
    let b = await store.balance(asha);
    assert.deepStrictEqual([b.paidPaise, b.heldPaise, b.availablePaise], [23000, 0, 0]);
    // More cashback, a request, and this time the owner refuses it.
    const c = await click(asha);
    await report(c, "A4", 120, "confirmed");
    const p = await service.requestPayout(asha, { upiId: "asha.k@okaxis" });
    await service.decidePayout(p.id, { status: "rejected", note: "UPI ID not found" });
    b = await store.balance(asha);
    assert.deepStrictEqual([b.heldPaise, b.availablePaise], [0, 12000]);
    // A purchase cancelled AFTER its cashback was paid blocks the next withdrawal until it is covered.
    const first = (await store.listTxns({ userId: asha })).find((t) => t.networkTxnId === `${tag}-A1`);
    await store.setTxnStatus(first.id, "rejected", { note: "returned after payout" });
    b = await store.balance(asha);
    assert.strictEqual(b.availablePaise, 4000, "₹120 new − ₹80 clawed back");
  });

  await test("what the phone sees: its own rows, never our commission or the network", async () => {
    const s = await service.summary(asha);
    assert.strictEqual(s.enabled, true);
    assert.strictEqual(s.minPayoutPaise, 10000);
    assert.strictEqual(s.canWithdraw, false);
    assert.ok(s.txns.length >= 3);
    for (const t of s.txns) {
      assert.deepStrictEqual(Object.keys(t).sort(),
        ["cashbackPaise", "confirmedAt", "id", "merchant", "occurredAt", "salePaise", "status", "store"]);
    }
    assert.ok(s.txns.some((t) => t.store === "Myntra"));
    assert.ok(s.payouts.every((p) => p.upiId.includes("•")));
    assert.ok(s.stores.some((x) => x.id === "nykaa" && x.rateText === "Up to 6%"));
    assert.ok(!s.stores.some((x) => x.id === "purplle"), "a partner the owner switched off is not offered");
    assert.ok(!s.stores.some((x) => x.id === "swiggy"), "nor one we earn nothing from");
  });

  // ───────────────────────── over HTTP ─────────────────────────
  console.log("\ncashback — over HTTP");
  const app = express();
  app.use(express.json());
  app.use("/cashback", routes.hooks);
  app.use("/cashback", (req, _res, next) => { req.user = { sub: String(req.get("x-test-user") || "") }; next(); }, routes.router);
  app.use("/go", (req, _res, next) => { req.user = { sub: String(req.get("x-test-user") || "") }; next(); }, require("../src/routes/go"));
  const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, { method = "GET", user, body } = {}) => {
    const r = await fetch(base + path, { method,
      headers: { "content-type": "application/json", ...(user ? { "x-test-user": String(user) } : {}) },
      body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json().catch(() => null) };
  };

  await test("opening a partner gives a click of its own and says whether it earns cashback", async () => {
    const list = await call("/go", { user: ravi });
    const myntra = list.json.merchants.find((m) => m.id === "myntra");
    assert.strictEqual(myntra.cashback, true);
    assert.strictEqual(list.json.merchants.find((m) => m.id === "nykaa").cashbackText, "Up to 6%");
    assert.ok(!list.json.merchants.find((m) => m.id === "swiggy").cashback);
    const go = await call("/go/myntra", { user: ravi });
    assert.deepStrictEqual([go.json.tracked, go.json.cashback], [true, true]);
    assert.ok(!("clickId" in go.json), "the id stays on the link and the server");
    const sw = await call("/go/swiggy", { user: ravi });
    assert.strictEqual(sw.json.cashback, false);
    await new Promise((r) => setTimeout(r, 150)); // the click is written without holding the reply
    const last = await db.one("SELECT * FROM affiliate_clicks WHERE user_id = $1 AND merchant = 'myntra' ORDER BY id DESC LIMIT 1", [ravi]);
    assert.match(last.click_id, /^[0-9a-f]{20}$/);
    assert.strictEqual(last.network, "sandbox");
  });

  await test("the network's report: a wrong secret is a 404; the right one is recorded, by GET or POST", async () => {
    const last = await db.one("SELECT click_id FROM affiliate_clicks WHERE user_id = $1 AND merchant = 'myntra' ORDER BY id DESC LIMIT 1", [ravi]);
    const q = `subid=${last.click_id}&transaction_id=${tag}-H1&sale_amount=1500&commission=90&status=pending`;
    assert.strictEqual((await call(`/cashback/sandbox/hook/${"x".repeat(40)}?${q}`)).status, 404);
    const made = await call(`/cashback/sandbox/hook/${"s".repeat(40)}?${q}`);
    assert.deepStrictEqual([made.status, made.json.status], [200, "pending"]);
    const txn = await store.txnById(made.json.id);
    assert.deepStrictEqual([txn.userId, txn.merchant, txn.cashbackPaise], [ravi, "myntra", 9000]);
    const ok = await call(`/cashback/sandbox/hook/${"s".repeat(40)}`, { method: "POST",
      body: { subid: last.click_id, transaction_id: `${tag}-H1`, commission: "90", status: "validated" } });
    assert.deepStrictEqual([ok.status, ok.json.status, ok.json.id], [200, "confirmed", made.json.id]);
    assert.strictEqual((await call(`/cashback/sandbox/hook/${"s".repeat(40)}?commission=5`)).status, 400, "no transaction id");
    env({ CASHBACK: "on", CASHBACK_SANDBOX: "on" });
    assert.strictEqual((await call(`/cashback/sandbox/hook/${"s".repeat(40)}?${q}`)).status, 404, "no secret set, no URL");
    env(ON);
  });

  await test("the phone: its summary, and a withdrawal refused with a reason it can show", async () => {
    assert.strictEqual((await call("/cashback")).status, 401);
    const s = await call("/cashback", { user: ravi });
    assert.strictEqual(s.json.enabled, true);
    assert.ok(s.json.balance.confirmedPaise >= 9000);
    const bad = await call("/cashback/payouts", { method: "POST", user: ravi, body: { upiId: "nope" } });
    assert.deepStrictEqual([bad.status, bad.json.code], [409, "upi"]);
    assert.match(bad.json.error, /valid UPI ID/, "the words the app shows");
    const none = await mkUser("empty");
    const low = await call("/cashback/payouts", { method: "POST", user: none, body: { upiId: "empty@okaxis" } });
    assert.deepStrictEqual([low.status, low.json.code], [409, "below_min"]);
  });

  server.close();
  env({});
  console.log(`\n${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
  setTimeout(() => process.exit(process.exitCode || 0), 50).unref();
})();

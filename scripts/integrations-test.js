/**
 * THIRD-PARTY INTEGRATION TESTS — `npm run test:integrations`.
 *
 * Payment collection and flight search + fare watch. No database, no
 * network.
 *
 * The assertions concentrate on the branches where a mistake costs the user
 * something real: marking an invoice paid without a valid signature, or
 * searching the wrong day.
 */
process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgres://test:test@localhost:5432/test";

const assert = require("assert");
const payments = require("../src/payments/service");
const flights = require("../src/tools/flights");
const fares = require("../src/travel/fares");

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`  FAIL ${name}\n       ${e.message}`);
    process.exitCode = 1;
  }
}
async function atest(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`  FAIL ${name}\n       ${e.message}`);
    process.exitCode = 1;
  }
}

(async () => {
  console.log("\npayment collection");

  test("unconfigured Razorpay refuses instead of inventing a link", async () => {
    const saved = process.env.RAZORPAY_KEY_ID;
    delete process.env.RAZORPAY_KEY_ID;
    const out = await payments.createRequest({ userId: 1, amountRupees: 500 });
    if (saved) process.env.RAZORPAY_KEY_ID = saved;
    assert.strictEqual(out.ok, false);
    assert.ok(/isn't configured/i.test(out.error), out.error);
  });

  test("a webhook without a valid signature is rejected", () => {
    const crypto = require("crypto");
    const body = Buffer.from(JSON.stringify({ event: "payment_link.paid" }));

    // No secret configured -> reject everything. An unverified webhook
    // could mark any invoice paid.
    const saved = process.env.RAZORPAY_WEBHOOK_SECRET;
    delete process.env.RAZORPAY_WEBHOOK_SECRET;
    assert.strictEqual(payments.verifySignature(body, "anything"), false);

    process.env.RAZORPAY_WEBHOOK_SECRET = "s3cret";
    const good = crypto.createHmac("sha256", "s3cret").update(body).digest("hex");
    assert.strictEqual(payments.verifySignature(body, good), true, "valid signature must pass");
    assert.strictEqual(payments.verifySignature(body, "deadbeef"), false);
    assert.strictEqual(payments.verifySignature(body, good.slice(0, -2) + "00"), false);
    assert.strictEqual(payments.verifySignature(null, good), false);

    if (saved) process.env.RAZORPAY_WEBHOOK_SECRET = saved;
    else delete process.env.RAZORPAY_WEBHOOK_SECRET;
  });

  test("there is no code path that sends money out", () => {
    // Collection only, by design. If a transfer/payout helper ever appears
    // here it should be a deliberate decision, not a quiet addition.
    const api = Object.keys(payments);
    for (const forbidden of ["payout", "transfer", "refund", "sendMoney", "withdraw"]) {
      assert.ok(!api.includes(forbidden), `unexpected outbound-money API: ${forbidden}`);
    }
  });

  console.log("\nflights and fare watch");

  test("known cities resolve, unknown ones are asked about", () => {
    assert.strictEqual(flights.resolveAirport("bangalore"), "BLR");
    assert.strictEqual(flights.resolveAirport("BOM"), "BOM");
    assert.strictEqual(flights.resolveAirport("somewhere"), null);
  });

  test("the Amadeus host follows the environment", () => {
    // Test and production are separate hosts AND separate credentials —
    // pointing live keys at the sandbox returns unbookable inventory.
    const saved = process.env.AMADEUS_ENV;
    delete process.env.AMADEUS_ENV;
    assert.ok(flights.amadeusHost().includes("test.api.amadeus.com"));
    process.env.AMADEUS_ENV = "production";
    assert.strictEqual(flights.amadeusHost(), "https://api.amadeus.com");
    if (saved) process.env.AMADEUS_ENV = saved;
    else delete process.env.AMADEUS_ENV;
  });

  await atest("an unreadable date is questioned, not silently made tomorrow", async () => {
    const saved = process.env.AMADEUS_CLIENT_ID;
    const saved2 = process.env.AMADEUS_CLIENT_SECRET;
    process.env.AMADEUS_CLIENT_ID = "x";
    process.env.AMADEUS_CLIENT_SECRET = "y";
    const out = await flights.search({ from: "BLR", to: "DEL", date: "sometime-ish" });
    if (saved) process.env.AMADEUS_CLIENT_ID = saved; else delete process.env.AMADEUS_CLIENT_ID;
    if (saved2) process.env.AMADEUS_CLIENT_SECRET = saved2; else delete process.env.AMADEUS_CLIENT_SECRET;
    assert.ok(out.needsArgs, `should ask, got ${JSON.stringify(out)}`);
  });

  test("only INR fares are compared against a rupee target", () => {
    const best = fares.cheapest([
      { price: "USD 40.00", flight: "AA1" },
      { price: "INR 8452.00", flight: "6E203" },
      { price: "INR 12000.00", flight: "AI505" },
    ]);
    assert.strictEqual(best.price, 8452);
    assert.strictEqual(best.flight.flight, "6E203");
    assert.strictEqual(fares.cheapest([{ price: "USD 40.00" }]), null);
  });

  console.log("\ntool surface");

  test("every integration is reachable by voice", () => {
    const registry = require("../src/tools/registry");
    require("../src/tools/builtins").registerBuiltins();
    for (const n of [
      "collect_payment", "check_payments",
      "search_flights", "watch_flight_fare",
    ]) {
      assert.ok(registry.get(n), `missing tool: ${n}`);
    }
  });

  test("actions with real consequences require confirmation", () => {
    const registry = require("../src/tools/registry");
    // Asking someone for money reaches a third party on the user's behalf.
    // It may not happen unprompted.
    for (const n of ["collect_payment"]) {
      assert.strictEqual(registry.get(n).risk, "high", `${n} must be high risk`);
      assert.strictEqual(typeof registry.get(n).confirmSummary, "function", n);
    }
    // Watching a price does nothing irreversible.
    for (const n of ["watch_flight_fare"]) {
      assert.strictEqual(registry.get(n).risk, "low", n);
    }
  });

  test("the confirmation names the amount and the person", () => {
    const registry = require("../src/tools/registry");
    const s = registry.get("collect_payment").confirmSummary({
      from: "Ravi", amount: 15000, reason: "the consultation",
    });
    assert.ok(s.includes("15,000"), s);
    assert.ok(s.includes("Ravi"), s);
  });

  console.log(`\n${passed} passed${process.exitCode ? " — with failures above" : ""}\n`);
})();

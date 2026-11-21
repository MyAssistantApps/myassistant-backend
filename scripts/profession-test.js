/**
 * PROFESSION RESOLVE TESTS — `npm run test:profession`.
 *
 * Free-text "What do you do?" → workspace key (users/professionResolve.js),
 * and the POST /profile/profession/resolve route. No database or AI key
 * needed: the AI is injected.
 */
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://test:test@localhost:5432/test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "profession-test-secret-profession-test-0001";

const assert = require("assert");
const { resolveProfession, byRules } = require("../src/users/professionResolve");

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`  FAIL ${name}\n       ${e && (e.stack || e.message)}`);
    process.exitCode = 1;
  }
}

const noAi = async () => { throw new Error("AI must not be called"); };

(async () => {
  console.log("\nrules: common answers need no AI");
  const cases = {
    "Chartered Accountant": "professional",
    "Software Engineer": "professional",
    "school teacher": "professional",
    "cab driver": "professional",
    "business analyst": "professional",
    "store manager": "professional",
    "medical student": "student",
    "law student": "student",
    "Dentist": "doctor",
    "Physiotherapist": "doctor",
    "Dr. Rao": "doctor",
    "Advocate": "advocate",
    "corporate lawyer": "advocate",
    "bakery owner": "business",
    "runs a bakery": "business",
    "real estate agent": "business",
    "homemaker": "personal",
    "retired banker": "personal",
  };
  for (const [text, want] of Object.entries(cases)) {
    await test(`"${text}" → ${want}`, async () => {
      assert.strictEqual(byRules(text), want);
      const r = await resolveProfession(text, { ai: noAi });
      assert.strictEqual(r.persona, want);
      assert.strictEqual(r.source, "rules");
    });
  }

  console.log("\nAI path and fallbacks");
  await test("an unknown job goes to the AI and keeps its label", async () => {
    const r = await resolveProfession("astrologer", { ai: async () => ({ persona: "business", label: "astrologer" }) });
    assert.deepStrictEqual(r, { persona: "business", label: "Astrologer", source: "ai" });
  });
  await test("an AI failure falls back to professional, never blocks", async () => {
    const r = await resolveProfession("farmer", { ai: noAi });
    assert.deepStrictEqual(r, { persona: "professional", label: "Farmer", source: "fallback" });
  });
  await test("an AI answer outside the six keys is ignored", async () => {
    const r = await resolveProfession("priest", { ai: async () => ({ persona: "admin", label: "x" }) });
    assert.strictEqual(r.persona, "professional");
    assert.strictEqual(r.source, "fallback");
  });
  await test("empty text resolves to nothing", async () => {
    assert.deepStrictEqual(await resolveProfession("   ", { ai: noAi }), { persona: "", label: "", source: "empty" });
  });
  await test("long input is capped at 80 characters", async () => {
    const r = await resolveProfession("teacher ".repeat(30), { ai: noAi });
    assert.ok(r.label.length <= 80);
  });

  console.log("\nroute: POST /profile/profession/resolve");
  await test("needs sign-in, needs text, answers with the mapping", async () => {
    const express = require("express");
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { if (req.headers["x-uid"]) req.user = { sub: req.headers["x-uid"] }; next(); });
    app.use("/profile", require("../src/routes/profile"));
    const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
    const url = `http://127.0.0.1:${server.address().port}/profile/profession/resolve`;
    const post = (body, uid) => fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(uid ? { "x-uid": uid } : {}) },
      body: JSON.stringify(body),
    });
    try {
      assert.strictEqual((await post({ text: "Dentist" })).status, 401);
      assert.strictEqual((await post({ text: " " }, "7")).status, 400);
      const ok = await post({ text: "Dentist" }, "7");
      assert.strictEqual(ok.status, 200);
      assert.deepStrictEqual(await ok.json(), { persona: "doctor", label: "Dentist", source: "rules" });
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  console.log(`\n${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
})().finally(() => setTimeout(() => process.exit(process.exitCode || 0), 50).unref());

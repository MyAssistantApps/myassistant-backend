/**
 * CLINIC / PERSONA TESTS — `npm run test:clinic`.
 *
 * No database, no network. Covers the decisions that would misfire in a
 * way a doctor notices at once: who may open the clinic workspace, which
 * persona values are accepted, and which day a follow-up falls on in the
 * doctor's own timezone.
 */
process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgres://test:test@localhost:5432/test";

const assert = require("assert");
const persona = require("../src/users/persona");
const clinic = require("../src/clinic/routes")._test;

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`  FAIL ${name}\n       ${e.message}`);
    process.exitCode = 1;
  }
}

function fakeRes() {
  return {
    code: 200, body: null,
    status(c) { this.code = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

async function runGate(sub, personaValue) {
  const gate = persona.requirePersona("doctor", async () => personaValue);
  const req = { user: { sub } };
  const res = fakeRes();
  let nexted = false;
  await gate(req, res, () => { nexted = true; });
  return { req, res, nexted };
}

(async () => {
  console.log("\npersona values");

  await test("known personas are accepted, case-insensitively", () => {
    assert.strictEqual(persona.cleanPersona("Doctor"), "doctor");
    assert.strictEqual(persona.cleanPersona(" student "), "student");
  });
  await test("unknown or free-text values are rejected, never stored", () => {
    assert.strictEqual(persona.cleanPersona("surgeon"), null);
    assert.strictEqual(persona.cleanPersona(""), null);
    assert.strictEqual(persona.cleanPersona(undefined), null);
  });
  await test("case files belong to doctor/professional/business only", () => {
    assert.ok(persona.usesCaseFiles("doctor"));
    assert.ok(persona.usesCaseFiles("business"));
    assert.ok(!persona.usesCaseFiles("student"));
    assert.ok(!persona.usesCaseFiles(""));
  });

  console.log("\nclinic gate");

  await test("a doctor is let through", async () => {
    const { nexted, req } = await runGate("7", "doctor");
    assert.ok(nexted);
    assert.strictEqual(req.persona, "doctor");
  });
  await test("a non-doctor gets 403, not the workspace", async () => {
    const { nexted, res } = await runGate("7", "student");
    assert.ok(!nexted);
    assert.strictEqual(res.code, 403);
    assert.strictEqual(res.body.error, "persona_required");
  });
  await test("an account that never chose gets 403", async () => {
    const { nexted, res } = await runGate("7", "");
    assert.ok(!nexted);
    assert.strictEqual(res.code, 403);
  });
  await test("the dev anonymous user is refused", async () => {
    const { nexted, res } = await runGate("anonymous-dev", "doctor");
    assert.ok(!nexted);
    assert.strictEqual(res.code, 401);
  });
  await test("a lookup failure fails CLOSED", async () => {
    const gate = persona.requirePersona("doctor", async () => { throw new Error("db down"); });
    const res = fakeRes();
    let nexted = false;
    await gate({ user: { sub: "7" } }, res, () => { nexted = true; });
    assert.ok(!nexted);
    assert.strictEqual(res.code, 500);
  });

  console.log("\nthe doctor's day");

  const IST = 330;
  // 2026-11-12 23:30 IST = 18:00 UTC
  const lateEvening = Date.UTC(2026, 10, 12, 18, 0);
  await test("day window follows the doctor's timezone, not UTC", () => {
    const w = clinic.dayWindow(lateEvening, IST);
    assert.strictEqual(w.start, Date.UTC(2026, 10, 11, 18, 30)); // 12 Nov 00:00 IST
    assert.strictEqual(w.end - w.start, 24 * 3600 * 1000);
  });
  await test("follow-ups split into overdue / today / upcoming", () => {
    const w = clinic.dayWindow(lateEvening, IST);
    const row = (id, due) => ({ id, client_id: 1, client_name: "Ramesh", due_at: due, notify_patient: 1, called_at: 0 });
    const b = clinic.bucketFollowUps(
      [row(1, w.start - 1), row(2, w.start), row(3, w.end - 1), row(4, w.end)], w);
    assert.deepStrictEqual(b.overdue.map((f) => f.id), [1]);
    assert.deepStrictEqual(b.today.map((f) => f.id), [2, 3]);
    assert.deepStrictEqual(b.upcoming.map((f) => f.id), [4]);
    assert.strictEqual(b.today[0].clientName, "Ramesh");
    assert.strictEqual(b.today[0].notifyPatient, true);
  });
  await test("a garbage timezone header falls back to IST", () => {
    const req = (v) => ({ get: () => v });
    assert.strictEqual(clinic.tzOf(req("abc")), 330);
    assert.strictEqual(clinic.tzOf(req("9999")), 330);
    assert.strictEqual(clinic.tzOf(req("-300")), -300);
  });

  /* ---------------------------------------------------------------- */
  console.log("\nclinic timings + slot engine");
  const store = require("../src/clinic/store");

  await test("bad timetable entries are dropped, never guessed", () => {
    const h = store.cleanHours({
      mon: [["10:00", "13:00"], ["25:00", "26:00"], ["14:00", "12:00"], "junk"],
      tue: "nope",
    });
    assert.deepStrictEqual(h.mon, [["10:00", "13:00"]]);
    assert.deepStrictEqual(h.tue, []);
    assert.deepStrictEqual(h.sun, []);
  });
  await test("timings read naturally for a caller", () => {
    const s = store.describeHours(store.cleanHours(store.DEFAULT_HOURS));
    assert.strictEqual(s, "Mon–Fri 10am–1pm, 5pm–8pm; Sat 10am–1pm; Sun closed");
  });

  // Mon 16 Nov 2026, local midnight IST
  const monStart = Date.UTC(2026, 10, 15, 18, 30);
  const hours = store.cleanHours({ mon: [["10:00", "11:00"]] });
  const at = (h, m) => monStart + (h * 60 + m) * 60000;
  await test("slots fill the timings in slot-length steps", () => {
    const s = store.freeSlots({ hours, slotMin: 15, dayStart: monStart, now: monStart });
    assert.deepStrictEqual(s, [at(10, 0), at(10, 15), at(10, 30), at(10, 45)]);
  });
  await test("a booked appointment removes its slot (and overlaps)", () => {
    const s = store.freeSlots({
      hours, slotMin: 15, dayStart: monStart, now: monStart,
      booked: [{ starts_at: at(10, 10), duration_min: 15 }],
    });
    assert.deepStrictEqual(s, [at(10, 30), at(10, 45)]);
  });
  await test("slots too soon (under 30 min away) are not offered", () => {
    const s = store.freeSlots({ hours, slotMin: 15, dayStart: monStart, now: at(10, 5) });
    assert.deepStrictEqual(s, [at(10, 45)]);
  });
  await test("a closed day has no slots", () => {
    const s = store.freeSlots({ hours, slotMin: 15, dayStart: monStart + 86400000, now: monStart });
    assert.deepStrictEqual(s, []);
  });
  await test("local midnight follows the doctor's timezone", () => {
    assert.strictEqual(store.localMidnight(at(23, 30), 330), monStart);
  });
  await test("a calendar date resolves to the doctor's midnight", () => {
    assert.strictEqual(clinic.dayStartOf("2026-11-16", 330), monStart);
  });

  /* ---------------------------------------------------------------- */
  console.log("\nclinical drafting");
  const ai = require("../src/clinic/ai");

  await test("SOAP normaliser drops nameless drugs and bad follow-ups", () => {
    const n = ai.normalizeSoap({
      subjective: "cough 3 days", objective: "", assessment: "URTI", plan: "rest",
      medications: [{ name: "Paracetamol", dose: "650 mg", frequency: "TDS", duration: "3 days", instructions: "" },
        { name: "", dose: "5 mg" }],
      follow_up_days: 0, red_flags: ["breathlessness"],
    });
    assert.strictEqual(n.medications.length, 1);
    assert.strictEqual(n.followUpDays, null);
    assert.deepStrictEqual(n.redFlags, ["breathlessness"]);
  });
  await test("SOAP text marks empty sections instead of inventing them", () => {
    const t = ai.soapToText(ai.normalizeSoap({ subjective: "cough", assessment: "URTI", plan: "rest", follow_up_days: 7 }));
    assert.ok(t.includes("O: Not discussed."));
    assert.ok(t.includes("Review in 7 days."));
  });
  await test("medicine line reads like a prescription", () => {
    assert.strictEqual(
      ai.medLine({ name: "Amoxicillin", dose: "500 mg", frequency: "TDS", duration: "5 days", instructions: "after food" }),
      "Amoxicillin 500 mg TDS × 5 days (after food)");
  });
  await test("loose JSON is recovered from a chatty reply", () => {
    assert.deepStrictEqual(ai.parseJsonLoose('Sure! ```json\n{"a":1}\n```'), { a: 1 });
    assert.deepStrictEqual(ai.parseJsonLoose('note: {"a":2} done'), { a: 2 });
    assert.strictEqual(ai.parseJsonLoose("no json here"), null);
  });
  await test("structured-output schemas are strict objects", () => {
    for (const s of [ai.SOAP_SCHEMA, ai.RX_SCHEMA]) {
      assert.strictEqual(s.additionalProperties, false);
      for (const k of Object.keys(s.properties)) assert.ok(s.required.includes(k), `${k} must be required`);
    }
  });
  console.log("\nclinical drafting: gpt-4.1 first, then the default model (stubbed router, no network)");
  const router = require("../src/services/ai/router");
  const realGen = router.generateReply;
  let calls = [];
  let respond = () => ({ reply: "{}", model: "gpt-4.1" });
  router.generateReply = async (messages, opts) => {
    calls.push({ messages, opts });
    return respond(opts, calls.length);
  };
  const rxJson = JSON.stringify({ diagnosis: "URTI", medications: [{ name: "Paracetamol", dose: "650 mg", frequency: "TDS", duration: "3 days", instructions: "after food" }], advice: "", follow_up_days: 7 });

  await test("prescription parsing asks gpt-4.1 for schema-pinned JSON", async () => {
    calls = [];
    respond = () => ({ reply: rxJson, model: "gpt-4.1-2025-04-14", provider: "openai" });
    const r = await ai.parsePrescription("paracetamol 650 tds 3 days after food, review in a week");
    assert.strictEqual(calls.length, 1);
    const o = calls[0].opts;
    assert.strictEqual(o.model, "gpt-4.1");
    assert.strictEqual(o.json, true);
    assert.strictEqual(o.schema, ai.RX_SCHEMA);
    assert.ok(o.system.includes("transcriptionist"));
    assert.ok(calls[0].messages[0].content.includes("DICTATION"));
    assert.strictEqual(r.provider, "gpt-4.1-2025-04-14");
    assert.strictEqual(r.medications[0].dose, "650 mg");
    assert.strictEqual(r.followUpDays, 7);
  });
  await test("gpt-4.1 failing → retried once on the app's default model", async () => {
    calls = [];
    respond = (opts) => {
      if (opts.model === "gpt-4.1") throw new Error("model_not_found");
      return { reply: rxJson, model: "gpt-5.4-nano" };
    };
    const r = await ai.parsePrescription("paracetamol 650 tds");
    assert.strictEqual(calls.length, 2);
    assert.strictEqual(calls[1].opts.model, undefined, "second try uses the router's default");
    assert.strictEqual(r.provider, "gpt-5.4-nano");
  });
  await test("a reply that isn't JSON is retried, never guessed", async () => {
    calls = [];
    respond = (opts) => (opts.model === "gpt-4.1"
      ? { reply: "Sorry, I can't help with that.", model: "gpt-4.1" }
      : { reply: "Here you go:\n```json\n" + rxJson + "\n```", model: "gpt-5.4-nano" });
    const r = await ai.parsePrescription("paracetamol");
    assert.strictEqual(calls.length, 2);
    assert.strictEqual(r.medications[0].name, "Paracetamol");
  });
  await test("both failing → an honest error, no half-parsed draft", async () => {
    respond = () => ({ reply: "nope", model: "x" });
    await assert.rejects(ai.parsePrescription("paracetamol"), /could not draft/);
  });
  await test("consult drafting uses gpt-4.1 with the SOAP schema and the patient context", async () => {
    calls = [];
    respond = () => ({ reply: JSON.stringify({ chief_complaint: "fever", subjective: "fever 2 days", objective: "temp 100.8",
      assessment: "viral pharyngitis", plan: "paracetamol, gargles", medications: [], follow_up_days: 7, red_flags: [] }), model: "gpt-4.1" });
    const r = await ai.draftConsultNote({ transcript: "Patient has had fever for two days, throat red.", patientName: "Meena", context: "diabetic" });
    assert.strictEqual(calls[0].opts.model, "gpt-4.1");
    assert.strictEqual(calls[0].opts.schema, ai.SOAP_SCHEMA);
    assert.ok(calls[0].messages[0].content.includes("Patient: Meena"));
    assert.ok(calls[0].messages[0].content.includes("diabetic"));
    assert.ok(calls[0].opts.system.includes("Record ONLY what was said"));
    assert.strictEqual(r.note.assessment, "viral pharyngitis");
    assert.strictEqual(r.note.followUpDays, 7);
  });
  await test("the model is gpt-4.1, matching the phone-call agent", () => {
    assert.strictEqual(ai.OPENAI_MODEL, "gpt-4.1");
  });
  await test("schemas are strict objects (all keys required, no extras)", () => {
    const check = (s, path) => {
      if (s.type === "object") {
        assert.strictEqual(s.additionalProperties, false, `${path}: additionalProperties`);
        assert.deepStrictEqual([...s.required].sort(), Object.keys(s.properties).sort(), `${path}: required`);
        for (const [k, v] of Object.entries(s.properties)) check(v, `${path}.${k}`);
      }
      if (s.type === "array") check(s.items, `${path}[]`);
    };
    check(ai.SOAP_SCHEMA, "soap");
    check(ai.RX_SCHEMA, "rx");
  });
  await test("SOAP drafting refuses a near-empty consult", async () => {
    await assert.rejects(ai.draftConsultNote({ transcript: "hi" }), /too short/);
  });
  router.generateReply = realGen;

  console.log("\nprescription PDF");
  const { renderPrescription } = require("../src/clinic/rx");
  await test("renders a real PDF with the doctor's letterhead", async () => {
    const buf = await renderPrescription({
      doctor: { name: "Anita Rao", qualification: "MBBS, MD", specialty: "General Physician", regNo: "KMC 12345" },
      clinic: { clinicName: "Rao Clinic", address: "MG Road, Mangaluru", phone: "0824 222222" },
      patient: { name: "Ramesh K", age: "42", sex: "M" },
      diagnosis: "Acute pharyngitis",
      medications: [{ name: "Paracetamol", dose: "650 mg", frequency: "TDS", duration: "3 days", instructions: "after food" }],
      advice: "Warm saline gargles.", followUpDays: 5, date: monStart, tzOffsetMin: 330,
    });
    assert.ok(Buffer.isBuffer(buf));
    assert.strictEqual(buf.subarray(0, 5).toString(), "%PDF-");
    assert.ok(buf.length > 1500);
  });

  /* ---------------------------------------------------------------- */
  console.log("\nadvocates & business: money, PDFs, drafting");
  const proStore = require("../src/pro/store");

  await test("invoice totals: lines, GST, total — in paise, no float drift", () => {
    const t = proStore.computeTotals([
      { description: "Strategy consulting", qty: 3, rate: 25000 },
      { description: "Travel", qty: 1, rate: 1999.99 },
      { description: "", qty: 2, rate: 10 },        // dropped: no description
      { description: "Zero qty", qty: 0, rate: 500 }, // dropped: no quantity
    ], 18);
    assert.strictEqual(t.lines.length, 2);
    assert.strictEqual(t.subtotalPaise, 7699999);
    assert.strictEqual(t.gstPaise, Math.round(7699999 * 0.18));
    assert.strictEqual(t.totalPaise, t.subtotalPaise + t.gstPaise);
  });
  await test("an unusual GST rate is refused (0 used), not guessed", () => {
    assert.strictEqual(proStore.computeTotals([{ description: "x", qty: 1, rate: 100 }], 17).gstRate, 0);
    assert.strictEqual(proStore.computeTotals([{ description: "x", qty: 1, rate: 100 }], 28).gstRate, 28);
  });
  await test("privacy: every new table is exported and erased", () => {
    const names = proStore.USER_TABLES.map(([t]) => t).sort();
    assert.deepStrictEqual(names, ["pro_cases", "pro_hearings", "pro_invoices", "pro_leads"]);
  });

  const { renderInvoice, renderDocument, money } = require("../src/pro/pdf");
  await test("money reads in Indian grouping", () => {
    assert.strictEqual(money(125000), "Rs. 1,25,000");
    assert.strictEqual(money(1999.5), "Rs. 1,999.50");
  });
  await test("invoice PDF renders with GST and a pay-online link", async () => {
    const buf = await renderInvoice({
      kind: "invoice", number: "INV-0001", date: Date.now(), seller: { name: "Rao Ventures", regLine: "GSTIN 29ABCDE1234F1Z5" },
      buyer: { name: "Acme Ltd" }, items: [{ description: "Consulting", qty: 2, rate: 50000, amount: 100000 }],
      subtotal: 100000, gstRate: 18, gst: 18000, total: 118000, paymentUrl: "https://rzp.io/l/test",
    });
    assert.strictEqual(buf.subarray(0, 5).toString(), "%PDF-");
  });
  await test("legal document PDF renders on the advocate's letterhead", async () => {
    const buf = await renderDocument({
      title: "Legal Notice", body: "Under instructions from my client...\n\nYou are hereby called upon to pay...",
      advocate: { name: "Adv. Anita Rao", regLine: "Enrolment No. KAR/1234/2010" },
    });
    assert.strictEqual(buf.subarray(0, 5).toString(), "%PDF-");
  });

  const drafting = require("../src/pro/drafting");
  await test("drafting cites ONLY grounded provisions; invented sections are dropped", async () => {
    const realGen2 = router.generateReply;
    let sys = "";
    router.generateReply = async (_m, opts) => {
      sys = opts.system;
      return { model: "gpt-4.1", reply: JSON.stringify({
        title: "Legal Notice for Recovery of Rent",
        body: "Under instructions from my client, I hereby call upon you to pay the arrears of rent of Rs. 60,000 within 15 days, failing which my client shall initiate proceedings.",
        provisions_cited: ["BNS 318", "Made-up Act 999"],
        advocate_checks: ["Tenant's full address", "Date of the rent agreement"] }) };
    };
    const d = await drafting.draftLegal({ kind: "notice", facts: "Tenant has not paid 4 months rent of Rs 60,000; cheating under IPC 420; vacate in 15 days" });
    router.generateReply = realGen2;
    assert.ok(sys.includes("BNS"), "the repealed IPC 420 was mapped to BNS in the grounding");
    assert.ok(!sys.includes("IPC 420 —"), "the old section is not offered as citable");
    assert.ok(d.provisionsCited.every((p) => !/made-up/i.test(p)), "an invented act is dropped");
    assert.strictEqual(d.advocateChecks.length, 2);
    assert.strictEqual(d.provider, "gpt-4.1");
  });
  await test("drafting refuses empty facts", async () => {
    await assert.rejects(drafting.draftLegal({ kind: "notice", facts: "help" }), /describe the facts/);
  });

  console.log(`\n${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
})();

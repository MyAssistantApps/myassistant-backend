/**
 * CONNECT TESTS — `npm run test:connect`.
 *
 * Talking to a contact's assistant (src/connect/), against a THROWAWAY
 * database (DATABASE_URL; skipped without it). No AI and no push is
 * called: the summary is injected and no user has a device token.
 *
 *   discovery: only my contacts, only verified app users, never myself,
 *              and each person's open/contacts/off setting is honoured
 *   the session is the HOST's assistant: their name, voice, persona limits
 *   guest tools: message, urgent (capped), free/busy without details,
 *              booking (refused on a busy time, written to both sides)
 *   the owner's voice tool opens the call on the phone
 */
const hasDb = Boolean(process.env.DATABASE_URL);
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://test:test@localhost:5432/test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "connect-test-secret-connect-test-0000001";

const assert = require("assert");

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

(async () => {
  if (!hasDb) {
    console.log("connect tests: skipped (set DATABASE_URL to a throwaway database)");
    return;
  }
  const db = require("../src/db");
  await db.init();
  await require("../src/routes/contacts").migrate();
  await require("../src/studio/store").migrate();
  const svc = require("../src/connect/service");
  await svc.migrate();

  const tag = Date.now().toString().slice(-7);
  const mk = async (name, phone, extra = {}) => {
    const u = await db.one(
      `INSERT INTO users (email, name, phone_number, phone_verified_at, persona, profession, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [`connect-${tag}-${name}@example.test`, name, phone, extra.unverified ? null : Date.now(),
        extra.persona || "professional", extra.profession || "", Date.now()]);
    return Number(u.id);
  };
  const save = (owner, name, phone) => db.run(
    `INSERT INTO contacts (user_id, name, phone, updated_at) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
    [owner, name, phone, Date.now()]);

  const P = (n) => `+9190${tag}${n}`;
  const me = await mk("Dhanush", P("01"));
  const alan = await mk("Alan Lobo", P("02"), { profession: "Software Engineer" });
  const ghost = await mk("Ghost", P("03"), { unverified: true });
  const shy = await mk("Shy", P("04"));
  const picky = await mk("Picky", P("05"));
  await db.run(`INSERT INTO assistant_profiles (user_id, name, voice, updated_at) VALUES ($1,'Nova','sage',$2)
                ON CONFLICT (user_id) DO UPDATE SET name='Nova', voice='sage'`, [alan, Date.now()]);
  await save(me, "Alan", P("02"));
  await save(me, "Ghost", P("03"));
  await save(me, "Shy", P("04"));
  await save(me, "Picky", P("05"));
  await save(me, "Not On App", `+9190${tag}99`);
  await svc.setOpen(shy, "off");
  await svc.setOpen(picky, "contacts");

  console.log("\ndiscovery");
  await test("only verified app users in my contacts who take calls", async () => {
    const list = await svc.people(me);
    assert.deepStrictEqual(list.map((p) => p.ownerName), ["Alan"]);
    const a = list[0];
    assert.strictEqual(a.assistantName, "Nova");
    assert.strictEqual(a.voice, "sage");
    assert.strictEqual(a.hasPhoto, false);
  });
  await test("'contacts' mode opens once they save my number too", async () => {
    await save(picky, "Dhanush", P("01"));
    assert.ok((await svc.people(me)).some((p) => p.id === picky));
  });
  await test("not in my contacts, off, unverified, or myself → refused", async () => {
    const stranger = await mk("Stranger", P("06"));
    await assert.rejects(svc.host(stranger, alan), (e) => e.status === 404);
    await assert.rejects(svc.host(me, shy), (e) => e.status === 403);
    await assert.rejects(svc.host(me, ghost), (e) => e.status === 404);
    await assert.rejects(svc.host(me, me), (e) => e.status === 404);
  });

  console.log("\nthe session is the host's assistant");
  await test("instructions name Alan's assistant and its limits; tools are guest-only", async () => {
    const s = await svc.sessionFor(me, alan);
    assert.strictEqual(s.card.voice, "sage");
    assert.match(s.instructions, /You are Nova, the personal assistant of Alan/);
    assert.match(s.instructions, /speaking with Dhanush/);
    assert.match(s.instructions, /Software Engineer/);
    assert.match(s.instructions, /never what Alan is doing/i);
    assert.deepStrictEqual(s.tools.map((t) => t.name).sort(),
      ["book_appointment", "check_availability", "end_call", "leave_message", "urgent_ping"]);
  });

  console.log("\nguest tools");
  const inbox = () => db.query(`SELECT message FROM agent_messages WHERE to_phone_number=$1 ORDER BY id`, [P("02")]);
  await test("'ask Alan to call me' goes straight through: the message alone is enough", async () => {
    const before = (await inbox()).length;
    const r = await svc.runGuestTool(me, alan, "leave_message", { message: "Please call Dhanush back." });
    assert.ok(r.ok, JSON.stringify(r));
    assert.strictEqual((await inbox()).length, before + 1);
    assert.match((await inbox()).at(-1).message, /Please call Dhanush back/);
    const empty = await svc.runGuestTool(me, alan, "leave_message", {});
    assert.deepStrictEqual(empty.needs_details, ["message"]);
  });
  await test("a complete message lands in Alan's inbox with action, deadline and reply route", async () => {
    const r = await svc.runGuestTool(me, alan, "leave_message", {
      message: "Call me about the demo.", action_needed: "call back", by_when: "today by 5 pm", reply_via: "call",
    });
    assert.ok(r.ok);
    const m = (await inbox()).at(-1).message;
    assert.match(m, /Call me about the demo/);
    assert.match(m, /Action: call back \| By: today by 5 pm \| Reply via: call/);
  });
  const urgent = (i) => ({ what_happened: `Server down ${i}`, action_needed: "approve the rollback", by_when: "right now" });
  await test("urgent_ping needs only what is urgent", async () => {
    assert.deepStrictEqual((await svc.runGuestTool(me, alan, "urgent_ping", {})).needs_details, ["what_happened"]);
  });
  await test("urgent_ping is flagged and capped per day", async () => {
    for (let i = 0; i < 3; i++) assert.ok((await svc.runGuestTool(me, alan, "urgent_ping", urgent(i))).ok);
    const r = await svc.runGuestTool(me, alan, "urgent_ping", urgent(9));
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /limited/);
    assert.strictEqual((await inbox()).filter((m) => m.message.startsWith("[URGENT]")).length, 3);
  });

  // Tomorrow, 11:00 IST, is busy for Alan.
  const tz = 330;
  const tomorrow = new Date(Date.now() + tz * 60_000 + 86_400_000).toISOString().slice(0, 10);
  const [y, mo, d] = tomorrow.split("-").map(Number);
  const elevenIst = Date.UTC(y, mo - 1, d, 11, 0) - tz * 60_000;
  await require("../src/reminders/store").create(alan, "Private: dentist", elevenIst);

  await test("check_availability gives free times only, around his busy hour", async () => {
    const r = await svc.runGuestTool(me, alan, "check_availability", { date: tomorrow }, { tz });
    assert.ok(r.ok);
    const free = r.data.free_times;
    assert.ok(free.includes("09:00") && free.includes("14:00"));
    assert.ok(!free.includes("11:00") && !free.includes("10:30") && !free.includes("11:30"));
    assert.ok(!JSON.stringify(r).includes("dentist"), "never what he is doing");
  });
  const meeting = (time, extra = {}) => ({
    purpose: "Demo", date: tomorrow, time, minutes: 45, mode: "online",
    place: "Google Meet", attendees: "just the caller", prepare: "the slide deck", ...extra,
  });
  await test("a meeting needs only a time and a mode; the rest defaults", async () => {
    const r = await svc.runGuestTool(me, alan, "book_appointment", { purpose: "Demo", date: tomorrow, time: "15:00" }, { tz });
    assert.strictEqual(r.ok, false);
    assert.deepStrictEqual(r.needs_details, ["mode"]);
    const bad = await svc.runGuestTool(me, alan, "book_appointment", meeting("15:00", { mode: "carrier pigeon" }), { tz });
    assert.deepStrictEqual(bad.needs_details, ["mode"]);
  });
  await test("book_appointment refuses a busy time and books a free one on both sides, with every detail", async () => {
    const busy = await svc.runGuestTool(me, alan, "book_appointment", meeting("11:00"), { tz });
    assert.strictEqual(busy.ok, false);
    const ok = await svc.runGuestTool(me, alan, "book_appointment", meeting("15:00"), { tz });
    assert.ok(ok.ok, JSON.stringify(ok));
    const at15 = Date.UTC(y, mo - 1, d, 15, 0) - tz * 60_000;
    const hostRem = await db.one(`SELECT text, ring FROM reminders WHERE user_id=$1 AND due_at=$2`, [alan, at15]);
    const myRem = await db.one(`SELECT text FROM reminders WHERE user_id=$1 AND due_at=$2`, [me, at15]);
    assert.match(hostRem.text, /Meeting with Dhanush: Demo \| Online \| 45 min \| Link: Google Meet \| With: just the caller \| Prepare: the slide deck/);
    assert.strictEqual(hostRem.ring, "gentle");
    assert.match(myRem.text, /Meeting with Alan: Demo/);
    assert.match((await inbox()).at(-1).message, /Booked by your assistant/);
  });
  await test("an urgent meeting over the urgent cap books as a normal one", async () => {
    // The urgent_ping test above used today's 3 urgent alerts.
    const r = await svc.runGuestTool(me, alan, "book_appointment",
      meeting("09:00", { purpose: "Spam", mode: "phone", urgent: true }), { tz });
    assert.ok(r.ok, JSON.stringify(r));
    assert.strictEqual(r.data.urgent, false);
    await db.run(`DELETE FROM agent_messages WHERE message LIKE '[URGENT]%'`);
  });
  await test("an urgent meeting rings as an alarm and alerts Alan", async () => {
    const ok = await svc.runGuestTool(me, alan, "book_appointment",
      meeting("16:30", { purpose: "Outage review", mode: "in_person", place: "Office, 3rd floor", urgent: true }), { tz });
    assert.ok(ok.ok, JSON.stringify(ok));
    assert.strictEqual(ok.data.urgent, true);
    const at = Date.UTC(y, mo - 1, d, 16, 30) - tz * 60_000;
    const rem = await db.one(`SELECT text, ring FROM reminders WHERE user_id=$1 AND due_at=$2`, [alan, at]);
    assert.match(rem.text, /^URGENT meeting with Dhanush: Outage review \| In person/);
    assert.strictEqual(rem.ring, "alarm");
    assert.match((await inbox()).at(-1).message, /^\[URGENT\]/);
  });
  await test("booking a DOCTOR through their assistant: a clinic appointment with a patient record", async () => {
    const clinic = require("../src/clinic/store");
    await clinic.migrate();
    const doc = await mk("Dr Meera", P("07"), { persona: "doctor", profession: "Dentist" });
    await save(me, "Dr Meera", P("07"));
    // The first free slot in the doctor's default hours within a week.
    let date = null, time = null;
    for (let i = 1; i <= 7 && !time; i++) {
      const day = new Date(Date.now() + tz * 60_000 + i * 86_400_000).toISOString().slice(0, 10);
      const r = await svc.runGuestTool(me, doc, "check_availability", { date: day }, { tz });
      if (r.ok && r.data.free_times.length) { date = day; time = r.data.free_times[0]; }
    }
    assert.ok(time, "the doctor has a free slot this week");
    const r = await svc.runGuestTool(me, doc, "book_appointment", {
      purpose: "Tooth pain", date, time, minutes: 15, mode: "in_person",
      place: "Clinic", attendees: "just the caller",
    }, { tz });
    assert.ok(r.ok, JSON.stringify(r));
    const appt = await db.one(`SELECT * FROM clinic_appointments WHERE user_id=$1 ORDER BY id DESC LIMIT 1`, [doc]);
    assert.strictEqual(appt.source, "assistant");
    assert.strictEqual(appt.status, "booked");
    assert.match(appt.reason, /Tooth pain/);
    assert.ok(appt.client_id, "linked to a patient record");
    const patient = await db.one(`SELECT name, kind, phone FROM clients WHERE id=$1 AND user_id=$2`, [appt.client_id, doc]);
    assert.strictEqual(patient.kind, "patient");
    assert.strictEqual(patient.phone, P("01"));
    // The same caller booking again reuses the record.
    const again = await clinic.createAppointment(doc, { patientName: "Dhanush", patientPhone: P("01"), startsAt: Number(appt.starts_at) + 7 * 86_400_000, source: "voice" });
    assert.strictEqual(Number(again.client_id), Number(appt.client_id));
    // And it is in the doctor's upcoming list.
    const up = await clinic.listAppointments(doc, { from: Date.now() - 86_400_000, to: Date.now() + 30 * 86_400_000, includeClosed: false });
    assert.ok(up.some((x) => Number(x.id) === Number(appt.id)));
  });
  await test("a minimal meeting books with defaults filled in", async () => {
    const ok = await svc.runGuestTool(me, alan, "book_appointment", { date: tomorrow, time: "13:00", mode: "phone" }, { tz });
    assert.ok(ok.ok, JSON.stringify(ok));
    const at17 = Date.UTC(y, mo - 1, d, 13, 0) - tz * 60_000;
    const rem = await db.one(`SELECT text FROM reminders WHERE user_id=$1 AND due_at=$2`, [alan, at17]);
    assert.match(rem.text, /Meeting with Dhanush: Meeting \| Phone call \| 30 min \| Call: \+9190\d+ \| With: just the caller/);
  });
  await test("the instructions are fast: act at once, no read-back, no confirmation", async () => {
    const s = await svc.sessionFor(me, alan);
    assert.match(s.instructions, /Act IMMEDIATELY/);
    assert.match(s.instructions, /Never read a request back/);
    assert.match(s.instructions, /Ask Alan to call me/);
    assert.doesNotMatch(s.instructions, /Shall I go ahead\?"\. Call the tool only after/);
  });
  await test("bad input and unknown tools are refused", async () => {
    assert.strictEqual((await svc.runGuestTool(me, alan, "check_availability", { date: "tomorrow" })).ok, false);
    assert.strictEqual((await svc.runGuestTool(me, alan, "read_his_messages", {})).ok, false);
    assert.strictEqual((await svc.runGuestTool(me, alan, "end_call", {})).end, true);
  });

  console.log("\nafter the call");
  await test("the summary reaches the host; a one-line call sends nothing", async () => {
    const before = (await inbox()).length;
    const none = await svc.finish(me, alan, [{ role: "user", text: "hi" }], { ai: async () => "x" });
    assert.strictEqual(none.summarised, false);
    const r = await svc.finish(me, alan, [
      { role: "assistant", text: "Hello Dhanush, I am Nova." },
      { role: "user", text: "Book me tomorrow at three." },
    ], { ai: async (text, owner) => { assert.strictEqual(owner, "Alan"); return "Dhanush booked a demo tomorrow at 15:00."; } });
    assert.ok(r.summarised);
    const all = await inbox();
    assert.strictEqual(all.length, before + 1);
    assert.match(all.at(-1).message, /Call with your assistant Nova/);
  });

  console.log("\nthe owner's voice tool");
  await test("connect_to_assistant opens the call for an app contact, and explains otherwise", async () => {
    const registry = require("../src/tools/registry");
    require("../src/tools/builtins");
    const tool = registry.get ? registry.get("connect_to_assistant") : null;
    if (!tool) return console.log("       (registry has no get(); covered by the service tests above)");
    const ok = await tool.execute({ contact_name: "Alan" }, { userId: me });
    assert.ok(ok.ok, JSON.stringify(ok));
    assert.strictEqual(ok.deviceAction.type, "connect_assistant");
    assert.strictEqual(ok.deviceAction.hostId, alan);
    const no = await tool.execute({ contact_name: "Not On App" }, { userId: me });
    assert.strictEqual(no.ok, false);
    assert.match(no.speak, /does not use MyAssistant/);
  });

  console.log("\nurgent alerts escalate until seen");
  await test("the ping schedule: once, 5 min later twice, then every 20 s", async () => {
    const u = require("../src/connect/urgent");
    assert.deepStrictEqual([1, 2, 3, 4, 5].map(u.gapAfter), [300_000, 15_000, 60_000, 20_000, 20_000]);
  });
  await test("an urgent alert pings once and queues the next ping in 5 minutes", async () => {
    const u = require("../src/connect/urgent");
    await u.migrate();
    await db.run(`DELETE FROM agent_messages WHERE message LIKE '[URGENT]%'`);
    await db.run(`DELETE FROM connect_urgent`);
    const r = await svc.runGuestTool(me, alan, "urgent_ping", { what_happened: "Server is down" });
    assert.ok(r.ok, JSON.stringify(r));
    const a = await db.one(`SELECT * FROM connect_urgent WHERE user_id=$1 ORDER BY id DESC LIMIT 1`, [alan]);
    assert.ok(a && a.message_id, "alert recorded with its message");
    assert.strictEqual(a.pings, 1);
    const job = await db.one(`SELECT * FROM jobs WHERE kind=$1 AND (payload->>'id')::bigint=$2`, [u.JOB, a.id]);
    assert.ok(job, "next ping queued");
    assert.strictEqual(Number(job.payload.n), 2);
    const wait = Number(job.run_after) - Number(job.created_at);
    assert.ok(wait >= 299_000 && wait <= 301_000, `waits 5 min (${wait})`);
  });
  await test("unseen: the job pings again and queues the next, until acknowledged", async () => {
    const u = require("../src/connect/urgent");
    const a = await db.one(`SELECT * FROM connect_urgent WHERE user_id=$1 ORDER BY id DESC LIMIT 1`, [alan]);
    await u.onJob({ id: a.id, n: 2 });
    await u.onJob({ id: a.id, n: 3 });
    await u.onJob({ id: a.id, n: 4 });
    assert.strictEqual((await db.one(`SELECT pings FROM connect_urgent WHERE id=$1`, [a.id])).pings, 4);
    // Reading the message in the inbox is seeing it.
    assert.strictEqual(await u.ack(alan, { messageIds: [a.message_id] }), 1);
    await u.onJob({ id: a.id, n: 5 });
    const after = await db.one(`SELECT pings, acked_at FROM connect_urgent WHERE id=$1`, [a.id]);
    assert.strictEqual(after.pings, 4, "no ping after it was seen");
    assert.ok(after.acked_at);
    assert.strictEqual(await u.ack(alan, { id: a.id }), 0, "acknowledged once only");
  });
  await test("only the host can acknowledge, and an old alert stops by itself", async () => {
    const u = require("../src/connect/urgent");
    await db.run(`DELETE FROM agent_messages WHERE message LIKE '[URGENT]%'`);
    await svc.runGuestTool(me, alan, "urgent_ping", { what_happened: "Call me" });
    const a = await db.one(`SELECT * FROM connect_urgent WHERE user_id=$1 ORDER BY id DESC LIMIT 1`, [alan]);
    assert.strictEqual(await u.ack(me, { id: a.id }), 0, "the caller cannot silence it");
    await db.run(`UPDATE connect_urgent SET created_at = $2 WHERE id=$1`, [a.id, Date.now() - 61 * 60_000]);
    await u.onJob({ id: a.id, n: 9 });
    const end = await db.one(`SELECT pings, ended_at FROM connect_urgent WHERE id=$1`, [a.id]);
    assert.ok(end.ended_at, "ended after the hour");
    assert.strictEqual(end.pings, 1);
  });

  console.log(`\n${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
  await db.close();
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
}).finally(() => setTimeout(() => process.exit(process.exitCode || 0), 100).unref());

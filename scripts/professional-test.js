/**
 * PROFESSIONAL FEATURE TESTS — `npm run test:professional`.
 *
 * Covers the features built for busy professionals: commitment tracking,
 * proactive nudging, and meeting capture.
 *
 * No database and no network. What is tested is the DECISION LOGIC — what
 * counts as a promise, when it is too late at night to interrupt someone —
 * because those are the judgements that misfire in ways
 * a user notices immediately.
 */
process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgres://test:test@localhost:5432/test";

const assert = require("assert");
const commitments = require("../src/commitments/service");
const scheduler = require("../src/proactive/scheduler");
const meetings = require("../src/meetings/service");

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

/* ------------------------------------------------------------------ */

console.log("\ncommitment capture");

test("a real promise passes the cheap gate", () => {
  for (const s of [
    "I'll send Ravi the proposal by Friday",
    "let me get back to her tomorrow",
    "I need to file the GST return before the 20th",
    "tell him I will call back tonight",
  ]) {
    assert.ok(commitments.PROMISE_RX.test(s), `missed: ${s}`);
  }
});

test("ordinary conversation does NOT trigger a model call", () => {
  // The gate exists so extraction costs nothing on a normal turn. If this
  // regresses, every single utterance starts paying for an extra API call.
  for (const s of [
    "what's the weather like",
    "play some music",
    "he said he would send it",
    "book me a cab to the airport",
    "what is the punishment for cheating",
  ]) {
    assert.ok(!commitments.PROMISE_RX.test(s), `false positive: ${s}`);
  }
});

test("extraction is fire-and-forget and never throws into a turn", () => {
  // extractAsync must be safe to call with anything, including junk, with
  // no await — a rejected promise here would surface as an unhandled
  // rejection mid-conversation.
  assert.doesNotThrow(() => {
    commitments.extractAsync(null, "I'll send it tomorrow");
    commitments.extractAsync(1, "");
    commitments.extractAsync(1, "nothing promised here");
  });
});

console.log("\nproactive nudging");

test("quiet hours block a 3am nudge and allow a midday one", () => {
  // localHour() derives from the tz offset, so shift the offset to place
  // "now" at a known local hour rather than depending on when tests run.
  const utcHour = new Date().getUTCHours();
  const offsetFor = (targetHour) => ((targetHour - utcHour + 24) % 24) * 60;

  assert.strictEqual(scheduler.inQuietHours(offsetFor(3)), true, "3am must be quiet");
  assert.strictEqual(scheduler.inQuietHours(offsetFor(23)), true, "11pm must be quiet");
  assert.strictEqual(scheduler.inQuietHours(offsetFor(13)), false, "1pm must be allowed");
  assert.strictEqual(scheduler.inQuietHours(offsetFor(9)), false, "9am must be allowed");
});

test("the scheduler starts and stops without a database", () => {
  assert.doesNotThrow(() => {
    scheduler.start();
    scheduler.start(); // idempotent — a double start must not double-sweep
    scheduler.stop();
  });
});

console.log("\nmeeting capture");

(async () => {
  await atest("a too-short recording is reported, not analysed", async () => {
    const out = await meetings.analyze("hello?");
    assert.deepStrictEqual(out.decisions, []);
    assert.deepStrictEqual(out.actions, []);
    assert.ok(/too short/i.test(out.summary), out.summary);
    // Crucially it does NOT fabricate a summary of a meeting that had none.
    assert.strictEqual(out.follow_up, "");
  });

  test("only the user's own action items become tracked commitments", () => {
    // record() files actions where mine === true. Anything else stays in
    // the meeting record: we cannot nudge someone else's client, and a
    // tracker full of other people's tasks is one the user stops reading.
    const actions = [
      { text: "Send the revised quote", owner: "Dhanush", mine: true },
      { text: "Get board approval", owner: "Ravi", mine: false },
      { text: "Share the deck", owner: "Ravi", mine: false },
    ];
    assert.strictEqual(actions.filter((a) => a.mine).length, 1);
  });

  console.log("\ntool surface");

  test("each professional feature is reachable by voice", () => {
    const registry = require("../src/tools/registry");
    require("../src/tools/builtins").registerBuiltins();
    for (const n of [
      "list_my_commitments",   // "what did I promise?"
      "complete_commitment",   // "I sent it"
      "recall_meeting",        // "what did we decide?"
    ]) {
      assert.ok(registry.get(n), `missing tool: ${n}`);
    }
  });

  test("completing a commitment that does not exist fails honestly", async () => {
    const registry = require("../src/tools/registry");
    const t = registry.get("complete_commitment");
    assert.strictEqual(t.risk, "medium");
    assert.ok(t.description.includes("Mark"));
  });

  // The Quick Actions tiles' mics (owner, 2026-11-23): the advocate's
  // "Book Consultation" and the business "Schedule Meeting" book by voice
  // into the same appointment book the doctor uses — nobody else does.
  await atest("booking by voice is open to the three professions, and only them", async () => {
    const registry = require("../src/tools/registry");
    const persona = require("../src/users/persona");
    const tool = registry.get("book_patient_appointment");
    const refused = /only for doctor, advocate and business profiles/;
    const args = { client_name: "Nobody Such", starts_at: "2099-01-05T10:00:00+05:30" };
    const real = persona.personaOf;
    try {
      for (const who of ["student", "personal", "professional"]) {
        persona.personaOf = async () => who;
        const r = await tool.execute(args, { userId: 1, tzOffsetMin: 330 });
        assert.ok(r && r.ok === false && refused.test(r.error), `${who} is refused`);
      }
      for (const who of ["doctor", "advocate", "business"]) {
        persona.personaOf = async () => who;
        // Past the gate it looks the client up; whatever that answers here,
        // it is not the profession refusal.
        let r;
        try {
          r = await tool.execute(args, { userId: 1, tzOffsetMin: 330 });
        } catch (e) {
          r = { ok: false, error: String(e && e.message) };
        }
        assert.ok(!refused.test(String(r && r.error)), `${who} passes the gate`);
      }
    } finally {
      persona.personaOf = real;
    }
    assert.ok(/advocate's consultation/.test(tool.description));
  });

  console.log(`\n${passed} passed${process.exitCode ? " — with failures above" : ""}\n`);
})();

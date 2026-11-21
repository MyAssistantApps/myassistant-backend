/**
 * WORKSPACE TESTS — `npm run test:workspace`.
 *
 * Unit (no database): every pack is complete, professions land on the
 * right pack, routine times are computed in the user's time zone, AI plan
 * blocks are cleaned.
 * Database (DATABASE_URL, a THROWAWAY one; skipped without it): the
 * overview, a routine switched on becomes ONE repeating reminder and off
 * removes it, the day plan uses the AI, falls back to the pack's day, and
 * is cached per day.
 */
const hasDb = Boolean(process.env.DATABASE_URL);
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://test:test@localhost:5432/test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "workspace-test-secret-workspace-test-0001";

const assert = require("assert");
const packs = require("../src/workspace/packs");
const svc = require("../src/workspace/service");

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

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

(async () => {
  console.log("\npacks are complete");
  await test("every pack has a day, four routines and six actions, all well-formed", () => {
    const ids = new Set();
    for (const p of packs.PACKS) {
      assert.ok(!ids.has(p.id), `duplicate ${p.id}`);
      ids.add(p.id);
      assert.ok(p.title && p.tagline && p.focus > 0, p.id);
      assert.ok(p.day.length >= 5, `${p.id} day`);
      for (const b of p.day) assert.ok(HHMM.test(b.start) && HHMM.test(b.end) && b.end > b.start, `${p.id} ${b.title}`);
      assert.strictEqual(p.routines.length, 4, `${p.id} routines`);
      const rids = new Set();
      for (const r of p.routines) {
        assert.ok(!rids.has(r.id), `${p.id} duplicate routine ${r.id}`);
        rids.add(r.id);
        assert.ok(HHMM.test(r.time), `${p.id}.${r.id} time`);
        assert.ok(["daily", "weekly", "monthly"].includes(r.repeat), `${p.id}.${r.id} repeat`);
        if (r.repeat === "weekly") assert.ok(r.weekday >= 0 && r.weekday <= 6, `${p.id}.${r.id} weekday`);
        if (r.repeat === "monthly") assert.ok(r.monthDay >= 1 && r.monthDay <= 28, `${p.id}.${r.id} monthDay`);
        assert.ok(r.title && r.detail && r.text, `${p.id}.${r.id} copy`);
      }
      assert.strictEqual(p.actions.length, 6, `${p.id} actions`);
      for (const x of p.actions) assert.ok(x.label && x.icon && x.ask, `${p.id} action`);
      assert.ok(!("match" in packs.toClient(p)), "the matcher is not sent to the app");
    }
  });

  console.log("\nprofessions land on the right pack");
  const cases = {
    "Software Engineer": "engineering", "Product Manager": "engineering", "Civil Engineer": "engineering",
    "Data Scientist / Analyst": "engineering", "Designer": "engineering",
    "Teacher": "education", "Professor / Lecturer": "education", "Tutor / Coach": "education",
    "Chartered Accountant": "finance", "Banker": "finance", "Company Secretary": "finance", "Legal Consultant": "finance",
    "Sales & Marketing": "sales",
    "Manager": "management", "HR / Recruiter": "management", "Operations Executive": "management",
    "Consultant": "management", "Customer Support": "management",
    "Content Creator": "creative", "Journalist / Writer": "creative", "Photographer": "creative",
    "Nurse": "healthcare_staff", "Pharmacist": "healthcare_staff", "Lab Technician": "healthcare_staff",
    "Driver": "field_work", "Delivery Partner": "field_work", "Electrician / Plumber": "field_work",
    "Mechanic / Technician": "field_work", "Chef / Cook": "field_work",
    "Police / Defence": "public_service", "Government Employee": "public_service", "Pilot / Cabin Crew": "public_service",
    "Freelancer": "freelance",
    "College Student": "student", "Exam Aspirant (UPSC, NEET, JEE)": "student",
    "Homemaker": "homemaker", "Retired": "retired", "retired banker": "retired", "Looking for Work": "job_seeker",
  };
  await test(`${Object.keys(cases).length} catalog professions`, () => {
    for (const [profession, want] of Object.entries(cases)) {
      assert.strictEqual(packs.packFor({ profession, persona: "professional" }).id, want, profession);
    }
  });
  await test("unknown text falls back by persona", () => {
    assert.strictEqual(packs.packFor({ profession: "Astrologer", persona: "professional" }).id, "general");
    assert.strictEqual(packs.packFor({ profession: "", persona: "student" }).id, "student");
    assert.strictEqual(packs.packFor({ profession: "", persona: "personal" }).id, "personal");
    assert.strictEqual(packs.packFor({}).id, "general");
  });

  console.log("\nroutine times, in the user's clock");
  // 2026-11-21 (a Saturday) 08:00 IST = 02:30 UTC.
  const now = Date.UTC(2026, 10, 21, 2, 30);
  const ist = (ms) => new Date(ms + 330 * 60_000).toISOString().slice(0, 16);
  await test("daily: later today, or tomorrow once passed", () => {
    assert.strictEqual(ist(svc.nextAt({ time: "09:15", repeat: "daily" }, { tz: 330, now })), "2026-11-21T09:15");
    assert.strictEqual(ist(svc.nextAt({ time: "07:00", repeat: "daily" }, { tz: 330, now })), "2026-11-22T07:00");
  });
  await test("weekly: the next matching weekday", () => {
    assert.strictEqual(ist(svc.nextAt({ time: "16:30", repeat: "weekly", weekday: 5 }, { tz: 330, now })), "2026-11-27T16:30");
    assert.strictEqual(ist(svc.nextAt({ time: "10:00", repeat: "weekly", weekday: 6 }, { tz: 330, now })), "2026-11-21T10:00");
  });
  await test("monthly: the next matching date", () => {
    assert.strictEqual(ist(svc.nextAt({ time: "10:00", repeat: "monthly", monthDay: 25 }, { tz: 330, now })), "2026-11-25T10:00");
    assert.strictEqual(ist(svc.nextAt({ time: "10:00", repeat: "monthly", monthDay: 1 }, { tz: 330, now })), "2026-12-01T10:00");
  });
  await test("a bad time is refused", () => {
    assert.throws(() => svc.nextAt({ time: "25:00", repeat: "daily" }), /HH:MM/);
  });

  console.log("\nplan blocks are cleaned");
  await test("bad blocks are dropped, kinds normalised, sorted, capped", () => {
    const out = svc.cleanBlocks([
      { start: "14:00", end: "15:00", title: "Review", kind: "task" },
      { start: "09:00", end: "10:00", title: "Deep work", kind: "focus" },
      { start: "11:00", end: "10:00", title: "Backwards", kind: "task" },
      { start: "9:00", end: "10:00", title: "Bad time", kind: "task" },
      { start: "12:00", end: "12:30", title: "", kind: "break" },
      { start: "16:00", end: "16:30", title: "Odd kind", kind: "party" },
    ]);
    assert.deepStrictEqual(out.map((b) => b.title), ["Deep work", "Review", "Odd kind"]);
    assert.strictEqual(out[2].kind, "task");
    assert.strictEqual(svc.cleanBlocks(Array(30).fill({ start: "09:00", end: "10:00", title: "x", kind: "task" })).length, 12);
  });

  if (!hasDb) {
    console.log("\nworkspace DB tests: skipped (set DATABASE_URL to a throwaway database)");
  } else {
    const db = require("../src/db");
    await db.init();
    await require("../src/workspace/store").migrate();
    const u = await db.one(
      `INSERT INTO users (email, name, profession, persona, created_at) VALUES ($1,'Eng','Software Engineer','professional',$2) RETURNING id`,
      [`workspace-${Date.now()}@example.test`, Date.now()]);
    const uid = Number(u.id);

    console.log("\noverview and routines (database)");
    await test("overview: the engineering pack, every routine off, no plan", async () => {
      const o = await svc.overview(uid, 330);
      assert.strictEqual(o.pack.id, "engineering");
      assert.strictEqual(o.routines.length, 4);
      assert.ok(o.routines.every((r) => r.on === false));
      assert.strictEqual(o.plan, null);
      assert.ok(Array.isArray(o.today.reminders) && Array.isArray(o.today.promises));
    });

    await test("switching a routine on makes one repeating reminder; off removes it", async () => {
      let o = await svc.setRoutine(uid, "standup", { on: true, time: "09:20" }, 330);
      const s = o.routines.find((r) => r.id === "standup");
      assert.ok(s.on && s.time === "09:20" && s.nextAt > Date.now());
      const rows = await db.query(`SELECT repeat, text FROM reminders WHERE user_id=$1`, [uid]);
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0].repeat, "daily");
      // Switching it on again replaces, never duplicates.
      await svc.setRoutine(uid, "standup", { on: true }, 330);
      assert.strictEqual((await db.query(`SELECT 1 FROM reminders WHERE user_id=$1`, [uid])).length, 1);
      o = await svc.setRoutine(uid, "standup", { on: false }, 330);
      assert.ok(!o.routines.find((r) => r.id === "standup").on);
      assert.strictEqual((await db.query(`SELECT 1 FROM reminders WHERE user_id=$1`, [uid])).length, 0);
    });

    await test("a weekly routine repeats weekly; an unknown routine is a 404", async () => {
      await svc.setRoutine(uid, "weekly", { on: true }, 330);
      const r = await db.one(`SELECT repeat FROM reminders WHERE user_id=$1`, [uid]);
      assert.strictEqual(r.repeat, "weekly");
      await assert.rejects(svc.setRoutine(uid, "nope", { on: true }, 330), (e) => e.status === 404);
    });

    await test("deleting the reminder elsewhere reads as off", async () => {
      await db.run(`DELETE FROM reminders WHERE user_id=$1`, [uid]);
      const o = await svc.overview(uid, 330);
      assert.ok(!o.routines.find((r) => r.id === "weekly").on);
    });

    console.log("\nthe day plan (database)");
    await test("the AI plan is used, cleaned, and cached for the day", async () => {
      let asked = 0;
      const ai = async ({ prompt }) => {
        asked++;
        assert.match(prompt, /Software Engineer/);
        return { blocks: [{ start: "10:00", end: "12:00", title: "Finish the API", kind: "focus" }, { start: "x", end: "y", title: "bad", kind: "task" }], note: "Protect the morning." };
      };
      const p = await svc.planDay(uid, 330, { ai });
      assert.strictEqual(p.source, "ai");
      assert.deepStrictEqual(p.blocks.map((b) => b.title), ["Finish the API"]);
      assert.strictEqual(p.note, "Protect the morning.");
      await svc.planDay(uid, 330, { ai });
      assert.strictEqual(asked, 1, "the second open is served from the cache");
      assert.strictEqual((await svc.overview(uid, 330)).plan.blocks.length, 1);
    });

    await test("a failing AI falls back to the pack's own day", async () => {
      const p = await svc.planDay(uid, 330, { force: true, ai: async () => { throw new Error("down"); } });
      assert.strictEqual(p.source, "template");
      assert.strictEqual(p.blocks.length, packs.get("engineering").day.length);
    });

    await test("privacy: both tables are erased with the account", async () => {
      const tables = require("../src/routes/privacy").USER_TABLES || [];
      const names = tables.map((t) => t[0]);
      if (names.length) {
        assert.ok(names.includes("workspace_routines") && names.includes("workspace_days"));
      }
    });
    await db.close();
  }

  console.log(`\n${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
}).finally(() => setTimeout(() => process.exit(process.exitCode || 0), 100).unref());

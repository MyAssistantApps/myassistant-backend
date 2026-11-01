/**
 * THE MANAGER AGENT — `npm run test:manager`.
 *
 * Pins agents/manager.js:
 *   (a) every specialist's toolkit names real registered tools, and the
 *       ESSENTIAL set does too — a renamed tool must fail here, not
 *       silently vanish from a specialist;
 *   (b) cue words route ordinary requests to the right specialists,
 *       several at once for a request with several parts;
 *   (c) a follow-up ("yes", "do it") keeps the previous turn's specialists,
 *       and only within the carry window;
 *   (d) the tool list: MUST and ESSENTIAL first, then the toolkits, then
 *       the old selection, capped — and with no specialist, the old
 *       selection untouched;
 *   (e) skips: a shortcut, an app note, empty text, AI_MANAGER=off;
 *   (f) the model step is never reached without a key, and short chat
 *       never asks it.
 *
 * No database and no network: the model is never called here.
 */
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://x:y@127.0.0.1:1/z";
process.env.JWT_SECRET = process.env.JWT_SECRET || "manager-test-0123456789012345678901234567";
process.env.NODE_ENV = process.env.NODE_ENV || "test";
delete process.env.OPENAI_API_KEY;
delete process.env.AI_MANAGER;

const assert = require("assert");
require("../src/agents/runtime"); // registers the built-in tools
const registry = require("../src/tools/registry");
const manager = require("../src/agents/manager");

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    process.exitCode = 1;
    console.error(`FAIL  ${name}\n      ${e.message}`);
  }
}

(async () => {
  const live = new Set(registry.list().map((t) => t.name));

  console.log("(a) toolkits name real tools");
  await test("every specialist tool is registered", () => {
    const missing = [];
    for (const [id, s] of Object.entries(manager.SPECIALISTS)) {
      for (const n of s.tools) if (!live.has(n)) missing.push(`${id}:${n}`);
    }
    assert.deepStrictEqual(missing, []);
  });
  await test("every ESSENTIAL tool is registered", () => {
    assert.deepStrictEqual(manager.ESSENTIAL.filter((n) => !live.has(n)), []);
  });
  await test("each specialist has a role, cues and a toolkit", () => {
    for (const [id, s] of Object.entries(manager.SPECIALISTS)) {
      assert.ok(s.role && s.role.length > 40, `${id} role`);
      assert.ok(s.cues instanceof RegExp, `${id} cues`);
      assert.ok(s.tools.length >= 5, `${id} tools`);
    }
  });

  console.log("(b) cue words");
  const cases = [
    ["call mom", "comms"],
    ["send a whatsapp to Ravi saying I'm late", "comms"],
    ["remind me to pay rent tomorrow at 9", "planner"],
    ["set an alarm for 6 am", "planner"],
    ["what's the weather in Bangalore", "info"],
    ["any news about ISRO", "info"],
    ["order biryani from swiggy", "commerce"],
    ["recharge my jio", "commerce"],
    ["draw a poster for my cafe", "creative"],
    ["play some old hindi songs", "creative"],
    ["turn on the flashlight", "device"],
    ["uninstall candy crush", "device"],
    ["remember that my wife's birthday is 4 june", "memory"],
    ["show my documents that expire this month", "records"],
    // found by live testing with the real model, 2026-10-31
    ["can you sort out dinner for the kids tonight", "commerce"],
    ["my mother keeps asking about her pension papers", "records"],
    ["I need to get to the airport by six", "commerce"],
    ["is it going to be cold enough for a jacket", "info"],
  ];
  for (const [text, want] of cases) {
    await test(`"${text}" -> ${want}`, () => {
      assert.ok(manager.byRules(text).includes(want), `got ${manager.byRules(text).join(",") || "none"}`);
    });
  }
  await test("two parts reach two specialists", () => {
    const got = manager.byRules("order biryani and tell Ravi I'm running late");
    assert.ok(got.includes("commerce") && got.includes("comms"), got.join(","));
  });
  await test("never more than three specialists", () => {
    const got = manager.byRules("call mom, remind me at 5, order pizza, draw a cat and turn on wifi");
    assert.ok(got.length <= 3, got.join(","));
  });
  await test("relationship words alone are not a memory request", () => {
    assert.ok(!manager.byRules("my mother keeps asking about her pension papers").includes("memory"));
  });
  await test("thanks and greetings never ask the model", async () => {
    for (const t of ["thanks so much for that", "good morning to you", "okay that is great"]) {
      assert.ok(manager.SMALL_TALK.test(t), t);
      assert.strictEqual((await manager.decide({ text: t })).via, "none", t);
    }
  });
  await test("a plain question is not an Information request (seen in the app)", () => {
    const got = manager.byRules("What is on my shopping list and what do you remember about me");
    assert.ok(!got.includes("info"), got.join(","));
    assert.ok(got.includes("commerce") && got.includes("memory"), got.join(","));
  });
  await test("small talk names no specialist", () => {
    assert.deepStrictEqual(manager.byRules("hello there"), []);
    assert.deepStrictEqual(manager.byRules("thanks a lot"), []);
  });

  console.log("(c) follow-ups carry the previous specialists");
  await test("a yes keeps them", async () => {
    const session = {};
    const first = await manager.decide({ text: "send 200 rupees to amma on upi", session });
    assert.strictEqual(first.via, "maya");
    const next = await manager.decide({ text: "yes do it", session });
    assert.strictEqual(next.via, "carry");
    assert.deepStrictEqual(next.agents, first.agents);
  });
  await test("not after the carry window", async () => {
    const session = { manager: { agents: ["commerce"], at: Date.now() - 11 * 60_000 } };
    const next = await manager.decide({ text: "yes", session });
    assert.notStrictEqual(next.via, "carry");
  });
  await test("a new subject is routed fresh, not carried", async () => {
    const session = { manager: { agents: ["commerce"], at: Date.now() } };
    const next = await manager.decide({ text: "what's the weather tomorrow in Pune", session });
    assert.strictEqual(next.via, "maya");
    assert.ok(next.agents.includes("info"));
  });

  console.log("(d) the tool list");
  const base = ["web_search", "get_weather", "create_reminder", "place_phone_call", "draft_text"];
  await test("no specialist: the old selection, untouched", () => {
    assert.strictEqual(manager.toolsFor({ agents: [] }, { base, live }), base);
  });
  await test("must, essential, toolkit, then base", () => {
    const out = manager.toolsFor({ agents: ["commerce"] }, { base, must: ["run_shortcut"], live, cap: 40 });
    assert.strictEqual(out[0], "run_shortcut");
    for (const n of manager.ESSENTIAL) assert.ok(out.includes(n), n);
    assert.ok(out.includes("order_food") && out.includes("pay_by_upi"));
    assert.ok(out.indexOf("order_food") < out.indexOf("place_phone_call"));
    assert.strictEqual(new Set(out).size, out.length, "no duplicates");
  });
  await test("capped, but never below must + essential", () => {
    const out = manager.toolsFor({ agents: ["planner", "commerce", "records"] }, { base, live, cap: 40 });
    assert.strictEqual(out.length, 40);
    const tiny = manager.toolsFor({ agents: ["planner"] }, { base, must: ["run_shortcut"], live, cap: 3 });
    assert.ok(tiny.length >= 1 + manager.ESSENTIAL.length);
  });
  await test("a big toolkit cannot crowd a second specialist out (found by e2e-g1)", () => {
    const text = "forget that I am vegetarian, and set an alarm for 6 am";
    const agents = manager.byRules(text);
    assert.ok(agents.includes("planner") && agents.includes("memory"), agents.join(","));
    const out = manager.toolsFor({ agents }, { base: ["forget_memory"], live, cap: 40 });
    assert.ok(out.length <= 40);
    for (const n of ["forget_memory", "set_alarm", "remember_fact"]) assert.ok(out.includes(n), n);
    // each specialist keeps a fair share even with no scorer hint
    const blind = manager.toolsFor({ agents: ["planner", "memory"] }, { base: [], live, cap: 40 });
    const memoryShare = manager.SPECIALISTS.memory.tools.filter((n) => blind.includes(n)).length;
    assert.ok(memoryShare >= 8, `memory kept ${memoryShare}`);
  });
  await test("tools this user lacks are dropped", () => {
    const out = manager.toolsFor({ agents: ["records"] }, { base: [], live: new Set(["web_search", "record_entry"]) });
    assert.deepStrictEqual(out.sort(), ["record_entry", "web_search"]);
  });
  await test("the brief: nothing for one kind of work; several parts are hers, no team", () => {
    assert.strictEqual(manager.briefFor({ agents: [] }), "");
    assert.strictEqual(manager.briefFor({ agents: ["comms"] }), "");
    const two = manager.briefFor({ agents: ["comms", "commerce"] });
    assert.ok(/COMMUNICATION/.test(two) && /SHOPPING AND MONEY/.test(two) && /several parts/.test(two));
    assert.ok(!/\[MANAGER\]|Specialists for/.test(two) && /Never mention agents/.test(two), two);
  });

  console.log("(e) skips");
  await test("a shortcut or garbled turn is not routed", async () => {
    assert.strictEqual((await manager.decide({ text: "call mom", skip: true })).via, "skip");
  });
  await test("the app's own note is not routed", async () => {
    assert.strictEqual((await manager.decide({ text: "[SYSTEM] call ended", owner: false })).via, "skip");
  });
  await test("empty text is not routed", async () => {
    assert.strictEqual((await manager.decide({ text: "   " })).via, "skip");
  });
  await test("AI_MANAGER=off is the old behaviour", async () => {
    process.env.AI_MANAGER = "off";
    const plan = await manager.decide({ text: "call mom" });
    delete process.env.AI_MANAGER;
    assert.strictEqual(plan.via, "skip");
    assert.strictEqual(manager.toolsFor(plan, { base, live }), base);
  });

  console.log("(f) the model step");
  await test("short chat never asks the model", async () => {
    const plan = await manager.decide({ text: "hi there" });
    assert.strictEqual(plan.via, "none");
  });
  await test("without a key an unreadable turn falls back to none, fast", async () => {
    const plan = await manager.decide({ text: "can you sort out the thing we talked about" });
    assert.strictEqual(plan.via, "none");
    assert.ok(plan.ms < 200, `${plan.ms}ms`);
  });

  console.log("(h) what the phone shows: no agents");
  await test("the phone is never told about agents", () => {
    const none = { via: "maya", agents: [], toolAgent: {} };
    assert.deepStrictEqual(manager.controlFor({ agents: ["commerce", "comms"], via: "maya" }, ["order_food"]), none);
    assert.deepStrictEqual(manager.controlFor(null), none);
  });

  console.log("(j) Maya first: the manager only when needed");
  await test("one specialist's words: Maya handles it, no team note", async () => {
    const p = await manager.decide({ text: "set an alarm for 6 am" });
    assert.deepStrictEqual([p.via, p.agents.join(",")], ["maya", "planner"]);
    assert.strictEqual(manager.briefFor(p), "");
    assert.ok(manager.toolsFor(p, { base: [], live }).includes("set_alarm"), "its tools are still offered");
  });
  await test("several kinds of work: still Maya, with every part's tools", async () => {
    const p = await manager.decide({ text: "order biryani and tell Ravi I'm running late" });
    assert.strictEqual(p.via, "maya");
    assert.ok(p.agents.length >= 2);
    const out = manager.toolsFor(p, { base: [], live, cap: 40 });
    assert.ok(out.includes("order_food") && out.includes("send_agent_message"));
  });
  await test("nothing matched: Maya answers, no model call by default", async () => {
    const p = await manager.decide({ text: "can you sort out the thing we talked about" });
    assert.deepStrictEqual([p.via, p.agents.length], ["none", 0]);
  });
  await test("the agents get a map of the app", () => {
    const g = require("../src/agents/appGuide").appGuide("Maya");
    assert.ok(/Home, Hub/.test(g) && !/Design/.test(g));
    assert.ok(/only assistant/.test(g) && /Never mention agents/.test(g), "Maya never presents a team");
    assert.ok(!/Your agents|specialist agents —|The owner sees the team/.test(g));
    assert.ok(g.length < 1600);
  });

  console.log("(i) the Manager, only when asked");
  for (const [text, want] of [
    ["I want to talk to your manager", true], ["connect me to your boss", true],
    ["can I speak with the manager agent", true], ["let me talk to your supervisor please", true],
    ["call the manager at the bank", false], ["call my manager Ravi", false], ["call mom", false],
    ["set an alarm for 6", false],
  ]) {
    await test(`"${text}" -> ${want ? "the Manager" : "Maya"}`, () => {
      assert.strictEqual(manager.askedManager(text), want);
    });
  }
  await test("asked: the Manager takes the conversation, keeps follow-ups, and hands back", async () => {
    const session = {};
    const p = await manager.decide({ text: "I want to talk to your manager", session });
    assert.deepStrictEqual([p.via, p.addressed], ["manager", "manager"]);
    const next = await manager.decide({ text: "find the best rated biryani near me and open Swiggy", session });
    assert.strictEqual(next.addressed, "manager", "a follow-up stays with the Manager");
    const back = await manager.decide({ text: "thanks manager, back to Maya", session });
    assert.deepStrictEqual([back.via, !!back.handback, !!back.addressed], ["handback", true, false]);
    const after = await manager.decide({ text: "set an alarm for 6", session });
    assert.strictEqual(after.via, "maya", "Maya again");
  });
  await test("the Manager's hold ends after five quiet minutes", async () => {
    const session = { persona: { id: "manager", at: Date.now() - 6 * 60_000 } };
    const p = await manager.decide({ text: "set an alarm for 6", session });
    assert.strictEqual(p.via, "maya");
  });
  await test("the Manager gets the internet, apps and every team's tools (more than Maya)", () => {
    const p = { agents: manager.SPECIALISTS ? Object.keys(manager.SPECIALISTS) : [], addressed: "manager" };
    const out = manager.toolsFor(p, { base: ["get_weather"], live, cap: 40 });
    for (const n of ["web_search", "read_webpage", "open_named_app", "phone_control", "place_phone_call",
      "create_reminder", "order_food", "remember_fact"]) {
      if (live.has(n)) assert.ok(out.includes(n), n);
    }
    assert.ok(out.length > 40 && out.length <= manager.MANAGER_CAP, `${out.length} tools`);
  });
  await test("the brief makes it the Manager; the phone is told to show the panel", () => {
    const brief = manager.briefFor({ agents: [], addressed: "manager" }, { assistant: "Maya" });
    assert.ok(/you ARE the Manager/.test(brief) && /Manager here/.test(brief) && /handing them back to Maya/.test(brief), brief);
    assert.deepStrictEqual(manager.controlFor({ agents: [], addressed: "manager" }).addressed, { id: "manager", label: "Manager" });
    assert.strictEqual(manager.controlFor({ agents: [], handback: true }).via, "handback");
    assert.deepStrictEqual(manager.controlFor({ agents: ["comms"], via: "maya" }), { via: "maya", agents: [], toolAgent: {} },
      "any other turn: nothing shown");
  });
  await test("the live voice has the switch as tools, and no old persona tool", () => {
    assert.ok(registry.get("hand_to_manager") && registry.get("hand_back_to_assistant"));
    assert.ok(!registry.get("talk_as_agent"));
    assert.ok(/hand_to_manager/.test(manager.managerRule("Maya")));
  });

  console.log("(g) parallel-safe tools (registry.isParallelSafe)");
  registry.seal({ strict: false });
  await test("the read-only allowlist names real tools", () => {
    assert.deepStrictEqual([...registry.READ_ONLY_LEGACY].filter((n) => !live.has(n)), []);
  });
  await test("plain reads may run together", () => {
    for (const n of ["get_weather", "web_search", "list_reminders", "recall_memory"]) {
      assert.ok(registry.isParallelSafe(n), n);
    }
  });
  await test("writes, device actions and money never do", () => {
    for (const n of ["create_reminder", "cancel_scheduled_task", "add_finance_item", "remember_fact",
      "send_agent_message", "place_phone_call", "pay_by_upi", "order_food", "send_developer_feedback",
      "create_document", "start_task", "shopping_list_add", "set_alarm", "phone_control"]) {
      assert.ok(!registry.isParallelSafe(n), n);
    }
  });
  await test("someone else's words are read in order, never in parallel", () => {
    for (const n of registry.UNTRUSTED_SOURCES) assert.ok(!registry.isParallelSafe(n), n);
  });
  await test("an unknown tool is not safe", () => {
    assert.ok(!registry.isParallelSafe("no_such_tool"));
  });

  console.log(`\n${passed} passed${process.exitCode ? " — FAILURES above" : ""}`);
  process.exit(process.exitCode || 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

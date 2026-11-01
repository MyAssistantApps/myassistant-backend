/**
 * TASKS INSIDE OTHER APPS (ai/screenTask.js) — the safety rules, with no
 * model and no network. Run: npm run test:screen
 */
process.env.NODE_ENV = process.env.NODE_ENV || "test";
const assert = require("assert");
const s = require("../src/ai/screenTask");

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
}
const screen = { pkg: "com.whatsapp", app: "WhatsApp", nodes: [
  { i: 1, text: "Ravi", click: true }, { i: 2, hint: "Message", edit: true },
  { i: 3, desc: "Send", click: true }, { i: 4, hint: "Enter OTP", edit: true },
  { i: 5, pw: true, edit: true }, { i: 6, text: "Pay ₹250", click: true },
  { i: 7, text: "Place order", click: true }, { i: 8, desc: "Delete chat", click: true },
] };
const step = (o) => s.enforce({ node: null, text: null, direction: null, say: "x", result: null, ...o }, screen);

test("send, pay, order and delete always need the owner's yes", () => {
  for (const n of [3, 6, 7, 8]) assert.strictEqual(step({ action: "tap", node: n }).sensitive, true, `#${n}`);
});
test("an ordinary tap goes ahead", () => assert.strictEqual(step({ action: "tap", node: 1 }).sensitive, false));
test("passwords and codes are never typed", () => {
  assert.strictEqual(step({ action: "type", node: 5, text: "secret" }).action, "fail");
  assert.strictEqual(step({ action: "type", node: 4, text: "482913" }).action, "fail");
  assert.strictEqual(step({ action: "type", node: 2, text: "running late" }).action, "type");
});
test("an element not on the screen is never tapped", () => assert.strictEqual(step({ action: "tap", node: 99 }).action, "wait"));
test("this app and the installer are off limits", () => {
  for (const pkg of ["com.myassistant.myassistant", "com.google.android.packageinstaller"]) {
    assert.strictEqual(s.enforce({ action: "tap", node: 1, say: "x" }, { pkg, nodes: [{ i: 1 }] }).action, "fail", pkg);
  }
});
test("the model reads the screen compactly, passwords marked, never their text", () => {
  const d = s.describe({ app: "WhatsApp", nodes: [{ i: 1, text: "Ravi", click: true }, { i: 5, pw: true, edit: true }] });
  assert.match(d, /#1 view "Ravi" \[tap\]/);
  assert.match(d, /#5 view \(password\) \[type\]/);
});
test("do_in_app starts a screen task on the phone with the app and the whole goal", async () => {
  const reg = { tools: {}, get(n) { return this.tools[n]; }, register(t) { this.tools[t.name] = t; } };
  s.registerScreenTaskTools(reg);
  s.registerScreenTaskTools(reg); // twice is fine
  return reg.get("do_in_app").execute({ app: "WhatsApp", goal: "send Ravi hi" }).then((r) => {
    assert.deepStrictEqual(r.deviceAction, { type: "screen_task", app: "WhatsApp", goal: "send Ravi hi" });
  });
});
console.log(`screen-task: ${passed} passed`);

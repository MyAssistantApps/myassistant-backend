/**
 * TASKS INSIDE OTHER APPS (owner, 2026-11-01: "should be able to open any
 * app I asked for and do task" — built with confirmations).
 *
 * The phone's Accessibility service (ScreenAgentService.kt) can read what
 * is on screen and tap, type, scroll and go back. A task runs on the phone
 * as a loop: it sends the screen here (POST /ai/screen/step), this module
 * asks the model for ONE next step, the phone does it, and again — until
 * the model says done or failed, or the phone's step limit is reached.
 *
 * SAFETY, enforced here AND on the phone:
 *   - A step that would pay, send, buy, order, delete, transfer, book,
 *     submit or confirm is marked `sensitive`, whatever the model said; the
 *     phone shows its own Allow / Stop card and waits for the owner.
 *   - Password and OTP fields are never read (the phone sends them blank)
 *     and never typed into: such a step fails the task.
 *   - The installer, Settings' security pages and this app itself are off
 *     limits (the phone refuses them too).
 */
const openai = require("../services/ai/openai");

const MAX_NODES = 220;
const MAX_HISTORY = 12;

/** Words on a control that make tapping it consequential. */
const RISKY = /\b(pay|paying|payment|send|sending|buy|purchase|order|place order|checkout|check out|delete|remove|uninstall|transfer|book|booking|submit|confirm|proceed to pay|subscribe|donate|withdraw|unsubscribe|block|report|post|publish|share|call|accept|agree|allow|install|log ?out|sign ?out)\b/i;

/** Places a task never acts in. */
const OFF_LIMITS = /^(com\.android\.packageinstaller|com\.google\.android\.packageinstaller|com\.android\.settings\.security|com\.myassistant\.myassistant)$/;

const SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["tap", "type", "scroll", "back", "wait", "done", "fail"] },
    node: { type: ["integer", "null"], description: "The # of the element to tap, type into or scroll." },
    text: { type: ["string", "null"], description: "What to type (type only)." },
    direction: { type: ["string", "null"], enum: ["up", "down", null] },
    say: { type: "string", description: "Five to eight words on what this step does, for the owner." },
    result: { type: ["string", "null"], description: "done/fail only: one sentence on how it ended." },
  },
  required: ["action", "node", "text", "direction", "say", "result"],
  additionalProperties: false,
};

const SYSTEM = [
  "You operate an Android phone for its owner through its accessibility service, one step at a time, to",
  "complete the GOAL in the app that is open. You see the screen as a list of elements: #number, kind,",
  "text, and what it accepts (tap, type, scroll). Choose ONE next step:",
  "- tap #n · type #n with text · scroll #n up/down (or the screen when no list) · back · wait (the screen is",
  "  still loading) · done (the goal is reached; say how) · fail (impossible or unsafe; say why).",
  "Rules:",
  "- Only use element numbers that are on THIS screen. Prefer what is visible over guessing.",
  "- Look at the steps already taken: never repeat a step that did not change anything; try another way.",
  "- Do exactly what the goal asks and nothing more: no extra messages, purchases, follows or settings.",
  "- To type, tap the field first if it is not focused, then type into it.",
  "- Never type passwords, PINs, OTPs or card numbers; if the goal needs one, fail and say the owner must enter it.",
  "- Sending, paying, ordering, booking or deleting is the LAST step and needs the owner's yes, which the phone",
  "  asks for itself: just choose that tap when everything before it is ready.",
  "- If a login, captcha or an unexpected payment screen appears, fail and say what is needed.",
  "- `say` is shown to the owner while you work: short and plain (\"Opening Ravi's chat\").",
].join("\n");

/** The screen, compactly, as the model reads it. */
function describe(screen) {
  const nodes = Array.isArray(screen && screen.nodes) ? screen.nodes.slice(0, MAX_NODES) : [];
  const lines = nodes.map((n) => {
    const can = [n.click && "tap", n.edit && "type", n.scroll && "scroll"].filter(Boolean).join(",");
    const label = String(n.text || n.desc || n.hint || "").replace(/\s+/g, " ").slice(0, 80);
    const kind = String(n.cls || "").split(".").pop() || "view";
    return `#${n.i} ${kind}${n.pw ? " (password)" : ""}${label ? ` "${label}"` : ""}${n.id ? ` id=${String(n.id).split("/").pop()}` : ""}${can ? ` [${can}]` : ""}${n.focus ? " (focused)" : ""}`;
  });
  return `APP: ${String((screen && screen.app) || (screen && screen.pkg) || "unknown")}\n` +
    `SCREEN (${nodes.length} elements):\n${lines.join("\n") || "(nothing readable)"}`;
}

/** The phone's step, checked again here: sensitive taps, blocked fields, bad targets. */
function enforce(step, screen) {
  const nodes = Array.isArray(screen && screen.nodes) ? screen.nodes : [];
  const byI = new Map(nodes.map((n) => [n.i, n]));
  const out = { ...step, sensitive: false };
  if (OFF_LIMITS.test(String((screen && screen.pkg) || ""))) {
    return { action: "fail", node: null, text: null, direction: null, say: "Stopped",
      result: "That screen is off limits for me; please do this part yourself.", sensitive: false };
  }
  if (["tap", "type", "scroll"].includes(out.action) && out.node != null && !byI.has(out.node)) {
    if (out.action !== "scroll") {
      return { ...out, action: "wait", node: null, say: "Looking at the screen again" };
    }
    out.node = null;
  }
  const target = out.node != null ? byI.get(out.node) : null;
  if (out.action === "type") {
    if (target && target.pw) {
      return { action: "fail", node: null, text: null, direction: null, say: "Stopped",
        result: "That needs a password or code, which you have to type yourself.", sensitive: false };
    }
    if (/\b(\d{4,8})\b/.test(String(out.text || "")) && /otp|pin|code|password|cvv/i.test(String(target && (target.hint || target.text || target.id) || ""))) {
      return { action: "fail", node: null, text: null, direction: null, say: "Stopped",
        result: "That needs a code you have to enter yourself.", sensitive: false };
    }
  }
  if (out.action === "tap" && target) {
    const label = `${target.text || ""} ${target.desc || ""} ${String(target.id || "").split("/").pop()}`;
    if (RISKY.test(label)) out.sensitive = true;
  }
  return out;
}

/**
 * One step: { goal, screen:{pkg,app,nodes[]}, history:[{action,say,...}] }
 * -> { action, node, text, direction, say, result, sensitive }.
 */
async function nextStep({ goal, screen, history = [] }, { model } = {}) {
  const g = String(goal || "").trim().slice(0, 500);
  if (!g) throw Object.assign(new Error("goal is required"), { status: 400 });
  const past = (Array.isArray(history) ? history : []).slice(-MAX_HISTORY)
    .map((h, k) => `${k + 1}. ${h.action}${h.node != null ? ` #${h.node}` : ""}${h.text ? ` "${String(h.text).slice(0, 60)}"` : ""} — ${String(h.say || "").slice(0, 60)}${h.changed === false ? " (nothing changed)" : ""}`);
  const user = `GOAL: ${g}\n\nSTEPS SO FAR:\n${past.join("\n") || "(none yet)"}\n\n${describe(screen)}`;
  const out = await openai.chat({
    system: SYSTEM,
    messages: [{ role: "user", content: user }],
    model: model || process.env.SCREEN_TASK_MODEL || openai.models.smart(),
    json: true, schema: SCHEMA, maxTokens: 300, timeoutMs: 20_000,
  });
  let step;
  try { step = JSON.parse(out.text || "{}"); } catch (_) { step = {}; }
  if (!SCHEMA.properties.action.enum.includes(step.action)) {
    step = { action: "wait", node: null, text: null, direction: null, say: "Looking at the screen again", result: null };
  }
  return enforce(step, screen);
}

/** The tool that starts a task on the phone. */
function registerScreenTaskTools(registry) {
  if (registry.get("do_in_app")) return;
  registry.register({
    name: "do_in_app",
    description:
      "DO A TASK INSIDE ANOTHER APP on the phone, step by step on its screen: 'send Ravi \"running late\" on " +
      "WhatsApp', 'add a large Margherita to my Domino's cart', 'turn on dark mode in Instagram'. Give the app's " +
      "name and the whole goal in plain words. The phone opens the app and works through it; anything that " +
      "sends, pays, orders, books or deletes stops for the owner's yes on screen. Use open_named_app instead " +
      "when they only want the app opened, and the dedicated tools (place_phone_call, send_whatsapp_message, " +
      "order_food…) when one fits — this is for everything else. Never for passwords, OTPs or banking PINs.",
    risk: "medium",
    // Only a build that can run it (ScreenAgentService) says screen_task.
    requires: [{ kind: "device_feature", id: "screen_task" }],
    // Starting it is a phone action; each step that sends, pays or deletes
    // stops on the phone for the owner's yes (enforce + ScreenAgentService).
    effects: ["device"],
    deviceAction: true,
    inputSchema: {
      type: "object",
      properties: {
        app: { type: "string", description: "The app's name as they said it ('WhatsApp', 'Swiggy')." },
        goal: { type: "string", description: "The whole task, in plain words, with every detail they gave." },
      },
      required: ["app", "goal"],
    },
    async execute(args) {
      const app = String(args.app || "").trim().slice(0, 60);
      const goal = String(args.goal || "").trim().slice(0, 500);
      if (!app || !goal) return { ok: false, error: "say which app and what to do in it" };
      return {
        ok: true,
        deviceAction: { type: "screen_task", app, goal },
        speak: `On it — working in ${app} now.`,
      };
    },
  });
}

module.exports = { nextStep, enforce, describe, registerScreenTaskTools, SCHEMA, RISKY };

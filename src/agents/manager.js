/**
 * THE MANAGER AGENT (2026-10-31).
 *
 * One assistant used to face every turn alone with a word-scored slice of
 * ~170 tools (tools/relevance.js). The manager now decides, per turn,
 * which SPECIALIST agents the request belongs to — communication,
 * planning, information, commerce, creative work, the phone itself,
 * memory, records — and the turn is handed to them:
 *
 *   • tools  — the chosen specialists' whole toolkits go to the front of
 *              the turn's tool list, so "order biryani and tell Ravi I'm
 *              late" gets both order_food and send_agent_message even
 *              when the word scorer missed one. A few ESSENTIAL tools stay
 *              on every turn; the rest of the old selection fills what
 *              room is left (cap PHONE_MAX), so nothing that was offered
 *              before is lost on a turn the manager reads wrongly.
 *   • brief  — a short role note per specialist, added to THIS TURN (the
 *              end of the prompt, so the cached prefix is untouched).
 *
 * HOW IT DECIDES, cheapest first:
 *   1. skip    — a shortcut, the app's own note, a garbled transcript:
 *                nothing to manage.
 *   2. carry   — "yes", "do it", "and him too": a follow-up keeps the
 *                specialists of the previous turn (10 minutes).
 *   3. rules   — cue words per specialist. Instant, no model.
 *   4. model   — only when the rules found nothing and the turn is long
 *                enough to mean something: one small JSON call to the
 *                chat model, capped at MODEL_TIMEOUT_MS. A timeout or an
 *                error is the old behaviour, never a failed turn.
 *
 * ONE ASSISTANT, NOTHING VISIBLE (owner, 2026-11-01: "let most of the task
 * be done by one AI model only, i.e. Maya … the user should not be able to
 * see the underlying agents, even in the UI"). Every turn is Maya's, on
 * the one chat model: the specialists are only tool groups and short notes
 * inside her own turn, never another voice, name or screen. The phone is
 * told no agents (controlFor), "talk to your manager" is gone, and the one
 * extra model call (step 4) stays opt-in for when the rules miss.
 *
 * AI_MANAGER=off turns the manager off (the old selection, unchanged);
 * AI_MANAGER_MODEL=off keeps the rules and drops step 4.
 */

const CARRY_MS = 10 * 60_000;
// Measured 2026-10-31: gpt-5.4-nano routes in 0.7–1.2 s (gpt-4.1-mini
// 1.2–1.7 s). The wait overlaps the personal context ai/context.js
// fetches meanwhile.
const MODEL_TIMEOUT_MS = Number(process.env.AI_MANAGER_TIMEOUT_MS) || 1500;
const MAX_AGENTS = 3;

/** Every turn keeps these, whatever the manager decides. */
const ESSENTIAL = [
  "end_conversation", "present_text", "recall_conversation", "remember_fact", "recall_memory",
  "web_search", "check_recent_actions", "send_developer_feedback", "stay_silent",
];

const SPECIALISTS = {
  comms: {
    scope: "calls, messages, WhatsApp, email",
    label: "Communication",
    role: "You are handling COMMUNICATION: calls, messages, WhatsApp and email. Find the right " +
      "person from memory or contacts before acting; never invent a number or address.",
    cues: /\b(call|ring|dial|phone (him|her|them)|message|msg|text (him|her|them)|sms|whatsapp|e-?mail|mail|inbox|reply|send .+ to|tell \w+|let \w+ know|missed calls?|who called)\b/i,
    tools: ["place_phone_call", "phone_calls", "send_agent_message", "send_whatsapp_message",
      "email_read", "email_reply", "email_send", "email_recipients", "send_document",
      "send_video_note", "check_my_calls", "call_recall", "book_by_calling_business",
      "arrange_meeting_with", "lookup_person", "show_address"],
  },
  planner: {
    scope: "reminders, calendar, alarms, timers, plans, habits",
    label: "Planning",
    role: "You are handling PLANNING: reminders, calendar, alarms, timers, scheduled tasks, the " +
      "day's priorities and habits. Confirm the exact date and time you set, in their time zone.",
    cues: /\b(remind|reminder|calendar|meeting|appointment|schedule|alarm|wake me|timer|tomorrow|tonight|today|next (week|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|at \d{1,2}(:\d\d)?\s*(am|pm)?|o'?clock|agenda|plan my day|priorit\w*|habits?|streak|focus|brief|promised|commitment|to-?dos?)\b/i,
    tools: ["create_reminder", "list_reminders", "update_reminder", "create_calendar_event",
      "list_calendar_events", "update_calendar_event", "delete_calendar_event", "schedule_task",
      "list_scheduled_tasks", "cancel_scheduled_task", "set_alarm", "set_timer", "stop_timer",
      "show_alarms", "stop_alarm", "snooze_alarm", "plan_my_day", "complete_priority",
      "momentum_status", "add_habit", "check_habit", "start_focus", "daily_brief",
      "play_daily_brief", "set_morning_brief", "show_schedule", "list_my_commitments",
      "complete_commitment", "prepare_meeting", "record_meeting", "recall_meeting", "start_task"],
  },
  info: {
    scope: "search, news, weather, places, directions, law, travel",
    label: "Information",
    role: "You are handling INFORMATION: search, news, weather, places, maps, law and travel. " +
      "Use live tools for anything that can change; say where an answer came from.",
    // Not "what is / how / why": every question starts so, and "what is on
    // my shopping list" is no lookup (seen in the app, 2026-10-31).
    cues: /\b(who was|search|google|look up|news|headlines|weather|rain|temperature|near (me|by)|nearby|directions?|navigate|route to|how far|law|act|section|judg(e)?ment|flight|fare|convert|exchange rate|horoscope|research|pdf of|forecast|cold|jacket|umbrella|sunny)\b/i,
    tools: ["web_search", "deep_research", "read_webpage", "get_news", "show_news",
      "read_news_story", "get_weather", "find_places_nearby", "get_current_location",
      "start_navigation", "consult_knowledge", "indian_law", "indian_case_law", "convert_currency",
      "search_flights", "watch_flight_fare", "show_pictures", "show_search_results",
      "open_public_pdf", "get_horoscope", "going_out_check"],
  },
  commerce: {
    scope: "shopping, food, rides, tickets, recharge, payments, money",
    label: "Shopping and money",
    role: "You are handling SHOPPING AND MONEY: the shopping list, orders, rides, tickets, " +
      "recharges and payments. Anything that spends or requests money needs their clear yes first.",
    cues: /\b(buy|order|shopping|grocer\w*|cart|swiggy|zomato|blinkit|zepto|amazon|flipkart|uber|ola|cab|taxi|ride|airport|station|ticket|movie|recharge|pay|upi|rupees?|rs\.?|₹|payment|paid|owe|emi|loan|salary|budget|finance|pantry|run out of|dinner|lunch|breakfast|food|hungry|biryani|pizza|groceries)\b/i,
    tools: ["shopping_list_add", "shopping_list_show", "shopping_list_check", "shopping_list_remove",
      "shopping_list_clear", "shopping_list_clear_all", "shop_from_list", "share_shopping_list",
      "pantry_update", "order_food", "book_ride", "book_movie_tickets", "mobile_recharge",
      "open_service_app", "pay_by_upi", "save_upi_id", "collect_payment", "check_payments",
      "list_my_errands", "check_task_outcomes", "add_finance_item", "update_finance_item",
      "remove_finance_item", "get_finance_plan"],
  },
  creative: {
    scope: "images, video, photo edits, documents, drafts, music",
    label: "Creative",
    role: "You are handling CREATIVE WORK: images, video, photo edits, documents, drafts and " +
      "music. Ask one short question only when the request is too vague to make anything good.",
    cues: /\b(draw|image|picture of|poster|design|generate|create (a|an)|make (a|an|me)|video|edit (my|this|the) photo|background|look like|try (on|a look)|write (a|an|me)|draft|essay|letter|speech|document|pdf|ppt|presentation|spreadsheet|play|song|music|playlist)\b/i,
    tools: ["generate_image", "generate_video", "edit_my_photo", "try_a_look", "create_document",
      "draft_text", "edit_draft", "present_text", "play_music", "open_video_mode"],
  },
  device: {
    scope: "phone settings, apps, camera, screenshots, shortcuts",
    label: "Phone control",
    role: "You are handling THE PHONE ITSELF: settings, apps, the camera, screenshots and " +
      "shortcuts. Say exactly what changed; if the phone refused, say so.",
    cues: /\b(turn (on|off)|switch (on|off)|wifi|wi-fi|bluetooth|torch|flashlight|volume|brightness|silent|dnd|do not disturb|open (the )?\w+( app)?|launch|uninstall|install|update the app|dark mode|light mode|theme|screen time|camera|scan|screenshot|what('?s| is) (this|on my screen)|translat\w*|interpreter|shortcuts?)\b/i,
    tools: ["phone_control", "open_app", "open_named_app", "open_app_screen", "open_webpage",
      "uninstall_app", "update_app", "set_app_theme", "get_app_usage", "enable_usage_tracking",
      "analyze_camera", "look_at_screenshot", "capture_document", "scan_business_card",
      "translator_mode", "start_interpreter_mode", "stop_interpreter_mode", "run_shortcut",
      "continue_shortcut", "list_shortcuts", "create_shortcut", "update_shortcut", "delete_shortcut"],
  },
  memory: {
    scope: "remembering or forgetting facts about the owner and people",
    label: "Memory",
    role: "You are handling MEMORY: what to remember, recall or forget about the owner and the " +
      "people in their life. Save only what they actually said; read back what you saved.",
    cues: /\b(remember|don'?t forget|forget|recall|what do you know|who is my|birthday|anniversary|address|lives? (at|in)|from now on|always|never again|call yourself|your name)\b/i,
    tools: ["remember_fact", "recall_memory", "forget_memory", "remember_person",
      "remember_person_date", "remember_address", "add_person_note", "lookup_person",
      "update_my_profile", "add_standing_instruction", "remove_standing_instruction",
      "configure_assistant", "recall_conversation"],
  },
  records: {
    scope: "saved documents, record books, cases, clients, papers",
    label: "Records and documents",
    role: "You are handling RECORDS AND DOCUMENTS: saved files, record books, cases, clients " +
      "and patients. Read totals and dates from the records, never from memory of the chat.",
    cues: /\b(documents?|files?|receipts?|reports?|notices?|certificates?|expir\w*|renew\w*|records?|accounts?|entry|entries|ledger|total|cases?|hearings?|clients?|patients?|recall visit|dues|notion|papers|pension|passport|aadhaar|pan card|licen[cs]e|insurance|policy)\b/i,
    tools: ["search_documents", "find_document", "get_last_document", "list_person_documents",
      "associate_document", "list_expiring_documents", "save_web_document",
      "file_document_under_client", "record_entry", "list_entries", "amend_last_entry",
      "remember_case", "remember_event", "check_patient_dues", "record_patient_payment",
      "schedule_patient_recall", "complete_patient_recall", "send_patient_document",
      "bills_email", "notion_search", "notion_read_page", "notion_add", "notion_create_page"],
  },
};
const NAMES = Object.keys(SPECIALISTS);

/**
 * THE MANAGER, ON REQUEST (owner, 2026-11-01: "if user says I want to talk
 * to your manager agent the manager agent should pop up ... access to the
 * internet and much more tools ... open any app I asked for and do task").
 * Everything else stays Maya's and invisible; only an explicit ask brings
 * the Manager, who keeps the conversation for follow-ups until they want
 * the assistant back (or MANAGER_MS of quiet). "Your" or "agent" is
 * required: "call the manager at the bank" is a phone call to a person.
 */
const MANAGER_MS = 5 * 60_000;
const MANAGER_CAP = 100; // OpenAI takes up to 128 functions
const ASK_MANAGER = /\b(?:talk|speak|chat|connect|put me through|transfer|call|get|bring|switch|hand|pass|want|need)\b[^.?!]{0,30}?(?:\byour\s+(?:manager|boss|supervisor)\b|\bmanager\s+agent\b)/i;
const BACK_TO_ASSISTANT = /\b(?:back to (?:maya|the assistant|my assistant|you)|(?:let me |i want to |can i )?(?:talk|speak) to maya|bye,? manager|thanks?,? manager|thank you,? manager|done with (?:the |you,? )?manager|that'?s all,? manager)\b/i;
const askedManager = (text) => ASK_MANAGER.test(String(text || ""));
// The Manager's reach: the internet, any app, the phone, then every team's tools.
const MANAGER_FIRST = ["web_search", "read_webpage", "open_named_app", "open_app_screen", "phone_control",
  "show_search_results", "show_pictures", "hand_back_to_assistant"];

// Thanks, greetings, goodbyes: no specialist, and never worth a model call.
const SMALL_TALK = /^\s*(thanks?|thank you|thanks a lot|ok(ay)?|cool|great|nice|awesome|good (morning|afternoon|evening|night)|hi|hello|hey|bye|goodbye|see you)\b[\w\s.,!?']{0,30}$/i;

// A follow-up carries no subject of its own.
const FOLLOW_UP = /^\s*(yes|yeah|yep|yup|ok(ay)?|sure|haan|ha|do it|go ahead|please( do)?|confirm(ed)?|correct|right|that one|the (first|second|third|last) one|and (him|her|them|that|also)|also|same|again|no|nope|cancel( it)?|stop)\b[\w\s.,!?']{0,40}$/i;

/** The specialists named by cue words, strongest first. */
function byRules(text) {
  const t = String(text || "");
  const hits = [];
  for (const id of NAMES) {
    const rx = new RegExp(SPECIALISTS[id].cues.source, "gi");
    const n = (t.match(rx) || []).length;
    if (n) hits.push([id, n]);
  }
  hits.sort((a, b) => b[1] - a[1]);
  return hits.slice(0, MAX_AGENTS).map(([id]) => id);
}

const SCHEMA = {
  type: "object",
  properties: {
    agents: { type: "array", items: { type: "string", enum: [...NAMES, "none"] } },
  },
  required: ["agents"],
  additionalProperties: false,
};

const MANAGER_PROMPT =
  "You route a personal assistant's turn to specialist agents. Reply with JSON " +
  '{"agents":[...]} listing 0 to 3 of: ' +
  NAMES.map((id) => `${id} (${SPECIALISTS[id].scope})`).join(", ") +
  '. Use ["none"] for small talk or anything no specialist needs. Order by importance.';

/** One small JSON call to the fast model; null on any failure or timeout. */
async function byModel(text, historyLines) {
  const openai = require("../services/ai/openai");
  if (!openai.ready() || !/^(on|1|true|yes)$/i.test(String(process.env.AI_MANAGER_MODEL || "off"))) return null;
  const recent = historyLines.slice(-2).join("\n").slice(0, 600);
  const content = (recent ? `Earlier:\n${recent}\n\n` : "") + `Now: ${String(text).slice(0, 600)}`;
  try {
    const out = await require("../services/ai/router").generateReply(
      [{ role: "user", content }],
      { system: MANAGER_PROMPT, json: true, schema: SCHEMA, model: process.env.AI_MANAGER_MODEL_NAME || openai.models.chat(),
        timeoutMs: MODEL_TIMEOUT_MS, noRetry: true, maxTokens: 40 },
    );
    const parsed = JSON.parse(out.reply || "{}");
    const agents = (Array.isArray(parsed.agents) ? parsed.agents : []).filter((a) => NAMES.includes(a));
    return [...new Set(agents)].slice(0, MAX_AGENTS);
  } catch (_) {
    return null;
  }
}

const enabled = () => !/^(off|0|false|no)$/i.test(String(process.env.AI_MANAGER || "on").trim());

/**
 * The manager's decision for one turn:
 *   { agents: ["comms", …], via: "skip"|"carry"|"rules"|"model"|"none", ms }
 * `session` is the ai/sessions record (the previous decision is kept on it).
 */
async function decide({ text, owner = true, skip = false, session = null, history = [] } = {}) {
  const t0 = Date.now();
  const done = (agents, via) => {
    const plan = { agents, via, ms: Date.now() - t0 };
    if (session && agents.length) session.manager = { agents, at: Date.now() };
    return plan;
  };
  if (!enabled() || skip || !owner || !String(text || "").trim()) return { agents: [], via: "skip", ms: 0 };

  // The Manager, asked for or still holding the conversation.
  const held = session && session.persona && session.persona.id === "manager" &&
    Date.now() - session.persona.at < MANAGER_MS;
  if (held && BACK_TO_ASSISTANT.test(text) && !askedManager(text)) {
    session.persona = null;
    return { agents: [], via: "handback", handback: true, ms: Date.now() - t0 };
  }
  if (askedManager(text) || held) {
    if (session) session.persona = { id: "manager", at: Date.now() };
    return { agents: NAMES.slice(), via: "manager", addressed: "manager", ms: Date.now() - t0 };
  }
  if (session && session.persona) session.persona = null;

  const prev = session && session.manager && Date.now() - session.manager.at < CARRY_MS
    ? session.manager.agents : null;
  if (prev && FOLLOW_UP.test(text)) return done(prev, "carry");

  // MAYA FIRST (owner, 2026-10-31: "if Maya is able to take the decision,
  // don't move to the manager"). One specialist's words: Maya does it
  // herself, with that specialist's tools at hand and no hand-off. Only a
  // request spanning two or more specialists goes through the manager.
  // Several parts ("order biryani and tell Ravi") are still hers: their
  // tools are offered together and she does each part herself.
  const ruled = byRules(text);
  if (ruled.length) return done(ruled, "maya");

  // Nothing matched: Maya answers on her own. Asking a model which
  // specialist to use cost a call and ~1 s on every such turn; it is opt-in
  // now (AI_MANAGER_MODEL=on).
  if (SMALL_TALK.test(text) || String(text).trim().split(/\s+/).length < 3) return done([], "none");
  if (/^(on|1|true|yes)$/i.test(String(process.env.AI_MANAGER_MODEL || "off"))) {
    const modelled = await byModel(text, history.map((h) => `${h.role || "user"}: ${h.text || h.content || ""}`));
    if (modelled && modelled.length) return done(modelled, "model");
  }
  return done([], "none");
}

/**
 * The turn's tool names. With no specialists this is `base` unchanged (the
 * old selection). With specialists: what MUST be there, the ESSENTIAL
 * set, the specialists' toolkits, then the rest of `base` — capped.
 */
function toolsFor(plan, { base = [], must = [], live = null, cap = 40 } = {}) {
  if (!plan || !plan.agents.length) return base;
  const has = (n) => !live || live.has(n);
  if (plan.addressed === "manager") {
    // Every team's whole kit, the internet and apps first.
    const all = NAMES.flatMap((id) => SPECIALISTS[id].tools);
    const out = [...new Set([...must, ...ESSENTIAL, ...MANAGER_FIRST, ...base, ...all])].filter(has);
    return out.slice(0, Math.max(cap, MANAGER_CAP));
  }
  const packs = plan.agents.map((id) => SPECIALISTS[id].tools.filter(has));
  const picked = new Set(base);
  // The toolkits share the room fairly: first what the word scorer ALSO
  // picked for these words (the strongest signal), then one tool from each
  // specialist in turn — so a 32-tool planner cannot push a second
  // specialist's whole kit past the cap ("forget that, and set an alarm").
  const scored = packs.flatMap((p) => p.filter((n) => picked.has(n)));
  const turns = [];
  for (let i = 0; i < Math.max(0, ...packs.map((p) => p.length)); i++) {
    for (const p of packs) if (i < p.length) turns.push(p[i]);
  }
  const out = [...new Set([...must, ...ESSENTIAL, ...scored, ...turns, ...base])].filter(has);
  return out.slice(0, Math.max(cap, must.length + ESSENTIAL.length));
}

/**
 * The THIS TURN note: Maya's own guidance for the kinds of work in this
 * request — no hand-off, no team. Nothing for a single kind of work (its
 * tools are already offered).
 */
function briefFor(plan, { assistant = "the assistant" } = {}) {
  if (plan && plan.addressed === "manager") return managerBrief(assistant, plan.first);
  if (plan && plan.handback) {
    return `They are back with you from your Manager. You are ${assistant} again: say one short, warm line ` +
      "that you're back, then carry on with whatever they asked.";
  }
  if (!plan || plan.agents.length < 2) return "";
  const lines = plan.agents.map((id) => `- ${SPECIALISTS[id].role}`);
  lines.push("- This request has several parts: do each part yourself with its own tools, then give " +
    "ONE short reply covering all of them, in the order they asked. Never mention agents or a team.");
  return "This request needs several kinds of work:\n" + lines.join("\n");
}

/** THIS TURN's note while the Manager has the conversation. */
function managerBrief(assistant) {
  return `[THE MANAGER] The owner asked to talk to your manager. For this conversation you ARE the Manager — ` +
    `the senior assistant above ${assistant}, who leads her team and can do everything she can, and more. ` +
    `Speak as the Manager, never as ${assistant}: calm, confident, warm and to the point. Start your first reply ` +
    `with "Manager here." and not again after that. You have every tool: the internet (search, and reading a page ` +
    `in full), opening any app on the phone, the phone's settings, calls, messages, reminders, calendar, documents, ` +
    `shopping and the rest. Use them to actually get the job done, several in a row when it takes several steps, ` +
    `and tell them plainly what you did. When the job is done or they ask for ${assistant}, say one short line ` +
    `handing them back to ${assistant}.`;
}

/**
 * What the phone is told about agents: nothing, except while the Manager
 * has the conversation (it shows the Manager panel) and on the turn that
 * hands back. The shape stays for installed builds.
 */
function controlFor(plan = null) {
  if (plan && plan.addressed === "manager") {
    return { via: "manager", agents: [], toolAgent: {}, addressed: { id: "manager", label: "Manager" } };
  }
  if (plan && plan.handback) return { via: "handback", agents: [], toolAgent: {} };
  return { via: "maya", agents: [], toolAgent: {} };
}

/**
 * The live voice fixes its tools when the session opens, so the switch is
 * a tool there: the model calls hand_to_manager when they ask for the
 * Manager, and hand_back_to_assistant when the Manager is done. The phone
 * shows and hides the Manager panel on these calls.
 */
function registerManagerTools(registry) {
  if (registry.get("hand_to_manager")) return; // loaded twice (tests reload the runtime)
  registry.register({
    name: "hand_to_manager",
    description:
      "ONLY when the owner asks to talk to YOUR manager ('I want to talk to your manager', 'connect me to " +
      "your boss', 'manager agent'). Then speak as the Manager — start with 'Manager here.' — until the job " +
      "is done. NEVER for calling or messaging a person: 'call the manager at the bank' is place_phone_call.",
    risk: "low",
    effects: ["read"],
    inputSchema: { type: "object", properties: {}, required: [] },
    async execute() {
      return { ok: true, agent: "manager", label: "Manager",
        result: "You are the Manager now: speak as the Manager, use every tool you need, and hand back when done." };
    },
  });
  registry.register({
    name: "hand_back_to_assistant",
    description: "The Manager is done, or the owner asked for the assistant back: hand the conversation back.",
    risk: "low",
    effects: ["read"],
    inputSchema: { type: "object", properties: {}, required: [] },
    async execute() {
      return { ok: true, agent: "assistant", result: "Handed back: you are the assistant again." };
    },
  });
}

/** For the live prompt: how the switch works there. */
function managerRule(assistant = "the assistant") {
  return `YOUR MANAGER: you are ${assistant}. Never mention agents or a team — except this: when the owner asks ` +
    `to talk to your manager, call hand_to_manager and from then on speak as the Manager ("Manager here."), ` +
    `a calm, senior, capable voice who gets the job done with every tool you have (search the internet, open any ` +
    `app, phone settings, messages, reminders and the rest). When the job is done or they ask for ${assistant}, ` +
    `call hand_back_to_assistant and say one short line as ${assistant} again.`;
}

module.exports = { decide, toolsFor, briefFor, controlFor, registerManagerTools, managerRule, askedManager, ASK_MANAGER, BACK_TO_ASSISTANT, MANAGER_CAP, byRules, SPECIALISTS, ESSENTIAL, FOLLOW_UP, SMALL_TALK, enabled };

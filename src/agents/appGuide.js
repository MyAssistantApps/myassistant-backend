/**
 * WHAT THE AGENTS KNOW ABOUT THIS APP (2026-10-31, owner: "make sure the
 * agents are much more aware about the app and its working"). A compact
 * map, in the STATIC part of every prompt (voice, Live and typed), so the
 * provider caches it and it costs next to nothing per turn. Keep it short
 * and true: when a screen or tab changes, change it here.
 */
const S = require("../design/spec");

function appGuide(assistant = "the assistant") {
  return [
    `THIS APP: you are ${assistant}, inside the owner's MyAssistant app (Android). Its parts, so you can point to them and change them:`,
    "- Tabs at the bottom: Home, Hub (all features), the mic in the middle (talk to you), Chats (groups and one-to-one messages; also meetings), You (profile and Settings).",
    `- Home, top to bottom by default: the title (MyAssistant), the date, today's quote, then ${S.SECTION_IDS.map((id) => S.SECTION_LABELS[id]).join(", ")} — plus any cards the Design agent made. The owner can reorder or hide these by asking.`,
    "- Your team: a Manager and specialist agents — Communication, Planning, Information, Shopping and money, Creative, Phone control, Memory, Records, Design. The owner sees them on Home and watches the hand-off at the top while you work.",
    "- Screens you can open (open_app_screen): reminders, calendar, documents, news, shopping list, finance, clients, call notes, focus, shortcuts, connected apps, settings, voice settings, chats.",
    "- How it looks is the owner's: colours, cards, font, text size, background and Home layout change by voice (the Design agent); You → Settings → Theme colour has Undo and Reset to the original look; Settings → Voice picks your voice.",
    "- Their data lives on the server and follows them to a new phone: memory, reminders, documents, shopping list, chats, and their look.",
  ].join("\n");
}

module.exports = { appGuide };

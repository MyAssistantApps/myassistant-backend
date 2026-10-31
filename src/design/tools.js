/**
 * THE DESIGNER (2026-10-31, v2). Maya hands every request about how the
 * app looks to ONE tool, ask_designer, in the owner's own words. The
 * Designer agent — a model that knows the design document's shape
 * (design.schema.json) and the person's current design — answers in JSON
 * only: what to change, as a partial document. The server merges and
 * validates it, saves it (undoable), and the phone draws it at once
 * (deviceAction apply_ui_spec). Maya confirms in a line.
 *
 * No model at all for undo, reset, darker and lighter.
 */
const S = require("./spec");
const store = require("./store");

const DESIGNER_PROMPT =
  "You are the Designer agent of a mobile assistant app. You change how the app looks by editing its " +
  "DESIGN DOCUMENT, whose shape (every field explained) is:\n" + S.SCHEMA_TEXT + "\n\n" +
  "You get the person's current design and their request. Answer with ONE JSON object and nothing else:\n" +
  '{"action": "change" | "undo" | "reset" | "save" | "use_saved" | "none",\n' +
  ' "changes": { only the fields that change, same shape as the document; null clears a field back to the app\'s own },\n' +
  ' "name": "a name, for save / use_saved, or a short name for a new look",\n' +
  ' "summary": "one short sentence for the owner saying what you changed"}\n' +
  "RULES: change exactly what was asked and nothing else. Colours #RRGGBB. Keep text readable: pageText " +
  "on page and cardText on card at least 4.5:1, muted text 3:1 — when you change a background, change " +
  "its text too if needed. A colour asked for must still LOOK like that colour — on a dark card red is " +
  "like #FF5A5F, blue #5AA9FF, green #4ADE80, yellow #FACC15; on a light card red is like #C62828, blue " +
  "#1D4ED8, green #15803D — never a washed-out pastel. A whole new " +
  "look (\"sunset\", \"black and gold\") sets page, card, cardRaised, pageText, pageMuted, pageFaint, " +
  "cardText, cardMuted, primary, partner, secondary, tertiary together, plus background/cards/typography " +
  "if it helps. \"Gradient background\" means background.style \"gradient\" with from and to colours that " +
  "clearly differ. Dark theme = dark page and card with light text; light = the reverse. Moving or " +
  "hiding Home parts is handled separately — do not send home and do not mention it. action \"none\" when " +
  "the request is not about how the app looks.";

/** The Designer's answer to [request], as a JSON object (or null). */
async function askModel(request, cur, extra = "") {
  const openai = require("../services/ai/openai");
  if (!openai.ready()) return null;
  const saved = await store.listThemes(cur._uid).catch(() => []);
  const { _uid, ...doc } = cur;
  const content =
    `Current design: ${JSON.stringify(doc)}\nSaved looks: ${saved.length ? saved.join(", ") : "none"}\n` +
    `Request: "${String(request).slice(0, 400)}"${extra}`;
  try {
    const r = await require("../services/ai/router").generateReply([{ role: "user", content }], {
      system: DESIGNER_PROMPT, json: true,
      // The chat model (gpt-5.4-nano): on design it matched gpt-4.1 at the
      // lowest price (compared 2026-10-31). DESIGN_MODEL overrides. A
      // dropped connection is retried by the router.
      model: process.env.DESIGN_MODEL || openai.models.chat(), timeoutMs: 20_000,
    });
    const out = JSON.parse(r.reply || "{}");
    return out && typeof out === "object" ? out : null;
  } catch (e) {
    console.warn(`design: designer failed: ${String(e.message || e).slice(0, 160)}`);
    return null;
  }
}

// Said when the Designer could not answer: say so, offer again — never loop.
const FAILED = "The designer did not answer this time and nothing changed. Tell the owner it did not work " +
  "and ask if they want you to try again — do not call ask_designer again in this reply.";

const applied = (spec, summary, extra = {}) => ({
  ok: true,
  result: summary,
  design: S.describe(spec),
  ...extra,
  deviceAction: { type: "apply_ui_spec", spec },
});

async function saveAndApply(uid, next, note, summary) {
  const v = await store.save(uid, next, note);
  if (!v.ok) return { ok: false, error: `Not applied: ${v.errors.join("; ")}` };
  require("./cards").forget(uid);
  return applied(v.spec, summary);
}

// Requests that need no model.
const UNDO = /^\s*(please\s+)?(undo( that| it| the last( change)?)?|go back( to the (last|previous|old) (look|design|one))?|i liked it (better )?before)\b/i;
const RESET = /\b(reset|restore)\b.*\b(design|look|theme|colou?rs?|app)\b|\b(original|default) (look|design|theme)\b/i;
const SHADE = /\b(darker|lighter|brighter)\b/i;

async function designFor(uid, request) {
  const cur = await store.get(uid);
  const text = String(request || "").trim();

  if (UNDO.test(text)) {
    const spec = await store.undo(uid);
    if (!spec) return { ok: false, error: "There is no earlier look to go back to." };
    require("./cards").forget(uid);
    return applied(spec, "Back to the previous look.");
  }
  if (RESET.test(text)) return applied(await store.reset(uid), "Back to the app's original look.");
  if (SHADE.test(text) && text.split(/\s+/).length <= 6) {
    const dir = /darker/i.test(text) ? "darker" : "lighter";
    return saveAndApply(uid, S.merge(cur, { colors: S.shade(cur, dir) }), `designer: ${dir}`,
      `Made the page and cards ${dir}.`);
  }

  // Layout ("hide Born today", "reminders first") is asked separately,
  // with a strict schema that can only name real sections.
  const layout = LAYOUT.test(text) ? await layoutFor(text, cur) : null;
  if (layout && !COLOURISH.test(text)) {
    return saveAndApply(uid, { ...cur, home: { sections: arrange(cur.home.sections, layout) } },
      `designer: ${text.slice(0, 120)}`, layoutSummary(layout, cur));
  }
  let out = await askModel(text, { ...cur, _uid: uid });
  if (!out) return { ok: false, error: FAILED };
  for (let attempt = 0; attempt < 2; attempt++) {
    const action = String(out.action || "change");
    if (action === "none") {
      return { ok: false, error: `That isn't something the app's design can do${out.summary ? `: ${out.summary}` : "."}` };
    }
    if (action === "undo") return designFor(uid, "undo");
    if (action === "reset") return applied(await store.reset(uid), "Back to the app's original look.");
    if (action === "save") {
      const r = await store.saveTheme(uid, out.name || "My look", cur);
      return r.ok ? { ok: true, result: `Saved this look as "${r.name}".` } : r;
    }
    if (action === "use_saved") {
      const t = await store.getTheme(uid, out.name);
      if (!t) {
        const names = await store.listThemes(uid);
        return { ok: false, error: names.length ? `No saved look called "${out.name}". Saved: ${names.join(", ")}.` : "There are no saved looks yet." };
      }
      return saveAndApply(uid, t.spec, `designer: use ${t.name}`, `Switched to "${t.name}".`);
    }
    const changes = out.changes && typeof out.changes === "object" ? { ...out.changes } : {};
    // Home's layout never comes from this free-form answer (a model
    // rewriting the list moved the wrong things): layoutFor() below.
    delete changes.home;
    if (layout) changes.home = { sections: arrange(cur.home.sections, layout) };
    if (!Object.keys(changes).length) return { ok: false, error: "The designer changed nothing — ask the owner what should look different." };
    const next = S.merge(cur, { ...changes, ...(out.name && changes.colors ? { name: out.name } : {}) });
    const v = S.validate(next);
    const said = String(out.summary || "Changed the look.").slice(0, 200);
    const summary = layout ? `${layoutSummary(layout, cur).replace(/\.$/, "")}; ${said[0].toLowerCase()}${said.slice(1)}` : said;
    if (v.ok) return saveAndApply(uid, next, `designer: ${text.slice(0, 120)}`, summary);
    if (attempt === 1) return { ok: false, error: `The designer's change was not readable, so nothing changed: ${v.errors.join("; ")}` };
    out = await askModel(text, { ...cur, _uid: uid },
      `\nYour last answer was rejected: ${v.errors.join("; ")}. Answer again with that fixed.`);
    if (!out) return { ok: false, error: FAILED };
  }
  return { ok: false, error: FAILED };
}

const LAYOUT = /\b(hide|show|unhide|remove|move|put|first|top|last|bottom|order|rearrange|above|below)\b/i;
const COLOURISH = /\b(colou?rs?|red|blue|green|black|white|gold|purple|pink|orange|yellow|grey|gray|theme|dark|light|gradient|font|text|bigger|smaller|rounded|corners?|style|background|title|card (with|for|showing)|add a card|new card)\b/i;

/** The layout ops for [request], from a strict schema (only real section ids). */
async function layoutFor(request, cur) {
  const openai = require("../services/ai/openai");
  if (!openai.ready()) return null;
  const ids = cur.home.sections.map((x) => x.id);
  const label = (id) => (S.SECTION_LABELS[id] ||
    ((cur.customCards.find((c) => `card:${c.id}` === id) || {}).title) || id);
  const list = { type: "array", items: { type: "string", enum: ids } };
  try {
    const r = await require("../services/ai/router").generateReply([{
      role: "user",
      content: `Home sections, top to bottom now: ${cur.home.sections.map((x) => `${x.id} = ${label(x.id)}${x.visible ? "" : " (hidden)"}`).join("; ")}.
` +
        `Request: "${String(request).slice(0, 300)}"`,
    }], {
      system: "You rearrange the Home screen of an app. Answer with the sections to put FIRST (the very top, in " +
        "order), LAST (the very end, in order), to HIDE and to SHOW. Leave a list empty when nothing goes in " +
        "it. 'My reminders', 'my day', 'agenda', 'calendar' are the section today. Only what was asked.",
      json: true,
      schema: { type: "object", properties: { first: list, last: list, hide: list, show: list },
        required: ["first", "last", "hide", "show"], additionalProperties: false },
      model: process.env.DESIGN_MODEL || openai.models.chat(), timeoutMs: 15_000,
    });
    const out = JSON.parse(r.reply || "{}");
    const any = ["first", "last", "hide", "show"].some((k) => Array.isArray(out[k]) && out[k].length);
    return any ? out : null;
  } catch (e) {
    console.warn(`design: layout failed: ${String(e.message || e).slice(0, 160)}`);
    return null;
  }
}

/** What actually changed — not every id the model listed. */
function layoutSummary(ops, cur) {
  const name = (id) => S.SECTION_LABELS[id] || ((cur.customCards.find((c) => `card:${c.id}` === id) || {}).title) || id;
  const before = cur.home.sections;
  const after = arrange(before, ops);
  const was = (id) => before.findIndex((x) => x.id === id);
  const now = (id) => after.findIndex((x) => x.id === id);
  const vis = (list, id) => (list.find((x) => x.id === id) || {}).visible;
  const parts = [];
  // Only what moved UP: the others were just pushed down by it.
  const top = (ops.first || []).filter((id) => now(id) < was(id));
  if (top.length) parts.push(`put ${top.map(name).join(", ")} at the top`);
  const end = (ops.last || []).filter((id) => was(id) !== now(id));
  if (end.length) parts.push(`moved ${end.map(name).join(", ")} to the end`);
  const hid = (ops.hide || []).filter((id) => vis(before, id) && !vis(after, id));
  if (hid.length) parts.push(`hid ${hid.map(name).join(", ")}`);
  const shown = (ops.show || []).filter((id) => !vis(before, id) && vis(after, id));
  if (shown.length) parts.push(`brought back ${shown.map(name).join(", ")}`);
  const t = parts.join(", ");
  return t ? `${t[0].toUpperCase()}${t.slice(1)}.` : "Rearranged Home.";
}

/** Home's sections after {first, last, hide, show} (ids; unknown ones ignored). */
function arrange(sections, ops = {}) {
  const ids = (v) => (Array.isArray(v) ? v : v ? [v] : []).map(String);
  let list = sections.map((x) => ({ ...x }));
  const known = (id) => list.some((x) => x.id === id);
  const first = ids(ops.first).filter(known);
  const last = ids(ops.last).filter(known);
  if (first.length || last.length) {
    list = [
      ...first.map((id) => list.find((x) => x.id === id)),
      ...list.filter((x) => !first.includes(x.id) && !last.includes(x.id)),
      ...last.map((id) => list.find((x) => x.id === id)),
    ];
  }
  for (const id of ids(ops.hide)) { const x = list.find((y) => y.id === id); if (x) x.visible = false; }
  for (const id of ids(ops.show)) { const x = list.find((y) => y.id === id); if (x) x.visible = true; }
  return list;
}

function registerDesignTools(registry) {
  registry.register({
    name: "ask_designer",
    risk: "low",
    effects: ["write:record"],
    deviceAction: true,
    timeoutMs: 60_000,
    description:
      "The Designer agent: for ANY request about how THIS app looks — colours of anything (\"card text red\", " +
      "\"blue buttons\"), a whole new look (\"sunset\", \"black and gold\"), dark/light, darker/lighter, a " +
      "gradient background, card style and corners, font, text size, the Home title, showing, hiding or " +
      "moving Home sections, new Home cards, undo, reset, saving or using a named look. Pass the owner's " +
      "request in their own words. It changes the design and the phone shows it at once; then confirm in " +
      "one short line what changed (its `result`). Call it ONCE per request.",
    inputSchema: {
      type: "object",
      properties: { request: { type: "string", description: "What they want, in their words." } },
      required: ["request"],
    },
    async execute(args = {}, ctx = {}) {
      if (!ctx.userId) return { ok: false, error: "not signed in" };
      if (!String(args.request || "").trim()) return { ok: false, error: "Say what should look different." };
      return designFor(ctx.userId, args.request);
    },
  });
}

module.exports = { registerDesignTools, designFor, askModel, arrange, DESIGNER_PROMPT, DESIGN_TOOLS: ["ask_designer"] };

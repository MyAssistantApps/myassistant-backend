/**
 * THE DESIGN AGENT'S TOOLS (2026-10-31). The owner says how the app should
 * look — "make it sunset orange", "rounder cards", "put my reminders
 * first", "add a card with my water habit", "undo that" — and these edit
 * their UI spec (design/spec.js), save it on the server (design/store.js)
 * and hand the phone the result to draw at once (deviceAction
 * apply_ui_spec). Nothing here writes code; everything is validated, and
 * every change can be undone.
 */
const S = require("./spec");
const store = require("./store");

// The app's own colours (lib/design/neon_tokens.dart), so a change to ONE
// colour ("darker cards") has a whole palette to start from.
const APP_PALETTE = {
  dark: {
    name: "Default dark", dark: true, bg: "#070B2B", surface: "#0C1440", surfaceHigh: "#121B4E",
    primary: "#3D8BFF", partner: "#E04BF5", secondary: "#22E4FF", tertiary: "#BDF64B",
    textHi: "#F3F6FF", textLo: "#BAC4E3", textDim: "#8E9AC2",
  },
  light: {
    name: "Default light", dark: false, bg: "#F7F7FB", surface: "#FFFFFF", surfaceHigh: "#EEEFF6",
    primary: "#2563EB", partner: "#C026D3", secondary: "#0891B2", tertiary: "#65A30D",
    textHi: "#1B1D28", textLo: "#585E70", textDim: "#6B7185",
  },
};

const PALETTE_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string" },
    bg: { type: "string" }, surface: { type: "string" }, surfaceHigh: { type: "string" },
    primary: { type: "string" }, partner: { type: "string" },
    secondary: { type: "string" }, tertiary: { type: "string" },
    textHi: { type: "string" }, textLo: { type: "string" }, textDim: { type: "string" },
  },
  required: ["name", ...S.PALETTE_KEYS],
  additionalProperties: false,
};
const THEME_SCHEMA = {
  type: "object",
  properties: {
    palette: PALETTE_SCHEMA,
    cardStyle: { type: "string", enum: S.CARD_STYLES },
    radius: { type: "integer" },
    font: { type: "string", enum: S.FONTS },
    background: { type: "string", enum: S.BACKGROUNDS },
  },
  required: ["palette", "cardStyle", "radius", "font", "background"],
  additionalProperties: false,
};

const DESIGNER_PROMPT =
  "You design the colour scheme and feel of a mobile assistant app. Given the owner's words, return " +
  "JSON: a palette of #RRGGBB colours — bg (the page), surface (cards), surfaceHigh (chips on cards), " +
  "primary (brand: buttons, the orb, active tab) and partner (its gradient partner), secondary and " +
  "tertiary (supporting accents), textHi (headings, body), textLo (secondary lines), textDim (hints) — " +
  "plus cardStyle (glass|solid|outlined|flat), radius (0-32), font (" + S.FONTS.join("|") + ") and " +
  "background (ambient|gradient|plain). RULES: words must be easy to read — textHi at least 7:1 " +
  "against bg and surface, textLo at least 4.5:1; surface a little lighter (dark themes) or a little " +
  "darker/whiter (light themes) than bg; primary clearly visible on bg. A dark theme has a dark bg " +
  "and light text; a light theme the reverse. Make it beautiful and true to what they asked.";

/** One model call: a whole look from words. Retries with the checker's complaints. */
async function designFromWords(description, { mode = null, avoid = [] } = {}) {
  const openai = require("../services/ai/openai");
  const router = require("../services/ai/router");
  if (!openai.ready()) return { ok: false, error: "The design model is not available right now." };
  let ask = `Owner asked for: "${String(description).slice(0, 300)}".` +
    (mode ? ` It must be a ${mode} theme.` : "") +
    (avoid.length ? ` Make it clearly different from: ${avoid.join("; ")}.` : "");
  for (let attempt = 0; attempt < 3; attempt++) {
    let out;
    try {
      const r = await router.generateReply([{ role: "user", content: ask }], {
        system: DESIGNER_PROMPT, json: true, schema: THEME_SCHEMA,
        model: process.env.DESIGN_MODEL || openai.models.smart(), timeoutMs: 25_000, noRetry: true,
      });
      out = JSON.parse(r.reply || "{}");
    } catch (e) {
      return { ok: false, error: "The design model did not answer — try again in a moment." };
    }
    const look = {
      palette: out.palette,
      shape: { radius: out.radius, cardStyle: out.cardStyle },
      type: { font: out.font },
      background: out.background,
      ...(mode && mode !== "adaptive" ? { mode } : {}),
    };
    const v = S.validate(look);
    if (v.ok) return { ok: true, look, name: out.palette.name };
    ask += `\nYour last answer was rejected: ${v.errors.join("; ")}. Fix exactly that.`;
  }
  return { ok: false, error: "I could not make a readable version of that look — try describing it differently." };
}

const apply = (spec, summary, extra = {}) => ({
  ok: true,
  result: summary,
  design: S.describe(spec),
  ...extra,
  deviceAction: { type: "apply_ui_spec", spec },
});
const refused = (v) => ({ ok: false, error: `Not applied: ${v.errors.join("; ")}` });

async function saveAndApply(uid, next, note, summary) {
  const v = await store.save(uid, next, note);
  if (!v.ok) return refused(v);
  require("./cards").forget(uid);
  return apply(v.spec, summary);
}

/** A section name as the owner says it, to the spec's id. */
function sectionId(word, spec) {
  const w = String(word || "").toLowerCase().trim();
  if (S.SECTION_IDS.includes(w)) return w;
  for (const [id, label] of Object.entries(S.SECTION_LABELS)) {
    if (label.toLowerCase().includes(w) || w.includes(label.toLowerCase())) return id;
  }
  const card = (spec.customCards || []).find((c) => c.id === w.replace(/^card:/, "") || c.title.toLowerCase() === w);
  return card ? `card:${card.id}` : null;
}

const SECTION_HELP = Object.entries(S.SECTION_LABELS).map(([id, l]) => `${id} (${l})`).join(", ");

function registerDesignTools(registry) {
  const base = { risk: "low", effects: ["write:record"], deviceAction: true, timeoutMs: 60_000 };

  registry.register({
    ...base,
    name: "design_app",
    description:
      "Change how THIS app looks, any part of it, when the owner asks: colours ('make the cards darker', " +
      "'brand colour teal'), card style (glass|solid|outlined|flat) and corner radius (0-32), the font (" +
      S.FONTS.join(", ") + "), text size (scale 0.9-1.3), background (ambient|gradient|plain), dark/light, " +
      "the header title. Pass ONLY what changes. Colours are #RRGGBB; a palette change may name just the " +
      "keys that change (bg, surface, surfaceHigh, primary, partner, secondary, tertiary, textHi, textLo, " +
      "textDim). For a whole new look from words ('sunset', 'calm forest') use generate_theme instead.",
    inputSchema: {
      type: "object",
      properties: {
        palette: { type: "object", description: "Colour keys to change, e.g. {\"surface\":\"#1E1E2E\"}." },
        mode: { type: "string", enum: S.MODES },
        cardStyle: { type: "string", enum: S.CARD_STYLES },
        radius: { type: "integer", description: "Card corner radius, 0 (square) to 32 (very round)." },
        font: { type: "string", enum: S.FONTS },
        textScale: { type: "number", description: "0.9 to 1.3; 1 is normal." },
        background: { type: "string", enum: S.BACKGROUNDS },
        title: { type: "string", description: "The words at the top of Home (default MyAssistant)." },
        showDate: { type: "boolean" },
        showQuote: { type: "boolean" },
      },
    },
    async execute(args = {}, ctx = {}) {
      const uid = ctx.userId;
      if (!uid) return { ok: false, error: "not signed in" };
      const cur = await store.get(uid);
      const patch = {};
      if (args.palette && typeof args.palette === "object") {
        const dark = args.mode === "light" ? false : args.mode === "dark" ? true
          : cur.palette ? cur.palette.dark : cur.mode !== "light";
        patch.palette = { ...(cur.palette || APP_PALETTE[dark ? "dark" : "light"]), ...args.palette };
      }
      if (args.mode) patch.mode = args.mode;
      if (args.cardStyle || args.radius != null) {
        patch.shape = { ...(args.cardStyle ? { cardStyle: args.cardStyle } : {}), ...(args.radius != null ? { radius: args.radius } : {}) };
      }
      if (args.font || args.textScale != null) {
        patch.type = { ...(args.font ? { font: args.font } : {}), ...(args.textScale != null ? { scale: args.textScale } : {}) };
      }
      if (args.background) patch.background = args.background;
      if (args.title != null || args.showDate != null || args.showQuote != null) {
        patch.header = {
          ...(args.title != null ? { title: args.title } : {}),
          ...(args.showDate != null ? { showDate: args.showDate } : {}),
          ...(args.showQuote != null ? { showQuote: args.showQuote } : {}),
        };
      }
      if (!Object.keys(patch).length) return { ok: false, error: "Nothing to change — say what should look different." };
      return saveAndApply(uid, S.merge(cur, patch), "design_app", "Changed the look.");
    },
  });

  registry.register({
    ...base,
    name: "generate_theme",
    description:
      "Make a WHOLE new look for the app from the owner's words — 'make it feel like a sunset', 'calm " +
      "and green', 'black and gold, luxury', 'something cheerful'. Designs the full colour scheme, card " +
      "style, corners, font and background together, checked to stay readable, and applies it.",
    inputSchema: {
      type: "object",
      properties: {
        description: { type: "string", description: "The look in their words." },
        mode: { type: "string", enum: ["dark", "light"], description: "Only if they said dark or light." },
      },
      required: ["description"],
    },
    async execute(args = {}, ctx = {}) {
      const uid = ctx.userId;
      if (!uid) return { ok: false, error: "not signed in" };
      const made = await designFromWords(args.description, { mode: args.mode || null });
      if (!made.ok) return made;
      const cur = await store.get(uid);
      return saveAndApply(uid, S.merge(cur, made.look), `generate_theme: ${args.description}`,
        `Applied a new look, "${made.name}".`);
    },
  });

  registry.register({
    ...base,
    name: "arrange_home",
    description:
      "Arrange the Home screen: which sections show and in what order — 'put my reminders first', " +
      "'hide Born today', 'show the tips again'. Sections: " + SECTION_HELP + ", and their own custom " +
      "cards by title. `order` lists sections to go first, in that order; `hide` and `show` toggle them.",
    inputSchema: {
      type: "object",
      properties: {
        order: { type: "array", items: { type: "string" } },
        hide: { type: "array", items: { type: "string" } },
        show: { type: "array", items: { type: "string" } },
      },
    },
    async execute(args = {}, ctx = {}) {
      const uid = ctx.userId;
      if (!uid) return { ok: false, error: "not signed in" };
      const cur = await store.get(uid);
      let sections = cur.home.sections.map((s) => ({ ...s }));
      const unknown = [];
      const ids = (list) => (Array.isArray(list) ? list : []).map((w) => {
        const id = sectionId(w, cur);
        if (!id) unknown.push(w);
        return id;
      }).filter(Boolean);
      const first = ids(args.order);
      if (first.length) {
        sections = [...first.map((id) => sections.find((s) => s.id === id)).filter(Boolean),
          ...sections.filter((s) => !first.includes(s.id))];
      }
      for (const id of ids(args.hide)) sections.find((s) => s.id === id).visible = false;
      for (const id of ids(args.show)) sections.find((s) => s.id === id).visible = true;
      if (unknown.length) {
        return { ok: false, error: `I don't know these sections: ${unknown.join(", ")}. There are: ${SECTION_HELP}.` };
      }
      return saveAndApply(uid, { ...cur, home: { sections } }, "arrange_home", "Rearranged Home.");
    },
  });

  registry.register({
    ...base,
    name: "add_home_card",
    description:
      "Add a NEW card to Home that the owner describes — 'a card with my reminders today', 'a weather " +
      "card', 'a card with a button to plan my day'. Built from blocks: text {value}, list {source, " +
      "limit 1-5}, stat {source, label}, button {label, ask: what tapping it asks the assistant}. Sources " +
      "(their own data, refreshed live): " + S.SOURCES.join(", ") + ". `position`: 'top' or a section to " +
      "go after. At most 8 custom cards.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        blocks: { type: "array", items: { type: "object" } },
        accent: { type: "string", description: "Optional #RRGGBB for the card's accent." },
        position: { type: "string" },
      },
      required: ["title", "blocks"],
    },
    async execute(args = {}, ctx = {}) {
      const uid = ctx.userId;
      if (!uid) return { ok: false, error: "not signed in" };
      const cur = await store.get(uid);
      if (cur.customCards.length >= 8) return { ok: false, error: "There are already 8 custom cards — remove one first." };
      const id = `c${Date.now().toString(36)}`;
      const card = { id, title: args.title, accent: args.accent, blocks: args.blocks };
      const sections = cur.home.sections.filter((s) => s.id !== `card:${id}`);
      const after = args.position && args.position !== "top" ? sectionId(args.position, cur) : null;
      const at = args.position === "top" ? 0 : after ? sections.findIndex((s) => s.id === after) + 1 : sections.length;
      sections.splice(Math.max(0, at), 0, { id: `card:${id}`, visible: true });
      return saveAndApply(uid, { ...cur, customCards: [...cur.customCards, card], home: { sections } },
        `add_home_card: ${args.title}`, `Added the "${String(args.title).slice(0, 40)}" card to Home.`);
    },
  });

  registry.register({
    ...base,
    name: "remove_home_card",
    description: "Remove one of the owner's custom Home cards, by its title.",
    inputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
    async execute(args = {}, ctx = {}) {
      const uid = ctx.userId;
      if (!uid) return { ok: false, error: "not signed in" };
      const cur = await store.get(uid);
      const t = String(args.title || "").toLowerCase();
      const card = cur.customCards.find((c) => c.title.toLowerCase() === t)
        || cur.customCards.find((c) => c.title.toLowerCase().includes(t));
      if (!card) {
        return { ok: false, error: cur.customCards.length
          ? `No custom card called "${args.title}". There are: ${cur.customCards.map((c) => c.title).join(", ")}.`
          : "There are no custom cards on Home." };
      }
      return saveAndApply(uid, {
        ...cur,
        customCards: cur.customCards.filter((c) => c.id !== card.id),
        home: { sections: cur.home.sections.filter((s) => s.id !== `card:${card.id}`) },
      }, `remove_home_card: ${card.title}`, `Removed the "${card.title}" card.`);
    },
  });

  registry.register({
    ...base,
    name: "undo_design",
    description: "Undo the last change to how the app looks — 'undo that', 'go back', 'I liked it before'.",
    inputSchema: { type: "object", properties: {} },
    async execute(_args, ctx = {}) {
      if (!ctx.userId) return { ok: false, error: "not signed in" };
      const spec = await store.undo(ctx.userId);
      if (!spec) return { ok: false, error: "There is no earlier look to go back to." };
      require("./cards").forget(ctx.userId);
      return apply(spec, "Went back to the previous look.");
    },
  });

  registry.register({
    ...base,
    name: "reset_design",
    description: "Put the app back to its original look — 'reset the design', 'back to default'. Undoable.",
    inputSchema: { type: "object", properties: {} },
    async execute(_args, ctx = {}) {
      if (!ctx.userId) return { ok: false, error: "not signed in" };
      return apply(await store.reset(ctx.userId), "Back to the app's original look.");
    },
  });

  registry.register({
    ...base,
    effects: ["write:record"],
    deviceAction: false,
    name: "save_theme",
    description: "Save the app's current look under a name — 'save this as Office', 'keep this look as Night'.",
    inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    async execute(args = {}, ctx = {}) {
      if (!ctx.userId) return { ok: false, error: "not signed in" };
      const r = await store.saveTheme(ctx.userId, args.name, await store.get(ctx.userId));
      return r.ok ? { ok: true, result: `Saved this look as "${r.name}".` } : r;
    },
  });

  registry.register({
    ...base,
    name: "apply_theme",
    description: "Switch to a look the owner saved by name — 'use my Office look', 'switch to Night'.",
    inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    async execute(args = {}, ctx = {}) {
      if (!ctx.userId) return { ok: false, error: "not signed in" };
      const t = await store.getTheme(ctx.userId, args.name);
      if (!t) {
        const names = await store.listThemes(ctx.userId);
        return { ok: false, error: names.length ? `No saved look called "${args.name}". Saved: ${names.join(", ")}.` : "There are no saved looks yet." };
      }
      return saveAndApply(ctx.userId, t.spec, `apply_theme: ${t.name}`, `Switched to "${t.name}".`);
    },
  });

  registry.register({
    risk: "low",
    effects: ["read"],
    name: "list_themes",
    description: "The looks the owner has saved by name, and what the app looks like now.",
    inputSchema: { type: "object", properties: {} },
    async execute(_args, ctx = {}) {
      if (!ctx.userId) return { ok: false, error: "not signed in" };
      const [names, cur] = await Promise.all([store.listThemes(ctx.userId), store.get(ctx.userId)]);
      return { ok: true, saved: names, now: S.describe(cur),
        result: `${names.length ? `Saved looks: ${names.join(", ")}.` : "No saved looks yet."} Now: ${S.describe(cur)}.` };
    },
  });

  registry.register({
    ...base,
    name: "preview_designs",
    description:
      "Show the owner a few OPTIONS to choose from — 'show me some designs', 'give me three options for " +
      "a calm look'. Makes 2-3 different looks from their words and shows each on the phone for a few " +
      "seconds, then returns to the current look. They pick one with pick_preview ('the second one').",
    inputSchema: {
      type: "object",
      properties: {
        description: { type: "string" },
        count: { type: "integer", description: "2 or 3." },
      },
      required: ["description"],
    },
    async execute(args = {}, ctx = {}) {
      const uid = ctx.userId;
      if (!uid) return { ok: false, error: "not signed in" };
      const n = Math.min(3, Math.max(2, Number(args.count) || 3));
      const cur = await store.get(uid);
      const options = [];
      for (let i = 0; i < n; i++) {
        const made = await designFromWords(args.description, { avoid: options.map((o) => o.label) });
        if (made.ok) options.push({ label: made.name || `Option ${i + 1}`, spec: S.validate(S.merge(cur, made.look)).spec });
      }
      if (!options.length) return { ok: false, error: "I could not make any options just now — try again." };
      store.setPreviews(uid, options);
      return {
        ok: true,
        result: `Showing ${options.length} options: ${options.map((o, i) => `${i + 1}. ${o.label}`).join(", ")}. ` +
          "Ask which one they want; pick_preview applies it.",
        deviceAction: { type: "preview_ui_specs", seconds: 4, current: cur, options },
      };
    },
  });

  registry.register({
    ...base,
    name: "pick_preview",
    description: "Apply one of the options preview_designs just showed — 'the second one', 'keep option 1'.",
    inputSchema: { type: "object", properties: { option: { type: "integer" } }, required: ["option"] },
    async execute(args = {}, ctx = {}) {
      if (!ctx.userId) return { ok: false, error: "not signed in" };
      const p = store.getPreview(ctx.userId, Number(args.option));
      if (!p) return { ok: false, error: "Those options have expired — I can show new ones." };
      return saveAndApply(ctx.userId, p.spec, `pick_preview: ${p.label}`, `Applied "${p.label}".`);
    },
  });

  registry.register({
    risk: "low",
    effects: ["read"],
    name: "current_design",
    description: "What the app looks like now (colours, cards, font, Home layout, custom cards).",
    inputSchema: { type: "object", properties: {} },
    async execute(_args, ctx = {}) {
      if (!ctx.userId) return { ok: false, error: "not signed in" };
      const cur = await store.get(ctx.userId);
      return { ok: true, result: S.describe(cur), sections: cur.home.sections, cards: cur.customCards.map((c) => c.title) };
    },
  });
}

module.exports = { registerDesignTools, designFromWords, APP_PALETTE, DESIGN_TOOLS: [
  "design_app", "generate_theme", "arrange_home", "add_home_card", "remove_home_card", "undo_design",
  "reset_design", "save_theme", "apply_theme", "list_themes", "preview_designs", "pick_preview", "current_design",
] };

/**
 * THE UI SPEC (2026-10-31) — how ONE person's app looks, as data.
 *
 * The Design agent changes the app by editing this document, never code:
 * the phone already knows how to draw every value in it (lib/design in the
 * app). Every edit goes through validate(), so whatever the model writes,
 * what reaches the phone is readable and bounded:
 *
 *   palette   the whole colour scheme (NeonPalette in the app). Text must
 *             be readable on its ground (WCAG contrast), the brand colour
 *             visible on the page.
 *   mode      dark | light | adaptive (null = leave the app's own setting)
 *   shape     card corner radius and card style
 *   type      the font (only what the app bundles) and the text size
 *   background, header, home (section order and visibility), customCards
 *
 * null anywhere means "the app's default" — a fresh spec is exactly the
 * app as it looks today.
 */

const SECTION_IDS = ["play", "agents", "today", "born", "extras", "asks", "shortcuts", "whatsnew"];
const SECTION_LABELS = {
  play: "Play my day", agents: "Your agents", today: "Today's cards", born: "Born today",
  extras: "Tips and extra cards", asks: "Try asking", shortcuts: "Quick tools", whatsnew: "What's new",
};
const FONTS = ["Space Grotesk", "Manrope", "Roboto"];
const CARD_STYLES = ["glass", "solid", "outlined", "flat"];
const BACKGROUNDS = ["ambient", "gradient", "plain"];
const MODES = ["dark", "light", "adaptive"];
const PALETTE_KEYS = ["bg", "surface", "surfaceHigh", "primary", "partner", "secondary", "tertiary",
  "textHi", "textLo", "textDim"];
const STATUS_KEYS = ["success", "warning", "error"];
const MAX_CARDS = 8;
const MAX_BLOCKS = 8;
// What a custom card can show, resolved on the server from the user's own
// data (design/cards.js). Nothing else: no URLs to fetch, no code.
const SOURCES = ["reminders", "calendar", "shopping", "habits", "weather", "news", "brief"];
const BLOCKS = ["text", "list", "stat", "button"];

function defaults() {
  return {
    version: 1,
    mode: null,
    palette: null,
    shape: { radius: null, cardStyle: null },
    type: { font: null, scale: 1 },
    background: null,
    header: { title: "MyAssistant", showDate: true, showQuote: true },
    home: { sections: SECTION_IDS.map((id) => ({ id, visible: true })) },
    customCards: [],
  };
}

// ── colour ────────────────────────────────────────────────────────────
const HEX = /^#?([0-9a-f]{6})$/i;
function hex(v) {
  const m = HEX.exec(String(v || "").trim());
  return m ? `#${m[1].toUpperCase()}` : null;
}
function luminance(h) {
  const n = parseInt(h.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}
/** WCAG contrast ratio of two #RRGGBB colours, 1..21. */
function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

/** A palette, checked: every key a colour, words readable on the cards. */
function checkPalette(p, errors) {
  if (p == null) return null;
  if (typeof p !== "object") { errors.push("palette must be an object"); return null; }
  const out = { dark: Boolean(p.dark) };
  for (const k of PALETTE_KEYS) {
    const c = hex(p[k]);
    if (!c) { errors.push(`palette.${k} must be a colour like #1A2B3C`); continue; }
    out[k] = c;
  }
  for (const k of STATUS_KEYS) if (p[k] != null) {
    const c = hex(p[k]);
    if (c) out[k] = c;
  }
  if (errors.length) return null;
  // Readable: main words on the page and on the cards at least 4.5:1
  // (WCAG AA), secondary words 3:1, the brand colour visible on the page.
  const need = [
    ["textHi", "bg", 4.5], ["textHi", "surface", 4.5], ["textLo", "surface", 3],
    ["textLo", "bg", 3], ["primary", "bg", 2.2], ["primary", "surface", 2],
  ];
  for (const [fg, bgk, min] of need) {
    const r = contrast(out[fg], out[bgk]);
    if (r < min) errors.push(`palette.${fg} on ${bgk} is ${r.toFixed(1)}:1 — needs at least ${min}:1 to be readable`);
  }
  // dark follows the page, whatever was claimed.
  out.dark = luminance(out.bg) < 0.2;
  if (typeof p.name === "string") out.name = p.name.slice(0, 40);
  return out;
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const oneOf = (v, list) => (v == null ? null : list.find((x) => x.toLowerCase() === String(v).toLowerCase()) || undefined);

function checkCard(c, i, errors) {
  if (!c || typeof c !== "object") { errors.push(`customCards[${i}] must be an object`); return null; }
  const id = String(c.id || `card${i + 1}`).replace(/[^a-z0-9_-]/gi, "").slice(0, 24) || `card${i + 1}`;
  const title = String(c.title || "").trim().slice(0, 40);
  if (!title) errors.push(`customCards[${i}] needs a title`);
  const blocks = [];
  for (const [j, b] of (Array.isArray(c.blocks) ? c.blocks : []).slice(0, MAX_BLOCKS).entries()) {
    const type = oneOf(b && b.type, BLOCKS);
    if (!type) { errors.push(`customCards[${i}].blocks[${j}].type must be one of ${BLOCKS.join(", ")}`); continue; }
    if (type === "text") blocks.push({ type, value: String(b.value || "").slice(0, 280) });
    if (type === "button") {
      const ask = String(b.ask || "").trim().slice(0, 200);
      if (!ask) errors.push(`customCards[${i}].blocks[${j}] (button) needs "ask": what it asks the assistant`);
      blocks.push({ type, label: String(b.label || ask).slice(0, 30), ask });
    }
    if (type === "list" || type === "stat") {
      const source = oneOf(b.source, SOURCES);
      if (!source) { errors.push(`customCards[${i}].blocks[${j}].source must be one of ${SOURCES.join(", ")}`); continue; }
      blocks.push({ type, source, label: String(b.label || "").slice(0, 40), limit: clamp(Number(b.limit) || 3, 1, 5) });
    }
  }
  if (!blocks.length) errors.push(`customCards[${i}] needs at least one block`);
  return { id, title, accent: hex(c.accent) || null, blocks };
}

/**
 * The spec made safe: unknown keys dropped, values clamped, colours and
 * contrast checked. { ok, spec, errors } — on errors nothing is saved and
 * the agent is told exactly what to fix.
 */
function validate(input) {
  const errors = [];
  const d = defaults();
  const s = input && typeof input === "object" ? input : {};
  const spec = { version: 1 };

  const mode = s.mode == null ? null : oneOf(s.mode, MODES);
  if (mode === undefined) errors.push(`mode must be one of ${MODES.join(", ")}`);
  spec.mode = mode || null;

  spec.palette = checkPalette(s.palette, errors);

  const shape = s.shape || {};
  spec.shape = {
    radius: shape.radius == null ? null : clamp(Math.round(Number(shape.radius) || 0), 0, 32),
    cardStyle: shape.cardStyle == null ? null : oneOf(shape.cardStyle, CARD_STYLES) || null,
  };
  if (shape.cardStyle != null && !oneOf(shape.cardStyle, CARD_STYLES)) {
    errors.push(`shape.cardStyle must be one of ${CARD_STYLES.join(", ")}`);
  }

  const type = s.type || {};
  const font = type.font == null ? null : oneOf(type.font, FONTS);
  if (font === undefined) errors.push(`type.font must be one of ${FONTS.join(", ")} (the fonts the app carries)`);
  spec.type = { font: font || null, scale: clamp(Number(type.scale) || 1, 0.9, 1.3) };

  const bg = s.background == null ? null : oneOf(s.background, BACKGROUNDS);
  if (bg === undefined) errors.push(`background must be one of ${BACKGROUNDS.join(", ")}`);
  spec.background = bg || null;

  const h = s.header || {};
  spec.header = {
    title: String(h.title == null ? d.header.title : h.title).trim().slice(0, 24) || d.header.title,
    showDate: h.showDate !== false,
    showQuote: h.showQuote !== false,
  };

  // Every built-in section exactly once, in the order given; any left out
  // keep their place at the end, visible. Custom cards may sit anywhere.
  const cards = (Array.isArray(s.customCards) ? s.customCards : []).slice(0, MAX_CARDS)
    .map((c, i) => checkCard(c, i, errors)).filter(Boolean);
  const cardIds = new Set(cards.map((c) => `card:${c.id}`));
  const seen = new Set();
  const sections = [];
  for (const x of Array.isArray(s.home && s.home.sections) ? s.home.sections : []) {
    const id = String((x && x.id) || "");
    if ((!SECTION_IDS.includes(id) && !cardIds.has(id)) || seen.has(id)) continue;
    seen.add(id);
    sections.push({ id, visible: x.visible !== false });
  }
  for (const id of [...SECTION_IDS, ...cardIds]) if (!seen.has(id)) sections.push({ id, visible: true });
  spec.home = { sections };
  spec.customCards = cards;

  return { ok: errors.length === 0, spec, errors };
}

function hsl(h) {
  const n = parseInt(h.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => c / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const hue = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [hue / 6, s, l];
}
function fromHsl([h, s, l]) {
  const f = (p, q, t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const c = s === 0 ? [l, l, l] : [f(p, q, h + 1 / 3), f(p, q, h), f(p, q, h - 1 / 3)];
  return "#" + c.map((x) => Math.round(x * 255).toString(16).padStart(2, "0")).join("").toUpperCase();
}

/**
 * "Make it darker" / "lighter": the page, the cards and the chips moved
 * together in lightness, the hue kept. The result is still validated.
 */
function shade(palette, dir) {
  const out = { ...palette };
  for (const k of ["bg", "surface", "surfaceHigh"]) {
    const [h, s, l] = hsl(hex(palette[k]));
    out[k] = fromHsl([h, s, dir === "darker" ? l * 0.68 : l + (1 - l) * 0.3]);
  }
  return out;
}

/** a deep-merged with b (b wins; arrays replace). */
function merge(a, b) {
  if (b === undefined) return a;
  if (b === null || typeof b !== "object" || Array.isArray(b)) return b;
  const out = { ...(a && typeof a === "object" && !Array.isArray(a) ? a : {}) };
  for (const [k, v] of Object.entries(b)) out[k] = merge(out[k], v);
  return out;
}

/** One line per thing that differs from the defaults — what the agent reads back. */
function describe(spec) {
  const s = validate(spec).spec;
  const out = [];
  if (s.palette) out.push(`palette ${s.palette.name || ""} (${s.palette.dark ? "dark" : "light"}, primary ${s.palette.primary})`.replace("  ", " "));
  if (s.mode) out.push(`mode ${s.mode}`);
  if (s.shape.radius != null) out.push(`card corners ${s.shape.radius}`);
  if (s.shape.cardStyle) out.push(`cards ${s.shape.cardStyle}`);
  if (s.type.font) out.push(`font ${s.type.font}`);
  if (s.type.scale !== 1) out.push(`text size ${Math.round(s.type.scale * 100)}%`);
  if (s.background) out.push(`background ${s.background}`);
  if (s.header.title !== "MyAssistant") out.push(`title "${s.header.title}"`);
  const hidden = s.home.sections.filter((x) => !x.visible).map((x) => SECTION_LABELS[x.id] || x.id);
  if (hidden.length) out.push(`hidden: ${hidden.join(", ")}`);
  if (s.customCards.length) out.push(`custom cards: ${s.customCards.map((c) => c.title).join(", ")}`);
  return out.length ? out.join("; ") : "the app's default look";
}

module.exports = {
  defaults, validate, merge, describe, contrast, hex, shade,
  SECTION_IDS, SECTION_LABELS, FONTS, CARD_STYLES, BACKGROUNDS, MODES, PALETTE_KEYS, SOURCES, BLOCKS,
};

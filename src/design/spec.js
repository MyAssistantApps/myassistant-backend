/**
 * THE DESIGN DOCUMENT (v2, 2026-10-31) — how ONE person's app looks, as one
 * JSON document. Its shape, with a line on every field, is
 * design.schema.json; the app's own look is default-design.json.
 *
 * The Designer agent answers a request ("card text red") with a partial
 * document of the same shape; merge() folds it into the current one and
 * validate() makes sure what reaches the phone is readable and bounded.
 * Every colour is optional: absent or null is the app's own, so a change
 * names only what changes.
 *
 * v1 documents (palette/shape/type, the first Design agent) are converted
 * on the way in, so looks saved before still load.
 */
const fs = require("fs");
const path = require("path");

const SCHEMA = JSON.parse(fs.readFileSync(path.join(__dirname, "design.schema.json"), "utf8"));
const DEFAULT = JSON.parse(fs.readFileSync(path.join(__dirname, "default-design.json"), "utf8"));
/** The schema as the Designer reads it: one compact JSON line. */
const SCHEMA_TEXT = JSON.stringify(SCHEMA);

const SECTION_IDS = DEFAULT.home.sections.map((s) => s.id);
const SECTION_LABELS = {
  play: "Play my day", agents: "Your agents", today: "Today's cards", born: "Born today",
  extras: "Tips and extra cards", asks: "Try asking", shortcuts: "Quick tools", whatsnew: "What's new",
};
const FONTS = ["Space Grotesk", "Manrope", "Roboto"];
const CARD_STYLES = ["glass", "solid", "outlined", "flat"];
const BACKGROUNDS = ["ambient", "gradient", "plain"];
const MODES = ["dark", "light", "adaptive"];
const COLOR_KEYS = Object.keys(SCHEMA.colors);
const MAX_CARDS = 8;
const MAX_BLOCKS = 8;
const SOURCES = ["reminders", "calendar", "shopping", "habits", "weather", "news", "brief"];
const BLOCKS = ["text", "list", "stat", "button"];

// The app's own colours (lib/design/neon_tokens.dart), by the names above.
const APP_COLORS = {
  dark: {
    page: "#070B2B", pageText: "#F3F6FF", pageMuted: "#BAC4E3", pageFaint: "#8E9AC2",
    card: "#0C1440", cardRaised: "#121B4E", cardText: "#F3F6FF", cardMuted: "#BAC4E3",
    primary: "#3D8BFF", partner: "#E04BF5", secondary: "#22E4FF", tertiary: "#BDF64B",
  },
  light: {
    page: "#F7F7FB", pageText: "#1B1D28", pageMuted: "#585E70", pageFaint: "#6B7185",
    card: "#FFFFFF", cardRaised: "#EEEFF6", cardText: "#1B1D28", cardMuted: "#585E70",
    primary: "#2563EB", partner: "#C026D3", secondary: "#0891B2", tertiary: "#65A30D",
  },
};

const defaults = () => JSON.parse(JSON.stringify(DEFAULT));

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

/** Whether a design draws dark: by its page colour, else by its mode. */
function isDark(spec) {
  const page = spec && spec.colors && spec.colors.page;
  if (page) return luminance(page) < 0.2;
  return !(spec && spec.mode === "light");
}

/** Every colour the phone will use: theirs over the app's own. */
function effectiveColors(spec) {
  const base = APP_COLORS[isDark(spec) ? "dark" : "light"];
  const out = { ...base };
  for (const [k, v] of Object.entries((spec && spec.colors) || {})) if (v) out[k] = v;
  // Text in cards follows the page's text unless set on its own.
  if (!(spec && spec.colors && spec.colors.cardText) && spec && spec.colors && spec.colors.pageText) out.cardText = spec.colors.pageText;
  if (!(spec && spec.colors && spec.colors.cardMuted) && spec && spec.colors && spec.colors.pageMuted) out.cardMuted = spec.colors.pageMuted;
  return out;
}

// Readable pairs, checked when either colour was set on purpose.
const PAIRS = [
  ["pageText", "page", 4.5], ["pageMuted", "page", 3], ["cardText", "card", 4.5],
  ["cardMuted", "card", 3], ["primary", "page", 2], ["headerTitle", "page", 3],
];

// ── v1 → v2 ───────────────────────────────────────────────────────────
function fromV1(s) {
  if (!s || s.version === 2 || !(s.palette || s.shape || s.type || typeof s.background === "string")) return s;
  const p = s.palette || {};
  const colors = {};
  const map = { bg: "page", surface: "card", surfaceHigh: "cardRaised", textHi: "pageText", textLo: "pageMuted",
    textDim: "pageFaint", primary: "primary", partner: "partner", secondary: "secondary", tertiary: "tertiary",
    success: "success", warning: "warning", error: "error" };
  for (const [a, b] of Object.entries(map)) if (p[a]) colors[b] = p[a];
  return {
    version: 2, mode: s.mode || null, colors, name: p.name,
    background: { style: typeof s.background === "string" ? s.background : null },
    cards: { style: s.shape && s.shape.cardStyle, radius: s.shape && s.shape.radius },
    typography: { font: s.type && s.type.font, scale: s.type && s.type.scale },
    header: s.header, home: s.home, customCards: s.customCards,
  };
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
 * The document made safe: unknown keys dropped, values clamped, colours
 * and contrast checked. { ok, spec, errors } — on errors nothing is saved,
 * and the errors say exactly what to fix.
 */
function validate(input) {
  const errors = [];
  const d = defaults();
  const s = fromV1(input && typeof input === "object" ? input : {}) || {};
  const spec = { version: 2 };
  if (typeof s.name === "string" && s.name.trim()) spec.name = s.name.trim().slice(0, 40);

  const mode = s.mode == null ? null : oneOf(s.mode, MODES);
  if (mode === undefined) errors.push(`mode must be one of ${MODES.join(", ")}`);
  spec.mode = mode || null;

  spec.colors = {};
  for (const [k, v] of Object.entries(s.colors && typeof s.colors === "object" ? s.colors : {})) {
    if (!COLOR_KEYS.includes(k) || v == null || v === "") continue;
    const c = hex(v);
    if (!c) errors.push(`colors.${k} must be a colour like #1A2B3C`);
    else spec.colors[k] = c;
  }
  const eff = effectiveColors(spec);
  for (const [fg, bg, min] of PAIRS) {
    if (!(fg in spec.colors) && !(bg in spec.colors)) continue;
    if (!eff[fg] || !eff[bg]) continue;
    const r = contrast(eff[fg], eff[bg]);
    if (r < min) errors.push(`colors.${fg} ${eff[fg]} on ${bg} ${eff[bg]} is ${r.toFixed(1)}:1 — needs at least ${min}:1 to be readable`);
  }

  const bgIn = s.background && typeof s.background === "object" ? s.background : {};
  const style = bgIn.style == null ? null : oneOf(bgIn.style, BACKGROUNDS);
  if (style === undefined) errors.push(`background.style must be one of ${BACKGROUNDS.join(", ")}`);
  spec.background = { style: style || null, from: hex(bgIn.from), to: hex(bgIn.to) };
  // A gradient the eye can see (2026-10-31: #06314F → #003B66 read as one
  // colour): its two ends must differ clearly.
  if (spec.background.style === "gradient" && spec.background.from && spec.background.to &&
      contrast(spec.background.from, spec.background.to) < 1.35) {
    errors.push(`background.from ${spec.background.from} and background.to ${spec.background.to} are too alike ` +
      `(${contrast(spec.background.from, spec.background.to).toFixed(2)}:1) — a gradient needs ends that clearly differ (1.35:1 or more)`);
  }

  const cards = s.cards && typeof s.cards === "object" ? s.cards : {};
  const cs = cards.style == null ? null : oneOf(cards.style, CARD_STYLES);
  if (cs === undefined) errors.push(`cards.style must be one of ${CARD_STYLES.join(", ")}`);
  spec.cards = { style: cs || null, radius: cards.radius == null ? null : clamp(Math.round(Number(cards.radius) || 0), 0, 32) };

  const t = s.typography && typeof s.typography === "object" ? s.typography : {};
  const font = t.font == null ? null : oneOf(t.font, FONTS);
  if (font === undefined) errors.push(`typography.font must be one of ${FONTS.join(", ")} (the fonts the app carries)`);
  spec.typography = { font: font || null, scale: clamp(Number(t.scale) || 1, 0.9, 1.3) };

  const h = s.header && typeof s.header === "object" ? s.header : {};
  spec.header = {
    title: String(h.title == null ? d.header.title : h.title).trim().slice(0, 24) || d.header.title,
    showDate: h.showDate !== false,
    showQuote: h.showQuote !== false,
  };

  const custom = (Array.isArray(s.customCards) ? s.customCards : []).slice(0, MAX_CARDS)
    .map((c, i) => checkCard(c, i, errors)).filter(Boolean);
  const cardIds = new Set(custom.map((c) => `card:${c.id}`));
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
  spec.customCards = custom;
  spec.dark = isDark(spec);

  return { ok: errors.length === 0, spec, errors };
}

/** a deep-merged with b (b wins; arrays replace; null clears to the app's own). */
function merge(a, b) {
  if (b === undefined) return a;
  if (b === null || typeof b !== "object" || Array.isArray(b)) return b;
  const out = { ...(a && typeof a === "object" && !Array.isArray(a) ? a : {}) };
  for (const [k, v] of Object.entries(b)) out[k] = merge(out[k], v);
  return out;
}

// ── darker / lighter ──────────────────────────────────────────────────
function hsl(h) {
  const n = parseInt(h.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => c / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const dd = max - min;
  const sat = l > 0.5 ? dd / (2 - max - min) : dd / (max + min);
  const hue = max === r ? (g - b) / dd + (g < b ? 6 : 0) : max === g ? (b - r) / dd + 2 : (r - g) / dd + 4;
  return [hue / 6, sat, l];
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
/** The page, the cards and the chips moved together in lightness ("darker" / "lighter"). */
function shade(spec, dir) {
  const eff = effectiveColors(spec);
  const colors = {};
  for (const k of ["page", "card", "cardRaised"]) {
    const [h, s, l] = hsl(eff[k]);
    colors[k] = fromHsl([h, s, dir === "darker" ? l * 0.68 : l + (1 - l) * 0.3]);
  }
  return colors;
}

/** One line on what differs from the app's own look — read back to the owner. */
function describe(spec) {
  const s = validate(spec).spec;
  const out = [];
  const c = Object.entries(s.colors);
  if (s.name) out.push(`"${s.name}"`);
  if (c.length) out.push(`colours: ${c.map(([k, v]) => `${k} ${v}`).join(", ")}`);
  if (s.mode) out.push(`mode ${s.mode}`);
  if (s.background.style) out.push(`background ${s.background.style}`);
  if (s.cards.style) out.push(`cards ${s.cards.style}`);
  if (s.cards.radius != null) out.push(`corners ${s.cards.radius}`);
  if (s.typography.font) out.push(`font ${s.typography.font}`);
  if (s.typography.scale !== 1) out.push(`text ${Math.round(s.typography.scale * 100)}%`);
  if (s.header.title !== "MyAssistant") out.push(`title "${s.header.title}"`);
  const hidden = s.home.sections.filter((x) => !x.visible).map((x) => SECTION_LABELS[x.id] || x.id);
  if (hidden.length) out.push(`hidden: ${hidden.join(", ")}`);
  if (s.customCards.length) out.push(`cards: ${s.customCards.map((x) => x.title).join(", ")}`);
  return out.length ? out.join("; ") : "the app's original look";
}

module.exports = {
  defaults, validate, merge, describe, contrast, hex, shade, effectiveColors, isDark, fromV1,
  SCHEMA, SCHEMA_TEXT, APP_COLORS, COLOR_KEYS,
  SECTION_IDS, SECTION_LABELS, FONTS, CARD_STYLES, BACKGROUNDS, MODES, SOURCES, BLOCKS,
};

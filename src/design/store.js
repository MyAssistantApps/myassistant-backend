/**
 * Each person's UI spec, on the server (2026-10-31): the look they chose
 * survives a reinstall and follows them to a new phone.
 *
 *   ui_specs         the current spec, one row per user
 *   ui_spec_history  every earlier spec (newest 30), for "undo that"
 *   ui_themes        looks they saved by name ("save this as Office")
 *
 * Previews ("show me three options") are kept in memory for 15 minutes:
 * they only matter until the owner picks one.
 */
const { query, one, run } = require("../db");
const S = require("./spec");

const KEEP_HISTORY = 30;
const MAX_THEMES = 20;
const PREVIEW_TTL_MS = 15 * 60_000;

let migrated = null;
function migrate() {
  if (!migrated) {
    migrated = run(`
      CREATE TABLE IF NOT EXISTS ui_specs (
        user_id    INTEGER PRIMARY KEY,
        spec       JSONB   NOT NULL,
        updated_at BIGINT  NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ui_spec_history (
        id         BIGSERIAL PRIMARY KEY,
        user_id    INTEGER NOT NULL,
        spec       JSONB   NOT NULL,
        note       TEXT    NOT NULL DEFAULT '',
        created_at BIGINT  NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ui_spec_history_user ON ui_spec_history (user_id, id DESC);
      CREATE TABLE IF NOT EXISTS ui_themes (
        user_id    INTEGER NOT NULL,
        name       TEXT    NOT NULL,
        spec       JSONB   NOT NULL,
        created_at BIGINT  NOT NULL,
        PRIMARY KEY (user_id, name)
      );
    `).catch((e) => { migrated = null; throw e; });
  }
  return migrated;
}

/** The current spec (the defaults when they never changed anything). */
async function get(uid) {
  await migrate();
  const row = await one(`SELECT spec FROM ui_specs WHERE user_id = $1`, [uid]);
  return S.validate(row ? row.spec : S.defaults()).spec;
}

/**
 * Save [next] as the current spec; the one it replaces goes to history.
 * Returns { ok, spec, errors } — nothing is saved when it does not validate.
 */
async function save(uid, next, note = "") {
  const v = S.validate(next);
  if (!v.ok) return v;
  await migrate();
  const prev = await one(`SELECT spec FROM ui_specs WHERE user_id = $1`, [uid]);
  const now = Date.now();
  await run(`INSERT INTO ui_spec_history (user_id, spec, note, created_at) VALUES ($1, $2, $3, $4)`,
    [uid, JSON.stringify(prev ? prev.spec : S.defaults()), String(note).slice(0, 200), now]);
  await run(`INSERT INTO ui_specs (user_id, spec, updated_at) VALUES ($1, $2, $3)
             ON CONFLICT (user_id) DO UPDATE SET spec = EXCLUDED.spec, updated_at = EXCLUDED.updated_at`,
    [uid, JSON.stringify(v.spec), now]);
  await run(`DELETE FROM ui_spec_history WHERE user_id = $1 AND id NOT IN
               (SELECT id FROM ui_spec_history WHERE user_id = $1 ORDER BY id DESC LIMIT ${KEEP_HISTORY})`, [uid]);
  return v;
}

/** Back one step. Null when there is nothing to undo. */
async function undo(uid) {
  await migrate();
  const last = await one(`SELECT id, spec FROM ui_spec_history WHERE user_id = $1 ORDER BY id DESC LIMIT 1`, [uid]);
  if (!last) return null;
  const spec = S.validate(last.spec).spec;
  await run(`INSERT INTO ui_specs (user_id, spec, updated_at) VALUES ($1, $2, $3)
             ON CONFLICT (user_id) DO UPDATE SET spec = EXCLUDED.spec, updated_at = EXCLUDED.updated_at`,
    [uid, JSON.stringify(spec), Date.now()]);
  await run(`DELETE FROM ui_spec_history WHERE id = $1`, [last.id]);
  return spec;
}

/** The app's own look again (undoable: the old one goes to history). */
async function reset(uid) {
  return (await save(uid, S.defaults(), "reset")).spec;
}

const themeKey = (name) => String(name || "").trim().replace(/\s+/g, " ").slice(0, 40);

async function saveTheme(uid, name, spec) {
  const key = themeKey(name);
  if (!key) return { ok: false, error: "A theme needs a name." };
  await migrate();
  const n = await one(`SELECT count(*)::int AS n FROM ui_themes WHERE user_id = $1 AND lower(name) <> lower($2)`, [uid, key]);
  if (n.n >= MAX_THEMES) return { ok: false, error: `You already have ${MAX_THEMES} saved looks — remove one first.` };
  await run(`DELETE FROM ui_themes WHERE user_id = $1 AND lower(name) = lower($2)`, [uid, key]);
  await run(`INSERT INTO ui_themes (user_id, name, spec, created_at) VALUES ($1, $2, $3, $4)`,
    [uid, key, JSON.stringify(S.validate(spec).spec), Date.now()]);
  return { ok: true, name: key };
}
async function getTheme(uid, name) {
  await migrate();
  const row = await one(`SELECT name, spec FROM ui_themes WHERE user_id = $1 AND lower(name) = lower($2)`, [uid, themeKey(name)]);
  return row ? { name: row.name, spec: S.validate(row.spec).spec } : null;
}
async function listThemes(uid) {
  await migrate();
  return (await query(`SELECT name, created_at FROM ui_themes WHERE user_id = $1 ORDER BY created_at DESC`, [uid]))
    .map((r) => r.name);
}
async function deleteTheme(uid, name) {
  await migrate();
  return (await run(`DELETE FROM ui_themes WHERE user_id = $1 AND lower(name) = lower($2)`, [uid, themeKey(name)])) > 0;
}

// ── previews ──────────────────────────────────────────────────────────
const previews = new Map(); // uid -> { at, options: [{label, spec}] }
function setPreviews(uid, options) {
  previews.set(uid, { at: Date.now(), options });
}
function getPreview(uid, n) {
  const p = previews.get(uid);
  if (!p || Date.now() - p.at > PREVIEW_TTL_MS) { previews.delete(uid); return null; }
  return p.options[n - 1] || null;
}

module.exports = {
  migrate, get, save, undo, reset, saveTheme, getTheme, listThemes, deleteTheme,
  setPreviews, getPreview, KEEP_HISTORY,
};

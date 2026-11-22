/**
 * JYOTISH STORE — saved birth profiles, the prediction cache and the
 * geocoding cache. Tables are created lazily with a cached migrate().
 *
 *   jyotish_profiles     a user's saved people (max PROFILE_LIMIT)
 *   jyotish_predictions  generated readings, per user + chart + range + category + language + period
 *   jyotish_geocode      Nominatim answers by normalised query (shared; holds no user data)
 */
const { run, query, one } = require("../db");

const PROFILE_LIMIT = 20;
const PREDICTION_TTL_MS = 400 * 86_400_000; // a "this year" reading stays valid all year
const GEOCODE_TTL_MS = 90 * 86_400_000;

let migrated = null;
function migrate() {
  if (!migrated) {
    migrated = run(`
      CREATE TABLE IF NOT EXISTS jyotish_profiles (
        id          BIGSERIAL PRIMARY KEY,
        user_id     INTEGER NOT NULL,
        name        TEXT    NOT NULL,
        birth       JSONB   NOT NULL,
        created_at  BIGINT  NOT NULL,
        updated_at  BIGINT  NOT NULL
      );
      CREATE INDEX IF NOT EXISTS jyotish_profiles_user ON jyotish_profiles (user_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS jyotish_predictions (
        cache_key   TEXT    PRIMARY KEY,
        user_id     INTEGER NOT NULL,
        text        TEXT    NOT NULL,
        created_at  BIGINT  NOT NULL
      );
      CREATE INDEX IF NOT EXISTS jyotish_predictions_user ON jyotish_predictions (user_id);

      CREATE TABLE IF NOT EXISTS jyotish_geocode (
        q           TEXT    PRIMARY KEY,
        results     JSONB   NOT NULL,
        created_at  BIGINT  NOT NULL
      );
    `).catch((e) => {
      migrated = null;
      throw e;
    });
  }
  return migrated;
}

const profileOut = (r) => ({ id: Number(r.id), name: r.name, birth: r.birth, createdAt: Number(r.created_at), updatedAt: Number(r.updated_at) });

async function listProfiles(userId) {
  await migrate();
  const rows = await query(`SELECT * FROM jyotish_profiles WHERE user_id=$1 ORDER BY updated_at DESC LIMIT $2`, [userId, PROFILE_LIMIT]);
  return rows.map(profileOut);
}

/** Saves a profile; the same name (any case) updates it. Returns null when the limit is reached. */
async function saveProfile(userId, name, birth) {
  await migrate();
  const now = Date.now();
  const same = await one(`SELECT id FROM jyotish_profiles WHERE user_id=$1 AND lower(name)=lower($2)`, [userId, name]);
  if (same) {
    const r = await one(`UPDATE jyotish_profiles SET birth=$3, name=$4, updated_at=$5 WHERE id=$1 AND user_id=$2 RETURNING *`,
      [same.id, userId, JSON.stringify(birth), name, now]);
    return profileOut(r);
  }
  const count = await one(`SELECT count(*)::int AS n FROM jyotish_profiles WHERE user_id=$1`, [userId]);
  if (count.n >= PROFILE_LIMIT) return null;
  const r = await one(`INSERT INTO jyotish_profiles (user_id, name, birth, created_at, updated_at) VALUES ($1,$2,$3,$4,$4) RETURNING *`,
    [userId, name, JSON.stringify(birth), now]);
  return profileOut(r);
}

async function deleteProfile(userId, id) {
  await migrate();
  return (await run(`DELETE FROM jyotish_profiles WHERE id=$1 AND user_id=$2`, [id, userId])) > 0;
}

async function cachedPrediction(key) {
  await migrate();
  const r = await one(`SELECT text, created_at FROM jyotish_predictions WHERE cache_key=$1`, [key]);
  if (!r || Date.now() - Number(r.created_at) > PREDICTION_TTL_MS) return null;
  return r.text;
}

async function savePrediction(key, userId, text) {
  await migrate();
  await run(`INSERT INTO jyotish_predictions (cache_key, user_id, text, created_at) VALUES ($1,$2,$3,$4)
             ON CONFLICT (cache_key) DO UPDATE SET text=EXCLUDED.text, created_at=EXCLUDED.created_at`,
  [key, userId, text, Date.now()]);
}

async function cachedGeocode(q) {
  await migrate();
  const r = await one(`SELECT results, created_at FROM jyotish_geocode WHERE q=$1`, [q]);
  if (!r || Date.now() - Number(r.created_at) > GEOCODE_TTL_MS) return null;
  return r.results;
}

async function saveGeocode(q, results) {
  await migrate();
  await run(`INSERT INTO jyotish_geocode (q, results, created_at) VALUES ($1,$2,$3)
             ON CONFLICT (q) DO UPDATE SET results=EXCLUDED.results, created_at=EXCLUDED.created_at`,
  [q, JSON.stringify(results), Date.now()]);
}

const USER_TABLES = [
  ["jyotish_profiles", "user_id"],
  ["jyotish_predictions", "user_id"],
];

module.exports = {
  migrate, listProfiles, saveProfile, deleteProfile, cachedPrediction, savePrediction,
  cachedGeocode, saveGeocode, USER_TABLES, PROFILE_LIMIT,
};

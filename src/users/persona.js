/**
 * PERSONA — what the user does, picked once at registration.
 * -------------------------------------------------------------------------
 * `users.profession` is free text ("software engineer", set through
 * PUT /profile/details) and cannot gate anything. `users.persona` is
 * the canonical key the user chose on the "What do you do?" step, and it
 * decides which workspaces the app shows:
 *
 *   doctor        → Doctor's assistant + Clinic workspace
 *   advocate      → Advocate's assistant (client case files)
 *   business      → Business assistant (customer case files)
 *   professional  → client case files
 *   student       → personal assistant only
 *   personal      → personal assistant only
 *   ''            → not chosen yet; the app asks before anything else
 *
 * The gate is enforced HERE as well as in the app: a hidden screen is a
 * UX decision, a 403 is a guarantee.
 */
const { one } = require("../db");

const PERSONAS = ["doctor", "advocate", "business", "professional", "student", "personal"];
const PERSONA_SET = new Set(PERSONAS);

/** Canonical key, or null when the value is not a persona we know. */
function cleanPersona(v) {
  const k = String(v ?? "").trim().toLowerCase();
  return PERSONA_SET.has(k) ? k : null;
}

/** Personas whose work is organised around client/patient case files. */
function usesCaseFiles(persona) {
  return ["doctor", "advocate", "business", "professional"].includes(persona);
}

async function personaOf(userId) {
  const r = await one("SELECT persona FROM users WHERE id = $1", [Number(userId)]);
  return r?.persona || "";
}

/**
 * Express middleware: lets the request through only for users whose
 * persona is one of `allowed`. Mount AFTER appAuth (needs req.user.sub).
 * `lookup` is injectable so the gate can be tested without a database.
 */
function requirePersona(allowed, lookup = personaOf) {
  const ok = new Set([].concat(allowed));
  return async (req, res, next) => {
    const uid = Number(req.user?.sub);
    if (!Number.isInteger(uid) || uid <= 0) {
      return res.status(401).json({ error: "sign in required" });
    }
    try {
      const p = await lookup(uid);
      if (!ok.has(p)) {
        return res.status(403).json({
          error: "persona_required",
          required: [...ok],
          message: "This workspace is only available for the matching profile type.",
        });
      }
      req.persona = p;
      next();
    } catch (e) {
      res.status(500).json({ error: "could not verify profile" });
    }
  };
}

module.exports = { PERSONAS, cleanPersona, usesCaseFiles, personaOf, requirePersona };

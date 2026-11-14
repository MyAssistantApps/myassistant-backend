/**
 * CLINIC — the doctor's workspace API (mounted at /clinic, doctors only).
 * -------------------------------------------------------------------------
 * Built on what already existed and was only reachable by voice: patient
 * case files (clients, kind 'patient'), recalls (practice/store
 * client_recalls — the assistant phones the patient beforehand) and the
 * dues ledger (client_ledger). This adds the screens' side of it.
 *
 *   GET  /clinic/today              everything the dashboard needs, ONE call
 *   GET  /clinic/followups          pending follow-ups (overdue first)
 *   POST /clinic/followups          schedule one {clientId, dueAt, note, notifyPatient}
 *   POST /clinic/followups/:id/done mark done        (body {cancel:true} → cancelled)
 *   GET  /clinic/dues               who owes what, largest first
 *   POST /clinic/ledger             {clientId, amount, kind: due|paid, note}
 *
 * Gated twice: appAuth (signed in) + requirePersona('doctor'). "Today" is
 * the DOCTOR's today — the day window comes from the app's X-TZ-Offset,
 * not the server clock, or a 9 pm follow-up in Mumbai lands on tomorrow.
 */
const router = require("express").Router();
const { requirePersona } = require("../users/persona");
const practice = require("../practice/store");
const clients = require("../clients/store");
const reminders = require("../reminders/store");
const audit = require("../audit/log");
const { one } = require("../db");

const DAY = 24 * 3600 * 1000;

router.use(requirePersona("doctor"));

/* ---------------- pure helpers (unit-tested) ---------------- */

function tzOf(req) {
  const v = Number(req.get("X-TZ-Offset"));
  // Real offsets run −12h…+14h. Anything else is a broken header → IST.
  return Number.isFinite(v) && v >= -720 && v <= 840 ? v : 330;
}

/** [start, end) of the local calendar day containing `now`, in epoch ms. */
function dayWindow(now, tzOffsetMin) {
  const off = tzOffsetMin * 60 * 1000;
  const start = Math.floor((now + off) / DAY) * DAY - off;
  return { start, end: start + DAY };
}

function followUpShape(r) {
  return {
    id: Number(r.id),
    clientId: Number(r.client_id),
    clientName: r.client_name || "",
    clientPhone: r.client_phone || "",
    note: r.note || "",
    dueAt: Number(r.due_at),
    notifyPatient: Number(r.notify_patient) === 1,
    patientCalled: Number(r.called_at) > 0,
  };
}

/** Splits pending follow-ups around today's window. Input sorted by due_at. */
function bucketFollowUps(rows, { start, end }) {
  const out = { overdue: [], today: [], upcoming: [] };
  for (const r of rows) {
    const f = followUpShape(r);
    if (f.dueAt < start) out.overdue.push(f);
    else if (f.dueAt < end) out.today.push(f);
    else out.upcoming.push(f);
  }
  return out;
}

function dueShape(d) {
  return { clientId: Number(d.client_id), name: d.name, balance: Math.round(Number(d.balance) * 100) / 100 };
}

const uidOf = (req) => Number(req.user.sub); // requirePersona already checked it

/* ---------------- routes ---------------- */

router.get("/today", async (req, res) => {
  const uid = uidOf(req);
  try {
    const win = dayWindow(Date.now(), tzOf(req));
    // Overdue reaches back 60 days — older than that is a list nobody acts on.
    const [rows, dues, count, appts] = await Promise.all([
      practice.listRecallsDetailed(uid, { from: win.start - 60 * DAY, to: win.end + 7 * DAY, limit: 200 }),
      practice.pendingDues(uid, 50),
      one(`SELECT COUNT(*)::int AS n FROM clients WHERE user_id = $1 AND kind = 'patient' AND archived = 0`, [uid]),
      require("./store").listAppointments(uid, { from: win.start, to: win.end }),
    ]);
    const b = bucketFollowUps(rows, win);
    const d = dues.map(dueShape);
    res.json({
      dayStart: win.start,
      patients: count?.n || 0,
      followUps: b,
      dues: d.slice(0, 5),
      duesCount: d.length,
      duesTotal: Math.round(d.reduce((s, x) => s + x.balance, 0) * 100) / 100,
      appointments: appts.map(require("./store").apptShape),
    });
  } catch (e) {
    console.error("clinic/today:", e.message);
    res.status(500).json({ error: "could not load today" });
  }
});

router.get("/followups", async (req, res) => {
  const uid = uidOf(req);
  try {
    const win = dayWindow(Date.now(), tzOf(req));
    const rows = await practice.listRecallsDetailed(uid, { from: win.start - 365 * DAY, limit: 300 });
    res.json(bucketFollowUps(rows, win));
  } catch (e) {
    res.status(500).json({ error: "could not load follow-ups" });
  }
});

router.post("/followups", async (req, res) => {
  const uid = uidOf(req);
  const { clientId, dueAt, note, notifyPatient } = req.body || {};
  const due = Number(dueAt);
  if (!Number.isFinite(due) || due < Date.now() - 60_000) {
    return res.status(400).json({ error: "dueAt must be a future time (epoch ms)" });
  }
  try {
    const client = await clients.getClient(uid, clientId);
    if (!client) return res.status(404).json({ error: "patient not found" });
    const hasPhone = Boolean(String(client.phone || "").trim());
    const recall = await practice.createRecall(uid, {
      clientId: client.id, note: note || "", dueAt: due,
      notifyPatient: notifyPatient !== false && hasPhone,
    });
    // Same delivery as the voice tool: the doctor's own nudge is a normal
    // reminder (push + alarm), so there is one pipeline, not two.
    try {
      const r = await reminders.create(uid, `Follow-up: ${client.name}${note ? ` — ${note}` : ""}`, due);
      if (r) await practice.setReminderId(uid, recall.id, r.id);
    } catch (_) {}
    audit.record(uid, "clinic.followup.created", `follow-up for "${client.name}"`);
    res.json({
      followUp: followUpShape({ ...recall, client_name: client.name, client_phone: client.phone }),
      noPhone: notifyPatient !== false && !hasPhone,
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post("/followups/:id/done", async (req, res) => {
  const uid = uidOf(req);
  try {
    const row = await practice.closeRecall(uid, req.params.id, req.body?.cancel ? "cancelled" : "done");
    if (!row) return res.status(404).json({ error: "follow-up not found or already closed" });
    // The doctor's reminder for it must not ring after the patient came in.
    if (row.reminder_id) {
      try { await reminders.remove(uid, Number(row.reminder_id)); } catch (_) {}
    }
    audit.record(uid, req.body?.cancel ? "clinic.followup.cancelled" : "clinic.followup.done", `follow-up #${row.id}`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "could not update follow-up" });
  }
});

router.get("/dues", async (req, res) => {
  const uid = uidOf(req);
  try {
    const d = (await practice.pendingDues(uid, 100)).map(dueShape);
    res.json({ dues: d, total: Math.round(d.reduce((s, x) => s + x.balance, 0) * 100) / 100 });
  } catch (e) {
    res.status(500).json({ error: "could not load dues" });
  }
});

router.post("/ledger", async (req, res) => {
  const uid = uidOf(req);
  const { clientId, amount, kind, note } = req.body || {};
  try {
    const client = await clients.getClient(uid, clientId);
    if (!client) return res.status(404).json({ error: "patient not found" });
    const row = await practice.addLedger(uid, { clientId: client.id, amount, kind, note });
    if (!row) return res.status(400).json({ error: "amount must be a positive number" });
    audit.record(uid, `clinic.ledger.${row.kind}`, `${row.kind} ${row.amount} for "${client.name}"`);
    res.json({ ok: true, balance: await practice.balanceOf(uid, client.id) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/* ================================================================== */
/* PHASE 2 — clinic profile, appointment book, consult notes, Rx       */
/* ================================================================== */

const clinicStore = require("./store");
const clinicAi = require("./ai");
const { renderPrescription } = require("./rx");
const docsStore = require("../docs/store");
const multer = require("multer");

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

/** "2026-11-14" in the doctor's timezone → local midnight epoch ms. */
function dayStartOf(dateStr, tzOffsetMin, now = Date.now()) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ""));
  if (!m) return clinicStore.localMidnight(now, tzOffsetMin);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - tzOffsetMin * 60 * 1000;
}

/* ---------------- profile ---------------- */

router.get("/profile", async (req, res) => {
  try {
    res.json({ profile: await clinicStore.getProfile(uidOf(req)) });
  } catch (e) {
    res.status(500).json({ error: "could not load clinic profile" });
  }
});

router.put("/profile", async (req, res) => {
  try {
    const p = await clinicStore.saveProfile(uidOf(req), req.body || {});
    audit.record(uidOf(req), "clinic.profile.updated", "clinic profile");
    res.json({ profile: p });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/* ---------------- appointments ---------------- */

router.get("/appointments", async (req, res) => {
  const uid = uidOf(req);
  const tz = tzOf(req);
  try {
    const day = dayStartOf(req.query.date, tz);
    const rows = await clinicStore.listAppointments(uid, { from: day, to: day + DAY });
    res.json({ dayStart: day, appointments: rows.map(clinicStore.apptShape) });
  } catch (e) {
    res.status(500).json({ error: "could not load appointments" });
  }
});

router.get("/slots", async (req, res) => {
  const uid = uidOf(req);
  const tz = tzOf(req);
  try {
    const day = dayStartOf(req.query.date, tz);
    const slots = await clinicStore.slotsFor(uid, day, { tzOffsetMin: tz });
    res.json({ dayStart: day, slots });
  } catch (e) {
    res.status(500).json({ error: "could not load slots" });
  }
});

router.post("/appointments", async (req, res) => {
  const uid = uidOf(req);
  const b = req.body || {};
  try {
    let name = b.patientName;
    let phone = b.patientPhone;
    if (b.clientId) {
      const c = await clients.getClient(uid, b.clientId);
      if (!c) return res.status(404).json({ error: "patient not found" });
      name = name || c.name;
      phone = phone || c.phone;
    }
    const row = await clinicStore.createAppointment(uid, {
      clientId: b.clientId, patientName: name, patientPhone: phone,
      startsAt: b.startsAt, reason: b.reason, remindPatient: b.remindPatient,
      durationMin: b.durationMin, source: "app",
    });
    audit.record(uid, "clinic.appointment.created", `appointment for "${row.patient_name}"`);
    res.json({ appointment: clinicStore.apptShape(row) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.patch("/appointments/:id", async (req, res) => {
  const uid = uidOf(req);
  try {
    const row = await clinicStore.updateAppointment(uid, req.params.id, req.body || {});
    if (!row) return res.status(404).json({ error: "appointment not found" });
    audit.record(uid, "clinic.appointment.updated", `appointment #${row.id} → ${row.status}`);
    res.json({ appointment: clinicStore.apptShape(row) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/**
 * "I'm running 40 minutes late" — the assistant phones every patient still
 * to come today (booked, not yet arrived, starting from now on) and tells
 * them. Capped, and one call per patient: the doctor confirms the count on
 * screen before this runs.
 */
router.post("/appointments/delay", async (req, res) => {
  const uid = uidOf(req);
  const minutes = Math.round(Number(req.body?.minutes));
  if (!Number.isFinite(minutes) || minutes < 5 || minutes > 240) {
    return res.status(400).json({ error: "minutes must be between 5 and 240" });
  }
  const agentCall = require("../agents/agentCall");
  if (!agentCall.enabled()) {
    return res.status(503).json({ error: "calling is not set up on this server yet" });
  }
  try {
    const tz = tzOf(req);
    const now = Date.now();
    const day = clinicStore.localMidnight(now, tz);
    const rows = (await clinicStore.listAppointments(uid, { from: now - 10 * 60 * 1000, to: day + DAY, includeClosed: false }))
      .filter((r) => r.status === "booked" && r.patient_phone);
    const targets = rows.slice(0, 12);
    const u = await one("SELECT name FROM users WHERE id = $1", [uid]);
    const first = String(u?.name || "").split(" ")[0] || "the doctor";
    let started = 0;
    for (const r of targets) {
      const when = new Date(Number(r.starts_at)).toLocaleTimeString("en-IN", {
        hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata",
      });
      try {
        await agentCall.start({
          userId: uid, userName: first, toNumber: r.patient_phone, contactName: r.patient_name,
          task: `Tell them politely that Dr. ${first} is running about ${minutes} minutes late today, ` +
            `so their ${when} appointment will start roughly ${minutes} minutes later. ` +
            `Apologise for the wait. If they want to reschedule, say the clinic will call them back.`,
          lang: null,
        });
        started++;
      } catch (e) {
        console.error("delay call failed:", e?.message);
      }
    }
    audit.record(uid, "clinic.delay.broadcast", `${minutes} min late — ${started} patient call(s)`);
    res.json({ ok: true, called: started, skipped: rows.length - targets.length });
  } catch (e) {
    res.status(500).json({ error: "could not notify patients" });
  }
});

/* ---------------- consult notes ---------------- */

/** One audio chunk → text. The app records in chunks so a failure is visible. */
router.post("/consult/transcribe", upload.single("audio"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "audio file required" });
  if (req.body?.consent !== "true") {
    return res.status(400).json({ error: "patient consent is required to record a consultation" });
  }
  try {
    const { transcribeAudio } = require("../services/ai/router");
    // Returns { text, language } | null (null = no AI provider configured).
    const out = await transcribeAudio(req.file.buffer, req.file.mimetype);
    if (!out) return res.status(503).json({ error: "transcription is not configured on this server" });
    res.json({ text: String(out.text || "").trim(), language: out.language || "" });
  } catch (e) {
    res.status(502).json({ error: "could not transcribe that recording" });
  }
});

router.post("/consult/draft", async (req, res) => {
  const uid = uidOf(req);
  const { clientId, transcript } = req.body || {};
  try {
    let patientName = "";
    let context = "";
    if (clientId) {
      const c = await clients.getClient(uid, clientId);
      if (!c) return res.status(404).json({ error: "patient not found" });
      patientName = c.name;
      context = c.summary || "";
    }
    const { note, provider } = await clinicAi.draftConsultNote({ transcript, patientName, context });
    res.json({ note, provider, text: clinicAi.soapToText(note) });
  } catch (e) {
    res.status(422).json({ error: e.message || "could not draft the note" });
  }
});

/** The doctor approved (and maybe edited) the draft: file it in the case file. */
router.post("/consult/save", async (req, res) => {
  const uid = uidOf(req);
  const { clientId, note, text } = req.body || {};
  try {
    const c = await clients.getClient(uid, clientId);
    if (!c) return res.status(404).json({ error: "patient not found" });
    const body = String(text || "").trim() || clinicAi.soapToText(clinicAi.normalizeSoap(note || {}));
    const row = await clients.addNote(uid, c.id, `Consultation\n${body}`);
    if (!row) return res.status(400).json({ error: "the note is empty" });
    audit.record(uid, "clinic.consult.saved", `consult note for "${c.name}"`);
    res.json({ ok: true, noteId: Number(row.id) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/* ---------------- prescriptions ---------------- */

router.post("/rx/parse", async (req, res) => {
  try {
    res.json(await clinicAi.parsePrescription(req.body?.text));
  } catch (e) {
    res.status(422).json({ error: e.message || "could not read that prescription" });
  }
});

router.post("/rx", async (req, res) => {
  const uid = uidOf(req);
  const b = req.body || {};
  try {
    const c = await clients.getClient(uid, b.clientId);
    if (!c) return res.status(404).json({ error: "patient not found" });
    const meds = (Array.isArray(b.medications) ? b.medications : []).map(clinicAi.normalizeMed).filter((m) => m.name);
    const [profile, u] = await Promise.all([
      clinicStore.getProfile(uid),
      one("SELECT name, specialty FROM users WHERE id = $1", [uid]),
    ]);
    const fu = Number(b.followUpDays);
    const pdf = await renderPrescription({
      doctor: { name: u?.name || "", qualification: profile.qualification, specialty: u?.specialty || "", regNo: profile.regNo },
      clinic: { clinicName: profile.clinicName, address: profile.address, phone: profile.phone },
      patient: { name: c.name, age: String(b.age || "").slice(0, 10), sex: String(b.sex || "").slice(0, 10) },
      diagnosis: String(b.diagnosis || "").slice(0, 300),
      medications: meds,
      advice: String(b.advice || "").slice(0, 1000),
      followUpDays: Number.isInteger(fu) && fu > 0 ? fu : null,
      date: Date.now(),
      tzOffsetMin: tzOf(req),
    });
    const stamp = new Date().toISOString().slice(0, 10);
    const safe = c.name.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "_") || "patient";
    const doc = await docsStore.createDocument(uid, {
      buffer: pdf, filename: `Prescription_${safe}_${stamp}.pdf`, mime: "application/pdf",
      note: `Prescription for ${c.name}`,
    });
    const summary = meds.map(clinicAi.medLine).join("; ");
    await docsStore.setMetadata(uid, doc.id, {
      title: `Prescription — ${c.name} — ${stamp}`,
      category: "prescription",
      docDate: stamp,
      summary: summary.slice(0, 1200),
      tags: ["prescription", c.name.toLowerCase()],
      fullText: [b.diagnosis && `Diagnosis: ${b.diagnosis}`, summary, b.advice && `Advice: ${b.advice}`].filter(Boolean).join("\n"),
    });
    await clients.linkDocument(uid, doc.id, c.id);
    await clients.addNote(uid, c.id, `Prescription issued:\n${meds.map((m) => `• ${clinicAi.medLine(m)}`).join("\n") || "(no medicines)"}`);
    audit.record(uid, "clinic.rx.created", `prescription for "${c.name}" (${meds.length} item(s))`);
    const fresh = await docsStore.getDocument(uid, doc.id);
    res.json({ document: docsStore.toClient(fresh) });
  } catch (e) {
    console.error("clinic/rx:", e.message);
    res.status(400).json({ error: e.message || "could not create the prescription" });
  }
});

module.exports = router;
module.exports._test = { dayWindow, bucketFollowUps, tzOf, followUpShape, dayStartOf };

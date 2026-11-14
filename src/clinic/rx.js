/**
 * PRESCRIPTION PDF — the doctor's letterhead, one patient, one visit.
 * -------------------------------------------------------------------------
 * Rendered with pdfkit (already a dependency). Every word on the page is
 * something the doctor entered or approved on the review screen: the
 * medicines come from the doctor's own dictation (parsed, never
 * suggested), and the doctor taps "Create" after reading them.
 *
 * Layout follows the familiar Indian OPD slip: letterhead with
 * qualification and registration number (NMC requires the registration
 * number on a prescription), patient line, ℞ list, advice, follow-up,
 * signature block. Generic-name reminder is left to the doctor.
 */
const PDFDocument = require("pdfkit");

const INK = "#111827";
const MUTED = "#6B7280";
const ACCENT = "#4F46E5";
const LINE = "#E5E7EB";

function fmtDate(ms, tzOffsetMin = 330) {
  const d = new Date(ms + tzOffsetMin * 60 * 1000);
  const mo = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${d.getUTCDate()} ${mo[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/**
 * @param {object} p
 *   doctor   {name, qualification, specialty, regNo}
 *   clinic   {clinicName, address, phone}
 *   patient  {name, age, sex, phone}
 *   diagnosis, medications [{name,dose,frequency,duration,instructions}],
 *   advice, followUpDays, date (ms), tzOffsetMin
 * @returns {Promise<Buffer>}
 */
function renderPrescription(p) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A5", margin: 36, info: { Title: `Prescription — ${p.patient?.name || ""}` } });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const W = doc.page.width - 72;
    const x0 = 36;

    // ---- Letterhead
    const drName = p.doctor?.name ? (/^dr\.?\s/i.test(p.doctor.name) ? p.doctor.name : `Dr. ${p.doctor.name}`) : "Doctor";
    doc.fillColor(ACCENT).font("Helvetica-Bold").fontSize(15).text(drName, x0, 36, { width: W * 0.6 });
    const quals = [p.doctor?.qualification, p.doctor?.specialty].filter(Boolean).join(" · ");
    if (quals) doc.fillColor(INK).font("Helvetica").fontSize(8.5).text(quals, { width: W * 0.6 });
    if (p.doctor?.regNo) doc.fillColor(MUTED).fontSize(8).text(`Reg. No. ${p.doctor.regNo}`, { width: W * 0.6 });
    const leftBottom = doc.y;

    const right = [p.clinic?.clinicName, p.clinic?.address, p.clinic?.phone && `Ph: ${p.clinic.phone}`].filter(Boolean);
    doc.font("Helvetica-Bold").fontSize(9).fillColor(INK);
    let ry = 38;
    right.forEach((line, i) => {
      doc.font(i === 0 ? "Helvetica-Bold" : "Helvetica").fontSize(i === 0 ? 9.5 : 8)
        .fillColor(i === 0 ? INK : MUTED)
        .text(line, x0 + W * 0.55, ry, { width: W * 0.45, align: "right" });
      ry = doc.y + 1;
    });
    let y = Math.max(leftBottom, ry) + 8;
    doc.moveTo(x0, y).lineTo(x0 + W, y).lineWidth(1.2).strokeColor(ACCENT).stroke();
    y += 10;

    // ---- Patient line
    const pt = p.patient || {};
    const ageSex = [pt.age && `${pt.age}`, pt.sex].filter(Boolean).join(" / ");
    doc.fillColor(INK).font("Helvetica-Bold").fontSize(10)
      .text(pt.name || "Patient", x0, y, { continued: Boolean(ageSex) });
    if (ageSex) doc.font("Helvetica").fillColor(MUTED).text(`   ${ageSex}`);
    doc.font("Helvetica").fontSize(8.5).fillColor(MUTED)
      .text(`Date: ${fmtDate(p.date || Date.now(), p.tzOffsetMin)}`, x0, y, { width: W, align: "right" });
    y = doc.y + 6;

    if (p.diagnosis) {
      doc.fillColor(MUTED).font("Helvetica").fontSize(8).text("DIAGNOSIS", x0, y);
      doc.fillColor(INK).fontSize(9.5).text(p.diagnosis, { width: W });
      y = doc.y + 6;
    }

    // ---- Rx
    doc.fillColor(ACCENT).font("Helvetica-Bold").fontSize(20).text("Rx", x0, y);
    y = doc.y + 2;
    const meds = Array.isArray(p.medications) ? p.medications : [];
    meds.forEach((m, i) => {
      if (y > doc.page.height - 140) { doc.addPage(); y = 36; }
      doc.fillColor(INK).font("Helvetica-Bold").fontSize(10)
        .text(`${i + 1}. ${m.name}${m.dose ? `  ${m.dose}` : ""}`, x0 + 6, y, { width: W - 6 });
      const sub = [m.frequency, m.duration && `for ${m.duration}`, m.instructions].filter(Boolean).join("  ·  ");
      if (sub) doc.font("Helvetica").fontSize(8.8).fillColor(MUTED).text(sub, x0 + 20, doc.y + 1, { width: W - 20 });
      y = doc.y + 6;
      doc.moveTo(x0 + 6, y - 3).lineTo(x0 + W, y - 3).lineWidth(0.5).strokeColor(LINE).stroke();
    });
    if (!meds.length) {
      doc.fillColor(MUTED).font("Helvetica-Oblique").fontSize(9).text("No medicines prescribed.", x0 + 6, y);
      y = doc.y + 6;
    }

    if (p.advice) {
      y += 4;
      doc.fillColor(MUTED).font("Helvetica").fontSize(8).text("ADVICE", x0, y);
      doc.fillColor(INK).fontSize(9.5).text(p.advice, { width: W });
      y = doc.y + 4;
    }
    if (p.followUpDays) {
      doc.fillColor(INK).font("Helvetica-Bold").fontSize(9.5)
        .text(`Review after ${p.followUpDays} day${p.followUpDays === 1 ? "" : "s"}`, x0, y + 4);
      y = doc.y;
    }

    // ---- Signature
    const sy = Math.max(y + 30, doc.page.height - 96);
    doc.moveTo(x0 + W - 130, sy).lineTo(x0 + W, sy).lineWidth(0.7).strokeColor(INK).stroke();
    doc.fillColor(INK).font("Helvetica-Bold").fontSize(9).text(drName, x0 + W - 160, sy + 4, { width: 160, align: "right" });
    doc.fillColor(MUTED).font("Helvetica").fontSize(7.5)
      .text("Signature", x0 + W - 160, doc.y, { width: 160, align: "right" });

    doc.end();
  });
}

module.exports = { renderPrescription, fmtDate };

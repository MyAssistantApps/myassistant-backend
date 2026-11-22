/**
 * PRO PDFs — invoices / quotes (business, advocates' fee bills) and drafted
 * legal documents (advocates), on the professional's own letterhead.
 * Rendered with pdfkit, like clinic/rx.js. Every word is something the
 * user entered or approved on screen.
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

/** ₹1,25,000.50 — Indian grouping (pdfkit's Helvetica has no ₹, so "Rs."). */
function money(rupees) {
  const neg = rupees < 0;
  const [w, f] = Math.abs(rupees).toFixed(2).split(".");
  let s = w;
  if (s.length > 3) {
    const last3 = s.slice(-3);
    let rest = s.slice(0, -3);
    const parts = [];
    while (rest.length > 2) { parts.unshift(rest.slice(-2)); rest = rest.slice(0, -2); }
    if (rest) parts.unshift(rest);
    s = `${parts.join(",")},${last3}`;
  }
  return `${neg ? "-" : ""}Rs. ${s}${f === "00" ? "" : `.${f}`}`;
}

function collect(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
}

/** Letterhead: the person / firm on the left, contact details on the right. */
function letterhead(doc, { name, subtitle, regLine, org, address, phone }) {
  const x0 = doc.page.margins.left;
  const W = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  doc.fillColor(ACCENT).font("Helvetica-Bold").fontSize(16).text(name || "", x0, doc.page.margins.top, { width: W * 0.58 });
  if (subtitle) doc.fillColor(INK).font("Helvetica").fontSize(9).text(subtitle, { width: W * 0.58 });
  if (regLine) doc.fillColor(MUTED).fontSize(8.5).text(regLine, { width: W * 0.58 });
  const leftBottom = doc.y;
  let ry = doc.page.margins.top + 2;
  [org, address, phone && `Ph: ${phone}`].filter(Boolean).forEach((line, i) => {
    doc.font(i === 0 ? "Helvetica-Bold" : "Helvetica").fontSize(i === 0 ? 10 : 8.5)
      .fillColor(i === 0 ? INK : MUTED)
      .text(line, x0 + W * 0.55, ry, { width: W * 0.45, align: "right" });
    ry = doc.y + 1;
  });
  const y = Math.max(leftBottom, ry) + 8;
  doc.moveTo(x0, y).lineTo(x0 + W, y).lineWidth(1.2).strokeColor(ACCENT).stroke();
  return y + 12;
}

/**
 * @param p { kind: 'invoice'|'quote', number, date, dueAt, seller:{name,subtitle,
 *   regLine, org, address, phone}, buyer:{name, phone}, items:[{description,qty,rate,amount}],
 *   subtotal, gstRate, gst, total, notes, paymentUrl, tzOffsetMin }
 */
function renderInvoice(p) {
  const doc = new PDFDocument({ size: "A4", margin: 44, info: { Title: `${p.kind === "quote" ? "Quotation" : "Invoice"} ${p.number}` } });
  const out = collect(doc);
  const x0 = 44;
  const W = doc.page.width - 88;
  let y = letterhead(doc, p.seller || {});

  doc.fillColor(INK).font("Helvetica-Bold").fontSize(18)
    .text(p.kind === "quote" ? "QUOTATION" : "INVOICE", x0, y);
  doc.font("Helvetica").fontSize(9.5).fillColor(MUTED)
    .text(`No. ${p.number}`, x0, y + 2, { width: W, align: "right" })
    .text(`Date: ${fmtDate(p.date || Date.now(), p.tzOffsetMin)}`, { width: W, align: "right" });
  if (p.dueAt) doc.text(`${p.kind === "quote" ? "Valid till" : "Due"}: ${fmtDate(p.dueAt, p.tzOffsetMin)}`, { width: W, align: "right" });
  y = Math.max(doc.y, y + 26) + 10;

  doc.fillColor(MUTED).fontSize(8.5).text(p.kind === "quote" ? "PREPARED FOR" : "BILLED TO", x0, y);
  doc.fillColor(INK).font("Helvetica-Bold").fontSize(11).text(p.buyer?.name || "—");
  if (p.buyer?.phone) doc.font("Helvetica").fontSize(9).fillColor(MUTED).text(p.buyer.phone);
  y = doc.y + 14;

  // Table header
  const cols = { d: x0, q: x0 + W * 0.58, r: x0 + W * 0.7, a: x0 + W * 0.84 };
  doc.rect(x0, y, W, 20).fill("#F3F4F6");
  doc.fillColor(INK).font("Helvetica-Bold").fontSize(9)
    .text("Description", cols.d + 6, y + 6)
    .text("Qty", cols.q, y + 6, { width: W * 0.1, align: "right" })
    .text("Rate", cols.r, y + 6, { width: W * 0.13, align: "right" })
    .text("Amount", cols.a, y + 6, { width: W * 0.16 - 6, align: "right" });
  y += 26;
  doc.font("Helvetica").fontSize(9.5);
  for (const it of p.items || []) {
    if (y > doc.page.height - 160) { doc.addPage(); y = 44; }
    const h = Math.max(doc.heightOfString(it.description, { width: W * 0.56 }), 12);
    doc.fillColor(INK).text(it.description, cols.d + 6, y, { width: W * 0.56 })
      .text(String(it.qty), cols.q, y, { width: W * 0.1, align: "right" })
      .text(money(it.rate), cols.r, y, { width: W * 0.13, align: "right" })
      .text(money(it.amount), cols.a, y, { width: W * 0.16 - 6, align: "right" });
    y += h + 8;
    doc.moveTo(x0, y - 4).lineTo(x0 + W, y - 4).lineWidth(0.5).strokeColor(LINE).stroke();
  }

  y += 6;
  const row = (label, value, bold = false) => {
    doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(bold ? 11 : 9.5).fillColor(bold ? INK : MUTED)
      .text(label, x0 + W * 0.55, y, { width: W * 0.25, align: "right" })
      .fillColor(INK).text(value, cols.a, y, { width: W * 0.16 - 6, align: "right" });
    y = doc.y + 4;
  };
  row("Subtotal", money(p.subtotal));
  if (p.gstRate > 0) row(`GST @ ${p.gstRate}%`, money(p.gst));
  row("Total", money(p.total), true);

  if (p.notes) {
    y += 10;
    doc.fillColor(MUTED).font("Helvetica").fontSize(8.5).text("NOTES", x0, y);
    doc.fillColor(INK).fontSize(9.5).text(p.notes, { width: W });
    y = doc.y;
  }
  if (p.paymentUrl && p.kind !== "quote") {
    y += 12;
    doc.fillColor(ACCENT).font("Helvetica-Bold").fontSize(10).text("Pay online: ", x0, y, { continued: true })
      .font("Helvetica").fillColor(INK).text(p.paymentUrl, { link: p.paymentUrl, underline: true });
  }
  doc.end();
  return out;
}

/**
 * A drafted legal document on the advocate's letterhead.
 * @param p { title, body (paragraphs separated by blank lines), advocate:{name,
 *   subtitle, regLine, org, address, phone}, date, tzOffsetMin }
 */
function renderDocument(p) {
  const doc = new PDFDocument({ size: "A4", margin: 56, info: { Title: p.title || "Document" } });
  const out = collect(doc);
  const x0 = 56;
  const W = doc.page.width - 112;
  let y = letterhead(doc, p.advocate || {});
  doc.font("Helvetica").fontSize(9.5).fillColor(MUTED)
    .text(`Date: ${fmtDate(p.date || Date.now(), p.tzOffsetMin)}`, x0, y, { width: W, align: "right" });
  y = doc.y + 10;
  doc.fillColor(INK).font("Helvetica-Bold").fontSize(13)
    .text(String(p.title || "").toUpperCase(), x0, y, { width: W, align: "center" });
  doc.moveDown(0.8);
  doc.font("Times-Roman").fontSize(11.5).fillColor(INK);
  for (const para of String(p.body || "").split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean)) {
    doc.text(para, { width: W, align: "justify", lineGap: 2 });
    doc.moveDown(0.6);
  }
  // Signature
  doc.moveDown(2);
  const sy = Math.min(doc.y, doc.page.height - 110);
  doc.moveTo(x0 + W - 160, sy).lineTo(x0 + W, sy).lineWidth(0.7).strokeColor(INK).stroke();
  doc.font("Helvetica-Bold").fontSize(10).text(p.advocate?.name || "", x0 + W - 200, sy + 4, { width: 200, align: "right" });
  if (p.advocate?.regLine) doc.font("Helvetica").fontSize(8.5).fillColor(MUTED).text(p.advocate.regLine, x0 + W - 200, doc.y, { width: 200, align: "right" });
  doc.end();
  return out;
}

module.exports = { renderInvoice, renderDocument, money, fmtDate };

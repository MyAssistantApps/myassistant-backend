/**
 * WHAT THE SELLERS ANSWERED, MADE SIMPLE (2026-11-04). on_search replies
 * arrive one per seller app, each with providers (stores) and their items
 * in ONDC's catalog shape; the app needs a flat, small list.
 */

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

function firstImage(d) {
  const i = d?.images || d?.symbol ? [d?.symbol, ...(d?.images || [])] : [];
  const u = i.find((x) => typeof x === "string" && /^https?:\/\//.test(x));
  return u || null;
}

/** All stores and items from a list of on_search callbacks. */
function flatten(rows) {
  const stores = [];
  for (const row of rows) {
    const body = row.payload || row;
    const ctx = body.context || {};
    const providers = body.message?.catalog?.["bpp/providers"] || [];
    const bppName = body.message?.catalog?.["bpp/descriptor"]?.name || null;
    for (const p of providers) {
      const items = (p.items || []).map((it) => ({
        id: String(it.id),
        name: it.descriptor?.name || "",
        description: it.descriptor?.short_desc || "",
        image: firstImage(it.descriptor),
        price: num(it.price?.value),
        mrp: num(it.price?.maximum_value),
        currency: it.price?.currency || "INR",
        unit: [it.quantity?.unitized?.measure?.value, it.quantity?.unitized?.measure?.unit]
          .filter(Boolean).join(" "),
        available: num(it.quantity?.available?.count),
        categoryId: it.category_id || null,
        locationId: it.location_id || null,
        fulfillmentId: it.fulfillment_id || null,
      })).filter((i) => i.name && i.price != null);
      if (!items.length) continue;
      const loc = (p.locations || [])[0] || {};
      stores.push({
        bppId: ctx.bpp_id,
        bppUri: ctx.bpp_uri,
        sellerApp: bppName,
        providerId: String(p.id),
        name: p.descriptor?.name || "Store",
        image: firstImage(p.descriptor),
        locality: loc.address?.locality || loc.address?.city || loc.address?.street || "",
        locationId: loc.id || null,
        items,
      });
    }
  }
  return stores;
}

/** The latest on_select quote, simplified. */
function quote(row) {
  const o = row?.payload?.message?.order || {};
  const q = o.quote || {};
  return {
    total: num(q.price?.value),
    currency: q.price?.currency || "INR",
    breakup: (q.breakup || []).map((b) => ({
      title: b.title,
      type: b["@ondc/org/title_type"] || null,
      itemId: b["@ondc/org/item_id"] || null,
      quantity: num(b["@ondc/org/item_quantity"]?.count),
      price: num(b.price?.value),
    })),
    fulfillments: (o.fulfillments || []).map((f) => ({
      id: f.id,
      type: f.type || null,
      tat: f["@ondc/org/TAT"] || null,
      category: f["@ondc/org/category"] || null,
      serviceable: f.state?.descriptor?.code !== "Non-serviceable",
    })),
    error: row?.payload?.error?.message || null,
  };
}

module.exports = { flatten, quote };

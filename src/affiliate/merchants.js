/**
 * EVERYDAY SERVICES (owner, 2026-11-04: "apps we use daily, where we as a
 * company can earn commission"). The app's Misc page lists these; every
 * open goes through GET /go/:id, which adds OUR tracking:
 *
 *   program "amazon"   — Amazon Associates: ?tag=AMAZON_ASSOCIATE_TAG
 *   program "network"  — an affiliate network (Cuelinks) wraps the link:
 *                        CUELINKS_CID. Covers most Indian brands below.
 *   program "partner"  — earns only with a business partnership (Porter,
 *                        Urban Company…): opened plainly until one exists.
 *
 * Only these ids can be opened — /go is not an open redirect.
 */
const MERCHANTS = [
  { home: "Daily needs", id: "pharmeasy", name: "PharmEasy", category: "Medicines", url: "https://pharmeasy.in/", program: "network", color: "#10847E", pkg: "com.phonegap.rxpal" },
  // Food & groceries — the apps everyone already uses (client, 2026-11-05)
  { id: "swiggy", name: "Swiggy", category: "Food & groceries", url: "https://www.swiggy.com/", program: "partner", color: "#FC8019", home: true, pkg: "in.swiggy.android" },
  { id: "zomato", name: "Zomato", category: "Food & groceries", url: "https://www.zomato.com/", program: "partner", color: "#E23744", home: true, pkg: "com.application.zomato" },
  { id: "blinkit", name: "Blinkit", category: "Food & groceries", url: "https://blinkit.com/", program: "partner", color: "#F8CB46", home: true, pkg: "com.grofers.customerapp" },
  // Ownly — Rapido's zero-commission food delivery (2026-11-13). Opens the
  // installed app (pkg); with no website of its own, its Play Store page
  // otherwise.
  { id: "ownly", name: "Ownly", category: "Food & groceries", url: "https://play.google.com/store/apps/details?id=com.ownly.customer", program: "partner", color: "#E8336F", home: true, pkg: "com.ownly.customer" },
  { id: "zepto", name: "Zepto", category: "Food & groceries", url: "https://www.zeptonow.com/", program: "partner", color: "#7B2BF9", home: true, pkg: "com.zeptoconsumerapp" },
  { id: "bigbasket", name: "BigBasket", category: "Food & groceries", url: "https://www.bigbasket.com/", program: "network", color: "#84C225", home: true, pkg: "com.bigbasket.mobileapp" },
  // Rides — taxis, autos, bikes and goods (client, 2026-11-05)
  { id: "uber", name: "Uber", category: "Rides", url: "https://m.uber.com/", program: "partner", color: "#000000", home: true, pkg: "com.ubercab" },
  { id: "ola", name: "Ola", category: "Rides", url: "https://book.olacabs.com/", program: "partner", color: "#1C1C1C", home: true, pkg: "com.olacabs.customer" },
  { id: "rapido", name: "Rapido", category: "Rides", url: "https://www.rapido.bike/", program: "partner", color: "#F9C933", home: true, pkg: "com.rapido.passenger" },
  { id: "nammayatri", name: "Namma Yatri", category: "Rides", url: "https://nammayatri.in/", program: "partner", color: "#2E2E2E", home: true, pkg: "in.juspay.nammayatri" },
  // Fashion
  { id: "myntra", name: "Myntra", category: "Fashion", url: "https://www.myntra.com/", program: "network", color: "#FF3F6C", pkg: "com.myntra.android" },
  { id: "ajio", name: "AJIO", category: "Fashion", url: "https://www.ajio.com/", program: "network", color: "#2C4152", pkg: "com.ril.ajio" },
  { id: "nykaafashion", name: "Nykaa Fashion", category: "Fashion", url: "https://www.nykaafashion.com/", program: "network", color: "#E80071", pkg: "com.fsn.nds" },
  { id: "tatacliq", name: "Tata CLiQ", category: "Fashion", url: "https://www.tatacliq.com/", program: "network", color: "#DA1C5C", pkg: "com.tul.tatacliq" },
  { id: "amazonfashion", name: "Amazon Fashion", category: "Fashion", url: "https://www.amazon.in/amazonfashion", program: "amazon", color: "#232F3E", pkg: "in.amazon.mShop.android.shopping" },
  // Beauty
  { id: "nykaa", name: "Nykaa", category: "Beauty", url: "https://www.nykaa.com/", program: "network", color: "#FC2779", pkg: "com.fsn.nykaa" },
  { id: "purplle", name: "Purplle", category: "Beauty", url: "https://www.purplle.com/", program: "network", color: "#7A2E8E", pkg: "com.manash.purplle" },
  { id: "mamaearth", name: "Mamaearth", category: "Beauty", url: "https://mamaearth.in/", program: "network", color: "#00AEEF", pkg: "com.mamaearthapp" },
  // Electronics & shopping
  { id: "amazon", name: "Amazon", category: "Shopping", url: "https://www.amazon.in/", program: "amazon", color: "#FF9900", pkg: "in.amazon.mShop.android.shopping" },
  { id: "flipkart", name: "Flipkart", category: "Shopping", url: "https://www.flipkart.com/", program: "network", color: "#2874F0", pkg: "com.flipkart.android" },
  { id: "croma", name: "Croma", category: "Shopping", url: "https://www.croma.com/", program: "network", color: "#0F8B8D" },
  { id: "reliancedigital", name: "Reliance Digital", category: "Shopping", url: "https://www.reliancedigital.in/", program: "network", color: "#E42529", pkg: "in.digital.reliance" },
  // Moving & delivery
  { home: "Daily needs", id: "porter", name: "Porter", category: "Moving & delivery", url: "https://porter.in/", program: "partner", color: "#1E4FD8", pkg: "com.theporter.android.customerapp" },
  { id: "shiprocket", name: "Shiprocket", category: "Moving & delivery", url: "https://www.shiprocket.in/", program: "partner", color: "#7347EF", pkg: "com.shiprocket.shiprocket" },
  { home: "Daily needs", id: "urbancompany", name: "Urban Company", category: "Home services", url: "https://www.urbancompany.com/", program: "partner", color: "#111111", pkg: "com.urbanclap.urbanclap" },
  // EV charging (2026-11-13): Zeon's public charging network.
  { home: "Daily needs", id: "zeon", name: "Zeon", category: "EV charging", url: "https://zeoncharging.com/", program: "partner", color: "#E31E24", pkg: "com.namp.zeon" },
  // Health
  { home: "Daily needs", id: "tata1mg", name: "Tata 1mg", category: "Medicines", url: "https://www.1mg.com/", program: "network", color: "#FF6F61", pkg: "com.aranoah.healthkart.plus" },
  { home: "Daily needs", id: "apollo247", name: "Apollo 24|7", category: "Medicines", url: "https://www.apollo247.com/", program: "network", color: "#02475B", pkg: "com.apollo.patientapp" },
  { id: "netmeds", name: "Netmeds", category: "Medicines", url: "https://www.netmeds.com/", program: "network", color: "#32AEB1", pkg: "com.NetmedsMarketplace.Netmeds" },
  // Travel & stays
  { id: "makemytrip", name: "MakeMyTrip", category: "Travel & stays", url: "https://www.makemytrip.com/", program: "network", color: "#E73C33", pkg: "com.makemytrip" },
  { id: "goibibo", name: "Goibibo", category: "Travel & stays", url: "https://www.goibibo.com/", program: "network", color: "#EC5B24", pkg: "com.goibibo" },
  { id: "booking", name: "Booking.com", category: "Travel & stays", url: "https://www.booking.com/", program: "network", color: "#003580", pkg: "com.booking" },
  { id: "agoda", name: "Agoda", category: "Travel & stays", url: "https://www.agoda.com/", program: "network", color: "#5392F9", pkg: "com.agoda.mobile.consumer" },
  // Entertainment
  { id: "bookmyshow", name: "BookMyShow", category: "Movies & events", url: "https://in.bookmyshow.com/", program: "network", color: "#F84464", pkg: "com.bt.bms" },
  // Insurance
  { id: "policybazaar", name: "Policybazaar", category: "Insurance", url: "https://www.policybazaar.com/", program: "network", color: "#0065FF", pkg: "com.policybazaar" },
  { id: "acko", name: "ACKO", category: "Insurance", url: "https://www.acko.com/", program: "network", color: "#582CDB", pkg: "com.acko.android" },
  // Gifts
  { id: "fnp", name: "Ferns N Petals", category: "Gifts", url: "https://www.fnp.com/", program: "network", color: "#7D8035", pkg: "com.Clairvoyant.FernsAndPetals" },
  { id: "igp", name: "IGP", category: "Gifts", url: "https://www.igp.com/", program: "network", color: "#E23744", pkg: "com.igp.android" },
];

const BY_ID = new Map(MERCHANTS.map((m) => [m.id, m]));

/**
 * A deep link inside the partner's own site (a hotel search with dates),
 * or null: only the same host as the partner's url is ever allowed.
 */
function deepLink(m, target) {
  try {
    const u = new URL(String(target || ""));
    const host = new URL(m.url).hostname.replace(/^www\./, "");
    if (u.protocol !== "https:") return null;
    if (u.hostname.replace(/^www\./, "") !== host && !u.hostname.endsWith("." + host)) return null;
    return u.toString();
  } catch (_) {
    return null;
  }
}

/** The tracked link for [m], and whether we earn on it right now. */
function trackedUrl(m, target) {
  const dest = deepLink(m, target) || m.url;
  m = { ...m, url: dest };
  if (m.program === "amazon" && process.env.AMAZON_ASSOCIATE_TAG) {
    const u = new URL(m.url);
    u.searchParams.set("tag", process.env.AMAZON_ASSOCIATE_TAG);
    return { url: u.toString(), tracked: true };
  }
  if ((m.program === "network" || m.program === "amazon") && process.env.CUELINKS_CID) {
    const u = new URL("https://linksredirect.com/");
    u.searchParams.set("cid", process.env.CUELINKS_CID);
    u.searchParams.set("source", "linkkit");
    u.searchParams.set("url", m.url);
    return { url: u.toString(), tracked: true };
  }
  return { url: m.url, tracked: false };
}

/** The list the app shows (no tracking ids in it). */
function catalogue() {
  // home: true → on Home under its own category; a string → on Home under
  // that group instead ("Daily needs", client 2026-11-05). pkg: the Android
  // app the phone opens first when it is installed (2026-11-13).
  return MERCHANTS.map(({ id, name, category, color, program, home, pkg }) => ({
    id, name, category, color, earns: trackedUrl(BY_ID.get(id)).tracked, program,
    home: Boolean(home), homeGroup: typeof home === "string" ? home : (home ? category : null),
    ...(pkg ? { pkg } : {}),
  }));
}

module.exports = { MERCHANTS, BY_ID, trackedUrl, catalogue, deepLink };

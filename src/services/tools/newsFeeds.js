/**
 * NEWS WITH PICTURES, WITHOUT A NEWS KEY (owner, 2026-11-01: "why this
 * news are not appearing?" — the News page showed bare headlines on a
 * gradient: production has no BRAVE_SEARCH_API_KEY, and the fallback was
 * Google News RSS, which carries no picture, summary or time).
 *
 * Newspapers' own RSS feeds do carry them. These were checked from the
 * VPS on 2026-11-01 (status 200, every item with a picture): BBC, NDTV
 * and Times of India. The Hindu and Indian Express answer 403 there.
 *
 * feed(topic) -> stories in tools/news.js's shape, newest first, the same
 * story from two papers kept once; null for a topic with no feeds here
 * (a free-text search stays on Google News).
 */
const TIMEOUT_MS = 6000;
const TTL_MS = 10 * 60_000;

const F = {
  ndtvTop: ["NDTV", "https://feeds.feedburner.com/ndtvnews-top-stories"],
  ndtvIndia: ["NDTV", "https://feeds.feedburner.com/ndtvnews-india-news"],
  ndtvWorld: ["NDTV", "https://feeds.feedburner.com/ndtvnews-world-news"],
  ndtvSports: ["NDTV Sports", "https://feeds.feedburner.com/ndtvsports-latest"],
  gadgets360: ["Gadgets 360", "https://feeds.feedburner.com/gadgets360-latest"],
  toiTop: ["Times of India", "https://timesofindia.indiatimes.com/rssfeedstopstories.cms"],
  toiIndia: ["Times of India", "https://timesofindia.indiatimes.com/rssfeeds/-2128936835.cms"],
  toiWorld: ["Times of India", "https://timesofindia.indiatimes.com/rssfeeds/296589292.cms"],
  toiBusiness: ["Times of India", "https://timesofindia.indiatimes.com/rssfeeds/1898055.cms"],
  toiTech: ["Times of India", "https://timesofindia.indiatimes.com/rssfeeds/66949542.cms"],
  toiSports: ["Times of India", "https://timesofindia.indiatimes.com/rssfeeds/4719148.cms"],
  toiEnt: ["Times of India", "https://timesofindia.indiatimes.com/rssfeeds/1081479906.cms"],
  toiScience: ["Times of India", "https://timesofindia.indiatimes.com/rssfeeds/-2128672765.cms"],
  toiHealth: ["Times of India", "https://timesofindia.indiatimes.com/rssfeeds/3908999.cms"],
  bbcWorld: ["BBC", "https://feeds.bbci.co.uk/news/world/rss.xml"],
  bbcBusiness: ["BBC", "https://feeds.bbci.co.uk/news/business/rss.xml"],
  bbcTech: ["BBC", "https://feeds.bbci.co.uk/news/technology/rss.xml"],
  bbcSport: ["BBC Sport", "https://feeds.bbci.co.uk/sport/rss.xml"],
  bbcEnt: ["BBC", "https://feeds.bbci.co.uk/news/entertainment_and_arts/rss.xml"],
  bbcScience: ["BBC", "https://feeds.bbci.co.uk/news/science_and_environment/rss.xml"],
  bbcHealth: ["BBC", "https://feeds.bbci.co.uk/news/health/rss.xml"],
};

/** The News screen's tabs (lib/screens/news_screen.dart) and their papers. */
const TOPICS = {
  top: [F.ndtvTop, F.toiTop, F.bbcWorld],
  india: [F.ndtvIndia, F.toiIndia],
  world: [F.bbcWorld, F.ndtvWorld, F.toiWorld],
  business: [F.toiBusiness, F.bbcBusiness],
  tech: [F.gadgets360, F.toiTech, F.bbcTech],
  sports: [F.ndtvSports, F.toiSports, F.bbcSport],
  entertainment: [F.toiEnt, F.bbcEnt],
  science: [F.bbcScience, F.toiScience],
  health: [F.bbcHealth, F.toiHealth],
};
const ALIAS = { "": "top", today: "top", sport: "sports", technology: "tech", entertainment: "entertainment" };

const cache = new Map(); // url -> { at, items }

function decode(s) {
  return String(s || "")
    .replace(/<!\[CDATA\[|\]\]>/g, "")
    .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (m, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, " ");
}

const tag = (block, name) => {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, "i").exec(block);
  return m ? decode(m[1]).trim() : "";
};

/** A story's picture: media:content / media:thumbnail / enclosure / an <img> in the summary. */
function pictureOf(block) {
  const pick = [
    /<media:content[^>]+url="([^"]+)"/i,
    /<media:thumbnail[^>]+url="([^"]+)"/i,
    /<enclosure[^>]+url="([^"]+)"[^>]*type="image/i,
    /<enclosure[^>]+url="([^"]+)"/i,
    /<img[^>]+src=["']([^"']+)["']/i,
    /&lt;img[^&]+src=(?:&quot;|")([^&"]+)/i,
  ];
  for (const rx of pick) {
    const m = rx.exec(block);
    if (m && /^https:\/\//.test(m[1])) {
      // BBC's thumbnails are 240 px wide; the same picture comes at 976.
      return decode(m[1]).replace(/\/(ace\/standard|news)\/240\//, "/$1/976/");
    }
  }
  return "";
}

const plain = (html) => decode(String(html || "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

function ageOf(at, now = Date.now()) {
  if (!Number.isFinite(at)) return { age: "", ageMins: null };
  const mins = Math.max(0, Math.round((now - at) / 60_000));
  const age = mins < 60 ? `${Math.max(1, mins)} min ago`
    : mins < 48 * 60 ? `${Math.round(mins / 60)} hours ago`
      : `${Math.round(mins / 1440)} days ago`;
  return { age, ageMins: mins };
}

/** One feed's stories, from the cache when fresh. */
async function read([source, url]) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.items;
  const r = await fetch(url, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { "user-agent": "Mozilla/5.0 (MyAssistant news)" },
  });
  if (!r.ok) throw new Error(`${source} ${r.status}`);
  const xml = await r.text();
  const items = [];
  for (const m of xml.matchAll(/<item[\s>]([\s\S]*?)<\/item>/gi)) {
    const block = m[1];
    const title = plain(tag(block, "title"));
    const link = tag(block, "link") || tag(block, "guid");
    if (!title || !/^https?:\/\//.test(link)) continue;
    const at = Date.parse(tag(block, "pubDate"));
    let snippet = plain(tag(block, "description"));
    if (snippet.toLowerCase() === title.toLowerCase()) snippet = "";
    items.push({
      title, url: link, source,
      publishedAt: Number.isFinite(at) ? at : null,
      snippet: snippet.length > 280 ? snippet.slice(0, 277).replace(/\s+\S*$/, "") + "…" : snippet,
      image: pictureOf(block),
    });
  }
  cache.set(url, { at: Date.now(), items });
  return items;
}

const key = (t) => String(t).toLowerCase().replace(/[^a-z0-9 ]/g, "").split(" ").filter((w) => w.length > 3).slice(0, 6).join(" ");

/** Stories for a News tab, or null when the topic is not a tab. */
async function feed(topic, { count = 12, now = Date.now(), storyId = (u) => u } = {}) {
  const t = String(topic || "").trim().toLowerCase();
  const list = TOPICS[ALIAS[t] !== undefined ? ALIAS[t] : t];
  if (!list) return null;
  const got = await Promise.allSettled(list.map(read));
  const seen = new Set();
  const out = [];
  // Newest first across the papers; a picture-less story only fills in.
  const all = got.flatMap((g) => (g.status === "fulfilled" ? g.value : []))
    .sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0));
  for (const s of [...all.filter((s) => s.image), ...all.filter((s) => !s.image)]) {
    const k = key(s.title);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    const { age, ageMins } = ageOf(s.publishedAt, now);
    out.push({
      id: storyId(s.url), title: s.title, url: s.url, source: s.source,
      age, ageMins, publishedAt: s.publishedAt ? new Date(s.publishedAt).toISOString() : null,
      snippet: s.snippet, extra: [], image: s.image, thumbnail: s.image, favicon: "",
    });
    if (out.length >= count) break;
  }
  return out;
}

module.exports = { feed, TOPICS, pictureOf, read, ageOf };

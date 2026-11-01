/**
 * News from the papers' own feeds (services/tools/newsFeeds.js), offline:
 * a stubbed fetch serves sample BBC and TOI items. Run: npm run test:papers
 */
process.env.NODE_ENV = process.env.NODE_ENV || "test";
const assert = require("assert");
const f = require("../src/services/tools/newsFeeds");

const now = Date.parse("2026-11-01T12:00:00Z");
const bbc = `<rss><channel><title>BBC</title>
<item><title><![CDATA[Shops looted in protest]]></title><description><![CDATA[Protests across Germany turned violent.]]></description>
<link>https://www.bbc.co.uk/news/articles/a1</link><pubDate>Sat, 01 Nov 2026 11:30:00 GMT</pubDate>
<media:thumbnail width="240" height="135" url="https://ichef.bbci.co.uk/ace/standard/240/cpsprodpb/x.jpg"/></item>
<item><title>Same story, other paper</title><link>https://www.bbc.co.uk/news/articles/a2</link><pubDate>Sat, 01 Nov 2026 09:00:00 GMT</pubDate></item>
</channel></rss>`;
const toi = `<rss><channel>
<item><title>IGL sees 93% drop in profit</title><description>&lt;a href="x"&gt;&lt;img border="0" src="https://static.toiimg.com/photo/1.cms" /&gt;&lt;/a&gt;Profit fell sharply &amp; shares slid.</description>
<link>https://timesofindia.indiatimes.com/b/1.cms</link><pubDate>Sat, 01 Nov 2026 11:50:00 +0000</pubDate>
<enclosure type="image/jpeg" url="https://static.toiimg.com/photo/msid-1.cms"/></item>
<item><title>Shops looted in protest!</title><link>https://timesofindia.indiatimes.com/w/2.cms</link><pubDate>Sat, 01 Nov 2026 11:00:00 +0000</pubDate></item>
</channel></rss>`;
globalThis.fetch = async (url) => new Response(/bbc/.test(url) ? bbc : toi, { status: 200 });

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
}

(async () => {
  await test("a tab gets stories with pictures, summaries and times, newest first", async () => {
    const items = await f.feed("business", { now });
    assert.strictEqual(items[0].title, "IGL sees 93% drop in profit");
    assert.strictEqual(items[0].image, "https://static.toiimg.com/photo/msid-1.cms");
    assert.strictEqual(items[0].snippet, "Profit fell sharply & shares slid.", "no HTML in the summary");
    assert.strictEqual(items[0].age, "10 min ago");
    assert.strictEqual(items[0].source, "Times of India");
  });
  await test("BBC's 240 px thumbnail is asked for at 976", async () => {
    const items = await f.feed("world", { now });
    const s = items.find((x) => x.source === "BBC" && x.image);
    assert.match(s.image, /\/ace\/standard\/976\//);
  });
  await test("the same story from two papers is kept once", async () => {
    const items = await f.feed("world", { now });
    assert.strictEqual(items.filter((x) => /shops looted/i.test(x.title)).length, 1);
  });
  await test("the screen's tabs all have papers; a free-text topic does not", async () => {
    for (const t of ["", "top", "india", "world", "business", "tech", "sports", "entertainment", "science", "health"]) {
      assert.ok(Array.isArray(await f.feed(t, { now })), t || "(top)");
    }
    assert.strictEqual(await f.feed("israel election", { now }), null);
  });
  console.log(`news-papers: ${passed} passed`);
})();

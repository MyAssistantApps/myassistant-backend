/**
 * Price compare photos (src/pricecompare/photos.js): Bing's results page
 * becomes its own resized https thumbnails, nothing else; a name is looked
 * up once and kept; a failed search is an empty answer, not an error.
 * No network: the search is replaced.
 */
const assert = require("assert");
const { parseBing, photosFor, _cache } = require("../src/pricecompare/photos");

const page = [
  'm={&quot;murl&quot;:&quot;https://store.example/a.jpg&quot;,&quot;turl&quot;:&quot;https://ts3.mm.bing.net/th?id=OIP.aaa&amp;pid=15.1&quot;}',
  'm={&quot;turl&quot;:&quot;https://ts3.mm.bing.net/th?id=OIP.aaa&amp;pid=15.1&quot;}', // the same photo again
  'm={&quot;turl&quot;:&quot;http://ts3.mm.bing.net/th?id=OIP.http&quot;}', // not https
  'm={&quot;turl&quot;:&quot;https://evil.example/th?id=OIP.evil&quot;}', // not bing's host
  'm={&quot;turl&quot;:&quot;https://tse2.mm.bing.net/th?id=OIP.bbb&quot;}',
].join("\n");

(async () => {
  assert.deepStrictEqual(parseBing(page, 4), [
    "https://tse1.mm.bing.net/th?id=OIP.aaa&w=600&h=600&c=7",
    "https://tse1.mm.bing.net/th?id=OIP.bbb&w=600&h=600&c=7",
  ]);
  assert.deepStrictEqual(parseBing(page, 1).length, 1);
  assert.deepStrictEqual(parseBing("", 4), []);

  _cache.clear();
  let calls = 0;
  const search = async () => { calls++; return ["https://tse1.mm.bing.net/th?id=1", "https://tse1.mm.bing.net/th?id=2"]; };
  assert.deepStrictEqual(await photosFor("boAt  Airdopes 141", 1, { search }), ["https://tse1.mm.bing.net/th?id=1"]);
  assert.deepStrictEqual(await photosFor("BOAT AIRDOPES 141", 4, { search }), ["https://tse1.mm.bing.net/th?id=1", "https://tse1.mm.bing.net/th?id=2"]);
  assert.strictEqual(calls, 1, "one look-up per name");

  assert.deepStrictEqual(await photosFor("x", 4, { search }), [], "too short to search");
  assert.deepStrictEqual(await photosFor("broken search", 4, { search: async () => { throw new Error("down"); } }), []);

  console.log("price photos: all passed");
})().catch((e) => { console.error(e); process.exit(1); });

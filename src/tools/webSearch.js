/**
 * WEB SEARCH — provider adapter.
 *
 * §28: no fake implementations. If no provider is configured this returns
 * an honest failure the agent reports as "I can't search the web yet",
 * rather than inventing results. Adding a key switches it on with no other
 * code change.
 *
 * Supported, in order (see providerChain):
 *   OPENAI_API_KEY            OpenAI web search (reads the pages, writes the answer)
 *   (always last) Wikipedia — keyless.
 */
const TIMEOUT_MS = 8000;

/**
 * Providers to try IN ORDER: OpenAI web search when its key is set, then
 * Wikipedia — which needs no key and no quota, so search can never be
 * dead. One provider failing (429, outage, no results) falls through to
 * the next instead of failing the user's turn.
 */
function providerChain() {
  const chain = [];
  // OpenAI's own search (2026-10-02): it reads the pages and writes the
  // answer.
  if (require("../services/ai/openai").ready()) chain.push("openai");
  chain.push("wikipedia");
  return chain;
}

/**
 * The shape of a question, ignoring the decorations a model bolts on:
 * stop words, dates and numbers. "flights from Noida to Bangalore
 * tomorrow" and "flights from Noida to Bangalore tomorrow time and price
 * 2026-09-12" share one shape, and should share one search.
 */
const FP_STOP = new Set(
  ("the a an of for from to in on at and or with what when how much many " +
   "is are was were do does did please tell me my i you it this that today " +
   "tomorrow now current currently latest time times price prices cost").split(" ")
);
function fingerprint(q) {
  return [
    ...new Set(
      String(q).toLowerCase()
        .replace(/\d{4}-\d{2}-\d{2}/g, " ")
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .split(/\s+/)
        .filter((w) => w.length >= 3 && !FP_STOP.has(w))
    ),
  ].sort().join(" ");
}

/** Kept for callers/diagnostics that ask "what will be used first". */
function provider() {
  return providerChain()[0] || null;
}

// Successful searches are cached briefly: the same question asked twice in
// a conversation ("who is the PM of India?" ×3 in one minute, observed)
// must not burn a second unit of the tiny free-tier quota.
/**
 * Questions whose answer changes by the day or the hour. An encyclopedia
 * article is never an answer to one of these.
 */
const LIVE_QUESTION =
  /\b(today|tonight|tomorrow|now|current|currently|latest|live|price|prices|rate|rates|cost|fare|fares|flight|flights|weather|forecast|news|score|scores|open|closing|stock|share|gold|petrol|diesel|exchange|traffic|timing|timings|schedule|available|availability)\b/i;

const searchCache = require("./searchCache");

const RESULT_TTL = 10 * 60_000;
const resultCache = new Map(); // normalized query -> { ts, out }

async function run(query, ctx = {}) {
  const chain = providerChain();
  const q = String(query || "").trim().slice(0, 300);
  if (!q) return { ok: false, error: "empty query" };

  // SPECIALISTS FIRST. Weather and exchange rates have keyless sources
  // that are better than a grounded search for their own questions — a
  // forecast from the meteorological service beats a model's summary of a
  // weather page — and answering them here leaves the tiny search quota
  // for the questions that genuinely need a search engine.
  const specialist = await require("./liveFacts").tryLiveFact(q, ctx);
  if (specialist) return specialist;

  const cacheKey = q.toLowerCase();
  const hit = resultCache.get(cacheKey);
  if (hit && Date.now() - hit.ts < RESULT_TTL) return hit.out;
  const isLive = LIVE_QUESTION.test(q);

  // NEAR-DUPLICATES COUNT AS THE SAME QUESTION. One turn asking about
  // flights ran two searches — "flights from Noida to Bangalore tomorrow"
  // and the same thing with "time and price 2026-09-12" bolted on — which
  // spends two of a very small daily allowance to answer one question,
  // and the second, over-specific one is usually the worse of the two.
  // THE SHAPE MUST CARRY isLive, because the RESULTS depend on it.
  // fingerprint() deliberately strips "price", "today", "latest" and the
  // rest as noise — which are the very words LIVE_QUESTION keys on. So
  // "best laptops 2026" and "best laptops 2026 price" reduce to ONE shape
  // while being searched differently (one day-restricted, one not) and
  // cached with different TTLs. Whichever landed first was served to the
  // other, under the wrong freshness and for the wrong length of time.
  const shape = fingerprint(q) + (isLive ? " \u2022live" : "");
  for (const [, v] of resultCache) {
    if (v.shape === shape && Date.now() - v.ts < RESULT_TTL) return v.out;
  }

  // THE SHARED STORE. Memory above is this process's own; this is every
  // user's. One person asking for today's headlines answers it for the
  // next person, and it survives a deploy — which the in-memory cache
  // never did. Live questions keep 20 minutes, settled facts a day.
  const shared = await searchCache.get(shape);
  if (shared) {
    resultCache.set(cacheKey, { ts: Date.now(), out: shared, shape });
    return shared;
  }

  let results = [];
  let lastError = "";
  let used = "";
  let blocked = false; // any provider refused us, not merely found nothing
  for (const p of chain) {
    try {
      const r = await BACKENDS[p](q);
      if (r && r.length) {
        results = r;
        used = p;
        break;
      }
      lastError = `${p}: no results`;
    } catch (e) {
      lastError = `${p}: ${String(e.message).slice(0, 120)}`;
      // REMEMBER AN OUTAGE ACROSS THE WHOLE CHAIN. lastError only holds
      // the final provider's message, and the chain ends on Wikipedia —
      // so a quota exhaustion two providers earlier was reported as
      // "wikipedia: no results", i.e. as an absence rather than an
      // outage.
      if (/rate.?limit|429|quota|exhaust|timeout|ECONN/i.test(e.message || "")) {
        blocked = true;
      }
      console.warn(`web search ${lastError} — trying next provider`);
    }
  }
  if (!results.length) {
    // "I COULD NOT LOOK" IS NOT "IT DOES NOT EXIST".
    //
    // When the live search is unavailable (quota, outage), the chain
    // falls to Wikipedia, which has nothing for a local
    // business or a named professional. The model saw a bare "search
    // failed" and told the user "I'm not finding any wine shops near the
    // bus stand" — which reads as the shop not existing, about a shop
    // that has been there thirty years. The distinction has to reach the
    // model or it will keep reporting an outage as an absence.
    const unavailable =
      blocked || /rate.?limit|429|quota|no provider|timeout|ECONN/i.test(lastError);
    return {
      ok: false,
      error: unavailable
        ? "the web search is temporarily unavailable (rate limit), so nothing could be looked up"
        : `search failed (${lastError || "no results"})`,
      note: unavailable
        ? "SAY YOU COULD NOT SEARCH, not that nothing was found. The search " +
          "did not run — reporting 'I couldn't find any' about a place that " +
          "may well exist is wrong and the user can tell. Say the search is " +
          "unavailable for a moment, and offer to open a map or the site " +
          "instead. Do NOT answer the question from your own memory as " +
          "though you had looked it up."
        : undefined,
    };
  }

  // A LIVE QUESTION DESERVES A REAL ANSWER OR A STRAIGHT NO.
  //
  // When every real provider is spent, the chain lands on Wikipedia — and
  // "gold rate today India" comes back as the Reserve Bank of India's
  // article. That is not an answer to a question about today, and handing
  // it over as one is how the assistant ended up telling a user to go and
  // check IndiGo themselves. If the question is plainly about something
  // that CHANGES and all we have is an encyclopedia, say so.
  if (used === "wikipedia" && LIVE_QUESTION.test(q)) {
    return {
      ok: false,
      error: "search_unavailable",
      data: {
        query: q,
        hint:
          "Live web search is unavailable right now (the provider's quota is " +
          "spent), and an encyclopedia cannot answer a question about prices, " +
          "times, rates, weather or news TODAY. Say in ONE short line that " +
          "you cannot look that up at the moment, and offer to open the page " +
          "on their phone. Do NOT guess the figure, do NOT answer from " +
          "memory as though it were current, and do NOT tell them to go and " +
          "search for it themselves.",
      },
    };
  }
  try {
    // AN ENCYCLOPEDIA IS NOT A WEB SEARCH, and the model has to be told.
    // Asked for flight times and prices, the Wikipedia fallback returned
    // five Delhi Metro articles; handed over as plain numbered results
    // they read as a failed search, and the reply told the user to go
    // check IndiGo themselves. Naming the fallback lets the answer be
    // "I can't get live prices" instead of a shrug dressed as research.
    const fallback = used === "wikipedia";
    const out = {
      provider: used,
      ok: true,
      data: results,
      // Compact digest for the model to summarise from.
      speak: used === "openai"
        ? results[0].snippet
        : results
            .slice(0, 5)
            .map((r, i) => `${i + 1}. ${r.title} — ${r.snippet}`)
            .join("\n"),
      ...(fallback
        ? {
            note:
              "THESE ARE WIKIPEDIA ARTICLES, not live web results — the web " +
              "search providers were unavailable, so this is the last-resort " +
              "encyclopedia. They will NOT contain prices, timetables, " +
              "availability or anything else that changes. If that is what " +
              "was asked for, say in ONE line that you cannot get live " +
              "prices or times right now, and offer to open the site for " +
              "them. Never tell them to go and look it up themselves, and " +
              "never present these articles as an answer to a live question.",
          }
        : {}),
    };
    // "What are the flight timings from Mangalore to Bangalore" (the
    // owner, 2026-10-01): three searches, pages whose snippets carried no
    // times, and the assistant offered Google. When the question wants
    // figures and the snippets have none, read the top pages and hand
    // over the lines that carry times and prices. SEARCH_DEEP_READ=off
    // switches it off.
    if (!fallback && process.env.SEARCH_DEEP_READ !== "off") {
      const pt = require("./pageText");
      const kind = pt.figureKind(q);
      if (used !== "openai" && pt.wantsFigures(q) && !pt.hasFigures(results, kind)) {
        const pages = await deepRead(results, { kind });
        if (pages.length) {
          out.data = { results, pages };
          out.speak += "\n" + pages.map((p) => `From ${p.site}: ${p.lines.join(" | ")}`).join("\n");
          out.note =
            "The figures the question asked for are in `pages` (read from the top results). " +
            "Answer from them in your own words — the specific times or prices, with the site " +
            "they came from. Do NOT offer to open a website for a question; only if they want " +
            "to book or buy.";
        } else {
          out.note =
            "No page carried the exact figures. Say plainly what you found (which airlines, " +
            "how long, typical times) and that the exact timetable was not in reach — do NOT " +
            "offer to open Google; offer open_webpage only if they want to book.";
        }
      }
    }
    resultCache.set(cacheKey, { ts: Date.now(), out, shape });
    if (resultCache.size > 200) {
      resultCache.delete(resultCache.keys().next().value);
    }
    // Write-through, fire and forget: a cache write must never delay or
    // fail the answer the user is waiting for.
    searchCache.put(shape, q, out, isLive).catch(() => {});
    return out;
  } catch (e) {
    return { ok: false, error: `search failed: ${String(e.message).slice(0, 300)}` };
  }
}

const BACKENDS = {
  /**
   * OPENAI — the first provider since 2026-10-02: one call searches, reads
   * the pages and writes the answer with its sources, so the brain gets
   * the figures themselves (a flight time, today's rate) instead of six
   * snippets to guess from. The answer is the first result, marked
   * `answer: true`; the sources follow it as plain results.
   */
  async openai(q) {
    const openai = require("../services/ai/openai");
    const r = await openai.webSearch(q, { location: { country: process.env.SEARCH_COUNTRY || "IN" } });
    if (!r.text) return [];
    return [
      { title: "Answer from a live web search (just now)", snippet: r.text.slice(0, 4000), url: r.sources[0] ? r.sources[0].url : "", answer: true },
      ...r.sources.map((src) => ({ title: src.title, snippet: "", url: src.url })),
    ];
  },
  /**
   * WIKIPEDIA — keyless, unmetered, never blocked. The last resort under
   * every quota so search is never fully dead: testers hit "my search
   * tool is still acting up" for a whole session when the only provider
   * ran out of its daily quota. Encyclopedic
   * only, and the results say so, so the model never presents this as a
   * live web search.
   */
  async wikipedia(q) {
    const r = await fetch(
      "https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=5&srsearch=" +
        encodeURIComponent(q),
      { signal: AbortSignal.timeout(TIMEOUT_MS) }
    );
    if (!r.ok) throw new Error(`wikipedia ${r.status}`);
    const j = await r.json();
    return (j.query?.search || []).map((x) => ({
      title: `${x.title} (Wikipedia)`,
      snippet: String(x.snippet || "").replace(/<[^>]*>/g, "").replace(/&quot;/g, '"'),
      url: "https://en.wikipedia.org/wiki/" + encodeURIComponent(String(x.title).replace(/ /g, "_")),
    }));
  },
};

/**
 * The lines with figures from the top two result pages, read through
 * safeFetch (model-visible URLs must not reach this server's own network).
 * [{ site, url, lines }] — pages that fail, time out, or carry no figure
 * are left out.
 */
async function deepRead(results, { max = 5, keep = 2, timeoutMs = 8000, kind } = {}) {
  const pt = require("./pageText");
  const { safeFetch } = require("../services/safeFetch");
  const picks = (results || []).filter((r) => /^https?:\/\//i.test(r.url || "")).slice(0, max);
  const pages = await Promise.all(picks.map(async (r) => {
    try {
      const resp = await safeFetch(r.url, { headers: { "user-agent": "MyAssistant/1.0 (+https://hariassistant.tech)", accept: "text/html" } }, { timeoutMs });
      if (!resp.ok) return null;
      const type = String(resp.headers.get("content-type") || "");
      if (!/text\/html|application\/xhtml/i.test(type)) return null;
      const html = (await resp.text()).slice(0, 600_000);
      const lines = pt.figureLines(pt.extractReadableText(html), 1200, kind);
      if (!lines.length) return null;
      let site = r.url;
      try { site = new URL(r.url).hostname.replace(/^www\./, ""); } catch (_) { /* keep */ }
      return { site, url: r.url, lines };
    } catch (_) {
      return null;
    }
  }));
  // The big booking sites render their timetables in the browser, so the
  // first results often carry nothing; the fifth (trip.com, cleartrip)
  // does. All are read at once; the first two with figures are kept.
  return pages.filter(Boolean).slice(0, keep);
}

module.exports = { run, provider, deepRead };

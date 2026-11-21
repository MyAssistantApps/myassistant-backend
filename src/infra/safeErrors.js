/**
 * ─────────────────────────────────────────────────────────────────────────
 *  NO INTERNALS IN ERROR RESPONSES (2026-11-15, security hardening).
 *
 *  Some forty routes answer `{ error: e.message }`. For a validation error
 *  that is the intended, user-facing sentence. But when the exception came
 *  from a provider or the database, e.message carried the provider's own
 *  response body ("openai /chat/completions 401: {... sk-...abcd, org-…}"),
 *  SQL ("relation \"x\" does not exist"), a network error or a file path —
 *  information an attacker uses to map the system and that OWASP A09/A05
 *  says never leaves the server.
 *
 *  Rather than rewrite every route (and lose the deliberate messages), this
 *  middleware wraps res.json once: for an error status whose `error` string
 *  LOOKS like an internal leak, the client gets a generic sentence and the
 *  original goes to the server log with the request id. Everything else
 *  passes through untouched.
 *
 *  The admin panel's own API (/admin-panel/api, behind ADMIN_KEY) is left
 *  alone: its operator needs the real reason.
 * ─────────────────────────────────────────────────────────────────────────
 */

const LEAKS = [
  /\bsk-[A-Za-z0-9_*.-]{3,}/, // an API key or its masked tail
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/i,
  /incorrect api key|invalid[_ ]api[_ ]key|api key provided/i,
  /\b(?:openai|gemini|bolna|plivo|razorpay|serpapi)\s+\/?[\w/.-]*\s*\d{3}\s*:/i, // "openai /path 401: …"
  /\{\s*"error"\s*:/, // a provider's raw JSON body
  /\b(?:org|proj)-[A-Za-z0-9]{8,}/, // OpenAI organisation / project ids
  /relation "[^"]*" does not exist|column "[^"]*"|syntax error at or near|violates (?:unique|foreign key|not-null|check) constraint|duplicate key value|invalid input syntax for/i,
  /\bat\s+\S+\s+\(?[\w/\\.:-]+\.js:\d+:\d+\)?/, // a stack frame
  /\b(?:ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EHOSTUNREACH)\b|fetch failed/i,
  /(?:\/app\/|\/opt\/myassistant|node_modules|[A-Z]:\\)[\w/\\.-]*/, // server paths
  /\bDATABASE_URL\b|\bJWT_SECRET\b|_API_KEY\b|_SECRET\b|_TOKEN\b/,
];

function looksInternal(msg) {
  if (typeof msg !== "string" || !msg) return false;
  return LEAKS.some((re) => re.test(msg));
}

function generic(status) {
  if (status === 402) return "The daily usage limit has been reached. Please try again tomorrow.";
  if (status >= 500) return "An unexpected error has occurred. Please try again shortly.";
  return "The request could not be processed. Please try again.";
}

function middleware({ exempt = [/^\/admin-panel\/api\//] } = {}) {
  return (req, res, next) => {
    if (exempt.some((re) => re.test(req.originalUrl || req.url || ""))) return next();
    const json = res.json.bind(res);
    res.json = (body) => {
      try {
        if (res.statusCode >= 400 && body && typeof body === "object" && !Array.isArray(body)) {
          for (const field of ["error", "message", "detail", "details"]) {
            if (looksInternal(body[field])) {
              console.warn(`[safe-errors] ${req.requestId || "-"} ${req.method} ${req.path} ${res.statusCode} ` +
                `(${field} withheld): ${String(body[field]).slice(0, 500)}`);
              body = { ...body, [field]: field === "error" ? generic(res.statusCode) : undefined };
            }
          }
        }
      } catch (_) { /* never break a response over this */ }
      return json(body);
    };
    next();
  };
}

module.exports = { middleware, looksInternal, generic };

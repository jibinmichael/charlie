// lib/http-guards.mjs — the server's security headers and its CORS rule, as Express middleware. Kept here, not
// inline in server/charlie-remote.ts, so a test can run them.
//
// CORS. The workspace API (/agents, /outreach) answers a browser only from the origins listed in
// HIRE_APP_ORIGINS. Unset = no origin, so the browser refuses the call (fail closed). Every other route keeps the open
// CORS the landing page's public /pool-* stats need.

/** Security headers on every reply. */
export function securityHeaders() {
  return (_req, res, next) => {
    res.header("X-Content-Type-Options", "nosniff");
    res.header("X-Frame-Options", "DENY");
    res.header("Referrer-Policy", "no-referrer");
    res.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    next();
  };
}

const HIRE_API = /^\/(agents|outreach)\//;

/** The origins a browser may call the hiring API from: comma-separated, trailing slash ignored. */
export function hireOriginsOf(value) {
  return new Set(String(value || "").split(",").map((s) => s.trim().replace(/\/$/, "")).filter(Boolean));
}

/** CORS for every route, strict on the hiring API. */
export function cors({ hireOrigins }) {
  return (req, res, next) => {
    const origin = String(req.headers.origin || "");
    if (HIRE_API.test(req.path)) {
      res.header("Vary", "Origin");
      if (origin && hireOrigins.has(origin)) res.header("Access-Control-Allow-Origin", origin);
    } else res.header("Access-Control-Allow-Origin", origin || "*");
    res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  };
}

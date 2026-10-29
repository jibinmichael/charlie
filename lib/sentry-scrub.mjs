// lib/sentry-scrub.mjs — strip PII from Sentry events before they leave the process.
//
// Charlie logs user emails all over (e.g. "[match] user@x.com: ...") and its URLs carry HMAC tokens,
// so anything we send to Sentry must be scrubbed. Used as the `beforeSend` (and breadcrumb) hook in
// every Sentry.init across both runtimes. Fail-safe: if scrubbing throws, we DROP the event rather
// than risk sending unscrubbed PII.

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
// token-ish query params we never want in Sentry (HMAC download/unsub/mcp tokens)
const TOKEN_QS_RE = /([?&](?:token|t|e|sig|key)=)[^&#\s]+/gi;

/** Redact emails + token query-params from a string. */
export function redactString(s) {
  if (typeof s !== "string") return s;
  return s.replace(EMAIL_RE, "[email]").replace(TOKEN_QS_RE, "$1[redacted]");
}

/** Deep-redact a value in place (strings scrubbed, objects/arrays walked). */
function walk(v, seen) {
  if (typeof v === "string") return redactString(v);
  if (!v || typeof v !== "object") return v;
  if (seen.has(v)) return v;
  seen.add(v);
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) v[i] = walk(v[i], seen);
  } else {
    for (const k of Object.keys(v)) v[k] = walk(v[k], seen);
  }
  return v;
}

/**
 * Sentry `beforeSend` hook: drop user identity and deep-redact emails/tokens from the event.
 * Returns the scrubbed event, or null to drop it if scrubbing fails (fail-closed on PII).
 * @param {any} event
 * @returns {any}
 */
export function scrubEvent(event) {
  if (!event) return event;
  try {
    if (event.user) delete event.user; // never send email / username / ip_address
    return walk(event, new WeakSet());
  } catch {
    return null; // rather send nothing than leak PII
  }
}

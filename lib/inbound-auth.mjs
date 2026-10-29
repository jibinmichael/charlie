// lib/inbound-auth.mjs — may an unverified POST to /inbound be processed?
//
// `/inbound` is the one door into Charlie, and the handler REPLIES to whatever address the payload
// names. So an accepted-but-unverified POST is not a read: it makes the server send mail to an
// attacker-chosen recipient, over the sending domain. There is no recovering a burned sending
// reputation.
//
// The rule this file exists to enforce: a MISSING secret must reject, never accept.
//
// An expression like `secrets.length === 0 || secrets.some(verify)` means "if no signing secret is
// configured, accept everything": safe by configuration, not by construction. Deleting or
// misspelling one env var would silently turn the server into an open relay while every log stays
// green. Here it fails closed instead: no secret means no signature can ever be verified, so nothing
// is processed. Downtime is recoverable; a wrong email in a real inbox is not.

/**
 * Is this inbound POST authenticated?
 *
 * @param {string[]} secrets configured signing secrets (already filtered for empties).
 * @param {(secret: string) => boolean} verify checks the request against ONE secret.
 * @returns {boolean} true only when a configured secret positively verifies the request.
 */
export function inboundSigOk(secrets, verify) {
  // Defensive on both inputs: a caller that hands us a non-array or a non-function is a bug, and
  // the fail-closed answer to "am I sure?" is no.
  if (!Array.isArray(secrets) || secrets.length === 0) return false;
  if (typeof verify !== "function") return false;
  return secrets.some((s) => typeof s === "string" && s.length > 0 && verify(s) === true);
}

/**
 * Is the server missing every inbound signing secret? Used at boot to refuse to start, so the
 * failure is a loud crash-loop instead of a quietly-open relay.
 *
 * @param {string[]} secrets configured signing secrets.
 * @returns {boolean}
 */
export function inboundSecretsMissing(secrets) {
  return !Array.isArray(secrets) || secrets.length === 0;
}

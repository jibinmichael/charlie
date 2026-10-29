// lib/hire-people.mjs — one identity per person, whatever source found them.
// A pursuit is person × job, so every source must resolve the same human to the same row, or
// one person gets two pursuits for one job and two emails. Pure: the store does the lookups.
//
// Keys, strongest first: the LinkedIn profile, the email address. Any key that matches is the same person. Keys that point at DIFFERENT people,
// or a match that disagrees on a key both sides hold, is a CONFLICT: never merged, never guessed,
// sent to a person (the routing rule, applied to identity).
/** A LinkedIn profile URL reduced to "linkedin.com/in/<slug>", or null. Pure. */
export function linkedinKey(url) {
  const m = String(url || "").toLowerCase().match(/linkedin\.com\/(?:in|pub)\/([^/?#\s]+)/);
  return m ? `linkedin.com/in/${decodeURIComponent(m[1]).replace(/\/+$/, "")}` : null;
}

export const IDENTITY_KEYS = ["linkedin_key", "email"];

/** The identity keys a source record carries, normalised. Pure. */
export function identityKeys({ linkedin_url = null, email = null } = {}) {
  const e = typeof email === "string" && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim()) ? email.trim().toLowerCase() : null;
  return { linkedin_key: linkedinKey(linkedin_url), email: e };
}

/**
 * Decide who this is, given the existing hire_people rows each key matched.
 * @param keys  identityKeys() of the incoming record
 * @param found rows from hire_people matching ANY of the keys
 * @returns {{action:"existing", id, fill}|{action:"new"}|{action:"conflict", ids, reason}}
 *   fill: keys the existing row lacks and this record supplies (safe to add)
 */
export function resolvePerson(keys, found) {
  const present = IDENTITY_KEYS.filter((k) => keys[k]);
  if (!present.length) return { action: "conflict", ids: [], reason: "no identity key at all" };
  const hits = found.filter((row) => present.some((k) => row[k] && row[k] === keys[k]));
  const ids = [...new Set(hits.map((r) => r.id))];
  if (ids.length === 0) return { action: "new" };
  if (ids.length > 1) return { action: "conflict", ids, reason: `keys point at ${ids.length} different people` };
  const row = hits[0];
  const clash = present.find((k) => row[k] && row[k] !== keys[k]);
  if (clash) return { action: "conflict", ids, reason: `same person by one key, a different ${clash}` };
  const fill = Object.fromEntries(present.filter((k) => !row[k]).map((k) => [k, keys[k]]));
  return { action: "existing", id: row.id, fill };
}

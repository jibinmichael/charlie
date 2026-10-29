// lib/qualify/copy.mjs — a connection's own wording for its emails (hire_connections.sequence), filled and checked.
// PURE.
//
// A connection may override the opening ("intro") and closing ("closing") lines of the verify email. Custom fields
// fill from the role and the person: {name}, {role}, {company}, {city}, {partner}. An override that breaks a rule is
// NOT used: the default copy goes out instead and the reason is recorded, so a typo in a setting can never put a
// wrong sentence in a real inbox.
//
// The rules an override must keep: no dash characters, none of the words the server never
// shows a person (screening, record, status, dossier), no promise of a job or of pay
// (lib/no-money-promise.test.mjs), every {field} known, 20 to 400 characters.

const FIELDS = ["name", "role", "company", "city", "partner"];
const BANNED = /\b(screening|record|status|dossier|pipeline|algorithm)\b/i;
const PROMISE = /\b(guarantee\w*|assured|will get (the|this|a) (job|offer|role)|you('| wi)ll be hired|definitely (get|be))\b/i;

/**
 * Charlie's own wording for the verify email's opening and closing, as templates over the custom fields: what the
 * settings boxes start with. The same sentences the email uses when a connection sets nothing
 * (email-kit.mjs renderQualifyVerify), with "the" for the article, since a template cannot pick "a" or "an".
 */
export const DEFAULT_VERIFY_COPY = Object.freeze({
  intro: "{company} is hiring for the {role} role in {city}, and I can put you forward through {partner}. I think you could fit it, and before your name goes anywhere I want to check a few things with you.",
  closing: "Nothing about you goes to {company} unless you say yes to the first question. If it is a no, say so and I won't write about this role again.",
});

/** {field} placeholders filled from values. Unknown placeholders are reported, never left in. Pure. */
export function fill(template, values) {
  const unknown = [];
  const out = String(template || "").replace(/\{([a-z]+)\}/gi, (m, k) => {
    const key = k.toLowerCase();
    if (!FIELDS.includes(key)) { unknown.push(m); return m; }
    return String(values[key] ?? "").trim();
  });
  return { text: out.replace(/\s{2,}/g, " ").trim(), unknown };
}

/** Why an override cannot be used, or null when it can. Pure. */
export function copyProblem(text) {
  const t = String(text || "");
  if (t.length < 20 || t.length > 400) return `it is ${t.length} characters (20 to 400)`;
  if (/[‒-―−]|\s-\s|--/.test(t)) return "it has a dash";
  const b = t.match(BANNED);
  if (b) return `it says "${b[0]}", a word Charlie never shows a person`;
  const p = t.match(PROMISE);
  if (p) return `it promises an outcome ("${p[0]}")`;
  return null;
}

/**
 * The verify email's opening and closing for this connection, or null for each to use the default.
 * @returns {{ intro: string|null, closing: string|null, issues: string[] }}
 */
export function verifyCopy(sequence, values) {
  const issues = [];
  const pick = (key) => {
    const raw = sequence?.verify?.[key];
    if (!raw || !String(raw).trim()) return null;
    const { text, unknown } = fill(raw, values);
    if (unknown.length) { issues.push(`verify ${key}: unknown field ${unknown.join(", ")}; default used`); return null; }
    const problem = copyProblem(text);
    if (problem) { issues.push(`verify ${key}: ${problem}; default used`); return null; }
    return text;
  };
  return { intro: pick("intro"), closing: pick("closing"), issues };
}

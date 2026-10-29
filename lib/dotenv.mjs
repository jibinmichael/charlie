// lib/dotenv.mjs — the one .env-file line parser (used by loadEnv() in charlie-store.mjs and by
// health-check.mjs), following the common dotenv rules so `cp .env.example .env.local` just works:
//   - blank lines and lines starting with # are ignored; an optional leading `export ` is allowed,
//   - an UNQUOTED value loses a trailing comment that starts with whitespace + # (`5000   # ms` → `5000`),
//     and surrounding whitespace (`KEY=   # note` → empty); a # with no space before it stays (`a#b`),
//   - a QUOTED value ("..." or '...') keeps everything inside the quotes, # included, and loses the
//     quotes; anything after the closing quote (such as a comment) is dropped.
// Same behaviour as `node --env-file`, which the npm voice:* scripts use.

/**
 * Parse one line of a .env file.
 * @param {string} line
 * @returns {[string, string] | null} [name, value], or null for a blank/comment/unparseable line.
 */
export function parseEnvLine(line) {
  const m = String(line).match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (!m) return null;
  const [, name, rest] = m;
  const raw = rest.trim();
  const q = raw[0];
  if (q === '"' || q === "'") {
    const end = raw.indexOf(q, 1);
    if (end > 0) return [name, raw.slice(1, end)];
  }
  return [name, raw.replace(/(^|\s+)#.*$/, "").trim()];
}

/**
 * Parse a whole .env file's text.
 * @param {string} text
 * @returns {Array<[string, string]>}
 */
export function parseEnv(text) {
  return String(text).split(/\r?\n/).map(parseEnvLine).filter(Boolean);
}

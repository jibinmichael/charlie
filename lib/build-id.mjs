// lib/build-id.mjs — a fingerprint of the code that is actually running.
//
// `charlie-engine` is a one-shot cron container with no HTTP surface, so there is no other way to ask
// it what it is running, and `railway up` uploads the working tree (uncommitted changes included)
// rather than a commit. A hand-bumped VERSION constant does not prove two services run equal code.
//
// A CONTENT HASH does. Hash the source files that determine behaviour and you get an id that cannot be
// forgotten, cannot be bumped without changing the code, and is identical on two services running the
// same tree. "Did my deploy land?" and "are both services on the same code?" become checkable.
//
// Deliberately NOT git: the working tree is what ships, so a commit SHA could describe a tree that was
// never deployed.
//
// Cheap: a few hundred small files, sha256 each, once at process start.
//
// Fail SOFT. This is observability. If the filesystem cannot be read the caller gets `null` and says
// "unknown"; a monitoring feature must never be able to abort a send.

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// WHAT COUNTS AS BEHAVIOUR. The engine's own scripts, the shared libs, the versioned prompts, and the
// human-edited rubrics the prompts read. Tests are excluded: they never run in prod, and letting them
// churn the id would train an operator to ignore a changed fingerprint.
const DIRS = ["lib", "prompts", "server", "emails"];
const ROOT_EXT = [".mjs", ".ts"];
const RUBRICS = ["matcher.md", "composer.md", "dossier.md", "package.json", "watchlist.json"];
const SKIP_DIR = new Set(["node_modules", ".next", ".git", "schemas-out", "fixtures", "__snapshots__"]);
const isTest = (p) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(p);

function walk(dir, out) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const full = join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIR.has(e.name) && !e.name.startsWith(".")) walk(full, out); continue; }
    if (!e.isFile()) continue;
    if (isTest(e.name)) continue;
    // Code and data only inside the walked dirs. No `.md`: the only markdown that is BEHAVIOUR is the
    // three rubrics the prompts read, and those are at the root in RUBRICS. Fingerprinting other
    // markdown would report a divergence for a doc edit, and a signal that cries wolf gets ignored.
    if (!ROOT_EXT.some((x) => e.name.endsWith(x)) && !e.name.endsWith(".json")) continue;
    out.push(full);
  }
  return out;
}

/** Every file whose content the fingerprint covers, repo-relative and sorted (so it is deterministic
 * across machines and filesystems). */
export function buildFiles() {
  const files = [];
  try {
    for (const e of readdirSync(ROOT, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (!e.isFile()) continue;
      if (isTest(e.name)) continue;
      if (ROOT_EXT.some((x) => e.name.endsWith(x)) || RUBRICS.includes(e.name)) files.push(join(ROOT, e.name));
    }
  } catch { /* fall through — an unreadable root yields an empty list, and buildId() returns null */ }
  for (const d of DIRS) {
    try { if (statSync(join(ROOT, d)).isDirectory()) walk(join(ROOT, d), files); } catch { /* absent dir is fine */ }
  }
  // Normalise separators so a Windows checkout and a Linux container agree.
  return files.map((f) => relative(ROOT, f).split(sep).join("/")).sort();
}

/**
 * A short, stable fingerprint of the running code, or null if it could not be computed.
 * @returns {string|null} 12 hex chars, e.g. "9f2c1ab77e04"
 */
export function buildId() {
  const rel = buildFiles();
  if (!rel.length) return null;
  const h = createHash("sha256");
  for (const p of rel) {
    let body;
    try { body = readFileSync(join(ROOT, p)); } catch { return null; } // a half-read tree must not produce a confident id
    // Hash the PATH as well as the content, so renaming a file changes the id.
    h.update(p).update("\0").update(createHash("sha256").update(body).digest()).update("\0");
  }
  return h.digest("hex").slice(0, 12);
}

/** buildId plus what went into it, for a report an operator can actually debug. */
export function buildManifest() {
  const files = buildFiles();
  return { build: buildId(), files: files.length };
}

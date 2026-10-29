// unbounded-read.test.mjs — a read that stops at 1000 rows does not fail. It succeeds, shorter.
//
// Supabase caps an unpaginated select at 1000 rows. A script that is correct while a table is under a
// thousand rows becomes wrong the moment it is not, without anything in it changing, and it keeps
// printing "errored 0" because there is no error: it simply never looks at the rest. Review cannot
// catch a threshold like that. A test can.
//
// A read counts as bounded if it does ANY of: .range() (paginate), .limit(), .single()/.maybeSingle(),
// head:true / count:'exact' (no rows returned), or .in(...) / .eq() on a narrowing key. Anything else
// on a table that can exceed 1000 rows fails here.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// Tables that already exceed, or can exceed, 1000 rows.
export const BIG_TABLES = ["candidates", "talent_pool", "sent_emails", "email_events", "finds", "match_verdicts", "signals", "jobs", "job_pool"];

const BOUNDED = /\.range\(|\.limit\(|\.single\(|\.maybeSingle\(|head:\s*true|count:\s*["']exact["']|\.in\(|\.eq\(/;

// Reviewed exceptions. Each needs a reason, and a reason that is about the DATA, not convenience.
const ALLOW = new Map([
]);

function walk(dir, out = []) {
  for (const f of readdirSync(dir)) {
    if (["node_modules", ".git", ".next", ".claude", "docs", "coverage"].includes(f)) continue;
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(mjs|ts)$/.test(f) && !/\.test\.mjs$/.test(f)) out.push(p);
  }
  return out;
}

const ROOT = new URL("..", import.meta.url).pathname;

describe("no unbounded read on a table that can pass 1000 rows", () => {
  it("every select is paginated, limited, or narrowed", () => {
    const offenders = [];
    for (const file of walk(ROOT)) {
      const src = readFileSync(file, "utf8");
      const rel = file.replace(ROOT, "");
      if (ALLOW.has(rel)) continue;
      const re = /\.from\(["'`](\w+)["'`]\)([\s\S]{0,300}?)(?=;|\n\s*(?:if|const|let|await|return|\}))/g;
      let m;
      while ((m = re.exec(src))) {
        const [, table, tail] = m;
        if (!BIG_TABLES.includes(table)) continue;
        if (!/\.select\(/.test(tail)) continue;
        // A write that returns its own row (`.insert(...).select("id")`) is not a read of the table.
        // It returns exactly what it wrote, so the 1000-row cap cannot touch it.
        if (/\.(insert|upsert|update|delete)\(/.test(tail)) continue;
        if (BOUNDED.test(tail)) continue;
        offenders.push(`${rel}:${src.slice(0, m.index).split("\n").length}  ${table}`);
      }
    }
    expect(offenders, `unbounded read(s) on a 1000+ row table:\n  ${offenders.join("\n  ")}`).toEqual([]);
  });
});

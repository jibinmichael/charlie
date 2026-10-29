// env-example.test.mjs — every env var the runtime code reads must be documented in .env.example.
//
// Each read has an `|| default`, so an undocumented variable crashes nothing: it just leaves a knob
// that bounds a cost or a cap invisible to the operator. This makes that gap a failing test.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { heartbeatEnvKey } from "./lib/heartbeat.mjs";

// Runtime entry points and modules at the root, plus the server, voice and prompt modules.
const FILES = [
  ...readdirSync(".").filter((f) => /\.(mjs|ts)$/.test(f) && !/\.test\./.test(f) && !/\.config\./.test(f)),
  ...["server", "voice", "prompts"].flatMap((d) => readdirSync(d).filter((f) => /\.(mjs|ts)$/.test(f) && !/\.test\./.test(f)).map((f) => `${d}/${f}`)),
];
// Set by the platform or the test runner, never by an operator.
const PLATFORM = new Set(["CI", "NODE_ENV", "NEXT_RUNTIME", "VITEST"]);
const example = readFileSync(".env.example", "utf8");

// A var is "documented" if it appears at the start of a line as NAME= (the file's own format) or is
// named in a comment explaining a related knob.
const documented = (name) =>
  new RegExp(`^${name}=`, "m").test(example) || new RegExp(`\\b${name}\\b`).test(example);

function readsIn(file) {
  const src = readFileSync(file, "utf8");
  const found = new Set();
  for (const m of src.matchAll(/process\.env\.([A-Z0-9_]+)/g)) found.add(m[1]);
  // Names built at run time that a literal scan would miss:
  //   - heartbeats: pingHeartbeat("job") / heartbeat("job") / { heartbeat: "job" } read heartbeatEnvKey(job);
  //   - process.env[NAME] where NAME is a string constant in the same file (const X = "VAR");
  //   - drip-guard's per-type table: envKey: "VAR".
  for (const m of src.matchAll(/\b(?:pingHeartbeat|heartbeat)\(\s*["']([^"']+)["']|\bheartbeat:\s*["']([^"']+)["']/g)) {
    found.add(heartbeatEnvKey(m[1] ?? m[2]));
  }
  for (const m of src.matchAll(/process\.env\[\s*([A-Za-z_$][\w$]*)\s*\]/g)) {
    const c = src.match(new RegExp(`\\bconst\\s+${m[1]}\\s*=\\s*["']([A-Z][A-Z0-9_]*)["']`));
    if (c) found.add(c[1]);
  }
  for (const m of src.matchAll(/\benvKey:\s*["']([A-Z][A-Z0-9_]*)["']/g)) found.add(m[1]);
  return [...found];
}

describe(".env.example documents every env var the runtime reads", () => {
  it("finds real reads, so the assertion below cannot pass vacuously", () => {
    const all = FILES.flatMap(readsIn);
    expect(all.length).toBeGreaterThan(5);
    expect(all).toContain("JOBS_DESC_CAP");
    // ...including names built at run time.
    expect(all).toContain("HEARTBEAT_URL_MATCH_SEND");
    expect(all).toContain("HEARTBEAT_URL_VOICE_PIPELINE");
    expect(all).toContain("DRIP_GLOBAL_MIN_GAP_DAYS");
  });

  for (const file of FILES) {
    it(`${file} reads nothing undocumented`, () => {
      const missing = readsIn(file).filter((v) => !documented(v));
      // RAILWAY_* are injected by the platform; nothing else gets a pass.
      const real = missing.filter((v) => !v.startsWith("RAILWAY_") && !PLATFORM.has(v));
      expect(real).toEqual([]);
    });
  }

  it("documents the cap that decides whether jobs.json can be written at all", () => {
    // JOBS_DESC_CAP is not a tuning knob. Above ~77,000 postings an uncapped jobs.json exceeds V8's
    // 536,870,888-character string limit, the write throws outside every try/catch, and engine:run's
    // && chain drops the send. Whoever operates this service has to be able to see that lever.
    expect(example).toMatch(/^JOBS_DESC_CAP=/m);
    expect(example).toMatch(/536,870,888|string length|string ceiling/i);
  });
});

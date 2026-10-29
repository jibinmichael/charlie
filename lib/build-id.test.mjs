// build-id.test.mjs — the content fingerprint of the running code (lib/build-id.mjs).
//
// `charlie-engine` is a cron container with no HTTP surface, and a hand-bumped VERSION does not prove
// equal code. A content hash is evidence rather than belief only if it moves when the code moves and
// holds still when it does not; these tests pin both halves.
import { describe, it, expect, afterEach } from "vitest";
import { writeFileSync, rmSync, renameSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildId, buildFiles, buildManifest } from "./build-id.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

// A scratch file INSIDE the fingerprint's coverage (lib/*.mjs, not a *.test.mjs) so we can watch the id
// react to a real content change. Named so it is obvious if it ever survives a crashed run.
const PROBE = join(HERE, "__buildid-probe.tmp.mjs");
const PROBE2 = join(HERE, "__buildid-probe-renamed.tmp.mjs");
afterEach(() => { for (const p of [PROBE, PROBE2]) if (existsSync(p)) rmSync(p); });

describe("the fingerprint holds still when the code does", () => {
  it("is stable across calls", () => {
    expect(buildId()).toBe(buildId());
  });

  it("looks like a short hash, not a version string", () => {
    expect(buildId()).toMatch(/^[0-9a-f]{12}$/);
  });

  it("covers the files that decide behaviour", () => {
    const files = buildFiles();
    // The engine's own entrypoints, the shared libs, the versioned prompts and the human rubrics.
    for (const f of ["scheduler.mjs", "charlie-store.mjs", "preflight.mjs", "watchdog.mjs", "lib/send-guard.mjs", "lib/build-id.mjs", "matcher.md", "server/charlie-remote.ts"]) {
      expect(files, `${f} must be fingerprinted`).toContain(f);
    }
    expect(buildManifest()).toEqual({ build: buildId(), files: files.length });
  });

  it("covers the human rubrics but no other markdown", () => {
    // matcher/composer/dossier .md ARE behaviour (the prompts read them). Other markdown is not, and
    // fingerprinting it would report a divergence for a doc edit — a signal that cries wolf gets ignored.
    const md = buildFiles().filter((f) => f.endsWith(".md"));
    expect(md.sort()).toEqual(["composer.md", "dossier.md", "matcher.md"]);
  });

  it("excludes the runtime-written data files, or the id would churn daily", () => {
    // jobs.json is 88MB and rewritten by every scan; watchlist-yc/india.json are written by the ingest
    // jobs. Any of them inside the fingerprint would make it change every night for no deploy.
    const files = buildFiles();
    for (const f of ["jobs.json", "watchlist-yc.json", "watchlist-india.json", "resolve-queue.json", "seen-jobs.json"]) {
      expect(files, `${f} must NOT be fingerprinted`).not.toContain(f);
    }
    expect(files).toContain("watchlist.json"); // this one IS behaviour: which companies we scan
  });

  it("ignores test files, so adding a test does not churn the id", () => {
    // A fingerprint that moves for reasons nobody deployed is a fingerprint people learn to ignore.
    expect(buildFiles().some((f) => /\.test\.mjs$/.test(f))).toBe(false);
    const before = buildId();
    const probeTest = join(HERE, "__buildid-probe.tmp.test.mjs");
    try {
      writeFileSync(probeTest, "// not deployed behaviour\n");
      expect(buildId()).toBe(before);
    } finally { if (existsSync(probeTest)) rmSync(probeTest); }
  });

  it("does not depend on git, because `railway up` ships the working tree", () => {
    // A commit SHA would describe a tree that may never have been deployed — the exact lie this
    // replaces. Nothing in the module may reach for git.
    const src = readFileSync(join(ROOT, "lib/build-id.mjs"), "utf8");
    // (".git" appears once, in the directory SKIP list — that is the opposite of reading git.)
    expect(src).not.toMatch(/child_process|execSync|spawnSync|RAILWAY_GIT_COMMIT/);
  });
});

describe("the fingerprint moves when the code does", () => {
  it("changes when a covered file's CONTENT changes", () => {
    const before = buildId();
    writeFileSync(PROBE, "export const x = 1;\n");
    const added = buildId();
    expect(added).not.toBe(before);
    writeFileSync(PROBE, "export const x = 2;\n"); // same path, one byte different
    expect(buildId()).not.toBe(added);
  });

  it("changes when a covered file is RENAMED, content untouched", () => {
    // Content-only hashing would miss a rename, and a moved module is a different program.
    writeFileSync(PROBE, "export const x = 1;\n");
    const before = buildId();
    renameSync(PROBE, PROBE2);
    expect(buildId()).not.toBe(before);
  });

  it("returns to the original id when the change is reverted", () => {
    // Order-independence and no hidden state: a revert must land back on the same id, or "did my
    // rollback take?" becomes unanswerable too.
    const before = buildId();
    writeFileSync(PROBE, "export const x = 1;\n");
    expect(buildId()).not.toBe(before);
    rmSync(PROBE);
    expect(buildId()).toBe(before);
  });
});

describe("the stamp is wired where it can actually be read", () => {
  const src = (p) => readFileSync(join(ROOT, p), "utf8");

  it("preflight stamps the build at the START of the run, before any check", () => {
    // Before the checks, so a run that ABORTS still records which code aborted.
    const preflight = src("preflight.mjs");
    expect(preflight).toMatch(/async function stampBuild\(/);
    expect(preflight).toMatch(/saveEngineBuild\(\{ build, files, at: new Date\(\)\.toISOString\(\)/);
    const body = preflight.match(/if \(wants\(PRE_SCAN\)\) \{[\s\S]{0,400}/)[0];
    expect(body.indexOf("await stampBuild(phase)")).toBeGreaterThan(-1);
    expect(body.indexOf("await stampBuild(phase)")).toBeLessThan(body.indexOf("checkRequiredEnv()"));
  });

  it("the stamp can never abort the run", () => {
    // Observability must not be able to break the job it observes.
    const fn = src("preflight.mjs").match(/async function stampBuild\([\s\S]*?\n\}/)[0];
    expect(fn).toMatch(/catch \(e\)/);
    expect(fn).not.toMatch(/throw/);
    expect(fn).not.toMatch(/process\.exit/);
  });

  it("the store tells 'never stamped' apart from 'unreadable' without throwing", () => {
    const store = src("charlie-store.mjs");
    const fn = store.match(/export async function loadEngineBuild[\s\S]*?\n\}/)[0];
    expect(fn).toMatch(/return null/);
    expect(fn).toMatch(/catch \{ return null; \}/);
  });

  it("/healthz reports the build, not only the hand-bumped VERSION", () => {
    const server = src("server/charlie-remote.ts");
    expect(server).toMatch(/const BUILD = buildId\(\);/);
    expect(server).toMatch(/app\.get\("\/healthz",[^\n]*build: BUILD/);
  });

  it("the watchdog compares the two services and reports staleness", () => {
    const watchdog = src("watchdog.mjs");
    const fn = watchdog.match(/async function checkBuildParity\(\)[\s\S]*?\n\}/)[0];
    expect(fn).toMatch(/loadEngineBuild\(\)/);
    expect(fn).toMatch(/serverBuild === stamp\.build/);
    expect(fn).toMatch(/DIVERGED/);
    // WARN, not FAIL: a rolling deploy legitimately diverges for a minute, and watchdog's exit code is
    // the container's status — turning ordinary deploys into CRASHED would make the exit code meaningless.
    expect(fn).not.toMatch(/\badd\(/);
    // And it must run AFTER checkHealthz, or serverBuild is always null and the check is vacuous.
    expect(watchdog.indexOf("await checkHealthz();")).toBeLessThan(watchdog.indexOf("await checkBuildParity();"));
  });
});

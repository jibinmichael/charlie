// fit-authority.test.mjs — the kill switch, the veto seam, and the evidence record.
// Everything here is about ONE question: can the Fit Engine reach a real inbox without being
// explicitly, deliberately switched on for a named person?
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fitSendMode, fitSendCohort, fitAuthority, fitCanVeto, fitAuthorityBanner, FIT_MODES } from "./lib/fit-authority.mjs";
import { fitVeto } from "./lib/fit-veto.mjs";
import { fitDecisionRecord } from "./lib/fit-record.mjs";

const ENV = ["FIT_SEND_MODE", "FIT_SEND_COHORT"];
const clear = () => ENV.forEach((k) => delete process.env[k]);
beforeEach(clear); afterEach(clear);

describe("the kill switch defaults to OFF and fails closed on everything", () => {
  it("unset is off", () => { expect(fitSendMode()).toBe("off"); expect(fitAuthority("a@b.com")).toBe("off"); });

  it("every malformed value is off — you have to spell it to get it", () => {
    for (const v of ["", " ", "on", "true", "1", "ENFORCE!", "shadow ", "yes", "enabled", "enforce;"]) {
      process.env.FIT_SEND_MODE = v;
      process.env.FIT_SEND_COHORT = "a@b.com";
      if (v === "shadow ") { expect(fitSendMode()).toBe("shadow"); continue; }  // trimmed, and that is intended
      expect(fitSendMode()).toBe("off");
      expect(fitAuthority("a@b.com")).toBe("off");
    }
  });

  it("AN EMPTY COHORT IS NOBODY, NOT EVERYBODY — even on enforce", () => {
    process.env.FIT_SEND_MODE = "enforce";
    for (const c of [undefined, "", " ", " , , "]) {
      if (c === undefined) delete process.env.FIT_SEND_COHORT; else process.env.FIT_SEND_COHORT = c;
      expect(fitSendCohort().size).toBe(0);
      expect(fitAuthority("anyone@anywhere.com")).toBe("off");
      expect(fitCanVeto("anyone@anywhere.com")).toBe(false);
    }
  });

  it("authority is per-person: on for the listed address, off for everyone else", () => {
    process.env.FIT_SEND_MODE = "enforce";
    process.env.FIT_SEND_COHORT = " Listed@Example.COM , other@x.com ";
    expect(fitAuthority("listed@example.com")).toBe("enforce");
    expect(fitCanVeto("LISTED@EXAMPLE.COM")).toBe(true);
    expect(fitAuthority("notlisted@example.com")).toBe("off");
    expect(fitAuthority("")).toBe("off");
    expect(fitAuthority(undefined)).toBe("off");
  });

  it("shadow can never veto — only enforce can", () => {
    process.env.FIT_SEND_COHORT = "a@b.com";
    process.env.FIT_SEND_MODE = "shadow";
    expect(fitAuthority("a@b.com")).toBe("shadow");
    expect(fitCanVeto("a@b.com")).toBe(false);
    process.env.FIT_SEND_MODE = "enforce";
    expect(fitCanVeto("a@b.com")).toBe(true);
  });

  it("the flag lives in the normal production config, not hidden in code", () => {
    const env = readFileSync(new URL("./.env.example", import.meta.url), "utf8");
    expect(env).toMatch(/^FIT_SEND_MODE=off$/m);
    expect(env).toMatch(/^FIT_SEND_COHORT=$/m);
    expect(env).toMatch(/EMPTY MEANS NOBODY/);
    expect(FIT_MODES).toEqual(["off", "shadow", "enforce"]);
  });

  it("the banner says what is live, and calls out the empty-cohort trap", () => {
    process.env.FIT_SEND_MODE = "enforce";
    expect(fitAuthorityBanner()).toMatch(/mode=enforce cohort=0 address\(es\) — NOBODY/);
  });
});

describe("the veto seam", () => {
  const job = { id: "j1", title: "Sr. Firmware Engineer", company: "Acme", description: "x" };
  const sat = (r) => ({ req: r, gating: true, kind: "capability", status: "met", evidence_strength: "direct", evidence: `cited: ${r}`, outcome: "satisfied" });
  const near = (r) => ({ req: r, gating: true, kind: "capability", status: "partial", evidence_strength: "adjacent", evidence: "nearby", outcome: "unproven", blocks: true });
  const good = [sat("a"), sat("b"), sat("c"), sat("d"), sat("e")];
  const bad = [sat("a"), sat("b"), sat("c"), near("d"), near("e"), near("f"), near("g")];
  const deps = (judged, authority) => ({
    // THE REAL SHAPE. This double must mirror the engine's real return value: a double that returns a
    // bare array would agree with a seam bug that produces zero fit decisions in production.
    stage1: async () => ({ key: "k", cached: false, requirements: judged.map((r) => ({ req: r.req, gating: true, kind: "capability", tool: false })) }),
    stage2: async () => judged,
    authority: () => authority,
    now: "2026-08-09T00:00:00.000Z",
  });
  const senior = { preferences: { seniority: null, role: "Embedded Engineer II" } };
  const quiet = () => {};

  it("OFF: the engine is never called at all", async () => {
    let called = false;
    const r = await fitVeto({ email: "a@b.com", dossier: {}, job, log: quiet,
      deps: { ...deps(good, "off"), stage1: async () => { called = true; return { key: "k", cached: false, requirements: [] }; } } });
    expect(called).toBe(false);
    expect(r).toEqual({ veto: false, record: null, authority: "off" });
  });

  it("SHADOW: the engine runs, records, and never vetoes", async () => {
    const r = await fitVeto({ email: "a@b.com", dossier: senior, job, log: quiet, deps: deps(bad, "shadow") });
    expect(r.veto).toBe(false);
    expect(r.record).toBeTruthy();
    expect(r.record.send).toBe(false);       // it disagreed, and said so, and still did not act
  });

  it("ENFORCE: a rejection becomes a veto", async () => {
    const r = await fitVeto({ email: "a@b.com", dossier: senior, job, log: quiet, deps: deps(bad, "enforce") });
    expect(r.veto).toBe(true);
  });

  it("ENFORCE: an approval is NOT a veto — the seam is subtractive", async () => {
    const r = await fitVeto({ email: "a@b.com", dossier: { preferences: { seniority: "senior" } }, job, log: quiet, deps: deps(good, "enforce") });
    expect(r.veto).toBe(false);
    expect(r.record.send).toBe(true);
  });

  it("fails OPEN on infrastructure error — a timeout must not silence anyone", async () => {
    const r = await fitVeto({ email: "a@b.com", dossier: senior, job, log: quiet,
      deps: { ...deps(bad, "enforce"), stage2: async () => { throw new Error("504"); } } });
    expect(r.veto).toBe(false);
  });

  it("fails OPEN when there is no requirement list — no opinion is not a hold", async () => {
    const r = await fitVeto({ email: "a@b.com", dossier: senior, job, log: quiet,
      deps: { ...deps(bad, "enforce"), stage1: async () => ({ key: "k", cached: false, requirements: [] }) } });
    expect(r.veto).toBe(false);
  });

  it("THE THREE NAMED BAD CASES STAY BLOCKED under enforce", async () => {
    // The over-level title: 5/7 clears D1's ratio; the level gate holds it (title band 4 vs claimed 2).
    const conv = [sat("a"), sat("b"), sat("c"), sat("d"), sat("e"), near("f"), near("g")];
    expect((await fitVeto({ email: "a@b.com", dossier: senior, job: { ...job, title: "Sr. Firmware Engineer - Embedded Linux" }, log: quiet, deps: deps(conv, "enforce") })).veto).toBe(true);
    // The tool-heavy platform role: 3 satisfied, 4 tolerated unlisted tools — tolerated may not exceed satisfied.
    const tool = (r) => ({ req: r, gating: true, kind: "capability", status: "unknown", evidence_strength: null, evidence: null, tool: true, outcome: "unproven", blocks: false });
    const zb = [sat("CI/CD"), sat("LLM integration"), sat("Python"), tool("Kubernetes"), tool("Helm"), tool("Terraform"), tool("ArgoCD")];
    expect((await fitVeto({ email: "a@b.com", dossier: { preferences: { seniority: "senior" } }, job: { ...job, title: "Senior Software Engineer, Developer Platform" }, log: quiet, deps: deps(zb, "enforce") })).veto).toBe(true);
    // The staff role: 2 satisfied of 4 — below the decided floor and below the ratio.
    const gl = [sat("CLI development"), sat("Open source"), near("Go"), near("Technical direction")];
    expect((await fitVeto({ email: "a@b.com", dossier: { preferences: { seniority: "senior" } }, job: { ...job, title: "Staff Software Engineer" }, log: quiet, deps: deps(gl, "enforce") })).veto).toBe(true);
  });
});

// ── THE SEAM/ENGINE CONTRACT ───────────────────────────────────────────────────────────────────────
// The seam and the engine must agree on the return shape. This pins the REAL function, so the double
// above can never drift away from it again. No model call: a cache hit short-circuits before the API.
describe("stage1Requirements return-shape contract", () => {
  it("returns { key, cached, requirements } — an OBJECT, never a bare array", async () => {
    const { stage1Requirements, stage1Key } = await import("./lib/fit-stage.mjs");
    const job = { id: "j1", title: "Engineer", description: "x".repeat(80) };
    const rows = [{ req: "React", gating: true, kind: "capability", tool: true }];
    // Pre-seed the cache under the real key so no API call is made.
    const cache = new Map([[stage1Key(job.title, job.description), rows]]);
    const out = await stage1Requirements(job, cache);
    expect(Array.isArray(out)).toBe(false);                 // the seam must not assume a bare array
    expect(out).toMatchObject({ cached: true, requirements: rows });
    expect(typeof out.key).toBe("string");
    expect(Array.isArray(out.requirements)).toBe(true);
  });

  it("the seam DESTRUCTURES it rather than using it directly", () => {
    const src = readFileSync(new URL("./lib/fit-veto.mjs", import.meta.url), "utf8");
    expect(src).toMatch(/const \{ requirements \} = await stage1\(/);
    expect(src).not.toMatch(/const requirements = await stage1\(/);
  });

  it("REGRESSION: the seam reaches stage 2 when stage 1 returns the real shape", async () => {
    let reachedStage2 = false;
    const rows = [{ req: "React", gating: true, kind: "capability", tool: true }];
    const r = await fitVeto({
      email: "a@b.com", dossier: { preferences: { seniority: "senior" } },
      job: { id: "j", title: "Engineer" }, log: () => {},
      deps: {
        authority: () => "shadow",
        stage1: async () => ({ key: "k", cached: true, requirements: rows }),
        stage2: async () => { reachedStage2 = true; return rows.map((x) => ({ ...x, status: "met", evidence_strength: "direct", evidence: "cited", outcome: "satisfied" })); },
      },
    });
    expect(reachedStage2).toBe(true);        // the seam reaches stage 2
    expect(r.record).toBeTruthy();           // and a decision record now exists
  });
});

describe("the evidence record", () => {
  const rows = [
    { req: "React", gating: true, kind: "capability", tool: true, status: "met", evidence_strength: "direct", evidence: "built X", locator: "resume", outcome: "satisfied", why: "met:direct", blocks: false },
    { req: "Python", gating: true, kind: "capability", tool: true, status: "partial", evidence_strength: "adjacent", evidence: "FastAPI", locator: "resume", outcome: "unproven", why: "partial:adjacent", blocks: true },
    { req: "8+ years", gating: true, kind: "experience-duration", tool: false, status: "contradicted", evidence_strength: null, evidence: "no professional history", locator: null, outcome: "unproven", why: "contradicted", blocks: true },
    { req: "Bangalore", gating: true, kind: "constraint", status: "met", evidence_strength: "direct", evidence: "based there", outcome: "satisfied" },
  ];
  const rec = fitDecisionRecord({ email: "A@B.com", jobId: "j1", jobTitle: "Engineer", authority: "enforce",
    decision: { send: false, why: "held", satisfied: 1, total: 3, anchors: 1 }, requirements: rows, at: "2026-08-09T00:00:00.000Z" });

  it("keeps every field the brief requires", () => {
    for (const k of ["email", "job_id", "job_title", "authority", "send", "why", "satisfied", "unmet", "contradictions", "engine", "at"])
      expect(rec).toHaveProperty(k);
    expect(rec.email).toBe("a@b.com");
    expect(rec.engine).toHaveProperty("build");
    expect(rec.engine).toHaveProperty("model");
  });

  it("keeps the citation and the blocking fields, not a summary of them", () => {
    expect(rec.satisfied[0]).toMatchObject({ req: "React", evidence: "built X", evidence_strength: "direct", locator: "resume", why: "met:direct" });
    expect(rec.unmet.find((r) => r.req === "Python")).toMatchObject({ evidence: "FastAPI", evidence_strength: "adjacent", why: "partial:adjacent", blocks: true });
    expect(rec.contradictions.map((r) => r.req)).toEqual(["8+ years"]);
  });

  it("excludes constraint rows, exactly as the operator does", () => {
    expect([...rec.satisfied, ...rec.unmet].map((r) => r.req)).not.toContain("Bangalore");
  });

  it("is a COPY, never a second score", () => {
    const src = readFileSync(new URL("./lib/fit-record.mjs", import.meta.url), "utf8");
    const body = src.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
    expect(body).not.toMatch(/composite|weight|\*\s*0\.|score\s*=/i);
  });
});

describe("the live send path is unchanged and uncircumventable", () => {
  const sched = readFileSync(new URL("./scheduler.mjs", import.meta.url), "utf8");

  it("the veto runs ONLY after the existing gate already said send", () => {
    const i = sched.indexOf('if (g.decision === "send")');
    const v = sched.indexOf("await fitVeto(");
    expect(i).toBeGreaterThan(-1);
    expect(v).toBeGreaterThan(i);           // inside the approved branch, never before it
  });

  it("the engine can only turn a send into a hold — it never assigns `job`", () => {
    const seam = readFileSync(new URL("./lib/fit-veto.mjs", import.meta.url), "utf8");
    expect(seam).not.toMatch(/job\s*=\s*cand|decision\s*=\s*"send"/);
    expect(sched).toMatch(/if \(fv\.veto\)/);
  });

  it("the veto seam cannot reach a mailer", () => {
    for (const f of ["./lib/fit-veto.mjs", "./lib/fit-authority.mjs", "./lib/fit-record.mjs", "./lib/send-rule.mjs"]) {
      const src = readFileSync(new URL(f, import.meta.url), "utf8");
      expect(src).not.toMatch(/resend|sendGuarded|emails\.send/i);
    }
  });

  it("sendGuarded is still the ONE physical door", () => {
    const guard = readFileSync(new URL("./lib/send-guard.mjs", import.meta.url), "utf8");
    expect(guard).toMatch(/resend\.emails\.send/);
    expect(sched).toMatch(/sendGuarded/);
  });

  it("the decision record is persisted WITH the send that it justified", () => {
    expect(sched).toMatch(/_fit: fitRecords\.get\(rawJob\.id\) \?\? null/);
  });
});

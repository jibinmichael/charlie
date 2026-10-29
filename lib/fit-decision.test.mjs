// fit-decision.test.mjs — the v2 fit operator (lib/fit-decision.mjs), and the guarantee that it decides
// nothing yet.
//
// Counting any PARTIAL as satisfying a gating requirement lets through evidence for things that are not
// there, so the tests that matter here pin WHICH partials can satisfy a requirement, and the
// fail-closed cases around it.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import {
  fitDecision, partition, requirementOutcome, anchors, citationSupport, positiveClause,
  SATISFYING, ANCHORING, UNDEMONSTRATED, SILENCE_BLOCKS_ON, overStatedBand, durationVerdict,
  STRONG, POSSIBLE, INSUFFICIENT, NOT_A_FIT,
} from "./fit-decision.mjs";

// Helpers. Default kind is `capability`; the default gatingFloor is 3, so fixtures carry >= 3.
const g = (req, status, evidence = "cited at Acme", extra = {}) => ({ req, status, gating: true, kind: "capability", evidence, ...extra });
const p = (req, status, evidence = "cited at Acme", extra = {}) => ({ ...g(req, status, evidence, extra), gating: false });
const met3 = ["A", "B", "C"].map((r) => g(r, "met", "cited at Acme", { evidence_strength: "direct", tool: false }));

describe("evidence strength is READ, never inferred — and status must agree", () => {
  const outcome = (r) => requirementOutcome(r, () => true);

  it("met + direct satisfies and anchors; met + adjacent satisfies but cannot anchor", () => {
    expect(outcome(g("A", "met", "e", { evidence_strength: "direct" }))).toMatchObject({ outcome: "satisfied", anchors: true });
    expect(outcome(g("A", "met", "e", { evidence_strength: "adjacent" }))).toMatchObject({ outcome: "satisfied", anchors: false });
  });

  it("met + trivial SATISFIES but cannot anchor — the Assetplus failure", () => {
    // "English listed as a spoken language" genuinely satisfies; calling it unmet would invent a
    // deficiency. It just cannot be the reason an email is sent.
    expect(outcome(g("English", "met", "e", { evidence_strength: "trivial" }))).toMatchObject({ outcome: "satisfied", anchors: false });
  });

  it("PARTIAL never satisfies, whatever its strength — the Counsel route", () => {
    // Gating on strength ALONE accepts partial+adjacent, which lets a 3-year record pass a Senior
    // requirement.
    for (const sName of ["direct", "adjacent", "trivial"]) {
      const o = outcome(g("Senior level", "partial", "3+ years", { evidence_strength: sName }));
      expect(o.outcome, sName).toBe("unproven");
      expect(o.blocks, sName).toBe(true);
      expect(o.why).toBe(`partial:${sName}`);
    }
  });

  it("SELF-REPORTED and ASPIRATIONAL are not demonstrations, even on a met row", () => {
    // A meaningful share of everything status calls MET is only self-reported.
    for (const sName of ["self-reported", "aspirational"]) {
      const o = outcome(g("Figma", "met", "Figma listed under tech preferences", { evidence_strength: sName }));
      expect(o.outcome, sName).toBe("unproven");
      expect(o.blocks, sName).toBe(true);
      expect(o.why).toBe(`undemonstrated:${sName}`);
    }
    expect([...UNDEMONSTRATED].sort()).toEqual(["aspirational", "self-reported"]);
  });

  it("a strong-fit cannot be built out of self-reported evidence", () => {
    const reqs = ["A", "B", "C"].map((r) => g(r, "met", "e", { evidence_strength: "self-reported" }));
    expect(fitDecision(reqs).verdict).toBe(POSSIBLE);
    expect(fitDecision(reqs).counts.undemonstrated).toBe(3);
  });

  it("FAILS CLOSED when the field is absent — there is deliberately no prose fallback", () => {
    const o = outcome(g("A", "met", "Self-reports design systems as a skill"));
    expect(o.outcome).toBe("unproven");
    expect(o.why).toBe("evidence-strength-absent");
  });

  it("NO evidence regex survives in the module", () => {
    const code = readFileSync(new URL("./fit-decision.mjs", import.meta.url), "utf8")
      .split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    for (const gone of ["classifyPartial", "self[- ]report", "self-describ", "practice[- ]level", "as the posting specifies"]) {
      expect(code, gone).not.toContain(gone);
    }
  });

  it("an unresolved citation still blocks, whatever the strength claims", () => {
    const o = requirementOutcome(g("A", "met", "e", { evidence_strength: "direct" }), () => false);
    expect(o.why).toBe("citation-unresolved");
    expect(o.blocks).toBe(true);
  });
});

describe("overStatedBand — arithmetic, not classification", () => {
  const dur = (req, evidence, status = "partial") => ({ req, evidence, status, kind: "experience-duration" });

  it("catches a record above a stated ceiling", () => {
    expect(overStatedBand(dur("2-6 years PM", "Senior PM with 8+ years in B2B SaaS"))).toEqual({ ceiling: 6, found: 8 });
    expect(overStatedBand(dur("7–12 years PM", "Product leader with 17+ years"))).toEqual({ ceiling: 12, found: 17 });
  });

  it("does NOT fire on exceeding a MINIMUM — the failure an earlier prose instrument made", () => {
    // "5+ years" against sixteen is a person comfortably qualified, not a contradiction.
    expect(overStatedBand(dur("5+ years", "total span well exceeds 5 years; 16 years listed"))).toBeNull();
  });

  it("is decimal-safe — an earlier version read '1.5 years' as '5 years'", () => {
    expect(overStatedBand(dur("2–4 years experience", "about 1.5 years across backend"))).toBeNull();
    expect(overStatedBand(dur("1-2 years", "about 1.5 years"))).toBeNull();
  });

  it("only applies to experience-duration, and only where there is evidence", () => {
    expect(overStatedBand({ req: "React 16-18", evidence: "20 years of React", status: "met", kind: "capability" })).toBeNull();
    expect(overStatedBand(dur("1-3 years", null, "unknown"))).toBeNull();
    expect(overStatedBand(dur("1-3 years", "no numbers here"))).toBeNull();
  });

  it("UNDER a stated floor is a contradiction too — the mirror case", () => {
    // "7+ years" against four years is not partial satisfaction, whatever the judge scored.
    expect(durationVerdict(dur("7+ years", "Full-stack developer with 4 years"))).toMatchObject({ verdict: "under", floor: 7, found: 4 });
    const d = fitDecision([...met3, { req: "7+ years", status: "partial", gating: true, kind: "experience-duration", evidence: "4 years", evidence_strength: "direct" }]);
    expect(d.verdict).toBe(NOT_A_FIT);
    expect(d.contradictions[0].why).toBe("under-stated-floor:4<7");
  });

  it("INSIDE a stated band satisfies, whatever the judge said", () => {
    // The posting asked 1-3 years, the record says 14 months, the judge still said partial.
    expect(durationVerdict(dur("1–3 years experience", "roughly 14 months of full-time"))).toMatchObject({ verdict: "inside", found: 1.2 });
    const r = { req: "1–3 years experience", status: "partial", gating: true, kind: "experience-duration", evidence: "roughly 14 months", evidence_strength: "direct" };
    const o = requirementOutcome(r, () => true);
    expect(o.outcome).toBe("satisfied");
    expect(o.anchors).toBe(true);
    expect(o.why).toBe("inside-stated-band:1-3");
  });

  it("reads months as well as years, so a band is comparable either way", () => {
    expect(durationVerdict(dur("1-3 years", "18 months"))).toMatchObject({ verdict: "inside" });
    expect(durationVerdict(dur("2-4 years", "6 months"))).toMatchObject({ verdict: "under" });
  });

  it("a cleared FLOOR is not a special case — it goes the ordinary route", () => {
    // "5+ years" against sixteen is simply satisfied; there is nothing for the arithmetic to say.
    expect(durationVerdict(dur("5+ years", "16 years listed"))).toBeNull();
  });

  it("routes to NOT_A_FIT and preserves the band for the explanation", () => {
    const d = fitDecision([...met3, { req: "2-6 years PM", status: "met", gating: true, kind: "experience-duration", evidence: "8+ years", evidence_strength: "direct" }]);
    expect(d.verdict).toBe(NOT_A_FIT);
    expect(d.contradictions[0]).toMatchObject({ req: "2-6 years PM", band: { ceiling: 6, found: 8 } });
    expect(d.contradictions[0].why).toBe("over-stated-band:8>6");
    expect(d.counts.overBand).toBe(1);
  });

  it("outranks a met+direct row — arithmetic beats the model's own status", () => {
    const r = { req: "1-3 years", status: "met", gating: true, kind: "experience-duration", evidence: "6 years", evidence_strength: "direct" };
    expect(requirementOutcome(r, () => true).outcome).toBe("contradiction");
  });
});

describe("a missing TOOL does not hold a role — instruction 3, now answerable", () => {
  it("tool silence is tolerated, not blocking", () => {
    const reqs = [...met3, g("Kubernetes", "unknown", null, { tool: true })];
    const d = fitDecision(reqs);
    expect(d.verdict).toBe(STRONG);
    expect(d.counts.tolerated).toBe(1);
    expect(d.tolerated[0].why).toBe("unknown:tool");
  });

  it("a non-tool capability silence still blocks", () => {
    const reqs = [...met3, g("Information architecture", "unknown", null, { tool: false })];
    expect(fitDecision(reqs).verdict).toBe(POSSIBLE);
  });

  it("silence about a LEVEL or DOMAIN blocks even if the model marks it a tool", () => {
    // Belt and braces: the contract names these as the things that genuinely disqualify, so a stray
    // tool:true must not be able to wave one through.
    for (const kind of ["experience-duration", "domain", "credential"]) {
      const reqs = [...met3, g("X", "unknown", null, { kind, tool: true })];
      expect(fitDecision(reqs, {}).verdict, kind).toBe(POSSIBLE);
    }
  });

  it("an absent `tool` field blocks — unknown is not assumed to be a tool", () => {
    expect(fitDecision([...met3, g("Something", "unknown", null)]).verdict).toBe(POSSIBLE);
  });

  it("the stricter variant stays reproducible behind an option", () => {
    const reqs = [...met3, g("Kubernetes", "unknown", null, { tool: true })];
    expect(fitDecision(reqs, { toolSilenceBlocks: true }).verdict).toBe(POSSIBLE);
  });
});

describe("an anchor is required — corroboration is not a reason to send", () => {
  it("INSUFFICIENT when everything satisfying is adjacent or trivial", () => {
    const soft = ["A", "B", "C"].map((r) => g(r, "met", "e", { evidence_strength: "adjacent" }));
    const d = fitDecision(soft);
    expect(d.verdict).toBe(INSUFFICIENT);
    expect(d.why).toMatch(/nothing is shown DIRECTLY/);
    expect(fitDecision(["A", "B", "C"].map((r) => g(r, "met", "e", { evidence_strength: "trivial" }))).verdict).toBe(INSUFFICIENT);
  });

  it("one direct requirement anchors the rest", () => {
    const reqs = [
      g("A", "met", "e", { evidence_strength: "direct" }),
      g("B", "met", "e", { evidence_strength: "adjacent" }),
      g("C", "met", "e", { evidence_strength: "trivial" }),
    ];
    expect(fitDecision(reqs).verdict).toBe(STRONG);
    expect(fitDecision(reqs).counts).toMatchObject({ satisfied: 3, anchors: 1 });
  });
});

describe("the gating set has to be big enough to be a screen", () => {
  it("INSUFFICIENT below the floor, however good the evidence", () => {
    // A strong fit resting on one or two gating requirements (or a single mis-scored partial) is
    // not a screen. A conjunction over one item is not a test.
    expect(fitDecision([g("A", "met")]).verdict).toBe(INSUFFICIENT);
    expect(fitDecision([g("A", "met"), g("B", "met")]).verdict).toBe(INSUFFICIENT);
    expect(fitDecision(met3).verdict).toBe(STRONG);
  });

  it("says how many it had, so the hold is explainable", () => {
    expect(fitDecision([g("A", "met"), g("B", "met")]).why).toMatch(/only 2 required requirement/);
  });

  it("the floor is an argument, not a constant baked into the verdict", () => {
    expect(fitDecision([met3[0]], { gatingFloor: 1 }).verdict).toBe(STRONG);
    expect(fitDecision(met3, { gatingFloor: 4 }).verdict).toBe(INSUFFICIENT);
  });

  it("the floor counts what was DECIDED, not what was asked", () => {
    // A role with ONE satisfied requirement of seven, the other six being unlisted tools (Next.js,
    // Prisma, SWR, Electron, Swift, React Native), must not pass. A tolerated silence is not evidence
    // either way, so it cannot help a conjunction reach the size that makes it a screen.
    const one = [
      g("React", "met", "e", { evidence_strength: "direct", tool: true }),
      ...["Next.js", "Prisma", "SWR", "Electron", "Swift", "React Native"].map((t) => g(t, "unknown", null, { tool: true })),
    ];
    const d = fitDecision(one);
    expect(d.verdict).toBe(INSUFFICIENT);
    expect(d.why).toMatch(/actually decided/);
    expect(d.counts).toMatchObject({ satisfied: 1, tolerated: 6 });
  });

  it("but a real satisfied set is unaffected by a tolerated tool beside it", () => {
    expect(fitDecision([...met3, g("Kubernetes", "unknown", null, { tool: true })]).verdict).toBe(STRONG);
  });

  it("INSUFFICIENT, never vacuously strong, when nothing is gating at all", () => {
    expect(fitDecision([{ req: "React", status: "met", gating: null }]).verdict).toBe(INSUFFICIENT);
    for (const input of [[], null, undefined, "nope"]) expect(fitDecision(input).verdict).toBe(INSUFFICIENT);
  });
});

describe("contradiction outranks everything", () => {
  it("NOT_A_FIT outranks both satisfied and unproven requirements", () => {
    const reqs = [...met3, g("K8s", "unknown", null), g("On-call", "contradicted", "left ops deliberately")];
    expect(fitDecision(reqs).verdict).toBe(NOT_A_FIT);
  });

  it("now ALSO reachable without the model, via overStatedBand", () => {
    // Not-a-fit is otherwise reachable only through status:"contradicted", which the model rarely
    // emits. The deterministic band check covers the one class it can decide arithmetically.
    // Everything else — a graduation year, an under-level mismatch — still needs the model to say so,
    // and does not reach not-a-fit. That is a known limit.
    expect(fitDecision([...met3, g("2-6 years", "met", "8+ years", { evidence_strength: "direct", kind: "experience-duration" })]).verdict).toBe(NOT_A_FIT);
    const gradYear = fitDecision([...met3, g("Grad 2028", "partial", "Expected graduation 2029, not 2028", { evidence_strength: "direct" })]);
    expect(gradYear.verdict).toBe(POSSIBLE); // held, not dropped — the honest limit
  });

  it("a PREFERRED requirement can be anything at all without blocking", () => {
    const reqs = [...met3, p("MBA", "contradicted"), p("K8s", "unknown", null), p("X", "partial", "Self-reports X")];
    expect(fitDecision(reqs).verdict).toBe(STRONG);
  });
});

describe("constraint-kind requirements are excluded, not double-judged", () => {
  it("the gates already own location and work authorisation", () => {
    const reqs = [...met3, { req: "Onsite in Berlin", status: "unknown", gating: true, kind: "constraint" }];
    expect(partition(reqs).constraint).toHaveLength(1);
    expect(fitDecision(reqs).verdict).toBe(STRONG);
  });
});

describe("citation support measures the POSITIVE clause only", () => {
  const dossier = "Product Head at Northwind Software, freight SaaS. Built 60+ REST APIs on OpenAPI 3.0 for 25 carriers.";

  it("strips the 'but X is missing' half before scoring", () => {
    // A common artifact: the evidence names the thing it honestly could not find, and would be
    // penalised for the absent thing not being in the dossier.
    const e = "Built 60+ REST APIs on OpenAPI 3.0; no explicit GraphQL or gRPC work described";
    expect(positiveClause(e)).toBe("Built 60+ REST APIs on OpenAPI 3.0");
    expect(citationSupport(e, dossier)).toBe(1);
    // Prove the artifact is what it says: scoring the WHOLE string is strictly worse.
    const whole = anchors(e).filter((t) => dossier.toLowerCase().includes(t)).length / anchors(e).length;
    expect(whole).toBeLessThan(1);
  });

  it("still scores an invented citation low", () => {
    expect(citationSupport("Principal Engineer at Netflix on the streaming platform", dossier)).toBeLessThan(0.4);
  });

  it("returns null rather than 0 when nothing is checkable", () => {
    // null means UNMEASURABLE. Zero would read as "refuted", which is a different claim.
    expect(citationSupport("", dossier)).toBeNull();
    expect(citationSupport("the and for with", dossier)).toBeNull();
    expect(citationSupport("Netflix", "")).toBeNull();
  });

  it("drops stop words that appear in every citation", () => {
    expect(anchors("Resume states experience across roles")).toEqual([]);
  });

  it("bakes in NO threshold — the module exports no cut-point", () => {
    const code = readFileSync(new URL("./fit-decision.mjs", import.meta.url), "utf8")
      .split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    expect(code).not.toMatch(/SUPPORT_(FLOOR|MIN)|support\s*>=\s*0\.[0-9]/);
  });
});

describe("IT DECIDES NOTHING YET — v1 remains authoritative", () => {
  const ROOT = new URL("../", import.meta.url);
  const importers = readdirSync(ROOT)
    .filter((f) => (f.endsWith(".mjs") || f.endsWith(".ts")) && !f.includes(".test."))
    .filter((f) => readFileSync(new URL(f, ROOT), "utf8").includes("fit-decision.mjs"));

  it("no production module imports it", () => {
    expect(importers).toEqual([]);
  });

  it("the live gate still routes on the matcher bar and the fit floor, untouched", () => {
    const gate = readFileSync(new URL("quality-gate.mjs", ROOT), "utf8");
    expect(gate).toMatch(/matcherScore < Number\(process\.env\.MATCH_BAR \|\| 70\)/);
    expect(gate).toMatch(/covScoreable && cov\.composite < FIT_FLOOR/);
    expect(gate).not.toMatch(/fitDecision|fit-decision/);
  });
});

// ── A decision may not rest on more assumed than shown ────────────────────────────────────────────
// A platform role with three satisfied requirements and four silent infrastructure tools tolerated is
// not defensible as a send: on a platform role that stack IS the job.
describe("tolerated may not EXCEED satisfied — the platform-role false positive", () => {
  const shown = (req) => g(req, "met", `cited at Acme: ${req}`, { evidence_strength: "direct", tool: false });
  const silentTool = (req) => g(req, "unknown", null, { evidence_strength: null, tool: true });

  // The shape, requirement for requirement.
  const platformRole = [
    shown("CI/CD systems"), shown("LLM integration"), shown("Python or TypeScript or Bash"),
    silentTool("Kubernetes"), silentTool("Helm"), silentTool("Terraform"), silentTool("ArgoCD"),
  ];

  it("PROVES THE REGRESSION: 3 shown vs 4 tolerated no longer sends", () => {
    const d = fitDecision(platformRole);
    expect(d.verdict).toBe(INSUFFICIENT);
    expect(d.counts.tolerated).toBe(4);
    expect(d.counts.satisfied).toBe(3);
    expect(d.why).toMatch(/more of this role was assumed than demonstrated/);
  });

  it("and it is the RATIO that changed the answer, nothing else", () => {
    // Same three demonstrations, one fewer assumption. Every other input is identical, so if this
    // still sends then the ratio rule is the only thing that moved the verdict.
    const d = fitDecision(platformRole.slice(0, 6));
    expect(d.verdict).toBe(STRONG);
    expect(d.counts.tolerated).toBe(3);
    expect(d.counts.satisfied).toBe(3);
  });

  it("equal is allowed — the rule refuses a MINORITY of demonstrations, not a tie", () => {
    expect(fitDecision([...met3, silentTool("X"), silentTool("Y"), silentTool("Z")]).verdict).toBe(STRONG);
    expect(fitDecision([...met3, silentTool("X"), silentTool("Y"), silentTool("Z"), silentTool("W")]).verdict).toBe(INSUFFICIENT);
  });

  it("leaves strong matches untouched", () => {
    // Typical strong shapes: 5 or 6 satisfied against at most one tolerated tool.
    const visionRole = [
      shown("CS or related degree"), shown("Python"), shown("RESTful APIs"),
      shown("Computer Vision ML"), shown("Full-stack development"), silentTool("FastAPI or Flask or Django"),
    ];
    expect(fitDecision(visionRole).verdict).toBe(STRONG);
    const fullStackRole = ["React", "Node.js", "LLMs", "RAG", "Full-stack development", "API integration"].map(shown);
    expect(fitDecision([...fullStackRole, silentTool("Python")]).verdict).toBe(STRONG);
  });

  it("does not make an unlisted tool blocking, and does not touch the floor", () => {
    // A tolerated tool is still not a blocker: the verdict below is INSUFFICIENT for the FLOOR
    // reason, not the ratio reason, and `blocking` stays empty.
    const d = fitDecision([shown("A"), shown("B"), silentTool("X")]);
    expect(d.counts.blocking).toBe(0);
    expect(d.why).toMatch(/too few to constitute a screen/);
  });
});

// ── The INSTANCE rule stays out of the stage-2 prompt ─────────────────────────────────────────────
// A prose rule "a named instance of what was asked is direct, not adjacent" does not change the
// model's reading on the same evidence, so it is kept out of prompts/fit-stage2.mjs. These tests stop
// it drifting back in unnoticed.
describe("the failed INSTANCE rule stays out of the stage-2 prompt", () => {
  const src = readFileSync(new URL("../prompts/fit-stage2.mjs", import.meta.url), "utf8");
  const body = src.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");

  it("the rule is ABSENT from the prompt the model actually receives", () => {
    expect(body).not.toMatch(/A NAMED INSTANCE OF WHAT WAS ASKED/i);
    expect(body).not.toMatch(/FastAPI or Django is/i);
  });

  it("the evidence-strength rules are untouched", () => {
    expect(body).toMatch(/"self-reported" — the ONLY support is that they say so/);
    expect(body).toMatch(/Docker when they ask Kubernetes -> partial, not met/);
    expect(body).toMatch(/When two could apply, pick the WEAKER one/);
  });

  it("no keyword or regex classifier over evidence prose was introduced anywhere", () => {
    for (const f of [/new RegExp/, /\.test\(/, /\.match\(/, /includes\(/])
      expect(src).not.toMatch(f);
  });
});

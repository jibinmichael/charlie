// position.test.mjs — the Position is grounded, fails closed, and reaches no reader.
//
// The field is computed and stored; nothing renders it yet. These tests pin the three things that
// would hurt a real person if they broke:
//
//   1. uncertainty must ship NOTHING, at every step
//   2. the builder must never see the raw resume, only already-grounded dossier facts
//   3. writing the field must not change a candidate's status (the saveDossier trap)
//
// The model's TASTE is not tested here — whether a sentence is any good is judged by a human reading
// a sample. What is testable is the machinery around it, and that is what this covers.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { buildPosition, hasEnoughToPosition, factsFor } from "./lib/position.mjs";
import { PositionBuild, PositionVerdict, StoredPosition } from "./lib/schemas/position.mjs";
import { POSITION_BUILD_SYSTEM } from "./prompts/position-build.mjs";
import { POSITION_VERIFY_SYSTEM } from "./prompts/position-verify.mjs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

const DOSSIER = {
  headline: "Product designer working on AI review workflows",
  strengths: ["Designing for uncertainty", "Design systems"],
  proof_points: [
    { claim: "Built the human review surface for an AI CX system processing 2M+ conversations", source: "resume" },
    { claim: "Designed a rule builder powering 5M automations a month", source: "resume" },
  ],
  case_studies: [],
  employers: [{ name: "Acme" }],
};

// A client that replies with whatever we hand it, so every failure mode is reachable without a network.
const fakeClient = (replies) => {
  let i = 0;
  return { messages: { create: async () => {
    const r = replies[Math.min(i++, replies.length - 1)];
    if (r instanceof Error) throw r;
    return { content: [{ type: "text", text: typeof r === "string" ? r : JSON.stringify(r) }], usage: { input_tokens: 10, output_tokens: 10 } };
  } } };
};
const GOOD_BUILD = { statement: "You build the surfaces where a person checks what a model just did.", evidence: [{ claim: "Built the human review surface for an AI CX system", source: "resume" }] };
const OK = { grounded: true, violations: [], reason: "traces" };

describe("uncertainty ships nothing", () => {
  it("a verifier that rejects drops the position", async () => {
    const r = await buildPosition(DOSSIER, { client: fakeClient([GOOD_BUILD, { grounded: false, violations: ["2 job title"], reason: "names a title" }]) });
    expect(r.position).toBeNull();
    expect(r.reason).toMatch(/rejected/);
  });

  it("a verifier that cannot be read is NOT an approval", async () => {
    const r = await buildPosition(DOSSIER, { client: fakeClient([GOOD_BUILD, "not json at all"]) });
    expect(r.position).toBeNull();
    expect(r.reason).toMatch(/fail closed/);
  });

  it("a builder that returns junk twice drops the position", async () => {
    const r = await buildPosition(DOSSIER, { client: fakeClient(["{{{", "{{{"]) });
    expect(r.position).toBeNull();
  });

  it("an API error drops the position rather than throwing at the caller", async () => {
    const r = await buildPosition(DOSSIER, { client: fakeClient([new Error("529 overloaded")]) });
    expect(r.position).toBeNull();
  });

  it("AN EMPTY STATEMENT IS A CORRECT ANSWER, not a retry", async () => {
    // The prompt is told to return "" when the facts are too thin. That must store nothing and must
    // not be dressed up as a failure.
    const r = await buildPosition(DOSSIER, { client: fakeClient([{ statement: "", evidence: [] }]) });
    expect(r.position).toBeNull();
    expect(r.reason).toMatch(/declined/);
  });

  it("a statement with no evidence is dropped, however good it sounds", async () => {
    const r = await buildPosition(DOSSIER, { client: fakeClient([{ statement: "You do great work.", evidence: [] }]) });
    expect(r.position).toBeNull();
  });

  it("a thin dossier never spends a build call at all", async () => {
    let calls = 0;
    const counting = { messages: { create: async () => { calls++; return { content: [{ type: "text", text: "{}" }] }; } } };
    const r = await buildPosition({ headline: "x", proof_points: [] }, { client: counting });
    expect(r.position).toBeNull();
    expect(calls).toBe(0);
  });

  it("the happy path stores the sentence, its evidence and its provenance", async () => {
    const r = await buildPosition(DOSSIER, { client: fakeClient([GOOD_BUILD, OK]), now: () => "2026-08-12T00:00:00Z" });
    expect(r.position.statement).toBe(GOOD_BUILD.statement);
    expect(r.position.evidence.length).toBe(1);
    expect(r.position.at).toBe("2026-08-12T00:00:00Z");
    expect(StoredPosition.safeParse(r.position).success).toBe(true);
  });
});

describe("the builder cannot see anything ungrounded", () => {
  it("factsFor passes ONLY already-grounded dossier fields, never a resume", () => {
    const f = factsFor({ ...DOSSIER, resume_text: "SECRET RAW RESUME", preferences: { comp_floor: 99 } });
    expect(Object.keys(f).sort()).toEqual(["case_studies", "employers", "headline", "proof_points", "strengths"]);
    expect(JSON.stringify(f)).not.toContain("SECRET RAW RESUME");
    expect(JSON.stringify(f)).not.toContain("99");
  });

  it("no caller passes a resume into the position build", () => {
    const src = read("./lib/position.mjs") + read("./scripts/backfill-positions.mjs");
    expect(src).not.toMatch(/getResume/);
    expect(src).not.toMatch(/resumeText/);
  });

  it("hasEnoughToPosition needs real evidence, not just a headline", () => {
    expect(hasEnoughToPosition({ headline: "x" })).toBe(false);
    expect(hasEnoughToPosition({ headline: "x", proof_points: [1, 2] })).toBe(true);
    expect(hasEnoughToPosition(null)).toBe(false);
  });
});

describe("the bans are stated to the builder AND checked by the verifier", () => {
  it("both prompts ban titles, levels, flattery and market claims", () => {
    for (const [name, p] of [["build", POSITION_BUILD_SYSTEM], ["verify", POSITION_VERIFY_SYSTEM]]) {
      expect(p, `${name}: titles`).toMatch(/JOB TITLE/i);
      expect(p, `${name}: level`).toMatch(/LEVEL|SENIORITY/i);
      expect(p, `${name}: flattery`).toMatch(/FLATTER/i);
      expect(p, `${name}: market`).toMatch(/MARKET CLAIM/i);
    }
  });

  it("the build prompt handles the early-career case explicitly", () => {
    expect(POSITION_BUILD_SYSTEM).toMatch(/EARLY IN THEIR CAREER/i);
    expect(POSITION_BUILD_SYSTEM).toMatch(/Inflating a beginner/i);
  });

  it("the prompts carry a header", () => {
    for (const f of ["./prompts/position-build.mjs", "./prompts/position-verify.mjs"]) {
      const s = read(f);
      expect(s, f).toMatch(/\/\/ MODEL:/);
      expect(s, f).toMatch(/VALIDATED AT/);
    }
  });
});

describe("writing the field cannot hurt a live user", () => {
  const script = read("./scripts/backfill-positions.mjs");
  // Comments stripped for the "must NOT contain" assertions. Source comments may quote the very
  // expression being guarded against, so a raw match would fail on the explanation rather than on
  // the bug. engine-email.test.mjs does the same for the same reason.
  const code = script.split("\n").filter((l) => !/^\s*(\/\/|\*)/.test(l)).join("\n");

  it("THE saveDossier TRAP, and why the source-grep version of this test was worthless", () => {
    // THE saveDossier TRAP. Asserting the SOURCE contains `saveDossier(c.email, {...c.dossier,
    // position}, c.status)` is not enough: listActiveCandidates selects "email, dossier,
    // email_config, created_at" — NO status column — so `c.status` is `undefined` at runtime, a JS
    // default parameter fires on undefined, and every user written would flip to `screening`,
    // removing them from every send. The right CHARACTERS can be present while the VALUE is wrong,
    // so this asserts the two things that actually decide the outcome.

    // 1. The status passed is a literal, not a field read off a row that does not carry one.
    expect(script).toMatch(/saveDossier\(c\.email, \{ \.\.\.c\.dossier, position \}, "active"\)/);
    expect(code, "must not read a status the query never selected").not.toMatch(/c\.status/);

    // 2. The premise of that literal: the only source of users is listActiveCandidates, whose query
    // is .eq("status","active"). If a future edit widens the source, this must be revisited.
    expect(script).toMatch(/listActiveCandidates\(\)/);
    expect(code, "a wider source would invalidate the hardcoded status").not.toMatch(/listNewsletterCandidates|from\("candidates"\)/);
  });

  it("PROVES THE PREMISE: listActiveCandidates really does filter to active, and really does omit status", () => {
    // Both halves read from the store itself, so this test fails if either changes underneath us.
    const store = read("./charlie-store.mjs");
    const fn = store.slice(store.indexOf("export async function listActiveCandidates"), store.indexOf("export async function listNewsletterCandidates"));
    expect(fn, "the query must still be active-only").toMatch(/\.eq\("status", "active"\)/);
    expect(fn, "if status is ever SELECTED, prefer the row's own value again").not.toMatch(/select\([^)]*status/);
  });

  it("a re-run costs nothing: somebody already positioned is skipped", () => {
    // A long --apply run can be killed partway through. Resuming must not re-bill every person
    // already done.
    expect(script).toMatch(/!c\.dossier\?\.position\?\.statement/);
  });

  it("the merge is additive, so nothing a person told us is overwritten", () => {
    expect(script).toMatch(/\{ \.\.\.c\.dossier, position \}/);
  });

  it("it is DRY by default and needs --apply to write", () => {
    expect(script).toMatch(/const APPLY = process\.argv\.includes\("--apply"\)/);
    expect(script).toMatch(/if \(APPLY\)/);
  });

  it("it has a spend ceiling and isolates each record", () => {
    expect(script).toMatch(/MAX_USD/);
    expect(script).toMatch(/STOPPING/);
    expect(script).toMatch(/catch \(e\)[\s\S]{0,120}continuing/);
  });
});

describe("PHASE 1 REACHES NO READER", () => {
  it("no email template or send path reads the position's content", () => {
    // Deliberately precise. A bare /\.position\b/ matches `ROLE.box.position`, the advice box's
    // CSS token in render-email.mjs — a false positive that would make this test look like it was
    // protecting something while actually failing on a colour. `statement` is the unique marker:
    // it is the only field of a stored position anything would ever render.
    for (const f of ["./render-email.mjs", "./email-kit.mjs", "./composer.mjs", "./scheduler.mjs", "./first-role.mjs", "./prompts/composer.mjs"]) {
      const src = read(f);
      expect(src, `${f} reads position.statement`).not.toMatch(/position\??\.statement/);
      expect(src, `${f} reads dossier.position`).not.toMatch(/dossier\??\.position/);
    }
  });

  it("the position module is imported by the backfill script and nothing else", () => {
    for (const f of ["./scheduler.mjs", "./first-role.mjs", "./composer.mjs", "./render-email.mjs"]) {
      expect(read(f), f).not.toMatch(/lib\/position\.mjs/);
    }
    expect(read("./scripts/backfill-positions.mjs")).toMatch(/lib\/position\.mjs/);
  });
});

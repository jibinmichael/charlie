// inbound-not-job-search.test.mjs — a build that grounds NOTHING must not become an active user.
//
// `/inbound`'s content filter for a stranger's first email is a character count (`substantiveBio`,
// email-onboard.mjs). A sales solicitation can clear it and have a full dossier built on it — and the
// model correctly diagnoses "There is nothing here to describe." Without a gate on that result the
// pipeline would ignore its own diagnosis, save the row as "active", and mail it like a real user.
//
// The gate (`groundsNothing`) works on what was ALREADY computed — no classifier, no second model
// call, $0.
//
// WHY NOT `isThinDossier`: it requires proofs >= 2 AND a role AND a region (email-onboard.mjs). As a
// REJECT gate it would refuse a sparse-but-real person, breaking resume-optional onboarding and the
// "do NOT merge the two bars" rule in email-onboard.mjs. `groundsNothing` is deliberately STRICTLY
// NARROWER, and the containment test below is what pins that.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── the junk specimen: a solicitation email that produced an empty dossier ─────────────────────────
const JUNK_DOSSIER = {
  name: null,
  headline: "No professional information provided",
  narrative:
    "The provided material contains no resume content, work history, skills, or self-description. " +
    "Both the resume slot and the notes are copies of a solicitation email about selling a domain " +
    "name. There is nothing here to describe.",
  proof_points: [],
  case_studies: [],
  strengths: [],
  gaps: ["no resume content was provided"],
  preferences: {},
};

// ── the fence: sparse, but REAL. One grounded proof, one strength, no stated region. This person is
// `isThinDossier === true` and MUST still onboard — that is the resume-optional guarantee. ──
const SPARSE_BUT_REAL = {
  name: "Asha",
  headline: "Product designer",
  narrative: "Product designer who has shipped payments flows.",
  proof_points: [{ claim: "Designed the payments flow at Lumora", evidence: "their own words", source: "conversation" }],
  case_studies: [],
  strengths: ["product design"],
  gaps: [],
  preferences: { role: "Product Designer" }, // no remote / comp_floor / stage -> hasRegion false
};

let built = JUNK_DOSSIER;
const saveDossier = vi.fn(async () => true);
const uploadResume = vi.fn(async () => true);

vi.mock("./dossier-build.mjs", () => ({ buildDossier: vi.fn(async () => structuredClone(built)) }));
vi.mock("./url-ingest.mjs", () => ({ ingestUrls: vi.fn(async () => []) }));
vi.mock("./company-context.mjs", () => ({ enrichCompanyContext: vi.fn(async () => {}) }));
vi.mock("./charlie-store.mjs", () => ({
  saveDossier: (...a) => saveDossier(...a),
  uploadResume: (...a) => uploadResume(...a),
  getDossier: vi.fn(async () => null),
  getResume: vi.fn(async () => ""),
  markOnboardingCohort: vi.fn((d) => d),
}));
// extractPrefs runs a Haiku call; stub the SDK so it returns "no stated preferences".
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    constructor() {
      this.messages = { create: vi.fn(async () => ({ content: [{ type: "text", text: "{}" }] })) };
    }
  },
}));

const { onboardFromEmail, groundsNothing, isThinDossier } = await import("./email-onboard.mjs");
const { readFileSync } = await import("node:fs");

beforeEach(() => {
  saveDossier.mockClear();
  uploadResume.mockClear();
});

describe("onboardFromEmail — a build that grounded nothing must not go active", () => {
  it("THE REGRESSION: the domain-spam specimen must NOT be saved as an active candidate", async () => {
    built = JUNK_DOSSIER;
    await expect(
      onboardFromEmail("promo@example.invalid", "Buy this premium domain name today. Great investment opportunity for your brand. Contact us for pricing.", "Buy this premium domain name today."),
    ).rejects.toMatchObject({ code: "ungrounded" });

    // The load-bearing assertion: no candidate row, therefore no whatsnew, no daily role, no drips.
    expect(saveDossier).not.toHaveBeenCalled();
  });

  it("THE FENCE: a sparse-but-real person still onboards active,", async () => {
    built = SPARSE_BUT_REAL;
    const d = await onboardFromEmail("asha@example.invalid", "I'm a data analyst in Pune. Six years, mostly logistics. I built the delivery-time dashboards at Lumora.", "I'm a data analyst in Pune.");
    expect(d).toBeTruthy();
    expect(saveDossier).toHaveBeenCalledTimes(1);
    expect(saveDossier.mock.calls[0][2]).toBe("active");
  });
});

describe("groundsNothing — the predicate itself", () => {
  it("the junk specimen grounds nothing", () => {
    expect(groundsNothing(JUNK_DOSSIER)).toBe(true);
  });

  it("ANY single grounded item is enough to onboard — a proof, a strength, or a case study", () => {
    expect(groundsNothing({ ...JUNK_DOSSIER, proof_points: [{ claim: "Shipped X" }] })).toBe(false);
    expect(groundsNothing({ ...JUNK_DOSSIER, strengths: ["product design"] })).toBe(false);
    expect(groundsNothing({ ...JUNK_DOSSIER, case_studies: [{ title: "Payments" }] })).toBe(false);
  });

  it("does not count an empty-shaped proof or a blank strength as substance", () => {
    expect(groundsNothing({ ...JUNK_DOSSIER, proof_points: [{ evidence: "no claim key" }] })).toBe(true);
    expect(groundsNothing({ ...JUNK_DOSSIER, strengths: ["", "   "] })).toBe(true);
  });

  it("fails closed on a missing or malformed dossier", () => {
    for (const bad of [null, undefined, "", 0, "a string", []]) expect(groundsNothing(bad)).toBe(true);
  });

  it("survives a dossier whose arrays are the wrong type (never throws)", () => {
    expect(groundsNothing({ proof_points: "nope", strengths: null, case_studies: 7 })).toBe(true);
  });
});

// THE CONTAINMENT PROPERTY: SPARSE_BUT_REAL is thin AND must still onboard, so the two predicates
// cannot be the same one. If someone later "simplifies" groundsNothing into isThinDossier, this fails.
describe("groundsNothing is STRICTLY NARROWER than isThinDossier", () => {
  it("the sparse-but-real person is THIN but is NOT ungrounded", () => {
    expect(isThinDossier(SPARSE_BUT_REAL)).toBe(true);
    expect(groundsNothing(SPARSE_BUT_REAL)).toBe(false);
  });

  it("anything that grounds nothing is also thin (containment holds, never the reverse)", () => {
    for (const d of [JUNK_DOSSIER, { ...JUNK_DOSSIER, preferences: { role: "PM", remote: "remote" } }]) {
      if (groundsNothing(d)) expect(isThinDossier(d)).toBe(true);
    }
  });
});

// The wiring: a source-level assertion in the style of resume-optional-onboarding.test.mjs.
// The unit tests above prove the predicate; these prove it is actually CONNECTED, and connected to
// the ask rather than to the retry queue.
describe("/inbound routes an ungrounded build to the ask, not to the retry queue", () => {
  const SERVER = readFileSync(new URL("./server/charlie-remote.ts", import.meta.url), "utf8");

  it("the onboarding branch checks e.code === \"ungrounded\"", () => {
    expect(SERVER).toMatch(/ungrounded\s*=\s*e\?\.code === "ungrounded"/);
  });

  it("an ungrounded build replies renderMissingResume and returns BEFORE onboardBuildFailed", () => {
    const branch = SERVER.slice(SERVER.indexOf("if (resumeText && !existing)"));
    const ask = branch.indexOf("renderMissingResume");
    const buildFailed = branch.indexOf("await onboardBuildFailed()");
    expect(ask).toBeGreaterThan(-1);
    expect(buildFailed).toBeGreaterThan(-1);
    expect(ask).toBeLessThan(buildFailed); // the ungrounded return must come first
  });

  it("onboard_retry does NOT reschedule an ungrounded build (no 3x Opus on spam)", () => {
    expect(SERVER).toMatch(/}\s*else if \(!ungrounded && attempt < MAX\)/);
  });
});

// company-context.test.mjs — behaviour guard for past-employer domain enrichment (no live API).
//
// The things that must hold:
//   1. DARK SWITCH / byte-identical: with COMPANY_CONTEXT unset, finalizeEmployers strips any `employers`
//      key and enrichCompanyContext is a no-op (no lookup, no save).
//   2. GROUNDING (never-invent): finalizeEmployers keeps ONLY employer names present verbatim in the resume;
//      an invented/normalized name is dropped.
//   3. NEVER-UPGRADE: a company's domain is attached ONLY as context on the employer entry; it is
//      NEVER promoted into strengths/proof_points/narrative/headline. A resume with an employer but no
//      ticketing work must not yield any "ticketing" claim about the person.
//   4. FAIL-OPEN: a missing/failed/empty lookup leaves the dossier untouched and never throws.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { finalizeEmployers } from "./dossier-build.mjs";

// --- Mock the store + the company-research tool so enrichCompanyContext runs deterministically. ---
const h = vi.hoisted(() => ({
  candidate: null,
  saved: null,
  lookup: null, // (name) => insight|null, or a fn that throws
}));

vi.mock("./charlie-store.mjs", () => ({
  getCandidate: vi.fn(async () => h.candidate),
  saveDossier: vi.fn(async (_email, dossier, status) => { h.saved = { dossier, status }; }),
}));
vi.mock("./composer.mjs", () => ({
  lookupCompany: vi.fn(async (name) => (typeof h.lookup === "function" ? h.lookup(name) : null)),
}));

const { enrichCompanyContext } = await import("./company-context.mjs");
const store = await import("./charlie-store.mjs");
const composer = await import("./composer.mjs");

const RESUME = "Maya Okonkwo\nProduct designer, 6 years. Designed the onboarding flow at Lumora. Built dashboards at Acme Corp.";

// A dossier as buildDossier would produce it with the flag on: employers are grounded NAMES only, and the
// person's claims (strengths/proof_points/narrative/headline) say nothing about ticketing.
const makeDossier = () => ({
  name: "Maya Okonkwo",
  headline: "Product designer, 6 years",
  narrative: "Maya designed the onboarding flow at Lumora and built dashboards at Acme Corp.",
  proof_points: [{ claim: "designed the onboarding flow at Lumora", evidence: "resume", source: "resume" }],
  case_studies: [],
  strengths: ["design systems", "user research"],
  gaps: [],
  preferences: {},
  employers: [{ name: "Lumora" }, { name: "Acme Corp" }],
});

const ENV = process.env.COMPANY_CONTEXT;
beforeEach(() => {
  delete process.env.COMPANY_CONTEXT;
  h.candidate = null; h.saved = null; h.lookup = null;
  store.getCandidate.mockClear(); store.saveDossier.mockClear(); composer.lookupCompany.mockClear();
});
afterEach(() => { if (ENV === undefined) delete process.env.COMPANY_CONTEXT; else process.env.COMPANY_CONTEXT = ENV; });

describe("finalizeEmployers — dark switch (byte-identical when off)", () => {
  it("strips any employers field when the flag is off", () => {
    const d = finalizeEmployers(makeDossier(), RESUME);
    expect("employers" in d).toBe(false);
  });
  it("leaves an employers-less dossier untouched when off", () => {
    const d = finalizeEmployers({ headline: "x" }, RESUME);
    expect("employers" in d).toBe(false);
  });
});

describe("finalizeEmployers — grounding gate (flag on)", () => {
  beforeEach(() => { process.env.COMPANY_CONTEXT = "on"; });

  it("keeps names present verbatim in the resume and drops invented ones", () => {
    const d = finalizeEmployers(
      { headline: "x", employers: ["Lumora", "Acme Corp", "Imaginary Corp"] },
      RESUME,
    );
    const names = d.employers.map((e) => e.name);
    expect(names).toEqual(["Lumora", "Acme Corp"]); // Imaginary Corp never appears in the resume → dropped
  });

  it("normalizes to [{name}] and de-dups repeats", () => {
    const d = finalizeEmployers({ headline: "x", employers: ["Lumora", "lumora", { name: "Lumora" }] }, RESUME);
    expect(d.employers).toEqual([{ name: "Lumora" }]);
  });

  it("drops the field entirely when nothing is grounded (no empty ride-along)", () => {
    const d = finalizeEmployers({ headline: "x", employers: ["Nowhere Inc"] }, RESUME);
    expect("employers" in d).toBe(false);
  });
});

describe("enrichCompanyContext — dark switch", () => {
  it("is a no-op when the flag is off: no lookup, no save", async () => {
    h.candidate = { dossier: makeDossier(), status: "active" };
    const out = await enrichCompanyContext("maya@example.com");
    expect(out).toBeNull();
    expect(composer.lookupCompany).not.toHaveBeenCalled();
    expect(store.saveDossier).not.toHaveBeenCalled();
  });
});

describe("enrichCompanyContext — flag on", () => {
  beforeEach(() => { process.env.COMPANY_CONTEXT = "on"; });

  it("attaches the domain ONLY to the employer entry, never as a person-claim (never-upgrade)", async () => {
    h.candidate = { dossier: makeDossier(), status: "active" };
    // Lumora is event ticketing; the person did DESIGN there, not ticketing. The domain must not become a
    // "ticketing" capability about Maya. (If enrich ever pushed domain into strengths/proof_points, the
    // final assertion below would fail — that is the regression this test pins.)
    h.lookup = (name) => (name === "Lumora"
      ? { name: "Lumora", what: "event-ticketing SaaS" }
      : { name, what: "logistics analytics platform" });

    const out = await enrichCompanyContext("maya@example.com");
    expect(out).toBeTruthy();
    const lumora = out.employers.find((e) => e.name === "Lumora");
    expect(lumora.domain).toBe("event-ticketing SaaS"); // context lives on the entry
    expect(lumora.source).toBe("company-research");

    // No ticketing capability leaked into any claim ABOUT the person.
    const personClaims = JSON.stringify([out.strengths, out.proof_points, out.narrative, out.headline]);
    expect(personClaims.toLowerCase()).not.toContain("ticketing");
    expect(out.strengths).toEqual(["design systems", "user research"]); // strengths untouched

    // saved with the preserved status (never downgraded to the saveDossier default "screening").
    expect(store.saveDossier).toHaveBeenCalledTimes(1);
    expect(store.saveDossier.mock.calls[0][2]).toBe("active");
  });

  it("fails open when a lookup returns nothing: dossier untouched, no save", async () => {
    h.candidate = { dossier: makeDossier(), status: "active" };
    h.lookup = () => null; // no verified domain for any employer
    const out = await enrichCompanyContext("maya@example.com");
    expect(out).toBeNull();
    expect(store.saveDossier).not.toHaveBeenCalled();
  });

  it("fails open when a lookup throws: never throws up, no save", async () => {
    h.candidate = { dossier: makeDossier(), status: "active" };
    h.lookup = () => { throw new Error("web search down"); };
    const out = await enrichCompanyContext("maya@example.com");
    expect(out).toBeNull(); // nothing attached → no save, no throw
    expect(store.saveDossier).not.toHaveBeenCalled();
  });

  it("saves the partial result when only some employers resolve (per-employer isolation)", async () => {
    h.candidate = { dossier: makeDossier(), status: "active" };
    h.lookup = (name) => (name === "Lumora" ? { name, what: "event-ticketing SaaS" } : null);
    const out = await enrichCompanyContext("maya@example.com");
    expect(out.employers.find((e) => e.name === "Lumora").domain).toBe("event-ticketing SaaS");
    expect(out.employers.find((e) => e.name === "Acme Corp").domain).toBeUndefined(); // fail-open for the miss
    expect(store.saveDossier).toHaveBeenCalledTimes(1);
  });

  it("no-ops when the dossier has no grounded employers", async () => {
    const d = makeDossier(); delete d.employers;
    h.candidate = { dossier: d, status: "active" };
    const out = await enrichCompanyContext("maya@example.com");
    expect(out).toBeNull();
    expect(composer.lookupCompany).not.toHaveBeenCalled();
    expect(store.saveDossier).not.toHaveBeenCalled();
  });
});

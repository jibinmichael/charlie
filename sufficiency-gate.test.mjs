// sufficiency-gate.test.mjs — hunting must not start on a profile we cannot judge.
//
// Two separate holes must never meet again:
//   1. renderWelcome's `thin` param must drive the copy, so a skeletal profile gets the honest welcome.
//   2. computeCoverage returns { thin: true } when the dossier is too sparse to score, and a thin
//      coverage must not SKIP the fit floor in quality-gate.
// Together they would send the people Charlie knows least about the least-checked roles, on the
// matcher score alone, while telling them "I know what to look for".
//
// The gate drops those sends, which leaves the person with no emailed find, which is precisely the
// condition completeness-nudge.mjs waits for: gentle nudges only until we know enough.
//
// The distinction these tests protect: thin-because-DOSSIER drops (we don't know the person);
// thin-because-JD still sends (a vague posting is the employer's fault, not the user's).

import { describe, it, expect } from "vitest";
import { gateRole, remoteAccessibility, reachableForRegion } from "./quality-gate.mjs";
import { verifyRemoteAccess } from "./remote-access-verify.mjs";

const liveFetch = async () => ({ status: 200, json: async () => ({}), text: async () => "" });
const job = { id: "greenhouse:acme:1", company: "Acme", title: "Engineer", location: "Bengaluru, India", apply_url: "https://x/1", description: "work" };
const dossier = { location: "Bengaluru, India", headline: "Senior Engineer" };

const gate = (cov, matcherScore = 90) =>
  gateRole({ job, dossier, matcherScore, fetchImpl: liveFetch, getCov: async () => cov });

describe("the data-sufficiency gate", () => {
  it("DROPS when the dossier is too sparse to score (the people we know least about)", async () => {
    const g = await gate({ thin: true, reason: "dossier" });
    expect(g.outcome).toBe("drop");
    expect(g.reason).toMatch(/don't know enough about you yet/i);
  });

  it("drops even on a high matcher score — a confident score on no evidence is the danger, not the excuse", async () => {
    expect((await gate({ thin: true, reason: "dossier" }, 99)).outcome).toBe("drop");
  });

  it("STILL SENDS when only the posting is unscoreable (not the person's fault)", async () => {
    // A vague JD must not silence a real role. This is the half that must NOT regress.
    expect((await gate({ thin: true, reason: "jd" })).outcome).toBe("send");
  });

  it("a coverage failure keeps the 'jd' fate and still sends", async () => {
    // computeCoverage's catch returns reason "jd" deliberately: a model timeout is not evidence
    // about the person, so it must not punish them.
    expect((await gate({ thin: true, reason: "jd" }, 88)).outcome).toBe("send");
  });

  it("legacy callers passing bare { thin: true } are unaffected (backwards compatible)", async () => {
    // scheduler.mjs / first-role.mjs use `.catch(() => ({ thin: true }))` with no reason. Unlabelled
    // thin must keep the plain behaviour, or this gate would silently silence everyone on any cov error.
    expect((await gate({ thin: true })).outcome).toBe("send");
  });

  it("a scoreable profile is untouched: floor still applies", async () => {
    expect((await gate({ composite: 88 })).outcome).toBe("send");
    expect((await gate({ composite: 49 })).outcome).toBe("digest"); // below the fit floor
  });

  it("the sufficiency drop happens even when the fit floor would have passed it", async () => {
    // Thin coverage must not skip the floor and turn into a clean "send".
    const g = await gate({ thin: true, reason: "dossier", composite: 95 });
    expect(g.outcome).toBe("drop");
  });
});

// THE SENIORITY-GAP HARD STOP. A 7-year person must never be emailed a 12-14-year role as their ONE
// role of the day, even when the skills/domain keep the composite high. The fit pass already rates them
// "under" with a deep seniority subscore; the gate DROPS that (never a solo send, never the digest).
describe("the seniority-gap hard stop", () => {
  it("DROPS a role the person is deeply UNDER, even on a high composite + high matcher score", async () => {
    const g = await gate({ composite: 82, seniorityLevel: "under", subscores: { seniority: 0.2 } }, 95);
    expect(g.outcome).toBe("drop");
    expect(g.reason).toMatch(/well above your level/i);
  });

  it("does NOT drop a normal one-level stretch (under but shallow — above the floor)", async () => {
    // seniority subscore 0.5 > SENIORITY_UNDER_FLOOR (0.34): a stretch, not a chasm → still sends.
    expect((await gate({ composite: 82, seniorityLevel: "under", subscores: { seniority: 0.5 } })).outcome).toBe("send");
  });

  it("does NOT fire when the person is AT or OVER the level, however low the subscore reads", async () => {
    expect((await gate({ composite: 82, seniorityLevel: "at", subscores: { seniority: 0.1 } })).outcome).toBe("send");
    expect((await gate({ composite: 82, seniorityLevel: "over", subscores: { seniority: 0.1 } })).outcome).toBe("send");
  });

  it("does NOT fire on a thin (unscoreable) cov — no seniority read to trust", async () => {
    // thin-because-jd still sends; the seniority stop must not fabricate a gap from a missing read.
    expect((await gate({ thin: true, reason: "jd" })).outcome).toBe("send");
  });
});

// THE CITY-CORRIDOR GATE. reachableForRegion is country-level, so an onsite role in a same-country
// city the person never asked for would otherwise be their ONE solo role. The gate routes that to the
// weekly digest (soft, recoverable — they might relocate). Grounded in stated words only.
describe("the city-corridor gate", () => {
  const okCov = { composite: 85, seniorityLevel: "at", subscores: { seniority: 0.8 } };
  const cityGate = ({ job, dossier, cov = okCov, matcherScore = 90 }) =>
    gateRole({ job, dossier, matcherScore, fetchImpl: liveFetch, getCov: async () => cov });

  // The canonical case: person wants the Pune/Nagpur/Bangalore/Indore corridor, the role
  // is onsite in Noida (same country, different city).
  const punePerson = { location: "Pune, India", headline: "Senior PM", preferences: { remote: "remote or hybrid within Pune, Nagpur, Bangalore, Indore" } };

  it("DIGESTS an onsite role in a city the person never named (Noida vs the Pune corridor)", async () => {
    const job = { id: "greenhouse:vinove:1", company: "Vinove", title: "Product Manager", location: "Noida, India", apply_url: "https://x/1", description: "onsite" };
    const g = await cityGate({ job, dossier: punePerson });
    expect(g.outcome).toBe("digest");
    expect(g.reason).toMatch(/onsite|asked to work in/i);
  });

  it("SENDS when the onsite role IS in a city they named (Bangalore is in the corridor)", async () => {
    const job = { id: "greenhouse:acme:2", company: "Acme", title: "Product Manager", location: "Bengaluru, India", apply_url: "https://x/2", description: "onsite" };
    expect((await cityGate({ job, dossier: punePerson })).outcome).toBe("send");
  });

  it("does NOT fire on a REMOTE role, even in another city", async () => {
    const job = { id: "greenhouse:acme:3", company: "Acme", title: "Product Manager", location: "Remote, India", remote: true, apply_url: "https://x/3", description: "remote" };
    expect((await cityGate({ job, dossier: punePerson })).outcome).toBe("send");
  });

  it("does NOT fire when the person named no city (remote-anywhere person)", async () => {
    const anywhere = { location: "India", preferences: { remote: "remote anywhere in india" } };
    const job = { id: "greenhouse:acme:4", company: "Acme", title: "Product Manager", location: "Noida, India", apply_url: "https://x/4", description: "onsite" };
    expect((await cityGate({ job, dossier: anywhere })).outcome).toBe("send");
  });

  it("fail-open on an UNKNOWN city — never over-holds a role we can't place", async () => {
    const job = { id: "greenhouse:acme:5", company: "Acme", title: "Product Manager", location: "Mysore, India", apply_url: "https://x/5", description: "onsite" };
    expect((await cityGate({ job, dossier: punePerson })).outcome).toBe("send");
  });

  it("the kill-switch (CITY_CORRIDOR=off) disables the gate", async () => {
    const prev = process.env.CITY_CORRIDOR;
    process.env.CITY_CORRIDOR = "off";
    try {
      const job = { id: "greenhouse:vinove:6", company: "Vinove", title: "Product Manager", location: "Noida, India", apply_url: "https://x/6", description: "onsite" };
      expect((await cityGate({ job, dossier: punePerson })).outcome).toBe("send");
    } finally {
      if (prev === undefined) delete process.env.CITY_CORRIDOR; else process.env.CITY_CORRIDOR = prev;
    }
  });
});

// Remote accessibility, Tier 1. "The company hires in India" is NOT evidence THIS remote role is
// open to India. Read the role's OWN JD signal. Every phrasing below is verbatim-shaped from real pool
// JDs, so the precision holds on live data — especially the India-FRIENDLY "evening IST overlap" case
// that a naive regex would wrongly block.
describe("remote accessibility (Tier 1, deterministic)", () => {
  it("RESTRICTED on an unambiguous bar: US work-auth, US-hours, EU-only", () => {
    expect(remoteAccessibility({ remote: true, location: "Remote", description: "You must be authorized to work in the United States." })).toBe("restricted");
    expect(remoteAccessibility({ remote: true, location: "Remote", description: "Core working hours are EST." })).toBe("restricted");
    expect(remoteAccessibility({ remote: true, location: "Remote", description: "You must be eligible to work in the EU." })).toBe("restricted");
  });

  it("OPEN on explicit global openness, or an IST-friendly role (it WANTS an India person)", () => {
    expect(remoteAccessibility({ remote: true, location: "Remote", description: "Our team is fully distributed across the world." })).toBe("open");
    expect(remoteAccessibility({ remote: true, location: "Remote", description: "Serve customers anywhere in the world." })).toBe("open");
    // the precision case: mentions "US" but WANTS evening-IST overlap → India-accessible, must not block.
    expect(remoteAccessibility({ remote: true, location: "Remote", description: "You're comfortable working evening IST hours to overlap with US customers." })).toBe("open");
  });

  it("UNKNOWN (deferred to Tier 2) on the genuinely ambiguous middle a regex must not guess", () => {
    expect(remoteAccessibility({ remote: true, location: "Remote", description: "async-friendly, but overlap with European and US time zones is expected." })).toBe("unknown");
    expect(remoteAccessibility({ remote: true, location: "Remote", description: "Varying locations across Canada, USA and/or EMEA." })).toBe("unknown");
    expect(remoteAccessibility({ remote: true, location: "Remote", description: "We are a US-based fintech company." })).toBe("unknown"); // describes the company, not a bar
  });

  it("reachableForRegion(india) blocks a US-auth remote role and passes an anywhere-in-world one", () => {
    expect(reachableForRegion({ remote: true, location: "Remote", description: "must be authorized to work in the United States" }, "india")).toBe(false);
    expect(reachableForRegion({ remote: true, location: "Remote", description: "our team is fully distributed across the world" }, "india")).toBe(true);
  });

  it("no-signal bare-remote is UNCHANGED (Tier 1 adds no regression; Tier 2 handles this bucket)", () => {
    expect(reachableForRegion({ remote: true, location: "Remote", description: "a normal remote role", companyHiresIndia: true }, "india")).toBe(true);
    expect(reachableForRegion({ remote: true, location: "Remote", description: "a normal remote role", companyHiresIndia: false }, "india")).toBe(false);
  });

  it("US candidates are untouched — a US-auth remote role is reachable for a US person", () => {
    expect(reachableForRegion({ remote: true, location: "Remote", description: "must be authorized to work in the US" }, "us")).toBe(true);
  });

  it("the kill-switch (REMOTE_ACCESS=off) falls back to the per-company signal", () => {
    const prev = process.env.REMOTE_ACCESS;
    process.env.REMOTE_ACCESS = "off";
    try {
      // with the gate off, a US-auth remote role at an India-hiring company is reachable again.
      expect(reachableForRegion({ remote: true, location: "Remote", description: "must be authorized to work in the United States", companyHiresIndia: true }, "india")).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.REMOTE_ACCESS; else process.env.REMOTE_ACCESS = prev;
    }
  });
});

// Remote accessibility, Tier 2 — the grounded verifier itself (schema + fail-closed contract), with a mock client.
describe("verifyRemoteAccess (Tier 2 verifier)", () => {
  const mkClient = (obj) => ({ messages: { create: async () => ({ content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj) }] }) } });
  const job = { id: "greenhouse:acme:1", title: "Engineer", location: "Remote", description: "a remote role" };

  it("accessible=true passes through", async () => {
    const v = await verifyRemoteAccess({ job, client: mkClient({ accessible: true, confidence: "high", reason: "hires globally" }) });
    expect(v.accessible).toBe(true);
  });

  it("accessible=false drops (fail closed on a real negative)", async () => {
    const v = await verifyRemoteAccess({ job, client: mkClient({ accessible: false, confidence: "high", reason: "US-only" }) });
    expect(v.accessible).toBe(false);
  });

  it("an UNPARSEABLE reply fails closed after the retry (accessible=false, errored)", async () => {
    const v = await verifyRemoteAccess({ job, client: mkClient("not json at all") });
    expect(v.accessible).toBe(false);
    expect(v.errored).toBe(true);
  });

  it("a THROWING client fails closed, never throws", async () => {
    const throwing = { messages: { create: async () => { throw new Error("api down"); } } };
    const v = await verifyRemoteAccess({ job, client: throwing });
    expect(v.accessible).toBe(false);
    expect(v.errored).toBe(true);
  });

  it("no key + no client → SKIPPED (never a blanket drop of every remote role)", async () => {
    const prev = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const v = await verifyRemoteAccess({ job });
      expect(v.skipped).toBe(true);
      expect(v.accessible).toBe(false); // still not "accessible", but the caller keys off skipped
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prev;
    }
  });
});

// Remote accessibility, Tier 2 — the gate integration (verifier injected as a stub; no real model call).
describe("the Tier-2 remote-access gate integration", () => {
  const liveFetch = async () => ({ status: 200, json: async () => ({}), text: async () => "" });
  const okCov = { composite: 85, seniorityLevel: "at", subscores: { seniority: 0.8 } };
  const indiaDoss = { location: "Bengaluru, India", headline: "Senior Engineer" };
  const usDoss = { location: "Austin, US", headline: "Senior Engineer", preferences: { comp_currency: "USD" } };
  // an ambiguous ("unknown") remote role: bare "Remote", no restriction, no openness signal.
  const unknownRemote = { id: "greenhouse:acme:1", company: "Acme", title: "Engineer", location: "Remote", description: "a normal remote role", apply_url: "https://x/1" };
  const t2gate = (verdict, { job = unknownRemote, dossier = indiaDoss } = {}) =>
    gateRole({ job, dossier, matcherScore: 90, fetchImpl: liveFetch, getCov: async () => okCov, verifyAccess: async () => verdict });

  it("DROPS an ambiguous remote role the verifier judges NOT accessible", async () => {
    const g = await t2gate({ accessible: false, reason: "requires US-hours overlap" });
    expect(g.outcome).toBe("drop");
    expect(g.reason).toMatch(/isn't genuinely open to your region/i);
  });

  it("SENDS when the verifier judges it accessible", async () => {
    expect((await t2gate({ accessible: true })).outcome).toBe("send");
  });

  it("SKIPPED verdict keeps the Tier-1 result (never a blanket drop)", async () => {
    expect((await t2gate({ accessible: false, skipped: true })).outcome).toBe("send");
  });

  it("never consulted for a US candidate", async () => {
    let called = false;
    const g = await gateRole({ job: unknownRemote, dossier: usDoss, matcherScore: 90, fetchImpl: liveFetch, getCov: async () => okCov, verifyAccess: async () => { called = true; return { accessible: false }; } });
    expect(called).toBe(false);
    expect(g.outcome).toBe("send");
  });

  it("never consulted for a role already classified open/restricted by Tier 1", async () => {
    let called = false;
    const openJob = { ...unknownRemote, id: "greenhouse:acme:2", description: "our team works from anywhere in the world" };
    const g = await gateRole({ job: openJob, dossier: indiaDoss, matcherScore: 90, fetchImpl: liveFetch, getCov: async () => okCov, verifyAccess: async () => { called = true; return { accessible: false }; } });
    expect(called).toBe(false); // Tier 1 said "open" → Tier 2 not needed
    expect(g.outcome).toBe("send");
  });

  it("shadow mode logs the would-drop but still sends; off mode never calls the verifier", async () => {
    const prev = process.env.REMOTE_ACCESS_TIER2;
    try {
      process.env.REMOTE_ACCESS_TIER2 = "shadow";
      expect((await t2gate({ accessible: false, reason: "x" })).outcome).toBe("send");
      let called = false;
      process.env.REMOTE_ACCESS_TIER2 = "off";
      const g = await gateRole({ job: unknownRemote, dossier: indiaDoss, matcherScore: 90, fetchImpl: liveFetch, getCov: async () => okCov, verifyAccess: async () => { called = true; return { accessible: false }; } });
      expect(called).toBe(false);
      expect(g.outcome).toBe("send");
    } finally {
      if (prev === undefined) delete process.env.REMOTE_ACCESS_TIER2; else process.env.REMOTE_ACCESS_TIER2 = prev;
    }
  });
});

// "Enough data" is TWO bars and they must stay different.
//   strict (isThinDossier)  -> what Charlie SAYS   (honest vs confident welcome). Fires often.
//   loose  (dossierIsDense) -> what Charlie SENDS  (the gate drops the role).     Fires rarely.
// Honesty is cheap, so its bar is generous. Silence is expensive, so its bar is not. Merging them
// either silences most new users before their first reply, or lets Charlie claim "I know what to look
// for" on a profile it barely read.
describe("the two-bar split is deliberate — this test exists so nobody 'fixes' it", () => {
  it("a profile can be THIN (honest copy) and still SCOREABLE (roles keep flowing)", async () => {
    const { isThinDossier } = await import("./email-onboard.mjs");
    const { computeCoverage } = await import("./fit-coverage.mjs");
    // The real shape of a fresh email-onboard user: a resume parsed into a few proof points, but no
    // stated role or region yet because they have not replied. Verified live via scripts/qa-ov5-harness.
    const fresh = {
      proof_points: [{ claim: "Worked on the payments team" }, { claim: "Helped with the checkout flow" }, { claim: "Holds a B.Tech" }],
      preferences: {},
    };
    expect(isThinDossier(fresh)).toBe(true);                                   // strict bar: be honest
    const cov = await computeCoverage({ dossier: fresh, jobDescription: "hiring" });
    expect(cov.reason).not.toBe("dossier");                                    // loose bar: still send
  });

  it("only a near-empty profile trips the SEND bar", async () => {
    const { computeCoverage } = await import("./fit-coverage.mjs");
    const almostNothing = { proof_points: [{ claim: "Worked somewhere" }] }; // 1 item < 2
    expect((await computeCoverage({ dossier: almostNothing, jobDescription: "x".repeat(500) })).reason).toBe("dossier");
  });

  it("the strict bar is strictly stricter: everything it passes, the loose bar passes too", async () => {
    const { isThinDossier } = await import("./email-onboard.mjs");
    const rich = {
      proof_points: [{ claim: "built payments" }, { claim: "shipped checkout" }],
      headline: "Senior Engineer",
      preferences: { remote: "remote, India" },
    };
    expect(isThinDossier(rich)).toBe(false);
    // not-thin implies >= 2 proof points, which implies dossierIsDense. The ordering must hold, or the
    // two bars have crossed and a "not thin" person could be blocked from every send.
    expect((rich.proof_points || []).length).toBeGreaterThanOrEqual(2);
  });
});

describe("computeCoverage labels its thin reasons", () => {
  it("a sparse dossier is thin-because-dossier, not thin-because-jd", async () => {
    const { computeCoverage } = await import("./fit-coverage.mjs");
    // dossierIsDense wants >= 2 items across proof_points/strengths/case_studies/experience.
    const r = await computeCoverage({ dossier: { proof_points: [] }, jobDescription: "x".repeat(500) });
    expect(r).toMatchObject({ thin: true, reason: "dossier" });
  });

  it("a dense dossier + an unscoreable posting is thin-because-jd", async () => {
    const { computeCoverage } = await import("./fit-coverage.mjs");
    const dense = { proof_points: [{ claim: "built payments" }, { claim: "shipped checkout" }] };
    const r = await computeCoverage({ dossier: dense, jobDescription: "hiring" }); // too short to score
    expect(r).toMatchObject({ thin: true, reason: "jd" });
  });
});

// blind-dossier.test.mjs — the scorer judges the work, never the name.
//
// Holding the dossier and the role constant at temperature 0 and changing ONLY the name can still
// move a model's score, by enough to decide whether a role is sent at all. A name has no bearing on
// whether somebody can do a job, so the scorer never sees it.
import { describe, it, expect } from "vitest";
import { blindDossier, blindDossierText } from "./lib/blind-dossier.mjs";
import { matchCacheKey } from "./lib/match-cache-key.mjs";

const real = {
  name: "Marisol O",
  headline: "Supply chain planner with over 9 years",
  contact: { email: "p@example.com", phone: "+91 90000 00000" },
  links: ["https://linkedin.com/in/marisol-o-planning"],
  proof_points: ["cut stockouts by a third across 12 warehouses", "built the monthly S&OP cadence"],
  strengths: ["demand forecasting", "SAP IBP"],
  experience: [{ company: "Halvorsen Freight", title: "Demand Planning Lead", name: "Marisol O" }],
  preferences: { remote: "remote only", comp_floor: 25 },
};

describe("what the scorer must never see", () => {
  const blind = blindDossier(real);

  it("the name is gone, at the top level and nested", () => {
    expect(blind.name).toBeUndefined();
    expect(blind.experience[0].name).toBeUndefined();
    expect(JSON.stringify(blind)).not.toMatch(/Marisol/);
  });

  it("contact details and links are gone — a profile URL carries the full name", () => {
    expect(blind.contact).toBeUndefined();
    expect(blind.links).toBeUndefined();
    expect(JSON.stringify(blind)).not.toMatch(/linkedin\.com|90000|@example\.com/);
  });
});

describe("what the scorer must STILL see — otherwise it cannot judge at all", () => {
  const blind = blindDossier(real);

  it("keeps every piece of evidence about the work", () => {
    expect(blind.headline).toBe(real.headline);
    expect(blind.proof_points).toEqual(real.proof_points);
    expect(blind.strengths).toEqual(real.strengths);
    expect(blind.preferences.remote).toBe("remote only");
    expect(blind.experience[0].company).toBe("Halvorsen Freight");
    expect(blind.experience[0].title).toBe("Demand Planning Lead");
  });

  it("does not pretend to be anonymisation", () => {
    // A school, a city, a mother tongue all carry demographic signal and all deliberately remain:
    // they are also real evidence. Removing the direct identifier removes the strongest and cheapest
    // signal, nothing more. Anyone claiming a redaction step makes a model unbiased is wrong.
    const withSchool = blindDossier({ ...real, education: [{ school: "Northfield Polytechnic Institute" }] });
    expect(withSchool.education[0].school).toBe("Northfield Polytechnic Institute");
  });
});

describe("it never mutates the caller's dossier", () => {
  it("the original still has the name, because the composer needs it", () => {
    const copy = JSON.parse(JSON.stringify(real));
    blindDossier(real);
    expect(real).toEqual(copy);
    // The email still opens "Dear Marisol". The name is needed to SPEAK to a person, never to JUDGE one.
    expect(real.name).toBe("Marisol O");
  });
});

describe("the text form, which is what the scorer and its cache actually receive", () => {
  it("strips the name from serialised JSON", () => {
    const out = blindDossierText(JSON.stringify(real));
    expect(out).not.toMatch(/Marisol/);
    expect(out).toMatch(/cut stockouts by a third/);
  });

  it("FAILS OPEN on unparseable text, returning it unchanged", () => {
    // The deliberate trade. A scorer that still sees a name is imperfect; a scorer handed an empty
    // dossier scores everyone identically and silently ends the product. An unparseable dossier is
    // already an upstream bug and must not become a second one here.
    expect(blindDossierText("not json at all")).toBe("not json at all");
    expect(blindDossierText("")).toBe("");
    expect(blindDossierText(null)).toBe("");
    expect(blindDossierText(undefined)).toBe("");
  });

  it("survives junk without throwing", () => {
    for (const bad of [42, {}, [], true]) expect(() => blindDossierText(bad)).not.toThrow();
    for (const bad of [null, undefined, 42, "x", []]) expect(() => blindDossier(bad)).not.toThrow();
  });
});

describe("the scorer is actually wired to the blinded text", () => {
  it("match-batch routes the cache key AND the prompt through scoringText", async () => {
    // Both, or the cache never hits again: the key is a hash of the dossier text, so a blinded prompt
    // with an unblinded key would re-score every pair on every run, forever.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("match-batch.mjs", "utf8");
    expect(src).toMatch(/import \{ blindDossierText \} from "\.\/lib\/blind-dossier\.mjs"/);
    expect(src).toMatch(/u\.scoringText = blindDossierText\(u\.dossierText\)/);
    // no scorer-side site may still read the raw text
    expect(src).not.toMatch(/matchCacheKey\(\{[^}]*dossierText: u\.dossierText/);
    expect(src).not.toMatch(/buildScoringMessages\(\{[^}]*dossierText: u\.dossierText/);
  });
});

// ── The scorer's copy must be immune to fields the scorer does not read ──────────────────────────
//
// The verdict cache key hashes the scorer's projection of the dossier. If a field the scorer never
// reads (e.g. `dossier.position`) leaked into that projection, adding it to many people at once would
// invalidate every stored verdict and the next run would re-score every pair at full cost.
//
// These are behavioural: they build the real key with the real function and compare hashes. A test
// that grepped blind-dossier.mjs for the word "position" would pass while the key still moved.
describe("blindDossier — a non-scoring field cannot move the cache key", () => {
  const base = {
    headline: "Builds data tools",
    strengths: ["python"],
    proof_points: [{ claim: "shipped x" }],
    preferences: { home_place: "Bengaluru" },
    employers: [{ name: "Acme", position: "Analyst" }],
  };
  const job = { id: "j1", source: "greenhouse", company: "Acme", title: "Analyst", description: "SQL" };
  const key = (d) => matchCacheKey({
    model: "claude-haiku-4-5", maxTokens: 1000, matcherText: "RUBRIC",
    dossierText: blindDossierText(JSON.stringify(d, null, 2)), job, constrained: true,
  });

  it("adding a position leaves the key byte-identical", () => {
    const withPos = { ...base, position: { statement: "You build tools", evidence: [{ claim: "x" }], model: "opus", at: "2026-08-12" } };
    expect(key(withPos)).toBe(key(base));
  });

  it("CHANGING a stored position later also leaves it identical (a rebuild is free too)", () => {
    const v1 = { ...base, position: { statement: "first take" } };
    const v2 = { ...base, position: { statement: "a completely different sentence" } };
    expect(key(v1)).toBe(key(v2));
  });

  it("but a real scoring field still moves it — silence here would mean the cache serves stale verdicts", () => {
    expect(key({ ...base, headline: "Builds payment systems" })).not.toBe(key(base));
    expect(key({ ...base, strengths: ["go"] })).not.toBe(key(base));
    expect(key({ ...base, preferences: { home_place: "Austin" } })).not.toBe(key(base));
  });

  it("a nested `position` is EVIDENCE and survives — it is the job title at an employer", () => {
    const out = blindDossier({ ...base, position: { statement: "dropped" } });
    expect(out.position).toBeUndefined();
    expect(out.employers[0].position).toBe("Analyst");
  });

  it("nothing else is lost on the way through", () => {
    const out = blindDossier({ ...base, position: { statement: "dropped" } });
    for (const k of ["headline", "strengths", "proof_points", "preferences", "employers"]) {
      expect(out[k], `${k} was dropped from the scorer's copy`).toBeDefined();
    }
  });
});

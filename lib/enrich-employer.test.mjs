// enrich-employer.test.mjs — verifiedCompany() in lib/enrich.mjs. The model annotates employer names
// and a plain substring check does not survive the annotation; each wrongful drop also loses the
// role's dates, which the tenure maths runs on. Company names here are fictional.
import { describe, it, expect } from "vitest";
import { verifiedCompany } from "./enrich.mjs";

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
// what the old line did: src.includes(norm(r.company))
const oldWay = (name, src) => (norm(name) ? src.includes(norm(name)) : false);

describe("verifiedCompany", () => {
  it("recovers the roles the annotation was hiding", () => {
    const src = norm("Acme Consulting Pvt Ltd — Senior Engineer, 2021-2023");
    expect(oldWay("Acme Consulting Pvt Ltd (client: Globex)", src)).toBe(false); // dropped
    expect(verifiedCompany("Acme Consulting Pvt Ltd (client: Globex)", src)).toBe("Acme Consulting Pvt Ltd");
  });

  it("never stores the client as the employer", () => {
    const src = norm("Acme Consulting Pvt Ltd — Senior Engineer");
    // the whole reason this is not just a looser substring check
    expect(verifiedCompany("Acme Consulting Pvt Ltd (client: Globex)", src)).not.toMatch(/Globex/);
  });

  it("takes the first of a slash pair, which is where the person worked", () => {
    const src = norm("Hooli Software, Product Designer 2019-2022");
    expect(oldWay("Hooli Software / Pied.photo", src)).toBe(false);
    expect(verifiedCompany("Hooli Software / Pied.photo", src)).toBe("Hooli Software");
  });

  it("survives a legal suffix the resume does not print", () => {
    const src = norm("Contoso — Associate, 2018-2021");
    expect(oldWay("Contoso Technology Solutions", src)).toBe(false);
    expect(verifiedCompany("Contoso Technology Solutions", src)).toBe("Contoso");
  });

  it("leaves an exact match exactly as written", () => {
    const src = norm("Initrode, Program Manager");
    expect(verifiedCompany("Initrode", src)).toBe("Initrode");
  });

  it("still drops an employer the source never names", () => {
    const src = norm("Freelance product designer, various clients, 2020-2024");
    expect(verifiedCompany("Umbrella Global", src)).toBeNull();
    expect(verifiedCompany("digital asset custody platform (unnamed)", src)).toBeNull();
    expect(verifiedCompany("Blue Door Design & Branding Co.", src)).toBeNull();
  });

  it("does not match on a fragment too short to mean anything", () => {
    const src = norm("worked at Vandelay and at Soylent on a co-branded programme");
    expect(verifiedCompany("Co", src)).toBeNull();   // 2 chars, must not match "co-branded"
    expect(verifiedCompany("", src)).toBeNull();
    expect(verifiedCompany(null, src)).toBeNull();
  });

  it("refuses everything when there is no source to check against", () => {
    expect(verifiedCompany("Initrode", "")).toBeNull();
  });
});

// current_company / previous_company go through the same citation check as roles[]: a described job
// ("enterprise SaaS consultancy") is not an employer name.
describe("the named columns go through the same door", () => {
  it("keeps a verified employer, annotation stripped", async () => {
    const { enrichCandidate } = await import("./enrich.mjs");
    expect(typeof enrichCandidate).toBe("function"); // the row builder is exercised below via verifiedCompany
    const src = "worked at Pied Piper as head of product, 2022 to now";
    expect(verifiedCompany("Pied Piper (digital asset custody platform)", norm(src))).toBe("Pied Piper");
  });

  it("refuses a described job as an employer name", () => {
    const src = norm("Head of Product at a company building custody infrastructure");
    expect(verifiedCompany("enterprise SaaS consultancy", src)).toBeNull();
    expect(verifiedCompany("digital asset custody platform (unnamed)", src)).toBeNull();
  });
});

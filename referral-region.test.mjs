// referral-region.test.mjs — proves opening warm-intro referrals to all regions stays fail-closed.
//
// Three things must hold (the ask: open referrals to every region, but only when the contact clears
// a high-confidence, verified-only bar so a thin-data region goes SILENT, never wrong):
//   1. REGION FLAG (reversible + fail-closed default): referralRegionAllowed/referralStatus keep every
//      non-us region DARK until REFERRAL_REGIONS names it; an unknown/blank region is never allowed.
//   2. HIGH-CONFIDENCE GATE: a contact is surfaced ONLY when email-verified AND confidence >= the bar
//      AND it carries a LinkedIn. Low-confidence, no-LinkedIn, or unverified -> NO referral (null).
//   3. HAPPY PATH: a verified, high-confidence contact with a LinkedIn still attaches.
//
// No live network / no DB: the store is mocked and global fetch is stubbed with Hunter API shapes.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Force the Hunter provider (deterministic, single-call) and a known confidence bar BEFORE import,
// since MIN_CONFIDENCE and the provider choice are read at module load.
process.env.HUNTER_API_KEY = "test-key";
delete process.env.HUNTR_GTM_API_KEY;
process.env.REFERRAL_MIN_CONFIDENCE = "80";

const h = vi.hoisted(() => ({ emails: [], verifyStatus: "valid" }));

vi.mock("./charlie-store.mjs", () => ({
  getReferralCache: vi.fn(async () => null),           // cache miss -> live search
  recordReferralLookup: vi.fn(async () => {}),
  referralSearchesThisMonth: vi.fn(async () => 0),     // under the monthly cap
}));

const jsonResponse = (obj) => ({ ok: true, status: 200, json: async () => obj });
const fetchStub = vi.fn(async (url) => {
  const u = String(url);
  if (u.includes("domain-search")) return jsonResponse({ data: { domain: "acme.com", emails: h.emails } });
  if (u.includes("email-verifier")) return jsonResponse({ data: { status: h.verifyStatus } });
  throw new Error(`unexpected fetch: ${u}`);
});
vi.stubGlobal("fetch", fetchStub);

const { findReferralContact } = await import("./referral-find.mjs");
const { referralRegionAllowed } = await import("./quality-gate.mjs");
const { referralStatus } = await import("./render-email.mjs");

// One Hunter contact whose title matches the role's function (so rankContacts keeps it).
const contact = (over = {}) => ({
  first_name: "Priya", last_name: "Nair", value: "priya.nair@acme.com",
  position: "Software Engineer", seniority: "senior", department: "it",
  confidence: 92, type: "personal", linkedin: "https://www.linkedin.com/in/priya-nair", ...over,
});

const find = () => findReferralContact({
  email: "user@example.com", company: "Acme", jobUrl: "", roleTitle: "Software Engineer",
  location: "San Francisco, CA", region: "us",
});

beforeEach(() => { h.emails = [contact()]; h.verifyStatus = "valid"; delete process.env.REFERRAL_REGIONS; });
afterEach(() => { fetchStub.mockClear(); });

describe("referralRegionAllowed — reversible, fail-closed region switch", () => {
  it("defaults to us-only: us allowed, india + other + blank blocked", () => {
    delete process.env.REFERRAL_REGIONS;
    expect(referralRegionAllowed("us")).toBe(true);
    expect(referralRegionAllowed("india")).toBe(false);
    expect(referralRegionAllowed("other")).toBe(false);
    expect(referralRegionAllowed("")).toBe(false);
    expect(referralRegionAllowed(undefined)).toBe(false);
  });
  it("opens india only when REFERRAL_REGIONS names it", () => {
    process.env.REFERRAL_REGIONS = "us,india";
    expect(referralRegionAllowed("india")).toBe(true);
    expect(referralRegionAllowed("us")).toBe(true);
    expect(referralRegionAllowed("other")).toBe(false); // still fail-closed for anything not listed
  });
});

describe("referralStatus — the render gate honours the same flag (no fail-to-zero)", () => {
  const ref = { name: "Priya Nair" };
  it("hides the box for india by default, shows it once the flag opens india", () => {
    delete process.env.REFERRAL_REGIONS;
    expect(referralStatus("india", ref)).toBe("hidden:region");
    process.env.REFERRAL_REGIONS = "us,india";
    expect(referralStatus("india", ref)).toBe("shown");
    expect(referralStatus("us", ref)).toBe("shown");
  });
});

describe("high-confidence gate — a wrong warm intro is unrecoverable, so fail closed", () => {
  it("attaches a verified, high-confidence contact WITH a LinkedIn", async () => {
    h.emails = [contact({ confidence: 92 })];
    h.verifyStatus = "valid";
    const r = await find();
    expect(r.none).toBeUndefined();
    expect(r.contact.name).toBe("Priya Nair");
    expect(r.contact.linkedin).toContain("linkedin.com");
    expect(r.contact.unverified).toBe(false);
  });

  it("returns NO referral when confidence is below the bar", async () => {
    h.emails = [contact({ confidence: 50 })]; // < 80, everything else fine
    h.verifyStatus = "valid";
    const r = await find();
    expect(r.none).toBe(true);
    expect(r.reason).toBe("low_confidence");
  });

  it("returns NO referral when the contact has no LinkedIn", async () => {
    h.emails = [contact({ confidence: 95, linkedin: "" })];
    h.verifyStatus = "valid";
    const r = await find();
    expect(r.none).toBe(true);
  });

  it("returns NO referral when the email fails verification (no unverified fallback)", async () => {
    h.emails = [contact({ confidence: 95 })];
    h.verifyStatus = "invalid"; // verifier says undeliverable
    const r = await find();
    expect(r.none).toBe(true);
  });
});

// referral-fallback.test.mjs — Huntr and Hunter are two indexes, not two settings.
//
// With both keys configured, Hunter must still be asked when Huntr's index has nobody at a company:
// "Huntr has nobody at Acme" is not "nobody at Acme is findable". Picking a single provider by which
// key is set (huntrKey ? huntr : hunter) would leave the user with silence from a provider we hold a
// key for.
//
// The two things the fallback must NOT do, each pinned by a test:
//   1. It must not spend past the cap. referralSearchesThisMonth() counts every row in
//      referral_lookups regardless of provider, so a spent month is spent for BOTH. Falling through
//      on `quota` would walk straight past the cap it exists to enforce.
//   2. It must not lower the bar. A fallback contact clears MIN_CONFIDENCE + verified + LinkedIn or
//      it is not surfaced. Asking a second source is not the same as accepting a weaker answer, and
//      a wrong warm intro in a real inbox is unrecoverable.
//
// No live network, no DB: the store is mocked and global fetch is stubbed with both API shapes.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Read at module load, so they must be set BEFORE the import below.
process.env.HUNTR_GTM_API_KEY = "test-huntr-key";
process.env.HUNTER_API_KEY = "test-hunter-key";
process.env.REFERRAL_MIN_CONFIDENCE = "80";
process.env.REFERRAL_REGIONS = "us";

const h = vi.hoisted(() => ({ monthlySearches: 0 }));

vi.mock("./charlie-store.mjs", () => ({
  getReferralCache: vi.fn(async () => null), // always a cache miss → live search
  recordReferralLookup: vi.fn(async () => {}),
  referralSearchesThisMonth: vi.fn(async () => h.monthlySearches),
}));

const { findReferralContact } = await import("./referral-find.mjs");

const json = (obj) => ({ ok: true, status: 200, json: async () => obj });

// One in-region, senior-looking person. Used as Huntr's search hit.
const HUNTR_PERSON = { name: "Priya Rao", title: "Senior Product Manager", linkedin_url: "https://linkedin.com/in/priyarao", location: "San Francisco, California, United States", website: "acme.com" };

// A Hunter contact that clears the bar: verified, confidence >= 80, has a LinkedIn.
const HUNTER_GOOD = { first_name: "Dana", last_name: "Cole", value: "dana@acme.com", position: "Product Manager", department: "management", confidence: 95, linkedin: "https://linkedin.com/in/danacole", type: "personal" };

/**
 * Route the stub by host. `huntrPeople` / `huntrResolve` drive Huntr, `hunterEmails` drives Hunter.
 * Every call is recorded so a test can assert a provider was never even asked.
 */
function stubFetch({ huntrPeople = [], huntrResolve = null, hunterEmails = [], hunterVerify = "valid" } = {}) {
  const calls = [];
  const fn = vi.fn(async (url, init) => {
    const u = String(url);
    calls.push(u);
    if (u.includes("tryhuntr.com/person-search")) return json({ people: huntrPeople });
    if (u.includes("tryhuntr.com/person-email")) return json({ result: huntrResolve || { email: null, certainty: "not_found", status: "" } });
    if (u.includes("hunter.io/v2/domain-search")) return json({ data: { domain: "acme.com", emails: hunterEmails } });
    if (u.includes("hunter.io/v2/email-verifier")) return json({ data: { status: hunterVerify, result: hunterVerify } });
    throw new Error(`unexpected fetch: ${u}`);
  });
  fn.calls = calls;
  fn.askedHuntr = () => calls.some((c) => c.includes("tryhuntr.com"));
  fn.askedHunter = () => calls.some((c) => c.includes("hunter.io"));
  return fn;
}

const findAtAcme = () => findReferralContact({
  email: "user@example.com", company: "Acme", jobUrl: "https://jobs.ashbyhq.com/acme/123",
  roleTitle: "Senior Product Manager", location: "San Francisco", region: "us",
});

beforeEach(() => { h.monthlySearches = 0; });
afterEach(() => { vi.unstubAllGlobals(); });

describe("Huntr → Hunter fallback", () => {
  it("asks Hunter when Huntr's index has nobody", async () => {
    const fetchStub = stubFetch({ huntrPeople: [], hunterEmails: [HUNTER_GOOD] });
    vi.stubGlobal("fetch", fetchStub);

    const r = await findAtAcme();

    expect(fetchStub.askedHuntr(), "Huntr should still be tried first").toBe(true);
    expect(fetchStub.askedHunter(), "Hunter must be asked once Huntr comes back empty").toBe(true);
    expect(r.none).toBeFalsy();
    expect(r.contact?.email).toBe("dana@acme.com");
  });

  it("asks Hunter when Huntr found people but none cleared its certainty bar", async () => {
    // Huntr returns a person, but resolveEmail never reaches ultra_sure → reason: low_certainty.
    const fetchStub = stubFetch({
      huntrPeople: [HUNTR_PERSON],
      huntrResolve: { email: "priya@acme.com", certainty: "likely", status: "FOUND" },
      hunterEmails: [HUNTER_GOOD],
    });
    vi.stubGlobal("fetch", fetchStub);

    const r = await findAtAcme();
    expect(fetchStub.askedHunter()).toBe(true);
    expect(r.contact?.email).toBe("dana@acme.com");
  });

  it("does NOT ask Hunter when Huntr already found somebody — no wasted quota", async () => {
    const fetchStub = stubFetch({
      huntrPeople: [HUNTR_PERSON],
      huntrResolve: { email: "priya@acme.com", certainty: "ultra_sure", status: "FOUND" },
      hunterEmails: [HUNTER_GOOD],
    });
    vi.stubGlobal("fetch", fetchStub);

    const r = await findAtAcme();
    expect(r.contact?.email).toBe("priya@acme.com");
    expect(fetchStub.askedHunter(), "a Huntr hit must end the search").toBe(false);
  });
});

describe("what the fallback must not break", () => {
  it("does NOT fall through on `quota` — the counter is shared, so a spent month is spent for both", async () => {
    h.monthlySearches = 999; // way past HUNTER_MONTHLY_CAP
    const fetchStub = stubFetch({ huntrPeople: [], hunterEmails: [HUNTER_GOOD] });
    vi.stubGlobal("fetch", fetchStub);

    const r = await findAtAcme();
    expect(r.none).toBe(true);
    expect(r.reason).toBe("quota");
    expect(fetchStub.askedHunter(), "falling through on quota would bypass the cap entirely").toBe(false);
  });

  it("keeps the confidence bar on the fallback — a weak Hunter contact is still nobody", async () => {
    const weak = { ...HUNTER_GOOD, confidence: 40 }; // below MIN_CONFIDENCE
    const fetchStub = stubFetch({ huntrPeople: [], hunterEmails: [weak] });
    vi.stubGlobal("fetch", fetchStub);

    const r = await findAtAcme();
    expect(r.none).toBe(true);
    expect(r.reason).toBe("low_confidence");
  });

  it("keeps the verified-email requirement on the fallback", async () => {
    const fetchStub = stubFetch({ huntrPeople: [], hunterEmails: [HUNTER_GOOD], hunterVerify: "invalid" });
    vi.stubGlobal("fetch", fetchStub);

    const r = await findAtAcme();
    expect(r.none).toBe(true);
    expect(r.reason).toBe("low_confidence"); // never surfaced without a deliverable address
  });

  it("keeps the LinkedIn requirement on the fallback", async () => {
    const noLinkedin = { ...HUNTER_GOOD, linkedin: "" };
    const fetchStub = stubFetch({ huntrPeople: [], hunterEmails: [noLinkedin] });
    vi.stubGlobal("fetch", fetchStub);

    expect((await findAtAcme()).none).toBe(true);
  });

  it("still returns Huntr's own reason when there is no Hunter key to fall back to", async () => {
    const saved = process.env.HUNTER_API_KEY;
    delete process.env.HUNTER_API_KEY;
    try {
      const fetchStub = stubFetch({ huntrPeople: [] });
      vi.stubGlobal("fetch", fetchStub);
      const r = await findAtAcme();
      expect(r.none).toBe(true);
      expect(fetchStub.askedHunter()).toBe(false);
    } finally { process.env.HUNTER_API_KEY = saved; }
  });

  it("a Huntr outage does not swallow the lookup — Hunter still answers", async () => {
    // Huntr's own path catches the throw and returns lookup_failed; the fallback must engage.
    const calls = [];
    const fetchStub = vi.fn(async (url) => {
      const u = String(url); calls.push(u);
      if (u.includes("tryhuntr.com")) return { ok: false, status: 503, json: async () => ({}) };
      if (u.includes("domain-search")) return json({ data: { domain: "acme.com", emails: [HUNTER_GOOD] } });
      return json({ data: { status: "valid", result: "valid" } });
    });
    vi.stubGlobal("fetch", fetchStub);

    const r = await findAtAcme();
    expect(r.contact?.email).toBe("dana@acme.com");
    expect(calls.some((c) => c.includes("hunter.io"))).toBe(true);
  });
});

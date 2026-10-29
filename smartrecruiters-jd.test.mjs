// smartrecruiters-jd.test.mjs — regression guard: a SmartRecruiters posting must carry its real JD.
//
// WHY THIS EXISTS. SmartRecruiters' list endpoint (/v1/companies/<slug>/postings) carries no job
// description at all — verified against the live API, there is no `jobAd` or `description` key on a
// list item. Without hydrating from the detail endpoint, every SmartRecruiters job would sit in the
// matchable pool with no JD.
//
// The damage is not "a missing field". A description-less job can still be SCORED (the matcher
// reads the title) and SENT, but it can never carry a fit chart: jdIsScoreable() needs text, so
// computeCoverage returns thin and render-email hides the readout — and the reason is invisible,
// because a missing JD is reported the same way as a vague one.
//
// Two things are locked in here:
//   1. the extractor reads jobAd.sections when hydration has attached them, requirements included;
//   2. it still returns null (never a guess, never a partial) when there is nothing to read — which
//      is what makes the pool guard in main() able to drop the job instead of pooling it.

import { describe, it, expect } from "vitest";
import { smartRecruitersDescription, hydrateDescriptions } from "./scan-jobs.mjs";

// A posting shaped like the live detail endpoint's jobAd (sections are HTML, per the real API).
const withSections = (sections) => ({ id: "6000000001269964", name: "Android Engineer", jobAd: { sections } });

const REAL = {
  jobDescription: { text: "<p><strong>What will you get to do here?</strong></p><ul><li>Design and architect scalable systems.</li></ul>" },
  qualifications: { text: "<ul><li>3+ years of professional experience in Android application development.</li></ul>" },
  companyDescription: { text: "<p>We deliver food.</p>" },
  additionalInformation: { text: "<p>Equal opportunity employer.</p>" },
};

describe("smartRecruitersDescription — reads the real JD off the detail endpoint's jobAd", () => {
  it("returns the description text, not null (the whole bug)", () => {
    const d = smartRecruitersDescription(withSections(REAL));
    expect(d).toBeTruthy();
    expect(d).toContain("Design and architect scalable systems");
  });

  it("keeps the REQUIREMENTS, which is what the fit chart and the knockout floor both read", () => {
    const d = smartRecruitersDescription(withSections(REAL));
    expect(d).toContain("3+ years of professional experience");
  });

  it("strips HTML, so the pooled description is plain text like every other source's", () => {
    const d = smartRecruitersDescription(withSections(REAL));
    expect(d).not.toMatch(/<\/?(p|ul|li|strong)\b/i);
  });

  it("orders role text and requirements BEFORE company boilerplate, so they survive the 2500 cap", () => {
    const d = smartRecruitersDescription(withSections(REAL));
    expect(d.indexOf("3+ years")).toBeLessThan(d.indexOf("We deliver food"));
    expect(d.indexOf("Design and architect")).toBeLessThan(d.indexOf("We deliver food"));
  });

  it("is long enough and signalled enough to be scoreable (the chart's actual precondition)", async () => {
    const { jdIsScoreable } = await import("./lib/jd-requirements.mjs");
    // Real postings run ~7k chars; this fixture is short, so pad the role text the way a real one reads.
    const padded = withSections({
      ...REAL,
      jobDescription: { text: `<p>${"You will build and own Android features end to end. ".repeat(20)}</p>` },
    });
    expect(jdIsScoreable(smartRecruitersDescription(padded))).toBe(true);
  });
});

describe("smartRecruitersDescription — fails closed, never guesses", () => {
  it("returns null when the posting was never hydrated (no jobAd at all)", () => {
    expect(smartRecruitersDescription({ id: "1", name: "Android Engineer" })).toBeNull();
  });

  it("returns null for a malformed or empty jobAd rather than an empty string", () => {
    expect(smartRecruitersDescription({ jobAd: {} })).toBeNull();
    expect(smartRecruitersDescription({ jobAd: { sections: {} } })).toBeNull();
    expect(smartRecruitersDescription({ jobAd: { sections: { jobDescription: { text: "   " } } } })).toBeNull();
    expect(smartRecruitersDescription(null)).toBeNull();
    expect(smartRecruitersDescription(undefined)).toBeNull();
  });

  it("does not invent the missing sections — a partial jobAd yields only what is there", () => {
    const d = smartRecruitersDescription(withSections({ qualifications: { text: "<ul><li>5+ years.</li></ul>" } }));
    expect(d).toBe("5+ years.");
  });
});

describe("hydrateDescriptions — enrichment that cannot break the scan", () => {
  it("is a NO-OP for every source without a detail endpoint (byte-identical behaviour)", async () => {
    const jobs = [{ id: "a" }, { id: "b" }];
    for (const source of ["ashby", "greenhouse", "lever", "recruitee", "kula", "workable", "keka"]) {
      const r = await hydrateDescriptions({ source, slug: "x" }, jobs);
      expect(r).toEqual({ attempted: 0, hydrated: 0 });
    }
    expect(jobs.every((j) => !("jobAd" in j))).toBe(true); // nothing was touched
  });

  it("no-ops on an empty or missing jobs array instead of throwing", async () => {
    expect(await hydrateDescriptions({ source: "smartrecruiters", slug: "x" }, [])).toEqual({ attempted: 0, hydrated: 0 });
    expect(await hydrateDescriptions({ source: "smartrecruiters", slug: "x" }, null)).toEqual({ attempted: 0, hydrated: 0 });
  });

  it("leaves a posting un-hydrated (description stays null) when the detail fetch fails", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: false, status: 500, headers: { get: () => null } });
    try {
      const jobs = [{ id: "1" }];
      const r = await hydrateDescriptions({ source: "smartrecruiters", slug: "swiggy" }, jobs);
      expect(r.attempted).toBe(1);
      expect(r.hydrated).toBe(0);
      expect(smartRecruitersDescription(jobs[0])).toBeNull(); // -> the pool guard drops it
    } finally {
      globalThis.fetch = orig;
    }
  });

  it("attaches jobAd when the detail endpoint answers, so the extractor can read it", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ jobAd: { sections: REAL } }) });
    try {
      const jobs = [{ id: "1" }, { id: "2" }];
      const r = await hydrateDescriptions({ source: "smartrecruiters", slug: "swiggy" }, jobs);
      expect(r).toEqual({ attempted: 2, hydrated: 2 });
      expect(smartRecruitersDescription(jobs[0])).toContain("3+ years of professional experience");
    } finally {
      globalThis.fetch = orig;
    }
  });

  // The detail endpoint is its own external boundary and gets its own schema. The failure
  // it exists to stop is NOT a missing section (the reader already guards those) — it is a vendor
  // returning a non-string where `text` belongs, which would reach stripHtml as "[object Object]"
  // and pool a GARBAGE description. Garbage is worse than null here, because garbage is scoreable.
  it("rejects a detail document whose section text is not a string, rather than pooling garbage", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true, status: 200, headers: { get: () => null },
      json: async () => ({ jobAd: { sections: { jobDescription: { text: { nested: "object" } } } } }),
    });
    try {
      const jobs = [{ id: "1" }];
      const r = await hydrateDescriptions({ source: "smartrecruiters", slug: "swiggy" }, jobs);
      expect(r.hydrated).toBe(0);
      expect(jobs[0].jobAd).toBeUndefined();          // never attached
      expect(smartRecruitersDescription(jobs[0])).toBeNull(); // -> pool guard drops it
    } finally {
      globalThis.fetch = orig;
    }
  });

  it("accepts a detail document with sections we do not read (passthrough, not strict)", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true, status: 200, headers: { get: () => null },
      json: async () => ({ id: "1", jobAd: { sections: { ...REAL, someNewSection: { text: "future" } } }, unknownTopLevel: 1 }),
    });
    try {
      const jobs = [{ id: "1" }];
      const r = await hydrateDescriptions({ source: "smartrecruiters", slug: "swiggy" }, jobs);
      expect(r.hydrated).toBe(1); // a vendor adding fields must never break the scan
      expect(smartRecruitersDescription(jobs[0])).toContain("3+ years of professional experience");
    } finally {
      globalThis.fetch = orig;
    }
  });

  it("skips a posting with no id rather than fetching a garbage url", async () => {
    const orig = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => { calls++; return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ jobAd: { sections: REAL } }) }; };
    try {
      await hydrateDescriptions({ source: "smartrecruiters", slug: "swiggy" }, [{ name: "no id here" }]);
      expect(calls).toBe(0);
    } finally {
      globalThis.fetch = orig;
    }
  });
});

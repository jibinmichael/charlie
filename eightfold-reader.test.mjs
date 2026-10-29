// eightfold-reader.test.mjs — the Eightfold source.
//
// Eightfold is a PLATFORM, not a board: one deployment per employer, each on its own host with its
// own `domain` param. It reaches large employers no other Charlie source covers.
//
// Three things carry real risk:
//
// 1. THE SECONDS TRAP. `t_create` is a unix SECONDS timestamp (1785425471). Read as milliseconds it
//    dates every posting to January 1970, MAX_AGE_DAYS=45 drops the lot, and the source reports
//    "answered, but everything aged out" — a silent zero wearing a successful fetch.
//
// 2. THE PAGE CEILING. `num` is capped at 10 SERVER-SIDE: asking for 50 or 100 returns 10 anyway
//    on large boards. Because the pager stops on a short page, a PAGE constant
//    above 10 reads the first page as "board exhausted" and silently takes 10 roles from a
//    1,000-role board. A vendor ceiling, not a tuning knob.
//
// 3. THE COMMA. `location` is "Mumbai,India" with no space. classifyPlace and the geo gate read a
//    country token after ", " like every other source, so the extractor normalises it.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { extractEightfold, applyDetail } from "./scan-jobs.mjs";
import { EightfoldJob, ATS_JOB_SCHEMAS, ATS_DETAIL_SCHEMAS } from "./lib/schemas/ats-jobs.mjs";
import { classifyPlace } from "./quality-gate.mjs";

// A real row, verbatim from https://explore.jobs.netflix.net/api/apply/v2/jobs.
const REAL = {
  ats_job_id: "JR41792", business_unit: "Streaming", canonicalPositionUrl: "https://explore.jobs.netflix.net/careers/job/790317351106",
  department: "Core Finance & Controllership", display_job_id: "JR41792", id: 790317351106,
  job_description: "", locale: "en-US", location: "Mumbai,India", locations: ["Mumbai,India"],
  name: "Associate, Production Finance - India", posting_name: "Associate, Production Finance - India",
  t_create: 1784937600, t_update: 1784937600, type: "ATS", work_location_option: "onsite",
};
const ENTRY = { slug: "netflix", host: "explore.jobs.netflix.net", domain: "netflix.com" };

describe("extractEightfold", () => {
  it("reads t_create as SECONDS, so postings are not all dated 1970 and dropped as stale", () => {
    const out = extractEightfold(REAL, "netflix", ENTRY);
    expect(out.posted_at).toBe(new Date(1784937600 * 1000).toISOString());
    expect(new Date(out.posted_at).getUTCFullYear()).toBeGreaterThan(2020); // the trap, stated plainly
  });

  it("normalises 'Mumbai,India' so the geo gate reads the country the same way as every other source", () => {
    const out = extractEightfold(REAL, "netflix", ENTRY);
    expect(out.location).toBe("Mumbai, India");
    expect(classifyPlace(out.location)).toBe("india"); // the whole point of the comma fix
  });

  it("maps work_location_option to the canonical remote field", () => {
    expect(extractEightfold({ ...REAL, work_location_option: "onsite" }, "n", ENTRY).remote).toBe(false);
    expect(extractEightfold({ ...REAL, work_location_option: "remote" }, "n", ENTRY).remote).toBe(true);
    expect(extractEightfold({ ...REAL, work_location_option: "hybrid" }, "n", ENTRY).remote).toBe("hybrid");
  });

  it("never invents comp or employment type — Eightfold states neither on either document", () => {
    const out = extractEightfold(REAL, "netflix", ENTRY);
    expect(out.compensation).toBeNull();
    expect(out.employment_type).toBeNull();
  });

  it("survives a row with nothing in it rather than throwing mid-batch", () => {
    const out = extractEightfold({}, "netflix", ENTRY);
    expect(out.title).toBeNull();
    expect(out.location).toBeNull();
    expect(out.posted_at).toBeNull();
  });

  it("validates the real row against the schema the boundary uses", () => {
    expect(EightfoldJob.safeParse(REAL).success).toBe(true);
    expect(ATS_JOB_SCHEMAS.eightfold).toBe(EightfoldJob);
    expect(ATS_DETAIL_SCHEMAS.eightfold).toBeDefined(); // the list omits every JD; hydration is mandatory
  });
});

describe("eightfold paging constants", () => {
  const SRC = readFileSync("scan-jobs.mjs", "utf8");

  it("pages at 10, the server-side cap — anything larger silently truncates every board", () => {
    // num=10, 50 and 100 all return 10 rows. The pager breaks on a short page, so PAGE > 10 would take
    // 10 roles from a 1,000-role board and call it complete.
    expect(SRC).toMatch(/const EIGHTFOLD_PAGE = 10;/);
  });

  it("is registered in SOURCES, or its boards fetch while staying invisible in the funnel", () => {
    expect(SRC).toMatch(/const SOURCES = \[[^\]]*"eightfold"/);
  });

  it("loads its watchlist as a segment, or the boards are never attempted at all", () => {
    expect(SRC).toMatch(/watchlist-eightfold\.json/);
    const wl = JSON.parse(readFileSync("watchlist-eightfold.json", "utf8"));
    expect(wl.length).toBeGreaterThan(0);
    // Every entry must carry host + domain: the endpoint cannot be built without both, and a missing
    // one yields a 404 that reads as "no such board" rather than "we asked wrong".
    for (const e of wl) {
      expect(e.source).toBe("eightfold");
      expect(typeof e.host).toBe("string");
      expect(typeof e.domain).toBe("string");
    }
  });
});

// ── the hydration mapping ────────────────────────────────────────────────────
//
// The JD lives in the detail document's `job_description`, NOT `jobAd` (SmartRecruiters' name for it,
// which Eightfold's document does not have). Reading the wrong field throws nothing: `hydrated` stays
// 0, every posting keeps the empty description its list row arrived with, and the pool's
// no-description guard drops it, a third form of the silent zero described above.
//
// The detail document's top-level keys are id, name, posting_name, location, locations, hot,
// department, business_unit, t_update, t_create, ats_job_id, display_job_id, type, job_description,
// id_locale, … Most list rows carry no description, so this mapping carries most of the source.
describe("applyDetail — the field-name mapping that fails silently when it is wrong", () => {
  // Verbatim shape of the live bcg.eightfold.ai detail document, trimmed to the keys that matter.
  const EF_DETAIL = {
    id: 790318, name: "Consultant", location: "Mumbai,India",
    job_description: "<p>You will lead client teams.</p><p>10+ years required.</p>",
  };

  it("attaches Eightfold's JD, which lives on job_description and NOT on jobAd", () => {
    const raw = { ...REAL };
    expect(applyDetail("eightfold", raw, EF_DETAIL)).toBe(true);
    expect(raw.job_description).toBe(EF_DETAIL.job_description);
  });

  it("makes the description survive all the way through the extractor", () => {
    // The assertion that actually matters: hydration is pointless unless extractEightfold sees it.
    // If it were "", the pool guard would drop the posting.
    const raw = { ...REAL };
    applyDetail("eightfold", raw, EF_DETAIL);
    const out = extractEightfold(raw, "netflix", ENTRY);
    expect(out.description).toContain("10+ years required");
    expect(out.description.length).toBeGreaterThan(0);
  });

  it("does not count a detail document that carries no usable JD", () => {
    // hydrated is the counter that makes the NEXT breakage of this kind legible in the scan log, so
    // it must never be inflated by a document that attached nothing.
    for (const d of [{}, { job_description: "" }, { job_description: "   " }, { jobAd: "wrong source" }]) {
      const raw = { ...REAL };
      expect(applyDetail("eightfold", raw, d)).toBe(false);
      expect(raw.job_description).toBe("");
    }
  });

  it("leaves SmartRecruiters on jobAd — the source that genuinely uses that name", () => {
    const raw = {};
    expect(applyDetail("smartrecruiters", raw, { jobAd: { sections: {} } })).toBe(true);
    expect(raw.jobAd).toEqual({ sections: {} });
  });

  it("leaves Workday on jobPostingInfo, handing over the whole document", () => {
    const raw = {};
    expect(applyDetail("workday", raw, { jobPostingInfo: { jobDescription: "<p>hi</p>" } })).toBe(true);
    expect(raw.__detail).toEqual({ jobDescription: "<p>hi</p>" });
    expect(applyDetail("workday", {}, { jobAd: "wrong key" })).toBe(false);
  });

  it("never throws on a null/absent detail document (hydration fails open, per posting)", () => {
    for (const d of [null, undefined]) {
      expect(applyDetail("eightfold", { ...REAL }, d)).toBe(false);
      expect(applyDetail("workday", {}, d)).toBe(false);
      expect(applyDetail("smartrecruiters", {}, d)).toBe(false);
    }
    expect(applyDetail("eightfold", null, EF_DETAIL)).toBe(false);
  });

  it("agrees with the schema that declares the field, so the two cannot drift apart", () => {
    // ATS_DETAIL_SCHEMAS.eightfold is what parses the document before applyDetail sees it. If the
    // schema ever stops declaring job_description, this mapping is reading a field nothing validates.
    const parsed = ATS_DETAIL_SCHEMAS.eightfold.safeParse(EF_DETAIL);
    expect(parsed.success).toBe(true);
    expect(parsed.data.job_description).toBe(EF_DETAIL.job_description);
  });
});

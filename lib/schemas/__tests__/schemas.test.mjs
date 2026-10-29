// lib/schemas/__tests__/schemas.test.mjs — boundary-schema contract tests.
// Per schema: one realistic VALID fixture parses, one MALFORMED fixture fails closed. Fixtures for
// the ATS shapes mirror the real feed items scan-jobs.mjs parses; no live API calls, no keys.
// Run: npm run test:schemas (or the full `npm test`).
import { describe, it, expect } from "vitest";
import { GreenhouseJob, AshbyJob, LeverJob, KulaJob, KekaJob } from "../ats-jobs.mjs";
import { ResendSendPayload } from "../resend-send.mjs";
import { ResendWebhookEvent } from "../resend-webhook.mjs";
import { Dossier } from "../dossier.mjs";
import { MatchOutput, MatchOutputFormat } from "../match-output.mjs";

describe("ATS job shapes (raw feed items scan-jobs.mjs parses)", () => {
  it("Greenhouse: valid item parses; missing numeric id fails closed", () => {
    expect(
      GreenhouseJob.safeParse({
        id: 4012345,
        title: "Senior Product Designer",
        location: { name: "Remote - US" },
        departments: [{ name: "Design" }],
        offices: [{ name: "Remote", location: "US" }],
        content: "&lt;p&gt;Own the design system.&lt;/p&gt;",
        absolute_url: "https://boards.greenhouse.io/acme/jobs/4012345",
        first_published: "2026-07-01T00:00:00Z",
        updated_at: "2026-07-05T00:00:00Z",
      }).success,
    ).toBe(true);
    // GH board API always sends a numeric id; a string id (or none) is a broken item -> skip.
    expect(GreenhouseJob.safeParse({ id: "4012345", title: "PM" }).success).toBe(false);
    expect(GreenhouseJob.safeParse({ title: "PM" }).success).toBe(false);
  });

  it("Ashby: valid item (jobId only) parses; item with no id/jobId fails closed", () => {
    expect(
      AshbyJob.safeParse({
        jobId: "6b1e-uuid",
        title: "Staff Engineer",
        location: "Remote",
        isRemote: true,
        descriptionPlain: "Build the platform.",
        employmentType: "FullTime",
        applyUrl: "https://jobs.ashbyhq.com/acme/6b1e-uuid",
        publishedAt: "2026-07-02T00:00:00Z",
      }).success,
    ).toBe(true);
    expect(AshbyJob.safeParse({ title: "Staff Engineer" }).success).toBe(false); // no id AND no jobId
  });

  it("Lever: valid item parses; numeric id fails closed (Lever ids are strings)", () => {
    expect(
      LeverJob.safeParse({
        id: "a1b2-posting",
        text: "Growth Marketer",
        categories: { location: "New York", team: "Marketing", commitment: "Full-time" },
        workplaceType: "hybrid",
        salaryRange: { min: 120000, max: 160000, currency: "USD" },
        hostedUrl: "https://jobs.lever.co/acme/a1b2-posting",
        createdAt: 1751500000000,
      }).success,
    ).toBe(true);
    expect(LeverJob.safeParse({ id: 5, text: "Growth Marketer" }).success).toBe(false);
  });

  it("Kula: valid item parses; missing id fails closed", () => {
    expect(
      KulaJob.safeParse({
        id: 88231,
        title: "Backend Engineer",
        ats_job: { workplace: "remote", ats_department: { name: "Engineering" }, employment_type: "full_time", job_description: "<p>APIs.</p>" },
      }).success,
    ).toBe(true);
    expect(KulaJob.safeParse({ title: "Backend Engineer" }).success).toBe(false);
  });

  it("Keka: valid item (string or object locations) parses; non-string/object location fails closed", () => {
    expect(
      KekaJob.safeParse({
        id: 55,
        title: "Support Engineer",
        jobLocations: ["Bengaluru", { city: "Pune", state: "MH", countryName: "India" }],
        jobType: "Full Time",
        departmentName: "Quality",
        salaryRangeFormat: "12-18 LPA",
        publishedOn: "2026-07-03",
      }).success,
    ).toBe(true);
    expect(KekaJob.safeParse({ id: 55, jobLocations: [123] }).success).toBe(false);
  });
});

describe("Resend send payload (the direct resend.emails.send choke point)", () => {
  it("valid payload parses", () => {
    expect(
      ResendSendPayload.safeParse({
        from: "charlie@mail.example.com",
        to: "user@example.com",
        subject: "Found one worth your time",
        html: "<p>hi</p>",
        headers: { "Message-ID": "<x@y>", "List-Unsubscribe": "<https://u>" },
      }).success,
    ).toBe(true);
  });
  it("array recipients + attachments parse", () => {
    expect(
      ResendSendPayload.safeParse({
        from: "charlie@mail.example.com",
        to: ["a@example.com", "b@example.com"],
        subject: "hi",
        html: "<p>x</p>",
        attachments: [{ filename: "resume.pdf", content: "base64==" }],
      }).success,
    ).toBe(true);
  });
  it("blank subject fails closed", () => {
    expect(ResendSendPayload.safeParse({ from: "a@x.com", to: "b@y.com", subject: "   ", html: "<p>x</p>" }).success).toBe(false);
  });
  it("missing html fails closed", () => {
    expect(ResendSendPayload.safeParse({ from: "a@x.com", to: "b@y.com", subject: "hi" }).success).toBe(false);
  });
  it("empty recipient list fails closed", () => {
    expect(ResendSendPayload.safeParse({ from: "a@x.com", to: [], subject: "hi", html: "<p>x</p>" }).success).toBe(false);
  });
});

describe("Resend webhook event (the /webhooks/resend body)", () => {
  it("valid delivered event parses", () => {
    expect(
      ResendWebhookEvent.safeParse({
        type: "email.delivered",
        created_at: "2026-07-13T00:00:00Z",
        data: { email_id: "re_abc", to: "user@example.com", subject: "hi", extra_field: 1 },
      }).success,
    ).toBe(true);
  });
  it("bounced event with array recipients parses", () => {
    expect(
      ResendWebhookEvent.safeParse({ type: "email.bounced", data: { to: ["a@x.com", "b@x.com"] } }).success,
    ).toBe(true);
  });
  it("missing type fails closed (won't act on it)", () => {
    expect(ResendWebhookEvent.safeParse({ data: { to: "a@x.com" } }).success).toBe(false);
  });
  it("missing data object fails closed", () => {
    expect(ResendWebhookEvent.safeParse({ type: "email.delivered" }).success).toBe(false);
  });
});

describe("Dossier (what the matching pipeline consumes)", () => {
  const valid = {
    name: "Maya Okonkwo",
    headline: "Product designer, 6 years, fintech",
    narrative: "Led the checkout redesign end to end.",
    proof_points: [{ claim: "shipped checkout", source: "resume" }],
    case_studies: [],
    strengths: ["design systems"],
    gaps: ["seniority not stated"],
    preferences: { remote: "remote-india", comp_floor: null },
  };
  it("valid dossier parses", () => {
    expect(Dossier.safeParse(valid).success).toBe(true);
  });

  // Extraction writes an explicit `name: null` when it finds no name. `z.string().optional()` accepts
  // `undefined` but REJECTS `null`, which would skip the person at match-batch.mjs's dossier check on
  // every run. Each assertion below fails against `.optional()`.
  it("name: null parses — an unextracted name must not exclude a user forever", () => {
    const r = Dossier.safeParse({ ...valid, name: null });
    expect(r.success).toBe(true);
    expect(r.data.name).toBe(null);
  });
  it("name absent entirely still parses", () => {
    const { name, ...noName } = valid;
    expect(Dossier.safeParse(noName).success).toBe(true);
  });
  it("a real name still parses, and a non-string name is still rejected", () => {
    expect(Dossier.safeParse({ ...valid, name: "Maya Okonkwo" }).success).toBe(true);
    expect(Dossier.safeParse({ ...valid, name: 42 }).success).toBe(false);
  });
  // Same class, second field: dossier-build.mjs normalizes a non-array `gaps` to [], so the schema
  // must not be stricter than the code.
  it("gaps absent defaults to [] rather than excluding the user", () => {
    const { gaps, ...noGaps } = valid;
    const r = Dossier.safeParse(noGaps);
    expect(r.success).toBe(true);
    expect(r.data.gaps).toEqual([]);
  });
  it("a non-array gaps is still rejected", () => {
    expect(Dossier.safeParse({ ...valid, gaps: "seniority not stated" }).success).toBe(false);
  });
  // Third instance: a model can emit preferences.mode as ["internship","first_job"] instead of a single
  // string. eligibility-gate.mjs ignores a non-string mode, so the schema must not turn it into total
  // exclusion. Degrade the field, never drop the human.
  it("a malformed preferences.mode degrades to null instead of excluding the user", () => {
    const r = Dossier.safeParse({ ...valid, preferences: { ...valid.preferences, mode: ["internship", "first_job"] } });
    expect(r.success).toBe(true);
    expect(r.data.preferences.mode).toBe(null);
  });
  it("a malformed employment_type_wanted degrades to null too (same consumer shape)", () => {
    const r = Dossier.safeParse({ ...valid, preferences: { ...valid.preferences, employment_type_wanted: ["intern", "full_time"] } });
    expect(r.success).toBe(true);
    expect(r.data.preferences.employment_type_wanted).toBe(null);
  });
  it("a well-formed preferences.mode is still preserved verbatim", () => {
    const r = Dossier.safeParse({ ...valid, preferences: { ...valid.preferences, mode: "internship" } });
    expect(r.success).toBe(true);
    expect(r.data.preferences.mode).toBe("internship");
  });
  it("empty headline fails closed", () => {
    expect(Dossier.safeParse({ ...valid, headline: "  " }).success).toBe(false);
  });
  it("proof_points not an array fails closed", () => {
    expect(Dossier.safeParse({ ...valid, proof_points: { a: 1 } }).success).toBe(false);
  });
  it("preferences missing (not an object) fails closed", () => {
    const { preferences, ...noPrefs } = valid;
    expect(Dossier.safeParse(noPrefs).success).toBe(false);
  });
  it("seeker fields parse: professional_years + preferences.mode/employment_type_wanted", () => {
    const student = { ...valid, professional_years: 0, preferences: { ...valid.preferences, mode: "internship", employment_type_wanted: "intern" } };
    expect(Dossier.safeParse(student).success).toBe(true);
  });
  it("desire fields parse: preferences.motivation (string) + admired (array)", () => {
    const withDesire = { ...valid, preferences: { ...valid.preferences, motivation: "move from agency into product", admired: ["Figma", "Linear"] } };
    expect(Dossier.safeParse(withDesire).success).toBe(true);
    // motivation must be a string when present (a stray object fails closed)
    expect(Dossier.safeParse({ ...valid, preferences: { ...valid.preferences, motivation: { a: 1 } } }).success).toBe(false);
  });
  it("professional_years is TYPED (a string fails closed)", () => {
    expect(Dossier.safeParse({ ...valid, professional_years: "two" }).success).toBe(false);
  });
});

describe("MatchOutput (Haiku scoring output — the daily match boundary)", () => {
  const valid = {
    score: 78,
    verdict: "strong",
    chips: [{ text: "Design systems depth", kind: "good" }],
    why_you: "You shipped a design system and they are building one.",
    flag: "Seniority not stated in the posting.",
    dealbreaker_hit: false,
  };
  it("valid output parses", () => {
    expect(MatchOutput.safeParse(valid).success).toBe(true);
  });
  // matcher.md tells the model to "say less" when it cannot ground the tie-in, and unconstrained Haiku
  // emits `why_you: null`. `.optional()` (accepts undefined, REJECTS null) would reject those records,
  // and the reject path forces score 0 / verdict "skip", silently discarding the real score.
  it("why_you: null parses (model's way of saying nothing is groundable — must NOT drop the record)", () => {
    expect(MatchOutput.safeParse({ ...valid, why_you: null }).success).toBe(true);
  });
  it("why_you absent entirely still parses", () => {
    const { why_you, ...noWhy } = valid;
    expect(MatchOutput.safeParse(noWhy).success).toBe(true);
  });
  it("a hallucinated out-of-range score still fails closed", () => {
    expect(MatchOutput.safeParse({ ...valid, score: 140 }).success).toBe(false);
  });
  it("an unknown verdict still fails closed", () => {
    expect(MatchOutput.safeParse({ ...valid, verdict: "amazing" }).success).toBe(false);
  });
  // The constrained-decoding schema is a HAND-MIRROR of the Zod one (the file says so). This asserts
  // the nullable fields agree across both, so they cannot drift.
  it("constrained schema mirrors the Zod nullables (why_you + flag both accept null)", () => {
    const props = MatchOutputFormat.schema.properties;
    expect(props.why_you.type).toEqual(["string", "null"]);
    expect(props.flag.type).toEqual(["string", "null"]);
  });
});

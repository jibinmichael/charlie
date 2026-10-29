// lib/schemas/ats-jobs.mjs — Zod schemas for the RAW ATS job objects Charlie parses.
// External boundary: the per-job items returned by each ATS feed, BEFORE scan-jobs.mjs's
// extract<Source>() reads them. One schema per family actually parsed. Each mirrors exactly
// the fields the matching extractor reads (see the extract<Source>() functions in scan-jobs.mjs) — nothing invented from
// the vendor's API docs. Shapes are permissive (the extractors use `?? null` fallbacks and
// .passthrough keeps the many fields we ignore); the identity field each extractor depends on
// is required + typed, so a structurally broken item is caught and that record is skipped
// (fail-closed), never turned into a garbage job.
import { z } from "zod";

const idish = z.union([z.string(), z.number()]); // ATS ids are strings (ashby/lever) or ints (gh/keka/kula)

// ── Greenhouse ── boards-api.greenhouse.io/v1/boards/<slug>/jobs?content=true  (extractGreenhouse)
//   reads: id, title, location.name, offices[].{name,location}, departments[0].name, content,
//          absolute_url, first_published, updated_at
export const GreenhouseJob = z
  .object({
    id: z.number(), // GH board API always returns a numeric id; the extractor uses it directly (no fallback)
    title: z.string().nullish(),
    location: z.object({ name: z.string().nullish() }).nullish(),
    offices: z.array(z.object({ name: z.string().nullish(), location: z.string().nullish() }).passthrough()).nullish(),
    departments: z.array(z.object({ name: z.string().nullish() }).passthrough()).nullish(),
    content: z.string().nullish(),
    absolute_url: z.string().nullish(),
    first_published: z.string().nullish(),
    updated_at: z.string().nullish(),
  })
  .passthrough();

// ── Ashby ── api.ashbyhq.com/posting-api/job-board/<slug>  (extractAshby)
//   reads: id|jobId, title, location|locationName, isRemote, descriptionPlain, descriptionHtml|description,
//          team|department|departmentName, employmentType|employmentTypeName,
//          compensation|compensationTierSummary, applyUrl|jobUrl, publishedAt|publishedDate
export const AshbyJob = z
  .object({
    id: idish.nullish(),
    jobId: idish.nullish(),
    title: z.string().nullish(),
    location: z.string().nullish(),
    locationName: z.string().nullish(),
    isRemote: z.boolean().nullish(),
    descriptionPlain: z.string().nullish(),
    descriptionHtml: z.string().nullish(),
    description: z.string().nullish(),
    applyUrl: z.string().nullish(),
    jobUrl: z.string().nullish(),
    publishedAt: z.string().nullish(),
    publishedDate: z.string().nullish(),
  })
  .passthrough()
  .refine((j) => j.id != null || j.jobId != null, { message: "ashby job has no id/jobId" });

// ── Lever ── api.lever.co/v0/postings/<slug>?mode=json  (extractLever)
//   reads: id, text, categories.{location,allLocations,team,department,commitment}, workplaceType,
//          salaryRange.{min,max,currency}, descriptionPlain, description, descriptionHtml,
//          hostedUrl|applyUrl, createdAt(number)
export const LeverJob = z
  .object({
    id: z.string(),
    text: z.string().nullish(),
    categories: z
      .object({
        location: z.string().nullish(),
        allLocations: z.array(z.string()).nullish(),
        team: z.string().nullish(),
        department: z.string().nullish(),
        commitment: z.string().nullish(),
      })
      .passthrough()
      .nullish(),
    workplaceType: z.string().nullish(),
    salaryRange: z
      .object({ min: z.number().nullish(), max: z.number().nullish(), currency: z.string().nullish() })
      .passthrough()
      .nullish(),
    descriptionPlain: z.string().nullish(),
    description: z.string().nullish(),
    descriptionHtml: z.string().nullish(),
    hostedUrl: z.string().nullish(),
    applyUrl: z.string().nullish(),
    createdAt: z.number().nullish(),
  })
  .passthrough();

// ── Kula ── careers.kula.ai/api/internal/ats_job_posts?accountName=<slug>  (extractKula)
//   reads: id, title, ats_job.{offices[].{location,name,workplace,remote}, workplace,
//          ats_department.name, employment_type, job_description}
export const KulaJob = z
  .object({
    id: idish,
    title: z.string().nullish(),
    ats_job: z
      .object({
        offices: z
          .array(
            z
              .object({
                location: z.string().nullish(),
                name: z.string().nullish(),
                workplace: z.string().nullish(),
                remote: z.boolean().nullish(),
              })
              .passthrough(),
          )
          .nullish(),
        workplace: z.string().nullish(),
        ats_department: z.object({ name: z.string().nullish() }).passthrough().nullish(),
        employment_type: z.string().nullish(),
        job_description: z.string().nullish(),
      })
      .passthrough()
      .nullish(),
  })
  .passthrough();

// ── Keka ── <slug>.keka.com/careers/api/embedjobs/default/active/<guid>  (extractKeka)
//   reads: id, title, jobLocations[] (string OR {city,state,country,countryName,name,locationName}),
//          jobType (string|numeric code), isRemote, departmentName, salaryRangeFormat,
//          salaryRange(string), description, publishedOn
export const KekaJob = z
  .object({
    id: idish,
    title: z.string().nullish(),
    jobLocations: z
      .array(
        z.union([
          z.string(),
          z
            .object({
              city: z.string().nullish(),
              state: z.string().nullish(),
              country: z.string().nullish(),
              countryName: z.string().nullish(),
              name: z.string().nullish(),
              locationName: z.string().nullish(),
            })
            .passthrough(),
        ]),
      )
      .nullish(),
    jobType: z.union([z.string(), z.number()]).nullish(),
    isRemote: z.boolean().nullish(),
    departmentName: z.string().nullish(),
    salaryRangeFormat: z.string().nullish(),
    salaryRange: z.union([z.string(), z.number(), z.object({}).passthrough()]).nullish(),
    description: z.string().nullish(),
    publishedOn: z.string().nullish(),
  })
  .passthrough();

/** The parser registry, keyed by scan-jobs.mjs source name, for the families we schema-validate. */
// ── SmartRecruiters, the per-posting DETAIL document ─────────────────────────
//   api.smartrecruiters.com/v1/companies/<slug>/postings/<id>   (hydrateDescriptions ->
//   smartRecruitersDescription). A SEPARATE external boundary from the list endpoint above: the
//   list response carries no job description at all, so the JD is fetched per posting and this is
//   the shape that comes back.
//   reads: jobAd.sections.{jobDescription,qualifications,additionalInformation,companyDescription}.text
//
// Permissive like every sibling (the reader already guards each section with a typeof check and the
// order table skips whatever is absent), but the ONE thing the reader depends on is typed: each
// section's `text` must be a string. A vendor that starts returning an object or an array there
// would otherwise reach stripHtml() as `[object Object]` and pool a garbage description — which is
// worse than the null this fix exists to eliminate, because a garbage JD is scoreable. safeParse
// failure means the posting is simply not hydrated, and the pool guard then drops it: fail closed.
const SrSection = z.object({ text: z.string().nullish() }).passthrough();
export const SmartRecruitersPostingDetail = z
  .object({
    jobAd: z
      .object({
        sections: z
          .object({
            jobDescription: SrSection.nullish(),
            qualifications: SrSection.nullish(),
            additionalInformation: SrSection.nullish(),
            companyDescription: SrSection.nullish(),
          })
          .passthrough()
          .nullish(),
      })
      .passthrough()
      .nullish(),
  })
  .passthrough();

// ── Workday, the LIST item ───────────────────────────────────────────────────
//   POST <tenant>.<dc>.myworkdayjobs.com/wday/cxs/<tenant>/<site>/jobs   (extractWorkday)
//   reads: title, externalPath, locationsText, postedOn, bulletFields[0] (the req id)
//
// `externalPath` is the ONE field the reader cannot do without: it is both the apply-URL suffix and
// the key the detail endpoint is addressed by, so a posting missing it can be neither linked nor
// hydrated. Typed as a required string for that reason; everything else is permissive like its
// siblings. `locationsText` is deliberately nullish — Workday omits it on some tenants and collapses
// multi-site roles to "5 Locations", which the extractor handles rather than the schema.
export const WorkdayJob = z
  .object({
    title: z.string().nullish(),
    externalPath: z.string(),
    locationsText: z.string().nullish(),
    postedOn: z.string().nullish(),
    bulletFields: z.array(z.string()).nullish(),
  })
  .passthrough();

// ── Workday, the per-posting DETAIL document ─────────────────────────────────
//   GET <tenant>.<dc>.myworkdayjobs.com/wday/cxs/<tenant>/<site>/job/<externalPath>
//   reads: jobPostingInfo.{jobDescription,startDate,jobReqId,country.descriptor,location,timeType}
//
// The list endpoint carries NO description, so — exactly like SmartRecruiters above — the JD is
// fetched per posting and this is the shape that comes back. `jobDescription` must be a string when
// present, for the same reason SrSection.text is typed: a vendor returning an object there would
// reach stripHtml() as "[object Object]" and pool a garbage, scoreable description. safeParse
// failure leaves the posting un-hydrated and the pool guard drops it — fail closed.
//
// `country.descriptor` is why this schema matters beyond the JD: it is the employer's own answer to
// "which country is this role in", and it is the ONLY trustworthy country signal Workday gives.
// The list view's `locationsText` uses bare codes ("IN - Crawfordsville") that cannot be decoded
// safely — see the block comment in quality-gate.mjs.
export const WorkdayPostingDetail = z
  .object({
    jobPostingInfo: z
      .object({
        jobDescription: z.string().nullish(),
        startDate: z.string().nullish(),
        jobReqId: z.string().nullish(),
        timeType: z.string().nullish(),
        location: z.string().nullish(),
        externalUrl: z.string().nullish(),
        country: z.object({ descriptor: z.string().nullish() }).passthrough().nullish(),
      })
      .passthrough()
      .nullish(),
  })
  .passthrough();

// ── Amazon ── www.amazon.jobs/en/search.json?normalized_country_code[]=<ISO3>  (extractAmazon)
//
// One employer, not one board: the whole company answers from a single keyless GET, so unlike every
// other source here `slug` is a constant and the market is what varies.
//
// `country_code` is ISO-3166 alpha-3 (USA/IND/GBR/AUS/CAN), NOT the alpha-2 the rest of this codebase
// uses. "IN" is silently an empty result set, not an error. The three-letter form is required and
// `AMAZON_MARKETS` is the only place it is written down.
//
// `id_icims` is the employer's own stable posting handle and survives a retitle; `id` is a UUID that
// does not. jobId prefers icims for the same reason Workday prefers bulletFields[0].
export const AmazonJob = z
  .object({
    id: z.string().nullish(),
    id_icims: idish.nullish(),
    title: z.string().nullish(),
    city: z.string().nullish(),
    country_code: z.string().nullish(),
    normalized_location: z.string().nullish(),
    posted_date: z.string().nullish(),
    job_path: z.string().nullish(),
    description: z.string().nullish(),
    basic_qualifications: z.string().nullish(),
  })
  .passthrough();

// ── Eightfold ── <host>/api/apply/v2/jobs?domain=<domain>  (extractEightfold)
//
// A platform, not a company board: one deployment per employer, each on its own host
// (explore.jobs.netflix.net) with its own `domain` query param. Reaches employers no other Charlie
// source touches; the endpoint answers keyless.
//
// `location` is a bare "City,Country" string with no space after the comma, and `locations` repeats
// it as an array. `t_create` is a unix SECONDS timestamp, not milliseconds and not ISO.
// The list response carries `job_description: ""` for every row — the JD lives only on the detail
// document, same as SmartRecruiters and Workday, which is why EightfoldPostingDetail exists.
export const EightfoldJob = z
  .object({
    id: idish.nullish(),
    ats_job_id: z.string().nullish(),
    name: z.string().nullish(),
    posting_name: z.string().nullish(),
    location: z.string().nullish(),
    locations: z.array(z.string()).nullish(),
    department: z.string().nullish(),
    business_unit: z.string().nullish(),
    work_location_option: z.string().nullish(), // "onsite" | "remote" | "hybrid"
    location_flexibility: z.string().nullish(),
    t_create: z.number().nullish(), // unix SECONDS
    t_update: z.number().nullish(),
    canonicalPositionUrl: z.string().nullish(),
    job_description: z.string().nullish(), // always "" in the list; populated on the detail doc
  })
  .passthrough();

export const EightfoldPostingDetail = z
  .object({
    id: idish.nullish(),
    name: z.string().nullish(),
    location: z.string().nullish(),
    job_description: z.string().nullish(), // HTML
  })
  .passthrough();

export const ATS_JOB_SCHEMAS = {
  greenhouse: GreenhouseJob,
  ashby: AshbyJob,
  lever: LeverJob,
  kula: KulaJob,
  keka: KekaJob,
  workday: WorkdayJob,
  amazon: AmazonJob,
  eightfold: EightfoldJob,
};

/** Per-source DETAIL document schemas, for sources whose list endpoint omits the description. */
export const ATS_DETAIL_SCHEMAS = {
  smartrecruiters: SmartRecruitersPostingDetail,
  workday: WorkdayPostingDetail,
  eightfold: EightfoldPostingDetail,
};

/** @typedef {import("zod").infer<typeof GreenhouseJob>} GreenhouseJobType */
/** @typedef {import("zod").infer<typeof AshbyJob>} AshbyJobType */
/** @typedef {import("zod").infer<typeof LeverJob>} LeverJobType */
/** @typedef {import("zod").infer<typeof KulaJob>} KulaJobType */
/** @typedef {import("zod").infer<typeof KekaJob>} KekaJobType */

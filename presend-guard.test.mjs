// presend-guard.test.mjs — proves the three production leaks (repeat, non-India, language) are
// blocked, and that legit roles still send. Pure-function tests (no network/env). Run:
//   node presend-guard.test.mjs      # exits non-zero on any failure
//
// This file gates the daily cron (engine:run: `... && presend-guard.test.mjs && ... && scheduler ...`),
// so it MUST be deterministic — a flaky assertion here silently aborts the whole send. Force the
// stochastic Tier-2 remote-access verifier OFF: it makes a live Haiku call (remote-access-verify.mjs)
// whose verdict on a bare-"Remote" fixture is a coin-flip and would abort the day's send. Tier-2 has
// its own tests; this file only asserts the DETERMINISTIC guard.
process.env.REMOTE_ACCESS_TIER2 = "off";
import assert from "node:assert";
import { repeatDecision, preSendGuard } from "./presend-guard.mjs";
import { canonicalJobIdentity } from "./charlie-store.mjs";
import { homeRegion, reachableForRegion, jobLanguageRequirements, languageBlocker, eligibilityBlocker } from "./quality-gate.mjs";
import { renderEmail, readoutStatus } from "./render-email.mjs";

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log(`PASS  ${name}`); } catch (e) { fail++; console.log(`FAIL  ${name}\n      ${e.message}`); } };

// ── prior sends fingerprint: a "Software Engineer" at HackerRank was already emailed ─────────────
const sig = {
  identities: new Set(["url:boards.greenhouse.io/hackerrank/jobs/123", "ct:hackerrank::software engineer"]),
  roleKeys: new Set(["hackerrank::software engineer"]),
  coreKeys: new Set(["hackerrank::software engineer"]),
  companies: [{ company: "hackerrank", at: new Date().toISOString() }],
};

// ── BUG A: repeat send (the unbreakable rule) ───────────────────────────────────────────────────
t("A1 retitled repost, SAME apply_url → blocked by identity", () => {
  const job = { company: "HackerRank", title: "Backend Engineer II", apply_url: "https://boards.greenhouse.io/hackerrank/jobs/123?utm_source=x" };
  const r = repeatDecision(job, sig);
  assert.ok(r && r.rule === "repeat:identity", `expected repeat:identity, got ${JSON.stringify(r)}`);
});
t("A2 seniority retitle, no url → blocked by core (title-stem)", () => {
  const job = { company: "HackerRank", title: "Software Engineer II" }; // no apply_url
  const r = repeatDecision(job, sig);
  assert.ok(r && (r.rule === "repeat:core" || r.rule === "repeat:company-cooloff"), `expected core/cooloff, got ${JSON.stringify(r)}`);
});
t("A3 functional retitle, different url, within cool-off → blocked by company cool-off", () => {
  const job = { company: "HackerRank", title: "Distributed Systems Engineer", apply_url: "https://lever.co/hackerrank/999" };
  const r = repeatDecision(job, sig);
  assert.ok(r && r.rule === "repeat:company-cooloff" && r.soft === true, `expected soft cooloff, got ${JSON.stringify(r)}`);
});
t("A- different company, fresh → NOT a repeat (must send)", () => {
  const job = { company: "Stripe", title: "Software Engineer", apply_url: "https://stripe.com/jobs/9" };
  assert.strictEqual(repeatDecision(job, sig), null);
});
t("apply_url canonicalization strips www / query / trailing slash", () => {
  const a = canonicalJobIdentity({ apply_url: "https://www.greenhouse.io/hackerrank/jobs/123/?x=1" });
  assert.strictEqual(a, "url:greenhouse.io/hackerrank/jobs/123");
});

// ── BUG B: non-India / eligibility leak ─────────────────────────────────────────────────────────
t("B home region from RESUME even with no preference set", () => {
  assert.strictEqual(homeRegion({ headline: "Product Designer based in Bengaluru" }), "india");
  assert.strictEqual(homeRegion({ contact: { phone: "+91 98765 43210" } }), "india");
  assert.strictEqual(homeRegion({ preferences: { comp_currency: "USD" } }), "us");
});
t("B US-only-remote role NOT reachable for India candidate", () => {
  assert.strictEqual(reachableForRegion({ location: "United States (Remote)" }, "india"), false);
});
t("B blank location + no remote flag → NOT reachable (was treated as global)", () => {
  assert.strictEqual(reachableForRegion({ location: "", remote: false }, "india"), false);
});
t("B genuinely global-remote → reachable", () => {
  assert.strictEqual(reachableForRegion({ location: "Remote" }, "india"), true);
  assert.strictEqual(reachableForRegion({ location: "Bengaluru, India" }, "india"), true);
});
t("B symmetric: India-only role NOT reachable for US candidate", () => {
  assert.strictEqual(reachableForRegion({ location: "Bengaluru, India" }, "us"), false);
  assert.strictEqual(reachableForRegion({ location: "United States (Remote)" }, "us"), true);
});

// ── BUG B2: work-model-as-location ──────────────────────────────────────────────────────────────
// Some ATS configs put the work MODEL in `location` ("Hybrid", "In-Office", "Distributed") and the
// real city in the TITLE. Stripping on-site/in-office/hybrid as if they meant "anywhere" leaves an
// empty residue, the role reads as "bare remote", and falls through to companyHiresIndia — making
// every office job of a company with any India role reachable for a Bengaluru candidate. Conversely
// the residue of "Hybrid or Remote" is the word "or", which must not withhold a real Bangalore role.
t("B2 in-office role with NO place named is NOT reachable (an office we cannot locate)", () => {
  const j = { location: "In-Office", title: "Brand Social Media Intern (Fall 2026)", companyHiresIndia: true };
  assert.strictEqual(reachableForRegion(j, "india"), false); // an Austin desk must not reach a Bengaluru inbox
  assert.strictEqual(reachableForRegion(j, "us"), false); // symmetric: we don't know it's a US office either
});
t("B2 hybrid role in a FOREIGN city is not reachable for either region", () => {
  const beijing = { location: "Hybrid", title: "Business Development Representative, Beijing", companyHiresIndia: true };
  assert.strictEqual(reachableForRegion(beijing, "india"), false);
  assert.strictEqual(reachableForRegion(beijing, "us"), false);
});
t("B2 real city in the TITLE is read when the location names no place", () => {
  // A real India role that must not be withheld.
  const blr = { location: "Hybrid or Remote", title: "Principal Partner Solutions Engineer, SAARC (Based in Bangalore)" };
  assert.strictEqual(reachableForRegion(blr, "india"), true);
  const austin = { location: "Distributed", title: "Account Executive, SLED (Austin)" };
  assert.strictEqual(reachableForRegion(austin, "us"), true);
  // blank location + city in title (a real ATS shape)
  assert.strictEqual(reachableForRegion({ location: null, title: "Dark Store Manager - Kolkata" }, "india"), true);
});
t("B2 a location that names a real place WINS over a title mention", () => {
  // Real pool row: located in Singapore, titled "... India & South East Asia". A Singapore role.
  const sg = { location: "Singapore", title: "GTM Strategy & Operations, India & South East Asia", companyHiresIndia: true };
  assert.strictEqual(reachableForRegion(sg, "india"), false);
});
t("B2 uppercase OR is Oregon, not the conjunction 'or'", () => {
  // Real pool row "Remote - OR". Case-insensitive connective-stripping would erase the only
  // evidence of place and hand a US-state role to an India candidate.
  assert.strictEqual(reachableForRegion({ location: "Remote - OR", companyHiresIndia: true }, "india"), false);
  // ...while the lowercase conjunction must still be treated as noise:
  assert.strictEqual(reachableForRegion({ location: "Hybrid or Remote", title: "Engineer (Based in Bangalore)" }, "india"), true);
});
t("B2 the JD's own 'Available Locations' line settles it, both ways", () => {
  // Most of this employer's office roles carry this line; it is the employer's own answer.
  const blr = { location: "In-Office", title: "Data Scientist", description: "About us. Available Locations - Bengaluru, India", companyHiresIndia: true };
  assert.strictEqual(reachableForRegion(blr, "india"), true); // rescued: a REAL Bengaluru role
  assert.strictEqual(reachableForRegion(blr, "us"), false); // ...and correctly not a US role
  const austin = { location: "Distributed", title: "Data Scientist", description: "Available Locations: Austin, US", companyHiresIndia: true };
  assert.strictEqual(reachableForRegion(austin, "india"), false); // ruled out despite companyHiresIndia
  assert.strictEqual(reachableForRegion(austin, "us"), true);
});
t("B2 multi-word work models are fully stripped ('Hybrid; In-Office')", () => {
  // A non-global strip leaves "In Office", which reads as a place name and suppresses the
  // Available-Locations lookup — silently withholding a real Bengaluru role.
  const j = { location: "Hybrid; In-Office", title: "Engineer", description: "Available Locations: Bengaluru, India", companyHiresIndia: true };
  assert.strictEqual(reachableForRegion(j, "india"), true);
});
t("B2 does not regress genuine remote / explicit-India rows", () => {
  assert.strictEqual(reachableForRegion({ location: "Remote India", title: "Customer Engineer, India" }, "india"), true);
  assert.strictEqual(reachableForRegion({ location: "Remote", companyHiresIndia: true }, "india"), true);
  assert.strictEqual(reachableForRegion({ location: "Remote", companyHiresIndia: false }, "india"), false);
  assert.strictEqual(reachableForRegion({ location: "United States (Remote)" }, "india"), false);
});

// ── BUG C: language requirement leak ────────────────────────────────────────────────────────────
const englishOnly = { preferences: { languages: ["English"] } };
t("C German fluency required (native phrasing) → blocked for English-only", () => {
  const job = { title: "Backend Engineer", description: "You bring verhandlungssicheres Deutsch (C1 German required) and 5 years experience." };
  assert.deepStrictEqual(jobLanguageRequirements(job), ["german"]);
  assert.deepStrictEqual(languageBlocker(job, englishOnly), ["german"]);
});
t("C 'fluent in German' in body only → detected", () => {
  const job = { title: "Support Lead", description: "Must be fluent in German to support DACH customers." };
  assert.deepStrictEqual(languageBlocker(job, englishOnly), ["german"]);
});
t("C title tag (German) → detected", () => {
  const job = { title: "Account Executive (German Speaking)", description: "Sell to enterprise." };
  assert.deepStrictEqual(languageBlocker(job, englishOnly), ["german"]);
});
t("C- 'German market a plus' → NOT a requirement (must not block)", () => {
  const job = { title: "PM", description: "Experience with the German market is a plus." };
  assert.strictEqual(languageBlocker(job, englishOnly), null);
});
t("C- candidate who speaks German → not blocked", () => {
  const job = { title: "Backend Engineer", description: "Fluent German required." };
  assert.strictEqual(languageBlocker(job, { preferences: { languages: ["English", "German"] } }), null);
});
t("C- English-only role → never blocks", () => {
  assert.strictEqual(languageBlocker({ title: "Engineer", description: "Great communication in English." }, englishOnly), null);
});

// ── BUG G: US work-authorization leak (a role whose LOCATION looked global-remote but the JD demands
//    US work auth / citizenship / clearance the candidate can't get). Location-only checks miss this.
t("G US work-auth required → blocked for an India candidate", () => {
  assert.strictEqual(eligibilityBlocker({ title: "Engineer", description: "Fully remote. Must be authorized to work in the US." }, "india"), "requires US work authorization");
});
t("G US citizenship / clearance → blocked for an India candidate", () => {
  assert.strictEqual(eligibilityBlocker({ title: "Engineer", description: "US citizenship required. Active security clearance." }, "india"), "requires US work authorization");
});
t("G US work-auth BUT sponsorship offered → not blocked", () => {
  assert.strictEqual(eligibilityBlocker({ title: "Engineer", description: "Must be authorized to work in the US, however we offer visa sponsorship." }, "india"), null);
});
t("G 'do not offer sponsorship' + US auth → still blocked", () => {
  assert.strictEqual(eligibilityBlocker({ title: "Engineer", description: "Must be authorized to work in the US. We do not offer visa sponsorship." }, "india"), "requires US work authorization");
});
t("G- US candidate clears US work authorization", () => {
  assert.strictEqual(eligibilityBlocker({ title: "Engineer", description: "Must be authorized to work in the US." }, "us"), null);
});
t("G- genuine India / global-remote role → never blocks", () => {
  assert.strictEqual(eligibilityBlocker({ title: "Designer", description: "Remote from India, Bengaluru preferred." }, "india"), null);
  assert.strictEqual(eligibilityBlocker({ title: "Designer", description: "Remote, work from anywhere." }, "india"), null);
});

// ── BUG H: bare "Remote" from a US-only company leaked to India (company-context signal) ──────────
// A role whose location is just "Remote" was treated as globally reachable. It's only trustworthy as
// global if the company actually hires in India (tagCompanyReach sets companyHiresIndia from the pool).
t("H bare Remote at a company that hires in India → reachable", () => {
  assert.strictEqual(reachableForRegion({ location: "Remote", companyHiresIndia: true }, "india"), true);
});
t("H bare Remote at a company with NO India footprint → NOT reachable for India", () => {
  assert.strictEqual(reachableForRegion({ location: "Remote", companyHiresIndia: false }, "india"), false);
});
t("H- unannotated bare Remote stays global (back-compat, no over-block)", () => {
  assert.strictEqual(reachableForRegion({ location: "Remote" }, "india"), true);
});
t("H- an India-located role is reachable even when the company flag is false", () => {
  assert.strictEqual(reachableForRegion({ location: "Bengaluru, India", companyHiresIndia: false }, "india"), true);
});
t("H- bare Remote at a US-only company is fine for a US candidate", () => {
  assert.strictEqual(reachableForRegion({ location: "Remote", companyHiresIndia: false }, "us"), true);
});

// ── FAIL-CLOSED additions ─────────────────────────────────────────────────────────────────────
// Async guard test needs its own runner (the `t` above is sync-only).
const at = async (name, fn) => { try { await fn(); pass++; console.log(`PASS  ${name}`); } catch (e) { fail++; console.log(`FAIL  ${name}\n      ${e.message}`); } };

// D) liveness ambiguity (network can't confirm on a checkable source) → DIGEST via preSendGuard,
//    never a confident solo send and never a hard drop.
await at("D ambiguous liveness (network down on checkable source) → digest, not send/drop", async () => {
  const alwaysThrows = async () => { throw new Error("ECONNRESET"); };
  const g = await preSendGuard({
    job: { id: "greenhouse:acme:1", location: "Remote", remote: true },
    dossier: { headline: "Engineer in Bengaluru" },
    matcherScore: 88,
    signatures: null,
    getCov: async () => ({ thin: true }),
    fetchImpl: alwaysThrows,
  });
  assert.strictEqual(g.decision, "digest", `expected digest, got ${JSON.stringify(g)}`);
});

// E) truncated-JD guard in render-email: the requirements table is suppressed ONLY when the JD is
//    EXPLICITLY truncated (a coverage flag or a visible mid-text cut) — NOT merely long. The engine
//    renders from the full jobs.json description, so a long-but-complete JD still renders the readout
//    (a long JD is not a truncated one).
// render-email signs feedback/unsub links (email-kit), which needs a token secret. Supply a
// throwaway one for the test if the env doesn't already carry it (pure render, no network).
if (!process.env.CHARLIE_TOKEN_SECRET) process.env.CHARLIE_TOKEN_SECRET = "test-only-secret-".repeat(3);
const covLive = {
  thin: false, composite: 72, caption: "my read", confidence: "high", counts: { met: 2, partial: 1, unknown: 0 },
  coverage: [{ req: "5y React", status: "met", evidence: "x" }, { req: "GraphQL", status: "partial", evidence: null }],
  topMove: "surface your real GraphQL work", reason: "solid fit",
  // The first-pass read is the requirements readout. These four assertions are about
  // TRUNCATION — a full JD renders the readout, a visibly-cut one suppresses it — so the fixture
  // needs whatever the readout currently consumes. Without `screen` the section renders empty and
  // the positive cases fail for the wrong reason.
  seniorityLevel: "at",
  subscores: { domain: 0.7, mustHave: 0.8 },
  screen: {
    level: "They ask for five years of React. You have five, two of them leading.",
    domain: "They build developer tools. You built checkout for a marketplace. Different room, same scale of traffic.",
    recent: "Your last year was a checkout redesign in React, which is the work here.",
  },
};
const baseFields = { role_title: "Frontend Engineer", company: "Acme", why_you: "you shipped a checkout redesign", flag: "no explicit GraphQL depth shown" };
// THE READOUT AND why_you DO NOT RENDER as an HTML heading, so an HTML probe would PASS VACUOUSLY in
// both directions. These assertions read `readoutStatus` instead: it decides the readout telemetry,
// and jdWasTruncated governs whether a cut-off JD is ever treated as scoreable. It also names WHY.
await at("E full (untruncated) JD → coverage is scoreable (no regression)", () => {
  assert.equal(readoutStatus(covLive, "x".repeat(1200)), "shown", "a full JD must be scoreable");
});
await at("E long-but-complete JD (>= former 2500 cap) → still scoreable (E5: length is not truncation)", () => {
  assert.equal(readoutStatus(covLive, "x".repeat(2500)), "shown", "length alone must never read as truncation");
});
await at("E JD that visibly ends mid-text (trailing ellipsis) → suppressed", () => {
  assert.equal(readoutStatus(covLive, `${"x".repeat(1200)}…`), "hidden:jd_truncated", "a visibly-cut JD must be suppressed");
});
await at("E cov.jdTruncated marker → suppressed too", () => {
  assert.equal(readoutStatus({ ...covLive, jdTruncated: true }, "x".repeat(500)), "hidden:jd_truncated", "the explicit marker must suppress");
});

// F) GEO HARD STOP: a US role must DROP (not digest, not send) for an India candidate, and an
//    unknown-region candidate defaults to India so foreign roles are dropped. Genuine global-remote
//    still sends. US roles must never reach the India cohort.
const liveFetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => "" });
await at("F US role for an India candidate → DROP (hard stop)", async () => {
  const g = await preSendGuard({ job: { id: "greenhouse:acme:2", location: "United States (Remote)", apply_url: "https://x/2" }, dossier: { headline: "Designer in Bengaluru" }, matcherScore: 88, signatures: null, getCov: async () => ({ thin: true }), fetchImpl: liveFetch });
  assert.strictEqual(g.decision, "drop", `expected drop, got ${JSON.stringify(g)}`);
});
await at("F unknown-region candidate defaults to India → US role DROPPED", async () => {
  const g = await preSendGuard({ job: { id: "greenhouse:acme:3", location: "San Francisco", apply_url: "https://x/3" }, dossier: { headline: "Senior Product Manager" }, matcherScore: 88, signatures: null, getCov: async () => ({ thin: true }), fetchImpl: liveFetch });
  assert.strictEqual(g.decision, "drop", `expected drop, got ${JSON.stringify(g)}`);
});
await at("F genuine global-remote still SENDS for an India candidate (not over-blocked)", async () => {
  // A GENUINELY global-remote role: the JD says so in words ("work from anywhere in the world"), so the
  // deterministic Tier-1 reachability (remoteAccessibility === "open") passes it — no model call, no
  // coin-flip. A bare placeless "Remote" with zero evidence is the ambiguous case Tier-2 judges in prod
  // and is deliberately NOT what this deterministic gate asserts.
  const g = await preSendGuard({ job: { id: "greenhouse:acme:4", location: "Remote", remote: true, description: "This role is fully remote — you can work from anywhere in the world.", apply_url: "https://x/4" }, dossier: { headline: "Designer in Bengaluru" }, matcherScore: 88, signatures: null, getCov: async () => ({ thin: true }), fetchImpl: liveFetch });
  assert.strictEqual(g.decision, "send", `expected send, got ${JSON.stringify(g)}`);
});


// ── HARD CONSTRAINTS enforced BEFORE the send, not flagged after it ──────────────────────────────
// send-audit.mjs carries the rule "a remote-only person must not be handed a role in another city".
// An audit that runs only AFTER the send finds the mismatch once the email is already in an inbox, so
// preSendGuard consults the SAME auditRole function before the gate.
const remoteWanter = { preferences: { remote: "remote", home_place: "Bangalore, India" }, proof_points: ["a"], strengths: ["b"] };
const liveJob = (over = {}) => ({ id: "gh:acme:1", company: "Acme", title: "Product Manager", location: "Noida, India", description: "x".repeat(400), apply_url: "https://acme.example/jobs/1", ...over });

await (async () => {
  const g = await preSendGuard({ job: liveJob(), dossier: remoteWanter, matcherScore: 90, signatures: null, getCov: async () => ({ thin: false, composite: 90 }) });
  t("remote-wanter + office role in another city -> DIGEST, never a solo send", () => {
    assert.equal(g.decision, "digest");
    assert.match(g.rule, /constraint:location:remote-mismatch/);
  });
})();

await (async () => {
  // Not a drop: the role is still real and still reaches the weekly digest, exactly like a cool-off.
  const g = await preSendGuard({ job: liveJob({ location: "Remote - India" }), dossier: remoteWanter, matcherScore: 90, signatures: null, getCov: async () => ({ thin: false, composite: 90 }) });
  t("a genuinely remote role is NOT blocked for a remote-wanter", () => {
    assert.notEqual(g.rule, "constraint:location:remote-mismatch");
  });
})();

await (async () => {
  const g = await preSendGuard({ job: liveJob({ location: "Bangalore, India" }), dossier: remoteWanter, matcherScore: 90, signatures: null, getCov: async () => ({ thin: false, composite: 90 }) });
  t("an office role IN their own home city is still allowed through the constraint check", () => {
    assert.notEqual(g.rule, "constraint:location:remote-mismatch");
  });
})();

// A person whose acceptable cities live INSIDE the remote preference, with no `home_place` at all.
// This is common among people who want remote; reading `home_place` alone would drop every office
// role in the cities they just listed — silence, not a bad send.
const namedCities = {
  preferences: { remote: "mostly remote, though Bangalore, Cochin or Hubli would work" },
  proof_points: ["a"], strengths: ["b"],
};

await (async () => {
  const g = await preSendGuard({ job: liveJob({ location: "Bangalore, KA, India" }), dossier: namedCities, matcherScore: 90, signatures: null, getCov: async () => ({ thin: false, composite: 90 }) });
  t("a city named in the remote preference itself counts, with no home_place set", () => {
    assert.notEqual(g.rule, "constraint:location:remote-mismatch");
  });
})();

await (async () => {
  // She wrote "Cochin"; the employer writes "Ernakulam". Same place — the alias table must apply to
  // cities read out of the preference string exactly as it does to home_place.
  const g = await preSendGuard({ job: liveJob({ location: "Ernakulam, Kerala, India" }), dossier: namedCities, matcherScore: 90, signatures: null, getCov: async () => ({ thin: false, composite: 90 }) });
  t("an alias of a named city counts too (Cochin/Ernakulam)", () => {
    assert.notEqual(g.rule, "constraint:location:remote-mismatch");
  });
})();

await (async () => {
  // The widening stops at what she typed. She never said Ahmedabad, so Ahmedabad is still blocked —
  // this must not become "any office role in India is fine now".
  const g = await preSendGuard({ job: liveJob({ location: "Ahmedabad, GJ, India" }), dossier: namedCities, matcherScore: 90, signatures: null, getCov: async () => ({ thin: false, composite: 90 }) });
  t("a city she never named is STILL blocked — the rule widens only to her own words", () => {
    assert.match(g.rule, /constraint:location:remote-mismatch/);
  });
})();

await (async () => {
  // The country token must not read as a place. "hybrid in Pune (India), otherwise remote (India)" names ONE city
  // she can reach; treating "India" as acceptable would wave through an office 2,000 km away.
  const countryNamed = { preferences: { remote: "hybrid in Pune (India), otherwise remote (India)" }, proof_points: ["a"], strengths: ["b"] };
  const g = await preSendGuard({ job: liveJob({ location: "Noida, India" }), dossier: countryNamed, matcherScore: 90, signatures: null, getCov: async () => ({ thin: false, composite: 90 }) });
  t("naming a COUNTRY does not open every office in it", () => {
    assert.match(g.rule, /constraint:location:remote-mismatch/);
  });
})();

await (async () => {
  // Someone who never asked for remote must be entirely unaffected — this rule may only ever narrow
  // what a remote-wanter receives, never change anyone else's outcome.
  const officeOk = { preferences: { home_place: "Bangalore, India" }, proof_points: ["a"], strengths: ["b"] };
  const g = await preSendGuard({ job: liveJob(), dossier: officeOk, matcherScore: 90, signatures: null, getCov: async () => ({ thin: false, composite: 90 }) });
  t("a person with no remote preference is unaffected by the constraint check", () => {
    assert.notEqual(g.rule, "constraint:location:remote-mismatch");
  });
})();

await (async () => {
  // The constraint runs BEFORE gateRole, so a role that can never be sent never spends a Sonnet
  // coverage call. Asserted because it is the cost half of the fix, and cost regressions are silent.
  let covCalls = 0;
  await preSendGuard({ job: liveJob(), dossier: remoteWanter, matcherScore: 90, signatures: null, getCov: async () => { covCalls++; return { thin: false, composite: 90 }; } });
  t("a constraint-blocked role spends NO coverage call", () => assert.equal(covCalls, 0));
})();

console.log(`\n${fail ? "SOME FAILED" : "ALL PASS"} — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

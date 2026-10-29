// digest-selection.test.mjs — the regression fence for the weekly digest's selection rule.
//
// getEmailedRoleSignatures reads statuses [emailed, digest, new], which INCLUDES the 'digest' finds the
// digest is about to show. Called without an exclusion, every near-miss matches its own canonical
// identity, repeatDecision drops all of them, the digest sends nothing, and the empty-digest path then
// flips every find to 'digest_sent', silently destroying the queue.
//
// So these tests assert the OBSERVABLE OUTCOME (does a near-miss actually reach the digest?) rather than
// the parts. They import the REAL rule (digest-select.mjs) rather than mirroring it, so a regression in the
// rule itself fails here rather than in a real inbox.

import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { selectDigestItems } from "./digest-select.mjs";
import { repeatDecision } from "./presend-guard.mjs";
import { canonicalJobIdentity, roleKey, titleStem, companyKey } from "./charlie-store.mjs";

const CAP = 5;

// Rebuild getEmailedRoleSignatures exactly as charlie-store does, over the same status set, honoring
// excludeIds. Keeps the test pure (no Supabase) while pinning the real contract the caller must satisfy.
function signaturesFrom(rows, { excludeIds = null } = {}) {
  const identities = new Set(), roleKeys = new Set(), coreKeys = new Set(), companies = [];
  for (const r of rows) {
    if (excludeIds && excludeIds.has(r.id)) continue;
    const j = r.job || {};
    identities.add(canonicalJobIdentity(j));
    const rk = roleKey(j.company, j.title); if (rk !== "::") roleKeys.add(rk);
    const ck = `${companyKey(j.company)}::${titleStem(j.title)}`; if (ck !== "::") coreKeys.add(ck);
    if (r.status === "emailed") companies.push({ company: companyKey(j.company), at: r.created_at || null });
  }
  return { identities, roleKeys, coreKeys, companies };
}

const find = (id, company, title, url, status = "digest") => ({
  id, status, created_at: new Date().toISOString(),
  job: { company, title, apply_url: url },
});

// The call digest.mjs makes: signatures scoped to exclude the digest's own in-flight finds.
const runDigest = ({ digestFinds, allRows, emailedKeys = new Set(), isLive = async () => true }) =>
  selectDigestItems({
    digestFinds,
    sig: signaturesFrom(allRows, { excludeIds: new Set(digestFinds.map((f) => f.id)) }),
    emailedKeys, cap: CAP, isLive,
  });

describe("digest selection — the outcome, not the parts", () => {
  it("a near-miss with NO prior emailed role REACHES the digest (the self-drop case)", async () => {
    const f = find("f1", "Acme", "Senior Engineer", "https://boards.greenhouse.io/acme/jobs/999");
    // allRows contains the digest find itself — exactly what the store returns.
    const { items } = await runDigest({ digestFinds: [f], allRows: [f] });
    expect(items).toHaveLength(1);
    expect(items[0].company).toBe("Acme");
  });

  it("an empty digest consumes NOTHING (never burn a queue you did not show)", async () => {
    const { items, consumed } = await runDigest({ digestFinds: [], allRows: [] });
    expect(items).toHaveLength(0);
    expect(consumed).toHaveLength(0);
  });

  it("REGRESSION GUARD: an unscoped signature set makes every item self-drop as repeat:identity", async () => {
    // If a caller ever drops excludeIds, this is what happens.
    const f = find("f1", "Acme", "Senior Engineer", "https://boards.greenhouse.io/acme/jobs/999");
    const selfColliding = signaturesFrom([f]); // no exclusion
    expect(repeatDecision(f.job, selfColliding)?.rule).toBe("repeat:identity");
    const { items, consumed } = await selectDigestItems({ digestFinds: [f], sig: selfColliding, cap: CAP });
    expect(items).toHaveLength(0);       // sends nothing...
    expect(consumed).toEqual(["f1"]);    // ...and retires the find anyway.
  });

  it("a role already EMAILED never reaches the digest, and is retired", async () => {
    const sent = find("e1", "Acme", "Senior Engineer", "https://boards.greenhouse.io/acme/jobs/999", "emailed");
    const near = find("f1", "Acme", "Senior Engineer", "https://boards.greenhouse.io/acme/jobs/999");
    const { items, consumed } = await runDigest({ digestFinds: [near], allRows: [sent, near] });
    expect(items).toHaveLength(0);
    expect(consumed).toContain("f1"); // genuinely retired: they already got it
  });

  it("a retitled repost of an emailed role never reaches the digest", async () => {
    const sent = find("e1", "Acme", "Senior Software Engineer", "https://boards.greenhouse.io/acme/jobs/12345", "emailed");
    const repost = find("f1", "Acme", "Staff Software Engineer", "https://boards.greenhouse.io/acme/jobs/12345");
    const { items } = await runDigest({ digestFinds: [repost], allRows: [sent, repost] });
    expect(items).toHaveLength(0);
  });

  it("capped items are NOT consumed — they roll to next week instead of being destroyed", async () => {
    const finds = Array.from({ length: 7 }, (_, i) =>
      find(`f${i}`, `Co${i}`, `Engineer ${i}`, `https://boards.greenhouse.io/co${i}/jobs/${i}`));
    const { items, consumed } = await runDigest({ digestFinds: finds, allRows: finds });
    expect(items).toHaveLength(CAP);
    expect(consumed).toHaveLength(CAP);   // only the 5 shown
    expect(consumed).not.toContain("f5"); // the 2 over the cap survive for next week
    expect(consumed).not.toContain("f6");
  });

  it("a dead role is consumed but not shown", async () => {
    const f = find("f1", "Acme", "Senior Engineer", "https://boards.greenhouse.io/acme/jobs/999");
    const { items, consumed } = await runDigest({ digestFinds: [f], allRows: [f], isLive: async () => false });
    expect(items).toHaveLength(0);
    expect(consumed).toEqual(["f1"]);
  });

  it("two digest finds for the same role dedupe against each other", async () => {
    const a = find("f1", "Acme", "Senior Engineer", "https://boards.greenhouse.io/acme/jobs/1");
    const b = find("f2", "Acme", "Senior Engineer", "https://boards.greenhouse.io/acme/jobs/2");
    const { items } = await runDigest({ digestFinds: [a, b], allRows: [a, b] });
    expect(items).toHaveLength(1);
  });

  it("a null signature set (DB read failed) does not crash selection", async () => {
    const f = find("f1", "Acme", "Senior Engineer", "https://boards.greenhouse.io/acme/jobs/999");
    const { items } = await selectDigestItems({ digestFinds: [f], sig: null, cap: CAP });
    expect(items).toHaveLength(1);
  });
});

// The rule above is only correct if digest.mjs actually CALLS it correctly. digest.mjs is a top-level
// script (it connects to Supabase on import), so no test can execute its call site. Assert on the source
// instead.
describe("digest.mjs call site", () => {
  const src = readFileSync(new URL("./digest.mjs", import.meta.url), "utf8");

  it("passes excludeIds to getEmailedRoleSignatures (without it the digest self-drops every item)", () => {
    expect(src).toMatch(/getEmailedRoleSignatures\(\s*email\s*,\s*\{\s*excludeIds/);
  });

  it("builds the exclusion set from the digest finds' own ids", () => {
    expect(src).toMatch(/ownIds\s*=\s*new Set\(\s*digestFinds\.map\(/);
  });

  it("delegates selection to the tested rule rather than re-implementing it inline", () => {
    expect(src).toMatch(/selectDigestItems\(/);
    // A raw repeatDecision loop here would mean the rule drifted back out of digest-select.mjs.
    expect(src).not.toMatch(/repeatDecision\(/);
  });
});

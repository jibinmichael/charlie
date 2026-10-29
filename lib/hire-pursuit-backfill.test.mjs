// lib/hire-pursuit-backfill.test.mjs — the backfill mapping from outreach records to pursuits. Every legacy status maps
// to a pursuit that passes the model's invariants, or is reported unmapped; nothing is invented.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { mapOutreachThread, peopleOf, yesListsFromSource } from "./hire-pursuit-backfill.mjs";
import { invariants, stageOf } from "./hire-lifecycle.mjs";

const NOW = Date.parse("2026-10-05T12:00:00Z");
describe("Path O: outreach threads", () => {
  const msg = (from, iso, label = null) => ({ from, at: iso, label, subject: "s", emailId: from === "candidate" ? `e-${iso}` : null });
  const thread = (messages, poolId = 1277) => ({ id: "pd-blr:a@example.com", mandate: "pd-blr", person: { email: "a@example.com", poolId, name: "A" }, messages, lastAt: messages.at(-1).at });

  it("never replied and past the give-up: no response, so no follow-up goes out; inside the wait: still waiting", () => {
    const old = mapOutreachThread(thread([msg("charlie", "2026-09-29T10:00:00Z", "Role outreach")]), { person_id: "p", yes: false, now: NOW });
    expect(old.pursuit).toMatchObject({ engagement: "NO_RESPONSE", ask: null });
    expect(old.flags.join(" ")).toMatch(/no automatic follow-up/);
    const fresh = mapOutreachThread(thread([msg("charlie", "2026-10-04T10:00:00Z", "Role outreach")]), { person_id: "p", yes: false, now: NOW });
    expect(fresh.pursuit).toMatchObject({ engagement: "AWAITING_REPLY", ask: { kind: "INTEREST" } });
    expect(() => mapOutreachThread(thread([msg("charlie", "2026-10-04T10:00:00Z")]), { person_id: "p", yes: false })).toThrow(/clock/);
  });

  it("replied but no human yes: a reply to read, not a guessed interest", () => {
    const r = mapOutreachThread(thread([msg("charlie", "2026-09-29T10:00:00Z", "Role outreach"), msg("candidate", "2026-09-29T12:00:00Z")]), { person_id: "p", yes: false, now: NOW });
    expect(r.pursuit.engagement).toBe("AWAITING_REPLY");
    expect(stageOf(r.pursuit, { job: { id: r.pursuit.job_id, employer_id: r.pursuit.employer_id, lifecycle: "active" } }).stage).toBe("Reply to read");
  });

  it("a human yes and answers after the questions: interested, screening asked, answers to read", () => {
    const r = mapOutreachThread(thread([msg("charlie", "2026-09-29T10:00:00Z", "Role outreach"), msg("candidate", "2026-09-29T12:00:00Z"), msg("charlie", "2026-09-30T10:00:00Z", "Role details and questions"), msg("candidate", "2026-10-01T10:00:00Z")]), { person_id: "p", yes: true, now: NOW });
    expect(r.pursuit).toMatchObject({ engagement: "INTERESTED", screening: { state: "REQUESTED" }, ask: { kind: "SCREENING_ANSWER" }, to_read: { ref: "e-2026-10-01T10:00:00Z" } });
    expect(invariants(r.pursuit)).toEqual([]);
  });

  it("a suppressed address is opted out of every job", () => {
    const r = mapOutreachThread(thread([msg("charlie", "2026-09-29T10:00:00Z", "Role outreach")]), { person_id: "p", yes: false, suppression: "unsubscribe", now: NOW });
    expect(r.pursuit).toMatchObject({ engagement: "OPTED_OUT", ask: null, contact: { state: "WITHDRAWN" } });
  });
});

describe("identity and the yes lists", () => {
  it("the same person from two records is one person", () => {
    const w = peopleOf([{ ref: "m", identity: { email: "a@example.com" } }, { ref: "o", identity: { email: "A@example.com", linkedin_url: "linkedin.com/in/a" } }]);
    expect(w.people).toBe(1);
    expect(w.idOf.get("m")).toBe(w.idOf.get("o"));
  });

});

describe("the inbox's lifecycle per thread (lib/hire-outreach-lifecycle.mjs)", () => {
  const msg = (from, iso, label = null) => ({ from, at: iso, label, subject: "s", emailId: from === "candidate" ? `e-${iso}` : null });
  const t = (id, email, messages) => ({ id, mandate: "pd-blr", person: { email, poolId: 1, name: id }, messages, lastAt: messages.at(-1)?.at });
  const db = (rows) => ({ from: () => ({ select: () => ({ in: async () => ({ data: rows, error: null }) }) }) });

  it("an unsubscribed address reads opted out; a thread that cannot be mapped carries its own error and the rest still map", async () => {
    const { withLifecycle } = await import("./hire-outreach-lifecycle.mjs");
    const out = await withLifecycle(db([{ address: "gone@example.com", reason: "unsubscribe" }]), [
      t("ok", "gone@example.com", [msg("charlie", "2026-10-04T10:00:00Z", "Role outreach")]),
      t("broken", "x@example.com", []),
    ], "pd-blr", Date.parse("2026-10-05T12:00:00Z"));
    expect(out[0].lifecycle).toMatchObject({ stage: "Opted out", engagement: "OPTED_OUT" });
    expect(out[1].lifecycle.error).toBeTruthy();
  });
});

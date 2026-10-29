// first-contact.test.mjs — the first email a stranger sends must LAND SOMEWHERE.
//
// WHAT IT FENCES. Someone writes to start@ without attaching a resume. `/inbound` has no
// `candidates` row for them (no resume => nothing to ground a profile on), so the handler replies
// "One thing, and I'll get you started". That first contact must still be recorded
// (recordFirstContact), or a real human who wrote in leaves no trace anyone can count or follow up on.
// The landing page's prefilled mail must not ask for a pasted link, because onboarding grounds on the
// ATTACHED file and never reads one.
//
// Every inbound reply also goes through lib/send-guard.mjs: a direct resend.emails.send would skip the
// suppression check and record no sent_emails row (no idempotency against webhook redelivery).
//
// WHY THESE ARE STRUCTURAL ASSERTIONS, in the role-attachments.test.mjs idiom: the failure mode here
// is not "the helper is wrong", it is "the helper was never wired to the call site". A unit test of
// recordFirstContact would pass while the drop branch never calls it. So the wiring is what gets
// asserted, and drift fails CI instead of failing a stranger.

import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

const read = (p) => readFileSync(new URL(`./${p}`, import.meta.url), "utf8");
const SERVER = read("server/charlie-remote.ts");

// The `!existing && !resumeText` branch — a NEW person whose resume did not arrive.
function dropBranch(src) {
  const start = src.indexOf("if (!existing && !resumeText) {");
  expect(start, "the resume-missing branch moved or was renamed — re-point this test").toBeGreaterThan(-1);
  return src.slice(start, src.indexOf("\n    }", start));
}

describe("a stranger who writes in without a resume is recorded, not dropped", () => {
  it("the resume-missing branch records the contact before replying", () => {
    const branch = dropBranch(SERVER);
    expect(branch, "the drop branch does not call recordFirstContact — anyone who writes in without an attachment exists in NO store")
      .toMatch(/recordFirstContact\s*\(/);
  });

  it("it records BEFORE the reply goes out, so a send failure cannot lose the person", () => {
    const branch = dropBranch(SERVER);
    const at = branch.indexOf("recordFirstContact");
    const reply = branch.indexOf("renderMissingResume");
    // Both must be PRESENT — otherwise -1 < reply passes this vacuously, which is the exact
    // "test that proves nothing" failure.
    expect(at, "recordFirstContact missing from the drop branch").toBeGreaterThan(-1);
    expect(reply, "renderMissingResume missing from the drop branch").toBeGreaterThan(-1);
    expect(at).toBeLessThan(reply);
  });

  it("recordFirstContact is imported from the store seam, not redefined locally", () => {
    expect(SERVER).toMatch(/^\s*import\s+\{[^}]*recordFirstContact[^}]*\}\s+from\s+"\.\.\/charlie-store\.mjs"/m);
  });
});

describe("recordFirstContact preserves first-contact time and never breaks the reply", () => {
  const STORE = read("charlie-store.mjs");
  const fn = STORE.slice(STORE.indexOf("export async function recordFirstContact"));

  it("treats a duplicate (23505) as a no-op rather than an error", () => {
    // A repeat write must not reset created_at — the value of the row is WHEN they first wrote in.
    expect(fn.slice(0, 800)).toMatch(/23505/);
  });

  it("is fail-soft: a store failure is caught, never thrown at the inbound handler", () => {
    expect(fn.slice(0, 800)).toMatch(/catch\s*\(/);
  });
});

describe("every /inbound reply goes through the ONE send door", () => {
  // The inbound handler is a user-facing send path: suppression and sent_emails idempotency are not
  // optional there. Only lib/send-guard.mjs may call Resend directly.
  const handler = SERVER.slice(SERVER.indexOf('app.post("/inbound"'), SERVER.indexOf("async function sendMailTo"));

  it("no raw resend.emails.send survives anywhere in the inbound handler", () => {
    expect(handler.replace(/^\s*\/\/.*$/gm, ""), "an /inbound reply calls Resend directly — it will mail a suppressed address and leave no sent_emails row")
      .not.toMatch(/resend\.emails\.send\s*\(/);
  });

  it("all inbound sends go through sendGuarded (convo, interrogation, intro@, security-forward, join@ x2)", () => {
    // The guarded inbound sends: the interrogation door, intro@/convo, the security-report
    // owner-forward (to ALERT_EMAIL, not a user reply), and the join@ campaign's candidate send and
    // owner-verdict notify. No inbound path reaches Resend outside the door. The raw-send assertion
    // above is the real backstop; this count fails CI if a NEW unguarded path is added or a guarded
    // one is removed.
    expect(handler.match(/sendGuarded\s*\(\{/g) || []).toHaveLength(6);
    for (const t of ["inbound:intro", "security-forward", "join:", "joinowner:"]) expect(handler).toContain(t);
  });

  it("dedupes on the INBOUND message id, so a webhook redelivery cannot double-reply", () => {
    expect(handler).toMatch(/dedupeKey:\s*String\(d\.email_id/);
  });
});

describe("unsubscribe is not a one-way door (the reply exception is WIRED, not just written)", () => {
  const handler = SERVER.slice(SERVER.indexOf('app.post("/inbound"'), SERVER.indexOf("async function sendMailTo"));

  it("every sendGuarded call in the inbound handler overrides isSuppressed with the reply policy", () => {
    // A pure policy nobody passes to sendGuarded protects nothing.
    const calls = handler.match(/sendGuarded\s*\(\{/g) || [];
    const wired = handler.match(/deps:\s*\{\s*isSuppressed:\s*replyAllowed\s*\}/g) || [];
    expect(wired).toHaveLength(calls.length);
  });

  it("the policy comes from the tested pure function, not a regex retyped at the call site", () => {
    expect(SERVER).toMatch(/^\s*import\s+\{\s*mayReplyDespiteSuppression\s*\}\s+from\s+"\.\.\/lib\/suppression-policy\.mjs"/m);
    expect(handler).toMatch(/mayReplyDespiteSuppression\s*\(/);
    // The reason test must not be reimplemented inline — one source of truth for what opens the door.
    expect(handler.replace(/^\s*\/\/.*$/gm, "")).not.toMatch(/\/\^unsubscribe/);
  });

  it("falls back to the ordinary isSuppressed check when the reason does not qualify", () => {
    expect(handler).toMatch(/return\s+isSuppressed\(addr\)/);
  });
});

describe("the landing page asks for what the backend can actually read", () => {
  const PAGE = read("app/page.tsx");

  it("asks the visitor to ATTACH the resume", () => {
    expect(PAGE).toMatch(/attached/i);
  });

  it("never asks for a LINK to a resume — onboarding cannot read one", () => {
    // The exact wording that sent people into the drop branch.
    expect(PAGE, "the prefilled mail asks for a resume LINK; onboarding grounds on the attached file's text and never fetches a URL, so this steers people into the resume-missing branch")
      .not.toMatch(/link to my resume/i);
  });
});

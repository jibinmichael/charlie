// campaign-loop.test.mjs — the join@ orchestration invariants, with injected mocks (no live email, no
// live model). The two load-bearing claims: the model NEVER advances/rejects (only a human verdict
// does), and every gate/read fails closed.
import { describe, it, expect } from "vitest";
import { handleJoinReply, handleOwnerVerdict } from "./campaign-loop.mjs";
import { CAMPAIGN_OPENERS } from "./render-campaign.mjs";
import { turnCap, CAMPAIGN_RULES } from "./campaign-rules.mjs";

// a fresh mock deps object; `state` holds the one applicant row, `sent` records candidate-facing sends.
function mk({ app = null, facts = { hasCandidate: true, hasDeliveredMatch: true }, model = null, readThrows = false } = {}) {
  const sent = [];
  const owner = [];
  let row = app;
  const deps = {
    getJoinApplicant: async () => { if (readThrows) throw new Error("db down"); return row; },
    upsertJoinApplicant: async (_e, patch) => { row = { ...(row || {}), ...patch }; return row; },
    appendJoinTranscript: async (_e, entry) => { row = { ...(row || {}), transcript: [...(row?.transcript || []), entry] }; return row; },
    orderGateFacts: async () => facts,
    askModel: async () => model,
    lintOk: () => true,
    sendCandidate: async (_e, kind, args) => { sent.push({ kind, args }); },
    notifyOwner: async (_e, phase) => { owner.push(phase); },
    buildRejectBoard: async () => ({ rows: [{ label: "GTM automation and tooling", weight: 100, shown: false }, { label: "Customer discovery", weight: 66, shown: true }] }),
    isOwner: (from) => from === "owner@example.com",
    maxTurns: 6,
    log: () => {},
  };
  return { deps, sent, owner, get row() { return row; } };
}

describe("the gate is deterministic and fails closed", () => {
  it("redirects an applicant who never onboarded (Case 2)", async () => {
    const m = mk({ app: { stage: "applied" }, facts: { hasCandidate: false, hasDeliveredMatch: true } });
    const r = await handleJoinReply({ from: "a@b.com", text: "my second letter" }, m.deps);
    expect(r.action).toBe("redirect");
    expect(m.sent).toEqual([{ kind: "redirect", args: undefined }]);
    expect(m.row.stage).toBe("redirected");
  });

  it("an application that ignored the two questions is sent back, and the OWNER never sees it", async () => {
    // An application that ignores the posting's questions.
    //
    // The load-bearing assertion is `owner` staying EMPTY. This is not a rejection — the verdict is
    // 100% human and no human has looked yet — so it must not consume the owner's attention, and a
    // non-answer must not be stored as a submission where it would sit in the queue looking like one.
    const m = mk({ app: { stage: "applied" } });
    const r = await handleJoinReply({ from: "a@b.com", text: "PFA my resume. Interested in this role." }, m.deps);
    expect(r.action).toBe("incomplete");
    expect(m.sent).toEqual([{ kind: "incomplete", args: undefined }]);
    expect(m.owner, "the owner must not be notified about a non-answer").toEqual([]);
    expect(m.row.transcript, "a non-answer is not a submission").toBeUndefined();
    expect(m.row.stage, "they stay applied, so writing again properly still works").toBe("applied");
  });

  it("a real answer passes straight through to the human", async () => {
    // The other half. If this ever fails, the gate has started rejecting people, which it must not do.
    const m = mk({ app: { stage: "applied" } });
    const r = await handleJoinReply({ from: "a@b.com", text: "I signed up and the onboarding asked me things no job site has. It felt uncomfortable in a good way." }, m.deps);
    expect(r.action).toBe("owner_review");
    expect(m.owner).toEqual(["prescreen"]);
  });

  it("does NOT send anything when the DB read throws (fail closed)", async () => {
    const m = mk({ readThrows: true });
    const r = await handleJoinReply({ from: "a@b.com", text: "x" }, m.deps);
    expect(r.action).toBe("error");
    expect(m.sent).toEqual([]); // no phantom send on an unknown state
  });
});

describe("the model never advances anyone — the verdict is 100% human", () => {
  it("a passed gate hands to the OWNER, it does not auto-advance to the challenge", async () => {
    const m = mk({ app: { stage: "applied" } });
    // A realistic application body: the attempt gate reads a very short reply as a non-answer, so
    // the fixture must be something an actual applicant would send. The ONE thing this test is for:
    // a passed gate goes to the human.
    const r = await handleJoinReply({ from: "a@b.com", text: "I signed up and the onboarding asked me things no job site has bothered to ask." }, m.deps);
    expect(r.action).toBe("owner_review");
    expect(m.owner).toEqual(["prescreen"]);       // owner notified
    expect(m.sent).toEqual([]);                     // NOTHING sent to the candidate yet
    expect(m.row.stage).toBe("prescreen_review");
  });

  it("a non-owner reply cannot cast a verdict", async () => {
    const m = mk({ app: { stage: "prescreen_review" } });
    const r = await handleOwnerVerdict({ from: "imposter@x.com", text: "advance a@b.com", targetFrom: "a@b.com" }, m.deps);
    expect(r.action).toBe("not_owner");
    expect(m.sent).toEqual([]);
  });

  it("only the owner's typed 'advance' starts the challenge", async () => {
    const m = mk({ app: { stage: "prescreen_review" } });
    const r = await handleOwnerVerdict({ from: "owner@example.com", text: "advance", targetFrom: "a@b.com" }, m.deps);
    expect(r.action).toBe("advanced_to_challenge");
    expect(m.sent[0].kind).toBe("kickoff");
    expect(m.row.stage).toBe("challenge");
  });

  it("the owner's 'reject' at prescreen sends the grounded board", async () => {
    const m = mk({ app: { stage: "prescreen_review" } });
    const r = await handleOwnerVerdict({ from: "owner@example.com", text: "reject", targetFrom: "a@b.com" }, m.deps);
    expect(r.action).toBe("rejected_prescreen");
    expect(m.sent[0].kind).toBe("reject");
    expect(m.sent[0].args.board.rows.length).toBeGreaterThan(0);
    expect(m.row.stage).toBe("rejected");
    expect(m.row.verdict_by).toBe("owner@example.com"); // audit: who cast it
  });

  it("the owner's 'advance' at the final stage sends the let's-talk email", async () => {
    const m = mk({ app: { stage: "verdict_review" } });
    const r = await handleOwnerVerdict({ from: "owner@example.com", text: "advance", targetFrom: "a@b.com" }, m.deps);
    expect(r.action).toBe("advanced_final");
    expect(m.sent[0].kind).toBe("pass");
    expect(m.row.stage).toBe("advanced");
  });
});

describe("the challenge loop is fenced", () => {
  it("falls back to the next fixed opener when the model output is unusable (never an empty send)", async () => {
    const m = mk({ app: { stage: "challenge", turns: 1, transcript: [{ role: "charlie", text: "opener that is not in the bank" }] }, model: "not json at all" });
    const r = await handleJoinReply({ from: "a@b.com", text: "my answer" }, m.deps);
    expect(r.action).toBe("probe");
    expect(m.sent[0].kind).toBe("message");
    expect(typeof m.sent[0].args.message).toBe("string");
    expect(m.sent[0].args.message.length).toBeGreaterThan(0); // a real, governed question went out
  });

  it("a passed reply after the final send (Case 6) shares the call link, once", async () => {
    const m = mk({ app: { stage: "advanced" } });
    const r = await handleJoinReply({ from: "a@b.com", text: "I'm in!" }, m.deps);
    expect(r.action).toBe("calendly");
    expect(m.sent[0].kind).toBe("calendly");
    expect(m.row.stage).toBe("closed");
  });
});

describe("humane guardrails — never overwhelm the applicant (enforced, not prose)", () => {
  it("stops grilling after maxProbesPerOpener and moves to the next question, not another probe", async () => {
    const op = CAMPAIGN_OPENERS[0];
    const transcript = [
      { role: "charlie", text: op }, { role: "candidate", text: "a" },
      { role: "charlie", text: "probe 1" }, { role: "candidate", text: "b" },
      { role: "charlie", text: "probe 2" }, // already at maxProbesPerOpener (2)
    ];
    const m = mk({ app: { stage: "challenge", turns: 3, transcript }, model: JSON.stringify({ message: "probe 3", done: false }) });
    const r = await handleJoinReply({ from: "a@b.com", text: "my answer" }, m.deps);
    expect(r.action).toBe("next_opener");
    expect(m.sent[0].args.message).toBe(CAMPAIGN_OPENERS[1]); // the NEXT question, never a third grilling probe
  });

  it("the turn ceiling: the operator env can lower it but never raise it above the humane max", () => {
    expect(turnCap(3)).toBe(3);
    expect(turnCap(100)).toBe(CAMPAIGN_RULES.maxTurns);
    expect(turnCap(undefined)).toBe(CAMPAIGN_RULES.maxTurns);
  });

  it("never asks more than maxOpeners hard questions (the bank is capped)", () => {
    expect(CAMPAIGN_RULES.maxOpeners).toBeLessThanOrEqual(CAMPAIGN_OPENERS.length);
  });

  it("a premature model 'done' while questions remain moves to the next opener, not a repeated close", async () => {
    // reproduces the smoke-test bug: a weak first answer made the model say done; the old code sent the
    // close line as a probe and repeated it. Now it asks the next question instead of ending early.
    const transcript = [{ role: "charlie", text: CAMPAIGN_OPENERS[0] }, { role: "candidate", text: "not my cup of tea" }];
    const m = mk({ app: { stage: "challenge", turns: 1, transcript }, model: JSON.stringify({ message: "That's everything I wanted to ask.", done: true }) });
    const r = await handleJoinReply({ from: "a@b.com", text: "still not sure" }, m.deps);
    expect(r.action).toBe("probe");                          // did NOT finish to verdict on a premature done
    expect(m.sent[0].args.message).toBe(CAMPAIGN_OPENERS[1]); // asked the NEXT question, not the close line
    expect(m.row.stage).toBe("challenge");
  });

  it("never re-asks a question already sent (model echoes the opener -> move to the next one)", async () => {
    const transcript = [{ role: "charlie", text: CAMPAIGN_OPENERS[0] }, { role: "candidate", text: "my answer" }];
    // the model echoes opener 0 verbatim (the smoke-test bug) instead of probing or advancing
    const m = mk({ app: { stage: "challenge", turns: 1, transcript }, model: JSON.stringify({ message: CAMPAIGN_OPENERS[0], done: false }) });
    const r = await handleJoinReply({ from: "a@b.com", text: "another answer" }, m.deps);
    expect(r.action).toBe("probe");
    expect(m.sent[0].args.message).toBe(CAMPAIGN_OPENERS[1]);      // moved to the next question
    expect(m.sent[0].args.message).not.toBe(CAMPAIGN_OPENERS[0]);  // did NOT re-ask the same one
  });
});

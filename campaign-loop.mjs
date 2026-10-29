// campaign-loop.mjs — the join@ hiring campaign orchestration (the state machine). Isolated + testable:
// all side effects are INJECTED (store, model, send, templates), so the transitions can be unit-tested
// with mocks and no live email or API call. The live inbound handler stays a thin branch that calls
// these two functions. INERT until JOIN_CAMPAIGN=on.
//
// THE INVARIANTS THIS FILE ENFORCES:
//   * The VERDICT is 100% human. The model never advances or rejects anyone. Only handleOwnerVerdict,
//     driven by the owner's typed reply, moves a candidate to advanced/rejected and sends those emails.
//   * Fail closed. A DB read that throws, a model output that fails its schema, a lint block, a missing
//     send — none of these silently guesses. They log and stop, or fall back to a governed default.
//   * The model is fenced. Every generated message clears convo-lint before send; every model output is
//     schema-validated; the loop is hard-capped at maxTurns; the transcript is bounded by the store.
//   * Grounded. The reject board and the near-miss reason are built from the candidate's own material by
//     injected builders; this file never invents a fact about a person.
//
// stages: applied -> (redirected | prescreen_review) ; prescreen_review -(owner advance)-> challenge ;
//         challenge -> verdict_review ; verdict_review -(owner)-> advanced | rejected ; advanced -(reply)->
//         closed. rejected/redirected/closed are terminal for the loop.

import { attemptVerdict, orderGateVerdict, parseOwnerVerdict } from "./campaign-gate.mjs";
import { CampaignTurn } from "./lib/schemas/campaign-turn.mjs";
import { CampaignSummary } from "./lib/schemas/campaign-summary.mjs";
import { CAMPAIGN_CHALLENGE_SYSTEM } from "./prompts/campaign-challenge.mjs";
import { CAMPAIGN_SCORE_SYSTEM } from "./prompts/campaign-score.mjs";
import { CAMPAIGN_OPENERS } from "./render-campaign.mjs";
import { CAMPAIGN_RULES, turnCap } from "./campaign-rules.mjs";

const stripFences = (t) => String(t ?? "").replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
const jparse = (t) => { try { return JSON.parse(stripFences(t)); } catch { return null; } };

// A candidate reply arrived at join@ (sender is NOT the owner). Route by the applicant's current stage.
// deps: { getJoinApplicant, upsertJoinApplicant, appendJoinTranscript, orderGateFacts, askModel,
//         lintOk, sendCandidate, notifyOwner, buildRejectBoard(unused here), maxTurns, log }
export async function handleJoinReply({ from, text = "" } = {}, deps) {
  const d = deps || {};
  const log = d.log || (() => {});
  let app;
  try {
    app = await d.getJoinApplicant(from);
  } catch (e) {
    log(`[join] read failed for ${from}: ${e.message}`); // fail closed: do nothing, no phantom send
    return { action: "error", reason: "read_failed" };
  }
  const stage = app?.stage || "new";

  // ── new / applied: "the second letter". Deterministic gate, then hand to the human. ──
  if (stage === "new" || stage === "applied" || stage === "redirected") {
    let facts;
    try {
      facts = await d.orderGateFacts(from); // { hasCandidate, hasDeliveredMatch }
    } catch (e) {
      log(`[join] gate facts failed for ${from}: ${e.message}`);
      return { action: "error", reason: "gate_failed" }; // fail closed
    }
    if (orderGateVerdict(facts) === "redirect") {
      await d.sendCandidate(from, "redirect");
      await d.upsertJoinApplicant(from, { stage: "redirected", redirect_count: (app?.redirect_count || 0) + 1, last_msg_at: new Date().toISOString() });
      return { action: "redirect" };
    }

    // ── did they attempt the two things the posting asked for? ──
    //
    // NOT A VERDICT. The campaign's standing rule is that the human decides who passes, so this never
    // judges whether an answer was GOOD — only whether the questions were ATTEMPTED, which is a fact
    // about the message. It sends the two questions back and stops. They may write again immediately.
    //
    // The owner is NOT notified and no transcript is stored: nothing here is a judgement worth a
    // human's attention, and storing a non-answer as a submission would put it in front of the owner
    // as if it were one. `attemptVerdict` fails OPEN, so anything ambiguous reaches the human anyway.
    if (attemptVerdict(text) === "incomplete") {
      await d.sendCandidate(from, "incomplete");
      await d.upsertJoinApplicant(from, { stage: "applied", redirect_count: (app?.redirect_count || 0) + 1, last_msg_at: new Date().toISOString() });
      log(`[join] ${from} did not attempt the two questions — sent them back, owner not notified`);
      return { action: "incomplete" };
    }
    // passed the gate: record their submission and notify the owner. NO auto-advance.
    await d.appendJoinTranscript(from, { role: "candidate", text });
    await d.upsertJoinApplicant(from, { stage: "prescreen_review" });
    await d.notifyOwner(from, "prescreen");
    return { action: "owner_review", phase: "prescreen" };
  }

  // ── challenge loop: a reply to a hard question. Probe, or hand to the human when done. ──
  if (stage === "challenge") {
    await d.appendJoinTranscript(from, { role: "candidate", text });
    const fresh = await d.getJoinApplicant(from);
    const turns = fresh?.turns || 0;
    const openers = CAMPAIGN_OPENERS.slice(0, CAMPAIGN_RULES.maxOpeners); // humane: at most maxOpeners hard questions, never a barrage
    const asked = countOpenersAsked(fresh?.transcript);
    const remaining = openers.slice(asked);
    const cap = turnCap(d.maxTurns);

    // hard cap: never exceed the humane turn ceiling -> close to the human.
    if (turns >= cap || remaining.length === 0) {
      return finishToVerdict(from, d);
    }

    // humane: don't grill. After maxProbesPerOpener follow-ups on one question, move on to the next opener.
    if (probesSinceLastOpener(fresh?.transcript) >= CAMPAIGN_RULES.maxProbesPerOpener) {
      const nextOpener = remaining[0];
      if (!nextOpener) return finishToVerdict(from, d);
      await d.sendCandidate(from, "message", { message: nextOpener });
      await d.appendJoinTranscript(from, { role: "charlie", text: nextOpener });
      await d.upsertJoinApplicant(from, { turns: turns + 1, last_msg_at: new Date().toISOString() });
      return { action: "next_opener" };
    }

    // ask the model for the next probe / opener. Fail closed to the next fixed opener on any miss.
    let turnOut = null;
    try {
      const raw = await d.askModel(CAMPAIGN_CHALLENGE_SYSTEM, buildChallengeUser(remaining, fresh?.transcript));
      const parsed = CampaignTurn.safeParse(jparse(raw));
      if (parsed.success) turnOut = parsed.data;
    } catch (e) {
      log(`[join] challenge model failed for ${from}: ${e.message}`);
    }
    let message = turnOut?.message;
    let done = turnOut?.done === true;
    if (!message || !d.lintOk(message)) {
      // governed fallback: ask the next opener verbatim (never an ungoverned or empty send).
      message = remaining[0];
      done = false;
      if (!message) return finishToVerdict(from, d);
    }
    // never re-ask a question already sent. The model sometimes echoes the last opener verbatim instead
    // of probing or advancing; a candidate re-asked the exact same thing is a broken experience. If the
    // message repeats any prior Charlie turn, move to the next unasked opener instead.
    const priorCharlie = new Set((fresh?.transcript || []).filter((t) => t.role === "charlie").map((t) => t.text));
    if (priorCharlie.has(message)) {
      message = remaining[0];
      done = false;
      if (!message) return finishToVerdict(from, d);
    }
    // If the model declares done while real questions remain, DON'T accept its close (which would
    // otherwise be sent as a probe and repeat). Move to the next unasked opener instead, so a weak first
    // answer never ends the whole thing, the candidate gets the full, fair set. We only truly finish when
    // this was the last opener (remaining <= 1), the turn cap hit, or the openers are exhausted (above).
    if (done && remaining.length > 1) { message = remaining[0]; done = false; }
    await d.sendCandidate(from, "message", { message });
    await d.appendJoinTranscript(from, { role: "charlie", text: message });
    if (done) return finishToVerdict(from, d, { skipModelClose: true }); // last opener + done -> hand to the human
    await d.upsertJoinApplicant(from, { turns: turns + 1, last_msg_at: new Date().toISOString() });
    return { action: "probe" };
  }

  // ── advanced (they passed the final; Case 6 sent). Any reply = "I'm in" -> share the call link. ──
  if (stage === "advanced") {
    await d.sendCandidate(from, "calendly");
    await d.upsertJoinApplicant(from, { stage: "closed", last_msg_at: new Date().toISOString() });
    return { action: "calendly" };
  }

  // terminal stages (rejected / redirected already handled above / closed / prescreen_review /
  // verdict_review): do not re-engage from a stray reply. A reply while awaiting a human verdict is
  // simply recorded, never auto-answered.
  if (stage === "prescreen_review" || stage === "verdict_review") {
    await d.appendJoinTranscript(from, { role: "candidate", text }).catch(() => {});
    return { action: "await_owner" };
  }
  return { action: "noop", stage };
}

// The owner replied. Parse the verdict and EXECUTE it (the only path that advances/rejects). `targetFrom`
// is the applicant resolved from the reply thread when the owner didn't type an address.
// deps: { getJoinApplicant, upsertJoinApplicant, appendJoinTranscript, isOwner, buildRejectBoard,
//         summarize, sendCandidate, calendlyUrl, log }
export async function handleOwnerVerdict({ from, text = "", targetFrom = null } = {}, deps) {
  const d = deps || {};
  const log = d.log || (() => {});
  if (!d.isOwner(from)) return { action: "not_owner" }; // only the owner address is ever honored
  const v = parseOwnerVerdict(text);
  if (!v) return { action: "no_verdict" };
  const target = (v.target || targetFrom || "").toLowerCase();
  if (!target) return { action: "no_target" };
  if (v.verdict === "hold") return { action: "hold" };

  let app;
  try { app = await d.getJoinApplicant(target); } catch (e) { log(`[join] owner read failed: ${e.message}`); return { action: "error" }; }
  if (!app) return { action: "unknown_target" };

  // prescreen decision
  if (app.stage === "prescreen_review") {
    if (v.verdict === "advance") {
      const opener = CAMPAIGN_OPENERS[0];
      await d.sendCandidate(target, "kickoff", { opener });
      await d.appendJoinTranscript(target, { role: "charlie", text: opener });
      await d.upsertJoinApplicant(target, { stage: "challenge", turns: 1, verdict: null, last_msg_at: new Date().toISOString() });
      return { action: "advanced_to_challenge" };
    }
    // reject: build the role-priority explainer, send the honest no.
    let board = { rows: [] };
    try { board = await d.buildRejectBoard(target); } catch (e) { log(`[join] board build failed: ${e.message}`); }
    await d.sendCandidate(target, "reject", { board });
    await d.upsertJoinApplicant(target, { stage: "rejected", verdict: "reject", verdict_by: from, verdict_at: new Date().toISOString() });
    return { action: "rejected_prescreen" };
  }

  // final decision (after the challenge loop)
  if (app.stage === "verdict_review") {
    if (v.verdict === "advance") {
      await d.sendCandidate(target, "pass");
      await d.upsertJoinApplicant(target, { stage: "advanced", verdict: "advance", verdict_by: from, verdict_at: new Date().toISOString(), last_msg_at: new Date().toISOString() });
      return { action: "advanced_final" };
    }
    // reject: the near-miss. The reason is whatever the owner wrote after the verdict keyword (a human,
    // grounded line); empty -> a neutral honest fallback that invents no specific gap.
    const reason = reasonAfterVerdict(text) || "The answers were thoughtful, but they did not fully clear the bar for this particular seat.";
    await d.sendCandidate(target, "nearmiss", { reason });
    await d.upsertJoinApplicant(target, { stage: "rejected", verdict: "reject", verdict_by: from, verdict_at: new Date().toISOString() });
    return { action: "rejected_final" };
  }

  return { action: "no_pending_decision", stage: app.stage };
}

// ── helpers ──────────────────────────────────────────────────────────────────
async function finishToVerdict(from, d, { skipModelClose = false } = {}) {
  const fresh = await d.getJoinApplicant(from);
  let summary = null;
  try {
    const raw = await d.askModel(CAMPAIGN_SCORE_SYSTEM, JSON.stringify({ transcript: fresh?.transcript || [] }));
    const parsed = CampaignSummary.safeParse(jparse(raw));
    if (parsed.success) summary = parsed.data;
  } catch (e) {
    (d.log || (() => {}))(`[join] summary model failed for ${from}: ${e.message}`); // owner still gets the raw transcript
  }
  await d.upsertJoinApplicant(from, { stage: "verdict_review", scores: summary, last_msg_at: new Date().toISOString() });
  await d.notifyOwner(from, "final", { summary });
  return { action: "owner_review", phase: "final" };
}

function buildChallengeUser(remaining, transcript) {
  return JSON.stringify({
    OPENERS_REMAINING: remaining,
    TRANSCRIPT: (transcript || []).map((t) => ({ role: t.role, text: t.text })),
  });
}

// how many openers have already been asked = the count of charlie turns that exactly match a known opener.
function countOpenersAsked(transcript) {
  const set = new Set(CAMPAIGN_OPENERS);
  return (transcript || []).filter((t) => t.role === "charlie" && set.has(t.text)).length;
}

// how many probes (charlie turns that are NOT an opener) have followed the most recent opener. Enforces
// the humane "don't grill" cap — after maxProbesPerOpener, the loop moves on instead of digging further.
function probesSinceLastOpener(transcript) {
  const set = new Set(CAMPAIGN_OPENERS);
  const t = transcript || [];
  let lastOpener = -1;
  for (let i = t.length - 1; i >= 0; i--) { if (t[i].role === "charlie" && set.has(t[i].text)) { lastOpener = i; break; } }
  return t.slice(lastOpener + 1).filter((x) => x.role === "charlie" && !set.has(x.text)).length;
}

// the owner's reason for a final reject = everything after the leading verdict keyword line.
function reasonAfterVerdict(text) {
  const s = String(text || "").trim();
  const nl = s.indexOf("\n");
  const rest = nl >= 0 ? s.slice(nl + 1) : s.replace(/^\s*(advance|reject|hold)\b[\s:,\-]*[^\s@]*@?[^\s]*/i, "");
  return rest.trim().replace(/\r/g, "") || "";
}

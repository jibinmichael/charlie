// first-role.mjs — the AHA moment. Right after someone onboards by email, find their single
// best above-bar role from the shared pool and email it immediately, so the welcome promise
// ("your first role lands within minutes") is real, not a tease. If nothing clears the bar
// yet, we send nothing now — the daily engine will catch it — and the welcome copy already
// covers that ("the moment one clears your bar").
//
// It mirrors the daily send exactly (same matcher, composer, renderer, idempotency, the one
// honest catch) so the first email looks and reads like every email after it. Best-effort:
// it never throws into the caller, so a failed match never blocks onboarding.

import { Resend } from "resend";
import { matchBestRole } from "./match-one.mjs";
import { emailsWithSignal, getDossier, getResume, setFindStatus, getEmailedRoleSignatures, upsertFind, isSuppressed, isV2, chaseReplyTo } from "./charlie-store.mjs";
import { preSendGuard } from "./presend-guard.mjs";
import { sendGuarded } from "./lib/send-guard.mjs"; // the one send door
import { ResendSendPayload } from "./lib/schemas/resend-send.mjs"; // boundary validation for the direct sends
import { composeEmailFields, lookupCompany } from "./composer.mjs";
import { renderEmail, readoutStatus, referralStatus } from "./render-email.mjs";
import { computeCoverage } from "./fit-coverage.mjs";
import { screenForComposer } from "./lib/fit-screen.mjs"; // the read the composer must not argue with
import { newMessageId } from "./threading.mjs";
import { unsubUrlFor, renderFirstRoleClosest, cleanSubject } from "./email-kit.mjs";
import { nextGap } from "./email-onboard.mjs";
import { verifyGrounding, shouldHold } from "./grounding-verify.mjs";
import { citeOrDrop, groundingMode, groundingDecision, hasFitContent } from "./grounding-enforce.mjs"; // cite-or-drop, same decision as the daily send
import { captureError } from "./lib/sentry-node.mjs";
import { postSendAudit } from "./send-audit.mjs"; // post-send self-audit: flag a hard-constraint miss (never auto-corrects)
import { homeRegion, referralRegionAllowed } from "./quality-gate.mjs";
import { computePay, computeMomentum } from "./role-intel.mjs";
import { resolveInlineReferral } from "./referral-inline.mjs";
import { edgeHit, RARE_FIND_LABEL, rareFindSubject } from "./lib/edge-match.mjs"; // Edge Engine (dark)
import { isDryRun, findStatus } from "./lib/dry-run.mjs"; // EMAIL_DRY_RUN covers every send path

export async function sendFirstRole(email, { log = () => {} } = {}) {
  // The role match-one persisted as 'new' for cross-surface dedup. 'new' means IN FLIGHT, and
  // getEmailedRoleSignatures reads it as "this person has seen this posting" — so every exit that does
  // NOT send has to resolve this row, or the role is blocked for them (12h, per charlie-store's
  // STALE_NEW_HOURS). There are eight such exits: v2 cohort, signature read failure, gate DROP, three
  // grounding outcomes, suppression, and a failed send. Resolving them one by one is exactly the kind
  // of thing an edit forgets, so it happens in a `finally`.
  let pendingFindId = null;
  let resolved = false; // the row reached a terminal status of its own (emailed / digest)
  const dry = isDryRun();
  try {
    // There is no allowlist: every real protection is downstream — suppression at the send door, the
    // quality gate, the data-sufficiency drop, and preSendGuard.
    const { role, closest, jobs } = await matchBestRole(email, { log });
    // match-one wrote this row before any of the gates below ran. Arm it now so the `finally` owns it.
    if (role && !dry) pendingFindId = `${email}:${role.id}`;
    const dossier = await getDossier(email);
    // v1 first-role path: the v2 journey delivers the first role itself (fenced out while
    // ONBOARDING_V2 is off).
    if (isV2({ dossier })) { log(`first-role: ${email} is v2 cohort — journey delivers the first role`); return false; }
    if (!role) {
      // No clean above-bar match yet. If we found the closest real, reachable role, send the honest
      // "close, but I can do better once you tell me X" first touch; otherwise stay silent (the
      // welcome copy already covers the wait). This turns dead air into an engagement hook.
      if (closest) return await sendClosest(email, closest, dossier, { log });
      log(`first-role: nothing above bar (and no reachable closest) for ${email} yet`);
      return false;
    }

    // Full parity with the daily scheduler's send path: the ONE choke point every sender must clear
    // is preSendGuard, which stacks the four-vector no-repeat rule (repeatDecision — catches a
    // retitled repost on the same canonical apply_url, which match-one's roleKey-only dedup misses)
    // on top of the quality gate (liveness + region + language + fit floor). match-one already scored
    // + gated best-effort, but only with the weaker gateRole and roleKey dedup, so we re-run the
    // authoritative guard here before a single email goes out.
    // Exclude the role we're about to send from its own repeat-check: matchBestRole already persisted
    // it as a 'new' find (for cross-surface dedup), so without this the guard would see the role's own
    // identity and drop the send as a "repeat".
    //
    // FAIL CLOSED on a read error. repeatDecision treats a falsy signature set as "not a repeat", so
    // swallowing the error would let one transient Supabase blip disable the one unbreakable rule
    // (never send the same role twice) on the path EVERY new user hits. If we cannot verify, we do not
    // send: a missed first-role is recoverable, a duplicate is not. scheduler.mjs lets this throw for
    // the same reason.
    let signatures;
    try {
      signatures = await getEmailedRoleSignatures(email, { excludeId: `${email}:${role.id}` });
    } catch (e) {
      log(`first-role: cannot verify no-repeat for ${email} (${e.message}) — sending nothing`);
      return false;
    }
    const { match: _m, cov: _c, ...guardJob } = role;
    const gate = await preSendGuard({
      job: guardJob,
      dossier,
      matcherScore: role.match?.score,
      signatures,
      getCov: () => computeCoverage({ dossier, jobDescription: guardJob.description, jobTitle: guardJob.title }).catch((e) => ({ thin: true, reason: "error", error: e?.message })), // never an anonymous thin (see fit-coverage.mjs)
    });
    if (gate.decision !== "send") {
      // digest → record for the weekly email; drop → discard. Either way we send NOTHING now.
      if (gate.decision === "digest") {
        await upsertFind({ email, jobId: guardJob.id, job: guardJob, match: role.match, composed: { digest_rule: gate.rule, digest_reason: gate.reason }, status: findStatus("digest", dry), slot: 1 }).catch(() => {});
        resolved = true; // 'digest' is a terminal status of its own; the finally must not overwrite it
      }
      log(`first-role: ${gate.decision.toUpperCase()} (not sent) for ${email} — ${gate.reason}`);
      return false;
    }

    const resumeText = await getResume(email).catch(() => null);
    let companyInsight = null;
    try { companyInsight = await lookupCompany(role.company, { jobHint: role.title }); } catch { /* skip */ }

    // Edge Engine: decide rare-find BEFORE composing so the composer is handed the edge and
    // writes the grounded opening line. Deterministic gate in code; grounded copy in the prompt.
    const isRareFind = await edgeHit(dossier, role); // model-verified + fail-closed
    let fields = await composeEmailFields( // reassigned by cite-or-drop below
      JSON.stringify(dossier, null, 2),
      JSON.stringify(role, null, 2),
      // `gate.cov` is the SAME coverage the guard just computed, so the composer sees the exact read
      // this email will show under why_you. No second call, no extra cost.
      { match: role.match, companyInsight, edge: isRareFind ? dossier.edge : null, screen: screenForComposer(gate.cov) },
    );

    // honesty gate. VERIFY_MODE defaults to ENFORCE (grounding-verify.mjs).
    const grounding = await verifyGrounding({
      sourceText: `${JSON.stringify(dossier)}\n\nRESUME:\n${resumeText || ""}`,
      // edge_frame is a claim about the person, so it goes through the same send-time grounding check —
      // but ONLY the one that will actually render (isRareFind), so an over-produced, unshown frame can
      // never cause a false hold.
      // lede renders under the "Why you" label when why_you is absent/pruned (render-email.mjs), so
      // it is a person-claim too. `flag` does not render, so it is not verified.
      artifactText: JSON.stringify({ why_you: fields.why_you, lede: fields.lede, resume_tips: fields.resume_tips, facts: fields.facts, edge_frame: isRareFind ? fields.edge_frame : null }),
    });
    if (grounding.violations?.length) log(`first-role verify ${email}: ${grounding.severity} — ${grounding.violations.slice(0, 4).map((x) => `"${x.claim}" (${x.issue})`).join(" | ")}`);

    // It is the first email every new user receives, so it takes the same decision as the daily
    // send: hold the unverifiable, prune the localizable, send the grounded remainder.
    const pruned = grounding.violations?.length ? citeOrDrop(fields, null, grounding.violations) : null;
    const decision = groundingDecision(grounding, pruned, groundingMode(), shouldHold);
    // Log WHY, not just THAT. A hold is a silent non-send on the path every new user hits, and the
    // verifier is a model call that is not deterministic on borderline artifacts — so a hold with no
    // verdict is unreproducible after the fact. Name the severity (or the errored path) and the claims.
    if (decision === "hold") {
      const why = grounding.errored
        ? `verifier errored (${grounding.reason || "no reason"}) — uncertainty holds`
        : pruned && pruned.dropped.length === 0
          ? "flagged a claim cite-or-drop could not localize"
          : `severity=${grounding.severity}`;
      const claims = (grounding.violations || []).map((v) => (typeof v === "string" ? v : v.claim || JSON.stringify(v))).slice(0, 3);
      log(`first-role: HELD by grounding verifier for ${email}. ${why}${claims.length ? ` | flagged: ${claims.join(" || ")}` : " | no claims named"}`);
      return false;
    }
    if (decision === "prune") {
      fields = pruned.fields;
      log(`first-role: cite-or-drop removed ${pruned.dropped.length} ungrounded claim(s) for ${email}: ${pruned.dropped.join(" | ")}`);
      if (pruned.allFitDropped) {
        // Nothing grounded left to say about the fit. HOLD rather than substitute a neutral line —
        // silence beats a reason-less email, on the very first one they get.
        log(`first-role: ALL fit claims dropped for ${email} → HELD, not sent`);
        captureError(new Error(`grounding: all fit claims dropped for ${email} (first-role)`), { service: "first-role", kind: "grounding_all_dropped", email });
        return false;
      }
    }

    // Nothing is attached except a drafted intro when a referral resolves.
    const attachments = [];

    const unsubUrl = unsubUrlFor(email);
    const cov = gate.cov || { thin: true }; // reuse the guard's coverage (same as the scheduler) — no second compute
    // US-only pay-vs-market (grounded, fail-open). Momentum needs the full pool (not loaded on the
    // instant AHA path), so it rides the daily send; region + pay + reviews + summary show here.
    const region = homeRegion(dossier);
    const pay = region === "us" ? await computePay(role).catch(() => null) : null;
    let referral = null;
    if (referralRegionAllowed(region)) {
      const rr = await resolveInlineReferral({ email, dossier, company: role.company, jobUrl: role.apply_url || role.url, roleTitle: role.title, location: role.location, region, owner: !!process.env.OWNER_EMAIL && email === process.env.OWNER_EMAIL }).catch(() => null);
      if (rr) { referral = rr.referral; if (rr.introAttachment) attachments.push(rr.introAttachment); }
    }
    // Momentum chip (US-only): open reqs on the company's own ATS, counted
    // over the live pool. Mirrors scheduler.mjs so a new user's FIRST email carries the same grounded
    // enrichment as every email after it. Pure + best-effort: computeMomentum does no network, and a
    // null just hides the chip.
    const momentum = region === "us" ? await computeMomentum(role.company, jobs || []).catch(() => null) : null;
    // The LAST word on fit content, on every path (not only when the verifier flagged something).
    // If the meter will not render AND there is no why_you, the renderer would fall back to the
    // generic lede under the heading "Why you". Hold the send instead, loudly, so the root cause is
    // fixable rather than invisible.
    const fitShown = readoutStatus(cov, role.description) === "shown";
    if (!hasFitContent(fields, { readoutShown: fitShown })) {
      log(`first-role: no fit content for ${email} (readout hidden + no why_you) → HELD, not sent`);
      captureError(new Error(`no fit content for ${email} (first-role, ${role.company})`), { service: "first-role", kind: "no_fit_content", email, jobId: role.id });
      return false;
    }
    // Edge Engine (dark): a first role where the person's grounded rare combo wins earns the
    // "Rare find" badge + rare-fit subject + the opening frame. `isRareFind` computed above (before compose).
    const html = renderEmail({
      fields, match: role.match, cov, label: isRareFind ? RARE_FIND_LABEL : "Today's pick", applyUrl: role.apply_url, via: role.via, viaUrl: role.via_url, unsubUrl,
      email, findId: `${email}:${role.id}`, jobDescription: role.description, jobLocation: role.location, region, pay, momentum, postedAt: role.posted_at, referral,
      edgeFrame: isRareFind ? (fields.edge_frame || null) : null, 
      // Single-user path, so a one-address read is correct here where a per-render query would be
      // wrong in the batch loop. Fails open: an unreadable signals table shows the block.
      proAsked: (await emailsWithSignal("pro_interest").catch(() => new Set())).has(String(email || "").toLowerCase()),
      rawCompensation: role.compensation, employmentType: role.employment_type,
    });
    // Email-trust telemetry: the inputs the renderer ACTUALLY sees, including the real job
    // description, so a TRUNCATED posting is detectable (jdWasTruncated returns false on an absent JD).
    console.error(`[email-trust] ${email}: fit=${readoutStatus(cov, role.description)} referral=${referralStatus(region, referral)}`);
    const subject = cleanSubject(
      isRareFind
        ? rareFindSubject({ roleTitle: fields.role_title || role.title, company: fields.company || role.company })
        : fields.subject || `Found one worth your time: ${fields.role_title || role.title} at ${fields.company || role.company}`,
    );

    const resend = new Resend(process.env.RESEND_API_KEY);
    const from = process.env.CHARLIE_FROM || "charlie@mail.example.com";
    const findId = `${email}:${role.id}`;
    // Reply signal: signed chase+<token>@ Reply-To so a "still chasing this one" reply logs against the
    // exact role (dark until REPLY_SIGNAL=on; omitted when the token can't be built).
    const chaseTo = process.env.REPLY_SIGNAL === "on" ? chaseReplyTo({ email, jobId: role.id, from }) : null;
    const payload = {
      from, to: email, subject, html,
      headers: { "Message-ID": newMessageId("role"), "List-Unsubscribe": `<${unsubUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
      ...(chaseTo ? { replyTo: chaseTo } : {}),
      ...(attachments.length ? { attachments } : {}),
    };
    // Boundary: refuse a structurally broken send before it reaches Resend (fail-closed; caught below).
    const check = ResendSendPayload.safeParse(payload);
    if (!check.success) throw new Error(`refusing malformed first-role send (${findId}): ${check.error.issues.map((i) => `${i.path.join(".") || "(root)"} ${i.message}`).slice(0, 3).join("; ")}`);
    // EMAIL_DRY_RUN must cover every send path, this one included: a safety flag that covers one of two
    // send paths is worse than none, because it is trusted. Stop here, exactly as the scheduler does,
    // before sendGuarded.
    if (dry) {
      resolved = true; // match-one already recorded this as 'dry_run'; there is nothing to resolve
      log(`first-role: DRY RUN — would email "${subject}" to ${email} (${(Buffer.byteLength(html, "utf8") / 1024).toFixed(1)} KB, ${attachments.length} attachment(s)); nothing sent, no find status that blocks a later real send`);
      return false;
    }
    const sent = await sendGuarded({ resend, email, template: "first-role", dedupeKey: findId, payload, idempotencyKey: `find-alert/${findId}`, log });
    if (sent.status === "failed") throw new Error(typeof sent.error === "string" ? sent.error : JSON.stringify(sent.error));
    if (sent.status === "suppressed") return false;
    await setFindStatus(email, findId, "emailed").catch(() => {});
    resolved = true; // delivered; 'emailed' is terminal
    log(`first-role: emailed ${role.company} · ${role.title} to ${email}${sent.status === "duplicate" ? " (idempotency skip)" : ""}`);
    // Post-send self-audit (best-effort, never throws, never auto-corrects): flag a hard-constraint miss.
    await postSendAudit({ dossier, role, email, surface: "first-role", log, capture: captureError });
    return true;
  } catch (e) {
    log(`first-role failed for ${email}: ${e.message}`);
    return false;
  } finally {
    // Nothing was sent and nothing re-statused the row: record that, so the repeat guard stops reading
    // it as a delivered send. 'unsent' is deliberately NOT one of the statuses the guard counts, so the
    // role comes back into play. Best-effort and it can never throw — this runs on the success path too.
    if (pendingFindId && !resolved) {
      await setFindStatus(email, pendingFindId, "unsent").then(
        () => log(`first-role: ${pendingFindId} left unsent — marked 'unsent', so the role is not burned for ${email}`),
        (err) => log(`first-role: could not resolve ${pendingFindId} (${err.message}); it expires from the repeat guard within STALE_NEW_HOURS`),
      );
    }
  }
}

function firstName(full) {
  const tok = String(full || "").trim().split(/\s+/)[0] || "";
  if (!tok) return "";
  return tok === tok.toUpperCase() ? tok.charAt(0).toUpperCase() + tok.slice(1).toLowerCase() : tok;
}

// The honest "closest role" first touch when nothing clears the bar yet: a real, reachable, live
// role framed as "close, not perfect", with the one detail that would sharpen the next match. The
// reply lands in /inbound (which updates preferences). Best-effort; never throws into the caller.
async function sendClosest(email, role, dossier, { log = () => {} } = {}) {
  try {
    if (await isSuppressed(email)) { log(`first-role closest: ${email} suppressed — skip`); return false; }
    const m = renderFirstRoleClosest({ email, name: firstName(dossier?.name), role, gapAsk: nextGap(dossier)?.ask || "", label: "Closest to your profile", findId: `${email}:${role.id}` });
    const resend = new Resend(process.env.RESEND_API_KEY);
    const from = process.env.CHARLIE_FROM || "charlie@mail.example.com";
    const findId = `${email}:${role.id}`;
    const payload = {
      from, to: email, subject: m.subject, html: m.html, text: m.text,
      headers: { "Message-ID": newMessageId("role"), "List-Unsubscribe": `<${unsubUrlFor(email)}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
    };
    // Boundary: refuse a structurally broken send before it reaches Resend (fail-closed).
    const check = ResendSendPayload.safeParse(payload);
    if (!check.success) { log(`refusing malformed first-role closest (${findId}): ${check.error.issues.map((i) => `${i.path.join(".") || "(root)"} ${i.message}`).slice(0, 3).join("; ")}`); return false; }
    // Same as the main path: this is a real send, so EMAIL_DRY_RUN must stop it.
    if (isDryRun()) { log(`first-role closest: DRY RUN — would email "${m.subject}" to ${email}; nothing sent`); return false; }
    const sent = await sendGuarded({ resend, email, template: "first-closest", dedupeKey: findId, payload, idempotencyKey: `first-closest/${findId}`, log });
    if (sent.status !== "sent" && sent.status !== "duplicate") return false;
    await setFindStatus(email, findId, "emailed").catch(() => {});
    log(`first-role: closest ${role.company} · ${role.title} to ${email} (resend ${sent.id || "idempotency"})`);
    return true;
  } catch (e) {
    log(`first-role closest failed for ${email}: ${e.message}`);
    return false;
  }
}

// lib/hire-pursuit-backfill.mjs — READ ONLY: existing outreach records mapped onto pursuits in memory, so a person
// can read where everyone would stand before a single row is written. Pure. The pursuit sync
// (lib/hire-pursuit-sync.mjs) and the inbox lifecycle (lib/hire-outreach-lifecycle.mjs) use the same mapping.
//
// Source: the role-outreach threads (Path O, lib/hire-outreach.mjs).
//
// A legacy record is IMPORTED, not replayed: nothing in the past went through the transition guards
// (no one was assessed under the contract, no consent was recorded), so replaying would either be
// refused or require inventing facts. Instead each pursuit gets the state the record proves, one
// `pursuit.imported` history entry naming its source, and a list of FLAGS for everything the old
// record cannot prove. Every mapped pursuit must still pass invariants(); one that does not is
// reported as unmapped, never written.
import { createPursuit, invariants, LIFECYCLE_VERSION, DEFAULT_POLICY } from "./hire-lifecycle.mjs";
import { identityKeys, resolvePerson } from "./hire-people.mjs";

const H = 3_600_000;
const at = (s) => (s ? Date.parse(s) : null);
// the one lifecycle policy; a caller with its own setting (the Follow-up agent) passes it in
const POLICY = { follow_up_hours: DEFAULT_POLICY.follow_up_hours, give_up_hours: DEFAULT_POLICY.give_up_hours, max_follow_ups: DEFAULT_POLICY.max_follow_ups };

function openAsk(kind, id, opened, { follow_ups = 0, last = opened, policy = POLICY } = {}) {
  return { id, kind, waiting_for: kind, owner: kind === "EMPLOYER_FEEDBACK" ? "employer" : "candidate", opened_at: opened, due_at: last + (follow_ups ? policy.give_up_hours : policy.follow_up_hours) * H, follow_ups, max_follow_ups: policy.max_follow_ups, give_up_hours: policy.give_up_hours };
}

function imported(p, patch, when, source) {
  const next = structuredClone(p);
  Object.assign(next, patch);
  next.history = [...p.history, { type: "pursuit.imported", actor: "operator", at: when, pursuit_id: p.id, job_id: p.job_id, employer_id: p.employer_id, ref: source, from: null, to: null, effects: [], version: LIFECYCLE_VERSION }];
  return next;
}

function finish(pursuit, flags, extra) {
  const broken = invariants(pursuit);
  return broken.length ? { unmapped: true, why: broken, flags, ...extra } : { pursuit, flags, ...extra };
}

/** One identity per person across every path, the same rule the store applies. Conflicts are reported, never merged. */
export function peopleOf(records) {
  const rows = [];
  const conflicts = [];
  const idOf = new Map();
  for (const r of records) {
    const keys = identityKeys(r.identity);
    const v = resolvePerson(keys, rows);
    if (v.action === "conflict") { conflicts.push({ ref: r.ref, reason: v.reason }); idOf.set(r.ref, null); continue; }
    if (v.action === "new") { const row = { id: `person-${rows.length + 1}`, ...keys }; rows.push(row); idOf.set(r.ref, row.id); continue; }
    Object.assign(rows.find((x) => x.id === v.id), v.fill);
    idOf.set(r.ref, v.id);
  }
  return { idOf, conflicts, people: rows.length };
}

/**
 * Path O: one outreach thread (lib/hire-outreach.mjs buildThreads), with the human yes list (HIRE_YES_LISTS_FILE,
 * lib/hire-outreach-lifecycle.mjs yesLists) and the address's suppression, if any.
 */
export function mapOutreachThread(thread, { person_id, yes, suppression, now, job = null, policy: policyIn = null }) {
  const policy = policyIn ? { ...POLICY, ...policyIn } : POLICY;
  if (!Number.isFinite(now)) throw new Error("mapOutreachThread: needs a clock");
  // job: the mandate's hire_jobs row as the lifecycle sees it (lib/hire-pursuit-store.mjs lifecycleJob).
  const flags = job ? [] : ["this role has no hire_jobs row and no named employer: it needs both before it can be written"];
  const email = thread.person.email;
  const lj = job ?? { id: `outreach:${thread.mandate}`, employer_id: `unnamed:${thread.mandate}`, company: null, lifecycle: "active" };
  const ours = thread.messages.filter((m) => m.from === "charlie");
  const replies = thread.messages.filter((m) => m.from === "candidate");
  const first = at(ours[0]?.at);
  const base = createPursuit({ id: `outreach:${thread.mandate}:${email}`, job: lj, person: { id: person_id }, source: "pool", source_at: first, discovery_run: null, open_gaps: [], at: first });
  if (thread.person.poolId == null) flags.push("not found in the talent pool: no contact permission on record");
  flags.push("no reply key on these emails: their replies would route to Reply to read");
  const patch = { sent_to: email, contact: { state: thread.person.poolId == null ? "NONE" : "PERMITTED", basis: thread.person.poolId == null ? null : "pool_consent" } };
  const legacyKey = `legacy:${thread.mandate}:${email}`;
  const qSent = ours.find((m) => m.subject && /question/i.test(m.label ?? "")) ?? ours.find((m) => m.label === "Role details and questions");
  const lastReply = replies.at(-1);
  if (suppression) {
    Object.assign(patch, { engagement: "OPTED_OUT", contact: { ...patch.contact, state: "WITHDRAWN" } });
    flags.push(`suppressed (${suppression}): imported as opted out of every job`);
  } else if (!replies.length) {
    // a wait that has already outlived the follow-up and the give-up is imported as no response, so no
    // automatic follow-up goes to someone months later.
    // a follow-up already sent (the Follow-up agent, label "Follow-up") moves the wait to its give-up
    const followUp = ours.find((m) => m.label === "Follow-up");
    const giveUp = followUp ? at(followUp.at) + policy.give_up_hours * H : first + (policy.follow_up_hours + policy.give_up_hours) * H;
    if (now >= giveUp) {
      patch.engagement = "NO_RESPONSE";
      flags.push(followUp ? "never replied to the first email or the follow-up: no response" : "never replied, past the give-up time: imported as no response, so no automatic follow-up is sent");
    } else if (followUp) {
      Object.assign(patch, { engagement: "AWAITING_REPLY", ask: openAsk("INTEREST", legacyKey, first, { follow_ups: 1, last: at(followUp.at), policy }) });
      flags.push("followed up once; closes if no reply by the give-up time");
    } else {
      Object.assign(patch, { engagement: "AWAITING_REPLY", ask: openAsk("INTEREST", legacyKey, first, { policy }) });
      flags.push("never replied, still inside the wait: one follow-up is due on the usual schedule");
    }
  } else if (yes) {
    patch.engagement = "INTERESTED";
    flags.push("their yes was read by a person and kept in the operator's yes list: imported as interested, recorded as an operator decision");
    if (qSent) {
      const answered = replies.some((r) => at(r.at) > at(qSent.at));
      Object.assign(patch, { screening: { state: "REQUESTED", gaps: [], rounds: 1, asked: [] }, ask: openAsk("SCREENING_ANSWER", `${legacyKey}:q`, at(qSent.at), { policy }) });
      flags.push("questions sent with no recorded permission to screen");
      if (answered) { patch.to_read = { ref: lastReply.emailId ?? `reply:${lastReply.at}`, ask_id: `${legacyKey}:q`, at: at(lastReply.at) }; flags.push("answered; nobody has recorded whether every question was answered"); }
    }
    flags.push("no recorded consent to be introduced to the employer: must be asked");
  } else {
    Object.assign(patch, { engagement: "AWAITING_REPLY", ask: openAsk("INTEREST", legacyKey, first, { policy }), to_read: { ref: lastReply.emailId ?? `reply:${lastReply.at}`, ask_id: legacyKey, at: at(lastReply.at) } });
    flags.push("replied, and no person has recorded what the reply says: imported as a reply to read");
  }
  flags.push("no assessment under the Hiring Contract");
  return finish(imported(base, patch, at(thread.lastAt), `outreach:${thread.mandate}`), flags, { path: "O", ref: thread.id, name: thread.person.name });
}

/**
 * The operator's yes lists (HIRE_YES_LISTS_FILE), read as TEXT: the file is never imported or run.
 * Returns { mandate: Set(poolId) }. A list the parser cannot read is reported, never guessed.
 */
export function yesListsFromSource(src) {
  const out = {};
  const start = src.indexOf("const MANDATES = {");
  if (start < 0) return { error: "no MANDATES block" };
  for (const m of src.slice(start).matchAll(/\n {2}"?([a-z0-9-]+)"?: \{/g)) {
    const from = start + m.index;
    const yesAt = src.indexOf("yes: [", from);
    const nextMandate = src.slice(from + m[0].length).search(/\n {2}"?[a-z0-9-]+"?: \{/);
    const end = nextMandate < 0 ? src.length : from + m[0].length + nextMandate;
    if (yesAt < 0 || yesAt > end) continue;
    const close = src.indexOf("\n    ],", yesAt) > -1 && src.indexOf("\n    ],", yesAt) < end ? src.indexOf("\n    ],", yesAt) : src.indexOf("]", yesAt);
    const body = src.slice(yesAt + 6, close).replace(/\/\/.*$/gm, "").replace(/known: "(?:[^"\\]|\\.)*"/g, "").replace(/ask: \[[^\]]*\]/g, "");
    out[m[1]] = new Set([...body.matchAll(/(?:id: )?\b(\d{2,6})\b/g)].map((x) => Number(x[1])));
  }
  return out;
}

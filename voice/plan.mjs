// voice/plan.mjs — the verification plan: parse the mandate, generate the plan, check every link of
// the chain, approve an immutable version.
//
// THE CHAIN IS DATA, AND IT IS CHECKED IN CODE. Every item must carry:
//   mandate quote -> requirement -> why it matters -> evidence contract -> question -> probes
//   -> expected evidence -> fallback text for every move
// checkChain() names the item and the missing link. approvePlan() refuses on any failure. That is
// what makes "here is what Charlie will ask, and why" a property of the plan rather than a sentence.
//
// THE MODEL NEVER WRITES mandate_quote. buildPlan() fills it from the matrix (quote-checked by
// lib/mandate-parse.mjs verifyQuotes) or from the HR question verbatim, and checkChain() re-checks
// it against the JD text every time, including on a plan loaded back from the database.
//
// NO DEFAULT MODEL. VOICE_PLANNER_MODEL is read and refused if absent, per .env.example.
import { randomUUID } from "node:crypto";
import { MANDATE_PARSE_SYSTEM, buildMandateParseMessages } from "../prompts/mandate-parse.mjs";
import { salvageMandate } from "../lib/schemas/mandate-parse.mjs";
import { verifyQuotes, norm } from "../lib/mandate-parse.mjs";
import { VV_PLAN_SYSTEM, VV_PLAN_PROMPT_VERSION, buildPlanMessages } from "../prompts/vv-plan.mjs";
import { PlanGenOutput, VerificationPlan, FALLBACK_MOVES } from "../lib/schemas/vv-plan.mjs";

export { VV_PLAN_PROMPT_VERSION };

/** Seconds held back from the item budgets for the introduction and the close. */
export const SESSION_RESERVE_SECONDS = 90;

/** Words that expose the mechanism. Candidate-facing text containing one fails the chain check. */
export const MECHANISM_RE = /\b(probe|probes|probing|evidence|verif(?:y|ied|ies|ication)|assess(?:ment|ed|ing)?|scor(?:e|ed|ing)|rubric|evaluat(?:e|ed|ion|ing)|criteria|test(?:ed|ing)?)\b/i;
export const EM_DASH = /—/;

function modelOrRefuse() {
  const m = String(process.env.VOICE_PLANNER_MODEL || "").trim();
  if (!m) throw new Error("VOICE_PLANNER_MODEL is not set. There is no default; see .env.example.");
  return m;
}

function textOf(res) {
  return (res?.content || []).map((b) => b.text || "").join("").trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
}

function parseJsonOrRefuse(raw, what) {
  try { return JSON.parse(raw); } catch { throw new Error(`the model did not return JSON for ${what}. Nothing was written.`); }
}

function issues(err) {
  return err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
}

// ── mandate ──────────────────────────────────────────────────────────────────

/**
 * The mandate service's parse(): one model call, schema, quote check. Same prompt and schema as
 * scripts/mandate-parse.mjs, as a function.
 * @returns {Promise<{matrix: object, dropped: Array}>}
 */
export async function parseMandate({ client, model, jd, sourceName = "" }) {
  if (!String(jd || "").trim()) throw new Error("parseMandate: empty job description");
  const res = await client.messages.create({
    model: model || String(process.env.MANDATE_PARSE_MODEL || "claude-sonnet-4-6"),
    max_tokens: 4000, temperature: 0,
    system: MANDATE_PARSE_SYSTEM, messages: buildMandateParseMessages({ jd, sourceName }),
  });
  const parsed = parseJsonOrRefuse(textOf(res), "the mandate");
  // item by item: a bad item is dropped and reported, never the whole post; no role still refuses
  const ok = salvageMandate(parsed);
  if (!ok.success) throw new Error(`mandate parse did not match the schema: ${ok.error}`);
  const { kept, dropped } = verifyQuotes(ok.data, jd);
  return { matrix: kept, dropped: [...ok.dropped, ...dropped] };
}

// ── refs ─────────────────────────────────────────────────────────────────────

/**
 * Resolve an item ref against the matrix and the HR questions.
 * @returns {{bucket:string, index:number, quote:string, source:object|string}|null}
 */
export function resolveRef(ref, { matrix, questions = [] }) {
  const m = /^(hard|preferred|capabilities|question|intent):(\d+)$/.exec(String(ref || ""));
  if (!m) return null;
  const [, bucket, i] = m;
  const index = Number(i);
  if (bucket === "intent") return index === 0 ? { bucket, index, quote: String(matrix?.role || ""), source: matrix?.role || "" } : null;
  if (bucket === "question") {
    const q = questions[index];
    return typeof q === "string" && q.trim() ? { bucket, index, quote: q.trim(), source: q } : null;
  }
  const it = (matrix?.[bucket] || [])[index];
  return it && it.quote ? { bucket, index, quote: it.quote, source: it } : null;
}

// ── build ────────────────────────────────────────────────────────────────────

/**
 * Turn validated generator output into a plan: ids assigned, refs resolved, mandate_quote filled
 * from the source. An item whose ref does not resolve is DROPPED AND REPORTED, never kept.
 */
export function buildPlan(gen, { matrix, questions = [], sessionBudgetSeconds, mandateId = null, version = 1 }) {
  const dropped = [];
  const items = [];
  for (const g of gen.items) {
    const r = resolveRef(g.ref, { matrix, questions });
    if (!r) { dropped.push({ ref: g.ref, reason: "ref does not resolve to the matrix or a question" }); continue; }
    items.push({
      id: randomUUID(),
      requirement_id: null,   // linked by ref at save time (voice/store.mjs)
      ref: g.ref,
      kind: g.kind,
      priority: g.priority,
      budget_seconds: g.budget_seconds,
      evidence_contract: { ...g.contract, mandate_quote: r.quote },
    });
  }
  const plan = {
    id: randomUUID(),
    mandate_id: mandateId,
    version,
    status: "draft",
    session_budget_seconds: sessionBudgetSeconds,
    consent_text_version: null,
    flagged: gen.flagged || [],
    override_reason: null,
    approved_by: null,
    approved_at: null,
    items,
  };
  return { plan, dropped };
}

// ── chain check ──────────────────────────────────────────────────────────────

/**
 * Every link, for every item. Pure.
 * @returns {{ok:boolean, failures:Array<{itemId:string|null, ref:string|null, link:string, detail:string}>}}
 */
export function checkChain(plan, { jdText = "", questions = [] } = {}) {
  const failures = [];
  const fail = (item, link, detail) => failures.push({ itemId: item?.id ?? null, ref: item?.ref ?? null, link, detail });

  const shape = VerificationPlan.safeParse(plan);
  if (!shape.success) {
    fail(null, "schema", issues(shape.error));
    return { ok: false, failures };
  }
  const p = shape.data;
  const hay = norm(jdText);
  const qs = questions.map((q) => norm(q));

  let total = 0;
  const intents = p.items.filter((it) => it.kind === "intent").length;
  if (intents !== 1) fail(null, "intent", `expected exactly one intent item, found ${intents}`);

  for (const it of p.items) {
    const c = it.evidence_contract;
    total += it.budget_seconds;

    // requirement: the ref must resolve to the bucket its kind implies
    const m = /^(hard|preferred|capabilities|question|intent):(\d+)$/.exec(it.ref);
    if (!m) { fail(it, "requirement", `ref "${it.ref}" is not a matrix, question, or intent ref`); continue; }
    const bucket = m[1];
    if (it.kind === "intent" && bucket !== "intent") fail(it, "requirement", "an intent item must have ref intent:0");
    if (it.kind !== "intent" && bucket === "intent") fail(it, "requirement", `kind ${it.kind} cannot carry an intent ref`);
    if ((it.kind === "hr_fact" || it.kind === "hr_capability") && bucket !== "question") fail(it, "requirement", `kind ${it.kind} must reference a question`);
    if ((it.kind === "capability" || it.kind === "hard_requirement") && !["hard", "preferred", "capabilities"].includes(bucket)) fail(it, "requirement", `kind ${it.kind} must reference the matrix`);

    // mandate quote: in the JD, or verbatim the HR question; the intent item's source is the mandate as a whole
    const q = norm(c.mandate_quote);
    if (bucket === "question") {
      if (!qs.includes(q)) fail(it, "mandate_quote", "the quote is not one of the hiring team's questions verbatim");
    } else if (bucket !== "intent") {
      if (q.length < 8 || !hay.includes(q)) fail(it, "mandate_quote", "the quote is not in the job description");
    }

    // why
    if (!c.why_it_matters?.trim()) fail(it, "why_it_matters", "missing");

    // contract: at least one required, exactly one core
    const names = new Set(c.elements.map((e) => e.name));
    if (!c.elements.some((e) => e.required)) fail(it, "evidence_contract", "no element is required");
    const cores = c.elements.filter((e) => e.core).length;
    if (cores !== 1) fail(it, "evidence_contract", `expected exactly one core element, found ${cores}`);

    // question
    if (!c.anchor_question?.trim()) fail(it, "anchor_question", "missing");

    // probes: each targets an element that is in this contract
    for (const pr of c.depth_probes) {
      if (!names.has(pr.targets)) fail(it, "depth_probes", `probe targets "${pr.targets}" which is not in this item's contract`);
    }

    // expected evidence
    if (!c.expected_evidence?.trim()) fail(it, "expected_evidence", "missing");

    // fallback for every move
    for (const mv of FALLBACK_MOVES) {
      if (!c.fallback_text?.[mv]?.trim()) fail(it, "fallback_text", `missing "${mv}"`);
    }

    // candidate-facing voice walls
    const facing = [
      ["anchor_question", c.anchor_question],
      ...c.depth_probes.map((pr, i) => [`depth_probes[${i}]`, pr.text]),
      ["ownership_probe", c.ownership_probe],
      ["scenario", c.scenario],
      ...FALLBACK_MOVES.map((mv) => [`fallback_text.${mv}`, c.fallback_text?.[mv]]),
    ];
    for (const [where, text] of facing) {
      if (!text) continue;
      if (EM_DASH.test(text)) fail(it, "voice", `${where} contains an em dash`);
      const w = MECHANISM_RE.exec(text);
      if (w) fail(it, "voice", `${where} exposes the mechanism ("${w[0]}")`);
    }
  }

  const allowed = p.session_budget_seconds - SESSION_RESERVE_SECONDS;
  if (total > allowed) fail(null, "budget", `items total ${total}s, session allows ${allowed}s after the ${SESSION_RESERVE_SECONDS}s reserve`);

  return { ok: failures.length === 0, failures };
}

// ── generate ─────────────────────────────────────────────────────────────────

/**
 * One model call, validated at the boundary, refs resolved, chain checked. Nothing is persisted.
 * @returns {Promise<{plan: object, dropped: Array, chain: {ok:boolean, failures:Array}}>}
 */
export async function generatePlan({ client, model, matrix, questions = [], sessionBudgetSeconds, jdText = "", mandateId = null, version = 1 }) {
  const m = model || modelOrRefuse();
  if (!Number.isInteger(sessionBudgetSeconds) || sessionBudgetSeconds < 60) throw new Error("generatePlan: sessionBudgetSeconds must be an integer of at least 60");
  const res = await client.messages.create({
    model: m, max_tokens: 12000, temperature: 0,
    system: VV_PLAN_SYSTEM, messages: buildPlanMessages({ matrix, questions, sessionBudgetSeconds }),
  });
  const parsed = parseJsonOrRefuse(textOf(res), "the plan");
  const ok = PlanGenOutput.safeParse(parsed);
  if (!ok.success) throw new Error(`the plan did not match the schema, so nothing is kept: ${issues(ok.error)}`);
  const { plan, dropped } = buildPlan(ok.data, { matrix, questions, sessionBudgetSeconds, mandateId, version });
  const chain = checkChain(plan, { jdText, questions });
  return { plan, dropped, chain };
}

// ── approve ──────────────────────────────────────────────────────────────────

function deepFreeze(o) {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

/**
 * Approve a plan: the chain must hold, flags need a recorded override, and the result is an
 * immutable (frozen) approved version handed to `persist`. The caller's plan object is not mutated.
 * @param {object} plan
 * @param {{by:string, jdText:string, questions?:string[], persist:(p:object)=>Promise<any>, override?:string|null, consentTextVersion?:string|null}} opts
 */
export async function approvePlan(plan, { by, jdText, questions = [], persist, override = null, consentTextVersion = null }) {
  if (!by || !/^[^@\s]+@[^@\s]+$/.test(by)) throw new Error("approvePlan: `by` must be the approver's email");
  if (typeof persist !== "function") throw new Error("approvePlan: `persist` is required");
  const chain = checkChain(plan, { jdText, questions });
  if (!chain.ok) {
    const lines = chain.failures.map((f) => `  ${f.ref || "(plan)"} ${f.link}: ${f.detail}`).join("\n");
    throw new Error(`approvePlan refused: the chain does not hold\n${lines}`);
  }
  if ((plan.flagged || []).length && !String(override || "").trim()) {
    throw new Error(`approvePlan refused: ${plan.flagged.length} flagged question(s) and no override reason`);
  }
  const approved = deepFreeze(structuredClone({
    ...plan,
    status: "approved",
    approved_by: by,
    approved_at: new Date().toISOString(),
    override_reason: (plan.flagged || []).length ? String(override).trim() : null,
    consent_text_version: consentTextVersion ?? plan.consent_text_version ?? null,
  }));
  await persist(approved);
  return approved;
}

// ── render ───────────────────────────────────────────────────────────────────

/** The plan as a human reads it: every item with its whole chain, then flags, drops, failures. */
export function renderPlan(plan, { dropped = [], chain = null } = {}) {
  const L = [];
  L.push(`PLAN v${plan.version} · ${plan.status} · ${plan.items.length} items · session ${plan.session_budget_seconds}s (${SESSION_RESERVE_SECONDS}s reserved)`);
  const items = [...plan.items].sort((a, b) => a.priority - b.priority);
  for (const it of items) {
    const c = it.evidence_contract;
    L.push("");
    L.push(`[${it.priority}] ${it.kind} · ${it.ref} · ${it.budget_seconds}s`);
    L.push(`  establishes : ${c.establishes}`);
    L.push(`  quote       : "${c.mandate_quote}"`);
    L.push(`  why         : ${c.why_it_matters}`);
    L.push(`  elements    : ${c.elements.map((e) => `${e.name}${e.core ? " (core)" : ""}${e.required ? "*" : ""}`).join(", ")}   (* required)`);
    L.push(`  anchor      : ${c.anchor_question}`);
    for (const pr of c.depth_probes) L.push(`  probe       : ${pr.text}   -> ${pr.targets}`);
    if (c.ownership_probe) L.push(`  ownership   : ${c.ownership_probe}`);
    if (c.scenario) L.push(`  scenario    : ${c.scenario}`);
    if (c.contradiction_hooks.length) L.push(`  hooks       : ${c.contradiction_hooks.join("; ")}`);
    L.push(`  expected    : ${c.expected_evidence}`);
    L.push(`  fallback    : ${FALLBACK_MOVES.map((mv) => `${mv}="${c.fallback_text[mv]}"`).join(" | ")}`);
  }
  if ((plan.flagged || []).length) {
    L.push("");
    L.push(`FLAGGED (cannot approve without an override reason):`);
    for (const f of plan.flagged) L.push(`  ${f.ref}: ${f.reason}`);
  }
  if (dropped.length) {
    L.push("");
    L.push(`DROPPED (the model wrote an item the material does not contain):`);
    for (const d of dropped) L.push(`  ${d.ref}: ${d.reason}`);
  }
  if (chain) {
    L.push("");
    L.push(chain.ok ? "CHAIN: every link holds." : `CHAIN: ${chain.failures.length} failure(s)`);
    for (const f of chain.failures) L.push(`  ${f.ref || "(plan)"} ${f.link}: ${f.detail}`);
  }
  return L.join("\n");
}

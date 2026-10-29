// lib/qualify/justification.mjs — the justification an employer system receives with a submitted person, written
// from cited quotes only (nothing invented) and refused unless every check passes (no justification, no submission).
//
// Checks, each a refusal: the reply matches JustificationOutput and is not null; code (25 to 90 words, no dash
// or "!", no praise word, every number in it is in the quotes, it cites at least one given quote and only those,
// nothing about pay or notice); then the grounding verifier reads the quotes and the text.
import { HIRE_JUSTIFICATION_SYSTEM, HIRE_JUSTIFICATION_PROMPT_VERSION, buildJustificationMessages } from "../../prompts/hire-justification.mjs";
import { JustificationOutput } from "../schemas/hire-justification.mjs";
import { jsonOf } from "./answers.mjs";

export { HIRE_JUSTIFICATION_PROMPT_VERSION };

const PRAISE = /\b(strong|stronger|strongest|deep|deeply|extensive|extensively|proven|impressive|expert|expertise|excellent|great|solid|talented|exceptional|seasoned|outstanding|remarkable|highly|accomplished|brilliant|passionate|rare|perfect|ideal|top|best|world[- ]class|expertly|skilfully|skillfully|masterfully|successfully|effectively|seamlessly|flawlessly|brilliantly)\b/i;
const PAY = /\b(ctc|lpa|lakh|salary|pay|notice|relocat\w*|available from|joining)\b/i;

/**
 * The quotes the justification may use: the person's own words only (their answers in this exchange and the CV they
 * sent; lib/qualify/wiring.mjs ownEvidence), under the role's own must-haves. Which of them shows a fit is for the
 * writer to say and the grounding verifier to check; nothing here judges. Pure.
 * @param spec the role's brief (lib/qualify/roles.mjs briefFromRole)
 * @param _evaluation the scorer's answer (unused: a score is never evidence)
 * @param evidence [{id, quote}] their own words
 */
export function justificationItems(spec, _evaluation, evidence) {
  const quotes = (evidence || []).filter((e) => e?.id && String(e.quote || "").trim()).map((e) => ({ id: e.id, quote: String(e.quote).replace(/\s+/g, " ").trim().slice(0, 700) }));
  if (!quotes.length) return [];
  const must = (spec?.criteria || []).filter((c) => c.kind === "must_have").map((c) => String(c.label || "").trim()).filter(Boolean);
  const requirement = (must.length ? `What the ${spec?.role || "role"} role needs: ${must.join("; ")}` : `What the ${spec?.role || "role"} role needs`).slice(0, 200);
  return [{ requirement, quotes }];
}

/** The code checks. Pure. */
export function checkJustification(text, evidenceIds, items) {
  const t = String(text || "").trim();
  const quotes = items.flatMap((i) => i.quotes);
  const allowed = new Set(quotes.map((q) => q.id));
  if (!t) return { ok: false, reason: "no justification was written" };
  const words = t.split(/\s+/).length;
  if (words < 25 || words > 90) return { ok: false, reason: `the justification is ${words} words (25 to 90)` };
  if (/[‒-―−]|\s-\s|--|!/.test(t)) return { ok: false, reason: "the justification has a dash or an exclamation mark" };
  const praise = t.match(PRAISE);
  if (praise) return { ok: false, reason: `the justification judges them ("${praise[0]}")` };
  const pay = t.match(PAY);
  if (pay) return { ok: false, reason: `the justification talks about "${pay[0]}", which travels in its own field` };
  const all = quotes.map((q) => q.quote).join(" ");
  for (const n of t.match(/\d[\d,.]*/g) || []) if (!all.includes(n.replace(/[.,]$/, ""))) return { ok: false, reason: `the number ${n} is not in their record` };
  const cited = (evidenceIds || []).filter(Boolean);
  if (!cited.length) return { ok: false, reason: "the justification cites no quote" };
  if (cited.some((id) => !allowed.has(id))) return { ok: false, reason: "the justification cites a quote it was not given" };
  return { ok: true };
}

/**
 * Write and check the justification. Never throws for a refusal.
 * @returns {Promise<{ok:true, text:string, evidence_ids:string[]} | {ok:false, reason:string}>}
 */
export async function writeJustification({ client, verify, roleTitle, firstName, items, model }) {
  if (typeof verify !== "function") return { ok: false, reason: "no grounding verifier, so no justification" };
  if (!items?.length) return { ok: false, reason: "no quote from their own record or answers backs a must-have" };
  const m = String(model || process.env.HIRE_WHY_MODEL || "claude-sonnet-4-6");
  let parsed;
  try {
    const res = await client.messages.create({ model: m, temperature: 0, max_tokens: 600, system: HIRE_JUSTIFICATION_SYSTEM, messages: buildJustificationMessages({ roleTitle, firstName, items }) });
    parsed = jsonOf((res?.content || []).filter((b) => b.type === "text").map((b) => b.text).join(""));
  } catch (e) {
    return { ok: false, reason: `the justification could not be written: ${String(e?.message || e).slice(0, 120)}` };
  }
  const ok = JustificationOutput.safeParse(parsed);
  if (!ok.success) return { ok: false, reason: "the reply did not match the schema" };
  if (ok.data.justification == null) return { ok: false, reason: "their record and answers do not clearly show why they fit" };
  const text = ok.data.justification.trim();
  const checked = checkJustification(text, ok.data.evidence_ids, items);
  if (!checked.ok) return checked;
  const cited = new Set(ok.data.evidence_ids);
  const v = await verify({ sourceText: items.flatMap((i) => i.quotes).filter((q) => cited.has(q.id)).map((q) => q.quote).join("\n"), artifactText: text });
  if (!v || v.errored) return { ok: false, reason: "the grounding check could not answer, so no justification" };
  if (v.severity === "high" || v.ok === false) return { ok: false, reason: `the grounding check refused it: ${(v.violations || []).map((x) => x?.claim || x).join("; ").slice(0, 160) || "not supported"}` };
  return { ok: true, text, evidence_ids: ok.data.evidence_ids };
}

// dossier-build.mjs — assemble a GROUNDED first-draft dossier from a resume only.
//
// Reuses the existing assembly prompt (dossier.md) and adds a build-mode addendum:
// resume is the only input (no intake conversation yet), unknown preferences become
// null and are named in `gaps`, and the model must not upgrade the resume's own
// wording. Used by onboarding's dossier build. Output matches the schema
// match-jobs.mjs expects.
//
// ROBUSTNESS: the model occasionally wraps its JSON in prose/fences, emits a stray
// trailing comma, or — the usual culprit — runs past max_tokens and truncates the
// object mid-string (which JSON.parse reports as a failure at a content-dependent
// position, i.e. "a different position each time"). We therefore: give it enough
// room, detect truncation explicitly, extract the outermost balanced {...}, repair
// trailing commas, validate against the dossier schema, and on any failure retry
// ONCE with a stricter JSON-only system instruction. If it still fails we throw a
// clear, user-facing message and log the raw output server-side.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { BUILD_ADDENDUM as P_BUILD_ADDENDUM, TIER_ADDENDUM as P_TIER_ADDENDUM, STRICT_JSON as P_STRICT_JSON, EDGE_ADDENDUM as P_EDGE_ADDENDUM, COMPANY_CONTEXT_ADDENDUM as P_COMPANY_CONTEXT_ADDENDUM } from "./prompts/dossier-build.mjs"; // versioned prompt — see prompts/
import { verifyEdge } from "./edge-verify.mjs"; // Edge Engine safety net (grounds + confidence-gates the edge)

const here = dirname(fileURLToPath(import.meta.url));
const PROMPT_PATH = join(here, "dossier.md");
// The one-off dossier build from a resume is the highest-stakes reasoning step
// (grounding, no embellishment), and it runs ONCE per user — so it gets the strongest model.
// The high-volume match step uses Haiku (match-batch.mjs) and compose uses Sonnet.
const MODEL = "claude-opus-4-8";
// Adaptive thinking on the dossier build — the highest-stakes grounding step should reason before it
// writes. Runs ONCE per user, so the extra tokens/latency are worth it. Default ON; set
// DOSSIER_THINKING=off to fall back to no-thinking. Effort: low|medium|high|xhigh|max.
const DOSSIER_THINKING = String(process.env.DOSSIER_THINKING || "on").toLowerCase() !== "off";
const DOSSIER_EFFORT = process.env.DOSSIER_EFFORT || "high";
// A full dossier is ~2–4k output tokens; with adaptive thinking the call also spends reasoning tokens
// (counted against max_tokens), so give generous headroom so the object always closes. (Truncation is
// still detected.) 16k stays at the non-streaming ceiling; this call is once-per-user, not latency-critical.
const MAX_TOKENS = 16000;

// Layered on top of dossier.md for the resume-only first draft.
const BUILD_ADDENDUM = P_BUILD_ADDENDUM;

// Tier-1 work ingestion: the person gave more than a resume (attached docs and/or notes in their
// own words). Same grounding contract, plus a VERIFIABILITY TIER so self-narrated prose can never be
// laundered into evidence. This is the guardrail that lets "dump your work" stay grounded.
const TIER_ADDENDUM = P_TIER_ADDENDUM;

// Appended on the strict retry only.
const STRICT_JSON = P_STRICT_JSON;

// Edge Engine: the grounded rare-combo POSITION addendum. Layered on top of BUILD/TIER only when the
// flag is on. Dark by default → the model is never asked for an edge and the dossier has no edge field.
const EDGE_ADDENDUM = P_EDGE_ADDENDUM;
const edgeEngineOn = () => String(process.env.EDGE_ENGINE || "").toLowerCase() === "on";

// Company context (dark behind COMPANY_CONTEXT): ask the build for the list of past employer NAMES so a
// later best-effort step (company-context.mjs) can attach each company's domain as context. Dark by
// default → the addendum is never added and the dossier has no employers field.
const COMPANY_CONTEXT_ADDENDUM = P_COMPANY_CONTEXT_ADDENDUM;
const companyContextOn = () => String(process.env.COMPANY_CONTEXT || "").toLowerCase() === "on";

// Ground the employer names the model emitted, then return the dossier. Fail closed: with the flag OFF
// (or a missing/empty list) the `employers` field is REMOVED, so the stored dossier keeps its base shape. With the flag ON, each name is kept ONLY if it appears verbatim in the resume — the same
// deterministic grounding guard extractName() applies to the person's name, so an invented or normalized
// employer can never survive. Names are normalized to `[{ name }]`; company-context.mjs later attaches a
// `domain` onto each entry. Deterministic + synchronous: no model call, no research here.
export function finalizeEmployers(dossier, resumeText) {
  if (!dossier || typeof dossier !== "object") return dossier;
  if (!companyContextOn()) {
    if ("employers" in dossier) delete dossier.employers; // dark switch → no ride-along field
    return dossier;
  }
  const haystack = String(resumeText || "").toLowerCase();
  const seen = new Set();
  const grounded = [];
  for (const raw of Array.isArray(dossier.employers) ? dossier.employers : []) {
    const name = (typeof raw === "string" ? raw : raw && raw.name ? String(raw.name) : "").trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue; // one entry per employer
    if (!haystack.includes(key)) continue; // GROUNDING: drop any name not present verbatim in the resume
    seen.add(key);
    grounded.push({ name });
  }
  if (grounded.length) dossier.employers = grounded;
  else if ("employers" in dossier) delete dossier.employers; // nothing grounded → no empty ride-along field
  return dossier;
}

// Ground + confidence-gate the edge the model emitted, then return the dossier. Fail closed: with the
// flag OFF (or a missing/failed edge) the edge is REMOVED, so the stored dossier keeps its base shape.
// With the flag ON, edge-verify.mjs must confirm the combo is grounded; an ungrounded or unverifiable
// edge is dropped, and a grounded one has its verifier-assigned confidence stamped on.
export async function finalizeEdge(dossier, resumeText, client) {
  if (!edgeEngineOn() || !dossier || !dossier.edge || typeof dossier.edge !== "object") {
    if (dossier && "edge" in dossier) delete dossier.edge; // dark switch / no edge → no ride-along field
    return dossier;
  }
  const verdict = await verifyEdge({ sourceText: resumeText, edge: dossier.edge, client });
  if (!verdict.grounded) {
    delete dossier.edge; // ungrounded or unverifiable → drop it (a false rare-combo is worse than none)
    return dossier;
  }
  dossier.edge.confidence = verdict.confidence; // trust the verifier's rarity read, not the builder's
  return dossier;
}

function stripFences(text) {
  let t = (text ?? "").trim();
  if (t.startsWith("```")) t = t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return t.trim();
}

// Remove trailing commas before } or ] — a common, otherwise-fatal model slip.
function repairTrailingCommas(s) {
  return s.replace(/,(\s*[}\]])/g, "$1");
}

// Return the first balanced {...} block, ignoring braces inside strings. Returns null
// if there is no opening brace or the object never closes (i.e. it was truncated).
function sliceOutermostObject(s) {
  const start = s.indexOf("{");
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return s.slice(start, i + 1);
  }
  return null; // unbalanced — truncated output
}

// Tolerant extraction: direct parse, then balanced-slice, then trailing-comma repair.
function extractJson(text) {
  const t = stripFences(text);
  const tries = [t, sliceOutermostObject(t)].filter(Boolean);
  for (const candidate of tries) {
    try { return JSON.parse(candidate); } catch { /* try next */ }
    try { return JSON.parse(repairTrailingCommas(candidate)); } catch { /* try next */ }
  }
  const err = new Error("model did not return valid JSON");
  err.raw = text;
  throw err;
}

// Validate the shape we save and that match-jobs.mjs later reads. Throws on a bad
// shape so the caller can retry. Mutates harmlessly to fill obviously-empty fields.
function validateDossier(d) {
  if (!d || typeof d !== "object" || Array.isArray(d)) throw new Error("dossier is not a JSON object");
  const bad = [];
  if (typeof d.headline !== "string" || !d.headline.trim()) bad.push("headline");
  if (typeof d.narrative !== "string") d.narrative = d.narrative == null ? "" : String(d.narrative);
  for (const k of ["proof_points", "case_studies", "strengths", "gaps"]) {
    if (!Array.isArray(d[k])) bad.push(k);
  }
  if (!d.preferences || typeof d.preferences !== "object" || Array.isArray(d.preferences)) bad.push("preferences");
  if (bad.length) throw new Error(`dossier failed schema validation: missing/invalid ${bad.join(", ")}`);
  return d;
}

// A resume whose first non-empty line is a SECTION HEADER, not a name (some templates lead with
// "WORK EXPERIENCE", "PROFILE", "CONTACT", …). Anchored ^…$ so it only fires when the WHOLE line IS the
// header: "WORK EXPERIENCE" is rejected, but a real name (even all-caps "JANE DOE") is kept. A wrong
// name in a real inbox ("Hi WORK EXPERIENCE") is worse than no name, so an ambiguous header → null.
const SECTION_HEADER = /^(work experience|experience|employment( history)?|work history|professional (summary|experience|profile|background)|education|academic( background)?|skills|technical skills|core competenc(y|ies)|competencies|projects?|summary|profile|objective|career (objective|summary|profile)|contact( information| details)?|personal (details|information|info)|certifications?|licenses?|awards?|honou?rs?|references?|achievements?|accomplishments?|qualifications?|interests?|hobbies|languages?|publications?|volunteer( experience)?|activities|about( me)?|portfolio|resume|cv|curriculum vitae)\s*:?\s*$/i;
// A first line that is a SALUTATION, not a name. The resume is optional, so the "resume text" for many
// people IS their email to Charlie, whose first line is "Hi Charlie,". The greeting word is what
// disqualifies the line — a real first name that merely follows one cannot be told apart from the
// salutation, and a wrong name in a real inbox is worse than none, so an ambiguous line → null and the
// templates degrade to no name at all.
const GREETING = /^(hi|hii+|hey+|hello|hiya|dear|greetings|good\s+(morning|afternoon|evening)|thanks|thank\s+you|regards)\b/i;
// A first line that is not NAME-SHAPED. The greeting guard above catches "Hi Charlie,"; these catch
// the other shapes a resume header takes that would otherwise reach every lifecycle template as the
// person's name:
//   "Portfolio: behance.net/abc"                  a label, not a name (label prefix + a url)
//   "Q A L e a d | J a i p u r , I n d i a"  a letter-spaced PDF tagline (a `|` separator too)
//   "PRIYA K. S ."                                   a real name, but with a stray space before the period
// A wrong name in a real inbox is worse than no name, so anything ambiguous returns null and every
// template degrades cleanly ("You're all set." instead of "You're all set, X.").
// A PLACE IS NOT A PERSON. A resume can put "Pune, Maharashtra" on the line above the name, and every
// rule above passes it: two capitalised words, no digits, no separator, a mid-string comma.
//
// MATCHED ONLY WHEN THE WHOLE LINE IS PLACES. "Pune" and "Pune, Maharashtra" are nulled; "Rahul Pune"
// is not, because a real surname can be a place and throwing away a true name is the error this guard
// exists to avoid in the other direction.
// "bharat" is deliberately NOT in this list. It is a name for India AND a common Indian given name. A
// place word that is also a given name must stay out: the cost of nulling a true name outweighs
// catching one more junk line. Same reasoning for any future addition.
const PLACES = new Set(["india","maharashtra","karnataka","kerala","telangana","tamil","nadu","tamilnadu","gujarat","punjab","haryana","rajasthan","odisha","bihar","assam","goa","delhi","ncr","bengaluru","bangalore","mumbai","pune","hyderabad","chennai","kolkata","noida","gurgaon","gurugram","ahmedabad","jaipur","kochi","cochin","coimbatore","indore","chandigarh","lucknow","nagpur","surat","bhopal","trivandrum","thiruvananthapuram","madurai","mysore","mysuru","vizag","visakhapatnam","remote","usa","us","uk","canada","singapore","dubai","uae"]);
function isAllPlaceWords(name) {
  const words = String(name).toLowerCase().replace(/[.,]/g, " ").split(/\s+/).filter(Boolean);
  return words.length > 0 && words.every((w) => PLACES.has(w));
}

const NOT_NAME_SHAPED = [
  /[|/•·]/,                    // a separator: taglines and headers use them, names do not
  /\bhttps?:\/\/|\.(com|net|org|io|co|in|dev|me)\b/i, // a url or domain
  /^\s*[A-Za-z]+\s*:/,         // a "Label: value" prefix ("Portfolio:", "Contact:")
  /[,;:!?]$/,                  // sentence punctuation. NOT "." — see normaliseNameSpacing
  /\d/,                        // digits: phone numbers, addresses, "13 years"
  /^(\S\s){3,}\S/,             // letter-spaced text ("Q A L e a d")
];
// Whitespace-only tidy for a line that IS a name. "PRIYA K. S ." is a name whose PDF put a
// stray space before the final period; nulling it would throw away a correct name, and rewriting the
// letters would break the verbatim rule. Collapsing runs of spaces and closing the gap before a
// period changes no character of the name itself, so it stays verbatim.
function normaliseNameSpacing(s) {
  return s.replace(/\s+/g, " ").replace(/\s+\./g, ".").trim();
}
// Pull the person's name VERBATIM from the resume header (first non-empty line, markdown
// stripped). Deterministic on purpose: the name never goes through the model, so it can never
// be hallucinated, shortened, or altered. Returns null if there's no plausible name line.
export function extractName(resumeText) {
  const line = String(resumeText || "").split("\n").map((s) => s.trim()).filter(Boolean)[0] || "";
  const name = normaliseNameSpacing(line.replace(/^#+\s*/, "").replace(/[*_`]/g, ""));
  if (!name || name.length > 60 || name.includes("@") || SECTION_HEADER.test(name)) return null;
  if (GREETING.test(name)) return null;
  if (NOT_NAME_SHAPED.some((re) => re.test(name))) return null;
  if (isAllPlaceWords(name)) return null;
  // A name is a handful of words. More than that is a headline, a title line, or a whole sentence.
  // Five allows "Maria del Carmen Garcia Lopez" and still rejects "Senior Product Designer at Acme".
  if (name.split(/\s+/).length > 5) return null;
  return name;
}

async function generate(client, system, userContent) {
  const messages = [{ role: "user", content: userContent }];
  const req = { model: MODEL, max_tokens: MAX_TOKENS, system, messages };
  if (DOSSIER_THINKING) {
    // Adaptive thinking + effort. NOTE: thinking is incompatible with an assistant-turn prefill, and
    // the model rejects last-assistant prefills with a 400 anyway, so JSON-only is enforced via the
    // STRICT_JSON system instruction on the retry (see the attempts ladder). Thinking blocks are filtered out
    // below (type==="text" only), so only the final JSON is parsed.
    req.thinking = { type: "adaptive" };
    req.output_config = { effort: DOSSIER_EFFORT };
  }
  const response = await client.messages.create(req);
  const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  return { text, stopReason: response.stop_reason };
}

// Build a grounded first-draft dossier object from raw resume text.
export async function buildDossier(resumeText, { extraSources = [], notes = "" } = {}) {
  if (!resumeText || !resumeText.trim()) throw new Error("empty resume text");
  const cap = (t) => String(t || "").slice(0, 8000);
  // Each extra source is emitted under the wrapper that matches its VERIFIABILITY trust — this is what
  // makes the tiering real (the model reads the wrapper). trust:"artifact" = externally checkable
  // (e.g. GitHub-API facts) → cite "link". Everything else (self-authored docs + linked pages) is a
  // CLAIM → cite "conversation", same bar as their notes. Never flatten a claim into an artifact.
  const extraBlocks = (Array.isArray(extraSources) ? extraSources : [])
    .filter((s) => s && s.text && String(s.text).trim())
    .map((s) => s.trust === "artifact"
      ? `## VERIFIED SOURCE: ${String(s.label || "source")} (ARTIFACT, externally checkable; cite as "link" and name it)\n\n${cap(s.text)}`
      : `## SELF-PROVIDED SOURCE: ${String(s.label || "source")} (CLAIM, the person's own document or page, NOT verified; cite as "conversation", never promote self-praise to a proof_point unless it names a concrete checkable thing)\n\n${cap(s.text)}`)
    .join("\n\n");
  // CLAIM material (their own words) — low trust; the TIER_ADDENDUM keeps it out of proof_points
  // unless it names something concrete.
  const notesText = String(notes || "").trim();
  const notesBlock = notesText
    ? `## NOTES THEY WROTE (CLAIM source, their own words, NOT verified; cite as "conversation", never promote self-praise to a proof_point)\n\n${cap(notesText)}`
    : "";
  const hasExtra = !!(extraBlocks || notesBlock);

  const baseSystem = readFileSync(PROMPT_PATH, "utf8") + "\n\n" + (hasExtra ? TIER_ADDENDUM : BUILD_ADDENDUM)
    + (edgeEngineOn() ? "\n\n" + EDGE_ADDENDUM : "") // Edge Engine: only ask for an edge when the flag is on
    + (companyContextOn() ? "\n\n" + COMPANY_CONTEXT_ADDENDUM : ""); // only ask for employer names when the flag is on
  // The edge verifier must audit against the SAME corpus the edge was built from (resume + any extra
  // artifact/claim sources + notes, with their trust wrappers) — not the resume alone — so a combo half
  // grounded in a "conversation"-tier source is checked against real material, never dropped blind.
  const verifySource = [resumeText, extraBlocks, notesBlock].filter(Boolean).join("\n\n");
  const client = new Anthropic(); // reads ANTHROPIC_API_KEY (loaded by the caller)
  const today = new Date().toISOString().slice(0, 10);
  const userContent =
    `## TODAY\n\n${today} (judge tenure and recency against this; a date before today is PAST, do not call it "future")\n\n` +
    `## RESUME (ARTIFACT source, cite as "resume")\n\n${resumeText}\n\n` +
    (extraBlocks ? extraBlocks + "\n\n" : "") +
    (notesBlock ? notesBlock + "\n\n" : "") +
    `## INTAKE\n\n` +
    `(none yet — this is the first-draft build. Leave unknown preferences null ` +
    `and list each in gaps. Do not upgrade the wording of any source.)`;

  // Two attempts: the plain build, then a stricter JSON-only retry (STRICT_JSON in the system, NOT an
  // assistant prefill — prefills 400 on this model and can't coexist with thinking).
  const attempts = [
    { label: "build", system: baseSystem },
    { label: "build-strict-retry", system: baseSystem + "\n" + STRICT_JSON },
  ];

  let lastRaw = "";
  let lastErr = null;
  for (const a of attempts) {
    const isLast = a === attempts[attempts.length - 1];
    let gen;
    try {
      gen = await generate(client, a.system, userContent);
    } catch (e) {
      lastErr = e;
      console.error(`[build_dossier] ${a.label}: model API error: ${e.message}`);
      continue;
    }
    lastRaw = gen.text;

    if (gen.stopReason === "max_tokens") {
      lastErr = new Error(`response truncated at max_tokens (${MAX_TOKENS})`);
      console.error(`[build_dossier] ${a.label}: ${lastErr.message}; output incomplete, will ${isLast ? "give up" : "retry compactly"}`);
      continue; // truncated JSON cannot be salvaged — go to the stricter retry
    }

    try {
      const dossier = validateDossier(extractJson(gen.text));
      if (!Array.isArray(dossier.gaps)) dossier.gaps = [];
      dossier.name = extractName(resumeText); // deterministic + grounded: never model-touched, so it can't be invented or altered
      // Edge Engine (dark by default): ground + confidence-gate the edge, or strip it. Off ⇒ no-op strip.
      // Verify against the full build corpus (verifySource), not the resume alone.
      await finalizeEdge(dossier, verifySource, client);
      // Company context (dark by default): keep only employer names present verbatim in the resume, else
      // strip the field. Off ⇒ no-op strip. Grounds names against the resume alone (the
      // employer must be the person's own history, not a company mentioned in a pasted artifact).
      finalizeEmployers(dossier, resumeText);
      return dossier;
    } catch (e) {
      lastErr = e;
      // Log only the failure + output SIZE — never the content (it is resume-derived
      // user data). Set DEBUG_DOSSIER_RAW=1 locally to opt into the raw dump.
      const raw = process.env.DEBUG_DOSSIER_RAW === "1" ? `\n${gen.text.slice(0, 4000)}` : "";
      console.error(`[build_dossier] ${a.label}: ${e.message}. model output was ${gen.text.length} chars (content not logged).${raw}`);
      continue;
    }
  }

  const err = new Error(
    "Couldn't build a valid dossier from your resume right now — the model returned " +
      "malformed or incomplete data. Please run build_dossier again in a moment." +
      (lastErr ? ` (detail: ${lastErr.message})` : ""),
  );
  err.raw = lastRaw;
  throw err;
}

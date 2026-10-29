// prompts/vv-ask.mjs — a question about the board becomes a rule over its columns.
//
// WHAT IT DOES: given a hiring person's question in plain words and the catalogue of the talent
//   pool's fields (names, types, and the fixed values an enumerated field can take), returns a
//   structured query: filters on named fields, an optional sort, an optional list of columns to
//   show, whether the person wants a count, and the rule restated in one plain sentence. The
//   board applies the rule to the rows itself. The model never sees a person: no row, no name,
//   no value from the table is in the request. A question the catalogue cannot answer is refused
//   in one sentence, never approximated.
//
// WHAT IT IS NOT: it does not read candidates, rank them, or judge anyone. It translates. The
//   answer is a rule the reader can see and check against the columns; that is the whole point.
//
// MODEL: VOICE_ASK_MODEL, falling back to VOICE_JUDGE_MODEL (a small model is enough), temperature
//   0, one call per question. EXPECTED OUTPUT: JSON, lib/schemas/vv-ask.mjs AskQuery, validated at
//   the boundary; an unknown field or operator makes the whole answer invalid and the question is
//   refused rather than partly applied.
// A question becomes a view, never a column.
export const VV_ASK_PROMPT_VERSION = "2026-09-23.1";

/** The fields a rule may name, with their types and, where fixed, their values. This IS the catalogue the model sees. */
export const ASK_FIELDS = Object.freeze({
  name: { type: "text", about: "the person's name" },
  email: { type: "text", about: "email address" },
  city: { type: "text", about: "city they live in" },
  country: { type: "text", about: "country" },
  current_title: { type: "text", about: "current job title" },
  current_company: { type: "text", about: "current employer" },
  previous_company: { type: "text", about: "previous employer" },
  headline: { type: "text", about: "their own one-line summary" },
  top_skills: { type: "list", about: "skills read from the resume" },
  domains: { type: "list", about: "industries or domains read from the resume" },
  total_years: { type: "number", about: "years of experience" },
  roles_count: { type: "number", about: "number of roles held" },
  notice_days: { type: "number", about: "notice period in days" },
  comp_current: { type: "number", about: "current annual pay as a plain number; Indian pay is in rupees, so 12 LPA is 1200000" },
  comp_expected: { type: "number", about: "expected annual pay, same units" },
  completeness: { type: "number", about: "how complete the record is, 0 to 100" },
  applied_at: { type: "date", about: "when they applied, ISO date" },
  seniority: { type: "enum", about: "level", values: ["ic", "senior_ic", "lead", "manager", "head", "unknown"] },
  role_family: { type: "enum", about: "kind of role", values: ["product_design", "product_management", "customer_success", "sales", "marketing", "ops", "data", "other"] },
  seeking_status: { type: "enum", about: "what they say about moving", values: ["active_seeker", "open_to_right_thing", "passive", "not_looking", "unknown"] },
  work_mode_pref: { type: "enum", about: "preferred work mode", values: ["remote", "hybrid", "onsite", "flexible", "unknown"] },
  mobility_profile: { type: "enum", about: "tenure pattern computed from dates", values: ["stable", "steady", "mover", "hopper", "unknown"] },
  willing_to_relocate: { type: "text", about: "their own words on relocating" },
  consent_pool: { type: "boolean", about: "consented to be in the talent pool" },
  consent_share: { type: "boolean", about: "consented to be shared with a hiring team" },
  source_role: { type: "text", about: "the role they applied for" },
});

export const ASK_OPS = Object.freeze(["eq", "neq", "contains", "gte", "lte", "in", "is_true", "is_false", "is_empty", "not_empty"]);

/** The columns the board can show, so "show me phone and notice" is a real instruction. */
export const ASK_COLUMNS = Object.freeze(["name", "email", "phone", "designation", "company", "salary", "experience", "companies", "education", "location", "linkedin", "portfolio", "fit", "status", "consent"]);

const catalogue = Object.entries(ASK_FIELDS)
  .map(([k, f]) => `- ${k} (${f.type}${f.values ? `: ${f.values.join(" | ")}` : ""}): ${f.about}`)
  .join("\n");

export const VV_ASK_SYSTEM = `You turn a question about a table of job candidates into a rule over the table's fields. You never see the table. You answer with JSON only.

FIELDS you may name (nothing else exists):
${catalogue}

OPERATORS: eq, neq, contains (case-insensitive substring; on a list field, any element), gte, lte (numbers and dates), in (a list of values), is_true, is_false (booleans), is_empty, not_empty.

COLUMNS the board can show, for "columns": ${ASK_COLUMNS.join(", ")}.

RULES:
- Use only the fields and values above. If the question needs something the fields cannot express (a judgement, a score, a fact the table does not hold), set "refused" to one plain sentence saying what is missing and leave the rest empty.
- Enumerated fields take their fixed values, not synonyms: "actively looking" is seeking_status eq active_seeker; "designers" is role_family eq product_design.
- Pay is a plain annual number: "under 15 LPA" is comp_current lte 1500000.
- "Sort by" sets "sort". "Show" or "only" columns sets "columns". "How many" sets "aggregate" to "count".
- "explanation" restates the rule in one plain sentence a reader can check against the columns, e.g. "Sales people in Bengaluru with 3 or more years and notice under 30 days, newest applicants first." Never claim anything about the people.
- Output exactly: {"filters":[{"field":"…","op":"…","value":…}],"sort":{"field":"…","dir":"asc|desc"}|null,"columns":[…]|null,"aggregate":"count"|null,"explanation":"…","refused":null|"…"}`;

export function buildAskMessages({ question }) {
  return [{ role: "user", content: `QUESTION: ${String(question).trim()}\n\nAnswer with the JSON only.` }];
}

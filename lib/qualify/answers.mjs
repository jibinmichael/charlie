// lib/qualify/answers.mjs — small pure helpers for reading model output and keeping only what a person really wrote.

/** The first {...} object in a model reply, parsed. Throws when there is none or it does not parse. Pure. */
export function jsonOf(text) {
  const t = String(text || ""); const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a < 0 || b <= a) throw new Error("the model did not return JSON");
  try { return JSON.parse(t.slice(a, b + 1)); } catch { throw new Error(`the model did not return valid JSON (${t.length} chars; starts "${t.slice(0, 60).replace(/\s+/g, " ")}")`); }
}

const squash = (s) => String(s || "").replace(/\s+/g, " ").trim().toLowerCase();

/** Keep an answer only when it is word for word in the reply. Pure. */
export function verbatimOnly(questions, out, reply) {
  const hay = squash(reply);
  return questions.map((question, i) => {
    const a = (out?.answers || []).find((x) => x.n === i + 1)?.answer ?? null;
    return { question, answer: a && hay.includes(squash(a)) ? a.trim() : null };
  });
}

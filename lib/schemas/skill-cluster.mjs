// lib/schemas/skill-cluster.mjs — the model boundary for skill clustering.
//
// A BAD GROUP COSTS ITS GROUP, NOT THE BUCKET. One out-of-range value must not discard a whole model
// response. `coerceClusters` drops what it cannot read and
// returns the count so the loss appears in the run output.
import { z } from "zod";

export const SkillGroup = z.object({
  canonical: z.string().min(2).max(80),
  members: z.array(z.string().min(2).max(80)).min(2),
});

export const SkillClusters = z.object({ groups: z.array(SkillGroup).max(60).default([]) });

const TOKENS = (s) => String(s).toLowerCase().split(/[^a-z0-9+#.]+/).filter(Boolean);
/** Connectors that carry no meaning in a skill name. */
const GLUE = new Set(["and", "the", "of", "for", "a", "an", "to", "in", "with", "on", "or", "&"]);
/** Two words are the same word wearing different endings: roadmap / roadmapping, design / designing. */
const sameStem = (a, b) => a === b || (a.length >= 4 && b.length >= 4 && (a.startsWith(b.slice(0, 4)) || b.startsWith(a.slice(0, 4))));

/**
 * May `member` fold into `canonical`?
 *
 * THE MODEL WILL NOT HOLD THIS LINE AND THE PROMPT CANNOT MAKE IT. Told explicitly that a qualifier
 * is part of the skill, a model can still fold "procurement workflow design", "crm workflow design"
 * and "ai workflow design" into "workflow design". The failure direction is the expensive one -- it turns
 * a scarce specialist into a generalist and deletes the thing that made them findable.
 *
 * So the rule is arithmetic instead of instruction. The two names must carry the SAME meaningful
 * words: differences may be morphological ("roadmapping" for "roadmap"), spelling ("visualisation"
 * for "visualization") or glue ("and", "&"). Any word one has and the other lacks refuses the merge.
 *
 * IT IS SYMMETRIC. Checking only that the member adds nothing would let the CANONICAL add instead,
 * which is an upgrade rather than a merge: "revenue retention" folded into "net revenue retention",
 * or "windows administration" into "windows server administration". Both credit a person with
 * something more specific than they wrote: never inflate, never upgrade.
 *
 * It refuses some merges a human would allow. That is the correct direction: a missed merge costs a
 * smaller count, a wrong merge puts a skill on somebody's record that they never claimed.
 */
export function mayFold(canonical, member) {
  const c = TOKENS(canonical).filter((t) => !GLUE.has(t));
  const m = TOKENS(member).filter((t) => !GLUE.has(t));
  if (!c.length || !m.length) return false;
  const covers = (a, b) => a.every((t) => b.some((x) => sameStem(t, x)));
  return covers(m, c) && covers(c, m);
}

/**
 * Salvage a response, then enforce the rule the prompt states: every canonical name and every member
 * must be a string we actually gave the model. A name it invented is a skill nobody claimed.
 * Returns { ok, groups, dropped }.
 */
export function coerceClusters(raw, offered = new Set()) {
  if (!raw || typeof raw !== "object") return { ok: false, groups: [], dropped: 0 };
  const inGroups = Array.isArray(raw.groups) ? raw.groups : [];
  const groups = []; let dropped = 0;
  for (const g of inGroups) {
    const p = SkillGroup.safeParse({
      canonical: typeof g?.canonical === "string" ? g.canonical.trim() : "",
      members: (Array.isArray(g?.members) ? g.members : []).filter((m) => typeof m === "string").map((m) => m.trim()),
    });
    if (!p.success) { dropped++; continue; }
    const members = p.data.members.filter((m) => offered.has(m) && (m === p.data.canonical || mayFold(p.data.canonical, m)));
    // The canonical name must be one of the surviving members, or the group is not usable.
    if (members.length < 2 || !members.includes(p.data.canonical)) { dropped++; continue; }
    groups.push({ canonical: p.data.canonical, members });
  }
  return { ok: true, groups, dropped };
}

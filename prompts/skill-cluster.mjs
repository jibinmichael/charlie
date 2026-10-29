// prompts/skill-cluster.mjs — which of these skill names are the same skill?
//
// WHY A MODEL AT ALL. lib/skill-normalise.mjs already folds spelling deterministically and that is
// where the cheap wins are. What it cannot do is decide that "agentic ai", "ai agent" and "agentic
// workflow" name one skill while "llm evaluation" and "llm fine-tuning" name two. Established
// vocabulary folds fine with rules; emerging AI vocabulary does not, so nearly every mention ends up
// in its own bucket, and those are exactly the scarce skills worth counting.
//
// THE CANONICAL NAME MUST COME FROM THE LIST. Same cite-or-drop discipline as everything else that
// describes a person: a name the model invents is a skill nobody claimed. The caller drops any group
// whose canonical name is not one of the strings it was given.
//
// MERGING IS A CLAIM ABOUT A PERSON. If "llm evaluation" folds into "llm", everyone who wrote the
// former is now credited with the latter. A missed merge costs a smaller count. A wrong merge puts a
// skill on somebody's record that they did not claim, and a client filters on it. So the instruction
// is to leave things apart when unsure, and the bar for merging is "the same work", not "same topic".
//
// MODEL: Haiku 4.5, temperature 0. One call per bucket of related names, about $0.0025.
// EXPECTED OUTPUT: JSON, see SkillClusters in lib/schemas/skill-cluster.mjs.

export const SKILL_CLUSTER_SYSTEM = `You are given a list of skill names that all share a word. Some name the same skill written differently. Most do not. Group only the ones that are genuinely the same skill.

Output ONLY valid JSON, no prose, no backticks:
{ "groups": [ { "canonical": string, "members": [string] } ] }

THE BAR FOR MERGING IS "THE SAME WORK", NOT "THE SAME TOPIC".

  Merge: "agentic ai" + "ai agent" + "agentic ai system"     -- one skill, three phrasings
  Merge: "rag pipeline" + "rag system" + "rag architecture"  -- building a RAG system
  Do NOT merge: "llm evaluation" + "llm fine-tuning"         -- different work on the same object
  Do NOT merge: "rag" + "rag evaluation"                     -- building it and judging it differ
  Do NOT merge: "product design" + "product strategy"        -- adjacent, not the same
  Do NOT merge: "aws" + "azure"                              -- alternatives, not synonyms

A QUALIFIER IS PART OF THE SKILL. "ai product management" is not "product management"; "b2b product
design" is not "product design". A word naming a technology, domain, market or customer type changes
which job it is and how rare the person is. Propose the merge only when neither name adds a word the
other lacks. (lib/schemas/skill-cluster.mjs enforces this arithmetically and will refuse the merge
anyway, so proposing one costs a group; it never slips through.)

Merging is a claim about every person who wrote the member name: they will be recorded as having the
canonical skill. A missed merge only costs a smaller count. A wrong merge credits somebody with a
skill they never claimed, on a record a hiring manager reads. When you are unsure, leave them apart.

"canonical" MUST be copied exactly from the members of that group. Prefer the shortest member that a
practitioner would recognise on its own. Never invent a name, never tidy the spelling, never expand
an acronym that the list does not already expand.

A group needs at least two members. A name that belongs with nothing else is simply left out of the
output entirely; do not create a group of one.

Return an empty groups array if nothing in the list should be merged. That is a common and correct
answer.`;

export function buildSkillClusterMessages({ token = "", names = [] }) {
  const list = names.map((n) => `${n.k}  (${n.c} ${n.c === 1 ? "person" : "people"})`).join("\n");
  return [{
    role: "user",
    content: `## SKILL NAMES CONTAINING "${token}"\n${list}\n\nWhich of these are the same skill?`,
  }];
}

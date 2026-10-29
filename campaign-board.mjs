// campaign-board.mjs — builds the reject explainer (Case 5): "what this seat leans on most", the six
// founding-GTM-engineer skills RANKED by how central each is to THIS role. This is the ROLE's own shape,
// objective, not a verdict on the person. The candidate's resume is scored (resume-only) only to mark,
// warmly, which skills they DID show ("on your resume") — never to label a "gap": itemizing shortfalls
// is harmful, so the board states the role's weighting and acknowledges real strengths. Fails SAFE: a
// scorer miss yields the same ranked list with nothing marked (the role shape still explains the fit).
import { CampaignSkills } from "./lib/schemas/campaign-skills.mjs";
import { CAMPAIGN_SKILLS_SYSTEM } from "./prompts/campaign-skills.mjs";

// the role bar. weight = how central each skill is to this seat (drives the ranking + bar width).
export const ROLE_SKILLS = [
  { name: "GTM automation and tooling", weight: 100 }, // the spine
  { name: "AI-native workflow", weight: 85 },
  { name: "Analytics and measurement", weight: 82 },
  { name: "Distribution and experiments", weight: 70 },
  { name: "Customer discovery", weight: 66 },           // necessary but common
  { name: "Writing and narrative", weight: 60 },
];

const stripFences = (t) => String(t ?? "").replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
const jparse = (t) => { try { return JSON.parse(stripFences(t)); } catch { return null; } };

// pure: coverage array [{ name, coverage }] -> { rows:[{ label, weight, shown }] }, the role's skills
// ranked by weight (what this seat leans on most, first). `shown` is a warm, grounded acknowledgment that
// the resume evidenced it (strong/partial); it is never rendered as a "gap". Testable.
export function boardFromCoverage(skills = []) {
  const cov = Object.fromEntries((skills || []).map((s) => [s.name, s.coverage]));
  const rows = [...ROLE_SKILLS]
    .sort((a, b) => b.weight - a.weight)
    .map((s) => ({ label: s.name, weight: s.weight, shown: cov[s.name] === "strong" || cov[s.name] === "partial" }));
  return { rows };
}

// grounded: score the resume against the fixed skills via the model (resume-only source), schema-checked.
export async function scoreSkills({ resumeText, askModel, log = () => {} }) {
  if (!resumeText || !String(resumeText).trim()) return [];
  const user = JSON.stringify({ RESUME: String(resumeText).slice(0, 12000), SKILLS: ROLE_SKILLS.map((s) => s.name) });
  try {
    const raw = await askModel(CAMPAIGN_SKILLS_SYSTEM, user);
    const parsed = CampaignSkills.safeParse(jparse(raw));
    if (!parsed.success) { log(`[join] skills schema miss`); return []; }
    return parsed.data.skills;
  } catch (e) {
    log(`[join] skills model failed: ${e.message}`);
    return [];
  }
}

// convenience for the reject path: resume -> grounded board (empty on any failure).
export async function buildRejectBoardFor({ resumeText, askModel, log }) {
  return boardFromCoverage(await scoreSkills({ resumeText, askModel, log }));
}

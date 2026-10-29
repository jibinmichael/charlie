// market-weave.mjs — grounded market patterns woven into the role email.
//
// The non-negotiable (grounding): every figure here is a LITERAL COUNT over the
// user's real matched roles — nothing is modelled, predicted, or LLM-generated, so it is true by
// construction and the person could verify it by opening the postings. When the signal is thin,
// this returns null and Charlie says NOTHING rather than force a stat.
//
// Two grounding safeguards (both enforced below):
//   1. We only ever NAME a skill from a curated vocabulary of real tech nouns — never a generic
//      capitalized word (Data, Cloud, Platform, New...), which a loose heuristic would inflate into
//      a false "gap" the person may not have.
//   2. We match the skill in JD text CASE-SENSITIVELY, so a proper skill name can't collide with a
//      common lowercase word. Under-counting is fine (conservative); over-claiming is not.
//
// And we never assert the person LACKS the skill: the gap set is what the fit Readout could not
// fully evidence from the resume (partial/unknown), so the copy says "what your resume doesn't fully
// show", not "you're missing this".

// Real, nameable tech skills only. Canonical casing is used for BOTH display and matching. Ambiguous
// common words (bare "Go", "Node", "Data", "Cloud", "Platform") are deliberately excluded.
const SKILL_VOCAB = [
  "Kubernetes","Kafka","GraphQL","gRPC","Terraform","Docker","Helm","Prometheus","Grafana","Ansible",
  "Pulsar","RabbitMQ","Redis","PostgreSQL","MySQL","MongoDB","Cassandra","DynamoDB","Elasticsearch",
  "Snowflake","Airflow","Spark","Hadoop","Flink","Kinesis","Protobuf","Bazel",
  "TypeScript","JavaScript","Python","Golang","Rust","Scala","Kotlin","Java","Ruby","Rails","Django",
  "Flask","FastAPI","Spring","React","Angular","Vue","Svelte","Node.js","Next.js",
  "AWS","GCP","Azure","Lambda","Serverless","Swift","Android","Flutter","TensorFlow","PyTorch",
  "Pandas","Datadog","Splunk","Kotlin",
];

// word-boundary regex around a token, honoring tech punctuation (. + # /) as part of the token
function boundary(tok, flags) {
  const esc = tok.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9+#.])${esc}([^A-Za-z0-9+#.]|$)`, flags);
}

// which vocabulary skill (if any) does this requirement phrase name? CASE-SENSITIVE, so a bare
// lowercase common word ("react to", "swift response", "spring into") can never name the framework.
// Real skills appear canonically-cased in requirement text; missing a lowercased one is a safe
// under-count, never an over-claim.
function skillName(req) {
  const text = String(req || "");
  for (const s of SKILL_VOCAB) if (boundary(s, "").test(text)) return s;
  return null;
}

// does a JD literally mention this skill? CASE-SENSITIVE, so "Cloud"/"New"/"React" can't collide with
// their lowercase common-word forms. A conservative floor, never an inflated count.
function jdMentions(text, skill) {
  return !!text && !!skill && boundary(skill, "").test(text);
}

// The skill-unlock weave. Inputs:
//   cov      — the grounded fit Readout for the SENT role (cov.coverage = [{req,status,...}])
//   cluster  — the user's real above-the-bar match set, each with a .description (the JD)
// Returns { skill, n, total } for the most in-demand of the not-fully-shown skills, or null.
export function skillUnlock({ cov, cluster } = {}) {
  if (!cov || cov.thin || !Array.isArray(cov.coverage)) return null;
  const roles = (Array.isArray(cluster) ? cluster : []).filter(
    (r) => r && typeof r.description === "string" && r.description.length > 40,
  );
  const total = roles.length;
  if (total < 8) return null; // too small a cluster to honestly say "N of M"

  // Skills a MET requirement already evidences — never call one of these "not fully shown", even if
  // it also appears in a compound partial/unknown req (e.g. "Kubernetes + Istio" partial for Istio).
  const metSkills = new Set(
    cov.coverage.filter((r) => r && r.status === "met" && r.req).map((r) => skillName(r.req)).filter(Boolean),
  );

  // "not fully shown" = the Readout couldn't fully evidence it from the resume (partial or unknown).
  // We never claim the person LACKS it — only that their resume doesn't fully show it (see copy).
  const gaps = cov.coverage.filter((r) => r && (r.status === "partial" || r.status === "unknown") && r.req);
  let best = null;
  for (const g of gaps) {
    const skill = skillName(g.req);
    if (!skill || metSkills.has(skill)) continue; // only weave on a real skill not already met
    let n = 0;
    for (const r of roles) if (jdMentions(r.description, skill)) n++;
    if (!best || n > best.n) best = { skill, n };
  }
  if (!best) return null;
  if (best.n < 5) return null;            // absolute floor — a handful isn't a pattern
  if (best.n / total < 0.25) return null; // must be a real, common ask, not noise
  return { skill: best.skill, n: best.n, total };
}

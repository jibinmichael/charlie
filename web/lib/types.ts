// The voice-verification API's shapes, as the dashboard reads them (the server's /voice routes).
// Optional and nullable exactly where the server can send that.

export type PlanStatus = "draft" | "awaiting_approval" | "approved" | "rejected" | "superseded"
export type ItemKind =
  | "capability"
  | "hard_requirement"
  | "hr_fact"
  | "hr_capability"
  | "intent"
  | "communication_context"
export type SessionKind = "candidate" | "test"

export type ContractElement = { name: string; required: boolean; core: boolean }
export type Probe = { text: string; targets: string }
export type EvidenceContract = {
  establishes: string
  mandate_quote: string
  why_it_matters: string
  elements: ContractElement[]
  anchor_question: string
  depth_probes: Probe[]
  ownership_probe: string | null
  scenario: string | null
  contradiction_hooks: string[]
  expected_evidence: string
  fallback_text: { anchor: string; probe: string; move_on: string; clarify: string }
}
export type PlanItem = {
  id: string
  requirement_id: string | null
  ref: string
  kind: ItemKind
  priority: number
  budget_seconds: number
  evidence_contract: EvidenceContract
}
export type Plan = {
  id: string
  mandate_id: string | null
  version: number
  status: PlanStatus
  session_budget_seconds: number
  flagged: { ref: string; reason: string }[]
  approved_by: string | null
  approved_at: string | null
  items: PlanItem[]
}
export type PlanHead = {
  id: string
  version: number
  status: PlanStatus
  session_budget_seconds: number
  approved_by: string | null
  approved_at: string | null
  created_at: string
  flagged: { ref: string; reason: string }[]
}
export type ChainFailure = {
  itemId: string | null
  ref: string | null
  link: string
  detail: string
}
export type Chain = { ok: boolean; failures: ChainFailure[] }

export type Mandate = {
  id: string
  client: string | null
  role: string
  contact_email: string
  status: string
  created_at: string
  next_step_text: string | null
  jd_text?: string
  hr_questions?: string[]
}
export type JobRow = Mandate & {
  latest_plan: PlanHead | null
  approved_plan: PlanHead | null
  calls: number
}

export type SummaryItem = {
  ref: string
  kind: ItemKind
  establishes: string
  status: string | null
  coverage_band: string | null
}
export type Summary = {
  items: SummaryItem[]
  must_haves: { answered: number; total: number }
  evaluated: boolean
  reviewed: boolean
}
export type Session = {
  id: string
  kind: SessionKind
  candidate_id: string | null
  tester_email: string | null
  plan_id: string
  state: string
  started_at: string | null
  completed_at: string | null
  created_at: string
  conditions: Record<string, unknown> | null
  cursor?: Cursor | null
}
export type Cursor = {
  itemIndex?: number
  metaCount?: number
  items?: Record<string, { status: string; probesAsked: number; scenarioAsked?: boolean }>
}
export type CallRow = Session & {
  who: string | null
  name: string | null
  job: { role: string; client: string | null; mandate_id: string; plan_version: number } | null
  summary: Summary
}
export type JobDetail = {
  mandate: Mandate
  plans: PlanHead[]
  plan: Plan | null
  chain: Chain | null
  sessions: CallRow[]
}

export type Candidate = {
  id: string
  email: string
  name_as_given: string | null
  cv_ref: string | null
}
export type Conversation = {
  id: string
  session_id: string
  provider_conversation_id: string
  started_at: string
  ended_at: string | null
  end_reason: string | null
  raw_payload_ref: string | null
  audio_ref: string | null
  transcript_hash: string | null
}
export type Turn = {
  id: string
  conversation_id: string
  seq: number
  speaker: "agent" | "candidate"
  text: string
  t_start: number | null
  t_end: number | null
  stt_confidence: number | null
  usable: boolean
  plan_item_id: string | null
  move: string | null
  superseded_by: string | null
}
export type Evidence = {
  id: string
  session_id: string
  plan_item_id: string
  requirement_id: string | null
  contract_element: string
  type: string
  quote: string
  provenance: {
    conversation_id: string
    turn_ids: string[]
    audio_start_secs: number | null
    audio_end_secs: number | null
  }
  reliability: string
  specificity: number
  ownership: string
  probe_depth: number
  extractor_version: string
}
export type Signal = {
  id: string
  session_id: string
  plan_item_id: string | null
  category: string
  status: string
  basis: string
  coverage_band: string
  coverage_inputs: Record<string, unknown>
  evaluator_version: string
  evidence_ids: string[]
  reason: string | null
  limitations: string[]
}
export type Contradiction = {
  id: string
  plan_item_id: string | null
  field: string
  evidence_a: string
  evidence_b: string | null
  cv_line: string | null
  resolved: boolean
}
export type Consent = { scope: string; granted: boolean; text_version: string; recorded_at: string }
export type Review = {
  id: string
  reviewer: string
  recorded_at: string
  report_version: number
  per_signal: ReviewMark[]
  evidence_lift: { evidence_ids_new_beyond_cv: string[]; note: string | null }
}
export type ReviewMark = {
  signal_id: string
  charlie_status: string
  human_status: string
  agrees: boolean
  disagreement_reason: string | null
  note: string | null
  evaluator_version?: string | null
}
export type Event = { type: string; at: string; payload: Record<string, unknown> }

export type PackageQuote = {
  evidence_id: string
  quote: string
  contract_element: string
  type: string
  specificity: number
  ownership: string
  probe_depth: number
  reliability: string
  audio_start_secs: number | null
  audio_end_secs: number | null
  turn_ids: string[]
}
export type PackageSignal = {
  plan_item_id: string
  ref: string
  kind: ItemKind
  establishes: string
  mandate_quote: string
  why_it_matters: string
  status: string
  status_text: string
  reason: string | null
  coverage_band: string
  coverage_text: string
  coverage_inputs: Record<string, unknown>
  basis: string
  evidence: PackageQuote[]
  probes_asked: number
  missing_elements: string[]
  limitations: string[]
}
export type ReportPackage = {
  header: {
    session_id: string
    kind: SessionKind
    candidate_name_as_given: string | null
    role: string
    session_date: string
    session_status: string
    items_reached: number
    items_total: number
    duration_seconds: number | null
    plan_version: number
    extractor_version: string
    evaluator_version: string
  }
  identity_consent: { identity_basis: string; consents: Consent[] }
  must_have_gate: {
    ref: string
    establishes: string
    mandate_quote: string
    verdict: "answered" | "unknown"
    bar: "met" | "not_met" | null
    answer_quote: string | null
  }[]
  capability_grid: PackageSignal[]
  intent: PackageSignal | null
  hr_answers: { ref: string; question: string; answer_quote: string | null; status: string }[]
  communication: {
    markers: { marker: string; quote: string }[]
    conditions: Record<string, unknown>
    note: string
  }
  contradictions: {
    field: string
    quote_a: string
    quote_b: string | null
    cv_line: string | null
    resolved: boolean
    ref: string | null
  }[]
  gaps: { ref: string; establishes: string; status: string; reason: string }[]
  transcript: {
    conversations: number
    turns: number
    transcript_hash: string | null
    audio_available: boolean
  }
  limitations: string[]
  versions: { plan: number; extractor: string; evaluator: string; controller: string | null }
}
export type CallDetail = {
  session: Session
  candidate: Candidate | null
  mandate: { id: string; role: string; client: string | null }
  plan: Plan
  conversations: Conversation[]
  turns: Turn[]
  signals: Signal[]
  evidence: Evidence[]
  contradictions: Contradiction[]
  consents: Consent[]
  package: ReportPackage | null
  report_version: number | null
  review: Review | null
  cv_text?: string | null
  events: Event[]
}

export type Meta = {
  statuses: string[]
  coverage_bands: string[]
  insufficient_reasons: string[]
  not_assessed_reasons: string[]
  disagreement_reasons: string[]
  status_language: Record<string, string>
  coverage_language: Record<string, string>
  versions: { controller: string; extractor: string; evaluator: string }
  mandate_file_types: string[]
  mandate_file_max_bytes: number
}
export type Learning = {
  totals: { reviewed: number; agreed: number; disagreed: number }
  by_reason: Record<
    string,
    { count: number; jobs: Record<string, number>; versions: Record<string, number> }
  >
  open: {
    session_id: string
    role: string
    signal_id: string
    charlie_status: string
    human_status: string
    reason: string
    note: string | null
    evaluator_version: string | null
    recorded_at: string
    reviewer: string
  }[]
}
export type InviteResult = {
  session: Session
  candidate: Candidate | null
  link: string
  expires_at: string
}
export type CreateJobResult = {
  mandate: Mandate
  plan: Plan
  dropped: { ref: string; reason: string }[]
  chain: Chain
}

// ── the candidate page (/v/<token>) ────────────────────────────────────────────────────

export type ConsentText = {
  scope: "recording" | "retention" | "pool"
  text_version: string
  text: string
  required: boolean
}
export type SessionView = {
  kind: SessionKind
  state: string
  progress: { opened: number; total: number; now: string | null; done: boolean }
  role: string
  client: string | null
  next_step_text: string | null
  budget_seconds: number
  minutes: number
  consents: ConsentText[]
  consented: boolean
  live: boolean
  done: boolean
  closed: boolean
  expires_at: string
}
export type StartResult = {
  token: string
  conversation_id: string
  agent_id: string
  first_message: string
  first_message_var: string
  budget_seconds: number
  resuming: boolean
}

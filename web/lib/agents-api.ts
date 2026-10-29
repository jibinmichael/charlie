// Client for the server's agents API (/agents/api/*): each agent's on/off, mode and settings, its runs, the
// drafts waiting for a person, and the employer connections the Qualify & Submit agent works with.
import { api } from "./api"

/** The one agent today: Qualify & Submit (its definition lives in the server's agent registry). */
export type AgentId = "outreach"
export type AgentMode = "off" | "draft" | "auto"
export type AgentSettings = {
  daily_cap: number
  quiet_from: number
  quiet_to: number
  min_confidence?: number
}
export type RunItem = { who: string; mandate: string; action: string; result: string; reason: string }
export type AgentRun = {
  id: string
  agent: AgentId
  trigger: "schedule" | "manual"
  mode: AgentMode
  status: "running" | "ok" | "needs_review" | "failed" | "skipped"
  // ai_calls and tokens_*: what the run's model calls reported using (absent on runs from older servers)
  counts: Partial<Record<"considered" | "sent" | "drafted" | "waiting" | "skipped" | "failed" | "submitted" | "ai_calls" | "tokens_in" | "tokens_out" | "tokens_cache_read" | "tokens_cache_write", number>>
  items: RunItem[]
  note: string | null
  error: string | null
  started_at: string
  finished_at: string | null
}
export type Agent = {
  id: AgentId
  name: string
  /** A short tag shown beside the name (e.g. "White-label"); null when there is none. */
  label?: string | null
  what: string
  cadence: string
  /** What this agent does, step by step, as the server's agent registry describes it. */
  does: string[]
  built: boolean
  enabled: boolean
  /** The modes this agent may run in: an agent whose first emails need approval has no Auto. */
  modes: AgentMode[]
  mode: AgentMode
  settings: AgentSettings
  customised: boolean
  last_run: AgentRun | null
  pending: number
}
export type Draft = {
  id: string
  agent: AgentId
  mandate: string
  email: string
  name: string | null
  kind: string
  reason: string
  subject: string
  body_text: string
  created_at: string
}

export const listAgents = (secret: string) => api<{ agents: Agent[] }>(secret, "/agents/api/agents")

export const saveAgent = (
  secret: string,
  id: AgentId,
  body: { enabled?: boolean; mode?: AgentMode; settings?: Partial<AgentSettings> },
) => api<{ agent: Agent }>(secret, `/agents/api/agents/${id}`, { method: "PUT", body: JSON.stringify(body) })

export const runAgentNow = (secret: string, id: AgentId) =>
  api<{ status: string; run_id?: string; note?: string }>(secret, `/agents/api/agents/${id}/run`, { method: "POST" })

/** AI tokens against people put forward, over every run that measured them; runs without measurements are left out. */
export type AiUse = { runs: number; since: string | null; ai_calls: number; tokens: number; submitted: number }
export const agentRuns = (secret: string, id: AgentId) => api<{ runs: AgentRun[]; ai_use?: AiUse }>(secret, `/agents/api/agents/${id}/runs`)

export const pendingDrafts = (secret: string, id?: AgentId) =>
  api<{ drafts: Draft[] }>(secret, `/agents/api/drafts${id ? `?agent=${id}` : ""}`)

export const approveDraft = (secret: string, id: string) =>
  api<{ ok: boolean; reason: string }>(secret, `/agents/api/drafts/${id}/approve`, { method: "POST", body: JSON.stringify({ by: "workspace" }) })

export const rejectDraft = (secret: string, id: string) =>
  api<{ ok: boolean; reason?: string }>(secret, `/agents/api/drafts/${id}/reject`, { method: "POST", body: JSON.stringify({ by: "workspace" }) })

/** An employer system the Qualify & Submit agent works with (one stored connection on the server). */
export type ConnectionMode = "off" | "shadow" | "live"
export type Connection = {
  key: string
  name: string
  mode: ConnectionMode
  source: { type: string; statuses?: string[] }
  destination: { type: string; via?: string }
  settings: { per_role_cap?: number; batch_size?: number; last_full_at?: string }
  sequence: { verify?: { intro?: string; closing?: string } }
  updated_at: string
  roles: { total: number; briefed: number }
  threads: Partial<Record<QualifyStage, number>>
}
export type QualifyStage = "verify_sent" | "reminded" | "answered" | "held" | "confirming" | "ready" | "submitting" | "submitted" | "closed" | "failed"
/** One change to a candidacy and who caused it (a candidate's address is never sent). */
export type CandidacyEvent = {
  at: string
  type: "stage.changed" | "proposal.made" | "proposal.decided" | "engine.refused" | string
  actor: "agent" | "person" | "candidate" | "employer" | "system"
  actor_id: string | null
  from: QualifyStage | null
  to: QualifyStage | null
  reason: string | null
}
/** What an agent asked a person to decide ("Needs you"): today, close as not a fit. */
export type CandidacyProposal = {
  id: string
  kind: "close_not_fit"
  check: "gate" | "fit" | "pay"
  reason: string
  evidence: Record<string, string | number | null>
  proposed_by: string
  at: string | null
}
/** One Qualify & Submit conversation as the Inbox shows it, with its status already mapped by the server. */
export type QualifyThread = {
  id: string
  name: string | null
  email: string | null
  role: string | null
  company: string | null
  city: string | null
  external_role_id: string | null
  job_id: string | null
  fit: string | null
  rounds: number
  stage: QualifyStage
  label: string
  waitingFor: "them" | "their YES" | "charlie" | "pieworks" | "employer" | "you" | null
  next: string | null
  nextAt: string | null
  permission: { label: string; at: string | null; ref: string | null }
  confirm: { lines: string[]; asks: number; sent_at: string | null } | null
  questions: { id: string; text: string; round: number; answer: string | null }[]
  kept: { at: string | null; words: string; unread: boolean }[]
  submission: { status: string; attempt: number | null; at: string | null; message: string | null } | null
  /** A person's decision to put them forward: nothing in "ready" is submitted until it is "saved". */
  approval?: ThreadApproval | null
  // the candidacy lifecycle (absent from an older server)
  system_stage?: string | null
  close_group?: "They chose" | "No answer" | "Not a fit" | "Employer chose" | null
  handled_by?: string | null
  needs_you?: boolean
  proposal?: CandidacyProposal | null
  events?: CandidacyEvent[]
  verify_sent_at: string | null
  replied_at: string | null
  updated_at: string | null
  created_at: string | null
}
export type ConnectionPatch = {
  mode?: ConnectionMode
  statuses?: string[]
  settings?: { per_role_cap?: number; batch_size?: number }
  sequence?: { verify?: { intro?: string; closing?: string } }
}

export type VerifyCopy = { intro: string; closing: string }
export const listConnections = (secret: string) =>
  api<{ connections: Connection[]; defaults?: { verify: VerifyCopy } }>(secret, "/agents/api/connections")

/** Is the connection working: a live read of one page of the employer system's roles (never a submit). */
export type ConnectionCheck = {
  ok: boolean
  at: string
  total?: number | null
  sample?: { id: number; role: string; client: string } | null
  error?: string
}
export const connectionCheck = (secret: string, key: string) =>
  api<ConnectionCheck>(secret, `/agents/api/connections/${encodeURIComponent(key)}/check`)

export const saveConnection = (secret: string, key: string, body: ConnectionPatch) =>
  api<{ connection: Connection }>(secret, `/agents/api/connections/${key}`, { method: "PUT", body: JSON.stringify(body) })

export const connectionThreads = (secret: string, key: string) =>
  api<{ connection: { key: string; name: string; mode: ConnectionMode }; threads: QualifyThread[] }>(
    secret,
    `/agents/api/connections/${encodeURIComponent(key)}/threads`,
  )

/** A person's decision on an agent's question: approve the close, or keep them. The agent acts on its next run. */
export const decideProposal = (secret: string, id: string, decision: "approve" | "keep") =>
  api<{ ok: true; proposal: { id: string; status: string; decided_by: string; decided_at: string } }>(
    secret,
    `/agents/api/proposals/${encodeURIComponent(id)}/decide`,
    { method: "POST", body: JSON.stringify({ decision }) },
  )

/** A person's decision on putting someone forward (POST /agents/api/threads/:id/approval). */
export type ThreadApproval = { decision: "saved" | "passed"; by: string | null; at: string | null }
export const setThreadApproval = (secret: string, id: string, decision: "approve" | "pass") =>
  api<{ ok: true; approval: ThreadApproval }>(secret, `/agents/api/threads/${encodeURIComponent(id)}/approval`, {
    method: "POST",
    body: JSON.stringify({ decision, by: "workspace" }),
  })

/** What the Setup card shows beyond the saved settings: read-only, defined in the server's code. */
export type SetupEmail = { id: string; name: string; when: string; subject: string; lines: { text: string; editable: boolean }[] }
export type ConnectionSetup = {
  example: { name: string; role: string; company: string; city: string; partner: string }
  needs: string[]
  timings: { full_pass_hours: number; reply_minutes: number; remind_after_hours: number; close_after_hours: number; confirm_asks: number; evaluations_per_pass: number }
  emails: SetupEmail[]
  verify_issues: string[]
  /** each {token} in the templates, and what fills it */
  variables: Record<string, string>
  sender: string | null
  recipient: string
  audience: string[]
  copy_rules: string
  abilities: { id: string; name: string; what: string; model: string }[]
  guardrails: string[]
}
export const connectionSetup = (secret: string, key: string) =>
  api<ConnectionSetup>(secret, `/agents/api/connections/${encodeURIComponent(key)}/setup`)

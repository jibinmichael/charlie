"use client"

// The Agents screen: the overview of every agent, each agent's page (setup, drafts waiting for approval, run
// history) and the selected run's details.

import { ArrowLeftRight, Briefcase, CalendarClock, Check, ChevronRight, CircleCheck, Clock, History, Inbox, Info, Loader2, Lock, Mail, Play, Plug, Plus, Send, ShieldCheck, SlidersHorizontal, Sparkles, UserSearch, X } from "lucide-react"
import { useRouter } from "next/navigation"
import { Fragment, useCallback, useEffect, useMemo, useState } from "react"

import { AttachedPanel, SQUIRCLE } from "@/components/shared/AttachedDropdown"
import { tone } from "@/components/shared/tones"
import { useLink, useSecret } from "@/lib/api"
import {
  agentRuns,
  approveDraft,
  connectionCheck,
  connectionSetup,
  listAgents,
  listConnections,
  pendingDrafts,
  rejectDraft,
  runAgentNow,
  saveAgent,
  saveConnection,
  type Agent,
  type AgentId,
  type AgentMode,
  type AgentRun,
  type AiUse,
  type AgentSettings,
  type Connection,
  type ConnectionCheck,
  type ConnectionMode,
  type ConnectionPatch,
  type ConnectionSetup,
  type Draft,
  type VerifyCopy,
} from "@/lib/agents-api"
import { labelCase, personName } from "@/lib/labels"
import { cn } from "@/lib/utils"

import { F, GHOST, SANS } from "./Inbox"

/**
 * The agents the server runs: an overview to switch each agent
 * on, and per agent a page with what it does, its approval and schedule, the drafts waiting for you
 * and its run history, with the selected run's details on the right. Live: read on load, after every
 * action and every 30 seconds. Approve sends through the server's send guard; nothing sends from here.
 */

const MODE_WORDS: Record<AgentMode, { label: string; line: string }> = {
  auto: { label: "Auto", line: "Acts on its own, within the limits" },
  draft: { label: "Draft", line: "Proposes each email; nothing goes until you approve" },
  off: { label: "Off", line: "Does nothing" },
}

/** A run still marked running after this long was cut off (a restart); it no longer spins Run now. */
const RUN_FRESH_MS = 60 * 60_000
/** Is this run really running: marked running, and started within the hour of when the runs were read. The ONE rule
 *  the Run now button and the run history's status both use, so they spin together. */
const isLive = (r: AgentRun | undefined, readAt: number) => r?.status === "running" && readAt - Date.parse(r.started_at) < RUN_FRESH_MS

/** A connection's mode in one word: off, shadow (judges, sends and submits nothing), live. */
const CONN_MODE: Record<Connection["mode"], string> = { off: "Off", shadow: "Shadow", live: "Live" }

/** Chip tones, by meaning (components/shared/tones.ts, Charlie's colour system): the meaning's container behind its
 *  own text, and its dot. */
const TONE = {
  green: tone("success"),
  amber: tone("warning"),
  red: tone("error"),
  blue: tone("info"),
  grey: tone("neutral"),
} as const

const STATUS: Record<AgentRun["status"], { label: string; bg: string; fg: string; dot: string }> = {
  ok: { label: "Done", ...TONE.green },
  needs_review: { label: "Needs review", ...TONE.amber },
  failed: { label: "Failed", ...TONE.red },
  skipped: { label: "Skipped", ...TONE.grey },
  running: { label: "Running", ...TONE.blue },
}

const ICON: Record<AgentId, React.ComponentType<{ className?: string; strokeWidth?: number }>> = {
  outreach: Send, // Qualify & Submit, white-label
}

const when = new Intl.DateTimeFormat("en-IN", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
const at = (iso: string) => when.format(new Date(iso))

/** The mode an agent turns on in: its first mode that is not off (Qualify & Submit has no Draft). */
const onMode = (a: Agent): AgentMode => (a.modes ?? ["draft", "auto", "off"]).find((m) => m !== "off") ?? "draft"

/** An agent's state in one word, as its chip and its dot. */
function stateOf(a: Agent): { label: string; bg: string; fg: string; dot: string } {
  if (!a.built) return { label: "Being built", ...TONE.grey }
  if (!a.enabled || a.mode === "off") return { label: "Paused", ...TONE.grey }
  const s = a.last_run?.status
  if (s === "failed") return { label: "Active", ...TONE.green, dot: TONE.red.dot }
  if (s === "needs_review" || a.pending > 0) return { label: "Active", ...TONE.green, dot: TONE.amber.dot }
  return { label: "Active", ...TONE.green }
}

export function Agents({ isNew = false }: { isNew?: boolean }) {
  const secret = useSecret()
  const link = useLink()
  const [agents, setAgents] = useState<Agent[] | null>(null)
  const [sel, setSel] = useState<"overview" | AgentId>("overview")
  const [runs, setRuns] = useState<AgentRun[]>([])
  const [runId, setRunId] = useState<string>("")
  const [drafts, setDrafts] = useState<Draft[]>([])
  const [connections, setConnections] = useState<Connection[]>([])
  const [copyDefaults, setCopyDefaults] = useState<VerifyCopy | null>(null)
  // when the runs were last read: how old a "running" run is, measured outside render
  const [runsReadAt, setRunsReadAt] = useState(0)
  const [aiUse, setAiUse] = useState<AiUse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  // which agent's runs and drafts have come back: until then its page shows skeletons, never "0 runs"
  const [loadedFor, setLoadedFor] = useState<string | null>(null)
  // bumped after every action so the screen re-reads at once instead of waiting for the next tick
  const [tick, setTick] = useState(0)
  const refresh = useCallback(() => setTick((n) => n + 1), [])

  // Live: read on load, after every action, and every 30 seconds.
  useEffect(() => {
    let live = true
    const read = async () => {
      try {
        const { agents } = await listAgents(secret)
        if (!live) return
        setAgents(agents)
        // the employer connections show in the sidebar, the overview and the agent page; a read
        // failure leaves the rest of the page working
        const cd = await listConnections(secret).catch(() => null)
        setConnections(cd?.connections ?? [])
        if (cd?.defaults?.verify) setCopyDefaults(cd.defaults.verify)
        if (sel !== "overview") {
          const [{ runs, ai_use }, { drafts }] = await Promise.all([agentRuns(secret, sel), pendingDrafts(secret, sel)])
          if (!live) return
          setRuns(runs)
          setAiUse(ai_use ?? null)
          setRunsReadAt(Date.now())
          setDrafts(drafts)
          setLoadedFor(sel)
          setRunId((cur) => (cur && runs.some((r) => r.id === cur) ? cur : (runs[0]?.id ?? "")))
        }
        setError(null)
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : String(e))
      }
    }
    void read()
    const t = setInterval(() => void read(), 30_000)
    return () => {
      live = false
      clearInterval(t)
    }
  }, [secret, sel, tick])

  const agent = useMemo(() => (sel === "overview" ? null : (agents?.find((a) => a.id === sel) ?? null)), [agents, sel])
  const run = runs.find((r) => r.id === runId) ?? null

  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key)
    try {
      await fn()
      refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }
  // a different agent's page starts empty and loading, so the last agent's runs never show under this one
  const router = useRouter()
  // the new-agent page is its own route (/workspace/agents/new); every other item is a view of /workspace/agents
  const agentsHref = link("/workspace/agents")
  const newHref = link(`/workspace/agents/new`)
  const leaveNew = () => { if (isNew && agentsHref) router.push(agentsHref) }
  const open = (id: AgentId) => {
    if (id !== sel) { setRuns([]); setDrafts([]); setRunId("") }
    setSel(id)
    leaveNew()
  }
  const save = (id: AgentId, body: { enabled?: boolean; mode?: AgentMode; settings?: Partial<AgentSettings> }, key: string) =>
    act(key, () => saveAgent(secret, id, body))

  return (
    <div
      className="flex min-h-0 flex-1 overflow-hidden antialiased"
      style={{ background: F.white, color: F.ink, fontFamily: SANS }}
    >
      <aside className="flex w-[260px] shrink-0 flex-col gap-1 px-3 pt-4" style={{ borderRight: `1px solid ${F.line}` }}>
        <h1 className="px-2 pb-2 text-[15px] leading-[24px]">Agents</h1>
        {/* no "All agents" item: the overview is the default page, nothing is highlighted on it; an agent's page
            goes back to it with its Back link */}
        {newHref && (
          <NavItem on={isNew} onClick={() => router.push(newHref)}>
            <Plus className="size-3 shrink-0" strokeWidth={2} />
            New agent
          </NavItem>
        )}
        <p className="px-2 pt-3 pb-1 text-[12px] font-medium" style={{ color: F.muted }}>
          Available agents
        </p>
        {!agents && [56, 44, 64].map((w) => (
          <span key={w} className="flex items-center gap-2 px-2 py-2" aria-hidden>
            <Bone className="h-3 rounded" style={{ width: `${w}%` }} />
            <Bone className="ml-auto size-2 squircle" />
          </span>
        ))}
        {(agents ?? []).map((a) => (
          <NavItem key={a.id} on={sel === a.id} onClick={() => open(a.id)}>
            <span className="min-w-0 flex-1 truncate">{a.name}</span>
            {a.pending > 0 && (
              <span className="count rounded-full px-1.5" style={{ background: F.lemon, color: F.ink }}>
                {a.pending}
              </span>
            )}
            <span className="size-2 shrink-0 squircle" style={{ background: stateOf(a).dot }} />
          </NavItem>
        ))}
        {/* the employer systems Qualify & Submit works with, each with its mode, under the agents */}
        {connections.length > 0 && (
          <p className="px-2 pt-3 pb-1 text-[12px] font-medium" style={{ color: F.muted }}>
            Connections
          </p>
        )}
        {connections.map((c) => (
          <NavItem key={c.key} on={false} onClick={() => open("outreach")}>
            <span className="min-w-0 flex-1 truncate">{c.name}</span>
            <span className="label-mono shrink-0" style={{ color: c.mode === "off" ? F.faint : F.ink2 }}>
              {CONN_MODE[c.mode]}
            </span>
          </NavItem>
        ))}
      </aside>

      <section className="scroll-quiet flex min-w-0 flex-1 flex-col overflow-y-auto">
        {error && (
          <p className="mx-6 mt-4 rounded-lg px-3 py-2 text-[13px]" style={{ background: TONE.red.bg, color: TONE.red.fg }}>
            {error}
          </p>
        )}
        {!agents && !error && <OverviewSkeleton />}
        {isNew && <NewAgent onBack={() => { setSel("overview"); leaveNew() }} />}
        {!isNew && agents && sel === "overview" && (
          <Overview agents={agents} connections={connections} busy={busy} onToggle={(a, on) => save(a.id, { enabled: on, ...(on && a.mode === "off" ? { mode: onMode(a) } : {}) }, `toggle:${a.id}`)} onOpen={open} />
        )}
        {!isNew && agent && (
          <AgentPage
            agent={agent}
            connections={agent.id === "outreach" ? connections : []}
            copyDefaults={copyDefaults}
            runsReadAt={runsReadAt}
            aiUse={aiUse}
            onSaveConnection={(key, body) => act(`conn:${key}`, () => saveConnection(secret, key, body))}
            loading={loadedFor !== agent.id}
            runs={runs}
            runId={runId}
            drafts={drafts}
            busy={busy}
            onBack={() => setSel("overview")}
            onRun={(id) => setRunId(id)}
            onRunNow={() => act("run", async () => { const r = await runAgentNow(secret, agent.id); if (r.run_id) setRunId(r.run_id) })}
            onSave={(body, key) => save(agent.id, body, key)}
            onApprove={(d) => act(`approve:${d.id}`, async () => { const r = await approveDraft(secret, d.id); if (!r.ok) throw new Error(r.reason) })}
            onReject={(d) => act(`reject:${d.id}`, () => rejectDraft(secret, d.id))}
          />
        )}
      </section>

      {!isNew && agent && <RunDetails agent={agent} run={run} loading={loadedFor !== agent.id} />}
    </div>
  )
}

/** The new-agent page: routed, and honest that building your own agent is not open yet. */
function NewAgent({ onBack }: { onBack: () => void }) {
  return (
    <>
      {/* the same page header as an agent's page: the crumb back to Agents, then the title */}
      <header className="sticky top-0 z-10 flex flex-col gap-1 bg-white px-8 pt-4 pb-3" style={{ borderBottom: `1px solid ${F.line}` }}>
        <p className="flex items-center gap-2 text-[13px] leading-[20px]" style={{ color: F.muted }}>
          <button type="button" onClick={onBack} className="link">
            Agents
          </button>
          <span>›</span>
          <span style={{ color: F.ink }}>New agent</span>
        </p>
        <h2 className="text-[16px] font-medium">New agent</h2>
      </header>
      <div className="mx-auto flex w-full max-w-[560px] flex-col gap-3 px-6 py-10">
        <p className="text-[13px] leading-[20px]" style={{ color: F.ink2 }}>
          Building your own agent is not open yet. When it is, you will describe the work here, pick where its people
          come from and where they go, and set its limits, the same way Qualify &amp; Submit works today.
        </p>
        <p className="text-[13px] leading-[20px]" style={{ color: F.muted }}>
          Until then, the agents in the list on the left are the ones that run.
        </p>
      </div>
    </>
  )
}

function NavItem({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      // 13px regular in 28px rows; the open item is a subtle grey with ink text
      className={cn("flex h-7 items-center gap-2 px-2 text-left text-[13px] leading-[20px]", SQUIRCLE, !on && "hover:bg-[var(--c-hover)]")}
      style={on ? { background: F.rowOn, color: F.ink } : undefined}
    >
      {children}
    </button>
  )
}

/** A switch: a dark track with a check while on, a cross while off. A switch is a track, so it stays round. One
 *  size everywhere, the height of a chip (16px), in a table row, a panel or a page header. */
export function Switch({ on, onChange, label, disabled }: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className="relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors disabled:opacity-50"
      style={{ background: on ? F.ink : "var(--c-outline)" }}
    >
      <span className="flex size-3 items-center justify-center rounded-full bg-white transition-transform" style={{ transform: on ? "translateX(14px)" : "translateX(2px)" }}>
        {on ? <Check className="size-2" strokeWidth={2.5} style={{ color: F.ink }} /> : <X className="size-2" strokeWidth={2.5} style={{ color: TONE.grey.dot }} />}
      </span>
    </button>
  )
}

/** A status chip: mono, uppercase, small. */
function Chip({ children, bg, fg }: { children: React.ReactNode; bg: string; fg: string }) {
  return (
    <span className="label-mono inline-flex h-5 shrink-0 items-center rounded-full px-2" style={{ background: bg, color: fg }}>
      {children}
    </span>
  )
}

function Lemon({ onClick, disabled, children }: { onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn("flex h-8 shrink-0 items-center gap-1.5 px-3.5 text-[13px] hover:bg-[var(--c-brand-hover)] disabled:opacity-50", SQUIRCLE)}
      style={{ background: F.lemon, color: F.ink }}
    >
      {children}
    </button>
  )
}

function Card({ title, icon: Icon, children, footer }: { title: string; icon?: React.ComponentType<{ className?: string; strokeWidth?: number }>; children: React.ReactNode; footer?: React.ReactNode }) {
  return (
    <div className="flex flex-col rounded-2xl" style={{ boxShadow: `inset 0 0 0 1px ${F.line}` }}>
      <div className="flex flex-col gap-4 p-5">
        <h3 className="flex items-center gap-2 text-[14px] font-medium">
          {Icon && <Icon className="size-4 shrink-0" strokeWidth={1.75} />}
          {title}
        </h3>
        {children}
      </div>
      {footer && (
        <div className="mt-auto flex justify-end gap-2 px-5 py-3" style={{ borderTop: `1px solid ${F.line}` }}>
          {footer}
        </div>
      )}
    </div>
  )
}

function Overview({ agents, connections, busy, onToggle, onOpen }: { agents: Agent[]; connections: Connection[]; busy: string | null; onToggle: (a: Agent, on: boolean) => void; onOpen: (id: AgentId) => void }) {
  return (
    <div className="mx-auto flex w-full max-w-[720px] flex-col gap-4 px-6 py-10">
      {agents.map((a) => (
        <div key={a.id} className="flex flex-col gap-3 rounded-2xl p-6" style={{ boxShadow: `inset 0 0 0 1px ${F.line}` }}>
          <div className="flex items-center gap-4">
            <Switch on={a.enabled && a.mode !== "off"} label={`Turn ${a.name} on or off`} disabled={busy === `toggle:${a.id}`} onChange={(v) => onToggle(a, v)} />
            <button type="button" onClick={() => onOpen(a.id)} className="link text-[13px] leading-[20px]">
              {a.name}
            </button>
            {a.label && <Chip bg={F.chip} fg={F.ink2}>{a.label}</Chip>}
            <span className="ml-auto flex items-center gap-1.5">
              <Chip bg={stateOf(a).bg} fg={stateOf(a).fg}>{stateOf(a).label}</Chip>
              <Chip bg={F.chip} fg={F.ink2}>{MODE_WORDS[a.mode].label}</Chip>
            </span>
          </div>
          <p className="text-[13px] leading-[20px]" style={{ color: F.ink2 }}>
            {a.what}
          </p>
          {a.id === "outreach" &&
            connections.map((c) => (
              <p key={c.key} className="flex items-center gap-2 text-[13px]" style={{ color: F.ink2 }}>
                <Plug className="size-4" strokeWidth={1.75} />
                {c.name}
                <Chip bg={tone(c.mode === "live" ? "success" : c.mode === "shadow" ? "info" : "neutral").bg} fg={tone(c.mode === "live" ? "success" : c.mode === "shadow" ? "info" : "neutral").fg}>
                  {CONN_MODE[c.mode]}
                </Chip>
                <span style={{ color: F.muted }}>
                  {c.roles.briefed} of {c.roles.total} roles taken
                </span>
              </p>
            ))}
          <p className="flex items-center gap-2 text-[13px]" style={{ color: F.ink2 }}>
            <Clock className="size-4" strokeWidth={1.75} />
            {a.cadence}
            {a.last_run && (
              <span style={{ color: F.muted }}>
                {" "}
                · last run {at(a.last_run.started_at)}, {STATUS[a.last_run.status].label.toLowerCase()}
              </span>
            )}
          </p>
        </div>
      ))}
      <p className="flex items-start gap-2 pt-2 text-[13px] leading-[20px]" style={{ color: F.ink2 }}>
        <Info className="mt-[3px] size-4 shrink-0" strokeWidth={1.75} />
        Agents never introduce anyone to an employer without that person&apos;s consent. Drafts wait for you, and every
        email goes through the same checks as any other send: unsubscribes, one email per purpose, and quiet hours.
      </p>
    </div>
  )
}

type SaveFn = (b: { enabled?: boolean; mode?: AgentMode; settings?: Partial<AgentSettings> }, key: string) => void

function AgentPage({
  agent: a,
  connections,
  copyDefaults,
  runsReadAt,
  aiUse: use,
  onSaveConnection,
  loading,
  runs,
  runId,
  drafts,
  busy,
  onBack,
  onRun,
  onRunNow,
  onSave,
  onApprove,
  onReject,
}: {
  agent: Agent
  connections: Connection[]
  copyDefaults: VerifyCopy | null
  runsReadAt: number
  aiUse: AiUse | null
  onSaveConnection: (key: string, body: ConnectionPatch) => void
  loading: boolean
  runs: AgentRun[]
  runId: string
  drafts: Draft[]
  busy: string | null
  onBack: () => void
  onRun: (id: string) => void
  onRunNow: () => void
  onSave: SaveFn
  onApprove: (d: Draft) => void
  onReject: (d: Draft) => void
}) {
  const st = stateOf(a)
  const Icon = ICON[a.id]
  const on = a.enabled && a.mode !== "off"
  // a run left "running" by a restart never spins the button: only one started within the hour counts
  const running = busy === "run" || isLive(runs[0], runsReadAt)
  return (
    <div className="flex flex-col">
      <header className="sticky top-0 z-10 flex flex-col gap-1 bg-white px-8 pt-4 pb-3" style={{ borderBottom: `1px solid ${F.line}` }}>
        <p className="flex items-center gap-2 text-[13px] leading-[20px]" style={{ color: F.muted }}>
          <button type="button" onClick={onBack} className="link">
            Agents
          </button>
          <span>›</span>
          <span style={{ color: F.ink }}>{a.name}</span>
        </p>
        <div className="flex items-center gap-3">
          <h2 className="text-[16px] font-medium">{a.name}</h2>
          {a.label && <Chip bg={F.chip} fg={F.ink2}>{a.label}</Chip>}
          <Chip bg={st.bg} fg={st.fg}>{st.label}</Chip>
          <div className="ml-auto flex items-center gap-2">
            {/* spins while a run really runs: the Run now request (it answers when the run ends), or the newest run
                still marked running in the history (a scheduled one included); never a timer */}
            <Lemon onClick={onRunNow} disabled={running}>
              {running ? <Loader2 className="size-3 animate-spin" strokeWidth={2} /> : <Play className="size-3" strokeWidth={2} />}
              {running ? "Running" : "Run now"}
            </Lemon>
            <label className={cn("flex h-8 items-center gap-2.5 px-3 text-[13px]", SQUIRCLE)} style={{ boxShadow: `inset 0 0 0 1px ${F.line}` }}>
              <Switch
                on={on}
                label={on ? `Pause ${a.name}` : `Enable ${a.name}`}
                disabled={busy === "enable"}
                onChange={(v) => onSave({ enabled: v, ...(v && a.mode === "off" ? { mode: onMode(a) } : {}) }, "enable")}
              />
              {on ? "Agent on" : "Enable agent"}
            </label>
          </div>
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-[1000px] flex-col gap-6 px-8 py-7">
        <div className="flex items-start gap-4">
          <span className="flex size-12 shrink-0 items-center justify-center rounded-xl" style={{ background: tone("brand").bg, color: tone("brand").fg }}>
            <Icon className="size-6" strokeWidth={1.5} />
          </span>
          <div className="flex flex-col gap-1">
            <h3 className="text-[14px] leading-tight font-medium">{a.name}</h3>
            <p className="text-[13px] leading-[20px]" style={{ color: F.ink2 }}>
              {a.what}
            </p>
          </div>
        </div>

        {!a.built && (
          <p className="rounded-xl px-4 py-3 text-[13px] leading-[20px]" style={{ background: F.rowHover, color: F.ink2 }}>
            {a.name} is being built. You can set it up now; it starts working once it is ready, in the mode you choose.
          </p>
        )}

        <div className="flex gap-10">
          <Stat label="AI tokens" loading={loading} value={use?.runs ? `${tokenCount(use.tokens)} tokens` : ""} tip={use?.runs && use.since ? `Every run since ${new Date(use.since).toLocaleDateString("en-IN", { day: "numeric", month: "short" })} (${use.runs}), read from each model reply. Reading their replies is not counted.` : "Measured from the next run"} />
          <Stat label="Put forward" loading={loading} value={use?.runs ? String(use.submitted) : ""} tip="People who said yes to their details and were submitted, over those same runs" />
          <Stat label="Tokens per person put forward" loading={loading} value={!use?.runs ? "" : use.submitted ? tokenCount(use.tokens / use.submitted) : "No one yet"} tip="What a submission costs in AI: the tokens above divided by the people put forward" />
          <Stat label="Runs" loading={loading} value={`${runs.length} ${runs.length === 1 ? "run" : "runs"}`} />
          <Stat label="Waiting for you" loading={loading} value={String(drafts.length)} />
        </div>

        <div className="flex flex-col gap-3 rounded-2xl p-6" style={{ boxShadow: `inset 0 0 0 1px ${F.line}` }}>
          <h3 className="text-[14px] font-medium">What this agent does</h3>
          <ul className="flex flex-col gap-2">
            {a.does.map((d) => (
              <li key={d} className="flex items-start gap-2.5 text-[13px] leading-[20px]" style={{ color: F.ink2 }}>
                <CircleCheck className="mt-[3px] size-4 shrink-0" strokeWidth={2} style={{ color: F.ink2 }} />
                {d}
              </li>
            ))}
          </ul>
        </div>

        <div className="flex flex-col gap-4">
          {/* Qualify & Submit: one Setup card per connection holds every setting; any other agent shows its own
              Approval and Schedule cards */}
          {a.id === "outreach" ? (
            connections.map((c) => (
              <SetupCard
                key={`${c.key}-${c.updated_at}-${a.settings.quiet_from}-${a.settings.quiet_to}-${a.settings.daily_cap}-${copyDefaults ? 1 : 0}`}
                c={c}
                agent={a}
                defaults={copyDefaults}
                busy={busy === `conn:${c.key}` || busy === "setup"}
                onSaveConnection={(b) => onSaveConnection(c.key, b)}
                onSaveAgent={(b) => onSave(b, "setup")}
              />
            ))
          ) : (
            <>
              {/* keyed on the saved settings, so a card never holds (and sends back) settings another card has changed */}
              <ApprovalCard key={`a-${a.id}-${JSON.stringify(a.settings)}`} agent={a} busy={busy === "approval"} onSave={(b) => onSave(b, "approval")} />
              <ScheduleCard key={`s-${a.id}-${JSON.stringify(a.settings)}`} agent={a} busy={busy === "schedule"} onSave={(b) => onSave(b, "schedule")} />
            </>
          )}
        </div>

        <Card title={`Waiting for you${drafts.length ? ` (${drafts.length})` : ""}`} icon={Inbox}>
          {loading ? (
            <RowsSkeleton rows={1} />
          ) : drafts.length === 0 ? (
            <p className="text-[13px]" style={{ color: F.muted }}>
              Nothing to approve.
            </p>
          ) : (
            drafts.map((d) => <DraftCard key={d.id} d={d} busy={busy} onApprove={() => onApprove(d)} onReject={() => onReject(d)} />)
          )}
        </Card>

        <RunTable runs={runs} runId={runId} loading={loading} onRun={onRun} readAt={runsReadAt} />
      </div>
    </div>
  )
}

/** Nothing to show: "None", "0", "0 runs". */
const isEmpty = (v: string) => v === "None" || /^0(\s|$)/.test(v)

/** Nothing to show: a short grey dash. Drawn, not typed, so no dash character enters the copy. */
function Empty({ wide = false }: { wide?: boolean }) {
  return <span role="img" aria-label="None" className={cn("inline-block rounded-full align-middle", wide ? "h-[2px] w-4" : "h-[1.5px] w-2.5")} style={{ background: F.faint }} />
}

/** A count in a table cell: the number, or the grey dash for none. */
const Count = ({ n }: { n?: number | undefined }) => (n ? <span className="tabular-nums">{n}</span> : <Empty />)

const RUN_COLS = "grid grid-cols-[minmax(120px,1.2fr)_minmax(96px,1fr)_minmax(88px,0.9fr)_72px_72px_72px_minmax(0,1.6fr)] items-center gap-x-6"

/** The run history: small grey headers, 13px rows on hairlines, counts right-aligned,
 *  status as a dot and its word. A selected run opens what it did, person by person, beneath it. */
function RunTable({ runs, runId, loading, onRun, readAt }: { runs: AgentRun[]; runId: string; loading: boolean; onRun: (id: string) => void; readAt: number }) {
  return (
    <div className="flex flex-col overflow-hidden rounded-2xl" style={{ boxShadow: `inset 0 0 0 1px ${F.line}` }}>
      <div className="flex items-center gap-2 px-5 pt-4 pb-3">
        <h3 className="flex items-center gap-2 text-[14px] font-medium">
          <History className="size-4 shrink-0" strokeWidth={1.75} />
          Run history
        </h3>
        {!loading && runs.length > 0 && (
          <span className="text-[13px] tabular-nums" style={{ color: F.muted }}>
            {runs.length}
          </span>
        )}
      </div>
      {/* the header row: one hairline under it, inset from the card's sides, never a box joined to its edges */}
      <div className={cn(RUN_COLS, "mx-5 h-8 text-[12px]")} style={{ color: F.muted, borderBottom: `1px solid ${F.line}` }}>
        <span>When</span>
        <span>Status</span>
        <span>Started by</span>
        <span className="text-right">Checked</span>
        <span className="text-right">Drafted</span>
        <span className="text-right">Sent</span>
        <span>Note</span>
      </div>
      {loading ? (
        <div className="px-3 py-1">
          <RowsSkeleton />
        </div>
      ) : runs.length === 0 ? (
        <p className="px-5 py-4 text-[13px]" style={{ color: F.muted }}>
          No runs yet. Press Run now, or wait for its schedule.
        </p>
      ) : (
        // every row sits on the header's inset (12px list padding + 8px row padding = the header's 20px), so the
        // hairlines, the selected row and the opened run all line up with the columns
        <ul className="flex flex-col px-3 pb-2">
          {runs.map((r, i) => {
            const on = r.id === runId
            const st = STATUS[r.status]
            return (
              <li key={r.id} className={cn(on && "my-1 rounded-xl")} style={on ? { background: F.rowOn } : { borderTop: i && runs[i - 1]?.id !== runId ? `1px solid ${F.line}` : undefined }}>
                <button
                  type="button"
                  onClick={() => onRun(r.id)}
                  aria-expanded={on}
                  className={cn(RUN_COLS, "h-10 w-full px-2 text-left text-[13px] leading-[20px]", SQUIRCLE, !on && "hover:bg-[var(--c-hover)]")}
                >
                  <span style={{ color: F.ink }}>{at(r.started_at)}</span>
                  <span className="label-mono flex items-center gap-1.5" style={{ color: F.body }}>
                    {/* a live run spins, on the same rule as Run now; every other status is its dot */}
                    {isLive(r, readAt) ? (
                      <Loader2 className="size-3 shrink-0 animate-spin" strokeWidth={2} style={{ color: st.dot }} aria-label="Running" />
                    ) : (
                      <span className="size-1.5 shrink-0 squircle" style={{ background: st.dot }} />
                    )}
                    {st.label}
                  </span>
                  <span style={{ color: F.ink2 }}>{r.trigger === "manual" ? "Run now" : "Schedule"}</span>
                  <span className="text-right" style={{ color: F.body }}>
                    <Count n={r.counts.considered} />
                  </span>
                  <span className="text-right" style={{ color: F.body }}>
                    <Count n={r.counts.drafted} />
                  </span>
                  <span className="text-right" style={{ color: F.body }}>
                    <Count n={r.counts.sent} />
                  </span>
                  <span className="truncate" style={{ color: r.error ? TONE.red.ink : F.muted }} data-tip={r.error ?? r.note ?? (runSummary(r.items) || undefined)}>
                    {r.error ?? r.note ?? (r.counts.waiting ? `${r.counts.waiting} waiting` : runSummary(r.items) || <Empty />)}
                  </span>
                </button>
                {on && r.items.length > 0 && <RunItems items={r.items} />}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

/** A run's people and roles, nested in its opened row: a tally, then who, what happened and why. */
const RESULT_WORD: Record<string, string> = { shadow: "Would do", "not written to": "Skipped", sent: "Sent", drafted: "Drafted", submitted: "Submitted", closed: "Closed", failed: "Failed", synced: "Synced", refused: "Refused", ready: "Ready", judged: "Roles judged", "not judged": "Roles not judged", "not due": "Replies only" }
/** What a run did, in the Note column when it has no note of its own: its one line, or a tally of its lines. */
function runSummary(items: AgentRun["items"]): string {
  if (!items.length) return ""
  const [only] = items
  if (only && items.length === 1) return only.reason ? only.reason.charAt(0).toUpperCase() + only.reason.slice(1) : (RESULT_WORD[only.result] ?? labelCase(only.result))
  const tally = items.reduce<Record<string, number>>((m, it) => {
    const w = RESULT_WORD[it.result] ?? labelCase(it.result)
    return (m[w] = (m[w] ?? 0) + 1), m
  }, {})
  return Object.entries(tally).map(([w, n]) => `${n} ${w.toLowerCase()}`).join(" · ")
}
function RunItems({ items }: { items: AgentRun["items"] }) {
  const word = (r: string) => RESULT_WORD[r] ?? labelCase(r)
  const tally = Object.entries(items.reduce<Record<string, number>>((m, it) => ((m[word(it.result)] = (m[word(it.result)] ?? 0) + 1), m), {}))
  // the Role column only when it says something: a value that is the same on every line (the connection's key) is noise
  const showRole = new Set(items.map((it) => it.mandate || "")).size > 1
  const cols = showRole ? "grid grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_88px_minmax(0,2fr)] items-baseline gap-x-6" : "grid grid-cols-[minmax(0,1.1fr)_88px_minmax(0,2.4fr)] items-baseline gap-x-6"
  return (
    <div className="px-2 pb-2">
      <div className="overflow-hidden rounded-lg bg-white" style={{ boxShadow: `inset 0 0 0 1px ${F.line}` }}>
        <div className="flex flex-wrap items-center gap-1.5 px-3 pt-2.5 pb-2">
          {tally.map(([w, n]) => (
            <Chip key={w} bg={F.chip} fg={F.ink2}>
              <span className="tabular-nums">{n}</span> {w.toLowerCase()}
            </Chip>
          ))}
        </div>
        <div className={cn(cols, "mx-3 h-7 text-[12px]")} style={{ color: F.muted, borderBottom: `1px solid ${F.line}` }}>
          <span>Who</span>
          {showRole && <span>Role</span>}
          <span>Result</span>
          <span>Why</span>
        </div>
        <ul className="scroll-quiet flex max-h-[320px] flex-col overflow-y-auto px-3 pb-1">
          {items.map((it, j) => (
            <li key={j} className={cn(cols, "py-2 text-[13px] leading-[20px]")} style={{ borderTop: j ? `1px solid ${F.line}` : undefined }}>
              <span className="truncate" style={{ color: F.ink }} data-tip={it.who}>
                {it.action === "role" ? it.who : personName(it.who)}
              </span>
              {showRole && (
                <span className="truncate" style={{ color: F.ink2 }} data-tip={it.mandate}>
                  {it.mandate ? it.mandate : <Empty />}
                </span>
              )}
              <span className="truncate" style={{ color: F.ink2 }}>
                {word(it.result)}
              </span>
              <span className="min-w-0 truncate" style={{ color: F.muted }} data-tip={it.reason}>
                {it.reason ? labelCase(it.reason) : <Empty />}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

/** Every token a run's model calls reported: fresh input, output, and cache reads and writes. */
function runTokens(c: AgentRun["counts"]): number {
  return (c.tokens_in ?? 0) + (c.tokens_out ?? 0) + (c.tokens_cache_read ?? 0) + (c.tokens_cache_write ?? 0)
}
const tokenCount = (n: number) => new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(Math.round(n))

function Stat({ label, value, loading = false, tip }: { label: string; value: string; loading?: boolean; tip?: string }) {
  return (
    <div className="flex flex-col gap-1.5" data-tip={tip}>
      <span className="text-[13px]" style={{ color: F.muted }}>
        {label}
      </span>
      {loading ? (
        <Bone className="h-5 w-16 rounded" />
      ) : (
        <span className="flex h-5 items-center text-[16px] leading-[20px] font-medium" style={{ color: F.ink }}>
          {isEmpty(value) || value === "" ? <Empty wide /> : value}
        </span>
      )}
    </div>
  )
}

/** One skeleton block, the same grey the inbox's skeletons use. */
function Bone({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return <span className={cn("block animate-pulse", className)} style={{ background: F.chip, ...style }} />
}

/** The overview while the agents are read: the heading, then cards in the shape of the real ones. */
function OverviewSkeleton() {
  return (
    <div className="mx-auto flex w-full max-w-[720px] flex-col gap-4 px-6 py-10" aria-label="Loading agents" aria-busy>
      <div className="flex flex-col items-center gap-2.5 pb-4">
        <Bone className="h-5 w-56 rounded" />
        <Bone className="h-3 w-[420px] max-w-full rounded" />
        <Bone className="h-3 w-80 max-w-full rounded" />
      </div>
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex flex-col gap-3 rounded-2xl p-6" style={{ boxShadow: `inset 0 0 0 1px ${F.line}` }}>
          <span className="flex items-center gap-4">
            <Bone className="h-6 w-11 rounded-full" />
            <Bone className="h-3.5 w-40 rounded" />
            <span className="ml-auto flex gap-1.5">
              <Bone className="h-[22px] w-16 rounded-full" />
              <Bone className="h-[22px] w-12 rounded-full" />
            </span>
          </span>
          <Bone className="h-3 w-11/12 rounded" />
          <Bone className="h-3 w-2/3 rounded" />
          <Bone className="h-3 w-48 rounded" />
        </div>
      ))}
    </div>
  )
}

/** Rows in the shape of the run history while it is read. */
function RowsSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <span className="flex flex-col" aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        <span key={i} className="flex items-center gap-3 px-2 py-2.5" style={{ borderTop: i ? `1px solid ${F.line}` : undefined }}>
          <Bone className="h-3 w-[120px] rounded" />
          <Bone className="h-[22px] w-14 rounded-full" />
          <Bone className="h-3 rounded" style={{ width: `${[40, 55, 30][i % 3]}%` }} />
        </span>
      ))}
    </span>
  )
}

/** One settings row: the label and its (i) on the left, a small control on the right, hairlines between rows.
 *  Explanations stay in the (i) tooltip, never as grey text. */
function Row({ label, info, children }: { label: string; info?: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-12 items-center justify-between gap-6 py-2" style={{ borderTop: `1px solid ${F.line}` }}>
      <span className="flex items-center gap-1.5 text-[13px]" style={{ color: F.ink }}>
        {label}
        {info && (
          <span data-tip={info} aria-label={info} className="flex">
            <Info className="size-3" strokeWidth={1.75} style={{ color: F.faint }} />
          </span>
        )}
      </span>
      <span className="flex shrink-0 items-center gap-2">{children}</span>
    </div>
  )
}

/** A small segmented control: a grey track, the chosen option a white squircle. */
function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <span role="radiogroup" aria-label={label} className="inline-flex gap-0.5 rounded-full p-0.5" style={{ background: TONE.grey.bg }}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          // every segmented label in uppercase mono, a size below the chips' 11px
          className={cn("label-mono h-7 px-2.5", value === o.value && "font-medium", SQUIRCLE)}
          style={value === o.value ? { fontSize: 10, background: F.white, color: F.ink, boxShadow: "0 1px 2px rgba(15,14,22,0.08), inset 0 0 0 1px rgba(15,14,22,0.06)" } : { fontSize: 10, color: F.muted }}
        >
          {o.label}
        </button>
      ))}
    </span>
  )
}

/** A small number box with its unit after it. */
function NumberBox({ value, onChange, min, max, unit, label }: { value: number; onChange: (v: number) => void; min: number; max: number; unit?: string; label: string }) {
  return (
    <span className="flex items-center gap-2">
      <input
        type="number"
        aria-label={label}
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-7 w-16 rounded-lg px-2 text-right text-[13px] tabular-nums outline-none"
        style={{ background: F.white, boxShadow: `inset 0 0 0 1px ${F.line}`, color: F.ink }}
      />
      {unit && (
        <span className="w-12 text-[12px]" style={{ color: F.muted }}>
          {unit}
        </span>
      )}
    </span>
  )
}

/** A settings group: its title, its rows, and its own Save. */
function SettingsCard({ title, icon: Icon, footer, children }: { title: string; icon?: React.ComponentType<{ className?: string; strokeWidth?: number }>; footer: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex flex-col rounded-2xl" style={{ boxShadow: `inset 0 0 0 1px ${F.line}` }}>
      <h3 className="flex items-center gap-2 px-5 pt-4 pb-3 text-[14px] font-medium">
        {Icon && <Icon className="size-4 shrink-0" strokeWidth={1.75} />}
        {title}
      </h3>
      <div className="px-5">{children}</div>
      <div className="flex justify-end px-5 py-3" style={{ borderTop: `1px solid ${F.line}` }}>
        {footer}
      </div>
    </div>
  )
}

function ApprovalCard({ agent: a, busy, onSave }: { agent: Agent; busy: boolean; onSave: (b: { mode?: AgentMode; settings?: Partial<AgentSettings> }) => void }) {
  const [mode, setMode] = useState<AgentMode>(a.mode)
  const [cap, setCap] = useState<number>(a.settings.daily_cap)
  const dirty = mode !== a.mode || cap !== a.settings.daily_cap
  // only the modes this agent has, in the usual order
  const modes = (["draft", "auto", "off"] as AgentMode[]).filter((m) => (a.modes ?? ["draft", "auto", "off"]).includes(m))
  return (
    <SettingsCard title="Approval" footer={<Lemon onClick={() => onSave({ mode, settings: { daily_cap: cap } })} disabled={!dirty || busy}>{busy ? "Saving" : "Save"}</Lemon>}>
      <Row label="Mode" info={modes.map((m) => `${MODE_WORDS[m].label}: ${MODE_WORDS[m].line}.`).join(" ")}>
        <Segmented label="Mode" value={mode} onChange={setMode} options={modes.map((m) => ({ value: m, label: MODE_WORDS[m].label }))} />
      </Row>
      <Row label="Emails a day, at most" info="Sent and drafted together, counted per India day.">
        <NumberBox label="Emails a day, at most" value={cap} onChange={setCap} min={0} max={200} unit="emails" />
      </Row>
    </SettingsCard>
  )
}

const CONNECTION_MODES: { value: ConnectionMode; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "shadow", label: "Shadow" },
  { value: "live", label: "Live" },
]
const ROLE_STATUSES = ["Hot", "Warm", "Cold", "Hold"]
const STAGE_WORDS: [keyof Connection["threads"], string][] = [
  ["verify_sent", "asked"], ["reminded", "reminded"], ["answered", "answered"], ["held", "waiting on you"], ["confirming", "confirming"], ["ready", "ready"], ["submitting", "submitting"], ["submitted", "submitted"], ["closed", "closed"], ["failed", "need you"],
]

/** Whether the employer system answers: read live when the card opens, and again on demand. */
function ConnectionStatus({ k }: { k: string }) {
  const secret = useSecret()
  const [s, setS] = useState<ConnectionCheck | null>(null)
  const [checking, setChecking] = useState(true)
  const [n, setN] = useState(0)
  // state is set only when the answer comes back, never synchronously in the effect
  useEffect(() => {
    let live = true
    connectionCheck(secret, k)
      .then((r) => live && setS(r))
      .catch((e) => live && setS({ ok: false, at: new Date().toISOString(), error: e instanceof Error ? e.message : String(e) }))
      .finally(() => live && setChecking(false))
    return () => {
      live = false
    }
  }, [secret, k, n])
  const run = () => {
    setChecking(true)
    setN((x) => x + 1)
  }
  const dot = checking || !s ? TONE.grey.dot : s.ok ? TONE.green.dot : TONE.red.dot
  const words = checking || !s
    ? "Checking"
    : s.ok
      ? `Connected · ${s.total ?? "?"} active ${s.total === 1 ? "role" : "roles"}`
      : `Not connected · ${s.error ?? "no answer"}`
  return (
    <span className="flex min-w-0 items-center justify-end gap-2 text-[13px]" style={{ color: F.ink2 }}>
      <span className="size-2 shrink-0 squircle" style={{ background: dot }} />
      <span className="min-w-0 truncate" data-tip={s?.error ?? (s?.at ? `Checked ${at(s.at)}` : undefined)}>
        {words}
      </span>
      <button type="button" onClick={run} disabled={checking} className={cn(GHOST, "h-7 shrink-0 px-2 text-[12px] disabled:opacity-50")}>
        Check again
      </button>
    </span>
  )
}

/** One section of the Setup card: a chevron, a contextual icon, the name, a one-line
 *  summary on the right and, where something can be added, a small + action; it opens in place, never a modal. */
function SetupSection({ icon: Icon, title, summary, action, open, onToggle, children }: { icon: React.ComponentType<{ className?: string; strokeWidth?: number }>; title: string; summary: React.ReactNode; action?: React.ReactNode; open: boolean; onToggle: () => void; children: React.ReactNode }) {
  return (
    <div style={{ borderTop: `1px solid ${F.line}` }}>
      <div className="flex min-h-11 items-center gap-2">
        <button type="button" onClick={onToggle} aria-expanded={open} className={cn("flex min-w-0 flex-1 items-center gap-2 py-2 text-left", SQUIRCLE)}>
          <ChevronRight className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")} strokeWidth={2} style={{ color: F.faint }} />
          <Icon className="size-4 shrink-0" strokeWidth={1.75} />
          <span className="text-[13px] font-medium" style={{ color: F.ink }}>
            {title}
          </span>
          <span className="ml-auto min-w-0 truncate pl-4 text-right text-[12px]" style={{ color: F.muted }}>
            {summary}
          </span>
        </button>
        {action}
      </div>
      {open && <div className="flex flex-col pb-3 pl-[46px]">{children}</div>}
    </div>
  )
}

/** A line inside a section: a label on the left, its value or control on the right. */
function SetupLine({ label, info, children }: { label: string; info?: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-10 items-center justify-between gap-6 py-1.5">
      <span className="flex items-center gap-1.5 text-[13px]" style={{ color: F.ink2 }}>
        {label}
        {info && (
          <span data-tip={info} aria-label={info} className="flex">
            <Info className="size-3" strokeWidth={1.75} style={{ color: F.faint }} />
          </span>
        )}
      </span>
      <span className="flex shrink-0 items-center gap-2 text-[13px]" style={{ color: F.ink }}>
        {children}
      </span>
    </div>
  )
}

/** A template's text with every {variable} shown as a tag, distinct from the copy around it. */
function Tokens({ text, vars }: { text: string; vars: Record<string, string> }) {
  const parts = String(text).split(/(\{[a-z_]+\})/g)
  return (
    <>
      {parts.map((p, i) => {
        const m = /^\{([a-z_]+)\}$/.exec(p)
        if (!m) return <Fragment key={i}>{p}</Fragment>
        const label = vars[m[1]!] ?? m[1]
        return (
          <span key={i} className="mx-px inline-flex items-center rounded-md px-1.5 align-baseline text-[12px] leading-[18px]" style={{ background: TONE.blue.bg, color: TONE.blue.fg }} data-tip={`Filled per person: ${label}`}>
            {label}
          </span>
        )
      })}
    </>
  )
}

/** One header row of a template: the label in a fixed column, the value beside it. */
function TemplateRow({ label, last, children }: { label: string; last?: boolean; children: React.ReactNode }) {
  return (
    <div className="flex min-h-9 items-center gap-3 py-1" style={{ borderBottom: last ? undefined : `1px solid ${F.line}` }}>
      <span className="w-14 shrink-0 text-[12px]" style={{ color: F.muted }}>
        {label}
      </span>
      <span className="min-w-0 text-[13px]" style={{ color: F.body }}>
        {children}
      </span>
    </div>
  )
}

/** An agent has ONE source and ONE destination; Change lists what each could be instead, said
 *  plainly, never a button that pretends. A custom destination is shaped to what the source sends. */
const OTHER_SOURCES: { name: string; what: string }[] = []
const OTHER_DESTINATIONS = [
  { name: "Custom destination", what: "Your own endpoint, its fields matched to what the source sends" },
]

/** The Change list of a single choice: the current one, then the others with why they cannot be picked yet. */
function ChoiceList({ current, what, others }: { current: string; what: string; others: { name: string; what: string }[] }) {
  return (
    <div className="flex flex-col gap-0.5 p-1">
      <div className="flex items-center gap-2.5 rounded-lg px-2 py-1.5" style={{ background: F.rowOn }}>
        <span className="min-w-0 flex-1">
          <span className="block text-[13px]" style={{ color: F.ink }}>{current}</span>
          <span className="block text-[12px]" style={{ color: F.muted }}>{what}</span>
        </span>
        <Check className="size-3 shrink-0" strokeWidth={2.25} style={{ color: TONE.green.ink }} aria-label="In use" />
      </div>
      {others.map((o) => (
        <div key={o.name} className="flex items-center gap-2.5 px-2 py-1.5">
          <span className="min-w-0 flex-1">
            <span className="block text-[13px] leading-[20px]" style={{ color: F.ink }}>{o.name}</span>
            <span className="block text-[12px]" style={{ color: F.muted }}>{o.what}</span>
          </span>
          <Chip bg={F.chip} fg={F.ink2}>Coming soon</Chip>
        </div>
      ))}
    </div>
  )
}

/** The Change button beside a single-choice section, its list attached beneath it (an AttachedPanel). */
function ChangeMenu({ open, onOpenChange, ariaLabel, children }: { open: boolean; onOpenChange: (open: boolean) => void; ariaLabel: string; children: React.ReactNode }) {
  return (
    <AttachedPanel open={open} onOpenChange={onOpenChange} icon={<ArrowLeftRight className="size-3" strokeWidth={2} />} label="Change" align="right" ariaLabel={ariaLabel} width={360}>
      {children}
    </AttachedPanel>
  )
}

/**
 * Qualify & Submit's whole setup for one connection, in one card: source, destination, triggers, audience, limits,
 * emails, abilities and guardrails, each a section that opens in place. What is not a saved setting (the timings,
 * the real emails, the models, the guardrails) is read from the server's setup endpoint, never written here.
 */
function SetupCard({ c, agent: a, defaults, busy, onSaveConnection, onSaveAgent }: { c: Connection; agent: Agent; defaults: VerifyCopy | null; busy: boolean; onSaveConnection: (b: ConnectionPatch) => Promise<void> | void; onSaveAgent: (b: { settings: Partial<AgentSettings> }) => Promise<void> | void }) {
  const secret = useSecret()
  const [setup, setSetup] = useState<ConnectionSetup | null>(null)
  const [setupError, setSetupError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    connectionSetup(secret, c.key)
      .then((d) => live && setSetup(d))
      .catch((e) => live && setSetupError(e instanceof Error ? e.message : String(e)))
    return () => {
      live = false
    }
  }, [secret, c.key])
  const [open, setOpen] = useState<string | null>("source")
  const [emailOpen, setEmailOpen] = useState<string | null>(null)
  const [changing, setChanging] = useState<"source" | "dest" | null>(null)
  const toggle = (k: string) => setOpen((cur) => (cur === k ? null : k))
  // the connection's settings
  const [mode, setMode] = useState<ConnectionMode>(c.mode)
  const [statuses, setStatuses] = useState<string[]>(c.source.statuses ?? ["Hot", "Warm"])
  const [cap, setCap] = useState<number>(c.settings.per_role_cap ?? 16)
  const [batch, setBatch] = useState<number>(c.settings.batch_size ?? 4)
  const introStart = c.sequence.verify?.intro || defaults?.intro || ""
  const closingStart = c.sequence.verify?.closing || defaults?.closing || ""
  // read-only for now (editing is not built yet); Save keeps whatever wording is saved
  const [intro] = useState<string>(introStart)
  const [closing] = useState<string>(closingStart)
  // the agent's settings that this connection runs under
  const [quietFrom, setQuietFrom] = useState<number>(a.settings.quiet_from)
  const [quietTo, setQuietTo] = useState<number>(a.settings.quiet_to)
  const [daily, setDaily] = useState<number>(a.settings.daily_cap)
  const connDirty =
    mode !== c.mode || JSON.stringify(statuses) !== JSON.stringify(c.source.statuses ?? ["Hot", "Warm"]) ||
    cap !== (c.settings.per_role_cap ?? 16) || batch !== (c.settings.batch_size ?? 4) || intro !== introStart || closing !== closingStart
  const agentDirty = quietFrom !== a.settings.quiet_from || quietTo !== a.settings.quiet_to || daily !== a.settings.daily_cap
  // Charlie's own wording, unchanged, is saved as "no wording of its own", never as an override
  const own = (v: string, d: string | undefined) => (v.trim() && v.trim() !== (d ?? "").trim() ? v.trim() : "")
  const save = async () => {
    if (connDirty) await onSaveConnection({ mode, statuses, settings: { per_role_cap: cap, batch_size: batch }, sequence: { verify: { intro: own(intro, defaults?.intro), closing: own(closing, defaults?.closing) } } })
    if (agentDirty) await onSaveAgent({ settings: { quiet_from: quietFrom, quiet_to: quietTo, daily_cap: daily } })
  }
  const toggleStatus = (s: string) => setStatuses((cur) => (cur.includes(s) ? (cur.length > 1 ? cur.filter((x) => x !== s) : cur) : [...cur, s]))
  const counts = STAGE_WORDS.filter(([k]) => (c.threads[k] ?? 0) > 0)
  const hh = (h: number) => `${String(h).padStart(2, "0")}:00`
  const t = setup?.timings

  return (
    <SettingsCard title="Setup" icon={SlidersHorizontal} footer={<Lemon onClick={() => void save()} disabled={!(connDirty || agentDirty) || busy}>{busy ? "Saving" : "Save"}</Lemon>}>
      {setupError && (
        <p className="pb-2 text-[12px]" style={{ color: TONE.red.ink }}>
          The setup details could not be read: {setupError}
        </p>
      )}

      <SetupSection
        icon={Briefcase}
        title="Source"
        summary={`${c.name} · ${CONN_MODE[mode]} · ${c.roles.total} ${c.roles.total === 1 ? "role" : "roles"}`}
        open={open === "source"}
        onToggle={() => toggle("source")}
        action={
          <ChangeMenu open={changing === "source"} onOpenChange={(o) => setChanging(o ? "source" : null)} ariaLabel="Change the source">
            <ChoiceList current={c.name} what="In use" others={OTHER_SOURCES} />
          </ChangeMenu>
        }
      >
        <SetupLine label="Connection" info="A live read of one page of the roles, never a submit.">
          <ConnectionStatus k={c.key} />
        </SetupLine>
        <SetupLine label="Mode" info="Off does nothing. Shadow does everything except send and submit. Live sends and submits.">
          <Segmented label="Mode" value={mode} onChange={setMode} options={CONNECTION_MODES} />
        </SetupLine>
        <SetupLine label="Roles it takes" info="Only roles with these statuses become jobs; the rest are paused.">
          <span className="flex flex-wrap justify-end gap-1">
            {ROLE_STATUSES.map((s) => (
              <button key={s} type="button" onClick={() => toggleStatus(s)} aria-pressed={statuses.includes(s)} className={cn("h-7 px-2.5 text-[13px] leading-[20px]", statuses.includes(s) && "font-medium", SQUIRCLE)} style={statuses.includes(s) ? { background: F.ink, color: F.white } : { background: F.white, color: F.muted, boxShadow: `inset 0 0 0 1px ${F.line}` }}>
                {s}
              </button>
            ))}
          </span>
        </SetupLine>
        <SetupLine label="What it has done">
          <span style={{ color: F.ink2 }}>
            {c.roles.briefed} {c.roles.briefed === 1 ? "role" : "roles"} in
            {counts.length ? ` · ${counts.map(([k, w]) => `${c.threads[k]} ${w}`).join(" · ")}` : ""}
          </span>
        </SetupLine>
      </SetupSection>

      <SetupSection
        icon={Send}
        title="Destination"
        summary={`${c.destination.via ?? c.name} referral`}
        open={open === "dest"}
        onToggle={() => toggle("dest")}
        action={
          <ChangeMenu open={changing === "dest"} onOpenChange={(o) => setChanging(o ? "dest" : null)} ariaLabel="Change the destination">
            <ChoiceList current={`${c.destination.via ?? c.name} referral`} what="In use" others={OTHER_DESTINATIONS} />
          </ChangeMenu>
        }
      >
        <p className="pb-2 text-[13px]" style={{ color: F.ink2 }}>
          Each person is handed off once per role, with:
        </p>
        <span className="flex flex-wrap gap-1">
          {(setup?.needs ?? []).map((n) => (
            <Chip key={n} bg={F.chip} fg={F.ink2}>{n}</Chip>
          ))}
          {!setup && !setupError && <Bone className="h-[22px] w-48 rounded-full" />}
        </span>
      </SetupSection>

      <SetupSection icon={CalendarClock} title="Triggers" summary={t ? `New fits every ${t.full_pass_hours} h · ${hh(quietTo)} to ${hh(quietFrom)} IST` : <Empty />} open={open === "triggers"} onToggle={() => toggle("triggers")}>
        <SetupLine label="Finds new fits">{t ? `Every ${t.full_pass_hours} hours` : <Empty />}</SetupLine>
        <SetupLine label="Reads replies">{t ? `Every ${t.reply_minutes} minutes` : <Empty />}</SetupLine>
        <SetupLine label="Quiet hours" info="No emails go out between these hours, India time.">
          <NumberBox label="Quiet from" value={quietFrom} onChange={setQuietFrom} min={0} max={23} />
          <span className="text-[12px]" style={{ color: F.muted }}>to</span>
          <NumberBox label="Quiet until" value={quietTo} onChange={setQuietTo} min={0} max={23} unit=":00 IST" />
        </SetupLine>
      </SetupSection>

      <SetupSection icon={UserSearch} title="Audience" summary="Passes the candidate scorer" open={open === "audience"} onToggle={() => toggle("audience")}>
        <SetupLine label="Talks to" info="Everyone the server's candidate scorer (CANDIDATE_SCORER) passes for the role. A person approves each one before they are put forward.">
          Passes the scorer
        </SetupLine>
        <ul className="flex flex-col gap-1.5 pt-1">
          {(setup?.audience ?? []).map((r) => (
            <li key={r} className="flex items-start gap-2 text-[13px]" style={{ color: F.ink2 }}>
              <CircleCheck className="mt-[3px] size-3 shrink-0" strokeWidth={2} style={{ color: F.muted }} />
              {r}
            </li>
          ))}
        </ul>
      </SetupSection>

      <SetupSection icon={ShieldCheck} title="Limits" summary={`${batch} at a time · ${cap} per role · ${daily} a day`} open={open === "limits"} onToggle={() => toggle("limits")}>
        <SetupLine label="Asked at a time, per role" info="The next people are asked only when these have answered or closed.">
          <NumberBox label="Asked at a time, per role" value={batch} onChange={setBatch} min={1} max={16} unit="people" />
        </SetupLine>
        <SetupLine label="Submitted per role, at most">
          <NumberBox label="Submitted per role, at most" value={cap} onChange={setCap} min={1} max={30} unit="people" />
        </SetupLine>
        <SetupLine label="Emails a day, at most" info="Counted per India day.">
          <NumberBox label="Emails a day, at most" value={daily} onChange={setDaily} min={0} max={200} unit="emails" />
        </SetupLine>
      </SetupSection>

      <SetupSection icon={Mail} title="Emails" summary={setup ? `${setup.emails.length} emails · read-only` : <Empty />} open={open === "emails"} onToggle={() => toggle("emails")}>
        {/* a saved line the email will not use is said, never shown as if it went out */}
        {(setup?.verify_issues ?? []).map((m) => (
          <p key={m} className="mb-1 rounded-lg px-2.5 py-1.5 text-[12px]" style={{ background: TONE.amber.bg, color: TONE.amber.fg }}>
            Not used: {m.replace(/^verify (intro|closing): /, (_, k) => (k === "intro" ? "the opening line " : "the closing line ")).replace(/; default used$/, "")}. Charlie&apos;s wording goes out instead.
          </p>
        ))}
        {setup && (
          <>
            {/* the whole loop, in order; the closing email goes on any path that ends */}
            <div className="flex flex-wrap items-center gap-1 pb-2">
              {setup.emails.map((e, i) => {
                const on = (emailOpen ?? setup.emails[0]?.id) === e.id
                return (
                  <Fragment key={e.id}>
                    {i > 0 && e.id !== "closed" && <ChevronRight className="size-3 shrink-0" strokeWidth={2} style={{ color: F.faint }} />}
                    {e.id === "closed" && <span className="px-1 text-[12px]" style={{ color: F.muted }}>· any no:</span>}
                    <button
                      type="button"
                      onClick={() => setEmailOpen(e.id)}
                      aria-pressed={on}
                      className={cn("flex h-7 items-center gap-1.5 px-2.5 text-[13px] leading-[20px]", on && "font-medium", SQUIRCLE)}
                      style={on ? { background: F.ink, color: F.white } : { background: F.white, color: F.ink2, boxShadow: `inset 0 0 0 1px ${F.line}` }}
                    >
                      <span className="tabular-nums" style={{ opacity: 0.6 }}>{i + 1}</span>
                      {e.name}
                    </button>
                  </Fragment>
                )
              })}
            </div>
            {setup.emails
              .filter((e) => e.id === (emailOpen ?? setup.emails[0]?.id))
              .map((e) => (
                <div key={e.id} className="flex flex-col overflow-hidden rounded-xl" style={{ boxShadow: `inset 0 0 0 1px ${F.line}` }}>
                  {/* the header: From, To, Subject, each its own row */}
                  <div className="flex flex-col px-3 py-1">
                    <TemplateRow label="From">
                      <span className="rounded-md px-1.5 text-[12px] leading-[20px]" style={{ background: F.chip, color: F.ink }}>
                        {setup.sender ?? "Charlie"}
                      </span>
                    </TemplateRow>
                    <TemplateRow label="To">
                      <Tokens text={setup.recipient} vars={setup.variables} />
                    </TemplateRow>
                    <TemplateRow label="Subject" last>
                      <Tokens text={e.subject} vars={setup.variables} />
                    </TemplateRow>
                  </div>
                  {/* the body: copy as text, every variable a tag */}
                  <div className="flex flex-col gap-2.5 px-3 py-3" style={{ borderTop: `1px solid ${F.line}` }}>
                    {e.lines.map((l, j) => (
                      <p key={j} className="text-[13px] leading-[20px] whitespace-pre-line" style={{ color: F.body }}>
                        <Tokens text={l.text} vars={setup.variables} />
                      </p>
                    ))}
                  </div>
                  <div className="flex items-center gap-1.5 px-3 py-2 text-[12px]" style={{ borderTop: `1px solid ${F.line}`, color: F.muted }}>
                    <Clock className="size-3 shrink-0" strokeWidth={1.75} />
                    {e.when}
                  </div>
                </div>
              ))}
          </>
        )}
        {!setup && !setupError && <RowsSkeleton rows={3} />}
      </SetupSection>

      <SetupSection icon={Sparkles} title="Abilities" summary={setup ? `${setup.abilities.length} steps Charlie takes` : <Empty />} open={open === "abilities"} onToggle={() => toggle("abilities")}>
        {(setup?.abilities ?? []).map((ab) => (
          <SetupLine key={ab.id} label={ab.name}>
            <span className="max-w-[300px] truncate text-right" style={{ color: F.ink2 }} data-tip={ab.what}>{ab.what}</span>
            <Chip bg={F.chip} fg={F.ink2}>{ab.model}</Chip>
          </SetupLine>
        ))}
      </SetupSection>

      <SetupSection icon={Lock} title="Guardrails" summary="Always on" open={open === "guardrails"} onToggle={() => toggle("guardrails")}>
        <ul className="flex flex-col gap-1.5">
          {(setup?.guardrails ?? []).map((g) => (
            <li key={g} className="flex items-start gap-2 text-[13px]" style={{ color: F.ink2 }}>
              <CircleCheck className="mt-[3px] size-3 shrink-0" strokeWidth={2} style={{ color: TONE.green.dot }} />
              {g}
            </li>
          ))}
        </ul>
      </SetupSection>
    </SettingsCard>
  )
}

function ScheduleCard({ agent: a, busy, onSave }: { agent: Agent; busy: boolean; onSave: (b: { settings?: Partial<AgentSettings> }) => void }) {
  const [s, setS] = useState<AgentSettings>(a.settings)
  const dirty = JSON.stringify(s) !== JSON.stringify(a.settings)
  const num = (k: keyof AgentSettings, label: string, unit: string, min: number, max: number, info?: string) =>
    typeof s[k] === "number" ? (
      <Row key={k} label={label} {...(info ? { info } : {})}>
        <NumberBox label={label} value={s[k] as number} onChange={(v) => setS({ ...s, [k]: v })} min={min} max={max} unit={unit} />
      </Row>
    ) : null
  return (
    <SettingsCard title="Schedule" footer={<Lemon onClick={() => onSave({ settings: s })} disabled={!dirty || busy}>{busy ? "Saving" : "Save"}</Lemon>}>
      <Row label="How it runs">
        <span className="flex items-center gap-1.5 text-[13px]" style={{ color: F.ink2 }}>
          <Clock className="size-3" strokeWidth={1.75} />
          {a.cadence}
        </span>
      </Row>
      <Row label="Quiet hours" info="No emails go out between these hours, India time.">
        <NumberBox label="Quiet from" value={s.quiet_from} onChange={(v) => setS({ ...s, quiet_from: v })} min={0} max={23} />
        <span className="text-[12px]" style={{ color: F.muted }}>
          to
        </span>
        <NumberBox label="Quiet until" value={s.quiet_to} onChange={(v) => setS({ ...s, quiet_to: v })} min={0} max={23} unit=":00 IST" />
      </Row>
      {num("min_confidence", "Act only when this sure", "of 1", 0.5, 1, "Below this, the reply waits for you.")}
    </SettingsCard>
  )
}

function DraftCard({ d, busy, onApprove, onReject }: { d: Draft; busy: string | null; onApprove: () => void; onReject: () => void }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="flex flex-col gap-2 rounded-xl p-4" style={{ boxShadow: `inset 0 0 0 1px ${F.line}` }}>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px]" style={{ color: F.ink }}>
            {d.subject}
          </p>
          <p className="truncate text-[13px]" style={{ color: F.muted }}>
            To {d.name ?? d.email} · {d.mandate} · {d.reason}
          </p>
        </div>
        <Lemon onClick={onApprove} disabled={busy === `approve:${d.id}`}>
          <Check className="size-3" strokeWidth={2} />
          {busy === `approve:${d.id}` ? "Sending" : "Approve and send"}
        </Lemon>
        <button type="button" onClick={onReject} className={cn(GHOST, "h-8 shrink-0 gap-1 px-2.5 text-[13px]")}>
          <X className="size-3" strokeWidth={2} />
          Reject
        </button>
      </div>
      <button type="button" onClick={() => setOpen((o) => !o)} className="self-start text-[13px] leading-[20px]" style={{ color: F.link }}>
        {open ? "Hide the email" : "Read the email"}
      </button>
      {open && (
        <pre className="rounded-xl p-3 text-[13px] leading-[20px] whitespace-pre-wrap" style={{ background: TONE.blue.bg, color: F.body, fontFamily: "inherit" }}>
          {d.body_text}
        </pre>
      )}
    </div>
  )
}

/** The selected run's details, in the right-hand panel. */
function RunDetails({ agent: a, run, loading }: { agent: Agent; run: AgentRun | null; loading: boolean }) {
  const rows: [string, React.ReactNode][] = run
    ? [
        ["Agent", a.name],
        ["Status", <span key="s" className="label-mono flex items-center gap-1.5"><span className="size-1.5 squircle" style={{ background: STATUS[run.status].dot }} />{STATUS[run.status].label}</span>],
        ["Started by", run.trigger === "manual" ? "Run now" : "Its schedule"],
        ["Mode", MODE_WORDS[run.mode].label],
        ["Checked", `${run.counts.considered ?? 0} people`],
        ["Sent", String(run.counts.sent ?? 0)],
        ["Drafted", String(run.counts.drafted ?? 0)],
        ["Waiting", String(run.counts.waiting ?? 0)],
        ...(a.id === "outreach" ? ([["Submitted", String((run.counts as Record<string, number>).submitted ?? 0)]] as [string, React.ReactNode][]) : []),
        ["Failed", String(run.counts.failed ?? 0)],
        ["AI tokens", typeof run.counts.ai_calls === "number" ? `${tokenCount(runTokens(run.counts))} tokens · ${run.counts.ai_calls} ${run.counts.ai_calls === 1 ? "call" : "calls"}` : <Empty />],
      ]
    : []
  return (
    <aside className="scroll-quiet flex w-[300px] shrink-0 flex-col gap-5 overflow-y-auto px-6 pt-6" style={{ borderLeft: `1px solid ${F.line}` }}>
      <h3 className="text-[14px] font-medium">Run details</h3>
      {loading ? (
        <span className="flex flex-col gap-4" aria-hidden>
          <Bone className="h-4 w-32 rounded" />
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <span key={i} className="flex flex-col gap-1.5">
              <Bone className="h-2.5 w-16 rounded" />
              <Bone className="h-3 rounded" style={{ width: `${[60, 30, 45, 25, 35, 20][i]}%` }} />
            </span>
          ))}
        </span>
      ) : !run ? (
        <p className="text-[13px]" style={{ color: F.muted }}>
          No run selected.
        </p>
      ) : (
        <>
          <p className="text-[13px] font-medium">{at(run.started_at)}</p>
          {(run.note || run.error) && (
            <p className="text-[13px] leading-[20px]" style={{ color: run.error ? TONE.red.ink : F.ink2 }}>
              {run.error ?? run.note}
            </p>
          )}
          {/* compact rows: the label left, the value right, on hairlines */}
          <dl className="flex flex-col">
            {rows.map(([k, v]) => (
              <div key={k} className="flex h-8 items-center justify-between gap-3 text-[13px]" style={{ borderTop: `1px solid ${F.line}` }}>
                <dt style={{ color: F.muted }}>{k}</dt>
                <dd className="min-w-0 truncate text-right" style={{ color: F.body }}>{typeof v === "string" && isEmpty(v) ? <Empty /> : v}</dd>
              </div>
            ))}
          </dl>
        </>
      )}
    </aside>
  )
}

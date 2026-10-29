"use client"

// The workspace Inbox: every outreach and Qualify & Submit conversation, one thread per person, with the person's
// details, filters, and the Approve/Pass decisions an agent asks a person to make. Also exports the screen's palette
// (F) and shared button style (GHOST) that the Agents screen reuses.

import {
  ArrowUpDown,
  Briefcase,
  Check,
  ChevronDown,
  ChevronUp,
  Info,
  Plug,
  CircleCheck,
  CircleDashed,
  CircleSlash,
  Clock,
  CornerDownLeft,
  Download,
  FileText,
  Globe,
  GraduationCap,
  Layers,
  ListChecks,
  ListFilter,
  ListTodo,
  Mail,
  MapPin,
  Moon,
  Paperclip,
  Phone,
  RotateCcw,
  Search,
  Send,
  Tag,
  UserRound,
  X,
} from "lucide-react"
import { Fragment, useEffect, useMemo, useRef, useState } from "react"

import { LogoTile } from "@/components/shared/LogoTile"
import { AttachedDropdown, AttachedPanel, SQUIRCLE } from "@/components/shared/AttachedDropdown"
import { avatarTone, stageTone, tone } from "@/components/shared/tones"
import { useLink, useSecret } from "@/lib/api"
import {
  downloadAttachment,
  downloadCv,
  outreachAttachments,
  outreachMandates,
  outreachThreads,
  type CompanyFacts,
  type OutreachAttachment,
  type OutreachLifecycle,
  type OutreachThread,
} from "@/lib/outreach-api"
import {
  agentRuns,
  connectionCheck,
  connectionThreads,
  decideProposal,
  setThreadApproval,
  listAgents,
  listConnections,
  type Agent,
  type Connection,
  type ConnectionCheck,
  type CandidacyEvent,
  type QualifyThread,
  type RunItem,
} from "@/lib/agents-api"
import { cn } from "@/lib/utils"

/**
 * The outreach inbox: the record of every role's outreach emails, both ways, one thread per person, as the
 * server's outreach API returns them. Nobody replies from here. The threads are real and read on load. The one
 * thing a person does here is answer what an agent asked them ("Needs you": approve the close, or keep them); the
 * agent acts on it at its next run. A reply to the questions is "answered, needs review": nobody is shown
 * activated until a person has read it.
 */

// The workspace screens use the app's system font (--font-sans, set in app/globals.css); no font file is loaded.
export const SANS = "var(--font-sans)"

// The workspace's palette: every value is a token of Charlie's colour system (app/globals.css --c-*);
// a state's colour comes from its meaning (components/shared/tones.ts), never from here
export const F = {
  chrome: "var(--c-surface)",
  /** The primary action, lime with ink text. */
  lemon: "var(--c-brand)",
  lemonHover: "var(--c-brand-hover)",
  panel: "var(--c-surface)",
  white: "var(--c-surface)",
  line: "var(--c-line)",
  ink: "var(--c-text)",
  /** Body text: a step lighter than a title, so a heading reads above what it heads. */
  body: "var(--c-body)",
  ink2: "var(--c-text-2)",
  muted: "var(--c-muted)",
  // faint is never text (3.2:1): what was faint text now reads as supporting text
  faint: "var(--c-muted)",
  // what is selected or checked is the brand; teal is the link, and only the link
  accent: "var(--c-brand-ink)",
  link: "var(--c-link)",
  selLine: "var(--c-brand-line)",
  chip: "var(--c-neutral-container)",
  comment: "var(--c-neutral-container)",
  track: "var(--c-neutral-container)",
  rowOn: "var(--c-selected)",
  rowHover: "var(--c-hover)",
  pending: "var(--c-info-dot)",
  event: "var(--c-line)",
  noteBg: "var(--c-success-container)",
  noteLine: "var(--c-success-line)",
  green: "var(--c-success-dot)",
  avatar: "var(--c-neutral-ink)",
}

type Msg = {
  from: "charlie" | "candidate"
  at: string
  /** The instant, for the date dividers in the thread. */
  iso: string
  subject: string
  body: string
  /** Their emails only: the id their attachments are read by. */
  emailId?: string | null
}
type Note = { by: string; at: string; text: string }
type Job = { company: string; title: string; years: string; domain?: string | null }
/** Where the conversation stands, separate from whether the person is activated. */
type Conv =
  | "waiting"
  | "replied"
  | "idle"
  | "reopened"
  | "closed"
  | "roleSent"
  | "answered"
  | "partial"
  | "full"
/** Something that happened in the thread; `after` is the index of the email it follows. */
type Ev = {
  after: number
  kind:
    | "idle"
    | "reopened"
    | "activated"
    | "closed"
    | "roleSent"
    | "hold"
    | "answered"
    | "partial"
    | "full"
  at: string
  /** the moment itself, for the time under the thread's day divider */
  iso?: string
  text: string
}
type Thread = {
  id: string
  name: string
  email: string
  phone: string
  linkedin: string
  location: string
  title: string
  company: string
  totalExp: string
  currentCtc: string
  expectedCtc: string
  notice: string
  preferredLocation: string
  workMode: string
  previous: Job[]
  skills: string[]
  education: string
  role: string
  roleCompany: string
  /** Where the person's record comes from, e.g. "Pool #1652". */
  sourceLabel: string
  /** A CV is on file: its extracted text (the original file was not kept). */
  hasCv: boolean
  /** The current employer's facts, where enrichment has filled them; null when nothing is known. */
  companyFacts: CompanyFacts | null
  referredBy: string | null
  referrerAt: string | null
  referredOn: string | null
  /** Where the person stands, from the live thread: active, idle or inactive, as the server reports it. */
  activity: Activity
  activated: boolean
  unread: boolean
  lastAt: string
  sortKey: number
  /** Every state the conversation is in at once, e.g. re-opened and a full answer. */
  statuses: Conv[]
  /** The questions in the role-details email, and how many the person answered. */
  asked: number
  answered: number
  events: Ev[]
  messages: Msg[]
  notes: Note[]
  /** Where the person stands in the candidate lifecycle: stage, what Charlie waits for, the next action. */
  lifecycle: OutreachLifecycle | null
  /** A Qualify & Submit conversation (the agent runs it end to end); absent on an outreach thread. */
  qualify?: QualifyThread
}

type Activity = "active" | "idle" | "inactive"

/** Shown where the record does not say. Nothing is filled in for a person. */
const NG = "Not given"

const dateFmt = new Intl.DateTimeFormat("en-IN", { month: "short", day: "numeric" })
const timeFmt = new Intl.DateTimeFormat("en-IN", {
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
})
const dayDiff = (iso: string) => {
  const d = new Date(iso),
    t = new Date()
  return Math.round(
    (Date.UTC(t.getFullYear(), t.getMonth(), t.getDate()) -
      Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())) /
      86_400_000,
  )
}
const clock = (iso: string) => timeFmt.format(new Date(iso)).toUpperCase()
/** "Today, 9:42 AM", "Yesterday, 4:12 PM", "Sep 24, 10:05 AM". */
const fmtAt = (iso: string) => {
  const n = dayDiff(iso)
  return `${n === 0 ? "Today" : n === 1 ? "Yesterday" : dateFmt.format(new Date(iso))}, ${clock(iso)}`
}
/** The list's short form: "9:42 AM", "Yesterday", "Sep 24". */
const fmtShort = (iso: string) => {
  const n = dayDiff(iso)
  return n === 0 ? clock(iso) : n === 1 ? "Yesterday" : dateFmt.format(new Date(iso))
}
/** The list's relative form: "now", "4m", "3h", "2d", then the date. */
const rel = (ms: number) => {
  const m = Math.max(0, Math.round((Date.now() - ms) / 60_000))
  if (m < 1) return "now"
  if (m < 60) return `${m}m`
  if (m < 24 * 60) return `${Math.round(m / 60)}h`
  if (m < 7 * 24 * 60) return `${Math.round(m / (24 * 60))}d`
  return dateFmt.format(new Date(ms))
}
/** Pay is a plain annual number; rupees read in lakhs. An unknown currency is shown as the number. */
const money = (v: number | null, cur: string | null) => {
  if (v == null) return NG
  if (cur === "INR") return `₹${Number((v / 100_000).toFixed(1))} L`
  return cur ? `${v.toLocaleString("en-IN")} ${cur}` : v.toLocaleString("en-IN")
}
/** The product never shows an em or en dash; a record's own text is joined with a comma instead. */
const noDash = (v: string) => v.replace(/\s*[\u2014\u2013]\s*/g, ", ")

function toThread(o: OutreachThread): Thread {
  const p = o.person
  const previous: Job[] = []
  if (p.company || p.title)
    previous.push({
      company: p.company ?? NG,
      title: p.title ?? "",
      years: "",
      domain: p.companyInfo?.domain ?? null,
    })
  if (p.previousCompany || p.previousTitle)
    previous.push({
      company: p.previousCompany ?? NG,
      title: p.previousTitle ?? "",
      years: "",
      domain: p.previousCompanyInfo?.domain ?? null,
    })
  return {
    id: o.id,
    name: p.name,
    email: p.email,
    phone: p.phone ?? NG,
    linkedin: p.linkedin ?? NG,
    location: p.city ?? NG,
    title: p.title ?? NG,
    company: p.company ?? NG,
    totalExp: p.totalYears == null ? NG : `${p.totalYears} yrs`,
    currentCtc: money(p.compCurrent, p.compCurrency),
    expectedCtc: money(p.compExpected, p.compCurrency),
    notice:
      p.noticeDays != null
        ? p.noticeDays === 0
          ? "Immediate (0 days)"
          : `${p.noticeDays} days`
        : (p.noticeRaw ?? NG),
    preferredLocation: p.relocate ? noDash(p.relocate) : NG,
    workMode: p.workMode ?? NG,
    previous,
    skills: p.skills,
    education: [p.degree, p.institution, p.gradYear].filter(Boolean).join(", ") || NG,
    role: o.role,
    roleCompany: "Not named in the emails",
    sourceLabel: p.poolId != null ? `Pool #${p.poolId}` : "Charlie pool",
    hasCv: p.hasCv,
    // shown only when enrichment has said something beyond the name
    companyFacts:
      p.companyInfo &&
      (p.companyInfo.domain ||
        p.companyInfo.industry ||
        p.companyInfo.description ||
        p.companyInfo.headcount != null)
        ? p.companyInfo
        : null,
    referredBy: null,
    referrerAt: null,
    referredOn: null,
    activity: o.activity,
    // avatars stay two-tone: green for active, grey for idle and inactive
    activated: o.activity === "active",
    unread: o.awaitingUs,
    lastAt: fmtShort(o.lastAt),
    sortKey: Date.parse(o.lastAt),
    statuses: o.statuses,
    asked: 0,
    answered: 0,
    events: o.events.map((e) => ({ ...e, at: fmtAt(e.at), iso: e.at })),
    messages: o.messages.map((m) => ({
      from: m.from,
      at: fmtAt(m.at),
      iso: m.at,
      subject: m.subject,
      body: m.body ?? "The words of this email were not recorded.",
      emailId: m.emailId ?? null,
    })),
    notes: [],
    // the server's fixed system stage is what everyone reads; the detailed step is kept alongside it
    lifecycle: o.lifecycle
      ? o.lifecycle.system_stage
        ? { ...o.lifecycle, ...(o.lifecycle.stage ? { step: o.lifecycle.stage } : {}), stage: o.lifecycle.close_group ? `${o.lifecycle.system_stage} · ${o.lifecycle.close_group}` : o.lifecycle.system_stage }
        : o.lifecycle
      : null,
  }
}

/** Who the agent is waiting for, as the lifecycle's owner and in words. */
const Q_OWNER: Record<string, { owner: OutreachLifecycle["owner"]; words: string }> = {
  them: { owner: "candidate", words: "Their reply" },
  "their YES": { owner: "candidate", words: "Their YES to the details" },
  charlie: { owner: "charlie", words: "Charlie, on the next run" },
  pieworks: { owner: "employer", words: "Pieworks" },
  employer: { owner: "employer", words: "The employer" },
  you: { owner: "operator", words: "You" },
}

/**
 * A Qualify & Submit conversation as an Inbox thread. The stage, who it waits for and what is next come from the
 * agent's own row; the timeline is what the row holds: the questions it asked, their answers and kept replies,
 * each in their own words. Nothing is filled in for a person.
 */
function fromQualify(v: QualifyThread, via: string): Thread {
  const role = v.role ?? "A role"
  const subject = `${role}${v.company ? ` at ${v.company}` : ""}`
  const messages: Msg[] = []
  const sent = v.verify_sent_at ?? v.created_at
  // one "Asked" per round: the first round went when the conversation opened, the latest at verify_sent_at; an
  // answer whose reply time the row no longer holds says so instead of borrowing a date
  const rounds = Array.from(new Set(v.questions.map((q) => q.round))).sort((a, b) => a - b)
  const latest = rounds[rounds.length - 1]
  for (const r of rounds) {
    const at = r === latest ? sent : (v.created_at ?? sent)
    if (!at) continue
    const qs = v.questions.filter((q) => q.round === r)
    messages.push({ from: "charlie", at: fmtAt(at), iso: at, subject, emailId: null, body: `Asked:\n${qs.map((q, i) => `${i + 1}. ${q.text}`).join("\n")}` })
  }
  const answered = v.questions.filter((q) => q.answer)
  const answerAt = v.replied_at ?? v.created_at
  if (answerAt && answered.length)
    messages.push({ from: "candidate", at: v.replied_at ? fmtAt(v.replied_at) : "Date not kept", iso: v.replied_at ?? new Date(Date.parse(answerAt) + 1).toISOString(), subject, emailId: null, body: answered.map((q) => q.answer).join("\n") })
  for (const k of v.kept)
    if (k.at && k.words) messages.push({ from: "candidate", at: fmtAt(k.at), iso: k.at, subject, emailId: null, body: k.words })
  messages.sort((a, b) => Date.parse(a.iso) - Date.parse(b.iso))
  if (!messages.length && sent) messages.push({ from: "charlie", at: fmtAt(sent), iso: sent, subject, emailId: null, body: v.label })
  const last = v.updated_at ?? v.replied_at ?? sent ?? new Date(0).toISOString()
  const w = v.waitingFor ? Q_OWNER[v.waitingFor] : undefined
  const done = v.stage === "submitted" || v.stage === "closed"
  return {
    id: `q:${v.id}`,
    name: v.name ?? v.email ?? "Unknown",
    email: v.email ?? "",
    phone: NG,
    linkedin: NG,
    location: NG,
    title: NG,
    company: NG,
    totalExp: NG,
    currentCtc: NG,
    expectedCtc: NG,
    notice: NG,
    preferredLocation: NG,
    workMode: NG,
    previous: [],
    skills: [],
    education: NG,
    role,
    roleCompany: v.company ?? NG,
    sourceLabel: `Qualify & Submit · ${via}`,
    hasCv: false,
    companyFacts: null,
    referredBy: null,
    referrerAt: null,
    referredOn: null,
    activity: done ? "inactive" : w?.owner === "candidate" ? "active" : "idle",
    activated: false,
    unread: v.needs_you ?? (v.waitingFor === "you" || v.kept.some((k) => k.unread)),
    lastAt: fmtShort(last),
    sortKey: Date.parse(last),
    statuses: [],
    asked: v.questions.length,
    answered: answered.length,
    events: [],
    messages,
    notes: [],
    // a closed or failed conversation has no next step: its reason is shown in the details, never as "Next"
    // the server's fixed system stage is what everyone reads; a closed one says why
    lifecycle: { stage: v.system_stage ? (v.close_group ? `${v.system_stage} · ${v.close_group}` : v.system_stage) : v.label, nextAction: done || v.stage === "failed" ? "" : (v.next ?? ""), owner: w?.owner ?? null, waitingFor: w?.words ?? null, dueAt: v.nextAt, saved: true },
    qualify: v,
  }
}

/** The choices the role menu and the filter panel offer, from the threads actually loaded. */
type Opts = { roles: string[]; referrers: string[]; locations: string[]; workModes: string[] }
const uniq = (xs: (string | null)[]) =>
  Array.from(new Set(xs.filter((x): x is string => !!x && x !== NG))).sort()


/** Every filter the panel offers; "" or "any" means the filter is off. */
type Owner = "operator" | "candidate" | "charlie" | "employer"
type Filters = {
  owner: "any" | Owner
  activation: "any" | Activity
  status: "any" | Conv
  referrer: string
  location: string
  workMode: string
  notice: "any" | "30" | "60" | "over60"
  exp: "any" | "0-3" | "3-6" | "6+"
  skill: string
  hasNotes: boolean
  hasReply: boolean
}
const NO_FILTERS: Filters = {
  owner: "any",
  activation: "any",
  status: "any",
  referrer: "",
  location: "",
  workMode: "",
  notice: "any",
  exp: "any",
  skill: "",
  hasNotes: false,
  hasReply: false,
}
const num = (s: string) => Number(s.match(/[0-9.]+/)?.[0] ?? NaN)
const noticeDays = (s: string) => num(s) * (/week/i.test(s) ? 7 : 1)

function matches(t: Thread, f: Filters) {
  const days = noticeDays(t.notice)
  const yrs = num(t.totalExp)
  return (
    (f.owner === "any" || f.owner === t.lifecycle?.owner) &&
    (f.activation === "any" || f.activation === t.activity) &&
    (f.status === "any" || t.statuses.includes(f.status)) &&
    (!f.referrer || f.referrer === t.referredBy) &&
    (!f.location || f.location === t.location) &&
    (!f.workMode || f.workMode === t.workMode) &&
    (f.notice === "any" ||
      (f.notice === "30" ? days <= 30 : f.notice === "60" ? days <= 60 : days > 60)) &&
    (f.exp === "any" ||
      (f.exp === "0-3" ? yrs < 3 : f.exp === "3-6" ? yrs >= 3 && yrs <= 6 : yrs > 6)) &&
    (!f.skill.trim() ||
      t.skills.some((k) => k.toLowerCase().includes(f.skill.trim().toLowerCase()))) &&
    (!f.hasNotes || t.notes.length > 0) &&
    (!f.hasReply || t.messages.some((m) => m.from === "candidate"))
  )
}

/** The active filters as removable chips: [label, the change that clears it]. */
function activeFilters(f: Filters): [string, Partial<Filters>][] {
  const out: [string, Partial<Filters>][] = []
  if (f.owner !== "any") out.push([`Waiting on: ${OWNER[f.owner]}`, { owner: "any" }])
  if (f.activation !== "any") out.push([ACT[f.activation].label, { activation: "any" }])
  if (f.status !== "any") out.push([`Status: ${CONV[f.status].label}`, { status: "any" }])
  if (f.referrer) out.push([`Referred by ${f.referrer}`, { referrer: "" }])
  if (f.location) out.push([f.location, { location: "" }])
  if (f.workMode) out.push([f.workMode, { workMode: "" }])
  if (f.notice !== "any") out.push([NOTICE[f.notice], { notice: "any" }])
  if (f.exp !== "any") out.push([EXP[f.exp], { exp: "any" }])
  if (f.skill.trim()) out.push([`Skill: ${f.skill.trim()}`, { skill: "" }])
  if (f.hasNotes) out.push(["Has notes", { hasNotes: false }])
  if (f.hasReply) out.push(["Has replied", { hasReply: false }])
  return out
}
const OWNER: Record<Owner, string> = {
  operator: "A person here",
  candidate: "The candidate",
  charlie: "Charlie",
  employer: "The employer",
}
const NOTICE: Record<Filters["notice"], string> = {
  any: "Any notice",
  "30": "Notice up to 30 days",
  "60": "Notice up to 60 days",
  over60: "Notice over 60 days",
}
const EXP: Record<Filters["exp"], string> = {
  any: "Any experience",
  "0-3": "Under 3 yrs",
  "3-6": "3 to 6 yrs",
  "6+": "Over 6 yrs",
}

/** The conversation states: one label, one icon, one colour each. */
const CONV: Record<
  Conv,
  {
    label: string
    Icon: React.ComponentType<{
      className?: string
      strokeWidth?: number
      style?: React.CSSProperties
    }>
    color: string
  }
> = {
  waiting: { label: "Waiting", Icon: CircleDashed, color: F.muted },
  replied: { label: "Replied", Icon: CornerDownLeft, color: F.green },
  idle: { label: "Idle", Icon: Moon, color: F.muted },
  reopened: { label: "Re-opened", Icon: RotateCcw, color: tone("info").ink },
  closed: { label: "Closed", Icon: CircleSlash, color: F.muted },
  roleSent: { label: "Role details sent", Icon: Send, color: tone("info").ink },
  answered: { label: "Answered, needs review", Icon: ListTodo, color: tone("attention").ink },
  partial: { label: "Partial answer", Icon: ListTodo, color: tone("warning").ink },
  full: { label: "Full answer", Icon: ListChecks, color: F.green },
}
const EVENT_ICON: Record<Ev["kind"], { Icon: (typeof CONV)[Conv]["Icon"]; color: string }> = {
  idle: { Icon: Moon, color: F.muted },
  reopened: { Icon: RotateCcw, color: tone("info").ink },
  activated: { Icon: CircleCheck, color: F.green },
  closed: { Icon: CircleSlash, color: F.muted },
  roleSent: { Icon: Send, color: tone("info").ink },
  hold: { Icon: Clock, color: F.muted },
  answered: { Icon: ListTodo, color: tone("attention").ink },
  partial: { Icon: ListTodo, color: tone("warning").ink },
  full: { Icon: ListChecks, color: F.green },
}
type Sort = "newest" | "oldest"

/** The three activity states: one label, one icon, one colour each. */
const ACT: Record<Activity, { label: string; Icon: (typeof CONV)[Conv]["Icon"]; color: string; bg: string; fg: string; outlined?: boolean }> = {
  active: { label: "Active", Icon: CircleCheck, color: tone("success").dot, bg: tone("success").bg, fg: tone("success").fg },
  idle: { label: "Idle", Icon: Moon, color: tone("neutral").dot, bg: tone("neutral").bg, fg: tone("neutral").fg },
  inactive: { label: "Inactive", Icon: CircleDashed, color: tone("neutral").dot, bg: "var(--c-surface)", fg: tone("neutral").ink, outlined: true },
}

export function Inbox() {
  const [query, setQuery] = useState("")
  const [filters, setFilters] = useState<Filters>(NO_FILTERS)
  const [sort, setSort] = useState<Sort>("newest")
  const [role, setRole] = useState<string | null>(null)
  const [selected, setSelected] = useState<string>("")
  const secret = useSecret()
  const [threads, setThreads] = useState<Thread[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [wouldDo, setWouldDo] = useState<{ at: string | null; items: RunItem[] } | null>(null)
  const [agentError, setAgentError] = useState<string | null>(null)

  const loaded = useRef(false)
  // Live: read on load and again every 30 seconds, so a send or a reply appears without a reload.
  // A failed refresh keeps what is on screen and says so only when nothing has loaded yet.
  useEffect(() => {
    let live = true
    const load = async () => {
      try {
        const { mandates } = await outreachMandates(secret)
        const all = await Promise.all(mandates.map((m) => outreachThreads(secret, m.key)))
        // the Qualify & Submit agent's conversations, from every connection that is on; a failure here never
        // hides the outreach threads, it is said once in the list
        let agentThreads: Thread[] = []
        try {
          const { connections } = await listConnections(secret)
          const on = connections.filter((c) => c.mode !== "off")
          const got = await Promise.all(on.map((c) => connectionThreads(secret, c.key)))
          agentThreads = got.flatMap((d) => d.threads.map((v) => fromQualify(v, d.connection.name)))
          const shadow = on.some((c) => c.mode === "shadow")
          const runs = shadow ? (await agentRuns(secret, "outreach")).runs : []
          // the full pass (twice a day) is the run that judges people; the 15-minute runs in between have nothing
          // to say, so show the latest run that did
          const pass = runs.find((r) => r.items.some((i) => i.result === "shadow" || i.result === "not written to")) ?? runs[0]
          if (live) {
            setWouldDo(shadow ? { at: pass?.started_at ?? null, items: (pass?.items ?? []).filter((i) => i.result === "shadow" || i.result === "not written to") } : null)
            setAgentError(null)
          }
        } catch (e) {
          if (live) {
            setAgentError(e instanceof Error ? e.message : String(e))
            setWouldDo(null)
          }
        }
        if (!live) return
        const ts = [...all.flatMap((d) => d.threads.map(toThread)), ...agentThreads].sort((a, b) => b.sortKey - a.sortKey)
        setThreads(ts)
        loaded.current = true
        setError(null)
        setSelected((cur) => cur || ts[0]?.id || "")
      } catch (e) {
        if (live && !loaded.current) setError(e instanceof Error ? e.message : String(e))
      }
    }
    void load()
    const t = setInterval(() => void load(), 30_000)
    return () => {
      live = false
      clearInterval(t)
    }
  }, [secret])

  const all = useMemo(() => threads ?? [], [threads])
  const opts: Opts = useMemo(
    () => ({
      roles: uniq(all.map((t) => t.role)),
      referrers: uniq(all.map((t) => t.referredBy)),
      locations: uniq(all.map((t) => t.location)),
      workModes: uniq(all.map((t) => t.workMode)),
    }),
    [all],
  )

  const rows = useMemo(() => {
    const r = all.filter(
      (t) =>
        searchHit(t, query) &&
        matches(t, filters) &&
        (!role || t.role === role),
    )
    return r.sort((a, b) => (sort === "newest" ? b.sortKey - a.sortKey : a.sortKey - b.sortKey))
  }, [all, query, filters, role, sort])

  // every role with how many people it has, for the roles panel
  const roleCounts = useMemo(
    () => opts.roles.map((r) => ({ name: r, count: all.filter((t) => t.role === r).length })),
    [opts.roles, all],
  )
  const thread = all.find((t) => t.id === selected) ?? null
  // up and down in the centre column move through the list as it is shown (filters and sort applied)
  const at = rows.findIndex((t) => t.id === selected)
  const prevId = at > 0 ? rows[at - 1]?.id : undefined
  const nextId = at < 0 ? rows[0]?.id : rows[at + 1]?.id
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === "j" && nextId) setSelected(nextId)
      if (e.key === "k" && prevId) setSelected(prevId)
    }
    document.addEventListener("keydown", key)
    return () => document.removeEventListener("keydown", key)
  }, [nextId, prevId])

  return (
    <div
      // every element on this screen, controls included, uses the same family, smoothed
      className="flex min-h-0 flex-1 flex-col antialiased"
      style={
        {
          background: F.chrome,
          color: F.ink,
          fontFamily: SANS,
          WebkitFontSmoothing: "antialiased",
          MozOsxFontSmoothing: "grayscale",
          textRendering: "optimizeLegibility",
          fontFeatureSettings: '"kern" 1',
        } as React.CSSProperties
      }
    >
      <TopBar role={role} onRole={setRole} roles={roleCounts} />
      <div
        className="flex min-h-0 flex-1 overflow-hidden"
        style={{ background: F.panel, borderTop: `1px solid ${F.line}` }}
      >
        <ThreadList
          rows={rows}
          selected={selected}
          onSelect={setSelected}
          query={query}
          onQuery={setQuery}
          loading={!threads && !error}
          filters={filters}
          onFilters={setFilters}
          sort={sort}
          onSort={setSort}
          opts={opts}
          wouldDo={wouldDo}
          agentError={agentError}
        />
        {error ? (
          <div
            className="flex flex-1 items-center justify-center text-[13px]"
            style={{ color: "var(--c-error-ink)" }}
          >
            {error}
          </div>
        ) : !threads ? (
          <>
            <ThreadSkeleton />
            <DetailsSkeleton />
          </>
        ) : thread ? (
          <>
            <ThreadView
              thread={thread}
              onPrev={prevId ? () => setSelected(prevId) : undefined}
              onNext={nextId ? () => setSelected(nextId) : undefined}
            />
            <Details
              thread={thread}
              others={all.filter((o) => o.email === thread.email && o.id !== thread.id)}
              onSelect={setSelected}
            />
          </>
        ) : (
          <div
            className="flex flex-1 items-center justify-center text-[13px]"
            style={{ color: F.faint }}
          >
            No conversation selected
          </div>
        )}
      </div>
    </div>
  )
}

/* ---------- top bar: Inbox and the roles panel; Connect and the agents ---------- */

/** The external tools a workspace connects. A tool with no connection on the server says "Coming soon". */
const TOOLS = [
  { name: "Pieworks", domain: "pieworks.in", what: "Referrals and their roles" },
]

/** One agent's state in the top bar, from the agents API: on, its mode, or not built yet. */
function agentState(a: Agent): { label: string; color: string } {
  if (!a.built) return { label: "Being built", color: tone("neutral").dot }
  if (!a.enabled || a.mode === "off") return { label: "Off", color: tone("neutral").dot }
  const s = a.last_run?.status
  if (s === "failed") return { label: "Failed", color: tone("error").dot }
  if (s === "needs_review" || a.pending > 0) return { label: `${a.pending || ""} to review`.trim(), color: tone("warning").dot }
  return { label: a.mode === "auto" ? "On, auto" : "On, draft", color: F.green }
}

function ToolCard({ name, domain, what, action, onOpen }: { name: string; domain: string; what: string; action: React.ReactNode; onOpen?: (() => void) | undefined }) {
  const Box = onOpen ? "button" : "div"
  return (
    // compact and borderless, one under the other, in the same attached panel; a tool that is connected opens its
    // details
    <Box
      {...(onOpen ? { type: "button" as const, onClick: onOpen } : {})}
      className={cn("flex w-full items-center gap-2.5 px-2 py-1.5 text-left hover:bg-[var(--c-hover)]", SQUIRCLE)}
    >
      <LogoTile name={name} domain={domain} size={10} className="shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] leading-[20px]" style={{ color: F.ink }}>
          {name}
        </p>
        <p className="truncate text-[12px]" style={{ color: F.muted }}>
          {what}
        </p>
      </div>
      {action}
    </Box>
  )
}

/** A connected tool's real state: its mode, with a dot from the live check (green working, red not, grey checking). */
function ConnChip({ c, check }: { c: Connection; check: ConnectionCheck | null }) {
  const dot = !check ? tone("neutral").dot : check.ok ? tone("success").dot : tone("error").dot
  const t = tone(c.mode === "live" ? "success" : c.mode === "shadow" ? "info" : "neutral")
  return (
    <span className="label-mono flex shrink-0 items-center gap-1.5 rounded-full px-2" style={{ background: t.bg, color: t.fg }}>
      <span className="size-1.5 squircle" style={{ background: dot }} />
      {c.mode === "live" ? "Live" : c.mode === "shadow" ? "Shadow" : "Off"}
    </span>
  )
}

/** A connected tool's details: whether it works (read live), its mode, what it has taken in, where its settings are. */
function ConnectionModal({ c, check, checking, onCheck, onClose }: { c: Connection; check: ConnectionCheck | null; checking: boolean; onCheck: () => void; onClose: () => void }) {
  const agentsHref = useLink()("/workspace/agents")
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose()
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [onClose])
  const stages = Object.entries(c.threads).filter(([, n]) => (n ?? 0) > 0)
  const status = checking || !check ? "Checking" : check.ok ? `Connected · ${check.total ?? "?"} active ${check.total === 1 ? "role" : "roles"}` : `Not connected · ${check.error ?? "no answer"}`
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/25 p-6" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal aria-label={c.name} className="flex w-[440px] max-w-full flex-col overflow-hidden rounded-[12px] bg-white shadow-[0_0_0_1px_var(--c-line),0_24px_64px_rgba(0,0,0,0.16)]">
        <div className="flex items-center gap-2.5 px-4 pt-4 pb-3" style={{ borderBottom: `1px solid ${F.line}` }}>
          <LogoTile name={c.name} domain={TOOLS.find((t) => t.name === c.name)?.domain ?? ""} size={10} className="shrink-0" />
          <h2 className="min-w-0 flex-1 truncate text-[14px] font-medium">{c.name}</h2>
          <ConnChip c={c} check={checking ? null : check} />
          <button type="button" aria-label="Close" onClick={onClose} className={cn(GHOST, "size-7 justify-center")}>
            <X className="size-4" strokeWidth={1.5} />
          </button>
        </div>
        <div className="flex flex-col px-4 py-1">
          <KV k="Connection" v={<span data-tip={check?.error ?? undefined}>{status}</span>} />
          <KV k="Mode" v={c.mode === "live" ? "Live: sends and submits" : c.mode === "shadow" ? "Shadow: judges, sends and submits nothing" : "Off"} />
          <KV k="Roles taken" v={`${c.roles.briefed} of ${c.roles.total}`} />
          <KV k="Conversations" v={stages.length ? stages.map(([k, n]) => `${n} ${k.replace("_", " ")}`).join(", ") : "None yet"} />
          {check?.ok && check.sample && <KV k="First role" v={`${check.sample.role}, ${check.sample.client}`} />}
          {check?.at && <KV k="Checked" v={fmtAt(check.at)} />}
        </div>
        <div className="flex items-center justify-end gap-2 px-4 py-3" style={{ borderTop: `1px solid ${F.line}` }}>
          <button type="button" onClick={onCheck} disabled={checking} className={cn(GHOST, "h-7 px-2.5 text-[13px] disabled:opacity-50")} style={{ boxShadow: `inset 0 0 0 1px ${F.line}` }}>
            Check again
          </button>
          {agentsHref && (
            <a href={agentsHref} data-link="block" className={cn("flex h-7 items-center px-2.5 text-[13px] leading-[20px] hover:bg-[var(--c-brand-hover)]", SQUIRCLE)} style={{ background: F.lemon, color: F.ink }}>
              Open settings
            </a>
          )}
        </div>
      </div>
    </div>
  )
}

/** Not built yet: said plainly, never a button that pretends. */
function Soon() {
  return (
    <span
      className="label-mono self-start rounded-full px-2"
      style={{ background: F.chip, color: F.ink2 }}
    >
      Coming soon
    </span>
  )
}

function TopBar({
  role,
  onRole,
  roles,
}: {
  role: string | null
  onRole: (r: string | null) => void
  roles: { name: string; count: number }[]
}) {
  const [rolesOpen, setRolesOpen] = useState(false)
  const [connectOpen, setConnectOpen] = useState(false)
  const [agentsOpen, setAgentsOpen] = useState(false)
  const secret = useSecret()
  const [agents, setAgents] = useState<Agent[]>([])
  const [conns, setConns] = useState<Connection[]>([])
  // a connected tool's live check: read when the Connect panel or the roles panel opens, and on "Check again"
  const [checks, setChecks] = useState<Record<string, ConnectionCheck>>({})
  const [checking, setChecking] = useState<Record<string, boolean>>({})
  const [openConn, setOpenConn] = useState<string | null>(null)
  const runCheck = (key: string) => {
    setChecking((m) => ({ ...m, [key]: true }))
    connectionCheck(secret, key)
      .then((r) => setChecks((m) => ({ ...m, [key]: r })))
      .catch((e) => setChecks((m) => ({ ...m, [key]: { ok: false, at: new Date().toISOString(), error: e instanceof Error ? e.message : String(e) } })))
      .finally(() => setChecking((m) => ({ ...m, [key]: false })))
  }
  const connOf = (toolName: string) => conns.find((c) => c.name.toLowerCase() === toolName.toLowerCase()) ?? null
  const toolAction = (toolName: string) => {
    const c = connOf(toolName)
    return c ? <ConnChip c={c} check={checking[c.key] ? null : (checks[c.key] ?? null)} /> : <Soon />
  }
  const checkAll = (open: boolean) => {
    if (open) for (const c of conns) if (!checks[c.key] && !checking[c.key]) runCheck(c.key)
  }
  // the agents and their employer connections, live: read on load and every 30 seconds; a failed read keeps
  // what is shown
  useEffect(() => {
    let live = true
    const read = () => {
      void listAgents(secret).then((d) => live && setAgents(d.agents)).catch(() => {})
      void listConnections(secret).then((d) => live && setConns(d.connections)).catch(() => {})
    }
    void read()
    const t = setInterval(read, 30_000)
    return () => {
      live = false
      clearInterval(t)
    }
  }, [secret])
  const [q, setQ] = useState("")
  const total = roles.reduce((a, r) => a + r.count, 0)
  const shown = roles.filter((r) => r.name.toLowerCase().includes(q.trim().toLowerCase()))
  const pick = (r: string | null) => {
    onRole(r)
    setRolesOpen(false)
    setQ("")
  }
  return (
    <header className="flex h-12 shrink-0 items-center gap-2 px-4">
      <h1 className="text-[15px] leading-[24px]">Inbox</h1>
      <div className="ml-2">
        <AttachedPanel
          ariaLabel="Filter by role"
          open={rolesOpen}
          onOpenChange={(o) => {
            setRolesOpen(o)
            checkAll(o)
          }}
          width={560}
          icon={<Briefcase className="size-3 shrink-0" strokeWidth={1.5} style={{ color: F.muted }} />}
          label={<span className="max-w-[220px] truncate">{role ?? "All roles"}</span>}
        >
          <div className="flex flex-col gap-3 p-3">
            <label
              className="flex h-8 items-center gap-2 rounded-lg px-2.5 text-[13px]"
              style={{ background: F.white, boxShadow: `inset 0 0 0 1px ${F.line}` }}
            >
              <Search className="size-3 shrink-0" strokeWidth={1.75} style={{ color: F.muted }} />
              <input
                autoFocus
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search roles"
                aria-label="Search roles"
                className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-[var(--c-muted)]"
                style={{ color: F.ink }}
              />
            </label>
            {/* a list, not cards: it has to hold hundreds of roles */}
            <div className="scroll-quiet flex max-h-[320px] flex-col overflow-y-auto">
              {!q.trim() && (
                <RoleCard name="All roles" count={total} on={!role} onPick={() => pick(null)} />
              )}
              {shown.map((r) => (
                <RoleCard key={r.name} name={r.name} count={r.count} on={role === r.name} onPick={() => pick(r.name)} />
              ))}
              {shown.length === 0 && (
                <p className="px-1 py-2 text-[13px]" style={{ color: F.muted }}>
                  No role matches
                </p>
              )}
            </div>
            <div className="flex flex-col gap-2 pt-1" style={{ borderTop: `1px solid ${F.line}` }}>
              <p className="pt-2 text-[12px]" style={{ color: F.muted }}>
                Import roles from
              </p>
              <div className="flex flex-col gap-0.5">
                {TOOLS.map((t) => {
                  const c = connOf(t.name)
                  return (
                    <ToolCard key={t.name} name={t.name} domain={t.domain} what={c ? `${c.roles.briefed} of ${c.roles.total} roles taken` : "Connect it first"} action={toolAction(t.name)} onOpen={c ? () => setOpenConn(c.key) : undefined} />
                  )
                })}
              </div>
            </div>
          </div>
        </AttachedPanel>
      </div>

      <div className="ml-auto flex items-center gap-2">
        <AttachedPanel
          ariaLabel="Connect external tools"
          open={connectOpen}
          onOpenChange={(o) => {
            setConnectOpen(o)
            checkAll(o)
          }}
          align="right"
          width={360}
          icon={<Plug className="size-3 shrink-0" strokeWidth={1.75} style={{ color: F.muted }} />}
          label="Connect"
        >
          <div className="flex flex-col gap-3 p-3">
            <p className="px-1 text-[13px]" style={{ color: F.ink2 }}>
              Bring roles and candidates in from the tools you already use.
            </p>
            <div className="flex flex-col gap-0.5">
              {TOOLS.map((t) => {
                const c = connOf(t.name)
                return (
                  <ToolCard key={t.name} name={t.name} domain={t.domain} what={t.what} action={toolAction(t.name)} onOpen={c ? () => setOpenConn(c.key) : undefined} />
                )
              })}
            </div>
          </div>
        </AttachedPanel>
        <AgentsButton agents={agents} conns={conns} open={agentsOpen} onOpenChange={setAgentsOpen} />
      </div>
      {openConn && conns.find((c) => c.key === openConn) && (
        <ConnectionModal
          c={conns.find((c) => c.key === openConn)!}
          check={checks[openConn] ?? null}
          checking={Boolean(checking[openConn])}
          onCheck={() => runCheck(openConn)}
          onClose={() => setOpenConn(null)}
        />
      )}
    </header>
  )
}

function RoleCard({ name, count, on, onPick }: { name: string; count: number; on: boolean; onPick: () => void }) {
  return (
    <button
      type="button"
      onClick={onPick}
      className={cn("flex h-9 shrink-0 items-center gap-3 px-2.5 text-left hover:bg-[var(--c-hover)]", SQUIRCLE)}
      style={on ? { background: F.rowOn } : undefined}
    >
      <span className="min-w-0 flex-1 truncate text-[13px] leading-[20px]" style={{ color: F.ink }}>
        {name}
      </span>
      <span className="shrink-0 text-[13px] tabular-nums" style={{ color: F.muted }}>
        {count} {count === 1 ? "person" : "people"}
      </span>
      <span className="flex w-3.5 shrink-0 justify-center">
        {on && <Check className="size-3" style={{ color: F.accent /* brand ink: selected */ }} />}
      </span>
    </button>
  )
}

export const GHOST = cn("flex items-center text-[var(--c-text-2)] hover:bg-[var(--c-hover)]", SQUIRCLE)

/**
 * The Agents button in the Inbox's top bar: the agents, each with its state, and the employer systems Qualify &
 * Submit works for, with a link to Agents.
 */
export function AgentsButton({
  agents,
  conns,
  open: agentsOpen,
  onOpenChange: setAgentsOpen,
}: {
  agents: Agent[]
  conns: Connection[]
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const agentsHref = useLink()("/workspace/agents")
  return (
    <AttachedPanel
      ariaLabel="Agents"
      open={agentsOpen}
      onOpenChange={setAgentsOpen}
      align="right"
      width={320}
      icon={<ShapesIcon className="size-4 shrink-0" />}
      // the real count once read; a skeleton until then, never a made-up number
      label={agents.length ? `${agents.length} agents` : <Bone className="h-2.5 w-14 rounded" />}
    >
      <ul className="flex flex-col p-1.5">
        {agents.map((a) => (
          <li key={a.id} className="flex items-center gap-2.5 rounded-lg px-2.5 py-2">
            <span className="size-2 shrink-0 squircle" style={{ background: agentState(a).color }} />
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] leading-[20px]" style={{ color: F.ink }}>
                {a.name}
              </span>
              <span className="block truncate text-[12px]" style={{ color: F.muted }}>
                {a.what}
              </span>
            </span>
            <span className="label-mono shrink-0" style={{ color: F.ink2 }}>
              {agentState(a).label}
            </span>
          </li>
        ))}
        {/* the employer systems Qualify & Submit works for, each with its mode */}
        {conns.map((c) => (
          <li key={c.key} className="flex items-center gap-2.5 rounded-lg py-1.5 pr-2.5 pl-[30px]">
            <Plug className="size-3 shrink-0" strokeWidth={1.75} style={{ color: F.muted }} />
            <span className="min-w-0 flex-1 truncate text-[13px] leading-[20px]" style={{ color: F.ink }}>
              {c.name}
              <span style={{ color: F.muted }}> · {c.roles.briefed} roles</span>
            </span>
            <span className="shrink-0 text-[12px]" style={{ color: c.mode === "off" ? F.faint : F.ink2 }}>
              {c.mode === "live" ? "Live" : c.mode === "shadow" ? "Shadow" : "Off"}
            </span>
          </li>
        ))}
        {agentsHref && (
          <li className="pt-1" style={{ borderTop: `1px solid ${F.line}` }}>
            <a
              href={agentsHref}
              data-link="block"
              className="block rounded-lg px-2.5 py-2 text-[13px] leading-[20px] hover:bg-[var(--c-hover)]"
              style={{ color: F.link }}
            >
              Open agents
            </a>
          </li>
        )}
      </ul>
    </AttachedPanel>
  )
}

/** The Agents mark: Lucide's "shapes" icon, drawn inline at a 1.25 stroke. */
function ShapesIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.25}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M8.3 10a.7.7 0 0 1-.626-1.079L11.4 3a.7.7 0 0 1 1.198-.043L16.3 8.9a.7.7 0 0 1-.572 1.1Z" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <circle cx="17.5" cy="17.5" r="3.5" />
    </svg>
  )
}

/* ---------- list ---------- */

/**
 * Search over everything the inbox shows about a conversation: who (name, email, title, company, city,
 * skills), the role, and the words of every email both ways. Every word typed must appear somewhere;
 * case and accents are ignored.
 */
function searchHit(t: Thread, query: string): boolean {
  const norm = (v: string) => v.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
  const words = norm(query).split(/\s+/).filter(Boolean)
  if (!words.length) return true
  const hay = norm(
    [
      t.name,
      t.email,
      t.title,
      t.company,
      t.location,
      t.role,
      ...t.skills,
      ...t.messages.flatMap((m) => [m.subject, m.body]),
    ].join(" \n "),
  )
  return words.every((w) => hay.includes(w))
}

function ThreadList({
  rows,
  selected,
  onSelect,
  query,
  onQuery,
  loading,
  filters,
  onFilters,
  sort,
  onSort,
  opts,
  wouldDo,
  agentError,
}: {
  rows: Thread[]
  selected: string
  onSelect: (id: string) => void
  query: string
  onQuery: (q: string) => void
  /** The first read has not come back yet: the list shows skeleton rows. */
  loading: boolean
  filters: Filters
  onFilters: (f: Filters) => void
  sort: Sort
  onSort: (v: Sort) => void
  opts: Opts
  /** Shadow: what the Qualify & Submit agent's last run would have done; null when no connection is in Shadow. */
  wouldDo: { at: string | null; items: RunItem[] } | null
  agentError: string | null
}) {
  const [filterOpen, setFilterOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const active = activeFilters(filters)
  const closeSearch = () => {
    onQuery("")
    setSearchOpen(false)
  }
  return (
    <aside
      className="relative z-10 flex w-[340px] shrink-0 flex-col"
      style={{
        background: F.panel,
        boxShadow: `1px 0 0 ${F.line}, 6px 0 14px -10px rgba(15,14,22,0.14)`,
      }}
    >
      <div className="flex flex-col gap-2 px-3 pt-3 pb-2.5">
        <div className="flex items-center gap-1">
          <span className="pl-1 text-[14px] font-medium">Outreach</span>
          <div className="relative ml-auto flex items-center">
            <button
              type="button"
              aria-label="Search"
              aria-expanded={searchOpen}
              onClick={() => (searchOpen ? closeSearch() : setSearchOpen(true))}
              className={cn(GHOST, "size-7 justify-center")}
              style={searchOpen ? { background: F.rowHover } : undefined}
            >
              <Search className="size-4" strokeWidth={1.5} />
            </button>
            <AttachedPanel
              ariaLabel="Filter"
              open={filterOpen}
              onOpenChange={setFilterOpen}
              width={440}
              dot={active.length > 0}
              icon={<ListFilter className="size-4" strokeWidth={1.5} />}
            >
              <FilterPanel
                value={filters}
                opts={opts}
                onApply={(f) => {
                  onFilters(f)
                  setFilterOpen(false)
                }}
                onClose={() => setFilterOpen(false)}
              />
            </AttachedPanel>
            <AttachedDropdown
              variant="icon"
              ariaLabel="Sort"
              minWidth={180}
              value={sort}
              onChange={(v) => onSort(v as Sort)}
              options={[
                { value: "newest", label: "Newest first" },
                { value: "oldest", label: "Oldest first" },
              ]}
              icon={<ArrowUpDown className="size-4" strokeWidth={1.5} />}
            />
          </div>
        </div>
        {/* search: opened from the icon, filters the list as you type; Escape or the x clears it */}
        {searchOpen && (
          <label
            className="flex h-8 items-center gap-2 rounded-lg px-2.5 text-[13px]"
            style={{ background: F.white, boxShadow: `inset 0 0 0 1px ${F.line}` }}
          >
            <Search className="size-3 shrink-0" strokeWidth={1.75} style={{ color: F.muted }} />
            <input
              autoFocus
              value={query}
              onChange={(e) => onQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") closeSearch()
              }}
              placeholder="Search people, roles and emails"
              aria-label="Search conversations"
              className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-[var(--c-muted)]"
              style={{ color: F.ink }}
            />
            {query && (
              <button
                type="button"
                aria-label="Clear search"
                onClick={closeSearch}
                className="flex size-4 items-center justify-center rounded-[5px] hover:bg-[var(--c-hover)]"
              >
                <X className="size-3" strokeWidth={2} style={{ color: F.muted }} />
              </button>
            )}
          </label>
        )}
        {active.length > 0 && (
          <div className="flex flex-wrap items-center gap-1">
            {active.map(([label, clear]) => (
              <span
                key={label}
                className="flex h-6 items-center gap-1 rounded-full pr-1 pl-2.5 text-[12px]"
                style={{ background: F.chip, color: F.ink2 }}
              >
                {label}
                <button
                  type="button"
                  aria-label={`Remove ${label}`}
                  onClick={() => onFilters({ ...filters, ...clear })}
                  className="flex size-4 items-center justify-center rounded-[5px] hover:bg-[var(--c-hover)]"
                >
                  <X className="size-3" strokeWidth={2} style={{ color: F.muted }} />
                </button>
              </span>
            ))}
            <button
              type="button"
              onClick={() => onFilters(NO_FILTERS)}
              className="px-1 text-[13px] leading-[20px]"
              style={{ color: F.link }}
            >
              Clear
            </button>
          </div>
        )}
      </div>

      <ul className="scroll-quiet flex min-h-0 flex-1 flex-col gap-px overflow-y-auto px-2 pb-2">
        {loading &&
          Array.from({ length: 8 }, (_, i) => (
            <li key={`sk${i}`} className="flex gap-2.5 px-2.5 py-2" aria-hidden>
              <Bone className="size-6 shrink-0 squircle" />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex h-6 items-center gap-1.5">
                  <Bone className="h-3 rounded" style={{ width: `${[38, 52, 44, 60, 34, 48, 56, 40][i]}%` }} />
                  <Bone className="ml-auto h-2.5 w-6 rounded" />
                </span>
                <span className="flex h-[19px] items-center">
                  <Bone className="h-2.5 rounded" style={{ width: `${[86, 72, 90, 64, 80, 76, 68, 84][i]}%` }} />
                </span>
                <span className="mt-1 flex gap-1">
                  <Bone className="h-5 w-16 rounded-full" />
                  <Bone className="h-5 w-24 rounded-full" />
                  <Bone className="h-5 w-20 rounded-full" />
                </span>
              </span>
            </li>
          ))}
        {agentError && (
          <li className="px-2.5 py-1.5 text-[12px]" style={{ color: F.muted }}>
            The agent&apos;s conversations could not be read: {agentError}
          </li>
        )}
        {wouldDo && <WouldDo {...wouldDo} />}
        {!loading && rows.length === 0 && (
          <li className="px-2 py-8 text-center text-[13px]" style={{ color: F.faint }}>
            Nothing here
          </li>
        )}
        {rows.map((t) => {
          const last = t.messages[t.messages.length - 1]
          if (!last) return null
          const on = t.id === selected
          return (
            <li key={t.id}>
              <button
                type="button"
                onClick={() => onSelect(t.id)}
                className={cn(
                  "flex w-full gap-2.5 rounded-lg px-2.5 py-2 text-left",
                  !on && "hover:bg-[var(--c-hover)]",
                )}
                // a conversation card is grey when hovered and a deeper grey when open, never lime
                style={on ? { background: tone("neutral").bg } : undefined}
              >
                <Avatar name={t.name} size={24} />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="flex items-center gap-1.5 text-[14px] leading-[24px]">
                    <span className="truncate" style={{ color: F.ink }}>
                      {t.name}
                    </span>
                    <span
                      className="ml-auto shrink-0 text-[12px]"
                      style={{ color: F.muted }}
                      data-tip={new Date(t.sortKey).toLocaleString("en-IN")}
                    >
                      {rel(t.sortKey)}
                    </span>
                    {t.unread && (
                      <span
                        className="size-1.5 shrink-0 squircle"
                        // something new to read: in motion, nobody's failure
                        style={{ background: tone("info").dot }}
                      />
                    )}
                  </span>
                  <span className="flex items-center gap-1 text-[13px]" style={{ color: F.ink2 }}>
                    {/* the preview never pops the whole email as a tooltip */}
                    <span className="truncate" data-tip-off>{last.body}</span>
                  </span>
                  <span className="mt-1 flex min-w-0 flex-wrap items-center gap-1">
                    <StateChip activity={t.activity} />
                    <StageChip l={t.lifecycle} />
                    {needsYou(t) && <NeedsYouChip />}
                    <Chip>{t.role}</Chip>
                  </span>
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </aside>
  )
}

/** Shadow: the agent's last run, read-only. Nothing here was sent or saved; it is what Live would do. */
function WouldDo({ at, items }: { at: string | null; items: RunItem[] }) {
  const [open, setOpen] = useState(true)
  return (
    <li className="mb-1 rounded-lg px-2.5 py-2" style={{ background: F.rowHover }}>
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-1.5 text-left text-[13px] font-medium">
        <Moon className="size-3 shrink-0" strokeWidth={2} style={{ color: F.muted }} />
        Would do
        <span className="font-normal" style={{ color: F.muted }}>
          Shadow{at ? `, ${fmtAt(at)}` : ""}
        </span>
        <ChevronDown className={cn("ml-auto size-3 transition-transform", !open && "-rotate-90")} style={{ color: F.faint }} />
      </button>
      {open && (
        <ul className="mt-1.5 flex flex-col gap-1">
          {items.length === 0 && (
            <li className="text-[12px]" style={{ color: F.muted }}>
              The last run would not write to anyone
            </li>
          )}
          {items.slice(0, 40).map((i, n) => (
            <li key={n} className="flex flex-col text-[12px] leading-[17px]">
              <span className="truncate" style={{ color: F.ink }}>
                {i.who}
                <span style={{ color: F.muted }}> · {i.result === "shadow" ? `would ${i.action}` : "skipped"}</span>
              </span>
              <span className="truncate" style={{ color: F.muted }} data-tip={i.reason}>
                {i.reason}
              </span>
            </li>
          ))}
        </ul>
      )}
    </li>
  )
}

function StateChip({ activity }: { activity: Activity }) {
  const { label, bg, fg, outlined } = ACT[activity]
  return (
    <span
      className="label-mono flex shrink-0 items-center rounded-full px-2"
      // the meaning's container behind its own text; an ending is outlined, never filled
      style={{ background: bg, color: fg, ...(outlined ? { boxShadow: `inset 0 0 0 1px ${F.line}` } : {}) }}
    >
      {label}
    </span>
  )
}

/** The lifecycle stage on a list row, beside the activity chip: whose move it is, as an icon. */
function StageChip({ l }: { l: OutreachLifecycle | null }) {
  if (!l?.stage) return null
  const { Icon } = ownerMark(l.owner ?? null)
  // coloured by phase (components/shared/tones.ts STAGE_TONE); a closed one is quiet and outlined
  const { tone: tn, outlined } = stageTone(l.stage)
  const t = tone(tn)
  return (
    <span
      className="label-mono flex shrink-0 items-center gap-1 rounded-full px-2"
      style={outlined ? { background: F.white, color: t.ink, boxShadow: `inset 0 0 0 1px ${F.line}` } : { background: t.bg, color: t.fg }}
      data-tip={l.nextAction}
    >
      <Icon className="size-3 shrink-0" strokeWidth={2} style={{ color: outlined ? t.ink : t.fg }} />
      <span className="truncate">{l.stage}</span>
    </span>
  )
}

/** A value chip in mono uppercase; a name (a skill) stays as written: `name`. */
function Chip({ children, name = false }: { children: React.ReactNode; name?: boolean }) {
  return (
    <span
      className={cn("truncate rounded-full px-2", name ? "text-[11px] leading-[18px]" : "label-mono")}
      style={{ background: tone("neutral").bg, color: tone("neutral").fg }}
    >
      {children}
    </span>
  )
}

/** A person must act on this conversation: the one "Needs you" look, beside the stage, never instead of it. */
function NeedsYouChip() {
  const t = tone("attention")
  return (
    <span className="label-mono flex shrink-0 items-center rounded-full px-2" style={{ background: t.bg, color: t.fg }}>
      Needs you
    </span>
  )
}
const needsYou = (t: Thread) => Boolean(t.qualify?.needs_you) || (t.qualify?.stage === "ready" && !t.qualify.approval) || t.lifecycle?.owner === "operator"

function Status({ activity }: { activity: Activity }) {
  const { label, Icon, color } = ACT[activity]
  return (
    <span className="label-mono flex shrink-0 items-center gap-1" style={{ color: F.ink2 }}>
      <Icon className="size-3" strokeWidth={2} style={{ color }} />
      {label}
    </span>
  )
}

/**
 * A colour per person, chosen from the name so the same person is always the same colour, on every screen: a light
 * tonal field with dark initials at Medium, 7.3:1 or better (components/shared/tones.ts). Charlie is the lime
 * squircle with the dark hand.
 */
function avatarColors(name: string): [string, string] {
  const { bg, fg } = avatarTone(name)
  return [bg, fg]
}

function Avatar({ name, charlie, size = 26 }: { name: string; charlie?: boolean; size?: number }) {
  const initials = charlie
    ? "C"
    : name
        .split(" ")
        .map((p) => p[0])
        .slice(0, 2)
        .join("")
  // Charlie is the lime squircle with the dark hand, its own mark, never initials
  if (charlie)
    return (
      <span
        className="squircle flex shrink-0 items-center justify-center"
        style={{ width: size, height: size, background: F.lemon }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/charlie-ink.svg" alt="" aria-hidden style={{ width: Math.round(size * 0.62), height: Math.round(size * 0.62) }} />
      </span>
    )
  const [tint, tone] = avatarColors(name)
  return (
    <span
      className="squircle flex shrink-0 items-center justify-center font-medium"
      style={{
        width: size,
        height: size,
        fontSize: Math.max(7, Math.round(size * 0.4)),
        background: tint,
        color: tone,
      }}
    >
      {initials}
    </span>
  )
}

/* ---------- thread ---------- */

/** One skeleton block: the chip grey, pulsing. Every loading state in the inbox is built from it. */
function Bone({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return <span className={cn("block animate-pulse", className)} style={{ background: F.chip, ...style }} />
}

/** The thread while the first read is out: the header (subject, person, role, chips), a day line and
 *  three messages in their bubbles, in the exact layout of ThreadView. */
function ThreadSkeleton() {
  return (
    <section className="flex min-w-0 flex-1 flex-col" aria-label="Loading the conversation" aria-busy>
      <div className="shrink-0 px-5 pt-3 pb-2.5" style={{ borderBottom: `1px solid ${F.line}` }}>
        <Bone className="h-4 w-3/5 rounded" />
        <span className="mt-2.5 flex items-center gap-2.5">
          <Bone className="h-3 w-28 rounded" />
          <Bone className="h-3 w-32 rounded" />
          <Bone className="h-3 w-20 rounded" />
          <Bone className="h-3 w-28 rounded" />
        </span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden px-5 py-4">
        <span className="flex items-center gap-3 py-0.5">
          <span className="w-[26px] shrink-0" />
          <Bone className="h-2.5 w-12 rounded" />
          <span className="h-px flex-1" style={{ background: F.line }} />
        </span>
        {[["78%", 7], ["52%", 2], ["70%", 5]].map(([w, lines], i) => {
          // inside Charlie's blue bubble the bars are its own blue one step deeper, never grey on blue
          const ink = i % 2 ? undefined : tone("info").line
          return (
          <span key={i} className="flex gap-3">
            <Bone className="mt-2.5 size-[26px] shrink-0 squircle" />
            <span className="flex min-w-0 flex-1 flex-col gap-2 rounded-2xl px-4 py-3.5" style={{ width: w as string, maxWidth: w as string, background: i % 2 ? F.rowHover : tone("info").bg }}>
              <Bone className="h-3 w-24 rounded" style={ink ? { background: ink } : {}} />
              {Array.from({ length: lines as number }, (_, j) => (
                <Bone key={j} className="h-2.5 rounded" style={{ width: `${[92, 88, 95, 70, 84, 90, 60][j]}%`, ...(ink ? { background: ink } : {}) }} />
              ))}
            </span>
          </span>
          )
        })}
      </div>
    </section>
  )
}

/** The details column while the first read is out: person, chips, then sections of label and value rows,
 *  the same width and edges as Details. */
function DetailsSkeleton() {
  return (
    <aside
      className="flex w-[360px] shrink-0 flex-col overflow-hidden bg-white"
      style={{ borderLeft: `1px solid ${F.line}` }}
      aria-hidden
    >
      <div className="px-4 pt-4 pb-3.5" style={{ borderBottom: `1px solid ${F.line}` }}>
        <span className="flex items-center gap-2.5">
          <Bone className="size-9 shrink-0 squircle" />
          <span className="flex flex-1 flex-col gap-1.5">
            <Bone className="h-3 w-32 rounded" />
            <Bone className="h-2.5 w-44 rounded" />
          </span>
        </span>
        <span className="mt-3 flex gap-1">
          <Bone className="h-5 w-16 rounded-full" />
          <Bone className="h-5 w-20 rounded-full" />
          <Bone className="h-5 w-12 rounded-full" />
        </span>
        <Bone className="mt-3 h-8 w-36 rounded-lg" />
      </div>
      {[5, 4, 4].map((rows, i) => (
        <div key={i} className="flex flex-col gap-2.5 px-4 py-3" style={{ borderBottom: `1px solid ${F.line}` }}>
          <Bone className="h-3 w-28 rounded" />
          {Array.from({ length: rows }, (_, j) => (
            <span key={j} className="grid grid-cols-[150px_1fr] items-center gap-3">
              <Bone className="h-2.5 w-24 rounded" />
              <Bone className="h-2.5 rounded" style={{ width: `${[70, 55, 80, 45, 62][j]}%` }} />
            </span>
          ))}
        </div>
      ))}
    </aside>
  )
}

function ThreadView({ thread, onPrev, onNext }: { thread: Thread; onPrev?: (() => void) | undefined; onNext?: (() => void) | undefined }) {
  const subject = thread.messages[0]?.subject ?? ""
  return (
    <section className="flex min-w-0 flex-1 flex-col">
      <div className="shrink-0 px-5 pt-3 pb-2.5" style={{ borderBottom: `1px solid ${F.line}` }}>
        <div className="flex items-center gap-2">
          <h2 className="min-w-0 flex-1 truncate text-[14px] font-medium">{subject}</h2>
          {/* up and down through the list as shown: the centre column, far right */}
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              aria-label="Previous conversation"
              data-tip="Previous (k)"
              disabled={!onPrev}
              onClick={onPrev}
              className={cn(GHOST, "size-7 justify-center disabled:opacity-35 disabled:hover:bg-transparent")}
              style={{ color: F.ink, boxShadow: `inset 0 0 0 1px ${F.line}` }}
            >
              <ChevronUp className="size-4" strokeWidth={2} />
            </button>
            <button
              type="button"
              aria-label="Next conversation"
              data-tip="Next (j)"
              disabled={!onNext}
              onClick={onNext}
              className={cn(GHOST, "size-7 justify-center disabled:opacity-35 disabled:hover:bg-transparent")}
              style={{ color: F.ink, boxShadow: `inset 0 0 0 1px ${F.line}` }}
            >
              <ChevronDown className="size-4" strokeWidth={2} />
            </button>
          </div>
        </div>
        <div
          className="mt-1.5 flex flex-wrap items-center gap-2.5 text-[13px]"
          style={{ color: F.ink }}
        >
          <span className="flex items-center gap-1.5">
            <Avatar name={thread.name} size={16} />
            {thread.name}
          </span>
          {thread.referredBy && (
            <>
              <Divider />
              <span className="flex items-center gap-1">
                <UserRound className="size-3" strokeWidth={1.75} style={{ color: F.muted }} />
                <span style={{ color: F.muted }}>Referred by</span>
                {thread.referredBy}
              </span>
            </>
          )}
          <Divider />
          <span className="flex items-center gap-1">
            <Briefcase className="size-3" strokeWidth={1.75} style={{ color: F.muted }} />
            {thread.role}
          </span>
          <Divider />
          <Status activity={thread.activity} />
          {thread.lifecycle?.stage && (
            <>
              <Divider />
              <StageInline l={thread.lifecycle} />
            </>
          )}
        </div>
      </div>

      <div className="scroll-quiet min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {/* one timeline: a line joins every email, event and note, like a comment thread */}
        <ol className="relative flex flex-col gap-3">
          <span
            aria-hidden
            className="absolute top-3 bottom-3 left-[13px] w-px"
            style={{ background: F.line }}
          />
          {thread.messages.map((m, i) => {
            const charlie = m.from === "charlie"
            const newDay = i === 0 || dayLabel(m.iso) !== dayLabel(thread.messages[i - 1]?.iso ?? m.iso)
            return (
              <Fragment key={i}>
                {newDay && (
                  <li className="relative flex items-center gap-3 py-0.5" aria-label={dayLabel(m.iso)}>
                    <span className="w-[26px] shrink-0" />
                    <span className="text-[12px]" style={{ color: F.muted }}>
                      {dayLabel(m.iso)}
                    </span>
                    <span className="h-px flex-1" style={{ background: F.line }} />
                  </li>
                )}
                <li className="relative flex gap-3">
                  <span className="relative mt-2.5 shrink-0 squircle ring-4 ring-white">
                    <Avatar
                      name={thread.name}
                      charlie={charlie}
                    />
                  </span>
                  <div className="min-w-0 flex-1">
                    <MessageCard
                      msg={m}
                      name={thread.name}
                      email={thread.email}
                      startOpen={i === thread.messages.length - 1}
                    />
                  </div>
                </li>
                {thread.events
                  .filter((e) => e.after === i)
                  .map((e, j) => (
                    <TimelineEvent key={`e${i}-${j}`} ev={e} day={m.iso} />
                  ))}
              </Fragment>
            )
          })}
          {thread.notes.map((n, i) => (
            <li key={`n${i}`} className="relative flex gap-3">
              <span className="relative shrink-0 squircle ring-4 ring-white">
                <Avatar name={n.by} />
              </span>
              <div className="min-w-0">
                <p className="mb-1 text-[12px]" style={{ color: F.ink }}>
                  {n.by}
                  <span className="ml-2" style={{ color: F.muted }}>
                    {n.at}
                  </span>
                </p>
                <p
                  className="inline-block rounded-lg px-3 py-1.5 text-[13px] leading-[20px]"
                  style={{ background: tone("success").bg, color: F.body }}
                >
                  {n.text}
                </p>
              </div>
            </li>
          ))}
          {/* one line where the thread ends: the lifecycle stage and what happens next */}
          {thread.lifecycle?.stage ? (
            <LifecycleMarker l={thread.lifecycle} />
          ) : (
            <StateRow Icon={CircleDashed} color={F.faint}>
              Where this stands could not be worked out
            </StateRow>
          )}
        </ol>
      </div>

      <div className="shrink-0 px-5 pt-1 pb-3">
        <input
          disabled
          placeholder="Internal notes are coming soon; nothing typed here is saved yet"
          className="h-8 w-full rounded-lg bg-[var(--c-hover)] px-3 text-[14px] outline-none placeholder:text-[var(--c-muted)]"
          style={{ color: F.ink, boxShadow: `inset 0 0 0 1px ${F.line}` }}
        />
      </div>
    </section>
  )
}

function StageInline({ l }: { l: OutreachLifecycle }) {
  const { Icon } = ownerMark(l.owner ?? null)
  const color = tone(stageTone(l.stage).tone).ink
  return (
    <span className="flex shrink-0 items-center gap-1" style={{ color: F.ink2 }} data-tip={l.nextAction}>
      <Icon className="size-3" strokeWidth={2} style={{ color }} />
      {l.stage}
    </span>
  )
}

/** "Today", "Yesterday" or the date: the divider before the first message of each day. */
const dayLabel = (iso: string) => {
  const n = dayDiff(iso)
  return n === 0 ? "Today" : n === 1 ? "Yesterday" : dateFmt.format(new Date(iso))
}

function Divider() {
  return <span className="h-3.5 w-px" style={{ background: F.line }} />
}

/** An event on the timeline: a small ringed icon on the line, then what happened and when. */
function TimelineEvent({ ev, day }: { ev: Ev; day?: string }) {
  // on the day of the message it follows (the divider above says it), the time only; on a later day, the full date
  const sameDay = Boolean(ev.iso && day && dayLabel(ev.iso) === dayLabel(day))
  const { Icon, color } = EVENT_ICON[ev.kind]
  return (
    <li className="relative flex items-center gap-3">
      <span className="relative flex size-[26px] shrink-0 items-center justify-center">
        <span
          className="flex size-5 items-center justify-center squircle bg-white"
          style={{ boxShadow: `0 0 0 1px ${F.line}, 0 0 0 4px var(--c-surface)` }}
        >
          <Icon className="size-3" strokeWidth={2} style={{ color }} />
        </span>
      </span>
      <p className="text-[12px]" style={{ color: F.ink2 }}>
        {ev.text}
        <span style={{ color: F.faint }}> · {sameDay && ev.iso ? <span data-tip={ev.at}>{clock(ev.iso)}</span> : ev.at}</span>
      </p>
    </li>
  )
}

/** Whose move it is, as an icon: the candidate (waiting on them), a person here, Charlie, the employer,
 *  or nobody (closed). Contextual icons, never a generic dot. */
function ownerMark(owner: OutreachLifecycle["owner"]): { Icon: (typeof CONV)[Conv]["Icon"]; color: string } {
  // the icon says whose move it is; its colour is the stage's (StageChip, StageInline, NextLine), never teal
  if (owner === "candidate") return { Icon: Clock, color: F.ink2 }
  if (owner === "operator") return { Icon: UserRound, color: tone("attention").ink }
  if (owner === "charlie") return { Icon: Send, color: F.ink2 }
  if (owner === "employer") return { Icon: Briefcase, color: F.ink2 }
  return { Icon: CircleSlash, color: F.muted }
}

/** A current-state row on the timeline: the same ringed icon as an event, the state beside it. */

function StateRow({
  Icon,
  color,
  children,
}: {
  Icon: (typeof CONV)[Conv]["Icon"]
  color: string
  children: React.ReactNode
}) {
  return (
    <li className="relative flex items-center gap-3">
      <span className="relative flex size-[26px] shrink-0 items-center justify-center">
        <span
          className="flex size-5 items-center justify-center squircle bg-white"
          style={{ boxShadow: `0 0 0 1px ${F.line}, 0 0 0 4px var(--c-surface)` }}
        >
          <Icon className="size-3" strokeWidth={2} style={{ color }} />
        </span>
      </span>
      <p className="text-[12px]" style={{ color: F.body }}>
        {children}
      </p>
    </li>
  )
}

/** One email. Hierarchy is colour only: one size, ink for who and what, grey for the rest. */
function MessageCard({
  msg,
  name,
  email,
  startOpen,
}: {
  msg: Msg
  name: string
  email: string
  startOpen: boolean
}) {
  const [open, setOpen] = useState(startOpen)
  const charlie = msg.from === "charlie"
  const secret = useSecret()
  const [files, setFiles] = useState<OutreachAttachment[] | null>(null)
  const [fileErr, setFileErr] = useState<string | null>(null)
  useEffect(() => {
    if (!open || charlie || !msg.emailId || files) return
    let live = true
    outreachAttachments(secret, msg.emailId)
      .then((d) => live && setFiles(d.attachments))
      .catch(() => live && setFiles([]))
    return () => {
      live = false
    }
  }, [open, charlie, msg.emailId, files, secret])
  return (
    // the fill hugs the email (never the full width); the time sits outside it, top right as before
    <div className="flex items-start gap-3">
      <div
        // no border: the fill alone tells them apart, Charlie's blue and the candidate's warm grey
        className={cn(
          "w-fit max-w-[82%] min-w-0 rounded-lg",
          charlie ? "bg-[var(--c-info-container)]" : "bg-[var(--c-hover)]",
        )}
      >
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex w-full items-start gap-2.5 px-3.5 py-2.5 text-left text-[14px] leading-[21px]"
        >
          <span className="min-w-0 flex-1">
            <span className="flex items-baseline gap-1">
              <span style={{ color: F.ink }}>{charlie ? "Charlie" : name}</span>
              {!charlie && (
                <span className="truncate" style={{ color: F.muted }}>
                  &lt;{email}&gt;
                </span>
              )}
            </span>
            {/* the preview is a glance, never a tooltip of the whole email: open the card to read it */}
            <span className="block truncate" style={{ color: F.muted }} data-tip-off>
              {open ? `To: ${charlie ? email : "Charlie"}` : msg.body.replace(/\s+/g, " ")}
            </span>
          </span>
        </button>
        {open && <EmailBody text={msg.body} signed={charlie} />}
        {open && files && files.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-3.5 pb-3.5">
            {files.map((a) => (
              <button
                key={a.id}
                type="button"
                onClick={() => {
                  setFileErr(null)
                  downloadAttachment(secret, msg.emailId ?? "", a).catch((e) =>
                    setFileErr(e instanceof Error ? e.message : String(e)),
                  )
                }}
                className="flex max-w-[260px] items-center gap-2 rounded-lg bg-white px-2.5 py-1.5 text-left text-[12px] hover:bg-[var(--c-hover)]"
                style={{ boxShadow: `inset 0 0 0 1px ${F.line}`, color: F.ink }}
              >
                <Paperclip
                  className="size-3 shrink-0"
                  strokeWidth={1.75}
                  style={{ color: F.muted }}
                />
                <span className="min-w-0 flex-1 truncate">{a.filename}</span>
                {a.size != null && (
                  <span className="shrink-0" style={{ color: F.faint }}>
                    {fileSize(a.size)}
                  </span>
                )}
                <Download
                  className="size-3 shrink-0"
                  strokeWidth={1.75}
                  style={{ color: F.muted }}
                />
              </button>
            ))}
            {fileErr && (
              <span className="self-center text-[12px]" style={{ color: "var(--c-error-ink)" }}>
                {fileErr}
              </span>
            )}
          </div>
        )}
      </div>
      <span
        className="ml-auto shrink-0 pt-2.5 text-[12px] leading-[20px]"
        style={{ color: F.muted }}
      >
        {/* the day is the divider above; here only the time, the full date on hover */}
        {/^\d{4}-/.test(msg.iso) && msg.at !== "Date not kept" ? <span data-tip={msg.at}>{clock(msg.iso)}</span> : msg.at}
      </span>
    </div>
  )
}

/**
 * A plain-text email, set for reading: paragraphs with air between them, hard-wrapped lines
 * joined back, "- " and "1. " lines as lists with a hanging marker, *bold* as bold, links and
 * addresses clickable, and Charlie's sign-off set apart as a signature. The words are never changed.
 */
function EmailBody({ text, signed }: { text: string; signed: boolean }) {
  const MARK = /^\s*([-*\u2022]|\d{1,2}[.)])\s+/
  const paras = text
    .replace(/\r\n?/g, "\n")
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
  const sig = signed && paras.length > 1 && /^[A-Z][\w ]{0,20}$/.test(paras[paras.length - 1] ?? "")
  const body = sig ? paras.slice(0, -1) : paras
  return (
    <div className="px-3.5 pb-4 text-[14px] leading-[22px]" style={{ color: F.body }}>
      <div className="flex max-w-[680px] flex-col gap-3">
        {body.map((p, i) => {
          const lines = p.split("\n")
          // a paragraph of list lines: each marker starts an item, the lines after it continue it
          if (MARK.test(lines[0] ?? "")) {
            const items: { mark: string; text: string }[] = []
            for (const l of lines) {
              const m = MARK.exec(l)
              const last = items[items.length - 1]
              if (m) items.push({ mark: m[1] ?? "", text: l.slice(m[0].length) })
              else if (last) last.text += ` ${l.trim()}`
            }
            return (
              <ul key={i} className="flex flex-col gap-1">
                {items.map((it, j) => (
                  <li key={j} className="flex gap-2">
                    <span className="w-4 shrink-0 text-right" style={{ color: F.muted }}>
                      {/^[-*]$/.test(it.mark) ? "\u2022" : it.mark}
                    </span>
                    <span className="min-w-0 flex-1">
                      <Inline text={it.text} />
                    </span>
                  </li>
                ))}
              </ul>
            )
          }
          return (
            <p key={i}>
              <Inline text={lines.map((l) => l.trim()).join(" ")} />
            </p>
          )
        })}
        {sig && (
          <div className="pt-1" style={{ color: F.ink2 }}>
            <span className="mb-2 block h-px w-4" style={{ background: F.faint }} />
            {paras[paras.length - 1]}
          </div>
        )}
      </div>
    </div>
  )
}

const fileSize = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1000))} KB`

/** One run of email text: *bold* marked by the sender, links and addresses made clickable. */
function Inline({ text }: { text: string }) {
  const parts = text.split(
    /(\*[^*\s][^*]*?[^*\s]\*|https?:\/\/[^\s<>()]+|[\w.+-]+@[\w-]+\.[\w.-]+)/g,
  )
  return (
    <>
      {parts.map((part, i) => {
        if (!part) return null
        if (/^\*[^*]+\*$/.test(part))
          return (
            // regular weight only inside a message: *bold* is kept as the sender's mark, never heavier
            <strong key={i} className="font-normal">
              {part.slice(1, -1)}
            </strong>
          )
        if (/^https?:\/\//.test(part)) {
          const url = part.replace(/[.,;:!?]+$/, "")
          return (
            <Fragment key={i}>
              <a
                href={url}
                target="_blank"
                rel="noreferrer"
                style={{ color: F.ink }}
              >
                {url}
              </a>
              {part.slice(url.length)}
            </Fragment>
          )
        }
        if (/^[\w.+-]+@[\w-]+\.[\w.-]+$/.test(part))
          return (
            <a key={i} href={`mailto:${part}`}>
              {part}
            </a>
          )
        return <Fragment key={i}>{part}</Fragment>
      })}
    </>
  )
}

/* ---------- details: everything from the CV, the pool record and the referral ---------- */

function Details({
  thread: t,
  others,
  onSelect,
}: {
  thread: Thread
  /** The same person's threads for other roles: one thread per role, each its own email thread. */
  others: Thread[]
  onSelect: (id: string) => void
}) {
  return (
    <aside
      className="scroll-quiet flex w-[360px] shrink-0 flex-col overflow-y-auto bg-white"
      style={{ borderLeft: `1px solid ${F.line}` }}
    >
      <div className="px-4 pt-4 pb-3.5" style={{ borderBottom: `1px solid ${F.line}` }}>
        <div className="flex items-center gap-2.5">
          <Avatar name={t.name} size={36} />
          <div className="min-w-0 text-[13px] leading-[18px]">
            <p className="truncate" style={{ color: F.ink }}>
              {t.name}
            </p>
            <p className="truncate" style={{ color: F.muted }}>
              {[t.title, t.company].filter((x) => x !== NG).join(" at ") || NG}
            </p>
          </div>
        </div>
        <div className="mt-2.5 flex flex-wrap gap-1">
          <StateChip activity={t.activity} />
          <Chip>{t.sourceLabel}</Chip>
          {t.totalExp !== NG && <Chip>{t.totalExp}</Chip>}
          {t.workMode !== NG && <Chip>{t.workMode}</Chip>}
        </div>
        {t.hasCv && <CvButton email={t.email} name={t.name} />}
      </div>

      {t.qualify ? <QualifySection v={t.qualify} l={t.lifecycle} /> : t.lifecycle && <StageSection l={t.lifecycle} />}

      <Section title="About">
        <Line Icon={Mail} link>
          {t.email}
        </Line>
        <Line Icon={Phone}>{t.phone}</Line>
        <Line Icon={MapPin}>{t.location}</Line>
        <Line Icon={LinkedInIcon} link>
          {t.linkedin}
        </Line>
      </Section>

      <Section title="Compensation" source="Self-reported">
        <KV k="Current CTC" v={t.currentCtc} />
        <KV k="Expected CTC" v={t.expectedCtc} />
        <KV k="Notice period" v={t.notice} />
        <KV k="Relocation" v={t.preferredLocation} />
      </Section>

      {t.companyFacts && <CompanySection c={t.companyFacts} />}

      <Section title="Experience" source="From pool record">
        <ul className="flex flex-col gap-2">
          {t.previous.map((j, i) => (
            <li key={i} className="flex gap-2.5 text-[12px] leading-[17px]">
              {j.domain ? (
                <LogoTile name={j.company} domain={j.domain} size={10} className="mt-px shrink-0" />
              ) : (
                <span
                  className="mt-px flex size-[22px] shrink-0 items-center justify-center rounded-[5px] text-[10px]"
                  style={{ background: F.chip, color: F.ink2 }}
                >
                  {j.company[0]}
                </span>
              )}
              <span className="min-w-0">
                <span className="flex items-center gap-1.5">
                  <span className="truncate" style={{ color: F.ink }}>
                    {j.company}
                  </span>
                  {i === 0 && <span style={{ color: tone("success").ink }}>Current</span>}
                </span>
                <span className="block truncate" style={{ color: F.muted }}>
                  {[j.title, j.years].filter(Boolean).join(" · ")}
                </span>
              </span>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Skills" source="From pool record">
        <div className="flex flex-wrap gap-1">
          {t.skills.map((s) => (
            <Chip key={s} name>{s}</Chip>
          ))}
        </div>
      </Section>

      <Section title="Education" source="From pool record">
        <Line Icon={GraduationCap}>{t.education}</Line>
      </Section>

      {t.referredBy && (
        <Section title="Referral" source="Pieworks">
          <KV k="Referred by" v={t.referredBy} />
          <KV k="Referrer at" v={t.referrerAt ?? NG} />
          <KV k="Referred on" v={t.referredOn ?? NG} />
        </Section>
      )}

      <Section title="Role" source="Mandate">
        <KV k="Role" v={t.role} />
        <KV k="Company" v={t.roleCompany} />
        {others.length > 0 && (
          <div className="mt-1 flex flex-col gap-1">
            <span className="text-[12px]" style={{ color: F.muted }}>
              Also contacted for
            </span>
            {others.map((o) => (
              <button
                key={o.id}
                type="button"
                onClick={() => onSelect(o.id)}
                className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-[12px] hover:bg-[var(--c-hover)]"
                style={{ color: F.link }}
              >
                <span className="truncate">{o.role}</span>
                <StateChip activity={o.activity} />
              </button>
            ))}
          </div>
        )}
      </Section>

      <Section title="Notes" add>
        {t.notes.length ? (
          t.notes.map((n, i) => (
            <div
              key={i}
              className="rounded-lg px-2.5 py-2 text-[12px] leading-[17px]"
              style={{ background: F.noteBg, boxShadow: `inset 0 0 0 1px ${F.noteLine}` }}
            >
              <p style={{ color: F.body }}>{n.text}</p>
              <p className="mt-1 flex justify-between" style={{ color: F.muted }}>
                <span>{n.by}</span>
                <span>{n.at}</span>
              </p>
            </div>
          ))
        ) : (
          <p className="text-[12px]" style={{ color: F.muted }}>
            No notes yet
          </p>
        )}
      </Section>
    </aside>
  )
}

const WAITING_FOR: Record<string, string> = {
  INTEREST: "Their reply",
  CV: "Their CV",
  SCREENING_CONSENT: "Permission to screen",
  DISCLOSURE_CONSENT: "Permission to introduce them",
  SCREENING_ANSWER: "Their answers",
  CALL: "The call",
  EMPLOYER_FEEDBACK: "The employer's feedback",
}
const PERMISSION: Record<string, string> = {
  NOT_REQUESTED: "Not asked",
  REQUESTED: "Asked",
  GRANTED: "Given",
  DENIED: "Declined",
  WITHDRAWN: "Withdrawn",
}

function NextLine({ l }: { l: OutreachLifecycle }) {
  const { Icon } = ownerMark(l.owner ?? null)
  const color = tone(stageTone(l.stage).tone).ink
  return (
    <span className="flex items-start gap-1.5" style={{ color: F.body }}>
      <Icon className="mt-[3px] size-3 shrink-0" strokeWidth={2} style={{ color }} />
      {l.nextAction}
    </span>
  )
}

/** Where the person stands in the lifecycle: the saved pursuit, or worked out from the emails on the read. */
function StageSection({ l }: { l: OutreachLifecycle }) {
  if (l.error || l.unmapped || !l.stage)
    return (
      <Section title="Where it stands" source="Derived">
        <p className="text-[12px] leading-[18px]" style={{ color: F.muted }}>
          Could not be worked out{l.error ? `: ${l.error}` : ""}
        </p>
      </Section>
    )
  return (
    <Section title="Where it stands" source={l.saved ? "Saved" : "Derived, not saved"}>
      <KV k="Stage" v={l.stage} />
      {l.step && <KV k="Step" v={l.step} />}
      <KV k="Waiting for" v={l.waitingFor ? (WAITING_FOR[l.waitingFor] ?? l.waitingFor) : "Nothing"} />
      {l.dueAt && <KV k="Due" v={fmtAt(l.dueAt)} />}
      <KV k="Permission to screen" v={PERMISSION[l.consentToScreen ?? ""] ?? NG} />
      <KV k="Permission to introduce" v={PERMISSION[l.consentToIntroduce ?? ""] ?? NG} />
      <div className="mt-0.5 flex flex-col gap-0.5 text-[13px] leading-[19px]">
        <span style={{ color: F.muted }}>Next</span>
        <NextLine l={l} />
      </div>
    </Section>
  )
}

/** A Qualify & Submit conversation: where it stands, the permission and its email, what was confirmed, the result. */
function QualifySection({ v, l }: { v: QualifyThread; l: OutreachLifecycle | null }) {
  return (
    <>
      {v.proposal && v.stage === "held" && <NeedsYou key={v.proposal.id} v={v} />}
      {v.stage === "ready" && !v.approval && <ApproveSubmit key={`approve-${v.id}`} v={v} />}
      <Section title="Where it stands" source="Saved by the agent">
        <KV k="Stage" v={l?.stage ?? v.label} />
        <KV k="Step" v={v.label} />
        <KV k="Handled by" v={v.handled_by ?? (v.needs_you ? "You" : "Nobody; it has ended")} />
        <KV k="Waiting for" v={l?.waitingFor ?? "Nothing"} />
        {v.nextAt && <KV k="Next" v={fmtAt(v.nextAt)} />}
        <KV k="Permission" v={`${v.permission.label}${v.permission.at ? `, ${fmtAt(v.permission.at)}` : ""}`} />
        {v.approval && <KV k="Put forward" v={`${v.approval.decision === "saved" ? "Approved" : "Passed"}${v.approval.at ? `, ${fmtAt(v.approval.at)}` : ""}`} />}
        {v.fit && <KV k="Fit" v={labelFit(v.fit)} />}
        {v.next && (
          <div className="mt-0.5 flex flex-col gap-0.5 text-[13px] leading-[19px]">
            <span style={{ color: F.muted }}>{v.stage === "failed" ? "Why" : v.stage === "closed" ? "Reason" : "Then"}</span>
            <span style={{ color: F.body }}>{v.next}</span>
          </div>
        )}
      </Section>
      {v.confirm && (
        <Section title="What they confirm" source={`Confirm ${v.confirm.asks} of 2`}>
          <ul className="flex flex-col gap-1 text-[13px] leading-[19px]" style={{ color: F.body }}>
            {v.confirm.lines.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        </Section>
      )}
      {v.kept.some((k) => k.unread) && (
        <Section title="Replies to read" source="Kept, not acted on">
          {v.kept
            .filter((k) => k.unread)
            .map((k, i) => (
              <p key={i} className="text-[13px] leading-[19px]" style={{ color: F.body }}>
                {k.words}
                {k.at && <span style={{ color: F.muted }}> · {fmtAt(k.at)}</span>}
              </p>
            ))}
        </Section>
      )}
      {v.events && v.events.length > 0 && <History v={v} />}
      {v.submission && (
        <Section title="Submission">
          <KV k="Result" v={labelSubmission(v.submission.status)} />
          {v.submission.attempt != null && <KV k="Attempt" v={String(v.submission.attempt)} />}
          {v.submission.at && <KV k="When" v={fmtAt(v.submission.at)} />}
          {v.submission.message && <KV k="Reply" v={v.submission.message} />}
        </Section>
      )}
    </>
  )
}
/**
 * What an agent asked a person (the candidacy lifecycle: an agent may not close someone on fit by itself). The
 * decision is recorded with who made it; the agent acts on it at its next run, within 15 minutes.
 */
const CHECK_WORDS: Record<string, string> = { gate: "The experience check", fit: "The fit after their answers", pay: "Their expected pay" }
function NeedsYou({ v }: { v: QualifyThread }) {
  const secret = useSecret()
  const p = v.proposal!
  const [busy, setBusy] = useState<"approve" | "keep" | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const decide = async (decision: "approve" | "keep") => {
    setBusy(decision)
    setError(null)
    try {
      await decideProposal(secret, p.id, decision)
      // honest about timing: the agent reads it again on its next run, and the day's email limit can push the email later
      setDone(decision === "approve" ? "Recorded. On its next run the agent checks again and, if nothing has changed, sends the closing email (within the day's email limit). This list updates within a minute." : "Recorded. On its next run the agent carries on with them. This list updates within a minute.")
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not record the decision")
    } finally {
      setBusy(null)
    }
  }
  const ev = Object.entries(p.evidence ?? {}).filter(([, x]) => x != null)
  return (
    <div className="flex flex-col gap-2 px-4 py-3" style={{ borderBottom: `1px solid ${F.line}`, background: tone("attention").bg }}>
      <p className="text-[14px] font-medium" style={{ color: F.ink }}>
        Needs you: close as not a fit?
      </p>
      <p className="text-[13px] leading-[19px]" style={{ color: F.ink2 }}>
        {CHECK_WORDS[p.check] ?? "A check"} says: {p.reason}.
      </p>
      {ev.length > 0 && (
        <p className="text-[12px] leading-[18px]" style={{ color: F.muted }}>
          {ev.map(([k, x]) => `${EVIDENCE_WORDS[k] ?? k} ${x}`).join(" · ")}
        </p>
      )}
      {done ? (
        <p className="text-[13px] leading-[19px]" style={{ color: F.body }}>
          {done}
        </p>
      ) : (
        <div className="flex items-center gap-2">
          <button type="button" disabled={busy !== null} onClick={() => decide("approve")} className={cn("flex h-7 items-center px-2.5 text-[13px] hover:bg-[var(--c-brand-hover)] disabled:opacity-50", SQUIRCLE)} style={{ background: F.lemon, color: F.ink }}>
            {busy === "approve" ? "Recording" : "Approve the close"}
          </button>
          <button type="button" disabled={busy !== null} onClick={() => decide("keep")} className={cn(GHOST, "h-7 px-2.5 text-[13px] disabled:opacity-50")} style={{ boxShadow: `inset 0 0 0 1px ${F.line}` }}>
            {busy === "keep" ? "Recording" : "Keep them"}
          </button>
        </div>
      )}
      {error && (
        <p className="text-[12px]" style={{ color: "var(--c-error-ink)" }}>
          {error}
        </p>
      )}
    </div>
  )
}
/**
 * A conversation ready to submit waits for a person: nothing is put forward until someone here approves it. Approve lets
 * the agent submit on its next run; Pass closes it. The decision is recorded with who made it; nothing is sent from here.
 */
function ApproveSubmit({ v }: { v: QualifyThread }) {
  const secret = useSecret()
  const [busy, setBusy] = useState<"approve" | "pass" | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const decide = async (decision: "approve" | "pass") => {
    setBusy(decision)
    setError(null)
    try {
      await setThreadApproval(secret, v.id, decision)
      setDone(decision === "approve" ? "Recorded. The agent puts them forward on its next run. This list updates within a minute." : "Recorded. The agent closes the conversation on its next run. This list updates within a minute.")
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not record the decision")
    } finally {
      setBusy(null)
    }
  }
  return (
    <div className="flex flex-col gap-2 px-4 py-3" style={{ borderBottom: `1px solid ${F.line}`, background: tone("attention").bg }}>
      <p className="text-[14px] font-medium" style={{ color: F.ink }}>
        Needs you: put them forward?
      </p>
      <p className="text-[13px] leading-[19px]" style={{ color: F.ink2 }}>
        They confirmed their details{v.company ? ` for ${v.company}` : ""}. Nothing is submitted until you approve.
      </p>
      {done ? (
        <p className="text-[13px] leading-[19px]" style={{ color: F.body }}>
          {done}
        </p>
      ) : (
        <div className="flex items-center gap-2">
          <button type="button" disabled={busy !== null} onClick={() => decide("approve")} className={cn("flex h-7 items-center px-2.5 text-[13px] hover:bg-[var(--c-brand-hover)] disabled:opacity-50", SQUIRCLE)} style={{ background: F.lemon, color: F.ink }}>
            {busy === "approve" ? "Recording" : "Approve"}
          </button>
          <button type="button" disabled={busy !== null} onClick={() => decide("pass")} className={cn(GHOST, "h-7 px-2.5 text-[13px] disabled:opacity-50")} style={{ boxShadow: `inset 0 0 0 1px ${F.line}` }}>
            {busy === "pass" ? "Recording" : "Pass"}
          </button>
        </div>
      )}
      {error && (
        <p className="text-[12px]" style={{ color: "var(--c-error-ink)" }}>
          {error}
        </p>
      )}
    </div>
  )
}
const EVIDENCE_WORDS: Record<string, string> = { fit: "Fit:", bar: "Bar:", gate: "Check:", expected: "Expects (lakh):", max: "Role pays up to (lakh):" }

/** What happened to this candidacy, in order, and who did it (the server's candidacy events). */
const STEP_WORDS: Record<string, string> = { verify_sent: "Asked", reminded: "Reminded", answered: "Reading reply", held: "Needs you", confirming: "Confirming details", ready: "Ready to submit", submitting: "Submitting", submitted: "Submitted", closed: "Closed", failed: "Needs you" }
// Follow-up is a retired agent; it stays named because its past steps are still in the history
const AGENT_NAMES: Record<string, string> = { outreach: "Qualify & Submit", followup: "Follow-up" }
function actorOf(e: CandidacyEvent, name: string | null): string {
  if (e.actor === "agent") return `Agent · ${AGENT_NAMES[e.actor_id ?? ""] ?? e.actor_id ?? "an agent"}`
  if (e.actor === "candidate") return name ?? "The candidate"
  if (e.actor === "person") return e.actor_id && e.actor_id !== "workspace" ? e.actor_id : "Someone in this workspace"
  if (e.actor === "employer") return "The employer"
  return "Charlie"
}
function whatOf(e: CandidacyEvent): string {
  if (e.type === "proposal.made") return `Asked a person: ${e.reason ?? "close as not a fit?"}`
  if (e.type === "proposal.decided") return e.reason ? e.reason.charAt(0).toUpperCase() + e.reason.slice(1) : "Decided"
  // the lifecycle engine (running in shadow) would have refused this move: said as its objection, never as a move
  if (e.type === "engine.refused") return `The lifecycle engine would refuse ${e.from ? `${STEP_WORDS[e.from] ?? e.from} → ` : ""}${e.to ? (STEP_WORDS[e.to] ?? e.to) : "this move"}${e.reason ? `: ${e.reason}` : ""}`
  const to = e.to ? (STEP_WORDS[e.to] ?? e.to) : "?"
  return `${e.from ? `${STEP_WORDS[e.from] ?? e.from} → ` : ""}${to}${e.reason ? `: ${e.reason}` : ""}`
}
function History({ v }: { v: QualifyThread }) {
  const events = [...(v.events ?? [])].reverse()
  return (
    <Section title="History" source="Who did what">
      <ol className="flex flex-col gap-2">
        {events.map((e, i) => (
          <li key={`${e.at}-${i}`} className="flex flex-col text-[13px] leading-[19px]">
            <span style={{ color: F.body }}>{whatOf(e)}</span>
            <span className="text-[12px]" style={{ color: F.muted }}>
              {actorOf(e, v.name)} · {fmtAt(e.at)}
            </span>
          </li>
        ))}
      </ol>
    </Section>
  )
}

const labelFit = (f: string) => f.charAt(0).toUpperCase() + f.slice(1)
const labelSubmission = (s: string) =>
  ({ sent: "Submitted", duplicate: "Already with the employer", failed: "Failed", refused: "Refused by the employer system" })[s] ?? s

/**
 * What happens next, as a calm lifecycle marker rather than a status line: "Follow up once" and the day, from the
 * lifecycle's own due date. A server value like "Wait; on <date> follow up once" is read for its action only.
 */
function nextText(l: OutreachLifecycle): { action: string; when: string | null } {
  const raw = (l.nextAction ?? "").trim()
  const m = /^wait;\s*on\s+\d{4}-\d{2}-\d{2}\s+(.*)$/i.exec(raw)
  const action = (m ? m[1] : raw) ?? ""
  const when = l.dueAt ? dayFmt.format(new Date(l.dueAt)) : null
  return { action: action ? action.charAt(0).toUpperCase() + action.slice(1) : "", when }
}
const dayFmt = new Intl.DateTimeFormat("en-IN", { weekday: "short", day: "numeric", month: "short" })

/** The last line of a thread: the stage, then what happens next and when, quiet. */
function LifecycleMarker({ l }: { l: OutreachLifecycle }) {
  const { Icon } = ownerMark(l.owner ?? null)
  const color = tone(stageTone(l.stage).tone).ink
  const { action, when } = nextText(l)
  return (
    <li className="relative flex items-center gap-3">
      <span className="relative flex size-[26px] shrink-0 items-center justify-center">
        <span
          className="flex size-5 items-center justify-center squircle bg-white"
          style={{ boxShadow: `0 0 0 1px ${F.line}, 0 0 0 4px var(--c-surface)` }}
        >
          <Icon className="size-3" strokeWidth={2} style={{ color }} />
        </span>
      </span>
      <span className="flex min-w-0 flex-wrap items-center gap-1.5 text-[12px] leading-[18px]">
        <span className="font-medium" style={{ color: F.ink }}>
          {l.stage}
        </span>
        {(action || when) && (
          <span
            className="flex items-center gap-1 rounded-full px-2"
            style={{ background: F.rowHover, color: F.ink2 }}
          >
            <Clock className="size-3 shrink-0" strokeWidth={2} style={{ color: F.muted }} />
            <span style={{ color: F.muted }}>Next</span>
            {action && <span className="truncate">{action}</span>}
            {when && <span style={{ color: F.muted }}>· {when}</span>}
          </span>
        )}
      </span>
    </li>
  )
}

/** Download the CV text on file. The original file was never kept, so it says "text". */
function CvButton({ email, name }: { email: string; name: string }) {
  const secret = useSecret()
  const [err, setErr] = useState<string | null>(null)
  return (
    <div className="mt-3 flex items-center gap-2">
      <button
        type="button"
        onClick={() => {
          setErr(null)
          downloadCv(secret, email, name).catch((e) =>
            setErr(e instanceof Error ? e.message : String(e)),
          )
        }}
        className={cn("flex h-7 items-center gap-1.5 bg-white px-3 text-[12px]", SQUIRCLE)}
        style={{ color: F.ink, boxShadow: `inset 0 0 0 1px ${F.line}` }}
      >
        <FileText className="size-3" strokeWidth={1.75} style={{ color: F.muted }} />
        Download CV
        <span style={{ color: F.faint }}>text</span>
      </button>
      {err && (
        <span className="text-[12px]" style={{ color: "var(--c-error-ink)" }}>
          {err}
        </span>
      )}
    </div>
  )
}

/** The current employer, as enrichment describes it. Only what is known is shown. */
function CompanySection({ c }: { c: CompanyFacts }) {
  const line = [
    c.industry,
    c.headcount != null ? `${c.headcount.toLocaleString("en-IN")} people` : c.scale,
    c.hq,
  ].filter(Boolean)
  return (
    <Section title="Company" source="Enrichment">
      <div className="flex items-center gap-2.5">
        <LogoTile name={c.name} domain={c.domain ?? undefined} size={10} className="shrink-0" />
        <div className="min-w-0 text-[12px] leading-[17px]">
          <p className="truncate text-[13px]" style={{ color: F.ink }}>
            {c.name}
          </p>
          {line.length > 0 && (
            <p className="truncate" style={{ color: F.muted }}>
              {line.join(" · ")}
            </p>
          )}
        </div>
      </div>
      {c.description && (
        <p className="line-clamp-4 text-[12px] leading-[18px]" style={{ color: F.ink2 }}>
          {c.description}
        </p>
      )}
      {c.founded != null && <KV k="Founded" v={String(c.founded)} />}
      {c.funding && <KV k="Funding" v={c.funding} />}
      {(c.website || c.domain) && (
        <Line Icon={Globe} link>
          {(c.website || c.domain || "").replace(/^https?:\/\//, "")}
        </Line>
      )}
    </Section>
  )
}

/** Where a section's facts come from, said once on hover instead of muted text on every section. */
const SOURCE_INFO: Record<string, string> = {
  Saved: "Saved: read from the candidate's stored record, kept in step with the emails every 15 minutes.",
  "Derived, not saved": "Derived: worked out from the emails on this read; nothing is saved for this role yet.",
  Derived: "Could not be worked out from the emails.",
  "Self-reported": "Self-reported: what the candidate told us. Not verified.",
  "From pool record": "From their talent pool record: their CV and their form answers.",
  Pieworks: "From Pieworks, the referral network.",
  Mandate: "From the role's brief.",
  Enrichment: "Company facts from the server's company enrichment.",
}

/** Location-aware: on open it measures where the icon sits and pins the tip to the screen (fixed, so no
 *  scrolling panel clips it), kept inside the window: leftward near the right edge, upward near the bottom. */
function InfoTip({ label }: { label: string }) {
  const [place, setPlace] = useState<React.CSSProperties>({})
  const measure = (el: HTMLElement) => {
    const r = el.getBoundingClientRect()
    const left = Math.max(8, Math.min(r.left, window.innerWidth - 240 - 8))
    setPlace(r.bottom + 120 > window.innerHeight ? { left, bottom: window.innerHeight - r.top + 6 } : { left, top: r.bottom + 6 })
  }
  return (
    <span
      className="group relative ml-1.5 flex items-center"
      tabIndex={0}
      aria-label={SOURCE_INFO[label] ?? label}
      onMouseEnter={(e) => measure(e.currentTarget)}
      onFocus={(e) => measure(e.currentTarget)}
    >
      <Info className="size-3" strokeWidth={1.75} style={{ color: F.faint }} />
      <span
        role="tooltip"
        className={cn(
          // hugs its words; a long one wraps at 240px
          "pointer-events-none fixed z-50 hidden w-max max-w-60 rounded-lg px-2.5 py-2 text-[12px] leading-[17px] group-hover:block group-focus:block",
        )}
        style={{ ...place, background: F.ink, color: F.white, boxShadow: "0 8px 20px -10px rgba(15,14,22,0.4)" }}
      >
        {SOURCE_INFO[label] ?? label}
      </span>
    </span>
  )
}

function Section({
  title,
  source,
  add,
  children,
}: {
  title: string
  source?: string
  add?: boolean
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(true)
  return (
    <div className="px-4 py-3" style={{ borderBottom: `1px solid ${F.line}` }}>
      <div className="flex items-center text-[12px]">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex items-center gap-1 text-[14px]"
          style={{ color: F.ink }}
        >
          {title}
          <ChevronDown
            className={cn("size-3 transition-transform", !open && "-rotate-90")}
            style={{ color: F.faint }}
          />
        </button>
        {source && <InfoTip label={source} />}
        {add && (
          <button type="button" className="ml-auto text-[13px] leading-[20px]" style={{ color: F.link }}>
            + Add
          </button>
        )}
      </div>
      {open && <div className="mt-2 flex flex-col gap-1.5">{children}</div>}
    </div>
  )
}

/** LinkedIn's own badge, the blue rounded square with the white "in". */
function LinkedInIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-label="LinkedIn" className={className}>
      <rect width="24" height="24" rx="5" fill="#0A66C2" />
      <path
        fill="#fff"
        d="M7.2 9.6h2.5v8.1H7.2zM8.45 5.6a1.45 1.45 0 1 1 0 2.9 1.45 1.45 0 0 1 0-2.9zM11.3 9.6h2.4v1.1h.03c.33-.63 1.15-1.3 2.37-1.3 2.54 0 3 1.67 3 3.84v4.46h-2.5v-3.95c0-.94-.02-2.15-1.31-2.15-1.31 0-1.51 1.02-1.51 2.08v4.02H11.3z"
      />
    </svg>
  )
}

function Line({
  Icon,
  link,
  children,
}: {
  Icon: React.ComponentType<{
    className?: string
    strokeWidth?: number
    style?: React.CSSProperties
  }>
  link?: boolean
  children: React.ReactNode
}) {
  return (
    <p
      className="flex items-center gap-2 text-[13px] leading-[20px]"
      style={{ color: link ? F.link : F.ink }}
    >
      <Icon className="size-3 shrink-0" strokeWidth={1.75} style={{ color: F.faint }} />
      <span className="truncate">{children}</span>
    </p>
  )
}

function KV({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    // left-aligned: the label in its own column, the value beside it
    <div className="grid grid-cols-[150px_1fr] items-baseline gap-3 text-[13px] leading-[19px]">
      <span style={{ color: F.muted }}>{k}</span>
      <span className="min-w-0 truncate" style={{ color: F.body }}>
        {v}
      </span>
    </div>
  )
}

/* ---------- filters: a panel over every field the CV and the referral give ---------- */

function FilterPanel({
  value,
  opts,
  onApply,
  onClose,
}: {
  value: Filters
  opts: Opts
  onApply: (f: Filters) => void
  onClose: () => void
}) {
  const [d, setD] = useState<Filters>(value)
  const set = (p: Partial<Filters>) => setD((x) => ({ ...x, ...p }))
  return (
    <div>
      <div>
        <div className="flex flex-col gap-1.5 px-4 pt-4 pb-3">
          <FilterRow label="Waiting on">
            <SelectPill
              Icon={UserRound}
              value={d.owner}
              onChange={(v) => set({ owner: v as Filters["owner"] })}
              options={[
                ["any", "Anyone"],
                ...(Object.keys(OWNER) as Owner[]).map((k): [string, string] => [k, OWNER[k]]),
              ]}
            />
          </FilterRow>
          <FilterRow label="Activation">
            <SelectPill
              Icon={CircleCheck}
              value={d.activation}
              onChange={(v) => set({ activation: v as Filters["activation"] })}
              options={[
                ["any", "Everyone"],
                ["active", "Active"],
                ["idle", "Idle"],
                ["inactive", "Inactive"],
              ]}
            />
          </FilterRow>
          <FilterRow label="Conversation status">
            <SelectPill
              Icon={CircleDashed}
              value={d.status}
              onChange={(v) => set({ status: v as Filters["status"] })}
              options={[
                ["any", "Select status"],
                ...(Object.keys(CONV) as Conv[]).map((k): [string, string] => [k, CONV[k].label]),
              ]}
            />
          </FilterRow>
          <FilterRow label="Referred by">
            <SelectPill
              Icon={UserRound}
              value={d.referrer}
              onChange={(v) => set({ referrer: v })}
              options={[
                ["", "Select referrer"],
                ...opts.referrers.map((r): [string, string] => [r, r]),
              ]}
            />
          </FilterRow>
          <FilterRow label="Location">
            <SelectPill
              Icon={MapPin}
              value={d.location}
              onChange={(v) => set({ location: v })}
              options={[
                ["", "Select location"],
                ...opts.locations.map((r): [string, string] => [r, r]),
              ]}
            />
          </FilterRow>
          <FilterRow label="Work mode">
            <SelectPill
              Icon={Briefcase}
              value={d.workMode}
              onChange={(v) => set({ workMode: v })}
              options={[
                ["", "Select work mode"],
                ...opts.workModes.map((r): [string, string] => [r, r]),
              ]}
            />
          </FilterRow>
          <FilterRow label="Notice period">
            <SelectPill
              Icon={Clock}
              value={d.notice}
              onChange={(v) => set({ notice: v as Filters["notice"] })}
              options={(Object.keys(NOTICE) as Filters["notice"][]).map((k): [string, string] => [
                k,
                k === "any" ? "Select notice" : NOTICE[k],
              ])}
            />
          </FilterRow>
          <FilterRow label="Experience">
            <SelectPill
              Icon={Layers}
              value={d.exp}
              onChange={(v) => set({ exp: v as Filters["exp"] })}
              options={(Object.keys(EXP) as Filters["exp"][]).map((k): [string, string] => [
                k,
                k === "any" ? "Select experience" : EXP[k],
              ])}
            />
          </FilterRow>
          <FilterRow label="Skill">
            <label
              className="flex h-8 items-center gap-2 rounded-lg px-2.5 text-[13px]"
              style={{ background: F.white, boxShadow: `inset 0 0 0 1px ${F.line}` }}
            >
              <Tag className="size-3 shrink-0" strokeWidth={1.75} style={{ color: F.muted }} />
              <input
                value={d.skill}
                onChange={(e) => set({ skill: e.target.value })}
                placeholder="Add a skill, e.g. Kafka"
                className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-[var(--c-muted)]"
                style={{ color: F.ink }}
              />
            </label>
          </FilterRow>
          <div className="mt-1.5 flex flex-col gap-2">
            <Check2 on={d.hasReply} onChange={(v) => set({ hasReply: v })}>
              Has replied
            </Check2>
            <Check2 on={d.hasNotes} onChange={(v) => set({ hasNotes: v })}>
              Has notes
            </Check2>
          </div>
        </div>
        <div
          className="flex items-center gap-2 px-4 py-3"
          style={{ borderTop: `1px solid ${F.line}` }}
        >
          <button
            type="button"
            onClick={() => setD(NO_FILTERS)}
            className="text-[13px] leading-[20px]"
            style={{ color: F.link }}
          >
            Clear all
          </button>
          <button
            type="button"
            onClick={onClose}
            className={cn("ml-auto flex h-8 items-center bg-white px-3.5 text-[13px]", SQUIRCLE)}
            style={{ color: F.ink, boxShadow: `inset 0 0 0 1px ${F.line}` }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onApply(d)}
            className={cn("flex h-8 items-center px-3.5 text-[13px] font-medium hover:bg-[var(--c-brand-hover)]", SQUIRCLE)}
            style={{ background: F.lemon, color: F.ink }}
          >
            Apply
          </button>
        </div>
      </div>
    </div>
  )
}

function FilterRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid min-h-8 grid-cols-[150px_1fr] items-center gap-3">
      <span className="text-[13px]" style={{ color: F.ink2 }}>
        {label}
      </span>
      <div className="flex min-w-0">{children}</div>
    </div>
  )
}

/** A filter field: the shared attached dropdown, field style. */
function SelectPill({
  Icon,
  value,
  onChange,
  options,
}: {
  Icon: React.ComponentType<{
    className?: string
    strokeWidth?: number
    style?: React.CSSProperties
  }>
  value: string
  onChange: (v: string) => void
  options: [string, string][]
}) {
  return (
    <AttachedDropdown
      variant="field"
      fullWidth
      value={value}
      onChange={onChange}
      options={options.map(([k, label]) => ({ value: k, label }))}
      icon={<Icon className="size-3 shrink-0" strokeWidth={1.75} style={{ color: F.muted }} />}
    />
  )
}

function Check2({
  on,
  onChange,
  children,
}: {
  on: boolean
  onChange: (v: boolean) => void
  children: React.ReactNode
}) {
  return (
    <label
      className="flex cursor-pointer items-center gap-2.5 text-[13px]"
      style={{ color: F.ink2 }}
    >
      <span
        className="flex size-4 items-center justify-center rounded-[4px]"
        style={
          on
            ? { background: F.lemon, boxShadow: `inset 0 0 0 1px ${tone("brand").dot}` }
            : { background: F.white, boxShadow: `inset 0 0 0 1px ${F.line}` }
        }
      >
        {on && <Check className="size-3" strokeWidth={2.5} style={{ color: F.ink }} />}
      </span>
      <input
        type="checkbox"
        checked={on}
        onChange={(e) => onChange(e.target.checked)}
        className="sr-only"
      />
      {children}
    </label>
  )
}

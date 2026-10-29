"use client"

// One verification: its plan, readiness, test calls and candidate links.

import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { useState } from "react"

import { PrimaryButton, SecondaryButton } from "@/components/shell/Buttons"
import { INPUT } from "@/components/shell/Field"
import { api, issuesOf, useLink, useSecret } from "@/lib/api"
import { duration, fmtDay } from "@/lib/format"
import type { CallRow, InviteResult, JobDetail, PlanItem } from "@/lib/types"
import { cn } from "@/lib/utils"

import { TestsMatrix } from "./Charts"
import { SessionChip } from "./Chips"
import { Doc, Eyebrow, Section } from "./Doc"

const TESTER_KEY = "charlie:tester-email"
const remembered = (fallback: string) => {
  try {
    return window.localStorage.getItem(TESTER_KEY) || fallback
  } catch {
    return fallback
  }
}
const remember = (v: string) => {
  try {
    window.localStorage.setItem(TESTER_KEY, v)
  } catch {
    /* nothing */
  }
}
export const labelOf = (s: CallRow) =>
  typeof s.conditions?.label === "string" && s.conditions.label ? s.conditions.label : null
const READY_STATES = new Set([
  "invited",
  "consented",
  "in_progress",
  "declined",
  "unreachable",
  "expired",
])

/**
 * A verification, as a page: the role, whether it is ready, how many areas and how long, one
 * primary action. Then, quietly: the areas Charlie will explore, the tests so far, the candidates.
 * Test again is one press from here; the candidate link is one line under it.
 */
export function VerificationDoc({ d, reload }: { d: JobDetail; reload: () => void }) {
  const link = useLink()
  const router = useRouter()
  const params = useSearchParams()
  const plan = d.plan
  const items = plan ? [...plan.items].sort((a, b) => a.priority - b.priority) : []
  const flagged = plan?.flagged ?? []
  const chainOk = d.chain?.ok ?? false
  const approved = plan?.status === "approved"
  const tests = d.sessions.filter((s) => s.kind === "test")
  const candidates = d.sessions.filter((s) => s.kind === "candidate")
  const linkReady = tests.some((s) => !READY_STATES.has(s.state))
  const [action, setAction] = useState<"none" | "test" | "link">(() =>
    params.get("test") ? "test" : params.get("link") ? "link" : "none",
  )
  const base = link(`/studio/${d.mandate.id}`)
  const minutes = plan ? Math.round(plan.session_budget_seconds / 60) : null
  const byDay = groupByDay(tests)

  return (
    <Doc>
      <header className="mb-10">
        <div className="text-muted-foreground mb-3 text-[13px]">
          {d.mandate.client ?? "Verification"}
        </div>
        <h1 className="text-foreground text-[15px] leading-[24px] tracking-[-0.02em]">
          {d.mandate.role}
        </h1>
        <p className="text-muted-foreground mt-2 flex flex-wrap items-center gap-2 text-[14px]">
          <span
            className={cn(
              "inline-flex h-[22px] items-center rounded-full px-2 text-[12px] font-medium",
              chainOk
                ? approved
                  ? "ink-ok field-ok"
                  : "ink-charlie field-charlie"
                : "ink-warn field-warn",
            )}
          >
            {chainOk ? (approved ? "Ready for candidates" : "Ready to test") : "Needs attention"}
          </span>
          <span>
            {items.length} area{items.length === 1 ? "" : "s"} to explore
            {minutes ? ` · ${minutes} min` : ""}
          </span>
        </p>
      </header>

      {d.chain && !chainOk && (
        <p className="text-status-error mb-8 text-[14px] leading-[1.6]">
          This verification can&apos;t be used yet:{" "}
          {d.chain.failures[0]?.detail ?? "a question does not trace back to the mandate"}.
        </p>
      )}

      <div className="mb-12 flex flex-wrap items-center gap-x-5 gap-y-2">
        <button
          type="button"
          disabled={!chainOk}
          onClick={() => setAction(action === "test" ? "none" : "test")}
          className={cn(
            "h-9 rounded-full px-4 text-[14px] font-medium transition-all",
            chainOk ? "btn-vibe" : "bg-primary text-primary-foreground opacity-40",
          )}
        >
          Test verification
        </button>
        <button
          type="button"
          disabled={!linkReady}
          onClick={() => setAction(action === "link" ? "none" : "link")}
          className="text-muted-foreground hover:text-foreground text-[13px] leading-[20px] transition-colors disabled:cursor-default disabled:opacity-50"
        >
          Generate candidate link
        </button>
        {!linkReady && chainOk && (
          <span className="text-muted-foreground/70 text-[13px]">after one test</span>
        )}
      </div>
      {action === "test" && (
        <TestStart
          d={d}
          onStarted={(token, sid) => {
            if (base) router.push(`${base}/c/${sid}?t=${encodeURIComponent(token)}`)
          }}
          onClose={() => setAction("none")}
        />
      )}
      {action === "link" && <LinkForm d={d} onDone={reload} onClose={() => setAction("none")} />}

      <Section title="Areas Charlie will explore">
        <ol className="flex flex-col gap-3">
          {items.map((it) => (
            <Area key={it.id} it={it} />
          ))}
        </ol>
        {flagged.map((f) => (
          <p key={f.ref} className="text-muted-foreground mt-4 text-[14px] leading-[1.6]">
            Charlie won&apos;t ask one question without a reason from you: {f.reason}
          </p>
        ))}
      </Section>

      <Section title="Tests">
        {base && tests.some((t) => t.summary?.evaluated) && (
          <div className="mb-8">
            <TestsMatrix tests={tests} items={items} hrefFor={(t) => `${base}/c/${t.id}`} />
          </div>
        )}
        {tests.length === 0 ? (
          <p className="text-muted-foreground text-[14px] leading-[1.6]">
            None yet. Take the conversation yourself before any candidate does.
          </p>
        ) : (
          byDay.map(([day, rows]) => (
            <div key={day} className="mb-5">
              <Eyebrow>{day}</Eyebrow>
              <ul className="flex flex-col gap-1.5">
                {rows.map((t) => (
                  <li key={t.id} className="flex items-baseline gap-3 text-[13px] leading-[20px]">
                    {base ? (
                      <Link
                        href={`${base}/c/${t.id}`}
                        className="text-foreground"
                      >
                        {labelOf(t) ?? `Test ${tests.length - tests.indexOf(t)}`}
                      </Link>
                    ) : (
                      <span className="text-foreground">{labelOf(t) ?? `Test ${tests.length - tests.indexOf(t)}`}</span>
                    )}
                    <span className="text-muted-foreground text-[13px]">
                      {duration(t.started_at, t.completed_at) || <SessionChip state={t.state} />}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))
        )}
      </Section>

      {candidates.length > 0 && (
        <Section title="Candidates">
          <ul className="flex flex-col gap-1.5">
            {candidates.map((c) => (
              <li key={c.id} className="flex items-baseline gap-3 text-[13px] leading-[20px]">
                {base ? (
                  <Link
                    href={`${base}/c/${c.id}`}
                    className="text-foreground"
                  >
                    {c.name ?? c.who ?? "Candidate"}
                  </Link>
                ) : (
                  <span className="text-foreground">{c.name ?? c.who ?? "Candidate"}</span>
                )}
                <span className="text-muted-foreground text-[13px]">
                  {c.who ?? ""}
                  {" · "}
                  <SessionChip state={c.state} />
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </Doc>
  )
}

function groupByDay(rows: CallRow[]): [string, CallRow[]][] {
  const out = new Map<string, CallRow[]>()
  const today = fmtDay(new Date().toISOString())
  for (const r of rows) {
    const day = fmtDay(r.started_at ?? r.created_at)
    const key = day === today ? "Today" : day
    out.set(key, [...(out.get(key) ?? []), r])
  }
  return [...out.entries()]
}

function Area({ it }: { it: PlanItem }) {
  const [open, setOpen] = useState(false)
  const c = it.evidence_contract
  const followUps = [
    ...c.depth_probes.map((p) => p.text),
    ...(c.ownership_probe ? [c.ownership_probe] : []),
    ...(c.scenario ? [c.scenario] : []),
  ]
  return (
    <li>
      <button type="button" onClick={() => setOpen((o) => !o)} className="block w-full text-left">
        <span className="text-foreground block text-[14px] font-medium">{c.establishes}</span>
        <span className="text-muted-foreground block text-[14px] leading-[1.6]">
          {c.anchor_question}
        </span>
        {followUps.length > 0 && (
          <span className="text-muted-foreground/70 block text-[13px]">
            {open
              ? "Hide follow-ups"
              : `${followUps.length} follow-up${followUps.length === 1 ? "" : "s"}`}
          </span>
        )}
      </button>
      {open && followUps.length > 0 && (
        <ul className="text-muted-foreground mt-2 flex flex-col gap-1 pl-5 text-[14px] leading-[1.6]">
          {followUps.map((f, i) => (
            <li key={i}>{f}</li>
          ))}
        </ul>
      )}
    </li>
  )
}

function TestStart({
  d,
  onStarted,
  onClose,
}: {
  d: JobDetail
  onStarted: (token: string, sessionId: string) => void
  onClose: () => void
}) {
  const secret = useSecret()
  const [label, setLabel] = useState("")
  const [email, setEmail] = useState(() => remembered(d.mandate.contact_email))
  const [busy, setBusy] = useState(false)
  const [errors, setErrors] = useState<string[] | null>(null)
  const ready = /\S+@\S+\.\S+/.test(email)
  async function start() {
    setBusy(true)
    setErrors(null)
    try {
      const r = await api<InviteResult>(secret, `/voice/api/jobs/${d.mandate.id}/candidates`, {
        method: "POST",
        body: JSON.stringify({
          kind: "test",
          tester_email: email.trim(),
          label: label.trim() || null,
        }),
      })
      remember(email.trim())
      onStarted(r.link.split("/v/")[1] ?? "", r.session.id)
    } catch (e: unknown) {
      setErrors(issuesOf(e))
      setBusy(false)
    }
  }
  return (
    <div className="mb-12">
      <p className="text-muted-foreground mb-4 text-[14px] leading-[1.6]">
        Take the exact conversation a candidate gets. Play the candidate you want to check: strong,
        vague, refusing, contradicting. Nothing from a test touches candidate data.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <input
          className={INPUT}
          placeholder="Name this test, e.g. strong candidate"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          autoFocus
        />
        <input
          className={INPUT}
          type="email"
          placeholder="Your email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </div>
      {errors && <p className="text-status-error mt-2 text-[13px]">{errors.join(" ")}</p>}
      <div className="mt-4 flex items-center gap-4">
        <PrimaryButton ready={ready} busy={busy} onClick={start}>
          {busy ? "One moment…" : "Start"}
        </PrimaryButton>
        <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
      </div>
    </div>
  )
}

function LinkForm({
  d,
  onDone,
  onClose,
}: {
  d: JobDetail
  onDone: () => void
  onClose: () => void
}) {
  const secret = useSecret()
  const plan = d.plan
  const approved = plan?.status === "approved"
  const flagged = plan?.flagged ?? []
  const [by, setBy] = useState(() => remembered(d.mandate.contact_email))
  const [override, setOverride] = useState("")
  const [f, setF] = useState({ name: "", email: "", cv_text: "" })
  const [busy, setBusy] = useState(false)
  const [errors, setErrors] = useState<string[] | null>(null)
  const [result, setResult] = useState<InviteResult | null>(null)
  const [copied, setCopied] = useState(false)
  const set = (k: keyof typeof f, v: string) => setF((s) => ({ ...s, [k]: v }))
  const ready = Boolean(
    (approved ||
      (/\S+@\S+\.\S+/.test(by) && (flagged.length === 0 || override.trim().length >= 3))) &&
    f.name.trim() &&
    /\S+@\S+\.\S+/.test(f.email) &&
    f.cv_text.trim().length >= 40,
  )
  async function submit() {
    if (!plan) return
    setBusy(true)
    setErrors(null)
    try {
      if (!approved)
        await api(secret, `/voice/api/jobs/${d.mandate.id}/plans/${plan.id}/approve`, {
          method: "POST",
          body: JSON.stringify({ by: by.trim(), override: override.trim() || null }),
        })
      const r = await api<InviteResult>(secret, `/voice/api/jobs/${d.mandate.id}/candidates`, {
        method: "POST",
        body: JSON.stringify({
          kind: "candidate",
          name: f.name.trim(),
          email: f.email.trim(),
          cv_text: f.cv_text.trim(),
        }),
      })
      setResult(r)
      onDone()
    } catch (e: unknown) {
      setErrors(issuesOf(e))
    }
    setBusy(false)
  }
  return (
    <div className="mb-12">
      <p className="text-muted-foreground mb-4 text-[14px] leading-[1.6]">
        {approved
          ? "Add the candidate; you get a link to send however you like."
          : "The first link approves this verification as it stands. A change afterwards is a new version."}
      </p>
      {!approved && (
        <div className="mb-3 grid gap-3 sm:grid-cols-2">
          <input
            className={INPUT}
            type="email"
            placeholder="Approved by (your email)"
            value={by}
            onChange={(e) => setBy(e.target.value)}
          />
          {flagged.length > 0 && (
            <input
              className={INPUT}
              placeholder="Why the flagged question is fine to ask"
              value={override}
              onChange={(e) => setOverride(e.target.value)}
            />
          )}
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <input
          className={INPUT}
          placeholder="Candidate's name"
          value={f.name}
          onChange={(e) => set("name", e.target.value)}
        />
        <input
          className={INPUT}
          type="email"
          placeholder="Candidate's email"
          value={f.email}
          onChange={(e) => set("email", e.target.value)}
        />
        <textarea
          className={cn(INPUT, "h-28 resize-y py-2 sm:col-span-2")}
          placeholder="Their CV, as text"
          value={f.cv_text}
          onChange={(e) => set("cv_text", e.target.value)}
        />
      </div>
      {errors && <p className="text-status-error mt-2 text-[13px]">{errors.join(" ")}</p>}
      {result ? (
        <div className="mt-4 flex flex-col gap-2">
          <span className="text-muted-foreground text-[13px]">
            Link created. It expires {fmtDay(result.expires_at)}. The candidate appears here once
            they open it.
          </span>
          <div className="flex items-center gap-3">
            <code className="text-foreground/90 bg-muted/70 min-w-0 flex-1 truncate rounded-md px-2 py-1.5 font-sans text-[12px]">
              {result.link}
            </code>
            <SecondaryButton
              onClick={async () => {
                await navigator.clipboard.writeText(result.link)
                setCopied(true)
              }}
            >
              {copied ? "Copied" : "Copy link"}
            </SecondaryButton>
          </div>
        </div>
      ) : (
        <div className="mt-4 flex items-center gap-4">
          <PrimaryButton ready={ready} busy={busy} onClick={submit}>
            {busy ? "One moment…" : "Generate link"}
          </PrimaryButton>
          <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
        </div>
      )}
    </div>
  )
}

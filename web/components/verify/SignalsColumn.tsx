"use client"

// The reviewer's annotation column beside a transcript: one card per signal, with a single Save.

import { useEffect, useRef, useState } from "react"

import { Label } from "@/components/shell/Lines"
import { AttachedDropdown } from "@/components/shared/AttachedDropdown"
import { Button } from "@/components/ui/button"
import { api, useSecret } from "@/lib/api"
import { fmtDate, secs, words } from "@/lib/format"
import type { CallDetail, Meta, PackageSignal } from "@/lib/types"
import { cn } from "@/lib/utils"

import { StatusChip } from "./Chips"

const FIELD =
  "border-border bg-card text-foreground h-8 w-full rounded-lg border px-2.5 text-[12px] outline-none transition-[box-shadow,border-color] duration-[var(--motion-fast)] focus-visible:border-vibe-1/60 focus-visible:ring-[3px] focus-visible:ring-vibe-1/15"

type Mark = { human_status: string; disagreement_reason: string; note: string }

/**
 * The annotation column beside the transcript: one card per signal (status, coverage, what would
 * have raised it, its quotes with timestamps), and the reviewer's reading inline on each with a
 * reason where it differs. One Save. Nothing here scores anybody. A mark that has not been touched
 * is the default (Charlie's own status), derived at read time rather than seeded by an effect.
 */
export function SignalsColumn({
  d,
  meta,
  activeEvidence,
  activeItem,
  onPickItem,
  onPickEvidence,
  onSaved,
}: {
  d: CallDetail
  meta: Meta | null
  activeEvidence: string | null
  activeItem: string | null
  onPickItem: (id: string | null) => void
  onPickEvidence: (id: string | null) => void
  onSaved: () => void
}) {
  const secret = useSecret()
  const pkg = d.package
  const isTest = d.session.kind === "test"
  const sigByItem = new Map(d.signals.map((s) => [s.plan_item_id, s]))
  const evById = new Map(d.evidence.map((e) => [e.id, e]))
  const [reviewer, setReviewer] = useState("")
  const [marks, setMarks] = useState<Record<string, Mark>>({})
  const [lift, setLift] = useState("")
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState<string | null>(null)
  const refs = useRef<Record<string, HTMLLIElement | null>>({})
  const markFor = (sigId: string, status: string): Mark =>
    marks[sigId] ?? { human_status: status, disagreement_reason: "", note: "" }
  const setMark = (sigId: string, status: string, patch: Partial<Mark>) =>
    setMarks((m) => ({ ...m, [sigId]: { ...markFor(sigId, status), ...patch } }))

  useEffect(() => {
    if (!activeEvidence) return
    const ev = evById.get(activeEvidence)
    const sig = ev && sigByItem.get(ev.plan_item_id)
    if (sig) refs.current[sig.id]?.scrollIntoView({ block: "nearest", behavior: "smooth" })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeEvidence])

  if (!pkg) {
    return (
      <p className="text-muted-foreground px-4 py-6 text-[12px] leading-[1.6]">
        No evaluation yet for this call. It appears once the call has been processed.
      </p>
    )
  }

  const sections: { title: string; rows: PackageSignal[] }[] = [
    { title: "Must-haves", rows: pkg.capability_grid.filter((s) => s.kind === "hard_requirement") },
    {
      title: "Capabilities",
      rows: pkg.capability_grid.filter((s) => s.kind !== "hard_requirement"),
    },
    { title: "Why this role", rows: pkg.intent ? [pkg.intent] : [] },
  ]

  async function save() {
    setSaving(true)
    setSaved(null)
    try {
      const per_signal = d.signals.map((s) => {
        const m = markFor(s.id, s.status)
        return {
          signal_id: s.id,
          human_status: m.human_status,
          disagreement_reason: m.human_status === s.status ? null : m.disagreement_reason || null,
          note: m.note || null,
        }
      })
      await api(secret, `/voice/api/calls/${d.session.id}/review`, {
        method: "POST",
        body: JSON.stringify({
          reviewer,
          report_version: d.report_version || 1,
          per_signal,
          evidence_lift: { evidence_ids_new_beyond_cv: [], note: lift || null },
        }),
      })
      setSaved("Saved. Every disagreement is now a case the next version has to get right.")
      onSaved()
    } catch (e: unknown) {
      setSaved(e instanceof Error ? e.message : String(e))
    }
    setSaving(false)
  }

  return (
    <div className="flex flex-col gap-8 px-4 py-2">
      {pkg.contradictions.length > 0 && (
        <div className="text-[13px] leading-[1.6]">
          <div className="text-foreground mb-1 font-medium">Statements that differ</div>
          {pkg.contradictions.map((c, i) => (
            <div key={i} className="mt-1">
              <span className="text-muted-foreground">
                {c.field}
                {c.resolved ? " · resolved by the candidate" : " · open, a question for a human"}
              </span>
              <div>{c.quote_a}</div>
              <div>{c.quote_b ? `${c.quote_b}` : `CV: ${c.cv_line}`}</div>
            </div>
          ))}
        </div>
      )}

      {sections.map((sec) =>
        sec.rows.length ? (
          <section key={sec.title} className="flex flex-col gap-2">
            <Label>{sec.title}</Label>
            <ol className="flex flex-col gap-2">
              {sec.rows.map((s) => {
                const sig = sigByItem.get(s.plan_item_id)
                const m = sig ? markFor(sig.id, sig.status) : null
                const differs = Boolean(sig && m && m.human_status !== sig.status)
                const active = activeItem === s.plan_item_id
                return (
                  <li
                    key={s.ref}
                    ref={(el) => {
                      if (sig) refs.current[sig.id] = el
                    }}
                    onClick={() => onPickItem(active ? null : s.plan_item_id)}
                    className={cn(
                      "border-border cursor-pointer border-b py-5 transition-colors duration-[var(--motion-fast)]",
                      active ? "text-foreground" : "",
                    )}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="text-foreground text-[16px] font-medium">{s.establishes}</div>
                      <StatusChip status={s.status} />
                    </div>
                    <div className="text-muted-foreground mt-1 text-[11px]">
                      {words(s.coverage_band)}
                      {s.reason ? ` · ${s.reason}` : ""}
                      {s.probes_asked
                        ? ` · ${s.probes_asked} follow-up${s.probes_asked === 1 ? "" : "s"}`
                        : ""}
                    </div>
                    <p className="text-foreground/85 mt-2 text-[13px] leading-[1.6]">
                      {s.status_text}
                    </p>
                    {s.evidence.length > 0 && (
                      <ul className="mt-2 flex flex-col gap-1">
                        {s.evidence.map((q) => (
                          <li
                            key={q.evidence_id}
                            onClick={(e) => {
                              e.stopPropagation()
                              onPickEvidence(q.evidence_id)
                              document
                                .getElementById(`turn-${q.turn_ids[0]}`)
                                ?.scrollIntoView({ block: "center", behavior: "smooth" })
                            }}
                            className={cn(
                              "py-1 text-[13px] leading-[1.6]",
                              activeEvidence === q.evidence_id
                                ? "text-foreground"
                                : "text-foreground/80 hover:text-foreground",
                            )}
                          >
                            <span className="text-muted-foreground tabular-nums">
                              {secs(q.audio_start_secs)}
                            </span>{" "}
                            {q.quote}
                          </li>
                        ))}
                      </ul>
                    )}
                    {s.missing_elements.length > 0 && (
                      <p className="text-muted-foreground mt-1.5 text-[11px]">
                        What would have raised this: {s.missing_elements.map(words).join(", ")}.
                      </p>
                    )}
                    {sig && m && !isTest && (
                      <div
                        className="mt-4 grid grid-cols-2 gap-2"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <label className="text-muted-foreground flex flex-col gap-1 text-[11px]">
                          Your reading
                          <AttachedDropdown
                            variant="field"
                            fullWidth
                            ariaLabel="Your reading"
                            firstIsChoice
                            value={m.human_status}
                            options={(meta?.statuses ?? []).map((st) => ({ value: st, label: words(st) }))}
                            onChange={(v) => setMark(sig.id, sig.status, { human_status: v })}
                          />
                        </label>
                        {differs ? (
                          <label className="text-muted-foreground flex flex-col gap-1 text-[11px]">
                            Why Charlie was wrong
                            <AttachedDropdown
                              variant="field"
                              fullWidth
                              ariaLabel="Why Charlie was wrong"
                              value={m.disagreement_reason}
                              options={[
                                { value: "", label: "choose a reason" },
                                ...(meta?.disagreement_reasons ?? []).map((r) => ({ value: r, label: words(r) })),
                              ]}
                              onChange={(v) => setMark(sig.id, sig.status, { disagreement_reason: v })}
                            />
                          </label>
                        ) : (
                          <span />
                        )}
                        <input
                          className={cn(FIELD, "col-span-2")}
                          placeholder="Note (optional)"
                          value={m.note}
                          onChange={(e) => setMark(sig.id, sig.status, { note: e.target.value })}
                        />
                      </div>
                    )}
                  </li>
                )
              })}
            </ol>
          </section>
        ) : null,
      )}

      {pkg.gaps.length > 0 && (
        <section className="flex flex-col gap-1.5">
          <Label>Not established in this session</Label>
          <ul className="text-[12px] leading-[1.55]">
            {pkg.gaps.map((g) => (
              <li key={g.ref}>
                {g.establishes}{" "}
                <span className="text-muted-foreground">
                  · {words(g.status)} · {g.reason}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="flex flex-col gap-1.5">
        <Label>What this does not tell you</Label>
        <ul className="text-muted-foreground list-disc pl-4 text-[12px] leading-[1.55]">
          {pkg.limitations.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      </section>

      {!isTest && (
        <section className="border-border flex flex-col gap-3 border-t pt-6">
          <h3 className="text-foreground text-[14px] font-medium tracking-[-0.01em]">
            Your review
          </h3>
          <p className="text-muted-foreground text-[11px] leading-[1.55]">
            Set your reading on each item above. Where it differs from Charlie&apos;s, say why. This
            is how the next version learns; nothing changes on its own.
          </p>
          {d.review && (
            <p className="text-muted-foreground text-[11px]">
              Last review by {d.review.reviewer}, {fmtDate(d.review.recorded_at)}.
            </p>
          )}
          <input
            className={FIELD}
            type="email"
            placeholder="Your email"
            value={reviewer}
            onChange={(e) => setReviewer(e.target.value)}
          />
          <textarea
            className={cn(FIELD, "h-16 resize-y py-1.5")}
            placeholder="What did this add beyond the CV and the screening call?"
            value={lift}
            onChange={(e) => setLift(e.target.value)}
          />
          <div className="flex items-center gap-2">
            <Button size="sm" disabled={saving || !reviewer} onClick={save}>
              Save review
            </Button>
            {saved && <span className="text-muted-foreground text-[11px]">{saved}</span>}
          </div>
        </section>
      )}
    </div>
  )
}

"use client"

// A conversation transcript with area dividers and inline evidence highlights.

import { Fragment, useRef, useState } from "react"
import { createPortal } from "react-dom"

import { annotate } from "@/lib/annotate"
import { secs, sentence } from "@/lib/format"
import type { Evidence, PlanItem, Turn } from "@/lib/types"
import { cn } from "@/lib/utils"

import { LinearIcon, type LinearIconName } from "@/components/shared/LinearIcon"

import { StatusChip } from "./Chips"
import { SpeakerRow } from "./Speaker"

type Row = { turn: Turn; sectionItemId: string | null; reconnected: boolean; opening: boolean }

/** Where the areas begin, where the call reconnected, and which Charlie turn opens an area. Pure. */
function groupTurns(turns: Turn[]): Row[] {
  const rows: Row[] = []
  let lastItem: string | null = null
  let awaitingOpening = true
  const seenConv = new Set<string>()
  for (const t of turns) {
    const reconnected = !seenConv.has(t.conversation_id) && seenConv.size > 0
    seenConv.add(t.conversation_id)
    const sectionItemId: string | null =
      t.plan_item_id && t.plan_item_id !== lastItem ? t.plan_item_id : null
    if (sectionItemId) {
      lastItem = sectionItemId
      awaitingOpening = true
    }
    const opening = t.speaker === "agent" && awaitingOpening
    if (opening) awaitingOpening = false
    rows.push({ turn: t, sectionItemId, reconnected, opening })
  }
  return rows
}

/**
 * The transcript as a document. An area begins with a quiet line naming it; Charlie's opening
 * question sits at the margin, larger; the person's answers and Charlie's follow-ups are indented
 * as one thread. Evidence is washed inside the person's words and, beside the turn, named in grey:
 * the area it speaks to and the kind of detail it is. Clicking either selects both.
 */
export function Transcript({
  turns,
  evidence,
  itemsById,
  statusByItem = {},
  activeEvidence,
  activeItem,
  onPickEvidence,
  personName,
  gutter = false,
  className,
}: {
  turns: Turn[]
  evidence: Evidence[]
  itemsById: Record<string, PlanItem>
  statusByItem?: Record<string, string>
  activeEvidence: string | null
  activeItem: string | null
  onPickEvidence: (id: string) => void
  personName?: string
  gutter?: boolean
  className?: string
}) {
  if (!turns.length)
    return (
      <p className="text-muted-foreground text-[13px]">
        No transcript yet. It arrives after the conversation ends.
      </p>
    )
  const byTurn = new Map<string, Evidence[]>()
  for (const e of evidence)
    for (const tid of e.provenance.turn_ids) byTurn.set(tid, [...(byTurn.get(tid) ?? []), e])
  const rows = groupTurns(turns)

  return (
    <div
      className={cn(
        "grid",
        gutter ? "grid-cols-[minmax(0,1fr)_180px] gap-x-8" : "grid-cols-1",
        className,
      )}
    >
      {rows.map(({ turn: t, sectionItemId, reconnected, opening }) => {
        const mine = byTurn.get(t.id) ?? []
        const segs =
          t.speaker === "candidate" && mine.length ? annotate(t.text, mine) : [{ text: t.text }]
        const isAgent = t.speaker === "agent"
        const section = sectionItemId ? itemsById[sectionItemId] : null
        return (
          <Fragment key={t.id}>
            {reconnected && (
              <>
                <p className="text-muted-foreground/70 mt-2 mb-6 text-[13px]">Reconnected</p>
                {gutter && <div />}
              </>
            )}
            {sectionItemId && (
              <>
                <p
                  className={cn(
                    "mt-3 mb-4 text-[12px] font-medium",
                    activeItem === sectionItemId ? "ink-charlie" : "text-muted-foreground",
                  )}
                >
                  {section?.evidence_contract.establishes ?? "next area"}
                </p>
                {gutter && <div />}
              </>
            )}
            <div
              id={`turn-${t.id}`}
              className={cn(
                "mb-6",
                t.usable === false && "opacity-50",
                t.superseded_by && "opacity-60",
              )}
            >
              <SpeakerRow
                who={t.speaker}
                {...(isAgent ? {} : personName ? { name: personName } : {})}
                time={secs(t.t_start)}
                muted={isAgent && !opening}
              />
              <p className="text-foreground mt-1.5 text-[13px] leading-[1.6]">
                {segs.map((s, i) =>
                  s.evidence ? (
                    <EvidenceMark
                      key={i}
                      text={s.text}
                      active={activeEvidence === s.evidence.id}
                      onPick={() => onPickEvidence(s.evidence!.id)}
                      area={
                        itemsById[s.evidence.plan_item_id]?.evidence_contract.establishes ?? "Area"
                      }
                      detail={`${sentence(s.evidence.contract_element)}${s.evidence.probe_depth ? ` · came after follow-up ${s.evidence.probe_depth}` : " · in the first answer"}${s.evidence.provenance.audio_start_secs != null ? ` · ${secs(s.evidence.provenance.audio_start_secs)}` : ""}`}
                      status={statusByItem[s.evidence.plan_item_id] ?? null}
                    />
                  ) : (
                    <span key={i}>{s.text}</span>
                  ),
                )}
              </p>
              {(t.usable === false || t.superseded_by) && (
                <p className="text-muted-foreground mt-1 text-[12px]">
                  {t.usable === false ? "unusable audio" : "restarted"}
                </p>
              )}
            </div>
            {gutter && (
              <div className="mb-7 flex flex-col gap-3 pt-6">
                {mine.map((e) => {
                  const item = itemsById[e.plan_item_id]
                  const active = activeEvidence === e.id
                  const status = statusByItem[e.plan_item_id]
                  return (
                    <div key={e.id} className="group relative">
                      <button
                        type="button"
                        onClick={() => onPickEvidence(e.id)}
                        className="rounded-full text-left"
                      >
                        <span
                          className={cn(
                            "block text-[13px] leading-[1.4] transition-colors",
                            active
                              ? "text-foreground"
                              : "text-muted-foreground group-hover:text-foreground",
                          )}
                        >
                          {item?.evidence_contract.establishes ?? "Area"}
                        </span>
                        <span className="text-muted-foreground/70 block text-[12px]">
                          {sentence(e.contract_element)}
                          {status ? ` · ${sentence(status)}` : ""}
                        </span>
                      </button>
                      <div className="hovercard bg-card pointer-events-none absolute top-0 right-full z-20 mr-3 w-72 rounded-lg p-3.5 opacity-0 transition-opacity duration-[var(--motion-fast)] group-hover:opacity-100">
                        <p className="text-foreground text-[13px] leading-[1.55]">{e.quote}</p>
                        <dl className="text-muted-foreground mt-2.5 grid grid-cols-[76px_1fr] gap-y-0.5 text-[12px]">
                          <dt>Area</dt>
                          <dd className="text-foreground/80">
                            {item?.evidence_contract.establishes ?? ""}
                          </dd>
                          <dt>Detail</dt>
                          <dd className="text-foreground/80">{sentence(e.contract_element)}</dd>
                          {e.probe_depth ? (
                            <>
                              <dt>Came after</dt>
                              <dd className="text-foreground/80">follow-up {e.probe_depth}</dd>
                            </>
                          ) : null}
                          <dt>Said at</dt>
                          <dd className="text-foreground/80">
                            {secs(e.provenance.audio_start_secs)}
                          </dd>
                          {status ? (
                            <>
                              <dt>Reads as</dt>
                              <dd className="text-foreground/80">{sentence(status)}</dd>
                            </>
                          ) : null}
                        </dl>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </Fragment>
        )
      })}
    </div>
  )
}

/**
 * A highlighted span with a hover card that knows where it is: it opens below the words, or above
 * when there is no room below, and slides left to stay inside the window.
 */
const TOKEN_GLYPH = (status: string | null): LinearIconName =>
  status === "supported" || status === "strongly_supported"
    ? "check"
    : status === "contradicted"
      ? "alert"
      : status === "stated_only"
        ? "circle"
        : "information"

function EvidenceMark({
  text,
  active,
  onPick,
  area,
  detail,
  status,
}: {
  text: string
  active: boolean
  onPick: () => void
  area: string
  detail: string
  status: string | null
}) {
  const ref = useRef<HTMLElement | null>(null)
  const [place, setPlace] = useState<{ top: number; left: number; above: boolean } | null>(null)
  const W = 320
  const H = 150
  const show = () => {
    const r = ref.current?.getBoundingClientRect()
    if (!r) return
    const above = window.innerHeight - r.bottom < H + 24
    const left = Math.max(8, Math.min(r.left, window.innerWidth - W - 8))
    setPlace({ top: above ? r.top - 8 : r.bottom + 8, left, above })
  }
  const hide = () => setPlace(null)
  return (
    <>
      <mark
        onClick={onPick}
        className={cn("hl text-foreground cursor-pointer", active && "hl-active")}
      >
        {text}
      </mark>
      <span
        ref={ref}
        role="button"
        tabIndex={0}
        onClick={onPick}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onPick()}
        className={cn("token", active && "token-active")}
        aria-label={`Evidence for ${area}`}
      >
        <LinearIcon name={TOKEN_GLYPH(status)} />
        <span>{area}</span>
      </span>
      {place &&
        typeof document !== "undefined" &&
        createPortal(
          <span
            className="hovercard bg-card pointer-events-none fixed z-[100] block w-80 rounded-[var(--radius-card)] p-3.5 text-left"
            style={{
              left: place.left,
              top: place.top,
              transform: place.above ? "translateY(-100%)" : undefined,
            }}
          >
            <span className="text-muted-foreground mb-1 block text-[11px]">
              Evidence
            </span>
            <span className="text-foreground block text-[13px] leading-[1.5]">
              {area}
            </span>
            <span className="text-muted-foreground mt-1.5 block text-[12px] leading-[1.6]">
              {detail}
            </span>
            {status && <StatusChip status={status} className="mt-2" />}
          </span>,
          document.body,
        )}
    </>
  )
}

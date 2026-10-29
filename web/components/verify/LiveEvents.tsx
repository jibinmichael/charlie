"use client"

// The live log of a running conversation, turn by turn, as the server records it.

import { secs } from "@/lib/format"
import type { Event, PlanItem } from "@/lib/types"
import { cn } from "@/lib/utils"

import { SpeakerRow } from "./Speaker"

/**
 * A conversation as the server records it, turn by turn, while it is still running. Each
 * `turn.recorded` event carries the candidate's latest words as the provider passed them mid-call
 * and the line Charlie answered with, plus the plan item, the move, the latency and whether the
 * scripted fallback spoke. This is the watcher's view; the canonical transcript, with evidence,
 * arrives from the provider after the call and replaces it.
 */
type Recorded = {
  seq: number
  candidate_text: string | null
  agent_text: string
  plan_item_id: string | null
  move: string | null
  elapsed: number | null
  latency_ms: number | null
  fallback_used: boolean
  judge_used: boolean
  at: string
}

function recorded(events: Event[]): Recorded[] {
  return events
    .filter((e) => e.type === "turn.recorded" && typeof e.payload?.agent_text === "string")
    .map((e) => {
      const p = e.payload
      return {
        seq: typeof p.seq === "number" ? p.seq : 0,
        candidate_text: typeof p.candidate_text === "string" ? p.candidate_text : null,
        agent_text: String(p.agent_text),
        plan_item_id: typeof p.plan_item_id === "string" ? p.plan_item_id : null,
        move: typeof p.move === "string" ? p.move : null,
        elapsed: typeof p.elapsed === "number" ? p.elapsed : null,
        latency_ms: typeof p.latency_ms === "number" ? p.latency_ms : null,
        fallback_used: p.fallback_used === true,
        judge_used: p.judge_used === true,
        at: e.at,
      }
    })
    .sort((a, b) => a.seq - b.seq || a.at.localeCompare(b.at))
}

export function LiveEvents({
  events,
  itemsById,
  personName,
  className,
}: {
  events: Event[]
  itemsById: Record<string, PlanItem>
  personName: string
  className?: string
}) {
  const turns = recorded(events)
  return (
    <div className={cn("flex flex-col", className)}>
      <p className="text-muted-foreground mb-6 text-[13px] leading-[1.6]">
        As the server records it, refreshed every few seconds. The candidate&apos;s words are what
        the provider passed mid-call and are provisional until the transcript arrives.
      </p>
      {turns.length === 0 && (
        <p className="text-muted-foreground text-[13px]">Waiting for the first turn.</p>
      )}
      {turns.map((t, i) => {
        const area = t.plan_item_id
          ? itemsById[t.plan_item_id]?.evidence_contract.establishes
          : null
        const prevArea = i > 0 ? turns[i - 1]?.plan_item_id : null
        return (
          <div key={`${t.seq}-${t.at}`} className="mb-6">
            {area && t.plan_item_id !== prevArea && (
              <p className="text-muted-foreground mt-2 mb-4 text-[12px] font-medium">{area}</p>
            )}
            {t.candidate_text && (
              <div className="mb-4">
                <SpeakerRow who="candidate" name={personName} />
                <p className="mt-1.5 text-[13px] leading-[1.6] text-[var(--ink)]">
                  {t.candidate_text}
                </p>
              </div>
            )}
            <SpeakerRow who="agent" {...(t.elapsed != null ? { time: secs(t.elapsed) } : {})} />
            <p className="mt-1.5 text-[13px] leading-[1.6] text-[var(--ink)]">{t.agent_text}</p>
            <p className="text-muted-foreground mt-1 text-[11px]">
              {[
                t.move ? t.move.replace(/_/g, " ") : null,
                t.latency_ms != null ? `${(t.latency_ms / 1000).toFixed(1)} s` : null,
                t.fallback_used ? "scripted fallback" : null,
                t.judge_used ? "judge" : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
          </div>
        )
      })}
    </div>
  )
}

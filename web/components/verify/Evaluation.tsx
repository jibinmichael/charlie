"use client"

// A conversation's evaluation, rendered as a document of requirements and their evidence.

import { secs, sentence } from "@/lib/format"
import type { PackageSignal, PlanItem, ReportPackage, Turn } from "@/lib/types"
import { cn } from "@/lib/utils"

import { AreasTable, TimeChart } from "./Charts"
import { Eyebrow } from "./Doc"
import { StatusChip } from "./Chips"

/**
 * The evaluation as a document. Per requirement: the name, then the evidence as the dominant
 * text, then coverage, then what was established and what remains unclear. A hairline between
 * requirements. The status is one quiet word. No score, no number, no recommendation.
 */
export function Evaluation({
  pkg,
  items = [],
  turns = [],
  onViewTranscript,
  className,
}: {
  pkg: ReportPackage
  items?: PlanItem[]
  turns?: Turn[]
  onViewTranscript?: (planItemId: string | null, evidenceId?: string) => void
  className?: string
}) {
  const rows: PackageSignal[] = [...pkg.capability_grid, ...(pkg.intent ? [pkg.intent] : [])]
  const h = pkg.header
  return (
    <div className={cn("flex flex-col", className)}>
      <p className="text-muted-foreground mb-8 text-[13px]">
        {h.duration_seconds != null
          ? `${Math.max(1, Math.round(h.duration_seconds / 60))} min · `
          : ""}
        {h.items_reached} of {h.items_total} areas explored
      </p>
      {items.length > 0 && (
        <div className="border-border mb-10 flex flex-col gap-8 border-b pb-10">
          <AreasTable
            pkg={pkg}
            items={items}
            turns={turns}
            onOpen={(pid) =>
              document
                .getElementById(`area-${pid}`)
                ?.scrollIntoView({ block: "start", behavior: "smooth" })
            }
          />
          <TimeChart turns={turns} items={items} />
        </div>
      )}

      {pkg.contradictions.length > 0 && (
        <section className="border-border mb-10 border-b pb-10">
          <h3 className="text-foreground mb-4 text-[14px] font-medium tracking-[-0.01em]">
            Statements that differ
          </h3>
          {pkg.contradictions.map((c, i) => (
            <div key={i} className="mb-4 text-[13px] leading-[1.6]">
              <Eyebrow>
                {sentence(c.field)} · {c.resolved ? "resolved by the person" : "open"}
              </Eyebrow>
              <p className="text-foreground">{c.quote_a}</p>
              <p className="text-foreground/80">
                {c.quote_b ? `${c.quote_b}` : `CV: ${c.cv_line}`}
              </p>
            </div>
          ))}
        </section>
      )}

      {rows.map((s, i) => (
        <section
          key={s.ref}
          id={`area-${s.plan_item_id}`}
          className={cn(
            "scroll-mt-10 pb-10",
            i < rows.length - 1 && "border-border mb-10 border-b",
          )}
        >
          <div className="text-foreground mb-5 flex flex-wrap items-center gap-3">
            <h3 className="text-[13px] font-medium tracking-[-0.01em]">{s.establishes}</h3>
            <StatusChip status={s.status} />
          </div>

          <Eyebrow>Evidence</Eyebrow>
          {s.evidence.length > 0 ? (
            <ul className="mb-6 flex flex-col gap-4">
              {s.evidence.map((q) => (
                <li key={q.evidence_id}>
                  <button
                    type="button"
                    onClick={() => onViewTranscript?.(s.plan_item_id, q.evidence_id)}
                    className="group block rounded-full text-left"
                    disabled={!onViewTranscript}
                  >
                    <p className="text-foreground text-[13px] leading-[1.6]">
                      <span className="hl">{q.quote}</span>
                    </p>
                    <p className="text-muted-foreground mt-1 text-[13px]">
                      {sentence(q.contract_element)}
                      {q.probe_depth ? " · after a follow-up" : ""}
                      {q.audio_start_secs != null ? ` · ${secs(q.audio_start_secs)}` : ""}
                      {onViewTranscript && (
                        <span className="ml-2 underline-offset-4 opacity-0 transition-opacity group-hover:underline group-hover:opacity-100">
                          View in transcript
                        </span>
                      )}
                    </p>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground mb-6 text-[13px]">
              Nothing was drawn for this area.
            </p>
          )}

          <div className="grid gap-6 sm:grid-cols-[1fr_1fr]">
            <div>
              <Eyebrow>Coverage</Eyebrow>
              <p className="text-foreground text-[13px] font-medium">{sentence(s.coverage_band)}</p>
              {s.probes_asked ? (
                <p className="text-muted-foreground mt-0.5 text-[13px]">
                  {s.probes_asked} follow-up{s.probes_asked === 1 ? "" : "s"} asked
                </p>
              ) : null}
            </div>
          </div>
          <div className="mt-6">
            <Eyebrow>What was established</Eyebrow>
            <p className="text-foreground/90 text-[13px] leading-[1.6]">{s.status_text}</p>
          </div>
          <div className="mt-5">
            <Eyebrow>What remains unclear</Eyebrow>
            <p className="text-foreground/90 text-[13px] leading-[1.6]">
              {s.missing_elements.length
                ? `${s.missing_elements.map(sentence).join(", ")}.`
                : s.reason
                  ? s.reason
                  : "Nothing this area asks for is missing."}
            </p>
          </div>
        </section>
      ))}

      {pkg.gaps.length > 0 && (
        <section className="border-border mb-10 border-t pt-10">
          <h3 className="text-foreground mb-3 text-[14px] font-medium tracking-[-0.01em]">
            Not reached
          </h3>
          <ul className="flex flex-col gap-1.5 text-[13px] leading-[1.6]">
            {pkg.gaps.map((g) => (
              <li key={g.ref} className="text-foreground/90">
                {g.establishes} <span className="text-muted-foreground">· {g.reason}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className={cn(pkg.gaps.length === 0 && "border-border border-t pt-10")}>
        <Eyebrow>What this does not tell you</Eyebrow>
        <ul className="text-muted-foreground flex flex-col gap-1 text-[13px] leading-[1.6]">
          {pkg.limitations.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      </section>
    </div>
  )
}

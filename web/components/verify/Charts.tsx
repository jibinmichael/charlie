"use client"

// Charts for a conversation and a verification: the areas table, the time chart and the tests matrix.

import { secs, sentence } from "@/lib/format"
import type { CallRow, PackageSignal, PlanItem, ReportPackage, Turn } from "@/lib/types"
import { cn } from "@/lib/utils"

import { toneOf } from "./Chips"
import { STATUS_ICON } from "@/components/shared/status-icon"
import { CircleDashed } from "lucide-react"

import { Eyebrow } from "./Doc"

/**
 * The picture of a conversation, drawn from the record and nothing else. The areas table reads
 * like an evaluation run: one row per area, the evaluator's word, the coverage band as a bar, how
 * many details were drawn and how many came after a follow-up, the time spent, where it starts in
 * the transcript. Bars and counts are facts made visible; there is no score.
 */
const BAND_WIDTH: Record<string, number> = {
  strong_coverage: 100,
  partial_coverage: 62,
  limited_coverage: 30,
  no_usable_evidence: 6,
}
const BAND_BAR: Record<string, string> = {
  strong_coverage: "bar-ok",
  partial_coverage: "bar-stated",
  limited_coverage: "bar-warn",
  no_usable_evidence: "bar-gap",
}
const BAND_INK: Record<string, string> = {
  strong_coverage: "ink-ok",
  partial_coverage: "ink-stated",
  limited_coverage: "ink-warn",
  no_usable_evidence: "ink-gap",
}

/** Seconds spent per area, from the canonical turns; a turn runs until the next one begins. */
export function timeByArea(
  turns: Turn[],
  items: PlanItem[],
): Map<string, { seconds: number; start: number | null }> {
  const out = new Map<string, { seconds: number; start: number | null }>()
  const ordered = [...turns].sort((a, b) => a.seq - b.seq)
  for (let i = 0; i < ordered.length; i++) {
    const t = ordered[i]!
    if (!t.plan_item_id || t.t_start == null) continue
    const next = ordered.slice(i + 1).find((n) => n.t_start != null)
    const end = t.t_end ?? next?.t_start ?? t.t_start
    const cur = out.get(t.plan_item_id) ?? { seconds: 0, start: t.t_start }
    out.set(t.plan_item_id, {
      seconds: cur.seconds + Math.max(0, end - t.t_start),
      start: cur.start ?? t.t_start,
    })
  }
  for (const it of items) if (!out.has(it.id)) out.set(it.id, { seconds: 0, start: null })
  return out
}

/** A status as a list tool shows it: the icon in its colour, then the word. */
function StatusWord({ status }: { status: string }) {
  const st = STATUS_ICON[status] ?? STATUS_ICON.not_assessed!
  return (
    <span className="text-foreground flex items-center gap-1.5 whitespace-nowrap">
      <st.icon className={cn("size-3 shrink-0", st.ink)} />
      {st.label}
    </span>
  )
}

export function AreasTable({
  pkg,
  items,
  turns,
  onOpen,
}: {
  pkg: ReportPackage
  items: PlanItem[]
  turns: Turn[]
  onOpen?: (planItemId: string) => void
}) {
  const grid: PackageSignal[] = [...pkg.capability_grid, ...(pkg.intent ? [pkg.intent] : [])]
  const byItem = new Map(grid.map((g) => [g.plan_item_id, g]))
  const time = timeByArea(turns, items)
  const contradictions = new Map<string, number>()
  for (const c of pkg.contradictions)
    if (c.ref) contradictions.set(c.ref, (contradictions.get(c.ref) ?? 0) + 1)
  const reached = items.filter((it) => byItem.has(it.id)).length
  const supported = grid.filter(
    (g) => g.status === "supported" || g.status === "strongly_supported",
  ).length
  return (
    <div>
      <div className="mb-3 flex items-baseline justify-between">
        <Eyebrow className="mb-0">Areas</Eyebrow>
        <span className="text-muted-foreground text-[12px]">
          {reached} of {items.length} reached · {supported} supported · {pkg.contradictions.length}{" "}
          statement{pkg.contradictions.length === 1 ? "" : "s"} differ
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] text-[13px] leading-[20px]">
          <thead>
            <tr className="text-muted-foreground border-border border-b text-left text-[12px]">
              <th className="w-7 py-2 pr-2 font-normal">#</th>
              <th className="min-w-[180px] py-2 pr-4 font-normal">Area</th>
              <th className="py-2 pr-4 font-normal">Reads as</th>
              <th className="w-[150px] py-2 pr-4 font-normal">Coverage</th>
              <th className="py-2 pr-4 font-normal">Details</th>
              <th className="py-2 pr-4 font-normal">Follow-ups</th>
              <th className="py-2 pr-4 font-normal">Time</th>
              <th className="py-2 text-right font-normal">From</th>
            </tr>
          </thead>
          <tbody>
            {items.map((it, i) => {
              const g = byItem.get(it.id)
              const t = time.get(it.id)
              const w = g ? (BAND_WIDTH[g.coverage_band] ?? 6) : 0
              const n = g?.evidence.length ?? 0
              const after = g?.evidence.filter((q) => q.probe_depth > 0).length ?? 0
              const diff = contradictions.get(it.ref) ?? 0
              return (
                <tr
                  key={it.id}
                  onClick={() => onOpen?.(it.id)}
                  className={cn(
                    "border-border border-b transition-colors duration-[var(--motion-fast)] last:border-b-0",
                    onOpen && "hover:bg-muted/50 cursor-pointer",
                  )}
                >
                  <td className="text-muted-foreground py-2.5 pr-2 tabular-nums">{i + 1}</td>
                  <td className="text-foreground py-2.5 pr-4">
                    {it.evidence_contract.establishes}
                    {diff ? (
                      <span className="text-status-warning ml-2 text-[12px]">
                        {diff} differ{diff === 1 ? "s" : ""}
                      </span>
                    ) : null}
                  </td>
                  <td className="py-2.5 pr-4 whitespace-nowrap">
                    {g ? (
                      <StatusWord status={g.status} />
                    ) : (
                      <span className="text-muted-foreground flex items-center gap-1.5">
                        <CircleDashed className="size-3 text-[var(--faint)]" />
                        Not reached
                      </span>
                    )}
                  </td>
                  <td className="py-2.5 pr-4">
                    <span className="flex items-center gap-2.5">
                      <span className="bg-muted relative h-1.5 w-[84px] shrink-0 overflow-hidden rounded-full">
                        <span
                          className={cn(
                            "absolute inset-y-0 left-0 rounded-full transition-[width] duration-[600ms] ease-out",
                            g?.status === "contradicted"
                              ? "bar-warn"
                              : g
                                ? (BAND_BAR[g.coverage_band] ?? "bar-gap")
                                : "bar-gap",
                          )}
                          style={{ width: `${w}%` }}
                        />
                      </span>
                      <span
                        className={cn(
                          "font-medium whitespace-nowrap",
                          g ? (BAND_INK[g.coverage_band] ?? "ink-gap") : "text-muted-foreground",
                        )}
                      >
                        {g
                          ? sentence(g.coverage_band)
                              .replace(" coverage", "")
                              .replace("No usable evidence", "None")
                          : ""}
                      </span>
                    </span>
                  </td>
                  <td className="py-2.5 pr-4">
                    <span className="flex items-center gap-2">
                      <span className="flex items-center gap-[3px]">
                        {Array.from({ length: n }, (_, k) => (
                          <span
                            key={k}
                            className={cn(
                              "h-2.5 w-2.5 rounded-[2px]",
                              k < n - after ? "bar-ok" : "bar-stated",
                            )}
                          />
                        ))}
                      </span>
                      <span className="text-muted-foreground tabular-nums">{n}</span>
                    </span>
                  </td>
                  <td className="text-muted-foreground py-2.5 pr-4 tabular-nums">
                    {g?.probes_asked ?? 0}
                  </td>
                  <td className="text-muted-foreground py-2.5 pr-4 whitespace-nowrap tabular-nums">
                    {t && t.seconds
                      ? t.seconds >= 60
                        ? `${Math.round(t.seconds / 60)} min`
                        : `${t.seconds} s`
                      : ""}
                  </td>
                  <td className="text-muted-foreground py-2.5 text-right tabular-nums">
                    {t?.start != null ? secs(t.start) : ""}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <p className="text-muted-foreground/70 mt-2 text-[12px]">
        Details: green squares came in the first answer, indigo ones after a follow-up. Coverage is
        the evaluator&apos;s band, made visible; nothing here is a score.
      </p>
    </div>
  )
}

export function TimeChart({ turns, items }: { turns: Turn[]; items: PlanItem[] }) {
  const time = timeByArea(turns, items)
  const rows = items.map((item) => ({ item, seconds: Math.round(time.get(item.id)?.seconds ?? 0) }))
  const total = rows.reduce((a, r) => a + r.seconds, 0)
  if (!total) return null
  return (
    <div>
      <Eyebrow>Where the time went</Eyebrow>
      <div className="bg-muted flex h-2 w-full overflow-hidden rounded-full">
        {rows.map(({ item, seconds }, i) => (
          <span
            key={item.id}
            data-tip={`${item.evidence_contract.establishes}: ${Math.round(seconds / 60)} min`}
            className={cn(
              "h-full transition-[width] duration-[600ms] ease-out",
              ["bar-ok", "bar-stated", "bar-warn", "bar-gap"][i % 4],
            )}
            style={{ width: `${(seconds / total) * 100}%` }}
          />
        ))}
      </div>
      <ol className="mt-2.5 flex flex-wrap gap-x-5 gap-y-1 text-[12px]">
        {rows.map(({ item, seconds }, i) => (
          <li key={item.id} className="text-muted-foreground flex items-center gap-1.5">
            <span
              className={cn(
                "inline-block size-2 rounded-sm",
                ["bar-ok", "bar-stated", "bar-warn", "bar-gap"][i % 4],
              )}
            />
            {item.evidence_contract.establishes} ·{" "}
            {seconds >= 60 ? `${Math.round(seconds / 60)} min` : `${seconds} s`}
          </li>
        ))}
      </ol>
    </div>
  )
}

/**
 * Tests against areas, for the verification page: does the verification hold across role-plays?
 * One row per test session, one column per area, the evaluator's word in each cell.
 */
const SHORT: Record<string, string> = {
  strongly_supported: "strong",
  supported: "supported",
  stated_only: "stated",
  contradicted: "differs",
  insufficient: "insufficient",
  not_assessed: "Not reached",
}
export function TestsMatrix({
  tests,
  items,
  hrefFor,
}: {
  tests: CallRow[]
  items: PlanItem[]
  hrefFor: (t: CallRow) => string
}) {
  const evaluated = tests.filter((t) => t.summary?.evaluated)
  if (!evaluated.length) return null
  const byRef = (t: CallRow, ref: string) =>
    t.summary.items.find((i) => i.ref === ref)?.status ?? null
  const label = (t: CallRow) =>
    typeof t.conditions?.label === "string" && t.conditions.label ? t.conditions.label : "Test"
  return (
    <div>
      <Eyebrow>How it held up across tests</Eyebrow>
      <div className="overflow-x-auto">
        <table className="w-full text-[13px] leading-[20px]">
          <thead>
            <tr className="text-muted-foreground border-border border-b text-left text-[12px]">
              <th className="py-2 pr-4 font-normal">Test</th>
              {items.map((it) => (
                <th key={it.id} className="max-w-[140px] py-2 pr-4 font-normal">
                  <span className="line-clamp-2">{it.evidence_contract.establishes}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {evaluated.map((t) => (
              <tr key={t.id} className="border-border border-b last:border-b-0">
                <td className="py-2.5 pr-4">
                  <a
                    href={hrefFor(t)}
                    className="text-foreground"
                  >
                    {label(t)}
                  </a>
                </td>
                {items.map((it) => {
                  const st = byRef(t, it.ref)
                  const good = st === "supported" || st === "strongly_supported"
                  void good
                  return (
                    <td key={it.id} className="py-2.5 pr-4">
                      {st ? (
                        <span
                          className={cn(
                            "inline-flex h-[22px] items-center rounded-md px-2 text-[12px] font-medium",
                            toneOf(st).ink,
                            toneOf(st).field,
                          )}
                        >
                          {SHORT[st] ?? sentence(st)}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">·</span>
                      )}
                    </td>
                  )
                })}
              </tr>
            ))}
            <tr className="text-muted-foreground text-[12px]">
              <td className="pt-2.5 pr-4">supported in</td>
              {items.map((it) => {
                const n = evaluated.filter((t) =>
                  ["supported", "strongly_supported"].includes(byRef(t, it.ref) ?? ""),
                ).length
                return (
                  <td key={it.id} className="pt-2.5 pr-4 tabular-nums">
                    {n} of {evaluated.length}
                  </td>
                )
              })}
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  )
}

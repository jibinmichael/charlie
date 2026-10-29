// Status chips for evidence statuses and session states.
import { cn } from "@/lib/utils"
import { sentence } from "@/lib/format"

/**
 * The six statuses in one chip grammar: filled green dot for strongly_supported and supported
 * (the second lighter), grey dot for stated_only, amber dot for contradicted, a hollow ring for
 * insufficient and not_assessed. The text beside the dot is the status word, spaced. Never a number.
 */
const TONE: Record<string, { ink: string; field: string; label: string }> = {
  strongly_supported: { ink: "ink-ok", field: "field-ok", label: "Strongly supported" },
  supported: { ink: "ink-ok", field: "field-ok", label: "Supported" },
  stated_only: { ink: "ink-stated", field: "field-stated", label: "Stated only" },
  contradicted: { ink: "ink-warn", field: "field-warn", label: "Contradicted" },
  insufficient: { ink: "ink-gap", field: "field-gap", label: "Insufficient" },
  not_assessed: { ink: "ink-gap", field: "field-gap", label: "Not assessed" },
}
export const toneOf = (status: string | null | undefined) =>
  status ? (TONE[status] ?? TONE.not_assessed!) : TONE.not_assessed!

/** One of the six statuses in its colour: deep ink on a soft field. `quiet` drops the field. */
export function StatusChip({
  status,
  className,
  quiet,
}: {
  status: string | null
  className?: string
  quiet?: boolean
}) {
  if (!status)
    return <span className={cn("text-muted-foreground text-[12px]", className)}>not yet</span>
  const t = toneOf(status)
  return (
    <span
      className={cn(
        "inline-flex h-[22px] items-center rounded-full px-2 text-[12px] font-medium whitespace-nowrap",
        t.ink,
        !quiet && t.field,
        className,
      )}
    >
      {t.label}
    </span>
  )
}

/** A coloured dot for a list. */
export function StatusDot({ status, title }: { status: string | null; title?: string }) {
  const t = status ? toneOf(status) : null
  return (
    <span
      data-tip={title}
      aria-label={title}
      className={cn(
        "inline-block size-2 squircle",
        t ? `bg-current ${t.ink}` : "border-border border",
      )}
    />
  )
}

const SESSION: Record<string, { label: string; ink: string; field: string }> = {
  invited: { label: "Not started", ink: "ink-gap", field: "field-gap" },
  consented: { label: "Not started", ink: "ink-gap", field: "field-gap" },
  in_progress: { label: "In the call", ink: "ink-charlie", field: "field-charlie" },
  completed: { label: "Processing", ink: "ink-stated", field: "field-stated" },
  transcript_ready: { label: "Processing", ink: "ink-stated", field: "field-stated" },
  evidence_ready: { label: "Processing", ink: "ink-stated", field: "field-stated" },
  evaluated: { label: "Ready to review", ink: "ink-warn", field: "field-warn" },
  awaiting_review: { label: "Ready to review", ink: "ink-warn", field: "field-warn" },
  blocked: { label: "Held for review", ink: "ink-warn", field: "field-warn" },
  reviewed: { label: "Reviewed", ink: "ink-ok", field: "field-ok" },
  reported: { label: "Done", ink: "ink-ok", field: "field-ok" },
  declined: { label: "Declined", ink: "ink-gap", field: "field-gap" },
  unreachable: { label: "Unreachable", ink: "ink-gap", field: "field-gap" },
  expired: { label: "Expired", ink: "ink-gap", field: "field-gap" },
  abandoned: { label: "Abandoned", ink: "ink-gap", field: "field-gap" },
}

export function SessionChip({ state, className }: { state: string; className?: string }) {
  const t = SESSION[state] ?? { label: sentence(state), ink: "ink-gap", field: "field-gap" }
  return (
    <span
      className={cn(
        "inline-flex h-[22px] items-center rounded-full px-2 text-[12px] font-medium whitespace-nowrap",
        t.ink,
        t.field,
        className,
      )}
    >
      {t.label}
    </span>
  )
}

export function KindBanner({ kind }: { kind: string }) {
  if (kind !== "test") return null
  return (
    <p className="text-muted-foreground text-[13px] leading-[1.6]">
      A test, run by the hiring team on the exact conversation a candidate gets. Nothing here
      touches candidate data.
    </p>
  )
}

// A transcript speaker row: the timestamp and the speaker's name in its colour.
import { cn } from "@/lib/utils"

/**
 * Who is speaking, the way a meeting transcript shows it: the time in grey, then the name in
 * its colour. Charlie is violet; the person is green.
 */
export function SpeakerRow({
  who,
  name,
  time,
  muted,
  className,
}: {
  who: "agent" | "candidate"
  name?: string
  time?: string
  muted?: boolean
  className?: string
}) {
  const label = name ?? (who === "agent" ? "Charlie" : "You")
  const ink = who === "agent" ? "ink-charlie" : "ink-ok"
  return (
    <div className={cn("flex items-center gap-2.5", className, muted && "opacity-90")}>
      {time && <span className="text-muted-foreground w-10 text-[13px] tabular-nums">{time}</span>}
      <span className={cn("text-[13px] font-medium", ink)}>{label}</span>
    </div>
  )
}

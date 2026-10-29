// The round Charlie mark, with an optional working halo.
import { cn } from "@/lib/utils"

/**
 * The mark: a round ink disc with the glyph. Static everywhere, except that while the system is
 * working on something the conic halo spins behind it. No mood, no animation of
 * the glyph itself; state lives in chips.
 */
export function Mark({
  size = 20,
  working = false,
  className,
}: {
  size?: number
  working?: boolean
  className?: string
}) {
  return (
    <span
      className={cn("relative inline-flex shrink-0", className)}
      style={{ width: size, height: size }}
      aria-hidden
    >
      {working && <span className="halo" />}
      <span
        className="bg-foreground text-background relative z-10 flex items-center justify-center squircle leading-none font-medium"
        style={{ width: size, height: size, fontSize: Math.round(size * 0.55) }}
      >
        C
      </span>
    </span>
  )
}

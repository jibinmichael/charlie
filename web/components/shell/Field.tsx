// Form field layout and the shared input class.
import { cn } from "@/lib/utils"

export const INPUT =
  "border-border bg-card text-foreground placeholder:text-muted-foreground/60 h-9 w-full rounded-lg border px-3 text-[13px] outline-none transition-[box-shadow,border-color] duration-[var(--motion-fast)] focus-visible:border-vibe-1/60 focus-visible:ring-[3px] focus-visible:ring-vibe-1/15"

/** Label above, control, one optional helper line below. Required is a quiet mark, not a red star. */
export function Field({
  label,
  required,
  helper,
  htmlFor,
  className,
  children,
}: {
  label: string
  required?: boolean
  helper?: React.ReactNode
  htmlFor?: string
  className?: string
  children: React.ReactNode
}) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <label htmlFor={htmlFor} className="text-foreground/80 text-[12px] font-medium">
        {label}
        {required && <span className="text-muted-foreground font-normal"> · required</span>}
      </label>
      {children}
      {helper && <p className="text-muted-foreground text-[11px] leading-[1.5]">{helper}</p>}
    </div>
  )
}

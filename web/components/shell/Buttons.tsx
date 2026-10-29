// The two shared buttons: primary and secondary.
import { cn } from "@/lib/utils"

/**
 * Two buttons, so every action reads the same. Primary is near-black text on the page's ink,
 * dimmed while not ready. Secondary is plain text with an underline on hover. No gradients, no
 * halos; a working state is the label changing.
 */
export function PrimaryButton({
  ready = true,
  busy = false,
  size = "sm",
  className,
  children,
  ...rest
}: {
  ready?: boolean
  busy?: boolean
  size?: "sm" | "md"
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      disabled={!ready || busy}
      className={cn(
        "bg-foreground text-background rounded-md px-4 text-[14px] font-medium transition-opacity duration-[var(--motion-fast)] disabled:cursor-default disabled:opacity-40",
        size === "sm" ? "h-8" : "h-9",
        !busy && ready && "hover:opacity-90",
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  )
}

export function SecondaryButton({
  size = "sm",
  tone = "neutral",
  className,
  children,
  ...rest
}: {
  size?: "sm" | "md"
  tone?: "neutral" | "danger"
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={cn(
        "rounded-md px-3 text-[14px] transition-colors duration-[var(--motion-fast)] disabled:cursor-default disabled:opacity-40",
        size === "sm" ? "h-8" : "h-9",
        tone === "danger"
          ? "text-status-error hover:bg-status-error-soft"
          : "text-foreground hover:bg-muted",
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  )
}

// Small shared pieces: loading hairline, empty states, error lines and headings.
import { LinearIcon, type LinearIconName } from "@/components/shared/LinearIcon"
import { cn } from "@/lib/utils"

/** Loading is a 1px gradient hairline sweeping across, never a spinner. */
export function Hairline({ className }: { className?: string }) {
  return (
    <div aria-hidden className={cn("bg-border relative h-px w-full overflow-hidden", className)}>
      <div className="hairline-vibe absolute inset-y-0 w-1/3 animate-[hairline-sweep_1.4s_ease-in-out_infinite]" />
    </div>
  )
}

/** Empty states: an icon in a ring, one sentence, at most one action. Never an illustration. */
export function EmptyState({
  icon = "document",
  children,
  action,
}: {
  icon?: LinearIconName
  children: React.ReactNode
  action?: React.ReactNode
}) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-14 text-center">
      <span className="border-border bg-card flex size-10 items-center justify-center squircle border">
        <LinearIcon name={icon} className="text-muted-foreground size-4" />
      </span>
      <p className="text-muted-foreground max-w-md text-[13px] leading-[1.6]">{children}</p>
      {action}
    </div>
  )
}

/** A quiet one-line empty message inside a section. */
export function EmptyLine({ children }: { children: React.ReactNode }) {
  return <p className="text-muted-foreground px-1 py-6 text-[13px] leading-[1.6]">{children}</p>
}

/** Errors are one line, the server's words. */
export function ErrorLine({ children }: { children: React.ReactNode }) {
  return (
    <p role="alert" className="text-status-error px-1 py-3 text-[13px] leading-[1.6]">
      {children}
    </p>
  )
}

export function H1({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <h1 className={cn("text-[15px] leading-[24px] tracking-[-0.015em]", className)}>
      {children}
    </h1>
  )
}

export function H2({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <h2 className={cn("text-[13px] font-medium tracking-[-0.005em]", className)}>{children}</h2>
  )
}

/** Section label: 11px, semibold, uppercase, muted. */
export function Label({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <h3
      className={cn(
        "text-muted-foreground text-[11px] font-medium tracking-[0.01em] uppercase",
        className,
      )}
    >
      {children}
    </h3>
  )
}

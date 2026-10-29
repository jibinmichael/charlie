// Document layout primitives shared by the verification pages: column, title, tabs, sections, row links and pills.
import Link from "next/link"

import { cn } from "@/lib/utils"

/** The document: one column, generous margins, nothing boxed. */
export function Doc({
  children,
  className,
  wide = false,
}: {
  children: React.ReactNode
  className?: string
  wide?: boolean
}) {
  return (
    <article
      className={cn(
        "mx-auto w-full px-10 pt-10 pb-28",
        wide ? "max-w-[840px]" : "max-w-[720px]",
        className,
      )}
    >
      {children}
    </article>
  )
}

export function DocTitle({
  children,
  kicker,
  sub,
}: {
  children: React.ReactNode
  kicker?: React.ReactNode
  sub?: React.ReactNode
}) {
  return (
    <header className="mb-10">
      {kicker && <div className="text-muted-foreground mb-3 text-[13px]">{kicker}</div>}
      <h1 className="text-foreground text-[15px] leading-[24px] tracking-[-0.02em]">
        {children}
      </h1>
      {sub && <div className="text-muted-foreground mt-2 text-[14px] leading-[1.6]">{sub}</div>}
    </header>
  )
}

/** Label in grey on the left, value on the right. Text, not a table. */
export function MetaRows({ rows }: { rows: { label: string; value: React.ReactNode }[] }) {
  return (
    <dl className="mb-8 grid grid-cols-[132px_1fr] gap-x-6 gap-y-2 text-[14px]">
      {rows.map((r) => (
        <div key={r.label} className="contents">
          <dt className="text-muted-foreground py-1">{r.label}</dt>
          <dd className="text-foreground flex min-w-0 items-center gap-2 py-1">{r.value}</dd>
        </div>
      ))}
    </dl>
  )
}

/** A segmented control: one grey field, the active segment raised in white. */
export function Tabs<T extends string>({
  value,
  options,
  onChange,
  className,
}: {
  value: T
  options: readonly { key: T; label: string }[]
  onChange: (v: T) => void
  className?: string
}) {
  return (
    <div
      className={cn(
        "bg-muted mb-8 inline-flex h-8 items-center rounded-[var(--radius-control)] p-[3px]",
        className,
      )}
    >
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          onClick={() => onChange(o.key)}
          className={cn(
            "flex h-full items-center rounded-[var(--radius-chip)] px-3 text-[13px] leading-[20px] transition-all duration-[var(--motion-fast)]",
            value === o.key
              ? "bg-card text-foreground font-medium shadow-[0_1px_2px_rgba(0,0,0,0.06),0_0_0_1px_rgba(0,0,0,0.03)]"
              : "text-muted-foreground hover:text-foreground hover:bg-white/60 active:bg-white/80",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Section({
  title,
  right,
  children,
  className,
}: {
  title: React.ReactNode
  right?: React.ReactNode
  children: React.ReactNode
  className?: string
}) {
  return (
    <section className={cn("mb-12", className)}>
      <div className="mb-4 flex items-baseline justify-between gap-4">
        <h2 className="text-foreground text-[14px] font-medium tracking-[-0.01em]">{title}</h2>
        {right}
      </div>
      {children}
    </section>
  )
}

/** A row you can open: title, a grey line, something quiet on the right. */
export function RowLink({
  href,
  title,
  meta,
  right,
  active,
}: {
  href: string
  title: React.ReactNode
  meta?: React.ReactNode
  right?: React.ReactNode
  active?: boolean
}) {
  return (
    <Link
      href={href}
      data-link="block"
      className={cn(
        "-mx-3 flex items-center gap-4 rounded-md px-3 py-2.5 transition-colors duration-[var(--motion-fast)]",
        active ? "bg-muted/70" : "hover:bg-muted/50",
      )}
    >
      <span className="min-w-0 flex-1">
        <span className="text-foreground block truncate text-[13px] leading-[20px]">{title}</span>
        {meta && <span className="text-muted-foreground block truncate text-[13px]">{meta}</span>}
      </span>
      {right}
    </Link>
  )
}

/** A status shown as quiet muted text (deliberately not a coloured pill). */
export function Pill({ children, className }: { children: React.ReactNode; className?: string }) {
  return <span className={cn("text-muted-foreground text-[14px]", className)}>{children}</span>
}

/** A small grey label above a block. Sentence case, never uppercase. */
export function Eyebrow({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn("text-muted-foreground mb-1.5 text-[12px] font-medium", className)}>
      {children}
    </div>
  )
}

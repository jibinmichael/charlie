"use client"

// The attached dropdown and panel: a trigger and its list or panel drawn as one shape.

import { Check, ChevronDown } from "lucide-react"
import { useEffect, useRef, useState } from "react"

import { cn } from "@/lib/utils"

/**
 * Every button is fully rounded: a pill, or a circle when it is
 * square. Every button in the workspace uses this, so the shape is decided here once. Circles (avatars, dots, marks)
 * use the .squircle class in app/globals.css, which is round too.
 */
// SQUIRCLE is the fully rounded shape (the name is historical). An open dropdown still squares the trigger's bottom to
// meet its list.
export const SQUIRCLE = "rounded-full"

/**
 * THE dropdown for a labelled trigger (the trigger shows the current value and the list belongs to
 * it). Open, trigger and list are ONE shape: the trigger keeps its rounded top and squares its
 * bottom, the list hangs flush beneath it at the same width with square top corners and rounded
 * bottom ones, a hairline divides them, one soft shadow wraps both. No gap, ever.
 *
 * Every dropdown uses this component; nothing redraws the shape by hand. An icon-only trigger (sort,
 * more) uses variant "icon": the same attached shape, the list hanging flush beneath the squircle
 * trigger and right-aligned to it, its top corner under the trigger square. A panel that is not a list
 * (the filter panel) uses AttachedPanel below: the same shape, never a floating Popover.
 */
export type DropdownOption = { value: string; label: string }

// Charlie's colour system (app/globals.css --c-*): the hairline, the text, supporting text, and the brand for what is
// selected. A field is white with the hairline, never a grey fill.
const LINE = "var(--c-line)"
const INK = "var(--c-text)"
const MUTED = "var(--c-muted)"
const ACCENT = "var(--c-brand-ink)"
const ACCENT_DOT = "var(--c-brand-dot)"
const SURFACE = "var(--c-surface)"
const HOVER = "var(--c-hover)"

export function AttachedDropdown({
  value,
  options,
  onChange,
  icon,
  variant = "pill",
  minWidth = 240,
  fullWidth = false,
  firstIsChoice = false,
  ariaLabel,
}: {
  value: string
  options: DropdownOption[]
  onChange: (value: string) => void
  /** A leading icon in the trigger, coloured by the caller; for variant "icon", the whole trigger. */
  icon?: React.ReactNode
  /** pill: a white squircle button (toolbars). field: a white control with the hairline (forms, panels).
   *  icon: a round icon-only trigger; the list floats beneath it, right-aligned, minWidth wide. */
  variant?: "pill" | "field" | "icon"
  /** The open width when the trigger is narrower; the trigger grows to it so the two stay one shape. */
  minWidth?: number
  /** Fill the parent's width (forms), so opening never changes the width. */
  fullWidth?: boolean
  /** The first option is a real choice (e.g. "Must have"), not "nothing chosen", so it never reads muted. */
  firstIsChoice?: boolean
  ariaLabel?: string
}) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const box = useRef<HTMLDivElement | null>(null)
  const current = options.find((o) => o.value === value) ?? options[0]
  // the first option is the "nothing chosen" one; its label reads muted in the trigger
  const unset = !firstIsChoice && current?.value === options[0]?.value

  useEffect(() => {
    if (!open) return
    const down = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", down)
    return () => document.removeEventListener("mousedown", down)
  }, [open])

  const choose = (v: string) => {
    onChange(v)
    setOpen(false)
  }
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") return setOpen(false)
    if (!open && (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ")) {
      e.preventDefault()
      setActive(
        Math.max(
          0,
          options.findIndex((o) => o.value === value),
        ),
      )
      return setOpen(true)
    }
    if (!open) return
    if (e.key === "ArrowDown") {
      e.preventDefault()
      setActive((i) => Math.min(options.length - 1, i + 1))
    }
    if (e.key === "ArrowUp") {
      e.preventDefault()
      setActive((i) => Math.max(0, i - 1))
    }
    if (e.key === "Enter") {
      e.preventDefault()
      const o = options[active]
      if (o) choose(o.value)
    }
  }

  const edge = `inset 1px 0 0 ${LINE}, inset -1px 0 0 ${LINE}`
  const iconOnly = variant === "icon"
  const field = variant === "field"
  const h = field ? "h-8 text-[13px]" : "h-7 text-[12px]"
  const radius = field ? 10 : 14

  return (
    <div
      ref={box}
      className={cn("relative", open && "z-50", fullWidth ? "w-full" : "inline-block")}
      onKeyDown={onKey}
    >
      {iconOnly ? (
        <button
          type="button"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-label={ariaLabel}
          onClick={() => {
            setActive(
              Math.max(
                0,
                options.findIndex((o) => o.value === value),
              ),
            )
            setOpen((o) => !o)
          }}
          className={cn("flex size-7 items-center justify-center text-[var(--c-text-2)] hover:bg-[var(--c-hover)]", SQUIRCLE)}
          // open, the trigger joins the list: white, rounded top, square bottom, the same edge
          style={open ? { background: SURFACE, borderRadius: "10px 10px 0 0", boxShadow: `${edge}, inset 0 1px 0 ${LINE}` } : undefined}
        >
          {icon}
        </button>
      ) : (
        <button
          type="button"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-label={ariaLabel}
          onClick={() => {
            setActive(
              Math.max(
                0,
                options.findIndex((o) => o.value === value),
              ),
            )
            setOpen((o) => !o)
          }}
          className={cn("flex w-full items-center gap-1.5 px-3 text-left", SQUIRCLE, h)}
          style={{
            minWidth: open && !fullWidth ? minWidth : undefined,
            color: unset && field ? MUTED : INK,
            background: SURFACE,
            borderRadius: open ? `${radius}px ${radius}px 0 0` : 10,
            boxShadow: open
              ? `${edge}, inset 0 1px 0 ${LINE}, 0 10px 24px -14px rgba(15,14,22,0.22)`
              : `inset 0 0 0 1px ${LINE}`,
          }}
        >
          {icon}
          <span className="min-w-0 flex-1 truncate">{current?.label}</span>
          <ChevronDown
            className={cn("size-3 shrink-0 transition-transform", open && "rotate-180")}
            style={{ color: MUTED }}
          />
        </button>
      )}
      {open && (
        <div
          role="listbox"
          className={cn(
            "absolute top-full max-h-[280px] overflow-y-auto bg-white px-1 pb-1",
            iconOnly ? "right-0 pt-1" : "right-0 left-0",
          )}
          style={{
            width: iconOnly ? minWidth : undefined,
            // icon: flush beneath the trigger, the corner under it square (top-left, top-right, bottom-right, bottom-left)
            borderRadius: iconOnly ? "14px 0 14px 14px" : `0 0 ${radius}px ${radius}px`,
            boxShadow: iconOnly
              ? `inset 0 0 0 1px ${LINE}, 0 14px 28px -12px rgba(15,14,22,0.24)`
              : `${edge}, inset 0 -1px 0 ${LINE}, 0 14px 28px -12px rgba(15,14,22,0.24)`,
          }}
        >
          {!iconOnly && <span className="mx-2 mb-1 block h-px" style={{ background: LINE }} />}
          {options.map((o, i) => (
            <button
              key={o.value}
              type="button"
              role="option"
              aria-selected={o.value === value}
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(o.value)}
              className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-[13px] leading-[20px]"
              style={{ color: INK, background: i === active ? HOVER : undefined }}
            >
              <span className="truncate">{o.label}</span>
              {o.value === value && (
                <Check className="size-3 shrink-0" style={{ color: ACCENT }} />
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * A panel that belongs to an icon trigger (the filter panel): the dropdown's attached shape for content
 * that is not a list. Open, the squircle trigger squares its bottom and the panel hangs flush beneath
 * it, left-aligned, the corner under the trigger square, one hairline and one shadow around both.
 * Closes on outside click and Escape. Never a floating Popover.
 */
export function AttachedPanel({
  open,
  onOpenChange,
  icon,
  label,
  align = "left",
  ariaLabel,
  width = 440,
  dot = false,
  primary = false,
  children,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  icon: React.ReactNode
  /** With a label the trigger is a labelled squircle button (white, h-7) with a chevron; without, icon-only. */
  label?: React.ReactNode
  /** Which edge the panel lines up with; the corner on that side, under the trigger, is square. */
  align?: "left" | "right"
  ariaLabel: string
  width?: number
  /** A small accent dot on the trigger, e.g. while filters are applied. */
  dot?: boolean
  /** A labelled trigger that is the page's primary action: lime with ink, Medium, as the Inbox's primary button. */
  primary?: boolean
  children: React.ReactNode
}) {
  const box = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!open) return
    const down = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) onOpenChange(false)
    }
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onOpenChange(false)
    }
    document.addEventListener("mousedown", down)
    document.addEventListener("keydown", key)
    return () => {
      document.removeEventListener("mousedown", down)
      document.removeEventListener("keydown", key)
    }
  }, [open, onOpenChange])
  const edge = `inset 1px 0 0 ${LINE}, inset -1px 0 0 ${LINE}`
  return (
    <div ref={box} className={cn("relative inline-block", open && "z-50")}>
      <button
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
        className={cn(
          "relative flex items-center",
          label
            ? cn("h-7 gap-1.5 px-3 text-[13px]", primary ? "font-medium" : "bg-white")
            : "size-7 justify-center text-[var(--c-text-2)] hover:bg-[var(--c-hover)]",
          SQUIRCLE,
        )}
        style={
          open
            ? { background: SURFACE, color: INK, borderRadius: "10px 10px 0 0", boxShadow: `${edge}, inset 0 1px 0 ${LINE}` }
            : label
              ? primary
                ? { background: "var(--c-brand)", color: INK }
                : { color: INK, boxShadow: `inset 0 0 0 1px ${LINE}` }
              : undefined
        }
      >
        {icon}
        {label}
        {label && (
          <ChevronDown
            className={cn("size-3 shrink-0 transition-transform", open && "rotate-180")}
            style={{ color: MUTED }}
          />
        )}
        {dot && (
          <span className="absolute top-1 right-1 size-1.5 squircle" style={{ background: ACCENT_DOT }} />
        )}
      </button>
      {open && (
        <div
          role="dialog"
          aria-label={ariaLabel}
          className={cn("absolute top-full bg-white", align === "left" ? "left-0" : "right-0")}
          style={{
            width,
            borderRadius: align === "left" ? "0 14px 14px 14px" : "14px 0 14px 14px",
            boxShadow: `inset 0 0 0 1px ${LINE}, 0 14px 28px -12px rgba(15,14,22,0.24)`,
          }}
        >
          {children}
        </div>
      )}
    </div>
  )
}

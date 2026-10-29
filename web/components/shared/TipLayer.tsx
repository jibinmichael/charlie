"use client"

/**
 * The product's one tooltip, drawn by the app instead of the browser's native `title` tooltip.
 *
 * Mounted once (app/layout.tsx). It shows for:
 *   - any element with `data-tip="..."` (use it instead of a native `title`), and
 *   - truncated text that is actually cut off (`.truncate`, or any element whose text overflows), showing its full
 *     text, so a clipped name or reason is always readable.
 * Ink background, white 12px text, at most 280px wide, above the element (below when there is no room), kept inside
 * the window. It never blocks a click, and it hides on scroll, on leaving, and on Escape.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"

type Tip = { text: string; x: number; y: number; below: boolean }

const DELAY_MS = 300

function tipFor(target: EventTarget | null): { el: HTMLElement; text: string } | null {
  if (!(target instanceof Element)) return null
  // an element (and what is inside it) that asks for no tooltip gets none, even when its text is cut off
  if (target.closest("[data-tip-off]")) return null
  const tagged = target.closest<HTMLElement>("[data-tip]")
  if (tagged?.dataset.tip) return { el: tagged, text: tagged.dataset.tip }
  // truncated text: the nearest element whose own text is cut off
  const cut = target.closest<HTMLElement>(".truncate, [data-truncate]")
  if (cut && cut.scrollWidth > cut.clientWidth + 1) {
    const text = (cut.textContent ?? "").trim()
    if (text) return { el: cut, text }
  }
  return null
}

export function TipLayer() {
  const [tip, setTip] = useState<Tip | null>(null)
  const timer = useRef<number | null>(null)
  const current = useRef<HTMLElement | null>(null)
  // the tip's own width, measured once it is drawn, so a short tip near an edge stays over its element instead of
  // being clamped as if it were the full 280px wide
  const box = useRef<HTMLDivElement | null>(null)
  const [width, setWidth] = useState<number | null>(null)
  useLayoutEffect(() => {
    if (tip && box.current) setWidth(box.current.offsetWidth)
  }, [tip])

  useEffect(() => {
    const clear = () => {
      if (timer.current) window.clearTimeout(timer.current)
      timer.current = null
      current.current = null
      setTip(null)
    }
    const show = (e: Event) => {
      const found = tipFor(e.target)
      if (!found) return
      // a click focuses too: only keyboard focus shows a tip at once, never a mouse click
      if (e.type === "focusin" && !(e.target as Element).matches(":focus-visible")) return
      if (found.el === current.current) return
      clear()
      current.current = found.el
      timer.current = window.setTimeout(() => {
        const r = found.el.getBoundingClientRect()
        const below = r.top < 56
        setTip({ text: found.text, x: r.left + r.width / 2, y: below ? r.bottom + 8 : r.top - 8, below })
      }, e.type === "focusin" ? 0 : DELAY_MS)
    }
    const hide = (e: Event) => {
      const el = current.current
      const to = (e as PointerEvent).relatedTarget
      if (el && to instanceof Node && el.contains(to)) return
      clear()
    }
    const key = (e: KeyboardEvent) => e.key === "Escape" && clear()
    document.addEventListener("pointerover", show)
    document.addEventListener("pointerout", hide)
    document.addEventListener("focusin", show)
    document.addEventListener("focusout", clear)
    document.addEventListener("pointerdown", clear)
    document.addEventListener("keydown", key)
    window.addEventListener("scroll", clear, true)
    return () => {
      document.removeEventListener("pointerover", show)
      document.removeEventListener("pointerout", hide)
      document.removeEventListener("focusin", show)
      document.removeEventListener("focusout", clear)
      document.removeEventListener("pointerdown", clear)
      document.removeEventListener("keydown", key)
      window.removeEventListener("scroll", clear, true)
      if (timer.current) window.clearTimeout(timer.current)
    }
  }, [])

  if (!tip || typeof document === "undefined") return null
  // kept inside the window: centred on the element, clamped 8px from either side
  const half = (width ?? 280) / 2
  const left = Math.min(Math.max(tip.x, half + 8), window.innerWidth - half - 8)
  return createPortal(
    <div
      ref={box}
      role="tooltip"
      className="pointer-events-none fixed z-[1000] max-w-[280px] rounded-lg px-2 py-1 text-[12px] leading-[17px] break-words whitespace-pre-line"
      style={{
        left,
        top: tip.y,
        transform: `translate(-50%, ${tip.below ? "0" : "-100%"})`,
        background: "#2f2f27", // a warm near-black
        color: "#ffffff",
        boxShadow: "0 6px 20px rgba(15,14,22,0.18)",
        fontFamily: "var(--font-sans)",
      }}
    >
      {tip.text}
    </div>,
    document.body,
  )
}

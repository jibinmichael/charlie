"use client"

// A company logo tile for the DOM: the favicon mark, or a monogram when there is none.

import { useEffect, useRef, useState } from "react"

import { cn } from "@/lib/utils"

import { isPlaceholder, logoUrl, monogram } from "./logo"

/** The mark where a domain is known, a monogram otherwise. */
export function LogoTile({
  name,
  domain,
  size = 10,
  className,
}: {
  name: string
  domain?: string | undefined
  size?: number
  className?: string
}) {
  const [failed, setFailed] = useState(false)
  const img = useRef<HTMLImageElement | null>(null)
  // a server-rendered image can fail before the page is interactive, so its onError never fires; read it once
  // mounted, so a missing mark still falls back to the monogram
  useEffect(() => {
    const el = img.current
    if (el && el.complete && el.naturalWidth === 0) setFailed(true)
  }, [domain])
  if (isPlaceholder(name)) return null
  const m = monogram(name)
  const style = { width: size, height: size }
  if (domain && !failed)
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        ref={img}
        src={logoUrl(domain)}
        alt=""
        width={size}
        height={size}
        onError={() => setFailed(true)}
        style={style}
        className={cn(
          "shrink-0 rounded-full bg-white object-cover shadow-[inset_0_0_0_1px_rgba(0,0,0,0.08)]",
          className,
        )}
      />
    )
  return (
    <span
      aria-hidden
      style={{ ...style, background: m.field, color: m.ink, fontSize: Math.round(size * 0.55) }}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full shadow-[inset_0_0_0_1px_rgba(0,0,0,0.08)]",
        className,
      )}
    >
      {m.letter}
    </span>
  )
}

/**
 * Inline annotation: split a candidate turn's text into segments, marking the spans that are
 * evidence quotes. The quote is verbatim by construction (the server drops any that is not), so a
 * whitespace-tolerant, case-insensitive search finds it. Overlaps keep the first quote; a quote that
 * cannot be located (it should not happen) is simply not marked, never invented.
 */
import type { Evidence } from "./types"

export type Segment = { text: string; evidence?: Evidence }

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
const norm = (s: string) => s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"')

export function annotate(text: string, evidence: Evidence[]): Segment[] {
  const t = norm(text)
  const ranges: { start: number; end: number; evidence: Evidence }[] = []
  for (const e of evidence) {
    const q = norm(e.quote).trim()
    if (!q) continue
    const pattern = q.split(/\s+/).map(esc).join("\\s+")
    const m = new RegExp(pattern, "i").exec(t)
    if (!m) continue
    const start = m.index
    const end = start + m[0].length
    if (ranges.some((r) => start < r.end && end > r.start)) continue
    ranges.push({ start, end, evidence: e })
  }
  ranges.sort((a, b) => a.start - b.start)
  const out: Segment[] = []
  let i = 0
  for (const r of ranges) {
    if (r.start > i) out.push({ text: text.slice(i, r.start) })
    out.push({ text: text.slice(r.start, r.end), evidence: r.evidence })
    i = r.end
  }
  if (i < text.length) out.push({ text: text.slice(i) })
  return out
}

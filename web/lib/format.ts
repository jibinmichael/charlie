// Small display formatters: dates, durations and status words.

export const fmtDate = (s?: string | null) =>
  s ? new Date(s).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : ""

export const fmtDay = (s?: string | null) =>
  s ? new Date(s).toLocaleDateString(undefined, { dateStyle: "medium" }) : ""

/** Seconds → m:ss. */
export const secs = (n?: number | null) =>
  n == null ? "" : `${Math.floor(n / 60)}:${String(Math.round(n % 60)).padStart(2, "0")}`

/** Duration between two ISO stamps, in minutes, or "" . */
export const duration = (a?: string | null, b?: string | null) =>
  a && b
    ? `${Math.max(1, Math.round((new Date(b).getTime() - new Date(a).getTime()) / 60000))} min`
    : ""

export const words = (s: string) => s.replace(/_/g, " ")

/** Sentence case for a status or band word: "stated_only" → "Stated only". */
export const sentence = (s: string) => {
  const w = s.replace(/_/g, " ").trim()
  return w ? w.charAt(0).toUpperCase() + w.slice(1) : w
}

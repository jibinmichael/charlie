/**
 * A logo tile for a company or a school. Where the record carries a domain, the mark is fetched
 * from Google's favicon service (no key, no account, and no generic fallback); where it does not, the tile is a monogram
 * in a colour derived from the name; nothing is invented to look like a real mark.
 */

// Through the site's own route (app/api/logo), which turns the service's "no mark" into a real
// 404, so the tile falls back to the monogram rather than a globe that looks like a logo.
export const logoUrl = (domain: string) => `/api/logo?domain=${encodeURIComponent(domain)}`

const HUES: { field: string; ink: string }[] = [
  { field: "#dbeafe", ink: "#1d4ed8" },
  { field: "#ede9fe", ink: "#6d28d9" },
  { field: "#dcfce7", ink: "#15803d" },
  { field: "#fef3c7", ink: "#b45309" },
  { field: "#fee2e2", ink: "#b91c1c" },
  { field: "#f3f4f6", ink: "#4b5563" },
]

/** A name that stands in for one we do not have gets no tile at all. */
export const isPlaceholder = (name: string) => /^(not named|various|unknown)$/i.test(name.trim())

/** The same colour for the same name, every time. */
export function monogram(name: string): { letter: string; field: string; ink: string } {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  const hue = HUES[h % HUES.length]!
  return { letter: name.trim().slice(0, 1).toUpperCase() || "?", ...hue }
}

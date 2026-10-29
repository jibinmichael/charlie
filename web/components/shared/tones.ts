/**
 * Charlie's colour system, as components use it. Lime is the brand; every other colour is a MEANING, and every
 * meaning is the same five parts, read from the tokens in app/globals.css (--c-<tone>-container, -on, -ink, -dot,
 * -line). A component asks for a meaning, never a colour: the same state looks the same everywhere.
 *
 *   brand      lime: the primary action, what is selected, and "Ready to introduce"
 *   success    done, live, connected, with the employer
 *   info       in motion, nobody here has to act
 *   progress   Charlie is working on it (qualifying)
 *   attention  a person must act ("Needs you")
 *   warning    something might be wrong (review, a contradiction, a partial answer)
 *   error      it failed
 *   neutral    off, skipped, ended, unknown
 */
export type Tone = "brand" | "success" | "info" | "progress" | "attention" | "warning" | "error" | "neutral"

export type ToneColors = { bg: string; fg: string; ink: string; dot: string; line: string }

/** The five parts of a meaning, as CSS values for inline styles. */
export function tone(t: Tone): ToneColors {
  return {
    bg: `var(--c-${t}-container)`,
    fg: `var(--c-${t}-on)`,
    ink: `var(--c-${t}-ink)`,
    dot: `var(--c-${t}-dot)`,
    line: `var(--c-${t}-line)`,
  }
}

/**
 * The candidacy lifecycle's stages (as the server names them), coloured by phase: five phases
 * read at a glance, the label says the exact stage. Closed is quiet and outlined: an ending, never a failure.
 */
export const STAGE_TONE: Record<string, Tone> = {
  Found: "neutral",
  Contacted: "info",
  Interested: "info",
  Qualifying: "progress",
  "Ready to introduce": "brand",
  Introduced: "success",
  "With employer": "success",
  Hired: "success",
  Closed: "neutral",
}

/** A stage label as shown ("Closed · No answer", "Qualifying", or an older detailed label): its tone, and whether
 *  it is an ending (outlined). An unknown label is neutral. */
export function stageTone(label: string | null | undefined): { tone: Tone; outlined: boolean } {
  const head = String(label ?? "").split(/ · |:/)[0]?.trim() ?? ""
  // an older detailed label that is an ending ("Closed: no response") is outlined too
  const ended = /^closed\b/i.test(head)
  return { tone: STAGE_TONE[head] ?? "neutral", outlined: ended }
}

/**
 * Avatars: a light tonal field and dark initials at Medium, every pair 7.3:1 or better (computed), one hue per
 * person picked from the name, the same on every screen. No red, saturated green or orange field, so an avatar never
 * reads as a status. Charlie is the solid lime circle with the hand, never one of these.
 */
export const AVATAR_TONES: [field: string, ink: string][] = [
  ["#dcebf9", "#174a78"], // sky 7.56
  ["#e3e5fa", "#2f3a8f"], // indigo 7.94
  ["#ece4f8", "#55308f"], // violet 7.72
  ["#d8efec", "#14524c"], // teal 7.47
  ["#dff1e3", "#22553a"], // mint 7.34
  ["#faf1c4", "#5c4800"], // sun 7.74
  ["#fbe4d5", "#6e3511"], // peach 7.87
  ["#f9e1e8", "#7a2140"], // rose 8.00
]

/** The avatar colours for a name: one hash, everywhere. */
export function avatarTone(name: string): { bg: string; fg: string } {
  let h = 0
  for (const ch of String(name || "?")) h = (Math.imul(h, 31) + (ch.codePointAt(0) ?? 0)) >>> 0
  const [bg, fg] = AVATAR_TONES[h % AVATAR_TONES.length]!
  return { bg, fg }
}

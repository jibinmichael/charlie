// Motion tokens shared by JS-driven animations.
import type { Transition } from "motion/react"

/**
 * Motion tokens. Values mirror the CSS variables in app/globals.css so JS-driven
 * transitions and CSS transitions agree. Motion communicates state; it never manufactures activity.
 */
export const motionMs = { fast: 120, normal: 180, slow: 260 } as const

export const easeOut: [number, number, number, number] = [0.32, 0.72, 0, 1]
export const easeInOut: [number, number, number, number] = [0.65, 0, 0.35, 1]

/** Block entry and result confirmation. */
export const settle: Transition = { duration: motionMs.slow / 1000, ease: easeOut }

/** State chip / colour crossfades (working → paused → rechecking). */
export const crossfade: Transition = { duration: motionMs.normal / 1000, ease: easeInOut }

/** Expandable detail. */
export const expand: Transition = { duration: motionMs.normal / 1000, ease: easeOut }

/** Composer trailing controls only. */
export const springEnter: Transition = { type: "spring", stiffness: 420, damping: 38 }

/** Reveal cadence is a legibility aid, never simulated latency: max 6 staggered items. */
/** One emphatic beat (a vote landing): lift and settle. */
export const pop: Transition = { duration: 0.55, ease: easeOut }

/** Live step rows land on this beat while a phase is streaming (the human's pacing call). */
export const STEP_CADENCE_MS = 450
/** Pause after a typed line before the next one starts. */
export const LINE_GAP_MS = 220

const REVEAL_STAGGER_MS = 60
const REVEAL_STAGGER_MAX = 6
export function revealDelay(index: number): number {
  return Math.min(index, REVEAL_STAGGER_MAX) * (REVEAL_STAGGER_MS / 1000)
}

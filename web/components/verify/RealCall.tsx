"use client"

// The in-call screen a candidate sees: who they are talking to, the timer and the call controls.

import { Captions, Mic, MicOff, PhoneOff, Volume2, VolumeX } from "lucide-react"
import { useState } from "react"

import { Mark } from "@/components/shell/Mark"
import { cn } from "@/lib/utils"

import type { Line } from "./CallSession"

/**
 * The call as a call: who you are talking to, how long it has run against its five minutes, Charlie
 * pulsing while speaking, and the three controls every phone has (mute, speaker, end). Captions are
 * off by default, the way a call is; turned on, they show the last thing each side said.
 *
 * THE TIMER IS THE CALL'S OWN BUDGET. It turns amber when Charlie starts wrapping up (45 seconds
 * before the end, voice/policy.mjs WRAP_MARGIN_SECONDS) so the person is not surprised by the close.
 *
 * `composer` is the typed rehearsal on the test page: the same screen, answers typed instead of spoken.
 */
const WRAP_MARGIN_SECONDS = 45

export function RealCallView({
  title,
  subtitle = null,
  lines,
  speaking,
  connecting,
  elapsed,
  budget,
  muted = false,
  onMute,
  speakerOff = false,
  onSpeaker,
  onEnd,
  problem = null,
  captionsDefault = false,
  composer = null,
}: {
  title: string
  subtitle?: string | null
  lines: Line[]
  speaking: boolean
  connecting: boolean
  elapsed: number
  budget: number | null
  muted?: boolean
  onMute?: (() => void) | undefined
  speakerOff?: boolean
  onSpeaker?: (() => void) | undefined
  onEnd?: (() => void) | undefined
  problem?: string | null
  captionsDefault?: boolean
  composer?: React.ReactNode
}) {
  const [captions, setCaptions] = useState(captionsDefault)
  const clock = (n: number) => `${Math.floor(n / 60)}:${String(Math.max(0, n) % 60).padStart(2, "0")}`
  const wrapping = budget != null && elapsed >= budget - WRAP_MARGIN_SECONDS
  const lastAgent = [...lines].reverse().find((l) => l.who === "agent") ?? null
  const lastThem = [...lines].reverse().find((l) => l.who === "candidate") ?? null
  const state = connecting ? "Connecting" : speaking ? "Charlie is speaking" : muted ? "You are muted" : "Listening"

  return (
    <div className="flex min-h-[560px] flex-col items-center rounded-[var(--radius-sheet)] bg-[var(--surface)] px-6 pt-8 pb-7 shadow-[0_0_0_1px_var(--border)]">
      <div className="flex w-full items-baseline justify-between gap-4 text-[13px]">
        <span className="text-muted-foreground min-w-0 truncate">{subtitle}</span>
        <span
          className={cn(
            "shrink-0 tabular-nums",
            wrapping ? "font-medium text-[var(--status-warning)]" : "text-muted-foreground",
          )}
          data-tip={wrapping ? "Charlie is wrapping up" : undefined}
        >
          {clock(elapsed)}
          {budget != null ? ` of ${clock(budget)}` : ""}
        </span>
      </div>

      <div className="flex flex-1 flex-col items-center justify-center py-10">
        <span className="relative inline-flex">
          {(speaking || connecting) && (
            <span
              aria-hidden
              className={cn(
                "absolute inset-0 squircle bg-[var(--ink)]/15",
                speaking ? "animate-ping" : "animate-pulse",
              )}
            />
          )}
          <Mark size={96} />
        </span>
        <h2 className="mt-6 text-[16px] leading-[1.3] font-medium tracking-[-0.01em] text-[var(--ink)]">
          {title}
        </h2>
        <p className="text-muted-foreground mt-1 text-[13px]">{state}</p>

        {captions && (
          <div className="mt-8 flex w-full max-w-[460px] flex-col gap-3 text-center">
            {lastAgent && (
              <p className="text-[14px] leading-[1.6] text-[var(--ink)]">{lastAgent.text}</p>
            )}
            {lastThem && (
              <p className="text-muted-foreground text-[13px] leading-[1.55]">You: {lastThem.text}</p>
            )}
            {!lastAgent && !lastThem && <p className="text-muted-foreground text-[13px]">Captions appear here.</p>}
          </div>
        )}
      </div>

      {problem && <p className="text-status-error mb-4 text-center text-[13px] leading-[1.5]">{problem}</p>}
      {composer && <div className="mb-6 w-full max-w-[460px]">{composer}</div>}

      <div className="flex items-center gap-4">
        {onMute && (
          <CallButton label={muted ? "Unmute" : "Mute"} active={muted} onClick={onMute}>
            {muted ? <MicOff className="size-5" /> : <Mic className="size-5" />}
          </CallButton>
        )}
        {onSpeaker && (
          <CallButton label={speakerOff ? "Speaker on" : "Speaker off"} active={speakerOff} onClick={onSpeaker}>
            {speakerOff ? <VolumeX className="size-5" /> : <Volume2 className="size-5" />}
          </CallButton>
        )}
        <CallButton label={captions ? "Hide captions" : "Show captions"} active={captions} onClick={() => setCaptions((c) => !c)}>
          <Captions className="size-5" />
        </CallButton>
        <button
          type="button"
          onClick={onEnd}
          disabled={!onEnd}
          aria-label="End call"
          data-tip="End call"
          className="bg-status-error flex size-14 items-center justify-center squircle text-white transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          <PhoneOff className="size-5" />
        </button>
      </div>
    </div>
  )
}

function CallButton({
  label,
  active,
  onClick,
  children,
}: {
  label: string
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={active}
      data-tip={label}
      className={cn(
        "flex size-14 items-center justify-center squircle transition-colors",
        active ? "bg-[var(--ink)] text-white" : "bg-[var(--muted)] text-[var(--ink)] hover:bg-[var(--border)]",
      )}
    >
      {children}
    </button>
  )
}

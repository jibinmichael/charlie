"use client"

// One voice-verification session: consent, the live call with its transcript, and the close.

import { ConversationProvider, useConversation } from "@elevenlabs/react"
import { useCallback, useEffect, useRef, useState } from "react"

import { PrimaryButton } from "@/components/shell/Buttons"
import { Mark } from "@/components/shell/Mark"
import { ErrorLine, Hairline } from "@/components/shell/Lines"
import { getSessionView, startSession } from "@/lib/session-api"
import type { SessionView } from "@/lib/types"
import { useLoad } from "@/lib/use-load"
import { cn } from "@/lib/utils"

import { RealCallView } from "./RealCall"
import { SpeakerRow } from "./Speaker"

type Phase = "welcome" | "connecting" | "live" | "closing"
export type Line = { id: number; who: "agent" | "candidate" | "section"; text: string; at?: number }
type Variant = "page" | "studio" | "doc"

const POLL_MS = 4000

/**
 * One session over the same three screens, whoever is on the line: what this is and the consent,
 * the call with its live transcript, and the close. The candidate page and the Studio both mount
 * this; nothing differs on the server. Copy follows the voice rules: warm, plain, one idea per
 * sentence, never the mechanism, never a promise Charlie cannot keep. Colour lives in the mark's
 * halo while Charlie is speaking and on the one primary action.
 */
export function CallSession({
  token,
  variant = "page",
  onDone,
  onNow,
}: {
  token: string
  variant?: Variant
  onDone?: () => void
  onNow?: (now: string | null) => void
}) {
  return (
    <ConversationProvider>
      <Inner token={token} variant={variant} onDone={onDone} onNow={onNow} />
    </ConversationProvider>
  )
}

function Inner({
  token,
  variant,
  onDone,
  onNow,
}: {
  token: string
  variant: Variant
  onDone?: (() => void) | undefined
  onNow?: ((now: string | null) => void) | undefined
}) {
  const fetcher = useCallback(() => getSessionView(token), [token])
  const { data: view, error, reload } = useLoad(fetcher)
  const [phase, setPhase] = useState<Phase>("welcome")
  const [agreed, setAgreed] = useState<Record<string, boolean>>({})
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [lines, setLines] = useState<Line[]>([])
  const [elapsed, setElapsed] = useState(0)
  const [progress, setProgress] = useState<SessionView["progress"] | null>(null)
  const seq = useRef(0)
  const clockRef = useRef(0)
  const lastNow = useRef<string | null>(null)
  const bottom = useRef<HTMLDivElement | null>(null)

  const conversation = useConversation({
    onConnect: () => setPhase("live"),
    onMessage: ({ message, role }) => {
      if (!message) return
      seq.current += 1
      setLines((l) => [
        ...l,
        {
          id: seq.current,
          who: role === "agent" ? "agent" : "candidate",
          text: message,
          at: clockRef.current,
        },
      ])
    },
    onDisconnect: () => {
      setPhase((p) => (p === "live" || p === "connecting" ? "closing" : p))
      reload()
      onDone?.()
    },
    onError: (message) => setProblem(message || "The connection dropped."),
  })
  const { startSession: connect, endSession, isSpeaking, isMuted, setMuted, setVolume } = conversation
  // the candidate page's speaker switch: Charlie's voice off and on, the microphone untouched
  const [speakerOff, setSpeakerOff] = useState(false)

  useEffect(() => {
    if (phase !== "live") return
    const id = setInterval(() => {
      getSessionView(token).then(
        (v) => {
          setProgress(v.progress)
          if (v.progress?.now && v.progress.now !== lastNow.current) {
            lastNow.current = v.progress.now
            onNow?.(v.progress.now)
            seq.current += 1
            const id = seq.current
            setLines((l) => [
              ...l,
              { id, who: "section", text: v.progress.now as string, at: clockRef.current },
            ])
          }
          if (v.done) {
            endSession()
            setPhase("closing")
          }
        },
        () => {
          /* a missed poll is nothing; the next one will land */
        },
      )
    }, POLL_MS)
    return () => clearInterval(id)
  }, [phase, token, endSession, onNow])

  useEffect(() => {
    if (phase !== "live") return
    const id = setInterval(
      () =>
        setElapsed((t) => {
          clockRef.current = t + 1
          return t + 1
        }),
      1000,
    )
    return () => clearInterval(id)
  }, [phase])

  async function begin(v: SessionView) {
    setBusy(true)
    setProblem(null)
    try {
      await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch {
      setProblem("The microphone is not available. Allow it in the browser and try again.")
      setBusy(false)
      return
    }
    try {
      const consents = v.consents.map((c) => ({
        scope: c.scope,
        text_version: c.text_version,
        granted: Boolean(agreed[c.scope]),
      }))
      const s = await startSession(token, consents)
      setPhase("connecting")
      connect({
        conversationToken: s.token,
        connectionType: "webrtc",
        dynamicVariables: { [s.first_message_var]: s.first_message },
      })
    } catch (e: unknown) {
      setProblem(e instanceof Error ? e.message : String(e))
      setPhase("welcome")
    }
    setBusy(false)
  }

  const studio = variant !== "page"
  const pad = variant === "studio" ? "px-6 py-6" : ""

  if (error) return <ErrorLine>{error}</ErrorLine>
  if (!view) return <Hairline />

  if (phase === "closing" || (phase === "welcome" && view.done)) {
    return (
      <div className={pad}>
        <Mark size={28} />
        <h2 className="mt-5 text-[16px] leading-[1.25] font-medium tracking-[-0.015em]">
          {studio ? "The conversation is over." : "Thank you. That's everything."}
        </h2>
        <div className="text-foreground/85 mt-4 flex flex-col gap-2 text-[13px] leading-[1.6]">
          {studio ? (
            <p>
              The transcript is being processed. The evaluation appears here once that is done,
              usually within a minute.
            </p>
          ) : (
            <>
              <p>
                {view.next_step_text ||
                  "The hiring team takes it from here. I don't set the timeline, so I can't say when you'll hear."}
              </p>
              <p>
                The hiring team can share the transcript with you if you ask them for it. You can
                close this page.
              </p>
            </>
          )}
        </div>
        {lines.length > 0 && <TranscriptList lines={lines} className="mt-8" />}
      </div>
    )
  }
  if (view.closed)
    return (
      <p className={cn("text-muted-foreground text-[13px] leading-[1.6]", pad)}>
        This conversation is closed.
      </p>
    )

  if (phase === "welcome") {
    if (view.live)
      return (
        <p className={cn("text-muted-foreground text-[13px] leading-[1.6]", pad)}>
          This conversation is open in another window. Close that one first, or wait a few minutes
          and open this link again.
        </p>
      )
    const resuming = view.state === "in_progress"
    const ready =
      view.consented || view.consents.filter((c) => c.required).every((c) => agreed[c.scope])
    return (
      <div className={pad}>
        {!studio && <Mark size={28} />}
        <h2
          className={cn(
            "text-[16px] leading-[1.25] font-medium tracking-[-0.015em]",
            !studio && "mt-5",
          )}
        >
          {resuming
            ? "Let's pick up where we left off."
            : studio
              ? "Before you start"
              : `A conversation about the ${view.role} role${view.client ? ` at ${view.client}` : ""}.`}
        </h2>
        {!resuming && (
          <div className="text-foreground/85 mt-4 flex flex-col gap-2 text-[13px] leading-[1.6]">
            {studio ? (
              <p>
                You are about to take the exact conversation a candidate gets: the same questions,
                the same Charlie, about {view.minutes} minutes. Answer as the candidate you want to
                test.
              </p>
            ) : (
              <>
                <p>
                  I&apos;m Charlie, an AI agent. The hiring team asked me to talk through the work
                  behind this role with you, so they can hear it in your own words.
                </p>
                <p>
                  It takes about {view.minutes} minutes, one question at a time. You can say skip,
                  repeat that, or I need a moment, whenever you like.
                </p>
                <p>
                  The conversation is recorded. The hiring team gets the recording, a written
                  transcript, and notes drawn from what you say. Nobody else.
                </p>
              </>
            )}
          </div>
        )}
        {resuming && (
          <p className="text-foreground/85 mt-4 text-[13px] leading-[1.6]">
            We were cut off. When you start again I&apos;ll repeat the question we were on.
          </p>
        )}
        {!view.consented && (
          <ul className="mt-6 flex flex-col gap-3">
            {view.consents.map((c) => (
              <li key={c.scope}>
                <label className="flex cursor-pointer items-start gap-3 text-[13px] leading-[1.55]">
                  <input
                    type="checkbox"
                    className="accent-foreground mt-1 size-4 shrink-0"
                    checked={Boolean(agreed[c.scope])}
                    onChange={(e) => setAgreed((a) => ({ ...a, [c.scope]: e.target.checked }))}
                  />
                  <span className="text-foreground/80">{c.text}</span>
                </label>
              </li>
            ))}
          </ul>
        )}
        {problem && <p className="text-status-error mt-4 text-[13px] leading-[1.55]">{problem}</p>}
        <div className="mt-7">
          <PrimaryButton size="md" ready={ready} busy={busy} onClick={() => begin(view)}>
            {busy
              ? "One moment"
              : resuming
                ? "Continue the conversation"
                : "Start the conversation"}
          </PrimaryButton>
        </div>
        <p className="text-muted-foreground mt-4 text-[12px] leading-[1.55]">
          Use headphones if you can, somewhere quiet. Your browser will ask for the microphone.
        </p>
      </div>
    )
  }

  // connecting or live. The candidate page is a call (components/verify/RealCall.tsx); the Studio
  // and the doc keep the transcript canvas, because there the transcript is the thing being read.
  if (variant === "page")
    return (
      <RealCallView
        title="Charlie"
        subtitle={`${view.role}${view.client ? ` at ${view.client}` : ""}`}
        lines={lines}
        speaking={isSpeaking}
        connecting={phase === "connecting"}
        elapsed={elapsed}
        budget={view.budget_seconds}
        muted={isMuted}
        onMute={() => setMuted(!isMuted)}
        speakerOff={speakerOff}
        onSpeaker={() => {
          setVolume({ volume: speakerOff ? 1 : 0 })
          setSpeakerOff(!speakerOff)
        }}
        onEnd={() => {
          endSession()
          setPhase("closing")
        }}
        problem={problem}
      />
    )
  return (
    <LivePresence
      lines={lines}
      speaking={isSpeaking}
      elapsed={elapsed}
      connecting={phase === "connecting"}
      muted={isMuted}
      onMute={() => setMuted(!isMuted)}
      onEnd={() => {
        endSession()
        setPhase("closing")
      }}
      problem={problem}
      now={progress?.now ?? null}
      count={progress ? `${progress.opened} of ${progress.total}` : null}
      budget={view.budget_seconds}
      bottomRef={bottom}
    />
  )
}

/**
 * The call as it happens: one canvas. A quiet line above (what Charlie is exploring, how far
 * along), the conversation as a document, and one quiet bar below with the listening state, the
 * time, Mute and End. Nothing else moves.
 */
export function LivePresence(props: LivePresenceProps) {
  const inner = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = inner.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 240
    if (nearBottom) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" })
  }, [props.lines.length])
  return <LivePresenceView {...props} scrollRef={inner} />
}

type LivePresenceProps = {
  lines: Line[]
  speaking: boolean
  elapsed: number
  connecting: boolean
  muted?: boolean
  onMute?: () => void
  onEnd?: () => void
  problem?: string | null
  stacked?: boolean
  sample?: boolean
  now?: string | null
  count?: string | null
  budget?: number | null
  bottomRef?: React.RefObject<HTMLDivElement | null>
}

function LivePresenceView({
  lines,
  speaking,
  elapsed,
  connecting,
  muted = false,
  onMute,
  onEnd,
  problem = null,
  sample = false,
  now = null,
  count = null,
  budget = null,
  bottomRef,
  scrollRef,
}: LivePresenceProps & { scrollRef: React.RefObject<HTMLDivElement | null> }) {
  const clock = (n: number) => `${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}`
  const remaining = budget != null ? Math.max(0, budget - elapsed) : null
  const state = connecting
    ? "Connecting"
    : speaking
      ? "Charlie is speaking"
      : muted
        ? "Muted"
        : "Listening"
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="text-muted-foreground flex items-baseline justify-between gap-6 pb-8 text-[13px]">
        <span className="min-w-0 truncate">
          {now ? (
            <>
              <span className="text-vibe-shimmer font-medium">Exploring · {now}</span>
              {count ? <span className="text-muted-foreground"> · {count}</span> : null}
            </>
          ) : connecting ? (
            "Connecting"
          ) : (
            "Getting started"
          )}
        </span>
        <span className="flex items-center gap-4">
          <span className={cn("wave", (speaking || connecting) && "wave-on")} aria-hidden>
            {Array.from({ length: 22 }, (_, i) => (
              <i key={i} />
            ))}
          </span>
          <span className="shrink-0 whitespace-nowrap tabular-nums">
            {remaining != null ? `${clock(remaining)} left` : clock(elapsed)}
          </span>
        </span>
      </div>
      {problem && <p className="text-status-error mb-4 text-[13px] leading-[1.5]">{problem}</p>}
      <div ref={scrollRef} className="scroll-quiet min-h-0 flex-1 overflow-y-auto">
        {lines.length ? (
          <TranscriptList lines={lines} live />
        ) : (
          <Hairline className="mt-2 max-w-xs" />
        )}
        <div ref={bottomRef} className="h-24" />
      </div>
      <div className="pointer-events-none sticky bottom-4 flex justify-center">
        <div className="dock bg-card pointer-events-auto flex items-center gap-4 rounded-full py-1.5 pr-1.5 pl-4">
          <span className="text-muted-foreground flex items-center gap-2 text-[13px]">
            <span
              className={cn(
                "size-2 squircle",
                speaking
                  ? "ink-charlie bg-current"
                  : connecting
                    ? "bg-muted-foreground/50 animate-pulse"
                    : "ink-ok bg-current",
              )}
            />
            {state}
            {sample ? " · Sample" : ""}
          </span>
          <span className={cn("wave", (speaking || connecting) && "wave-on")} aria-hidden>
            {Array.from({ length: 18 }, (_, i) => (
              <i key={i} />
            ))}
          </span>
          <span className="text-muted-foreground text-[13px] tabular-nums">
            {remaining != null ? `${clock(remaining)} left` : clock(elapsed)}
          </span>
          {onMute && (
            <button
              type="button"
              onClick={onMute}
              aria-label={muted ? "Unmute" : "Mute"}
              className={cn(
                "border-border flex h-8 items-center gap-1.5 rounded-full border px-3 text-[13px] font-medium transition-colors",
                muted
                  ? "bg-foreground text-background border-foreground"
                  : "text-foreground hover:bg-muted",
              )}
            >
              {muted ? "Unmute" : "Mute"}
            </button>
          )}
          <button
            type="button"
            onClick={onEnd}
            disabled={!onEnd}
            className="bg-status-error text-background flex h-8 items-center gap-1.5 rounded-full px-3.5 text-[13px] font-medium transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            <span className="bg-background/90 inline-block size-2 rounded-[2px]" />
            Stop
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * The live transcript as a document. An area begins with a quiet line naming it; Charlie's first
 * question in an area sits at the margin, larger; the answers and follow-ups that follow are
 * indented as one thread. Whitespace does the pacing.
 */
export function TranscriptList({
  lines,
  className,
}: {
  lines: Line[]
  live?: boolean
  className?: string
}) {
  const clock = (at?: number) =>
    at == null ? "" : `${Math.floor(at / 60)}:${String(at % 60).padStart(2, "0")}`
  const rows = markOpenings(lines)
  return (
    <ol className={cn("flex flex-col", className)}>
      {rows.map(({ line: l, opening }) => {
        if (l.who === "section") {
          return (
            <li key={l.id} className="ink-charlie mt-3 mb-4 text-[12px] font-medium">
              {l.text}
            </li>
          )
        }
        const agent = l.who === "agent"
        return (
          <li key={l.id} className="mb-5">
            <SpeakerRow who={l.who} time={clock(l.at)} muted={agent && !opening} />
            <p
              className={cn(
                "mt-1.5 text-[13px] leading-[1.6]",
                agent ? "text-foreground/85" : "text-foreground",
              )}
            >
              {l.text}
            </p>
          </li>
        )
      })}
    </ol>
  )
}

/** A pure pre-pass: which Charlie lines open an area (the first after each section line, or the first of all). */
function markOpenings(lines: Line[]): { line: Line; opening: boolean }[] {
  let awaiting = true
  return lines.map((l) => {
    if (l.who === "section") {
      awaiting = true
      return { line: l, opening: false }
    }
    const opening = l.who === "agent" && awaiting
    if (opening) awaiting = false
    return { line: l, opening }
  })
}

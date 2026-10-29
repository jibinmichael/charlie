"use client"

// One conversation page in the Studio: header, live view or transcript, and the evaluation.

import Link from "next/link"
import { useCallback, useEffect, useState } from "react"
import { AnimatePresence, motion } from "motion/react"

import { ErrorLine, Hairline } from "@/components/shell/Lines"
import { api, getMeta, useLink, useSecret } from "@/lib/api"
import { duration, fmtDate, sentence } from "@/lib/format"
import { settle } from "@/lib/motion"
import type { CallDetail, Meta } from "@/lib/types"
import { useLoad } from "@/lib/use-load"
import { cn } from "@/lib/utils"

import { CallSession } from "./CallSession"
import { Doc, Tabs } from "./Doc"
import { Evaluation } from "./Evaluation"
import { LiveEvents } from "./LiveEvents"
import { SAMPLE_DETAIL, SampleLive } from "./Sample"
import { SignalsColumn } from "./SignalsColumn"
import { Transcript } from "./Transcript"

const REFRESH_MS = 6000
const SETTLED = ["reported", "declined", "unreachable", "expired"]
const IN_FLIGHT = [
  "completed",
  "transcript_ready",
  "evidence_ready",
  "evaluated",
  "awaiting_review",
  "reviewed",
  "blocked",
  "abandoned",
]
type Tab = "live" | "evaluation" | "transcript" | "review"

/**
 * One conversation: the header, a segmented control (Live while it runs or on the sample,
 * Evaluation, Transcript, Review for a candidate), and the content. The
 * live canvas sits under the same tabs so the evaluation and transcript are always one press away.
 */
export function ConversationDoc({
  id,
  liveToken = null,
  sample = false,
}: {
  id: string
  liveToken?: string | null
  sample?: boolean
}) {
  const secret = useSecret()
  const link = useLink()
  const fetcher = useCallback(
    () =>
      sample
        ? Promise.resolve({ d: SAMPLE_DETAIL, meta: null as Meta | null })
        : Promise.all([api<CallDetail>(secret, `/voice/api/calls/${id}`), getMeta(secret)]).then(
            ([d, meta]) => ({ d, meta }),
          ),
    [secret, id, sample],
  )
  const { data, error, reload } = useLoad(fetcher)
  const d = data?.d ?? null
  const meta = data?.meta ?? null
  const [tab, setTab] = useState<Tab | null>(null)
  const [activeEvidence, setActiveEvidence] = useState<string | null>(null)
  const [activeItem, setActiveItem] = useState<string | null>(null)
  const settled = Boolean(d && (d.package || SETTLED.includes(d.session.state)))
  const inCall = Boolean(
    liveToken && d && !SETTLED.includes(d.session.state) && !IN_FLIGHT.includes(d.session.state),
  )

  useEffect(() => {
    if (!d || settled || sample || inCall) return
    const t = setInterval(reload, REFRESH_MS)
    return () => clearInterval(t)
  }, [d, settled, sample, inCall, reload])

  if (error) return <ErrorLine>{error}</ErrorLine>
  if (!d) return <Hairline />
  const s = d.session
  const label = typeof s.conditions?.label === "string" ? s.conditions.label : null
  const title = sample ? "Sample conversation" : (d.candidate?.name_as_given ?? label ?? "Test")
  const minutes = d.plan.session_budget_seconds
    ? Math.round(d.plan.session_budget_seconds / 60)
    : null
  const itemsById = Object.fromEntries(d.plan.items.map((i) => [i.id, i]))
  const evById = Object.fromEntries(d.evidence.map((e) => [e.id, e]))
  const statusByItem = Object.fromEntries(
    d.signals.filter((x) => x.plan_item_id).map((x) => [x.plan_item_id as string, x.status]),
  )
  const processing = !d.package && !SETTLED.includes(s.state) && !inCall
  const person = s.kind === "test" ? "You" : (d.candidate?.name_as_given ?? "Candidate")
  const areas = [...d.plan.items].sort((a, b) => a.priority - b.priority)
  const verificationHref = link(`/studio/${d.mandate.id}`)
  // Someone else's call, watched from the Studio: the server's live log stands in for the transcript.
  const watching = Boolean(d && !liveToken && !sample && s.state === "in_progress")
  const hasLive = inCall || sample || watching
  const current: Tab = tab ?? (hasLive ? "live" : "evaluation")
  const live = current === "live"
  const tabs: { key: Tab; label: string }[] = [
    ...(hasLive ? [{ key: "live" as const, label: "Live" }] : []),
    { key: "evaluation", label: "Evaluation" },
    { key: "transcript", label: "Transcript" },
    ...(s.kind === "candidate" && d.package ? [{ key: "review" as const, label: "Review" }] : []),
  ]

  return (
    <div className="flex min-w-0 flex-1">
      <Doc className={cn("min-w-0 flex-1", live && "pb-6")}>
        <header className={live ? "mb-6" : "mb-10"}>
          <div className="text-muted-foreground mb-3 text-[13px]">
            {verificationHref ? (
              <Link href={verificationHref}>
                {d.mandate.role}
              </Link>
            ) : (
              d.mandate.role
            )}
            {" · "}
            {inCall || watching
              ? "Live"
              : s.kind === "test"
                ? processing
                  ? "Test, processing"
                  : SETTLED.includes(s.state)
                    ? "Test completed"
                    : "Test"
                : sentence(s.state)}
            {minutes ? ` · ${minutes} min` : ""}
          </div>
          <h1
            className={cn(
              "text-foreground text-[15px] leading-[24px] tracking-[-0.02em]",
            )}
          >
            {title}
          </h1>
          {!live && (
            <p className="text-muted-foreground mt-2 text-[14px]">
              {s.started_at ? fmtDate(s.started_at) : "Not started"}
              {duration(s.started_at, s.completed_at)
                ? ` · ${duration(s.started_at, s.completed_at)}`
                : ""}
              {d.package
                ? ` · ${d.package.header.items_reached} of ${d.package.header.items_total} areas explored`
                : ""}
            </p>
          )}
        </header>

        {!live && (
          <div className="mb-8 flex flex-wrap items-center gap-x-5 gap-y-2 text-[13px] leading-[20px]">
            {s.kind === "test" && !sample && verificationHref && (
              <Link
                href={`${verificationHref}?test=1`}
                className="ink-charlie"
              >
                Test again
              </Link>
            )}
            {s.kind === "test" && !sample && verificationHref && (
              <Link
                href={`${verificationHref}?link=1`}
                className="text-muted-foreground"
              >
                Generate candidate link
              </Link>
            )}
            {sample && (
              <button
                type="button"
                onClick={() => setTab("live")}
                className="link ink-charlie"
              >
                Replay it live
              </button>
            )}
          </div>
        )}

        <Tabs value={current} options={tabs} onChange={setTab} />

        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={current}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={settle}
            className={cn(live && "h-[calc(100vh-12rem)] min-h-[420px]")}
          >
            {live &&
              (sample ? (
                <SampleLive onNow={() => {}} />
              ) : liveToken ? (
                <CallSession
                  token={liveToken}
                  variant="doc"
                  onNow={() => {}}
                  onDone={() => {
                    setTab("evaluation")
                    reload()
                  }}
                />
              ) : watching ? (
                <LiveEvents
                  events={d.events}
                  itemsById={itemsById}
                  personName={person}
                  className="scroll-quiet h-full overflow-y-auto"
                />
              ) : null)}

            {current === "evaluation" &&
              (d.package ? (
                <Evaluation
                  pkg={d.package}
                  items={areas}
                  turns={d.turns}
                  onViewTranscript={(pid, eid) => {
                    setActiveItem(pid)
                    setActiveEvidence(eid ?? null)
                    setTab("transcript")
                    if (eid)
                      setTimeout(
                        () =>
                          document
                            .getElementById(`turn-${evById[eid]?.provenance.turn_ids[0] ?? ""}`)
                            ?.scrollIntoView({ block: "center", behavior: "smooth" }),
                        50,
                      )
                  }}
                />
              ) : (
                <p className="text-muted-foreground text-[14px] leading-[1.65]">
                  {processing
                    ? "The evaluation appears once the conversation has been processed. This page refreshes on its own."
                    : inCall
                      ? "The evaluation appears after the conversation."
                      : "No evaluation for this conversation."}
                </p>
              ))}

            {current === "transcript" &&
              (d.turns.length || !inCall ? (
                <Transcript
                  turns={d.turns}
                  evidence={d.evidence}
                  itemsById={itemsById}
                  statusByItem={statusByItem}
                  activeEvidence={activeEvidence}
                  activeItem={activeItem}
                  personName={person}
                  gutter={false}
                  onPickEvidence={(eid) => {
                    setActiveEvidence(eid)
                    setActiveItem(evById[eid]?.plan_item_id ?? null)
                  }}
                />
              ) : (
                <p className="text-muted-foreground text-[14px] leading-[1.65]">
                  The transcript with its evidence arrives after the conversation. The Live tab
                  shows it as it happens.
                </p>
              ))}

            {current === "review" && (
              <div className="-mx-4">
                <SignalsColumn
                  d={d}
                  meta={meta}
                  activeEvidence={activeEvidence}
                  activeItem={activeItem}
                  onPickItem={(pid) => {
                    setActiveItem(pid)
                    setActiveEvidence(null)
                  }}
                  onPickEvidence={(eid) => {
                    setActiveEvidence(eid)
                    setTab("transcript")
                  }}
                  onSaved={reload}
                />
              </div>
            )}
          </motion.div>
        </AnimatePresence>
      </Doc>
    </div>
  )
}

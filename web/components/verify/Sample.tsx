"use client"

// Fixed, synthetic sample data for previewing the conversation screens without a live call.

import { useEffect, useState } from "react"

import type { CallDetail, Evidence, PlanItem, ReportPackage, Turn } from "@/lib/types"
import { cn } from "@/lib/utils"

import { LivePresence, TranscriptList, type Line } from "./CallSession"
import { Evaluation } from "./Evaluation"
import { Transcript } from "./Transcript"

/**
 * A SAMPLE conversation, for looking at the transcript surfaces before the voice provider is
 * connected. It is fixed text about no real person, it is never sent anywhere, and nothing here
 * is stored. Every screen that shows it says so.
 */
const contract = (establishes: string, anchor: string, probe: string) => ({
  establishes,
  mandate_quote: "",
  why_it_matters: "",
  elements: [{ name: "instance", required: true, core: true }],
  anchor_question: anchor,
  depth_probes: [{ text: probe, targets: "mechanism" }],
  ownership_probe: null,
  scenario: null,
  contradiction_hooks: [],
  expected_evidence: "",
  fallback_text: { anchor, probe, move_on: "", clarify: "" },
})
const ITEMS: PlanItem[] = [
  {
    id: "s-1",
    requirement_id: null,
    ref: "hard:0",
    kind: "hard_requirement",
    priority: 1,
    budget_seconds: 120,
    evidence_contract: contract(
      "Commercial HVAC repair in the current role",
      "Tell me about the HVAC repair work you do in your current role.",
      "When did that start, and is it still most of your week?",
    ),
  },
  {
    id: "s-2",
    requirement_id: null,
    ref: "capabilities:0",
    kind: "capability",
    priority: 2,
    budget_seconds: 200,
    evidence_contract: contract(
      "Diagnoses faults on their own route",
      "Tell me about the last fault you traced from scratch.",
      "How did you decide where to start looking?",
    ),
  },
  {
    id: "s-3",
    requirement_id: null,
    ref: "intent:0",
    kind: "intent",
    priority: 3,
    budget_seconds: 90,
    evidence_contract: contract(
      "Why this role, in their own words",
      "What drew you to this particular role?",
      "What do you understand the day to day to be?",
    ),
  },
]
export const SAMPLE_ITEMS_BY_ID: Record<string, PlanItem> = Object.fromEntries(
  ITEMS.map((i) => [i.id, i]),
)

const T = (
  seq: number,
  speaker: "agent" | "candidate",
  text: string,
  t: number,
  item: string | null,
  move: string | null,
): Turn => ({
  id: `st-${seq}`,
  conversation_id: "sample",
  seq,
  speaker,
  text,
  t_start: t,
  t_end: null,
  stt_confidence: null,
  usable: true,
  plan_item_id: item,
  move,
  superseded_by: null,
})
export const SAMPLE_TURNS: Turn[] = [
  T(
    0,
    "agent",
    "Hi, I'm Charlie. I'm an AI agent, and this conversation is recorded. I'm going to ask you about the work behind this role, one question at a time, for about ten minutes. You can say skip, repeat that, or I need a moment, whenever you like. Ready when you are.",
    0,
    null,
    "intro",
  ),
  T(1, "candidate", "Sure, ready.", 14, null, null),
  T(
    2,
    "agent",
    "Tell me about the HVAC repair work you do in your current role.",
    16,
    "s-1",
    "ask_anchor",
  ),
  T(
    3,
    "candidate",
    "So at Acme I look after rooftop units and chillers for about thirty commercial sites. It's around twelve call-outs a week, all logged in the CMMS, and I've been doing that since March 2023.",
    21,
    "s-1",
    null,
  ),
  T(
    4,
    "agent",
    "When did that start, and is it still most of your week?",
    44,
    "s-1",
    "probe_depth",
  ),
  T(
    5,
    "candidate",
    "March 2023, when I moved over from the installation crew. It's still most of my week, maybe four days out of five on breakdowns.",
    47,
    "s-1",
    null,
  ),
  T(
    6,
    "agent",
    "Okay, thank you. Tell me about the last fault you traced from scratch.",
    64,
    "s-2",
    "acknowledge_move_on",
  ),
  T(
    7,
    "candidate",
    "Last quarter a supermarket kept losing its cold room overnight. I pulled six months of alarm history from the CMMS, then went round the plant with a leak detector to find where the pressure was dropping.",
    69,
    "s-2",
    null,
  ),
  T(8, "agent", "How did you decide where to start looking?", 96, "s-2", "probe_depth"),
  T(
    9,
    "candidate",
    "Anything that alarmed between midnight and four, when the defrost cycle ran. That pointed at the timer, not the refrigerant, and swapping the controller fixed it on the second visit.",
    99,
    "s-2",
    null,
  ),
  T(
    10,
    "agent",
    "That's helpful. What drew you to this particular role?",
    124,
    "s-3",
    "acknowledge_move_on",
  ),
  T(
    11,
    "candidate",
    "Honestly, the route. It's the kind of site I already know, and the role owns the fault end to end instead of handing off after the first visit.",
    128,
    "s-3",
    null,
  ),
  T(
    12,
    "agent",
    "Thank you, that's everything I wanted to ask. The hiring team takes it from here. I don't set the timeline, so I can't tell you when you'll hear. Goodbye for now.",
    150,
    null,
    "wrap_up",
  ),
]
const E = (
  id: string,
  item: string,
  element: string,
  quote: string,
  turn: string,
  depth: number,
  t: number,
): Evidence => ({
  id,
  session_id: "sample",
  plan_item_id: item,
  requirement_id: null,
  contract_element: element,
  type: "instance",
  quote,
  provenance: {
    conversation_id: "sample",
    turn_ids: [turn],
    audio_start_secs: t,
    audio_end_secs: null,
  },
  reliability: "reliable",
  specificity: 2,
  ownership: "own",
  probe_depth: depth,
  extractor_version: "sample",
})
export const SAMPLE_EVIDENCE: Evidence[] = [
  E(
    "se-1",
    "s-1",
    "context",
    "I look after rooftop units and chillers for about thirty commercial sites. It's around twelve call-outs a week, all logged in the CMMS",
    "st-3",
    0,
    21,
  ),
  E("se-2", "s-1", "dates", "March 2023, when I moved over from the installation crew", "st-5", 1, 47),
  E(
    "se-3",
    "s-2",
    "instance",
    "a supermarket kept losing its cold room overnight",
    "st-7",
    0,
    69,
  ),
  E(
    "se-4",
    "s-2",
    "mechanism",
    "Anything that alarmed between midnight and four, when the defrost cycle ran",
    "st-9",
    1,
    99,
  ),
  E(
    "se-5",
    "s-3",
    "motivation",
    "the role owns the fault end to end instead of handing off after the first visit",
    "st-11",
    0,
    128,
  ),
]

export const SAMPLE_STATUS: Record<string, string> = {
  "s-1": "supported",
  "s-2": "strongly_supported",
  "s-3": "stated_only",
}

const Q = (e: Evidence): ReportPackage["capability_grid"][number]["evidence"][number] => ({
  evidence_id: e.id,
  quote: e.quote,
  contract_element: e.contract_element,
  type: e.type,
  specificity: e.specificity,
  ownership: e.ownership,
  probe_depth: e.probe_depth,
  reliability: e.reliability,
  audio_start_secs: e.provenance.audio_start_secs,
  audio_end_secs: e.provenance.audio_end_secs,
  turn_ids: e.provenance.turn_ids,
})
const sig = (
  item: PlanItem,
  status: string,
  band: string,
  status_text: string,
  missing: string[],
  probes: number,
): ReportPackage["capability_grid"][number] => ({
  plan_item_id: item.id,
  ref: item.ref,
  kind: item.kind,
  establishes: item.evidence_contract.establishes,
  mandate_quote: "",
  why_it_matters: "",
  status,
  status_text,
  reason: null,
  coverage_band: band,
  coverage_text: "",
  coverage_inputs: {},
  basis: "",
  evidence: SAMPLE_EVIDENCE.filter((e) => e.plan_item_id === item.id).map(Q),
  probes_asked: probes,
  missing_elements: missing,
  limitations: [],
})
export const SAMPLE_PACKAGE: ReportPackage = {
  header: {
    session_id: "sample",
    kind: "test",
    candidate_name_as_given: "Sample",
    role: "Field Service Technician",
    session_date: "2026-09-22T09:12:00Z",
    session_status: "completed",
    items_reached: 3,
    items_total: 3,
    duration_seconds: 150,
    plan_version: 1,
    extractor_version: "sample",
    evaluator_version: "sample",
  },
  identity_consent: { identity_basis: "invited mailbox holder", consents: [] },
  must_have_gate: [
    {
      ref: "hard:0",
      establishes: "Commercial HVAC repair in the current role",
      mandate_quote: "Must have 2+ years repairing commercial HVAC in your current role",
      verdict: "answered",
      bar: "met",
      answer_quote:
        "So at Acme I look after rooftop units and chillers for about thirty commercial sites. It's around twelve call-outs a week, all logged in the CMMS, and I've been doing that since March 2023.",
    },
    {
      ref: "hard:1",
      establishes: "A refrigerant handling certificate",
      mandate_quote:
        "A recognised refrigerant handling certificate required",
      verdict: "unknown",
      bar: null,
      answer_quote: null,
    },
  ],
  capability_grid: [
    sig(
      ITEMS[0]!,
      "supported",
      "partial_coverage",
      "A named employer, a weekly volume and a start date, in their own words, held up under one follow-up. Ownership of the call-out count was not asked.",
      ["ownership"],
      1,
    ),
    sig(
      ITEMS[1]!,
      "strongly_supported",
      "strong_coverage",
      "A specific fault, how it was traced, and the rule that narrowed it down, with a result. Each detail arrived after a follow-up, not in the opening answer.",
      [],
      1,
    ),
  ],
  intent: sig(
    ITEMS[2]!,
    "stated_only",
    "limited_coverage",
    "A reason was given in their own words. Nothing in the conversation could bear it out either way; sincerity is not observable.",
    ["role_understanding"],
    0,
  ),
  hr_answers: [
    {
      ref: "question:0",
      question: "What is your notice period?",
      answer_quote: "Thirty days, and I could probably make it three weeks if it mattered.",
      status: "supported",
    },
    {
      ref: "question:1",
      question: "Are you open to working from the Leeds depot four days a week?",
      answer_quote: "Four days is fine. I live ten minutes from the depot.",
      status: "supported",
    },
    {
      ref: "question:2",
      question: "What is your current fixed compensation?",
      answer_quote: null,
      status: "not_assessed",
    },
  ],
  communication: { markers: [], conditions: {}, note: "" },
  contradictions: [],
  gaps: [],
  transcript: { conversations: 1, turns: 13, transcript_hash: null, audio_available: false },
  limitations: [
    "Nothing here was corroborated outside this conversation.",
    "Identity is the mailbox the link was sent to; nothing more was checked.",
    "This is not an assessment of personality, and not a recommendation.",
  ],
  versions: { plan: 1, extractor: "sample", evaluator: "sample", controller: null },
}

export const SAMPLE_DETAIL: CallDetail = {
  session: {
    id: "sample",
    kind: "test",
    candidate_id: null,
    tester_email: "you@example.com",
    plan_id: "sample-plan",
    state: "reported",
    started_at: "2026-09-22T09:12:00Z",
    completed_at: "2026-09-22T09:14:30Z",
    created_at: "2026-09-22T09:10:00Z",
    conditions: { label: "Strong candidate" },
  },
  candidate: null,
  mandate: { id: "sample-mandate", role: "Field Service Technician", client: "Example Co" },
  plan: {
    id: "sample-plan",
    mandate_id: "sample-mandate",
    version: 1,
    status: "approved",
    session_budget_seconds: 600,
    flagged: [],
    approved_by: null,
    approved_at: null,
    items: ITEMS,
  },
  conversations: [
    {
      id: "sample",
      session_id: "sample",
      provider_conversation_id: "sample",
      started_at: "2026-09-22T09:12:00Z",
      ended_at: "2026-09-22T09:14:30Z",
      end_reason: "ended",
      raw_payload_ref: null,
      audio_ref: null,
      transcript_hash: null,
    },
  ],
  turns: SAMPLE_TURNS,
  signals: ITEMS.map((it, i) => ({
    id: `sig-${i}`,
    session_id: "sample",
    plan_item_id: it.id,
    category: it.kind,
    status: SAMPLE_STATUS[it.id] ?? "not_assessed",
    basis: "",
    coverage_band: "",
    coverage_inputs: {},
    evaluator_version: "sample",
    evidence_ids: SAMPLE_EVIDENCE.filter((e) => e.plan_item_id === it.id).map((e) => e.id),
    reason: null,
    limitations: [],
  })),
  evidence: SAMPLE_EVIDENCE,
  contradictions: [],
  consents: [
    {
      scope: "recording",
      granted: true,
      text_version: "sample",
      recorded_at: "2026-09-22T09:11:00Z",
    },
    {
      scope: "retention",
      granted: true,
      text_version: "sample",
      recorded_at: "2026-09-22T09:11:00Z",
    },
  ],
  package: SAMPLE_PACKAGE,
  report_version: 1,
  review: null,
  events: [],
}

const LIVE_LINES: Line[] = (() => {
  const out: Line[] = []
  let last: string | null = null
  let id = 0
  for (const t of SAMPLE_TURNS.slice(0, 10)) {
    if (t.plan_item_id && t.plan_item_id !== last) {
      last = t.plan_item_id
      out.push({
        id: ++id,
        who: "section",
        text: SAMPLE_ITEMS_BY_ID[t.plan_item_id]?.evidence_contract.establishes ?? "",
        at: t.t_start ?? 0,
      })
    }
    out.push({ id: ++id, who: t.speaker, text: t.text, at: t.t_start ?? 0 })
  }
  return out
})()

/** The live view, replayed: a line lands every couple of seconds; the state reads speaking while Charlie's line is newest. */
export function SampleLive({
  onNow,
  onEnd,
}: { onNow?: (now: string | null) => void; onEnd?: () => void } = {}) {
  const [n, setN] = useState(1)
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    const a = setInterval(() => setN((k) => Math.min(LIVE_LINES.length, k + 1)), 2600)
    const b = setInterval(() => setElapsed((s) => s + 1), 1000)
    return () => {
      clearInterval(a)
      clearInterval(b)
    }
  }, [])
  const lines = LIVE_LINES.slice(0, n)
  const speaking = lines[lines.length - 1]?.who === "agent"
  const section = [...lines].reverse().find((l) => l.who === "section")?.text ?? null
  useEffect(() => {
    onNow?.(section)
  }, [section, onNow])
  return (
    <LivePresence
      lines={lines}
      speaking={speaking}
      elapsed={elapsed}
      connecting={false}
      sample
      now={section}
      count={`${Math.min(3, lines.filter((l) => l.who === "section").length)} of 3`}
      budget={600}
      onEnd={() => {
        setN(LIVE_LINES.length)
        onEnd?.()
      }}
    />
  )
}

/** The stored transcript with its evidence marks, on the sample. */
export function SampleTranscript() {
  const [activeEvidence, setActiveEvidence] = useState<string | null>(null)
  const [activeItem, setActiveItem] = useState<string | null>(null)
  return (
    <Transcript
      turns={SAMPLE_TURNS}
      evidence={SAMPLE_EVIDENCE}
      itemsById={SAMPLE_ITEMS_BY_ID}
      statusByItem={SAMPLE_STATUS}
      activeEvidence={activeEvidence}
      activeItem={activeItem}
      onPickEvidence={(id) => {
        setActiveEvidence(id)
        setActiveItem(SAMPLE_EVIDENCE.find((e) => e.id === id)?.plan_item_id ?? null)
      }}
      personName="Sample"
    />
  )
}

/** The evaluation on the sample, with a way into the transcript. */
export function SampleEvaluation({
  onViewTranscript,
}: {
  onViewTranscript: (itemId: string | null) => void
}) {
  return <Evaluation pkg={SAMPLE_PACKAGE} onViewTranscript={onViewTranscript} />
}

export function SampleBanner({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "bg-status-info-soft text-foreground/80 rounded-lg px-3 py-2 text-[12px]",
        className,
      )}
    >
      A sample, to show the surface. Nobody real, nothing stored, nothing sent.
    </div>
  )
}

export { TranscriptList }

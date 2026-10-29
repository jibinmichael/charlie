"use client"

// The Studio's new-verification form: the mandate, the questions and the length, then Generate.

import { useEffect, useId, useState } from "react"

import { LinearIcon } from "@/components/shared/LinearIcon"
import { INPUT } from "@/components/shell/Field"
import { Hairline } from "@/components/shell/Lines"
import { api, issuesOf, useSecret } from "@/lib/api"
import type { CreateJobResult } from "@/lib/types"
import { cn } from "@/lib/utils"

const LENGTHS = [5, 10, 15, 20] as const
const MAX_MB = 10
const DRAFT_KEY = "charlie:setup-draft"
type Draft = {
  role: string
  email: string
  paste: string
  questions: string[]
  minutes: number
  client: string
  nextStep: string
}
const EMPTY: Draft = {
  role: "",
  email: "",
  paste: "",
  questions: [""],
  minutes: 10,
  client: "",
  nextStep: "",
}
function readDraft(): Draft {
  try {
    const raw = window.localStorage.getItem(DRAFT_KEY)
    if (!raw) return EMPTY
    const d = JSON.parse(raw) as Partial<Draft>
    return {
      ...EMPTY,
      ...d,
      questions: Array.isArray(d.questions) && d.questions.length ? d.questions : [""],
    }
  } catch {
    return EMPTY
  }
}
const writeDraft = (d: Draft) => {
  try {
    window.localStorage.setItem(DRAFT_KEY, JSON.stringify(d))
  } catch {
    /* memory only */
  }
}
const clearDraft = () => {
  try {
    window.localStorage.removeItem(DRAFT_KEY)
  } catch {
    /* nothing */
  }
}

function Label({ children }: { icon?: string; children: React.ReactNode }) {
  return <div className="text-muted-foreground mb-1.5 text-[12px] font-medium">{children}</div>
}

/**
 * The new-verification box that lives in the left column: what you are hiring for, your email,
 * the mandate, the questions, the length, Generate. The draft survives a reload in this browser.
 * Client-only, so the draft is read before the first render.
 */
export function SetupBox({ onGenerated }: { onGenerated: (r: CreateJobResult) => void }) {
  const secret = useSecret()
  const [d, setD] = useState<Draft>(readDraft)
  const [mode, setMode] = useState<"attach" | "paste">(() =>
    readDraft().paste ? "paste" : "attach",
  )
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [errors, setErrors] = useState<string[] | null>(null)
  const inputId = useId()
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((s) => ({ ...s, [k]: v }))
  useEffect(() => {
    writeDraft(d)
  }, [d])
  const accept = (files: FileList | null) => {
    const chosen = files?.[0]
    if (!chosen) return
    if (chosen.size > MAX_MB * 1024 * 1024) {
      setErrors([`That file is over ${MAX_MB} MB.`])
      return
    }
    setErrors(null)
    setFile(chosen)
  }
  const mandateReady = mode === "attach" ? Boolean(file) : d.paste.trim().length >= 40
  const ready = d.role.trim().length >= 2 && /\S+@\S+\.\S+/.test(d.email) && mandateReady

  async function submit() {
    if (!ready || busy) return
    setBusy(true)
    setErrors(null)
    try {
      const body: Record<string, unknown> = {
        role: d.role.trim(),
        client: d.client.trim() || null,
        contact_email: d.email.trim(),
        questions: d.questions.map((q) => q.trim()).filter(Boolean),
        session_budget_seconds: d.minutes * 60,
        next_step_text: d.nextStep.trim() || null,
      }
      if (mode === "attach" && file) {
        const buf = new Uint8Array(await file.arrayBuffer())
        let bin = ""
        for (let i = 0; i < buf.length; i += 0x8000)
          bin += String.fromCharCode(...buf.subarray(i, i + 0x8000))
        body.jd_file = { name: file.name, base64: btoa(bin) }
      } else body.jd_text = d.paste.trim()
      const r = await api<CreateJobResult>(secret, "/voice/api/jobs", {
        method: "POST",
        body: JSON.stringify(body),
      })
      clearDraft()
      onGenerated(r)
    } catch (e: unknown) {
      setErrors(issuesOf(e))
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div>
        <Label icon="two-flags">New verification</Label>
        <input
          className={INPUT}
          placeholder="What are you hiring for?"
          value={d.role}
          onChange={(e) => set("role", e.target.value)}
        />
        <input
          className={cn(INPUT, "mt-2")}
          type="email"
          placeholder="Your email"
          value={d.email}
          onChange={(e) => set("email", e.target.value)}
        />
      </div>
      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <Label icon="document">Mandate</Label>
          <div className="text-muted-foreground -mt-1.5 flex gap-2 text-[12px]">
            {(["attach", "paste"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={cn(
                  "transition-colors",
                  mode === m ? "text-foreground font-medium" : "hover:text-foreground",
                )}
              >
                {m === "attach" ? "Upload" : "Paste"}
              </button>
            ))}
          </div>
        </div>
        {mode === "attach" ? (
          file ? (
            <div className="border-border flex items-center gap-2 rounded-lg border px-3 py-2 text-[13px]">
              <span className="text-foreground min-w-0 flex-1 truncate">{file.name}</span>
              <button
                type="button"
                onClick={() => setFile(null)}
                aria-label="Remove file"
                className="text-muted-foreground hover:text-foreground"
              >
                <LinearIcon name="close" className="size-3" />
              </button>
            </div>
          ) : (
            <label
              htmlFor={inputId}
              className="border-border hover:bg-muted/60 flex cursor-pointer flex-col items-center gap-1 rounded-lg border border-dashed px-3 py-5 text-center transition-colors"
            >
              <span className="text-foreground text-[13px]">Drop the JD or browse</span>
              <span className="text-muted-foreground text-[11px]">
                PDF, DOCX, TXT · {MAX_MB} MB
              </span>
              <input
                id={inputId}
                type="file"
                accept=".pdf,.docx,.txt,.rtf,.md"
                className="sr-only"
                onChange={(e) => accept(e.target.files)}
              />
            </label>
          )
        ) : (
          <textarea
            className={cn(INPUT, "min-h-[120px] resize-y py-2 leading-[1.5]")}
            placeholder="Paste the job description as written."
            value={d.paste}
            onChange={(e) => set("paste", e.target.value)}
          />
        )}
      </div>
      <div>
        <Label icon="steps">Questions to ask</Label>
        <ul className="flex flex-col gap-1.5">
          {d.questions.map((q, i) => (
            <li key={i} className="group flex items-center gap-1.5">
              <input
                className={INPUT}
                placeholder={i === 0 ? "What is your notice period?" : "Another question"}
                value={q}
                onChange={(e) =>
                  set(
                    "questions",
                    d.questions.map((x, j) => (j === i ? e.target.value : x)),
                  )
                }
                onKeyDown={(e) => {
                  if (e.key === "Enter" && q.trim()) {
                    e.preventDefault()
                    set("questions", [
                      ...d.questions.slice(0, i + 1),
                      "",
                      ...d.questions.slice(i + 1),
                    ])
                  }
                }}
              />
              {d.questions.length > 1 && (
                <button
                  type="button"
                  aria-label="Remove question"
                  onClick={() =>
                    set(
                      "questions",
                      d.questions.filter((_, j) => j !== i),
                    )
                  }
                  className="text-muted-foreground hover:text-foreground shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
                >
                  <LinearIcon name="close" className="size-3" />
                </button>
              )}
            </li>
          ))}
        </ul>
        <button
          type="button"
          onClick={() => set("questions", [...d.questions, ""])}
          className="ink-charlie mt-2 flex items-center gap-1 text-[12px] font-medium"
        >
          Add question
        </button>
      </div>
      <div>
        <Label icon="clock">Length</Label>
        <div className="bg-muted inline-flex h-8 items-center rounded-lg p-[3px]">
          {LENGTHS.map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => set("minutes", m)}
              className={cn(
                "flex h-full items-center rounded-md px-2.5 text-[13px] leading-[20px] tabular-nums transition-all",
                d.minutes === m
                  ? "bg-card text-foreground font-medium shadow-[0_1px_2px_rgba(0,0,0,0.06)]"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {m} min
            </button>
          ))}
        </div>
      </div>
      <div>
        <button
          type="button"
          disabled={!ready || busy}
          onClick={submit}
          className={cn(
            "h-9 w-full rounded-lg text-[13px] font-medium transition-all",
            ready && !busy ? "btn-vibe" : "bg-primary text-primary-foreground opacity-40",
          )}
        >
          {busy ? "Generating…" : "Generate verification"}
        </button>
        {busy && <Hairline className="mt-2" />}
        {errors && <p className="text-status-error mt-2 text-[12px]">{errors.join(" ")}</p>}
      </div>
    </div>
  )
}

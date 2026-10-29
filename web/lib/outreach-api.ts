"use client"
// Client for the server's outreach API (/outreach/api/*): a hand-run role mandate's emails, both ways,
// one thread per person, plus CV and attachment downloads. Read only. Same Bearer, same base as lib/api.ts.
import { API, api, secretFetch } from "./api"

export type OutreachStatus = "waiting" | "replied" | "idle" | "reopened" | "roleSent" | "answered"
export type OutreachEvent = {
  after: number
  kind: "idle" | "reopened" | "roleSent" | "hold" | "answered"
  at: string
  text: string
}
export type OutreachMessage = {
  from: "charlie" | "candidate"
  at: string
  subject: string
  body: string | null
  recorded: boolean
  label: string | null
  /** Their emails only: the Resend id the attachments are read by. */
  emailId?: string | null
}
/** A company's facts, when the server has them (it sends null today). */
export type CompanyFacts = {
  name: string
  domain: string | null
  website: string | null
  industry: string | null
  headcount: number | null
  scale: string | null
  founded: number | null
  funding: string | null
  hq: string | null
  description: string | null
}
export type OutreachAttachment = {
  id: string
  filename: string
  contentType: string
  size: number | null
}
export type OutreachPerson = {
  /** A CV is on file (its extracted text; the original file was not kept). */
  hasCv: boolean
  companyInfo: CompanyFacts | null
  previousCompanyInfo: CompanyFacts | null
  poolId: number | null
  name: string
  email: string
  phone: string | null
  linkedin: string | null
  portfolio: string | null
  city: string | null
  title: string | null
  company: string | null
  previousTitle: string | null
  previousCompany: string | null
  totalYears: number | null
  compCurrent: number | null
  compExpected: number | null
  compCurrency: string | null
  noticeDays: number | null
  noticeRaw: string | null
  workMode: string | null
  relocate: string | null
  skills: string[]
  degree: string | null
  institution: string | null
  gradYear: number | null
  source: string | null
}
export type OutreachThread = {
  id: string
  mandate: string
  role: string
  city: string
  person: OutreachPerson
  statuses: OutreachStatus[]
  /** Where the person stands, derived by the server from the live thread. */
  activity: "active" | "idle" | "inactive"
  activated: boolean
  events: OutreachEvent[]
  messages: OutreachMessage[]
  lastAt: string
  awaitingUs: boolean
  /** Where the person stands in the candidate lifecycle. In shadow mode it is derived on every read and
   *  nothing is saved. Absent from an older API. */
  lifecycle?: OutreachLifecycle
}
export type OutreachLifecycle = {
  stage?: string
  /** the candidacy lifecycle's fixed system stage and, when closed, its group (absent from an older server) */
  system_stage?: string | null
  close_group?: string | null
  /** the detailed step (the lifecycle's own words) when `stage` shows the system stage */
  step?: string
  nextAction?: string
  owner?: "candidate" | "operator" | "charlie" | "employer" | null
  waitingFor?: string | null
  dueAt?: string | null
  engagement?: string
  screening?: string
  consentToScreen?: string
  consentToIntroduce?: string
  flags?: string[]
  shadow?: boolean
  /** true: read from the saved pursuit (kept in step every 15 minutes); false: derived on this read */
  saved?: boolean
  error?: string
  unmapped?: boolean
}
export type OutreachMandate = { key: string; role: string; city: string }

export const outreachMandates = (secret: string) =>
  api<{ mandates: OutreachMandate[] }>(secret, "/outreach/api/mandates")

export const outreachThreads = (secret: string, key: string) =>
  api<OutreachMandate & { threads: OutreachThread[] }>(
    secret,
    `/outreach/api/mandates/${encodeURIComponent(key)}`,
  )

export const outreachAttachments = (secret: string, emailId: string) =>
  api<{ attachments: OutreachAttachment[] }>(
    secret,
    `/outreach/api/messages/${encodeURIComponent(emailId)}/attachments`,
  )

/** Fetch a file with the Bearer and hand it to the browser as a download. */
async function download(secret: string, path: string, filename: string) {
  const r = await secretFetch(secret, `${API}${path}`, { cache: "no-store" })
  if (!r.ok)
    throw new Error(r.status === 404 ? "No longer available" : `Download failed (${r.status})`)
  const url = URL.createObjectURL(await r.blob())
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export const downloadCv = (secret: string, email: string, name: string) =>
  download(secret, `/outreach/api/cv/${encodeURIComponent(email)}`, `${name} CV (text).txt`)

export const downloadAttachment = (secret: string, emailId: string, a: OutreachAttachment) =>
  download(
    secret,
    `/outreach/api/messages/${encodeURIComponent(emailId)}/attachments/${encodeURIComponent(a.id)}`,
    a.filename,
  )

"use client"

// The Candidates list: every candidate session, newest first, each linking to its conversation.

import { useCallback } from "react"

import { EmptyState, ErrorLine, Hairline } from "@/components/shell/Lines"
import { api, useLink, useSecret } from "@/lib/api"
import { fmtDate } from "@/lib/format"
import type { CallRow } from "@/lib/types"
import { useLoad } from "@/lib/use-load"

import { SessionChip } from "./Chips"
import { Doc, DocTitle, RowLink } from "./Doc"

/**
 * Candidates: everyone with a link, newest first. A row opens their conversation page:
 * evaluation, transcript, review, and the panel. Test sessions never appear here.
 */
export function CandidatesView() {
  const secret = useSecret()
  const studio = useLink()("/studio")
  const fetcher = useCallback(
    () =>
      api<{ calls: CallRow[] }>(secret, "/voice/api/calls").then((r) =>
        r.calls.filter((c) => c.kind === "candidate"),
      ),
    [secret],
  )
  const { data: rows, error } = useLoad(fetcher)
  return (
    <main className="flex min-w-0 flex-1 overflow-y-auto">
      <Doc>
        <DocTitle>Candidates</DocTitle>
        {error && <ErrorLine>{error}</ErrorLine>}
        {rows === null && !error && <Hairline />}
        {rows && rows.length === 0 && (
          <EmptyState icon="user-circle">
            No candidates yet. Generate a candidate link on a verification; whoever takes it appears
            here.
          </EmptyState>
        )}
        {studio && rows && rows.length > 0 && (
          <ol className="flex flex-col">
            {rows.map((r) => (
              <li key={r.id}>
                <RowLink
                  href={`${studio}/${r.job?.mandate_id ?? ""}/c/${r.id}`}
                  title={r.name ?? r.who ?? "Candidate"}
                  meta={`${r.who ?? ""}${r.job ? ` · ${r.job.role}` : ""} · ${fmtDate(r.completed_at ?? r.started_at ?? r.created_at)}`}
                  right={<SessionChip state={r.state} />}
                />
              </li>
            ))}
          </ol>
        )}
      </Doc>
    </main>
  )
}

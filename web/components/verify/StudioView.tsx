"use client"

// The Verification Studio: create a verification, open one, or open one of its conversations.

import dynamic from "next/dynamic"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useCallback } from "react"

import { ErrorLine, Hairline } from "@/components/shell/Lines"
import { Mark } from "@/components/shell/Mark"
import { api, useLink, useSecret } from "@/lib/api"
import type { JobDetail, JobRow } from "@/lib/types"
import { useLoad } from "@/lib/use-load"

import { ConversationDoc } from "./ConversationDoc"
import { VerificationDoc } from "./VerificationDoc"

const SetupBox = dynamic(() => import("./SetupBox").then((m) => m.SetupBox), {
  ssr: false,
  loading: () => <Hairline />,
})

/**
 * The Studio: a list of verifications on the left, one page on the right. The page is the new
 * verification being written, a verification, or one conversation (test or candidate) with its
 * panel. Everything is white; the list's selected row is the only field of grey.
 */
export function StudioView({
  id,
  sid,
  liveToken = null,
  sample = false,
}: {
  id?: string
  sid?: string
  liveToken?: string | null
  sample?: boolean
}) {
  const secret = useSecret()
  const link = useLink()
  const router = useRouter()
  const listFetcher = useCallback(
    () => api<{ jobs: JobRow[] }>(secret, "/voice/api/jobs").then((r) => r.jobs),
    [secret],
  )
  const { data: jobs, reload: reloadJobs } = useLoad(listFetcher)
  const detailFetcher = useCallback(
    () => (id ? api<JobDetail>(secret, `/voice/api/jobs/${id}`) : Promise.resolve(null)),
    [secret, id],
  )
  const { data: d, error, reload } = useLoad(detailFetcher)
  const base = link("/studio")

  return (
    <div className="flex h-screen min-h-0">
      <main className="scroll-quiet flex h-screen w-full min-w-0 overflow-y-auto">
        {sample ? (
          <ConversationDoc id="sample" sample />
        ) : !id ? (
          <div className="mx-auto w-full max-w-[440px] px-6 py-16">
            <div className="mb-8 flex items-center gap-2 text-[13px]">
              <Mark size={18} />
              <span className="text-foreground font-medium">Charlie</span>
              <span className="text-muted-foreground">Verification Studio</span>
            </div>
            <SetupBox
              onGenerated={(r) => {
                reloadJobs()
                if (base) router.push(`${base}/${r.mandate.id}`)
              }}
            />
            {base && jobs && jobs.length > 0 && (
              <div className="mt-10">
                <div className="text-muted-foreground mb-1.5 text-[12px] font-medium">
                  Verifications
                </div>
                <ol className="-mx-2 flex flex-col">
                  {jobs.map((j) => (
                    <li key={j.id}>
                      <Link
                        href={`${base}/${j.id}`}
                        data-link="block"
                        className="text-foreground/80 hover:bg-muted/70 hover:text-foreground flex items-center gap-2 rounded-full px-2 py-1.5 text-[13px] leading-[20px] transition-colors"
                      >
                        <span className="min-w-0 flex-1 truncate">{j.role}</span>
                        {j.calls > 0 && (
                          <span className="text-muted-foreground text-[11px] tabular-nums">
                            {j.calls}
                          </span>
                        )}
                      </Link>
                    </li>
                  ))}
                </ol>
              </div>
            )}
          </div>
        ) : error ? (
          <div className="px-10 py-16">
            <ErrorLine>{error}</ErrorLine>
          </div>
        ) : !d ? (
          <Hairline />
        ) : sid ? (
          <ConversationDoc key={sid} id={sid} liveToken={liveToken} />
        ) : (
          <VerificationDoc d={d} reload={reload} />
        )}
      </main>
    </div>
  )
}

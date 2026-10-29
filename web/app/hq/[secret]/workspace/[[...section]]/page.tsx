// The workspace on a secret link: /hq/<secret>/workspace/<section>.
import { notFound } from "next/navigation"

import { Workspace, type Section } from "@/components/workspace/Workspace"

/** /workspace is the Inbox, /workspace/<inbox|agents> a section, and /workspace/agents/new the agent picker. */
const SECTIONS: Section[] = ["inbox", "agents"]

export default async function Page({ params }: { params: Promise<{ secret: string; section?: string[] }> }) {
  const { section } = await params
  const s = (section?.[0] ?? "inbox") as Section
  if (s === "agents" && section?.length === 2 && section[1] === "new") return <Workspace section="agents" sub="new" />
  if (!SECTIONS.includes(s) || (section?.length ?? 0) > 1) notFound()
  return <Workspace section={s} />
}

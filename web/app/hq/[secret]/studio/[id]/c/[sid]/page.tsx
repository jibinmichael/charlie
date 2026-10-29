// One conversation (test or candidate) of a verification; ?t= carries a live test token.
import { StudioView } from "@/components/verify/StudioView"

export default async function ConversationPage({ params, searchParams }: Readonly<{ params: Promise<{ id: string; sid: string }>; searchParams: Promise<{ t?: string }> }>) {
  const { id, sid } = await params
  const { t } = await searchParams
  return <StudioView id={id} sid={sid} liveToken={t ?? null} />
}

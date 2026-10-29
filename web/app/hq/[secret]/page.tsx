// The secret-link home: redirects to the workspace Inbox.
import { redirect } from "next/navigation"

export default async function HqHome({ params }: Readonly<{ params: Promise<{ secret: string }> }>) {
  const { secret } = await params
  // the home is the workspace Inbox
  redirect(`/hq/${secret}/workspace/inbox`)
}

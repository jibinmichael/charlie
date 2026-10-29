// The candidate's voice-verification page.
import { CallPage } from "@/components/verify/CallPage"

/**
 * The one candidate page. The token in the URL is the whole key: it names one session and nothing
 * else, and the page holds no secret. Everything it shows comes from the server for that token.
 */
export default async function CandidatePage({ params }: Readonly<{ params: Promise<{ token: string }> }>) {
  const { token } = await params
  return <CallPage token={token} />
}

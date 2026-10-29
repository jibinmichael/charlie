// The candidate page (/v/<token>): a single column that hosts the voice session.
import { CallSession } from "./CallSession"

/** The candidate's page: one column, the session, nothing else on it. */
export function CallPage({ token }: { token: string }) {
  return (
    <main className="flex flex-1 items-start justify-center px-6 py-14">
      <div className="w-full max-w-[520px]">
        <CallSession token={token} variant="page" />
      </div>
    </main>
  )
}

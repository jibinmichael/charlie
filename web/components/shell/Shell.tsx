"use client"

// The page shell: it puts the secret from the URL into context.

import { SecretContext } from "@/lib/api"

/** No chrome: the secret goes into context and the Studio fills the window. */
export function Shell({ secret, children }: { secret: string; children: React.ReactNode }) {
  return (
    <SecretContext.Provider value={secret}>
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</main>
    </SecretContext.Provider>
  )
}

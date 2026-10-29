// The candidate page's two calls. No bearer: the token in the path is the key.
import { API, ApiError } from "./api"
import type { SessionView, StartResult } from "./types"

type ErrorBody = { error?: string; missing?: string[] }

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const r = await fetch(`${API}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers || {}) },
    cache: "no-store",
  })
  let body: unknown = null
  try {
    body = await r.json()
  } catch {
    /* no body */
  }
  if (!r.ok) {
    const eb = (body ?? {}) as ErrorBody
    throw new ApiError(r.status, eb.error || `The server answered ${r.status}.`)
  }
  return body as T
}

export const getSessionView = (token: string) => call<SessionView>(`/voice/session/${token}`)

export const startSession = (
  token: string,
  consents: { scope: string; text_version: string; granted: boolean }[],
) =>
  call<StartResult>(`/voice/session/${token}/start`, {
    method: "POST",
    body: JSON.stringify({
      consents,
      user_agent: typeof navigator === "undefined" ? null : navigator.userAgent.slice(0, 400),
    }),
  })

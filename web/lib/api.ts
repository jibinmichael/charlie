"use client"
// The dashboard's one way of talking to the Charlie server. Only NEXT_PUBLIC_* configuration is read; the Bearer is
// the secret from the URL (/hq/<secret>). Nothing is cached across people.
import { createContext, useContext } from "react"

import { linkFor } from "./paths"
import type { Meta } from "./types"

/** The Charlie server's base URL (see .env.example). The fallback is a placeholder, so a missing setting fails visibly. */
export const API = process.env.NEXT_PUBLIC_CHARLIE_API_BASE || "https://api.example.com"

export const SecretContext = createContext<string>("")
export const useSecret = () => useContext(SecretContext)

/** Every link under the root goes through this (lib/paths.ts linkFor): `link("/workspace/inbox")` is
 *  /hq/<secret>/workspace/inbox. */
export function useLink() {
  const secret = useSecret()
  return (sub: string) => linkFor(secret, sub)
}

/** One request to the Charlie server with the secret as the Bearer. Every request in lib/ goes through here. */
export function secretFetch(secret: string, url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${secret}` } })
}

export class ApiError extends Error {
  status: number
  issues: string[] | undefined
  constructor(status: number, message: string, issues?: string[]) {
    super(message)
    this.status = status
    this.issues = issues
  }
}

type ErrorBody = { error?: string; issues?: string[] }

export async function api<T>(secret: string, path: string, init: RequestInit = {}): Promise<T> {
  const r = await secretFetch(secret, `${API}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...((init.headers as Record<string, string> | undefined) || {}),
    },
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
    const msg =
      r.status === 401
        ? "This link's secret is wrong."
        : r.status === 404
          ? "Verification is switched off on the server."
          : r.status === 503
            ? "The server has no dashboard secret configured."
            : eb.error || `The server answered ${r.status}.`
    throw new ApiError(r.status, msg, eb.issues)
  }
  return body as T
}

/** The issues list from a failed request, or the message alone. */
export function issuesOf(e: unknown): string[] {
  if (e instanceof ApiError && e.issues?.length) return e.issues
  return [e instanceof Error ? e.message : String(e)]
}

/** The vocabulary (statuses, bands, reasons, sentences), fetched once per page load. */
let metaCache: Promise<Meta> | null = null
export function getMeta(secret: string): Promise<Meta> {
  if (!metaCache)
    metaCache = api<Meta>(secret, "/voice/api/meta").catch((e) => {
      metaCache = null
      throw e
    })
  return metaCache
}

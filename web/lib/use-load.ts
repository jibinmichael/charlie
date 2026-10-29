"use client"
// useLoad: the fetch-on-mount hook every data screen uses.
import { useCallback, useEffect, useState } from "react"

/**
 * Load something from the server on mount and whenever `fetcher` changes; reload on demand. State
 * is set only inside the promise's callbacks, never synchronously in the effect body, and a stale
 * response from an unmounted or superseded fetch is dropped.
 */
export function useLoad<T>(fetcher: () => Promise<T>) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const reload = useCallback(() => setTick((t) => t + 1), [])

  useEffect(() => {
    let alive = true
    fetcher().then(
      (r) => {
        if (!alive) return
        setData(r)
        setError(null)
      },
      (e: unknown) => {
        if (!alive) return
        setError(e instanceof Error ? e.message : String(e))
      },
    )
    return () => {
      alive = false
    }
  }, [fetcher, tick])

  return { data, error, reload }
}

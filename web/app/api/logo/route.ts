// GET /api/logo?domain=: a same-origin proxy for company favicons.
import { NextResponse } from "next/server"

/**
 * The logo tile's source, same-origin. Browsers decode an image body even on a 404, so the
 * favicon service's "no mark" answer would still paint its placeholder; this route checks the
 * status itself and answers 404 with no body, which is what makes the tile fall back to a
 * monogram. Only a bare hostname is accepted, and the answer is cached at the edge for a day.
 */
const HOST = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i

export async function GET(req: Request) {
  const domain = new URL(req.url).searchParams.get("domain") ?? ""
  if (!HOST.test(domain)) return new NextResponse(null, { status: 400 })
  const upstream = `https://t2.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE&url=https://${encodeURIComponent(domain)}&size=64`
  try {
    const r = await fetch(upstream, { next: { revalidate: 86400 } })
    if (!r.ok) return new NextResponse(null, { status: 404 })
    return new NextResponse(await r.arrayBuffer(), {
      headers: {
        "content-type": r.headers.get("content-type") ?? "image/png",
        "cache-control": "public, max-age=86400, s-maxage=86400",
      },
    })
  } catch {
    return new NextResponse(null, { status: 404 })
  }
}

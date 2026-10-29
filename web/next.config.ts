// Next.js configuration: security headers on every page.
import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  // Hide the Next.js dev indicator badge, which overlaps the workspace rail.
  devIndicators: false,
  // Security headers on every page. The Content-Security-Policy only forbids other sites from framing ours.
  async headers() {
    return [{
      source: "/:path*",
      headers: [
        { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
        { key: "X-Frame-Options", value: "DENY" },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "no-referrer" },
        { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
        // a page that opened ours in a window loses its handle on it (the secret link is in this window's URL)
        { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
      ],
    }]
  },
}

export default nextConfig

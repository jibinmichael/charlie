// The root layout: metadata, the count-badge font, and the app-wide tooltip layer.
import type { Metadata } from "next"
import { Roboto_Mono } from "next/font/google"
import { TipLayer } from "@/components/shared/TipLayer"
import "./globals.css"

// The one typeface, everywhere, is the system's own: nothing is loaded for it. globals.css puts it in --font-sans and
// --font-mono; font-synthesis stays off, weights 400 and 500.

// The one exception to the one typeface: count badges are Roboto Mono 12/16, through the .count class in
// globals.css only; nothing else names it. Self-hosted by next/font at build time.
const countFont = Roboto_Mono({ subsets: ["latin"], weight: ["400"], display: "swap", variable: "--font-count" })

export const metadata: Metadata = {
  title: "Charlie",
  description:
    "Charlie: an AI recruiting agent workspace, with candidate voice verification.",
  robots: { index: false, follow: false, nocache: true },
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`h-full ${countFont.variable}`}>
      <body className="flex h-full min-h-full flex-col">
        {children}
        <div id="portal" />
        {/* the app's one tooltip, used instead of the browser's native title tooltip */}
        <TipLayer />
      </body>
    </html>
  )
}

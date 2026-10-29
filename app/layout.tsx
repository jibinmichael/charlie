import type { Metadata } from "next";
import * as Sentry from "@sentry/nextjs";
import Script from "next/script";
import "./globals.css";

// The site is set in ONE typeface: Courier Prime mono (--mono, declared in globals.css).
// No next/font webfonts here on purpose — a second family is not allowed,
// enforced by app/font-guard.test.mjs. Do not re-add Sanchez/Roboto/Caveat/etc.

const SITE = process.env.NEXT_PUBLIC_SITE_URL || "https://example.com";
// The browser tab / <title>. The social share cards below keep their own descriptive title.
const PAGE_TITLE = "Your story. Better represented!";
const TITLE = "Charlie · a career agent that does your job search for you";
const DESC =
  "Charlie reads the whole job market, learns what you actually want, and emails you a role only when it's genuinely worth your time. It runs inside the Claude you already use.";

// Google Analytics — wired but inert until NEXT_PUBLIC_GA_ID (G-XXXX) is set, so it lights
// up the moment the measurement ID is provided, with no code change.
const GA_ID = process.env.NEXT_PUBLIC_GA_ID;

const baseMetadata: Metadata = {
  metadataBase: new URL(SITE),
  title: PAGE_TITLE,
  description: DESC,
  applicationName: "Charlie",
  keywords: ["job search", "career agent", "AI job search", "Claude", "MCP", "Charlie"],
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    url: SITE,
    siteName: "Charlie",
    title: TITLE,
    description: DESC,
    images: [{ url: "/charlie-og.png", width: 1200, height: 630, alt: "Charlie — a career agent" }],
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESC,
    images: ["/charlie-og.png"],
  },
  icons: {
    // the coral hand mark (site-wide), matching the landing masthead + email logo. apple-touch is
    // still the robot PNG — a hand version needs a real 180x180 raster; regenerate when it matters.
    icon: [{ url: "/charlie-hand-icon.svg", type: "image/svg+xml" }],
    apple: [{ url: "/charlie-apple-touch.png", sizes: "180x180", type: "image/png" }],
  },
  manifest: "/site.webmanifest",
};

// Return the metadata via generateMetadata so we can fold in Sentry's trace data (connects a
// server render to the client trace). Next.js forbids exporting both `metadata` and this, so the
// object above stays a private base and we spread it here.
export function generateMetadata(): Metadata {
  return { ...baseMetadata, other: { ...Sentry.getTraceData() } };
}

export const viewport = { themeColor: "#F75858" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head />
      <body>
        {children}
        {GA_ID ? (
          <>
            <Script src={`https://www.googletagmanager.com/gtag/js?id=${GA_ID}`} strategy="afterInteractive" />
            <Script id="ga-init" strategy="afterInteractive">
              {`window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
gtag('js', new Date());
gtag('config', '${GA_ID}');`}
            </Script>
          </>
        ) : null}
      </body>
    </html>
  );
}

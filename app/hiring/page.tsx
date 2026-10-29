import type { Metadata } from "next";
import "./hiring.css";
import Report from "./Report";

// STATE OF HIRING — a standalone print-broadsheet editorial artifact. Like the rest of the
// site, it is set in the one font: Courier Prime mono (--mono, from globals.css). hiring.css
// maps its --bs / --sans vars onto --mono. No webfonts here — a second family is not allowed
// (enforced by app/font-guard.test.mjs).

export const metadata: Metadata = {
  title: "State of hiring · July 2026 — what companies are actually hiring for",
  description:
    "We read 11,530 live roles across 929 companies. Only 6.5% are actually AI jobs, nearly half of 'remote' is US-only, and junior roles have all but vanished. The honest data, by role.",
  alternates: { canonical: "/hiring" },
  openGraph: {
    title: "State of hiring · July 2026",
    description: "11,530 live roles, honestly read. What companies are actually hiring for, by role, skill, and location.",
    url: "/hiring",
    type: "article",
  },
};

export default function Page() {
  return (
    <Report />
  );
}

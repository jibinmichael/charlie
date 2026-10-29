// app/hq/[secret]/page.tsx — the voice-verification dashboard. One secret in the URL, no accounts.
//
// The page holds no key. Every read and write goes to the Railway server (server/voice.ts) with the
// URL's secret as a Bearer; the server holds the database and model keys and checks the secret on
// every request. A wrong secret renders the dashboard shell and every call answers 401.
//
// The reviewer works here in the browser, with no email in the loop. Not indexed.
import type { Metadata } from "next";
import Dashboard from "../dashboard";
import "../hq.css";

export const metadata: Metadata = {
  title: "Charlie · verification",
  robots: { index: false, follow: false, nocache: true },
};

export default function Page({ params }: { params: { secret: string } }) {
  return <Dashboard secret={params.secret} />;
}

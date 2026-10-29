import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Terms · Charlie",
  description: "What Charlie does, and the honest limits.",
};

export default function Terms() {
  return (
    <main className="doc">
      <a className="back" href="/">
        ←{" "}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="mark" src="/charlie-bot.svg" alt="" width={16} height={16} aria-hidden="true" />
        Charlie
      </a>
      <h1>Terms</h1>
      <p className="meta">Last updated June 28, 2026</p>

      <p>
        These are the plain-language terms for using Charlie. By connecting Charlie to
        your Claude, you agree to them.
      </p>

      <h2>What Charlie does</h2>
      <p>
        Charlie reads job boards, scores roles against the dossier you build with it, and
        emails you a role when one clears your bar. It is an assistant that does the
        looking — <b>you decide what to do with what it finds.</b>
      </p>

      <h2>The honest limits</h2>
      <ul>
        <li>Charlie is AI-driven and <b>can be wrong</b> — it may miss a good role, surface a weak one, or misjudge a fit.</li>
        <li>It is <b>not a guarantee of a job</b>, an interview, or any outcome.</li>
        <li>Always verify a posting yourself before acting on it — companies change or close roles, and details can be out of date.</li>
        <li>Charlie tries hard to be truthful, including telling you the catch on a role. It is still a best-effort tool, not a recruiter or an advisor.</li>
      </ul>

      <h2>Using Charlie</h2>
      <p>
        Charlie is for your own job search. Don&apos;t use it to abuse the job boards it
        reads, to impersonate someone else, or for anything unlawful.
      </p>

      <h2>No warranty, no liability</h2>
      <p>
        Charlie is provided <b>as-is</b>, without warranties of any kind. To the extent
        allowed by law, we are not liable for any loss arising from your use of it,
        including a role that didn&apos;t pan out or a posting that was inaccurate.
      </p>

      <h2>Changes</h2>
      <p>
        We may update these terms or how Charlie works as it improves. Continuing to use
        Charlie means you accept the current version.
      </p>

      <h2>Contact</h2>
      <p>
        Questions? Email{" "}
        <a href="mailto:hello@example.com">hello@example.com</a>.
      </p>

      <p className="note">
        This page is a plain-language summary of the terms of use. It is not legal advice.
      </p>
    </main>
  );
}

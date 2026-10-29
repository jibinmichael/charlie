import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy · Charlie",
  description: "What Charlie stores, why, and how to delete it.",
};

export default function Privacy() {
  return (
    <main className="doc">
      <a className="back" href="/">
        ←{" "}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="mark" src="/charlie-bot.svg" alt="" width={16} height={16} aria-hidden="true" />
        Charlie
      </a>
      <h1>Privacy</h1>
      <p className="meta">Last updated June 28, 2026</p>

      <p>
        Charlie is a career agent that reads job boards and emails you a role when one is
        genuinely worth your time. To do that, it holds a small amount of your
        information. Here is exactly what, in plain language.
      </p>

      <h2>What Charlie stores</h2>
      <ul>
        <li><b>Your email</b> — your identity and where Charlie reaches you.</li>
        <li><b>Your resume</b> — the text you share during setup.</li>
        <li><b>Your dossier</b> — the grounded profile Charlie builds from your resume and the few setup questions (what you want, what you won&apos;t accept).</li>
        <li><b>Your matches</b> — the roles Charlie surfaces for you and whether they were emailed.</li>
      </ul>
      <p>
        This is stored in a private database (Supabase), scoped to you. Charlie never
        asks for a password, a government ID, or payment details.
      </p>

      <h2>Who processes it</h2>
      <p>
        Charlie uses a few services to do its job, and shares only what each needs:
      </p>
      <ul>
        <li><b>Supabase</b> — stores your data (database + private file storage).</li>
        <li><b>Anthropic (Claude)</b> — the AI that reads your resume, builds your dossier, and scores roles.</li>
        <li><b>Resend</b> — sends the role emails to your inbox.</li>
      </ul>
      <p>
        Charlie does not sell your data, and does not use it to train anything. It is used
        only to find and send you matching roles.
      </p>

      <h2>Your data is yours</h2>
      <p>
        You can ask Charlie to show you what it holds at any time, and you can{" "}
        <b>delete everything</b> whenever you want — just ask Charlie to delete your data,
        or email us. Deletion removes your dossier, your matches, and your stored resume.
      </p>

      <h2>Contact</h2>
      <p>
        Questions, or want your data deleted? Email{" "}
        <a href="mailto:hello@example.com">hello@example.com</a>.
      </p>

      <p className="note">
        This page is a plain-language summary of how Charlie handles your data. It is not
        legal advice.
      </p>
    </main>
  );
}

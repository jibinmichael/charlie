import "./landing.css";
import MailCta from "./mail-cta";
import ReplyButton from "./reply-button";

// Charlie landing — the email-terminal redesign. The whole page IS one email: a Gmail-shaped
// window in Courier Prime mono, header pinned, letter scrolling, a fixed Reply/View footer.
// The one action, everywhere: write Charlie one email. Reply opens a prefilled draft to start@
// in the visitor's own mail app (native mailto = adaptive across desktop and mobile) — no app,
// no login, no upload. The site onboards nobody; onboarding happens by email. GA is site-wide (layout.tsx);
// MailCta adds a reply_start event on top of the pageview.

const TO = process.env.NEXT_PUBLIC_START_ADDR || "start@mail.example.com";
const MAIL_SUBJECT = "I want in";
// The file must be ATTACHED, not linked: onboarding grounds the profile on the attached file's text,
// and a pasted link is not read. Asking for a link sent people down the "resume didn't arrive" path,
// so the wording here is load-bearing, not copy polish.
//
// THREE WAYS IN, matching renderMissingResume exactly. "Resume" alone assumes a current
// one exists, and for most people it does not — that is where they postpone. A LinkedIn Save-to-PDF
// or a Peerlist Markdown export is one click on something they already have. Both formats already
// pass ALLOWED_EXT (server/resume-extract.mjs). A LINK to a LinkedIn profile is deliberately NOT
// offered: it cannot be read (it is an auth wall carrying other people's names — see url-ingest
// looksGated), so asking for one would be a promise Charlie cannot keep.
const MAIL_BODY =
  "Hi Charlie,\n\nI'd love an invite.\n\nAttached (optional, any one of these): my resume, my LinkedIn saved as a PDF, or my Peerlist export.\n\nThe work I'm looking for:\n- Role / title:\n- Remote, or a city:\n\nAnd a bit about me, in my own words:\n\n";
const MAILTO = `mailto:${TO}?subject=${encodeURIComponent(MAIL_SUBJECT)}&body=${encodeURIComponent(MAIL_BODY)}`;
// Desktop visitors on browser webmail often have no OS mailto handler, so the Reply link opens
// nothing and the signup silently dies. Gmail's web composer (view=cm) is a real URL that always
// works, prefilled identically so inbound routing is unchanged. su = subject, body = body.
const GMAIL_COMPOSE = `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(TO)}&su=${encodeURIComponent(MAIL_SUBJECT)}&body=${encodeURIComponent(MAIL_BODY)}`;
// Outlook web compose — the other big webmail fallback for a stuck mailto (personal + work both resolve).
const OUTLOOK_COMPOSE = `https://outlook.live.com/mail/0/deeplink/compose?to=${encodeURIComponent(TO)}&subject=${encodeURIComponent(MAIL_SUBJECT)}&body=${encodeURIComponent(MAIL_BODY)}`;

// The landing letter — a short letter from Charlie in short, digestible beats. Wavy scribble
// highlights (.hl) sit only on the sharpest points. The body is explicit JSX below.

export default function Home() {
  return (
    <div className="mailapp">
      <div className="mailterm">
        <div className="ghead">
          <div className="grow gtop">
            <h1 className="subject">A letter from Charlie</h1>
            <span className="spacer" />
          </div>
        </div>

        <div className="mbody">
          <p className="opener">Job hunting used to be a person reading your letter.</p>
          <p>
            Now it&apos;s <b className="hl">machines talking to machines</b>. And you, vanishing
            somewhere in between.
          </p>
          <p>A hundred applications. A handful of replies. Half the jobs were never real.</p>
          <p>And every silence chips away at the belief that you&apos;re worth an answer.</p>
          <p>But here&apos;s the thing: you were never the problem.</p>
          <p>You&apos;re a story, and stories need a reader.</p>
          <p>That&apos;s what I&apos;m for.</p>
          <p>So here is what I do.</p>
          <p>I watch the market so you don&apos;t have to.</p>
          <p>I learn who you really are, in your own words.</p>
          <p>
            When something clears your bar, I send you <b className="hl">one role</b>.
          </p>
          <p>And I tell you where it falls short, too.</p>
          <p>
            I won&apos;t invent you. I won&apos;t apply for you. I won&apos;t personalize your resume
            for each job automagically. I <b className="hl">won&apos;t promise you a job</b>.
          </p>
          <p>I will represent you truthfully, and fight for the one that fits.</p>
          <img src="/hero.png" alt="" className="hero-img" aria-hidden="true" />
          <p>So if any of this landed, come find me.</p>
          <p>
            Write to me at{" "}
            <MailCta href={MAILTO} className="view" location="body">
              {TO}
            </MailCta>
            , and tell me what you&apos;re chasing.
          </p>
          <p>No forms.</p>
          <p>No dashboard.</p>
          <p>Just one email.</p>
          <p>We&apos;ll take it from there.</p>
          <p className="signoff">
            <span className="seal">
              <svg viewBox="0 0 128 128" aria-hidden="true">
                <rect width="128" height="128" rx="28" fill="#EBF15A" />
                <path d="M86 42 A30 30 0 1 0 86 86" fill="none" stroke="#2B2B26" strokeWidth="16" strokeLinecap="round" />
              </svg>
            </span>
          </p>
        </div>

        <div className="mfoot">
          <ReplyButton mailto={MAILTO} gmail={GMAIL_COMPOSE} outlook={OUTLOOK_COMPOSE} address={TO} className="btn" location="footer">
            <img src="/charlie-reply.svg" className="reply-icon" alt="" aria-hidden="true" />
            Reply to get started
          </ReplyButton>
        </div>
      </div>
    </div>
  );
}

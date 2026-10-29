"use client";

// A mail link that fires a Google Analytics event before the browser hands off to the
// visitor's mail app. It never preventDefaults — the native mailto is what opens the draft
// (desktop mail client or the mobile mail/Gmail app, whichever the OS routes it to), so the
// adaptive behaviour is preserved. GA is site-wide in layout.tsx and no-ops until
// NEXT_PUBLIC_GA_ID is set, so the optional-chained call is safe either way.

type Gtag = (command: string, event: string, params?: Record<string, unknown>) => void;

export default function MailCta({
  href,
  className,
  location,
  newTab,
  children,
}: {
  href: string;
  className?: string;
  location: string;
  // The mailto links hand off to the OS mail app and never need a new tab. The Gmail
  // web-compose fallback is a real https URL, so it opens in a new tab to keep the letter open.
  newTab?: boolean;
  children: React.ReactNode;
}) {
  function track() {
    const gtag = (window as unknown as { gtag?: Gtag }).gtag;
    gtag?.("event", "reply_start", { location });
  }

  return (
    <a
      href={href}
      className={className}
      onClick={track}
      {...(newTab ? { target: "_blank", rel: "noopener noreferrer" } : {})}
    >
      {children}
    </a>
  );
}

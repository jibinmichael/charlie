"use client";

// The primary "reply" CTA, hardened. A bare `mailto:` silently does NOTHING on a desktop browser with
// no OS mail app registered (a webmail visitor) — the click dies and the signup is lost. So this tries
// the native mail app and, if nothing opens (the page keeps focus after a beat), reveals web-compose
// fallbacks that always work in a browser. Mobile and desktop mail-client users get the native draft
// exactly as before; only the stuck webmail case sees the fallback. GA `reply_start` fires either way.
import { useState } from "react";

type Gtag = (command: string, event: string, params?: Record<string, unknown>) => void;
const track = (location: string) => (window as unknown as { gtag?: Gtag }).gtag?.("event", "reply_start", { location });

export default function ReplyButton({
  mailto,
  gmail,
  outlook,
  address,
  className,
  location,
  children,
}: {
  mailto: string;
  gmail: string;
  outlook: string;
  address: string;
  className?: string;
  location: string;
  children: React.ReactNode;
}) {
  const [stuck, setStuck] = useState(false);

  function onClick(e: React.MouseEvent) {
    e.preventDefault();
    track(location);
    // attempt the native mail app; if one is registered the page loses focus (app/tab opens)
    window.location.href = mailto;
    // no app opened -> the page still has focus a beat later -> offer the web-compose fallbacks
    window.setTimeout(() => {
      if (document.hasFocus()) setStuck(true);
    }, 1200);
  }

  return (
    <span className="replyc">
      <a href={mailto} className={className} onClick={onClick}>
        {children}
      </a>
      {stuck && (
        <span className="replyfb" role="group" aria-label="Send from your inbox">
          <span className="replyfb-lead">No mail app opened. Write to {address} from:</span>
          <a href={gmail} target="_blank" rel="noopener noreferrer" onClick={() => track(`${location}-gmail`)}>
            Gmail
          </a>
          <a href={outlook} target="_blank" rel="noopener noreferrer" onClick={() => track(`${location}-outlook`)}>
            Outlook
          </a>
        </span>
      )}
    </span>
  );
}

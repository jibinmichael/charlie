"use client";

// The live scan caption: real numbers from the engine's last scan (roles live, companies,
// opened today, closed since yesterday) — the kind of thing no job board shows. Reads the
// public /pool-stats endpoint. Falls back to the static caption if stats aren't there yet,
// so the landing never shows a blank or a broken number. Same .cap styling as before.

import { useEffect, useState } from "react";

const API = process.env.NEXT_PUBLIC_CHARLIE_API_BASE || "https://api.example.com";
const FALLBACK = "1,000+ companies, plus the major remote boards";

type Stats = { roles?: number; companies?: number; opened24h?: number; closedYesterday?: number };

export default function LiveCounter() {
  const [s, setS] = useState<Stats | null>(null);

  useEffect(() => {
    let on = true;
    fetch(`${API}/pool-stats`)
      .then((r) => r.json())
      .then((d) => { if (on && d && d.roles) setS(d); })
      .catch(() => { /* keep the fallback */ });
    return () => { on = false; };
  }, []);

  if (!s || !s.roles) return <p className="cap">{FALLBACK}</p>;
  const n = (x?: number) => (x ?? 0).toLocaleString();
  return (
    <p className="cap live">
      <span className="pulse" aria-hidden="true" />
      <b>{n(s.roles)}</b> open roles live across <b>{n(s.companies)}</b> companies
      {s.closedYesterday ? (
        <> · <span className="gone"><b>{n(s.closedYesterday)}</b> already closed</span> elsewhere</>
      ) : null}
    </p>
  );
}

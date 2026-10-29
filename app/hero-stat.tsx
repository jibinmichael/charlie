"use client";

// The hero proof line: real "roles live" count from the engine's /pool-stats, plus a
// "now reading <company>" ticker so you can feel Charlie scanning. Falls back to a static
// number if the endpoint isn't reachable, and holds still under prefers-reduced-motion.
import { useEffect, useState } from "react";

const API = process.env.NEXT_PUBLIC_CHARLIE_API_BASE || "https://api.example.com";
const NAMES = ["Figma", "Notion", "Linear", "Ramp", "Razorpay", "Vercel", "Anthropic", "PhonePe", "Deel", "Stripe"];

export default function HeroStat() {
  const [roles, setRoles] = useState<number>(11000);
  const [idx, setIdx] = useState(0);
  const [vis, setVis] = useState(true);

  useEffect(() => {
    let on = true;
    fetch(`${API}/pool-stats`)
      .then((r) => r.json())
      .then((d) => { if (on && d && d.roles) setRoles(d.roles); })
      .catch(() => { /* keep fallback */ });
    return () => { on = false; };
  }, []);

  useEffect(() => {
    if (typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const t = setInterval(() => {
      setVis(false);
      setTimeout(() => { setIdx((i) => (i + 1) % NAMES.length); setVis(true); }, 180);
    }, 1700);
    return () => clearInterval(t);
  }, []);

  return (
    <p className="proof fade d3">
      <span className="dot" aria-hidden="true" />
      <span>
        <b>{roles.toLocaleString()}</b> open roles live &middot;{" "}
        <span className="nowread">
          reading <b style={{ opacity: vis ? 1 : 0 }}>{NAMES[idx]}</b>&hellip;
        </span>
      </span>
    </p>
  );
}

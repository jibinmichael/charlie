"use client";
// app/hq/dashboard.tsx — the shell: three tabs, one error line, nothing else.
import { useState } from "react";
import Jobs from "./jobs";
import Calls from "./calls";
import Eval from "./eval";

type Tab = "jobs" | "calls" | "eval";

export default function Dashboard({ secret }: { secret: string }) {
  const [tab, setTab] = useState<Tab>("jobs");
  // A call opened from another tab: the Eval tab reads it, the Calls tab sets it.
  const [focusCall, setFocusCall] = useState<string | null>(null);

  return (
    <main className="hq">
      <header className="hq-top">
        <div className="hq-brand">Charlie <span className="hq-dim">· verification</span></div>
        <nav className="hq-tabs" aria-label="Sections">
          {(["jobs", "calls", "eval"] as Tab[]).map((t) => (
            <button key={t} className={`hq-tab${tab === t ? " is-on" : ""}`} onClick={() => setTab(t)} aria-current={tab === t ? "page" : undefined}>
              {t === "jobs" ? "Jobs" : t === "calls" ? "Calls" : "Eval"}
            </button>
          ))}
        </nav>
      </header>
      {tab === "jobs" && <Jobs secret={secret} />}
      {tab === "calls" && <Calls secret={secret} onEvaluate={(id) => { setFocusCall(id); setTab("eval"); }} />}
      {tab === "eval" && <Eval secret={secret} focusCall={focusCall} />}
    </main>
  );
}

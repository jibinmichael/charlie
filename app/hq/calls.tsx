"use client";
// app/hq/calls.tsx — every session in a table; one opens to its transcript, conditions and events.
import { useCallback, useEffect, useState } from "react";
import { api, fmtDate, secs } from "./api";

export default function Calls({ secret, onEvaluate }: { secret: string; onEvaluate: (id: string) => void }) {
  const [calls, setCalls] = useState<any[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setCalls((await api(secret, "/voice/api/calls")).calls); setError(null); } catch (e: any) { setError(e.message); }
  }, [secret]);
  useEffect(() => { load(); }, [load]);

  if (error) return <p className="hq-error">{error}</p>;
  if (open) return <CallDetail secret={secret} id={open} onBack={() => { setOpen(null); load(); }} onEvaluate={onEvaluate} />;

  return (
    <section>
      <h1>Calls</h1>
      {calls === null ? <p className="hq-dim">Loading.</p> : calls.length === 0 ? <p className="hq-dim">No calls yet. Create a link from a job.</p> : (
        <table className="hq-table">
          <thead><tr><th>When</th><th>Who</th><th>Kind</th><th>Job</th><th>State</th></tr></thead>
          <tbody>
            {calls.map((c) => (
              <tr key={c.id} className="hq-click" onClick={() => setOpen(c.id)}>
                <td className="hq-dim">{fmtDate(c.started_at || c.created_at)}</td>
                <td>{c.name ? `${c.name} · ` : ""}{c.who}</td>
                <td>{c.kind}</td>
                <td>{c.job?.role || ""} <span className="hq-dim">v{c.job?.plan_version}</span></td>
                <td><span className={`hq-pill is-${c.state}`}>{c.state}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

export function CallDetail({ secret, id, onBack, onEvaluate }: { secret: string; id: string; onBack: () => void; onEvaluate: (id: string) => void }) {
  const [d, setD] = useState<any | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { (async () => { try { setD(await api(secret, `/voice/api/calls/${id}`)); } catch (e: any) { setError(e.message); } })(); }, [secret, id]);

  if (error) return <p className="hq-error">{error}</p>;
  if (!d) return <p className="hq-dim">Loading.</p>;
  const itemsById = Object.fromEntries(d.plan.items.map((i: any) => [i.id, i]));
  const s = d.session;

  return (
    <section>
      <button className="hq-link" onClick={onBack}>← Calls</button>
      <h1>{d.candidate?.name_as_given || s.tester_email} <span className="hq-dim">· {d.mandate.role} · {s.kind}</span></h1>
      <p className="hq-dim">
        <span className={`hq-pill is-${s.state}`}>{s.state}</span> · plan v{d.plan.version} · {s.started_at ? `started ${fmtDate(s.started_at)}` : "not started"}{s.completed_at ? ` · ended ${fmtDate(s.completed_at)}` : ""} · {d.conversations.length} connection{d.conversations.length === 1 ? "" : "s"}
        {d.package && <> · <button className="hq-link" onClick={() => onEvaluate(id)}>Open evaluation →</button></>}
      </p>

      {s.conditions && Object.keys(s.conditions).length > 0 && (
        <p className="hq-dim">Conditions: {Object.entries(s.conditions).map(([k, v]) => `${k} ${String(v)}`).join(" · ")}</p>
      )}

      <h2>Transcript</h2>
      {d.turns.length === 0 ? <p className="hq-dim">No transcript yet. It arrives after the call ends.</p> : (
        <ol className="hq-transcript">
          {d.turns.map((t: any) => (
            <li key={t.id} className={`hq-turn is-${t.speaker}${t.usable === false ? " is-unusable" : ""}`}>
              <div className="hq-turn-meta">{t.speaker === "agent" ? "Charlie" : "Candidate"} · {secs(t.t_start)}{itemsById[t.plan_item_id] ? ` · ${itemsById[t.plan_item_id].ref}` : ""}{t.move ? ` · ${t.move}` : ""}{t.usable === false ? " · unusable audio" : ""}</div>
              <div>{t.text}</div>
            </li>
          ))}
        </ol>
      )}

      <h2>Events</h2>
      <ul className="hq-events">{d.events.map((e: any, i: number) => <li key={i}><span className="hq-dim">{fmtDate(e.at)}</span> {e.type}</li>)}</ul>
    </section>
  );
}

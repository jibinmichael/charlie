"use client";
// app/hq/jobs.tsx — upload a mandate and HR's questions, read the plan and its chain, approve it,
// then add candidates one at a time and copy their links. Every action is a server call; nothing
// here decides anything.
import { useCallback, useEffect, useState } from "react";
import { api, ApiError, fmtDate } from "./api";

export default function Jobs({ secret }: { secret: string }) {
  const [jobs, setJobs] = useState<any[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try { setJobs((await api(secret, "/voice/api/jobs")).jobs); setError(null); }
    catch (e: any) { setError(e.message); }
  }, [secret]);
  useEffect(() => { load(); }, [load]);

  if (error) return <p className="hq-error">{error}</p>;
  if (open) return <JobDetail secret={secret} id={open} onBack={() => { setOpen(null); load(); }} />;
  if (creating) return <NewJob secret={secret} onDone={(id) => { setCreating(false); if (id) setOpen(id); else load(); }} />;

  return (
    <section>
      <div className="hq-row hq-between">
        <h1>Jobs</h1>
        <button className="hq-btn" onClick={() => setCreating(true)}>New job</button>
      </div>
      {jobs === null ? <p className="hq-dim">Loading.</p> : jobs.length === 0 ? <p className="hq-dim">No jobs yet. A job is a mandate, the questions HR added, and the plan Charlie will follow.</p> : (
        <table className="hq-table">
          <thead><tr><th>Role</th><th>Client</th><th>Plan</th><th>Calls</th><th>Created</th></tr></thead>
          <tbody>
            {jobs.map((j) => (
              <tr key={j.id} className="hq-click" onClick={() => setOpen(j.id)}>
                <td>{j.role}</td>
                <td className="hq-dim">{j.client || ""}</td>
                <td>{j.latest_plan ? <span className={`hq-pill is-${j.latest_plan.status}`}>v{j.latest_plan.version} {j.latest_plan.status}</span> : <span className="hq-dim">none</span>}</td>
                <td>{j.calls}</td>
                <td className="hq-dim">{fmtDate(j.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function NewJob({ secret, onDone }: { secret: string; onDone: (id: string | null) => void }) {
  const [f, setF] = useState({ role: "", client: "", contact_email: "", session_budget_seconds: 600, next_step_text: "", jd_text: "", questions: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string[] | null>(null);
  const set = (k: string, v: any) => setF((s) => ({ ...s, [k]: v }));

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError(null);
    try {
      const r = await api(secret, "/voice/api/jobs", { method: "POST", body: JSON.stringify({
        role: f.role, client: f.client || null, contact_email: f.contact_email, jd_text: f.jd_text,
        questions: f.questions.split("\n").map((s) => s.trim()).filter(Boolean),
        session_budget_seconds: Number(f.session_budget_seconds), next_step_text: f.next_step_text || null,
      }) });
      onDone(r.mandate.id);
    } catch (e: any) { setError(e instanceof ApiError && e.issues ? e.issues : [e.message]); setBusy(false); }
  }

  return (
    <section>
      <button className="hq-link" onClick={() => onDone(null)}>← Jobs</button>
      <h1>New job</h1>
      <p className="hq-dim">Paste the job description and the questions the hiring team wants asked, one per line. Charlie reads the mandate, writes the plan, and shows you every question with the requirement it exists to assess. Nothing is sent to anyone.</p>
      <form className="hq-form" onSubmit={submit}>
        <label>Role title<input required value={f.role} onChange={(e) => set("role", e.target.value)} /></label>
        <label>Client<input value={f.client} onChange={(e) => set("client", e.target.value)} /></label>
        <label>Hiring contact email<input required type="email" value={f.contact_email} onChange={(e) => set("contact_email", e.target.value)} /></label>
        <label>Call length in seconds<input required type="number" min={60} max={7200} value={f.session_budget_seconds} onChange={(e) => set("session_budget_seconds", e.target.value)} /></label>
        <label>What happens next, in the hiring team&apos;s own words (said to the candidate at the close; leave blank and Charlie says it does not set the timeline)<input value={f.next_step_text} onChange={(e) => set("next_step_text", e.target.value)} /></label>
        <label>Job description<textarea required rows={14} value={f.jd_text} onChange={(e) => set("jd_text", e.target.value)} /></label>
        <label>Additional questions, one per line<textarea rows={5} value={f.questions} onChange={(e) => set("questions", e.target.value)} /></label>
        {error && <ul className="hq-error">{error.map((m) => <li key={m}>{m}</li>)}</ul>}
        <button className="hq-btn" disabled={busy}>{busy ? "Reading the mandate and writing the plan. This takes about a minute." : "Generate plan"}</button>
      </form>
    </section>
  );
}

function JobDetail({ secret, id, onBack }: { secret: string; id: string; onBack: () => void }) {
  const [d, setD] = useState<any | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [by, setBy] = useState("");
  const [override, setOverride] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setD(await api(secret, `/voice/api/jobs/${id}`)); setError(null); } catch (e: any) { setError(e.message); }
  }, [secret, id]);
  useEffect(() => { load(); }, [load]);

  async function approve() {
    if (!d?.plan) return;
    setBusy(true); setNote(null);
    try { await api(secret, `/voice/api/jobs/${id}/plans/${d.plan.id}/approve`, { method: "POST", body: JSON.stringify({ by, override: override || null }) }); setNote("Approved. This version is now fixed; a change is a new version."); await load(); }
    catch (e: any) { setNote(e.message); }
    setBusy(false);
  }

  if (error) return <p className="hq-error">{error}</p>;
  if (!d) return <p className="hq-dim">Loading.</p>;
  const plan = d.plan; const chain = d.chain;
  const approved = plan?.status === "approved";

  return (
    <section>
      <button className="hq-link" onClick={onBack}>← Jobs</button>
      <h1>{d.mandate.role} <span className="hq-dim">{d.mandate.client ? `· ${d.mandate.client}` : ""}</span></h1>
      <p className="hq-dim">Contact {d.mandate.contact_email} · {d.plans.length} plan version{d.plans.length === 1 ? "" : "s"} · {d.sessions.length} call{d.sessions.length === 1 ? "" : "s"}</p>

      {plan && (
        <>
          <h2>Plan v{plan.version} <span className={`hq-pill is-${plan.status}`}>{plan.status}</span> <span className="hq-dim">· {plan.session_budget_seconds}s</span></h2>
          {chain && (chain.ok ? <p className="hq-ok">Every link holds: each question traces to a requirement, a quote, a reason, and what a sufficient answer contains.</p> : (
            <div className="hq-error"><p>The chain does not hold. This plan cannot be approved as it is:</p><ul>{chain.failures.map((f: any, i: number) => <li key={i}>{f.ref || "(plan)"} · {f.link}: {f.detail}</li>)}</ul></div>
          ))}
          {plan.flagged?.length > 0 && (
            <div className="hq-warn"><p>Questions Charlie will not ask without an override reason:</p><ul>{plan.flagged.map((f: any) => <li key={f.ref}>{f.ref}: {f.reason}</li>)}</ul></div>
          )}
          <ol className="hq-items">
            {[...plan.items].sort((a: any, b: any) => a.priority - b.priority).map((it: any) => {
              const c = it.evidence_contract;
              return (
                <li key={it.id} className="hq-item">
                  <div className="hq-row hq-between"><strong>{c.establishes}</strong><span className="hq-dim">{it.kind} · {it.ref} · {it.budget_seconds}s</span></div>
                  <dl className="hq-chain">
                    <dt>From the mandate</dt><dd>“{c.mandate_quote}”</dd>
                    <dt>Why it matters</dt><dd>{c.why_it_matters}</dd>
                    <dt>What would establish it</dt><dd>{c.elements.map((e: any) => `${e.name}${e.core ? " (core)" : ""}${e.required ? "*" : ""}`).join(", ")} <span className="hq-dim">(* required)</span></dd>
                    <dt>Opening question</dt><dd>{c.anchor_question}</dd>
                    <dt>Follow-ups</dt><dd>{c.depth_probes.map((p: any, i: number) => <div key={i}>{p.text} <span className="hq-dim">→ {p.targets}</span></div>)}{c.ownership_probe && <div>{c.ownership_probe} <span className="hq-dim">→ ownership</span></div>}</dd>
                    {c.scenario && <><dt>Scenario</dt><dd>{c.scenario}</dd></>}
                    <dt>A sufficient answer contains</dt><dd>{c.expected_evidence}</dd>
                  </dl>
                </li>
              );
            })}
          </ol>
          {!approved && plan.status === "draft" && (
            <div className="hq-form hq-inline">
              <label>Approve as (your email)<input type="email" value={by} onChange={(e) => setBy(e.target.value)} /></label>
              {plan.flagged?.length > 0 && <label>Override reason for the flagged questions<input value={override} onChange={(e) => setOverride(e.target.value)} /></label>}
              <button className="hq-btn" disabled={busy || !by || !chain?.ok} onClick={approve}>Approve plan v{plan.version}</button>
              {note && <p className="hq-dim">{note}</p>}
            </div>
          )}
          {approved && note && <p className="hq-ok">{note}</p>}
        </>
      )}

      {approved && <AddCandidate secret={secret} jobId={id} onAdded={load} />}

      {d.sessions.length > 0 && (
        <>
          <h2>Calls on this job</h2>
          <table className="hq-table"><thead><tr><th>Kind</th><th>Who</th><th>State</th><th>Created</th></tr></thead>
            <tbody>{d.sessions.map((s: any) => <tr key={s.id}><td>{s.kind}</td><td>{s.tester_email || s.candidate_id || ""}</td><td><span className={`hq-pill is-${s.state}`}>{s.state}</span></td><td className="hq-dim">{fmtDate(s.created_at)}</td></tr>)}</tbody>
          </table>
        </>
      )}
    </section>
  );
}

function AddCandidate({ secret, jobId, onAdded }: { secret: string; jobId: string; onAdded: () => void }) {
  const [kind, setKind] = useState<"candidate" | "test">("test");
  const [f, setF] = useState({ name: "", email: "", cv_text: "", tester_email: "" });
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<any | null>(null);
  const [error, setError] = useState<string[] | null>(null);
  const [copied, setCopied] = useState(false);
  const set = (k: string, v: string) => setF((s) => ({ ...s, [k]: v }));

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError(null); setResult(null);
    const body = kind === "candidate" ? { kind, email: f.email, name: f.name, cv_text: f.cv_text } : { kind, tester_email: f.tester_email };
    try { setResult(await api(secret, `/voice/api/jobs/${jobId}/candidates`, { method: "POST", body: JSON.stringify(body) })); onAdded(); }
    catch (e: any) { setError(e instanceof ApiError && e.issues ? e.issues : [e.message]); }
    setBusy(false);
  }

  return (
    <div className="hq-card">
      <h2>{kind === "test" ? "Test the verification yourself" : "Invite a candidate"}</h2>
      <div className="hq-row">
        <button className={`hq-toggle${kind === "test" ? " is-on" : ""}`} onClick={() => setKind("test")}>Test session (you)</button>
        <button className={`hq-toggle${kind === "candidate" ? " is-on" : ""}`} onClick={() => setKind("candidate")}>Real candidate</button>
      </div>
      <p className="hq-dim">{kind === "test" ? "Runs the exact plan, conversation, and evaluation a candidate would get. Nothing from a test session touches candidate data." : "Charlie does not send anything. You get a link and send it however you like. The candidate sees what this is, that it is recorded, and who sees it before they agree to anything."}</p>
      <form className="hq-form" onSubmit={submit}>
        {kind === "candidate" ? (
          <>
            <label>Name, as the hiring team has it<input required value={f.name} onChange={(e) => set("name", e.target.value)} /></label>
            <label>Email<input required type="email" value={f.email} onChange={(e) => set("email", e.target.value)} /></label>
            <label>CV, as text (required)<textarea required rows={8} value={f.cv_text} onChange={(e) => set("cv_text", e.target.value)} /></label>
          </>
        ) : (
          <label>Your email<input required type="email" value={f.tester_email} onChange={(e) => set("tester_email", e.target.value)} /></label>
        )}
        {error && <ul className="hq-error">{error.map((m) => <li key={m}>{m}</li>)}</ul>}
        <button className="hq-btn" disabled={busy}>{busy ? "Creating." : "Create link"}</button>
      </form>
      {result && (
        <div className="hq-ok">
          <p>Link created. It expires {fmtDate(result.expires_at)}.</p>
          <div className="hq-row"><code className="hq-code">{result.link}</code><button className="hq-btn" onClick={async () => { await navigator.clipboard.writeText(result.link); setCopied(true); }}>{copied ? "Copied" : "Copy link"}</button></div>
        </div>
      )}
    </div>
  );
}

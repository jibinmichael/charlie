"use client";
// app/hq/eval.tsx — the evidence package per call, the reviewer's agree/disagree per item with a
// reason (the ground-truth row), and the Learning view: open disagreements by reason and by job.
// Nothing here scores anybody; the words on the page are the six statuses and the candidate's own quotes.
import { useCallback, useEffect, useState } from "react";
import { api, fmtDate, secs } from "./api";
import { STATUSES, STATUS_LANGUAGE } from "../../voice/statuses.mjs";

const REASONS: Record<string, string> = {
  evidence_missed: "Evidence missed: it is in the transcript and was not extracted",
  evidence_insufficient: "Evidence insufficient: extracted, but it does not carry what the contract needs",
  evaluator_rule_incorrect: "Evaluator rule incorrect: the evidence is right, the status is wrong",
  mandate_ambiguous: "Mandate ambiguous: the requirement does not say what would satisfy it",
  candidate_answer_ambiguous: "Candidate answer ambiguous: a reasonable reader could go either way",
};

export default function Eval({ secret, focusCall }: { secret: string; focusCall: string | null }) {
  const [view, setView] = useState<"calls" | "learning">("calls");
  const [calls, setCalls] = useState<any[] | null>(null);
  const [open, setOpen] = useState<string | null>(focusCall);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setCalls((await api(secret, "/voice/api/calls")).calls.filter((c: any) => ["evaluated", "blocked", "awaiting_review", "reviewed", "reported"].includes(c.state))); setError(null); }
    catch (e: any) { setError(e.message); }
  }, [secret]);
  useEffect(() => { load(); }, [load]);

  if (error) return <p className="hq-error">{error}</p>;
  if (open) return <Package secret={secret} id={open} onBack={() => { setOpen(null); load(); }} />;

  return (
    <section>
      <div className="hq-row hq-between">
        <h1>Eval</h1>
        <div className="hq-row">
          <button className={`hq-toggle${view === "calls" ? " is-on" : ""}`} onClick={() => setView("calls")}>Packages</button>
          <button className={`hq-toggle${view === "learning" ? " is-on" : ""}`} onClick={() => setView("learning")}>Learning</button>
        </div>
      </div>
      {view === "learning" ? <Learning secret={secret} /> : calls === null ? <p className="hq-dim">Loading.</p> : calls.length === 0 ? <p className="hq-dim">Nothing evaluated yet. A package appears here once a call has been processed.</p> : (
        <table className="hq-table">
          <thead><tr><th>When</th><th>Who</th><th>Job</th><th>State</th></tr></thead>
          <tbody>{calls.map((c) => (
            <tr key={c.id} className="hq-click" onClick={() => setOpen(c.id)}>
              <td className="hq-dim">{fmtDate(c.completed_at || c.created_at)}</td><td>{c.name ? `${c.name} · ` : ""}{c.who}</td><td>{c.job?.role}</td><td><span className={`hq-pill is-${c.state}`}>{c.state}</span></td>
            </tr>
          ))}</tbody>
        </table>
      )}
    </section>
  );
}

function Package({ secret, id, onBack }: { secret: string; id: string; onBack: () => void }) {
  const [d, setD] = useState<any | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reviewer, setReviewer] = useState("");
  const [marks, setMarks] = useState<Record<string, { human_status: string; disagreement_reason: string; note: string }>>({});
  const [lift, setLift] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api(secret, `/voice/api/calls/${id}`);
      setD(r);
      const init: any = {};
      for (const s of r.signals) init[s.id] = { human_status: s.status, disagreement_reason: "", note: "" };
      setMarks(init);
    } catch (e: any) { setError(e.message); }
  }, [secret, id]);
  useEffect(() => { load(); }, [load]);

  if (error) return <p className="hq-error">{error}</p>;
  if (!d) return <p className="hq-dim">Loading.</p>;
  const pkg = d.package;
  const sigByItem: Record<string, any> = Object.fromEntries(d.signals.map((s: any) => [s.plan_item_id, s]));
  const isTest = d.session.kind === "test";

  async function save() {
    setSaving(true); setSaved(null);
    try {
      const per_signal = d.signals.map((s: any) => {
        const m = marks[s.id];
        return { signal_id: s.id, human_status: m.human_status, disagreement_reason: m.human_status === s.status ? null : (m.disagreement_reason || null), note: m.note || null };
      });
      await api(secret, `/voice/api/calls/${id}/review`, { method: "POST", body: JSON.stringify({ reviewer, report_version: d.report_version || 1, per_signal, evidence_lift: { evidence_ids_new_beyond_cv: [], note: lift || null } }) });
      setSaved("Saved. Every disagreement is now a case the next version has to get right.");
      await load();
    } catch (e: any) { setSaved(e.message); }
    setSaving(false);
  }

  const Sig = ({ s }: { s: any }) => {
    const sig = sigByItem[s.plan_item_id];
    const m = sig ? marks[sig.id] : null;
    const differs = m && m.human_status !== sig.status;
    return (
      <li className="hq-item">
        <div className="hq-row hq-between"><strong>{s.establishes}</strong><span className="hq-dim">{s.ref}</span></div>
        <p><span className={`hq-status is-${s.status}`}>{s.status.replace("_", " ")}</span> <span className="hq-dim">· {s.coverage_band.replace(/_/g, " ")}{s.reason ? ` · ${s.reason}` : ""}</span></p>
        <p>{s.status_text}</p>
        {s.evidence.length > 0 && (
          <ul className="hq-quotes">{s.evidence.map((q: any) => (
            <li key={q.evidence_id}><span className="hq-dim">{secs(q.audio_start_secs)} · {q.contract_element} · {q.type} · specificity {q.specificity} · {q.ownership}{q.probe_depth ? ` · follow-up ${q.probe_depth}` : ""}{q.reliability !== "usable" ? ` · ${q.reliability}` : ""}</span><div>“{q.quote}”</div></li>
          ))}</ul>
        )}
        {s.missing_elements.length > 0 && <p className="hq-dim">What would have raised this: {s.missing_elements.join(", ")}.</p>}
        {sig && m && !isTest && (
          <div className="hq-review">
            <label>Your reading
              <select value={m.human_status} onChange={(e) => setMarks({ ...marks, [sig.id]: { ...m, human_status: e.target.value } })}>
                {STATUSES.map((st: string) => <option key={st} value={st}>{st.replace("_", " ")}</option>)}
              </select>
            </label>
            {differs && (
              <label>Why Charlie was wrong
                <select value={m.disagreement_reason} onChange={(e) => setMarks({ ...marks, [sig.id]: { ...m, disagreement_reason: e.target.value } })}>
                  <option value="">choose a reason</option>
                  {Object.entries(REASONS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </label>
            )}
            <label>Note<input value={m.note} onChange={(e) => setMarks({ ...marks, [sig.id]: { ...m, note: e.target.value } })} /></label>
          </div>
        )}
      </li>
    );
  };

  return (
    <section>
      <button className="hq-link" onClick={onBack}>← Eval</button>
      {!pkg ? (
        <><h1>{d.candidate?.name_as_given || d.session.tester_email}</h1><p className="hq-dim">No package yet for this call (state {d.session.state}).</p></>
      ) : (
        <>
          <h1>{pkg.header.candidate_name_as_given || d.session.tester_email} <span className="hq-dim">· {pkg.header.role}{isTest ? " · TEST SESSION" : ""}</span></h1>
          <p className="hq-dim">{fmtDate(pkg.header.session_date)} · {pkg.header.items_reached} of {pkg.header.items_total} items reached · {secs(pkg.header.duration_seconds)} · plan v{pkg.header.plan_version} · extractor {pkg.header.extractor_version} · evaluator {pkg.header.evaluator_version}</p>

          <h2>Must-haves</h2>
          <table className="hq-table"><thead><tr><th>Requirement</th><th>Asked and answered</th><th>Their words</th></tr></thead>
            <tbody>{pkg.must_have_gate.map((g: any) => <tr key={g.ref}><td>{g.establishes}</td><td>{g.verdict}</td><td>{g.answer_quote ? `“${g.answer_quote}”` : <span className="hq-dim">not answered</span>}</td></tr>)}</tbody>
          </table>
          <p className="hq-dim">Whether an answer meets the bar is yours to decide from their words; Charlie does not guess it.</p>

          <h2>Capabilities</h2>
          <ol className="hq-items">{pkg.capability_grid.map((s: any) => <Sig key={s.ref} s={s} />)}</ol>

          {pkg.intent && (<><h2>Why this role, in their words</h2><ol className="hq-items"><Sig s={pkg.intent} /></ol></>)}

          {pkg.hr_answers.length > 0 && (<><h2>The hiring team&apos;s questions</h2><ul>{pkg.hr_answers.map((a: any) => <li key={a.ref}><strong>{a.question}</strong><div>{a.answer_quote ? `“${a.answer_quote}”` : "not answered"}</div></li>)}</ul></>)}

          {pkg.contradictions.length > 0 && (<><h2>Statements that differ</h2><ul>{pkg.contradictions.map((c: any, i: number) => <li key={i}><span className="hq-dim">{c.field}{c.resolved ? " · resolved by the candidate" : " · open, a question for a human"}</span><div>“{c.quote_a}”</div><div>{c.quote_b ? `“${c.quote_b}”` : `CV: ${c.cv_line}`}</div></li>)}</ul></>)}

          {pkg.gaps.length > 0 && (<><h2>Not established in this session</h2><ul>{pkg.gaps.map((g: any) => <li key={g.ref}>{g.establishes} <span className="hq-dim">· {g.status.replace("_", " ")} · {g.reason}</span></li>)}</ul></>)}

          <h2>Communication</h2>
          <p className="hq-dim">{pkg.communication.note} {Object.entries(pkg.communication.conditions).map(([k, v]) => `${k} ${v ?? "n/a"}`).join(" · ")}</p>

          <h2>What this does not tell you</h2>
          <ul>{pkg.limitations.map((l: string) => <li key={l}>{l}</li>)}</ul>

          {!isTest && (
            <div className="hq-card">
              <h2>Your review</h2>
              <p className="hq-dim">Set your reading on each item above. Where it differs from Charlie&apos;s, say why. This is how the next version learns; nothing changes on its own.</p>
              {d.review && <p className="hq-dim">Last review by {d.review.reviewer} on {fmtDate(d.review.recorded_at)}.</p>}
              <div className="hq-form">
                <label>Your email<input type="email" value={reviewer} onChange={(e) => setReviewer(e.target.value)} /></label>
                <label>What did this add beyond the CV and the screening call?<textarea rows={3} value={lift} onChange={(e) => setLift(e.target.value)} /></label>
                <button className="hq-btn" disabled={saving || !reviewer} onClick={save}>Save review</button>
                {saved && <p className="hq-dim">{saved}</p>}
              </div>
            </div>
          )}
        </>
      )}
      <p className="hq-dim hq-foot">{Object.keys(STATUS_LANGUAGE).length} statuses, no score.</p>
    </section>
  );
}

function Learning({ secret }: { secret: string }) {
  const [d, setD] = useState<any | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { (async () => { try { setD(await api(secret, "/voice/api/learning")); } catch (e: any) { setError(e.message); } })(); }, [secret]);
  if (error) return <p className="hq-error">{error}</p>;
  if (!d) return <p className="hq-dim">Loading.</p>;
  const reasons = Object.entries(d.by_reason) as [string, any][];
  return (
    <div>
      <p>{d.totals.reviewed} items reviewed · {d.totals.agreed} agreed · {d.totals.disagreed} disagreed</p>
      <p className="hq-dim">A disagreement is a case the next version must get right. It is fixed in a versioned prompt or rule, proven on every past case, and shipped with a new version number; nothing adjusts on its own.</p>
      {reasons.length === 0 ? <p className="hq-dim">No disagreements recorded yet.</p> : (
        <table className="hq-table"><thead><tr><th>Reason</th><th>Count</th><th>By job</th><th>By evaluator version</th></tr></thead>
          <tbody>{reasons.sort((a, b) => b[1].count - a[1].count).map(([r, v]) => <tr key={r}><td>{REASONS[r] || r}</td><td>{v.count}</td><td className="hq-dim">{Object.entries(v.jobs).map(([j, n]) => `${j} ${n}`).join(" · ")}</td><td className="hq-dim">{Object.entries(v.versions).map(([j, n]) => `${j} ${n}`).join(" · ")}</td></tr>)}</tbody>
        </table>
      )}
      {d.open.length > 0 && (
        <>
          <h2>Open cases</h2>
          <ul className="hq-events">{d.open.map((o: any, i: number) => <li key={i}><span className="hq-dim">{fmtDate(o.recorded_at)} · {o.role}</span> Charlie said {o.charlie_status.replace("_", " ")}, {o.reviewer} said {o.human_status.replace("_", " ")} · {o.reason}{o.note ? ` · ${o.note}` : ""}</li>)}</ul>
        </>
      )}
    </div>
  );
}

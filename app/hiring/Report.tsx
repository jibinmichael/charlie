"use client";
import { useState } from "react";

const ACC = "#c8502a", MID = "#8f8f8f", LT = "#c9c9c9", XLT = "#e5e5e5", DK = "#3a3a3a";

// ---- data (verified / corrected values; do not change without re-running the extractor) ----
const SKILLS: [string, number, string][] = [
  ["Python", 16.8, ""], ["LLM / GenAI", 13.6, "a"], ["AWS", 11.8, ""], ["SQL", 11.1, ""], ["Salesforce", 10.2, ""],
  ["Machine Learning", 9.0, ""], ["GCP", 8.4, ""], ["Kubernetes", 6.7, ""], ["TypeScript", 6.2, ""], ["React", 5.6, ""],
];
// sectors assigned by classifying each of the 929 companies into an industry (LLM pass over
// company + postings), then counting roles. 928/929 classified; Other = 2.6%.
const SECTORS: [string, number, string][] = [
  ["Fintech & payments", 12.9, ""], ["Data & analytics", 12.4, ""], ["Enterprise & productivity", 8.2, ""],
  ["AI models & infra", 8.1, "a"], ["Healthcare & biotech", 7.4, ""], ["Developer tools", 6.7, ""],
  ["Commerce & retail", 5.7, ""], ["Security", 5.2, ""], ["Cloud & infrastructure", 4.4, ""], ["HR & people", 4.1, ""],
];
// corrected: junior share is ~1-2% in every function (old numbers counted "Associate Director" as junior)
const JUNIOR: [string, number, string][] = [
  ["Marketing", 1.9, ""], ["Operations", 1.7, ""], ["Design", 1.6, ""], ["Customer / Support", 1.3, ""],
  ["Engineering", 1.1, "a"], ["Sales", 1.0, ""], ["Data / ML / AI", 0.8, "a"],
];
const EMERGENT: [string, number, string][] = [
  ["Forward Deployed Engineer", 135, "dark"], ["Applied AI / Scientist", 71, ""], ["Founding roles", 70, ""],
  ["AI Engineer", 67, ""], ["AI Product roles", 41, ""], ["Research Engineer", 23, ""], ["GTM Engineer", 21, ""],
];
type Role = { name: string; count: string; must: [string, number][]; nice: [string, number][]; senior: string; seniorSub: string; remote: string; remoteSub: string; pay: string };
const ROLES: Role[] = [
  { name: "Software Engineer", count: "1,311 live roles", must: [["Python", 40], ["AWS", 31], ["TypeScript", 30], ["React", 27]], nice: [["Kubernetes", 24], ["LLM / GenAI", 23], ["GCP", 19]], senior: "65% senior+", seniorSub: "1% junior", remote: "47% remote", remoteSub: "31% US-only", pay: "24%" },
  { name: "Data / ML / AI", count: "344 live roles", must: [["Python", 68], ["LLM / GenAI", 47], ["Machine Learning", 46], ["SQL", 42]], nice: [["Airflow", 22], ["Snowflake", 20], ["RAG", 17], ["Fine-tuning", 15]], senior: "62% senior+", seniorSub: "1% junior", remote: "49% remote", remoteSub: "41% US-only", pay: "21%" },
  { name: "DevOps", count: "307 live roles", must: [["Kubernetes", 58], ["AWS", 54], ["Python", 47], ["Terraform", 45]], nice: [["GCP", 38], ["CI/CD", 38], ["Azure", 25]], senior: "60% senior+", seniorSub: "15% manager", remote: "53% remote", remoteSub: "32% US-only", pay: "21%" },
  { name: "Product Manager", count: "400 live roles", must: [], nice: [["LLM / GenAI", 24], ["Prototyping", 18], ["SQL", 16], ["Salesforce", 10]], senior: "95% manager-level", seniorSub: "", remote: "46% remote", remoteSub: "34% US-only", pay: "21%" },
  { name: "Designer", count: "209 live roles", must: [["Prototyping", 52], ["Design Systems", 50], ["Figma", 44]], nice: [["User Research", 12], ["LLM / GenAI", 11]], senior: "54% senior+", seniorSub: "2% junior", remote: "44% remote", remoteSub: "32% US-only", pay: "23%" },
  { name: "Sales", count: "752 live roles", must: [["Outbound", 29], ["Salesforce", 26]], nice: [["CRM", 21], ["HubSpot", 7]], senior: "11% senior+", seniorSub: "12% manager", remote: "50% remote", remoteSub: "27% US-only", pay: "15%" },
];

function Waffle({ spec }: { spec: [number, string][] }) {
  const cells: string[] = [];
  spec.forEach(([n, c]) => { for (let i = 0; i < n; i++) cells.push(c); });
  return <div className="waffle">{cells.map((c, i) => <i key={i} style={{ background: c }} />)}</div>;
}

function BarRows({ data, unit, sm, count }: { data: [string, number, string][]; unit: (v: number) => string; sm?: boolean; count?: boolean }) {
  const max = Math.max(...data.map((d) => d[1]));
  return (
    <div className={`rows${sm ? " sm" : ""}${count ? " count" : ""}`}>
      {data.map(([lbl, v, cls]) => (
        <div className={`row${cls ? " " + cls : ""}`} key={lbl}>
          <span className="lbl">{lbl}</span>
          <div className="track"><div className="fill" style={{ width: `${(v / max) * 100}%` }} /></div>
          <span className="val">{unit(v)}</span>
        </div>
      ))}
    </div>
  );
}

const DOTS: [string, number, number, number, boolean][] = [
  ["Sales / AE", 18, 38, 20, false], ["Marketing", 55, 82, 18, false], ["Designer", 71, 58, 16, false],
  ["Product Mgr", 72, 44, 18, false], ["Data / ML / AI", 84, 36, 17, true], ["DevOps", 81, 22, 17, true], ["Software Eng", 89, 47, 32, true],
];
function Scatter() {
  return (
    <>
      <div className="scatter">
        <span className="ax y">How remote-open →</span>
        <div className="gridline" style={{ top: "25%" }} />
        <div className="gridline" style={{ top: "50%" }} />
        <div className="gridline" style={{ top: "75%" }} />
        <div className="squeeze" />
        <span className="squeeze-lbl">The squeeze: senior, remote, closed to newcomers</span>
        {DOTS.map(([label, left, top, size, isIn]) => (
          <div className={`dot${isIn ? " in" : ""}`} style={{ left: `${left}%`, top: `${top}%` }} key={label}>
            <i style={{ width: size, height: size }} /><span>{label}</span>
          </div>
        ))}
      </div>
      <p className="ax x">How senior the demand is →</p>
    </>
  );
}

function RoleExplorer() {
  const [i, setI] = useState(0);
  const r = ROLES[i];
  const max = Math.max(...[...r.must, ...r.nice].map((x) => x[1]));
  const barsFor = (rows: [string, number][], cls: string) => (
    <div className="rows sm">
      {rows.map(([lbl, v]) => (
        <div className={`row${cls}`} key={lbl}>
          <span className="lbl">{lbl}</span>
          <div className="track"><div className="fill" style={{ width: `${(v / max) * 100}%` }} /></div>
          <span className="val">{v}%</span>
        </div>
      ))}
    </div>
  );
  return (
    <>
      <div className="pills">{ROLES.map((ro, k) => <span key={ro.name} className={`pill${k === i ? " on" : ""}`} onClick={() => setI(k)}>{ro.name}</span>)}</div>
      <div className="role-grid">
        <div>
          <p className="role-name">{r.name}</p>
          <p className="role-count">{r.count}</p>
          {r.must.length > 0 && <><p className="mh">Must-have</p>{barsFor(r.must, " dark")}</>}
          <p className="mh">Nice-to-have</p>
          {barsFor(r.nice, "")}
        </div>
        <div>
          <div className="rstat"><p className="k">Who gets hired</p><p className="v"><b className="a">{r.senior}</b>{r.seniorSub ? <> <span>·</span> <b>{r.seniorSub}</b></> : null}</p></div>
          <div className="rstat"><p className="k">Remote share</p><p className="v"><b>{r.remote}</b> <span>· {r.remoteSub}</span></p></div>
          <div className="rstat last"><p className="k">Pay shown</p><p className="v"><b>{r.pay}</b> <span>of postings</span></p></div>
        </div>
      </div>
    </>
  );
}

export default function Report() {
  return (
    <div className="soh">
      <div className="page">
        <div className="masthead"><span className="brand">Charlie · State of Hiring</span><span className="date">JULY 2026</span></div>

        <header>
          <h1>AI isn’t taking the jobs. <em>It’s rewriting them.</em></h1>
          <p className="dek">We read <b>11,530 live roles</b> across 929 companies. Barely any are actually AI jobs. But AI skills have moved into the core of nearly every role, and the bottom rung of the career ladder has all but disappeared.</p>
          <p className="stamp"><span><b>11,530</b> live roles</span><span><b>929</b> companies</span><span><b>10</b> job boards</span><span>as of <b>Jul 6, 2026</b></span></p>
        </header>

        <section><div className="graphic">
          <p className="g-kicker">The AI hype gap</p>
          <h2>Companies talk about AI ten times more than they hire for it</h2>
          <p className="g-sub">Each square is one of 100 open roles.</p>
          <div className="big-lock">
            <div className="left">
              <p className="bignum">6.5%</p>
              <p className="bigsub">of open roles are actually AI jobs.</p>
              <p className="bigsupport">Another 61 in 100 mention AI without hiring for it. A third of the market stays silent.</p>
            </div>
            <div><Waffle spec={[[7, ACC], [61, MID], [32, XLT]]} /><p className="w-cap">100 open roles</p></div>
          </div>
          <div className="legend">
            <span><i style={{ background: ACC }} /><b>7</b>&nbsp;actually hire for AI</span>
            <span><i style={{ background: MID }} /><b>61</b>&nbsp;just mention it</span>
            <span><i style={{ background: XLT }} /><b>32</b>&nbsp;silent</span>
          </div>
          <p className="takeaway">If you are waiting for a role titled <b className="a">“AI,”</b> you are watching the wrong door.</p>
          <p className="source">Source: 11,530 live roles read by Charlie, July 6, 2026.</p>
        </div></section>

        <section><div className="index">
          <div className="cell"><p className="num a">1%</p><p className="d">of eng, data &amp; design roles are <b>junior</b>. The ladder’s bottom rung is gone.</p></div>
          <div className="cell"><p className="num">44%</p><p className="d">of <em>Remote</em> roles are quietly <b>US-only</b>.</p></div>
          <div className="cell"><p className="num">21%</p><p className="d">of roles <b>disclose the pay</b>. Four in five don’t.</p></div>
          <div className="cell"><p className="num">2.9%</p><p className="d">are <b>titles the AI era invented</b>, and growing.</p></div>
        </div></section>

        <section><div className="graphic">
          <p className="g-kicker">The remote question</p>
          <h2>Remote is the exception, not the rule</h2>
          <p className="g-sub">Share of all 11,530 roles that are open to remote work.</p>
          <div className="splitbar">
            <div className="seg a" style={{ width: "41%" }}>Remote-open · 41%</div>
            <div className="seg g" style={{ width: "59%" }}>Tied to a location · 59%</div>
          </div>
          <p className="annot"><b>The remote wave has crested.</b> <span>For most roles now, the desk comes with an address.</span></p>
          <p className="source">Remote status from each posting&rsquo;s remote flag. Hybrid is rarely labeled in postings, so it is not split out.</p>
        </div></section>

        <section><div className="graphic">
          <p className="g-kicker">Remote, in name</p>
          <h2>Half of <em>Remote</em> stops at the US border</h2>
          <p className="g-sub">Each square is one of 100 remote roles, grouped by where the posting says it is open.</p>
          <div className="big-lock">
            <div className="left">
              <p className="bignum">44</p>
              <p className="bigsub">of every 100 remote roles are US-only.</p>
              <p className="bigsupport">Only 2 in 100 are open to anyone, anywhere. Just 2 more reach India. Another 11 say only <em>Remote</em>, with no country at all.</p>
            </div>
            <div><Waffle spec={[[44, ACC], [14, MID], [29, LT], [11, XLT], [2, DK]]} /><p className="w-cap">100 remote roles</p></div>
          </div>
          <div className="legend">
            <span><i style={{ background: ACC }} /><b>44</b>&nbsp;US only</span>
            <span><i style={{ background: MID }} /><b>14</b>&nbsp;Europe / UK</span>
            <span><i style={{ background: LT }} /><b>29</b>&nbsp;rest of world</span>
            <span><i style={{ background: XLT }} /><b>11</b>&nbsp;just <em>Remote</em></span>
            <span><i style={{ background: DK }} /><b>2</b>&nbsp;open to anyone</span>
          </div>
          <p className="takeaway">For most of the world, <em>Remote</em> is a word, not an offer.</p>
          <p className="source">“US-only” counts remote roles whose stated location names the United States; read as directional.</p>
        </div></section>

        <section><div className="graphic">
          <p className="g-kicker">The entry-level door</p>
          <h2>The entry-level door has closed almost everywhere</h2>
          <p className="g-sub">Share of each function’s open roles that are junior.</p>
          <BarRows data={JUNIOR} unit={(v) => `${v}%`} />
          <p className="annot"><b>No function is a way in anymore.</b> <span>Whatever the field, fewer than two openings in 100 will take someone starting out.</span></p>
          <p className="source">Junior share inferred from posting seniority language; figures are directional.</p>
        </div></section>

        <section><div className="graphic">
          <p className="g-kicker">Skills</p>
          <h2>The skill every role now wants is barely three years old</h2>
          <p className="g-sub">Share of all 11,530 roles that name each skill.</p>
          <BarRows data={SKILLS} unit={(v) => `${v}%`} />
          <p className="annot"><b>LLM / GenAI is the #2 skill in the entire market,</b> <span>ahead of AWS and SQL, tools that took a decade to get there.</span></p>
          <p className="source">Skills inferred from posting text; a role can name several.</p>
        </div></section>

        <section><div className="graphic">
          <p className="g-kicker">The squeeze</p>
          <h2>The market has drifted senior, remote, and shut</h2>
          <p className="g-sub">Every role by how senior the demand is and how open to remote work. Bubble size shows live roles.</p>
          <Scatter />
          <p className="takeaway">The tech core has moved up and to the right. The jobs are real, but the path that used to lead to them is <b className="a">gone</b>.</p>
          <p className="source">Positions computed from seniority and remote-openness of each role family’s postings.</p>
        </div></section>

        <section><div className="graphic">
          <p className="g-kicker">Role explorer</p>
          <h2>What your role actually demands</h2>
          <p className="g-sub">Must-haves (named in a quarter or more of postings) vs. nice-to-haves, and who is really getting hired.</p>
          <RoleExplorer />
        </div></section>

        <section><div className="graphic">
          <p className="g-kicker">Sectors</p>
          <h2>Fintech and data are hiring harder than the AI labs</h2>
          <p className="g-sub">Share of all 11,530 roles, by each company&rsquo;s primary sector.</p>
          <BarRows data={SECTORS} unit={(v) => `${v}%`} />
          <p className="annot"><b>For all the noise, the sectors with the most open roles are fintech and data.</b> <span>The AI model-builders are real, but they rank fourth, not first.</span></p>
          <p className="source">Each of the 929 companies classified into its primary sector; role counts follow. Long-tail sectors not shown.</p>
        </div></section>

        <section><div className="graphic">
          <p className="g-kicker">New titles</p>
          <h2>The jobs that did not exist three years ago</h2>
          <p className="g-sub">Live counts of job titles the AI era invented.</p>
          <BarRows data={EMERGENT} unit={(v) => `${v}`} count />
          <div className="zero">
            <span className="n">0</span>
            <p><b>“Prompt Engineer,” the one everyone predicted?</b> <span>Zero live roles. It was folded into AI Engineer before it ever became a job.</span></p>
          </div>
          <p className="source">Titles counted by exact and near-exact match across the pool.</p>
        </div></section>

        <section className="cta">
          <h2>This is the whole market. Charlie finds your corner of it.</h2>
          <p>Charlie reads your real experience, checks it against every live role, and emails you only the ones genuinely reachable from where you live.</p>
          <a className="btn" href="/#write">Write Charlie →</a>
        </section>

        <p className="method"><b>Methodology.</b> Built from Charlie’s live job pool of 11,530 open roles across 929 companies, read from public job boards (Greenhouse, Ashby, Lever, SmartRecruiters and others) as of July 6, 2026, de-duplicated and freshness-checked. Skills and seniority are inferred from posting text, so those figures are directional. Sectors are assigned by classifying each of the 929 companies into its primary industry. Pay covers only the roughly 21% of roles that disclose it. “US-only” counts remote roles whose location names the United States. Coverage skews toward tech and AI-forward companies. This is not a survey, just what companies posted, and every figure is reproducible from the pool.</p>
        <footer><b>Charlie</b> reads the whole market and emails you one role worth your time</footer>
      </div>
    </div>
  );
}

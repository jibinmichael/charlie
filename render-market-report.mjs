// render-market-report.mjs — renders a "State of Your Market" briefing (built by market-report.mjs)
// into an email in CHARLIE'S OWN lifecycle language: the warm card shell (email-kit's emailShell,
// the hand logo + "your job search, handled" sign-off), Sanchez headings, Avenir body, the tiny coral
// eyebrow, and the single-rust bar chart that renderHiringReport already established. NOT a newspaper,
// NOT the locked role email. Same design system as the rest of Charlie's mail, a new letter within it.
//
// DESIGN BAR: Stripe. Chart-forward, generous whitespace, hairline rules, calm coral used once per
// idea, numerals never mixed with number-words. Diagrams carry the story; prose stays but stays tight.
//
// VOICE: first person, warm, a little funny. Charlie speaks as "I" ("this morning I read 13,860 posts
// for you"), never "Charlie" in the third person, never a machine register. No jargon the reader would
// not use. No bold inside sentences. No em dashes (esc strips them). It reads like a sharp friend who
// did the digging by hand and is telling you the honest version because you are worth it.
//
// EMAIL-SAFE (same discipline as email-kit / render-email): table layout, inline styles, %-width <td>
// bar cells (never <svg> — Gmail strips it), web-safe stacks (Sanchez degrades to Georgia on Gmail).
//
// GROUNDING: this layer only FRAMES the numbers market-report.mjs counted. Every figure is passed in;
// none is computed or invented here. Bar widths are proportional to real counts, never a decorative
// fake. No name is printed unless the dossier grounds one.
//
//   import { renderMarketReport } from "./render-market-report.mjs";
//   const { subject, html } = renderMarketReport(report, { email });

import { esc, emailShell, unsubUrlFor, cleanSubject } from "./email-kit.mjs";
import { LIFECYCLE } from "./emails/tokens.mjs";
import { chartPlan } from "./lib/gap-chart.mjs";

const SANS = LIFECYCLE.fonts.sans;
const HEAD = LIFECYCLE.fonts.head; // Sanchez -> Georgia
const C = LIFECYCLE.colors;
const CH = LIFECYCLE.chart; // { rust:#C8502A, grey:#8F8F8F, ink:#1A1A1A, track:#EEEEEE }
const PALE = "#DBD6CE"; // the "quiet" neutral for empty comp dots

const nf = (n) => Number(n || 0).toLocaleString("en-US");
const cap = (s) => String(s).replace(/^\w/, (m) => m.toUpperCase());
const lc1 = (s) => String(s).replace(/^\w/, (m) => m.toLowerCase()); // lowercase first letter for mid-sentence use
// Indian comp the way people say it: 80L, 1 Cr.
function inr(n) {
  if (n == null) return "";
  if (n >= 10000000) return `${(n / 10000000).toFixed(n % 10000000 ? 2 : 0).replace(/\.00$/, "")} Cr`;
  return `${Math.round(n / 100000)}L`;
}
// Comp with the person's OWN currency symbol (grounding: never render a USD floor as ₹, and never
// ASSERT a currency the person did not state). Only the two currencies market-report.mjs actually parses
// get a symbol; an unknown / null comp_currency renders a bare number, never a guessed ₹ or $.
function moneyFmt(n, ccy) {
  if (n == null) return "";
  if (ccy === "USD") return `$${Math.round(n / 1000)}K`;
  if (ccy === "INR") return `&#8377;${inr(n)}`;
  // A currency we hold no symbol for is still a currency the PERSON stated, so name it rather than
  // print a bare number that could be read as any denomination. Null/absent stays a bare number.
  return ccy ? `${esc(String(ccy).toUpperCase())} ${nf(n)}` : nf(n);
}
// How a currency reads mid-sentence.
const ccyWord = (c) => (c === "INR" ? "rupees" : c === "USD" ? "dollars" : String(c || "another currency"));
// A comp floor is only worth NAMING when it is a sane, non-trivial number in its currency. Floors are
// sometimes stored in the wrong magnitude (a sub-lakh rupee value, a 0, an unset field). Rendering
// "Clears ₹0L", or claiming a role "pays what you asked" against a ~0 floor, is misleading — so below
// the threshold we DROP the floor claim entirely and show only what's disclosed.
//
// The bar is PER CURRENCY. A single "$1,000 for USD, ₹1,00,000 for everything else" bar would discard
// a real floor stated in another major currency (EUR 50,000 falls under the rupee bar) and tell the
// person they never named one. Only INR needs the high bar in the markets Charlie serves; an unlisted
// currency gets the major-unit bar, because wrongly telling someone they never gave a number is worse
// than showing a floor we could have questioned.
const FLOOR_MIN = { INR: 100000 };
const FLOOR_MIN_DEFAULT = 1000; // USD, EUR, GBP, AED, SGD...
function meaningfulFloor(floor, ccy) {
  if (!Number.isFinite(floor) || floor <= 0) return false;
  return floor >= (FLOOR_MIN[String(ccy || "").toUpperCase()] ?? FLOOR_MIN_DEFAULT);
}
// The person's home region, named honestly (drawn from their dossier via report.meta.region), so the
// "at your level it's thin" line is grounded to THEIR market, not hardcoded to India.
function regionLabel(region) {
  const r = String(region || "").toLowerCase();
  if (/india/.test(r)) return "India";
  if (/\b(us|usa|united states|america)\b/.test(r)) return "the US";
  return "the market";
}
// domain label phrased for mid-sentence, Gen-AI spelled the correct way.
const fixAI = (s) => String(s).replace(/gen-?ai/gi, "Gen-AI");
const gflow = (x) => fixAI(x.flow || x.label);

// ── Charlie lifecycle primitives (matched to email-kit.mjs; not exported there, so mirrored here) ──
// The eyebrow: sentence case, coral, a whisper of tracking. NOT uppercase — tracked-out all-caps labels
// read as generic slop and break the voice rule (never ALL CAPS). The coral + weight carry the accent;
// the case stays human, in the same warm register as the copy below it.
const lead = (t, color = C.coral) =>
  `<p style="font-family:${SANS};font-size:12px;font-weight:600;letter-spacing:.01em;color:${color};margin:0 0 11px;">${esc(cap(t))}</p>`;
const h1 = (t) =>
  `<h1 style="font-family:${HEAD};font-weight:400;font-size:22px;line-height:1.3;letter-spacing:-.01em;color:${C.ink};margin:0 0 14px;">${esc(t)}</h1>`;
const p = (html) =>
  `<p style="font-family:${SANS};font-size:14.5px;line-height:1.62;color:${C.text};margin:0 0 14px;">${html}</p>`;
const note = (html) =>
  `<p style="font-family:${SANS};font-size:12px;line-height:1.5;color:${C.muted};margin:0 0 4px;">${html}</p>`;
const gap = (h) => `<div style="height:${h}px;line-height:${h}px;font-size:1px;">&nbsp;</div>`;
const hr = () => `<div style="border-top:1px solid ${C.line};font-size:1px;line-height:1px;margin:32px 0;">&nbsp;</div>`;

// single bar row (renderHiringReport style): label | grey track w/ proportional fill | value.
// Thin (10px) with tabular-aligned value on the right — the Stripe read: quiet, precise, scannable.
function bar(label, pct, val, color = CH.grey) {
  const w = Math.max(2, Math.min(100, pct));
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 10px;"><tbody><tr>
    <td width="164" style="font-family:${SANS};font-size:13px;color:${CH.ink};text-align:right;padding-right:14px;vertical-align:middle;">${esc(label)}</td>
    <td style="vertical-align:middle;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${CH.track};"><tbody><tr>
        <td width="${w.toFixed(1)}%" style="background:${color};height:10px;font-size:1px;line-height:10px;">&nbsp;</td>
        <td style="font-size:1px;line-height:10px;">&nbsp;</td>
      </tr></tbody></table>
    </td>
    <td width="30" align="right" style="font-family:${SANS};font-size:12.5px;color:${CH.ink};padding-left:12px;vertical-align:middle;">${esc(String(val))}</td>
  </tr></tbody></table>`;
}
// tiny two-tone legend line under a chart.
const legend = (items) =>
  note(
    items
      .map(([col, txt]) => `<span style="display:inline-block;width:9px;height:9px;border-radius:2px;background:${col};margin-right:6px;vertical-align:middle;"></span>${esc(txt)}`)
      .join(" &nbsp;&nbsp; ")
  );

// ── sections ─────────────────────────────────────────────────────────────────
// The funnel: two PER-PERSON stages (in-your-field -> you-can-take), numerals only, an arrow between.
// The raw scan total is not shown: it is the SAME global number for EVERY user (static, not theirs),
// so it reads as a brag. The h1 conveys the reading; the funnel stays entirely about them.
function opener(report) {
  const f = report.funnel;
  const stage = (n, l, strong = false) => `<td align="center" style="vertical-align:middle;padding:2px 4px;">
      <div style="font-family:${HEAD};font-size:${strong ? 34 : 27}px;font-weight:400;color:${strong ? C.coral : C.ink};line-height:1;">${esc(nf(n))}</div>
      ${gap(7)}
      <div style="font-family:${SANS};font-size:11px;color:${C.muted};line-height:1.35;">${esc(l)}</div>
    </td>`;
  const arrow = `<td width="26" align="center" style="vertical-align:middle;font-family:${SANS};font-size:16px;color:${C.faint};">&rarr;</td>`;
  const role = report.meta?.role;
  const roleWord = role ? `${lc1(role)} roles` : "roles at your level";
  return (
    lead("just between us") +
    h1(`I did today's reading with you in mind.`) +
    p(`I went hunting for ${esc(roleWord)}, then set aside everything out of reach for now. Here is what is really yours.`) +
    gap(4) +
    `<div style="background:${C.soft};border-radius:12px;padding:24px 10px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tbody><tr>
      ${stage(f.inField, "In your field")}
      ${arrow}
      ${stage(f.addressable, "You can take", true)}
    </tr></tbody></table></div>` +
    gap(6) +
    note(`Across ${nf(f.companies)} companies. The ${nf(f.unreachable)} I set aside were real jobs, just not within reach right now.`)
  );
}

function seniority(report) {
  const s = report.seniority;
  const T = report.tierLabels;
  const order = ["exec", "director", "principalStaff", "senior", "ic", "apm"];
  const barIdx = order.indexOf(report.barTier);
  // WINDOW the ladder to the person's own reach: their line, everything below it (their fallback), and at
  // most two rungs above. A person is NEVER shown a level they did not reach for — a Lead never gets the VP
  // row, a junior never gets Director.
  const start = Math.max(0, barIdx - 2);
  const shown = order.slice(start);
  const max = Math.max(...shown.map((k) => s[k]), 1);
  const bars = shown.map((k) => bar(T[k], (s[k] / max) * 100, s[k], order.indexOf(k) <= barIdx ? C.coral : CH.grey)).join("");
  const atLine = s[report.barTier] || 0;
  const above = order.slice(start, barIdx).map((k) => ({ label: T[k], n: s[k] })).filter((a) => a.n > 0);
  const aboveTotal = order.slice(0, barIdx).reduce((n, k) => n + s[k], 0);
  const region = regionLabel(report.meta?.region);
  // ADAPT the framing to where they actually are. Senior (few roles above) -> the honest "room above is
  // thin". Earlier-career (plenty above) -> "the next rung is open", never a discouraging "you can't".
  const thinAbove = aboveTotal <= atLine;
  const stepUp = above.map((a) => `${a.n} at ${a.label}`).join(", ");
  const head = thinAbove
    ? `At ${report.barLabel}, the room above you is thin.`
    : `At ${report.barLabel}, the next rung is open.`;
  const line = thinAbove
    ? `${atLine} roles sit right at your line. The step up is narrow${stepUp ? `, ${stepUp}` : ""}. That is ${region} this quarter, not a verdict on you. Better you hear it from me than find out the slow way.`
    // The window can show two rungs above, so say "above you" rather than "one rung up".
    : `${atLine} sit right at your line, and the climb is real${stepUp ? `, with ${stepUp} above you` : ""}. Plenty of room from here. I will aim you at the level you can actually take next, not a title you have to wait years for.`;
  return (
    hr() +
    lead("the hard bit") +
    h1(head) +
    gap(6) +
    bars +
    gap(10) +
    legend([[C.coral, "at or above your line"], [CH.grey, "below it"]]) +
    gap(8) +
    p(line)
  );
}

// THE GAP CHART — a diverging board. Every domain the market is hiring for in your reach: strengths you
// own grow LEFT in coral, holes the market wants but you have not shown grow RIGHT in grey, around one
// spine. One picture of what you cover and what you do not. Bar widths are proportional to real counts.
function divergeRow(label, val, side, max) {
  const pct = Math.max(6, Math.min(100, (val / max) * 100));
  const H = 18;
  const coral = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tbody><tr><td width="${(100 - pct).toFixed(1)}%" style="font-size:1px;line-height:${H}px;">&nbsp;</td><td width="${pct.toFixed(1)}%" style="background:${C.coral};height:${H}px;font-size:1px;line-height:${H}px;">&nbsp;</td></tr></tbody></table>`;
  const grey = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tbody><tr><td width="${pct.toFixed(1)}%" style="background:${CH.grey};height:${H}px;font-size:1px;line-height:${H}px;">&nbsp;</td><td width="${(100 - pct).toFixed(1)}%" style="font-size:1px;line-height:${H}px;">&nbsp;</td></tr></tbody></table>`;
  const nmL = `<td width="33%" align="right" style="font-family:${SANS};font-size:13px;color:${CH.ink};padding:5px 14px 5px 0;vertical-align:middle;">${esc(label)} <span style="color:${C.faint};">${val}</span></td>`;
  const nmR = `<td width="33%" align="left" style="font-family:${SANS};font-size:13px;color:${C.muted};padding:5px 0 5px 14px;vertical-align:middle;"><span style="color:${C.faint};">${val}</span> ${esc(label)}</td>`;
  const empty = `<td width="33%">&nbsp;</td>`;
  const spine = `border-left:1px solid ${C.faint};`;
  if (side === "have") {
    return `<tr>${nmL}<td width="17%" style="vertical-align:middle;">${coral}</td><td width="17%" style="vertical-align:middle;${spine}">&nbsp;</td>${empty}</tr>`;
  }
  return `<tr>${empty}<td width="17%" style="vertical-align:middle;">&nbsp;</td><td width="17%" style="vertical-align:middle;${spine}">${grey}</td>${nmR}</tr>`;
}

function coverage(report) {
  // DISABLED: this whole section is hidden for everyone.
  //
  // WHY. The chart decides whether a person "has" a skill by comparing the first four characters of
  // two words (`covers`, market-report.mjs), so Development / Software / Engineering read as three
  // unrelated topics, and someone can be told their own field is a hole in their story.
  //
  // A replacement exists — the coverage chart behind GAP_CHART=coverage, which reads the postings'
  // actual requirements instead of matching word prefixes. It is not switched on here until it has
  // been validated against real output. A briefing with one less section is worth more than one that
  // tells someone their career is a gap.
  if (true) return "";

  // chartPlan is the SHARED definition of what this chart draws — the shadow log in market-report.mjs
  // reads the same function, so the log can never describe a chart this renderer would not draw.
  const { shown, strengths, gaps, rows: doms } = chartPlan(report.domains);
  if (!shown) return "";
  const max = Math.max(...doms.map((d) => d.live), 1);
  const header = `<tr>
    <td colspan="2" align="right" style="font-family:${SANS};font-size:12px;font-weight:600;color:${C.coral};padding:0 14px 10px 0;">Yours</td>
    <td colspan="2" align="left" style="font-family:${SANS};font-size:12px;font-weight:600;color:${C.muted};padding:0 0 10px 14px;">A gap</td>
  </tr>`;
  const rows = [
    ...strengths.map((d) => divergeRow(fixAI(d.label), d.live, "have", max)),
    ...gaps.map((d) => divergeRow(fixAI(d.label), d.live, "gap", max)),
  ].join("");
  const chart = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="table-layout:fixed;"><tbody>${header}${rows}</tbody></table>`;
  const top = strengths[0], second = strengths[1];
  const gapDom = gaps[0];
  const gapCos = gapDom ? [...new Set(gapDom.examples.map((e) => e.company))].slice(0, 2).map(esc).join(", ") : "";
  const gapLine = gapDom
    ? ` The one hole is ${gflow(gapDom)}: ${gapDom.live} roles want it${gapCos ? ` (${gapCos})` : ""} and your story is quiet on it. If you have touched it and never wrote it down, that is the line worth adding.`
    : "";
  // THE WEDGE — when the market's top unmet ask can be anchored to where the person actually worked, name
  // it and INVITE them to claim it. Never asserts they have it (grounding): it connects their employer to
  // the market's demand and asks. This is what makes a reader feel seen. Falls back to the plain gap line.
  const w = report.wedge;
  const wedgeLine = w
    ? ` The market's one big ask you are quiet on is ${fixAI(w.flow || w.domain)}: ${w.live} roles want it. But you were at ${esc(w.employer)}${w.tenure ? ` for ${esc(w.tenure)}` : ""}${w.employerNote ? `, and that is ${esc(w.employerNote)}` : ""}. If you touched any of that, it is your headline, not a gap. Tell me and I move it to your side.`
    : gapLine;
  // Contextual framing: adapt to the SHAPE of what they cover. A person with two spikes gets a different
  // headline and read than one who covers the board — never one fixed sentence with the numbers swapped in.
  const thin = strengths.length <= 2;
  const head = thin ? "Your spikes, and the gap worth knowing." : "What you cover, and where the market leans.";
  // Say only what the count actually supports: these are the words THIS person's own story and THIS
  // person's reachable roles both use. It is a keyword overlap and the copy must not claim more.
  const ownLine = top
    ? `${cap(gflow(top))}${second ? ` and ${gflow(second)}` : ""} ${second ? "show" : "shows"} up in your own words and in the roles you can reach, ${top.live} of them for ${gflow(top)} alone.`
    : "";
  return (
    hr() +
    lead("the whole board") +
    h1(head) +
    gap(8) +
    chart +
    gap(12) +
    p(`${ownLine}${wedgeLine} I would rather name it than pretend it is not there.`)
  );
}

function geo(report) {
  const g = report.geo || {};
  // Region-agnostic + grounded: remote first, then the person's real top cities (names from the postings),
  // then the long tail. No hardcoded hub, so it reads right for Bengaluru, San Francisco or London alike.
  const rows = [
    ["Fully remote", g.remote || 0],
    ...(g.cities || []).map((c) => [c.city, c.n]),
    ["Elsewhere", g.other || 0],
  ].filter(([, n]) => n > 0);
  if (rows.length < 2) return "";
  const max = Math.max(...rows.map(([, n]) => n), 1);
  const bars = rows.map(([l, n], i) => bar(l, (n / max) * 100, n, i === 0 ? CH.rust : CH.grey)).join("");
  const topCity = (g.cities || [])[0];
  // Adapt to what they asked for: a remote-wanting person is led with remote and never pushed toward a
  // city, the cities offered only as an option. Everyone else gets the plain "where the roles are" read.
  const wantsRemote = /remote/i.test(String(report.meta?.remote || ""));
  const head = wantsRemote ? "Remote first, the way you asked." : "Where the roles actually are.";
  const line = wantsRemote
    ? `${g.remote > 0 ? `${g.remote} you can do fully remote, no move needed. ` : ""}The city roles are here too if you ever want them, but I led with what you asked for.`
    : `${g.remote > 0 ? `${g.remote} you can do fully remote` : "A spread across cities"}${topCity ? `, and ${esc(topCity.city)} has the most doors open for you` : ""}. Every one of them reachable, which is the whole point of clearing out the rest.`;
  return (
    hr() +
    lead("where they are") +
    h1(head) +
    gap(6) +
    bars +
    gap(10) +
    p(line)
  );
}

function companies(report) {
  const list = (report.topCompanies || []).slice(0, 7).filter((c) => c.n > 0);
  if (list.length < 3) return "";
  const max = Math.max(...list.map((c) => c.n), 1);
  const star = report.standout?.company;
  const bars = list.map((c) => bar(c.company, (c.n / max) * 100, c.n, c.company === star ? CH.rust : CH.grey)).join("");
  return (
    hr() +
    lead("who is hiring") +
    h1("The names with the most doors open for you.") +
    gap(6) +
    bars +
    gap(10) +
    p(`A mix of the big and the fast.${star ? ` ${esc(star)} is the one I would start with, and I will tell you why in a second.` : ""}`)
  );
}

function standout(report) {
  const s = report.standout;
  if (!s) return "";
  const comp = s.comp && s.comp.currency === "INR" ? `${inr(s.comp.min)}&ndash;${inr(s.comp.max)}` : s.comp && s.comp.currency === "USD" ? `$${Math.round(s.comp.min / 1000)}K&ndash;$${Math.round(s.comp.max / 1000)}K` : "";
  // GROUND the "pays what you asked" claim: only assert it when this role's disclosed comp actually
  // clears the person's stated floor in the same currency (standout may be a top-relevance pick that
  // does NOT clear). Otherwise say only what is true — it is the strongest match in reach.
  const f = report.comp || {};
  const clears = !!(s.comp && meaningfulFloor(f.floor, f.floorCcy) && s.comp.currency === f.floorCcy && s.comp.max >= f.floor);
  const line = clears
    ? "It pays what you asked and sits right where you would take it, no stretch."
    : "It sits right where you would take it, and it is the strongest match in your reach.";
  const loc = esc(String(s.location || "").replace(/,\s*[A-Z]{2},/, ","));
  const btn = s.apply_url
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 0;"><tbody><tr>
        <td style="background:${CH.ink};border-radius:8px;"><a href="${esc(s.apply_url)}" target="_blank" style="display:inline-block;font-family:${SANS};font-size:14px;font-weight:600;color:${C.white};text-decoration:none;padding:12px 22px;">Take a look &rarr;</a></td>
      </tr></tbody></table>`
    : "";
  return (
    hr() +
    lead("if you look at one thing") +
    `<div style="background:${C.soft};border-radius:12px;padding:24px 24px 26px;">
      <div style="font-family:${SANS};font-size:13px;font-weight:600;color:${C.coral};">${esc(s.company)}</div>
      ${gap(8)}
      <div style="font-family:${HEAD};font-size:19px;font-weight:400;line-height:1.3;color:${C.ink};">${esc(s.title)}</div>
      ${gap(9)}
      <div style="font-family:${SANS};font-size:13.5px;color:${C.muted};">${loc}${comp ? ` &nbsp;&middot;&nbsp; ${comp}` : ""}</div>
      ${gap(14)}
      <div style="font-family:${SANS};font-size:14px;line-height:1.6;color:${C.text};">${line} If I could point you at one thing today, this is it.</div>
      ${gap(16)}
      ${btn}
    </div>`
  );
}

// A single stacked proportion bar: of the whole 57, the coral slice clears your floor, the ink slice
// named a number below it, the pale slice never said. Part-to-whole in one crafted line (a radar/dot
// grid suits neither the data nor email). Widths are the true shares; the counts ride in the legend.
function money(report) {
  const c = report.comp;
  const total = c.total || 1;
  // Only speak of a floor when it is a meaningful number. A sub-lakh / zero / unset floor would make
  // the email say "Clears ₹0L" and treat every role as clearing it — misleading. Below the threshold we
  // drop the coral "clears" slice and the floor claim, and show only the honest named/silent split.
  const hasFloor = meaningfulFloor(c.floor, c.floorCcy);
  const obs = c.observed;
  // Their floor and this market are quoted in DIFFERENT currencies, so "does it clear your floor" is not
  // a question this data can answer: clearFloor only counts roles posted in the person's own currency, so
  // it comes back 0 and a coral "Clears EUR 50,000 (0)" reads as the market rejecting them. Say the honest
  // thing instead. No conversion is attempted anywhere — an invented exchange rate is an invented fact.
  const crossCcy = hasFloor && !!obs && obs.currency !== c.floorCcy;
  const comparable = hasFloor && !crossCcy;
  const clears = comparable ? c.clearFloor || 0 : 0;
  const named = Math.max(0, c.disclosed - clears);
  const silent = Math.max(0, c.total - c.disclosed);
  const seg = (n, color, first) =>
    n > 0
      ? `<td width="${Math.max(2, (n / total) * 100).toFixed(1)}%" style="background:${color};height:22px;font-size:1px;line-height:22px;${first ? "" : `border-left:2px solid ${C.card};`}">&nbsp;</td>`
      : "";
  // when there's no floor slice, the named segment becomes the visual first (borderless).
  const stack = `<div style="border-radius:8px;overflow:hidden;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;"><tbody><tr>${seg(clears, C.coral, true)}${seg(named, CH.ink, !comparable)}${seg(silent, PALE)}</tr></tbody></table></div>`;
  const legendItems = [];
  if (comparable) legendItems.push([C.coral, `Clears ${moneyFmt(c.floor, c.floorCcy)} (${clears})`]);
  legendItems.push([CH.ink, `Named a number (${named})`], [PALE, `Stayed quiet (${silent})`]);
  const bandOf = (o) => `${moneyFmt(o.lo, o.currency)}&ndash;${moneyFmt(o.hi, o.currency)}`;
  const topOf = (o) => (o.top > o.hi ? `, the strongest reaching ${moneyFmt(o.top, o.currency)}` : "");
  // They DID name a floor, in a currency this market does not post in. Name the mismatch, give them the
  // real band anyway, and ask for the one thing that would let us compare. Never claim, never convert.
  if (crossCcy) {
    return (
      hr() +
      lead("about the money") +
      h1("Here is what I can see on pay.") +
      gap(8) +
      stack +
      gap(14) +
      legend(legendItems) +
      gap(8) +
      p(`You told me ${moneyFmt(c.floor, c.floorCcy)}, and these roles post in ${esc(ccyWord(obs.currency))}, so I am not going to pretend I can line the two up. What I can tell you is what they pay: at your level they land ${bandOf(obs)}${topOf(obs)}. Only ${c.disclosed} of the ${c.total} named a number, so read it as a peek, not the whole truth. Tell me what your floor looks like in ${esc(ccyWord(obs.currency))} and I will show you exactly which ones clear it.`)
    );
  }
  // NO floor of their own, but enough roles disclosed to speak a band: SHOW them the number (the honest
  // "here is the floor I can see") and pull for theirs. Beats the weak "only N named pay" when the person
  // gave us nothing to clear against. Grounded: lo / hi / median are real posted figures, never imputed.
  if (!hasFloor && obs) {
    const band = bandOf(obs);
    const topPay = topOf(obs);
    return (
      hr() +
      lead("about the money") +
      h1("Here is what I can see on pay.") +
      gap(8) +
      stack +
      gap(14) +
      legend(legendItems) +
      gap(8) +
      p(`Only ${c.disclosed} of the ${c.total} put a number on it, so read this as a peek, not the whole truth. From the ones who did, roles at your level land ${band}${topPay}. That is all I can see from who posted, and it may be off. You have not named your floor yet, so tell me the least you would take and I will show you which of these clear it. You know your number better than a job post does.`)
    );
  }
  return (
    hr() +
    lead("about the money") +
    h1(`Only ${c.disclosed} of ${c.total} will even name the pay.`) +
    gap(8) +
    stack +
    gap(14) +
    legend(legendItems) +
    gap(8) +
    p(`${hasFloor && clears > 0 ? `That coral sliver is ${clears === 1 ? "the one role that clears" : `the ${clears} roles that clear`} your ${moneyFmt(c.floor, c.floorCcy)}. ` : ""}Read the silence as them being coy, not the market turning you down.`)
  );
}

function close() {
  return (
    hr() +
    p(`I will keep reading every day so you do not have to. The day one clears your bar, warts and all, you get one email from me. Never a list, never a nudge, never noise. That is the whole deal.`)
  );
}

// ── assembly ─────────────────────────────────────────────────────────────────
export function renderMarketReportContent(report) {
  return [opener, seniority, coverage, geo, companies, standout, money, close]
    .map((fn) => fn(report))
    .join("\n");
}

// Lead the subject with the person's OWN stated target so the line is theirs, and fall back to the
// generic one when they never named a role. Deliberately NOT the reachable count: a bare "2,183 roles
// you can actually take" in an inbox, without the letter's framing, promises more than the pre-filter
// earned. Their own casing is KEPT (lowercasing would turn "AI Developer" into "aI Developer"). Many
// targets are a list of roles, so take the first (on commas only — splitting on "/" would cut "AI/ML"
// and "UI/UX" in half), and if it is still too long for a subject line, use the generic one.
export function subjectFor(report) {
  const role = String(report?.meta?.role || "").split(",")[0].trim().replace(/\s+/g, " ");
  return cleanSubject(role && role.length <= 40 ? `Your ${role} market, honestly` : "Can you keep a secret?");
}

export function renderMarketReport(report, { email = report?.meta?.email || "" } = {}) {
  const content = renderMarketReportContent(report);
  return {
    subject: subjectFor(report),
    html: emailShell({
      preheader: `I did today's reading. This one is just for you.`,
      title: "State of your market",
      contentHtml: content,
      unsubUrl: unsubUrlFor(email),
      tag: "charliemarket",
    }),
  };
}

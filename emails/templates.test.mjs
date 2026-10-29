// emails/templates.test.mjs — HTML snapshot lock for every covered email template.
// A snapshot diff here is INTENTIONAL: it means a template's rendered output changed. Update
// snapshots only after a human has reviewed the visual diff.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

import { renderEmail } from "../render-email.mjs";
import {
  renderConsentGrant, renderDispute, renderStatusUpdate,
  renderAnswerNoted, renderOffTopic, renderUnsure,
} from "../render-reply.mjs";
import {
  renderStudioAsk,
  renderStudioReminder,
  renderYesCorrection,
  renderReplyCorrection,
  renderYesNoted,
  renderAnyCalls,
  renderRepresentPermission,
  renderWithHiringTeam,
  renderClientStatus,
  renderClientReplyAck,
  renderCvRequest,
  renderDecisionAsk,
  renderBreakingSilence,
  renderEvidenceAsk,
  renderRoleForward,
  renderYearsAsk,
  renderRepresentPoolAsk,
  renderAskAnswerAck,
  renderAskCorrection,
  renderWelcome,
  renderMissingResume,
  renderNotJobSearch,
  renderProInterest,
  renderSecondChance,
  renderResumeNotNeeded,
  renderReoptIn,
  renderOutOfMarket,
  renderBuildDelayed,
  renderWedge,
  renderRolePicks,
  renderHeldRoles,
  renderPrefsUpdated,
  renderAck,
  renderFirstRoleClosest,
  renderInterroTurn,
  renderRoleIntent,
  renderIntentAnswer,
  renderIntentQuestions,
  renderQuestionsAnswer,
  renderRoleHold,
  renderHoldAnswer,
  giftRoleBlock,
  fitCheckPage,
} from "../email-kit.mjs";
import { renderConfirmation } from "../render-confirmation.mjs";
import { lintMessage } from "../lib/convo-lint.mjs";
import * as F from "./fixtures.mjs";

// Freeze the clock so relative-time output ("2 days ago") is deterministic.
beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-07-12T12:00:00.000Z"));
});
afterAll(() => vi.useRealTimers());

describe("role email (render-email.mjs)", () => {
  it("ROLE_US — rich US role (exercises all ROLE tokens)", () => {
    expect(renderEmail(F.ROLE_US)).toMatchSnapshot();
  });
  it("ROLE_RARE — Edge Engine rare-find variant (plum label + opening frame, no attach note)", () => {
    const html = renderEmail(F.ROLE_RARE);
    // the intro message is attachment-only; it must NEVER be named in the body
    expect(html).not.toContain("Attached: intro message");
    // the rare-find opening frame renders at the top
    expect(html).toContain("This is a role your specific mix is rare for");
    // the rare-find label chip uses the distinct plum bg, not the default green
    expect(html).toContain(F.ROLE_RARE.label);
    expect(html).toMatchSnapshot();
  });
  it("ROLE_THIN — thin/India role (prose fallback, US blocks hidden)", () => {
    expect(renderEmail(F.ROLE_THIN)).toMatchSnapshot();
  });
});

describe("lifecycle emails (email-kit.mjs)", () => {
  it("renderWelcome", () => expect(renderWelcome(F.WELCOME)).toMatchSnapshot());
  it("renderMissingResume", () => expect(renderMissingResume(F.MISSING_RESUME)).toMatchSnapshot());
  it("renderSecondChance", () => expect(renderSecondChance(F.SECOND_CHANCE)).toMatchSnapshot());
  it("renderResumeNotNeeded", () => expect(renderResumeNotNeeded(F.RESUME_NOT_NEEDED)).toMatchSnapshot());
  it("renderReoptIn", () => expect(renderReoptIn(F.REOPT_IN)).toMatchSnapshot());
  it("renderOutOfMarket", () => expect(renderOutOfMarket(F.OUT_OF_MARKET)).toMatchSnapshot());
  it("renderBuildDelayed", () => expect(renderBuildDelayed(F.BUILD_DELAYED)).toMatchSnapshot());
  it("renderWedge", () => expect(renderWedge(F.WEDGE)).toMatchSnapshot());
  it("renderRolePicks", () => expect(renderRolePicks(F.ROLE_PICKS)).toMatchSnapshot());
  it("renderPrefsUpdated", () => expect(renderPrefsUpdated(F.PREFS_UPDATED)).toMatchSnapshot());
  it("renderAck", () => expect(renderAck(F.ACK)).toMatchSnapshot());
  it("renderFirstRoleClosest", () => expect(renderFirstRoleClosest(F.FIRST_ROLE_CLOSEST)).toMatchSnapshot());
  it("renderInterroTurn (first)", () => expect(renderInterroTurn(F.INTERRO_FIRST)).toMatchSnapshot());
  it("renderInterroTurn (continue)", () => expect(renderInterroTurn(F.INTERRO_TURN)).toMatchSnapshot());
});


// The gift-a-role block: a share for a role that's not yours but is someone's. Honest (never claims the
// friend fits), Sanchez heading, soft inset (no left border, no bold); the signed /j link rides the share.
describe("giftRoleBlock: gift a role, honest not hyped, /j link, no left border", () => {
  const b = giftRoleBlock({ email: "a@b.com", role: { id: "job1", title: "Senior PM", company: "Razorpay" } });
  it("renders only with BOTH a giver and a job id (needed to mint an attributable link)", () => {
    expect(giftRoleBlock({ email: "", role: { id: "job1" } })).toBe("");
    expect(giftRoleBlock({ email: "a@b.com", role: {} })).toBe("");
    expect(b).toContain("Not yours, but someone's?");
  });
  it("Sanchez heading, soft inset, never a left border or bold", () => {
    expect(b).toContain("'Sanchez'");
    expect(b).not.toMatch(/border-left/i);
    expect(b).not.toMatch(/<b>|<strong>|font-weight:\s*700/i);
  });
  it("the signed /j link (giver + job) rides inside the tracked share; the old tailor mailto is gone", () => {
    const pm = b.match(/\/e\/([A-Za-z0-9_-]+)\./);
    const payload = JSON.parse(Buffer.from(pm[1], "base64url").toString());
    expect(decodeURIComponent(payload.u)).toMatch(/\/j\/[A-Za-z0-9._-]+/);
    expect(b).not.toContain("Tailor my CV");
  });
  it("never claims the friend fits (the honest read is Charlie's to give)", () => {
    for (const bad of [/you'?re a (great|perfect|strong) (fit|match)/i, /perfect for you/i]) expect(b).not.toMatch(bad);
    expect(b).toContain("honest read");
  });
  it("carries no em dash (voice rule)", () => expect(b).not.toContain("—"));
  it("is DARK in the role email until GIFT_A_ROLE=on (the switch)", () => {
    expect(renderEmail(F.ROLE_US)).not.toContain("Not yours, but someone's?");
    process.env.GIFT_A_ROLE = "on";
    try { expect(renderEmail(F.ROLE_US)).toContain("Not yours, but someone's?"); }
    finally { delete process.env.GIFT_A_ROLE; }
  });
});

// The fit-check landing (/j): names the giver, shows the role, one "see your fit" button to check@,
// unfurls a card, never leaks the token to the page, never claims the friend fits.
describe("fitCheckPage: /j landing, name-aware, honest, no token leak, OG unfurl", () => {
  const p = fitCheckPage({ token: "AAA.BBB", giverName: "Priya Sharma", role: { title: "Senior PM", company: "Razorpay", location: "Bangalore" } });
  it("names the giver's first name; junk ALL-CAPS falls back to 'A friend'", () => {
    expect(p).toContain("Priya flagged this for you");
    expect(fitCheckPage({ token: "A.B", giverName: "WORK EXPERIENCE", role: { title: "X" } })).toContain("A friend flagged this for you");
  });
  it("shows the role + one 'See if you're a fit' button to check@", () => {
    expect(p).toContain("Senior PM");
    expect(p).toContain("See if you're a fit");
    expect(p).toContain("mailto:check@");
  });
  it("unfurls a card: OG image + the role in og:title", () => {
    expect(p).toContain("charlie-og.png");
    expect(p).toContain('og:title" content="Senior PM at Razorpay"');
  });
  it("never shows the raw token on the page; it rides only in the mailto body", () => {
    const visible = p.replace(/href="mailto:[^"]*"/g, "");
    expect(visible).not.toContain("[fref:");
    expect(p).toContain("fref%3AAAA.BBB");
  });
  it("never claims the friend fits", () => {
    for (const bad of [/you'?re a (great|perfect|strong) (fit|match)/i]) expect(p).not.toMatch(bad);
  });
});

// The interrogation turn is sent through the conversation copy-lint before sendGuarded. It MUST clear the lint
// by construction (exactly one "?", a costless exit, no em dash) — a drop here would silently swallow the
// onboarding question. Lock that invariant so a copy edit can't break the send path.
describe("interro turn clears the copy-lint (send-path invariant)", () => {
  for (const [name, fx] of [["first", F.INTERRO_FIRST], ["continue", F.INTERRO_TURN]]) {
    it(name, () => {
      const m = renderInterroTurn(fx);
      const r = lintMessage({ subject: m.subject, text: m.text });
      expect(r.ok, JSON.stringify(r.violations)).toBe(true);
    });
  }
});

// When onboarding fails on OUR side (a model outage), the reply must reassure the resume arrived and
// promise to come back — never ask them to resend or blame their file. Lock the honest-copy contract.
describe("renderBuildDelayed: honest delay, never blames the resume", () => {
  const m = renderBuildDelayed(F.BUILD_DELAYED);
  it("reassures the resume arrived", () => expect(m.text).toMatch(/came through/i));
  it("does NOT ask them to resend or blame their file", () => {
    for (const bad of [/resend/i, /could ?n['’]?t read/i, /attach/i, /did ?n['’]?t (arrive|reach)/i, /never reached/i]) {
      expect(m.text).not.toMatch(bad);
      expect(m.html).not.toMatch(bad);
    }
  });
  it("carries no em dash (voice rule)", () => expect(`${m.subject} ${m.text}`).not.toContain("—"));
});

// The wedge drip (variant A): the words carry the email, so the grounded FALLBACK (no model copy)
// must itself be honest, contextual, and voice-clean. Lock it: the grounded combination renders
// verbatim, the honest half always ships, and nothing invented (no number) or blaming leaks in.
describe("renderWedge: the grounded fallback is honest and contextual", () => {
  const m = renderWedge({ email: "a@b.com", combo: "An architecture degree and three years designing maps.", copy: null });
  it("renders the grounded combination verbatim (contextual, never generic)", () => {
    expect(m.text).toContain("An architecture degree and three years designing maps.");
    expect(m.html).toContain("An architecture degree and three years designing maps.");
  });
  it("always ships the honest half (the moat, not a horoscope)", () => {
    expect(m.text).toMatch(/won'?t send you those/i);
  });
  it("states no number and carries no em dash (words carry it, nothing invented)", () => {
    expect(`${m.subject} ${m.text}`).not.toMatch(/\d/);
    expect(`${m.subject} ${m.text}`).not.toContain("—");
  });
});

// The out-of-market note is the one email a foreign user gets INSTEAD of roles. It must be honest
// (name the two markets, say we're holding off), never overclaim, always carry the reply-back
// correction path (so a false positive self-recovers), and never open with a junk section-header name.
describe("renderOutOfMarket: honest, upfront, self-recoverable", () => {
  const m = renderOutOfMarket({ email: "a@b.com", name: "Lena", place: "Lisbon" });
  it("is upfront about the two markets and the person's place", () => {
    expect(m.text).toMatch(/india and the us/i);
    expect(m.text).toContain("Lisbon");
  });
  it("says it is holding off rather than sending the wrong roles", () => {
    expect(m.text).toMatch(/hold off/i);
  });
  it("always carries the reply-back correction path (false positive self-recovers)", () => {
    expect(m.text).toMatch(/reply/i);
    expect(m.html).toMatch(/reply/i);
    expect(m.text).toMatch(/wrong/i);
  });
  it("carries no em dash (voice rule)", () => expect(`${m.subject} ${m.text}`).not.toContain("—"));
  it("makes no promise it can't keep (no roles, no guarantee of a match)", () => {
    for (const bad of [/found (a|one|your) (role|job|match)/i, /perfect (fit|match)/i]) {
      expect(m.text).not.toMatch(bad);
      expect(m.html).not.toMatch(bad);
    }
  });
  it("guards the name slot: a junk section-header name never opens the email", () => {
    const junk = renderOutOfMarket({ email: "a@b.com", name: "WORK EXPERIENCE", place: "Lisbon" });
    expect(junk.text).not.toContain("WORK EXPERIENCE");
    expect(junk.html).not.toContain("WORK EXPERIENCE");
    expect(junk.text.startsWith("Hi, ")).toBe(true);
  });
  it("reads fine with no place (falls back to 'outside both')", () => {
    const np = renderOutOfMarket({ email: "a@b.com", name: "Lena", place: "" });
    expect(np.text).toMatch(/outside both/i);
  });
});

describe("VIP pair", () => {
  it("renderConfirmation", () => expect(renderConfirmation(F.CONFIRMATION)).toMatchSnapshot());
});

// renderRolePicks goes to people Charlie has NO grounded profile for, so the honest catch is the
// only thing separating it from a job-board blast. It is enforced in code, and this is the proof —
// a caller in a hurry must not be able to send an unhedged role.
describe("renderRolePicks: the honest catch is structural, not a convention", () => {
  const base = { email: "a@b.com", name: "Maya" };
  const good = { role: "Technical Writer", company: "Brightfold", location: "Chennai", catch: "it reads a level below senior.", applyUrl: "https://x.test/a" };

  it("drops a role that has no catch", () => {
    const out = renderRolePicks({ ...base, items: [good, { role: "Unhedged", company: "Nowhere", applyUrl: "https://x.test/b" }] });
    expect(out.html).toContain("Brightfold");
    expect(out.html).not.toContain("Unhedged");
    expect(out.text).not.toContain("Unhedged");
  });

  it("renders nothing at all when NO role carries a catch", () => {
    // Fail closed: an email of unhedged roles is worse than no email.
    expect(renderRolePicks({ ...base, items: [{ role: "A", company: "B" }, { role: "C", company: "D" }] })).toBeNull();
  });

  it("treats a whitespace-only catch as missing", () => {
    expect(renderRolePicks({ ...base, items: [{ ...good, catch: "   " }] })).toBeNull();
  });

  it("returns null on an empty or malformed list rather than an empty shell", () => {
    for (const items of [[], null, undefined, "nope"]) expect(renderRolePicks({ ...base, items })).toBeNull();
  });

  it("prints the catch for every role it does render", () => {
    const out = renderRolePicks({ ...base, items: [good, { ...good, company: "Orbitra Labs", catch: "hardware-heavy, not SaaS." }] });
    expect((out.html.match(/The catch:/g) || [])).toHaveLength(2);
    expect((out.text.match(/The catch:/g) || [])).toHaveLength(2);
  });

  it("makes no claim about the reader's fit (there is no dossier to ground one)", () => {
    const out = renderRolePicks({ ...base, items: [good] });
    for (const claim of [/your profile/i, /fits you/i, /you're a (good|strong) (fit|match)/i, /clear(ed)? the bar for me/i])
      expect(out.html).not.toMatch(claim);
  });
});

describe("renderHeldRoles", () => {
  it("renders the held-roles email", () => {
    expect(renderHeldRoles(F.HELD_ROLES).html).toMatchSnapshot();
  });

  it("separates a preference hold from a depth hold, and marks an open role as open", () => {
    const out = renderHeldRoles(F.HELD_ROLES);
    expect(out.html).toMatch(/Nothing in the way of this one/);
    expect(out.html).toMatch(/you told me you want remote/);
    expect(out.html).toMatch(/depth I cannot see in your profile yet/);
    expect(out.text).toMatch(/Nothing in the way of this one/);
  });

  it("makes no claim about how well they fit — no score, no percentage, no verdict", () => {
    const out = renderHeldRoles(F.HELD_ROLES);
    // Percentages are checked against the TEXT part only: the HTML carries table width="100%"
    // layout attributes, which are markup, not a claim about the reader.
    for (const claim of [/\d+\s*\/\s*100/, /\d+\s?%/, /you'?re a (good|strong) (fit|match)/i, /clears? your bar/i, /fits you/i])
      expect(out.text, `text must not claim: ${claim}`).not.toMatch(claim);
    for (const claim of [/\d+\s*\/\s*100/, /you'?re a (good|strong) (fit|match)/i, /clears? your bar/i, /fits you/i])
      expect(out.html, `html must not claim: ${claim}`).not.toMatch(claim);
  });

  it("carries no em dash anywhere in the copy", () => {
    const out = renderHeldRoles(F.HELD_ROLES);
    expect(out.html).not.toMatch(/\u2014/);
    expect(out.text).not.toMatch(/\u2014/);
    expect(out.subject).not.toMatch(/\u2014/);
  });

  it("returns null rather than an empty shell when there is nothing to show", () => {
    for (const items of [[], null, undefined, "nope", [{ role: "PM" }]]) expect(renderHeldRoles({ ...F.HELD_ROLES, items })).toBeNull();
  });

  it("can suppress the depth ask for someone whose profile is already rich", () => {
    expect(renderHeldRoles({ ...F.HELD_ROLES, askDepth: false }).html).not.toMatch(/Save to PDF/);
    expect(renderHeldRoles(F.HELD_ROLES).html).toMatch(/Save to PDF/);
  });
});

// ── the reply to someone who is NOT job hunting ──────────────────────────────────────────────────
// groundsNothing refuses to build a candidate row from a sales pitch. The REPLY must match that
// diagnosis: a salesperson must not be asked for their resume and what kind of role they want.
describe("renderNotJobSearch", () => {
  const r = () => renderNotJobSearch({ email: "spam@example.com" });
  it("NEVER asks for a resume — that is the entire bug being fixed", () => {
    const { html, text, subject } = r();
    for (const body of [html, text, subject]) expect(body).not.toMatch(/resume|\bcv\b|curriculum/i);
  });
  it("does not ask what role they want either", () => {
    const { html, text } = r();
    for (const body of [html, text]) expect(body).not.toMatch(/what (kind of )?role|pay floor|where you want to work/i);
  });
  it("leaves ONE way back in, for the false positive (a real person read wrong)", () => {
    expect(r().text).toMatch(/reply/i);
  });
  it("carries no em dash, in either half", () => {
    const { html, text } = r();
    for (const body of [html, text]) expect(body).not.toMatch(/—|–/);
  });
  // The contrast that stops a future refactor quietly collapsing the two replies back into one.
  it("the resume ask still EXISTS for the case that deserves it", () => {
    expect(renderMissingResume({ email: "x@example.com" }).html).toMatch(/resume/i);
  });
});

// ── the three ways in ─────────────────────────────────────────────────────────────────────────────
// "Send your resume" assumes a current resume exists. For most people it does not, and that is the
// moment they postpone and never come back. LinkedIn's own Save-to-PDF and Peerlist's Markdown export
// are one click on something they already have.
describe("renderMissingResume — three ways in, any ONE of them", () => {
  const r = () => renderMissingResume({ email: "x@example.com" });
  it("offers the LinkedIn PDF export, with the steps spelled out", () => {
    const { html, text } = r();
    for (const b of [html, text]) {
      expect(b).toMatch(/linkedin/i);
      expect(b).toMatch(/resources/i);   // the menu they have to find
      expect(b).toMatch(/save to pdf/i); // the button
    }
  });
  it("offers the Peerlist export", () => {
    for (const b of [r().html, r().text]) expect(b).toMatch(/peerlist/i);
  });
  it("frames them as alternatives, not a checklist", () => {
    expect(r().text).toMatch(/any one of these|whichever is quickest/i);
  });
  it("KEEPS the lowest-effort path first — a few lines still beats every file", () => {
    const t = r().text;
    expect(t.indexOf("your own words")).toBeLessThan(t.indexOf("LinkedIn"));
    expect(t).toMatch(/don.t need a resume/i);
  });
  // FIRST CONTACT: Charlie does not know their name yet, and no call site passes one.
  // Greeting a stranger by a name we invented would be an invented fact in the very first sentence.
  it("greets a stranger WITHOUT a name, because we do not have one", () => {
    expect(r().text).toMatch(/^Hi, I'm Charlie/);
    expect(r().text).not.toMatch(/^Hi undefined|^Hi ,/);
  });
  it("names only formats the attachment handler actually accepts", () => {
    // ALLOWED_EXT = pdf, docx, txt, rtf, md — asking for a format we drop would be a broken promise.
    const t = r().text.toLowerCase();
    expect(t).toMatch(/pdf/);
    expect(t).toMatch(/markdown|\.md\b/);
  });
  it("carries no em dash", () => {
    for (const b of [r().html, r().text]) expect(b).not.toMatch(/—|–/);
  });
});

// ── touch-point consistency ──────────────────────────────────────────────────────────────────────
// Every place Charlie asks for a file must offer the SAME three ways in. A landing page that says
// "resume" while the email says "any one of three" is the inconsistency that makes someone bounce
// between the two and do neither.
//
// This also pins the harder half: NONE of them may offer a LINK to a profile. A LinkedIn URL cannot
// be read (it is an auth wall carrying other people's names — url-ingest looksGated), so asking for
// one would be a promise Charlie cannot keep.
describe("every ask offers the same three ways in", () => {
  const ASKS = {
    renderMissingResume: () => renderMissingResume({ email: "x@e.com" }),
    renderSecondChance: () => renderSecondChance({ email: "x@e.com" }),
    renderResumeNotNeeded: () => renderResumeNotNeeded({ email: "x@e.com" }),
  };
  for (const [name, make] of Object.entries(ASKS)) {
    it(`${name} names all three`, () => {
      const { html, text } = make();
      for (const body of [html, text]) {
        expect(body).toMatch(/resume/i);
        expect(body).toMatch(/linkedin/i);
        expect(body).toMatch(/peerlist/i);
      }
    });
    it(`${name} never asks for a LINK to a profile`, () => {
      const { html, text } = make();
      for (const body of [html, text]) {
        expect(body).not.toMatch(/linkedin\.com\//i);      // no URL to paste
        expect(body).not.toMatch(/(send|share|paste|drop)[^.]{0,24}(your )?linkedin (url|link|profile link)/i);
      }
    });
  }
  it("only the FIRST-CONTACT email carries the step-by-step — the rest stay short", () => {
    expect(renderMissingResume({ email: "x@e.com" }).text).toMatch(/save to pdf/i);
    expect(renderSecondChance({ email: "x@e.com" }).text).not.toMatch(/save to pdf/i);
  });
});

// ── the Pro interest block and its reply ─────────────────────────────────────────────────────────
// An interest probe, not a sale. None of the four things exist yet, so every claim here has to stay
// conditional — and the block itself promises "nothing to pay, nothing to sign up for". These pin
// that neither the block nor its reply quietly becomes a pitch.
describe("Pro interest", () => {
  it("the reply sells nothing: no price, no date, no signup", () => {
    const { html, text } = renderProInterest({ email: "x@e.com" });
    for (const b of [html, text]) {
      // \b on `subscribe` so the shell's own "unsubscribe" footer link is not a false positive.
      expect(b).not.toMatch(/₹|\bprice|\bpricing\b|\bper month\b|\bsubscribe\b|\bupgrade\b|\bfree trial\b|\bcredit card\b/i);
      expect(b).not.toMatch(/\b(next week|next month|coming soon|shortly|by [A-Z][a-z]+day)\b/i);
    }
  });
  it("the reply is honest that nothing exists yet", () => {
    expect(renderProInterest({ email: "x@e.com" }).text).toMatch(/none of those exist yet/i);
  });
  it("carries no em dash", () => {
    const { html, text } = renderProInterest({ email: "x@e.com" });
    for (const b of [html, text]) expect(b).not.toMatch(/—|–/);
  });
  it("greets without a name when we do not have one", () => {
    expect(renderProInterest({ email: "x@e.com" }).text).toMatch(/^That is genuinely useful/);
  });
});

// The studio-role ask, its answer, and the correction for a reply sent out of context. The design system is locked, so the rendered
// HTML is pinned here rather than trusted.
describe("the studio ask, its acknowledgement, and the correction", () => {
  it("renderStudioAsk", () => expect(renderStudioAsk(F.STUDIO_ASK)).toMatchSnapshot());
  it("renderAskAnswerAck", () => expect(renderAskAnswerAck(F.ASK_ANSWER_ACK)).toMatchSnapshot());
  it("renderAskCorrection", () => expect(renderAskCorrection(F.ASK_CORRECTION)).toMatchSnapshot());
  it("renderStudioReminder", () => expect(renderStudioReminder(F.STUDIO_REMINDER)).toMatchSnapshot());

  it("carry no em dash", () => {
    for (const m of [renderStudioAsk(F.STUDIO_ASK), renderAskAnswerAck(F.ASK_ANSWER_ACK), renderAskCorrection(F.ASK_CORRECTION), renderStudioReminder(F.STUDIO_REMINDER)]) {
      for (const b of [m.html, m.text]) expect(b).not.toMatch(/—|–/);
    }
  });

  it("expose no mechanism word", () => {
    for (const m of [renderStudioAsk(F.STUDIO_ASK), renderAskAnswerAck(F.ASK_ANSWER_ACK), renderAskCorrection(F.ASK_CORRECTION), renderStudioReminder(F.STUDIO_REMINDER)]) {
      for (const w of ["dossier", "screening", "talent pool", "rubric", "home_place"]) {
        expect(m.text.toLowerCase()).not.toContain(w);
      }
    }
  });


  it("the reminder promises it is the only one, and that silence is an answer", () => {
    const { text } = renderStudioReminder(F.STUDIO_REMINDER);
    expect(text).toMatch(/only time I will nudge you/);
    expect(text).toMatch(/saying nothing is a complete answer/);
  });

  it("the reminder asks exactly what the original ask asked, and nothing more", () => {
    // A reminder that grows a second set of questions is a new ask wearing a reminder's clothes.
    // Counting question marks is the wrong test: the first bullet carries a clarifier in both
    // emails. Compare the questions themselves.
    const qs = (t) => (t.match(/[^.!?\n]*\?/g) || []).map((q) => q.replace(/^[-\s]+/, "").trim());
    expect(qs(renderStudioReminder(F.STUDIO_REMINDER).text)).toEqual(qs(renderStudioAsk(F.STUDIO_ASK).text));
  });

  it("the reminder repeats the facts, so a buried first email is recoverable", () => {
    const { text } = renderStudioReminder(F.STUDIO_REMINDER);
    for (const fact of ["Kolkata", "32 lakhs", "hybrid rather than remote", "consultancy that designs apps for its clients"]) {
      expect(text).toContain(fact);
    }
  });

  it("the ask names the studio and the money, and does not name the company", () => {
    const { text } = renderStudioAsk(F.STUDIO_ASK);
    expect(text).toMatch(/consultancy that designs apps for its clients/);
    expect(text).toMatch(/Kolkata/);
    expect(text).toMatch(/32 lakhs/);
    expect(text).toMatch(/have not named the company/);
  });

  it("none of the three invents a timeline", () => {
    for (const m of [renderAskAnswerAck(F.ASK_ANSWER_ACK), renderAskCorrection(F.ASK_CORRECTION)]) {
      expect(m.text).not.toMatch(/within a week|in a few days|by (monday|friday)|next week/i);
    }
  });

  it("the ask and the ack both promise nothing moves without permission", () => {
    for (const m of [renderStudioAsk(F.STUDIO_ASK), renderAskAnswerAck(F.ASK_ANSWER_ACK), renderAskCorrection(F.ASK_CORRECTION), renderStudioReminder(F.STUDIO_REMINDER)]) {
      expect(m.text).toMatch(/until you tell me it can/);
    }
  });
});

// The role-forward and years-ask templates. The design system is locked, so the rendered
// HTML is pinned here rather than trusted.
describe("the role forward, and the one question asked before it", () => {
  it("renderRoleForward", () => expect(renderRoleForward(F.ROLE_FORWARD)).toMatchSnapshot());
  it("renderYearsAsk", () => expect(renderYearsAsk(F.YEARS_ASK)).toMatchSnapshot());

  it("carry no em dash", () => {
    for (const m of [renderRoleForward(F.ROLE_FORWARD), renderYearsAsk(F.YEARS_ASK)]) {
      for (const b of [m.html, m.text]) expect(b).not.toMatch(/—|–/);
    }
  });

  it("expose no mechanism word", () => {
    for (const m of [renderRoleForward(F.ROLE_FORWARD), renderYearsAsk(F.YEARS_ASK)]) {
      for (const w of ["dossier", "screening", "talent pool", "rubric", "score", "shortlist"]) {
        expect(m.text.toLowerCase()).not.toContain(w);
      }
    }
  });

  // THE POINT OF THIS TEMPLATE IS WHAT IT DOES NOT DO. It asks nothing: no link, no next step for
  // them to perform.
  it("the forward asks nothing of the person", () => {
    const { text, html } = renderRoleForward(F.ROLE_FORWARD);
    expect(text).not.toMatch(/apply|click|tap|fill|submit|upload/i);
    expect(text).toMatch(/do not need to do anything/i);
    // The only two links a lifecycle email carries by construction are the webfont and the unsubscribe
    // (emailShell adds both). Anything else is an action being asked of them.
    const links = (html.match(/href="([^"]*)"/g) || []).filter((h) => !/fonts\.googleapis|\/unsubscribe\?/.test(h));
    expect(links, "the forward grew a link, which means it grew an ask").toEqual([]);
  });

  it("the forward states only the facts it was handed", () => {
    // Nothing about the role may originate in the template: a fact the posting never stated would be
    // an invented claim about the role.
    const { text } = renderRoleForward({ ...F.ROLE_FORWARD, roleFacts: "" });
    expect(text).not.toMatch(/Mysuru|Kubernetes|three to five years/);
  });

  it("the years ask wants exactly one thing back", () => {
    // Not a question-mark count: the ask is phrased as a statement ("one box you left blank: how many
    // years"), which is deliberate. What matters is that only one reply is requested, so a person can
    // answer in four words without wondering what else was wanted.
    const { text } = renderYearsAsk(F.YEARS_ASK);
    expect(text).toMatch(/Reply with the number\. That is the whole reply/);
    expect((text.match(/\?/g) || []).length).toBeLessThanOrEqual(1);
    expect(text.toLowerCase()).not.toMatch(/also (tell|send|share)|and your (notice|ctc|salary)/);
  });

  it("the years ask never states a number back at them", () => {
    // If we could read it off the resume we would not be asking. Guessing and asking them to confirm
    // our guess is how somebody gets filtered on our arithmetic rather than their own.
    const { text } = renderYearsAsk(F.YEARS_ASK);
    expect(text).not.toMatch(/I have you (at|down as)|looks like (about )?\d/i);
  });
});

// The applicant-pool represent ask. It goes to applicants whose form never asked for
// pay, notice or a portfolio, so the assertions are about what it asks and what it refuses to be.
describe("the pool gaps ask", () => {
  it("renderRepresentPoolAsk", () => expect(renderRepresentPoolAsk(F.REPRESENT_POOL_ASK)).toMatchSnapshot());

  it("carries no em dash", () => {
    const m = renderRepresentPoolAsk(F.REPRESENT_POOL_ASK);
    for (const b of [m.html, m.text]) expect(b).not.toMatch(/—|–/);
  });

  it("exposes no mechanism word", () => {
    const { text } = renderRepresentPoolAsk(F.REPRESENT_POOL_ASK);
    for (const w of ["dossier", "screening", "talent pool", "rubric", "score", "shortlist", "record"]) {
      expect(text.toLowerCase()).not.toContain(w);
    }
  });

  // THE POINT OF THIS EMAIL IS THAT IT IS NOT A PITCH. It names no company and no opening, and that is
  // also what settles its permission: consent_pool governs sending somebody OTHER companies' roles,
  // and this sends none. If a role ever appears in here, that reasoning stops holding.
  it("offers nothing and names no opening", () => {
    const { text, html } = renderRepresentPoolAsk(F.REPRESENT_POOL_ASK);
    expect(text).toMatch(/nothing to apply to here/i);
    expect(text).not.toMatch(/hiring|vacancy|opening|position is|role is based/i);
    const links = (html.match(/href="([^"]*)"/g) || []).filter((h) => !/fonts\.googleapis|\/unsubscribe\?/.test(h));
    expect(links, "the ask grew a link, which makes it an offer").toEqual([]);
  });

  it("asks only for the blanks it was handed", () => {
    const one = renderRepresentPoolAsk({ ...F.REPRESENT_POOL_ASK, missing: ["pay"] }).text;
    expect(one).toMatch(/expecting on pay/i);
    expect(one, "asked for a link we already hold").not.toMatch(/A link to your work/);
    expect(one, "asked for a notice period we already hold").not.toMatch(/counting your notice/);
  });

  // These two go to everyone: nobody has ever been asked them, and they are what a company reads first.
  it("always asks for a piece of work and for what they want next", () => {
    for (const missing of [[], ["pay"], ["portfolio", "pay", "notice"]]) {
      const { text } = renderRepresentPoolAsk({ ...F.REPRESENT_POOL_ASK, missing });
      expect(text).toMatch(/One piece of work you are proud of, in your own words/);
      expect(text).toMatch(/What you actually want next/);
    }
  });

  it("says a guess about them is worse than a blank, and promises nothing moves", () => {
    const { text } = renderRepresentPoolAsk(F.REPRESENT_POOL_ASK);
    expect(text).toMatch(/a guess about you is worse than a blank/);
    expect(text).toMatch(/until you tell me it can/);
  });
});

// The evidence ask. It goes to people whose form never asked for a word or a link
// about their own work, with the question written in the vocabulary of their role.
describe("the evidence ask", () => {
  it("renderEvidenceAsk", () => expect(renderEvidenceAsk(F.EVIDENCE_ASK)).toMatchSnapshot());

  it("carries no em dash", () => {
    const m = renderEvidenceAsk(F.EVIDENCE_ASK);
    for (const b of [m.html, m.text]) expect(b).not.toMatch(/—|–/);
  });

  it("exposes no mechanism word", () => {
    const { text } = renderEvidenceAsk(F.EVIDENCE_ASK);
    for (const w of ["dossier", "screening", "talent pool", "rubric", "score", "shortlist", "record"]) {
      expect(text.toLowerCase()).not.toContain(w);
    }
  });

  it("puts the caller's question in, verbatim and only once", () => {
    const { text } = renderEvidenceAsk(F.EVIDENCE_ASK);
    expect(text).toContain("One account you grew, saved, or lost and learned from");
    expect(text).not.toMatch(/piece of work you are proud of/); // the design question must not leak in
  });

  // IT PROMISES NOTHING IT CANNOT DELIVER. "Send me this and I will get you in faster" is the easy
  // version of this email and it is a claim about an outcome nobody controls. The honest benefit is
  // legibility, and saying so is what keeps the next email worth opening.
  it("promises no speed and no outcome", () => {
    const { text } = renderEvidenceAsk(F.EVIDENCE_ASK);
    expect(text).toMatch(/will not promise this makes anything faster/);
    expect(text).not.toMatch(/guarantee|fast.?track|priority|get you (an interview|hired|in)|ahead of/i);
  });

  it("offers nothing and names no company", () => {
    const { text, html } = renderEvidenceAsk(F.EVIDENCE_ASK);
    expect(text).not.toMatch(/hiring|vacancy|opening|apply/i);
    const links = (html.match(/href="([^"]*)"/g) || []).filter((h) => !/fonts\.googleapis|\/unsubscribe\?/.test(h));
    expect(links, "the ask grew a link, which makes it an offer").toEqual([]);
  });

  it("lowers the bar on purpose, and promises nothing moves", () => {
    const { text } = renderEvidenceAsk(F.EVIDENCE_ASK);
    expect(text).toMatch(/Rough is fine/);
    expect(text).toMatch(/until you tell me it can/);
  });
});

// The follow-through on the forward. Its whole value is the tense, so that is what the
// assertions defend: it may only be sent to somebody for whom the past tense is true.
describe("it is with the hiring team now", () => {
  it("renderWithHiringTeam", () => expect(renderWithHiringTeam(F.WITH_HIRING_TEAM)).toMatchSnapshot());

  it("carries no em dash", () => {
    const m = renderWithHiringTeam(F.WITH_HIRING_TEAM);
    for (const b of [m.html, m.text]) expect(b).not.toMatch(/—|–/);
  });

  it("exposes no mechanism word", () => {
    const { text } = renderWithHiringTeam(F.WITH_HIRING_TEAM);
    for (const w of ["dossier", "screening", "talent pool", "rubric", "score", "shortlist", "record"]) {
      expect(text.toLowerCase()).not.toContain(w);
    }
  });

  // THE TENSE IS THE PRODUCT. renderRoleForward says "is going to the hiring managers". If this one
  // hedges back into the future it is the same email twice and the second is a lie about the first.
  it("says it went, not that it is going", () => {
    const { text } = renderWithHiringTeam(F.WITH_HIRING_TEAM);
    expect(text).toMatch(/profile went to the hiring team/);
    expect(text).not.toMatch(/is going to|will go to|will be sent/i);
  });

  // NO OUTCOME AND NO DATE. This would be the first promise about a result Charlie has ever made, and
  // the client's timeline is not ours. The one promise kept is that they hear either way.
  it("promises no timeline and no outcome", () => {
    const { text } = renderWithHiringTeam(F.WITH_HIRING_TEAM);
    expect(text).not.toMatch(/within|by (monday|friday|next)|\d+ (days|weeks)|shortly|soon|guarantee|interview will/i);
    expect(text).toMatch(/do not set their timeline/);
    expect(text).toMatch(/includes hearing nothing/);
  });

  it("asks nothing of them, and carries no link", () => {
    const { text, html } = renderWithHiringTeam(F.WITH_HIRING_TEAM);
    expect(text).toMatch(/Nothing is needed from you/);
    const links = (html.match(/href="([^"]*)"/g) || []).filter((h) => !/fonts\.googleapis|\/unsubscribe\?/.test(h));
    expect(links, "the update grew a link, which makes it an ask").toEqual([]);
  });

  it("names the company in the subject, and keeps it inside a phone preview", () => {
    const { subject } = renderWithHiringTeam(F.WITH_HIRING_TEAM);
    expect(subject).toContain("Globex Logistics");
    expect(subject.length).toBeLessThanOrEqual(60);
  });
});

// The permission ask. It asks; it does not represent. renderRoleForward and
// renderWithHiringTeam are statements about something already done, and neither may be sent to
// anybody who has not answered THIS email with a yes. These assertions defend that boundary.
describe("the permission ask", () => {
  it("renderRepresentPermission", () => expect(renderRepresentPermission(F.REPRESENT_PERMISSION)).toMatchSnapshot());

  it("carries no em dash", () => {
    const m = renderRepresentPermission(F.REPRESENT_PERMISSION);
    for (const b of [m.html, m.text]) expect(b).not.toMatch(/—|–/);
  });

  it("exposes no mechanism word", () => {
    const { text } = renderRepresentPermission(F.REPRESENT_PERMISSION);
    for (const w of ["dossier", "screening", "talent pool", "rubric", "score", "shortlist", "record"]) {
      expect(text.toLowerCase()).not.toContain(w);
    }
  });

  // THE ONE THING THIS EMAIL MUST NEVER DO. If it ever states that a profile has moved, the sequence
  // collapses and somebody is represented without having agreed to it.
  it("never claims anything has been sent, and says so out loud", () => {
    const { text } = renderRepresentPermission(F.REPRESENT_PERMISSION);
    expect(text).toMatch(/have not sent them anything about you/);
    expect(text).toMatch(/will not unless you tell me to/);
    expect(text).not.toMatch(/went to|is going to|is in front of|have (put|sent) (you|your)/i);
  });

  it("asks for a yes and makes a no equally easy", () => {
    const { text } = renderRepresentPermission(F.REPRESENT_PERMISSION);
    expect(text).toMatch(/If you want me to put you forward, reply and say so/);
    expect(text).toMatch(/If it is a no, say that instead/);
  });

  // The role facts all arrive from the caller, so a detail the brief never gave cannot originate here.
  it("states nothing about the role on its own", () => {
    const bare = renderRepresentPermission({ email: "a@b.com", name: "Maya Rao", roleTitle: "UI/UX Designer", where: "X", band: "", studio: "", because: "" });
    expect(bare.text).not.toMatch(/Kolkata|two to four|apps for retail brands/);
  });

  it("names no company, and promises to before anything moves", () => {
    const { text } = renderRepresentPermission(F.REPRESENT_PERMISSION);
    expect(text).toMatch(/have not named the company/);
    expect(text).toMatch(/before anything with your name on it moves/);
  });

  it("keeps the role title's own casing in the subject", () => {
    // A lower-cased title ("ui/ux designer") reads badly. A title is a proper noun.
    expect(renderRepresentPermission(F.REPRESENT_PERMISSION).subject).toContain("UI/UX Designer");
  });
});

// The two that close the loop. One says interest is moving; the other asks the only
// question we have no other way to answer. Both sit inside a sequence where the tense is the product.
describe("the yes, acknowledged", () => {
  it("renderYesNoted", () => expect(renderYesNoted(F.YES_NOTED)).toMatchSnapshot());

  it("carries no em dash and no mechanism word", () => {
    const m = renderYesNoted(F.YES_NOTED);
    for (const b of [m.html, m.text]) expect(b).not.toMatch(/—|–/);
    for (const w of ["dossier", "screening", "talent pool", "rubric", "score"]) expect(m.text.toLowerCase()).not.toContain(w);
  });

  // THE BOUNDARY THIS DEFENDS. Interest is moving; a profile is not. renderWithHiringTeam is the only
  // template allowed to say somebody is in front of a company, and saying it early would mean telling
  // a person they are being considered before anyone has seen them.
  it("passes on interest, never a profile", () => {
    const { text } = renderYesNoted(F.YES_NOTED);
    expect(text).toMatch(/passing on that you are interested/);
    expect(text).not.toMatch(/your profile (went|is|has gone)|in front of them|sent them your/i);
  });

  it("promises to come back either way, and invents no date", () => {
    const { text } = renderYesNoted(F.YES_NOTED);
    expect(text).toMatch(/includes the day it turns out to be nothing/);
    // "as soon as I have something real" promises nothing and contains the word soon, so the ban is
    // on actual date claims rather than on a substring. A bare "soon" on its own is still a promise.
    expect(text).not.toMatch(/within \w+|by (monday|friday|next)|\d+ (days|weeks)|shortly|very soon|hear soon/i);
  });

  it("answers a question only when one was asked", () => {
    expect(renderYesNoted(F.YES_NOTED).text).toMatch(/You asked for the job details/);
    expect(renderYesNoted({ ...F.YES_NOTED, answered: "" }).text).not.toMatch(/You asked/);
  });
});

describe("has anyone been in touch", () => {
  it("renderAnyCalls", () => expect(renderAnyCalls(F.ANY_CALLS)).toMatchSnapshot());

  it("carries no em dash and no mechanism word", () => {
    const m = renderAnyCalls(F.ANY_CALLS);
    for (const b of [m.html, m.text]) expect(b).not.toMatch(/—|–/);
    for (const w of ["dossier", "screening", "talent pool", "rubric", "score"]) expect(m.text.toLowerCase()).not.toContain(w);
  });

  // IT MUST NOT READ AS PRESSURE. It follows shortly after these people were told, so "no" is the
  // expected answer and permission to give it comes BEFORE the question, not after.
  it("gives permission to say no, and to say nothing", () => {
    const { text } = renderAnyCalls(F.ANY_CALLS);
    const noIdx = text.indexOf("that is the normal answer this early");
    expect(noIdx).toBeGreaterThan(-1);
    expect(noIdx).toBeLessThan(text.indexOf("I would like to know"));
    expect(text).toMatch(/If you would rather not, that is completely fine and I will not ask again/);
  });

  it("gives the honest reason rather than implying one", () => {
    const { text } = renderAnyCalls(F.ANY_CALLS);
    expect(text).toMatch(/There is no tracker, no dashboard/);
    expect(text).toMatch(/What I have is what you tell me/);
  });

  it("asks nothing else and carries no link", () => {
    const { html } = renderAnyCalls(F.ANY_CALLS);
    const links = (html.match(/href="([^"]*)"/g) || []).filter((h) => !/fonts\.googleapis|\/unsubscribe\?/.test(h));
    expect(links).toEqual([]);
  });
});

// The correction for a templated reply.
describe("the reply correction", () => {
  it("renderReplyCorrection", () => expect(renderReplyCorrection(F.REPLY_CORRECTION)).toMatchSnapshot());

  it("carries no em dash and no mechanism word", () => {
    const m = renderReplyCorrection(F.REPLY_CORRECTION);
    for (const b of [m.html, m.text]) expect(b).not.toMatch(/—|–/);
    for (const w of ["dossier", "screening", "talent pool", "rubric"]) expect(m.text.toLowerCase()).not.toContain(w);
  });

  // THE POINT OF IT. A generic apology for a generic reply proves the complaint instead of answering
  // it, so the person's own words have to appear.
  it("quotes what they actually wrote", () => {
    const { text } = renderReplyCorrection(F.REPLY_CORRECTION);
    expect(text).toContain("nobody has called me so far");
    expect(renderReplyCorrection({ ...F.REPLY_CORRECTION, theirWords: "nope" }).text).toContain("nope");
  });

  it("names the mistake without hedging, and answers the real question", () => {
    const { text } = renderReplyCorrection(F.REPLY_CORRECTION);
    expect(text).toMatch(/replied as though you had not/);
    expect(text).toMatch(/Lumora has not been in touch with you/);
  });

  it("does not offer to change their preferences, which was the whole error", () => {
    const { text } = renderReplyCorrection(F.REPLY_CORRECTION);
    // It NAMES the mistake ("a note about changing your pay floor"), which is the opposite of making
    // it again. What must never reappear is the OFFER: the settings menu that caused this.
    expect(text).toMatch(/a note about changing your pay floor/);
    expect(text).not.toMatch(/if you'?d like to change|tell me in a reply and I'?ll update/i);
  });

  it("reassures without inventing a timeline", () => {
    const { text } = renderReplyCorrection(F.REPLY_CORRECTION);
    expect(text).toMatch(/changes nothing about where you stand/);
    expect(text).not.toMatch(/within \w+|by (monday|friday)|\d+ (days|weeks)/i);
  });
});

// The correction for somebody whose YES was answered with a form letter.
describe("the yes correction", () => {
  it("renderYesCorrection", () => expect(renderYesCorrection(F.YES_CORRECTION)).toMatchSnapshot());

  it("carries no em dash and no mechanism word", () => {
    const m = renderYesCorrection(F.YES_CORRECTION);
    for (const b of [m.html, m.text]) expect(b).not.toMatch(/—|–/);
    for (const w of ["dossier", "screening", "talent pool", "rubric"]) expect(m.text.toLowerCase()).not.toContain(w);
  });

  it("quotes them and owns the mistake without hedging", () => {
    const { text } = renderYesCorrection(F.YES_CORRECTION);
    expect(text).toContain("ok sure lets go ahead with it");
    expect(text).toMatch(/my fault, not a misunderstanding of what you wrote/);
  });

  // IT IS ONE EMAIL, NOT TWO. The person is owed a correction AND an answer, and splitting them would
  // add yet another email.
  it("answers as well as apologises", () => {
    const { text } = renderYesCorrection(F.YES_CORRECTION);
    expect(text).toMatch(/Yes, noted/);
    expect(text).toMatch(/passing on that you are interested/);
    expect(text).toMatch(/cannot name the company yet/);
  });

  // Interest moves, a profile does not. Same boundary every template in this sequence defends.
  it("passes on interest, never a profile", () => {
    expect(renderYesCorrection(F.YES_CORRECTION).text).not.toMatch(/your profile (went|is|has gone)|in front of them/i);
  });

  it("does not repeat the offer that caused it", () => {
    const { text } = renderYesCorrection(F.YES_CORRECTION);
    expect(text).toMatch(/a note about changing your pay floor/);
    expect(text).not.toMatch(/if you'?d like to change|tell me in a reply and I'?ll update/i);
  });
});

// The client status update. Three snapshots because the template has three shapes, and
// the two variants are not cosmetic: `reviewing` adds a claim about another company's behaviour, and
// an absent pointer must remove a line rather than render an empty or invented one.
describe("renderClientStatus", () => {
  it("with hiring team", () => expect(renderClientStatus(F.CLIENT_STATUS)).toMatchSnapshot());
  it("reviewing", () => expect(renderClientStatus(F.CLIENT_STATUS_REVIEWING)).toMatchSnapshot());
  it("no pointer", () => expect(renderClientStatus(F.CLIENT_STATUS_NO_POINTER)).toMatchSnapshot());
  it("they answered the follow-up", () => expect(renderClientStatus(F.CLIENT_STATUS_REPLIED)).toMatchSnapshot());

  // The reply clause is a claim that something they wrote is in front of the client. It is true for
  // the few who answered and false for everyone else, so it must be absent by default rather than
  // present-but-empty. Same failure shape as the pointer: an invented detail in a status mail.
  it("says nothing about a reply unless there was one", () => {
    for (const f of [F.CLIENT_STATUS, F.CLIENT_STATUS_REVIEWING, F.CLIENT_STATUS_NO_POINTER]) {
      const m = renderClientStatus(f);
      expect(`${m.text} ${m.html}`).not.toMatch(/the answer you wrote me/i);
    }
    const r = renderClientStatus(F.CLIENT_STATUS_REPLIED);
    expect(r.text).toContain("the answer you wrote me on 20 August");
    expect(r.html).toContain("the answer you wrote me on 20 August");
  });

  // Both halves list the same things in the same order. The pointer and the reply are built twice,
  // once per half, which is exactly how the two halves of a mail drift apart.
  it("carries the same list in the HTML and the text when there are two things", () => {
    const m = renderClientStatus({ ...F.CLIENT_STATUS, repliedOn: "20 August" });
    const line = "including the weather-dashboard repo you pointed us at and the answer you wrote me on 20 August";
    expect(m.text).toContain(line);
    expect(m.html).toContain(line);
  });

  // The pointer names something THEY submitted. When they submitted nothing usable the sentence has
  // to go, because a fabricated detail in a status email is worse than a shorter status email.
  it("drops the pointer sentence entirely when there is nothing to point at", () => {
    const { text, html } = renderClientStatus(F.CLIENT_STATUS_NO_POINTER);
    expect(text).toContain("Everything you sent went across with it.");
    expect(text).not.toContain("you pointed us at");
    expect(html).not.toContain("you pointed us at");
  });

  // "someone is reading it" is only ever true when a human marked them. It must not leak into the
  // default, which goes to everybody.
  it("never claims anyone is reading it unless reviewing is set", () => {
    for (const half of Object.values(renderClientStatus(F.CLIENT_STATUS))) {
      expect(String(half)).not.toMatch(/reading it|going through yours/i);
    }
    const rev = renderClientStatus(F.CLIENT_STATUS_REVIEWING);
    expect(rev.text).toMatch(/going through yours/);
  });

  // The two subjects this template sends ARE the pattern /inbound matches to file a reply. Two copies
  // of a subject line drift: the matcher stops recognising replies while reconciliation, reading the
  // same stale pattern, reports no gap. Tying them together is the only version that cannot drift.
  it("both subjects are recognised by the branch that files their replies", async () => {
    const { isClientStatusReply } = await import("../lib/evidence-record.mjs");
    for (const f of [F.CLIENT_STATUS, F.CLIENT_STATUS_REVIEWING]) {
      const { subject } = renderClientStatus(f);
      expect(isClientStatusReply(`Re: ${subject}`), `"${subject}" sends and nothing files its replies`).toBe(true);
    }
  });

  // These people applied to one role through a form. They are not enrolled in the matching product,
  // so the copy must never promise future roles or offer to change preferences. That promise is what
  // renderAck makes, and sending it here would misdescribe the relationship.
  it("promises no future roles and offers no preference change", () => {
    for (const f of [F.CLIENT_STATUS, F.CLIENT_STATUS_REVIEWING, F.CLIENT_STATUS_NO_POINTER]) {
      const { text } = renderClientStatus(f);
      expect(text).not.toMatch(/pay floor|another role|more roles|when one/i);
    }
  });
});

// The ack for a reply to a client-status mail. `toBoard` is a claim about where their
// words physically went, so it is pinned rather than treated as tone.
describe("renderClientReplyAck", () => {
  it("filed to the board", () => expect(renderClientReplyAck(F.CLIENT_REPLY_ACK)).toMatchSnapshot());
  it("filed to the record only", () => expect(renderClientReplyAck(F.CLIENT_REPLY_ACK_RECORD)).toMatchSnapshot());
  it("nothing filed", () => expect(renderClientReplyAck(F.CLIENT_REPLY_ACK_NONE)).toMatchSnapshot());

  // Board filing can fail: no row for that address, or Notion unreachable. Saying the hiring team can
  // see something they cannot is a claim about the world, not a softer wording.
  it("never says the hiring team can see it unless it reached them", () => {
    const no = renderClientReplyAck(F.CLIENT_REPLY_ACK_RECORD);
    expect(`${no.text} ${no.html}`).not.toMatch(/hiring team reads it/i);
    const yes = renderClientReplyAck(F.CLIENT_REPLY_ACK);
    expect(yes.text).toMatch(/hiring team reads it/);
  });

  // A reply below the filing floor ("thanks!") gets an ack that claims NOTHING. "It is on your file"
  // when nothing was filed is a step that stopped working and kept reporting success.
  it("claims nothing at all when nothing was filed", () => {
    const { text, html } = renderClientReplyAck(F.CLIENT_REPLY_ACK_NONE);
    expect(`${text} ${html}`).not.toMatch(/on your file|hiring team reads it|word for word/i);
    expect(text).toMatch(/If something moves, you will hear from me/);
  });

  // The whole reason this template exists: renderAck would offer these people a pay-floor change and
  // promise them roles, neither of which is true of somebody who applied to one role through a form.
  it("promises no future roles and offers no preference change", () => {
    for (const f of [F.CLIENT_REPLY_ACK, F.CLIENT_REPLY_ACK_RECORD, F.CLIENT_REPLY_ACK_NONE]) {
      const { text, html } = renderClientReplyAck(f);
      expect(`${text} ${html}`).not.toMatch(/pay floor|another role|more roles|worth your time/i);
    }
  });
});

// The CV request.
describe("renderBreakingSilence", () => {
  it("the ask shape", () => expect(renderBreakingSilence(F.BREAKING_SILENCE_ASK)).toMatchSnapshot());
  it("the nothing-needed shape", () => expect(renderBreakingSilence(F.BREAKING_SILENCE_NO_ASK)).toMatchSnapshot());
  it("no name", () => expect(renderBreakingSilence(F.BREAKING_SILENCE_NO_NAME)).toMatchSnapshot());

  // The mail makes exactly one claim about us. Rendering it blank would send a boast with a hole in it.
  it("refuses to render without the number", () => {
    expect(() => renderBreakingSilence({ ...F.BREAKING_SILENCE_ASK, putForward: 0 })).toThrow(/putForward/);
  });

  // "Put in front of a hiring manager" is what happened. "Placed" is not: every representation on
  // record is still awaiting an outcome, and a candidate who later learns that remembers being told
  // otherwise.
  it("never claims a placement, an interview or an offer", () => {
    for (const f of [F.BREAKING_SILENCE_ASK, F.BREAKING_SILENCE_NO_ASK]) {
      const { text, subject } = renderBreakingSilence(f);
      expect(`${subject} ${text}`).not.toMatch(/\bplaced\b|\bhired\b|\boffer\b|got them a job|landed (a|the) role|interview/i);
    }
  });

  // The whole point of writing to people who need nothing. A pool that chases everyone for the same
  // thing every time is a pool nobody answers.
  it("asks the settled 505 for nothing at all", () => {
    const { text } = renderBreakingSilence(F.BREAKING_SILENCE_NO_ASK);
    expect(text).toMatch(/nothing to do/i);
    expect(text).not.toMatch(/missing|send me|best work|a few lines/i);
  });

  it("asks everyone else for their best work, not a guess about them", () => {
    // A different question per role family reads as a form and puts words in a person's mouth about
    // what their best work ought to be.
    const { text } = renderBreakingSilence(F.BREAKING_SILENCE_ASK);
    expect(text).toMatch(/your best work so far/i);
    expect(text).toMatch(/proudest of/i);
  });

  it("stays a 40-second read", () => {
    for (const f of [F.BREAKING_SILENCE_ASK, F.BREAKING_SILENCE_NO_ASK]) {
      expect(renderBreakingSilence(f).text.split(/\s+/).length).toBeLessThan(170);
    }
  });
});

describe("renderDecisionAsk", () => {
  it("one gap", () => expect(renderDecisionAsk(F.DECISION_ASK)).toMatchSnapshot());
  it("two gaps", () => expect(renderDecisionAsk(F.DECISION_ASK_TWO)).toMatchSnapshot());
  it("no name", () => expect(renderDecisionAsk(F.DECISION_ASK_NO_NAME)).toMatchSnapshot());

  // Without a gap there is nothing true to ask, and an email that cannot say what it wants is a chase.
  // Worse, sending it to somebody whose application is complete invents a deficiency in a real person.
  it("refuses to render with nothing to ask", () => {
    expect(() => renderDecisionAsk({ ...F.DECISION_ASK, missing: "" })).toThrow(/missing/);
  });

  // It must not claim the reader has been selected, shortlisted or advanced. None of them have been.
  it("makes no claim about the reader's status", () => {
    for (const f of [F.DECISION_ASK, F.DECISION_ASK_TWO, F.DECISION_ASK_NO_NAME]) {
      const { text, subject } = renderDecisionAsk(f);
      // "a few" is deliberately NOT banned outright: "a few lines is plenty" is the ask itself. What
      // must never appear is the SCARCITY claim — "you are one of a few" — which is false for almost
      // everyone it would go to.
      expect(`${subject} ${text}`).not.toMatch(/shortlist|short list|selected|one of a few|among a few|a few (candidates|people|applicants)|impressed|stood out|advanc|final round|interview/i);
    }
  });

  // The gap is OURS, not a flaw of theirs. A person reading this must not come away thinking they
  // were judged and found wanting on something they were never asked about.
  it("frames the gap as our blank rather than their failing", () => {
    const { text } = renderDecisionAsk(F.DECISION_ASK);
    expect(text).toMatch(/not a mark against you/i);
    expect(text).toMatch(/blank on our side/i);
    expect(text).not.toMatch(/weak|lacking|missing from your|you failed|concern/i);
  });

  // Saying no must stay costless, and "no" must remain a real answer rather than a silence.
  it("keeps not answering a live option", () => {
    const { text } = renderDecisionAsk(F.DECISION_ASK);
    expect(text).toMatch(/still stands/i);
    expect(text).toMatch(/say so plainly/i);
  });
});

describe("renderCvRequest", () => {
  it("named", () => expect(renderCvRequest(F.CV_REQUEST)).toMatchSnapshot());
  it("no name", () => expect(renderCvRequest(F.CV_REQUEST_NO_NAME)).toMatchSnapshot());

  // The link is the entire point. An email that renders without one is worse than not sending.
  it("refuses to render without a form url", () => {
    expect(() => renderCvRequest({ ...F.CV_REQUEST, formUrl: "" })).toThrow(/formUrl/);
  });

  // It must not claim the reader has been selected, shortlisted or advanced. None of them have been. A false signal about progress is the worst error available here.
  it("makes no claim about the reader's status", () => {
    for (const f of [F.CV_REQUEST, F.CV_REQUEST_NO_NAME]) {
      const { text, subject } = renderCvRequest(f);
      expect(`${subject} ${text}`).not.toMatch(/shortlist|selected|a few|short list|impressed|stood out|advanc/i);
    }
  });

  // And it must not apologise. Grovelling makes the reader feel worse about something that was
  // never their problem.
  it("does not apologise", () => {
    const { text } = renderCvRequest(F.CV_REQUEST);
    expect(text).not.toMatch(/sorry|apolog|our mistake|our fault|oversight/i);
  });

  // Reusing the original address is the join key. Without that instruction a CV arrives that cannot
  // be matched to anybody.
  it("tells them to reuse the address they applied with", () => {
    expect(renderCvRequest(F.CV_REQUEST).text).toMatch(/same email you applied with/i);
  });
});

// The inbound replies (render-reply.mjs). Six templates, one per situation.
//
// These carry a register no other template here has: NO <h1> and NO eyebrow, because a person does
// not put a headline on a reply. That is exactly the kind of structural claim a snapshot exists to
// hold, so it is pinned below as well as snapshotted.
describe("the inbound replies", () => {
  const ALL = () => [
    renderConsentGrant(F.REPLY_CONSENT), renderDispute(F.REPLY_DISPUTE),
    renderStatusUpdate(F.REPLY_STATUS), renderAnswerNoted(F.REPLY_ANSWER),
    renderOffTopic(F.REPLY_OFF_TOPIC), renderUnsure(F.REPLY_UNSURE),
  ];

  it("renderConsentGrant", () => expect(renderConsentGrant(F.REPLY_CONSENT)).toMatchSnapshot());
  it("renderDispute", () => expect(renderDispute(F.REPLY_DISPUTE)).toMatchSnapshot());
  it("renderStatusUpdate", () => expect(renderStatusUpdate(F.REPLY_STATUS)).toMatchSnapshot());
  it("renderAnswerNoted", () => expect(renderAnswerNoted(F.REPLY_ANSWER)).toMatchSnapshot());
  it("renderOffTopic", () => expect(renderOffTopic(F.REPLY_OFF_TOPIC)).toMatchSnapshot());
  it("renderUnsure", () => expect(renderUnsure(F.REPLY_UNSURE)).toMatchSnapshot());

  it("carry no em dash", () => {
    for (const m of ALL()) for (const b of [m.html, m.text]) expect(b).not.toMatch(/—|–/);
  });

  it("expose no mechanism word", () => {
    // "record" is in this list and NOT in the one above: renderAskAnswerAck says "it is on your
    // record now", which is live copy.
    for (const m of ALL()) {
      for (const w of ["dossier", "screening", "record", "rubric", "talent pool", "home_place"]) {
        expect(m.text.toLowerCase(), `"${w}" in ${m.subject}`).not.toContain(w);
        expect(m.html.toLowerCase(), `"${w}" in the html of ${m.subject}`).not.toContain(w);
      }
    }
  });

  it("carry no headline and no eyebrow (the reply register)", () => {
    for (const m of ALL()) {
      expect(m.html, `${m.subject} has an h1`).not.toMatch(/<h1[\s>]/i);
      expect(m.html, `${m.subject} has an eyebrow`).not.toMatch(/text-transform:\s*uppercase/i);
    }
  });

  it("never offer the preferences menu, which is the defect they replace", () => {
    for (const m of ALL()) {
      expect(m.text).not.toMatch(/pay floor/i);
      expect(m.text).not.toMatch(/if you'?d like to change|tell me in a reply and I'?ll update/i);
    }
  });

  it("greet without a name when we do not have one", () => {
    // "Hi , " reaching a real person is the failure this guards.
    for (const r of [renderStatusUpdate, renderAnswerNoted, renderOffTopic, renderUnsure]) {
      const { text, html } = r(F.REPLY_NO_NAME);
      expect(text).not.toMatch(/Hi\s*,/);
      expect(html).not.toMatch(/Hi\s*,/);
    }
  });

  it("still use the locked shell (logo, unsubscribe, tokens)", () => {
    for (const m of ALL()) {
      expect(m.html).toContain("/unsubscribe?");
      expect(m.html).toContain("charlie-hand.png");
    }
  });
});

describe("the role put to one person, and what an answer gets back", () => {
  const ALL = () => [renderRoleIntent(F.ROLE_INTENT), renderRoleIntent(F.ROLE_INTENT_BARE), renderIntentAnswer(F.INTENT_ANSWER)];

  it("renderRoleIntent", () => expect(renderRoleIntent(F.ROLE_INTENT)).toMatchSnapshot());
  it("renderRoleIntent (no name, no facts)", () => expect(renderRoleIntent(F.ROLE_INTENT_BARE)).toMatchSnapshot());
  it("renderIntentAnswer", () => expect(renderIntentAnswer(F.INTENT_ANSWER)).toMatchSnapshot());

  it("carry no em dash", () => {
    for (const m of ALL()) for (const b of [m.subject, m.html, m.text]) expect(b).not.toMatch(/—|–/);
  });

  it("expose no mechanism word", () => {
    for (const m of ALL()) {
      for (const w of ["dossier", "screening", "talent pool", "rubric", "score", "shortlist"]) {
        expect(m.text.toLowerCase()).not.toContain(w);
      }
    }
  });

  it("refuses to render without a reason it was them", () => {
    // No true line about somebody means no email for them. An empty `because` must not degrade into
    // "I thought of you because ." in a real inbox.
    expect(() => renderRoleIntent({ ...F.ROLE_INTENT, because: "" })).toThrow(/because is required/);
    expect(() => renderRoleIntent({ ...F.ROLE_INTENT, because: "  . " })).toThrow(/because is required/);
  });

  it("a yes cannot be read as a submission", () => {
    // The whole reason this is not renderRoleInvite: these people have not cleared the brief.
    const { text } = renderRoleIntent(F.ROLE_INTENT);
    expect(text).toMatch(/The next step is not your name going to them/);
    expect(text).not.toMatch(/put it in front of them|put what you have already sent/i);
  });

  it("names no company and gives no reason for that", () => {
    const { text } = renderRoleIntent(F.ROLE_INTENT);
    expect(text).toMatch(/I am not naming the company/);
    expect(text).not.toMatch(/asked us not to/i);
  });

  it("the acknowledgement is true of a no as well as a yes", () => {
    // renderAskAnswerAck tells every replier their background is going to the hiring side.
    const { text } = renderIntentAnswer(F.INTENT_ANSWER);
    expect(text).not.toMatch(/taking the shape of your background|to the hiring side/i);
    expect(text).toMatch(/If it was a no, nothing moves/);
  });

  it("says what THIS brief is strict about, never another job's", () => {
    // Role-specific phrasing such as "deal size and targets", sent to a designer, is a sentence about
    // somebody else's job in a real inbox.
    const pm = renderRoleIntent(F.ROLE_INTENT_BARE).text;
    expect(pm).toMatch(/high bar on the products you have shipped/);
    expect(pm).not.toMatch(/deal size|targets|their own numbers/);
    expect(pm).toMatch(/That is from your own answers, not a guess of mine/);
    for (const k of ["bar", "questionCount", "proof"]) {
      expect(() => renderRoleIntent({ ...F.ROLE_INTENT, [k]: "" })).toThrow(new RegExp(`${k} is required`));
    }
  });

  it("uses the article the role needs", () => {
    expect(renderRoleIntent(F.ROLE_INTENT).subject).toMatch(/^An account executive role/);
    expect(renderRoleIntent(F.ROLE_INTENT_BARE).subject).toMatch(/^A product manager role/);
  });
});


describe("the questions that follow a yes, and what answering them gets back", () => {
  const ALL = () => [renderIntentQuestions(F.INTENT_QUESTIONS), renderIntentQuestions(F.INTENT_QUESTIONS_BARE), renderQuestionsAnswer(F.QUESTIONS_ANSWER)];

  it("renderIntentQuestions", () => expect(renderIntentQuestions(F.INTENT_QUESTIONS)).toMatchSnapshot());
  it("renderIntentQuestions (one question, no name)", () => expect(renderIntentQuestions(F.INTENT_QUESTIONS_BARE)).toMatchSnapshot());
  it("renderQuestionsAnswer", () => expect(renderQuestionsAnswer(F.QUESTIONS_ANSWER)).toMatchSnapshot());

  it("carry no em dash", () => {
    for (const m of ALL()) for (const b of [m.subject, m.html, m.text]) expect(b).not.toMatch(/—|–/);
  });

  it("expose no mechanism word", () => {
    for (const m of ALL()) {
      for (const w of ["dossier", "screening", "talent pool", "rubric", "score", "shortlist"]) {
        expect(m.text.toLowerCase()).not.toContain(w);
      }
    }
  });

  it("the headline counts the questions it actually asks", () => {
    expect(renderIntentQuestions(F.INTENT_QUESTIONS).subject).toMatch(/^Three questions before/);
    expect(renderIntentQuestions(F.INTENT_QUESTIONS_BARE).subject).toMatch(/^One question before/);
  });

  it("every question passed in reaches both halves, numbered", () => {
    const m = renderIntentQuestions(F.INTENT_QUESTIONS);
    F.INTENT_QUESTIONS.questions.forEach((q, i) => {
      expect(m.text).toContain(`${i + 1}. ${q}`);
      expect(m.html).toContain(`${i + 1}. `);
    });
  });

  it("refuses to render with nothing to ask, or with a form's worth", () => {
    expect(() => renderIntentQuestions({ ...F.INTENT_QUESTIONS, questions: [] })).toThrow(/at least one question/);
    expect(() => renderIntentQuestions({ ...F.INTENT_QUESTIONS, questions: ["a", "b", "c", "d", "e", "f"] })).toThrow(/five questions at most/);
  });

  it("invites a plain no, and promises an answer rather than an outcome", () => {
    const { text } = renderIntentQuestions(F.INTENT_QUESTIONS);
    expect(text).toMatch(/not something you have done, say so plainly/);
    expect(text).toMatch(/tell you straight whether I am putting you forward/);
    expect(text).not.toMatch(/I will put you forward|you will be put forward/i);
  });

  it("the acknowledgement does not decide anything", () => {
    const { text } = renderQuestionsAnswer(F.QUESTIONS_ANSWER);
    expect(text).toMatch(/Nothing about you has gone to them/);
    expect(text).not.toMatch(/you are being put forward|you have been put forward|shortlist/i);
  });
});

describe("where this stands, and what writing back gets", () => {
  const ALL = () => [renderRoleHold(F.ROLE_HOLD), renderRoleHold(F.ROLE_HOLD_BARE), renderHoldAnswer(F.HOLD_ANSWER)];

  it("renderRoleHold", () => expect(renderRoleHold(F.ROLE_HOLD)).toMatchSnapshot());
  it("renderRoleHold (no name)", () => expect(renderRoleHold(F.ROLE_HOLD_BARE)).toMatchSnapshot());
  it("renderHoldAnswer", () => expect(renderHoldAnswer(F.HOLD_ANSWER)).toMatchSnapshot());

  it("carry no em dash", () => {
    for (const m of ALL()) for (const b of [m.subject, m.html, m.text]) expect(b).not.toMatch(/—|–/);
  });

  it("expose no mechanism word", () => {
    for (const m of ALL()) {
      for (const w of ["dossier", "screening", "talent pool", "rubric", "score", "shortlist"]) {
        expect(m.text.toLowerCase()).not.toContain(w);
      }
    }
  });

  it("claims no submission, announces no withdrawal, names no date", () => {
    // The sentence this template exists to NOT send: "your application is submitted".
    const { text } = renderRoleHold(F.ROLE_HOLD);
    expect(text).not.toMatch(/submitted|application|withdrawn|withdrew|closed|paused|on hold|inactive/i);
    expect(text).not.toMatch(/\b(monday|tuesday|wednesday|thursday|friday|week|days|tomorrow)\b/i);
    expect(text).toMatch(/Nothing with your name on it has gone anywhere/);
    expect(text).toMatch(/If anything moves, you will hear from me/);
  });

  it("asks nothing", () => {
    for (const m of [renderRoleHold(F.ROLE_HOLD), renderHoldAnswer(F.HOLD_ANSWER)]) expect(m.text).not.toMatch(/\?/);
  });
});

// ── The Qualify & Submit agent's sequence (lib/qualify/agent.mjs) ─────────────────────────────────
import { renderQualifyVerify, renderQualifyReminder, renderQualifyPutForward, renderQualifyClosed, renderQualifyConfirm, renderQualifyHandoff } from "../email-kit.mjs";

describe("the Qualify & Submit sequence", () => {
  it("verify", () => { const m = renderQualifyVerify(F.QUALIFY_VERIFY); expect(m.subject).toMatchSnapshot(); expect(m.html).toMatchSnapshot(); expect(m.text).toMatchSnapshot(); });
  it("reminder", () => { const m = renderQualifyReminder(F.QUALIFY_REMINDER); expect(m.subject).toMatchSnapshot(); expect(m.html).toMatchSnapshot(); expect(m.text).toMatchSnapshot(); });
  it("put forward", () => { const m = renderQualifyPutForward(F.QUALIFY_PUT_FORWARD); expect(m.subject).toMatchSnapshot(); expect(m.html).toMatchSnapshot(); expect(m.text).toMatchSnapshot(); });
  it("closed, no plain YES: says nothing was sent, never that they said no", () => { const m = renderQualifyClosed({ ...F.QUALIFY_CLOSED, noYes: true }); expect(m.text).toMatch(/didn't get a reply of just YES/); expect(m.text).toMatch(/nothing was sent/); expect(m.text).not.toMatch(/—/); });
  it("confirm", () => { const m = renderQualifyConfirm(F.QUALIFY_CONFIRM); expect(m.subject).toMatchSnapshot(); expect(m.html).toMatchSnapshot(); expect(m.text).toMatchSnapshot(); expect(m.text).toMatch(/reply with just YES/); expect(m.text).toMatch(/CV: Asha_Rao_CV\.pdf/); });
  it("closed", () => { const m = renderQualifyClosed(F.QUALIFY_CLOSED); expect(m.subject).toMatchSnapshot(); expect(m.html).toMatchSnapshot(); expect(m.text).toMatchSnapshot(); });
  it("hand-off", () => { const m = renderQualifyHandoff(F.QUALIFY_HANDOFF); expect(m.subject).toMatchSnapshot(); expect(m.html).toMatchSnapshot(); expect(m.text).toMatchSnapshot(); });
  it("hand-off: the confirmed lines unchanged, the note addressed to the employer, where to write", () => {
    const facts = F.QUALIFY_HANDOFF.facts;
    const m = renderQualifyHandoff(F.QUALIFY_HANDOFF);
    expect(m.subject).toBe("Introducing Asha Rao for Support Engineer");
    expect(m.text).toMatch(/^Hi Meera\./);
    expect(m.text).toMatch(/On behalf of Acme Talent, I am introducing Asha Rao for the Support Engineer role at Acme Robotics\./);
    for (const f of facts.slice(0, 3)) expect(m.text).toContain(f);
    expect(m.text).toContain("About them: Resolved billing tickets at Acme.");
    expect(m.text).not.toMatch(/about you/);
    expect(m.text).toMatch(/Replies here don't reach me, so please write to Asha directly at asha@x\.com\./);
    expect(m.text).not.toMatch(/[\u2012-\u2015]/);
    expect(m.html).toMatch(/unsubscribe/i);
    const { org: _org, ...noOrg } = F.QUALIFY_HANDOFF;
    expect(renderQualifyHandoff(noOrg).text).not.toMatch(/on behalf of/i);
    expect(() => renderQualifyHandoff({ ...F.QUALIFY_HANDOFF, facts: [] })).toThrow(/confirmed facts/);
    expect(() => renderQualifyHandoff({ ...F.QUALIFY_HANDOFF, candidateEmail: "" })).toThrow(/required/);
  });

  it("asks consent first, names the company, never says screening, record or status, and promises nothing", () => {
    const all = [renderQualifyClosed({ ...F.QUALIFY_CLOSED, noYes: true }), renderQualifyConfirm(F.QUALIFY_CONFIRM), renderQualifyVerify(F.QUALIFY_VERIFY), renderQualifyReminder(F.QUALIFY_REMINDER), renderQualifyPutForward(F.QUALIFY_PUT_FORWARD), renderQualifyClosed(F.QUALIFY_CLOSED), renderQualifyHandoff(F.QUALIFY_HANDOFF)];
    expect(renderQualifyVerify(F.QUALIFY_VERIFY).text).toMatch(/1\. May I put you forward to Acme Robotics/);
    for (const m of all) {
      expect(`${m.subject} ${m.text}`).not.toMatch(/\b(screening|record|status|dossier)\b/i);
      expect(m.text).not.toMatch(/[‒-―]/);
      expect(m.text).not.toMatch(/guarantee|you will be hired/i);
      expect(m.html).toMatch(/unsubscribe/i);
    }
  });

  it("refuses to render without the role, the company or the questions", () => {
    expect(() => renderQualifyVerify({ ...F.QUALIFY_VERIFY, company: "" })).toThrow(/required/);
    expect(() => renderQualifyVerify({ ...F.QUALIFY_VERIFY, questions: [] })).toThrow(/questions/);
  });
});

// ── Pieworks 2call activation (lib/pieworks-activation.mjs) ───────────────────────────────────────
import { renderPieworksAsk, renderPieworksReminder, renderPieworksClarify, renderPieworksNoted, renderPieworksStats } from "../email-kit.mjs";

describe("the Pieworks 2call activation sequence", () => {
  const { city: _city, ...noCity } = F.PIEWORKS_ASK;
  it("ask", () => { const m = renderPieworksAsk(F.PIEWORKS_ASK); expect(m.subject).toMatchSnapshot(); expect(m.html).toMatchSnapshot(); expect(m.text).toMatchSnapshot(); });
  it("reminder", () => { const m = renderPieworksReminder(noCity); expect(m.subject).toMatchSnapshot(); expect(m.html).toMatchSnapshot(); expect(m.text).toMatchSnapshot(); });
  it("clarify", () => { const m = renderPieworksClarify(noCity); expect(m.subject).toMatchSnapshot(); expect(m.html).toMatchSnapshot(); expect(m.text).toMatchSnapshot(); });
  it("noted", () => { const m = renderPieworksNoted(noCity); expect(m.subject).toMatchSnapshot(); expect(m.html).toMatchSnapshot(); expect(m.text).toMatchSnapshot(); });
  it("stats (owner)", () => { const m = renderPieworksStats(F.PIEWORKS_STATS); expect(m.subject).toMatchSnapshot(); expect(m.text).toMatchSnapshot(); expect(m.text).toMatch(/This week: 31 emailed, 11 moved to interested \(35%\)\./); });

  it("asks YES or NO, names the company, never describes the person, promises nothing, has no dashes", () => {
    const all = [renderPieworksAsk(F.PIEWORKS_ASK), renderPieworksReminder(noCity), renderPieworksClarify(noCity), renderPieworksNoted(noCity)];
    expect(all[0].text).toMatch(/Reply YES/);
    expect(all[0].text).toMatch(/at Acme Robotics in Jaipur/);
    for (const m of all) {
      expect(`${m.subject} ${m.text}`).toMatch(/Acme Robotics/);
      expect(`${m.subject} ${m.text}`).not.toMatch(/\b(screening|record|status|dossier|2call|webhook)\b/i);
      expect(m.text).not.toMatch(/[‒-―]/);
      expect(m.text).not.toMatch(/guarantee|you will be hired|interview/i);
      expect(m.html).toMatch(/unsubscribe/i);
    }
  });

  it("the ask is personal: referred or not, and each fact line only when it was given", () => {
    const referred = renderPieworksAsk(F.PIEWORKS_ASK);
    expect(referred.subject).toBe("Ravi, you were referred for Support Engineer-Billing L2 at Acme Robotics");
    expect(referred.text).toMatch(/^Hi Ravi,\n\nYou were referred to Pieworks for the Support Engineer-Billing L2 role at Acme Robotics in Jaipur, and you're on their shortlist\./);
    expect(referred.text).toContain("Pay: 5 to 8 lakh a year (CTC)");
    expect(referred.text).toContain("Experience: 1 to 3 years (you have 2)");
    expect(referred.text).toContain("The role: Resolve customer tickets for the billing product.");
    const plain = renderPieworksAsk({ ...F.PIEWORKS_ASK, referred: false, pay: "", years: "", line: "" });
    expect(plain.subject).toBe("Ravi, you're on the shortlist for Support Engineer-Billing L2 at Acme Robotics");
    expect(plain.text).toMatch(/You're on Pieworks' shortlist for the Support Engineer/);
    expect(plain.text).not.toMatch(/referred|Pay:|Experience:|The role:/);
    expect(renderPieworksAsk({ ...F.PIEWORKS_ASK, name: "" }).subject).toBe("You were referred for Support Engineer-Billing L2 at Acme Robotics");
    expect(renderPieworksReminder(F.PIEWORKS_ASK).text).toMatch(/you were referred for\./);
  });

  it("refuses to render without the role or the company", () => {
    for (const r of [renderPieworksAsk, renderPieworksReminder, renderPieworksClarify, renderPieworksNoted]) {
      expect(() => r({ ...F.PIEWORKS_ASK, company: "" })).toThrow(/required/);
      expect(() => r({ ...F.PIEWORKS_ASK, role: "" })).toThrow(/required/);
    }
  });
});

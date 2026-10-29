// emails/fixtures.mjs — realistic, deterministic fixture data for the email snapshot tests.
// Every new template MUST add a fixture here and a snapshot test.
// Dates are fixed strings; the test freezes system time so relative-time output is stable.

// ── Role email (render-email.mjs → renderEmail) ─────────────────────────────
// Rich US fixture: exercises nearly every ROLE token (fit meter, resume-vs-listing chart,
// honest catch, company stats + momentum chip, pay chip, positioning box, referral card, chips).
export const ROLE_US = {
  fields: {
    role_title: "Senior Product Designer",
    // ROLE_US is the "exercises all ROLE tokens" fixture, so it carries a why_you: the "Why you"
    // heading renders only when there is a rationale under it, and without one these snapshots would
    // silently stop covering the rationale path. ROLE_RARE spreads ROLE_US and therefore inherits it;
    // the ABSENT-rationale branch is covered by role-ask.test.mjs instead.
    why_you:
      "You took Lumen from zero to adopted across every surface, which is the exact scope this role opens with, and you have said you want a systems mandate rather than feature work.",
    company: "Klaviyo",
    job_summary:
      "Klaviyo is looking for a senior product designer to evolve Ascent, their internal design system, by owning components, tokens, patterns, and documentation across product surfaces.",
    facts: [
      { k: "Location", v: "Boston, MA (remote not stated)" },
      { k: "Team", v: "Design Systems" },
    ],
    flag: "They lean senior on martech; name the transferable bit so it doesn't read as a domain gap.",
    resume_tips: [
      "Lead with the Lumen design system you took from zero to adopted.",
      "Your 0 to 1 dashboard work, framed as product judgment.",
    ],
    company_insight: {
      name: "Klaviyo",
      what: "Marketing automation and CRM for e-commerce brands.",
      stage: "Public",
      raised: "~$778M",
      size: "~2,368 people",
      sources: [{ label: "Crunchbase", url: "#" }],
    },
  },
  match: { score: 78 },
  cov: {
    thin: false,
    composite: 78,
    lane: "apply",
    coverage: [
      { req: "Design systems", status: "met" },
      { req: "Components & tokens", status: "met" },
      { req: "Accessibility · WCAG AA", status: "met" },
      { req: "Design-to-code parity", status: "partial" },
      { req: "AI-assisted workflows", status: "unknown" },
      { req: "Martech domain", status: "unknown" },
    ],
    topMove: "Open with the Lumen design system you took from zero to adopted.",
    seniorityLevel: "at",
    subscores: { domain: 0.72, mustHave: 0.79 },
    // The three-line first-pass read. `recent` deliberately carries NO chip — nothing measures
    // recency, and a chip that argues with its own sentence is worse than none (lib/fit-screen.mjs).
    screen: {
      level: "They ask for six or more years leading design systems. You have eight, four of them owning one.",
      domain: "They sell martech to enterprise teams. You built for airport operations teams. Same many-stakeholder, high-stakes user, a different industry.",
      recent: "Your last two years were the Lumen design system end to end, which is the job described here.",
    },
  },
  label: "Today's pick",
  region: "us",
  postedAt: "2026-07-10T12:00:00.000Z", // "2 days ago" under the frozen clock
  pay: {
    lo: 170000,
    hi: 205000,
    currency: "USD",
    bls: { median: 119190, socLabel: "digital & interface designers", area: "Boston metro", url: "#" },
  },
  momentum: { openNow: 68, opened30d: 12, monthAgo: 52, trendSource: "snapshot", trend: [52, 68], company: "Klaviyo" },
  referral: {
    name: "Jordan Lee",
    position: "Staff Product Designer, Klaviyo",
    linkedin: "https://www.linkedin.com/in/jordan-lee-example",
    reach: "mailto:z@k.com",
  },
  applyUrl: "https://example.com/apply",
  unsubUrl: "https://test.charlie.local/unsub",
  attached: true,
  email: "a@b.com",
  findId: "a@b.com:job1",
};

// Thin / India fixture: prose-fallback fit path + all US-only blocks hidden (region !== "us").
export const ROLE_THIN = {
  fields: {
    role_title: "Product Designer",
    company: "Zluri",
    job_summary: "Zluri is hiring a product designer to shape their SaaS management product.",
    facts: [{ k: "Location", v: "Bengaluru, hybrid" }],
    flag: "Early-stage; expect breadth over depth.",
    why_you: "Your systems work maps cleanly to their design-debt problem.",
  },
  match: { score: 72 },
  cov: { thin: true },
  label: "Fresh pick",
  region: "in",
  postedAt: "2026-07-11T12:00:00.000Z",
  applyUrl: "https://example.com/apply2",
  unsubUrl: "https://test.charlie.local/unsub",
  attached: false,
  email: "c@d.com",
  findId: "c@d.com:job2",
};

// Rare-find fixture: same rich US role, but the Edge Engine variant — the "Rare find" label (plum chip)
// and the grounded opening line at the top of the body (edgeFrame). Locks the rare-combo rendering and
// confirms the body never prints "Attached: intro message." even though a referral resolved.
export const ROLE_RARE = {
  ...ROLE_US,
  label: "Rare find",
  edgeFrame:
    "Most designers who apply here show one side of the job. You show both: the systems depth from taking Lumen from zero to adopted, and the zero to one product judgment. This is a role your specific mix is rare for.",
};

// ── Lifecycle emails (email-kit.mjs) ────────────────────────────────────────
export const WELCOME = { email: "a@b.com", name: "Maya", thin: false, ask: "what's your pay floor?", strength: "the Lumen design system" };
export const MISSING_RESUME = { email: "a@b.com", name: "Maya" };
// The follow-up to MISSING_RESUME: they were asked, and never wrote back. Nameless on purpose —
// this email goes to people we have no grounded profile for, so a name is the exception, not the rule.
export const SECOND_CHANCE = { email: "a@b.com" };
// The resume-not-needed recovery: nameless on purpose — these people never onboarded, so there is
// no grounded name to greet them with.
export const RESUME_NOT_NEEDED = { email: "a@b.com" };
// A re-opt-in check for someone unsubscribed (likely by a scanner) right as they engaged. Named,
// because this only goes to people who wrote in and have a profile we can pick back up.
export const REOPT_IN = { email: "a@b.com", name: "Maya" };
// The honest "give me a few minutes" reply when an onboarding build fails on our side (a model
// outage) rather than a bad resume. Nameless: onboarding fires before we have a grounded name.
export const BUILD_DELAYED = { email: "a@b.com" };
// The honest "I only cover India and the US" note for a candidate whose grounded home is outside both
// markets. `place` is their stated home, rendered verbatim. Named here; the name guard is exercised
// separately in the test (a junk section-header name must not open the email).
export const OUT_OF_MARKET = { email: "a@b.com", name: "Lena", place: "Lisbon" };
// The wedge drip (variant A). `combo` is the grounded, verified rare combination (code-rendered
// verbatim); `copy` is the model's connective prose. A null `copy` falls back to grounded defaults.
export const WEDGE = {
  email: "a@b.com",
  combo: "An architecture degree and three years designing maps.",
  copy: {
    subject: "I think I found your edge",
    opening: "I went back through everything you've told me, and one thing keeps standing out.",
    edge_line: "That combination is rarer than you'd guess, and it's the most valuable thing you bring.",
    advantage_line: "It's an edge in the rooms built for it, where that exact mix is the whole point.",
    honest_line: "Some rooms won't see why it matters, and that's alright. I won't send you those.",
    close_line: "So from here on, I'm looking for the roles where your combination is the point.",
  },
};
// A hand-picked shortlist for someone with NO grounded profile. The third item deliberately has no
// `catch`, so the snapshot proves an unhedged role is DROPPED rather than rendered.
export const ROLE_PICKS = {
  email: "a@b.com",
  name: "Maya",
  intro: "you wrote to me about technical writing, so here are two that are open right now.",
  items: [
    { role: "Technical Writer", company: "Brightfold", location: "Chennai, India", note: "Developer docs for a payments API.", catch: "it reads a level below senior.", applyUrl: "https://example.com/apply-a" },
    { role: "Senior Documentation Lead", company: "Orbitra Labs", location: "Bengaluru, India", note: "Satellite telemetry tooling, senior scope.", catch: "hardware-heavy, not SaaS.", applyUrl: "https://example.com/apply-b" },
    { role: "Unhedged Role That Must Not Render", company: "Nowhere", location: "Nowhere", applyUrl: "https://example.com/apply-c" },
  ],
};
export const PREFS_UPDATED = { email: "a@b.com", changedText: "your target to senior product design and your city to Boston" };
export const ACK = { email: "a@b.com" };
export const FIRST_ROLE_CLOSEST = {
  email: "a@b.com",
  name: "Maya",
  role: { title: "Senior Product Designer", company: "Figma", location: "San Francisco, CA", apply_url: "https://example.com/apply3" },
  gapAsk: "are you open to hybrid in SF?",
  label: "Closest to your profile",
  findId: "a@b.com:job3",
};
// The friend-drip (bring-a-friend share loop). A/B is on the shareable note ONLY; the letter is
// identical across variants. shareUrl is a fixed signed-link placeholder so the snapshot is stable.

// ── interrogation onboarding (renderInterroTurn) ────────────────────────────
export const INTERRO_FIRST = { email: "a@b.com", name: "Maya", first: true, strength: "the Lumen design system", question: "is staff the level you're aiming for, or is lead where you want to go?" };
export const INTERRO_TURN = { email: "a@b.com", name: "Maya", first: false, changedText: "your target to staff product design", strength: "the Lumen design system", question: "remote, a city, or either?" };

// ── VIP pair (render-invite.mjs / render-confirmation.mjs) ───────────────────
export const CONFIRMATION = { unsubUrl: "https://test.charlie.local/unsub" };

// ── renderHeldRoles (email-kit.mjs) ─────────────────────────────────────────
// Exercises all three item shapes the template distinguishes: an open role with nothing in its way,
// a role held on a stated PREFERENCE (theirs to change), and a role held on missing DEPTH (ours to
// fix, by asking). Deterministic; no dates or scores.
export const HELD_ROLES = {
  email: "a@b.com",
  name: "Maya",
  lookedFor: "you are a lead product manager, so I aimed at product roles in and around your city and anything genuinely remote.",
  items: [
    { role: "Product Manager", company: "PhonePe", location: "Bengaluru, Karnataka", note: "600 million users, 40 million merchants.", open: true, applyUrl: "https://example.test/phonepe" },
    { role: "Principal Product Manager, Firefly", company: "Adobe", location: "Noida, India", note: "Generative AI surfaces, image and video. The most senior of the four.", held: "you told me you want remote, and this one is in Noida. If you would consider it, say so and I will stop filtering those out.", applyUrl: "https://example.test/adobe" },
    { role: "Product Manager, Marketplace", company: "Supabase", location: "Remote", note: "Open source Postgres platform, 7 million developers.", held: "it asks for platform and marketplace depth I cannot see in your profile yet.", applyUrl: "https://example.test/supabase" },
  ],
};

// A named role and the two things the pool never recorded about anybody: would you work onsite in
// Bangalore, and does the budget work.
export const STUDIO_ASK = { email: "a@b.com", name: "Maya Rao" };

// They answered. Acknowledge it and promise nothing about a process that does not exist yet.
export const ASK_ANSWER_ACK = { email: "a@b.com", name: "Maya Rao" };

// Charlie replied to somebody with the wrong conversation and owes them a correction. Every sentence
// is passed in by a hand-run script; a correction is never model-generated.
export const ASK_CORRECTION = {
  email: "a@b.com",
  name: "Maya Rao",
  wrong: "The reply you got from me earlier was wrong. It answered a different conversation and asked you what kind of role you are after, which is the one thing you had just told me. That was a fault on my side, and it is fixed now.",
  answer: "Your two answers are exactly what I needed: onsite in Kolkata works, and the budget works. I have both, and I will not ask you again.",
  next: "What happens next, honestly. I am taking the shape of your background to the hiring side, without your name on it, and I will come back to you with what I hear. I cannot give you a timeline, because I do not have one yet. When I know, you will.",
  either: "That includes coming back to tell you it went nowhere, if that is the answer. I would rather say that than leave you waiting.",
  promise: "Nothing with your name on it moves until you tell me it can.",
};

// The single nudge to the people who never answered the studio ask. There is no second one.
export const STUDIO_REMINDER = { email: "a@b.com", name: "Maya Rao" };

// The role-forward note. Their profile goes to the hiring managers and NOTHING is asked of
// them: no apply link, no referral, no scorecard. The role facts are passed in by the hand-run
// script so the template can never state something the posting did not say.
export const ROLE_FORWARD = {
  email: "a@b.com",
  name: "Maya Rao",
  company: "Globex Logistics",
  roleTitle: "Platform Engineer",
  roleFacts: "The role: hybrid in Mysuru, three to five years, hands-on with Kubernetes, Go and monitoring for a fleet-tracking service. One opening, and they want to decide this month.",
};

// For people who left the years box blank. One question, because reading a number off somebody's
// resume and filtering on that reading is how they get rejected on our arithmetic rather than theirs.
export const YEARS_ASK = { email: "a@b.com", name: "Maya Rao", roleTitle: "Platform Engineer", band: "three to five years" };
// The applicant-pool represent ask. All three blanks, so the fixture locks the longest shape
// (portfolio missing on top of pay and notice).
export const REPRESENT_POOL_ASK = { email: "a@b.com", name: "Maya Rao", missing: ["portfolio", "pay", "notice"] };

// The evidence ask. A customer-success question, because that family is the clearest
// demonstration of why the ask is contextual: "a piece of work you are proud of" means nothing to
// somebody whose work is accounts and renewals and who has no artefact to attach.
export const EVIDENCE_ASK = {
  email: "a@b.com",
  name: "Maya Rao",
  evidence: "One account you grew, saved, or lost and learned from. Which account, what you did, and what it was worth.",
  alsoAsk: ["pay"],
};

// "It has actually happened". The follow-through on ROLE_FORWARD, which said the profile
// IS GOING to the hiring managers. The whole value of this one is the tense.
export const WITH_HIRING_TEAM = {
  email: "a@b.com",
  name: "Maya Rao",
  company: "Globex Logistics",
  roleTitle: "Platform Engineer",
};

// The permission ask. It asks whether Charlie may put somebody forward; it is NOT a
// representation notice, and the two must never be confused, so this fixture is the one that pins it.
export const REPRESENT_PERMISSION = {
  email: "a@b.com",
  name: "Maya Rao",
  roleTitle: "UI/UX Designer",
  where: "Kolkata",
  band: "two to four years",
  studio: "agency that designs apps for retail brands",
  because: "your answers walk through how you debugged a live incident step by step, which is the thing this brief actually asks for.",
};

// The yes, acknowledged. Sits between "may I?" and "it is in front of them", and says
// interest is moving rather than a profile. `answered` carries what they asked in their own reply.
export const YES_NOTED = {
  email: "a@b.com",
  name: "Maya Rao",
  roleTitle: "UI/UX Designer",
  where: "Kolkata",
  answered: "You asked for the job details. I do not have permission to name the company yet, and the moment I do you will have it along with everything else I know about the role.",
};

// "Has anyone been in touch?" Asked once, of people whose profile actually moved.
export const ANY_CALLS = { email: "a@b.com", name: "Maya Rao", company: "Lumora", roleTitle: "Senior Content Designer" };
// ANY_CALLS_STAGE adds the second question ("where has it got to?") for the client-board cohort. Two
// fixtures because askStage adds prose to BOTH halves of the template, and a paragraph added to the
// HTML alone would send copy nobody had reviewed.
export const ANY_CALLS_STAGE = { ...ANY_CALLS, askStage: true };

// The correction owed for a templated reply. It quotes the person, because the failure is a reply
// that could have been sent to anybody.
export const REPLY_CORRECTION = { email: "a@b.com", name: "Maya Rao", theirWords: "nobody has called me so far", company: "Lumora" };

// The correction owed to somebody who said yes and got a form letter twice.
export const YES_CORRECTION = { email: "a@b.com", name: "Maya Rao", theirWords: "ok sure lets go ahead with it", roleTitle: "UI/UX Designer", where: "Kolkata" };

// The client status update. THREE FIXTURES, because the template has three shapes and
// the differences between them are the parts that can go wrong.
//
// CLIENT_STATUS is the ordinary one: their application went to the client's hiring team.
// CLIENT_STATUS_REVIEWING adds one sentence, and that sentence is a claim about another company's
// behaviour ("someone is reading it"). It is only true when a human on the client side has marked
// that person, so it needs its own snapshot rather than being assumed to be a cosmetic variant.
// CLIENT_STATUS_NO_POINTER is the applicant who submitted no usable link. The pointer line must
// DISAPPEAR rather than render empty or invent something, and only a fixture pins that.
export const CLIENT_STATUS = {
  email: "a@b.com",
  name: "Maya Rao",
  company: "Acme AI",
  roleTitle: "AI Engineer",
  pointer: "weather-dashboard repo",
};

export const CLIENT_STATUS_REVIEWING = { ...CLIENT_STATUS, reviewing: true };

export const CLIENT_STATUS_NO_POINTER = { ...CLIENT_STATUS, pointer: "" };

// CLIENT_STATUS_REPLIED is the person who was asked one follow-up question and answered it. Their
// answer is on the page the client reads, so the mail says so. The date is pre-formatted by the
// caller, and the whole clause must DISAPPEAR when there is no reply rather than render a date-less
// sentence: the other three fixtures pin that, this one pins the sentence itself.
export const CLIENT_STATUS_REPLIED = { ...CLIENT_STATUS, pointer: "", repliedOn: "20 August" };

// The CV request. Two fixtures: the named case, and the one where we never captured a
// name. The second exists because a greeting that renders "Hi ." is the kind of thing that only
// shows up in front of a real person.
export const CV_REQUEST = { email: "a@b.com", name: "Maya Rao", company: "Acme AI", roleTitle: "AI Engineer", formUrl: "https://forms.example.com/r/abc123" };
export const CV_REQUEST_NO_NAME = { ...CV_REQUEST, name: "" };

// ── The inbound replies (render-reply.mjs) ──────────────────────────────────
// One fixture per situation: each situation gets its own reply.
// `quote` is the classifier's VERBATIM span from the person's own message, never a paraphrase, and
// only the two templates whose copy is built to show it ever receive one.
//
// The two quotes below are realistic: a consent grant, and a disputed rejection. Using real-shaped
// words keeps the snapshot honest about what this has to handle.
export const REPLY_CONSENT = { email: "a@b.com", name: "Maya Rao", quote: "please share my profile with Lumora" };
export const REPLY_DISPUTE = { email: "a@b.com", name: "Maya Rao", quote: "I have more than ten years in research roles, so I think my experience was misread" };
export const REPLY_STATUS = { email: "a@b.com", name: "Maya Rao" };
export const REPLY_ANSWER = { email: "a@b.com", name: "Maya Rao" };
export const REPLY_OFF_TOPIC = { email: "a@b.com", name: "Maya Rao" };
export const REPLY_UNSURE = { email: "a@b.com", name: "Maya Rao" };
// No name on file: the greeting has to disappear cleanly rather than render "Hi , ".
export const REPLY_NO_NAME = { email: "a@b.com", name: "" };

// The decision ask. Sent to a candidate whose application is SILENT on a must-have the
// client named. Three fixtures, because the differences are the parts that can go wrong: one gap, two
// gaps, and the person whose name we never captured.
export const DECISION_ASK = {
  email: "a@b.com",
  name: "Maya Rao",
  company: "Globex Grocer",
  roleTitle: "Data Analyst",
  missing: "a time you found a number was wrong before anyone used it, and what was causing it",
};
export const DECISION_ASK_TWO = { ...DECISION_ASK, alsoMissing: "a forecast you built that someone planned against, and how it compared with what happened" };
export const DECISION_ASK_NO_NAME = { ...DECISION_ASK, name: "" };

// Breaking the silence. One mail to the whole pool, two shapes. The numbers are measured
// at send time and passed in, so a fixture pins the SHAPE, never the claim.
export const BREAKING_SILENCE_ASK = {
  email: "a@b.com", name: "Maya Rao", ask: true,
  putForward: 75, mandates: 3, share: "18%",
};
export const BREAKING_SILENCE_NO_ASK = { ...BREAKING_SILENCE_ASK, ask: false };
export const BREAKING_SILENCE_NO_NAME = { ...BREAKING_SILENCE_ASK, name: "" };


// The ack for somebody who replied to a client-status mail. Three fixtures because
// `filed` is a claim about where their words physically went, and each value is a different claim:
// the board, their record only, or nothing at all (a reply too short to file). The last one must
// claim nothing rather than say "it is on your file" when it is not.
export const CLIENT_REPLY_ACK = { email: "a@b.com", name: "Maya Rao", filed: "board" };
export const CLIENT_REPLY_ACK_RECORD = { ...CLIENT_REPLY_ACK, filed: "record" };
export const CLIENT_REPLY_ACK_NONE = { ...CLIENT_REPLY_ACK, filed: "none" };

// The ack for somebody answering "has anyone been in touch?". Deliberately says nothing about
// WHICH way they answered: a reply here can be no, a first call, or an offer.
export const CHECKIN_NOTED = { email: "a@b.com", name: "Tomasz Oyelaran" };

/** The role offered to somebody already in the pool, answerable with one word. Invented person and role. */
export const ROLE_INVITE = {
  email: "tara@example.com",
  name: "Tara Kapoor",
  roleTitle: "Lead Service Designer",
  city: "Ahmedabad",
  years: "eight to ten years",
  whatItIs:
    "It is service design for a chain of neighbourhood clinics: how a patient books, waits, is seen " +
    "and pays, across the front desk, a kiosk and a phone app. The team is four designers and a " +
    "researcher, so you would run the fieldwork yourself rather than commission it.",
};

/** The same invitation with no name and no years band, which is the sparsest it can render. */
export const ROLE_INVITE_BARE = {
  email: "someone@example.com",
  roleTitle: "Lead Service Designer",
  city: "Ahmedabad",
  whatItIs: "It is service design for a chain of neighbourhood clinics, across the front desk, a kiosk and a phone app.",
};

/** What each of the three possible answers gets back. */
export const INVITE_ANSWER_YES = { email: "tara@example.com", name: "Tara Kapoor", answer: "yes" };
export const INVITE_ANSWER_NO = { email: "tara@example.com", name: "Tara Kapoor", answer: "no" };
export const INVITE_ANSWER_UNCLEAR = { email: "tara@example.com", name: "Tara Kapoor", answer: "unclear" };

/** One role put to one person, with the reason it was them. Invented person, invented employers. */
export const ROLE_INTENT = {
  email: "arjun@example.com",
  name: "Arjun Mehta",
  roleTitle: "Account Executive",
  city: "Bengaluru",
  whatItIs:
    "A seed-stage software company in Bengaluru is hiring an account executive. The job is the full " +
    "sales cycle: building outbound pipeline from scratch, running demos, and closing.",
  because: "you were the first sales hire at Northwind and ran the full sales cycle at Lakeside before that.",
  facts: ["On site, five days a week.", "They are asking for three to five years of selling B2B software."],
  bar: "deal size and targets",
  questionCount: "four",
  proof: "their own numbers",
};

/** The same mail with no name and no facts list, which is the sparsest it can render. */
export const ROLE_INTENT_BARE = {
  email: "someone@example.com",
  roleTitle: "Product Manager",
  city: "Pune",
  whatItIs: "A software company in Pune is hiring a product manager.",
  because: "you have owned a product from discovery to launch",
  bar: "the products you have shipped",
  questionCount: "three",
  proof: "their own work",
  source: "your own answers",
};

export const INTENT_ANSWER = { email: "arjun@example.com", name: "Arjun Mehta" };

/** The questions that follow a yes. Invented person; the questions are the shape of a sales brief. */
export const INTENT_QUESTIONS = {
  email: "arjun@example.com",
  name: "Arjun Mehta",
  roleTitle: "Account Executive",
  city: "Bengaluru",
  questions: [
    "How many years have you sold B2B software where closing the deal was yours?",
    "What is the largest deal you closed yourself, and roughly what was it worth a year?",
    "What was your last sales target, and where did you finish against it?",
  ],
};

/** One question and no name, which is the sparsest it can render. */
export const INTENT_QUESTIONS_BARE = {
  email: "someone@example.com",
  roleTitle: "Product Designer",
  city: "Pune",
  questions: ["Which products have you designed end to end, from discovery to launch?"],
};

export const QUESTIONS_ANSWER = { email: "arjun@example.com", name: "Arjun Mehta" };

/** Where this stands: holding what they gave us while the company is quiet. */
export const ROLE_HOLD = { email: "arjun@example.com", name: "Arjun Mehta" };
export const ROLE_HOLD_BARE = { email: "someone@example.com" };
export const HOLD_ANSWER = { email: "arjun@example.com", name: "Arjun Mehta" };

// ── The Qualify & Submit agent (email-kit.mjs renderQualify*) ─────────────────────────────────────
export const QUALIFY_VERIFY = {
  name: "Asha Rao", role: "Support Engineer, Billing", company: "Acme Robotics", city: "Jaipur", partner: "Pieworks",
  questions: [
    "May I put you forward to Acme Robotics for the Support Engineer, Billing role?",
    "What is your current pay a year, fixed and variable separately? For example: 12 lakh fixed, 2 lakh variable.",
    "What is your notice period, in days?",
    "Please attach your latest CV as a PDF.",
  ],
  unsubUrl: "https://api.example.com/unsubscribe?t=fixture",
};
export const QUALIFY_REMINDER = { name: "Asha Rao", role: "Support Engineer, Billing", company: "Acme Robotics", unsubUrl: "https://api.example.com/unsubscribe?t=fixture" };
export const QUALIFY_PUT_FORWARD = { name: "Asha Rao", role: "Support Engineer, Billing", company: "Acme Robotics", partner: "Pieworks", unsubUrl: "https://api.example.com/unsubscribe?t=fixture" };
export const QUALIFY_CLOSED = { name: "Asha Rao", role: "Support Engineer, Billing", company: "Acme Robotics", unsubUrl: "https://api.example.com/unsubscribe?t=fixture" };
export const QUALIFY_CONFIRM = {
  name: "Asha Rao", role: "Support Engineer, Billing", company: "Acme Robotics", city: "Jaipur", partner: "Pieworks",
  facts: ["Current pay: 4 lakh fixed, 0 lakh variable", "Expected pay: 5 lakh a year", "Notice period: 30 days", "Experience: 3 years", "Based in: Ajmer", "Phone: +91 9876543210", "LinkedIn: https://www.linkedin.com/in/asha-rao", "CV: Asha_Rao_CV.pdf"],
  unsubUrl: "https://api.example.com/unsubscribe?t=fixture",
};
export const QUALIFY_HANDOFF = {
  org: "Acme Talent", name: "Asha Rao", candidateEmail: "asha@x.com", role: "Support Engineer", company: "Acme Robotics", contact: "Meera Pillai",
  facts: ["Name: Asha Rao", "Email: asha@x.com", "CV: Asha_Rao_CV.pdf", "What I will say about you: Resolved billing tickets at Acme."],
  unsubUrl: "https://api.example.com/unsubscribe?t=fixture",
};

// Pieworks 2call activation (lib/pieworks-activation.mjs). Invented person, role and numbers.
export const PIEWORKS_ASK = {
  name: "Ravi Menon", role: "Support Engineer-Billing L2", company: "Acme Robotics", city: "Jaipur", referred: true,
  pay: "5 to 8 lakh a year (CTC)", years: "1 to 3 years (you have 2)", line: "Resolve customer tickets for the billing product.",
  unsubUrl: "https://api.example.com/unsubscribe?t=fixture",
};
export const PIEWORKS_STATS = {
  week: { emailed: 31, interested: 11 },
  all: { emailed: 188, interested: 64, declined: 41, waiting: 17, closed: 63, pending: 3 },
  unsubUrl: "https://api.example.com/unsubscribe?t=fixture",
};

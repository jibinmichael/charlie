// lib/mandates.mjs — one entry per client mandate: the form it came from, the criteria its score is
// computed from, the client's written must-haves, and the facts recorded but never scored.
//
// The mandates below are EXAMPLES with fictional clients and placeholder Notion database / Tally form
// ids. Replace them with your own. Changing a weight or a criterion changes every score on that board,
// so treat this file the way a rubric is treated: edited deliberately, reviewed in a PR, never adjusted
// to make a particular candidate look better.
//
// THE SPLIT THAT MATTERS. `criteria` are scored. `facts` are recorded verbatim from what the person
// wrote and are NEVER scored: years, employer, college, notice, compensation. Recording pedigree as a
// filterable fact gives the client their filter without letting a university move a score. Blank
// means they did not say, never that they fail.
//
// THE GATE. `eligibility` is the client's must-haves as THEY worded them, checked in code by
// lib/eligibility.mjs. It is not scored and it deletes nobody: it produces a verdict per person so the
// board can say "40 applied, 7 meet the stated must-haves". An additive score alone lets a candidate
// fail a hard must-have and still finish near the top. A criterion our form cannot answer is declared
// `cannotAnswer` rather than approximated, because a column that looks like a filter and cannot answer
// the question is worse than no column at all.

/**
 * tier: must-have | good-to-have | how-they-work.  weight: multiplies the 0-3 level.
 *
 * `looks_like` is written FOR THE REVIEWER and carries judgement language ("rather than that they were
 * near it"). `ask` is the same criterion written for the CANDIDATE, because that sentence gets read
 * back to the person it describes and reviewer prose lands as a slight. Every must-have has one; a
 * criterion with no `ask` can never be put in an email.
 */
import { oneOf, namesAnyOf, atLeast, cannotAnswer } from "./eligibility.mjs";

export const MANDATES = {
  northwind: {
    key: "northwind",
    client: "Northwind Payroll",
    role: "Customer Success Manager",
    board: "Northwind Payroll — Customer Success Manager",
    databaseId: "00000000-0000-0000-0000-000000000001",
    formId: "FORM01",
    location: "Pune",
    summary:
      "Example mandate: customer success for a payroll and leave-management SaaS sold to mid-sized " +
      "employers, Pune. Owns a book of accounts from go-live to renewal and keeps payday uneventful.",
    criteria: [
      { key: "go_live_ownership", label: "Took accounts live", tier: "must-have", weight: 2,
        looks_like: "Personally ran a customer from signed contract to first successful use, and can name the step that nearly slipped and what they did about it.",
        ask: "a customer you took from signed contract to going live, and the step that nearly slipped" },
      { key: "renewal_ownership", label: "Owned renewals", tier: "must-have", weight: 2,
        looks_like: "Held the renewal for their accounts themselves, with a retention figure or a renewal they saved, rather than handing the commercial conversation to a sales colleague.",
        ask: "a renewal you were responsible for, and what you did in the months before it came due" },
      { key: "churn_diagnosis", label: "Spotting churn early", tier: "must-have", weight: 2,
        looks_like: "Noticed an account drifting before it said so, from usage, tickets or tone, and describes the signal they saw and the intervention they chose.",
        ask: "an account you saw drifting before they told you, what you noticed, and what you did next" },
      { key: "explaining_rules", label: "Explaining rules plainly", tier: "must-have", weight: 2,
        looks_like: "Explained a statutory, tax or policy rule to a customer who was not a specialist, so the customer could act on it without a follow-up call.",
        ask: "a rule or regulation you explained to a customer, and how you made it usable for them" },
      { key: "escalations", label: "Handling escalations", tier: "must-have", weight: 1,
        looks_like: "Took an angry escalation, coordinated the internal fix and closed the loop with the customer, with the timeline stated.",
        ask: "an escalation you handled, who you pulled in internally, and how you closed it with the customer" },
      { key: "health_scoring", label: "Account health tracking", tier: "good-to-have", weight: 1,
        looks_like: "Keeps a working view of account health and can say which inputs they trust and which they ignore." },
      { key: "expansion", label: "Expansion", tier: "good-to-have", weight: 1,
        looks_like: "Grew an existing account by finding a second team or module that needed the product." },
      { key: "depth", label: "Depth and specificity", tier: "how-they-work", weight: 1,
        looks_like: "Names accounts by type, numbers and dates. Describes what happened rather than describing customer success in the abstract." },
    ],
    // Example must-haves, written the way a client brief might word them.
    eligibility: [
      { key: "owns_renewals", fact: "renewal_owner", column: "Who owns renewals",
        criterion: "Owns the renewal conversation for their own accounts today",
        test: oneOf({ passes: ["i own", "i do", "myself", "i am responsible", "i handle"],
                      fails: ["shared", "sales team", "account executive", "someone else", "not my", "another team"] }) },
      { key: "live_portfolio", fact: "accounts_managed", column: "Accounts managed",
        criterion: "Manages a live book of customer accounts in their current role",
        test: atLeast(1) },
      { key: "uses_cs_platform", fact: "cs_tools", column: "Customer success tools",
        criterion: "Works day to day in a customer success or support platform",
        test: namesAnyOf(["gainsight", "totango", "churnzero", "vitally", "planhat", "zendesk", "freshdesk", "intercom", "hubspot", "salesforce"]) },
      { key: "degree_completed", fact: "degree", column: "Degree",
        criterion: "Completed graduate degree in commerce, finance, business or a related field",
        test: oneOf({ blocks: ["dropped out", "did not complete", "incomplete", "discontinued"],
                      passes: ["commerce", "b.com", "bcom", "finance", "accounting", "business", "bba", "mba", "economics"],
                      fails: ["none", "no degree", "diploma", "12th", "higher secondary"] }) },
    ],
    facts: [
      { key: "years_cs", label: "Years in customer success", column: "Years in customer success", number: true, question: "Total years in a customer success or account management role", pedigree: true },
      { key: "degree", label: "Degree", column: "Degree", question: "What is your degree in?", pedigree: true },
      { key: "renewal_owner", label: "Who owns renewals", column: "Who owns renewals", question: "In your current role, who owns the renewal conversation for your accounts?" },
      { key: "accounts_managed", label: "Accounts managed", column: "Accounts managed", question: "How many customer accounts do you look after right now?" },
      { key: "cs_tools", label: "Customer success tools", column: "Customer success tools", question: "Which customer success or support tools do you work in every week?" },
    ],
  },

  globex: {
    key: "globex",
    client: "Globex Grocer",
    role: "Data Analyst",
    board: "Globex Grocer — Data Analyst",
    databaseId: "00000000-0000-0000-0000-000000000002",
    formId: "FORM02",
    location: "Hyderabad",
    summary:
      "Example mandate: data analyst for a grocery-delivery app, Hyderabad. Answers operations and " +
      "marketing questions from order, rider and inventory data, and makes sure people trust the answer.",
    criteria: [
      { key: "metric_definition", label: "Defining the metric", tier: "must-have", weight: 2,
        looks_like: "Wrote down what a metric meant before computing it, settled a disagreement about a definition, and can say what changed once the definition was fixed.",
        ask: "a metric you had to define before you could measure it, and what the definition settled" },
      { key: "sql_fluency", label: "SQL on messy tables", tier: "must-have", weight: 2,
        looks_like: "Wrote non-trivial SQL against real production tables, with a join or window function they can describe and a trap in the data they had to work around.",
        ask: "a query you wrote against messy real data, and a trap in that data you had to work around" },
      { key: "data_quality", label: "Catching bad data", tier: "must-have", weight: 2,
        looks_like: "Found that a number was wrong before anyone acted on it, and traced it to its cause: a duplicate event, a timezone, a broken pipeline.",
        ask: "a time you found a number was wrong before anyone used it, and what was causing it" },
      { key: "question_framing", label: "Turning a vague ask into an analysis", tier: "must-have", weight: 2,
        looks_like: "Took a loose business question, narrowed it to something answerable, and reports what the answer changed for the person who asked.",
        ask: "a loose question someone brought you, how you narrowed it down, and what your answer changed" },
      { key: "dashboard_use", label: "Dashboards people actually use", tier: "must-have", weight: 1,
        looks_like: "Built a recurring report or dashboard that a team relied on, and knows how they know it was used.",
        ask: "a dashboard or regular report you built that a team relied on, and how you knew they used it" },
      { key: "forecasting", label: "Forecasting demand", tier: "must-have", weight: 1,
        looks_like: "Produced a forecast that someone planned against, and compared it with what actually happened afterwards.",
        ask: "a forecast you built that someone planned against, and how it compared with what happened" },
      { key: "ops_data", label: "Operations data", tier: "good-to-have", weight: 1,
        looks_like: "Worked with operational data such as deliveries, stock levels, staffing or routing." },
      { key: "storytelling", label: "Presenting findings", tier: "good-to-have", weight: 1,
        looks_like: "Presented a finding to a non-technical audience and changed a decision with it." },
      { key: "depth", label: "Depth and specificity", tier: "how-they-work", weight: 1,
        looks_like: "Names tables, metrics, tools and outcomes rather than reciting analytics vocabulary." },
    ],
    facts: [
      { key: "years_analytics", label: "Years in analytics", column: "Years in analytics", number: true, question: "Total years working as an analyst", pedigree: true },
      { key: "sql_dialects", label: "Databases and warehouses used", column: "Databases and warehouses used", question: "Which databases or warehouses have you written SQL against?" },
    ],
  },

  initech: {
    key: "initech",
    client: "Initech Learning",
    role: "Frontend Engineer",
    board: "Initech Learning — Frontend Engineer",
    databaseId: "00000000-0000-0000-0000-000000000003",
    formId: "FORM03",
    location: "Chennai",
    summary:
      "Example mandate: frontend engineer for an online-learning product used by school students on " +
      "shared family phones, Chennai. Builds lesson and quiz screens that stay fast and usable.",
    criteria: [
      { key: "accessibility", label: "Accessible interfaces", tier: "must-have", weight: 2,
        looks_like: "Fixed a real accessibility problem, for example keyboard focus, screen-reader labels or contrast, and says how they tested the fix with an assistive tool.",
        ask: "an accessibility problem you fixed in a screen you built, and how you checked the fix worked" },
      { key: "performance", label: "Making pages fast", tier: "must-have", weight: 2,
        looks_like: "Measured a slow screen, found the cause, and reports the before and after numbers. A list of techniques without a measurement does not count.",
        ask: "a screen you made faster, how you measured it, and what the numbers were before and after" },
      { key: "component_design", label: "Reusable components", tier: "must-have", weight: 2,
        looks_like: "Designed a component other engineers reused, and can name the API decision they would change in hindsight.",
        ask: "a component you designed that other engineers reused, and one decision about it you would change now" },
      { key: "state_bugs", label: "Debugging UI state", tier: "must-have", weight: 2,
        looks_like: "Tracked down a bug caused by stale or shared state, and describes the reproduction they built to pin it down.",
        ask: "a bug caused by state in the interface, and how you reproduced it before fixing it" },
      { key: "testing", label: "Frontend testing", tier: "must-have", weight: 1,
        looks_like: "Wrote tests that caught a regression before release, at a level they chose on purpose.",
        ask: "a test you wrote that caught a real regression, and why you tested at that level" },
      { key: "constrained_devices", label: "Low-end devices and slow networks", tier: "must-have", weight: 1,
        looks_like: "Built for low-memory phones or unreliable connections and changed something concrete because of it.",
        ask: "something you changed in a product so it worked on slow phones or patchy connections" },
      { key: "design_partnership", label: "Working with designers", tier: "good-to-have", weight: 1,
        looks_like: "Pushed back on or improved a design with a designer, and the change shipped." },
      { key: "depth", label: "Depth and specificity", tier: "how-they-work", weight: 1,
        looks_like: "Names frameworks, browsers, numbers and outcomes rather than listing technologies." },
    ],
    // Example must-haves. Two of them the form cannot answer, and the gate says so rather than
    // approximating them.
    eligibility: [
      { key: "years_frontend", fact: null, column: null,
        criterion: "3+ years building production web frontends",
        test: cannotAnswer("We record total years of professional experience, a different denominator. " +
          "Four years of backend work and four years of frontend work answer it identically. To gate this " +
          "we must ask \"years spent building production web frontends\" as its own question.") },
      { key: "framework_shipped", fact: "frameworks", column: "Frameworks shipped in",
        criterion: "Has shipped a production app in a modern component framework",
        test: namesAnyOf(["react", "vue", "angular", "svelte", "solid", "preact", "next.js", "nextjs", "nuxt"]) },
      { key: "public_work", fact: "work_link", column: "Link to their work",
        criterion: "Shares a link to work we can look at: public code or a live product",
        test: oneOf({ passes: ["github", "gitlab", "codepen", "http", "www."], fails: ["none", "n/a", "private", "cannot share", "no link"] }) },
      { key: "take_home", fact: null, column: null,
        criterion: "Clears the client's own take-home exercise",
        test: cannotAnswer("The exercise is set and marked by the client and its rubric was not shared " +
          "with us. We can collect a submission link, but whether it clears the bar is the client's call, " +
          "and a bar we invent is a standard nobody agreed to.") },
    ],
    facts: [
      { key: "years_total", label: "Total years of experience", column: "Total years of experience", number: true, question: "Total years of professional experience", pedigree: true },
      { key: "frameworks", label: "Frameworks shipped in", column: "Frameworks shipped in", question: "Which frameworks have you shipped production code in?" },
      { key: "work_link", label: "Link to their work", column: "Link to their work", question: "Share a link to code or a live product you built" },
      { key: "browsers", label: "Browsers and devices tested on", column: "Browsers and devices tested on", question: "Which browsers and devices do you usually test on?" },
      { key: "studied", label: "Where they studied", column: "Where they studied", question: "Where did you study?", pedigree: true },
    ],
  },
};

/**
 * Live Tally forms that deliberately have no client board, and why. The sweep names any published
 * form it does not recognise so a new posting surfaces as a decision waiting rather than as silence —
 * but a warning that fires every single run is one nobody reads, which is the same failure as a
 * label that is true of everybody. Acknowledging a form here is the act of saying "seen, not a client
 * mandate". Deleting a line makes the sweep start asking about it again.
 */
export const FORMS_WITHOUT_MANDATE = {
  FORM90: "Product Manager (3-6 years) — Charlie's own pool, no client attached",
  FORM91: "Product Designer (3-6 years) — Charlie's own pool, no client attached",
};

/** The one consent that governs appearing on a client board. Anyone not answering Yes never gets a row. */
export const SHARE_CONSENT_QUESTION = "If shortlisted, may we share your Charlie profile with the employer?";

/**
 * Umbrella Assurance — Site Reliability Engineer (example of a CONFIDENTIAL mandate).
 *
 * Example: site reliability engineer for a general insurer's policy and claims platform, on-site in
 * Indore. The criteria weight incident handling and removing toil above tool breadth, because the
 * rare person is the one who can calm a live incident and then make sure it does not recur.
 *
 * `confidential` — the client is NOT named to candidates. We are hiring on their behalf and the
 * posting says so without saying who. Every candidate-facing sender must refuse rather than guess a
 * name, which is why this is a field and not a note in a doc.
 */
export const UMBRELLA = {
  key: "umbrella",
  client: "Umbrella Assurance",
  confidential: true,
  role: "Site Reliability Engineer",
  board: "Umbrella Assurance — Site Reliability Engineer",
  databaseId: "00000000-0000-0000-0000-000000000004",
  formId: "FORM04",
  location: "Indore",
  // VERBATIM FROM THE FORM. The derived default says "five days a week" and this form does not, so a
  // derived question would match nothing and the answer would reach the model as evidence. Declared
  // here, then checked against the live form by mandate-run, which refuses rather than scoring the
  // wrong thing.
  onsiteQuestion: "This role is based in our Indore office. Can you work from there?",
  summary:
    "Example mandate: reliability for the systems that issue policies and settle claims. On-call " +
    "rotation, observability and automation, on infrastructure that must stay up at month end.",
  criteria: [
    { key: "incident_command", label: "Running a live incident", tier: "must-have", weight: 2,
      looks_like: "Led or co-led a live incident and describes the first ten minutes: what they checked, what they ruled out, who they told. Somebody who only reports the root cause is usually describing the postmortem, not the incident.",
      ask: "a live incident you helped run, and what you did in the first ten minutes" },
    { key: "observability", label: "Making systems observable", tier: "must-have", weight: 2,
      looks_like: "Added a metric, log or trace that later shortened an investigation, and can say which question it answered.",
      ask: "a metric, log or trace you added, and an investigation it later made shorter" },
    { key: "toil_automation", label: "Automating toil away", tier: "must-have", weight: 2,
      looks_like: "Replaced a recurring manual task with code, with the time it used to take and what broke the first time the automation ran.",
      ask: "a manual task you automated, how long it used to take, and what went wrong on the first run" },
    { key: "postmortems", label: "Postmortems that changed something", tier: "must-have", weight: 2,
      looks_like: "Wrote or ran a blameless postmortem whose follow-up actually shipped. A postmortem with no completed action is a document, not a fix.",
      ask: "a postmortem you wrote or ran, and the follow-up from it that actually shipped" },
    { key: "linux_networking", label: "Linux and networking fundamentals", tier: "must-have", weight: 2,
      looks_like: "Debugged a problem at the operating-system or network layer, for example DNS, TLS, file descriptors or memory pressure, and names the command that showed them the cause.",
      ask: "a problem you debugged at the operating-system or network level, and what showed you the cause" },
    // DOMAIN EXPERIENCE is scored as an edge (weight 1), not a gate. Making it a must-have would reject
    // a stronger engineer in favour of a weaker one who once worked in the sector, which is a pedigree
    // filter wearing a domain costume. If a client says it is genuinely a gate, change the tier to
    // must-have and the weight to 2 and re-run: that is a deliberate act, recorded in a PR.
    { key: "domain_regulated", label: "Regulated-industry experience (example: insurance)", tier: "good-to-have", weight: 1,
      looks_like: "Has run infrastructure under audit or regulatory controls, in this example insurance or other financial services: change approvals, data retention, access reviews. Names the control and what they did to meet it.",
      ask: "any infrastructure work you have done under audit or regulatory controls, and what that changed" },
    { key: "on_call_health", label: "Sustainable on-call", tier: "good-to-have", weight: 1,
      looks_like: "Reduced pages or alert noise for a rotation and can say by roughly how much.",
      ask: "something you changed that made an on-call rotation quieter" },
    { key: "infra_as_code", label: "Infrastructure as code", tier: "good-to-have", weight: 1,
      looks_like: "Manages infrastructure through reviewed code rather than console changes. Useful, and its absence is not disqualifying." },
    { key: "depth", label: "Depth and specificity", tier: "how-they-work", weight: 1,
      looks_like: "Names systems, symptoms, tools and numbers. Describes what happened rather than describing reliability in the abstract." },
  ],
  facts: [
    { key: "years_ops", label: "Years in operations or SRE", column: "Years in operations or SRE", number: true, question: "Total years in an operations, SRE or platform role", pedigree: true },
    { key: "degree", label: "Degree", column: "Degree", question: "What is your degree in?", pedigree: true },
    { key: "clouds", label: "Clouds used", column: "Clouds used", question: "Which cloud providers or data centres have you run production on?" },
    { key: "monitoring", label: "Monitoring tools", column: "Monitoring tools", question: "Which monitoring and alerting tools have you used?" },
  ],
};

MANDATES.umbrella = UMBRELLA;

/**
 * Refuse to put a confidential client's name in front of a candidate.
 *
 * Some mandates are run on the client's behalf WITHOUT naming them: the posting says "a large insurer"
 * and never says who. The board still names them,
 * because the client reads the board. The candidate-facing mails must not, and the failure mode if
 * this is left to memory is unrecoverable: an email naming the client, in a stranger's inbox,
 * breaking a confidentiality the client asked for.
 *
 * So every sender that renders a company name calls this first and it THROWS. There is no fallback
 * string, deliberately: a sender that quietly substituted "the hiring team" would produce "your
 * application for the Site Reliability Engineer role at the hiring team" and send it. Refusing is the
 * only safe direction until the copy for an unnamed client is written and reviewed.
 */
export function assertNameable(m) {
  if (m?.confidential) {
    throw new Error(
      `${m.key}: this client is confidential and must not be named to candidates. ` +
      `The mail this sender renders says "at ${m.client}". Write the unnamed-client copy first.`,
    );
  }
  return m.client;
}

/**
 * Contact and compensation fields: transcribed to columns, never sent to the model.
 *
 * THE ON-SITE QUESTION IS NOT IN HERE, because it names a city and the city changes per mandate. A
 * question that matches nothing in this list falls through the filter in mandate-run and is handed to
 * the MODEL AS EVIDENCE, so an answer like "I would need to relocate" would be scored as though
 * it were an account of their work. Use `contactQuestions(mandate)` instead of this constant.
 */
export const CONTACT_QUESTIONS = [
  "Full name", "Email", "Phone number", "Current location, city", "LinkedIn URL",
  "Current company", "Current role or job title", "How soon could you join?",
];

/**
 * The on-site question for a mandate.
 *
 * PREFER THE DECLARED ONE. The fallback is the standard form wording and is a guess for any form
 * worded differently; a mismatch would hand the answer to the model as evidence. mandate-run checks
 * whichever string this returns against the live form and refuses if it is absent.
 */
export const onsiteQuestion = (m) =>
  m.onsiteQuestion || `This role is on-site in ${m.location}, five days a week. Are you able to work from there?`;

/** The board column that answer is written to. */
export const onsiteColumn = (m) => `On-site in ${m.location}`;

/** Every question whose answer is a contact or logistics fact for THIS mandate, never evidence. */
export const contactQuestions = (m) => [...CONTACT_QUESTIONS, onsiteQuestion(m)];

/**
 * Questions that must never reach the model, because the answer is pedigree and the rubric forbids
 * pedigree from moving a level. The prompt says so too, but a prompt is a request and this is a wall:
 * a fact the model cannot see cannot leak into a judgement. Compensation is excluded the same way.
 */
export const pedigreeQuestions = (m) => m.facts.filter((f) => f.pedigree).map((f) => f.question);
export const MONEY_RE = /CTC|compensation/i;

/**
 * The board columns compensation is written to. Applicants answer in a mix of lakhs and rupees, so
 * the column says "(as entered)". Named beside the mandates because the loader depends on the exact
 * column names, and a renamed column would otherwise fail silently.
 */
export const MONEY_COLUMNS = { current: "Current CTC (as entered)", expected: "Expected CTC (as entered)" };

export const maxScore = (m) => m.criteria.reduce((a, c) => a + c.weight * 3, 0);

/**
 * EVERY client board, including any that is not a MANDATES entry (a board with its own scorer and no
 * criteria block here). Anything that asks "which boards could this person be on?" reads THIS, so a
 * new board is added once.
 */
export const CLIENT_BOARDS = [
  // `client` and `role` are the words said TO the candidate ("your application for the Backend Engineer
  // role at Hooli"). Any follow-up must use the same two, or it names a different job at a different
  // company than the mail it is following up on.
  { key: "hooli", name: "Hooli — Backend Engineer", databaseId: "00000000-0000-0000-0000-000000000005",
    client: "Hooli", role: "Backend Engineer" },
  ...Object.values(MANDATES).map((m) => ({
    key: m.key, name: m.board, databaseId: m.databaseId,
    client: m.client, role: m.role, confidential: Boolean(m.confidential),
  })),
];

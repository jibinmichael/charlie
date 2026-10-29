// tally-applicants.test.mjs — reading applicants without inventing a consent answer.
//
// TWO SILENT FAILURE MODES:
//
//   1. THE JOIN. Tally does not key answers by question title. Each response carries a `questionId`
//      and the titles arrive in a separate array, and the value lives under `answer` (there is no
//      `value` field). Getting either wrong yields empty answers for everybody and throws nothing.
//
//   2. THE CONSTANT. A title constant that does not exactly match the form's question (e.g. truncated
//      at 120 characters) matches nothing, so everyone who ticked an opt-in box is silently recorded
//      as not having done so.
//
// So the titles below are verbatim form titles, and the test asserts our constants exist among them.
// A truncated or drifted constant fails here instead of printing a confident zero.

import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { answerText, answersByTitle, titleIndex, TallySubmissionsPage } from "./lib/schemas/tally.mjs";
import { classify, REQUIRED_TITLES, DESIRABLE_TITLES, CONSENT_TITLE, OPTIN_TITLE } from "./lib/tally.mjs";

// Verbatim question titles as GET /forms/<id>/submissions returns them. Do not tidy, shorten or re-wrap these.
const LIVE_TITLES = [
  "First Name",
  "Last Name",
  "Email Address",
  "Phone Number",
  "City",
  "Country",
  "LinkedIn Profile URL",
  "Portfolio URL",
  "Resume / CV",
  "Availability",
  "How would you describe the kind of engineer you are?",
  "What kind of team do you want to join next?",
  "What's a system you designed end to end?",
  "Tell us about an outage you handled.",
  "Anything else we should know?",
  "I agree that Charlie may process the information in this application to assess me for this role.",
  "Yes, Charlie may also send me roles from other companies it works with. (Optional - answering this has no bearing on how this application is assessed.)",
];

describe("the titles we match on exist on the real form", () => {
  for (const t of [...REQUIRED_TITLES, ...DESIRABLE_TITLES, CONSENT_TITLE, OPTIN_TITLE]) {
    it(`"${t.slice(0, 55)}${t.length > 55 ? "..." : ""}" is a real question`, () => {
      expect(LIVE_TITLES, "this constant matches no question, so anything computed from it is a false zero").toContain(t);
    });
  }

  it("the opt-in constant is the WHOLE title, parenthetical included", () => {
    // A 120-character truncation would cut it just after "has no bearing on how".
    expect(OPTIN_TITLE.length).toBeGreaterThan(120);
    expect(OPTIN_TITLE.endsWith(")")).toBe(true);
  });
});

describe("answerText — the shapes Tally actually returns", () => {
  it("reads a plain string", () => expect(answerText("Ada")).toBe("Ada"));
  it("reads a checkbox array of objects", () => expect(answerText([{ id: "a", text: "Yes" }])).toBe("Yes"));
  it("reads a file upload array", () => expect(answerText([{ name: "cv.pdf", url: "https://x" }])).toBe("cv.pdf"));
  it("treats missing and unreadable alike, because for us they mean the same thing", () => {
    expect(answerText(null)).toBe("");
    expect(answerText(undefined)).toBe("");
    expect(answerText([])).toBe("");
  });
});

describe("answersByTitle — the join that silently returns nothing when it is wrong", () => {
  const questions = [{ id: "q1", title: "First Name", type: "INPUT_TEXT" }, { id: "q2", title: "Portfolio URL", type: "INPUT_LINK" }];
  const submission = { id: "s1", isCompleted: true, responses: [{ questionId: "q1", answer: "Ada" }, { questionId: "q2", answer: "https://ada.design" }] };

  it("joins on questionId and reads `answer`", () => {
    const out = answersByTitle(submission, titleIndex(questions));
    expect(out["First Name"]).toBe("Ada");
    expect(out["Portfolio URL"]).toBe("https://ada.design");
  });

  it("would have caught the original bug: reading `value` instead of `answer` yields nothing", () => {
    const wrong = { ...submission, responses: submission.responses.map((r) => ({ questionId: r.questionId, value: r.answer })) };
    const out = answersByTitle(wrong, titleIndex(questions));
    expect(out["First Name"]).toBe(""); // empty, not absent, and NOT an exception. That is the danger.
  });

  it("ignores an answer to a question since deleted from the form", () => {
    const out = answersByTitle({ ...submission, responses: [{ questionId: "gone", answer: "x" }] }, titleIndex(questions));
    expect(Object.keys(out)).toHaveLength(0);
  });
});

describe("classify — consent first, then whether a story can be built", () => {
  const full = {
    "First Name": "Ada", "Last Name": "Lovelace", "Email Address": "ADA@Example.com ",
    "How would you describe the kind of engineer you are?": "I like owning the boring parts of a backend: queues, retries, and the dashboards nobody else reads.",
    "What kind of team do you want to join next?": "A small platform team where on-call is shared and postmortems actually change the roadmap.",
    "What's a system you designed end to end?": "Designed a ledger service that replaced nightly batch reconciliation with an event stream, cutting mismatches to near zero.",
    "Tell us about an outage you handled.": "A cache stampede took checkout down for twenty minutes; I added request coalescing and a load test that now runs on every release.",
    [CONSENT_TITLE]: "I agree",
  };
  const p = (answers) => classify({ answers });

  it("no consent box means we do not screen them and do not write to them", () => {
    const { [CONSENT_TITLE]: _drop, ...noBox } = full;
    expect(p(noBox).status).toBe("no_consent");
  });

  it("consent plus every answer is complete", () => {
    expect(p(full).status).toBe("complete");
    expect(p(full).missing).toEqual([]);
  });

  it("a missing essay makes it partial, and names the exact question to quote back", () => {
    const { "What kind of team do you want to join next?": _gone, ...rest } = full;
    const c = p(rest);
    expect(c.status).toBe("partial");
    expect(c.missing).toEqual(["What kind of team do you want to join next?"]);
  });

  it("a token answer to an essay is a skipped question wearing an answer's clothes", () => {
    for (const token of ["n/a", "-", "NA", "same as above"]) {
      const c = p({ ...full, "What's a system you designed end to end?": token });
      expect(c.status, `"${token}" was accepted as an answer`).toBe("partial");
      expect(c.missing).toContain("What's a system you designed end to end?");
    }
  });

  it("but a name only has to be non-empty — the 40-character bar is for essays only", () => {
    expect(p({ ...full, "First Name": "Jo" }).status).toBe("complete");
  });

  it("opt-in is independent of status: it decides what we may send, never whether we read them", () => {
    expect(p(full).optedIn).toBe(false);
    expect(p({ ...full, [OPTIN_TITLE]: "Yes" }).optedIn).toBe(true);
    const { "What kind of team do you want to join next?": _g, ...partial } = full;
    expect(p({ ...partial, [OPTIN_TITLE]: "Yes" })).toMatchObject({ status: "partial", optedIn: true });
  });

  it("normalises the address, because it is the key everything downstream joins on", () => {
    expect(p(full).email).toBe("ada@example.com");
  });
});

describe("the page schema refuses a broken payload rather than reporting an empty form", () => {
  it("accepts a real page", () => {
    expect(TallySubmissionsPage.safeParse({ hasMore: false, questions: [{ id: "q1", title: "First Name" }], submissions: [{ id: "s1", responses: [] }] }).success).toBe(true);
  });
  it("rejects a submission with no id", () => {
    expect(TallySubmissionsPage.safeParse({ submissions: [{ responses: [] }] }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// THE CONSENT DETECTORS, against every wording the forms use.
//
// A permission question asked in words the detector does not know records people who said yes as
// people who said no, and nothing throws. The titles below are verbatim form titles. Do not tidy,
// shorten or re-wrap them. A new wording nobody added fails here, loudly, instead of storing a
// refusal nobody made.
// ---------------------------------------------------------------------------------------------
import { POOL_Q, SHARE_Q, affirmative } from "./lib/consent-questions.mjs";

describe("consent detectors — every live wording, and nothing else", () => {
  const POOL_WORDINGS = [
    ["most forms", "Would you like to join the Charlie talent pool?"],
    ["form A", "Yes, Charlie may also send me roles from other companies it works with. (Optional - answering this has no bearing on how this application is assessed.)"],
    ["form B", "Even if this role isn't the one, would you like to be part of Charlie's talent network?"],
    ["form C", "Would you like Charlie to consider you for other relevant roles in the future based on your profile and experience?"],
  ];
  const SHARE_WORDINGS = [
    ["8 forms", "If shortlisted, may we share your Charlie profile with the employer?"],
    ["form C", "I consent to being contacted by the Acme HR / hiring team regarding this application and the recruitment process."],
  ];

  for (const [form, title] of POOL_WORDINGS) {
    it(`pool consent is detected on ${form}`, () => {
      expect(POOL_Q.test(title), "this wording reads as a refusal, silently, for everyone on that form").toBe(true);
    });
  }
  for (const [form, title] of SHARE_WORDINGS) {
    it(`share consent is detected on ${form}`, () => {
      expect(SHARE_Q.test(title), "this wording reads as a refusal, silently, for everyone on that form").toBe(true);
    });
  }

  // A narrower pattern misses the form C wording. Running it here proves the wider one is needed:
  // this assertion fails if anyone reintroduces the narrower version.
  it("the narrower pattern misses the form C wording, which is why the wider one is needed", () => {
    const PRE_FIX = /talent (pool|network|community)|partner network|roles from other companies|send me (relevant |other )?roles|be part of .*(network|pool)/i;
    const formC = POOL_WORDINGS.at(-1)[1];
    expect(PRE_FIX.test(formC)).toBe(false); // the narrow pattern misses it
    expect(POOL_Q.test(formC)).toBe(true);   // the shipped one does not
  });

  // NOT EVERY FORM ASKS. People on a form with no pool question are correctly stored as
  // not-contactable, and widening the pattern must never invent a consent out of an ordinary question.
  it("does not match ordinary questions that merely mention roles or contact", () => {
    for (const t of [
      "What is your current / most recent job title?",
      "Why do you want to work on a small infrastructure team?",
      "This role is designed primarily for candidates with 0-2 years of experience.",
      "Phone number",
      "Are you able to work on-site in our Leeds office two days a week?",
    ]) {
      expect(POOL_Q.test(t), `"${t}" was read as consent to be written to`).toBe(false);
      expect(SHARE_Q.test(t), `"${t}" was read as consent to be shared with an employer`).toBe(false);
    }
  });

  // The two scripts must not drift apart: they import the same export, and this asserts it.
  it("pool-applicants and backfill-consent share one definition", async () => {
    const [applicants, backfill] = await Promise.all([
      readFile(new URL("./scripts/pool-applicants.mjs", import.meta.url), "utf8"),
      readFile(new URL("./scripts/backfill-consent.mjs", import.meta.url), "utf8"),
    ]);
    for (const [name, src] of [["pool-applicants", applicants], ["backfill-consent", backfill]]) {
      expect(src, `${name} defines its own copy of the consent regex again`).toContain('from "../lib/consent-questions.mjs"');
      expect(src.includes("talent (pool|network|community)"), `${name} inlined the pattern instead of importing it`).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// DID THEY AGREE? Every distinct answer wording the forms return, verbatim.
//
// Finding the question is only half of it. A checkbox consent comes back as its own label, "I
// consent", which `/^yes\b/` would score as a refusal.
// ---------------------------------------------------------------------------------------------
describe("affirmative — the words people actually agree in", () => {
  const AGREED = [
    "Yes", "Yes, please.",
    "Yes — send me relevant opportunities as they arise",
    "Yes — send me relevant opportunities as they arrive",
    "Yes — keep me in consideration for relevant roles",
    "Yes — you may share my profile if shortlisted",
    "I consent",
  ];
  const REFUSED = [
    "No", "No — only contact me about this search", "No — contact me first",
    "No — only consider me for this Acme role",
  ];

  for (const v of AGREED) it(`"${v.slice(0, 46)}" is agreement`, () => expect(affirmative(v)).toBe(true));
  for (const v of REFUSED) it(`"${v.slice(0, 46)}" is refusal`, () => expect(affirmative(v)).toBe(false));

  it("a bare /^yes/ test would score 'I consent' as a refusal, which is why affirmative is wider", () => {
    const PRE_FIX = (v) => /^yes\b/i.test(String(v || "").trim());
    expect(PRE_FIX("I consent")).toBe(false); // the narrow test misreads it
    expect(affirmative("I consent")).toBe(true); // affirmative does not
  });

  it("a negation is never agreement, however it is phrased", () => {
    for (const v of ["I do not consent", "I don't agree", "I do not agree", "", null, undefined, "Not yes"]) {
      expect(affirmative(v), `"${v}" was read as agreement`).toBe(false);
    }
  });

  it("neither script keeps its own copy of the test", async () => {
    for (const f of ["./scripts/pool-applicants.mjs", "./scripts/backfill-consent.mjs"]) {
      const src = await readFile(new URL(f, import.meta.url), "utf8");
      expect(src, `${f} inlined the yes() pattern again`).not.toMatch(/\/\^yes\\b\/i/);
    }
  });
});

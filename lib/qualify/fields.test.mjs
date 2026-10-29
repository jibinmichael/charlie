// lib/qualify/fields.test.mjs — reading a person's details and answers, never inventing one. Pure.
import { describe, it, expect } from "vitest";
import { readYesNo, parseLakh, parseCurrentPay, parseExpectedPay, parseNoticeDays, parsePhone, parseLinkedIn, parseYears, fieldsFromRecord, questionsFor, readAnswers, mergeFields, missingFields } from "./fields.mjs";
import { fill, copyProblem, verifyCopy } from "./copy.mjs";
import { checkJustification, justificationItems, writeJustification } from "./justification.mjs";
import { looksLikeCv } from "./cv-file.mjs";

describe("reading answers", () => {
  it.each([["18 LPA", 18], ["18 lakhs", 18], ["1800000", 18], ["1.2 Cr", 120], ["1,50,000 a month", 18], ["12", 12], ["500", null], ["open to discussion", null]])("pay %s -> %s lakh", (x, n) => expect(parseLakh(x)).toBe(n));
  it.each([
    ["12 lakh fixed, 2 lakh variable", { fixed: 12, variable: 2 }],
    ["Fixed 14 LPA and variable 1.5 LPA", { fixed: 14, variable: 1.5 }],
    ["15 LPA fixed only", { fixed: 15, variable: 0 }],
    ["no variable, 9 LPA", { fixed: 9, variable: 0 }],
    ["10 LPA fixed", { fixed: 10, variable: null }],
    ["15 LPA", { fixed: null, variable: null }],
  ])("current pay %s", (x, out) => expect(parseCurrentPay(x)).toEqual(out));
  it("expected pay takes the top of a range; notice, phone, LinkedIn and years read only when certain", () => {
    expect(parseExpectedPay("18 to 20 LPA")).toBe(20);
    expect(parseNoticeDays("2 months")).toBe(60);
    expect(parseNoticeDays("immediately")).toBe(0);
    expect(parseNoticeDays("depends")).toBeNull();
    expect(parsePhone("+91-98765 43210")).toEqual({ countryCode: "+91", phoneNo: "9876543210" });
    expect(parsePhone("9876543210")).toBeNull();
    expect(parseLinkedIn("my profile linkedin.com/in/asha-rao/")).toBe("https://www.linkedin.com/in/asha-rao");
    expect(parseYears("about 6.5 years")).toBe(6.5);
  });
});

describe("what we already know, and what we ask", () => {
  const pool = { email: "a@x.com", full_name: "Asha Rao", total_years: 3, linkedin_url: "linkedin.com/in/asha-rao", current_company: "Acme", city: "Ajmer", phone: "+91 98765 43210", comp_expected: 500000, notice_days: 30, comp_current: 400000 };
  it("takes fields from the record with their source, never current pay (it is one total, not fixed and variable)", () => {
    const f = fieldsFromRecord(pool, {});
    expect(f.expectedCtc).toEqual({ value: 5, source: "pool" });
    expect(f.noticePeriod).toEqual({ value: "30", source: "pool" });
    expect(f.currentCtcFixed).toBeUndefined();
    expect(fieldsFromRecord({ ...pool, comp_expected: 200 }, {}).expectedCtc).toBeUndefined();
  });
  it("asks consent first, then only what is missing, the city, up to three must-haves, and the CV", () => {
    const q = questionsFor({ fields: fieldsFromRecord(pool, {}), role: "Support Engineer", company: "Northwind Labs", city: "Pune", personCity: "Ajmer", openMustHaves: [{ ref: "c2", label: "Zendesk." }, { ref: "c3", label: "a" }, { ref: "c4", label: "b" }, { ref: "c5", label: "c" }] });
    expect(q.map((x) => x.id)).toEqual(["consent", "currentPay", "workFrom", "must:c2", "must:c3", "must:c4", "cv"]);
    expect(q[0].text).toBe("May I put you forward to Northwind Labs for the Support Engineer role?");
    expect(q[3].text).toBe("Have you done this: Zendesk? If yes, where, and what did you do?");
  });
  it("reads answers into fields, consent and the city answer; the total is derived only from both parts", () => {
    const r = readAnswers({ consent: "Yes please", currentPay: "4 lakh fixed, no variable", workFrom: "No", phone: "+44 7700 900123" });
    expect(r.consent).toBe("yes");
    expect(r.workFrom).toBe("no");
    const m = mergeFields(fieldsFromRecord(pool, {}), r.fields);
    expect(m.currentCtcTotal).toEqual({ value: 4, source: "derived" });
    expect(m.countryCode.value).toBe("+44");
    expect(missingFields(m)).toEqual([]);
    expect(missingFields(fieldsFromRecord(pool, {}))).toEqual(["currentCtcFixed", "currentCtcVariable", "currentCtcTotal"]);
  });
});

describe("a connection's own copy", () => {
  it("fills known fields and refuses unknown ones, dashes, banned words and promises (the default goes out instead)", () => {
    expect(fill("Hi {name}, {company} is hiring", { name: "Asha", company: "Northwind Labs" }).text).toBe("Hi Asha, Northwind Labs is hiring");
    expect(copyProblem("We think your record fits this role well enough")).toMatch(/record/);
    expect(copyProblem("You are a great fit — apply now please")).toMatch(/dash/);
    expect(copyProblem("This role is guaranteed to be yours, honestly")).toMatch(/promises/);
    const c = verifyCopy({ verify: { intro: "Hi {name}, {company} hires for {role} via {partner}.", closing: "Your {salary} is safe with us here." } }, { name: "Asha", company: "Northwind Labs", role: "QA", partner: "Pieworks" });
    expect(c.intro).toBe("Hi Asha, Northwind Labs hires for QA via Pieworks.");
    expect(c.closing).toBeNull();
    expect(c.issues[0]).toMatch(/unknown field \{salary\}/);
  });
});

describe("the justification", () => {
  const items = [{ requirement: "Billing support", quotes: [{ id: "e1", quote: "Resolved billing tickets for 2 releases and wrote macros in Zendesk at Acme" }] }];
  const GOOD = "Asha resolved billing tickets for 2 releases at Acme and wrote the macros she used in Zendesk, which covers the ticket handling and the helpdesk tool the role lists.";
  it("passes plain, cited text; refuses praise, pay talk, numbers not in the record, and uncited text", () => {
    expect(checkJustification(GOOD, ["e1"], items)).toEqual({ ok: true });
    expect(checkJustification(GOOD.replace("resolved", "expertly resolved"), ["e1"], items).reason).toMatch(/judges|expert/);
    expect(checkJustification(`${GOOD} Her notice is short.`, ["e1"], items).reason).toMatch(/notice/);
    expect(checkJustification(GOOD.replace("2 releases", "5 releases"), ["e1"], items).reason).toMatch(/number 5/);
    expect(checkJustification(GOOD, [], items).reason).toMatch(/cites no quote/);
  });
  it("quotes only their own words, under the role's must-haves; a score is never evidence; no quotes, no items", () => {
    const spec = { role: "Support Engineer", criteria: [{ ref: "c1", kind: "must_have", label: "Billing support" }, { ref: "c2", kind: "must_have", label: "Zendesk" }, { ref: "c3", kind: "preferred", label: "x" }] };
    const ev = { score: 91, pass: true, reasons: ["Pieworks AI score 91"] };
    expect(justificationItems(spec, ev, [{ id: "answer:must:c1", quote: "  I resolved   billing tickets " }, { id: "cv:1", quote: "" }])).toEqual([{ requirement: "What the Support Engineer role needs: Billing support; Zendesk", quotes: [{ id: "answer:must:c1", quote: "I resolved billing tickets" }] }]);
    expect(justificationItems(spec, ev, [])).toEqual([]);
  });
  it("refuses when the verifier finds an invented claim or cannot answer", async () => {
    const client = { messages: { create: async () => ({ content: [{ type: "text", text: JSON.stringify({ justification: GOOD, evidence_ids: ["e1"] }) }] }) } };
    expect((await writeJustification({ client, verify: async () => ({ ok: true, severity: "none" }), roleTitle: "Support", firstName: "Asha", items })).ok).toBe(true);
    expect((await writeJustification({ client, verify: async () => ({ ok: false, severity: "high", violations: ["2 releases"] }), roleTitle: "Support", firstName: "Asha", items })).reason).toMatch(/refused/);
    expect((await writeJustification({ client, verify: async () => ({ ok: false, errored: true }), roleTitle: "Support", firstName: "Asha", items })).reason).toMatch(/could not answer/);
  });
});


describe("ambiguous pay stays missing", () => {
  it.each([["I expect a 30% hike", null], ["currently 10, expecting 14 LPA", null], ["50000", null], ["12k", null], ["18 lakh to 20 lakh", 20], ["12k a month", 1.44], ["1500000", 15]])("expected %s -> %s", (x, n) => expect(parseExpectedPay(x)).toBe(n));
  it.each([
    ["12 lakh fixed + 10% variable", { fixed: 12, variable: null }],
    ["fixed 1,00,000 per month, variable 2 lakh", { fixed: 12, variable: 2 }],
  ])("current %s", (x, out) => expect(parseCurrentPay(x)).toEqual(out));
  it("serving notice is not immediate; a must-have with a word Charlie never shows is not asked", () => {
    expect(parseNoticeDays("serving notice, last day 15 Nov")).toBeNull();
    const q = questionsFor({ fields: {}, role: "QA", company: "Northwind Labs", openMustHaves: [{ ref: "c1", label: "Background screening clearance" }, { ref: "c2", label: "Zendesk" }] });
    expect(q.map((x) => x.id)).toContain("must:c2");
    expect(q.map((x) => x.id)).not.toContain("must:c1");
  });
});


describe("label-first pay phrasing", () => {
  it.each([["Fixed 12L Variable 1.5L", { fixed: 12, variable: 1.5 }], ["12L fixed 1.5L variable", { fixed: 12, variable: 1.5 }]])("%s", (x, out) => expect(parseCurrentPay(x)).toEqual(out));
});


describe("only a CV becomes the CV", () => {
  const CV = "Asha Rao. Work experience: Support engineer at Acme, 2021 to now. Education: B.Tech. Skills: Zendesk, SQL.";
  it.each([
    ["Asha_CV.pdf", "anything", true],
    ["resume-asha.pdf", CV, true],
    ["document.pdf", CV, true],
    ["ACVL_payslip.pdf", "Net pay 50,000. Deductions.", false],
    ["Offer_Letter.pdf", "Dear Asha, we are pleased to offer you employment. Educational qualifications required.", false],
    ["letter.pdf", "To whomsoever it may concern. This is to certify employment with Acme. Skills shown.", false],
    ["review.pdf", "Performance review. Experience with Android, skills rating for the year.", false],
    ["notes.pdf", "Some notes about a meeting", false],
  ])("%s -> %s", (name, text, want) => expect(looksLikeCv(name, text)).toBe(want));
});


describe("answers and CV files", () => {
  // city answers are read as the city question (kind "city"): "can't / won't" anywhere is a no there
  it.each([
    ["No problem, I can work from there.", "yes"], ["No issues, I can relocate", "yes"], ["No, I can't relocate", "no"],
    ["I cannot relocate", "no"], ["Yes, but only if hybrid", "unclear"], ["No thanks.", "no"], ["Not anymore, sorry.", "no"],
    ["No problem, go ahead", "yes"], ["Only remote please", "unclear"],
  ])("%s -> %s", async (x, want) => { const { readYesNo } = await import("./fields.mjs"); expect(readYesNo(x, "city")).toBe(want); });
  it.each([
    ["scan.pdf", "APPOINTMENT LETTER\nTo, Ms Asha Rao\nYour educational qualifications and experience will be verified.", false],
    ["letter.pdf", "RELIEVING LETTER. This is to confirm she was relieved from duties. Skills, experience.", false],
    ["receipt.pdf", "PAYMENT RECEIPT. Professional Certification fee. Experience, skills.", false],
    ["Asha_CV.pdf", "Asha Rao. HR business partner. Managed annual appraisal cycles. Net pay and gross earnings audits. Experience. Education.", true],
    ["Asha Rao.pdf", "Career History: Acme 2019. Core Competencies: payroll.", true],
    ["Asha_CV.pdf", "Dear Hiring Manager, I am applying for the role.", true],   // their own cover letter on page 1: still their document
    ["offer.pdf", "Dear Ms Asha, we are pleased to offer you the role.", false],     // a letter addressed TO them is not
  ])("CV check %s", (n, t, want) => expect(looksLikeCv(n, t)).toBe(want));
});


describe("strict about yes", () => {
  // a false YES submits without consent (never acceptable); a false NO closes a willing person; unclear asks again
  it.each([
    ["Absolutely not", "no"], ["Definitely not", "no"], ["Ok, don't", "unclear"], ["Ok will check", "unclear"], ["Ok, let me think", "unclear"],
    ["Okay, I will get back to you", "unclear"], ["Sure, let me discuss with family", "unclear"], ["Ok noted", "unclear"],
    ["No objection", "yes"], ["No objections", "yes"], ["Yes, if the CTC is 20 LPA", "unclear"], ["Happy to, if hybrid", "unclear"],
    ["Yes, though only remote", "unclear"], ["Ok", "yes"], ["No issue", "yes"], ["Yes yes", "yes"], ["Not a problem", "yes"],
    ["Please proceed", "yes"], ["Haan", "yes"], ["Never", "no"], ["I decline", "no"], ["Do not put me forward", "no"],
    ["Withdraw my application", "no"], ["Okay not interested", "no"], ["Yes please, CV attached", "yes"],
    ["Yes, go ahead. Please don't share my phone with recruiters", "unclear"], ["Sure, but I'm serving notice", "unclear"],
  ])("consent %s -> %s", (x, want) => expect(readYesNo(x, "consent")).toBe(want));
  it.each([["Definitely not", "no"], ["Absolutely not", "no"], ["Happy to, if hybrid", "unclear"], ["No objection", "yes"], ["Can't do onsite 5 days", "no"]])("city %s -> %s", (x, want) => expect(readYesNo(x, "city")).toBe(want));
  it.each([
    ["letter.pdf", "Dear Asha Rao, your salary is revised. Experience, skills.", false],
    ["doc.pdf", "Dear Candidate. Work experience and education verified.", false],
    ["doc2.pdf", "Dear Employee welcome. Experience. Skills.", false],
    ["inc.pdf", "Increment letter. Experience and skills reviewed.", false],
    ["Review.pdf", "Annual Review FY24. Experience. Skills.", false],
    ["Asha_CV.pdf", "Salary statement. Net pay 80,000. Deductions 5,000.", false],
    ["Asha_CV.pdf", "Dear Hiring Manager, my CV follows. Experience. Education.", true],
  ])("CV check %s", (n, t, want) => expect(looksLikeCv(n, t)).toBe(want));
});


describe("the final YES, greetings, the city, and real CVs", () => {
  it.each([
    ["YES", true], ["Yes.", true], ["yes!", true], ["Yes, please go ahead.", true], ["Hi,\n\nYes, please go ahead.\n\nThanks,\nAsha", true],
    ["Hi Charlie,\nYes\n\nRegards, Asha Rao\nSent from my iPhone", true], ["Yes thanks", true], ["Confirmed", true], ["Haan ji", true],
    ["Okay. I've accepted another offer.", false], ["Ok, stop", false], ["Ok.\n\nUnfortunately I have accepted another offer.\n\nRegards,\nAsha", false],
    ["Yes, I'll let you know", false], ["Ok", false], ["Sure", false], ["Yes, but my expected is 6 lakh", false], ["Yes after March", false],
    ["Thanks", false], ["", false], ["No", false], ["Yes\nActually wait", false],
  ])("readConfirmYes %j -> %s", async (x, want) => { const { readConfirmYes } = await import("./fields.mjs"); expect(readConfirmYes(x, "Asha Rao")).toBe(want); });

  it("a greeting before the answer is not the answer; after an agreement, a can't is not a refusal of the city", () => {
    expect(readYesNo("Hi,\n\nYes, please go ahead.\n\nThanks,\nAsha", "consent")).toBe("yes");
    expect(readYesNo("Hi Charlie,\nYes, go ahead", "consent")).toBe("yes");
    expect(readYesNo("Hi, no thanks", "consent")).toBe("no");
    expect(readYesNo("Yes, can't wait", "city")).not.toBe("no");
    expect(readYesNo("I cannot relocate", "city")).toBe("no");
  });

  it.each([
    ["Asha_CV.pdf", "Dear Mr Sharma, please find my CV. Experience. Education.", true],
    ["Priya_Resume.pdf", "Dear Priya, Work experience: payroll lead. Net pay reconciliation and statutory deductions. Education.", true],
    ["Ravi_CV.pdf", "HR operations. Ran the annual review, salary revision, offer letter and employee verification process.", true],
    ["Meena CV.pdf", "Engineering manager. Led the performance review for 2023 across 40 people. Skills.", true],
    ["Asha_CV.pdf", "Payslip for September. Net pay 80,000.", false],
    ["letter.pdf", "Dear Asha Rao, your salary is revised. Experience, skills.", false],
  ])("CV check %s", (n, t, want) => expect(looksLikeCv(n, t)).toBe(want));
});


describe("no character is invisible to the final YES; signatures and plain yeses", () => {
  const WHO = { name: "Rahul Sharma", company: "Acme Corp", phone: "9876543210", email: "rahul@x.com" };
  it.each([
    ["Yes, लेकिन अभी नहीं", false], ["Yes\nअभी मत भेजिए", false], ["Yes 👎", false], ["Yes\n25", false], ["YES\n+91 98765 00000", false],
    ["Yes?", false], ["Yes...?", false], ["Yes\nSent from my iPhone\nActually wait, I accepted another offer this morning", false],
    ["Yes\nSent via my phone. Don't send yet.", false], ["Yes\nRegards\nRahul\nStop", false], ["Yes\n\nRegards, but please wait", false],
    ["Yes\nRahul Sharma no", false], ["Hiya", false],
    ["Yes Charlie", true], ["Yes, that is correct", true], ["Yes, everything is correct", true], ["Yes, all details are correct.", true],
    ["Yes it's correct", true], ["Correct", true], ["Yes, looks good", true], ["Yes sure", true], ["Ok yes", true], ["Yep", true],
    ["Confirm", true], ["Yes please send", true], ["Yes, thank you Charlie", true], ["YES\n\nThanks & Regards\nRahul Sharma", true],
    // a company line is never a signature (a company is free text, "Wait Watchers")
    ["Yes go ahead\nWarm regards,\nRahul Sharma\nAcme Corp", false], ["Yes go ahead\nWarm regards,\nRahul Sharma", true], ["Yes\nRegards,\nRahul Sharma | +91 98765 43210 | rahul@x.com", true],
    // a "-- " block is set aside only when every line after it is something we hold about them
    ["Yes\n-- \nRahul Sharma\nQA Lead, Acme", false], ["Yes\n-- \nRahul Sharma\nAcme Corp | rahul@x.com", false], ["Yes\n-- \nRahul Sharma | rahul@x.com", true], ["Yes\nSent from my iPhone", true],
  ])("readConfirmYes %j -> %s", async (x, want) => { const { readConfirmYes } = await import("./fields.mjs"); expect(readConfirmYes(x, WHO)).toBe(want); });
  it("a greeting needs a word boundary", () => {
    expect(readYesNo("Hiya", "consent")).not.toBe("yes");
    expect(readYesNo("Highly interested", "consent")).toBe("unclear");
  });
});


describe("nothing hides in boilerplate", () => {
  const WHO = { name: "Asha Rao", company: "Acme", phone: "9876543210", email: "p1@x.com" };
  it.each([
    "Yes\nSent from my iPhone actually no", "Yes\nSent from my phone - I am not interested anymore", "Yes\nSent from Yahoo Mail on Android no wait",
    "Yes\nSent from my iPhone sorry not yet", "Yes\nGet Outlook for iOS hmm not sure", "Yes\n--\nNo, not yet. Let me talk to my family first",
    "Yes\n--\nPS my notice is actually 90 days", "Yes\n-- \nI'm not interested anymore, sorry",
  ])("%j is not a plain YES", async (x) => { const { readConfirmYes } = await import("./fields.mjs"); expect(readConfirmYes(x, WHO)).toBe(false); });
  it("a refusal word is never a signature word, even in their name or company", async () => {
    const { readConfirmYes } = await import("./fields.mjs");
    expect(readConfirmYes("Yes\nThanks\nnot currently", { name: "Asha Rao", company: "currently not working" })).toBe(false);
    expect(readConfirmYes("Yes\nRegards,\nWait", { name: "Asha Rao", company: "Wait Watchers" })).toBe(false);
    expect(readConfirmYes("Yes\nRegards\nNo Way", { name: "No Way" })).toBe(false);
    expect(readConfirmYes("Yes\nSent from Yahoo Mail on Android", WHO)).toBe(true);
    expect(readConfirmYes("Yes\nGet Outlook for iOS", WHO)).toBe(true);
  });
});


describe("punctuation never hides a refusal; real phone clients can say YES", () => {
  const WHO = { name: "Asha Rao", company: "Wait Watchers", phone: "9876543210", email: "p1@x.com" };
  const IPHONE = "Yes\n\n> On 6 Oct 2026, at 10:00, Charlie <charlie@mail.example.com> wrote:\n>\n> Hi Asha.\n> Here is exactly what I will send";
  const OUTLOOK = "Yes\n\nGet Outlook for iOS<https://aka.ms/o0ukef>\n________________________________\nFrom: Charlie <charlie@mail.example.com>\nSent: Monday, October 6, 2026 10:00 AM\nSubject: Reply YES to be put forward to Northwind Labs\n\nHi Asha.";
  it.each([
    ["Yes\nRegards,\nWait!", false], ["Yes\nRegards,\nWait?", false], ["Yes\n--\nWait!", false], ["Yes\nThanks\nAcme", false],
    [IPHONE, true], [OUTLOOK, true], ["Yes\n\nSent from my Redmi Note 8 Pro", true], ["Yes\nSent from Gmail Mobile", true],
    ["Yes\nSent from Proton Mail mobile", true], ["Yes, please submit", true], ["Yes\nSent from my iPhone actually", false],
    ["Yes\n> no wait\nRegards", true], ["Hmm\n\n> On 6 Oct, Charlie <charlie@mail.example.com> wrote:\n> Yes", false],
  ])("%j -> %s", async (x, want) => { const { readConfirmYes } = await import("./fields.mjs"); expect(readConfirmYes(x, WHO)).toBe(want); });
  it("a refusal word in their name, with punctuation or a curly apostrophe, is still not a signature", async () => {
    const { readConfirmYes } = await import("./fields.mjs");
    expect(readConfirmYes("Yes\nRegards\nNo!", { name: "No Way" })).toBe(false);
    expect(readConfirmYes("Yes\nRegards\nDon’t", { name: "Dont Panic" })).toBe(false);
    expect(readConfirmYes("Yes\nRegards\nAsha!", { name: "Asha Rao" })).toBe(true);
  });
});


describe("Gmail's wrapped header; a line typed inside our quoted email", () => {
  const WHO = { name: "Asha Rao", phone: "9876543210", email: "p1@x.com" };
  it.each([
    ["Yes\n\nOn Mon, 6 Oct 2026 at 10:00, Charlie <charlie@mail.example.com>\nwrote:\n\n> Hi Asha.\n> Notice period: 30 days", true],
    ["Yes\n\nOn Mon, 6 Oct 2026 at 10:00, Charlie <\ncharlie@mail.example.com> wrote:\n\n> Hi Asha.", true],
    ["Yes\n\nOn Mon, 6 Oct 2026 at 10:00, Charlie <charlie@mail.example.com> wrote:\n> Notice period: 30 days\nIt's 60 days now\n> Expected pay: 5 lakh", false],
    ["Yes\n\nOn Mon, 6 Oct 2026, Charlie <charlie@mail.example.com>\nwrote:\n> Notice period: 30 days\nactually 90", false],
  ])("%j -> %s", async (x, want) => { const { readConfirmYes } = await import("./fields.mjs"); expect(readConfirmYes(x, WHO)).toBe(want); });
});


describe("a line of theirs starting with 'On' is never our header", () => {
  const WHO = { name: "Asha Rao", phone: "9876543210", email: "p1@x.com" };
  const Q = "On Mon, 6 Oct 2026 at 10:00, Charlie <apply+k@mail.example.com> wrote:\n> Hi Asha.";
  it.each([
    [`Yes\nOn notice period: it is 90 days now, not 30.\n\n${Q}`, false], [`Yes\nOn second thought, hold off.\n${Q}`, false],
    [`Yes\nOn hold please\nOn Mon, 6 Oct 2026 at 10:00, Charlie <apply+k@mail.example.com>\nwrote:\n> Hi`, false],
    [`On my notice period: it is 90 days, not 30.\n\n${Q}`, false], [`Yes\n\n${Q}`, true],
  ])("%j -> %s", async (x, want) => { const { readConfirmYes, confirmCore } = await import("./fields.mjs"); expect(readConfirmYes(x, WHO)).toBe(want); if (!want) expect(confirmCore(x, WHO)).not.toBe(""); });
});


describe("only our header's own lines are skipped", () => {
  const WHO = { name: "Asha Rao", phone: "9876543210", email: "p1@x.com" };
  const H1 = "On Mon, 6 Oct 2026 at 10:00, Charlie <apply+k@mail.example.com> wrote:";
  it.each([
    [`Yes\n\n${H1}\n> Notice period: 30 days\nIt is 60 days not 30 as you wrote\n> Expected pay: 5 lakh`, false],
    [`Yes\n\n${H1}\n> Notice period: 30 days\nIt is 60 days, not what you wrote:`, false],
    [`Yes\n\n${H1}\n> Hi Asha\n\nnotice is 90, not as you wrote`, false],
    ["Yes\n\nOn Mon, 6 Oct 2026 at 10:00 AM\nCharlie\n<apply+k@mail.example.com> wrote:\n> Hi Asha", true],
    [`Yes\n\n${H1}\n> Hi Asha`, true],
  ])("%j -> %s", async (x, want) => { const { readConfirmYes } = await import("./fields.mjs"); expect(readConfirmYes(x, WHO)).toBe(want); });
});


describe("the default wording the settings boxes start with", () => {
  it("passes every copy rule and fills from the custom fields", async () => {
    const { DEFAULT_VERIFY_COPY } = await import("./copy.mjs");
    const c = verifyCopy({ verify: DEFAULT_VERIFY_COPY }, { name: "Asha", company: "Northwind Labs", role: "Support Engineer", city: "Pune", partner: "Pieworks" });
    expect(c.issues).toEqual([]);
    expect(c.intro).toBe("Northwind Labs is hiring for the Support Engineer role in Pune, and I can put you forward through Pieworks. I think you could fit it, and before your name goes anywhere I want to check a few things with you.");
    expect(c.closing).toMatch(/^Nothing about you goes to Northwind Labs unless you say yes/);
  });
});

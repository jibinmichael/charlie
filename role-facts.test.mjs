// role-facts.test.mjs — two facts the posting states (its own pay band and employment type).
//
// Only a small share of roles state a real pay figure, and far more of them are India-reachable than
// US-reachable, so the posting's own pay must be shown where it exists rather than relying on the
// BLS-anchored US-only chip (`computePay`).
//
// The input strings below are realistic posting values, because the whole risk of this feature is a
// formatter meeting a shape nobody anticipated and printing nonsense about money.
import { describe, it, expect } from "vitest";
import { payLine, employmentKind } from "./lib/role-facts.mjs";

describe("pay renders only when the posting really stated one", () => {
  it("formats real INR strings from the pool in the units people speak", () => {
    expect(payLine("1200000-1600000 INR").text).toBe("₹12 lakh to ₹16 lakh");
    expect(payLine("1100000-1400000 INR").text).toBe("₹11 lakh to ₹14 lakh");
    expect(payLine("6500000-9500000 INR").text).toBe("₹65 lakh to ₹95 lakh");
    // Crore, because "150 lakh" is not how anyone says it. This band is 1.76x, comfortably inside the
    // width guard, so it keeps both ends and switches unit mid-range exactly as a person would.
    expect(payLine("8500000-15000000 INR").text).toBe("₹85 lakh to ₹1.5 crore");
    expect(payLine("15000000-15000000 INR").text).toBe("₹1.5 crore");
  });

  it("formats real USD strings, including hourly rates", () => {
    expect(payLine("115000-184000 USD").text).toBe("$115k to $184k");
    expect(payLine("300000-300000 USD").text).toBe("$300k");
    // THE TRAP: an hourly rate. Naive thousands-rounding turns "20-21 USD" into "$0k to $0k".
    expect(payLine("20-21 USD").text).toBe("$20 to $21");
  });

  it("a band wider than 2.5x collapses to 'From X'", () => {
    // Research on posting practice finds a very wide band suppresses applications, measurably more
    // for women. It also carries no information — it is a legal hedge printed as a fact. "From ₹5
    // lakh" is both more honest and less discouraging than a range that means nothing.
    expect(payLine("500000-5000000 INR").text).toBe("From ₹5 lakh");
    expect(payLine("50000-300000 USD").text).toBe("From $50k");
  });

  it("says NOTHING when the posting only gestured at pay", () => {
    for (const v of ["Competitive", "Best in industry", "As per market standards", "Negotiable", "Not disclosed", "DOE", "", null, undefined, "   "]) {
      expect(payLine(v), String(v)).toBeNull();
    }
  });

  it("NEVER guesses a currency", () => {
    // An unlabelled number could be rupees, dollars, or a headcount. Printing the wrong currency on
    // someone's salary is the worst single mistake this email could make.
    expect(payLine("1200000-1600000")).toBeNull();
    expect(payLine("18-24")).toBeNull();
  });

  it("survives junk without throwing", () => {
    for (const v of [{}, [], 42, "₹₹₹", "USD", "lakh"]) {
      expect(() => payLine(v)).not.toThrow();
    }
  });
});

describe("the work arrangement is printed only when it is NOT the default", () => {
  it("full-time says nothing, in every spelling the sources use", () => {
    // 19,000 of the 21,733 roles stating a type say full-time. It is the assumption, so printing it
    // is noise on nine roles in ten.
    for (const v of ["FullTime", "Full time", "Full-time", "full_time", "Full Time", "Full-Time", "Full-time Employment", "fulltime_permanent"]) {
      expect(employmentKind(v), v).toBeNull();
    }
  });

  it("a departure IS information", () => {
    // These are dealbreakers a person should never discover on the application form.
    expect(employmentKind("Contract")).toBe("Contract");
    expect(employmentKind("contract_to_hire")).toBe("Contract");
    expect(employmentKind("PartTime")).toBe("Part-time");
    expect(employmentKind("part_time")).toBe("Part-time");
    expect(employmentKind("Intern")).toBe("Internship");
    expect(employmentKind("Temporary")).toBe("Temporary");
  });

  it("an unknown shape says nothing rather than echoing the database at someone", () => {
    for (const v of ["", null, undefined, "W2", "exempt", "grade_7", 42, {}]) {
      expect(employmentKind(v), String(v)).toBeNull();
    }
  });
});

describe("in the email", () => {
  const base = {
    fields: { role_title: "Backend Engineer", company: "Acme", job_summary: "They want someone to own the payments service.", why_you: "you shipped a checkout redesign" },
    cov: { thin: true },
    jobDescription: "x".repeat(1400),
    email: "u@x.com",
    findId: "u@x.com:job-1",
    postedAt: new Date(Date.now() - 2 * 86400000).toISOString(),
  };

  it("shows stated pay to an INDIA role — the case the US-only gate silenced", async () => {
    const { renderEmail } = await import("./render-email.mjs");
    const html = renderEmail({ ...base, region: "india", rawCompensation: "1200000-1600000 INR" });
    expect(html).toContain("₹12 lakh to ₹16 lakh");
  });

  it("renders nothing at all when the posting stated nothing", async () => {
    const { renderEmail } = await import("./render-email.mjs");
    const html = renderEmail({ ...base, region: "india", rawCompensation: "Competitive", employmentType: "FullTime" });
    expect(html).not.toContain("Competitive");
    expect(html).not.toMatch(/Full[\s-]?time/i);
  });

  it("shows Contract, and does not show Full-time", async () => {
    const { renderEmail } = await import("./render-email.mjs");
    expect(renderEmail({ ...base, region: "india", employmentType: "Contract" })).toContain("Contract");
    expect(renderEmail({ ...base, region: "india", employmentType: "FullTime" })).not.toMatch(/>Full[\s-]?time</i);
  });

  it("never prints TWO pay figures — the BLS chip wins when it rendered", async () => {
    const { renderEmail } = await import("./render-email.mjs");
    // computePay's US chip and the posting's own string are different numbers from different sources.
    // Showing both would put two salaries in one line, arguing with each other.
    const html = renderEmail({ ...base, region: "us", pay: { lo: 120000, hi: 150000 }, rawCompensation: "300000-300000 USD" });
    expect(html).not.toContain("$300k");
  });
});

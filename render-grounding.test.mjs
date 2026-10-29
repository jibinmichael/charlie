// render-grounding.test.mjs — a fact the CODE writes gets the same gate as a fact a MODEL writes.
//
// `citeOrDrop` (grounding-enforce.mjs) guards every claim the composer writes about a person. The
// claims `render-email.mjs` writes about the ROLE need the same discipline:
//
//   1. locationLine must never default an unstated work mode to "On-site". Most postings state no
//      mode at all, and a remote role read as On-site is a role the candidate does not apply for.
//
//   2. relativeTime must never clamp a future/unparseable timestamp to "just now": the renderer stamps
//      a VERIFIED check badge next to whatever it returns.
//
// Never invent a fact. Silence is not a claim.

import { describe, it, expect } from "vitest";
import { locationLine, relativeTime, renderEmail } from "./render-email.mjs";

// Every one of these is a real-world location string shape from the job pool.
const STATES_NO_MODE = [
  "Paris, France",
  "San Francisco",
  "Japan",
  "Hawthorne, CA",
  "NYC Office",
  "Cambridge, Massachusetts",
  "London",
  "Singapore",
  "Dunnville, ON, CAN, Canada",
  "Bengaluru, India",
  "New York, NY",
  "Multiple locations",
  "Not specified",
];

describe("locationLine never states a work mode the posting did not", () => {
  for (const raw of STATES_NO_MODE) {
    it(`"${raw}" gets no mode appended`, () => {
      const out = locationLine(raw);
      expect(out).not.toMatch(/On-site|Remote|Hybrid/);
    });
  }

  it("renders the place verbatim when no mode is stated", () => {
    expect(locationLine("Paris, France")).toBe("Paris, France");
    expect(locationLine("London")).toBe("London");
  });

  it("is empty for an empty location, never a bare mode", () => {
    expect(locationLine("")).toBe("");
    expect(locationLine(null)).toBe("");
    expect(locationLine("   ")).toBe("");
  });
});

describe("locationLine still reports a mode the posting DOES state", () => {
  const CASES = [
    ["Remote - US", "US · Remote"],
    ["Fully remote", "Remote"],
    ["Remote (India)", "Remote"],
    ["Remote-first", "Remote"],
    ["San Francisco, CA (Remote OK)", "San Francisco, CA · Remote"],
    // mode vocabulary that a naive regex misses and reads as On-site
    ["Anywhere", "Remote"],
    ["Work from home", "Remote"],
    ["WFH", "Remote"],
    ["Distributed", "Remote"],
    ["Virtual", "Remote"],
    ["Telecommute", "Remote"],
    ["Home-based", "Remote"],
    // real pool string shapes
    ["Anywhere in the World", "Remote"],              // 59 rows
    ["World Wide - Remote", "Remote"],                // 38 rows
    ["Santa Clara, CA or Remote", "Santa Clara, CA · Remote"], // 34 rows
    ["Worldwide", "Remote"],                          // 8 rows
    ["Remote - Anywhere", "Remote"],                  // 4 rows
    ["Anywhere in the United States", "United States · Remote"], // 3 rows
    ["Remote (Global)", "Remote"],                    // 2 rows
    // explicitly stated on-site is a real claim and survives
    ["Austin, TX (On-site)", "Austin, TX · On-site"],
  ];
  for (const [raw, want] of CASES) {
    it(`"${raw}" -> "${want}"`, () => expect(locationLine(raw)).toBe(want));
  }

  it("keeps both when the posting offers both, rather than narrowing to one", () => {
    // Collapsing to "Hybrid" would delete an option the employer actually offered.
    expect(locationLine("Remote or Hybrid in Miami, FL")).toMatch(/Remote or Hybrid/);
  });

  it('drops a dangling conjunction left behind by stripping the mode word', () => {
    expect(locationLine("Bangalore or Remote")).toBe("Bangalore · Remote");
  });

  it('never mistakes a real place containing "world" or "OR" for a mode word', () => {
    // "OR" here is Oregon; "World" here is a building or a business park.
    expect(locationLine("3 World Trade Center, NY, United States of America")).toBe("3 World Trade Center, NY, United States of America");
    expect(locationLine("Bangalore RMZ-ECO WORLD, India")).toBe("Bangalore RMZ-ECO WORLD, India");
    expect(locationLine("4026 - Warrenton OR II, United States of America")).toBe("4026 - Warrenton OR II, United States of America");
    expect(locationLine("San Francisco or Palo Alto")).toBe("San Francisco or Palo Alto");
  });

  it('treats the scanner\'s "(remote not stated)" hedge as silence, not as a claim', () => {
    expect(locationLine("Pune, India (remote not stated)")).toBe("Pune, India");
  });
});

describe("relativeTime never invents a posting time", () => {
  it("is empty for an unparseable date", () => {
    expect(relativeTime("")).toBe("");
    expect(relativeTime(null)).toBe("");
    expect(relativeTime("not a date")).toBe("");
  });

  it("is empty for a FUTURE date instead of reading 'just now'", () => {
    const future = new Date(Date.now() + 6 * 3600_000).toISOString();
    expect(relativeTime(future)).toBe("");
  });

  it("still reports a real past date", () => {
    const twoDays = new Date(Date.now() - 2 * 86400_000).toISOString();
    expect(relativeTime(twoDays)).toBe("2 days ago");
  });
});

// ── the job-fact hole: the header location must come from the POSTING, not the model ─────────────
// A composer sentence like "Bengaluru (onsite; remote not stated)" can assert a mode the job record
// (location "Bengaluru", remote null) never states. composer.md forbids it, but citeOrDrop covers
// claims about the PERSON, not the JOB. locationLine is faithful to its input, so what matters is
// WHICH STRING is handed to it. These pin that the posting wins.
describe("renderEmail — the location is read from the posting, never from the model's sentence", () => {
  const base = {
    fields: { role_title: "Senior Product Manager", company: "Razorpay", job_summary: "Payments.", facts: [] },
    applyUrl: "https://x/1", unsubUrl: "https://x/u", email: "d@example.com", findId: "d@example.com:x",
  };
  const render = (extra) => renderEmail({ ...base, ...extra });

  it("the model's invented 'onsite' cannot reach the email", () => {
    const html = render({
      // what a composer sentence can look like
      fields: { ...base.fields, facts: [{ k: "Location", v: "Bengaluru (onsite; remote not stated)", ok: null }] },
      jobLocation: "Bengaluru", // exactly what the posting says
    });
    expect(html).toMatch(/Bengaluru/);
    expect(html).not.toMatch(/on-?site/i); // the posting never said it, so it is never printed
  });

  it("a mode the POSTING states is still printed — this must not silence real information", () => {
    const html = render({ fields: { ...base.fields, facts: [] }, jobLocation: "Bengaluru, India (Hybrid)" });
    expect(html).toMatch(/Hybrid/);
  });

  it("the model cannot DELETE a mode the posting states either", () => {
    const html = render({
      fields: { ...base.fields, facts: [{ k: "Location", v: "Bengaluru", ok: null }] },
      jobLocation: "Remote - India",
    });
    expect(html).toMatch(/Remote/);
  });

  it("falls back to the fact row only when no posting location is passed (owner-only callers)", () => {
    const html = render({ fields: { ...base.fields, facts: [{ k: "Location", v: "Berlin", ok: null }] } });
    expect(html).toMatch(/Berlin/);
  });

  it("an empty posting location does not blank a location the fact row has", () => {
    const html = render({ fields: { ...base.fields, facts: [{ k: "Location", v: "Berlin", ok: null }] }, jobLocation: "   " });
    expect(html).toMatch(/Berlin/);
  });
});

// fit-screen.test.mjs — the first-pass read replaces a keyword chart, and must not repeat its bugs.
//
// What a keyword chart gets wrong, and this must not repeat:
//   · rows under a "Gap" header while carrying status `unknown`, which the engine's own prompt
//     defines as "the profile does not show it, NEVER a miss"
//   · "gaps" that nobody writes on a resume (a frontend engineer shown `Git`)
//   · requirements silently dropped between extraction and rendering
//
// The lines are model-written: deriving them from `evidence` can produce the SAME SENTENCE under
// OPPOSITE verdicts on one screen.
import { describe, it, expect } from "vitest";
import { SCREEN_LABEL } from "./render-email.mjs";
import { screenRows, dealbreaker, isCommodity, verdictFor } from "./lib/fit-screen.mjs";

const cov = (over = {}) => ({
  thin: false,
  seniorityLevel: "at",
  subscores: { domain: 0.7, mustHave: 0.8 },
  coverage: [],
  screen: { level: "They ask for three to six years. You have four.", domain: "They build for schools. You built for clinics.", recent: "Your last eighteen months were a React product." },
  ...over,
});

describe("nothing is invented when there is nothing to say", () => {
  it("a thin coverage yields no rows and no stopper", () => {
    for (const bad of [null, undefined, { thin: true }, { thin: true, reason: "jd" }]) {
      expect(screenRows(bad)).toEqual([]);
      expect(dealbreaker(bad)).toBeNull();
    }
  });

  it("a null line is DROPPED, never filled in", () => {
    // Three rows is a maximum, not a quota. An absent row is a far smaller failure than a guessed one.
    const rows = screenRows(cov({ screen: { level: "They ask for five years. You have five.", domain: null, recent: null } }));
    expect(rows.map((r) => r.key)).toEqual(["level"]);
  });

  it("a screen object that is missing or junk yields no rows rather than throwing", () => {
    for (const s of [undefined, null, "nope", 42, {}]) {
      expect(Array.isArray(screenRows(cov({ screen: s })))).toBe(true);
    }
  });
});

describe("the verdict chip is decided in CODE, never by the model", () => {
  it("level: under is the only softened case, and OVER is never a warning", () => {
    // Roles read as OVER the posting are clicked far more often than at-level ones: being above the
    // bar is the strongest signal in the data.
    expect(verdictFor("level", cov({ seniorityLevel: "under" }))).toBe("close");
    expect(verdictFor("level", cov({ seniorityLevel: "at" }))).toBe("yes");
    expect(verdictFor("level", cov({ seniorityLevel: "over" }))).toBe("yes");
  });

  it("domain reads the deterministic subscore", () => {
    expect(verdictFor("domain", cov({ subscores: { domain: 0.9 } }))).toBe("yes");
    expect(verdictFor("domain", cov({ subscores: { domain: 0.4 } }))).toBe("close");
    expect(verdictFor("domain", cov({ subscores: { domain: 0.1 } }))).toBe("no");
  });

  it("RECENT HAS NO CHIP, because nothing measures recency", () => {
    // This row must not borrow `mustHave`: that would render "Recent work [yes]" directly above "the
    // stack and domain differ from this posting". A chip that argues with its own sentence costs more
    // trust than a blank space does.
    expect(verdictFor("recent", cov())).toBeNull();
    expect(screenRows(cov()).find((r) => r.key === "recent").verdict).toBeNull();
  });
});

describe("the stopper is singular, and it is never a missing tool", () => {
  const req = (r, status = "unknown") => ({ req: r, status, evidence: null });

  it("a duration requirement the profile does not show IS a stopper", () => {
    expect(dealbreaker(cov({ coverage: [req("5+ years fintech")] }))).toBe("5+ years fintech");
  });

  it("a missing LIBRARY is never a stopper", () => {
    // Research is explicit that a different tool is not a deal-breaker, and it is usually just
    // unlisted. This is the whole reason the keyword chart was wrong.
    for (const r of ["Angular", "Kubernetes", "GraphQL", "Redux / Apollo Client", "Next.js"]) {
      expect(dealbreaker(cov({ coverage: [req(r)] })), r).toBeNull();
    }
  });

  it("a MET duration requirement is not a stopper", () => {
    expect(dealbreaker(cov({ coverage: [req("5+ years fintech", "met")] }))).toBeNull();
    expect(dealbreaker(cov({ coverage: [req("5+ years fintech", "partial")] }))).toBeNull();
  });

  it("a degree is never a stopper", () => {
    // SHRM 2022, and fit-floor.mjs already treats credentials as survivable.
    expect(dealbreaker(cov({ coverage: [req("Bachelor's degree")] }))).toBeNull();
  });

  it("returns ONE, not a list — so the email can never become a wall of objections", () => {
    const out = dealbreaker(cov({ coverage: [req("5+ years fintech"), req("8+ years payments")] }));
    expect(typeof out).toBe("string");
  });
});

describe("the positioning detail lives in exactly ONE place", () => {
  // The role email and the positioning email the CTA sends must not print the same content: tapping
  // "show me how to position for this role" has to deliver something the reader has not already
  // scrolled past, or the link is a lie and the click is worthless as a measurement.
  //
  // The role email is SKIMMED. It gets the one move and an offer; the email that arrives because
  // somebody asked for it gets the detail.
  const fixture = () => ({
    fields: { role_title: "Frontend Engineer", company: "Acme", why_you: "you shipped a checkout redesign", resume_tips: ["Open with the Lumen system", "Name the 40M rows", "Lead with the team of four", "Put Go above Node"] },
    cov: { ...cov(), coverage: [{ req: "5y React", status: "met", evidence: "x" }], topMove: "Open with the design system you took from zero to adopted." },
    jobDescription: "x".repeat(1400),
    email: "u@x.com",
    findId: "u@x.com:job-1",
  });

  it("with the link LIVE, the role email carries the move but NOT the bullets", async () => {
    const { renderEmail } = await import("./render-email.mjs");
    const prev = process.env.POSITION_ASK;
    process.env.POSITION_ASK = "on";
    try {
      const html = renderEmail(fixture());
      expect(html).toContain("Show me how to position for this role");
      expect(html).toContain("zero to adopted"); // the single move stays
      for (const b of ["Name the 40M rows", "Lead with the team of four", "Put Go above Node"]) {
        expect(html, `"${b}" must live behind the click, not above it`).not.toContain(b);
      }
    } finally {
      if (prev === undefined) delete process.env.POSITION_ASK; else process.env.POSITION_ASK = prev;
    }
  });

  it("with the link OFF, nothing is lost — the bullets render inline as before", async () => {
    const { renderEmail } = await import("./render-email.mjs");
    const prev = process.env.POSITION_ASK;
    delete process.env.POSITION_ASK;
    try {
      const html = renderEmail(fixture());
      expect(html).not.toContain("Show me how to position for this role");
      expect(html).toContain("Name the 40M rows");
    } finally {
      if (prev !== undefined) process.env.POSITION_ASK = prev;
    }
  });
});

describe("the Pro block is never shown to someone who already answered it", () => {
  // Re-asking a person who already replied "yes, I'd use this" asks them for something they have
  // given. It reads as Charlie not listening, and every honest thing in the email depends on it
  // listening.
  const fx = () => ({
    fields: { role_title: "Frontend Engineer", company: "Acme", why_you: "you shipped a checkout redesign" },
    cov: { ...cov(), coverage: [{ req: "5y React", status: "met", evidence: "x" }] },
    jobDescription: "x".repeat(1400),
    email: "u@x.com",
    findId: "u@x.com:job-1",
  });
  const withPitch = async (fn) => {
    const prev = process.env.PRO_PITCH;
    process.env.PRO_PITCH = "on";
    try { return await fn((await import("./render-email.mjs")).renderEmail); }
    finally { if (prev === undefined) delete process.env.PRO_PITCH; else process.env.PRO_PITCH = prev; }
  };

  it("shows it by default", () => withPitch((renderEmail) => {
    expect(renderEmail(fx())).toContain("I'm interested");
  }));

  it("HIDES it once they have asked", () => withPitch((renderEmail) => {
    const html = renderEmail({ ...fx(), proAsked: true });
    expect(html).not.toContain("I'm interested");
    expect(html).not.toContain("What else I could do for you");
  }));

  it("fails OPEN — an unknown answer still shows the block", () => withPitch((renderEmail) => {
    // The caller reads this from one signals query per run. If that read fails it returns an empty
    // set, so `proAsked` is false and everyone sees the block — the pre-existing behaviour. Failing
    // closed would silently delete a section for every user on an infra blip (fail-to-zero).
    for (const v of [undefined, null, false, 0, ""]) {
      expect(renderEmail({ ...fx(), proAsked: v }), String(v)).toContain("I'm interested");
    }
  }));

  it("the rest of the email is untouched when the block is hidden", () => withPitch((renderEmail) => {
    const html = renderEmail({ ...fx(), proAsked: true });
    // This fixture carries no job_summary and no advice, so it renders the header and the actions and
    // nothing else. Those are what "untouched" means for it. Asserting a section it never had would
    // have been a test that passes by construction.
    expect(html).toContain("Frontend Engineer");
    expect(html).toContain("Acme");
    // and the two things deliberately removed from every email stay removed
    expect(html).not.toContain("Nothing here disqualifies you");
    expect(html).not.toContain("Why you");
  }));
});

describe("the commodity denylist", () => {
  it("catches the things nobody writes on a resume", () => {
    // Every one of these was shown to a real person as their gap.
    for (const r of ["Git", "HTML5 / CSS3", "SQL", "Agile delivery", "Stakeholder communication", "Problem-solving & adaptability", "English intermediate", "Relational DB / SQL"]) {
      expect(isCommodity(r), r).toBe(true);
    }
  });

  it("does not swallow real, specific requirements", () => {
    for (const r of ["Elasticsearch", "protobufs/gRPC", "Next.js", "Apollo GraphQL", "Flask/FastAPI", "CI/CD pipelines", "Kubernetes"]) {
      expect(isCommodity(r), r).toBe(false);
    }
  });
});

// send-audit.test.mjs — the post-send self-audit catches hard-constraint misses (remote-wanter, office role),
// and never throws. Run with `npm test` (vitest).
import { describe, it, expect } from "vitest";
import { auditRole, postSendAudit, cityVariants, workArrangement, remoteOnly } from "./send-audit.mjs";

const remotePerson = { preferences: { remote: "remote", home_place: "Bangalore, India" } };

describe("auditRole — location / remote (remote-wanter, office role)", () => {
  it("FLAGS a remote-wanting person handed a role in ANOTHER city", () => {
    const f = auditRole({ dossier: remotePerson, role: { title: "Lead PM", location: "Hyderabad, Telangana, India", remote: null } });
    expect(f).toHaveLength(1);
    expect(f[0].rule).toBe("location:remote-mismatch");
    expect(f[0].severity).toBe("high");
  });

  it("is clean for a true-remote role", () => {
    expect(auditRole({ dossier: remotePerson, role: { title: "Principal PM", location: "Remote", remote: true } })).toEqual([]);
  });

  it("is clean for a role in the person's OWN city (home-city fallback)", () => {
    expect(auditRole({ dossier: remotePerson, role: { title: "PM", location: "Bangalore, India", remote: null } })).toEqual([]);
  });

  it("does NOT flag location when the person did not ask for remote", () => {
    const onsitePerson = { preferences: { remote: "", home_place: "Pune, India" } };
    expect(auditRole({ dossier: onsitePerson, role: { title: "PM", location: "Hyderabad, India", remote: null } })).toEqual([]);
  });
});

describe("workArrangement — what the POSTING says, tri-state, never a guess", () => {
  it("reads the normalised remote flag", () => {
    expect(workArrangement({ remote: true })).toBe("remote");
    expect(workArrangement({ remote: false })).toBe("onsite");
  });

  it("unstated is its own answer, not a lean either way", () => {
    // Most live roles say nothing about arrangement. Folding those into either side would be
    // guessing about the majority of the pool.
    expect(workArrangement({ remote: null })).toBe("unknown");
    expect(workArrangement({})).toBe("unknown");
    expect(workArrangement(undefined)).toBe("unknown");
  });

  it("believes the location field when it says remote outright", () => {
    expect(workArrangement({ remote: null, location: "Remote (India)" })).toBe("remote");
  });
});

describe("remoteOnly — narrow on purpose", () => {
  // Every string below is shaped like a real `preferences.remote` value (anonymised).
  it("is true for someone who ruled out an office", () => {
    for (const remote of ["remote", "Remote (WFH)", "fully remote", "Remote only, home base Bengaluru, India"]) {
      expect(remoteOnly({ remote }), `"${remote}" should be remote-only`).toBe(true);
    }
  });

  it("is FALSE for people who want remote and will also take a desk", () => {
    // The failure this prevents is silence, not a bad send: digesting roles they would have taken.
    for (const remote of [
      "Remote or Bengaluru, Hyderabad, Pune, Kolkata, India",
      "Pune, Bangalore, Remote/Hybrid",
      "Remote / Gurugram, India",
      "open to either remote or bengaluru",
    ]) {
      expect(remoteOnly({ remote }), `"${remote}" must NOT be remote-only`).toBe(false);
    }
  });

  it("an office word beats a remote-only phrase in the same sentence", () => {
    // Both of these contain "fully remote" AND offer an office; flagging them would be wrong.
    expect(remoteOnly({ remote: "Fully Remote or Hybrid - Pune, Nagpur, Bangalore, Indore" })).toBe(false);
    expect(remoteOnly({ remote: "Cities in India (on-site or hybrid), fully remote from anywhere" })).toBe(false);
  });

  it("is false for someone who never mentioned remote", () => {
    expect(remoteOnly({ remote: "Bangalore" })).toBe(false);
    expect(remoteOnly({})).toBe(false);
  });
});

describe("auditRole — arrangement, asked independently of city (the gap the city rule cannot see)", () => {
  // THE REGRESSION FIXTURE. A person who wrote "Remote only, home base Bengaluru, India" must not be
  // sent Bengaluru office roles. A plain city rule passes every one of them, because their city IS
  // the role's city.
  const remoteSeeker = { preferences: { remote: "Remote only, home base Bengaluru, India", home_place: "Bengaluru, India" } };
  const realSends = [
    { title: "Senior Product Designer", company: "Okta", location: "Bengaluru, India", remote: null },
    { title: "Product Design Manager", company: "PhonePe", location: "Bangalore", remote: null },
    { title: "Design Builder", company: "Razorpay", location: "Bengaluru", remote: null },
    { title: "Product Designer", company: "DevRev", location: "Bangalore, India", remote: null },
    { title: "Senior Product Designer", company: "HackerRank", location: "Hybrid in Bangalore, India", remote: null },
    { title: "Product designer", company: "Ema", location: "India - Bengaluru", remote: null },
    { title: "Product Designer", company: "Ekacare", location: "Bengaluru, KA, India", remote: null },
    { title: "Senior Product Designer", company: "Hr", location: "Bengaluru, KA, India", remote: null },
  ];

  it("the OLD rule was silent on all eight — this is what was broken", () => {
    for (const role of realSends) {
      const cityFindings = auditRole({ dossier: remoteSeeker, role }).filter((f) => f.rule === "location:remote-mismatch");
      expect(cityFindings, `${role.company} should not trip the CITY rule — the city matched`).toEqual([]);
    }
  });

  it("every one of the eight now flags", () => {
    for (const role of realSends) {
      const f = auditRole({ dossier: remoteSeeker, role });
      expect(f.length, `${role.company} — ${role.location} still passes`).toBeGreaterThan(0);
      expect(f[0].rule).toBe("arrangement:unknown");
      expect(f[0].severity).toBe("high"); // high routes to DIGEST via presend-guard, never a drop
    }
  });

  it("an explicitly onsite role in their own city flags with the sharper reason", () => {
    const f = auditRole({ dossier: remoteSeeker, role: { title: "PM", location: "Bengaluru, India", remote: false } });
    expect(f[0].rule).toBe("arrangement:onsite-vs-remote-only");
  });

  it("a genuinely remote role is still clean — the 17,125 roles they can still reach", () => {
    expect(auditRole({ dossier: remoteSeeker, role: { title: "PM", location: "Remote", remote: true } })).toEqual([]);
    expect(auditRole({ dossier: remoteSeeker, role: { title: "PM", location: "Remote (India)", remote: null } })).toEqual([]);
  });

  it("does NOT touch the person who wants remote but will take a desk in that same city", () => {
    const flexible = { preferences: { remote: "Fully Remote or Hybrid - Pune, Nagpur, Bangalore, Indore" } };
    expect(auditRole({ dossier: flexible, role: { title: "UI Eng", location: "Bengaluru, India", remote: null } })).toEqual([]);
    expect(auditRole({ dossier: flexible, role: { title: "UI Eng", location: "Pune, India", remote: false } })).toEqual([]);
  });

  it("still reports only ONE finding for an out-of-city role — the two rules do not double-fire", () => {
    const f = auditRole({ dossier: remoteSeeker, role: { title: "PM", location: "Hyderabad, India", remote: null } });
    expect(f).toHaveLength(1);
    expect(f[0].rule).toBe("location:remote-mismatch");
  });
});

describe("auditRole — dealbreakers", () => {
  it("FLAGS a role whose text matches a stated dealbreaker", () => {
    const person = { preferences: { dealbreakers: ["gambling"] } };
    const f = auditRole({ dossier: person, role: { title: "PM, Gambling Platform", location: "Remote", remote: true, description: "own the gambling funnel" } });
    expect(f.some((x) => x.rule === "dealbreaker:hit")).toBe(true);
  });

  it("ignores too-short / empty dealbreaker tokens (noise)", () => {
    const person = { preferences: { dealbreakers: ["ai", ""] } };
    expect(auditRole({ dossier: person, role: { title: "AI PM", location: "Remote", remote: true, description: "" } })).toEqual([]);
  });
});

describe("postSendAudit — best-effort, never throws, never sends", () => {
  it("returns findings and calls capture on a violation", async () => {
    const captured = [];
    const f = await postSendAudit({
      dossier: remotePerson,
      role: { title: "PM", location: "Chennai, India", remote: null },
      email: "u@x.com", surface: "daily-role",
      log: () => {}, capture: (err, ctx) => captured.push(ctx),
    });
    expect(f).toHaveLength(1);
    expect(captured).toHaveLength(1);
    expect(captured[0].surface).toBe("daily-role");
  });

  it("never throws even on a malformed role", async () => {
    await expect(postSendAudit({ dossier: null, role: null, email: "u@x.com", surface: "x" })).resolves.toEqual([]);
  });
});

// ── City aliases: one city, several spellings ───────────────────────────────────────────────────
// The home-city exemption must not compare raw substrings: a candidate who wrote "Bangalore" would be
// treated as not-in-their-own-city for every role an employer posted as "Bengaluru" — often the
// larger half of their own city. preSendGuard gates on this, so a miss withholds real roles.
describe("auditRole — home city matches across spellings", () => {
  const remoteWanter = (home) => ({ preferences: { remote: "remote", home_place: home } });
  const at = (location) => ({ title: "Product Manager", location, description: "" });
  const flagged = (dossier, role) => auditRole({ dossier, role }).some((f) => f.rule === "location:remote-mismatch");

  it("Bangalore ↔ Bengaluru is the SAME city in both directions", () => {
    expect(flagged(remoteWanter("Bangalore, India"), at("Bengaluru, Karnataka"))).toBe(false);
    expect(flagged(remoteWanter("Bengaluru, India"), at("Bangalore, India"))).toBe(false);
  });

  it("covers the other renamed cities candidates actually type", () => {
    expect(flagged(remoteWanter("Bombay"), at("Mumbai, Maharashtra, India"))).toBe(false);
    expect(flagged(remoteWanter("Madras"), at("Chennai, Tamil Nadu, India"))).toBe(false);
    expect(flagged(remoteWanter("Calcutta"), at("Kolkata, West Bengal, India"))).toBe(false);
    expect(flagged(remoteWanter("Gurgaon, India"), at("Gurugram, Haryana, India"))).toBe(false);
    expect(flagged(remoteWanter("Cochin"), at("Kochi, Kerala, India"))).toBe(false);
  });

  // The whole point of the guard. Widening spellings must not widen GEOGRAPHY.
  it("still flags a genuinely different city", () => {
    expect(flagged(remoteWanter("Bangalore, India"), at("Noida, India"))).toBe(true);
    expect(flagged(remoteWanter("Bangalore, India"), at("Hyderabad, Telangana, India"))).toBe(true);
    expect(flagged(remoteWanter("Kochi, India"), at("Bengaluru, Karnataka"))).toBe(true);
  });

  it("a near-neighbour is NOT an alias — Noida is not Delhi, Thane is not Mumbai", () => {
    expect(flagged(remoteWanter("Delhi, India"), at("Noida, India"))).toBe(true);
    expect(flagged(remoteWanter("Mumbai, India"), at("Thane, Maharashtra, India"))).toBe(true);
  });

  it("an unknown city still matches itself, and nothing else", () => {
    expect(cityVariants("reykjavik")).toEqual(["reykjavik"]);
    expect(flagged(remoteWanter("Reykjavik"), at("Reykjavik, Iceland"))).toBe(false);
    expect(flagged(remoteWanter("Reykjavik"), at("Oslo, Norway"))).toBe(true);
  });

  it("a genuinely remote role is still fine regardless of city spelling", () => {
    expect(flagged(remoteWanter("Bangalore, India"), at("Remote - India"))).toBe(false);
  });
});

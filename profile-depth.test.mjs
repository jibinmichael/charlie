// profile-depth.test.mjs — the profile-depth metric (how much grounded evidence a dossier holds).
//
// The point of these tests is that the metric stays re-derivable. If the definition of "depth"
// drifts, any history measured on it silently stops meaning anything and nobody notices, because a
// number still appears.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { profileDepth, bandFor, depthEngagementTable, depthSnapshotMode, DEPTH_BANDS } from "./profile-depth.mjs";

let saved;
beforeEach(() => { saved = process.env.DEPTH_SNAPSHOT; });
afterEach(() => { if (saved === undefined) delete process.env.DEPTH_SNAPSHOT; else process.env.DEPTH_SNAPSHOT = saved; });

describe("depth is the proof-point count, and stays that", () => {
  it("counts proof points, not the richer things it could have counted", () => {
    // Engagement evidence is measured on THIS definition.
    // Redefining depth to include case studies or strengths would make the history incomparable —
    // the quiet way a metric stops meaning anything while still producing a number.
    const d = profileDepth({ proof_points: [1, 2, 3], case_studies: [1, 2], strengths: [1, 2, 3, 4] });
    expect(d.depth).toBe(3);
    expect(d.proofPoints).toBe(3);
    expect(d.caseStudies).toBe(2);
    expect(d.strengths).toBe(4);
  });

  it("counts a preference only when the person actually stated it", () => {
    // null is the build declining to guess (dossier.md tells it not to), so counting keys would count
    // silence as knowledge — the same error as reading a missing field as a fact about someone.
    const d = profileDepth({
      preferences: { role: "Frontend Developer", remote: "remote only", seniority: null, tech: [], values: "", stage: ["seed"] },
    });
    expect(d.statedPrefs).toBe(3); // role, remote, stage
  });

  it("survives a missing or junk dossier without throwing", () => {
    for (const bad of [null, undefined, {}, { proof_points: "not an array" }, { preferences: "nope" }]) {
      expect(profileDepth(bad).depth).toBe(0);
      expect(profileDepth(bad).statedPrefs).toBe(0);
    }
  });
});

describe("bands", () => {
  it("puts each depth in the band the evidence table used", () => {
    expect(bandFor(0)).toBe("0-3");
    expect(bandFor(2)).toBe("0-3");
    expect(bandFor(3)).toBe("3-6");
    expect(bandFor(5)).toBe("3-6");
    expect(bandFor(6)).toBe("6-10");
    expect(bandFor(9)).toBe("6-10");
    expect(bandFor(10)).toBe("10+");
    expect(bandFor(26)).toBe("10+"); // a very deep profile
  });

  it("bands are contiguous and cover everything, so nobody falls between them", () => {
    for (let i = 0; i < DEPTH_BANDS.length - 1; i++) expect(DEPTH_BANDS[i].hi).toBe(DEPTH_BANDS[i + 1].lo);
    expect(DEPTH_BANDS[0].lo).toBe(0);
    expect(DEPTH_BANDS[DEPTH_BANDS.length - 1].hi).toBe(Infinity);
  });
});

describe("the evidence table can be rebuilt from data", () => {
  const thin = { email: "thin@x.com", dossier: { proof_points: [1, 2, 3, 4] } };   // band 3-6
  const deep = { email: "deep@x.com", dossier: { proof_points: Array(12).fill(1) } }; // band 10+

  it("reproduces the expected shape: thin band silent, deep band engaged", () => {
    const rows = depthEngagementTable({
      candidates: [thin, deep],
      roleSends: [{ email: "thin@x.com" }, { email: "thin@x.com" }, { email: "deep@x.com" }, { email: "deep@x.com" }],
      clicks: [{ email: "deep@x.com" }, { email: "deep@x.com" }],
    });
    const byBand = Object.fromEntries(rows.map((r) => [r.band, r]));
    expect(byBand["3-6"].clicksPerEmail).toBe(0);
    expect(byBand["3-6"].everClicked).toBe(0);
    expect(byBand["10+"].clicksPerEmail).toBe(1);
    expect(byBand["10+"].everClicked).toBe(1);
  });

  it("EXCLUDES people who were never mailed a role", () => {
    // They cannot speak to engagement either way, and counting them as a zero would invent a
    // disengaged user out of a person Charlie simply never wrote to.
    const rows = depthEngagementTable({ candidates: [thin, deep], roleSends: [{ email: "deep@x.com" }], clicks: [] });
    const byBand = Object.fromEntries(rows.map((r) => [r.band, r]));
    expect(byBand["3-6"].users).toBe(0);
    expect(byBand["10+"].users).toBe(1);
  });

  it("matches addresses case-insensitively across the three sources", () => {
    const rows = depthEngagementTable({
      candidates: [{ email: "Deep@X.com", dossier: { proof_points: Array(12).fill(1) } }],
      roleSends: [{ email: "deep@x.com" }],
      clicks: [{ email: "DEEP@x.COM" }],
    });
    expect(Object.fromEntries(rows.map((r) => [r.band, r]))["10+"].clicks).toBe(1);
  });

  it("returns a table, not a crash, on empty inputs", () => {
    const rows = depthEngagementTable({});
    expect(rows).toHaveLength(DEPTH_BANDS.length);
    expect(rows.every((r) => r.users === 0)).toBe(true);
  });
});

describe("the snapshot is off until someone turns it on", () => {
  it("defaults to off and rejects an unknown value", () => {
    delete process.env.DEPTH_SNAPSHOT;
    expect(depthSnapshotMode()).toBe("off");
    process.env.DEPTH_SNAPSHOT = "sure";
    expect(depthSnapshotMode()).toBe("off");
  });

  it("dry and on are readable after import", () => {
    process.env.DEPTH_SNAPSHOT = "dry";
    expect(depthSnapshotMode()).toBe("dry");
    process.env.DEPTH_SNAPSHOT = "on";
    expect(depthSnapshotMode()).toBe("on");
  });
});

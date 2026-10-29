// prefs-audit-trail.test.mjs — a reply that changes what Charlie searches by leaves a record.
//
// WHY. A reply saying "remote only" flips the same role from SEND to DIGEST at the real gate, but the
// in-memory inbound log is wiped by every deploy and platform logs are short-lived. Without a durable
// record, "is Charlie applying what people tell him?" can only be re-derived by running the code. A
// thing that works and a thing that quietly stopped working leave identical evidence when nothing is
// written down.
import { describe, it, expect } from "vitest";
import { applyPrefsOnly } from "./email-onboard.mjs";

const dossier = () => ({ preferences: { role: "Frontend Developer", remote: "open to Bangalore" }, status: "active" });

describe("a preference change from a reply is recorded", () => {
  it("writes a prefs_updated signal naming the keys that changed", async () => {
    const signals = [];
    const r = await applyPrefsOnly("her@example.com", "make it remote only please", {
      getDossier: async () => dossier(),
      extractPrefs: async () => ({ remote: "remote only" }),
      saveDossier: async () => {},
      recordSignal: async (s) => { signals.push(s); return true; },
    });

    expect(r.changed).toContain("remote");
    expect(signals).toHaveLength(1);
    expect(signals[0].event).toBe("prefs_updated");
    expect(signals[0].email).toBe("her@example.com");
    expect(signals[0].meta.changed).toContain("remote");
    expect(signals[0].meta.source).toBe("reply");
  });

  it("records the KEY, never the stated value", async () => {
    const signals = [];
    await applyPrefsOnly("her@example.com", "I won't go below 18 LPA", {
      getDossier: async () => dossier(),
      extractPrefs: async () => ({ comp_floor: 18 }),
      saveDossier: async () => {},
      recordSignal: async (s) => { signals.push(s); return true; },
    });
    // The new value already lives in the dossier; what was missing was WHEN and WHAT. Copying a
    // person's pay floor into a second table buys nothing and spreads their data.
    expect(JSON.stringify(signals[0])).not.toContain("18");
    expect(signals[0].meta.changed).toEqual(["comp_floor"]);
  });

  it("records NOTHING when the reply states no change", async () => {
    const signals = [];
    const r = await applyPrefsOnly("her@example.com", "thanks!", {
      getDossier: async () => dossier(),
      extractPrefs: async () => ({}),
      saveDossier: async () => { throw new Error("must not save on an empty change"); },
      recordSignal: async (s) => { signals.push(s); return true; },
    });
    expect(r.changed).toEqual([]);
    expect(signals).toEqual([]);
  });

  it("a failing audit trail can NEVER fail the person's update", async () => {
    // The whole point of the update is that Charlie searches differently tomorrow. A bookkeeping
    // error must not cost that. This is the fail-closed-becomes-fail-to-zero rule pointed at the
    // logging itself: the observability may not become the outage.
    let saved = null;
    const r = await applyPrefsOnly("her@example.com", "remote only", {
      getDossier: async () => dossier(),
      extractPrefs: async () => ({ remote: "remote only" }),
      saveDossier: async (_e, d) => { saved = d; },
      recordSignal: async () => { throw new Error("supabase is down"); },
    });
    expect(r.changed).toContain("remote");
    expect(saved.preferences.remote).toBe("remote only");
  });

  it("an UNRESOLVABLE recorder cannot fail the update either (the default-parameter trap)", async () => {
    // A recorder resolved in a default parameter (`rec = recordSignal`) is evaluated BEFORE the try
    // block exists, so a missing binding would throw straight past the catch into applyEmailChange.
    // Passing an explicitly undefined recorder checks that resolution happens inside the try and
    // degrades to a recordSignal attempt that fails harmlessly rather than a throw.
    let saved = null;
    const r = await applyPrefsOnly("her@example.com", "remote only", {
      getDossier: async () => dossier(),
      extractPrefs: async () => ({ remote: "remote only" }),
      saveDossier: async (_e, d) => { saved = d; },
      recordSignal: undefined,
    });
    expect(r.changed).toContain("remote");
    expect(saved.preferences.remote).toBe("remote only");
  });

  it("the record is written AFTER the save, so it never claims a change that did not persist", async () => {
    const order = [];
    await applyPrefsOnly("her@example.com", "remote only", {
      getDossier: async () => dossier(),
      extractPrefs: async () => ({ remote: "remote only" }),
      saveDossier: async () => { order.push("save"); },
      recordSignal: async () => { order.push("record"); return true; },
    });
    expect(order).toEqual(["save", "record"]);
  });
});

// represent.test.mjs — "can I represent you?", and the profile it completes.
//
// Notice period and active-vs-passive are rarely known. `notice_period` must be in the preferences
// allowlist, or every one anyone types is stripped at the schema before it can be stored.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { representMissing, representMode } from "./represent.mjs";
import { renderRepresent, renderRepresentAsk, REPRESENT_SUBJECT } from "./email-kit.mjs";
import { safePreferences } from "./lib/schemas/preferences.mjs";

let saved;
beforeEach(() => { saved = process.env.REPRESENT; });
afterEach(() => { if (saved === undefined) delete process.env.REPRESENT; else process.env.REPRESENT = saved; });

describe("the flag", () => {
  it("defaults to off and rejects an unknown value", () => {
    delete process.env.REPRESENT;
    expect(representMode()).toBe("off");
    process.env.REPRESENT = "sure";
    expect(representMode()).toBe("off");
  });
});

describe("notice_period can actually be stored", () => {
  it("survives the preferences schema", () => {
    // Without the allowlist entry this is silently dropped, and the answer to the first question a
    // headhunter asks vanishes between the reply and the record.
    const { prefs } = safePreferences({ notice_period: "60 days", mode: "actively looking" });
    expect(prefs.notice_period).toBe("60 days");
    expect(prefs.mode).toBe("actively looking");
  });
});

describe("the extractor is asked for every field the schema allows", () => {
  it("names notice_period in the prompt, not just in the schema", async () => {
    // A field in the preferences ALLOWLIST but not in the extraction prompt is never produced by the
    // model, so every notice period anyone typed would be dropped, while the Represent email asks
    // for it. This asserts the two layers agree rather than trusting that both get updated.
    const { ONBOARD_EXTRACT_SYSTEM } = await import("./prompts/onboard-extract.mjs");
    const { Preferences } = await import("./lib/schemas/preferences.mjs");
    for (const key of Object.keys(Preferences.shape)) {
      expect(ONBOARD_EXTRACT_SYSTEM, `${key} is storable but the extractor is never asked for it`).toContain(key);
    }
  });
});

describe("what we still cannot answer", () => {
  it("asks in the order a headhunter asks", () => {
    expect(representMissing({}).map((x) => x.key).slice(0, 3)).toEqual(["mode", "notice_period", "comp_floor"]);
  });

  it("does not ask for something already known", () => {
    const m = representMissing({ preferences: { mode: "actively looking", notice_period: "30 days", comp_floor: 25 } });
    for (const k of ["mode", "notice_period", "comp_floor"]) expect(m.map((x) => x.key)).not.toContain(k);
  });

  it("treats an empty array as unknown, not as an answer", () => {
    expect(representMissing({ preferences: { dealbreakers: [] } }).map((x) => x.key)).toContain("dealbreakers");
  });

  it("only ever asks about FACTS, never for a self-assessment", () => {
    // "Are you actively looking" is answerable. "How motivated are you" is a judgement we have no
    // business asking someone to make about themselves, and no headhunter asks it either.
    const text = representMissing({}).map((m) => `${m.label} ${m.prompt}`).join(" ").toLowerCase();
    for (const bad of ["how motivated", "how serious", "rate your", "how committed", "why should"]) {
      expect(text, bad).not.toContain(bad);
    }
  });

  it("survives a missing or junk dossier", () => {
    for (const bad of [null, undefined, {}, { preferences: "nope" }]) {
      expect(Array.isArray(representMissing(bad))).toBe(true);
    }
  });
});

describe("the offer email", () => {
  const r = () => renderRepresent({ email: "a@b.com", name: "Priya" });

  it("says I AM STARTING, never that a partnership exists", () => {
    // Announcing a partnership that does not exist is a
    // claim about ourselves of exactly the kind Charlie refuses to make about a person — and if it
    // slipped, every later email would be worth less.
    const t = r().text.toLowerCase();
    expect(t).toContain("i am starting something small");
    expect(t).toContain("calling it represent");
    expect(t).not.toMatch(/have partnered|we have partnered|partnership with|are partnering|in partnership/);
  });

  it("carries NO invented application statistic", () => {
    // "Hundreds apply" is an observation anyone job-hunting recognises. "The average role gets 250
    // applicants" would be a number we made up, and someone would repeat it.
    expect(r().text).not.toMatch(/\d+\s*(applicants|applications|%)/i);
  });

  it("asks permission rather than promising a benefit", () => {
    expect(r().subject).toBe("Can I represent you?");
    expect(r().text).toContain("I want you on it");
  });

  it("names the programme, so the reply and the button agree", () => {
    expect(r().html).toContain("Represent me");
  });

  it("carries no em dash in either half", () => {
    expect(/—|–/.test(r().text + r().html)).toBe(false);
  });
});

describe("the reply is caught before the preference writer", () => {
  it("the subject Charlie sends matches the handler's pattern, with and without Re:", () => {
    // If these drift, "represent me" routes into applyEmailChange and becomes a stated preference
    // about the kind of role they want — invented out of a button we asked them to press.
    const INBOUND = new RegExp(`^\\s*(re:|fwd:)?\\s*${REPRESENT_SUBJECT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i");
    const { subject } = renderRepresent({ email: "a@b.com" });
    expect(INBOUND.test(subject)).toBe(true);
    expect(INBOUND.test(`Re: ${subject}`)).toBe(true);
    expect(INBOUND.test("Did the Toddle role end with you?")).toBe(false);
    expect(INBOUND.test("About your last few roles")).toBe(false);
  });
});

describe("the answer email", () => {
  it("asks at most THREE things", () => {
    // Eight questions read as homework and get nothing back; three read as a conversation.
    const many = representMissing({});
    expect(many.length).toBeGreaterThan(3);
    const t = renderRepresentAsk({ email: "a@b.com", missing: many }).text;
    expect(t.split("\n").filter((l) => l.startsWith("- ")).length).toBe(3);
  });

  it("promises to come back either way", () => {
    // The offer is speculative. Saying so costs nothing and is the only thing that makes the rest of
    // it credible.
    expect(renderRepresentAsk({ email: "a@b.com", missing: [] }).text).toContain("If nothing comes of it, I will tell you that too");
  });

  it("renders with nothing missing rather than breaking", () => {
    const t = renderRepresentAsk({ email: "a@b.com", missing: [] });
    expect(t.text).not.toContain("undefined");
    expect(/—|–/.test(t.text + t.html)).toBe(false);
  });
});

// poolMissing: the applicant-pool sibling of representMissing. It reads talent_pool columns, because
// an applicant has no dossier and reading preferences off one returns "everything is missing".
describe("poolMissing", () => {
  it("names only the columns that are actually empty", async () => {
    const { poolMissing } = await import("./represent.mjs");
    expect(poolMissing({ portfolio_url: "x", comp_expected: 1, notice_days: 30 })).toEqual([]);
    expect(poolMissing({ portfolio_url: "x", comp_expected: 1, notice_days: null })).toEqual(["notice"]);
    expect(poolMissing({})).toEqual(["portfolio", "pay", "notice"]);
  });

  it("treats a zero notice period as known, not missing", async () => {
    // Somebody serving no notice is the most placeable person there is. Reading 0 as absent would ask
    // them for the one thing they already told us, and would drop the best answer on the list.
    const { poolMissing } = await import("./represent.mjs");
    expect(poolMissing({ portfolio_url: "x", comp_expected: 1, notice_days: 0 })).toEqual([]);
  });

  it("does not read a dossier's preferences (the wrong-shape trap)", async () => {
    const { poolMissing } = await import("./represent.mjs");
    expect(poolMissing({ preferences: { notice_period: "30 days" } })).toEqual(["portfolio", "pay", "notice"]);
  });
});

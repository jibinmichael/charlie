// lib/agents/setup.test.mjs — the Setup card's details are the agent's own code, never written for the screen.
import { describe, it, expect } from "vitest";
import { qualifySetup } from "./setup.mjs";
import { FULL_PASS_HOURS, REMIND_AFTER_HOURS, CLOSE_AFTER_HOURS, CONFIRM_ASKS } from "../qualify/agent.mjs";
import { EVALUATIONS_PER_PASS } from "../qualify/wiring.mjs";
import { ADAPTERS } from "../qualify/adapters.mjs";
import { AGENTS } from "./registry.mjs";
import { questionsFor } from "../qualify/fields.mjs";

const CONN = { key: "pieworks", name: "Pieworks", source: { type: "pieworks" }, destination: { via: "Pieworks" }, sequence: {} };

describe("the Setup card's details", () => {
  const s = qualifySetup({ connection: CONN, env: {} });

  it("the Audience lines say who the agent may talk to: whoever the configured scorer passes", () => {
    expect(s.audience.slice(0, 2)).toEqual(["People the candidate scorer passes (pieworks)", "Never anyone a person passed on"]);
    expect(qualifySetup({ connection: CONN, env: { CANDIDATE_SCORER: "none" } }).audience[0]).toBe("People the candidate scorer passes (none)");
  });

  it("timings are the agent's constants", () => {
    expect(s.timings).toEqual({ full_pass_hours: FULL_PASS_HOURS, reply_minutes: AGENTS.outreach.every_minutes, remind_after_hours: REMIND_AFTER_HOURS, close_after_hours: CLOSE_AFTER_HOURS, confirm_asks: CONFIRM_ASKS, evaluations_per_pass: EVALUATIONS_PER_PASS });
    expect(s.emails.find((e) => e.id === "reminder").when).toContain(`${REMIND_AFTER_HOURS} hours`);
  });

  it("what the destination needs comes from its adapter", () => {
    expect(s.needs).toEqual(ADAPTERS.pieworks.needs);
    expect(s.needs).toContain("CV as a PDF");
  });

  // the templates keep their variables as tokens, distinct from the copy
  it("six real emails with their variables as tokens; only Verify's two lines are the connection's own", () => {
    expect(s.emails.map((e) => e.id)).toEqual(["verify", "reminder", "followup", "confirm", "putforward", "closed"]);
    const v = s.emails[0];
    expect(v.subject).toBe("{role} at {company}: may I put you forward?");
    expect(v.lines[0].text).toBe("Hi {name}.");
    for (const e of s.emails) for (const m of [e.subject, ...e.lines.map((l) => l.text)].join(" ").matchAll(/\{([a-z_]+)\}/g)) expect(s.variables, `{${m[1]}} has no meaning`).toHaveProperty(m[1]);
    expect(v.lines.filter((l) => l.editable)).toHaveLength(2);
    expect(s.emails.slice(1).every((e) => e.lines.every((l) => !l.editable))).toBe(true);
    expect(s.emails.find((e) => e.id === "confirm").lines.some((l) => /reply with just YES/.test(l.text))).toBe(true);
  });

  it("a connection's own wording is what the Verify email shows", () => {
    const own = qualifySetup({ connection: { ...CONN, sequence: { verify: { intro: "Hello from {company}, about the {role} role in {city}." } } } });
    expect(own.emails[0].lines.find((l) => l.editable).text).toBe("Hello from {company}, about the {role} role in {city}.");
  });

  it("models are what the code reads from the environment, defaults otherwise", () => {
    expect(s.abilities.find((a) => a.id === "judge").model).toBe("Scorer: pieworks");
    expect(qualifySetup({ connection: CONN, env: { CANDIDATE_SCORER: "none" } }).abilities.find((a) => a.id === "judge").model).toBe("Scorer: none");
    expect(qualifySetup({ connection: CONN, env: { HIRE_MANDATE_ANSWERS_MODEL: "claude-opus-5-5" } }).abilities.find((a) => a.id === "answers").model).toBe("claude-opus-5-5");
    expect(s.abilities.find((a) => a.id === "submit").model).toBe("No AI");
  });

  it("never a made-up role or company: variables only; the sender is the server's own", () => {
    expect(qualifySetup({ connection: CONN }).example).toMatchObject({ role: "{role}", company: "{company}", city: "{city}" });
    expect(qualifySetup({ connection: CONN, env: { CHARLIE_FROM: "Charlie <hello@x.com>" } }).sender).toBe("Charlie <hello@x.com>");
  });

  it("the Verify questions are the agent's own; a rejected line is said, never shown as in use", () => {
    const qs = questionsFor({ fields: {}, role: "{role}", company: "{company}", city: "{city}", haveCvPdf: false }).map((q) => q.text);
    const v = s.emails[0].lines.map((l) => l.text).join("\n");
    for (const q of qs) expect(v).toContain(q);
    const bad = qualifySetup({ connection: { ...CONN, sequence: { verify: { intro: "Hello -- this has a dash in it, sadly enough" } } } });
    expect(bad.verify_issues.join(" ")).toMatch(/intro: it has a dash; default used/);
    expect(bad.emails[0].lines.find((l) => l.editable).text).not.toMatch(/--/);
  });
});

describe("the Setup card says nothing is put forward without a person's approval", () => {
  it("names it as a guardrail", async () => {
    const { qualifySetup } = await import("./setup.mjs");
    const s = qualifySetup({ connection: { key: "pieworks", name: "Pieworks", source: { type: "pieworks" }, destination: { type: "pieworks" }, settings: {} }, env: {} });
    expect(s.guardrails).toContain("Put forward only once a person approved them in the Inbox");
  });
});

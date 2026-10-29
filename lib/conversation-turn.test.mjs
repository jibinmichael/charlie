// conversation-turn.test.mjs — multi-turn conversations (lib/compose-reply.mjs), evaluated as sequences, plus the adversarial cases that matter most:
// what happens when the MODEL misbehaves. The prompt asks it not to invent; these prove the code
// refuses to send it when it does anyway.

import { describe, it, expect } from "vitest";
import { composeReply, groundingOk, factSheet, outOfBounds, isContinuation, transcriptFrom } from "./compose-reply.mjs";

const ROLE = { title: "Senior Android Engineer", company: "Saltwater Labs", location: "Nagpur", remote: null, compensation: null };
const ROLE_FULL = { ...ROLE, remote: "On-site", compensation: "INR 21,00,000 - 27,00,000" };

/** A model that returns whatever the test tells it to. */
const fake = (payload) => ({ messages: { create: async () => ({ content: [{ type: "text", text: JSON.stringify(payload) }] }) } });
/** A model that is asked for a reply and produces one; the test asserts what survives the gate. */
const say = (kind, reply) => fake({ kind, reply });

const OFFER = [
  { who: "charlie", text: "Yes. That's the Senior Android Engineer role at Saltwater Labs in Nagpur. Reply yes and I'll put you forward." },
];

describe("the conversation, as a sequence", () => {
  it("1. role offered -> 'Yes' continues that offer and names what they agreed to", async () => {
    const r = await composeReply({
      message: "Yes", job: ROLE, transcript: OFFER,
      client: say("continue", "Got it. I'll put you forward for the Senior Android Engineer role."),
    });
    expect(r.kind).toBe("continue");
    expect(r.reply).toContain("Senior Android Engineer");
    expect(r.reply).not.toMatch(/pay floor|preferences|what kind of role/i);
  });

  it("2. 'What about remote?' when the listing does not say", async () => {
    const r = await composeReply({
      message: "What about remote?", job: ROLE, transcript: OFFER,
      client: say("answer", "The listing doesn't say whether it's remote. I can ask if you'd like."),
    });
    expect(r.reply).toMatch(/doesn't say/i);
  });

  it("3. 'How much?' with no published range never yields a number", async () => {
    const r = await composeReply({
      message: "How much?", job: ROLE, transcript: OFFER,
      client: say("answer", "They haven't published a range. I can ask if you'd like."),
    });
    expect(r.reply).not.toMatch(/\d/);
  });

  it("4. 'Is that in Nagpur?' answers yes first", async () => {
    const r = await composeReply({
      message: "Is that in Nagpur?", job: ROLE, transcript: OFFER,
      client: say("answer", "Yes, it's in Nagpur."),
    });
    expect(r.reply).toMatch(/^Yes/);
  });

  it("8. 'Actually never mind' produces no reply at all", async () => {
    const r = await composeReply({ message: "Actually never mind.", job: ROLE, transcript: OFFER, client: say("none", "") });
    expect(r.kind).toBe("none");
    expect(r.reply).toBeNull();
  });

  it("11. no role in play never reaches the model", async () => {
    let called = false;
    const spy = { messages: { create: async () => { called = true; return { content: [] }; } } };
    const r = await composeReply({ message: "What about remote?", job: {}, client: spy });
    expect(called).toBe(false);
    expect(r.kind).toBe("cannot");
  });

  it("12. asking us to find a job never reaches the model", async () => {
    let called = false;
    const spy = { messages: { create: async () => { called = true; return { content: [] }; } } };
    for (const m of ["Can you find me a remote Android job?", "Please search for other openings", "Look for a role in Pune"]) {
      const r = await composeReply({ message: m, job: ROLE, client: spy });
      expect(r.kind, m).toBe("cannot");
    }
    expect(called).toBe(false);
  });

  it("13. asking about other candidates never reaches the model", async () => {
    for (const m of ["How many people applied?", "Who else is applying?", "Tell me about the other candidates"]) {
      expect(outOfBounds(m), m).toBeTruthy();
    }
  });

  it("14. outside our knowledge falls to a human", async () => {
    const r = await composeReply({ message: "What did they think of me?", job: ROLE, transcript: OFFER, client: say("cannot", "") });
    expect(r.kind).toBe("cannot");
    expect(r.reply).toBeNull();
  });
});

describe("the gate refuses a model that invents", () => {
  const sheet = factSheet(ROLE);

  it("refuses a salary that is not on the sheet", () => {
    expect(groundingOk("It pays around INR 15,00,000.", sheet).ok).toBe(false);
  });

  it("refuses 'it's on-site' when the field is unknown", () => {
    const g = groundingOk("It's on-site in Nagpur.", sheet);
    expect(g.ok).toBe(false);
    expect(g.why).toMatch(/working arrangement/);
  });

  it("allows the same words alongside an admission that we do not know", () => {
    expect(groundingOk("The listing doesn't say whether it's remote. I can ask.", sheet).ok).toBe(true);
  });

  it("refuses promises Charlie cannot keep", () => {
    for (const bad of [
      "I'll set up an interview for you.",
      "They said they liked your profile.",
      "You'll hear back by next week.",
      "I'll find you something remote.",
    ]) expect(groundingOk(bad, sheet).ok, bad).toBe(false);
  });

  it("refuses a reply carrying an email address", () => {
    expect(groundingOk("Write to hiring@saltwater.example and ask.", sheet).ok).toBe(false);
  });

  it("refuses a lecture", () => {
    expect(groundingOk("Thanks for your question. ".repeat(20), sheet).ok).toBe(false);
  });

  it("allows a number that IS on the sheet", () => {
    expect(groundingOk("The listing says INR 21,00,000 - 27,00,000.", factSheet(ROLE_FULL)).ok).toBe(true);
  });

  it("a rejected reply falls back to the deterministic answer rather than to silence", async () => {
    const r = await composeReply({
      message: "How much does it pay?", job: ROLE, transcript: OFFER,
      client: say("answer", "It pays about INR 20,00,000."), // invented
    });
    expect(r.why).toMatch(/rejected/);
    expect(r.reply).toMatch(/haven't published/i);
    expect(r.reply).not.toMatch(/\d/);
  });

  it("a model that returns junk falls back, never crashes", async () => {
    const junk = { messages: { create: async () => ({ content: [{ type: "text", text: "not json at all" }] }) } };
    const r = await composeReply({ message: "Where is it based?", job: ROLE, client: junk });
    expect(r.reply).toBe("It's in Nagpur.");
  });
});

describe("the pieces", () => {
  it("a continuation is short and affirmative or negative, never a preference change", () => {
    for (const y of ["Yes", "yes please", "sure", "go ahead", "no thanks", "never mind"]) expect(isContinuation(y), y).toBe(true);
    for (const n of ["Actually make it remote only from now on", "I have 12 years of experience, not 4", "What about remote?"])
      expect(isContinuation(n), n).toBe(false);
  });

  it("the transcript carries both halves, oldest first", () => {
    const t = transcriptFrom({
      inbound: [{ received_at: "2026-08-25T10:00:00Z", body: "Yes" }],
      sends: [{ sent_at: "2026-08-25T09:00:00Z", body_text: "Reply yes and I'll put you forward." }],
    });
    expect(t.map((x) => x.who)).toEqual(["charlie", "them"]);
  });

  it("the fact sheet exposes only permitted fields", () => {
    const sheet = factSheet({ ...ROLE, _relScore: 0.93, apply_url: "https://x", description: "secret" });
    expect(sheet.text).not.toMatch(/_relScore|0\.93|apply_url|secret/);
  });
});

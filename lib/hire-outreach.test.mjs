// lib/hire-outreach.test.mjs — the outreach inbox threads: sends and replies joined per person, and the derived state.
import { describe, it, expect } from "vitest";
import { buildThreads, deriveState, activityState, IDLE_DAYS } from "./hire-outreach.mjs";

const DAY = 86_400_000;
const T0 = Date.parse("2026-09-24T10:00:00Z");
const at = (d) => new Date(T0 + d * DAY).toISOString();
const send = (email, template, d, extra = {}) => ({ email, template, dedupe_key: "pd-blr", sent_at: at(d), subject: `${template} subject`, body_text: `${template} body`, ...extra });
const reply = (email, d, body = "yes, interested") => ({ email, received_at: at(d), subject: "Re: role", body });

describe("buildThreads", () => {
  it("makes one thread per person sent the first email, with their sends and replies in order", () => {
    const threads = buildThreads({
      mandate: "pd-blr",
      sends: [send("a@x.com", "role-intent", 0), send("a@x.com", "role-questions", 2), send("b@x.com", "role-intent", 0)],
      inbound: [reply("a@x.com", 1), reply("a@x.com", 3, "20 L now, 28 L expected, 30 days")],
      pool: [{ id: 7, email: "a@x.com", full_name: "Asha Rao", current_title: "Product designer", comp_current: 20 }],
      now: T0 + 4 * DAY,
    });
    expect(threads).toHaveLength(2);
    const a = threads.find((t) => t.person.email === "a@x.com");
    expect(a.messages.map((m) => m.from)).toEqual(["charlie", "candidate", "charlie", "candidate"]);
    expect(a.person).toMatchObject({ poolId: 7, name: "Asha Rao", title: "Product designer", compCurrent: 20, compExpected: null });
    expect(a.awaitingUs).toBe(true);
  });

  it("never shows anybody as activated, even after they answer the questions", () => {
    const [t] = buildThreads({
      mandate: "pd-blr",
      sends: [send("a@x.com", "role-intent", 0), send("a@x.com", "role-questions", 1)],
      inbound: [reply("a@x.com", 0.5), reply("a@x.com", 2, "all four answers")],
      pool: [],
      now: T0 + 3 * DAY,
    });
    expect(t.activated).toBe(false);
    expect(t.statuses).toEqual(["replied", "roleSent", "answered"]);
  });

  it("keeps out other emails the same person got: other templates and other mandates' keys", () => {
    const [t] = buildThreads({
      mandate: "pd-blr",
      sends: [send("a@x.com", "role-intent", 0), send("a@x.com", "role", 1, { dedupe_key: "job-1" }), send("a@x.com", "role-intent", 1, { dedupe_key: "ae-blr" })],
      inbound: [],
      pool: [],
      now: T0 + 2 * DAY,
    });
    expect(t.messages).toHaveLength(1);
  });

  it("joins a personal answer (role-reply, keyed per entry) by recipient and date", () => {
    const [t] = buildThreads({
      mandate: "pd-blr",
      sends: [send("a@x.com", "role-intent", 1), send("a@x.com", "role-reply", 2, { dedupe_key: "a-deadline" }), send("a@x.com", "role-reply", 0, { dedupe_key: "older" })],
      inbound: [],
      pool: [],
      now: T0 + 3 * DAY,
    });
    expect(t.messages.map((m) => m.label)).toEqual(["Role outreach", "Personal answer"]);
  });

  it("says when the words of a send were not recorded instead of inventing them", () => {
    const [t] = buildThreads({ mandate: "pd-blr", sends: [send("a@x.com", "role-intent", 0, { body_text: null })], inbound: [], pool: [], now: T0 });
    expect(t.messages[0]).toMatchObject({ body: null, recorded: false });
  });

  it("refuses a mandate it does not know", () => {
    expect(() => buildThreads({ mandate: "nope", sends: [], inbound: [], pool: [], now: T0 })).toThrow(/unknown mandate/);
  });
});

describe("deriveState", () => {
  const charlie = (d, kind = "role-intent") => ({ from: "charlie", at: at(d), kind });
  const them = (d) => ({ from: "candidate", at: at(d), kind: "reply" });

  it("waiting before the idle window passes, idle after it", () => {
    expect(deriveState([charlie(0)], T0 + (IDLE_DAYS - 1) * DAY).statuses).toEqual(["waiting"]);
    expect(deriveState([charlie(0)], T0 + (IDLE_DAYS + 1) * DAY).statuses).toEqual(["idle"]);
  });

  it("a reply after the idle window re-opens the thread, with both events on the timeline", () => {
    const s = deriveState([charlie(0), them(IDLE_DAYS + 2)], T0 + 20 * DAY);
    expect(s.statuses).toEqual(["reopened"]);
    expect(s.events.map((e) => e.kind)).toEqual(["idle", "reopened"]);
    expect(s.events[1].after).toBe(1);
  });

  it("a prompt reply is replied, not re-opened", () => {
    expect(deriveState([charlie(0), them(1)], T0 + 2 * DAY).statuses).toEqual(["replied"]);
  });

  it("a status update is an event, not a status", () => {
    const s = deriveState([charlie(0), them(1), charlie(2, "role-hold")], T0 + 3 * DAY);
    expect(s.statuses).toEqual(["replied"]);
    expect(s.events.map((e) => e.kind)).toEqual(["hold"]);
  });

  it("questions sent and not answered: role details sent, no answered", () => {
    const s = deriveState([charlie(0), them(1), charlie(2, "role-questions")], T0 + 3 * DAY);
    expect(s.statuses).toEqual(["replied", "roleSent"]);
  });
});

describe("activityState", () => {
  const charlie = (d) => ({ from: "charlie", at: at(d) });
  const them = (d) => ({ from: "candidate", at: at(d) });

  it("inactive when they never replied, however recent our email", () => {
    expect(activityState([charlie(0)], T0 + DAY)).toBe("inactive");
    expect(activityState([charlie(0)], T0 + 30 * DAY)).toBe("inactive");
  });

  it("active when their message is the last one, however old", () => {
    expect(activityState([charlie(0), them(1)], T0 + 30 * DAY)).toBe("active");
  });

  it("active while our answer to them is fresh, idle once it goes unanswered for the idle window", () => {
    const msgs = [charlie(0), them(1), charlie(2)];
    expect(activityState(msgs, T0 + (2 + IDLE_DAYS - 1) * DAY)).toBe("active");
    expect(activityState(msgs, T0 + (2 + IDLE_DAYS) * DAY)).toBe("idle");
  });

  it("is on every thread buildThreads returns", () => {
    const [t] = buildThreads({ mandate: "pd-blr", sends: [send("a@x.com", "role-intent", 0)], inbound: [reply("a@x.com", 1)], pool: [], now: T0 + 2 * DAY });
    expect(t.activity).toBe("active");
  });
});

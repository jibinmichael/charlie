// lib/pieworks-activation.test.mjs — the 2call activation end to end against an in-memory store, a fake send, fake
// active roles and a fake status push. No network, no database, no email.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { activation, activationMode, replyAddress, replyKeyFrom, readReply, countStats, weekKey, payLine, yearsLine, roleLine, isTestRole, wasReferred, subjectNamesRole, ASKS_PER_PASS, MAX_PUSH_ATTEMPTS } from "./pieworks-activation.mjs";

const H = 3_600_000;
const T0 = Date.parse("2026-10-27T05:00:00Z"); // a Tuesday

/** A synthetic webhook record in the shape Pieworks sends. */
const REFERRED = {
  shortlistId: 1000201, requirementId: 900001, source: "Referral Link", experience: 2, linkedInUrl: "https://www.linkedin.com/in/ravi-menon/",
  name: "Ravi Menon", currentCompany: "Acme Edtech", emailId: "ravi.menon@example.com", phoneNo: "9000000001", countryCode: "+91",
  currentLocation: "Pune", expectedCtc: 25, noticePeriod: "30", currentCtcFixed: 9, currentCtcVariable: 0, currentCtcTotal: 9,
  aiScoreReason: '<div class="feedback-card">...</div>',
};
const ROLE = {
  id: 900001, role: "Support Engineer", clientName: "Northwind Labs", location: "Jaipur", status: "Hot",
  minCtc: 5.0, maxCtc: 8.0, minVariablePay: 0, maxVariablePay: 0, minExperience: 1.0, maxExperience: 3.0,
  okr: "Resolve customer tickets for the billing product.Write help articles for issues that repeat across accounts.",
};

function memStore() {
  const rows = new Map();
  return {
    rows,
    async insertNew(list) { let n = 0; for (const r of list) if (!rows.has(r.shortlist_id)) { rows.set(r.shortlist_id, { stage: "received", push_attempts: 0, received_at: new Date(T0).toISOString(), ...r }); n++; } return n; },
    async byReplyKey(key) { return [...rows.values()].find((r) => r.reply_key === key) || null; },
    async openByEmail(email) { return [...rows.values()].filter((r) => r.email === String(email).toLowerCase() && ["emailed", "reminded", "clarified", "closed"].includes(r.stage)); },
    async inStage(stage, limit = 500) { return [...rows.values()].filter((r) => r.stage === stage).slice(0, limit); },
    async unpushed() { return [...rows.values()].filter((r) => r.stage === "interested" && !r.pushed_at && r.push_attempts < MAX_PUSH_ATTEMPTS); },
    async all() { return [...rows.values()]; },
    async update(id, patch) { const next = { ...rows.get(id), ...patch }; rows.set(id, next); return next; },
  };
}

let S, sent, pushes, clock, pushReply, rolesReply;
const make = (over = {}) => activation({
  S, mode: "live", statsTo: "owner@example.com", now: () => clock, log: () => {},
  getResend: () => ({}),
  // like sendGuarded: one send per (email, template, dedupeKey), a repeat is a duplicate
  send: async (a) => { if (sent.some((x) => x.email === a.email && x.template === a.template && x.dedupeKey === a.dedupeKey)) return { status: "duplicate" }; sent.push(a); return { status: "sent", id: `re_${sent.length}` }; },
  fetchRoles: async () => rolesReply(),
  push: async (a) => { pushes.push(a); return pushReply(a); },
  ...over,
});

beforeEach(() => {
  process.env.CHARLIE_FROM = "Charlie <charlie@mail.example.com>";
  S = memStore(); sent = []; pushes = []; clock = T0;
  pushReply = () => ({ ok: true, result: 200, message: "Saved" });
  rolesReply = () => ({ roles: [ROLE] });
});
afterEach(() => { delete process.env.CHARLIE_FROM; });

describe("pure parts", () => {
  it("mode is off unless shadow or live", () => {
    expect(activationMode({})).toBe("off");
    expect(activationMode({ PIEWORKS_ACTIVATION: "yes" })).toBe("off");
    expect(activationMode({ PIEWORKS_ACTIVATION: " LIVE " })).toBe("live");
    expect(activationMode({ PIEWORKS_ACTIVATION: "shadow" })).toBe("shadow");
  });
  it("reply address round-trips, and never collides with apply+", () => {
    expect(replyAddress("abc123def456ghi7", "Charlie <charlie@mail.example.com>")).toBe("pieworks+abc123def456ghi7@mail.example.com");
    expect(replyKeyFrom(["start", "pieworks+ABC123def456ghi7"])).toBe("abc123def456ghi7");
    expect(replyKeyFrom(["apply+abc123def456ghi7"])).toBeNull();
    expect(replyAddress("k", "")).toBeNull();
  });
  it("reads a reply as they typed it: our quoted email is not their words", () => {
    const who = { name: "Ravi Menon", phone: "9000000001", email: "ravi.menon@example.com" };
    expect(readReply("Yes", who)).toBe("yes");
    expect(readReply("Yes, I am interested.\n\nRegards,\nRavi Menon\n9000000001", who)).toBe("yes");
    expect(readReply("Hi, yes interested\n\nOn Tue, 27 Oct 2026, Pieworks x Charlie <charlie@mail.example.com> wrote:\n> If it's not for you, reply NO", who)).toBe("yes");
    expect(readReply("No thanks", who)).toBe("no");
    expect(readReply("Not interested", who)).toBe("no");
    expect(readReply("Yes but what is the salary?", who)).toBe("unclear");
    expect(readReply("Can you call me", who)).toBe("unclear");
    expect(readReply("", who)).toBe("unclear");
  });
  it("counts emailed against moved, and only an accepted move is a conversion", () => {
    const since = T0 - 7 * 24 * H, at = new Date(T0 - H).toISOString(), old = new Date(T0 - 30 * 24 * H).toISOString();
    const rows = [
      { stage: "interested", emailed_at: at, pushed_at: at },
      { stage: "interested", emailed_at: at, pushed_at: null },
      { stage: "declined", emailed_at: old },
      { stage: "emailed", emailed_at: at },
      { stage: "closed", emailed_at: old },
      { stage: "skipped", emailed_at: null },
    ];
    expect(countStats(rows, since)).toEqual({ all: { emailed: 5, interested: 1, pending: 1, declined: 1, waiting: 1, closed: 1 }, week: { emailed: 3, interested: 1 } });
  });
  it("the week key is that week's Monday", () => {
    expect(weekKey(Date.parse("2026-10-26T23:00:00Z"))).toBe("2026-10-26");
    expect(weekKey(Date.parse("2026-11-01T10:00:00Z"))).toBe("2026-10-26");
  });
});

describe("the facts in the ask, from the shapes activeRoles returns", () => {
  it("pay: total CTC in lakh (never called fixed), the variable part within it, nothing when the numbers are missing or contradict", () => {
    expect(payLine(ROLE)).toBe("5 to 8 lakh a year (CTC)");
    // 20-25 fixed + 2-5 variable reads 22-30 in activeRoles, so the band is the total
    expect(payLine({ minCtc: 22, maxCtc: 30, maxVariablePay: 5 })).toBe("22 to 30 lakh a year (CTC), of which up to 5 lakh is variable");
    expect(payLine({ minCtc: 12, maxCtc: 12 })).toBe("12 lakh a year (CTC)");
    expect(payLine({ minCtc: 5, maxCtc: 8, maxVariablePay: 20 })).toBe("5 to 8 lakh a year (CTC)");
    for (const r of [{}, { minCtc: 10 }, { minCtc: 10, maxCtc: 5 }, { minCtc: 0, maxCtc: 5 }, { minCtc: "x", maxCtc: 5 }, { minCtc: null, maxCtc: 5 }]) expect(payLine(r)).toBe("");
  });
  it("years: their own only when inside the band, never pointing at a gap", () => {
    expect(yearsLine(ROLE, 2)).toBe("1 to 3 years (you have 2)");
    expect(yearsLine(ROLE, 2.5)).toBe("1 to 3 years (you have 2.5)");
    expect(yearsLine(ROLE, 0.5)).toBe("1 to 3 years");
    expect(yearsLine(ROLE, 9)).toBe("1 to 3 years");
    expect(yearsLine(ROLE, null)).toBe("1 to 3 years");
    expect(yearsLine({ minExperience: 0, maxExperience: 1 }, 5)).toBe("Up to 1 year");
    expect(yearsLine({ minExperience: 5, maxExperience: 2 }, 3)).toBe("");
    expect(yearsLine({}, 3)).toBe("");
  });
  it("the role line: the first sentence verbatim, or nothing when Pieworks ran sentences together or added markup", () => {
    expect(roleLine(ROLE.okr)).toBe("Resolve customer tickets for the billing product.");
    expect(roleLine("Lead a team of data engineers on the warehouse.Design reliable batch pipelines.")).toBe("Lead a team of data engineers on the warehouse.");
    expect(roleLine("Plan weekly delivery routes for the fleetTrack driver attendance across depots.")).toBe("");
    expect(roleLine("1. Vendor Onboarding &amp; Contract ReviewMeet with suppliers.")).toBe("");
    expect(roleLine("Work with tools (e.g. Zendesk) every day.")).toBe("");
    expect(roleLine("Build JavaScript apps for clients.")).toBe("");
    expect(roleLine("")).toBe("");
    expect(roleLine("testing")).toBe("");
  });
  it("Pieworks' own test listing is never a role anyone is emailed about", () => {
    expect(isTestRole({ role: "Do not upload", clientName: "Pieworks", okr: "testing" })).toBe(true);
    expect(isTestRole(ROLE)).toBe(false);
  });
  it("referred reads Pieworks' source", () => {
    expect(wasReferred({ source: "Referral Link" })).toBe(true);
    expect(wasReferred({ source: "Family" })).toBe(false);
    expect(wasReferred({})).toBe(false);
  });
});

describe("the webhook batch", () => {
  it("stores each person once, without Pieworks' AI assessment in the record, and skips a bad record by id", async () => {
    const A = make();
    const out = await A.ingest([REFERRED, { ...REFERRED }, { shortlistId: 7, requirementId: 1, name: "X" }], { idempotencyKey: "charlie-batch-1" });
    expect(out).toMatchObject({ received: 3, stored: 1, repeats: 0 });
    expect(out.skipped).toEqual([{ id: 7, issue: expect.stringMatching(/emailId/) }]);
    const row = S.rows.get(1000201);
    expect(row.email).toBe("ravi.menon@example.com");
    expect(row.candidate.aiScoreReason).toBeUndefined();
    expect(row.ai_score_reason).toMatch(/feedback-card/);
    // Pieworks re-sends the same person the next day: a no-op
    expect((await A.ingest([REFERRED])).stored).toBe(0);
  });
});

describe("a pass", () => {
  it("off does nothing at all", async () => {
    const A = make({ mode: "off" });
    await A.ingest([REFERRED]);
    expect(await A.runPass()).toMatchObject({ mode: "off", asked: 0 });
    expect(sent).toEqual([]);
  });

  it("shadow sends nothing and moves nobody", async () => {
    const A = make({ mode: "shadow" });
    await A.ingest([REFERRED]);
    await A.runPass(); await A.runPass();
    expect(sent).toEqual([]);
    expect(S.rows.get(1000201)).toMatchObject({ stage: "received", stage_reason: "shadow: would ask" });
  });

  it("live: asks once, from Pieworks x Charlie, with a reply address that finds the row", async () => {
    const A = make();
    await A.ingest([REFERRED]);
    expect(await A.runPass()).toMatchObject({ asked: 1, failed: 0 });
    await A.runPass();
    expect(sent).toHaveLength(1);
    const { payload, template, dedupeKey } = sent[0];
    expect(template).toBe("pieworks-ask");
    expect(dedupeKey).toBe("1000201:ask");
    expect(payload.from).toBe("Pieworks x Charlie <charlie@mail.example.com>");
    expect(payload.subject).toBe("Ravi, you were referred for Support Engineer at Northwind Labs");
    expect(payload.text).toContain("Pay: 5 to 8 lakh a year (CTC)");
    expect(payload.text).toContain("Experience: 1 to 3 years (you have 2)");
    expect(payload.text).toContain("The role: Resolve customer tickets for the billing product.");
    expect(payload.headers["List-Unsubscribe"]).toMatch(/unsubscribe/);
    const key = replyKeyFrom([payload.replyTo.split("@")[0]]);
    expect((await S.byReplyKey(key)).shortlist_id).toBe(1000201);
    expect(S.rows.get(1000201).stage).toBe("emailed");
  });

  it("fails closed on the roles: unread means nobody asked; a role not active or not open is skipped", async () => {
    rolesReply = () => { throw new Error("HTTP 503"); };
    const A = make();
    await A.ingest([REFERRED, { ...REFERRED, shortlistId: 2, requirementId: 999 }]);
    expect(await A.runPass()).toMatchObject({ asked: 0, failed: 1 });
    expect(S.rows.get(1000201).stage).toBe("received");
    rolesReply = () => ({ roles: [{ ...ROLE, status: "Fulfilled" }] });
    await A.runPass();
    expect(S.rows.get(1000201)).toMatchObject({ stage: "skipped", stage_reason: "the role's status is Fulfilled" });
    expect(S.rows.get(2)).toMatchObject({ stage: "skipped", stage_reason: "the role is not in Pieworks' active roles" });
    expect(sent).toEqual([]);
  });

  it("a suppressed address is skipped; a failed send stays to be tried again", async () => {
    let status = "suppressed";
    const A = make({ send: async (a) => { sent.push(a); return { status }; } });
    await A.ingest([REFERRED, { ...REFERRED, shortlistId: 2, emailId: "b@example.com" }]);
    status = "suppressed"; await A.runPass();
    expect(S.rows.get(1000201).stage).toBe("skipped");
    expect(S.rows.get(2).stage).toBe("skipped");
    const B = make({ send: async () => ({ status: "failed" }) });
    await B.ingest([{ ...REFERRED, shortlistId: 3, emailId: "c@example.com" }]);
    expect(await B.runPass()).toMatchObject({ failed: 1 });
    expect(S.rows.get(3)).toMatchObject({ stage: "received", stage_reason: "the ask was not sent: failed" });
  });

  it("never emails anyone on Pieworks' test listing", async () => {
    rolesReply = () => ({ roles: [{ ...ROLE, role: "Do not upload", clientName: "Pieworks" }] });
    const A = make();
    await A.ingest([REFERRED]);
    await A.runPass();
    expect(sent).toEqual([]);
    expect(S.rows.get(1000201)).toMatchObject({ stage: "skipped", stage_reason: "Pieworks' test listing" });
  });

  it("asks at most a capped number per pass", async () => {
    const A = make();
    await A.ingest(Array.from({ length: ASKS_PER_PASS + 5 }, (_, i) => ({ ...REFERRED, shortlistId: 100 + i, emailId: `p${i}@example.com` })));
    expect((await A.runPass()).asked).toBe(ASKS_PER_PASS);
    expect((await A.runPass()).asked).toBe(5);
  });

  it("one reminder at 48 hours, closed 48 hours after that, nothing more", async () => {
    const A = make();
    await A.ingest([REFERRED]);
    await A.runPass();
    clock = T0 + 47 * H; await A.runPass();
    expect(sent.map((s) => s.template)).toEqual(["pieworks-ask"]);
    clock = T0 + 49 * H; await A.runPass();
    expect(S.rows.get(1000201).stage).toBe("reminded");
    clock = T0 + 98 * H; await A.runPass();
    clock = T0 + 200 * H; await A.runPass();
    expect(sent.map((s) => s.template)).toEqual(["pieworks-ask", "pieworks-reminder"]);
    expect(S.rows.get(1000201)).toMatchObject({ stage: "closed", stage_reason: "no reply" });
  });
});

describe("a reply", () => {
  async function asked(A) {
    await A.ingest([REFERRED]);
    await A.runPass();
    return replyKeyFrom([sent[0].payload.replyTo.split("@")[0]]);
  }

  it("YES moves them to interested in Pieworks, then thanks them once Pieworks accepted", async () => {
    const A = make();
    const key = await asked(A);
    expect(await A.onReply({ key, from: "Ravi.Menon@example.com", body: "Yes" })).toBe("yes: moved to interested");
    expect(pushes).toEqual([{ requirementId: 900001, shortlistId: 1000201 }]);
    expect(S.rows.get(1000201)).toMatchObject({ stage: "interested", reply_read: "yes" });
    expect(S.rows.get(1000201).pushed_at).toBeTruthy();
    expect(sent.map((s) => s.template)).toEqual(["pieworks-ask", "pieworks-noted"]);
    // a second yes changes nothing and moves nothing again
    expect(await A.onReply({ key, from: "ravi.menon@example.com", body: "yes" })).toBe("noted only: already interested");
    expect(pushes).toHaveLength(1);
  });

  it("a yes Pieworks does not accept is retried by the sweep, never thanked early, and stops after the cap", async () => {
    pushReply = () => ({ ok: false, result: 300, message: "error" });
    const A = make();
    const key = await asked(A);
    expect(await A.onReply({ key, from: "ravi.menon@example.com", body: "yes please" })).toMatch(/not accepted it yet/);
    for (let i = 0; i < 10; i++) await A.runPass();
    expect(pushes).toHaveLength(MAX_PUSH_ATTEMPTS);
    expect(sent.map((s) => s.template)).toEqual(["pieworks-ask"]);
    expect(S.rows.get(1000201).pushed_at).toBeFalsy();
  });

  it("a thrown push counts as a try, never as a move", async () => {
    pushReply = () => { throw new Error("HTTP 500"); };
    const A = make();
    const key = await asked(A);
    await A.onReply({ key, from: "ravi.menon@example.com", body: "Yes" });
    expect(S.rows.get(1000201)).toMatchObject({ stage: "interested", push_attempts: 1 });
    expect(S.rows.get(1000201).pushed_at).toBeFalsy();
  });

  it("NO stops everything and moves nothing", async () => {
    const A = make();
    const key = await asked(A);
    expect(await A.onReply({ key, from: "ravi.menon@example.com", body: "No, not interested" })).toBe("no: stopped");
    clock = T0 + 60 * H; await A.runPass();
    expect(pushes).toEqual([]);
    expect(sent.map((s) => s.template)).toEqual(["pieworks-ask"]);
  });

  it("an unclear reply is asked once more plainly; a second unclear one sends nothing; a yes after it still moves", async () => {
    const A = make();
    const key = await asked(A);
    expect(await A.onReply({ key, from: "ravi.menon@example.com", body: "What is the salary?" })).toBe("unclear: clarify sent");
    expect(await A.onReply({ key, from: "ravi.menon@example.com", body: "Please call me" })).toBe("unclear again: recorded, nothing sent");
    expect(sent.map((s) => s.template)).toEqual(["pieworks-ask", "pieworks-clarify"]);
    expect(pushes).toEqual([]);
    expect(await A.onReply({ key, from: "ravi.menon@example.com", body: "Yes" })).toBe("yes: moved to interested");
  });

  it("a reply sent to the From address (Reply-To ignored) is still theirs when the subject names the role; nothing else is", async () => {
    const A = make();
    const key = await asked(A);
    expect(await A.keyForReply({ from: "ravi.menon@example.com", subject: "Re: Ravi, you were referred for Support Engineer at Northwind Labs" })).toBe(key);
    expect(await A.keyForReply({ from: "ravi.menon@example.com", subject: "Re: your role this week" })).toBeNull();
    expect(await A.keyForReply({ from: "someone@else.com", subject: "Re: Support Engineer at Northwind Labs" })).toBeNull();
    await A.onReply({ key, from: "ravi.menon@example.com", body: "No thanks" });
    expect(await A.keyForReply({ from: "ravi.menon@example.com", subject: "Re: Support Engineer at Northwind Labs" })).toBeNull();
  });

  it("subjectNamesRole survives the dash cleanSubject turns into a comma", () => {
    expect(subjectNamesRole("Re: Still open: Growth Lead, B2B Sales at Acme", "Growth Lead – B2B Sales")).toBe(true);
    expect(subjectNamesRole("Re: hello", "Growth Lead – B2B Sales")).toBe(false);
    expect(subjectNamesRole("Re: anything", "")).toBe(false);
  });

  it("only their own address is read", async () => {
    const A = make();
    const key = await asked(A);
    expect(await A.onReply({ key, from: "someone@else.com", body: "Yes" })).toMatch(/^ignored/);
    expect(pushes).toEqual([]);
    expect(S.rows.get(1000201).stage).toBe("emailed");
  });

  it("a late yes after the thread closed still moves them", async () => {
    const A = make();
    const key = await asked(A);
    clock = T0 + 49 * H; await A.runPass();
    clock = T0 + 98 * H; await A.runPass();
    expect(S.rows.get(1000201).stage).toBe("closed");
    expect(await A.onReply({ key, from: "ravi.menon@example.com", body: "Yes" })).toBe("yes: moved to interested");
  });

  it("with the flag off, a reply is recorded but nothing is sent or moved", async () => {
    const live = make();
    const key = await asked(live);
    const off = make({ mode: "off" });
    await off.onReply({ key, from: "ravi.menon@example.com", body: "Yes" });
    expect(pushes).toEqual([]);
    expect(sent).toHaveLength(1);
    expect(S.rows.get(1000201).stage).toBe("interested");
  });
});

describe("the weekly stats email", () => {
  it("goes to the owner on Monday morning, once a week, never on other days", async () => {
    const A = make();
    await A.ingest([REFERRED]);
    await A.runPass();
    expect(sent.some((s) => s.template === "pieworks-stats")).toBe(false);
    clock = Date.parse("2026-11-02T05:00:00Z"); // Monday
    await A.runPass();
    const st = sent.filter((s) => s.template === "pieworks-stats");
    expect(st).toHaveLength(1);
    expect(st[0]).toMatchObject({ email: "owner@example.com", dedupeKey: "2026-11-02" });
    // the ask went out on Tuesday 27 October, inside the seven days before this Monday
    expect(st[0].payload.subject).toBe("Pieworks: 1 emailed, 0 moved to interested this week");
    clock += 2 * H; await A.runPass();
    expect(sent.filter((s) => s.template === "pieworks-stats")).toHaveLength(1);
  });
});

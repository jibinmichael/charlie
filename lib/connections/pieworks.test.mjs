// lib/connections/pieworks.test.mjs — the Pieworks client against sample payloads in the API's shape. No network:
// every request goes to a fake fetch, and any live host is refused by construction.
import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { pieworksConfig, listActiveRoles, submitReferral, markInterested, verifyWebhookSignature } from "./pieworks.mjs";

// A synthetic role in the shape the activeRoles endpoint returns.
const SAMPLE_ROLE = {
  maxCtc: 8.0, offeredCandidates: null, role: "Support Engineer",
  mandatorySkill: "1-3 years in customer supportGood written English & ticket triage skillsWorking knowledge of a helpdesk tool (e.g., Zendesk)",
  clientName: "Northwind Labs", minVariablePay: 0.0, sentToClients: 0, createdOn: "2026-01-05", interviews: 0, isPodMember: false, toCall: 0,
  okr: "Resolve customer tickets for the billing product.", jobFamily: "Support (L2)", minCtc: 5.0, id: 1000101, earnUpto: "10000",
  totalDiscoveries: 0, activeFrom: "2026-01-05", clientLogo: "uploads/clients/1000001/dp/logo.png", maxVariablePay: 0.0,
  maxExperience: 3.0, noOfVaccancyPending: 1, location: "Pune", interested: 0, remarks: null, status: "Hot", minExperience: 1.0,
};
const page = (roles, total) => ({ result: 200, message: `Showing results`, dataObject: { totalRows: total, rows: roles.length }, dataArray: roles, dataArray2: null });
const reply = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

// A test host (*.test), which the client allows under Vitest.
const CFG = pieworksConfig({ PIEWORKS_API_BASE: "https://pieworks.test/mainservice", PIEWORKS_API_KEY: "k-test", PIEWORKS_REFERRAL_CODE: "REF123" });

const CANDIDATE = {
  experience: 3, linkedInUrl: "https://linkedin.com/in/someone", name: "Asha Rao", currentCompany: "Acme", emailId: "asha@example.com",
  phoneNo: "9876543210", countryCode: "+91", currentLocation: "Bengaluru", currentCtcFixed: 3, currentCtcVariable: 0, currentCtcTotal: 3,
  expectedCtc: 4, noticePeriod: "15", justification: "Resolved billing tickets end to end and wrote the help articles for two releases.",
};
const PDF = { bytes: new Uint8Array([37, 80, 68, 70]), filename: "asha-rao-cv.pdf" };

describe("configuration", () => {
  it("refuses to run with anything unset, and never reaches the real host under test", async () => {
    expect(pieworksConfig({}).ok).toBe(false);
    expect(pieworksConfig({ PIEWORKS_API_BASE: "https://x.test", PIEWORKS_API_KEY: "k" }).reason).toMatch(/PIEWORKS_REFERRAL_CODE/);
    const real = pieworksConfig({ PIEWORKS_API_BASE: "https://partner-api.example.com/mainservice", PIEWORKS_API_KEY: "k", PIEWORKS_REFERRAL_CODE: "R" });
    let called = 0;
    await expect(listActiveRoles({ cfg: real, fetchImpl: async () => { called++; } })).rejects.toThrow(/real Pieworks host/);
    await expect(submitReferral({ cfg: real, fetchImpl: async () => { called++; }, roleId: 1, candidate: CANDIDATE, cv: PDF })).rejects.toThrow(/real Pieworks host/);
    expect(called).toBe(0);
  });
});

describe("active roles", () => {
  it("reads every page with the key, and parses the doc's sample role", async () => {
    const seen = [];
    const fetchImpl = async (url, init) => { seen.push({ url, auth: init.headers.Authorization }); return reply(url.includes("pageNum=1") ? page([SAMPLE_ROLE], 2) : page([{ ...SAMPLE_ROLE, id: 1000102 }], 2)); };
    const out = await listActiveRoles({ cfg: CFG, fetchImpl, pageSize: 1 });
    expect(out.roles.map((r) => r.id)).toEqual([1000101, 1000102]);
    expect(out.roles[0]).toMatchObject({ clientName: "Northwind Labs", status: "Hot", minExperience: 1, maxExperience: 3, maxCtc: 8 });
    expect(seen.map((s) => s.auth)).toEqual(["k-test", "k-test"]);
    expect(seen[0].url).toBe("https://pieworks.test/mainservice/open/activeRoles?pageNum=1&pageSize=1");
  });

  it("skips a malformed role by id and keeps the rest", async () => {
    const bad = { ...SAMPLE_ROLE, id: 7, clientName: "" };
    const out = await listActiveRoles({ cfg: CFG, fetchImpl: async () => reply(page([SAMPLE_ROLE, bad], 2)) });
    expect(out.roles.map((r) => r.id)).toEqual([1000101]);
    expect(out.skipped).toEqual([{ id: 7, issue: expect.stringMatching(/clientName/) }]);
  });

  it("stops on a broken envelope or a non-200 result instead of returning a partial list", async () => {
    await expect(listActiveRoles({ cfg: CFG, fetchImpl: async () => reply({ nope: true }) })).rejects.toThrow(/page 1/);
    await expect(listActiveRoles({ cfg: CFG, fetchImpl: async () => reply({ result: 401, message: "Unauthorised", dataObject: null, dataArray: null }) })).rejects.toThrow(/result 401/);
    await expect(listActiveRoles({ cfg: CFG, fetchImpl: async () => reply({}, 500) })).rejects.toThrow(/HTTP 500/);
  });
});

describe("submit a referral", () => {
  it("posts multipart with the candidate JSON and the PDF to the role's URL, with the referral code", async () => {
    let sent;
    const fetchImpl = async (url, init) => { sent = { url, init }; return reply({ result: 200, message: "Saved", dataObject: null, dataArray: null, dataArray2: null }); };
    expect(await submitReferral({ cfg: CFG, fetchImpl, roleId: 1000101, candidate: CANDIDATE, cv: PDF })).toEqual({ status: "sent", result: 200, message: "Saved" });
    expect(sent.url).toBe("https://pieworks.test/mainservice/recruitment2/open/submitReferral/1000101");
    expect(sent.init.signal).toBeInstanceOf(AbortSignal);          // a submit never hangs
    const part = JSON.parse(await sent.init.body.get("candidate").text());
    expect(part).toMatchObject({ ...CANDIDATE, referralCode: "REF123", justifications: CANDIDATE.justification });
    expect(sent.init.body.get("candidate").type).toBe("application/json");
    expect(sent.init.body.get("cv").type).toBe("application/pdf");
    expect(sent.init.body.get("cv").name).toBe("asha-rao-cv.pdf");
  });

  it("reads 300 'already discovered' as a duplicate, and any other 300 as refused", async () => {
    const dup = async () => reply({ result: 300, message: "This candidate is already discovered for this role" });
    expect((await submitReferral({ cfg: CFG, fetchImpl: dup, roleId: 1, candidate: CANDIDATE, cv: PDF })).status).toBe("duplicate");
    const other = async () => reply({ result: 300, message: "Role is closed" });
    expect(await submitReferral({ cfg: CFG, fetchImpl: other, roleId: 1, candidate: CANDIDATE, cv: PDF })).toEqual({ status: "refused", result: 300, message: "Role is closed" });
  });

  it.each([
    ["no expected pay", { expectedCtc: undefined }],
    ["no LinkedIn", { linkedInUrl: "" }],
    ["a phone with letters", { phoneNo: "98765 4321x" }],
    ["no country code", { countryCode: "91" }],
    ["a total that is not fixed plus variable", { currentCtcTotal: 9 }],
    ["notice in words", { noticePeriod: "two weeks" }],
  ])("sends nothing when the candidate has %s", async (_, over) => {
    let called = 0;
    await expect(submitReferral({ cfg: CFG, fetchImpl: async () => { called++; return reply({ result: 200 }); }, roleId: 1, candidate: { ...CANDIDATE, ...over }, cv: PDF })).rejects.toThrow(/not complete/);
    expect(called).toBe(0);
  });

  it("sends nothing without a PDF CV or a role id", async () => {
    const f = async () => reply({ result: 200 });
    await expect(submitReferral({ cfg: CFG, fetchImpl: f, roleId: 1, candidate: CANDIDATE, cv: { bytes: new Uint8Array([1]), filename: "cv.docx" } })).rejects.toThrow(/PDF/);
    await expect(submitReferral({ cfg: CFG, fetchImpl: f, roleId: 0, candidate: CANDIDATE, cv: PDF })).rejects.toThrow(/role id/);
  });
});

describe("markInterested (2call to interested)", () => {
  it("sends only the shortlist part with status 2, to the requirement's URL", async () => {
    let seen;
    const out = await markInterested({ cfg: CFG, requirementId: 900001, shortlistId: 1000201, fetchImpl: async (url, init) => { seen = { url, init }; return reply({ result: 200, message: "Saved" }); } });
    expect(out).toEqual({ ok: true, result: 200, message: "Saved" });
    expect(seen.url).toBe("https://pieworks.test/mainservice/recruitment2/open/submitReferral/900001");
    const keys = [...seen.init.body.keys()];
    expect(keys).toEqual(["shortlist"]);
    const part = seen.init.body.get("shortlist");
    expect(part.type).toBe("application/json");
    expect(JSON.parse(await part.text())).toEqual({ id: 1000201, status: { id: 2, name: "interested" } });
  });
  it("a 300 is not ok; a missing id or the real host under test is refused before any request", async () => {
    expect((await markInterested({ cfg: CFG, requirementId: 1, shortlistId: 2, fetchImpl: async () => reply({ result: 300, message: "nope" }) })).ok).toBe(false);
    let called = 0;
    await expect(markInterested({ cfg: CFG, requirementId: 0, shortlistId: 2, fetchImpl: async () => { called++; } })).rejects.toThrow(/requirement id/);
    await expect(markInterested({ cfg: CFG, requirementId: 1, shortlistId: 0, fetchImpl: async () => { called++; } })).rejects.toThrow();
    const real = pieworksConfig({ PIEWORKS_API_BASE: "https://partner-api.example.com/mainservice", PIEWORKS_API_KEY: "k", PIEWORKS_REFERRAL_CODE: "R" });
    await expect(markInterested({ cfg: real, requirementId: 1, shortlistId: 2, fetchImpl: async () => { called++; } })).rejects.toThrow(/real Pieworks host/);
    expect(called).toBe(0);
  });
});

describe("verifyWebhookSignature", () => {
  const secret = "s3cret";
  const body = '[{"shortlistId":1}]';
  const sign = (t, b = body, k = secret) => `t=${t},v1=${createHmac("sha256", k).update(`${t}.${b}`).digest("hex")}`;
  const now = 1_800_000_000;
  it("accepts a fresh, correct signature over the raw body", () => {
    expect(verifyWebhookSignature({ secret, header: sign(now), rawBody: Buffer.from(body), nowS: now + 10 })).toBe(true);
  });
  it("refuses a changed body, a wrong secret, a stale or future t, a bad header, or no secret", () => {
    expect(verifyWebhookSignature({ secret, header: sign(now), rawBody: body + " ", nowS: now })).toBe(false);
    expect(verifyWebhookSignature({ secret, header: sign(now, body, "other"), rawBody: body, nowS: now })).toBe(false);
    expect(verifyWebhookSignature({ secret, header: sign(now - 301), rawBody: body, nowS: now })).toBe(false);
    expect(verifyWebhookSignature({ secret, header: sign(now + 301), rawBody: body, nowS: now })).toBe(false);
    expect(verifyWebhookSignature({ secret, header: "v1=abc", rawBody: body, nowS: now })).toBe(false);
    expect(verifyWebhookSignature({ secret, header: undefined, rawBody: body, nowS: now })).toBe(false);
    expect(verifyWebhookSignature({ secret: "", header: sign(now, body, ""), rawBody: body, nowS: now })).toBe(false);
  });
});

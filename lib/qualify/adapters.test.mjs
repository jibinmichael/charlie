// lib/qualify/adapters.test.mjs — what the Setup card says a Pieworks hand-off carries is every field of the
// candidate schema the hand-off is validated against, never a list that drifts from it.
import { describe, it, expect } from "vitest";
import { PieworksCandidate } from "../schemas/pieworks.mjs";
import { PIEWORKS_NEEDS_BY_FIELD, ADAPTERS } from "./adapters.mjs";

describe("Pieworks: the hand-off's needs", () => {
  it("names every field the candidate schema requires, plus the CV", () => {
    const r = PieworksCandidate.safeParse({});
    const required = [...new Set(r.error.issues.map((i) => String(i.path[0])).filter(Boolean))];
    expect(required.length).toBeGreaterThan(10);
    for (const k of required) expect(PIEWORKS_NEEDS_BY_FIELD, `${k} has no plain-words name`).toHaveProperty(k);
    expect(ADAPTERS.pieworks.needs).toContain("CV as a PDF");
  });
});

describe("email: a destination, never a source", () => {
  const conn = (to) => ({ destination: { type: "email", to, name: "Meera" } });
  const cv = { bytes: new Uint8Array([1]), filename: "cv.pdf" };
  const pack = ADAPTERS.email.toCandidate({ name: { value: "Asha" }, emailId: { value: "a@x.com" } }, "note", { facts: ["Name: Asha"] });

  it("the pack is the confirmed lines it is given, and it refuses without them", () => {
    expect(pack).toEqual({ name: "Asha", email: "a@x.com", facts: ["Name: Asha"], justification: "note" });
    expect(() => ADAPTERS.email.toCandidate({}, "note")).toThrow(/confirmed facts/);
  });
  it("lists no roles", async () => {
    await expect(ADAPTERS.email.listRoles(conn("h@x.com"))).rejects.toThrow(/destination, not a source/);
  });
  it("sends only through the send it is handed, to the contact on the connection", async () => {
    const calls = [];
    const r = await ADAPTERS.email.submit(conn("h@x.com"), { candidate: pack, cv, send: async (o) => { calls.push(o); return { status: "sent" }; } });
    expect(r).toMatchObject({ status: "sent", to: "h@x.com" });
    expect(calls).toEqual([{ to: "h@x.com", contact: "Meera", candidate: pack, cv }]);
  });
  it.each([
    ["no contact", conn(""), { status: "sent" }, true, /hiring contact/],
    ["a contact that is not an address", conn("h at x"), { status: "sent" }, true, /hiring contact/],
    ["no send", conn("h@x.com"), null, true, /no send/],
    ["no CV", conn("h@x.com"), { status: "sent" }, false, /no CV/],
    ["a suppressed contact", conn("h@x.com"), { status: "suppressed" }, true, /not sent: suppressed/],
    ["a failed send", conn("h@x.com"), { status: "failed" }, true, /not sent: failed/],
  ])("%s throws, so the agent never counts it as handed off", async (_, c, result, withCv, msg) => {
    const send = result ? async () => result : undefined;
    await expect(ADAPTERS.email.submit(c, { candidate: pack, cv: withCv ? cv : null, send })).rejects.toThrow(msg);
  });
  it("a pack already claimed is never assumed sent or unsent: it throws for a person", async () => {
    await expect(ADAPTERS.email.submit(conn("h@x.com"), { candidate: pack, cv, send: async () => ({ status: "duplicate" }) })).rejects.toThrow(/already started/);
  });
});

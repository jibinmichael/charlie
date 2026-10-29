// server/outreach.test.mjs — the outreach inbox API: dark with the workspace flag, one secret, an
// unknown mandate refused, one mandate's threads read with the CV flag, the CV and
// attachments served only for outreach recipients, and nothing written or sent.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import express from "express";
import { readFileSync } from "node:fs";
import { outreachRouter } from "./outreach.ts";

const SECRET = "test-dashboard-secret-0123456789abcdef";

/** A read-only fake Supabase: select with eq / in / gte, and Storage download. Any write fails the test. */
function fakeDb(tables, files = {}) {
  const calls = [];
  const from = (table) => {
    const filters = [];
    const q = {
      select: () => q,
      eq: (k, v) => { filters.push((r) => r[k] === v); return q; },
      in: (k, vs) => { filters.push((r) => vs.includes(r[k])); return q; },
      gte: (k, v) => { filters.push((r) => r[k] >= v); return q; },
      insert: () => { throw new Error(`write to ${table}`); }, update: () => { throw new Error(`write to ${table}`); },
      upsert: () => { throw new Error(`write to ${table}`); }, delete: () => { throw new Error(`write to ${table}`); },
      then: (res, rej) => { calls.push(table); return Promise.resolve({ data: (tables[table] || []).filter((r) => filters.every((f) => f(r))), error: null }).then(res, rej); },
    };
    return q;
  };
  const storage = { from: (bucket) => ({
    download: async (path) => { calls.push(`storage:${bucket}`); const t = files[`${bucket}/${path}`]; return t == null ? { data: null, error: { message: "not found" } } : { data: new Blob([t]), error: null }; },
    list: async (_dir, { search } = {}) => { calls.push(`storage:${bucket}:list`); return { data: Object.keys(files).filter((k) => k === `${bucket}/${search}`).map((k) => ({ name: k.slice(bucket.length + 1) })), error: null }; },
    upload: () => { throw new Error("upload"); }, remove: () => { throw new Error("remove"); },
  }) };
  return { from, storage, calls };
}

/** Resend, faked: one received email with one PDF; any other email id is gone (404). */
const PDF = Buffer.from("%PDF-1.4 fake");
const fakeFetch = async (url, init) => {
  if (url === "https://files.example/cv.pdf") return new Response(PDF, { status: 200 });
  if (!String(init?.headers?.authorization || "").startsWith("Bearer re_")) return new Response("{}", { status: 401 });
  if (url === "https://api.resend.com/emails/receiving/em-1/attachments")
    return Response.json({ object: "list", has_more: false, data: [{ id: "att-1", filename: "Asha CV.pdf", content_type: "application/pdf", size: PDF.length, download_url: "https://files.example/cv.pdf", expires_at: "2026-10-05T07:00:00Z" }] });
  return new Response("{}", { status: 404 });
};

let server, base, db;
const api = (path, auth = `Bearer ${SECRET}`) => fetch(`${base}${path}`, { headers: { authorization: auth } });

beforeAll(async () => {
  db = fakeDb({
    sent_emails: [
      { email: "a@x.com", template: "role-intent", dedupe_key: "pd-blr", subject: "A role", body_text: "Hi", sent_at: "2026-09-24T10:00:00Z" },
      { email: "a@x.com", template: "role", dedupe_key: "job-1", subject: "Other", body_text: "Not this", sent_at: "2026-09-25T10:00:00Z" },
    ],
    inbound_messages: [
      { email: "a@x.com", email_id: "em-1", subject: "Re: A role", body: "Yes, interested", received_at: "2026-09-24T12:00:00Z" },
      { email: "outsider@x.com", email_id: "em-9", subject: "Hello", body: "Not an outreach reply", received_at: "2026-09-24T12:00:00Z" },
    ],
    talent_pool: [{ id: 9, email: "a@x.com", full_name: "Asha Rao", current_company: "Made For Humans", top_skills: ["Figma"] }],
  }, { "resumes/a@x.com.txt": "Asha Rao. Product designer.", "resumes/outsider@x.com.txt": "Not served" });
  const app = express();
  app.use(outreachRouter({ db, log: () => {}, now: () => Date.parse("2026-09-25T00:00:00Z"), fetchImpl: fakeFetch }));
  await new Promise((res) => { server = app.listen(0, () => res()); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => server?.close());
beforeEach(() => { process.env.HIRING_WORKSPACE = "on"; process.env.VOICE_DASHBOARD_SECRET = SECRET; process.env.RESEND_READ_KEY = "re_test_read"; });

describe("mounted on the live server", () => {
  it("charlie-remote.ts mounts the outreach API beside the hiring workspace (dark until HIRING_WORKSPACE is on)", () => {
    const src = readFileSync(new URL("./charlie-remote.ts", import.meta.url), "utf8");
    expect(src).toMatch(/import \{ outreachRouter, runPursuitSync \} from "\.\/outreach\.ts"/);
    expect(src).toMatch(/app\.use\(outreachRouter\(\)\);/);
    // the saved lifecycle is kept in step every 15 minutes (lib/hire-pursuit-sync.mjs)
    expect(src).toMatch(/setInterval\(\(\) => \{ runPursuitSync\(\)[^\n]*15 \* 60 \* 1000\)/);
  });
});

describe("gate", () => {
  it("404 while the workspace flag is off, 503 without a secret, 401 with the wrong one", async () => {
    process.env.HIRING_WORKSPACE = "off";
    expect((await api("/outreach/api/mandates")).status).toBe(404);
    process.env.HIRING_WORKSPACE = "on"; process.env.VOICE_DASHBOARD_SECRET = "";
    expect((await api("/outreach/api/mandates")).status).toBe(503);
    process.env.VOICE_DASHBOARD_SECRET = SECRET;
    expect((await api("/outreach/api/mandates", "Bearer nope")).status).toBe(401);
    expect((await api("/outreach/api/cv/a@x.com", "Bearer nope")).status).toBe(401);
  });
});

describe("reading", () => {
  it("lists the mandates and refuses an unknown one", async () => {
    // every configured outreach mandate is listed, in config order
    expect((await (await api("/outreach/api/mandates")).json()).mandates.map((m) => m.key)).toEqual(["pd-blr", "spd", "ae-blr", "j2ee-blr"]);
    expect((await api("/outreach/api/mandates/nope")).status).toBe(404);
  });

  it("returns one mandate's threads: the person, their company, the CV flag, their emails both ways, nobody activated", async () => {
    db.calls.length = 0;
    const d = await (await api("/outreach/api/mandates/pd-blr")).json();
    expect(d).toMatchObject({ key: "pd-blr", role: "Product Designer" });
    expect(d.threads).toHaveLength(1);
    const t = d.threads[0];
    expect(t.person).toMatchObject({ name: "Asha Rao", hasCv: true, companyInfo: null, previousCompanyInfo: null });
    expect(t.messages.map((m) => m.body)).toEqual(["Hi", "Yes, interested"]);
    expect(t.messages[1].emailId).toBe("em-1");
    expect(t.activated).toBe(false);
    // suppressions is read too, for the lifecycle stage (an unsubscribed person is opted out)
    expect(new Set(db.calls)).toEqual(new Set(["sent_emails", "inbound_messages", "talent_pool", "storage:resumes:list", "suppressions"]));
    // a reply nobody has marked, with no human yes on record: a reply to read, never a guessed interest
    expect(t.lifecycle).toMatchObject({ stage: "Reply to read", owner: "operator", engagement: "AWAITING_REPLY", consentToIntroduce: "NOT_REQUESTED", shadow: true });
  });

  it("serves the CV text for an outreach recipient, and nobody else's", async () => {
    const r = await api("/outreach/api/cv/a@x.com");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-disposition")).toMatch(/attachment; filename=".*CV \(text\)\.txt"/);
    expect(await r.text()).toBe("Asha Rao. Product designer.");
    expect((await api("/outreach/api/cv/outsider@x.com")).status).toBe(404);
  });

  it("lists and downloads an attachment on a recipient's reply; refuses other mail; says nothing for an email Resend no longer has", async () => {
    expect((await (await api("/outreach/api/messages/em-1/attachments")).json()).attachments).toEqual([{ id: "att-1", filename: "Asha CV.pdf", contentType: "application/pdf", size: PDF.length }]);
    const f = await api("/outreach/api/messages/em-1/attachments/att-1");
    expect(f.status).toBe(200);
    expect(f.headers.get("content-type")).toMatch(/application\/pdf/);
    expect(Buffer.from(await f.arrayBuffer()).equals(PDF)).toBe(true);
    expect((await api("/outreach/api/messages/em-9/attachments")).status).toBe(404);
    expect((await api("/outreach/api/messages/em-1/attachments/nope")).status).toBe(404);
  });

  it("an attachment list that does not match the schema is read as none, not guessed at", async () => {
    const app = express();
    const bad = async () => Response.json({ data: [{ filename: "no id" }] });
    app.use(outreachRouter({ db, log: () => {}, fetchImpl: bad }));
    const s = await new Promise((res) => { const x = app.listen(0, () => res(x)); });
    const r = await fetch(`http://127.0.0.1:${s.address().port}/outreach/api/messages/em-1/attachments`, { headers: { authorization: `Bearer ${SECRET}` } });
    expect((await r.json()).attachments).toEqual([]);
    s.close();
  });

  it("the router and its readers never send, write or upload", () => {
    const src = ["./outreach.ts", "../lib/hire-outreach.mjs", "../lib/outreach-files.mjs"].map((p) => readFileSync(new URL(p, import.meta.url), "utf8")).join("\n");
    expect(src).not.toMatch(/emails\.send\(|sendGuarded\(|\.(insert|update|upsert|delete|upload|remove)\(/);
  });
});

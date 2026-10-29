// lib/http-guards.test.mjs — the server's security headers and CORS rule (lib/http-guards.mjs), run on a real
// Express app on a local port. No network beyond 127.0.0.1.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import { readFileSync } from "node:fs";
import { securityHeaders, cors, hireOriginsOf } from "./http-guards.mjs";

const SITE = "https://app.example.com";
let server, base;

beforeAll(async () => {
  const app = express();
  app.disable("x-powered-by");
  app.use(securityHeaders());
  app.use(cors({ hireOrigins: hireOriginsOf(` ${SITE}/ , https://other.example `) }));
  for (const p of ["/agents/api/x", "/outreach/api/x", "/pool-stats"]) app.get(p, (_req, res) => res.json({ ok: true }));
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => server?.close());

const get = (path, origin, method = "GET") => fetch(`${base}${path}`, { method, headers: origin ? { origin } : {} });

describe("security headers", () => {
  it("every reply carries them, and no framework banner", async () => {
    const r = await get("/pool-stats");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("x-frame-options")).toBe("DENY");
    expect(r.headers.get("referrer-policy")).toBe("no-referrer");
    expect(r.headers.get("strict-transport-security")).toMatch(/max-age=31536000/);
    expect(r.headers.get("x-powered-by")).toBeNull();
  });
});

describe("CORS", () => {
  it("the hiring API answers only a listed origin", async () => {
    for (const p of ["/agents/api/x", "/outreach/api/x"]) {
      expect((await get(p, SITE)).headers.get("access-control-allow-origin")).toBe(SITE);
      expect((await get(p, "https://evil.example")).headers.get("access-control-allow-origin")).toBeNull();
      expect((await get(p, "https://evil.example", "OPTIONS")).headers.get("access-control-allow-origin")).toBeNull();
      expect((await get(p, "https://evil.example")).headers.get("vary")).toMatch(/Origin/);
    }
  });
  it("with no origins configured, the hiring API answers no browser (fail closed)", () => {
    expect(hireOriginsOf(undefined).size).toBe(0);
    expect(hireOriginsOf("").size).toBe(0);
  });
  it("other routes keep the open CORS the landing page needs", async () => {
    expect((await get("/pool-stats", "https://example.com")).headers.get("access-control-allow-origin")).toBe("https://example.com");
    expect((await get("/pool-stats")).headers.get("access-control-allow-origin")).toBe("*");
  });
  it("the live server mounts both, ahead of every router", () => {
    const src = readFileSync(new URL("../server/charlie-remote.ts", import.meta.url), "utf8");
    const at = (s) => src.indexOf(s);
    expect(at('app.disable("x-powered-by")')).toBeGreaterThan(0);
    expect(at("app.use(securityHeaders())")).toBeGreaterThan(0);
    expect(at("app.use(cors({ hireOrigins: hireOriginsOf(process.env.HIRE_APP_ORIGINS) }))")).toBeGreaterThan(0);
    expect(at("app.use(cors(")).toBeLessThan(at("app.use(agentsRouter("));
    expect(at("app.use(securityHeaders())")).toBeLessThan(at("app.use(voiceRouter("));
    expect(src).not.toMatch(/Access-Control-Allow-Origin", req\.headers\.origin \|\| "\*"/);
  });
});

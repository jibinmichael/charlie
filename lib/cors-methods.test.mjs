// lib/cors-methods.test.mjs — every HTTP method a server route answers is allowed by the server's CORS rules.
// The workspace calls the server from the browser; a method missing from Access-Control-Allow-Methods is refused
// by the browser before it reaches the server and leaves no server log, while the same request works from a terminal.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";

// The CORS rule lives in lib/http-guards.mjs; lib/http-guards.test.mjs checks the server still mounts it.
const remote = readFileSync(new URL("./http-guards.mjs", import.meta.url), "utf8");
const allowed = (/Access-Control-Allow-Methods",\s*"([^"]+)"/.exec(remote)?.[1] ?? "").split(/\s*,\s*/).map((m) => m.toUpperCase());

// The routers the dashboard calls from the browser: agents, outreach and voice.
const WORKSPACE = ["agents.ts", "outreach.ts", "voice.ts"];

describe("CORS allows every method the workspace's routes use", () => {
  it("each route's method in the workspace servers is in Access-Control-Allow-Methods", () => {
    expect(allowed.length).toBeGreaterThan(0);
    const used = new Set();
    for (const f of readdirSync(new URL("../server/", import.meta.url)).filter((x) => WORKSPACE.includes(x))) {
      const src = readFileSync(new URL(`../server/${f}`, import.meta.url), "utf8");
      for (const m of src.matchAll(/\b(?:r|app|router)\.(get|post|put|patch|delete)\(\s*["'`]/g)) used.add(m[1].toUpperCase());
    }
    expect(used.has("PUT")).toBe(true);
    for (const m of used) expect(allowed, `${m} is used by a route but not allowed by CORS`).toContain(m);
  });
});

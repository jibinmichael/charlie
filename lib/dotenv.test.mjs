// lib/dotenv.test.mjs — .env.local parsing must survive a straight copy of .env.example.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseEnvLine, parseEnv } from "./dotenv.mjs";

describe("parseEnvLine", () => {
  it("leaves a plain value unchanged", () => {
    expect(parseEnvLine("MAX_JOBS_PER_USER=3")).toEqual(["MAX_JOBS_PER_USER", "3"]);
    expect(parseEnvLine("A=sk-ant-abc")).toEqual(["A", "sk-ant-abc"]);
  });

  it("strips a trailing comment from an unquoted value", () => {
    expect(parseEnvLine("HEARTBEAT_TIMEOUT_MS=5000             # per-ping timeout in ms")).toEqual(["HEARTBEAT_TIMEOUT_MS", "5000"]);
    expect(parseEnvLine("VOYAGE_API_KEY=                       # unset = lexical")).toEqual(["VOYAGE_API_KEY", ""]);
  });

  it("keeps a # that is not preceded by whitespace in an unquoted value", () => {
    expect(parseEnvLine("X=abc#def")).toEqual(["X", "abc#def"]);
  });

  it("keeps a # inside a quoted value and drops the quotes", () => {
    expect(parseEnvLine('URL="https://example.com/page#frag"  # comment')).toEqual(["URL", "https://example.com/page#frag"]);
    expect(parseEnvLine("URL='https://example.com/a #b'")).toEqual(["URL", "https://example.com/a #b"]);
  });

  it("ignores blank and comment lines; accepts `export`", () => {
    expect(parseEnvLine("")).toBeNull();
    expect(parseEnvLine("# a comment")).toBeNull();
    expect(parseEnvLine("export K=v")).toEqual(["K", "v"]);
  });

  it("reads every numeric example value in .env.example as a number", () => {
    const pairs = parseEnv(readFileSync(".env.example", "utf8"));
    const numeric = pairs.filter(([, v]) => /^\d/.test(v));
    expect(numeric.length).toBeGreaterThan(5);
    for (const [k, v] of numeric) expect([k, Number.isFinite(Number(v))]).toEqual([k, true]);
    expect(Object.fromEntries(pairs).HEARTBEAT_TIMEOUT_MS).toBe("5000");
  });
});

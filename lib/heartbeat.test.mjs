// lib/heartbeat.test.mjs — the env var a job's heartbeat reads must always be a settable name.
import { describe, it, expect, vi, afterEach } from "vitest";
import { heartbeatEnvKey, pingHeartbeat } from "./heartbeat.mjs";

describe("heartbeatEnvKey", () => {
  it("uppercases a plain job name", () => {
    expect(heartbeatEnvKey("match_send")).toBe("HEARTBEAT_URL_MATCH_SEND");
    expect(heartbeatEnvKey("agents")).toBe("HEARTBEAT_URL_AGENTS");
  });

  it("turns a hyphen (or any other non-[A-Z0-9_] character) into an underscore", () => {
    expect(heartbeatEnvKey("voice-pipeline")).toBe("HEARTBEAT_URL_VOICE_PIPELINE");
    expect(heartbeatEnvKey("a.b c/d")).toBe("HEARTBEAT_URL_A_B_C_D");
  });

  it("always yields a POSIX-settable env var name", () => {
    for (const job of ["voice-pipeline", "pieworks", "ats_poll", "x-1.2"]) {
      expect(heartbeatEnvKey(job)).toMatch(/^[A-Z_][A-Z0-9_]*$/);
    }
  });
});

describe("pingHeartbeat", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.HEARTBEAT_URL_VOICE_PIPELINE;
  });

  it("reads the normalised name for a hyphenated job", async () => {
    process.env.HEARTBEAT_URL_VOICE_PIPELINE = "https://hc.example/abc/";
    const fetch = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal("fetch", fetch);
    await pingHeartbeat("voice-pipeline", { log: () => {} });
    await pingHeartbeat("voice-pipeline", { fail: true, log: () => {} });
    expect(fetch.mock.calls.map((c) => c[0])).toEqual(["https://hc.example/abc/", "https://hc.example/abc/fail"]);
  });

  it("is a warned no-op when the URL is unset", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const log = vi.fn();
    await pingHeartbeat("never-configured-job", { log });
    expect(fetch).not.toHaveBeenCalled();
    expect(log.mock.calls[0][0]).toContain("HEARTBEAT_URL_NEVER_CONFIGURED_JOB");
  });
});

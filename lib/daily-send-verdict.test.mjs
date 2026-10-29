// daily-send-verdict.test.mjs — the zero-send guard (lib/daily-send-verdict.mjs). Each fixture is the
// shape of a real day: healthy, silently stuck, mostly refused, and aborted before scoring.
import { describe, it, expect } from "vitest";
import { dailySendVerdict } from "./daily-send-verdict.mjs";

describe("daily send delivered — the zero-send guard", () => {
  it("a healthy day: 47 prepared, 0 stuck -> PASS", () => {
    expect(dailySendVerdict({ active: 55, prepared: 47, stuck: 0 }).ok).toBe(true);
  });

  it("zero role emails while the container reports green: 2 of 7 stuck -> FAIL", () => {
    const v = dailySendVerdict({ active: 55, prepared: 7, stuck: 2 });
    expect(v.ok).toBe(false);
    expect(v.detail).toMatch(/ATTEMPTED and refused/);
  });

  it("most sends refused by the provider: 22 of 65 stuck -> FAIL", () => {
    const v = dailySendVerdict({ active: 55, prepared: 65, stuck: 22 });
    expect(v.ok).toBe(false);
    expect(v.detail).toMatch(/22 of 65/);
  });

  it("the cost-ceiling abort (nothing scored at all) -> FAIL", () => {
    const v = dailySendVerdict({ active: 47, prepared: 0, stuck: 0 });
    expect(v.ok).toBe(false);
    expect(v.detail).toMatch(/produced NOTHING/);
  });

  it("an ALL-DIGEST day is NOT a failure (nobody cleared the bar — legitimate)", () => {
    expect(dailySendVerdict({ active: 55, prepared: 30, stuck: 0 }).ok).toBe(true);
  });

  it("no active users -> nothing was expected, so no alarm", () => {
    expect(dailySendVerdict({ active: 0, prepared: 0, stuck: 0 }).ok).toBe(true);
  });
});

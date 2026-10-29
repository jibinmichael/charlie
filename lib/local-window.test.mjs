// lib/local-window.test.mjs — coarse timezone + quiet-hours (deterministic, no I/O, no clock).
//
// Proves the humane-timing rules without any live clock (every case injects a fixed UTC instant):
//   1. India vs US resolve to DIFFERENT local hours for the same UTC instant (coarse market TZ).
//   2. A 2am-local proactive send DEFERS to the local morning; an evening send rolls to next morning.
//   3. A daytime, non-holiday send is NOT deferred (returns the same instant).
//   4. A holiday defers to the next working morning.
//   5. marketOf reads the market from the dossier (INR/US signal), defaulting India.

import { describe, it, expect } from "vitest";
import { localWindow, nextSendWindow, canSendNow, marketOf, isHoliday } from "./local-window.mjs";

const IN = { dossier: { preferences: { comp_currency: "INR" } } }; // homeRegion → india (IST +5:30)
const US = { dossier: { preferences: { comp_currency: "USD" } } }; // homeRegion → us    (ET  -5:00)

// Helper: the local wall-clock (hour, ymd) a result resolves to, for a given market candidate.
const at = (cand, ms) => localWindow(cand, ms);

describe("marketOf — coarse market from the dossier", () => {
  it("reads INR → india, USD → us, and defaults india", () => {
    expect(marketOf(IN)).toBe("india");
    expect(marketOf(US)).toBe("us");
    expect(marketOf({ dossier: {} })).toBe("india");
  });
});

describe("localWindow — the same instant is a different local hour per market", () => {
  // 2026-07-15 20:00 UTC → 01:30 IST (next day, QUIET) but 15:00 ET (afternoon, fine).
  const ms = Date.UTC(2026, 6, 15, 20, 0, 0);
  it("India reads it as ~1:30am (quiet)", () => {
    const w = at(IN, ms);
    expect(w.market).toBe("india");
    expect(w.localHour).toBe(1);
    expect(w.quiet).toBe(true);
    expect(w.ymd).toBe("2026-07-16");
  });
  it("US reads the same instant as ~3pm (not quiet)", () => {
    const w = at(US, ms);
    expect(w.market).toBe("us");
    expect(w.localHour).toBe(15);
    expect(w.quiet).toBe(false);
    expect(w.ymd).toBe("2026-07-15");
  });
});

describe("nextSendWindow — quiet hours defer to the local morning", () => {
  it("a 2am-local send defers to 8am the SAME local day", () => {
    const ms = Date.UTC(2026, 6, 14, 20, 30, 0); // 02:00 IST on 2026-07-15
    expect(at(IN, ms).localHour).toBe(2); // sanity: it is 2am local
    const when = nextSendWindow(IN, ms);
    expect(when).toBeGreaterThan(ms);
    const w = at(IN, when);
    expect(w.localHour).toBe(8);
    expect(w.ymd).toBe("2026-07-15"); // same day, later that morning
    expect(w.quiet).toBe(false);
  });

  it("an 11pm-local send rolls to 8am the NEXT local day", () => {
    const ms = Date.UTC(2026, 6, 15, 17, 30, 0); // 23:00 IST on 2026-07-15
    expect(at(IN, ms).localHour).toBe(23);
    const when = nextSendWindow(IN, ms);
    const w = at(IN, when);
    expect(w.localHour).toBe(8);
    expect(w.ymd).toBe("2026-07-16"); // today's morning already passed → next day
  });

  it("a daytime, non-holiday send is NOT deferred (returns the same instant)", () => {
    const ms = Date.UTC(2026, 6, 15, 6, 30, 0); // 12:00 IST, a normal weekday
    expect(at(IN, ms).quiet).toBe(false);
    expect(nextSendWindow(IN, ms)).toBe(ms);
    expect(canSendNow(IN, ms)).toBe(true);
  });
});

describe("nextSendWindow — holidays defer to the next working morning", () => {
  it("a daytime send on an India holiday defers to the next day's morning", () => {
    expect(isHoliday("2026-08-15", "india")).toBe(true); // Independence Day (in the static list)
    const ms = Date.UTC(2026, 7, 15, 6, 30, 0); // 12:00 IST on 2026-08-15 (holiday, but daytime)
    expect(at(IN, ms).quiet).toBe(false); // not a quiet HOUR…
    expect(canSendNow(IN, ms)).toBe(false); // …but still not allowed (holiday)
    const when = nextSendWindow(IN, ms);
    const w = at(IN, when);
    expect(w.ymd).toBe("2026-08-16"); // skipped the holiday
    expect(w.localHour).toBe(8);
  });
});

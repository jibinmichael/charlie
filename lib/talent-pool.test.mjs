// lib/talent-pool.test.mjs — the board's read of the talent pool pages past the provider's cap.
import { describe, it, expect } from "vitest";
import { fakeDb } from "../voice/__tests__/fake-db.mjs";
import { listTalentPool } from "./talent-pool.mjs";

describe("listTalentPool", () => {
  it("pages past the provider's per-request cap and returns every row, newest first", async () => {
    const rows = Array.from({ length: 2345 }, (_, i) => ({ id: i + 1, email: `p${i}@x.test`, applied_at: new Date(Date.UTC(2026, 0, 1) + i * 60000).toISOString() }));
    const client = fakeDb({ talent_pool: rows });
    const all = await listTalentPool({ client });
    expect(all).toHaveLength(2345);
    expect(all[0].id).toBe(2345);
    expect(all.at(-1).id).toBe(1);
    expect(await listTalentPool({ client, limit: 1500 })).toHaveLength(1500);
  });
  it("refuses to run without a client rather than reaching for one", async () => {
    await expect(listTalentPool({})).rejects.toThrow(/client is required/);
  });
});

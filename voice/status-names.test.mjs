// voice/status-names.test.mjs — the six status names are identical in the code constant, the report
// schema, the migration's check constraint and the evaluator. No seventh, anywhere.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { STATUSES, COVERAGE_BANDS, STATUS_LANGUAGE, COVERAGE_LANGUAGE } from "./statuses.mjs";
import { ReportPackage } from "../lib/schemas/vv-report.mjs";

const SIX = ["strongly_supported", "supported", "stated_only", "contradicted", "insufficient", "not_assessed"];

describe("status names", () => {
  it("the constant is exactly the six, with a sentence for each, and the four bands likewise", () => {
    expect([...STATUSES]).toEqual(SIX);
    expect(Object.keys(STATUS_LANGUAGE).sort()).toEqual([...SIX].sort());
    expect(COVERAGE_BANDS).toHaveLength(4);
    expect(Object.keys(COVERAGE_LANGUAGE).sort()).toEqual([...COVERAGE_BANDS].sort());
  });

  it("the migration's check constraint lists the same six", () => {
    const sql = readFileSync("supabase/migrations/20260922140000_vv_evidence.sql", "utf8");
    const m = /status\s+text not null check \(status in \(([^)]+)\)\)/.exec(sql);
    expect(m).not.toBeNull();
    const inSql = m[1].split(",").map((s) => s.trim().replace(/^'|'$/g, ""));
    expect(inSql).toEqual(SIX);
    const b = /coverage_band\s+text not null check \(coverage_band in \(([^)]+)\)\)/.exec(sql);
    expect(b[1].split(",").map((s) => s.trim().replace(/^'|'$/g, ""))).toEqual([...COVERAGE_BANDS]);
  });

  it("the report schema's status enum is the same six", () => {
    const ok = ReportPackage.shape.capability_grid.element.shape.status.options;
    expect([...ok]).toEqual(SIX);
  });

  it("the evaluator and the package builder import the constant rather than spelling the names", () => {
    for (const f of ["voice/evaluate.mjs", "voice/render-package.mjs", "lib/schemas/vv-report.mjs"]) {
      const src = readFileSync(f, "utf8");
      expect(src).toMatch(/from ["'].*statuses\.mjs["']/);
    }
  });
});

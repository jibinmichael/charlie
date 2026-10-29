// server/resume-columns.test.mjs — two-column resumes extract column by column.
//
// Joining every item on a row left to right welds the columns together (the left column's school name
// spliced into the right column's sentence). Only extracted text is stored, never the original file,
// so that damage would be permanent.
import { describe, it, expect } from "vitest";
import { columnAwareLines } from "./resume-extract.mjs";

// what the old code did: join every item on a row, left to right
const oldWay = (rows) => rows.map((r) => r.items.map((i) => i.str).join(" ").replace(/\s+/g, " ").trim()).filter(Boolean);

const twoCol = [
  { y: 700, items: [{ x: 40, str: "EDUCATION" }, { x: 320, str: "EXPERIENCE" }] },
  { y: 680, items: [{ x: 40, str: "Northgate Institute of" }, { x: 320, str: "collaboration with diverse" }] },
  { y: 660, items: [{ x: 40, str: "Engineering" }, { x: 320, str: "stakeholders, and the ability" }] },
  { y: 640, items: [{ x: 40, str: "B.Sc, 2017" }, { x: 320, str: "to drive product launches" }] },
];

describe("columnAwareLines", () => {
  it("stops welding the two columns into one line", () => {
    expect(oldWay(twoCol)).toContain("Northgate Institute of collaboration with diverse");
    expect(columnAwareLines(twoCol)).not.toContain("Northgate Institute of collaboration with diverse");
  });

  it("keeps the school name contiguous so it can be cited", () => {
    const text = columnAwareLines(twoCol).join("\n");
    expect(text).toContain("Northgate Institute of\nEngineering");
    expect(text).toContain("collaboration with diverse\nstakeholders, and the ability");
  });

  it("reads the left column fully before the right one", () => {
    const out = columnAwareLines(twoCol);
    expect(out.indexOf("B.Sc, 2017")).toBeLessThan(out.indexOf("collaboration with diverse"));
  });

  it("leaves a single-column page exactly as it was", () => {
    const oneCol = [
      { y: 700, items: [{ x: 40, str: "Dana Whitfield" }] },
      { y: 680, items: [{ x: 40, str: "Product Designer," }, { x: 96, str: "Leeds" }] },
      { y: 660, items: [{ x: 40, str: "Ran the onboarding research programme" }] },
    ];
    expect(columnAwareLines(oneCol)).toEqual(oldWay(oneCol));
  });

  it("does not treat one wide tab as a column", () => {
    const tabbed = [
      { y: 700, items: [{ x: 40, str: "Skills" }, { x: 300, str: "React, TypeScript" }] },
      { y: 680, items: [{ x: 40, str: "Led the platform rebuild end to end" }] },
      { y: 660, items: [{ x: 40, str: "Shipped it in eleven weeks" }] },
    ];
    // one gap on one row is not a gutter; minRows is 3
    expect(columnAwareLines(tabbed)).toEqual(oldWay(tabbed));
  });

  it("survives an empty page", () => {
    expect(columnAwareLines([])).toEqual([]);
  });
});

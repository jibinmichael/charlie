// scan-slim.test.mjs — the scan caps descriptions at ingest, not at write time.
//
// Holding every posting at full length for the whole run and capping only at write time carries many
// times the text the run will ever keep, and runs out of heap. These pin the two properties capping
// early depends on: capping early produces the same bytes as capping late, and the nice-to-have
// survives even though it is read off text the cap removes.

import { describe, it, expect } from "vitest";
import { capKeepingRequirements, extractNiceToHave } from "./jd-requirements.mjs";
import { serializeJobsFile } from "../scan-jobs.mjs";

const CAP = 2500;
// Deliberately well over the cap: a fixture under the cap would be returned untouched by `slim` and
// could never exercise the thing being tested.
const long = (label) =>
  `About the role. ${"x".repeat(4000)}\n\nRequirements:\n- ${label} five years of Java\n- ${"y".repeat(900)}\n\nNice to have:\n- Kubernetes\n- A PhD in ${label}`;

/** What the scan now does on the way in. */
const slim = (j) => {
  if (!j || typeof j.description !== "string" || j.description.length <= CAP) return j;
  const nice = j.nice_to_have || extractNiceToHave(j.description);
  j.description = capKeepingRequirements(j.description, CAP);
  if (nice) j.nice_to_have = nice;
  return j;
};

describe("capping on the way in equals capping on the way out", () => {
  it("produces the same serialized bytes either way", () => {
    const raw = () => [{ id: "a", source: "greenhouse", title: "Eng", description: long("astronomy") }];
    const late = serializeJobsFile(raw());          // full text held, capped at write
    const early = serializeJobsFile(raw().map(slim)); // capped at ingest
    expect(early).toBe(late);
  });

  it("keeps the nice-to-have, which lives in the part the cap removes", () => {
    const j = slim({ id: "b", description: long("astronomy") });
    expect(j.nice_to_have).toBeTruthy();
    expect(j.nice_to_have).toContain("Kubernetes");
    expect(j.description.length).toBeLessThanOrEqual(CAP);
    // NOT asserted: that the bonus is absent from the capped description. capKeepingRequirements
    // slides the window to the requirements, and in a posting where the bonus sits right after them
    // it survives too. The guarantee is that the field is populated from the FULL text, so it is
    // there whether or not the cap happened to keep it.
    expect(j.description).toContain("five years of Java");
  });

  it("keeps the requirements, which is the whole reason for the sliding cap", () => {
    const j = slim({ id: "c", description: long("astronomy") });
    expect(j.description).toContain("five years of Java");
  });

  it("leaves a short description untouched and allocates nothing", () => {
    const short = { id: "d", description: "Short one." };
    expect(slim(short)).toBe(short);
  });

  it("is idempotent, so the writers capping again is a no-op", () => {
    const once = slim({ id: "e", description: long("astronomy") });
    const twice = slim({ ...once });
    expect(twice.description).toBe(once.description);
  });
});

describe("the memory claim, measured", () => {
  it("holds far less text after slimming", () => {
    const jobs = Array.from({ length: 200 }, (_, i) => ({ id: `j${i}`, description: long("astronomy") }));
    const before = jobs.reduce((n, j) => n + j.description.length, 0);
    const after = jobs.map(slim).reduce((n, j) => n + j.description.length, 0);
    expect(after).toBeLessThan(before);
    // Not a token improvement: this is the difference between finishing and dying.
    expect(after / before).toBeLessThan(0.9);
  });
});

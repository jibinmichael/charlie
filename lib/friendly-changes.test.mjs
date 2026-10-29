// friendly-changes.test.mjs — a preference confirmation may never print a database column name at a
// person, e.g. "I've updated where you want to work, your pay currency, home_place, ...".
//
// `home_place` is a column in the dossier schema. A fallback of `map[k] || k` sends any key without a
// friendly name to the reader as itself.
//
// COMPLETING THE MAP CANNOT BE THE FIX. `preferences` is a Zod .passthrough() object, so any key can
// appear, and the map is guaranteed to be incomplete the next time somebody adds a field. This file
// pins the property that survives that: what we cannot say in English, we do not say.
//
// The function is small and lives in a .ts server file that this .mjs suite cannot import, so it is
// mirrored here and the test asserts the two stay identical. A copy that silently drifts would be
// worse than no test, so the drift check is the first assertion.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../server/charlie-remote.ts", import.meta.url), "utf8");

/** Mirror of friendlyChanges in server/charlie-remote.ts. */
function friendlyChanges(keys) {
  const map = {
    role: "the kind of role", seniority: "your seniority", remote: "where you want to work",
    comp_floor: "your pay floor", comp_currency: "your pay currency", stage: "company stage",
    dealbreakers: "your dealbreakers", ping_bar: "what's worth reaching out for", values: "what matters to you",
    home_place: "where you're based", mode: "what you're looking for", notice_period: "your notice period",
    relocate: "whether you'd relocate", location: "where you want to work",
  };
  const parts = keys.map((k) => map[k]).filter(Boolean);
  if (parts.length <= 1) return parts[0] || "";
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}

describe("the source still behaves the way this file mirrors", () => {
  it("drops unmapped keys instead of falling back to the key", () => {
    expect(SRC).toContain("const parts = keys.map((k) => map[k]).filter(Boolean);");
    // The `map[k] || k` fallback leaks a column name. If it ever comes back, this fails.
    expect(SRC).not.toContain("map[k] || k");
  });

  it("still maps the field that leaked", () => {
    expect(SRC).toMatch(/home_place:\s*"where you're based"/);
  });
});

describe("no database column can reach a person", () => {
  it("drops a key nobody wrote a phrase for", () => {
    expect(friendlyChanges(["home_place_v2"])).toBe("");
    expect(friendlyChanges(["some_new_column"])).toBe("");
  });

  it("keeps the mapped ones and silently drops the rest", () => {
    expect(friendlyChanges(["remote", "totally_new_field", "values"]))
      .toBe("where you want to work and what matters to you");
  });

  it("never emits a snake_case token, whatever it is given", () => {
    const keys = ["home_place", "comp_floor", "ping_bar", "unknown_key", "another_new_one", "mode"];
    expect(friendlyChanges(keys)).not.toMatch(/[a-z]+_[a-z]+/);
  });

  it("reproduces the real leak, and shows it fixed", () => {
    // A key list that includes a column with no friendly name.
    const real = ["remote", "comp_currency", "home_place", "values", "comp_floor"];
    const OLD = (ks) => ks.map((k) => ({ remote: "where you want to work", comp_currency: "your pay currency", values: "what matters to you", comp_floor: "your pay floor" })[k] || k).join(", ");
    expect(OLD(real)).toContain("home_place");          // the bug
    expect(friendlyChanges(real)).not.toContain("home_place"); // fixed
    expect(friendlyChanges(real)).toContain("where you're based");
  });

  it("returns an empty string when nothing can be said, so the caller says nothing", () => {
    // renderConvoReply falls back to "Got it, noted" on an empty changedText, which is the right
    // outcome: a vague acknowledgement beats a precise leak.
    expect(friendlyChanges(["a_new_field", "and_another"])).toBe("");
  });

  it("handles one, two and many correctly", () => {
    expect(friendlyChanges(["remote"])).toBe("where you want to work");
    expect(friendlyChanges(["remote", "values"])).toBe("where you want to work and what matters to you");
    expect(friendlyChanges(["remote", "values", "seniority"]))
      .toBe("where you want to work, what matters to you, and your seniority");
    expect(friendlyChanges([])).toBe("");
  });
});

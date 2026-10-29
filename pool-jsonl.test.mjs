// pool-jsonl.test.mjs — the JSONL job pool, which escapes V8's 512 MiB single-string ceiling.
//
// THE WALL. Building the whole pool as ONE string via JSON.stringify, and reading it back as one
// string via data.text(), fails once the pool passes 512 MiB — a limit no --max-old-space-size can
// raise. The pool grows daily, so the failure is not "slow" but "throws outright, permanently", and
// it lands on the file every send reads.
//
// JSONL removes it: each posting is stringified alone and the pieces are joined as BUFFERS, which have
// no such limit. The reader handles BOTH formats unconditionally, which is what keeps the writer's flag
// from being a one-way door.
import { describe, it, expect } from "vitest";
import { parsePoolBlob } from "./charlie-store.mjs";

/** A Blob stand-in with the two methods the parser uses. */
const blobOf = (text) => new Blob([text], { type: "application/json" });

describe("the reader accepts both formats", () => {
  const roles = [{ id: "a", title: "One" }, { id: "b", title: "Two" }];

  it("reads the LEGACY single JSON array", async () => {
    expect(await parsePoolBlob(blobOf(JSON.stringify(roles)))).toEqual(roles);
  });

  it("reads JSONL, one posting per line", async () => {
    expect(await parsePoolBlob(blobOf(roles.map((r) => JSON.stringify(r)).join("\n") + "\n"))).toEqual(roles);
  });

  it("reads JSONL with no trailing newline", async () => {
    expect(await parsePoolBlob(blobOf(roles.map((r) => JSON.stringify(r)).join("\n")))).toEqual(roles);
  });

  it("detects the format from leading whitespace correctly", async () => {
    expect(await parsePoolBlob(blobOf("\n  " + JSON.stringify(roles)))).toEqual(roles);
  });

  it("returns [] for an empty blob rather than throwing into the send", async () => {
    expect(await parsePoolBlob(blobOf(""))).toEqual([]);
    expect(await parsePoolBlob(blobOf("\n\n  \n"))).toEqual([]);
  });
});

describe("one bad posting never costs a day's pool", () => {
  it("skips a malformed LINE and keeps the rest", async () => {
    // Per-record isolation: one employer emitting a stray byte must not make a whole run produce
    // nothing.
    const text = ['{"id":"a"}', "{not json", '{"id":"c"}'].join("\n");
    const out = await parsePoolBlob(blobOf(text));
    expect(out.map((r) => r.id)).toEqual(["a", "c"]);
  });

  it("survives a line split across stream chunks", async () => {
    // The decoder hands back arbitrary chunk boundaries, so a posting WILL be cut in half at some
    // point in a large file. If the carry buffer were dropped, that role would vanish silently.
    const many = Array.from({ length: 500 }, (_, i) => ({ id: `r${i}`, pad: "x".repeat(300) }));
    const out = await parsePoolBlob(blobOf(many.map((r) => JSON.stringify(r)).join("\n")));
    expect(out).toHaveLength(500);
    expect(out[499].id).toBe("r499");
  });

  it("handles multi-byte characters split across chunks", async () => {
    // A UTF-8 character can straddle a chunk boundary. Decoding without { stream: true } would turn it
    // into a replacement char and corrupt the JSON on that line.
    const roles = Array.from({ length: 200 }, (_, i) => ({ id: `r${i}`, title: "Software Engineer — Bengaluru ✓ 日本語" }));
    const out = await parsePoolBlob(blobOf(roles.map((r) => JSON.stringify(r)).join("\n")));
    expect(out).toHaveLength(200);
    expect(out[100].title).toContain("日本語");
  });
});

describe("round trip", () => {
  it("JSONL preserves every field exactly, including the new bonus text", async () => {
    const roles = [
      { id: "greenhouse:acme:1", title: "Engineer", description: "long".repeat(100), nice_to_have: "Nice to have: Go", compensation: { min: 1, max: 2 } },
      { id: "ashby:b:2", title: "Designer", location: null, remote: true },
    ];
    const text = roles.map((r) => JSON.stringify(r)).join("\n") + "\n";
    expect(await parsePoolBlob(blobOf(text))).toEqual(roles);
  });
});

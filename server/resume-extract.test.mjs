// server/resume-extract.test.mjs — bound the BYTES, not just the text.
//
// MAX_CHARS (60,000) caps what reaches the model, but it applies AFTER extraction, and extraction is
// where the cost is. A .docx is a zip that mammoth decompresses in memory before a single character is
// counted, so attachment size and count must be bounded before extraction or a decompression bomb
// would slip past the text cap.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { extractResumeText, ALLOWED_EXT, MAX_ATTACHMENT_BYTES } from "./resume-extract.mjs";

describe("extractResumeText — size", () => {
  it("refuses a buffer larger than the cap BEFORE trying to decompress it", async () => {
    // A zip magic number on a huge buffer: exactly the shape of a decompression bomb. If the cap were
    // missing, this would reach mammoth and expand.
    const bomb = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1024);
    bomb[0] = 0x50; bomb[1] = 0x4b;
    const r = await extractResumeText(bomb, "resume.docx");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/larger than I can read/i);
  });

  it("the refusal tells a real person what to do instead", async () => {
    const big = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1);
    const r = await extractResumeText(big, "resume.pdf");
    // Not a stack trace, not "error": a sentence someone can act on.
    expect(r.reason).toMatch(/PDF under 10 MB/i);
    expect(r.reason).not.toMatch(/error|invalid|failed/i);
  });

  it("a normal-sized file is unaffected", async () => {
    const txt = Buffer.from("Jane Doe. Senior engineer. Shipped the payments rebuild in 2024.");
    const r = await extractResumeText(txt, "resume.txt");
    expect(r.ok).toBe(true);
    expect(r.text).toMatch(/payments rebuild/);
  });

  it("the cap is generous against real resumes (50 KB - 2 MB) and short of what hurts a container", () => {
    expect(MAX_ATTACHMENT_BYTES).toBeGreaterThanOrEqual(5 * 1024 * 1024);
    expect(MAX_ATTACHMENT_BYTES).toBeLessThanOrEqual(25 * 1024 * 1024);
  });

  it("still only accepts the formats it can actually read", () => {
    expect(ALLOWED_EXT).toContain("pdf");
    expect(ALLOWED_EXT).toContain("md");     // Peerlist export
    expect(ALLOWED_EXT).not.toContain("exe");
    expect(ALLOWED_EXT).not.toContain("zip");
  });
});

// The count cap lives in the handler, so it is asserted against the real file.
describe("the inbound loop caps how MANY attachments it will read", () => {
  const SERVER = readFileSync(new URL("./charlie-remote.ts", import.meta.url), "utf8");
  it("slices the attachment list rather than iterating all of it", () => {
    expect(SERVER).toMatch(/atts\.slice\(0, MAX_ATTACHMENTS\)/);
  });
  it("does not silently truncate — an over-cap email is logged", () => {
    expect(SERVER).toMatch(/attachments_capped/);
  });
});

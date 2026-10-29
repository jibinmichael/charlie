// server/resume-extract.mjs — deterministic, VERBATIM text extraction from an uploaded resume.
//
// Grounding-critical: the text this returns is what upload_resume stores and what
// build_dossier / extractName read. So it must be faithful, not a paraphrase — we never
// run the file through a model here. PDFs reconstruct line structure from text-item
// positions (so line 1 stays the person's name); DOCX via mammoth; TXT/RTF/MD as UTF-8.
// On anything it can't read (scans, image-only PDFs, garbage) it returns ok:false and the
// caller falls back to "paste it instead" — it must DEGRADE, never invent.

const MAX_CHARS = 60000; // bound the downstream model input; resumes are far smaller

// BOUND THE BYTES, not just the text. MAX_CHARS above caps what reaches the model, but it applies
// AFTER extraction — and extraction is where the cost is. A .docx is a zip, and mammoth decompresses
// it in memory before a single character is counted, so a decompression bomb never reaches the cap it
// was supposed to be stopped by. A base64 attachment is likewise materialised in full before anyone
// asks how big it is.
//
// 10 MB is far past any real resume (they run 50 KB to 2 MB) and far short of what hurts a container.
export const MAX_ATTACHMENT_BYTES = Number(process.env.MAX_ATTACHMENT_BYTES || 10 * 1024 * 1024);
const MIN_MEANINGFUL = 30; // fewer non-space chars than this == we didn't really read it

export const ALLOWED_EXT = ["pdf", "docx", "txt", "rtf", "md"];

// Drop control chars (keep tab/newline/carriage-return), normalize newlines + blank runs.
// \p{Cc} matches the C0/C1 control range without putting raw control bytes in this source.
export function cleanResumeText(s) {
  return String(s || "")
    .replace(/\p{Cc}/gu, (c) => (c === "\n" || c === "\t" || c === "\r" ? c : ""))
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Split one page's Y-grouped rows into columns, when the page actually has columns.
 *
 * Grouping by Y alone is right for a single-column resume and wrong for a two-column one, where it
 * splices the two columns into one line: e.g. "Example College of collaboration with diverse
 * stakeholders", the left column's school name welded to the right column's sentence. Downstream
 * extractors then cannot find the school, because it is no longer a contiguous string.
 *
 * The damage is not recoverable later: only the extracted text is stored, never the original file.
 *
 * FAIL SAFE, NOT CLEVER. A page is only treated as two-column when the SAME horizontal gap shows up
 * on at least three rows at a consistent x, which is what a real column gutter looks like and what a
 * one-off wide tab does not. Anything else is returned exactly as it came in, so the single-column
 * path (the overwhelming majority) is untouched.
 *
 * @param {{y: number, items: {x: number, str: string}[]}[]} rows  y-descending, items x-ascending
 * @returns {string[]} lines in reading order
 */
export function columnAwareLines(rows, { minGap = 60, minRows = 3 } = {}) {
  const gaps = [];
  for (const r of rows) {
    for (let i = 1; i < r.items.length; i++) {
      const gap = r.items[i].x - r.items[i - 1].x;
      if (gap >= minGap) gaps.push({ at: r.items[i].x, gap });
    }
  }
  // A gutter is one x that repeats. Cluster the candidate boundaries and take the most common.
  let gutter = null, best = 0;
  for (const g of gaps) {
    const n = gaps.filter((o) => Math.abs(o.at - g.at) <= 20).length;
    if (n > best) { best = n; gutter = g.at; }
  }
  const flat = (r) => r.items.map((i) => i.str).join(" ").replace(/\s+/g, " ").trim();
  if (gutter == null || best < minRows) return rows.map(flat).filter(Boolean);

  // Two columns: emit the left one top to bottom, then the right one.
  const left = [], right = [];
  for (const r of rows) {
    const l = r.items.filter((i) => i.x < gutter - 20);
    const g = r.items.filter((i) => i.x >= gutter - 20);
    const ls = l.map((i) => i.str).join(" ").replace(/\s+/g, " ").trim();
    const gs = g.map((i) => i.str).join(" ").replace(/\s+/g, " ").trim();
    if (ls) left.push(ls);
    if (gs) right.push(gs);
  }
  return [...left, ...right];
}

// Reconstruct PDF text line by line from pdf.js text-item geometry: group items by their
// Y coordinate (top to bottom), order each line left to right, then split columns where the page
// has them. Preserves the line structure a resume depends on — plain concatenation flattens
// everything into one line, and Y-grouping alone welds two columns into one.
async function pdfToText(buf) {
  const { getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  const out = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    const lines = new Map();
    for (const it of content.items) {
      if (!it.str || !it.transform) continue;
      const y = Math.round(it.transform[5]);
      if (!lines.has(y)) lines.set(y, []);
      lines.get(y).push({ x: it.transform[4], str: it.str });
    }
    const rows = [...lines.keys()].sort((a, b) => b - a)
      .map((y) => ({ y, items: lines.get(y).sort((a, b) => a.x - b.x) }));
    for (const line of columnAwareLines(rows)) out.push(line);
    out.push("");
  }
  return out.join("\n");
}

// Extract verbatim text from a resume file buffer. Sniffs by magic bytes first, falls back
// to the extension. Returns { ok, text, chars, truncated } or { ok:false, reason } — the
// reason is a person-facing line the chat can show before asking them to paste instead.
export async function extractResumeText(buf, filename = "") {
  if (!buf || !buf.length) return { ok: false, reason: "that file came through empty — mind trying again or pasting the text?" };
  const ext = (String(filename).split(".").pop() || "").toLowerCase();
  // Refuse before decompressing. This is the only line that stands between a zip bomb and the heap.
  if (buf.length > MAX_ATTACHMENT_BYTES) {
    return { ok: false, reason: "That file is larger than I can read. If it's a resume, a PDF under 10 MB works best." };
  }
  const isPdf = buf.length >= 5 && buf.toString("latin1", 0, 5) === "%PDF-";
  const isZip = buf.length >= 2 && buf[0] === 0x50 && buf[1] === 0x4b; // PK.. -> docx (zip)

  let raw = "";
  try {
    if (isPdf || ext === "pdf") {
      raw = await pdfToText(buf);
    } else if (isZip || ext === "docx") {
      const mammoth = await import("mammoth");
      const { value } = await mammoth.extractRawText({ buffer: buf });
      raw = value || "";
    } else if (["txt", "rtf", "md"].includes(ext)) {
      raw = buf.toString("utf8");
    } else {
      return { ok: false, reason: "I can read PDF, Word (.docx), or plain text — for anything else, just paste the text in." };
    }
  } catch (e) {
    return { ok: false, reason: "I had trouble reading that file — if it's a scan or image, paste the text and I'll take it from there.", error: String(e?.message || e) };
  }

  const text = cleanResumeText(raw);
  if (text.replace(/\s/g, "").length < MIN_MEANINGFUL) {
    return { ok: false, reason: "I couldn't pull any text out of that — if it's a scanned image, paste the text in and I'll use that." };
  }
  const truncated = text.length > MAX_CHARS;
  return { ok: true, text: truncated ? text.slice(0, MAX_CHARS) : text, chars: text.length, truncated };
}

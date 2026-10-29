// notion.mjs — the one seam to the Notion API. Every script that touches a candidate board goes
// through here, the same way every table goes through charlie-store.mjs.
//
// THE FAILURE MODE THIS FILE IS BUILT AROUND: a Notion token that cannot see a database returns an
// EMPTY RESULT, not an error. So does a token whose integration was never added to the page. A caller
// that trusts the count will happily conclude "0 candidates" and report success. `queryAll` therefore
// takes an `expect` and throws when the count disagrees. Never remove that argument to make a script
// pass — an unexpected count means we are looking at a partial view of a real client's board.

import fs from "fs";

const API = "https://api.notion.com/v1";
const VERSION = "2022-06-28";

// Notion's documented sustained limit is ~3 requests/second. One in-process queue, so parallel
// callers cannot collectively breach it.
let chain = Promise.resolve();
const GAP_MS = 340;
function serialize(fn) {
  const run = chain.then(fn, fn);
  chain = run.then(() => new Promise((r) => setTimeout(r, GAP_MS)), () => new Promise((r) => setTimeout(r, GAP_MS)));
  return run;
}

function token() {
  const t = process.env.NOTION_TOKEN;
  if (!t) throw new Error("NOTION_TOKEN is not set — add it to .env.local (see .env.example)");
  return t;
}

async function call(method, path, body, attempt = 1) {
  const res = await serialize(() => fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token()}`, "Notion-Version": VERSION, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  }));
  if (res.ok) return res.json();
  const text = await res.text();
  // 429 and 5xx are Notion having a moment; 4xx is us being wrong and retrying will not fix it.
  if ((res.status === 429 || res.status >= 500) && attempt <= 4) {
    const wait = Number(res.headers.get("retry-after") || 0) * 1000 || 1000 * attempt * attempt;
    await new Promise((r) => setTimeout(r, wait));
    return call(method, path, body, attempt + 1);
  }
  throw new Error(`Notion ${method} ${path} -> ${res.status} ${text.slice(0, 300)}`);
}

/** Every row of a database. `expect` is a required guard, not a convenience: see the header. */
export async function queryAll(databaseId, { expect } = {}) {
  const out = [];
  let cursor;
  do {
    const j = await call("POST", `/databases/${databaseId}/query`, { page_size: 100, start_cursor: cursor });
    out.push(...j.results);
    cursor = j.has_more ? j.next_cursor : null;
  } while (cursor);
  if (expect != null && out.length !== expect) {
    throw new Error(`REFUSING TO PROCEED: expected ${expect} rows, the API returned ${out.length}. ` +
      `An empty or short result usually means the database is not shared with this integration, ` +
      `which Notion reports as success rather than as an error.`);
  }
  return out;
}

export const updateProperties = (pageId, properties) => call("PATCH", `/pages/${pageId}`, { properties });
export const listChildren = async (blockId) => {
  const out = [];
  let cursor;
  do {
    const j = await call("GET", `/blocks/${blockId}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ""}`);
    out.push(...j.results);
    cursor = j.has_more ? j.next_cursor : null;
  } while (cursor);
  return out;
};
export const deleteBlock = (blockId) => call("DELETE", `/blocks/${blockId}`);

/**
 * Upload a local file into Notion and return its file_upload id, usable as a block's file source.
 * Tally serves CVs behind a signed URL that expires, so a link would rot; the bytes are moved here.
 */
export async function uploadFile(filePath, filename) {
  const created = await call("POST", "/file_uploads", { filename, content_type: "application/pdf" });
  const form = new FormData();
  form.append("file", new Blob([fs.readFileSync(filePath)], { type: "application/pdf" }), filename);
  const res = await serialize(() => fetch(`${API}/file_uploads/${created.id}/send`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token()}`, "Notion-Version": VERSION },
    body: form,
  }));
  if (!res.ok) throw new Error(`Notion upload -> ${res.status} ${(await res.text()).slice(0, 200)}`);
  const done = await res.json();
  if (done.status !== "uploaded") throw new Error(`Notion upload status ${done.status}`);
  return done.id;
}

/** Append blocks, in batches of 100 because that is the API's per-request ceiling. */
export async function appendBlocks(pageId, blocks) {
  for (let i = 0; i < blocks.length; i += 100) {
    await call("PATCH", `/blocks/${pageId}/children`, { children: blocks.slice(i, i + 100) });
  }
  return blocks.length;
}

// ---------------------------------------------------------------------------------------------
// Markdown -> Notion blocks.
//
// Deliberately narrow: headings, paragraphs, bullets, dividers and tables, which is exactly what the
// review pages contain. It is not a general Markdown engine and should not become one — an
// unsupported construct must come out as visible plain text, never be silently dropped, because a
// dropped sentence on a candidate's page is an absence that reads as a fact about them.
// ---------------------------------------------------------------------------------------------

const LIMIT = 2000; // Notion's max characters per rich-text object.

/**
 * Split on **bold** and *italic* so emphasis becomes an annotation; everything else stays literal.
 * Both must be handled: Notion escapes a stray asterisk rather than dropping it, so an unhandled
 * `*(good to have)*` reaches the reader as `\*(good to have)\*`.
 */
function richText(s) {
  const out = [];
  for (const part of String(s).split(/(\*\*[^*]+\*\*|\*[^*\s][^*]*\*)/g)) {
    if (!part) continue;
    const bold = /^\*\*[^*]+\*\*$/.test(part);
    const italic = !bold && /^\*[^*]+\*$/.test(part);
    const text = bold ? part.slice(2, -2) : italic ? part.slice(1, -1) : part;
    for (let i = 0; i < text.length; i += LIMIT) {
      out.push({ type: "text", text: { content: text.slice(i, i + LIMIT) }, annotations: { bold, italic } });
    }
  }
  return out.length ? out : [{ type: "text", text: { content: "" } }];
}

const cells = (line) => line.replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, "|").trim());

export function markdownToBlocks(md) {
  const lines = String(md).replace(/\r/g, "").split("\n");
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();
    if (!t) continue;

    if (/^\|.*\|$/.test(t)) {
      // A table is its rows plus the separator line; gather them, drop the separator, keep the rest.
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        const r = lines[i].trim();
        if (!/^\|[\s:|-]+\|$/.test(r)) rows.push(cells(r));
        i++;
      }
      i--;
      if (!rows.length) continue;
      const width = Math.max(...rows.map((r) => r.length));
      blocks.push({
        type: "table",
        table: {
          table_width: width,
          has_column_header: true,
          has_row_header: false,
          children: rows.map((r) => ({
            type: "table_row",
            table_row: { cells: Array.from({ length: width }, (_, c) => richText(r[c] ?? "")) },
          })),
        },
      });
      continue;
    }

    if (/^---+$/.test(t)) { blocks.push({ type: "divider", divider: {} }); continue; }
    const h = t.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      const tag = ["heading_1", "heading_2", "heading_3"][h[1].length - 1];
      blocks.push({ type: tag, [tag]: { rich_text: richText(h[2]) } });
      continue;
    }
    const b = t.match(/^[-*]\s+(.*)$/);
    if (b) { blocks.push({ type: "bulleted_list_item", bulleted_list_item: { rich_text: richText(b[1]) } }); continue; }
    const n = t.match(/^\d+[.)]\s+(.*)$/);
    if (n) { blocks.push({ type: "numbered_list_item", numbered_list_item: { rich_text: richText(n[1]) } }); continue; }

    blocks.push({ type: "paragraph", paragraph: { rich_text: richText(t) } });
  }
  return blocks;
}

// ---------------------------------------------------------------------------------------------
// Filing a candidate's reply onto their own row.
//
// A person answers the one question their application left blank. That answer is theirs, so it goes
// onto their page VERBATIM, under their name and the date, and it is never summarised, scored or
// rewritten on the way in. The hiring team reads what the candidate actually wrote.
//
// It does NOT touch the score. A reply changes the evidence, and a score is recomputed deliberately by
// a run that records what it saw — not silently by an inbound email, which would let a stranger's mail
// move a number on a client's board.
// ---------------------------------------------------------------------------------------------

/** Find a row on a board by email. Returns null rather than guessing at a near-match. */
export async function findRowByEmail(databaseId, email) {
  const wanted = String(email || "").toLowerCase().trim();
  if (!wanted) return null;
  const rows = await queryAll(databaseId);
  return rows.find((r) => (r.properties.Email?.email || "").toLowerCase() === wanted) || null;
}

/**
 * Append a candidate's reply to their page and stamp the date on the row.
 * Idempotent per `markerText`: a duplicate delivery of the same reply is not appended twice.
 */
export async function fileCandidateReply(databaseId, { email, name, asked, reply, receivedAt }) {
  const row = await findRowByEmail(databaseId, email);
  if (!row) return { ok: false, reason: "no row on this board for that address" };

  const body = String(reply || "").trim();
  if (!body) return { ok: false, reason: "empty reply" };
  const marker = `Replied ${receivedAt}`;

  const kids = await listChildren(row.id);
  const seen = kids.some((b) => b.type === "heading_2" &&
    (b.heading_2.rich_text || []).map((x) => x.plain_text).join("").trim() === marker);
  if (seen) return { ok: true, duplicate: true, pageId: row.id };

  const md = [
    `## ${marker}`,
    asked ? `_We asked what their application did not mention: ${asked}. Their answer, exactly as they sent it:_` : `_Their reply, exactly as they sent it:_`,
    "",
    ...body.split(/\n{2,}/).map((para) => para.replace(/\n/g, " ").trim()).filter(Boolean),
    "",
    `---`,
    `*Filed automatically when they replied. Not summarised, not scored. The score on this row still reflects the evidence listed under Scored on, and moves only when a review is run again.*`,
  ].join("\n");

  await appendBlocks(row.id, markdownToBlocks(md));
  const props = {};
  if (row.properties["Replied on"]) props["Replied on"] = { date: { start: String(receivedAt).slice(0, 10) } };
  if (Object.keys(props).length) await updateProperties(row.id, props);
  return { ok: true, pageId: row.id };
}


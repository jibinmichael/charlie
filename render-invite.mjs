// render-invite.mjs — computeMissing: which real preference fields a person's dossier still lacks.
//
// Used by confirm-sweep.mjs to ask only for what is genuinely absent. Every gap listed is REAL
// (computed from the person's own dossier), never a padded checklist. The remaining helpers below
// are unused leftovers of an earlier invitation template.

const SANS = "'Avenir Next',Avenir,'Segoe UI',Roboto,'Helvetica Neue',Helvetica,Arial,sans-serif";
const SERIF = "'Sanchez',Georgia,'Times New Roman',serif";
const LIME = "#e8fa5e", INK = "#17140f", CORAL = "#F75858", CORALD = "#D93F3F", MUT = "#7c766a", FAINT = "#9a9082";
// brand mark = the coral hand, hosted as a PNG (email clients strip inline SVG)
const HAND = `${process.env.CHARLIE_SITE_URL || "https://example.com"}/charlie-hand.png`;
import { SANCHEZ_FACE } from "./sanchez-font.mjs";

// which real fields is this person's dossier still missing? grounded in their own preferences —
// we only ever ask for what is genuinely absent, never a padded checklist.
export function computeMissing(dossier = {}) {
  const p = dossier.preferences || {};
  const has = (v) => v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && v.length === 0);
  const items = [];
  if (!has(p.ping_bar)) items.push({ label: "Your ping bar", prompt: "What kind of role is worth interrupting you for?" });
  if (!has(p.stage)) items.push({ label: "Company stage", prompt: "Startup, growth, or established? What fits you." });
  if (!has(p.values)) items.push({ label: "What you value", prompt: "What matters most to you in a team and a role." });
  if (!has(p.dealbreakers)) items.push({ label: "Your dealbreakers", prompt: "What you won't accept, ever." });
  if (!has(p.comp_floor)) items.push({ label: "Your pay floor", prompt: "The number below which it isn't worth your time." });
  return items;
}

// ── 8-bit KEY (matches the "secret key" subject): gold shape + auto ink outline (reads on lime) ──
function keyScene() {
  const g = {}; const set = (a, b, w, h, c) => { for (let y = b; y < b + h; y++) for (let x = a; x < a + w; x++) g[x + "," + y] = c; };
  const G = "#e6b23a";
  set(3, 3, 3, 1, G); set(2, 4, 5, 1, G); set(2, 5, 2, 1, G); set(5, 5, 2, 1, G);
  set(2, 6, 5, 1, G); set(3, 7, 3, 1, G); set(6, 5, 8, 2, G); set(11, 7, 1, 1, G); set(13, 7, 1, 2, G);
  const out = {};
  for (const k in g) { const [x, y] = k.split(",").map(Number);
    [[1,0],[-1,0],[0,1],[0,-1]].forEach(([dx, dy]) => { const nk = (x + dx) + "," + (y + dy); if (!g[nk]) out[nk] = "#14110c"; }); }
  Object.assign(g, out); g["3,4"] = "#ffe08a";
  const W = 20, H = 13, L1 = "#e8fa5e", L2 = "#dff24a";
  const s = Array.from({ length: H }, (_, y) => Array.from({ length: W }, (_, x) => ((x + y) % 2 ? L1 : L2)));
  [[1,1,"#e6b23a"],[18,1,"#e0466a"],[0,6,"#F75858"],[19,6,"#ffffff"],[1,11,"#F75858"],[18,11,"#e6b23a"],[10,0,"#e0466a"],[10,12,"#F75858"]]
    .forEach(([x, y, c]) => { if (s[y] && x < W) s[y][x] = c; });
  const OX = 3, OY = 2;
  for (const k in g) { const [x, y] = k.split(",").map(Number); const sx = OX + x, sy = OY + y; if (s[sy] && sx >= 0 && sx < W) s[sy][sx] = g[k]; }
  const CS = 13;
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;margin:0 auto;"><tbody>${
    s.map((row) => `<tr>${row.map((c) => `<td width="${CS}" height="${CS}" style="width:${CS}px;height:${CS}px;line-height:${CS}px;font-size:1px;background:${c};">&nbsp;</td>`).join("")}</tr>`).join("")
  }</tbody></table>`;
}

const benefit = (icon, title, desc) => `<tr>
  <td width="32" style="vertical-align:top;padding:0 13px 14px 0;font-size:16px;line-height:1.2;">${icon}</td>
  <td style="padding:0 0 14px;font-family:${SANS};">
    <div style="font-size:14.5px;font-weight:600;color:${INK};line-height:1.3;">${title}</div>
    <div style="font-size:13px;color:${MUT};line-height:1.5;margin-top:2px;">${desc}</div>
  </td></tr>`;

const enc = encodeURIComponent;

// The invitation drip itself is intentionally absent (drip-removal.test.mjs keeps it out);
// computeMissing above is the live export.

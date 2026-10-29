// render-confirmation.mjs — the "you're in" card. Sent once, the moment an invited person finishes
// their dossier (computeMissing → empty). Celebratory but humble: no swagger, no guilt (per the
// VIP language rule). The 8-bit graphic is a GIFT (the reward), a deliberate echo of the invite's key.

const SANS = "'Avenir Next',Avenir,'Segoe UI',Roboto,'Helvetica Neue',Helvetica,Arial,sans-serif";
const SERIF = "'Sanchez',Georgia,'Times New Roman',serif";
const LIME = "#e8fa5e", INK = "#17140f", CORALD = "#D93F3F", MUT = "#7c766a", FAINT = "#9a9082";
// brand mark = the coral hand, hosted as a PNG (email clients strip inline SVG)
const HAND = `${process.env.CHARLIE_SITE_URL || "https://example.com"}/charlie-hand.png`;
import { SANCHEZ_FACE } from "./sanchez-font.mjs";

// ── 8-bit GIFT (blue box, gold ribbon + bow) + auto ink outline so it reads on lime ──
function giftScene() {
  const g = {}; const set = (a, b, w, h, c) => { for (let y = b; y < b + h; y++) for (let x = a; x < a + w; x++) g[x + "," + y] = c; };
  const B = "#F75858", G = "#e6b23a", L = "#FFB4B4";
  set(5, 2, 2, 2, G); set(9, 2, 2, 2, G); set(4, 3, 2, 2, G); set(10, 3, 2, 2, G); set(7, 3, 2, 2, G); // bow
  set(3, 6, 10, 2, B);                     // lid
  set(4, 8, 8, 6, B);                      // box
  set(7, 6, 2, 8, G);                      // ribbon (over box)
  set(4, 8, 1, 3, L);                      // sheen
  const out = {};
  for (const k in g) { const [x, y] = k.split(",").map(Number);
    [[1,0],[-1,0],[0,1],[0,-1]].forEach(([dx, dy]) => { const nk = (x + dx) + "," + (y + dy); if (!g[nk]) out[nk] = "#14110c"; }); }
  Object.assign(g, out);
  const W = 20, H = 15, L1 = "#e8fa5e", L2 = "#dff24a";
  const s = Array.from({ length: H }, (_, y) => Array.from({ length: W }, (_, x) => ((x + y) % 2 ? L1 : L2)));
  [[1,1,"#e6b23a"],[18,1,"#e0466a"],[0,7,"#F75858"],[19,7,"#ffffff"],[1,13,"#F75858"],[18,13,"#e6b23a"],[10,0,"#e0466a"]]
    .forEach(([x, y, c]) => { if (s[y] && x < W) s[y][x] = c; });
  const OX = 3, OY = 1;
  for (const k in g) { const [x, y] = k.split(",").map(Number); const sx = OX + x, sy = OY + y; if (s[sy] && sx >= 0 && sx < W) s[sy][sx] = g[k]; }
  const CS = 13;
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;margin:0 auto;"><tbody>${
    s.map((row) => `<tr>${row.map((c) => `<td width="${CS}" height="${CS}" style="width:${CS}px;height:${CS}px;line-height:${CS}px;font-size:1px;background:${c};">&nbsp;</td>`).join("")}</tr>`).join("")
  }</tbody></table>`;
}

export function renderConfirmation({ unsubUrl = "#" } = {}) {
  return `<!doctype html><html lang="en" xmlns="http://www.w3.org/1999/xhtml"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="X-UA-Compatible" content="IE=edge"><meta name="x-apple-disable-message-reformatting">
<style>${SANCHEZ_FACE}</style><title>You're in</title></head>
<body style="margin:0;padding:0;background:#F5F3F0;font-family:${SANS};color:#2c2822;-webkit-font-smoothing:antialiased;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F5F3F0;"><tbody><tr>
<td align="center" style="padding:24px 12px 44px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:560px;background:#ffffff;border:1px solid #e1dacd;border-radius:8px;"><tbody>

<tr><td style="padding:13px 32px;border-bottom:1px solid #eae4d9;"><img src="${HAND}" width="28" height="28" alt="Charlie" style="display:block;"></td></tr>

<tr><td align="center" style="padding:28px 30px 10px;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="background:${LIME};border-radius:16px;box-shadow:0 8px 24px rgba(23,20,15,.20), 0 3px 8px rgba(23,20,15,.14);"><tbody><tr><td align="center" style="padding:20px 24px 20px;">
    ${giftScene()}
    <div style="font-family:${SANS};font-size:13px;font-weight:600;letter-spacing:.02em;color:${INK};margin:16px 0 0;">You&rsquo;re in!</div>
  </td></tr></tbody></table>
</td></tr>

<tr><td style="padding:22px 32px 4px;">
  <div style="font-family:${SERIF};font-size:19px;color:${INK};line-height:1.3;">You&rsquo;re officially in the Club.</div>
  <div style="font-family:${SANS};font-size:14px;color:#2c2822;line-height:1.62;margin-top:8px;">Thank you for finishing your profile. That&rsquo;s the part that lets me find roles that actually fit you, not just ones that match a keyword.</div>
</td></tr>

<tr><td style="padding:16px 32px 6px;">
  <div style="font-family:${SANS};font-size:10px;font-weight:600;letter-spacing:.13em;text-transform:uppercase;color:${CORALD};margin:0 0 12px;">What happens now</div>
  <div style="font-family:${SANS};font-size:13.5px;color:#2c2822;line-height:1.62;">I&rsquo;m already looking. When a role genuinely fits you, you&rsquo;ll hear it, honest about the fit and everything you need to go for it. Keep an eye out, something good is on its way.</div>
</td></tr>

<tr><td style="padding:16px 32px 30px;">
  <div style="font-family:${SANS};font-size:13.5px;color:${MUT};line-height:1.6;">Reply any time, I&rsquo;m here.</div>
  <div style="font-family:${SERIF};font-size:15px;color:${INK};margin-top:14px;">Charlie</div>
</td></tr>

</tbody></table>
<div style="font-family:${SANS};font-size:11.5px;line-height:1.7;color:${FAINT};max-width:560px;margin:16px auto 0;padding:0 32px;text-align:center;">
  You&rsquo;re one of the first 100 in the Club. <a href="${unsubUrl}" style="color:${MUT};">Unsubscribe</a>
</div>
</td></tr></tbody></table></body></html>`;
}

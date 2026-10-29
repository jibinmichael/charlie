// emails/tokens.mjs — the LOCKED design constants for Charlie's emails.
//
// TWO intentional, SEPARATE palettes — never merge them, never "fix" one to match the other:
//   • LIFECYCLE — onboarding/welcome/prefs/ack/digest/etc. (email-kit.mjs). Trust-green on white.
//   • ROLE      — the sent role email (render-email.mjs). Trust-green accent on a warm canvas, v9.
// The VIP pair (render-invite.mjs / render-confirmation.mjs) is a self-contained third artifact with
// its own local palette + pixel-art logo; it is NOT tokenized here (locked by its snapshot test).
//
// THE GREEN FAMILY, and why it is three values and not one. #00B67A is a FILL colour: at 2.4:1 on
// white it is legible as a bar, a badge fill or a lit glyph, and illegible as text. So anything that
// must be READ uses a darker member of the same hue, chosen against the WCAG AA floor rather than by
// eye: #00805A clears 4.5:1 on white (4.96:1), and #00654A clears it on the mint tint (6.3:1).
// Substituting the bright green into a text slot silently fails a contrast rule
// nothing in CI checks — that is the one way to get this palette wrong.
//
// KEY NAMES ARE FROZEN, VALUES ARE NOT. `coral` and `rvl.green` are read by name across ~30
// templates; renaming either is a large refactor for zero visual gain, so `coral` holds a green.
//
// Values are extracted verbatim from the templates. Any change here breaks a snapshot test; that is
// intentional: a palette change must be a deliberate, reviewed decision.

// The three members of the accent family. Named by JOB, not by shade, so a future re-hue changes
// three values here and nothing else in the file.
const FILL = "#00B67A";  // brand green — fills, bars, lit glyphs. NEVER text.
const INK = "#00805A";   // 4.96:1 on white — accent text, badge backgrounds behind white type.
const DEEP = "#00654A";  // 6.3:1 on the mint tint — small bold type inside a green pill.
const MINT = "#E8F8F1";  // the soft tint, ~9.5% FILL on white.

// ── LIFECYCLE (email-kit.mjs — palette `C`, HEAD_FONT, SANS, FONT_LINK) ──────
export const LIFECYCLE = {
  colors: {
    ink: "#2A2521", muted: "#7A7268", faint: "#AAA298",
    // `coral` is the brand accent (name frozen — read by ~30 templates). `green` ("success") is the
    // readable member of the SAME hue, so accent and success are one family (two unrelated greens on
    // one email read as a mistake) and amber stays the only other signal.
    coral: FILL, green: INK, amber: "#B5740F",
    line: "#ECE9E3", soft: "#F6F5F2",
    peach: "#F6F5F2", greenbg: MINT, amberbg: "#FBF3E3", frame: "#F6F5F2",
    signal_soft: MINT, // soft accent tint for the "one move" block
    body: "#FFFFFF", text: "#4A453E", card: "#FFFFFF",
    white: "#ffffff", // inline white used on CTA button/pill text + backgrounds
  },
  fonts: {
    head: "'Sanchez', Georgia, 'Times New Roman', serif",
    sans: "'Avenir Next',Avenir,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif",
  },
  fontLink: `<link href="https://fonts.googleapis.com/css2?family=Sanchez&display=swap" rel="stylesheet">`,
  whatsapp: "#1FA855", // WhatsApp's OWN brand green on the share pill — theirs, not ours; never re-hue it
  chart: { rust: FILL, grey: "#8F8F8F", ink: "#1A1A1A", track: "#EEEEEE" }, // hiring-report bar chart (key name historical)
};

// ── ROLE (render-email.mjs — palette `P` + hoisted inline hexes) ─────────────
export const ROLE = {
  colors: {
    canvas: "#F5F3F0", paper: "#ffffff", text: "#494540", head: "#1b1710", sub: "#5c564e",
    faint: "#9a9082", line: "#eae4d9", hair: "#e1dacd",
    accent: FILL, accentDeep: INK, track: MINT, chipBg: MINT,
  },
  fonts: {
    sans: "'Avenir Next',Avenir,'Segoe UI',Roboto,'Helvetica Neue',Helvetica,Arial,sans-serif",
    serif: "'Sanchez',Georgia,'Times New Roman',serif",
    mono: "'Menlo',ui-monospace,'SF Mono',Consolas,monospace",
  },
  white: "#fff", // inline white used on the verified badge check + the referral avatar
  // `empty` is the unlit florette and stays NEUTRAL GREY on purpose: a muted green would read as a
  // third state. `filled` is unreferenced by current templates; it stays so anything importing it
  // never gets `undefined` mid-render.
  fitMeter: { filled: "#6FD4AC", empty: "#ECEEEC", verdict: INK },
  // résumé-vs-listing status pills (met / partial / unknown): { bg, fg, tag }
  // "Have it" is green: red-on-pink is the colour every other product uses for a problem.
  fp: {
    met: { bg: MINT, fg: DEEP, tag: "Have it" },
    partial: { bg: "#FBF1DC", fg: "#9a6b13", tag: "Partly" },
    unknown: { bg: "#ECEEEC", fg: "#8a8a86", tag: "Not shown" },
  },
  // contextual chip tones: [bg, fg]
  chip: { pos: [MINT, DEEP], neutral: ["#ECEEEC", "#6D6A66"], caution: ["#FBF1DC", "#9a6b13"] },
  // diverging résumé-vs-listing chart. `green` is the "you bring" bar;
  // `amber`/`grey` stay on the gap side for contrast.
  rvl: { green: FILL, amber: "#E9B84A", grey: "#D8DAD6", spine: "1px solid #ece6db", gapInk: "#8a8a86", haveInk: DEEP },
  // callout box backgrounds. `position` is deliberately a shade deeper than MINT so a callout sitting
  // near a chip does not read as the same surface.
  box: { catch: "#EDEFEC", position: "#DFF3EA", advice: "#FAFAF8" },
  // market-weave highlight span
  hl: { bg: "#fdf0a3", ink: "#2c2410" },
  // Label badge (the eyebrow pill above the role title) themes. { bg, fg }. THE ONLY place a label
  // chip color is defined; render-email.mjs picks by label name and never hardcodes a chip color.
  //  - default  : the accent — "Today's pick" / "Fresh pick" / "Closest to your profile".
  //  - rareFind : a distinct plum so a rare-combo match ("Rare find") reads as special, not routine.
  // Text stays paper-white on both; the color is the ONLY difference.
  //
  // INK, NOT FILL. This badge carries white 11px uppercase type, so it is a text surface: white on
  // FILL is 2.4:1 and unreadable, white on INK is 4.96:1 and clears AA. The badge being a shade
  // deeper than the bars is the contrast requirement showing through, not an inconsistency.
  labels: {
    default: { bg: INK, fg: "#ffffff" },
    rareFind: { bg: "#6B4E9E", fg: "#ffffff" },
  },
};

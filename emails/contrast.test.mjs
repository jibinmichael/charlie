// emails/contrast.test.mjs — white type must never sit on the bright accent fill.
//
// Accent colours are tokenized, so changing one token value changes every template at once — and a
// brighter accent can silently drop white-on-accent text below a readable contrast (white on #00B67A
// is 2.4:1) without one line of the templates changing. A snapshot records that the hex changed; it
// has no opinion about readability. Only a test that reads the RENDERED HTML can hold a colour pairing.
//
// The palette's own contract, from emails/tokens.mjs:
//   FILL #00B67A  2.4:1 on white — bars, badges, lit glyphs. NEVER behind text.
//   INK  #00805A  4.96:1 on white — accent text, and any surface carrying white type.
//   DEEP #00654A  6.3:1 on the mint tint — small bold type inside a green pill.
//
// This test does not re-derive contrast ratios; it enforces the one pairing that is always wrong.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { renderEmail } from "../render-email.mjs";
import { renderWelcome, renderPrefsUpdated, renderAck, renderRolePicks, renderHeldRoles, renderFirstRoleClosest, unsubscribeConfirmPage } from "../email-kit.mjs";
import { ROLE, LIFECYCLE } from "./tokens.mjs";
import * as F from "./fixtures.mjs";

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-07-12T12:00:00.000Z"));
});
afterAll(() => vi.useRealTimers());

/** The bright fill, in whatever form a template writes it. Both palettes share the value. */
const FILL = ROLE.colors.accent.toLowerCase();

/**
 * Every `style="..."` block in the HTML that sets BOTH a white foreground and the bright fill as its
 * background. Returns the offending style strings, so a failure names the element rather than a count.
 *
 * Deliberately scoped to ONE style attribute: an element inherits nothing useful across a table cell
 * boundary in email HTML, so same-attribute is where the pairing is real and provable. A white-on-fill
 * pairing split across two elements is not something this can see, and is not claimed to be.
 */
function whiteOnFill(html) {
  const out = [];
  for (const m of String(html || "").matchAll(/style="([^"]*)"/g)) {
    const s = m[1].toLowerCase();
    const hasFill = new RegExp(`background(?:-color)?\\s*:\\s*${FILL}\\b`).test(s);
    if (!hasFill) continue;
    if (/(?:^|[;\s])color\s*:\s*(#fff\b|#ffffff\b|white\b)/.test(s)) out.push(m[1]);
  }
  return out;
}

/**
 * The BUTTON idiom, which same-attribute matching cannot see: the fill sits on a `<td>` and the white
 * type on the `<a>` inside it. That is how every CTA in this codebase is built, so a same-attribute
 * scanner alone is blind to the most common way the mistake gets made.
 *
 * Deliberately narrow: an element carrying the fill, then within the next ~400 characters (i.e. still
 * inside that cell) an element setting a white foreground. Longer than that and the nesting claim
 * stops being safe to make.
 */
function whiteOnFillNested(html) {
  const s = String(html || "");
  const out = [];
  const fill = new RegExp(`style="[^"]*background(?:-color)?\\s*:\\s*${FILL}\\b[^"]*"`, "gi");
  for (const m of s.matchAll(fill)) {
    const after = s.slice(m.index + m[0].length, m.index + m[0].length + 400);
    // The optional `[^"]*[;\s]` prefix is load-bearing: in a real button `color` is the FIRST
    // property in the `<a>`, so requiring a separator before it matched nothing. The self-proof
    // assertion below caught that, which is the entire reason it is written before the real cases.
    if (/style="(?:[^"]*[;\s])?color\s*:\s*(?:#fff\b|#ffffff\b|white\b)/i.test(after)) {
      out.push(after.replace(/\s+/g, " ").slice(0, 140));
    }
  }
  return out;
}

describe("the contrast contract", () => {
  it("proves itself: a hand-built white-on-fill element IS detected", () => {
    // Without this the test could pass by never matching anything, which is how a guard becomes
    // decoration. Both halves asserted: the bad pairing trips it, the correct one does not.
    expect(whiteOnFill(`<span style="background:${ROLE.colors.accent};color:#ffffff;">x</span>`)).toHaveLength(1);
    expect(whiteOnFill(`<span style="background:${ROLE.colors.accentDeep};color:#ffffff;">x</span>`)).toHaveLength(0);
    // The fill behind non-white type is fine — it is only the white pairing that fails.
    expect(whiteOnFill(`<div style="background:${ROLE.colors.accent};color:${ROLE.colors.head};">x</div>`)).toHaveLength(0);
  });

  it("the accent family still separates fill from ink", () => {
    // If someone "simplifies" these to one value, every fix below silently reverts.
    expect(ROLE.colors.accent).not.toBe(ROLE.colors.accentDeep);
    expect(LIFECYCLE.colors.coral).not.toBe(LIFECYCLE.colors.green);
    expect(LIFECYCLE.colors.coral.toLowerCase()).toBe(FILL); // both palettes share the fill
  });
});

describe("no rendered email puts white type on the bright fill", () => {
  // The three role-email fixtures exercise the verified badge and the referral avatar, which are the
  // two surfaces that regressed. ROLE_US carries the referral block; the badge renders in all of them.
  const roleCases = [["ROLE_US", F.ROLE_US], ["ROLE_RARE", F.ROLE_RARE], ["ROLE_THIN", F.ROLE_THIN]];
  for (const [name, fixture] of roleCases) {
    it(`role email — ${name}`, () => {
      const bad = whiteOnFill(renderEmail(fixture));
      expect(bad, `white on ${FILL} in ${name}:\n${bad.join("\n")}`).toEqual([]);
    });
  }

  const lifecycleCases = [
    ["renderWelcome", () => renderWelcome(F.WELCOME)],
    ["renderPrefsUpdated", () => renderPrefsUpdated(F.PREFS_UPDATED)],
    ["renderAck", () => renderAck(F.ACK)],
    ["renderRolePicks", () => renderRolePicks(F.ROLE_PICKS)],
    ["renderHeldRoles", () => renderHeldRoles(F.HELD_ROLES)],
    ["renderFirstRoleClosest", () => renderFirstRoleClosest(F.FIRST_ROLE_CLOSEST)],
  ];
  for (const [name, render] of lifecycleCases) {
    it(`lifecycle — ${name}`, () => {
      const out = render();
      const bad = whiteOnFill(out?.html ?? out);
      expect(bad, `white on ${FILL} in ${name}:\n${bad.join("\n")}`).toEqual([]);
    });
  }

  it("the BUTTON idiom too — fill on the cell, white type on the link inside it", () => {
    // THE GAP THIS CLOSES. The Pro CTA is `<td style="background:FILL"><a style="color:#fff">`, which
    // same-attribute matching cannot see, so the original scanner reported clean while a real button
    // sat at 2.4:1. It was found by a human reading markup, which is the thing tests exist to replace.
    expect(whiteOnFillNested(`<td style="background:${ROLE.colors.accent};"><a style="color:#ffffff;">go</a></td>`)).toHaveLength(1);
    expect(whiteOnFillNested(`<td style="background:${ROLE.colors.accentDeep};"><a style="color:#ffffff;">go</a></td>`)).toHaveLength(0);

    const prev = process.env.PRO_PITCH;
    process.env.PRO_PITCH = "on"; // the block is flag-gated, so the default render never exercised it
    try {
      for (const [name, fx] of [["ROLE_US", F.ROLE_US], ["ROLE_RARE", F.ROLE_RARE], ["ROLE_THIN", F.ROLE_THIN]]) {
        const html = renderEmail(fx);
        expect(html, `${name}: the Pro block must actually render, or this proves nothing`).toContain("I'm interested");
        const bad = [...whiteOnFill(html), ...whiteOnFillNested(html)];
        expect(bad, `white on ${FILL} in ${name} with PRO_PITCH on:\n${bad.join("\n")}`).toEqual([]);
      }
    } finally {
      if (prev === undefined) delete process.env.PRO_PITCH; else process.env.PRO_PITCH = prev;
    }
  });

  it("the unsubscribe confirm page", () => {
    // NOT an email, and that is exactly why it was missed: it is a page the unsubscribe link opens,
    // so no email test rendered it. Its button was white-on-C.coral.
    const bad = whiteOnFill(unsubscribeConfirmPage({ email: "a@b.com", action: "/unsubscribe?t=x" }));
    expect(bad, `white on ${FILL} on the unsubscribe page:\n${bad.join("\n")}`).toEqual([]);
  });
});

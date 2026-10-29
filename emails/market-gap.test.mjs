// emails/market-gap.test.mjs — the market-gap drop template's grounding + safety contract.
// The load-bearing facts (gap label, the "N of M asked" count, attributed market lines) are
// CODE-rendered; the model `copy` is optional prose that must never leak a placeholder or trip the
// voice lint. These tests lock all of that, plus an HTML snapshot.
import { describe, it, expect } from "vitest";
import { renderMarketGap } from "../email-kit.mjs";
import { honestyVoiceOk } from "../market-gap.mjs";

const base = { email: "sam@example.com" };
const research = {
  lines: [{ claim: "senior PM postings increasingly require product analytics", source: "https://example.com/report" }],
  pay: { median: 145000, label: "Product managers", area: "US", source: "https://www.bls.gov/oes/x.htm" },
};

describe("renderMarketGap — grounded facts are code-rendered", () => {
  const m = renderMarketGap({ ...base, gap: { gap: "product analytics", key: "product analytics" }, count: 3, total: 5, kind: "share", stalled: false, research, copy: null });

  it("renders the exact grounded count + gap as a visual chart, never a model guess", () => {
    expect(m.html).toContain("Shows up in 3 of the 5 roles closest to you");
    expect(m.html).toContain("product analytics");
    expect(m.text).toContain("product analytics shows up in 3 of the 5 roles closest to you");
  });

  it("uses NO bold (weight ceiling is medium; emphasis is the coral accent + the chart)", () => {
    expect(m.html).not.toMatch(/<b[ >]/);
    expect(m.html).not.toMatch(/font-weight:\s*(700|800|900|bold)/);
  });

  it("frames the absence as opportunity, never as a deficiency (voice contract)", () => {
    const body = `${m.subject}\n${m.text}`.toLowerCase();
    for (const penalizing of ["nothing from you", "that's why", "aren't landing", "you haven't", "the reason it"]) {
      expect(body).not.toContain(penalizing);
    }
  });

  it("attributes every market line to its real source (never Charlie's own voice)", () => {
    expect(m.html).toMatch(/example\.com\/report"[^>]*>source<\/a>/);
    expect(m.html).toContain("$145,000 median");
    expect(m.html).toMatch(/bls\.gov\/oes\/x\.htm/);
    expect(m.text).toContain("(source: https://example.com/report)");
  });

  it("never leaks the {{GAP}} placeholder and never ships an em/en dash", () => {
    for (const s of [m.html, m.text, m.subject]) {
      expect(s).not.toContain("{{GAP}}");
      expect(s).not.toMatch(/[—–]/);
    }
  });

  it("clears the voice lint on the fail-closed default copy", () => {
    expect(honestyVoiceOk({ subject: m.subject, text: m.text }).ok).toBe(true);
  });
});

describe("renderMarketGap — model copy is substituted and contained", () => {
  it("substitutes {{GAP}} in model-written fields and the subject", () => {
    const m = renderMarketGap({
      ...base, gap: { gap: "comp floor", key: "comp floor" }, count: 2, total: 4, kind: "pref", stalled: true, research: {},
      copy: { subject: "the one thing: {{GAP}}", opening: "you've seen a few.", gap_framing: "roles keep asking for {{GAP}}.", close_line: "reply and re-aim.", honest_line: "if it's off, tell me." },
    });
    expect(m.subject).toBe("the one thing: comp floor");
    expect(m.html).toContain("roles keep asking for comp floor.");
    expect(m.html).not.toContain("{{GAP}}");
    expect(honestyVoiceOk({ subject: m.subject, text: m.text }).ok).toBe(true);
  });

  it("is dash-safe when the gap label itself carries an en/em dash (else it fails closed on real data)", () => {
    const m = renderMarketGap({ ...base, gap: { gap: "5–7 years", key: "5 7 years" }, count: 3, total: 5, kind: "share", stalled: true, research: {}, copy: null });
    for (const s of [m.subject, m.text, m.html]) expect(s).not.toMatch(/[—–]/);
    expect(honestyVoiceOk({ subject: m.subject, text: m.text }).ok).toBe(true); // placeholder/voice regression guard
  });

  it("works with no research and no model copy (pool-signal-only path)", () => {
    const m = renderMarketGap({ ...base, gap: { gap: "kubernetes", key: "kubernetes" }, count: 4, total: 6, kind: "share" });
    expect(m.html).toContain("Shows up in 4 of the 6 roles closest to you");
    expect(m.html).not.toContain("what the market says"); // no market block when research is empty
  });
});

describe("renderMarketGap — snapshot", () => {
  it("share / never-matched / with research", () => {
    expect(renderMarketGap({ ...base, gap: { gap: "product analytics", key: "product analytics" }, count: 3, total: 5, kind: "share", stalled: false, research, copy: null })).toMatchSnapshot();
  });
});

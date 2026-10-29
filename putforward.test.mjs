// putforward.test.mjs — the per-company introduction offer.
//
// WHY IT IS NOT THE REPRESENT LETTER. That one asks in general whether Charlie may represent someone,
// and most people do not answer; treating silence as "declined" would be wrong, because expecting
// everyone to notice one email is not a consent model. So this email is
// gated on FIT instead: it only reaches a person whose grounded coverage against THIS role cleared
// the floor. Their reply is the consent, for one named company rather than a blanket yes.
import { describe, it, expect } from "vitest";
import { renderPutForward, PUTFORWARD_SUBJECT } from "./email-kit.mjs";

const base = { email: "a@b.com", name: "Priya", role: "Senior Product Designer", why: ["You owned the Lumen design system from tokens through adoption", "They ask for six years and you have seven"] };

describe("the introduction offer", () => {
  it("names the role and speaks to the person, not about them", () => {
    const m = renderPutForward(base);
    expect(m.subject).toBe("Senior Product Designer, and I think it is you");
    expect(m.text).toContain("Priya");
    expect(m.text).toContain("You owned the Lumen design system");
    // never third person: this is a letter to them, not a recruiter appraising a candidate
    expect(m.text).not.toMatch(/\b(she|he|they)\s+(has|have|is|was)\b/i);
  });

  it("NEVER promises an outcome", () => {
    // An oversold introduction is worse than none: the let-down lands on the one product they trusted.
    const m = renderPutForward(base);
    expect(m.text).toContain("I cannot promise they will reply");
    expect(m.text).not.toMatch(/\b(guarantee|you will get|interview is|hired|offer)\b/i);
  });

  it("does NOT name a company until the employer has agreed", () => {
    // Naming a company that then goes quiet manufactures a disappointment we cannot undo.
    const anon = renderPutForward(base);
    expect(anon.text).toContain("a company I have been talking to");
    expect(anon.text).not.toMatch(/\bKeka\b/);
    const named = renderPutForward({ ...base, company: "Keka" });
    expect(named.text).toContain("Keka");
  });

  it("the gap is an INVITATION, never a deficiency", () => {
    const m = renderPutForward({ ...base, gap: "whether you have worked on B2B SaaS at this scale." });
    expect(m.text).toContain("One thing I cannot answer for them");
    expect(m.text).toContain("tell me and I will put it in");
    // generic keyword-chart wording (e.g. telling a frontend engineer that Git is his gap)
    expect(m.text).not.toMatch(/\b(missing|lack|you do not have|shortfall|weakness)\b/i);
  });

  it("asks for exactly ONE thing", () => {
    const m = renderPutForward(base);
    expect(PUTFORWARD_SUBJECT).toBe("Put me forward");
    expect(m.html).toContain("Put me forward");
    // one role per email. Three options makes it a job board again, which is what this is not.
    expect((m.text.match(/Senior Product Designer/g) || []).length).toBeLessThanOrEqual(2);
  });

  it("caps the reasons at three and survives having none", () => {
    // Counted in the REASONS block only. The four things we ask for back ("your notice period", ...)
    // are bullets too, so a whole-text count reads 7 and proves nothing about the cap.
    const many = renderPutForward({ ...base, why: ["a", "b", "c", "d", "e"] });
    const reasonsBlock = many.text.split("Reply with four things")[0];
    expect((reasonsBlock.match(/^- /gm) || []).length).toBe(3);
    const none = renderPutForward({ email: "a@b.com", role: "Engineer" });
    expect(none.text).not.toContain("undefined");
  });

  it("greets with the FIRST name, never the full extracted one", () => {
    // A dossier name is "Priya S". Opening a letter with someone's surname initial reads like a mail
    // merge, which is the one thing this email cannot afford: its whole claim is that a person looked.
    const m = renderPutForward({ ...base, name: "Marisol O" });
    expect(m.text).toContain("Dear Marisol,");
    expect(m.text).not.toContain("Marisol O,");
    expect(renderPutForward({ ...base, name: "" }).text).not.toMatch(/^Dear/);
  });

  it("survives junk AROUND a recipient, and refuses to render without one", () => {
    for (const bad of [{ email: "a@b.com" }, { email: "a@b.com", why: "nope" }, { email: "a@b.com", why: null }, { email: "a@b.com", role: null, gap: 42 }]) {
      expect(() => renderPutForward(bad), JSON.stringify(bad)).not.toThrow();
    }
    // No recipient must THROW, not render. The unsubscribe link is signed from the address, so an
    // email with no recipient would ship an unsubscribe nobody can use — fail closed at build time
    // rather than send something unactionable.
    expect(() => renderPutForward({})).toThrow(/email required/i);
  });

  it("carries no em dash in either half", () => {
    const m = renderPutForward({ ...base, company: "Keka", gap: "whether you have shipped design systems at scale." });
    expect(/—|–/.test(m.text + m.html)).toBe(false);
  });

  it("white type sits on the readable green, never the 2.4:1 fill", () => {
    // A known contrast trap. The CTA is a button.
    const m = renderPutForward(base);
    expect(m.html).toContain("background:#00805A");
    expect(m.html).not.toMatch(/background:#00B67A[^"]*"[^>]*>\s*<a[^>]*color:#FFFFFF/i);
  });
});

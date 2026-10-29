// pause-command.test.mjs — the "pause" reply command.
//
// Without it a user's only lever is `unsubscribe`: a permanent exit for what is usually a temporary
// feeling. A pause lets them step away and come back on their own.
//
// THE WEIGHT OF THESE TESTS IS ON NOT FIRING. The asymmetry is the design: failing to recognise a real
// "pause" costs one more email and they can say it again. Wrongly recognising one silences somebody
// mid-conversation, who may never learn why the roles stopped.
import { describe, it, expect } from "vitest";
import { parsePauseCommand, parseDuration } from "./lib/pause-command.mjs";
import { renderPaused, renderResumed } from "./email-kit.mjs";

describe("it recognises a real command", () => {
  it("pauses indefinitely on a bare word", () => {
    for (const t of ["pause", "Pause", "  pause  ", "pause please", "hold", "snooze", "not now", "hold off"]) {
      expect(parsePauseCommand(t), t).toEqual({ kind: "pause", days: null });
    }
  });

  it("NEVER reads 'stop' as a pause — it is the universal opt-out word", () => {
    // Someone typing "stop" expects to leave for good. Pausing them instead leaves them quiet and
    // still on the list, and the next thing they do is mark Charlie as spam. That costs the sending
    // domain far more than a missed pause.
    for (const t of ["stop", "STOP", "stop for now", "stop please"]) {
      expect(parsePauseCommand(t), t).toBeNull();
    }
  });

  it("tolerates courtesy and punctuation around a real command", () => {
    for (const t of ["Pause please!", "pause, thanks", "Resume, thanks", "restart please"]) {
      expect(parsePauseCommand(t), t).not.toBeNull();
    }
  });

  it("reads a stated duration", () => {
    expect(parsePauseCommand("pause 2 weeks").days).toBe(14);
    expect(parsePauseCommand("pause for a month").days).toBe(30);
    expect(parsePauseCommand("snooze 10 days").days).toBe(10);
    expect(parsePauseCommand("pause 3 months").days).toBe(90);
  });

  it("resumes", () => {
    for (const t of ["restart", "resume", "unpause", "start again", "im back", "I'm back", "continue"]) {
      expect(parsePauseCommand(t), t).toEqual({ kind: "resume", days: null });
    }
  });
});

describe("it does NOT fire on a sentence that merely contains the word", () => {
  it("ignores the word inside a real message", () => {
    // These are the ones that would silence someone mid-conversation.
    for (const t of [
      "I had to pause my search last year when I moved to Bangalore",
      "Can you restart the search but focus on remote roles in Pune instead?",
      "I want to pause applying to agencies but keep product roles coming",
      "Thanks, this is great. No need to pause anything.",
    ]) {
      expect(parsePauseCommand(t), t).toBeNull();
    }
  });

  it("requires the command at the START, not buried in a clause", () => {
    expect(parsePauseCommand("actually, pause")).toBeNull();
    expect(parsePauseCommand("if you could pause that would help")).toBeNull();
  });

  it("REJECTS a command at the start followed by real content", () => {
    // Anchoring only the start would let every one of these through, each silencing a real reply or
    // discarding a real preference. These put the word at the START with content after it, which a
    // mid-sentence-only test would never catch.
    for (const t of [
      "Hold on, I already applied to that one",
      "Not now, but ping me about design roles",
      "Stop for now on agencies, keep startups",
      "Continue with product roles only please",
      "restart my search with a higher salary bar",
      "Resume - but only remote roles",
    ]) {
      expect(parsePauseCommand(t), t).toBeNull();
    }
  });

  it("REJECTS a bare command with a second paragraph", () => {
    // Length is measured on the whole message: measuring only the first line would silently drop a
    // second paragraph.
    expect(parsePauseCommand("Pause\n\nActually, focus on Bangalore roles")).toBeNull();
  });

  it("ignores anything long enough to be a message rather than a command", () => {
    expect(parsePauseCommand("pause " + "x".repeat(80))).toBeNull();
    // measured on the WHOLE message, not the first line
    expect(parsePauseCommand("pause\n" + "x".repeat(80))).toBeNull();
  });

  it("returns null for junk", () => {
    for (const t of ["", "   ", null, undefined, 42, "thanks!", "ok"]) expect(parsePauseCommand(t)).toBeNull();
  });
});

describe("duration parsing", () => {
  it("caps a runaway number rather than losing someone for years", () => {
    // "pause 999 months" is a typo, and an indefinite pause is the safer reading of one.
    expect(parseDuration("pause 999 months")).toBe(180);
  });

  it("returns null when no duration is stated", () => {
    expect(parseDuration("pause")).toBeNull();
    expect(parseDuration("pause 0 days")).toBeNull();
  });
});

describe("the emails", () => {
  it("ALWAYS says how to come back — that is the point of the email", () => {
    // A pause confirmation without a way back is just a quieter unsubscribe.
    expect(renderPaused({ email: "a@b.com" }).text).toContain("restart");
    expect(renderPaused({ email: "a@b.com", days: 14 }).text).toMatch(/restart|pick it up again/);
  });

  it("promises the profile is kept, because the fear is losing it", () => {
    expect(renderPaused({ email: "a@b.com" }).text).toMatch(/stays exactly as it is|not deleting/);
  });

  it("names the duration when there is one, and does not invent one when there is not", () => {
    expect(renderPaused({ email: "a@b.com", days: 14 }).text).toContain("14 days");
    expect(renderPaused({ email: "a@b.com" }).text).toContain("until you tell me otherwise");
  });

  it("resuming says what changed while they were away", () => {
    expect(renderResumed({ email: "a@b.com", poolSize: 74237 }).text).toContain("74,237");
    // and degrades without a number rather than printing a hole
    expect(renderResumed({ email: "a@b.com" }).text).not.toContain("undefined");
  });

  it("carries no em dash in either half", () => {
    for (const r of [renderPaused({ email: "a@b.com", name: "P", days: 7 }), renderPaused({ email: "a@b.com" }), renderResumed({ email: "a@b.com", poolSize: 1 })]) {
      expect(/—|–/.test(r.text + r.html)).toBe(false);
    }
  });
});

// sender-gate.test.mjs — a script that mails a real person about a real job must clear preSendGuard.
//
// `sendGuarded` checks whether we may mail this ADDRESS (suppression, idempotency) and says nothing
// about whether we should mail them THIS ROLE. A script that routes only through sendGuarded can put
// a remote-only person forward for an on-site role, which `preSendGuard`'s `hardConstraintMiss`
// catches in one line:
//
//     constraint:location:remote-mismatch — wants remote; role location is "Bengaluru Office"
//
// THE RULE. A file under scripts/ that renders a JOB-SPECIFIC email to a candidate must import
// preSendGuard. Not "should" — the test fails otherwise. Lifecycle senders (corrections, nudges,
// announcements) are not about a role and are deliberately out of scope; the ALLOWLIST below names
// the guard-bypassing operator tools that are exempt.
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = join(process.cwd(), "scripts");

// Manual guard-exempt operator tools sending to controlled aliases. Adding a name here is a deliberate act that a reviewer will see in the diff.
const ALLOWLIST = new Set([
  "send-india-first.mjs",
  "send-profile-nudge.mjs",
  "send-us-roundup.mjs",
  "send-workdump-announce.mjs",
  "send-role-correction.mjs", // an apology about a role already sent, not an offer of a new one
]);

/** Does this file mail a candidate ABOUT A SPECIFIC ROLE? */
function mailsAboutARole(src) {
  const sends = /sendGuarded\s*\(|resend\.emails\.send/.test(src);
  if (!sends) return false;
  // A job-specific send names a role: it renders a role email, a put-forward, or reads a job object.
  return /renderEmail\s*\(|renderPutForward\s*\(|renderFirstRoleClosest\s*\(|\bjobTitle\b|\bapply_url\b/.test(src);
}

// An import STATEMENT and an actual CALL — never the bare word, which appears in every comment that
// explains why the guard matters, including the ones in this file's own subjects.
const IMPORTS_GUARD = /import\s*\{[^}]*\bpreSendGuard\b[^}]*\}\s*from/;
const CALLS_GUARD = /await\s+preSendGuard\s*\(/;

const files = readdirSync(DIR).filter((f) => f.endsWith(".mjs"));

describe("every script that mails someone about a role clears preSendGuard", () => {
  it("finds the scripts at all (a zero-file scan would pass by construction)", () => {
    expect(files.length).toBeGreaterThan(5);
  });

  for (const f of files) {
    const src = readFileSync(join(DIR, f), "utf8");
    if (!mailsAboutARole(src) || ALLOWLIST.has(f)) continue;
    it(`${f} imports AND calls preSendGuard`, () => {
      // BOTH, and neither may be satisfied by a comment. The first version of this test matched the
      // bare word anywhere in the file, so deleting the import still passed — the guard mentioned
      // itself in its own explanation. A test that cannot fail is decoration.
      expect(
        IMPORTS_GUARD.test(src),
        `${f} mails a candidate about a specific role and never IMPORTS preSendGuard. sendGuarded checks the ADDRESS (suppression, idempotency); preSendGuard checks the ROLE (repeat, hard constraints, geo, language, liveness). Import it, or add ${f} to the ALLOWLIST here with a reason.`,
      ).toBe(true);
      expect(CALLS_GUARD.test(src), `${f} imports preSendGuard but never awaits it`).toBe(true);
    });
  }

  it("send-putforward.mjs specifically", () => {
    const src = readFileSync(join(DIR, "send-putforward.mjs"), "utf8");
    expect(IMPORTS_GUARD.test(src)).toBe(true);
    expect(CALLS_GUARD.test(src)).toBe(true);
    // and it must ACT on the verdict, not merely call it
    expect(src).toMatch(/gate\.decision\s*!==\s*"send"/);
    expect(src).toMatch(/process\.exit\(1\)/);
  });

  it("proves itself: a file that only MENTIONS the guard does not pass", () => {
    const commentOnly = `// we should really use preSendGuard here one day\nawait sendGuarded({}); renderPutForward({});`;
    expect(IMPORTS_GUARD.test(commentOnly)).toBe(false);
    expect(CALLS_GUARD.test(commentOnly)).toBe(false);
    const real = `import { preSendGuard } from "../presend-guard.mjs";\nconst gate = await preSendGuard({ job, dossier });`;
    expect(IMPORTS_GUARD.test(real)).toBe(true);
    expect(CALLS_GUARD.test(real)).toBe(true);
  });
});

describe("the guard catches the remote-vs-on-site case", () => {
  it("a remote-wanting person against an on-site role is stopped", async () => {
    const { preSendGuard } = await import("./presend-guard.mjs");
    const gate = await preSendGuard({
      job: { id: "x:1", company: "Plotline", title: "Lead Recruiter", location: "Bengaluru Office", description: "x".repeat(400), apply_url: "https://example.test/1" },
      dossier: { headline: "Talent acquisition professional", preferences: { remote: "remote only", dealbreakers: ["on-site only"] }, proof_points: ["a", "b"] },
      signatures: { identities: new Set(), roleKeys: new Set(), coreKeys: new Set(), companies: [] },
      getCov: () => ({ thin: true }),
    });
    expect(gate.decision).not.toBe("send");
    expect(gate.rule).toMatch(/constraint/);
  });
});

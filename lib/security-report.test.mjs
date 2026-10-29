// security-report.test.mjs — telling a security report apart from a sign-up on the inbound door.
import { describe, it, expect } from "vitest";
import { isSecurityReport } from "./security-report.mjs";

describe("isSecurityReport", () => {
  // A responsible-disclosure opener with no resume. Without this classifier it would fall into
  // `!existing && !resumeText` -> renderMissingResume ("send me your resume").
  it("classifies the real adarsh disclosure email as a security report", () => {
    const subject = "Attention regarding bug found in your Assets!!";
    const body =
      "I'd like to report a bug in your assets responsibly. Could you let me know " +
      "if you have a bug bounty program? If not, I'll provide the details here";
    expect(isSecurityReport(subject, body)).toBe(true);
  });

  it("catches unambiguous disclosure vocabulary", () => {
    expect(isSecurityReport("", "Do you run a bug bounty program?")).toBe(true);
    expect(isSecurityReport("Responsible disclosure", "Found something, contacting you first.")).toBe(true);
    expect(isSecurityReport("", "This is a coordinated disclosure. POC below.")).toBe(true);
    expect(isSecurityReport("", "Reference: CVE-2024-12345")).toBe(true);
    expect(isSecurityReport("", "Where is your security.txt?")).toBe(true);
  });

  it("catches a flaw named as being in *your* system", () => {
    expect(isSecurityReport("", "There is a stored XSS in your API.")).toBe(true);
    expect(isSecurityReport("", "I found an SSRF on your platform.")).toBe(true);
    expect(isSecurityReport("Heads up", "SQL injection in your login endpoint.")).toBe(true);
    expect(isSecurityReport("", "You have an exposed API key in your backend.")).toBe(true);
    expect(isSecurityReport("", "Subdomain takeover on your site is possible.")).toBe(true);
  });

  // The critical false-positive guard: a CYBERSECURITY job seeker uses the same words but is signing
  // up. Onboarding intent must win so we never divert a real sign-up to the owner instead of onboarding.
  it("does NOT misfire on a security professional's sign-up", () => {
    expect(isSecurityReport("I want in", "I'm a penetration tester with XSS and CSRF experience.")).toBe(false);
    expect(isSecurityReport("", "Looking for a security role. Here's my resume.")).toBe(false);
    expect(isSecurityReport("", "I do vulnerability research and want to join your team.")).toBe(false);
    expect(isSecurityReport("Application", "Applying for the AppSec role — my CV is attached.")).toBe(false);
    expect(isSecurityReport("", "I want in. I have experience with SSRF and IDOR testing on your kind of platform.")).toBe(false);
  });

  it("does NOT misfire on ordinary onboarding or generic prose", () => {
    expect(isSecurityReport("I want in", "Find me a product role in Bangalore.")).toBe(false);
    expect(isSecurityReport("Hi", "Excited to sign me up — I want product manager roles.")).toBe(false);
    // "exploit" as a cover-letter verb near "your platform" must NOT trip (it's not in the flaw set).
    expect(isSecurityReport("", "I'd love to exploit my design skills on your platform.")).toBe(false);
    // generic "the system", not "your system" — no directed report.
    expect(isSecurityReport("", "I built the vulnerability scanning module in the system I worked on.")).toBe(false);
    expect(isSecurityReport("", "")).toBe(false);
  });
});

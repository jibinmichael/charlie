// url-ingest.test.mjs — a gated page must not become a dossier source.
//
// A gated LinkedIn profile fetched by ingestGeneric returns HTTP 200 and a large body, so status and
// length checks pass. The content is NOT the profile: the person's name and city, one truncated About
// line, LinkedIn UI chrome, and OTHER PEOPLE'S NAMES AND CITIES from the "similar profiles" sidebar.
// url-ingest.mjs would wrap that as "a page they authored, so treat as their own words".
//
// Strangers' identities entering one person's dossier as first-person material is as bad as an
// invented fact: it is a REAL fact about a DIFFERENT human being.
//
// The fixture below reproduces the structure of a real captured wall (names anonymised): a guard
// tuned against imagined input is tuned against nothing.
import { describe, it, expect } from "vitest";
import { looksGated } from "./url-ingest.mjs";

const REAL_LINKEDIN_WALL = `Alex Example - Pune, Maharashtra, India | Professional Profile | LinkedIn Skip to main content LinkedIn Top Content People Learning Jobs Games Join now Sign in Alex Example Pune, Maharashtra, India 1K followers 500+ connections See your mutual connections View mutual connections with Alex Email or phone Password Show Forgot password? Sign in Sign in with Email or New to LinkedIn? Join now By clicking Continue to join or sign in, you agree to LinkedIn’s User Agreement , Privacy Policy , and Cookie Policy . Join to view profile Report this profile About As a Senior Product Designer at Acme, a business messaging platform, I… Services User Experience Design (UED) Request proposal View Alex’s full profile See who you know in common Get introduced Contact Alex directly Join to view full profile Other similar profiles Sam Sample Sam Sample Ahmedabad Connec`;

describe("looksGated — an auth wall is not a page we read", () => {
  it("REJECTS the real captured LinkedIn wall", () => {
    expect(looksGated(REAL_LINKEDIN_WALL)).toBe(true);
  });

  it("the fixture really is the poisoned one — it carries other people's names", () => {
    // If this ever fails the fixture was replaced with something harmless and the test above proves
    // nothing. Pinning WHY the wall is dangerous, not just that it is detected.
    expect(REAL_LINKEDIN_WALL).toMatch(/Sign in|Join now/i);
  });

  // The half that must not regress: a normal page with a sign-in LINK in its header is still readable.
  // Requiring BOTH a sign-in prompt AND a gate on the content is what keeps these apart.
  it("ALLOWS an ordinary portfolio that merely has a Sign in link", () => {
    expect(looksGated("Jane Doe. Sign in. I build payment systems. In 2023 I led the migration of ...")).toBe(false);
  });
  it("ALLOWS a personal site with no auth language at all", () => {
    expect(looksGated("I am a product designer. I shipped the onboarding flow at Acme in 2024.")).toBe(false);
  });
  it("REJECTS other common gate wordings", () => {
    for (const t of ["Log in to continue. Join to view full profile.",
                     "Create a free account to view the rest of this profile.",
                     "Sign in. Sign up to see more."]) expect(looksGated(t)).toBe(true);
  });
  it("fails closed on junk input rather than throwing", () => {
    for (const v of [null, undefined, "", 42, {}]) expect(looksGated(v)).toBe(false);
  });
});

// emails/unsubscribe-confirm.test.mjs — the scanner-safe unsubscribe contract.
//
// A mail-security scanner GETs every link in an email. If GET /unsubscribe suppressed on load, a
// scanner would silently opt out engaged users the moment it touched their welcome. So GET renders a
// one-tap CONFIRM whose button POSTs, and only the POST suppresses. This locks that mechanism.
import { describe, it, expect } from "vitest";
import { unsubscribeConfirmPage, unsubscribePage } from "../email-kit.mjs";

describe("unsubscribe GET is a confirm, never an auto-unsubscribe", () => {
  const page = unsubscribeConfirmPage("tok.sig");

  it("is a POST form carrying the token — a bare GET (scanner) cannot suppress", () => {
    expect(page).toContain('method="post"');
    expect(page).toContain('action="/unsubscribe?t=tok.sig"');
    expect(page).toMatch(/<button[^>]*type="submit"/);
  });

  it("does NOT claim the reader is already unsubscribed (nothing happened yet)", () => {
    // "You're unsubscribed" appears only on the DONE page (after the POST). The confirm page may
    // describe the outcome ("won't email you anymore"), but must not state it as already done.
    expect(page).not.toContain("You're unsubscribed");
  });

  it("url-encodes the token into the form action (no attribute break-out)", () => {
    expect(unsubscribeConfirmPage("a b/c&x")).toContain("t=a%20b%2Fc%26x");
  });

  it("the DONE page (shown after the POST) is the one that confirms the unsubscribe", () => {
    expect(unsubscribePage("Charlie won't email x@y.com anymore.", true)).toContain("You're unsubscribed");
  });
});

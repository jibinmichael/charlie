// lib/qualify/sender.test.mjs — the From line of a Qualify & Submit email (lib/qualify/wiring.mjs senderFrom).
import { describe, it, expect } from "vitest";
import { senderFrom } from "./wiring.mjs";

describe("senderFrom", () => {
  it("with no display name, CHARLIE_FROM exactly as before", () => {
    expect(senderFrom("charlie@mail.x.com")).toBe("charlie@mail.x.com");
    expect(senderFrom("Charlie <charlie@mail.x.com>")).toBe("Charlie <charlie@mail.x.com>");
  });
  it("a display name goes on CHARLIE_FROM's own address", () => {
    expect(senderFrom("charlie@mail.x.com", "Charlie on behalf of Acme Talent")).toBe('"Charlie on behalf of Acme Talent" <charlie@mail.x.com>');
    expect(senderFrom("Charlie <charlie@mail.x.com>", "Charlie on behalf of Acme")).toBe('"Charlie on behalf of Acme" <charlie@mail.x.com>');
  });
  it("a name can never carry a second address, a header or an em dash", () => {
    const from = senderFrom("charlie@mail.x.com", 'Charlie on behalf of "Evil" <a@b.com>\r\nBcc: c@d.com — Ltd');
    expect(from).toBe('"Charlie on behalf of Evil a@b.com Bcc: c@d.com - Ltd" <charlie@mail.x.com>');
    expect(from.match(/</g)).toHaveLength(1);
  });
  it("a name that strips to nothing refuses", () => {
    expect(() => senderFrom("charlie@mail.x.com", ' "<>" ')).toThrow(/empty/);
  });
});

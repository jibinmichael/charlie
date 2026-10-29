// no-owner-name.test.mjs — Charlie is the product and the only voice in its copy.
//
// Copy that is supposed to be Charlie speaking must never name the person who operates it. The one
// deliberate exception is renderFounderNote, a note FROM the founder: it takes the name from the
// `founder` argument or FOUNDER_NAME and never hardcodes one. The hiring-campaign scheduling email
// refers to "the person I work with" rather than a name.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderFounderNote } from "./email-kit.mjs";
import { renderCampaignCalendly } from "./render-campaign.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(ROOT, p), "utf8");

describe("the founder note takes its signer from config, never from code", () => {
  let prev;
  beforeEach(() => { prev = process.env.FOUNDER_NAME; delete process.env.FOUNDER_NAME; });
  afterEach(() => { if (prev === undefined) delete process.env.FOUNDER_NAME; else process.env.FOUNDER_NAME = prev; });

  it("signs as 'the founder' when no name is configured", () => {
    const m = renderFounderNote({ email: "a@example.com", name: "Sam", linkedin: "https://www.linkedin.com/in/example/" });
    expect(m.text).toMatch(/this is the founder, the human building Charlie/);
    expect(m.html).toMatch(/The founder<\/div>/);
  });

  it("uses the configured name, escaped, in both parts", () => {
    process.env.FOUNDER_NAME = "Ada <Lovelace>";
    const m = renderFounderNote({ email: "a@example.com", name: "Sam" });
    expect(m.text).toMatch(/this is Ada <Lovelace>, the human building Charlie/);
    expect(m.html).toContain("Ada &lt;Lovelace&gt;");
    expect(m.html).not.toContain("Ada <Lovelace>");
  });

  it("an explicit founder argument wins over the env", () => {
    process.env.FOUNDER_NAME = "Env Name";
    expect(renderFounderNote({ email: "a@example.com", founder: "Arg Name" }).text).toMatch(/this is Arg Name,/);
  });
});

describe("Charlie's own copy does not name the operator", () => {
  it("the scheduling email refers to 'the person I work with'", () => {
    const m = renderCampaignCalendly({ email: "a@example.com", calendlyUrl: "https://calendly.com/example" });
    expect(m.text).toMatch(/the person I work with/);
  });

  it("the founder note's source has no hardcoded signer", () => {
    const src = read("email-kit.mjs");
    const start = src.indexOf("export function renderFounderNote");
    const body = src.slice(start, src.indexOf("\nexport function", start + 1));
    expect(body).toMatch(/process\.env\.FOUNDER_NAME/);
    expect(body).not.toMatch(/this is [A-Z][a-z]+, the human/);
  });
});

// reply-intent.test.mjs — /inbound must not answer different situations with the same words. These
// tests pin the two properties that guarantee it.

import { describe, it, expect } from "vitest";
import { replyFor, QUOTING_INTENTS, URGENT_INTENTS, SILENT_INTENTS } from "./reply-intent.mjs";
import { INTENTS } from "./schemas/inbound-intent.mjs";

const person = { email: "someone@example.com", name: "Bram Okonjo" };

describe("no two intents get the same reply", () => {
  // A consent grant, a factual dispute, a status update, an answer to Charlie's own question, a
  // newsletter and a thank-you must each get their own reply. An edit that collapses two of these
  // back together fails here.
  it("every non-silent intent renders a distinct body", () => {
    const seen = new Map();
    for (const intent of INTENTS) {
      const { message, silent } = replyFor({ intent, quote: "" }, person);
      if (silent) continue;
      const key = message.text;
      const clash = seen.get(key);
      // `question`, `preference_change` and `other` share renderUnsure BY DESIGN: all three mean
      // "we are not confident enough to act", which is one situation wearing three labels. Anything
      // else sharing a body is the bug coming back.
      const bothUnsure = ["question", "preference_change", "other"];
      if (clash && !(bothUnsure.includes(clash) && bothUnsure.includes(intent))) {
        expect.fail(`"${intent}" and "${clash}" send byte-identical text:\n${key}`);
      }
      if (!clash) seen.set(key, intent);
    }
  });

  it("the six distinct situations really are six different emails", () => {
    const bodies = ["consent_grant", "dispute", "status_update", "answer", "off_topic", "other"]
      .map((intent) => replyFor({ intent, quote: "please share my profile" }, person).message.text);
    expect(new Set(bodies).size).toBe(6);
  });
});

describe("nothing can vanish", () => {
  it("an unmapped label fails to a human, not to silence", () => {
    // A label a future prompt invents, or one that slipped past the schema's .catch("other").
    const { message, silent } = replyFor({ intent: "some_future_label" }, person);
    expect(silent).toBe(false);
    expect(message.text).toMatch(/passed it to a person/i);
  });

  it("a missing intent object still answers", () => {
    expect(replyFor(undefined, person).message.text).toMatch(/passed it to a person/i);
    expect(replyFor({}, person).message.text).toMatch(/passed it to a person/i);
  });

  it("courtesy sends nothing to the user but is never marked handled on its own", () => {
    const r = replyFor({ intent: "courtesy" }, person);
    expect(r.message).toBeNull();
    expect(r.silent).toBe(true);
    // The caller notifies the owner for every intent including this one; see the route. The point
    // of this assertion is that `silent` is the ONLY thing courtesy changes.
    expect(SILENT_INTENTS).toEqual(["courtesy"]);
  });
});

describe("quoting is rationed", () => {
  it("only consent and dispute quote the person back", () => {
    const quote = "please share my profile with Acme";
    for (const intent of INTENTS) {
      const { message } = replyFor({ intent, quote }, person);
      if (!message) continue;
      const quoted = message.text.includes(quote);
      expect(quoted, `${intent} ${quoted ? "quotes" : "does not quote"} the person`)
        .toBe(QUOTING_INTENTS.includes(intent));
    }
  });

  it("a consent grant with no quote still reads as a sentence", () => {
    const { message } = replyFor({ intent: "consent_grant", quote: "" }, person);
    expect(message.text).toMatch(/^Hi Bram, understood, and thank you\./);
    expect(message.text).not.toMatch(/""|Taking that as ,/);
  });

  it("an unreasonably long quote is clipped, not pasted whole", () => {
    const huge = "word ".repeat(400).trim();
    const { message } = replyFor({ intent: "dispute", quote: huge }, person);
    expect(message.text.length).toBeLessThan(700);
    expect(message.text).not.toContain(huge);
  });
});

describe("the owner still gets woken for the two that matter", () => {
  it("consent and dispute are urgent, nothing else is", () => {
    expect(URGENT_INTENTS).toEqual(["consent_grant", "dispute"]);
    expect(replyFor({ intent: "consent_grant" }, person).urgent).toBe(true);
    expect(replyFor({ intent: "dispute" }, person).urgent).toBe(true);
    expect(replyFor({ intent: "status_update" }, person).urgent).toBe(false);
  });
});

describe("the person's name", () => {
  it("is a first name only, and absent when we do not have one", () => {
    expect(replyFor({ intent: "answer" }, { email: "a@b.com", name: "Bram Okonjo" }).message.text)
      .toMatch(/^Hi Bram, /);
    expect(replyFor({ intent: "answer" }, { email: "a@b.com", name: "" }).message.text)
      .toMatch(/^noted, and thank you/);
  });
});

// lib/represent-story.mjs — build the story, audit it, and drop it if it does not hold.
//
// Two model calls per person, once. Build with Sonnet, verify with Haiku. A story that fails the audit
// is NOT patched or softened: it is dropped and the person is reported, because the alternative is a
// sentence about somebody's career that we cannot stand behind reaching them and then their employer.

import Anthropic from "@anthropic-ai/sdk";
import { STORY_BUILD_SYSTEM, buildStoryMessages } from "../prompts/represent-story.mjs";
import { STORY_VERIFY_SYSTEM, buildStoryVerifyMessages } from "../prompts/represent-story-verify.mjs";
import { StoryBuild, StoryVerdict } from "./schemas/represent-story.mjs";

const BUILD_MODEL = process.env.STORY_BUILD_MODEL || "claude-sonnet-4-6";
const VERIFY_MODEL = process.env.STORY_VERIFY_MODEL || "claude-haiku-4-5";

// THREE ATTEMPTS, not two. Rejections are usually the writer reaching rather than the auditor being
// wrong ("spent ten years leading design" for somebody whose resume starts with four years of graphic
// design), and a third pass with the accumulated violations lands most of them. It is not the guard
// going soft: every attempt is audited from scratch by a prompt with no memory of the last one, and a
// story that cannot survive three honest attempts is dropped and the person is named for a human to
// write.
const MAX_ATTEMPTS = 3;

const readJson = (res) => {
  const t = (res.content || []).map((c) => c.text || "").join("").trim().replace(/^```(?:json)?|```$/g, "");
  try { return JSON.parse(t); } catch { return null; }
};

/**
 * EACH RETRY IS TOLD WHAT IT DID WRONG.
 *
 * A writer asked to make somebody sound worth meeting will reach, every time: arguing a fit ("Acme is
 * building conversational AI and that is the problem you have spent years solving") or upgrading a
 * claim ("adopted directly into the product roadmap" where the person wrote "adopted as UX work").
 * Reaching is exactly what the audit is for.
 *
 * So the violations are handed back and it writes again, smaller. This is not the verifier going
 * easy: every attempt is audited from scratch by the same prompt with no memory of the last, and a
 * story that fails every attempt is DROPPED. Nobody gets a story we cannot stand behind.
 */
export async function buildStory({ brief, answers, resume = "", audience = "candidate", name = "", log = () => {} }) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const usage = { build: null, verify: null };
  let lastReason = "no attempt";

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const messages = buildStoryMessages({ brief, answers, resume, audience, name });
    if (attempt > 1) {
      messages.push({ role: "assistant", content: "{}" });
      messages.push({
        role: "user",
        content:
          `Your story was audited and REJECTED for this:

${lastReason}

` +
          `Write it again, smaller and closer to the sources. Cut any clause you cannot point at a specific line for. ` +
          `A shorter, plainer, unarguable story is the correct outcome here, not a rephrased version of the same claims.`,
      });
    }
    const b = await client.messages.create({
      model: BUILD_MODEL, max_tokens: 1200, temperature: 0,
      system: STORY_BUILD_SYSTEM, messages,
    });
    usage.build = b.usage;
    const parsedB = StoryBuild.safeParse(readJson(b) ?? {});
    if (!parsedB.success) { lastReason = "build did not parse"; continue; }
    const story = parsedB.data;
    if (!String(story.story).trim()) { lastReason = "builder returned nothing"; continue; }

    const v = await client.messages.create({
      model: VERIFY_MODEL, max_tokens: 700, temperature: 0,
      system: STORY_VERIFY_SYSTEM, messages: buildStoryVerifyMessages({ story, answers, resume }),
    });
    usage.verify = v.usage;
    const parsedV = StoryVerdict.safeParse(readJson(v) ?? {});
    // An unreadable verdict is NOT a pass. Uncertainty ships nothing.
    if (!parsedV.success) { lastReason = "verifier did not parse"; continue; }
    if (parsedV.data.grounded) return { story, reason: attempt === 1 ? "ok" : `ok on attempt ${attempt}, after the audit pushed it back`, usage };

    lastReason = parsedV.data.violations.join("; ") || parsedV.data.reason;
    log(`attempt ${attempt} rejected: ${lastReason}`);
  }
  return { story: null, reason: `dropped after ${MAX_ATTEMPTS} attempts: ${lastReason}`, usage };
}

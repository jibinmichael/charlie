// lib/xyz-screen.mjs — run the X-Y-Z screen over one applicant, and refuse to trust an unquoted score.
//
// THE ONE CHECK THAT MATTERS. Every non-zero score has to carry a verbatim quote from what the person
// actually wrote. A model that scores well and quotes nothing has decided something about a real
// person out of thin air, and that decision would go on to a client. So the quote is verified against
// the source text here, and a score whose quote is not found is knocked down to 0 with a flag rather
// than believed. That is the same cite-or-drop rule the rest of the product runs on, applied to a
// judgement about somebody's career.

import Anthropic from "@anthropic-ai/sdk";
import { XYZ_SCREEN_SYSTEM, buildXyzMessages } from "../prompts/xyz-screen.mjs";
import { XyzScreen } from "./schemas/xyz-screen.mjs";

const MODEL = process.env.XYZ_SCREEN_MODEL || "claude-sonnet-4-6";
const MAX_TOKENS = 2000;

/**
 * Loose containment: a quote verifies if the WORDS are there, in order.
 *
 * PUNCTUATION IS NOT COMPARED. Resume text comes out of a PDF extractor, which sprays spaces around
 * punctuation ("Reusable Templates , enabling ..."). The model quotes it the way a human would type
 * it, without the stray space. Comparing punctuation would fail that genuine quote, knock the score
 * to 0 and flag it "unverified-quote" as though the model had invented it: the guard that stops a
 * model inventing things about a person would throw away what they really wrote.
 *
 * COMPARING WORDS IS NOT WEAKER. The check asks one question: did the model make this up? A model
 * that fabricates a claim fabricates words, not commas. Every word still has to be present, in the
 * same order, in what the person actually wrote.
 */
export function contains(haystack, needle) {
  const n = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const h = n(haystack), q = n(needle);
  if (!q) return true;
  if (h.includes(q)) return true;
  // A model sometimes stitches two spans with an ellipsis. Verify each half instead of failing both.
  // Split the RAW needle: normalising turns an ellipsis into a space, so by then there is nothing
  // left to split on and this branch could never fire.
  const parts = String(needle).split(/\s*(?:\.\.\.|…)\s*/).map(n).filter((p) => p.length > 12);
  if (parts.length > 1 && parts.every((p) => h.includes(p))) return true;

  // THE TWO-COLUMN RESUME. A PDF laid out in two columns comes out of the extractor with the columns
  // interleaved line by line:
  //
  //   - Spearheading the Product Strategy and Roadmap for core ERP
  //   users) and Contract Desk CLMS, driving a 60% efficiency gain
  //   modules, focusing on digitizing global Agricultural Value
  //
  // The model reads that correctly and quotes the real sentence, but no contiguous span of the source
  // contains it, so every quote on that resume would fail and the applicant would score near zero
  // because of a page layout.
  //
  // So the last resort asks how much of the quote's PHRASING survives in the source, pair of words by
  // pair of words. Interleaving breaks contiguity only where a column boundary falls, which is a
  // handful of places in a long quote; invention breaks it everywhere.
  //
  // A BAG OF WORDS WOULD NOT DO. "I led the billing service" against a resume saying "I worked on the
  // billing service" shares every word that matters, and "led" almost certainly appears somewhere
  // else on the page, so a subsequence or word-set test would wave through an upgraded claim. That is
  // exactly what cite-or-drop forbids. Adjacency is what makes the difference: "i led" and "led the"
  // are both absent, so the upgrade fails at 50% while a column-broken real quote passes at 90%.
  //
  // Long quotes only. Under eight words there are too few pairs for the ratio to mean anything, and a
  // short quote should simply be found.
  const qw = q.split(" ").filter(Boolean);
  if (qw.length < 8) return false;
  const bigrams = qw.slice(0, -1).map((w, i) => `${w} ${qw[i + 1]}`);
  const found = bigrams.filter((b) => h.includes(b)).length;
  return found / bigrams.length >= 0.85;
}

/**
 * @returns {{ screen: object|null, total: number, usage: object, reason: string }}
 *   screen is null when the reply could not be read, which means "a human looks at this one".
 */
/**
 * @param {string} [system] the role's anchors. Defaults to the design ones, which is what every
 *   existing caller wants; the product-management screen passes PM_SCREEN_SYSTEM. The anchors are
 *   not interchangeable, so this is explicit at the call site rather than inferred from the brief.
 */
export async function screenApplicant({ brief, requirements, answers, resume = "", system = XYZ_SCREEN_SYSTEM, log = () => {} }) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  // Quotes are verified against BOTH sources, because the evidence for a score legitimately
  // lives in either one. Verifying against the form alone would knock down every score the model
  // correctly took from the resume.
  const source = [Object.values(answers).join("\n\n"), String(resume || "")].join("\n\n");
  let usage = null;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await client.messages.create({
      // temperature 0. This screen decides whether a real person is put in front of a client, and at
      // the API default the same answers score differently on two runs: the model paraphrases a quote,
      // the verbatim check knocks that score to 0, and a person moves several places in the ranking
      // for no reason connected to their work. A decision about somebody's career should not be a
      // coin flip, and a screen you cannot reproduce is a screen you cannot defend to them.
      model: MODEL, max_tokens: MAX_TOKENS, temperature: 0, system,
      messages: buildXyzMessages({ brief, requirements, answers, resume }),
    });
    usage = res.usage;
    const text = (res.content || []).map((c) => c.text || "").join("").trim().replace(/^```(?:json)?|```$/g, "");
    let parsed;
    try { parsed = JSON.parse(text); } catch { log(`unreadable JSON (attempt ${attempt})`); continue; }
    const ok = XyzScreen.safeParse(parsed);
    if (!ok.success) { log(`schema rejected (attempt ${attempt}): ${ok.error.issues.slice(0, 2).map((i) => i.path.join(".")).join(", ")}`); continue; }

    const screen = ok.data;
    // CITE OR DROP, applied to a score, and every score says WHICH KIND OF ZERO IT IS.
    //
    // A bare 0 would mean two unrelated things: this person showed no evidence, or we failed to read
    // the evidence they showed. Without the distinction, a resume set in two columns and one with
    // nothing relevant produce identical records, and a screen that never ran reads as a judgement.
    //
    //   observed       a quote was given and found in what they wrote
    //   absent         the model looked and found nothing. A real zero.
    //   cannot_verify  something was claimed and could not be checked. NOT a zero, an unknown.
    for (const s of screen.scores) {
      if (s.score === 0) { s.status = "absent"; continue; }

      // A POSITIVE SCORE WITH NO QUOTE. `contains` treats an empty needle as satisfied, so without
      // this a 3 with an empty quote would sail through the one check that exists to stop invention.
      // The prompt says a score with no quote must be a 0, so this is the model breaking its own
      // contract and there is nothing here to confirm. Fail closed.
      if (!String(s.quote || "").trim()) {
        log(`score ${s.score} on "${s.requirement}" arrived with no quote — cannot verify`);
        s.rejected_score = s.score;
        s.score = 0; s.status = "cannot_verify";
        s.why = "this score arrived without a quote, so there was nothing to check it against";
        screen.flags = [...new Set([...(screen.flags || []), "unquoted-score"])];
        continue;
      }

      if (!contains(source, s.quote)) {
        log(`unverified quote on "${s.requirement}" — score ${s.score} -> 0`);
        // KEEP WHAT WAS REJECTED. Clearing the quote would destroy the only record of what the model
        // actually said, and a wrong matcher could then not be told apart from a real fabrication
        // without re-running the whole screen. A guard that deletes its own evidence cannot be audited.
        s.rejected_quote = s.quote;
        s.rejected_score = s.score;
        s.score = 0; s.quote = ""; s.status = "cannot_verify";
        s.why = "the quote behind this score was not found in what they wrote, so it was not counted";
        screen.flags = [...new Set([...(screen.flags || []), "unverified-quote"])];
        continue;
      }
      s.status = "observed";
    }

    // DID THE SCREEN ACTUALLY RUN? A third or more of the dimensions coming back unverifiable is not
    // a person who scored low, it is a reading that failed, and a total computed from it is a number
    // with nothing behind it. So the total is withheld rather than reported small, and the caller is
    // told to send this one to a human.
    //
    // A THIRD, not any. One bad quote out of six is ordinary and the other five still say something.
    const unreadable = screen.scores.filter((s) => s.status === "cannot_verify").length;
    const readable = screen.scores.length > 0 && unreadable / screen.scores.length < 1 / 3;
    const total = screen.scores.reduce((n, s) => n + s.score, 0);
    if (!readable) {
      log(`${unreadable} of ${screen.scores.length} dimensions could not be verified — this screen did not run`);
      screen.flags = [...new Set([...(screen.flags || []), "unreadable"])];
      return { screen, total, readable: false, usage, reason: `${unreadable}/${screen.scores.length} unverifiable — needs a human, not a score` };
    }
    return { screen, total, readable: true, usage, reason: "ok" };
  }
  return { screen: null, total: 0, readable: false, usage, reason: "unreadable after 2 attempts — needs a human" };
}

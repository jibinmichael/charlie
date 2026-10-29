// say-name.mjs — write a person's own name back to them the way a person would write it.
//
// People often type their name into a form in block capitals or entirely in lower case, so a greeting
// built straight from the field reads "Hi PRIYA." or "Hi farhan." Neither is a small thing in the
// first line of a mail about their job application: one is shouting their name back at them and the
// other looks like nobody looked.
//
// IT IS A DISPLAY FIX AND NOTHING MORE. It changes case, never spelling, never order, never content.
// A name that is already mixed case is returned untouched, because that person has told us how they
// write it and we are not entitled to an opinion. That is also why the rule is narrow rather than a
// general title-caser: "McDonald" and "de Souza" are correct as typed, and a helpful algorithm that
// "fixes" them is doing the same damage in the other direction.
//
// Tokens of two characters or fewer are left exactly as written, so initials survive: JP, MG, KV.

/**
 * Title-case a name ONLY when the whole thing was typed in one case.
 *
 * The decision is per NAME, not per token, and that distinction is the whole correctness of this
 * function. A per-token rule turns "van der Berg" into "Van Der Berg", because "van" and "der" are
 * lower case in isolation. Looked at whole, that name is already mixed case, which means the person
 * capitalised it deliberately and there is nothing here to fix. Only a name with no case information
 * in it at all — "farhan ali", "ARJUN KUMAR MEHTA" — is a name where we know they did not choose.
 */
export const sayName = (n) => {
  const name = String(n || "").trim();
  if (!name) return "";
  const hasLetters = /[a-z]/i.test(name);
  const uniform = name === name.toUpperCase() || name === name.toLowerCase();
  if (!hasLetters || !uniform) return name; // they told us how they write it

  return name
    .split(/\s+/)
    .map((w) => (w.length <= 2 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1).toLowerCase()))
    .join(" ");
};

/**
 * The name to open a mail with, or "" when there isn't one we can say out loud.
 *
 * Greeting from `name.split(" ")[0]` gets three things wrong at once, all of them visible in the
 * first line: it shouts ("PRIYA,"), it mumbles ("farhan,"), and where the name leads with an
 * initial it greets a letter ("P," for "P V Rao"). Case is
 * fixable and sayName fixes it. A lone initial is not: nobody is called P, and "Hi." is honest
 * where "P," is a small insult. Same rule as a place not being a person — if we cannot say it, we
 * do not say it.
 */
export const greetingName = (n) => {
  const first = sayName(n).split(/\s+/)[0] || "";
  return first.replace(/\./g, "").length > 1 ? first : "";
};

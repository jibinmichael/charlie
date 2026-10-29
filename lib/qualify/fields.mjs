// lib/qualify/fields.mjs — what an employer system needs to know about a person, where we already have it, what
// we must ask, and how a person's answer is read. PURE: no database, no model, no network.
//
// NEVER INVENTED. A field is either taken from the person's own record or answers, with its source
// named, or it is missing and asked. A value that cannot be read with certainty from an answer stays missing.
// Pay is stored in rupees a year (talent_pool.comp_*) and sent in lakh a year (the unit Pieworks uses for current,
// expected and the role's band). A stored value under 10,000 rupees
// cannot be a yearly salary and is treated as unknown.

const LAKH = 100000;
const round2 = (n) => Math.round(n * 100) / 100;

/** The destination's required person fields (Pieworks submitReferral, doc 1.4.1), less what we write ourselves. */
export const PIEWORKS_FIELDS = ["experience", "linkedInUrl", "name", "currentCompany", "emailId", "phoneNo", "countryCode", "currentLocation", "currentCtcFixed", "currentCtcVariable", "currentCtcTotal", "expectedCtc", "noticePeriod"];

/** "+91-98765 43210" -> {countryCode: "+91", phoneNo: "9876543210"}; no country code -> null (asked, never assumed). */
export function parsePhone(raw) {
  const t = String(raw || "").trim();
  const m = /^\+(\d{1,3})[\s\-.]*\(?(\d[\d\s\-.()]{5,18}\d)$/.exec(t);
  if (!m) return null;
  const digits = m[2].replace(/\D/g, "");
  if (digits.length < 6 || digits.length > 15) return null;
  return { countryCode: `+${m[1]}`, phoneNo: digits };
}

/** A LinkedIn profile URL in the text, normalised, or null. */
export function parseLinkedIn(raw) {
  const m = /(?:https?:\/\/)?(?:[a-z]{2,3}\.)?linkedin\.com\/in\/([A-Za-z0-9\-_%]{3,100})\/?/i.exec(String(raw || ""));
  return m ? `https://www.linkedin.com/in/${m[1]}` : null;
}

/**
 * One amount in lakh a year from ONE amount phrase ("18 LPA", "18 lakh", "1.2 Cr", "1800000", "1,50,000 a month"),
 * or null whenever it could mean something else ("30% hike" is not 30 lakh, "12k" is not 0.12 lakh), so: a
 * percentage is never an amount; "k" or "thousand" counts only with "a month"; a plain rupee figure
 * counts only from one lakh up (50000 could be a month); a bare small number is lakh only when nothing else is.
 */
export function parseLakh(phrase) {
  const t = String(phrase || "").toLowerCase().replace(/,/g, "").trim();
  if (/\d\s*(%|percent|pc\b)/.test(t)) return null;
  const m = /^(?:rs\.?|inr|₹)?\s*(\d+(?:\.\d+)?)\s*(lpa|lakhs?|lacs?|lac|l\b|cr|crores?|k\b|thousand)?\s*((?:per|a|\/)\s*(?:month|mo|annum|year|yr))?/.exec(t.replace(/^(about|around|roughly|approx\.?|approximately)\s+/, ""));
  if (!m) return null;
  let n = Number(m[1]);
  const unit = m[2] || "";
  const per = m[3] || "";
  const monthly = /month|mo\b/.test(per);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (/^(lpa|lakh|lakhs|lac|lacs|l)$/.test(unit)) { /* lakh already */ }
  else if (/^(cr|crore|crores)$/.test(unit)) n = n * 100;
  else if (/^(k|thousand)$/.test(unit)) { if (!monthly) return null; n = (n * 1000) / LAKH; }
  else if (n >= LAKH) n = n / LAKH;            // a plain rupee figure, one lakh or more
  else if (n >= 1000) return null;             // 1,000 to 99,999 with no unit: a month's pay or a typo, never certain
  else if (n > 200) return null;               // a bare number that is neither lakh nor rupees
  if (monthly) n = n * 12;
  return n >= 0.5 && n < 2000 ? round2(n) : null;
}

/** Every amount phrase in an answer, with its span; percentages are excluded (they are never amounts). Pure. */
function amountsIn(t) {
  return [...String(t || "").matchAll(/(?:rs\.?|inr|₹)?\s*\d[\d,]*(?:\.\d+)?\s*(?:lpa|lakhs?|lacs?|l\b|cr|crores?|k\b|thousand)?(?:\s*(?:per|a|\/)\s*(?:month|mo|annum|year|yr)\b)?(?!\s*(?:%|percent))/gi)]
    .map((m) => { const lead = m[0].length - m[0].trimStart().length; return { start: m.index + lead, end: m.index + m[0].trimEnd().length, text: m[0].trim() }; })
    .filter((x) => !/^\d+$/.test(x.text) || !/\s*(%|percent)/.test(String(t).slice(x.end, x.end + 9)))
    .filter((x) => parseLakh(x.text) != null);
}

/**
 * Current pay from an answer: fixed and variable, both stated (or "no variable"). Each keyword takes its NEAREST
 * amount; a tie, or one figure claimed by both words, is unreadable. A percentage is never an amount, so
 * "10% variable" leaves the variable missing (asked once more), never 10 lakh. Pure.
 */
export function parseCurrentPay(answer) {
  const t = String(answer || "");
  const noVariable = /\b(no|zero|nil|0)\s+(variable|bonus|incentives?)|\bfixed only\b|\ball fixed\b|\bonly fixed\b/i.test(t);
  const amounts = amountsIn(t);
  const nearest = (re) => {
    const k = re.exec(t);
    if (!k) return null;
    const ks = k.index, ke = k.index + k[0].length;
    const dist = (x) => (x.end <= ks ? ks - x.end : x.start >= ke ? x.start - ke : 0);
    const ranked = amounts.map((x) => ({ x, d: dist(x) })).filter((r) => r.d <= 25).sort((a, b) => a.d - b.d);
    if (!ranked.length) return null;
    if (ranked[1] && ranked[1].d === ranked[0].d) {
      // a tie: in "Fixed 12L Variable 1.5L" each label comes BEFORE its amount, in "12L fixed, 1.5L variable"
      // after it. Read the style from where the first label sits, and take the amount on that side; else unreadable.
      const labelFirst = (/\b(fixed|variable|bonus|incentives?)\b/i.exec(t)?.index ?? Infinity) < (amounts[0]?.start ?? -1);
      const side = ranked.filter((r) => r.d === ranked[0].d).find((r) => (labelFirst ? r.x.start >= ke : r.x.end <= ks));
      return side ? side.x : null;
    }
    return ranked[0].x;
  };
  const percentVariable = /\d\s*(%|percent)\s*(of\s+\w+\s+)?(variable|bonus|incentives?)|(variable|bonus|incentives?)[^.\d]{0,15}\d+\s*(%|percent)/i.test(t);
  const fx = nearest(/\bfixed\b/i), vx = noVariable || percentVariable ? null : nearest(/\b(variable|bonus|incentives?)\b/i);
  if (fx && vx && fx === vx) return { fixed: null, variable: null };
  const fixed = fx ? parseLakh(fx.text) : null;
  const variable = noVariable ? 0 : vx ? parseLakh(vx.text) : null;
  if (fixed != null) return { fixed, variable };
  return amounts.length === 1 && noVariable ? { fixed: parseLakh(amounts[0].text), variable: 0 } : { fixed: null, variable: null };
}

/**
 * Expected pay: one figure, or the top of a range ("18 to 20 LPA", "18 lakh to 20 lakh" -> 20). Two figures that
 * are not a range ("currently 10, expecting 14 LPA") or a percentage ("a 30% hike") are unreadable. Pure.
 */
export function parseExpectedPay(answer) {
  const t = String(answer || "").toLowerCase().replace(/,/g, "");
  if (/\d\s*(%|percent)/.test(t)) return null;
  const range = /(\d+(?:\.\d+)?)\s*(lpa|lakhs?|lacs?|l\b|cr)?\s*(?:-|to)\s*(\d+(?:\.\d+)?)\s*(lpa|lakhs?|lacs?|l\b|cr)?/.exec(t);
  if (range) return parseLakh(`${range[3]} ${range[4] || range[2] || ""}`);
  const all = amountsIn(t);
  return all.length === 1 ? parseLakh(all[0].text) : null;
}

/** Notice in days ("30 days", "2 months", "immediate"). Pure. */
export function parseNoticeDays(answer) {
  const t = String(answer || "").toLowerCase();
  // "serving notice" is not "immediate": it has an end date, which is asked for, never assumed
  if (/serving|last (working )?day/.test(t)) return null;
  if (/\b(immediate(ly)?|right away|already left|0 days?)\b/.test(t)) return 0;
  const d = /(\d{1,3})\s*days?/.exec(t);
  if (d) return Number(d[1]);
  const w = /(\d{1,2})\s*weeks?/.exec(t);
  if (w) return Number(w[1]) * 7;
  const m = /(\d{1,2}(?:\.\d)?)\s*months?|\b(one|two|three)\s+months?/.exec(t);
  if (m) return Math.round((m[1] ? Number(m[1]) : { one: 1, two: 2, three: 3 }[m[2]]) * 30);
  return null;
}

/** Total years of work ("6 years", "6.5 yrs"). Pure. */
export function parseYears(answer) {
  const m = /(\d{1,2}(?:\.\d)?)\s*\+?\s*(?:years?|yrs?)/i.exec(String(answer || ""));
  const n = m ? Number(m[1]) : null;
  return n != null && n >= 0 && n <= 50 ? n : null;
}

const val = (v, source) => ({ value: v, source });

/**
 * What the record already says, as destination fields with their source. Pure.
 * @param pool talent_pool row; person the same person as scored (lib/qualify/wiring.mjs ensureEvaluated)
 */
export function fieldsFromRecord(pool = {}, person = {}) {
  const f = {};
  const name = String(pool.full_name || person.full_name || "").trim();
  if (name) f.name = val(name, "pool");
  const email = String(pool.email || person.email || "").trim().toLowerCase();
  if (email) f.emailId = val(email, "pool");
  if (Number.isFinite(pool.total_years) && pool.total_years >= 0) f.experience = val(Number(pool.total_years), "pool");
  const li = parseLinkedIn(pool.linkedin_url || person.linkedin_url);
  if (li) f.linkedInUrl = val(li, "pool");
  const company = String(pool.current_company || person.current_company_raw || "").trim();
  if (company) f.currentCompany = val(company, "pool");
  const city = String(pool.city || person.city || "").trim();
  if (city) f.currentLocation = val(city, "pool");
  const ph = parsePhone(pool.phone || person.phone);
  if (ph) { f.phoneNo = val(ph.phoneNo, "pool"); f.countryCode = val(ph.countryCode, "pool"); }
  if (Number.isFinite(pool.comp_expected) && pool.comp_expected >= 10000 && (!pool.comp_currency || pool.comp_currency === "INR")) f.expectedCtc = val(round2(pool.comp_expected / LAKH), "pool");
  if (Number.isInteger(pool.notice_days) && pool.notice_days >= 0 && pool.notice_days <= 365) f.noticePeriod = val(String(pool.notice_days), "pool");
  // current pay is never taken from the record: it holds one total, and the employer needs fixed and variable
  return f;
}

/** The questions the verify email asks, ids stable, in the order asked. Pure. */
export const QUESTION_TEXT = {
  consent: ({ company, role }) => `May I put you forward to ${company} for the ${role} role?`,
  currentPay: () => "What is your current pay a year, fixed and variable separately? For example: 12 lakh fixed, 2 lakh variable.",
  expectedPay: () => "What pay a year would you expect for this role?",
  noticePeriod: () => "What is your notice period, in days?",
  phone: () => "What is the best phone number for you, with the country code?",
  linkedInUrl: () => "What is your LinkedIn profile link?",
  currentCompany: () => "Where do you work now?",
  currentLocation: () => "Which city are you based in now?",
  experience: () => "How many years have you worked in total?",
  workFrom: ({ city }) => `This role is based in ${city}. Would you work from there?`,
  cv: () => "Please attach your latest CV as a PDF.",
};

/**
 * The questions for one person and one role: consent first, then only what is missing, then up to three
 * must-haves their record is silent on, then the CV if we have no PDF. Pure.
 */
export function questionsFor({ fields = {}, role, company, city = null, personCity = null, openMustHaves = [], haveCvPdf = false }) {
  const q = [{ id: "consent", text: QUESTION_TEXT.consent({ company, role }) }];
  if (!fields.currentCtcFixed || !fields.currentCtcVariable) q.push({ id: "currentPay", text: QUESTION_TEXT.currentPay() });
  if (!fields.expectedCtc) q.push({ id: "expectedPay", text: QUESTION_TEXT.expectedPay() });
  if (!fields.noticePeriod) q.push({ id: "noticePeriod", text: QUESTION_TEXT.noticePeriod() });
  if (!fields.phoneNo || !fields.countryCode) q.push({ id: "phone", text: QUESTION_TEXT.phone() });
  if (!fields.linkedInUrl) q.push({ id: "linkedInUrl", text: QUESTION_TEXT.linkedInUrl() });
  if (!fields.currentCompany) q.push({ id: "currentCompany", text: QUESTION_TEXT.currentCompany() });
  if (!fields.currentLocation) q.push({ id: "currentLocation", text: QUESTION_TEXT.currentLocation() });
  if (!fields.experience) q.push({ id: "experience", text: QUESTION_TEXT.experience() });
  if (city && (!personCity || personCity.toLowerCase() !== String(city).toLowerCase())) q.push({ id: "workFrom", text: QUESTION_TEXT.workFrom({ city }) });
  openMustHaves.filter((m) => !/\b(screening|record|status|dossier)\b/i.test(String(m.label))).slice(0, 3).forEach((m, i) => q.push({ id: `must:${m.ref || i}`, text: `Have you done this: ${String(m.label).replace(/[.?!]+$/, "")}? If yes, where, and what did you do?` }));
  if (!haveCvPdf) q.push({ id: "cv", text: QUESTION_TEXT.cv() });
  return q;
}

/**
 * Yes, no or unclear, for an answer to "may I put you forward?" (kind "consent") or "would you work from there?"
 * (kind "city"). STRICT ABOUT YES, by design: a false yes submits someone without
 * consent and cannot be undone; a false no closes a willing person; "unclear" only asks again (bounded). So:
 *   YES      the reply OPENS with an agreement, and nothing after it negates, hedges or sets a condition.
 *   NO       the reply clearly refuses: it opens with a refusal, or says so outright ("not interested", "don't put me
 *            forward", "withdraw"). For the city question, "can't / won't / unable" anywhere is also a no.
 *   UNCLEAR  everything else. Asked again, never guessed.
 * Pure.
 */
const AGREE_OPEN = /^\s*(yes|yeah|yep|yup|ya|sure|ok|okay|okk?|alright|absolutely|definitely|of course|certainly|please (do|go ahead|proceed)|go ahead|proceed|happy to|glad to|count me in|i('?m| am) (interested|in)|interested|no problems?|no issues?|no worries|no objections?|not a problem|that works|works for me|sounds good|fine|haan|han|ha|ji)\b[\s,.!:;-]*/i;
const NEGATES = /\b(not|no|never|nope|don'?t|do not|doesn'?t|can'?t|cannot|won'?t|wouldn'?t|isn'?t|aren'?t|decline\w*|withdraw\w*|pass|refuse\w*)\b/i;
const HEDGES = /\b(but|however|though|although|if|unless|only|provided|as long as|depends|depending|maybe|perhaps|probably|unsure|not sure|let me|will (check|think|confirm|let you know|get back|revert)|get back|revert|think about|discuss|noted|later|tentative\w*)\b|\?/i;
const REFUSE_OPEN = /^\s*(no|nope|nah|never|not (interested|now|right now|really|keen|anymore|any more|looking|at the moment)|no (thanks|thank you|longer)|definitely not|absolutely not|certainly not|i decline|decline|i'?ll pass|pass|i'?d rather not|rather not)\b/i;
const REFUSE_SAID = /\b(not interested|no longer (interested|looking)|don'?t (want|wish) to (be|proceed|go)|do not (want|wish) to (be|proceed|go)|(do\s*n[o']?t|don'?t) (put|submit|send) me (forward|ahead|through)|(do\s*n[o']?t|don'?t) (put|submit|send|share) my (name|profile|cv|resume|application)\b(?!\s+with)|withdraw (me|my)|i decline|changed my mind)\b/i;
const CITY_REFUSE = /\b(can'?t|cannot|can not|won'?t|will not|unable to|not (able|willing|possible|open) to)\b/i;

// a greeting before the answer is not the answer ("Hi Charlie,\nYes, go ahead")
const GREETING_OPEN = /^\s*(hi|hello|hey|dear)\b(\s+(charlie|there|team)\b)?\s*[,!.:]?\s*/i;

export function readYesNo(text, kind = "consent") {
  const t = String(text || "").trim().replace(GREETING_OPEN, "");
  if (!t) return "unclear";
  const open = AGREE_OPEN.exec(t);
  if (open) {
    const rest = t.slice(open[0].length);
    if (!NEGATES.test(rest) && !HEDGES.test(rest)) return "yes";
  }
  if (REFUSE_OPEN.test(t) && !/^\s*no\s+(problems?|issues?|worries|objections?)\b/i.test(t)) return "no";
  if (REFUSE_SAID.test(t)) return "no";
  // after an agreement ("Yes, can't wait") a "can't" is not a refusal of the city: asked again, never closed
  if (kind === "city" && !open && CITY_REFUSE.test(t)) return "no";
  return "unclear";
}

/**
 * THE FINAL YES (no word list can read consent safely from free text): before
 * anything is submitted, the person is shown exactly what will be sent and asked to reply with just YES. This reads
 * that reply. Greetings, a sign-off and the signature after it, and a trailing "Sent from" line are set aside; what is
 * left must be one of a short list of plain yeses, and nothing else. "Okay. I've accepted another offer." is not on
 * it, and neither is "Ok": anything not on the list is asked once more, then closed unsubmitted. Pure.
 * Only commas, full stops and "!" are dropped. Any other character (another script, a digit, an emoji, a
 * "?") stays, so "Yes, लेकिन अभी नहीं", "Yes 👎" or "Yes?" can never read as a plain yes. Nothing is set
 * aside unless it is EXACTLY boilerplate: a phone client's own line from a fixed list (never one with words added),
 * and a signature only when every line of it is something we already hold about them (their name, phone or email; a
 * "--" line counts only as part of such a signature), and never a word that reads as a refusal even when it is in
 * their name ("No Way"). Our own email quoted back (iPhone Mail's "> On … wrote:", Outlook's "From:")
 * is not their words.
 */
// a client's own line, alone: "Sent from my iPhone", "Sent from my Redmi Note 8 Pro", "Get Outlook for iOS<https://..>".
// A device is a known brand plus model words (a digit, or pro/note/plus...), never other words ("actually no").
const BRANDS = "iphone|ipad|android( phone| device)?|phone|mobile|smartphone|samsung( galaxy)?( smartphone| device)?|galaxy|blackberry|huawei|oneplus|xiaomi|redmi|poco|realme|oppo|vivo|motorola|moto|nokia|pixel";
const MODEL = "( ([a-z]*\\d[a-z0-9+]*|pro|note|plus|max|ultra|mini|lite|se|prime|neo|fold|flip|edge|smartphone|device)){0,4}";
const SENT_FROM = new RegExp(`^\\s*(sent from my (${BRANDS})${MODEL}|sent from (outlook|mail|gmail|gmail mobile|yahoo mail|proton mail|protonmail|proton mail mobile|spark|zoho mail)( for (ios|android|iphone|windows))?( on (android|ios|iphone))?|get outlook for (ios|android))\\s*(<https?://[^>\\s]+>)?\\s*[.]?\\s*$`, "i");
/** Never a signature word, even when it is in their name. Checked on the cleaned word. */
const NOT_SIGNATURE = new Set(["no", "not", "nope", "nah", "naa", "nahi", "na", "mat", "ruko", "never", "wait", "stop", "hold", "later", "sorry", "dont", "cannot", "cant", "wont", "maybe", "unless", "but", "if", "except", "withdraw", "cancel", "decline", "pass", "busy", "yet", "until", "till", "only", "after", "before", "check", "think", "pause", "hmm", "hmmm", "unsure", "actually"]);
const SIGN_OFF = /^\s*(thanks (and|&) regards|thank you so much|thanks a lot|many thanks|best regards|warm regards|kind regards|thank you|thanks|regards|best|cheers|sincerely)\s*[,.!]*\s*/i;
const GREETING_LINE = /^\s*(hi|hello|hey|dear)\b(\s+(charlie|there|team)\b)?\s*[,!.:]*\s*$/i;
/** Charlie's own sending domain (from CHARLIE_FROM), so a quote of our own mail can be recognised. */
const OUR_DOMAIN = String(process.env.CHARLIE_FROM || "charlie@mail.example.com").split("@")[1] || "mail.example.com";
const OURS = new RegExp(`(charlie@|${OUR_DOMAIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "i");
const QUOTE_HEAD = /^\s*>?\s*(on .*wrote:?\s*$|from:\s|-{2,}\s*original message)/i;
const CONFIRM_YES = /^(yes|yes yes|yes please|yes go ahead|yes please go ahead|please go ahead|go ahead|yes proceed|yes please proceed|please proceed|yes please send|yes send|yes please submit|yes submit|please submit|yes confirmed|confirmed|confirm|i confirm|yes i confirm|yes all correct|all correct|correct|yes correct|yes it's correct|yes it is correct|yes that's correct|yes that is correct|yes that's right|yes everything is correct|yes all details are correct|yes all good|yes looks good|yes sure|sure yes|ok yes|okay yes|yes ok|yep|yes sir|yes ma'am|haan|haan ji|ha ji|ji haan)$/;

/**
 * The reply as the person typed it: our own quoted email (from its "On … wrote:" or "From:" line naming Charlie,
 * with or without a ">" in front, as iPhone Mail sends it), any ">" quoted line, a trailing client line, a greeting,
 * and a sign-off with a signature that is only their name, phone or email are set aside; lower-cased, with only
 * , . ! dropped. `who` is their name, or { name, phone, email }. Company words are never a signature (a company is
 * free text). Pure.
 */
export function confirmCore(text, who = "") {
  const w = typeof who === "string" ? { name: who } : who || {};
  const low = (x) => String(x || "").toLowerCase().replace(/[‘’]/g, "'");
  const clean = (x) => low(x).replace(/[^a-z0-9]/g, "");
  const names = new Set(low(w.name).split(/\s+/).map(clean).filter((x) => x.length >= 2 && !NOT_SIGNATURE.has(x)));
  const digits = String(w.phone || "").replace(/\D/g, "");
  // a signature line: only their name words, their phone, or their email, with separators
  const isSignature = (l) => {
    if (String(l).trim() === "--") return true;                                // the "-- " line, only inside a signature
    const noPhone = low(l).replace(low(w.email) || "\u0000", " ").replace(/\+?\d[\d\s-]{4,}\d/g, (m) => { const d = m.replace(/\D/g, ""); return digits.length >= 6 && d.length >= 6 && (d.endsWith(digits) || digits.endsWith(d.slice(-10))) ? " " : m; });
    const rest = noPhone.split(/[\s|,.:/()\-]+/).filter(Boolean);
    return rest.length > 0 && rest.every((x) => names.has(clean(x)) || x === "&");
  };
  let lines = String(text || "").split(/\r?\n/);
  // our own email quoted back: everything from its header line on is ours, not theirs. Gmail wraps a long
  // "On … Charlie <charlie@…> wrote:" across two or three lines, so the header is read joined.
  // A wrapped header starts at the CLOSEST "On …" line above its "wrote:" line, over unbroken lines
  // only, so a line of their own that starts with "On" ("On hold please") is never taken for our header
  const wrappedStart = (j) => { for (let i = j; i >= Math.max(0, j - 2); i--) { if (!lines[i].trim()) return -1; if (/^\s*>?\s*on\s/i.test(lines[i])) return OURS.test(lines.slice(i, j + 1).join(" ")) ? i : -1; } return -1; };
  const single = lines.findIndex((l, i) => QUOTE_HEAD.test(l) && !/^\s*>?\s*on\s/i.test(l) && OURS.test(`${l} ${lines[i + 1] || ""}`));
  // each header as [first line, last line]; only the header's OWN lines are skipped below (a line of theirs
  // ending "…as you wrote" is their words, not our header)
  const spans = [...(single >= 0 ? [[single, OURS.test(lines[single]) ? single : single + 1]] : []), ...lines.map((l, j) => (/\bwrote:?\s*$/i.test(l) ? [wrappedStart(j), j] : [-1, -1])).filter(([i]) => i >= 0)];
  const first = spans.reduce((m, sp) => (sp[0] < m[0] ? sp : m), [Infinity, Infinity]);
  const head = first[0];
  if (head !== Infinity) {
    // under an "On … wrote:" header the quote is ">"-marked: a line of their own typed inside it (an inline
    // correction) means this is not a plain YES
    const after = lines.slice(first[1] + 1);
    const ownBelow = /^\s*>?\s*on\s/i.test(lines[head]) && after.some((l) => l.trim() && !/^\s*>/.test(l));
    lines = lines.slice(0, head);
    if (ownBelow) lines.push("[their own words inside the quoted email]");
  }
  let kept = lines.filter((l) => !/^\s*>/.test(l)).map((x) => x.trim()).filter(Boolean);
  while (kept.length && (SENT_FROM.test(kept[kept.length - 1]) || /^[_=-]{5,}$/.test(kept[kept.length - 1]))) kept.pop();
  while (kept.length && GREETING_LINE.test(kept[0])) kept.shift();
  // the last sign-off line, if everything after it is their signature, ends the reply
  for (let i = kept.length - 1; i >= 0; i--) {
    const m = SIGN_OFF.exec(kept[i]);
    const tail = m ? kept[i].slice(m[0].length) : null;
    if (m && (!tail || isSignature(tail)) && kept.slice(i + 1).every(isSignature)) { kept = kept.slice(0, i); break; }
  }
  // a "-- " signature with no sign-off: set aside only when every line after it is their signature
  const delim = kept.findIndex((l) => l === "--");
  if (delim > 0 && kept.slice(delim + 1).every(isSignature)) kept = kept.slice(0, delim);
  // a bare name on the last line
  while (kept.length > 1 && isSignature(kept[kept.length - 1]) && !/\d|@/.test(kept[kept.length - 1])) kept.pop();
  return kept.join(" ").toLowerCase().replace(/[‘’]/g, "'").replace(/[,.!]+/g, " ").replace(/\s+/g, " ").trim()
    .replace(/^(hi|hello|hey|dear)( charlie| there| team)? /, "").replace(/(^| )charlie( |$)/g, " ").trim()
    .replace(/ (thanks|thank you|thank you so much|many thanks)$/, "").trim();
}

/** Is this reply just YES? Pure. */
export const readConfirmYes = (text, who = "") => CONFIRM_YES.test(confirmCore(text, who));

/**
 * Read filed answers (verbatim spans, or null) into fields and facts. Pure. Consent and the city question are read
 * with readYesNo.
 * @param answers {question_id: verbatim span | null}
 * @returns {{ fields: object, consent: "yes"|"no"|"unclear"|null, workFrom: "yes"|"no"|"unclear"|null }}
 */
export function readAnswers(answers = {}) {
  const f = {};
  const a = (id) => (typeof answers[id] === "string" && answers[id].trim() ? answers[id].trim() : null);
  if (a("currentPay")) {
    const p = parseCurrentPay(a("currentPay"));
    if (p.fixed != null) f.currentCtcFixed = val(p.fixed, "answer");
    if (p.variable != null) f.currentCtcVariable = val(p.variable, "answer");
  }
  if (a("expectedPay")) { const n = parseExpectedPay(a("expectedPay")); if (n != null) f.expectedCtc = val(n, "answer"); }
  if (a("noticePeriod")) { const n = parseNoticeDays(a("noticePeriod")); if (n != null) f.noticePeriod = val(String(n), "answer"); }
  if (a("phone")) { const p = parsePhone(a("phone")); if (p) { f.phoneNo = val(p.phoneNo, "answer"); f.countryCode = val(p.countryCode, "answer"); } }
  if (a("linkedInUrl")) { const l = parseLinkedIn(a("linkedInUrl")); if (l) f.linkedInUrl = val(l, "answer"); }
  if (a("currentCompany")) f.currentCompany = val(a("currentCompany").replace(/^(i work (at|for)|at)\s+/i, "").replace(/[.]+$/, ""), "answer");
  if (a("currentLocation")) f.currentLocation = val(a("currentLocation").replace(/^(i('| a)m (based )?in|in)\s+/i, "").replace(/[.]+$/, ""), "answer");
  if (a("experience")) { const n = parseYears(a("experience")); if (n != null) f.experience = val(n, "answer"); }
  const consent = a("consent") ? readYesNo(a("consent"), "consent") : null;
  const workFrom = a("workFrom") ? readYesNo(a("workFrom"), "city") : null;
  return { fields: f, consent, workFrom };
}

/** Fields merged (answers over record), plus the total of current pay when both parts are known. Pure. */
export function mergeFields(record = {}, answered = {}) {
  const out = { ...record, ...answered };
  if (out.currentCtcFixed && out.currentCtcVariable) out.currentCtcTotal = val(round2(out.currentCtcFixed.value + out.currentCtcVariable.value), "derived");
  return out;
}

/** The required fields still missing for the destination. Pure. */
export const missingFields = (fields, required = PIEWORKS_FIELDS) => required.filter((k) => fields[k]?.value == null || fields[k]?.value === "");

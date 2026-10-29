// lib/qualify/adapters.mjs — one adapter per kind of employer system the Qualify & Submit agent connects to.
// An adapter knows three things about its system: how to list roles, how to turn our resolved fields into its
// candidate payload, and how to submit. Everything else (who qualifies, what is asked, consent) is the agent's.
//
// pieworks   roles in + submissions out (lib/connections/pieworks.mjs).
// darwinbox  NOT BUILT: Darwinbox has no public candidate-submit API, so a connection of this type refuses to run.
import { listActiveRoles, submitReferral, pieworksConfig } from "../connections/pieworks.mjs";

const value = (fields, k) => fields?.[k]?.value;

/** Each field of the Pieworks candidate part (lib/schemas/pieworks.mjs PieworksCandidate, doc 1.4.1) in plain words;
 *  lib/qualify/adapters.test.mjs fails when the schema gains a field this does not name. */
export const PIEWORKS_NEEDS_BY_FIELD = {
  name: "Name", emailId: "Email", phoneNo: "Phone, with country code", countryCode: "Phone, with country code",
  linkedInUrl: "LinkedIn", currentCompany: "Current company", currentLocation: "City", experience: "Years of experience",
  currentCtcFixed: "Current pay: fixed, variable and total", currentCtcVariable: "Current pay: fixed, variable and total",
  currentCtcTotal: "Current pay: fixed, variable and total", expectedCtc: "Expected pay", noticePeriod: "Notice period",
  referralCode: "Your referral code", justification: "The note about them",
};

export const pieworks = {
  /** What a hand-off to Pieworks carries: the candidate part's fields, plus the cv part (a PDF). */
  needs: [...new Set(Object.values(PIEWORKS_NEEDS_BY_FIELD)), "CV as a PDF"],
  listRoles: async () => listActiveRoles({ cfg: pieworksConfig() }),
  /** Is the connection working: the key accepted and the roles readable? One page of one role; never a submit. */
  check: async () => {
    const r = await listActiveRoles({ cfg: pieworksConfig(), pageSize: 1, maxPages: 1 });
    return { ok: true, total: r.total, sample: r.roles[0] ? { id: r.roles[0].id, role: r.roles[0].role, client: r.roles[0].clientName } : null };
  },
  /** Our resolved fields as the doc's candidate part (1.4.1). The client validates it again before sending. */
  toCandidate(fields, justification) {
    return {
      experience: Number(value(fields, "experience")),
      linkedInUrl: value(fields, "linkedInUrl"),
      name: value(fields, "name"),
      currentCompany: value(fields, "currentCompany"),
      emailId: value(fields, "emailId"),
      phoneNo: value(fields, "phoneNo"),
      countryCode: value(fields, "countryCode"),
      currentLocation: value(fields, "currentLocation"),
      currentCtcFixed: Number(value(fields, "currentCtcFixed")),
      currentCtcVariable: Number(value(fields, "currentCtcVariable")),
      currentCtcTotal: Number(value(fields, "currentCtcTotal")),
      expectedCtc: Number(value(fields, "expectedCtc")),
      noticePeriod: String(value(fields, "noticePeriod")),
      justification,
    };
  },
  submit: async (_conn, { roleId, candidate, cv }) => submitReferral({ cfg: pieworksConfig(), roleId, candidate, cv }),
};

const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

/**
 * email   a destination only: the pack (the facts the person said YES to, their CV, the note) to
 *         the hiring contact on the connection, destination { type: "email", to, name? }. It goes through the agent's
 *         guarded send; this adapter never sends by itself. Anything but a clean "sent" throws, so the
 *         agent retries and then stops for a person, never closes the candidate over a mail problem.
 */
export const email = {
  needs: ["The details the person confirmed", "CV as a PDF"],
  listRoles: async () => { throw new Error("email is a destination, not a source of roles"); },
  check: async (conn) => {
    const to = String(conn?.destination?.to || "").trim();
    if (!EMAIL_RE.test(to)) throw new Error("the hiring contact's address is missing or not an address");
    return { ok: true, to };
  },
  /** The pack: exactly the confirmed lines (the agent passes them), never re-read from the fields. */
  toCandidate(fields, justification, { facts } = {}) {
    if (!Array.isArray(facts) || !facts.length) throw new Error("the hand-off needs the confirmed facts");
    return { name: value(fields, "name"), email: value(fields, "emailId"), facts, justification };
  },
  submit: async (conn, { candidate, cv, send }) => {
    const to = String(conn?.destination?.to || "").trim();
    if (!EMAIL_RE.test(to)) throw new Error("the hiring contact's address is missing or not an address");
    if (typeof send !== "function") throw new Error("no send for the hand-off; nothing was sent");
    if (!cv?.bytes?.length) throw new Error("no CV PDF to attach; nothing was sent");
    const r = await send({ to, contact: conn.destination?.name || "", candidate, cv });
    if (r?.status === "sent") return { status: "sent", to };
    // a pack already claimed but never recorded as sent: it may or may not have reached them (a run that stopped
    // between the claim and the send leaves the claim). Never assumed either way: it stops for a person
    if (r?.status === "duplicate") throw new Error("a hand-off to this contact was already started for this person; check with them before anything else");
    throw new Error(`the hand-off was not sent: ${r?.status ?? "no status"}`);
  },
};

export const ADAPTERS = { pieworks, email };

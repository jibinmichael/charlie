// lib/agents/registry.mjs — the agents, what each does, and how each works out of the box.
//
// THE LINEUP: one agent, Qualify & Submit (id `outreach`, labelled White-label), connected to Pieworks. Other ids the
// database admits (qualifier, rediscovery, followup) are not agents here: a stored row for one is ignored and a draft
// one left behind is never sent (server/agents.ts recheck).
//
// OUT OF THE BOX: a workspace with no hire_agents rows runs on these defaults. Qualify & Submit is automatic; who it
// writes to is decided by the pluggable candidate scorer (lib/scoring/index.mjs, CANDIDATE_SCORER), and nobody is put
// forward until a person approves them in the Inbox.
//
// BUILT FLAGS ARE HONEST. An agent whose workflow is not built yet (`built: false`) can be seen and configured but never
// runs, and the screen says so. Nothing here claims work that does not happen.

export const AGENT_IDS = ["outreach"];
export const MODES = ["off", "draft", "auto"];

/** The limits every agent shares, before its own settings. */
const COMMON = {
  daily_cap: 30, // emails (sent or drafted) per agent per India day
  quiet_from: 21, // no sends from 21:00 ...
  quiet_to: 9, // ... to 09:00, India time
};

export const AGENTS = {
  outreach: {
    name: "Qualify & Submit",
    // connected to Pieworks, shown as White-label
    label: "White-label",
    what: "Finds the people in your pool the candidate scorer passes for each employer's open roles, checks with each person by email that everything the employer needs is true, and submits the ones who still fit once a person approves them. Automatic.",
    cadence: "Finds new fits twice a day; reads replies every 15 minutes",
    // lib/qualify/agent.mjs. Each employer system is a connection with its own mode: off, shadow (does everything
    // except send and submit), live. The list below says only what happens.
    does: [
      "Brings each connected employer's open roles in, with a brief built only from the role's own fields",
      "Scores your pool against each role with the candidate scorer, after the experience check, and picks the ones it passes",
      "Emails each one to ask consent to be put forward, then only what the employer needs and their record lacks",
      "Reads their answers word for word, judges again, and asks one follow-up at most",
      "Sends its own reminder when someone has not replied, and closes the conversation quietly after it",
      "Submits the ones who said yes, still pass and a person approved, once, with a reason taken only from their own words",
    ],
    every_minutes: 15,
    built: true,
    // automatic: the control is each connection's mode, not a per-email approval
    modes: ["off", "auto"],
    defaults: { enabled: true, mode: "auto", settings: { ...COMMON } },
  },
};

/** An agent's live configuration: its stored row over its defaults. Pure. */
export function configOf(id, row) {
  const a = AGENTS[id];
  if (!a) throw new Error(`unknown agent ${id}`);
  const settings = { ...a.defaults.settings, ...(row?.settings ?? {}) };
  return {
    id,
    name: a.name,
    label: a.label ?? null,
    what: a.what,
    cadence: a.cadence,
    does: a.does,
    built: a.built,
    every_minutes: a.every_minutes,
    enabled: row ? row.enabled !== false : a.defaults.enabled,
    modes: a.modes ?? MODES,
    mode: (a.modes ?? MODES).includes(row?.mode) ? row.mode : a.defaults.mode,
    settings,
    customised: !!row,
  };
}

/** The India-time hour, for quiet hours. Pure. */
export function istHour(ms) {
  return new Date(ms + 330 * 60_000).getUTCHours();
}

/** Inside quiet hours (a window that may wrap midnight, e.g. 21 -> 9)? Pure. */
export function inQuietHours(ms, from, to) {
  const h = istHour(ms);
  if (!Number.isInteger(from) || !Number.isInteger(to) || from === to) return false;
  return from < to ? h >= from && h < to : h >= from || h < to;
}

/** The start of the India day containing `ms`, as an ISO string (the daily cap counts from here). Pure. */
export function istDayStart(ms) {
  const ist = new Date(ms + 330 * 60_000);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()) - 330 * 60_000).toISOString();
}

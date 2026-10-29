// lib/ask-preflight.mjs — refuse to ask a question the running server cannot hear the answer to.
//
// An ask only works when the server receiving the replies knows it: its template must be in ASK_TEMPLATES
// (lib/open-ask.mjs) and /inbound must have its branch. lib/ask-registry.test.mjs guards the repository; this
// guards the distance between the repository and the machine that receives the mail. A script that asks a
// question compares this tree's build id against the one /healthz reports, and refuses to send when they
// differ. Not a warning: a warning printed above hundreds of send lines is scrollback, and a human cannot be
// the check here.
//
// WHY REFUSE ON ANY DIFFERENCE rather than something cleverer. The server does not expose its
// ASK_TEMPLATES, so "does the deployed build know this template?" is not answerable from outside. What
// IS answerable is "is the deployed build this build?", and when the answer is no, the honest position
// is that we do not know what the server will do with the replies. Fail closed: deploy, then ask.
//
// It is not a general send guard. Sending a mail that expects NO reply is unaffected, because nothing
// is lost if the server has not caught up.

import { buildId } from "./build-id.mjs";
import { ASK_TEMPLATES } from "./open-ask.mjs";

/** Where to ask the running server what it is. */
const HEALTH = process.env.CHARLIE_HEALTH_URL || "https://api.example.com/healthz";

/**
 * Throw unless the running server is this exact code.
 *
 * @param {string} template the template the caller is about to send under
 * @param {{fetch?: typeof fetch, healthUrl?: string, mine?: string}} [deps] injected for tests
 */
export async function assertAskDeployable(template, deps = {}) {
  const t = String(template || "").trim();
  if (!t) throw new Error("assertAskDeployable: a template name is required");

  // A send whose replies nobody has to interpret does not need the server to have caught up.
  if (!ASK_TEMPLATES.includes(t)) return { ok: true, reason: "not an ask" };
  return assertRunningBuild(t, deps);
}

/**
 * The comparison itself, for a send whose replies are routed some other way than ASK_TEMPLATES (the
 * Qualify & Submit apply+<key>@ replies, lib/qualify/wiring.mjs). Throws unless /healthz reports this
 * exact build.
 */
export async function assertRunningBuild(label, deps = {}) {
  const t = String(label || "").trim();
  if (!t) throw new Error("assertRunningBuild: a label is required");

  const f = deps.fetch || fetch;
  const url = deps.healthUrl || HEALTH;
  // COMPUTED ONCE. buildId() hashes the working tree, so calling it twice and comparing the results
  // is a race against anything writing to the tree in between — which is exactly how the first version
  // of this went red one run in two under the test suite, as snapshot files were written between the
  // two reads. One read, one value, injectable so a test controls both sides of the comparison.
  const mine = deps.mine || buildId();

  let live;
  try {
    const r = await f(url, { signal: AbortSignal.timeout(15_000) });
    if (!r.ok) throw new Error(`${r.status}`);
    live = (await r.json()).build;
  } catch (e) {
    // An unreachable /healthz must not read as "fine": a check that stops checking must not keep reporting
    // success.
    throw new Error(
      `refusing to send "${t}": could not reach ${url} to confirm what the server is running (${e.message}). ` +
      `Replies to this mail need a server that knows about it.`,
    );
  }

  if (live !== mine) {
    throw new Error(
      `refusing to send "${t}": this tree is build ${mine}, the server is running ${live}.\n` +
      `  "${t}" is an ask, so its replies need /inbound to recognise it, and the running server was\n` +
      `  built from different code, so a person who answers could be sent a reply that ignores it.\n` +
      `  Deploy first, then re-run this.`,
    );
  }
  return { ok: true, build: mine };
}

// drip-removal.test.mjs — the bring-a-friend share loop and the VIP Club invite drip are REMOVED,
// and this is what stops them coming back.
//
// Charlie sends: roles, the market read, the things that gather what a match needs, confirmations,
// and replies to what a person actually wrote. Asking someone to recruit their friends, or inviting
// them to a club, is none of those — it is marketing wearing a lifecycle drip's clothes.
//
// WHY A TEST AND NOT A FLAG: a flag can be flipped back by anyone with access to the service
// variables, and a comment saying "do not re-add this" cannot stop a re-add. A failing check can. If someone
// genuinely decides to bring these back, they have to delete this file, which is a visible, arguable
// act in a diff rather than a quiet one-line env change.
//
// DELIBERATELY NOT ASSERTED DEAD — these are shared plumbing that other, wanted features use:
//   /g/<token>, friend_referrals, signToken, friendVariant  -> gift-a-role (GIFT_A_ROLE=on)
//   computeMissing (render-invite.mjs)                      -> confirm-sweep.mjs, and the
//                                                              confirmation is transactional
// Asserting those gone would be over-reach and would break features nobody asked to remove.

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL(".", import.meta.url).pathname;
const read = (p) => readFileSync(join(ROOT, p), "utf8");

describe("the inbox-setup drip stays removed", () => {
  // An inbox-setup tutorial (Gmail filters, Multiple Inboxes) is not a job Charlie does, and an
  // unflagged interval sweep that mails every active user is not something this product sends.
  //
  // track@ IS DELIBERATELY NOT ASSERTED DEAD. Forwarding a company's reply and getting it logged is
  // transactional and wanted; renderTrackAck stays. Only the tutorial goes.
  it("the module, the template and the sweep are all gone", () => {
    expect(existsSync(join(ROOT, "whatsnew.mjs")), "whatsnew.mjs").toBe(false);
    expect(read("email-kit.mjs")).not.toContain("renderWhatsNew");
    expect(read("email-kit.mjs")).not.toContain("sorted in your inbox");
    const server = read("server/charlie-remote.ts");
    expect(server).not.toContain("runWhatsNewSweep");
    expect(server).not.toContain("whatsnew");
  });

  it("the transactional track@ acknowledgement is untouched", () => {
    // The guard above must not be read as "remove anything mentioning tracking".
    expect(read("email-kit.mjs")).toContain("renderTrackAck");
  });
});

describe("the referral + club drips stay removed", () => {
  it("their modules do not exist", () => {
    for (const f of ["friend-drip.mjs", "invite-sweep.mjs"]) expect(existsSync(join(ROOT, f)), f).toBe(false);
  });

  it("the server starts no sweep for either", () => {
    const s = read("server/charlie-remote.ts");
    expect(s).not.toMatch(/runFriendDripSweep|runInviteSweep/);
    expect(s).not.toMatch(/from "\.\.\/(friend-drip|invite-sweep)\.mjs"/);
  });

  it("no code path can send either template through the send guard", () => {
    // The ONE physical send door is lib/send-guard.mjs, so a template id that never reaches it can
    // never be delivered. Scan every source file for a sendGuarded template naming these drips.
    const skip = new Set(["node_modules", ".git", ".next", "dist", "docs", "emails"]);
    const offenders = [];
    const walk = (dir) => {
      for (const e of readdirSync(join(ROOT, dir || "."), { withFileTypes: true })) {
        if (e.name.startsWith(".") || skip.has(e.name)) continue;
        const rel = dir ? `${dir}/${e.name}` : e.name;
        if (e.isDirectory()) { walk(rel); continue; }
        if (!/\.(mjs|ts|tsx)$/.test(e.name)) continue;
        if (rel === "drip-removal.test.mjs") continue;
        const src = readFileSync(join(ROOT, rel), "utf8");
        if (/template:\s*["'`](friend-drip|invite)["'`]/.test(src)) offenders.push(rel);
      }
    };
    walk("");
    expect(offenders, `these still send a removed drip: ${offenders.join(", ")}`).toEqual([]);
  });

  it("their render functions are gone", () => {
    expect(read("email-kit.mjs")).not.toMatch(/export function renderFriendDrip/);
    expect(read("render-invite.mjs")).not.toMatch(/export function renderInvite\b/);
  });

  // The other half of the guard: prove the cut did NOT take the wanted things with it. If a future
  // "cleanup" removes these, that is a regression in the opposite direction and should also fail.
  it("gift-a-role's shared plumbing survives", () => {
    const store = read("charlie-store.mjs");
    expect(store).toMatch(/friendVariant/);
    expect(store).toMatch(/friend_referrals/);
    expect(read("server/charlie-remote.ts")).toMatch(/\/g\//);
  });

  it("the confirmation stays — it is transactional, not a drip", () => {
    expect(existsSync(join(ROOT, "confirm-sweep.mjs"))).toBe(true);
    expect(read("render-invite.mjs")).toMatch(/export function computeMissing/);
    expect(read("server/charlie-remote.ts")).toMatch(/runConfirmationSweep/);
  });
});

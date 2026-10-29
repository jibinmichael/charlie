// Every link the dashboard builds is a /hq/<secret> URL, and every server call it makes is to a route the Charlie
// server serves. Run:
//   node --test lib/links.test.mjs      (Node 22.18+ strips the types of lib/paths.ts itself)
// No network and nothing live: the pure helper, and a read of the real source files.
import assert from "node:assert/strict"
import { readFileSync, readdirSync, statSync } from "node:fs"
import path from "node:path"
import { describe, test } from "node:test"
import { fileURLToPath } from "node:url"

import { hqRoot, linkFor } from "./paths.ts"

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..")
function files(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n)
    return statSync(p).isDirectory() ? files(p) : /\.(tsx?|mjs)$/.test(n) ? [p] : []
  })
}
const SOURCES = [...files(path.join(ROOT, "components")), ...files(path.join(ROOT, "app")), ...files(path.join(ROOT, "lib"))].filter(
  (p) => !p.endsWith(".test.mjs"),
)
const rel = (p) => path.relative(ROOT, p)

describe("links: every one is a /hq/<secret> URL", () => {
  test("the root and a path under it", () => {
    assert.equal(hqRoot("s3cr3t"), "/hq/s3cr3t")
    for (const sub of ["/studio", "/studio/m1/c/s1", "/workspace/inbox", "/workspace/agents", "/workspace/agents/new"])
      assert.equal(linkFor("s3cr3t", sub), `/hq/s3cr3t${sub}`)
  })
  test("no component builds /hq/${secret} by hand; every link goes through useLink", () => {
    // app/hq/[secret]/page.tsx is the secret route's own server redirect.
    const allowed = new Set([path.join("app", "hq", "[secret]", "page.tsx"), path.join("lib", "paths.ts")])
    const offenders = SOURCES.map(rel).filter((p) => !allowed.has(p) && readFileSync(path.join(ROOT, p), "utf8").includes("`/hq/${"))
    assert.deepEqual(offenders, [])
  })
})

describe("the signed-in mode is gone", () => {
  test("no page or call names a route this repo's server does not serve", () => {
    // /auth/*, /agents/api/me|team|company|settings belonged to a separate service that is not part of this repo.
    const dead = /["'`](?:\/auth\/|\/agents\/api\/(?:me|team|company|settings)\b)|\/w\/workspace/
    const offenders = SOURCES.filter((p) => dead.test(readFileSync(p, "utf8"))).map(rel)
    assert.deepEqual(offenders, [])
  })
  test("no route folder for it is left under app/", () => {
    for (const d of ["auth", "w", "onboarding"]) assert.equal(SOURCES.some((p) => rel(p).startsWith(path.join("app", d) + path.sep)), false, d)
  })
  test("every Bearer in lib/ goes through secretFetch", () => {
    const direct = SOURCES.filter((p) => rel(p).startsWith("lib")).filter((p) => /authorization:\s*`Bearer/.test(readFileSync(p, "utf8"))).map(rel)
    assert.deepEqual(direct, ["lib/api.ts"])
  })
})

// Where the dashboard's links point: everything lives under the secret link, /hq/<secret>/...
// Pure: no imports, so lib/links.test.mjs can run it under plain node.

/** The root for a secret link: /hq/<secret>. */
export const hqRoot = (secret: string) => `/hq/${secret}`

/** The link for a path under the root ("/workspace/inbox", "/studio/<id>"): the /hq/<secret> URL. */
export function linkFor(secret: string, sub: string): string {
  return `${hqRoot(secret)}${sub}`
}

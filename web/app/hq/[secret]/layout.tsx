// The layout for secret-link pages under /hq/<secret>.
import { Shell } from "@/components/shell/Shell"

/**
 * Everything under /hq/<secret>. The secret is the whole lock: it is presented as a Bearer to the
 * Charlie server on every request and never stored anywhere else. This layout holds no key.
 */
export default async function HqLayout({
  children,
  params,
}: Readonly<{ children: React.ReactNode; params: Promise<{ secret: string }> }>) {
  const { secret } = await params
  return <Shell secret={secret}>{children}</Shell>
}

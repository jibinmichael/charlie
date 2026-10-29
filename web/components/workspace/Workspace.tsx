"use client"

// The workspace frame: the left rail (Inbox, Agents) and the section it opens.

import {
  Bot,
  Inbox as InboxIcon,
} from "lucide-react"
import Link from "next/link"

import { CharlieLogo } from "@/components/shell/CharlieLogo"
import { useLink } from "@/lib/api"
import { cn } from "@/lib/utils"

import { Inbox } from "./Inbox"
import { Agents } from "./Agents"

/** The workspace sections: the Inbox (each agent conversation, both ways) and the Agents (Qualify & Submit). */
export type Section = "inbox" | "agents"

export function Workspace({ section, sub }: { section: Section; sub?: string | undefined }) {
  return (
    <div className="flex h-screen min-h-0">
      <WorkspaceRail active={section} />
      <div className="flex min-w-0 flex-1 flex-col">
        {section === "inbox" && <Inbox />}
        {section === "agents" && <Agents isNew={sub === "new"} />}
      </div>
    </div>
  )
}

/** The left nav: Inbox, Agents. One size, one stroke. */
function WorkspaceRail({ active }: { active: Section }) {
  const link = useLink()
  const items: {
    Icon: React.ComponentType<{ className?: string; strokeWidth?: number }>
    label: string
    href: string
    on: boolean
  }[] = [
    { Icon: InboxIcon, label: "Inbox", href: link("/workspace/inbox"), on: active === "inbox" },
    { Icon: Bot, label: "Agents", href: link("/workspace/agents"), on: active === "agents" },
  ]
  const item = ({ Icon, label, href, on }: (typeof items)[number]) => (
    <Link
      key={label}
      href={href}
      aria-label={label}
      data-link="block"
      className={cn(
        "group relative flex size-7 items-center justify-center squircle transition-colors outline-none",
        on
          ? "bg-[var(--surface)] text-[var(--ink)] shadow-[inset_0_0_0_1px_var(--border)]"
          : "text-[var(--ink-2)] hover:bg-[var(--hover)] hover:text-[var(--ink)] active:bg-[var(--muted)]",
      )}
    >
      <Icon className="size-4" strokeWidth={1.25} />
      {/* the tooltip: to the right of the icon, on hover or keyboard focus, after a short pause */}
      <span
        role="tooltip"
        className="pointer-events-none absolute top-1/2 left-full ml-2.5 -translate-x-1 -translate-y-1/2 rounded-md bg-[var(--ink)] px-2 py-1 text-[12px] leading-[16px] font-normal whitespace-nowrap text-white opacity-0 shadow-[0_4px_12px_rgba(0,0,0,0.12)] transition-[opacity,transform] duration-[var(--motion-fast)] group-hover:translate-x-0 group-hover:opacity-100 group-hover:delay-300 group-focus-visible:translate-x-0 group-focus-visible:opacity-100"
      >
        <span
          aria-hidden
          className="absolute top-1/2 -left-[3px] size-2 -translate-y-1/2 rotate-45 rounded-[1px] bg-[var(--ink)]"
        />
        {label}
      </span>
    </Link>
  )
  return (
    <nav className="relative z-30 flex w-12 shrink-0 flex-col items-center border-r border-[var(--border)] bg-white py-2">
      <div className="flex h-9 items-center">
        <CharlieLogo size={22} />
      </div>
      <div className="mt-3 flex flex-col items-center gap-1">{items.map(item)}</div>
    </nav>
  )
}

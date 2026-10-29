// Status icons for voice-verification results.
import { Circle, CircleCheck, CircleDashed, TriangleAlert } from "lucide-react"

export type Icon = React.ComponentType<{ className?: string }>

/** One of the six voice-verification statuses as an icon in its colour. */
export const STATUS_ICON: Record<string, { icon: Icon; ink: string; label: string }> = {
  strongly_supported: { icon: CircleCheck, ink: "text-[#16a34a]", label: "Strongly supported" },
  supported: { icon: CircleCheck, ink: "text-[#16a34a]", label: "Supported" },
  stated_only: { icon: CircleDashed, ink: "ink-stated", label: "Stated only" },
  contradicted: { icon: TriangleAlert, ink: "ink-warn", label: "Contradicted" },
  insufficient: { icon: Circle, ink: "text-[var(--faint)]", label: "Insufficient" },
  not_assessed: { icon: Circle, ink: "text-[var(--faint)]", label: "Not assessed" },
}

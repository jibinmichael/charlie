// Charlie's logo mark, as used in the workspace rail.
import { cn } from "@/lib/utils"

/** Charlie's mark: a lime rounded square with the hand in dark grey.
 *  The same drawing as the favicon (app/icon.svg). Static, never animated. */
export function CharlieLogo({ size = 20, className }: { size?: number; className?: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src="/charlie-mark.svg"
      alt=""
      width={size}
      height={size}
      aria-hidden
      className={cn("shrink-0", className)}
      style={{ width: size, height: size }}
    />
  )
}

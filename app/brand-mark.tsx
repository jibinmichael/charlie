// Charlie's wordmark with the robot face, used everywhere the brand appears outside the
// top nav (footer, every auth card, the connected + error screens). Purely presentational,
// so it's safe to import into both server and client components.
import type { CSSProperties } from "react";

export function BrandMark({
  size = 20,
  className = "brand",
  style,
}: {
  size?: number;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <span className={className} style={style}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className="mark" src="/charlie-bot.svg" alt="" width={size} height={size} aria-hidden="true" />
      Charlie<span className="d">.</span>
    </span>
  );
}

"use client";

import { useEffect, useState } from "react";

// The email header's timestamp. Server-renders a stable "just now" (so hydration
// matches), then on mount fills in the viewer's own local time — e.g. "3:42 PM (just now)".
export default function MailTime() {
  const [label, setLabel] = useState("just now");

  useEffect(() => {
    const d = new Date();
    let h = d.getHours();
    const m = d.getMinutes();
    const ampm = h >= 12 ? "PM" : "AM";
    h = h % 12;
    if (h === 0) h = 12;
    setLabel(`${h}:${m < 10 ? `0${m}` : m} ${ampm} (just now)`);
  }, []);

  return (
    <span className="time" suppressHydrationWarning>
      {label}
    </span>
  );
}

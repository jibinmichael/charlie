"use client";

import { useEffect } from "react";

// Ports the page's two interactions verbatim: the section reveals (.rv) and the
// scan-log staggered reveal (#scan). An IntersectionObserver adds the "in" class
// once each element scrolls into view, then unobserves it. CSS does the rest
// (including the prefers-reduced-motion opt-out).
export default function RevealObserver() {
  useEffect(() => {
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add("in");
            io.unobserve(e.target);
          }
        });
      },
      { threshold: 0.3 },
    );
    document.querySelectorAll(".rv, #scan").forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);

  return null;
}

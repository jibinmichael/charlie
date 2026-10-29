"use server";

import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";

export type JoinResult = { status: "success" | "duplicate" | "error" };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function joinWaitlist(rawEmail: string): Promise<JoinResult> {
  const email = (rawEmail ?? "").trim().toLowerCase();

  // server-side guard; the client validates too
  if (!EMAIL_RE.test(email)) return { status: "error" };

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    console.error(
      "[waitlist] missing Supabase env vars — is .env.local present and was the dev server restarted after creating it?",
      { hasUrl: Boolean(url), hasAnonKey: Boolean(anonKey) },
    );
    return { status: "error" };
  }

  const supabase = createClient<Database>(url, anonKey);
  const { error } = await supabase.from("waitlist").insert({ email });

  if (error) {
    // 23505 = unique_violation -> already on the list
    if (error.code === "23505") return { status: "duplicate" };
    console.error("[waitlist] insert failed:", {
      message: error.message,
      code: error.code,
      details: error.details,
      hint: error.hint,
    });
    return { status: "error" };
  }

  return { status: "success" };
}

// app/hq/api.ts — the dashboard's one way of talking to the server. NEXT_PUBLIC_* only.
const API = process.env.NEXT_PUBLIC_CHARLIE_API_BASE || "https://api.example.com";

export class ApiError extends Error {
  status: number;
  issues?: string[];
  constructor(status: number, message: string, issues?: string[]) { super(message); this.status = status; this.issues = issues; }
}

export async function api<T = any>(secret: string, path: string, init: RequestInit = {}): Promise<T> {
  const r = await fetch(`${API}${path}`, {
    ...init,
    headers: { "content-type": "application/json", authorization: `Bearer ${secret}`, ...(init.headers || {}) },
    cache: "no-store",
  });
  let body: any = null;
  try { body = await r.json(); } catch { /* no body */ }
  if (!r.ok) {
    const msg = r.status === 401 ? "This link's secret is wrong." : r.status === 404 ? "Voice verification is switched off on the server." : r.status === 503 ? "The server has no dashboard secret configured." : body?.error || `${r.status}`;
    throw new ApiError(r.status, msg, body?.issues);
  }
  return body as T;
}

export const fmtDate = (s?: string | null) => (s ? new Date(s).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "");
export const secs = (n?: number | null) => (n == null ? "" : `${Math.floor(n / 60)}:${String(Math.round(n % 60)).padStart(2, "0")}`);

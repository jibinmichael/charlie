// lib/load-env.mjs — import this FIRST in an entry script to load the repo's .env.local (then .env).
//
//   import "./lib/load-env.mjs";        // root entry points
//   import "../lib/load-env.mjs";       // scripts/
//
// Same rules as loadEnv() in charlie-store.mjs: a variable already set in the real environment wins,
// and a missing file is fine (Railway has none). Being a side-effect import is the point: ES imports
// are evaluated in order before the script body runs, so modules imported after this one already see
// the values when they read process.env at load time — a loadEnv() call in the body would be too late.
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "./dotenv.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

for (const file of [".env.local", ".env"]) {
  const p = join(ROOT, file);
  if (!existsSync(p)) continue;
  for (const [name, value] of parseEnv(readFileSync(p, "utf8"))) {
    if (process.env[name] === undefined) process.env[name] = value;
  }
}

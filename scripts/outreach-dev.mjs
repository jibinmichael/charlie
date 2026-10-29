#!/usr/bin/env node
// scripts/outreach-dev.mjs — a local server for the outreach inbox, and nothing else. Mounts
// server/outreach.ts on the JSON + CORS middleware: no /inbound, no webhooks, no sweeps, no send path.
// Everything it serves is read only (lib/hire-outreach.mjs, lib/outreach-files.mjs).
//
//   node --env-file=.env.local --import tsx scripts/outreach-dev.mjs [--port 8788]
//   then, in web/: NEXT_PUBLIC_CHARLIE_API_BASE=http://localhost:8788 npm run dev
//   and open http://localhost:3000/hq/<secret>/workspace
//
// The secret is VOICE_DASHBOARD_SECRET from the env file, else "dev-secret" (local only; the deployed
// server never reads this script). One server per port.
import "../lib/load-env.mjs"; // loads .env.local / .env before anything reads process.env
import express from "express";
import { outreachRouter } from "../server/outreach.ts";

process.env.HIRING_WORKSPACE = "on";
process.env.VOICE_DASHBOARD_SECRET ||= "dev-secret";
const i = process.argv.indexOf("--port");
const PORT = Number(i > -1 ? process.argv[i + 1] : 8788);

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.header("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
app.use(outreachRouter());
app.get("/healthz", (_req, res) => res.json({ ok: true, service: "outreach-dev" }));
app.listen(PORT, () => console.log(`[outreach-dev] http://localhost:${PORT}`));

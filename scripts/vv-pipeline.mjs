// vv-pipeline.mjs — run the voice-verification post-call pipeline on one session, or sweep every session
// that owes a report. NO SEND. NO CANDIDATE CONTACT. Reads the same env as the server.
//
//   npm run voice:pipeline -- --session <vv_sessions.id>     # one session, from its current stage
//   npm run voice:pipeline -- --sweep                          # every transcript_ready/evidence_ready/evaluated session
//
// Prints the result as JSON. Exit 0 on ok or a no-op, 1 when the session ended blocked or failed,
// 2 on bad arguments. Model spend per session is capped by VOICE_MAX_PIPELINE_COST_USD.
import Anthropic from "@anthropic-ai/sdk";
import { loadEnv } from "../charlie-store.mjs";
import * as store from "../voice/store.mjs";
import { runPipelineForSession, runPipelineSweep } from "../voice/pipeline.mjs";

loadEnv();
const args = process.argv.slice(2);
const flag = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] ?? true : null; };
const sessionId = flag("--session");
const sweep = args.includes("--sweep");
if (!sessionId && !sweep) { console.error("usage: --session <id> | --sweep"); process.exit(2); }
if (!process.env.ANTHROPIC_API_KEY) { console.error("ANTHROPIC_API_KEY is required (.env.local)"); process.exit(2); }

const client = new Anthropic();
const out = sweep
  ? await runPipelineSweep({ store, client, heartbeat: async () => {} })
  : await runPipelineForSession({ store, client, sessionId: String(sessionId) });
console.log(JSON.stringify(out, null, 2));
process.exit(sweep ? (out.failed ? 1 : 0) : out.ok ? 0 : 1);

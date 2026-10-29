// vv-agent.mjs — show or apply the voice-verification ElevenLabs agent's configuration (agent id from
// ELEVENLABS_AGENT_ID), and check the load-bearing parts. NO SEND. NO CANDIDATE.
//
//   npm run voice:agent                          # read the agent back and print the checks
//   npm run voice:agent -- --apply [--budget 600] [--base https://api.example.com]
//
// WHAT IT SETS: the agent is private
// (platform_settings.auth.enable_auth = true, so the browser cannot start a call without the token
// the server mints); the LLM is our custom endpoint (/voice/llm) with VOICE_LLM_BEARER stored as a
// workspace secret and referenced from custom_llm.api_key; the system prompt is the template that
// carries the conversation id (voice/live.mjs AGENT_SYSTEM_PROMPT); the first message is the
// dynamic variable the page passes at start (FIRST_MESSAGE_VAR); max duration is the session budget
// plus two minutes; custom_llm_extra_body is on so what the client sends is at least logged.
//
// WHAT IT DOES NOT SET: the post-call webhook. Webhooks are workspace objects the API exposes
// read-only here; this script prints what is linked and says plainly when nothing is. Set it in the dashboard
// (Agents → Settings → Post-call webhooks): URL <base>/webhooks/elevenlabs, the secret it shows goes
// into ELEVENLABS_WEBHOOK_SECRET, transcript on, audio off.
//
// EXIT CODE. Non-zero when, after reading back, enable_auth is not true, the custom LLM url is not
// ours, or the prompt is not the template.
import { loadEnv } from "../charlie-store.mjs";
import { AGENT_SYSTEM_PROMPT, FIRST_MESSAGE_VAR } from "../voice/live.mjs";

loadEnv();
const flag = (n, d = "") => { const i = process.argv.indexOf(n); return i > -1 ? String(process.argv[i + 1] ?? d) : d; };
const has = (n) => process.argv.includes(n);

const API = "https://api.elevenlabs.io";
const key = String(process.env.ELEVENLABS_API_KEY || "").trim();
const agentId = String(process.env.ELEVENLABS_AGENT_ID || "").trim();
const bearer = String(process.env.VOICE_LLM_BEARER || "").trim();
const base = flag("--base", "https://api.example.com").replace(/\/$/, "");
const budget = Number(flag("--budget", "600"));
if (!key || !agentId) { console.error("ELEVENLABS_API_KEY and ELEVENLABS_AGENT_ID are required (.env.local)"); process.exit(2); }

async function el(path, init = {}) {
  const r = await fetch(`${API}${path}`, { ...init, headers: { "xi-api-key": key, "content-type": "application/json", ...(init.headers || {}) } });
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  if (!r.ok) throw new Error(`${init.method || "GET"} ${path}: ${r.status} ${typeof body === "string" ? body.slice(0, 300) : JSON.stringify(body).slice(0, 300)}`);
  return body;
}

async function secretIdForBearer() {
  const name = "charlie-voice-llm-bearer";
  const list = await el("/v1/convai/secrets");
  const existing = (list?.secrets || []).find((s) => s.name === name);
  if (existing) return existing.secret_id;
  if (!bearer) throw new Error("VOICE_LLM_BEARER is empty and no secret named charlie-voice-llm-bearer exists; set the bearer first");
  const made = await el("/v1/convai/secrets", { method: "POST", body: JSON.stringify({ name, value: bearer }) });
  return made.secret_id;
}

function checks(agent) {
  const a = agent?.conversation_config?.agent || {};
  const p = a.prompt || {};
  const out = [];
  out.push(["private (auth.enable_auth)", agent?.platform_settings?.auth?.enable_auth === true]);
  out.push(["custom LLM", p.llm === "custom-llm"]);
  out.push([`custom LLM url = ${base}/voice/llm`, String(p.custom_llm?.url || "") === `${base}/voice/llm`]);
  out.push(["custom LLM api_key set", Boolean(p.custom_llm?.api_key)]);
  out.push(["system prompt is the template", String(p.prompt || "").trim() === AGENT_SYSTEM_PROMPT]);
  out.push([`first message is {{${FIRST_MESSAGE_VAR}}}`, String(a.first_message || "").trim() === `{{${FIRST_MESSAGE_VAR}}}`]);
  out.push([`max duration ≥ budget + 120 (${budget + 120})`, Number(agent?.conversation_config?.conversation?.max_duration_seconds) >= budget + 120]);
  out.push(["custom_llm_extra_body on", agent?.platform_settings?.overrides?.custom_llm_extra_body === true]);
  const wh = agent?.platform_settings?.workspace_overrides?.webhooks;
  out.push(["post-call webhook linked (set in the dashboard if not)", Boolean(wh?.post_call_webhook_id)]);
  return out;
}

const agent = await el(`/v1/convai/agents/${agentId}`);
if (has("--apply")) {
  const secret_id = await secretIdForBearer();
  const patch = {
    conversation_config: {
      agent: {
        first_message: `{{${FIRST_MESSAGE_VAR}}}`,
        language: "en",
        dynamic_variables: { dynamic_variable_placeholders: { [FIRST_MESSAGE_VAR]: "Hi, I'm Charlie." } },
        prompt: { prompt: AGENT_SYSTEM_PROMPT, llm: "custom-llm", custom_llm: { url: `${base}/voice/llm`, model_id: "charlie", api_key: { secret_id }, api_type: "chat_completions" } },
      },
      conversation: { max_duration_seconds: budget + 120 },
    },
    platform_settings: { auth: { enable_auth: true }, overrides: { custom_llm_extra_body: true } },
  };
  await el(`/v1/convai/agents/${agentId}`, { method: "PATCH", body: JSON.stringify(patch) });
  console.log("applied; reading back");
}
const after = has("--apply") ? await el(`/v1/convai/agents/${agentId}`) : agent;
let bad = 0;
for (const [label, ok] of checks(after)) { console.log(`${ok ? "ok " : "NO "} ${label}`); if (!ok && !/webhook/.test(label)) bad++; }
const conv = after?.conversation_config?.conversation || {}, turn = after?.conversation_config?.turn || {};
console.log(`\nread back: max_duration ${conv.max_duration_seconds}s · turn_timeout ${turn.turn_timeout}s · eagerness ${turn.turn_eagerness} · privacy ${JSON.stringify(after?.platform_settings?.privacy || {})}`);
process.exit(bad ? 1 : 0);

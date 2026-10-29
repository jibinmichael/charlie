// lib/schemas/vv-live.mjs — the shapes on the live path: what the candidate page sends to start a session, what
// ElevenLabs sends to the custom LLM endpoint, and what its post-call webhook carries. Every one of
// these is external data and is safeParse'd in server/voice.ts before anything reads it. Everything
// is permissive where the provider's shape is not pinned down, and strict where a wrong value would move
// state: the consent scopes, the message roles.
import { z } from "zod";
import { SCOPES } from "../../voice/consent.mjs";

/** The candidate page's start request: every consent answer, and the browser as it names itself. */
export const StartInput = z.object({
  consents: z.array(z.object({
    scope: z.enum(SCOPES),
    text_version: z.string().trim().min(1).max(60),
    granted: z.boolean(),
  })).max(SCOPES.length).default([]),
  user_agent: z.string().trim().max(400).nullable().default(null),
});

/** One message of the OpenAI-compatible history the provider sends on every turn. */
const LlmMessage = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.union([z.string(), z.array(z.any()), z.null()]).optional(),
}).passthrough();

/** The custom-LLM request. The provider sends the whole history every turn; `elevenlabs_extra_body` is client-supplied and only logged. */
export const LlmRequest = z.object({
  model: z.string().optional(),
  messages: z.array(LlmMessage).min(1).max(400),
  stream: z.boolean().optional(),
  tools: z.array(z.any()).optional(),
  elevenlabs_extra_body: z.record(z.string(), z.any()).optional(),
}).passthrough();

/** One transcript entry of the post-call webhook. `message` is null for tool-only entries. */
const WebhookTurn = z.object({
  role: z.enum(["agent", "user"]),
  message: z.string().nullable().optional(),
  time_in_call_secs: z.number().nullable().optional(),
}).passthrough();

/**
 * The post-call webhook body. Only `post_call_transcription` is acted on; every other type is
 * acknowledged and stored. The conversation id is the idempotency key.
 */
export const ElevenLabsWebhook = z.object({
  type: z.string(),
  event_timestamp: z.number().optional(),
  data: z.object({
    agent_id: z.string().optional(),
    conversation_id: z.string().min(1),
    status: z.string().optional(),
    transcript: z.array(WebhookTurn).optional(),
    metadata: z.record(z.string(), z.any()).optional(),
    analysis: z.record(z.string(), z.any()).optional(),
    conversation_initiation_client_data: z.record(z.string(), z.any()).optional(),
  }).passthrough(),
}).passthrough();

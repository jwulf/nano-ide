// LLM-as-worker runtime (ADR 0022 §E role 1) — the batteries-included implementation of
// the manifest's `llm` seam. For every `workers[]` entry that carries an `llm` binding
// (instead of a `handler` file), `workers.ts` registers a job worker on that task type
// whose handler is an LLM call — no external connector runtime required.
//
// A worker's contract:
//   { "taskType": "classify", "llm": "classifier" }              // workers[]
//   "llm": { "classifier": { "provider": "env",                  // llm registry
//                            "model": "${NANO_APP_LLM_MODEL}",
//                            "output": { "decision": "risk" } } }
//
// The job's input variables drive the prompt (`prompt` string and/or `messages` array,
// optional `system`); the model's reply becomes the job's output variables. When the
// binding declares `output.decision`, the model's JSON is fed through that DMN decision
// (the rails) and the decision's output is returned instead — the LLM proposes, the
// decision disposes.
//
// Provider is configuration, not code: `provider: "env"` resolves an OpenAI-compatible
// endpoint from the environment, so a fully-local model (Ollama, LM Studio, llama.cpp,
// vLLM, …) or a hosted API both work unchanged. This module is host-agnostic: env and
// fetch are injected (env always via the host seam), never read from a concrete runtime.

import type { LlmBinding } from "../manifest.ts";
import { expandEnvString } from "../manifest.ts";

/** Job variables/headers default to untyped JSON. */
export type LlmVars = Record<string, unknown>;

/** Reads an environment variable (routed through the host seam). */
export type EnvLookup = (name: string) => string | undefined;

/** One chat message on the wire. */
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** A resolved provider endpoint (OpenAI-compatible chat completions). */
export interface ProviderConfig {
  baseUrl: string;
  apiKey?: string;
  model: string;
}

/**
 * Evaluate a DMN decision (the output "rails"), returning its already-parsed output.
 * Injected by the caller so this module stays free of any engine/SDK coupling.
 */
export type DecisionEvaluator = (
  decisionId: string,
  variables: Record<string, unknown>,
) => Promise<unknown>;

/** Everything running one LLM job needs, injected for host-agnosticism + testability. */
export interface LlmRuntime {
  env: EnvLookup;
  /** Fetch implementation. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Decision-rails evaluator; required only when a binding sets `output.decision`. */
  evaluateDecision?: DecisionEvaluator;
}

/**
 * Resolve an OpenAI-compatible endpoint for a binding. `provider: "env"` (the only
 * built-in today) reads:
 *   - NANO_APP_LLM_BASE_URL  (default http://localhost:11434/v1 — Ollama's
 *                             OpenAI-compatible endpoint; override for any host)
 *   - NANO_APP_LLM_API_KEY   (optional; sent as `Authorization: Bearer` if set)
 *   - NANO_APP_LLM_MODEL     (fallback when the binding's `model` resolves empty)
 * The binding's `model` is env-templated (`${VAR}` / `${VAR:-default}`).
 */
export function resolveProvider(binding: LlmBinding, env: EnvLookup): ProviderConfig {
  if (binding.provider !== "env") {
    throw new Error(
      `llm worker: unsupported provider "${binding.provider}" (only "env" is built in — ` +
        `it resolves an OpenAI-compatible endpoint from NANO_APP_LLM_* env)`,
    );
  }
  const baseUrl = (env("NANO_APP_LLM_BASE_URL") ?? "http://localhost:11434/v1").replace(/\/+$/, "");
  const apiKey = env("NANO_APP_LLM_API_KEY") || undefined;
  const model = expandEnvString(binding.model ?? "", env) || env("NANO_APP_LLM_MODEL") || "";
  if (!model) {
    throw new Error(
      `llm worker: no model resolved for binding (model="${binding.model}"); ` +
        `set NANO_APP_LLM_MODEL or a literal model`,
    );
  }
  return { baseUrl, apiKey, model };
}

/**
 * Build the chat messages for a job's variables. Input contract:
 *   - `messages`: a ready `{role,content}[]` (used verbatim), or
 *   - `prompt`:   a user-message string.
 * An optional `system` string is prepended.
 */
export function buildMessages(vars: LlmVars): ChatMessage[] {
  const system = typeof vars.system === "string" ? vars.system : undefined;

  let msgs: ChatMessage[];
  if (Array.isArray(vars.messages)) {
    if (vars.messages.length === 0) {
      throw new Error("llm worker: 'messages' must not be an empty array");
    }
    msgs = (vars.messages as unknown[]).map((m, i) => {
      const o = m as { role?: unknown; content?: unknown };
      if (
        typeof o.content !== "string" ||
        (o.role !== "user" && o.role !== "assistant" && o.role !== "system")
      ) {
        throw new Error(
          `llm worker: messages[${i}] must be { role: user|assistant|system, content: string }`,
        );
      }
      return { role: o.role, content: o.content };
    });
  } else if (typeof vars.prompt === "string") {
    msgs = [{ role: "user", content: vars.prompt }];
  } else {
    throw new Error(
      "llm worker: job needs a 'prompt' string or a 'messages' array in its variables",
    );
  }

  return system ? [{ role: "system", content: system }, ...msgs] : msgs;
}

/**
 * Call the model's chat-completions endpoint. When `json` is set, requests a JSON object
 * response (`response_format`) so structured output can be parsed. Returns the assistant
 * message text.
 */
export async function callLlm(
  provider: ProviderConfig,
  messages: ChatMessage[],
  opts: { json?: boolean; fetch?: typeof fetch } = {},
): Promise<string> {
  const doFetch = opts.fetch ?? fetch;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (provider.apiKey) headers.authorization = `Bearer ${provider.apiKey}`;
  const body: Record<string, unknown> = { model: provider.model, messages };
  if (opts.json) body.response_format = { type: "json_object" };

  const res = await doFetch(`${provider.baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`llm provider returned ${res.status}: ${detail.slice(0, 500)}`);
  }
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    throw new Error("llm provider returned no message content");
  }
  return content;
}

/**
 * Run one job through the LLM (and optional decision rails). Returns the output variables
 * the job is completed with.
 *
 * - No `output` binding → returns `{ text }` (the raw completion).
 * - `output` set → requests JSON, parses it; the parsed object is the output.
 * - `output.decision` set → the parsed JSON is fed to that DMN decision and the decision's
 *   output is returned (object as-is, scalar wrapped as `{ result }`).
 */
export async function runLlmJob(
  vars: LlmVars,
  binding: LlmBinding,
  rt: LlmRuntime,
): Promise<Record<string, unknown>> {
  const wantJson = !!binding.output;
  const provider = resolveProvider(binding, rt.env);
  const messages = buildMessages(vars);
  const text = await callLlm(provider, messages, { json: wantJson, fetch: rt.fetch });

  if (!wantJson) return { text };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`llm worker: expected JSON output but got: ${text.slice(0, 300)}`);
  }
  // response_format asks for a JSON object, but a provider can still return a scalar, array,
  // or null — none of which is a valid variable map (nor valid decision-rails input).
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`llm worker: expected a JSON object output but got: ${text.slice(0, 300)}`);
  }
  const obj = parsed as Record<string, unknown>;

  const decisionId = binding.output?.decision;
  if (decisionId) {
    if (!rt.evaluateDecision) {
      throw new Error(
        `llm worker: binding declares output.decision "${decisionId}" but no decision ` +
          `evaluator is available (the engine SDK surface is required for decision rails)`,
      );
    }
    const out = await rt.evaluateDecision(decisionId, obj);
    return out !== null && typeof out === "object" && !Array.isArray(out)
      ? (out as Record<string, unknown>)
      : { result: out };
  }
  return obj;
}

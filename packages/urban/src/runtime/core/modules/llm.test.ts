import { test } from "node:test";
import assert from "node:assert/strict";
import type { LlmBinding } from "../manifest.ts";
import {
  buildMessages,
  callLlm,
  type ChatMessage,
  type EnvLookup,
  resolveProvider,
  runLlmJob,
} from "./llm.ts";

const noEnv: EnvLookup = () => undefined;
const envOf =
  (m: Record<string, string>): EnvLookup =>
  (k) =>
    m[k];

/** A minimal fetch double returning a fixed chat-completion. */
function fakeFetch(
  content: string,
  opts: { ok?: boolean; status?: number; capture?: (url: string, init: RequestInit) => void } = {},
): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    opts.capture?.(String(url), init);
    return {
      ok: opts.ok ?? true,
      status: opts.status ?? 200,
      json: async () => ({ choices: [{ message: { content } }] }),
      text: async () => content,
    };
  }) as unknown as typeof fetch;
}

// --- resolveProvider -------------------------------------------------------

test("resolveProvider defaults to the local Ollama endpoint and env-templates the model", () => {
  const binding: LlmBinding = { provider: "env", model: "${NANO_APP_LLM_MODEL}" };
  const p = resolveProvider(binding, envOf({ NANO_APP_LLM_MODEL: "llama3" }));
  assert.equal(p.baseUrl, "http://localhost:11434/v1");
  assert.equal(p.model, "llama3");
  assert.equal(p.apiKey, undefined);
});

test("resolveProvider honours NANO_APP_LLM_BASE_URL (trailing slash trimmed) + api key", () => {
  const p = resolveProvider(
    { provider: "env", model: "gpt-4o-mini" },
    envOf({ NANO_APP_LLM_BASE_URL: "https://api.example.com/v1/", NANO_APP_LLM_API_KEY: "sk-x" }),
  );
  assert.equal(p.baseUrl, "https://api.example.com/v1");
  assert.equal(p.model, "gpt-4o-mini");
  assert.equal(p.apiKey, "sk-x");
});

test("resolveProvider falls back to NANO_APP_LLM_MODEL when the binding model is empty", () => {
  const p = resolveProvider({ provider: "env", model: "" }, envOf({ NANO_APP_LLM_MODEL: "phi3" }));
  assert.equal(p.model, "phi3");
});

test("resolveProvider throws when no model resolves", () => {
  assert.throws(() => resolveProvider({ provider: "env", model: "" }, noEnv), /no model resolved/);
});

test("resolveProvider throws on an unsupported provider", () => {
  assert.throws(
    () => resolveProvider({ provider: "openai", model: "gpt" }, noEnv),
    /unsupported provider "openai"/,
  );
});

// --- buildMessages ---------------------------------------------------------

test("buildMessages wraps a prompt string as a single user message", () => {
  assert.deepEqual(buildMessages({ prompt: "hi" }), [{ role: "user", content: "hi" }]);
});

test("buildMessages prepends an optional system message", () => {
  assert.deepEqual(buildMessages({ prompt: "hi", system: "be terse" }), [
    { role: "system", content: "be terse" },
    { role: "user", content: "hi" },
  ]);
});

test("buildMessages uses a messages array verbatim", () => {
  const messages: ChatMessage[] = [
    { role: "user", content: "a" },
    { role: "assistant", content: "b" },
  ];
  assert.deepEqual(buildMessages({ messages }), messages);
});

test("buildMessages rejects a malformed messages entry", () => {
  assert.throws(() => buildMessages({ messages: [{ role: "user" }] }), /messages\[0\]/);
  assert.throws(() => buildMessages({ messages: [{ role: "bogus", content: "x" }] }), /messages\[0\]/);
});

test("buildMessages requires a prompt or messages", () => {
  assert.throws(() => buildMessages({}), /needs a 'prompt' string or a 'messages' array/);
});

test("buildMessages rejects an empty messages array", () => {
  assert.throws(() => buildMessages({ messages: [] }), /must not be an empty array/);
});

// --- callLlm ---------------------------------------------------------------

test("callLlm posts to /chat/completions and returns the message content", async () => {
  let seen: { url: string; init: RequestInit } | undefined;
  const f = fakeFetch("hello world", { capture: (url, init) => (seen = { url, init }) });
  const out = await callLlm({ baseUrl: "http://h/v1", model: "m", apiKey: "k" }, [
    { role: "user", content: "hi" },
  ], { fetch: f });
  assert.equal(out, "hello world");
  assert.equal(seen?.url, "http://h/v1/chat/completions");
  assert.equal(seen?.init.method, "POST");
  const headers = seen?.init.headers as Record<string, string>;
  assert.equal(headers.authorization, "Bearer k");
  const body = JSON.parse(String(seen?.init.body));
  assert.equal(body.model, "m");
  assert.equal(body.response_format, undefined);
});

test("callLlm requests a JSON object response when json:true", async () => {
  let body: Record<string, unknown> = {};
  const f = fakeFetch("{}", { capture: (_u, init) => (body = JSON.parse(String(init.body))) });
  await callLlm({ baseUrl: "http://h/v1", model: "m" }, [{ role: "user", content: "hi" }], {
    json: true,
    fetch: f,
  });
  assert.deepEqual(body.response_format, { type: "json_object" });
});

test("callLlm throws on a non-ok provider response", async () => {
  const f = fakeFetch("boom", { ok: false, status: 500 });
  await assert.rejects(
    callLlm({ baseUrl: "http://h/v1", model: "m" }, [{ role: "user", content: "hi" }], { fetch: f }),
    /llm provider returned 500/,
  );
});

test("callLlm throws when the provider returns no content", async () => {
  const f = (async () => ({ ok: true, status: 200, json: async () => ({ choices: [] }) })) as unknown as typeof fetch;
  await assert.rejects(
    callLlm({ baseUrl: "http://h/v1", model: "m" }, [{ role: "user", content: "hi" }], { fetch: f }),
    /no message content/,
  );
});

// --- runLlmJob -------------------------------------------------------------

const model = envOf({ NANO_APP_LLM_MODEL: "m" });

test("runLlmJob returns raw text when the binding has no output schema", async () => {
  const out = await runLlmJob({ prompt: "hi" }, { provider: "env", model: "" }, {
    env: model,
    fetch: fakeFetch("plain answer"),
  });
  assert.deepEqual(out, { text: "plain answer" });
});

test("runLlmJob parses JSON output when the binding sets output", async () => {
  const out = await runLlmJob(
    { prompt: "classify" },
    { provider: "env", model: "", output: {} },
    { env: model, fetch: fakeFetch('{"decision":"risk","score":0.9}') },
  );
  assert.deepEqual(out, { decision: "risk", score: 0.9 });
});

test("runLlmJob throws when JSON output is expected but not returned", async () => {
  await assert.rejects(
    runLlmJob({ prompt: "x" }, { provider: "env", model: "", output: {} }, {
      env: model,
      fetch: fakeFetch("not json"),
    }),
    /expected JSON output/,
  );
});

test("runLlmJob rejects a non-object JSON output (scalar/array/null)", async () => {
  for (const bad of ["42", "[1,2]", "null", '"just a string"']) {
    await assert.rejects(
      runLlmJob({ prompt: "x" }, { provider: "env", model: "", output: {} }, {
        env: model,
        fetch: fakeFetch(bad),
      }),
      /expected a JSON object output/,
      `should reject ${bad}`,
    );
  }
});

test("runLlmJob feeds parsed JSON through the decision rails and returns its output", async () => {
  const calls: Array<{ id: string; vars: Record<string, unknown> }> = [];
  const out = await runLlmJob(
    { prompt: "x" },
    { provider: "env", model: "", output: { decision: "risk" } },
    {
      env: model,
      fetch: fakeFetch('{"amount":100}'),
      evaluateDecision: async (id, vars) => {
        calls.push({ id, vars });
        return { approved: true };
      },
    },
  );
  assert.deepEqual(out, { approved: true });
  assert.deepEqual(calls, [{ id: "risk", vars: { amount: 100 } }]);
});

test("runLlmJob wraps a scalar decision output as { result }", async () => {
  const out = await runLlmJob(
    { prompt: "x" },
    { provider: "env", model: "", output: { decision: "risk" } },
    { env: model, fetch: fakeFetch("{}"), evaluateDecision: async () => "APPROVE" },
  );
  assert.deepEqual(out, { result: "APPROVE" });
});

test("runLlmJob wraps an array decision output as { result } (not a var map)", async () => {
  const out = await runLlmJob(
    { prompt: "x" },
    { provider: "env", model: "", output: { decision: "risk" } },
    { env: model, fetch: fakeFetch("{}"), evaluateDecision: async () => [1, 2] },
  );
  assert.deepEqual(out, { result: [1, 2] });
});

test("runLlmJob throws when decision rails are declared but no evaluator is available", async () => {
  await assert.rejects(
    runLlmJob({ prompt: "x" }, { provider: "env", model: "", output: { decision: "risk" } }, {
      env: model,
      fetch: fakeFetch("{}"),
    }),
    /no decision evaluator is available/,
  );
});

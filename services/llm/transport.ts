import { getConfig } from "../config";
import { getLlamaServerEndpoint } from "../llama-server";
import { adaptPrompt, type PromptIntent, type ChatMessage } from "../prompt-adapter";

export const getLlmEndpoint = () => {
  const ep = getLlamaServerEndpoint();
  if (!ep) throw new Error("Local LLM server is not ready yet");
  return ep;
};

export const getLlmTextModel = (): string => {
  return getConfig().embeddedModel;
};

export const callLLM = async (
  model: string,
  messages: ChatMessage[],
  jsonSchema?: Record<string, unknown>,
  intent?: PromptIntent,
  signal?: AbortSignal,
): Promise<string> => {
  const adapted = adaptPrompt(model, intent, messages, jsonSchema);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  const body: Record<string, unknown> = {
    model,
    messages: adapted.messages,
    temperature: 0,
    ...adapted.bodyOverrides,
  };

  if (adapted.schema) {
    body.response_format = {
      type: "json_schema",
      json_schema: { name: "response", strict: true, schema: adapted.schema },
    };
  }

  const endpoint = getLlmEndpoint();
  console.log(`[llm] POST ${endpoint}/chat/completions model=${model} intent=${intent}`);

  const response = await fetch(`${endpoint}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    // User cancellation (Discard / view abort) + the existing 120s safety
    // timeout. AbortSignal.any (Node 20.3+) settles on whichever fires
    // first; either aborts the in-flight LLM call so the llama slot frees.
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(120_000)])
      : AbortSignal.timeout(120_000),
  });

  if (!response.ok) {
    const text = await response.text();
    console.error(`[llm] Request failed (${response.status}):`, text.slice(0, 500));
    throw new Error(`LLM request failed (${response.status}): ${text}`);
  }

  const data = await response.json();
  if (!data.choices?.length || !data.choices[0].message?.content) {
    console.error("[llm] Empty or malformed response:", JSON.stringify(data).slice(0, 500));
    throw new Error("LLM returned empty or malformed response");
  }
  return data.choices[0].message.content;
};

export async function* callLLMStream(
  model: string,
  messages: ChatMessage[],
  jsonSchema?: Record<string, unknown>,
  intent?: PromptIntent,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const adapted = adaptPrompt(model, intent, messages, jsonSchema);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  const body: Record<string, unknown> = {
    model,
    messages: adapted.messages,
    temperature: 0,
    stream: true,
    ...adapted.bodyOverrides,
  };

  if (adapted.schema) {
    body.response_format = {
      type: "json_schema",
      json_schema: { name: "response", strict: true, schema: adapted.schema },
    };
  }

  const endpoint = getLlmEndpoint();
  console.log(`[llm-stream] POST ${endpoint}/chat/completions model=${model} intent=${intent}`);

  const response = await fetch(`${endpoint}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    // See callLLM: user cancellation + 120s safety timeout, whichever first.
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(120_000)])
      : AbortSignal.timeout(120_000),
  });

  if (!response.ok) {
    const text = await response.text();
    console.error(`[llm-stream] Request failed (${response.status}):`, text.slice(0, 500));
    throw new Error(`LLM stream request failed (${response.status}): ${text}`);
  }

  if (!response.body) {
    throw new Error("LLM stream response has no body");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let leftover = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      leftover += decoder.decode(value, { stream: true });

      // Split on double-newline SSE boundaries, but also handle single-newline data lines
      const lines = leftover.split("\n");
      // Keep the last partial line for the next iteration
      leftover = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(":")) continue;
        if (trimmed === "data: [DONE]") return;
        if (!trimmed.startsWith("data: ")) continue;

        const json = trimmed.slice(6);
        try {
          const chunk = JSON.parse(json);
          const delta = chunk.choices?.[0]?.delta?.content;
          if (typeof delta === "string" && delta.length > 0) {
            yield delta;
          }
        } catch {
          // Malformed chunk, skip
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

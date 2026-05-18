import { describe, it, expect } from "vitest";
import {
  adaptPrompt,
  mergeSystemIntoUser,
  injectFewShotExample,
  appendToUserMessage,

  type ChatMessage,
} from "./prompt-adapter";

// ============================================================
// Helper tests
// ============================================================

describe("mergeSystemIntoUser", () => {
  it("prepends system content to first user message", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Hello" },
    ];
    const result = mergeSystemIntoUser(messages);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("user");
    expect(result[0].content).toBe("You are helpful.\n\nHello");
  });

  it("handles multiple system messages", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "Rule 1." },
      { role: "system", content: "Rule 2." },
      { role: "user", content: "Go" },
    ];
    const result = mergeSystemIntoUser(messages);
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("Rule 1.\n\nRule 2.\n\nGo");
  });

  it("returns copy when no system messages", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "Hello" },
    ];
    const result = mergeSystemIntoUser(messages);
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("Hello");
    // Should be a new array
    expect(result).not.toBe(messages);
  });

  it("creates user message from system when no user exists", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "Instructions" },
    ];
    const result = mergeSystemIntoUser(messages);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("user");
    expect(result[0].content).toBe("Instructions");
  });

  it("preserves assistant messages", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "Be terse." },
      { role: "assistant", content: "OK" },
      { role: "user", content: "Question" },
    ];
    const result = mergeSystemIntoUser(messages);
    expect(result).toHaveLength(2);
    expect(result[0].role).toBe("assistant");
    expect(result[1].role).toBe("user");
    expect(result[1].content).toBe("Be terse.\n\nQuestion");
  });
});

describe("injectFewShotExample", () => {
  it("inserts user/assistant pair before last user message", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "Real question" },
    ];
    const result = injectFewShotExample(messages, {
      user: "Example input",
      assistant: "Example output",
    });
    expect(result).toHaveLength(3);
    expect(result[0].role).toBe("user");
    expect(result[0].content).toBe("Example input");
    expect(result[1].role).toBe("assistant");
    expect(result[1].content).toBe("Example output");
    expect(result[2].role).toBe("user");
    expect(result[2].content).toBe("Real question");
  });

  it("preserves system message before few-shot", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "Instructions" },
      { role: "user", content: "Real question" },
    ];
    const result = injectFewShotExample(messages, {
      user: "Ex",
      assistant: "Resp",
    });
    expect(result).toHaveLength(4);
    expect(result[0].role).toBe("system");
    expect(result[1].role).toBe("user");
    expect(result[1].content).toBe("Ex");
    expect(result[2].role).toBe("assistant");
    expect(result[3].role).toBe("user");
    expect(result[3].content).toBe("Real question");
  });

  it("does nothing with no user messages", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "Instructions" },
    ];
    const result = injectFewShotExample(messages, {
      user: "Ex",
      assistant: "Resp",
    });
    expect(result).toHaveLength(1);
  });
});

describe("appendToUserMessage", () => {
  it("appends text to the last user message", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "Sys" },
      { role: "user", content: "Hello" },
    ];
    const result = appendToUserMessage(messages, "Extra.");
    expect(result[1].content).toBe("Hello\n\nExtra.");
  });

  it("skips non-string content user messages", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "First" },
      {
        role: "user",
        content: [{ type: "text", text: "Image msg" }],
      },
    ];
    // Should append to "First" since the last user has array content
    const result = appendToUserMessage(messages, "Added.");
    expect(result[0].content).toBe("First\n\nAdded.");
    // Array content unchanged
    expect(Array.isArray(result[1].content)).toBe(true);
  });

  it("does not mutate original array", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "Original" },
    ];
    const result = appendToUserMessage(messages, "More");
    expect(messages[0].content).toBe("Original");
    expect(result[0].content).toBe("Original\n\nMore");
  });
});

// ============================================================
// Adapter integration tests
// ============================================================

const sampleMessages: ChatMessage[] = [
  { role: "system", content: "You are a receipt analyzer." },
  { role: "user", content: "Analyze this receipt." },
];

const sampleSchema = {
  type: "object",
  properties: { merchant: { type: "string" } },
  required: ["merchant"],
};

// llama3.1 (the bundled model) and unknown models both append a JSON
// reminder to the last user message. They are NOT passthroughs anymore —
// the adapter layer was tightened to enforce JSON output across the
// board after observing format drift in production. Tests verify the
// invariant that matters: schema is preserved, system stays put, the
// JSON reminder is appended to the last user.
describe("adaptPrompt — JSON-reminder adapters (llama3.1, default)", () => {
  it("appends JSON reminder for llama3.1:8b without otherwise mutating messages", () => {
    const result = adaptPrompt(
      "llama3.1:8b",
      "category-assignment",
      sampleMessages,
      sampleSchema,
    );
    expect(result.schema).toEqual(sampleSchema);
    expect(result.bodyOverrides).toBeUndefined();
    // System message preserved.
    const sys = result.messages.find((m) => m.role === "system");
    expect(sys?.content).toBe("You are a receipt analyzer.");
    // Last user message has JSON reminder appended.
    const lastUser = [...result.messages].reverse().find((m) => m.role === "user");
    expect(lastUser?.content).toContain("Respond with valid JSON only");
  });

  // #91-2: the bundled llama3.1 dropped Walmart's oddly-labeled
  // expedite-delivery fee ("3 hours or less") and tax from
  // summaryLabels. It must receive the online-order few-shot that
  // teaches that pattern (previously wired only to llama3.2:3b).
  it("injects the online-order expedite-fee few-shot for llama3.1 label-extraction", () => {
    const result = adaptPrompt(
      "llama3.1:8b",
      "label-extraction",
      [{ role: "user", content: "Analyze this receipt." }],
      sampleSchema,
    );
    const allText = result.messages.map((m) => String(m.content)).join("\n");
    expect(allText).toContain("3 hours or less");
    // And it must classify that line as a fee in the few-shot answer.
    expect(allText).toMatch(/"label"\s*:\s*"3 hours or less"\s*,\s*"type"\s*:\s*"fee"/);
  });

  it("appends JSON reminder for unknown models (default fallthrough)", () => {
    const result = adaptPrompt(
      "mistral:7b",
      "category-assignment",
      sampleMessages,
      sampleSchema,
    );
    expect(result.schema).toEqual(sampleSchema);
    const lastUser = [...result.messages].reverse().find((m) => m.role === "user");
    expect(lastUser?.content).toContain("Respond with valid JSON only");
  });
});

describe("adaptPrompt — gemma3", () => {
  it("merges system into user for gemma3:4b", () => {
    const result = adaptPrompt(
      "gemma3:4b",
      "category-assignment",
      sampleMessages,
      sampleSchema,
    );
    // No system messages should remain
    expect(result.messages.every((m) => m.role !== "system")).toBe(true);
    // User message should contain system content
    const userMsg = result.messages.find((m) => m.role === "user");
    expect(userMsg?.content).toContain("receipt analyzer");
    expect(userMsg?.content).toContain("Analyze this receipt");
  });

  it("injects few-shot for label-extraction", () => {
    const result = adaptPrompt(
      "gemma3:4b",
      "label-extraction",
      sampleMessages,
      sampleSchema,
    );
    // Should have few-shot user + assistant + real user = 3 messages
    expect(result.messages.length).toBe(3);
    expect(result.messages[0].role).toBe("user");
    expect(result.messages[1].role).toBe("assistant");
    expect(result.messages[2].role).toBe("user");
    // Few-shot should contain example receipt
    expect(result.messages[0].content).toContain("ACME GROCERY");
    // Assistant should be valid JSON
    const parsed = JSON.parse(result.messages[1].content as string);
    expect(parsed.merchant).toBe("ACME GROCERY");
  });

  it("does NOT inject few-shot for category-assignment", () => {
    const result = adaptPrompt(
      "gemma3:4b",
      "category-assignment",
      sampleMessages,
    );
    // Should just have merged user message, no few-shot
    expect(result.messages.length).toBe(1);
    expect(result.messages[0].role).toBe("user");
  });

  it("matches gemma-3 prefix too", () => {
    const result = adaptPrompt(
      "gemma-3-4b",
      "label-extraction",
      sampleMessages,
    );
    expect(result.messages.every((m) => m.role !== "system")).toBe(true);
  });

  it("preserves schema", () => {
    const result = adaptPrompt(
      "gemma3:4b",
      "label-extraction",
      sampleMessages,
      sampleSchema,
    );
    expect(result.schema).toEqual(sampleSchema);
  });
});

describe("adaptPrompt — llama3.2:3b", () => {
  // The "terse system replacement" was a design that never landed in the
  // current adapter — it preserves the original system message and just
  // injects few-shots + a JSON reminder. Tests now verify the actual
  // behavior: system unchanged, few-shots injected, JSON reminder on the
  // LAST user message (not the first; few-shots add user/assistant pairs
  // before the real user).
  it("preserves the original system message for label-extraction", () => {
    const result = adaptPrompt(
      "llama3.2:3b",
      "label-extraction",
      sampleMessages,
      sampleSchema,
    );
    const sys = result.messages.find((m) => m.role === "system");
    expect(sys?.content).toBe("You are a receipt analyzer.");
  });

  it("preserves the original system message for category-assignment", () => {
    const result = adaptPrompt(
      "llama3.2:3b",
      "category-assignment",
      sampleMessages,
    );
    const sys = result.messages.find((m) => m.role === "system");
    expect(sys?.content).toBe("You are a receipt analyzer.");
  });

  it("appends JSON reminder to the last user message", () => {
    const result = adaptPrompt(
      "llama3.2:3b",
      "label-extraction",
      sampleMessages,
    );
    const lastUser = [...result.messages].reverse().find((m) => m.role === "user");
    expect(lastUser?.content).toContain("Respond with valid JSON only");
  });

  it("does not match llama3.2:1b", () => {
    const result = adaptPrompt(
      "llama3.2:1b",
      "label-extraction",
      sampleMessages,
    );
    // Should fall through to default — system unchanged
    const sys = result.messages.find((m) => m.role === "system");
    expect(sys?.content).toBe("You are a receipt analyzer.");
  });
});

describe("adaptPrompt — nuextract", () => {
  it("converts to template format for label-extraction", () => {
    const result = adaptPrompt(
      "nuextract:3.5b",
      "label-extraction",
      sampleMessages,
      sampleSchema,
    );
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe("user");
    const content = result.messages[0].content as string;
    expect(content).toContain("<|input|>");
    expect(content).toContain("<|output|>");
    expect(content).toContain("Analyze this receipt");
    // Schema should be removed (nuextract fills template)
    expect(result.schema).toBeUndefined();
  });

  it("includes template from schema", () => {
    const result = adaptPrompt(
      "nuextract:3.5b",
      "label-extraction",
      sampleMessages,
      sampleSchema,
    );
    const content = result.messages[0].content as string;
    // Template should contain the schema keys with empty values
    expect(content).toContain('"merchant"');
  });


  it("works for category-assignment", () => {
    const result = adaptPrompt(
      "NuExtract-large",
      "category-assignment",
      sampleMessages,
      sampleSchema,
    );
    expect(result.messages).toHaveLength(1);
    expect((result.messages[0].content as string)).toContain("<|input|>");
  });

  it("handles missing schema gracefully", () => {
    const result = adaptPrompt(
      "nuextract:3.5b",
      "label-extraction",
      sampleMessages,
    );
    expect(result.messages).toHaveLength(1);
    const content = result.messages[0].content as string;
    expect(content).toContain("<|output|>\n{}");
  });

  it("builds nested templates from complex schemas", () => {
    const complexSchema = {
      type: "object",
      properties: {
        merchant: { type: "string" },
        totalAmount: { type: "number" },
        lineItems: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              price: { type: "number" },
            },
          },
        },
      },
    };
    const result = adaptPrompt(
      "nuextract:3.5b",
      "label-extraction",
      sampleMessages,
      complexSchema,
    );
    const content = result.messages[0].content as string;
    // Should have empty string for merchant, 0 for number, array with template object
    expect(content).toContain('"merchant": ""');
    expect(content).toContain('"totalAmount": 0');
    expect(content).toContain('"name": ""');
    expect(content).toContain('"price": 0');
  });
});

describe("adaptPrompt — no intent", () => {
  it("llama3.1 adapter still appends JSON reminder when intent is undefined", () => {
    const result = adaptPrompt(
      "llama3.1:8b",
      undefined,
      sampleMessages,
      sampleSchema,
    );
    expect(result.schema).toEqual(sampleSchema);
    const lastUser = [...result.messages].reverse().find((m) => m.role === "user");
    expect(lastUser?.content).toContain("Respond with valid JSON only");
  });

  it("gemma3 still merges system with undefined intent", () => {
    const result = adaptPrompt(
      "gemma3:4b",
      undefined,
      sampleMessages,
    );
    expect(result.messages.every((m) => m.role !== "system")).toBe(true);
  });
});

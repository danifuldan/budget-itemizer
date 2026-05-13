// ============================================================
// Prompt Adapter Layer — per-model prompt optimization
// ============================================================
//
// Intercepts messages inside callLLM() before they hit Ollama.
// Model detection by name prefix. First match wins, default passthrough.

export type PromptIntent =
  | "label-extraction"
  | "category-assignment";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content:
    | string
    | Array<{ type: string; text?: string; image_url?: { url: string } }>;
}

export interface AdaptedPrompt {
  messages: ChatMessage[];
  schema?: Record<string, unknown>;
  bodyOverrides?: Record<string, unknown>;
}

interface Adapter {
  match: (model: string) => boolean;
  adapt: (
    intent: PromptIntent | undefined,
    messages: ChatMessage[],
    schema?: Record<string, unknown>,
  ) => AdaptedPrompt;
}

// ============================================================
// Helpers (reusable across adapters)
// ============================================================

/** Move system message content into the first user message. */
export const mergeSystemIntoUser = (messages: ChatMessage[]): ChatMessage[] => {
  const systemMsgs = messages.filter((m) => m.role === "system");
  const rest = messages.filter((m) => m.role !== "system");

  if (systemMsgs.length === 0) return [...messages];

  const systemText = systemMsgs
    .map((m) => (typeof m.content === "string" ? m.content : ""))
    .join("\n\n");

  const firstUserIdx = rest.findIndex((m) => m.role === "user");
  if (firstUserIdx === -1) {
    // No user message — just convert system to user
    return [{ role: "user", content: systemText }, ...rest];
  }

  const firstUser = rest[firstUserIdx];
  const userContent =
    typeof firstUser.content === "string"
      ? firstUser.content
      : firstUser.content
          .filter((c) => c.type === "text")
          .map((c) => c.text)
          .join("\n");

  const merged = [...rest];
  merged[firstUserIdx] = {
    role: "user",
    content: `${systemText}\n\n${userContent}`,
  };
  return merged;
};

/** Insert a user/assistant few-shot pair before the last user message. */
export const injectFewShotExample = (
  messages: ChatMessage[],
  example: { user: string; assistant: string },
): ChatMessage[] => {
  const result = [...messages];
  // Find last user message
  let lastUserIdx = -1;
  for (let i = result.length - 1; i >= 0; i--) {
    if (result[i].role === "user") {
      lastUserIdx = i;
      break;
    }
  }
  if (lastUserIdx === -1) return result;

  result.splice(
    lastUserIdx,
    0,
    { role: "user", content: example.user },
    { role: "assistant", content: example.assistant },
  );
  return result;
};

/** Append text to the last user message (string content only). */
export const appendToUserMessage = (
  messages: ChatMessage[],
  text: string,
): ChatMessage[] => {
  const result = [...messages];
  for (let i = result.length - 1; i >= 0; i--) {
    if (result[i].role === "user" && typeof result[i].content === "string") {
      result[i] = {
        ...result[i],
        content: `${result[i].content}\n\n${text}`,
      };
      break;
    }
  }
  return result;
};

// ============================================================
// Few-shot example for label extraction (shared across adapters)
// ============================================================

const labelFewShotExample = {
  user: `Analyze this receipt and identify all labels and structure.

Receipt content:
ACME GROCERY
123 Main St
Date: 03/15/2025

Organic Bananas     $1.29
Whole Milk 1gal     $4.59
Sourdough Bread     $5.49

Subtotal            $11.37
Tax                 $0.91
Total               $12.28`,
  assistant: JSON.stringify({
    merchant: "ACME GROCERY",
    dateLabel: "03/15/2025",
    totalLabel: "Total",
    summaryLabels: [
      { label: "Subtotal", type: "subtotal" },
      { label: "Tax", type: "tax" },
    ],
    lineItems: [
      { productName: "Organic Bananas", quantity: 1, lineText: "Organic Bananas" },
      { productName: "Whole Milk 1gal", quantity: 1, lineText: "Whole Milk 1gal" },
      { productName: "Sourdough Bread", quantity: 1, lineText: "Sourdough Bread" },
    ],
  }),
};

// ============================================================
// Few-shot with messy/truncated receipt text (phi4-mini)
// Teaches: lineText != productName when receipt text is abbreviated
// ============================================================

const messyFewShotExample = {
  user: `Analyze this receipt and identify all labels and structure.

Receipt content:
WALMART SUPERCENTER
Purchase 01/22/2025

GV ORG WHL MLK G     $4.58
DEGREE MEN ULTRAC    $6.97
PROGRSO CHKN SOU     $2.78

SUBTL                $14.33
TAX                  $1.15
TOTAL                $15.48`,
  assistant: JSON.stringify({
    merchant: "WALMART SUPERCENTER",
    dateLabel: "01/22/2025",
    totalLabel: "TOTAL",
    summaryLabels: [
      { label: "SUBTL", type: "subtotal" },
      { label: "TAX", type: "tax" },
    ],
    lineItems: [
      { productName: "Great Value Organic Whole Milk", quantity: 1, lineText: "GV ORG WHL MLK G" },
      { productName: "Degree Men Ultraclean", quantity: 1, lineText: "DEGREE MEN ULTRAC" },
      { productName: "Progresso Chicken Soup", quantity: 1, lineText: "PROGRSO CHKN SOU" },
    ],
  }),
};

// ============================================================
// Few-shot for warehouse-style receipts (Costco, Sam's Club)
// Teaches: bare prices without $, item codes to ignore, tax codes (Y/3)
// ============================================================

const warehouseFewShotExample = {
  user: `Analyze this receipt and identify all labels and structure.

Receipt content:
SAMS CLUB #4856
03/10/2025

E   9912450   MM BATT 48PK   18.99 3
E   3304781   KS TRASH BG 200CT   15.49 3
55208   MCRFBR TOWEL 6PK   24.99 Y

SUBTOTAL   59.47
TAX   3.02
****   TOTAL   62.49`,
  assistant: JSON.stringify({
    merchant: "SAMS CLUB",
    dateLabel: "03/10/2025",
    totalLabel: "TOTAL",
    summaryLabels: [
      { label: "SUBTOTAL", type: "subtotal" },
      { label: "TAX", type: "tax" },
    ],
    lineItems: [
      { productName: "Member's Mark Batteries 48 Pack", quantity: 1, lineText: "MM BATT 48PK" },
      { productName: "Kirkland Trash Bags 200 Count", quantity: 1, lineText: "KS TRASH BG 200CT" },
      { productName: "Microfiber Towels 6 Pack", quantity: 1, lineText: "MCRFBR TOWEL 6PK" },
    ],
  }),
};

// ============================================================
// Few-shot for online orders with payment/delivery info (llama3.2:3b)
// Teaches: payment method lines and delivery info are NOT summary labels
// ============================================================

const onlineOrderFewShotExample = {
  user: `Analyze this receipt and identify all labels and structure.

Receipt content:
Walmart.com
Order placed March 8, 2026

Organic Bananas     $1.29
Whole Milk 1gal     $4.59
Sourdough Bread     $5.49

Subtotal            $11.37
Savings             -$0.50
Tax                 $0.00
Below order minimum $6.99
Driver tip          Free
Delivery            Free

Total               $17.86

Charge history
Mar 8, 2026         $17.86
Payment method
VISA ending in 1234 $17.86
Your payment method
VISA ending in 1234`,
  assistant: JSON.stringify({
    merchant: "Walmart.com",
    dateLabel: "March 8, 2026",
    totalLabel: "Total",
    summaryLabels: [
      { label: "Subtotal", type: "subtotal" },
      { label: "Savings", type: "discount" },
      { label: "Tax", type: "tax" },
      { label: "Below order minimum", type: "fee" },
      { label: "Driver tip", type: "fee" },
      { label: "Delivery", type: "shipping" },
    ],
    lineItems: [
      { productName: "Organic Bananas", quantity: 1, lineText: "Organic Bananas" },
      { productName: "Whole Milk 1gal", quantity: 1, lineText: "Whole Milk 1gal" },
      { productName: "Sourdough Bread", quantity: 1, lineText: "Sourdough Bread" },
    ],
  }),
};

// ============================================================
// Reinforcement suffix — appended to small-model user messages
// ============================================================

const lineTextReminder = `CRITICAL RULES:
- lineText MUST be 3-8 words copied EXACTLY from the receipt line — enough to uniquely locate that item
- Do NOT truncate lineText to 1-2 words. Do NOT include dollar amounts in lineText.
- totalLabel is ONLY the label text (e.g. "Total"), NOT the dollar amount.
- summaryLabels labels are text only — no dollar amounts.
- A bare dollar amount on its own line is NOT a product — it is a price for the item above it. Do NOT create a lineItem for it.`;

// ============================================================
// Adapter registry
// ============================================================

const adapters: Adapter[] = [
  // --- qwen3 ---
  {
    match: (model) => model.toLowerCase().startsWith("qwen3"),
    adapt: (intent, messages, schema) => {
      let adapted = [...messages];

      // Disable Qwen3 thinking/reasoning mode — we want direct JSON output
      // Prepend /no_think to the system prompt as a safety net
      if (intent === "label-extraction" || intent === "category-assignment") {
        const sysIdx = adapted.findIndex((m) => m.role === "system");
        if (sysIdx >= 0 && typeof adapted[sysIdx].content === "string") {
          adapted[sysIdx] = {
            ...adapted[sysIdx],
            content: `/no_think\n${adapted[sysIdx].content}`,
          };
        }

        // Inject few-shot for label extraction
        if (intent === "label-extraction") {
          adapted = injectFewShotExample(adapted, labelFewShotExample);
          adapted = appendToUserMessage(adapted, lineTextReminder);
        }
      }

      return {
        messages: adapted,
        schema,
        bodyOverrides: { think: false, repeat_penalty: 1.0 },
      };
    },
  },

  // --- phi4-mini ---
  {
    match: (model) => model.toLowerCase().includes("phi4") || model.toLowerCase().includes("phi-4"),
    adapt: (intent, messages, schema) => {
      let adapted = [...messages];

      if (intent === "label-extraction") {
        // Phi-4-mini hallucinates product names instead of copying receipt text.
        // Use messy few-shot (truncated text where lineText != productName) to teach copying.
        adapted = injectFewShotExample(adapted, messyFewShotExample);
        // Warehouse-style receipts: bare prices, item codes, tax codes
        adapted = injectFewShotExample(adapted, warehouseFewShotExample);
        adapted = appendToUserMessage(adapted, lineTextReminder);
        adapted = appendToUserMessage(
          adapted,
          "lineText must be a SUBSTRING copied verbatim from the receipt. NEVER complete abbreviations or add words not printed on the receipt.\nRespond with valid JSON only.",
        );
      } else if (intent === "category-assignment") {
        adapted = appendToUserMessage(
          adapted,
          "Respond with valid JSON only. No extra text.",
        );
      }

      return {
        messages: adapted,
        schema,
        // repeat_penalty 1.0: Ollama defaults to 1.1 which penalizes copying text from input.
        // For extraction tasks we WANT the model to copy receipt text verbatim.
        bodyOverrides: { repeat_penalty: 1.0 },
      };
    },
  },

  // --- gemma3 ---
  {
    match: (model) => model.startsWith("gemma3") || model.startsWith("gemma-3"),
    adapt: (intent, messages, schema) => {
      // Gemma3 doesn't support the system role — merge into user
      let adapted = mergeSystemIntoUser(messages);

      // Add few-shot example + reinforcement for label extraction
      if (intent === "label-extraction") {
        adapted = injectFewShotExample(adapted, labelFewShotExample);
        adapted = appendToUserMessage(adapted, lineTextReminder);
      }

      return { messages: adapted, schema };
    },
  },

  // --- llama3.2:3b ---
  {
    match: (model) => model.startsWith("llama3.2") && model.includes("3b"),
    adapt: (intent, messages, schema) => {
      let adapted = [...messages];

      if (intent === "label-extraction") {
        adapted = injectFewShotExample(adapted, onlineOrderFewShotExample);
        adapted = injectFewShotExample(adapted, labelFewShotExample);
        adapted = appendToUserMessage(adapted, lineTextReminder
          + "\n- summaryLabels must NOT include payment info (e.g. \"Payment method\", \"VISA ending in\", \"Charge history\"). These describe how the customer paid, not charges.");
      }

      // Belt-and-suspenders JSON reminder
      adapted = appendToUserMessage(
        adapted,
        "Respond with valid JSON only. No extra text.",
      );

      return { messages: adapted, schema };
    },
  },

  // --- nuextract ---
  {
    match: (model) => model.toLowerCase().includes("nuextract"),
    adapt: (intent, messages, schema) => {
      // Extract the user content from the original messages
      const userMsg = messages.find((m) => m.role === "user");
      const userText =
        typeof userMsg?.content === "string" ? userMsg.content : "";

      // Build template from schema
      const template = schema ? buildNuextractTemplate(schema) : "{}";

      const nuextractMessage: ChatMessage = {
        role: "user",
        content: `<|input|>\n${userText}\n<|output|>\n${template}`,
      };

      // nuextract: no system message, no JSON schema (it fills the template)
      return {
        messages: [nuextractMessage],
        schema: undefined,
        bodyOverrides: { temperature: 0 },
      };
    },
  },

  // --- llama3.1 (bundled model) ---
  // Llama 3.1's chat template includes "Environment: ipython" which causes
  // the model to output Python code instead of JSON. Few-shot + strong JSON
  // reinforcement keeps it on track.
  {
    match: (model) => model.toLowerCase().startsWith("llama3.1") || model.toLowerCase().startsWith("llama-3.1"),
    adapt: (intent, messages, schema) => {
      let adapted = [...messages];

      if (intent === "label-extraction") {
        adapted = injectFewShotExample(adapted, labelFewShotExample);
        adapted = appendToUserMessage(adapted, lineTextReminder);
      }

      adapted = appendToUserMessage(
        adapted,
        "Respond with valid JSON only. No code, no explanation, no markdown.",
      );

      return { messages: adapted, schema };
    },
  },

  // --- default passthrough ---
  {
    match: () => true,
    adapt: (_intent, messages, schema) => {
      let adapted = [...messages];
      adapted = appendToUserMessage(
        adapted,
        "Respond with valid JSON only. No code, no explanation, no markdown.",
      );
      return { messages: adapted, schema };
    },
  },
];

/** Build a JSON template with empty values from a JSON schema. */
const buildNuextractTemplate = (
  schema: Record<string, unknown>,
): string => {
  const buildFromProperties = (
    props: Record<string, unknown>,
  ): Record<string, unknown> => {
    const result: Record<string, unknown> = {};
    for (const [key, def] of Object.entries(props)) {
      const typedDef = def as Record<string, unknown>;
      if (typedDef.type === "string") {
        result[key] = "";
      } else if (typedDef.type === "number") {
        result[key] = 0;
      } else if (typedDef.type === "array") {
        const items = typedDef.items as Record<string, unknown> | undefined;
        if (items?.properties) {
          result[key] = [
            buildFromProperties(
              items.properties as Record<string, unknown>,
            ),
          ];
        } else {
          result[key] = [];
        }
      } else if (typedDef.type === "object" && typedDef.properties) {
        result[key] = buildFromProperties(
          typedDef.properties as Record<string, unknown>,
        );
      } else {
        result[key] = "";
      }
    }
    return result;
  };

  const properties = schema.properties as
    | Record<string, unknown>
    | undefined;
  if (!properties) return "{}";
  return JSON.stringify(buildFromProperties(properties), null, 2);
};

// ============================================================
// Main entry point — called from callLLM()
// ============================================================

export const adaptPrompt = (
  model: string,
  intent: PromptIntent | undefined,
  messages: ChatMessage[],
  schema?: Record<string, unknown>,
): AdaptedPrompt => {
  for (const adapter of adapters) {
    if (adapter.match(model)) {
      return adapter.adapt(intent, messages, schema);
    }
  }
  // Should never reach here due to default passthrough, but just in case
  return { messages, schema };
};

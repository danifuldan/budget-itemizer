import { Hono } from "hono";
import { auth, SSE_TOKEN } from "../middleware";
import { rateLimitOr500 } from "../error-mapping";
import { getAllEnvelopes, getAllAccounts } from "../../services/budget";
import { getWatcherStatus } from "../../services/watcher";
import { getHistory, deleteRecord } from "../../services/history";
import { getConfig, isSetupComplete } from "../../services/config";
import {
  isLlamaServerRunning,
  getLlamaServerStartError,
} from "../../services/llama-server";

const meta = new Hono();

// `?provider=ynab|actual` reads that provider explicitly (settings switch),
// independent of the global config.budgetProvider; anything else falls back
// to the config-active provider.
const readProviderQuery = (raw: string | undefined): "ynab" | "actual" | undefined =>
  raw === "ynab" || raw === "actual" ? raw : undefined;

meta.get("/budgets", auth, async (c) => {
  try {
    const { getBudgetProvider } = await import("../../services/budget-provider");
    const provider = readProviderQuery(c.req.query("provider"));
    const budgets = await getBudgetProvider(provider).getAllBudgets();
    return c.json(budgets, 200);
  } catch (err: any) {
    return rateLimitOr500(c, err);
  }
});

meta.get("/accounts", auth, async (c) => {
  try {
    const provider = readProviderQuery(c.req.query("provider"));
    const all = await getAllAccounts(provider);
    const showAll = c.req.query("all") === "true";
    if (showAll) return c.json(all, 200);
    // Filter by the hidden list for the EFFECTIVE provider (the explicit
    // query, else config-active). The list is per-provider, so one provider's
    // hidden entries can't affect the other — which is what fixes the
    // cross-provider leak. Within a provider we still match by id OR name:
    // YNAB's list can briefly hold un-migrated NAMES on first post-upgrade
    // launch (the async startup migration reconciles them to ids), and the
    // by-name match keeps those hidden until it lands. Names only ever match
    // within their own provider's accounts now, so no cross-hiding.
    const cfg = getConfig();
    const effectiveProvider = provider ?? cfg.budgetProvider;
    const hidden = effectiveProvider === "actual" ? cfg.actualHiddenAccounts : cfg.ynabHiddenAccounts;
    const filtered = hidden.length > 0
      ? all.filter((a) => !hidden.includes(a.id) && !hidden.includes(a.name))
      : all;
    return c.json(filtered, 200);
  } catch (err: any) {
    console.error("Error fetching accounts:", err);
    return rateLimitOr500(c, err);
  }
});

meta.get("/categories", auth, async (c) => {
  try {
    const provider = readProviderQuery(c.req.query("provider"));
    const categories = await getAllEnvelopes(provider);
    return c.json(categories, 200);
  } catch (err: any) {
    console.error("Error fetching categories:", err);
    return rateLimitOr500(c, err);
  }
});

meta.get("/auth/sse-token", auth, async (c) => {
  return c.json({ token: SSE_TOKEN }, 200);
});

// NO auth: FE polls /status before having creds (boot sequence).
meta.get("/status", async (c) => {
  const watcherStatus = getWatcherStatus();
  // Surface the last llama-server start failure so the FE can render a
  // recoverable error UI (with a path to Settings) instead of a permanent
  // "Loading local AI model…" splash.
  return c.json({
    server: "running",
    setup: isSetupComplete(),
    watcher: watcherStatus,
    llmReady: isLlamaServerRunning(),
    llmStartError: getLlamaServerStartError(),
  }, 200);
});

meta.get("/history", auth, async (c) => {
  const limit = parseInt(c.req.query("limit") || "50") || 50;
  return c.json(getHistory(limit), 200);
});

meta.delete("/history/:id", auth, async (c) => {
  const id = c.req.param("id");
  const deleted = deleteRecord(id);
  if (!deleted) return c.json({ error: "Record not found" }, 404);
  return c.json({ success: true }, 200);
});

// No auth: loopback health probe.
meta.get("/healthz", async (c) => {
  return c.text("OK", 200);
});

export default meta;

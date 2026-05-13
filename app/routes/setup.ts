import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { auth } from "../middleware";
import { getConfig, saveConfig, isSetupComplete, wasConfigReset } from "../../services/config";

// All setup routes require auth. The Tauri frontend gets its basic-auth
// credentials via the in-process `get_app_credentials` IPC command — they
// are never returned over HTTP. This closes the cred-leak-from-loopback
// and unauth-/setup/save attack chain (any caller without IPC access
// must already have the creds to POST changes).
const setup = new Hono();

setup.get("/status", auth, async (c) => {
  const config = getConfig();
  // Strip all secret material from the response. Frontend only needs
  // booleans to drive wizard "has-been-filled-in" UI; raw values come
  // from typing in the wizard or from the masked /config endpoint.
  const { ynabApiKey, appApiKey, appApiSecret, actualPassword, ...safeConfig } = config;
  return c.json({
    complete: isSetupComplete(),
    configWasReset: wasConfigReset(),
    config: {
      ...safeConfig,
      hasYnabApiKey: !!ynabApiKey,
      hasActualPassword: !!actualPassword,
    },
  });
});

setup.post("/test-ynab", auth, async (c) => {
  try {
    const { YnabBudgetProvider } = await import("../../services/budget-ynab");
    const ynab = new YnabBudgetProvider();
    const budgets = await ynab.getAllBudgets();
    return c.json({ success: true, budgets }, 200);
  } catch (err: any) {
    return c.json({ success: false, error: err.message }, 200);
  }
});

setup.post("/test-actual", auth, async (c) => {
  try {
    const { ActualBudgetProvider } = await import("../../services/budget-actual");
    const actual = new ActualBudgetProvider();
    const budgets = await actual.getAllBudgets();
    return c.json({ success: true, budgets }, 200);
  } catch (err: any) {
    return c.json({ success: false, error: err.message }, 200);
  }
});

setup.post(
  "/save",
  auth,
  zValidator("json", z.record(z.unknown())),
  async (c) => {
    const updates = c.req.valid("json") as Record<string, unknown>;
    const config = await saveConfig(updates as any);
    return c.json({ success: true, config }, 200);
  }
);

export default setup;

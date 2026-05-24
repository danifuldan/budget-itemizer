import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { auth } from "../middleware";
import { safeErrorMessage } from "../error-mapping";
import { getConfig, saveConfig, isSetupComplete } from "../../services/config";
import {
  getWatcherStatus,
  startWatcher,
  stopWatcher,
  clearAllPending,
} from "../../services/watcher";

const config = new Hono();

config.get("/", auth, async (c) => {
  const cfg = { ...getConfig() };
  const mask = (v: string) => v.length > 4 ? "••••" + v.slice(-4) : v ? "••••" : "";
  const secretLengths = {
    ynabApiKeyLength: cfg.ynabApiKey.length,
    actualPasswordLength: (cfg.actualPassword || "").length,
  };
  cfg.ynabApiKey = mask(cfg.ynabApiKey);
  cfg.appApiKey = mask(cfg.appApiKey);
  cfg.appApiSecret = mask(cfg.appApiSecret);
  if (cfg.actualPassword) cfg.actualPassword = mask(cfg.actualPassword);
  return c.json({ ...cfg, ...secretLengths }, 200);
});

// Length caps to keep config.json bounded and downstream filesystem /
// HTTP / SDK calls predictable. Pre-fix, a 100 KB inboxPath could be
// persisted, ballooning config.json and breaking subsequent fs.watch
// calls when the OS rejected the path. PATH_MAX is 1024 on macOS;
// 4096 is generous and matches Linux. Secret fields use a higher cap
// because some bearer tokens are long.
const PATH_MAX = 4096;
const SECRET_MAX = 8192;
const NAME_MAX = 256;
const URL_MAX = 2048;
const configUpdateSchema = z.object({
  embeddedModel: z.string().max(NAME_MAX).optional(),
  ynabApiKey: z.string().max(SECRET_MAX).optional(),
  ynabBudgetId: z.string().max(NAME_MAX).optional(),
  ynabCategoryGroups: z.array(z.string().max(NAME_MAX)).max(256).optional(),
  ynabAccountId: z.string().max(NAME_MAX).optional(),
  defaultAccount: z.string().max(NAME_MAX).optional(),
  inboxPath: z.string().max(PATH_MAX).optional(),
  processedPath: z.string().max(PATH_MAX).optional(),
  deleteAfterImport: z.boolean().optional(),
  watcherEnabled: z.boolean().optional(),
  watcherAutoImport: z.boolean().optional(),
  watcherNotify: z.boolean().optional(),
  watcherFocusApp: z.boolean().optional(),
  minimizeToTray: z.boolean().optional(),
  matchAcrossAccounts: z.boolean().optional(),
  hiddenAccounts: z.array(z.string().max(NAME_MAX)).max(256).optional(),
  discountMode: z.enum(["distribute", "credit"]).optional(),
  budgetProvider: z.enum(["ynab", "actual"]).optional(),
  actualServerUrl: z.string().max(URL_MAX).optional(),
  actualPassword: z.string().max(SECRET_MAX).optional(),
  actualSyncId: z.string().max(NAME_MAX).optional(),
}).strict();

config.post("/", auth, zValidator("json", configUpdateSchema), async (c) => {
  try {
    const updates = c.req.valid("json");
    // Any change to provider identity OR provider creds requires resetting
    // the cached SDK. Without this, editing actualServerUrl after a
    // successful first connect leaves the SDK pinned to the old URL
    // until app restart — Settings says "saved" but the next call still
    // hits the old server. Shared with /setup/save via the same helper so
    // the two routes can't drift on which fields trigger a reset.
    const { resetBudgetProviderIfAffected } = await import("../../services/budget-provider");
    await resetBudgetProviderIfAffected(updates);
    // Capture the setup-complete state before the write so we can detect
    // the false→true transition below. index.ts main() only auto-starts
    // the watcher at boot; if setup was incomplete then (fresh install
    // or partial config), the watcher stays off until something starts
    // it. Without this transition handler, a user finishes the setup
    // wizard, drops a receipt, and nothing happens.
    const wasSetupComplete = isSetupComplete();
    const cfg = await saveConfig(updates);
    const nowSetupComplete = isSetupComplete();

    // Watcher path changes only take effect when the watcher is recreated;
    // saveConfig alone updates the reported state but the underlying
    // fs.watch handle is still bound to the old path. Stop+start so the
    // new paths are actually watched. When the *inbox* moves, also drop
    // any pending entries — they point at files under the old inbox
    // path that nothing watches any more, so their "moved to processed"
    // events can never fire and they'd persist forever in the FE list.
    if (("inboxPath" in updates || "processedPath" in updates) && getWatcherStatus().running) {
      stopWatcher();
      if ("inboxPath" in updates) clearAllPending();
      startWatcher();
    } else if (!wasSetupComplete && nowSetupComplete && !getWatcherStatus().running) {
      // First-time setup completion (or recovery from a partially-
      // configured state). Boot-time auto-start missed because setup
      // wasn't complete then; pick it up now.
      startWatcher();
    }
    return c.json({ success: true, config: cfg }, 200);
  } catch (err: any) {
    return c.json({ error: safeErrorMessage(err) }, 500);
  }
});

export default config;

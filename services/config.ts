import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import { getSecret, setSecret, deleteSecret, KEYCHAIN_KEYS } from "./keychain";
import { writeRestrictedFile, ensureRestrictedDir } from "../utils/restricted-file";

/** Fields that are persisted in the macOS Keychain rather than config.json.
 *  Adding a field here means: never write to config.json, never read from
 *  the file, always go through Keychain. `appApiKey`/`appApiSecret` are
 *  the basic-auth credentials gating the Hono sidecar — they live in
 *  Keychain so a same-user attacker can't `cat config.json` for them. */
const SECRET_FIELDS = ["ynabApiKey", "actualPassword", "appApiKey", "appApiSecret"] as const;
type SecretField = typeof SECRET_FIELDS[number];

export interface AppConfig {
  embeddedModel: string;
  ynabApiKey: string;
  ynabBudgetId: string;
  ynabCategoryGroups: string[];
  defaultAccount: string;
  inboxPath: string;
  processedPath: string;
  deleteAfterImport: boolean;
  appPort: number;
  appApiKey: string;
  appApiSecret: string;
  watcherEnabled: boolean;
  watcherAutoImport: boolean;
  watcherNotify: boolean;
  watcherFocusApp: boolean;
  minimizeToTray: boolean;
  matchAcrossAccounts: boolean;
  hiddenAccounts: string[];
  discountMode: "distribute" | "credit";
  budgetProvider: "ynab" | "actual";
  actualServerUrl: string;
  actualPassword: string;
  actualSyncId: string;
}

const CONFIG_DIR = path.join(os.homedir(), ".config", "budget-itemizer");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

const defaults: AppConfig = {
  embeddedModel: "llama3.1-8b",
  ynabApiKey: "",
  ynabBudgetId: "",
  ynabCategoryGroups: [],
  defaultAccount: "",
  inboxPath: path.join(os.homedir(), "Receipts", "inbox"),
  processedPath: path.join(os.homedir(), "Receipts", "processed"),
  deleteAfterImport: false,
  appPort: 3456,
  appApiKey: "",
  appApiSecret: "",
  watcherEnabled: true,
  watcherAutoImport: false,
  watcherNotify: true,
  watcherFocusApp: false,
  minimizeToTray: true,
  matchAcrossAccounts: true,
  hiddenAccounts: [],
  discountMode: "distribute",
  budgetProvider: "ynab",
  actualServerUrl: "",
  actualPassword: "",
  actualSyncId: "",
};

let cachedConfig: AppConfig | null = null;
// True if loading the config file failed JSON parse on this process boot.
// Surfaced via /setup/status so the wizard can warn the user that their
// previous settings were lost. Cleared after the first successful saveConfig.
let _configWasReset = false;
export const wasConfigReset = (): boolean => _configWasReset;

const ensureDir = () => ensureRestrictedDir(CONFIG_DIR);
const writeConfigFile = (data: string): void => writeRestrictedFile(CONFIG_FILE, data);

/** Strip secret fields out of an object. Used before writing config.json
 *  so secrets never touch disk in plain form. */
function stripSecrets<T extends Partial<AppConfig>>(obj: T): T {
  const out = { ...obj };
  for (const key of SECRET_FIELDS) {
    delete (out as any)[key];
  }
  return out;
}

/** Synchronous part of config loading: read file, merge with defaults.
 *  Does NOT touch the Keychain — secret fields end up as empty strings
 *  here. Callers that need secrets must `await loadConfig()` first.
 *  Safe to call from module-init paths. */
function loadFileConfigSync(): AppConfig {
  ensureDir();
  let fileConfig: Partial<AppConfig> = {};
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      fileConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
    } catch {
      console.warn("Failed to parse config file, using defaults");
      _configWasReset = true;
    }
  }

  const merged: AppConfig = {
    ...defaults,
    ...fileConfig,
    // Secrets only come from Keychain via async loadConfig().
    ynabApiKey: "",
    actualPassword: "",
    appApiKey: "",
    appApiSecret: "",
  };

  return merged;
}

/** Read both file config and Keychain secrets. Call once at startup
 *  before any sync access that needs secrets. Idempotent — safe to
 *  call multiple times. */
export const loadConfig = async (): Promise<AppConfig> => {
  // Re-read file (in case it changed since module init) and migrate
  // any secrets stored in config.json from older builds.
  ensureDir();
  let fileConfig: Partial<AppConfig> = {};
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      fileConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
    } catch {
      console.warn("Failed to parse config file, using defaults");
      _configWasReset = true;
    }
  }

  let needsRewriteAfterMigration = false;
  for (const key of SECRET_FIELDS) {
    const fileValue = (fileConfig as any)[key];
    if (typeof fileValue === "string" && fileValue.length > 0) {
      try {
        await setSecret(KEYCHAIN_KEYS[key], fileValue);
        delete (fileConfig as any)[key];
        needsRewriteAfterMigration = true;
      } catch (err) {
        console.error(`Failed to migrate ${key} to Keychain:`, err);
      }
    }
  }

  // Strip deprecated fields from older configs. Custom LLM provider was
  // removed — leaving these in config.json would let a tampered file
  // re-introduce the old code path if any consumer ever resurrects it.
  const DEPRECATED_FIELDS = [
    "llmProvider",
    "llmEndpoint",
    "llmTextModel",
    "llmApiKey",
    "extractionProvider",
    "understandingProvider",
  ];
  for (const key of DEPRECATED_FIELDS) {
    if (key in fileConfig) {
      delete (fileConfig as any)[key];
      needsRewriteAfterMigration = true;
    }
  }

  const ynabApiKey = (await getSecret(KEYCHAIN_KEYS.ynabApiKey)) ?? "";
  const actualPassword = (await getSecret(KEYCHAIN_KEYS.actualPassword)) ?? "";
  let appApiKey = (await getSecret(KEYCHAIN_KEYS.appApiKey)) ?? "";
  let appApiSecret = (await getSecret(KEYCHAIN_KEYS.appApiSecret)) ?? "";

  // Generate basic-auth credentials on first launch and persist to
  // Keychain. The env-var fallback (APP_API_KEY/APP_API_SECRET) is kept
  // for dev/CI scenarios where Keychain access is awkward.
  if (!appApiKey && !process.env.APP_API_KEY) {
    appApiKey = crypto.randomUUID();
    try {
      await setSecret(KEYCHAIN_KEYS.appApiKey, appApiKey);
    } catch (err) {
      console.error("Failed to persist generated appApiKey to Keychain:", err);
    }
  }
  if (!appApiSecret && !process.env.APP_API_SECRET) {
    appApiSecret = crypto.randomUUID();
    try {
      await setSecret(KEYCHAIN_KEYS.appApiSecret, appApiSecret);
    } catch (err) {
      console.error("Failed to persist generated appApiSecret to Keychain:", err);
    }
  }

  cachedConfig = {
    ...defaults,
    ...fileConfig,
    ynabApiKey,
    actualPassword,
    appApiKey,
    appApiSecret,
  };

  if (needsRewriteAfterMigration) {
    try {
      writeConfigFile(JSON.stringify(stripSecrets(cachedConfig), null, 2));
    } catch (err) {
      console.error("Failed to persist post-migration config:", err);
    }
  }

  return cachedConfig;
};

/** Synchronous getter. If called before loadConfig(), returns the
 *  file-only view (secrets are empty strings). After loadConfig()
 *  resolves, returns the full view including Keychain-loaded secrets. */
export const getConfig = (): AppConfig => {
  if (!cachedConfig) {
    cachedConfig = loadFileConfigSync();
  }
  return cachedConfig;
};

export const saveConfig = async (updates: Partial<AppConfig>): Promise<AppConfig> => {
  const current = getConfig();
  const updated = { ...current, ...updates };
  ensureDir();

  // Persist secrets to Keychain (or remove them when cleared).
  for (const key of SECRET_FIELDS) {
    if (key in updates) {
      const value = (updates as any)[key];
      try {
        if (typeof value === "string" && value.length > 0) {
          await setSecret(KEYCHAIN_KEYS[key], value);
        } else {
          await deleteSecret(KEYCHAIN_KEYS[key]);
        }
      } catch (err) {
        console.error(`Failed to persist ${key} to Keychain:`, err);
      }
    }
  }

  try {
    writeConfigFile(JSON.stringify(stripSecrets(updated), null, 2));
  } catch (err) {
    console.error("Failed to write config file:", err);
  }
  cachedConfig = updated;
  // Once setup is back to complete, the "settings were reset" notice is
  // no longer relevant; clear so it stops surfacing on next status poll.
  if (_configWasReset && isSetupComplete()) {
    _configWasReset = false;
  }
  return updated;
};

export const isSetupComplete = (): boolean => {
  const config = getConfig();
  const inbox = config.inboxPath;
  const account = config.defaultAccount;
  // `processedPath` is unused at runtime when deleteAfterImport is on
  // (services/watcher.ts unlinks the source instead of moving). Treat it
  // as satisfied in that case — otherwise enabling the toggle and
  // clearing the now-unused field forces the wizard to relaunch.
  const processedSatisfied = !!config.processedPath || !!config.deleteAfterImport;

  if (config.budgetProvider === "actual") {
    return !!(config.actualServerUrl && config.actualPassword && config.actualSyncId && account && inbox && processedSatisfied);
  }

  // YNAB (default)
  const ynabKey = config.ynabApiKey || process.env.YNAB_API_KEY;
  const ynabBudget = config.ynabBudgetId || process.env.YNAB_BUDGET_ID;
  return !!(ynabKey && ynabBudget && account && inbox && processedSatisfied);
};

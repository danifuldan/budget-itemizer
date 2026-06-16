import { describe, it, expect, beforeEach, vi } from "vitest";
import * as fs from "fs";

vi.mock("fs");
// loadConfig now reads from the macOS Keychain via services/keychain. Stub
// it so tests don't touch real credentials and so secrets default to "".
vi.mock("./keychain", () => ({
  getSecret: vi.fn(async () => null),
  setSecret: vi.fn(async () => {}),
  deleteSecret: vi.fn(async () => {}),
  KEYCHAIN_KEYS: { ynabApiKey: "y", actualPassword: "a" },
}));

// Must import AFTER vi.mock so the module picks up the mocks.
import { loadConfig, saveConfig, isSetupComplete } from "./config";

const mockedFs = vi.mocked(fs);

beforeEach(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});

  mockedFs.mkdirSync.mockReturnValue(undefined);
  mockedFs.existsSync.mockReturnValue(false);
  mockedFs.writeFileSync.mockReturnValue(undefined);

  delete process.env.YNAB_API_KEY;
  delete process.env.YNAB_BUDGET_ID;

  // Reset cached config by re-loading with no file present.
  await loadConfig();
});

describe("loadConfig", () => {
  it("returns defaults when no config file exists", async () => {
    mockedFs.existsSync.mockReturnValue(false);
    const config = await loadConfig();
    expect(config.embeddedModel).toBe("llama3.1-8b");
    expect(config.ynabApiKey).toBe("");
    expect(config.appPort).toBe(3456);
  });

  it("merges partial config file with defaults (non-secret fields)", async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify({ appPort: 4000, ynabDefaultAccount: "Checking" })
    );
    const config = await loadConfig();
    expect(config.appPort).toBe(4000);
    expect(config.ynabDefaultAccount).toBe("Checking");
    expect(config.embeddedModel).toBe("llama3.1-8b");
  });

  it("strips deprecated LLM fields from older configs", async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify({
        appPort: 4000,
        llmProvider: "custom",
        llmEndpoint: "http://example/v1",
        llmTextModel: "old-model",
        llmApiKey: "stale-key",
      })
    );
    const config = await loadConfig();
    expect((config as any).llmProvider).toBeUndefined();
    expect((config as any).llmEndpoint).toBeUndefined();
    expect((config as any).llmTextModel).toBeUndefined();
    expect((config as any).llmApiKey).toBeUndefined();
    expect(config.appPort).toBe(4000);
    // Migration triggers a rewrite that drops the deprecated keys from disk.
    expect(mockedFs.writeFileSync).toHaveBeenCalled();
  });

  it("defaults both per-provider hidden lists to empty", async () => {
    mockedFs.existsSync.mockReturnValue(false);
    const config = await loadConfig();
    expect(config.ynabHiddenAccounts).toEqual([]);
    expect(config.actualHiddenAccounts).toEqual([]);
  });

  it("folds a legacy global hiddenAccounts list into ynabHiddenAccounts and drops the legacy key", async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify({ hiddenAccounts: ["acc-1", "acc-2"] })
    );
    const config = await loadConfig();
    // Legacy data was YNAB-centric (the migration only ran for YNAB), so it
    // lands in the YNAB list, not Actual's.
    expect(config.ynabHiddenAccounts).toEqual(["acc-1", "acc-2"]);
    expect(config.actualHiddenAccounts).toEqual([]);
    // The legacy field is removed from the in-memory config and rewritten out.
    expect((config as any).hiddenAccounts).toBeUndefined();
    expect(mockedFs.writeFileSync).toHaveBeenCalled();
  });

  it("does not clobber an existing ynabHiddenAccounts when a legacy key is also present", async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify({ hiddenAccounts: ["legacy"], ynabHiddenAccounts: ["already-migrated"] })
    );
    const config = await loadConfig();
    expect(config.ynabHiddenAccounts).toEqual(["already-migrated"]);
    expect((config as any).hiddenAccounts).toBeUndefined();
  });

  it("returns defaults and warns on corrupt JSON", async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue("not valid json {{{");
    const config = await loadConfig();
    expect(config.ynabApiKey).toBe("");
    expect(console.warn).toHaveBeenCalledWith(
      "Failed to parse config file, using defaults"
    );
  });
});

describe("legacy account-field migration", () => {
  it("folds a legacy defaultAccount into ynabDefaultAccount when provider is unset/ynab", async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify({ ynabAccountId: "acc-1", defaultAccount: "Checking" })
    );
    const config = await loadConfig();
    expect(config.ynabDefaultAccount).toBe("Checking");
    expect(config.ynabAccountId).toBe("acc-1"); // YNAB id stays put
    expect(config.actualDefaultAccount).toBe("");
    expect(config.actualAccountId).toBe("");
    expect((config as any).defaultAccount).toBeUndefined();
    expect(mockedFs.writeFileSync).toHaveBeenCalled();
  });

  it("relocates a misfiled account into the Actual fields when budgetProvider was actual", async () => {
    mockedFs.existsSync.mockReturnValue(true);
    // When Actual was active, the legacy shared fields held ACTUAL data
    // misfiled under the YNAB-named ynabAccountId + the shared defaultAccount.
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify({ budgetProvider: "actual", ynabAccountId: "actual-acc", defaultAccount: "Spending" })
    );
    const config = await loadConfig();
    expect(config.actualAccountId).toBe("actual-acc");
    expect(config.actualDefaultAccount).toBe("Spending");
    // YNAB slot cleared — we don't know YNAB's id; the picker re-selects.
    expect(config.ynabAccountId).toBe("");
    expect(config.ynabDefaultAccount).toBe("");
    expect((config as any).defaultAccount).toBeUndefined();
  });
});

describe("saveConfig", () => {
  it("merges partial updates with current config", async () => {
    mockedFs.existsSync.mockReturnValue(false);
    await loadConfig();

    const result = await saveConfig({ ynabBudgetId: "new-budget" });
    expect(result.ynabBudgetId).toBe("new-budget");
    expect(result.embeddedModel).toBe("llama3.1-8b");
    expect(mockedFs.writeFileSync).toHaveBeenCalled();
  });
});

describe("isSetupComplete", () => {
  it("returns true when all required fields are set in config", async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify({
        ynabBudgetId: "budget",
        defaultAccount: "Checking",
        inboxPath: "/inbox",
        processedPath: "/processed",
      })
    );
    // Override the keychain mock for this test only — secrets ARE present.
    const { getSecret } = await import("./keychain");
    vi.mocked(getSecret).mockResolvedValueOnce("ynab-key");
    await loadConfig();
    expect(isSetupComplete()).toBe(true);
  });

  it("returns false when a required field is missing", async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify({
        // missing ynabBudgetId, ynab account
        inboxPath: "/inbox",
        processedPath: "/processed",
      })
    );
    const { getSecret } = await import("./keychain");
    vi.mocked(getSecret).mockResolvedValueOnce("ynab-key");
    await loadConfig();
    expect(isSetupComplete()).toBe(false);
  });

  // 2A: the gate checks the ACTIVE provider's own account, so a name left
  // over from the other provider can't make setup look complete.
  it("Actual setup is NOT complete just because a YNAB account name lingers", async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify({
        budgetProvider: "actual",
        actualServerUrl: "https://localhost:5006",
        actualSyncId: "sync-1",
        ynabDefaultAccount: "Checking", // leftover from YNAB — must not satisfy Actual
        // no actualAccountId / actualDefaultAccount
        inboxPath: "/inbox",
        processedPath: "/processed",
      })
    );
    const { getSecret } = await import("./keychain");
    // actualPassword present (secret), so only the account is missing.
    vi.mocked(getSecret).mockResolvedValue("secret");
    await loadConfig();
    expect(isSetupComplete()).toBe(false);
  });

  // The id can be empty on first post-upgrade launch (async name→id migration
  // pending); the NAME alone keeps the gate satisfied so the wizard doesn't
  // spuriously relaunch.
  it("YNAB setup is complete with only ynabDefaultAccount (id not yet resolved)", async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify({
        ynabBudgetId: "budget",
        ynabDefaultAccount: "Checking", // name only, ynabAccountId still ""
        inboxPath: "/inbox",
        processedPath: "/processed",
      })
    );
    const { getSecret } = await import("./keychain");
    vi.mocked(getSecret).mockResolvedValueOnce("ynab-key");
    await loadConfig();
    expect(isSetupComplete()).toBe(true);
  });
});

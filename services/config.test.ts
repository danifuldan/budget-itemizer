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
      JSON.stringify({ appPort: 4000, defaultAccount: "Checking" })
    );
    const config = await loadConfig();
    expect(config.appPort).toBe(4000);
    expect(config.defaultAccount).toBe("Checking");
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
        // missing ynabBudgetId, defaultAccount
        inboxPath: "/inbox",
        processedPath: "/processed",
      })
    );
    const { getSecret } = await import("./keychain");
    vi.mocked(getSecret).mockResolvedValueOnce("ynab-key");
    await loadConfig();
    expect(isSetupComplete()).toBe(false);
  });
});

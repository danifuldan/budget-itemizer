import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ConfigData } from "../hooks/useConfig";
import { useAppUpdate } from "../hooks/useAppUpdate";
import { getAutostart, setAutostart } from "../hooks/useTauriAutostart";
import { useModelDownload } from "../hooks/useModelDownload";
import { useYnabTest } from "../hooks/useYnabTest";
import { useActualTest } from "../hooks/useActualTest";
import { useBudgetAccountLoader } from "../hooks/useBudgetAccountLoader";
import { apiFetch, apiPost } from "../api/client";
import Toggle from "./Toggle";
import TitlebarRegion from "./TitlebarRegion";
import ConfirmDialog from "./ConfirmDialog";
import ModelDownloadCard from "./ModelDownloadCard";

type ThemePreference = "system" | "light" | "dark";

interface SettingsViewProps {
  onBack: () => void;
  onRunSetup?: () => void;
  themePreference: ThemePreference;
  onThemeChange: (pref: ThemePreference) => void;
  config: ConfigData;
  configLoading: boolean;
  saveConfig: (updates: Partial<ConfigData>) => Promise<boolean>;
  appUpdate: ReturnType<typeof useAppUpdate>;
}

/** Inline row that surfaces app-update state. Receives the hook return
 *  as a prop so the boot-time check runs at App.tsx mount, not on
 *  Settings open. The auto-check is silent on failure (no scary message
 *  when GitHub returns 404 because no manifest is published yet);
 *  manual "Check now" failures DO surface so the user knows the click
 *  did something. */
function UpdateRow({ appUpdate }: { appUpdate: ReturnType<typeof useAppUpdate> }) {
  const { available, checking, installing, error, check, installAndRestart } = appUpdate;
  if (available) {
    return (
      <div className="settings-update-row">
        <span className="settings-update-text">
          Update available — v{available.version}
        </span>
        <button className="btn-link" onClick={installAndRestart} disabled={installing}>
          {installing ? "Installing…" : "Install & relaunch"}
        </button>
      </div>
    );
  }
  // useAppUpdate already maps known error classes to user-facing strings
  // (e.g., "Couldn't reach update server") and treats 404 / no-manifest as
  // the up-to-date case (no error set), so we just render whatever it gave us.
  const status = error
    ? error
    : checking
    ? "Checking for updates…"
    : "Up to date";
  return (
    <div className="settings-update-row">
      <span className="settings-update-text">{status}</span>
      <button className="btn-link" onClick={check} disabled={checking}>
        {checking ? "Checking…" : "Check now"}
      </button>
    </div>
  );
}

export default function SettingsView({ onBack, onRunSetup, themePreference, onThemeChange, config, configLoading: loading, saveConfig: save, appUpdate }: SettingsViewProps) {
  const modelDownload = useModelDownload({ modelId: "llama3.1-8b" });

  // budgetProvider is local state because it gates the dropdown
  // visibility and the hook wiring. Single useState — not worth a hook.
  const [budgetProvider, setBudgetProvider] = useState<"ynab" | "actual">("ynab");

  // Local Actual budget list (separate from loader.budgets — the
  // YNAB-vs-Actual UIs each have their own select element that shows
  // either YNAB or Actual budgets, not both).
  const [actualBudgetList, setActualBudgetList] = useState<{ id: string; name: string }[]>([]);

  // budgetAccountLoader is declared first so the test hooks below can
  // reference it via closure in their onTested callbacks. The
  // budgetIdField dynamically tracks the active provider — selectBudget
  // POSTs the right backend field (ynabBudgetId vs actualSyncId).
  //
  // Seed with the budget id for the SAVED provider (not the local
  // budgetProvider state, which may have been flipped by the user
  // mid-flow). Cross-provider mixing was a pre-refactor footgun where
  // a YNAB id leaked into actualSyncId on save.
  const savedProvider = config.budgetProvider || "ynab";
  const savedBudgetId = savedProvider === "actual" ? config.actualSyncId : config.ynabBudgetId;
  const budgetAccountLoader = useBudgetAccountLoader({
    budgetIdField: budgetProvider === "ynab" ? "ynabBudgetId" : "actualSyncId",
    loadAllAccounts: true,
    initialSelectedBudgetId: savedBudgetId || "",
    initialSelectedAccount: config.defaultAccount || "",
  });

  const ynabTest = useYnabTest({
    onTested: async (result) => {
      if (!result.success || !result.budgets) return;
      budgetAccountLoader.setBudgets(result.budgets);
      // Settings's auto-select rule: keep the user's existing budget
      // if it's still in the list; otherwise pick the first.
      const currentValid = result.budgets.some((b) => b.id === budgetAccountLoader.state.selectedBudgetId);
      const budgetId = currentValid ? budgetAccountLoader.state.selectedBudgetId : result.budgets[0]?.id || "";
      if (budgetId) {
        await budgetAccountLoader.selectBudget(budgetId);
      }
    },
  });

  const actualTest = useActualTest({
    initialServerUrl: config.actualServerUrl || "",
    initialPasswordPlaceholder: "•".repeat(config.actualPasswordLength || 0),
    onTested: async (result, budgets) => {
      if (!result.success || budgets.length === 0) return;
      setActualBudgetList(budgets);
      const currentValid = budgets.some((b) => b.id === budgetAccountLoader.state.selectedBudgetId);
      const budgetId = currentValid ? budgetAccountLoader.state.selectedBudgetId : budgets[0]?.id || "";
      if (budgetId) {
        await budgetAccountLoader.selectBudget(budgetId);
      }
    },
  });

  const [inboxPath, setInboxPath] = useState("");
  const [processedPath, setProcessedPath] = useState("");
  const [deleteAfterImport, setDeleteAfterImport] = useState(false);

  const [watcherEnabled, setWatcherEnabled] = useState(true);
  const [autoImport, setAutoImport] = useState(false);
  const [focusWindow, setFocusWindow] = useState(true);
  const [startOnLogin, setStartOnLogin] = useState(false);
  const [minimizeToTray, setMinimizeToTray] = useState(true);
  const [showNotifications, setShowNotifications] = useState(true);
  const [matchAcrossAccounts, setMatchAcrossAccounts] = useState(true);
  const [discountMode, setDiscountMode] = useState<"distribute" | "credit">("distribute");
  const [hiddenAccounts, setHiddenAccounts] = useState<string[]>([]);

  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // Ref to ensure we only initialize from config once
  const initialized = useRef(false);

  // Populate fields from config ONCE when it first loads. Model + budget
  // bootstrap is owned by hooks; this effect only seeds the rest.
  useEffect(() => {
    if (loading || initialized.current) return;
    initialized.current = true;

    setBudgetProvider(config.budgetProvider || "ynab");
    setInboxPath(config.inboxPath);
    setProcessedPath(config.processedPath);
    setDeleteAfterImport(config.deleteAfterImport ?? false);
    setWatcherEnabled(config.watcherEnabled);
    setAutoImport(config.watcherAutoImport);
    setFocusWindow(config.watcherFocusApp);
    setMinimizeToTray(config.minimizeToTray);
    setShowNotifications(config.watcherNotify);
    setMatchAcrossAccounts(config.matchAcrossAccounts);
    setDiscountMode(config.discountMode || "distribute");
    setHiddenAccounts(config.hiddenAccounts || []);
    getAutostart().then(setStartOnLogin);

    // Pre-populate the budget dropdown so the user sees their saved
    // budget by name (not just id) before clicking Test Connection.
    // /budgets fails silently if creds aren't set yet — that's the
    // first-run state where the wizard hasn't completed.
    apiFetch<{ id: string; name: string }[]>("/budgets")
      .then((data) => budgetAccountLoader.setBudgets(data))
      .catch(() => {});

    // If a budget is already saved, prime the accounts dropdowns too.
    // refreshAccounts hits /accounts (and /accounts?all=true since
    // loadAllAccounts=true), so the Default Account + Account Visibility
    // selects are populated on first render.
    const hasSavedBudget = (config.budgetProvider === "actual" && config.actualSyncId)
      || (config.budgetProvider !== "actual" && config.ynabBudgetId);
    if (hasSavedBudget) {
      budgetAccountLoader.refreshAccounts();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, config]);

  const handleProviderChange = async (provider: "ynab" | "actual") => {
    setBudgetProvider(provider);
    // Restore the budget id saved for the newly-active provider so the
    // dropdown shows ITS own value, not the prior provider's id. Without
    // this swap, the next Save would write the wrong id into the active
    // provider's backend field. Use setSelectedBudgetId (not selectBudget)
    // so we don't fire a /config write before the budgetProvider change
    // has landed in the loader's budgetIdField.
    const restoredBudgetId = provider === "actual"
      ? (config.actualSyncId || "")
      : (config.ynabBudgetId || "");
    budgetAccountLoader.setSelectedBudgetId(restoredBudgetId);
    budgetAccountLoader.setSelectedAccount(config.defaultAccount || "");
    await apiPost("/config", { budgetProvider: provider });
  };

  const handleSave = async () => {
    setSaving(true);
    setSaved(false);
    // Budget-id save mapping: keep the *non-active* provider's saved
    // value intact and only overwrite the active provider's field.
    // Without this, switching to YNAB and saving would null out
    // actualSyncId (and vice versa).
    const updates: Partial<ConfigData> = {
      embeddedModel: "llama3.1-8b",
      budgetProvider,
      ynabBudgetId: budgetProvider === "ynab"
        ? budgetAccountLoader.state.selectedBudgetId
        : config.ynabBudgetId,
      actualSyncId: budgetProvider === "actual"
        ? budgetAccountLoader.state.selectedBudgetId
        : config.actualSyncId,
      defaultAccount: budgetAccountLoader.state.selectedAccount,
      inboxPath,
      processedPath,
      deleteAfterImport,
      watcherEnabled,
      watcherAutoImport: autoImport,
      watcherNotify: showNotifications,
      watcherFocusApp: focusWindow,
      minimizeToTray,
      matchAcrossAccounts,
      discountMode,
      hiddenAccounts,
    };
    // Only include secret fields if the user actually typed a new value
    if (ynabTest.state.apiKey) updates.ynabApiKey = ynabTest.state.apiKey;
    if (budgetProvider === "actual") {
      if (actualTest.state.serverUrl) updates.actualServerUrl = actualTest.state.serverUrl;
      if (actualTest.state.passwordChanged && actualTest.state.password) {
        updates.actualPassword = actualTest.state.password;
      }
    }
    const ok = await save(updates);
    setSaving(false);
    if (ok) {
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    }
  };

  if (loading) {
    return (
      <div className="settings-view">
        <TitlebarRegion>
          <button className="btn-ghost" onClick={onBack}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10 3L5 8l5 5" />
            </svg>
            Back
          </button>
          <h1 className="settings-header-title">Settings</h1>
        </TitlebarRegion>
      </div>
    );
  }

  const ynabBudgetId = budgetProvider === "ynab" ? budgetAccountLoader.state.selectedBudgetId : "";
  const actualSyncId = budgetProvider === "actual" ? budgetAccountLoader.state.selectedBudgetId : "";
  const defaultAccount = budgetAccountLoader.state.selectedAccount;
  const accounts = budgetAccountLoader.state.accounts;
  const allAccounts = budgetAccountLoader.state.allAccounts;
  const loadingAccounts = budgetAccountLoader.state.loadingAccounts;
  const budgets = budgetProvider === "ynab" ? budgetAccountLoader.state.budgets : actualBudgetList;

  return (
    <>
    <ConfirmDialog
      open={modelDownload.state.confirmDeleteOpen}
      message={modelDownload.deleteConfirmMessage}
      confirmLabel="Delete"
      destructive
      onConfirm={modelDownload.performDelete}
      onCancel={modelDownload.cancelDelete}
    />
    <div className="settings-view">
      <TitlebarRegion>
        <button className="btn-ghost" onClick={onBack}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M10 3L5 8l5 5" />
          </svg>
          Back
        </button>
        <h1 className="settings-header-title">Settings</h1>
      </TitlebarRegion>

      <div className="settings-scroll">
      {/* AI Model */}
      <div className="settings-section">
        <h2 className="settings-section-title">AI Model</h2>
        <div className="settings-section-body">
          <ModelDownloadCard download={modelDownload} variant="settings" showInstalledRow />
        </div>
      </div>

      {/* Budget Connection */}
      <div className="settings-section">
        <h2 className="settings-section-title">Budget Connection</h2>
        <div className="settings-section-body">
          <div className="field">
            <label className="label" htmlFor="settings-budget-provider">Budget App</label>
            <select id="settings-budget-provider" className="select" value={budgetProvider} onChange={(e) => handleProviderChange(e.target.value as "ynab" | "actual")}>
              <option value="ynab">YNAB</option>
              <option value="actual">Actual Budget</option>
            </select>
          </div>

          {budgetProvider === "ynab" && (
            <>
              <div className="field">
                <label className="label" htmlFor="settings-ynab-token">API Token</label>
                <input
                  id="settings-ynab-token"
                  className="input"
                  type="password"
                  autoComplete="off"
                  value={ynabTest.state.apiKey}
                  onChange={(e) => ynabTest.setApiKey(e.target.value)}
                  placeholder={config.ynabApiKey || "Enter your YNAB API token"}
                />
              </div>
              <div className="field">
                <label className="label" htmlFor="settings-ynab-budget">Budget</label>
                <select id="settings-ynab-budget" className="select" value={ynabBudgetId} onChange={(e) => budgetAccountLoader.selectBudget(e.target.value)}>
                  {budgets.length === 0 && <option value="">No budgets found</option>}
                  {budgets.length > 0 && !budgets.some((b) => b.id === ynabBudgetId) && ynabBudgetId && (
                    <option value={ynabBudgetId}>{ynabBudgetId}</option>
                  )}
                  {budgets.map((b) => (
                    <option key={b.id} value={b.id}>{b.name}</option>
                  ))}
                </select>
              </div>
              <div className="test-connection">
                <button
                  className="btn btn-sm btn-secondary"
                  onClick={() => ynabTest.test()}
                  disabled={ynabTest.state.testing || (!ynabTest.state.apiKey && !config.ynabApiKey)}
                >
                  {ynabTest.state.testing ? "Testing..." : "Test Connection"}
                </button>
                {/* Render the test-connection outcome. If the loader
                    raised a post-test error (test passed but /accounts
                    fetch failed), show THAT error instead of the
                    success pill — same behavior as the pre-refactor
                    handleTestYnab branch (master:182). */}
                {ynabTest.state.result && (() => {
                  const loaderErr = budgetAccountLoader.state.error;
                  const success = ynabTest.state.result.success && !loaderErr;
                  const errorMsg = ynabTest.state.result.success
                    ? loaderErr
                    : ynabTest.state.result.error;
                  return (
                    <span className={`test-result ${success ? "success" : "error"}`}>
                      {success ? (
                        <>
                          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><circle cx="7" cy="7" r="6" stroke="currentColor" strokeWidth="1.5" /><path d="M4.5 7L6.5 9L9.5 5.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
                          Connected
                        </>
                      ) : (
                        <>Failed: {errorMsg}</>
                      )}
                    </span>
                  );
                })()}
              </div>
            </>
          )}

          {budgetProvider === "actual" && (
            <>
              <div className="field">
                <label className="label" htmlFor="settings-actual-url">Server URL</label>
                <input
                  id="settings-actual-url"
                  className="input"
                  value={actualTest.state.serverUrl}
                  onChange={(e) => actualTest.setServerUrl(e.target.value)}
                  placeholder="http://localhost:5006"
                  autoComplete="off"
                />
              </div>
              <div className="field">
                <label className="label" htmlFor="settings-actual-password">Password</label>
                <input
                  id="settings-actual-password"
                  className="input"
                  type="password"
                  autoComplete="current-password"
                  value={actualTest.state.password}
                  onChange={(e) => actualTest.setPassword(e.target.value)}
                  placeholder="Enter your Actual server password"
                />
              </div>
              <div className="test-connection">
                <button className="btn btn-sm btn-secondary" onClick={() => actualTest.test()} disabled={actualTest.state.testing}>
                  {actualTest.state.testing ? "Testing..." : "Test Connection"}
                </button>
                {actualTest.state.result && (() => {
                  const loaderErr = budgetAccountLoader.state.error;
                  const success = actualTest.state.result.success && !loaderErr;
                  const errorMsg = actualTest.state.result.success
                    ? loaderErr
                    : actualTest.state.result.error;
                  return (
                    <span className={`test-result ${success ? "success" : "error"}`}>
                      {success ? (
                        <>
                          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><circle cx="7" cy="7" r="6" stroke="currentColor" strokeWidth="1.5" /><path d="M4.5 7L6.5 9L9.5 5.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
                          Connected
                        </>
                      ) : (
                        <>Failed: {errorMsg}</>
                      )}
                    </span>
                  );
                })()}
              </div>
              <div className="field">
                <label className="label" htmlFor="settings-actual-budget">Budget</label>
                <select id="settings-actual-budget" className="select" value={actualSyncId} onChange={(e) => budgetAccountLoader.selectBudget(e.target.value)}>
                  {actualBudgetList.length === 0 && <option value="">No budgets found</option>}
                  {actualBudgetList.map((b) => (
                    <option key={b.id} value={b.id}>{b.name}</option>
                  ))}
                </select>
              </div>
            </>
          )}

          {/* Default Account — shared across providers, shown when a budget is selected */}
          {((budgetProvider === "ynab" && ynabBudgetId) || (budgetProvider === "actual" && actualSyncId)) && (
            <div className="field">
              <label className="label" htmlFor="settings-default-account">Default Account</label>
              <select
                id="settings-default-account"
                className="select"
                value={defaultAccount}
                onChange={(e) => budgetAccountLoader.setSelectedAccount(e.target.value)}
                disabled={loadingAccounts}
              >
                {loadingAccounts && <option value="">Loading accounts...</option>}
                {!loadingAccounts && accounts.length === 0 && <option value="">No accounts found</option>}
                {accounts.map((a) => (
                  <option key={a} value={a}>{a}</option>
                ))}
              </select>
            </div>
          )}
        </div>
      </div>

      {/* Account Visibility — shown for either provider when accounts are loaded */}
      {allAccounts.length > 0 && ((budgetProvider === "ynab" && ynabBudgetId) || (budgetProvider === "actual" && actualSyncId)) && (
      <div className="settings-section">
        <h2 className="settings-section-title">Account Visibility</h2>
        <div className="settings-section-body">
          <div className="toggle-desc" style={{ marginBottom: 12 }}>
            Uncheck accounts to hide them from the import dropdown.
          </div>
          {allAccounts.map((acct) => {
            const visible = !hiddenAccounts.includes(acct);
            return (
              <div className="toggle-row" key={acct}>
                <div className="toggle-label">{acct}</div>
                <Toggle
                  on={visible}
                  ariaLabel={`Show ${acct} in import dropdown`}
                  onChange={(on) => {
                    setHiddenAccounts((prev) =>
                      on ? prev.filter((a) => a !== acct) : [...prev, acct]
                    );
                  }}
                />
              </div>
            );
          })}
        </div>
      </div>
      )}

      {/* Folder Watcher */}
      <div className="settings-section">
        <h2 className="settings-section-title">Folder Watcher</h2>
        <div className="settings-section-body">
          <div className="field">
            <label className="label" htmlFor="settings-inbox">Inbox Folder</label>
            <input id="settings-inbox" className="input" value={inboxPath} onChange={(e) => setInboxPath(e.target.value)} />
          </div>
          <div className="field">
            <label className="label" htmlFor="settings-processed">Processed Folder</label>
            <input id="settings-processed" className="input" value={processedPath} onChange={(e) => setProcessedPath(e.target.value)} disabled={deleteAfterImport} />
          </div>
          <div className="toggle-row">
            <div>
              <div className="toggle-label">Delete source PDF after import</div>
              <div className="toggle-desc">Receipts are removed instead of archived. Reduces long-term plaintext retention of addresses, card digits, and item details.</div>
            </div>
            <Toggle
              on={deleteAfterImport}
              ariaLabel="Delete source PDF after import"
              onChange={async (on) => {
                setDeleteAfterImport(on);
                await save({ deleteAfterImport: on });
              }}
            />
          </div>
          <div className="toggle-row">
            <div>
              <div className="toggle-label">Watch inbox folder for new receipts</div>
              <div className="toggle-desc">Automatically pick up PDFs dropped into the inbox folder above</div>
            </div>
            <Toggle
              on={watcherEnabled}
              ariaLabel="Watch inbox folder for new receipts"
              onChange={async (on) => {
                setWatcherEnabled(on);
                try {
                  await apiPost(on ? "/watcher/start" : "/watcher/stop", {});
                } catch {}
                await save({ watcherEnabled: on });
              }}
            />
          </div>
          <div className="toggle-row">
            <div>
              <div className="toggle-label">Auto-import without review</div>
              <div className="toggle-desc">Skip review for files picked up from the inbox folder</div>
            </div>
            <Toggle on={autoImport} onChange={setAutoImport} ariaLabel="Auto-import without review" />
          </div>
        </div>
      </div>

      {/* App Behavior */}
      <div className="settings-section">
        <h2 className="settings-section-title">App Behavior</h2>
        <div className="settings-section-body">
          <div className="toggle-row">
            <div>
              <div className="toggle-label">Appearance</div>
              <div className="toggle-desc">Choose light, dark, or follow your system</div>
            </div>
            <div className="theme-picker">
              {(["light", "system", "dark"] as const).map((opt) => (
                <button
                  key={opt}
                  type="button"
                  className={`theme-btn${themePreference === opt ? " active" : ""}`}
                  onClick={() => onThemeChange(opt)}
                  aria-pressed={themePreference === opt}
                >
                  {opt === "light" ? (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="5"/><path d="M12 1v2m0 18v2M4.22 4.22l1.42 1.42m12.72 12.72l1.42 1.42M1 12h2m18 0h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>
                  ) : opt === "dark" ? (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/></svg>
                  ) : (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8m-4-4v4"/></svg>
                  )}
                  <span>{opt.charAt(0).toUpperCase() + opt.slice(1)}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="toggle-row">
            <div>
              <div className="toggle-label">Focus window on new receipt</div>
              <div className="toggle-desc">Bring app to front when a receipt is detected</div>
            </div>
            <Toggle on={focusWindow} onChange={setFocusWindow} ariaLabel="Focus window on new receipt" />
          </div>
          <div className="toggle-row">
            <div><div className="toggle-label">Start on login</div></div>
            <Toggle
              on={startOnLogin}
              ariaLabel="Start on login"
              onChange={(on) => {
                setStartOnLogin(on);
                setAutostart(on);
              }}
            />
          </div>
          <div className="toggle-row">
            <div><div className="toggle-label">Minimize to tray on close</div></div>
            <Toggle on={minimizeToTray} onChange={setMinimizeToTray} ariaLabel="Minimize to tray on close" />
          </div>
          <div className="toggle-row">
            <div><div className="toggle-label">Show notifications</div></div>
            <Toggle on={showNotifications} onChange={setShowNotifications} ariaLabel="Show notifications" />
          </div>
          <div className="toggle-row">
            <div>
              <div className="toggle-label">Match transactions across all accounts</div>
              <div className="toggle-desc">Search every account for a matching bank transaction, not just the default</div>
            </div>
            <Toggle on={matchAcrossAccounts} onChange={setMatchAcrossAccounts} ariaLabel="Match transactions across all accounts" />
          </div>
          <div className="toggle-row">
            <div>
              <div className="toggle-label">Distribute discounts across items</div>
              <div className="toggle-desc">Spread coupon savings proportionally across line items instead of a separate credit split</div>
            </div>
            <Toggle on={discountMode === "distribute"} onChange={(on) => setDiscountMode(on ? "distribute" : "credit")} ariaLabel="Distribute discounts across items" />
          </div>
        </div>
      </div>

      <div className="settings-save">
        <button className="btn btn-primary btn-full" onClick={handleSave} disabled={saving}>
          {saving ? "Saving..." : saved ? "Saved!" : "Save Settings"}
        </button>
        <UpdateRow appUpdate={appUpdate} />
        <div className="settings-footer-links">
          {onRunSetup && (
            <>
              <button className="btn-link" onClick={onRunSetup}>
                Re-run setup wizard
              </button>
              <span className="settings-footer-divider" aria-hidden="true">·</span>
            </>
          )}
          <button
            className="btn-link"
            onClick={async () => {
              try {
                await invoke("reveal_logs");
              } catch (e) {
                console.error("Could not reveal logs:", e);
              }
            }}
          >
            Reveal logs
          </button>
          <span className="settings-footer-divider" aria-hidden="true">·</span>
          <button
            className="btn-link"
            onClick={async () => {
              const url = "https://github.com/danifuldan/budget-itemizer/issues/new";
              try {
                const { open } = await import("@tauri-apps/plugin-shell");
                await open(url);
              } catch {
                window.open(url, "_blank", "noopener");
              }
            }}
          >
            Report a bug
          </button>
        </div>
      </div>
      </div>
    </div>
    </>
  );
}

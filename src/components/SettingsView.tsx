import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ConfigData } from "../hooks/useConfig";
import { useAppUpdate } from "../hooks/useAppUpdate";
import { APP_VERSION } from "../appVersion";
import { getAutostart, setAutostart } from "../hooks/useTauriAutostart";
import { useModelDownload } from "../hooks/useModelDownload";
import { useYnabTest } from "../hooks/useYnabTest";
import { useActualTest } from "../hooks/useActualTest";
import { useBudgetAccountLoader } from "../hooks/useBudgetAccountLoader";
import { budgetIdFieldFor, accountUpdateFor } from "../lib/budgetProvider";
import { useFocusRefresh } from "../hooks/useFocusRefresh";
import { apiFetch, apiPost, ApiError } from "../api/client";
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
  /** When opened from a status-link, scroll to this section
   *  ("folder-watcher", "ai-model"). undefined = top. */
  scrollToSection?: string;
}

/** Inline row that surfaces app-update state. Receives the hook return
 *  as a prop so the boot-time check runs at App.tsx mount, not on
 *  Settings open. The auto-check is silent on failure (no scary message
 *  when GitHub returns 404 because no manifest is published yet);
 *  manual "Check now" failures DO surface so the user knows the click
 *  did something. */
function UpdateRow({ appUpdate }: { appUpdate: ReturnType<typeof useAppUpdate> }) {
  const { available, checking, installing, error, lastCheck, check, installAndRestart } = appUpdate;
  if (available) {
    return (
      <div id="settings-update" className="settings-update-row">
        <span className="settings-update-text">
          Update available — v{available.version}
        </span>
        <button className="btn-link" onClick={installAndRestart} disabled={installing}>
          {installing ? "Installing…" : "Install & relaunch"}
        </button>
      </div>
    );
  }
  // Truthful status: a check that FAILED is never shown as "Up to date".
  // Each outcome is distinct and time-stamped so a broken updater is
  // visible (and diagnosable) instead of masquerading as success.
  const ago = (at: number): string => {
    const s = Math.max(0, Math.round((Date.now() - at) / 1000));
    if (s < 60) return "just now";
    const m = Math.round(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.round(m / 60);
    return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
  };
  let status: string;
  if (error) status = error;
  else if (checking) status = "Checking for updates…";
  else if (!lastCheck) status = "Not checked yet";
  else if (lastCheck.outcome === "up-to-date") status = `Up to date (checked ${ago(lastCheck.at)})`;
  else if (lastCheck.outcome === "no-manifest") status = `No newer release published (checked ${ago(lastCheck.at)})`;
  else if (lastCheck.outcome === "unreachable") status = `Couldn't reach update server (last tried ${ago(lastCheck.at)})`;
  else status = `Update check failed (last tried ${ago(lastCheck.at)})`;
  return (
    <div id="settings-update" className="settings-update-row">
      <span className="settings-update-text">{status}</span>
      <button className="btn-link" onClick={check} disabled={checking}>
        {checking ? "Checking…" : "Check now"}
      </button>
    </div>
  );
}

export default function SettingsView({ onBack, onRunSetup, themePreference, onThemeChange, config, configLoading: loading, saveConfig: save, appUpdate, scrollToSection }: SettingsViewProps) {
  const modelDownload = useModelDownload({ modelId: "llama3.1-8b" });

  // Deep-link from a status-link: scroll the requested section into view.
  // undefined (a plain Settings open) scrolls to the top so the view
  // isn't left wherever a previous deep-link landed.
  useEffect(() => {
    const el = scrollToSection
      ? document.getElementById(`settings-${scrollToSection}`)
      : null;
    if (!el) {
      document.querySelector(".settings-scroll")?.scrollTo({ top: 0 });
      return;
    }
    el.scrollIntoView({ behavior: "smooth", block: "start" });
    // The update row is sticky-pinned at the bottom, so it's already
    // on-screen — arriving from the gear's update dot needs an attention
    // cue, not a scroll. Self-disables under prefers-reduced-motion (the
    // global rule collapses animation duration to ~0). The
    // `appUpdate.available` gate (premortem 2026-05-26 Bug 3) guards
    // against the race where a concurrent check completes between the
    // gear click and this mount, clearing `available` so UpdateRow
    // renders its status branch — both branches share #settings-update
    // for deep-link stability, but pulsing a "Up to date" row would
    // contradict the dot the user just clicked.
    if (scrollToSection === "update" && appUpdate.available) {
      el.classList.add("deeplink-pulse");
      const t = setTimeout(() => el.classList.remove("deeplink-pulse"), 1600);
      return () => clearTimeout(t);
    }
    // appUpdate.available intentionally not in deps: the pulse is a
    // one-shot on navigation, using whichever value is current at the
    // moment scrollToSection changes. Including it would re-scroll on
    // every interval check that toggles availability.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollToSection]);

  // budgetProvider is local state because it gates the dropdown
  // visibility and the hook wiring. Single useState — not worth a hook.
  const [budgetProvider, setBudgetProvider] = useState<"ynab" | "actual">("ynab");

  // Local Actual budget list (separate from loader.budgets — the
  // YNAB-vs-Actual UIs each have their own select element that shows
  // either YNAB or Actual budgets, not both).
  const [actualBudgetList, setActualBudgetList] = useState<{ id: string; name: string }[]>([]);

  // Non-empty when the most recent /budgets fetch failed, so the dropdown
  // shows "couldn't load" rather than a misleading empty "No budgets found".
  const [budgetsError, setBudgetsError] = useState("");

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
  const savedAccountId = savedProvider === "actual" ? config.actualAccountId : config.ynabAccountId;
  const budgetAccountLoader = useBudgetAccountLoader({
    budgetIdField: budgetIdFieldFor(budgetProvider),
    loadAllAccounts: true,
    initialSelectedBudgetId: savedBudgetId || "",
    initialSelectedAccount: savedAccountId || "",
  });

  // Resync the Default Account + Account Visibility lists when the user
  // returns to the app while Settings is open (the Visibility list has no
  // dropdown-open hook to hang a refresh on). Throttled; only when a
  // budget is selected. Landing on Settings is already covered by the
  // mount effect's refreshAccounts().
  useFocusRefresh(() => {
    if (budgetAccountLoader.state.selectedBudgetId) budgetAccountLoader.refreshAccounts();
  }, 30_000);

  const ynabTest = useYnabTest({
    onTested: async (result) => {
      if (!result.success || !result.budgets) return;
      budgetAccountLoader.setBudgets(result.budgets);
      setBudgetsError(""); // a successful test recovered the budget list
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
    initialPasswordPlaceholder: "",
    onTested: async (result, budgets) => {
      if (!result.success || budgets.length === 0) return;
      setActualBudgetList(budgets);
      setBudgetsError(""); // a successful test recovered the budget list
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

  // Monotonic token so a stale /budgets response (from a prior provider
  // switch) can't overwrite the current provider's budget list.
  const budgetsInflight = useRef(0);

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
    // hiddenAccounts state tracks the ACTIVE provider's list (the visibility
    // section only ever shows the active provider's accounts).
    setHiddenAccounts(
      (config.budgetProvider || "ynab") === "actual"
        ? config.actualHiddenAccounts || []
        : config.ynabHiddenAccounts || [],
    );
    getAutostart().then(setStartOnLogin);

    // Pre-populate the budget dropdown so the user sees their saved
    // budget by name (not just id) before clicking Test Connection.
    primeBudgets(config.budgetProvider || "ynab");

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

  // Fetch the ACTIVE provider's budgets so the dropdown renders saved
  // budgets by name (not raw id) without a Test Connection click. /budgets
  // resolves against the backend's active provider (getBudgetProvider), so
  // callers must ensure config.budgetProvider is already updated first, and
  // we route the result into the matching dropdown source (the ynab loader
  // vs actualBudgetList). Fails silently when creds aren't set yet — the
  // first-run state where the wizard hasn't completed.
  const primeBudgets = (provider: "ynab" | "actual") => {
    // Clear any prior error up front so a failed provider's message can't
    // linger under a newly-active healthy provider while its fetch is in
    // flight (budgetsError is shared across both provider blocks).
    setBudgetsError("");
    // /budgets resolves against the backend's *live* provider, so a slow
    // response from a prior switch could land after a newer switch and
    // write the wrong provider's budgets. Drop stale responses via a
    // monotonic token (same guard the loader uses for /accounts).
    const token = ++budgetsInflight.current;
    // Query the provider explicitly so the read targets it regardless of the
    // backend's global config.budgetProvider (which a concurrent switch may
    // not have updated yet) — no cross-provider list under a rapid switch.
    apiFetch<{ id: string; name: string }[]>(`/budgets?provider=${provider}`)
      .then((data) => {
        if (budgetsInflight.current !== token) return;
        if (provider === "ynab") budgetAccountLoader.setBudgets(data);
        else setActualBudgetList(data);
        setBudgetsError("");
      })
      .catch(() => {
        if (budgetsInflight.current !== token) return;
        // Don't leave the user staring at "No budgets found" for a fetch
        // that actually failed — Test Connection re-fetches with the
        // entered creds, so point them there.
        setBudgetsError("Couldn't load budgets. Test Connection to retry.");
      });
  };

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
    // Restore the new provider's OWN saved account id, not the prior
    // provider's (the import target is per-provider now).
    const restoredAccountId = provider === "actual"
      ? (config.actualAccountId || "")
      : (config.ynabAccountId || "");
    budgetAccountLoader.setSelectedBudgetId(restoredBudgetId);
    budgetAccountLoader.setSelectedAccount(restoredAccountId);
    // Swap the visibility list to the new provider's so the toggle section
    // (and the next Save) operate on ITS hidden accounts, not the prior
    // provider's.
    setHiddenAccounts(provider === "actual" ? (config.actualHiddenAccounts || []) : (config.ynabHiddenAccounts || []));
    // The switch write can fail two very different ways, and they must NOT be
    // treated alike:
    //   1. Benign disruption — the write commits (200), but tearing down the
    //      prior budget connection ("Closing budget") truncates the response
    //      body, so apiPost's res.json() rejects with a PARSE error (not an
    //      ApiError). The backend IS on the new provider; the reload below
    //      reads it explicitly (?provider=), so we swallow and continue.
    //   2. Genuine failure — a non-2xx (ApiError). saveConfig ran AFTER the
    //      teardown on the server, so a non-2xx means the write did NOT commit
    //      and the backend is STILL on the old provider. Priming the new
    //      provider's data here would show a phantom switch. Surface it and
    //      stop, leaving the user on the new provider's block to fix creds and
    //      Test Connection.
    try {
      await apiPost("/config", { budgetProvider: provider });
    } catch (err) {
      if (err instanceof ApiError) {
        setBudgetsError("Couldn't switch budget app. Check the connection and Test Connection to retry.");
        return;
      }
      // else: benign body-disruption on a committed write — fall through.
    }
    // Backend is now on the new provider, so re-fetch ITS budgets (and,
    // if one is saved, accounts) — the mount-time prime only ran for the
    // provider that was active when Settings opened. Without this the
    // budget select falls back to the raw saved id until Test Connection.
    primeBudgets(provider);
    // Pass the saved account AND the target provider explicitly: the account
    // pins the selection (a concurrent refresh can't reassign the import
    // target), and the provider makes /accounts read THIS provider regardless
    // of the backend's global flag — together they close the rapid-switch
    // read race for both the selection and the account list.
    if (restoredBudgetId) budgetAccountLoader.refreshAccounts(restoredAccountId, provider);
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
      // Identity is the id; the display name is persisted alongside (readable
      // config; isSetupComplete accepts id OR name). Per-provider via the
      // shared helper — writes ONLY the active provider's account fields, so a
      // save can't clobber the other provider's import target (non-active
      // fields are omitted and saveConfig merges).
      ...accountUpdateFor(
        budgetProvider,
        selectedAccountId,
        (allAccounts.find((a) => a.id === selectedAccountId)
          ?? accounts.find((a) => a.id === selectedAccountId))?.name
          ?? (budgetProvider === "actual" ? config.actualDefaultAccount : config.ynabDefaultAccount),
      ),
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
      // Persist the visibility list to the ACTIVE provider's field only; the
      // other provider's field stays untouched (saveConfig merges), so a
      // YNAB save can't wipe Actual's hidden accounts or vice versa.
      ...(budgetProvider === "actual"
        ? { actualHiddenAccounts: hiddenAccounts }
        : { ynabHiddenAccounts: hiddenAccounts }),
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
        <TitlebarRegion />
        <div className="review-toolbar settings-subheader">
          <button className="btn-ghost" onClick={onBack}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10 3L5 8l5 5" />
            </svg>
            Back
          </button>
          <h1 className="settings-header-title">Settings</h1>
        </div>
      </div>
    );
  }

  const ynabBudgetId = budgetProvider === "ynab" ? budgetAccountLoader.state.selectedBudgetId : "";
  const actualSyncId = budgetProvider === "actual" ? budgetAccountLoader.state.selectedBudgetId : "";
  const selectedAccountId = budgetAccountLoader.state.selectedAccount;
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
      <TitlebarRegion />
      <div className="review-toolbar settings-subheader">
        <button className="btn-ghost" onClick={onBack}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M10 3L5 8l5 5" />
          </svg>
          Back
        </button>
        <h1 className="settings-header-title">Settings</h1>
      </div>

      <div className="settings-scroll">
      {/* AI Model */}
      <div className="settings-section" id="settings-ai-model">
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
                    // The loaded budget list doesn't contain the saved id
                    // (renamed/deleted budget, or wrong account). We have no
                    // name to show — surface that honestly instead of
                    // leaking the raw UUID into the UI.
                    <option value={ynabBudgetId}>Saved budget not found</option>
                  )}
                  {budgets.map((b) => (
                    <option key={b.id} value={b.id}>{b.name}</option>
                  ))}
                </select>
                {budgetsError && budgets.length === 0 && <span className="test-result error">{budgetsError}</span>}
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
                  placeholder={config.actualPasswordLength ? "•".repeat(config.actualPasswordLength) : "Enter your Actual server password"}
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
                {budgetsError && actualBudgetList.length === 0 && <span className="test-result error">{budgetsError}</span>}
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
                value={selectedAccountId}
                onChange={(e) => budgetAccountLoader.setSelectedAccount(e.target.value)}
                onMouseDown={() => { if (budgetAccountLoader.state.selectedBudgetId) budgetAccountLoader.refreshAccounts(); }}
                // Disable ONLY during the initial load (no accounts yet). Using
                // bare loadingAccounts deadlocked the dropdown: onMouseDown fires
                // a refresh → loadingAccounts=true → the select disables itself
                // the instant you click it, so it can never open to pick another
                // account. Once accounts are present, a refresh must not disable.
                disabled={loadingAccounts && accounts.length === 0}
              >
                {loadingAccounts && <option value="">Loading accounts...</option>}
                {!loadingAccounts && accounts.length === 0 && <option value="">No accounts found</option>}
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
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
            const visible = !hiddenAccounts.includes(acct.id);
            return (
              <div className="toggle-row" key={acct.id}>
                <div className="toggle-label">{acct.name}</div>
                <Toggle
                  on={visible}
                  ariaLabel={`Show ${acct.name} in import dropdown`}
                  onChange={(on) => {
                    setHiddenAccounts((prev) =>
                      on ? prev.filter((a) => a !== acct.id) : [...prev, acct.id]
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
      <div className="settings-section" id="settings-folder-watcher">
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
              <div className="toggle-label">Enable background monitoring for inbox folder</div>
            </div>
            <Toggle
              on={watcherEnabled}
              ariaLabel="Enable background monitoring for inbox folder"
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
              <div className="toggle-desc">Skip review for files from inbox folder</div>
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
        <div className="settings-version" aria-label={`Budget Itemizer version ${APP_VERSION}`}>
          Budget Itemizer v{APP_VERSION}
        </div>
      </div>
      </div>
    </div>
    </>
  );
}

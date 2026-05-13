import { useState, useEffect } from "react";
import { useSetup } from "../hooks/useSetup";
import { useModelDownload } from "../hooks/useModelDownload";
import { useYnabTest } from "../hooks/useYnabTest";
import { useActualTest } from "../hooks/useActualTest";
import { useBudgetAccountLoader } from "../hooks/useBudgetAccountLoader";
import { apiFetch } from "../api/client";
import TitlebarRegion from "./TitlebarRegion";
import ConfirmDialog from "./ConfirmDialog";
import ModelDownloadCard from "./ModelDownloadCard";

// Deep-links into specific FAQ answers in the README so "Why?" lands the
// user on the right answer instead of the top of the FAQ section. GitHub
// auto-generates anchors from the heading text — keep these in sync with
// the README headings if their wording changes.
const README_YNAB_CREDENTIALS_URL =
  "https://github.com/danifuldan/budget-itemizer#is-it-safe-to-paste-my-ynab-api-token-here";
const README_ACTUAL_CREDENTIALS_URL =
  "https://github.com/danifuldan/budget-itemizer#why-does-budget-itemizer-need-my-actual-budget-password";
const YNAB_TOKEN_URL = "https://app.ynab.com/settings/developer";
const LLAMA_INFO_URL = "https://www.llama.com/";

async function openExternal(url: string) {
  try {
    const { open } = await import("@tauri-apps/plugin-shell");
    await open(url);
  } catch {
    // Fallback for non-Tauri (dev) context
    window.open(url, "_blank", "noopener");
  }
}

interface SetupWizardProps {
  onComplete: () => void;
  onSkip?: () => void;
}

export default function SetupWizard({ onComplete, onSkip }: SetupWizardProps) {
  const [step, setStep] = useState(0);
  const { saveSetup } = useSetup();

  // Budget/account loader feeds both Test-Connection callbacks (for
  // seeding the budget list + auto-fetching accounts) and the step-4
  // dropdowns. Declared first so the test hooks below can reference it
  // in their onTested callbacks.
  const budgetAccountLoader = useBudgetAccountLoader({
    budgetIdField: "ynabBudgetId",
    loadAllAccounts: false,
  });

  const modelDownload = useModelDownload({
    modelId: "llama3.1-8b",
    embeddedModelInConfig: "llama3.1-8b",
    onActivated: async () => {
      // After /models/activate succeeds, persist the config so the next
      // app launch knows which model to start. Failing here propagates
      // back to useModelDownload, which keeps `done = false` and surfaces
      // the error — Next button stays disabled.
      const ok = await saveSetup({ embeddedModel: "llama3.1-8b" });
      if (!ok) throw new Error("Save failed");
    },
  });

  const ynabTest = useYnabTest({
    onTested: async (result) => {
      if (!result.success || !result.budgets) return;
      budgetAccountLoader.setBudgets(result.budgets);
      // Seed the first budget id so step 4 has something selected and
      // /accounts gets a budget to read against.
      const currentSelection = budgetAccountLoader.state.selectedBudgetId;
      const budgetId = currentSelection || result.budgets[0]?.id;
      if (budgetId) {
        await budgetAccountLoader.selectBudget(budgetId);
      }
    },
  });

  const actualTest = useActualTest({
    onTested: async (result, budgets) => {
      if (!result.success || budgets.length === 0) return;
      budgetAccountLoader.setBudgets(budgets);
      const currentSelection = budgetAccountLoader.state.selectedBudgetId;
      const budgetId = currentSelection || budgets[0]?.id;
      if (budgetId) {
        await budgetAccountLoader.selectBudget(budgetId);
      }
    },
  });

  // Step 2: Budget Provider
  const [budgetProvider, setBudgetProvider] = useState<"ynab" | "actual">("ynab");

  // Surfaces a save-setup failure so the user knows why Next didn't
  // advance. Cleared on every Next attempt and on field edits.
  const [advanceError, setAdvanceError] = useState<string | null>(null);

  // Step 5: Folders
  const [inboxPath, setInboxPath] = useState("~/Receipts/inbox");
  const [processedPath, setProcessedPath] = useState("~/Receipts/processed");

  // Banner: shown when sidecar found a corrupt config.json on boot and
  // fell back to defaults. We tell the user up-front instead of letting
  // them think they're seeing the wizard for unrelated reasons.
  const [configWasReset, setConfigWasReset] = useState(false);

  // Pre-populate from existing config (folder paths + banner). Model and
  // YNAB seeding live in their respective hooks now. We still hit
  // /setup/status here for the rest.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await apiFetch<{
          configWasReset: boolean;
          config?: any;
        }>("/setup/status");
        if (cancelled) return;
        if (data.configWasReset) setConfigWasReset(true);
        const c = data.config;
        if (!c) return;
        if (c.inboxPath) setInboxPath(c.inboxPath);
        if (c.processedPath) setProcessedPath(c.processedPath);

        // If there's already a saved YNAB key, surface the existing
        // budget list + accounts so the user doesn't have to re-test
        // before they can navigate back to step 4 mid-flow.
        if (c.hasYnabApiKey) {
          const res = await ynabTest.test();
          if (cancelled) return;
          if (res.success && c.ynabBudgetId) {
            // selectBudget already auto-fires for the first budget via
            // onTested. If the user's saved choice differs, switch.
            if (c.ynabBudgetId !== budgetAccountLoader.state.selectedBudgetId) {
              await budgetAccountLoader.selectBudget(c.ynabBudgetId);
            }
            if (c.defaultAccount) {
              budgetAccountLoader.setSelectedAccount(c.defaultAccount);
            }
          }
        }
      } catch {
        // Silent — wizard will just show empty fields, which is the
        // first-run state.
      }
    })();
    return () => { cancelled = true; };
    // Mount-once: re-running this effect would clobber in-flight user
    // edits (e.g. re-fire ynabTest after the user has already pasted
    // a new key).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const TOTAL_STEPS = 7;

  const handleTestYnab = async () => {
    await ynabTest.test();
  };

  const handleTestActual = async () => {
    await actualTest.test();
  };

  const goNext = async () => {
    // Save relevant fields before advancing. Critically, we check the
    // return value — saveSetup swallows errors and returns false, and a
    // pre-fix bug here advanced the wizard regardless. Users who hit a
    // network blip mid-wizard would finish with un-persisted fields and
    // not discover until next launch.
    setAdvanceError(null);
    let ok = true;
    switch (step) {
      case 1:
        ok = await saveSetup({ embeddedModel: "llama3.1-8b" });
        break;
      case 2:
        ok = await saveSetup({ budgetProvider });
        break;
      case 3:
        if (budgetProvider === "ynab") {
          ok = await saveSetup({ ynabApiKey: ynabTest.state.apiKey });
        } else {
          ok = await saveSetup({
            actualServerUrl: actualTest.state.serverUrl,
            actualPassword: actualTest.state.password,
          });
        }
        break;
      case 4:
        ok = await saveSetup({
          ynabBudgetId: budgetAccountLoader.state.selectedBudgetId,
          defaultAccount: budgetAccountLoader.state.selectedAccount,
        });
        break;
      case 5:
        ok = await saveSetup({ inboxPath, processedPath });
        break;
    }
    if (!ok) {
      setAdvanceError("Couldn't save your settings. Check your connection and try again.");
      return;
    }
    setStep((s) => s + 1);
  };

  const goBack = () => setStep((s) => s - 1);

  const budgets = budgetAccountLoader.state.budgets;
  const selectedBudget = budgetAccountLoader.state.selectedBudgetId;
  const accounts = budgetAccountLoader.state.accounts;
  const selectedAccount = budgetAccountLoader.state.selectedAccount;
  const loadingAccounts = budgetAccountLoader.state.loadingAccounts;
  const ynabResult = ynabTest.state.result;
  const ynabKey = ynabTest.state.apiKey;
  const testing = ynabTest.state.testing;
  const actualServerUrl = actualTest.state.serverUrl;
  const actualPassword = actualTest.state.password;
  const actualTestResult = actualTest.state.result;
  const actualTesting = actualTest.state.testing;

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
    <div className="wizard">
      <TitlebarRegion />
      <ol className="wizard-steps" aria-label="Setup progress">
        {Array.from({ length: TOTAL_STEPS }).map((_, i) => (
          <li
            key={i}
            className={`wizard-dot${i === step ? " active" : ""}${i < step ? " done" : ""}`}
            aria-current={i === step ? "step" : undefined}
          >
            <span className="visually-hidden">
              Step {i + 1} of {TOTAL_STEPS}
              {i === step ? " (current)" : i < step ? " (complete)" : ""}
            </span>
          </li>
        ))}
      </ol>

      {step === 0 && configWasReset && (
        <div className="wizard-banner-warning" role="alert">
          Your settings file was corrupted, so we started fresh. (Receipts and YNAB data are safe.) Please reconfigure your settings.
        </div>
      )}
      {advanceError && (
        <div className="wizard-banner-warning" role="alert">
          {advanceError}
        </div>
      )}
      {step === 0 && (
        <div className="wizard-card animate-in">
          <div className="wizard-icon" aria-hidden="true">
            <svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="5" y="2" width="18" height="24" rx="2" />
              <line x1="9" y1="8" x2="19" y2="8" />
              <line x1="9" y1="12" x2="19" y2="12" />
              <line x1="9" y1="16" x2="15" y2="16" />
            </svg>
          </div>
          <h1 className="wizard-title">Welcome to Budget Itemizer</h1>
          <div className="wizard-subtitle">
            Split your receipts into budget categories automatically (tested most with Amazon, Walmart, and Costco).
            Drop a PDF, review the items, and import — all on your machine.
          </div>
          <button className="btn btn-primary btn-full" onClick={() => setStep(1)}>
            Get Started
          </button>
          {onSkip && (
            <button className="btn-link" onClick={onSkip} style={{ marginTop: 16, fontSize: 12 }}>
              Skip setup
            </button>
          )}
        </div>
      )}

      {step === 1 && (
        <div className="wizard-card animate-in">
          <div className="wizard-icon" aria-hidden="true">
            <svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="14" cy="14" r="10" />
              <path d="M14 8v4l3 3" />
            </svg>
          </div>
          <h1 className="wizard-title">AI Setup</h1>
          <div className="wizard-subtitle">
            Downloads <a
              className="help-link"
              href={LLAMA_INFO_URL}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => { e.preventDefault(); openExternal(LLAMA_INFO_URL); }}
            >Llama 3.1 8B by Meta</a> — an open 4.9 GB language model that runs entirely on your machine.
          </div>

          <ModelDownloadCard
            download={modelDownload}
            variant="wizard"
            statusAnnouncerId="setup-download-status"
            showInstalledRow
          />

          <div className="wizard-nav">
            <button className="btn btn-secondary" onClick={goBack}>Back</button>
            <button className="btn btn-primary" onClick={goNext} disabled={!modelDownload.state.done}>Next</button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="wizard-card animate-in">
          <div className="wizard-icon" aria-hidden="true">
            <svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="6" width="22" height="16" rx="2" />
              <line x1="3" y1="12" x2="25" y2="12" />
            </svg>
          </div>
          <h1 className="wizard-title">Choose Budget App</h1>
          <div className="wizard-subtitle">Which budgeting app do you use?</div>
          <div className="field" style={{ textAlign: "left" }}>
            <label className="label" htmlFor="setup-budget-provider">Budget app</label>
            <select
              id="setup-budget-provider"
              className="select"
              value={budgetProvider}
              onChange={(e) => setBudgetProvider(e.target.value as "ynab" | "actual")}
            >
              <option value="ynab">YNAB</option>
              <option value="actual">Actual Budget</option>
            </select>
          </div>
          <div className="wizard-nav">
            <button className="btn btn-secondary" onClick={goBack}>Back</button>
            <button className="btn btn-primary" onClick={goNext}>Next</button>
          </div>
        </div>
      )}

      {step === 3 && budgetProvider === "ynab" && (
        <div className="wizard-card animate-in">
          <div className="wizard-icon" aria-hidden="true">
            <svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10 4h8l6 6v14a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2h4z" />
              <polyline points="18 4 18 10 24 10" />
            </svg>
          </div>
          <h1 className="wizard-title">Connect to YNAB</h1>
          <div className="wizard-subtitle">Your token is stored in the macOS Keychain and only sent to YNAB itself.</div>
          <div className="field" style={{ textAlign: "left" }}>
            <div className="field-label-row">
              <label className="label" htmlFor="setup-ynab-token">API Token</label>
              <div className="field-help">
                <a
                  className="help-link"
                  href={YNAB_TOKEN_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => { e.preventDefault(); openExternal(YNAB_TOKEN_URL); }}
                >
                  Get YNAB token <span className="help-link-icon" aria-hidden="true">↗</span>
                </a>
                <a
                  className="help-link"
                  href={README_YNAB_CREDENTIALS_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => { e.preventDefault(); openExternal(README_YNAB_CREDENTIALS_URL); }}
                >
                  Why? <span className="help-link-icon" aria-hidden="true">↗</span>
                </a>
              </div>
            </div>
            <input
              id="setup-ynab-token"
              className="input"
              type="password"
              value={ynabKey}
              onChange={(e) => ynabTest.setApiKey(e.target.value)}
              placeholder="Paste your YNAB personal access token"
              autoComplete="off"
            />
          </div>
          <div className="test-connection">
            <button className="btn btn-sm btn-secondary" onClick={handleTestYnab} disabled={testing || !ynabKey}>
              {testing ? "Testing..." : "Test Connection"}
            </button>
            {ynabResult && (
              <span className={`test-result ${ynabResult.success ? "success" : "error"}`}>
                {ynabResult.success ? (
                  <>
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><circle cx="7" cy="7" r="6" stroke="currentColor" strokeWidth="1.5" /><path d="M4.5 7L6.5 9L9.5 5.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
                    Connected ({ynabResult.budgets?.length ?? 0} budgets)
                  </>
                ) : (
                  <>Failed: {ynabResult.error}</>
                )}
              </span>
            )}
          </div>
          <div className="wizard-nav">
            <button className="btn btn-secondary" onClick={goBack}>Back</button>
            <button className="btn btn-primary" onClick={goNext}>Next</button>
          </div>
        </div>
      )}

      {step === 3 && budgetProvider === "actual" && (
        <div className="wizard-card animate-in">
          <div className="wizard-icon" aria-hidden="true">
            <svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10 4h8l6 6v14a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2h4z" />
              <polyline points="18 4 18 10 24 10" />
            </svg>
          </div>
          <h1 className="wizard-title">Connect to Actual Budget</h1>
          <div className="wizard-subtitle">Your password is stored in the macOS Keychain and only sent to your Actual server.</div>
          <div className="field" style={{ textAlign: "left" }}>
            <label className="label" htmlFor="setup-actual-url">Server URL</label>
            <input
              id="setup-actual-url"
              className="input"
              value={actualServerUrl}
              onChange={(e) => actualTest.setServerUrl(e.target.value)}
              placeholder="http://localhost:5006"
              autoComplete="off"
            />
          </div>
          <div className="field" style={{ textAlign: "left" }}>
            <div className="field-label-row">
              <label className="label" htmlFor="setup-actual-password">Password</label>
              <div className="field-help">
                <a
                  className="help-link"
                  href={README_ACTUAL_CREDENTIALS_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => { e.preventDefault(); openExternal(README_ACTUAL_CREDENTIALS_URL); }}
                >
                  Why? <span className="help-link-icon" aria-hidden="true">↗</span>
                </a>
              </div>
            </div>
            <input
              id="setup-actual-password"
              className="input"
              type="password"
              value={actualPassword}
              onChange={(e) => actualTest.setPassword(e.target.value)}
              placeholder="Your Actual Budget password"
              autoComplete="current-password"
            />
          </div>
          <div className="test-connection">
            <button className="btn btn-sm btn-secondary" onClick={handleTestActual} disabled={actualTesting || !actualServerUrl}>
              {actualTesting ? "Testing..." : "Test Connection"}
            </button>
            {actualTestResult && (
              <span className={`test-result ${actualTestResult.success ? "success" : "error"}`}>
                {actualTestResult.success ? (
                  <>
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><circle cx="7" cy="7" r="6" stroke="currentColor" strokeWidth="1.5" /><path d="M4.5 7L6.5 9L9.5 5.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
                    Connected
                  </>
                ) : (
                  <>Failed: {actualTestResult.error}</>
                )}
              </span>
            )}
          </div>
          <div className="wizard-nav">
            <button className="btn btn-secondary" onClick={goBack}>Back</button>
            <button className="btn btn-primary" onClick={goNext}>Next</button>
          </div>
        </div>
      )}

      {step === 4 && (
        <div className="wizard-card animate-in">
          <div className="wizard-icon" aria-hidden="true">
            <svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="6" width="22" height="16" rx="2" />
              <line x1="3" y1="12" x2="25" y2="12" />
            </svg>
          </div>
          <h1 className="wizard-title">Default Account</h1>
          <div className="wizard-subtitle">Choose which budget and account receipts import to.</div>
          <div className="field" style={{ textAlign: "left" }}>
            <label className="label" htmlFor="setup-budget">Budget</label>
            <select
              id="setup-budget"
              className="select"
              value={selectedBudget}
              onChange={(e) => budgetAccountLoader.selectBudget(e.target.value)}
            >
              {budgets.length === 0 && <option value="">Select a budget...</option>}
              {budgets.map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
          </div>
          <div className="field" style={{ textAlign: "left" }}>
            <label className="label" htmlFor="setup-default-account">Default Account</label>
            <select
              id="setup-default-account"
              className="select"
              value={selectedAccount}
              onChange={(e) => budgetAccountLoader.setSelectedAccount(e.target.value)}
              disabled={loadingAccounts || accounts.length === 0}
            >
              {accounts.length === 0 && <option value="">{loadingAccounts ? "Loading..." : "Select budget first"}</option>}
              {accounts.map((a) => (
                <option key={a} value={a}>{a}</option>
              ))}
            </select>
          </div>
          <div className="wizard-nav">
            <button className="btn btn-secondary" onClick={goBack}>Back</button>
            <button className="btn btn-primary" onClick={goNext}>Next</button>
          </div>
        </div>
      )}

      {step === 5 && (
        <div className="wizard-card animate-in">
          <div className="wizard-icon" aria-hidden="true">
            <svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 6a2 2 0 012-2h5l2 2h9a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2V6z" />
            </svg>
          </div>
          <h1 className="wizard-title">Receipt Folders</h1>
          <div className="wizard-subtitle">New files dropped in the inbox are detected automatically.</div>
          <div className="field" style={{ textAlign: "left" }}>
            <label className="label" htmlFor="setup-inbox">Inbox Folder</label>
            <input
              id="setup-inbox"
              className="input"
              value={inboxPath}
              onChange={(e) => setInboxPath(e.target.value)}
              placeholder="~/Receipts/inbox"
            />
          </div>
          <div className="field" style={{ textAlign: "left" }}>
            <label className="label" htmlFor="setup-processed">Processed Folder</label>
            <input
              id="setup-processed"
              className="input"
              value={processedPath}
              onChange={(e) => setProcessedPath(e.target.value)}
              placeholder="~/Receipts/processed"
            />
          </div>
          <div className="wizard-nav">
            <button className="btn btn-secondary" onClick={goBack}>Back</button>
            <button className="btn btn-primary" onClick={goNext}>Next</button>
          </div>
        </div>
      )}

      {step === 6 && (
        <div className="wizard-card animate-in">
          <div className="wizard-icon" aria-hidden="true">
            <svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M8 14l4 4 8-8" />
            </svg>
          </div>
          <h1 className="wizard-title">You're all set</h1>
          <div className="wizard-subtitle">Budget Itemizer is ready.</div>
          <div className="check-list">
            <div className="check-item">
              <div className="check-icon">&#10003;</div>
              AI model ready
            </div>
            <div className="check-item">
              <div className="check-icon">&#10003;</div>
              {budgetProvider === "ynab" ? "Connected to YNAB" : "Connected to Actual Budget"}
            </div>
            <div className="check-item">
              <div className="check-icon">&#10003;</div>
              Watching {inboxPath}
            </div>
          </div>
          <button className="btn btn-primary btn-full" onClick={onComplete}>
            Start Using Budget Itemizer
          </button>
        </div>
      )}
    </div>
    </>
  );
}

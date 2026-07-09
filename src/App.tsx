import { useReducer, useEffect, useCallback, useState, useRef } from "react";
import { apiPost, initFailure, uploadToInbox } from "./api/client";
import type { ReceiptLineItem, SSEHeader, SSEItem, SSETotal, Receipt, ImportRecord, AccountRef } from "./api/types";
import { useHistory } from "./hooks/useHistory";
import { useStatus } from "./hooks/useStatus";
import { useAccounts } from "./hooks/useAccounts";
import { useFocusRefresh } from "./hooks/useFocusRefresh";
import { useCategories } from "./hooks/useCategories";
import { useReceiptStream } from "./hooks/useReceiptStream";
import DropZone from "./components/DropZone";
import HistoryList from "./components/HistoryList";
import PendingList from "./components/PendingList";
import StatusBar from "./components/StatusBar";
import ProgressTicker from "./components/ProgressTicker";
import ReviewHeader from "./components/ReviewHeader";
import ItemsCard from "./components/ItemsCard";
import ReviewFooter from "./components/ReviewFooter";
import SetupWizard from "./components/SetupWizard";
import SettingsView from "./components/SettingsView";
import ErrorBanner from "./components/ErrorBanner";
import WarningBanner from "./components/WarningBanner";
import SplashScreen from "./components/SplashScreen";
import LlmStartErrorScreen from "./components/LlmStartErrorScreen";
import { useWatcherEvents, type ParseProgressEvent } from "./hooks/useWatcherEvents";
import { usePendingFiles } from "./hooks/usePendingFiles";
import { useWatcherNotifications, sendNotification } from "./hooks/useWatcherNotifications";
import { useConfig } from "./hooks/useConfig";
import { useAppUpdate } from "./hooks/useAppUpdate";
import { useTrayClose } from "./hooks/useTrayClose";
import { useDarkMode } from "./hooks/useDarkMode";
import TitlebarRegion from "./components/TitlebarRegion";

// --- State types ---

type View = "main" | "review" | "imported" | "setup" | "settings";

export interface AppState {
  view: View;
  merchant: string;
  transactionDate: string;
  totalAmount: number;
  tax: number;
  shipping: number;
  fees: number;
  discount: number;
  credit: number;
  creditLabel?: string;
  refund: number;
  items: ReceiptLineItem[];
  streamStatus: string;
  streamDone: boolean;
  selectedAccount: string;
  /** True when selectedAccount was auto-filled as a placeholder (first
   *  account) because no real default was known yet. A later real
   *  default id corrects a provisional pick; a user pick clears it and
   *  is never overridden. Fixes the post-upgrade ordering where
   *  ynabAccountId is persisted asynchronously after /accounts resolves. */
  accountIsProvisional: boolean;
  importing: boolean;
  error: string | null;
  lastFile: File | null;
  setupDismissed: boolean;
  sourceFilename: string | null;
  /** Set only when the review screen was opened from a HISTORY record
   *  (vs a pending/streamed file). Drives which delete route Discard
   *  uses — see discardTargetFor. null for pending/streamed receipts. */
  historyId: string | null;
  /** When navigating to Settings via a status-link, the section to scroll
   *  to (e.g. "folder-watcher", "ai-model"). undefined = top. */
  settingsSection?: string;
}

export type AppAction =
  | { type: "START_STREAM"; file: File }
  | { type: "SET_STATUS"; step: string }
  | { type: "SET_HEADER"; header: SSEHeader }
  | { type: "ADD_ITEM"; item: SSEItem }
  | { type: "SET_TOTAL"; totals: SSETotal }
  | { type: "SET_CATEGORIES"; categories: Record<string, string> | string[] }
  | { type: "STREAM_DONE"; receipt: Receipt }
  | { type: "STREAM_ERROR"; error: string }
  | { type: "DELETE_ITEM"; index: number }
  | { type: "UPDATE_ITEM_CATEGORY"; index: number; category: string }
  | { type: "UPDATE_ITEM_NAME"; index: number; name: string }
  | { type: "UPDATE_ITEM_AMOUNT"; index: number; amount: number }
  | { type: "UPDATE_FIELD"; field: "merchant" | "transactionDate" | "selectedAccount"; value: string }
  | { type: "SET_ACCOUNT"; account: string }
  | { type: "START_IMPORT" }
  | { type: "IMPORT_SUCCESS" }
  | { type: "RESET" }
  | { type: "NAVIGATE"; view: View; settingsSection?: string }
  | { type: "DISMISS_SETUP" }
  | { type: "SET_SOURCE_FILE"; filename: string }
  | { type: "LOAD_RECEIPT"; receipt: Receipt; sourceFilename: string; historyId?: string }
  | { type: "RECEIPT_READY_FOR_PENDING"; filename: string; receipt: Receipt }
  | { type: "ACCOUNTS_LOADED"; accounts: AccountRef[]; defaultAccountId: string }
  | { type: "APPLY_PARSE_PROGRESS_EVENT"; event: ParseProgressEvent }
  | { type: "LOAD_BUFFERED_PROGRESS"; filename: string; events: ParseProgressEvent[] };

export const initialState: AppState = {
  view: "main",
  merchant: "",
  transactionDate: "",
  totalAmount: 0,
  tax: 0,
  shipping: 0,
  fees: 0,
  discount: 0,
  credit: 0,
  creditLabel: undefined,
  refund: 0,
  items: [],
  streamStatus: "",
  streamDone: false,
  selectedAccount: "",
  accountIsProvisional: false,
  importing: false,
  error: null,
  lastFile: null,
  setupDismissed: false,
  sourceFilename: null,
  historyId: null,
};

/** Single source of truth for where an in-review Discard sends its
 *  delete. A receipt opened from history must go to DELETE /history/{id};
 *  a pending/streamed one to the pending-watcher delete. The decision
 *  used to live as an inline JSX ternary that only knew sourceFilename
 *  (which both origins set), so history discards 404'd silently. */
export type DiscardTarget =
  | { kind: "history"; id: string }
  | { kind: "pending"; filename: string };

export function discardTargetFor(state: AppState): DiscardTarget | null {
  if (state.historyId) return { kind: "history", id: state.historyId };
  if (state.sourceFilename) return { kind: "pending", filename: state.sourceFilename };
  return null;
}

export function reducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case "START_STREAM":
      // Preserve the resolved account across the reset, exactly like the
      // other review-entry cases (RECEIPT_READY_FOR_PENDING,
      // LOAD_BUFFERED_PROGRESS). Without this, a direct in-app parse wipes
      // selectedAccount to "" — the picker still shows the first account
      // (native <select> default) but the Import gate sees no selection, so
      // the user must re-pick an already-shown account before importing.
      return {
        ...initialState,
        view: "review",
        streamStatus: "reading-pdf",
        lastFile: action.file,
        sourceFilename: state.sourceFilename,
        selectedAccount: state.selectedAccount,
        accountIsProvisional: state.accountIsProvisional,
      };
    case "SET_STATUS":
      return { ...state, streamStatus: action.step };
    case "SET_HEADER":
      return {
        ...state,
        merchant: action.header.merchant,
        transactionDate: action.header.transactionDate,
      };
    case "ADD_ITEM":
      return {
        ...state,
        items: [
          ...state.items,
          {
            productName: action.item.productName,
            quantity: action.item.quantity,
            lineItemTotalAmount: action.item.amount,
            category: "",
          },
        ],
      };
    case "SET_TOTAL":
      return {
        ...state,
        totalAmount: action.totals.totalAmount,
        tax: action.totals.tax ?? 0,
        shipping: action.totals.shipping ?? 0,
        fees: action.totals.fees ?? 0,
        discount: action.totals.discount ?? 0,
        credit: action.totals.credit ?? 0,
        creditLabel: action.totals.creditLabel,
        refund: action.totals.refund ?? 0,
      };
    case "SET_CATEGORIES": {
      const cats = action.categories;
      const updated = state.items.map((item, i) => ({
        ...item,
        category: Array.isArray(cats)
          ? (cats[i] || item.category)
          : (cats[item.productName] ?? item.category),
      }));
      return { ...state, items: updated };
    }
    case "STREAM_DONE": {
      // The streamed line amounts were provisional — extracted before
      // total/summary lines were claimed (see build-receipt.ts).
      // buildReceiptFromLabels produced the reconciled, authoritative
      // figures. Refresh each SURVIVING streamed item with the reconciled
      // amount + category (matched by productName). We map over
      // state.items, not action.receipt.lineItems, so the user's curation
      // during streaming is preserved: a line deleted mid-parse stays
      // deleted (not resurrected), and a category the user picked is kept
      // over the reconciled one. Streamed items with no reconciled match
      // (reconciliation dropped them) keep their streamed values rather
      // than vanishing from the review screen.
      const finalItems = action.receipt.lineItems ?? [];
      const doneItems = state.items.map((item) => {
        const match = finalItems.find((fi) => fi.productName === item.productName);
        if (!match) return item;
        return {
          ...item,
          lineItemTotalAmount: match.lineItemTotalAmount,
          category: item.category || match.category || "",
        };
      });
      return {
        ...state,
        items: doneItems,
        streamDone: true,
        streamStatus: "",
        // Fill in any missing fields from the final receipt
        merchant: state.merchant || action.receipt.merchant,
        transactionDate: state.transactionDate || action.receipt.transactionDate,
        totalAmount: state.totalAmount || action.receipt.totalAmount,
      };
    }
    case "STREAM_ERROR":
      // importing:false is load-bearing for the IMPORT failure path: handleImport
      // sets importing=true (START_IMPORT) then dispatches STREAM_ERROR on a
      // failed/raced import. Without resetting it, the Import button stays
      // `disabled={importDisabled || importing}` forever — a failed import
      // (e.g. a transient Actual sync network-failure) permanently blocks retry
      // until the view is reset. (During a parse-stream error importing is
      // already false, so this is a no-op there.)
      return { ...state, error: action.error, streamDone: true, streamStatus: "", importing: false };
    case "DELETE_ITEM":
      return { ...state, items: state.items.filter((_, i) => i !== action.index) };
    case "UPDATE_ITEM_CATEGORY":
      return {
        ...state,
        items: state.items.map((item, i) =>
          i === action.index ? { ...item, category: action.category } : item
        ),
      };
    case "UPDATE_ITEM_NAME":
      return {
        ...state,
        items: state.items.map((item, i) =>
          i === action.index ? { ...item, productName: action.name } : item
        ),
      };
    case "UPDATE_ITEM_AMOUNT":
      return {
        ...state,
        items: state.items.map((item, i) =>
          i === action.index ? { ...item, lineItemTotalAmount: action.amount } : item
        ),
      };
    case "UPDATE_FIELD":
      return {
        ...state,
        [action.field]: action.value,
        // A manual selectedAccount edit is a real choice, not a placeholder.
        ...(action.field === "selectedAccount" ? { accountIsProvisional: false } : {}),
      };
    case "SET_ACCOUNT":
      // The user committed a choice — never auto-override it afterwards.
      return { ...state, selectedAccount: action.account, accountIsProvisional: false };
    case "START_IMPORT":
      return { ...state, importing: true };
    case "IMPORT_SUCCESS":
      return { ...state, view: "imported" as View, importing: false };
    case "RESET":
      return initialState;
    case "NAVIGATE":
      return {
        ...state,
        view: action.view,
        settingsSection: action.settingsSection,
        setupDismissed: state.view === "setup" ? true : state.setupDismissed,
      };
    case "DISMISS_SETUP":
      return { ...state, view: "main", setupDismissed: true };
    case "SET_SOURCE_FILE":
      return { ...state, sourceFilename: action.filename };
    case "LOAD_RECEIPT":
      return {
        ...initialState,
        view: "review",
        streamDone: true,
        merchant: action.receipt.merchant,
        transactionDate: action.receipt.transactionDate,
        totalAmount: action.receipt.totalAmount,
        tax: action.receipt.tax ?? 0,
        shipping: action.receipt.shipping ?? 0,
        fees: action.receipt.fees ?? 0,
        discount: action.receipt.discount ?? 0,
        credit: action.receipt.credit ?? 0,
        creditLabel: action.receipt.creditLabel,
        refund: action.receipt.refund ?? 0,
        items: (action.receipt.lineItems ?? []).map((li) => ({
          productName: li.productName,
          quantity: li.quantity ?? 1,
          lineItemTotalAmount: li.lineItemTotalAmount,
          category: li.category || "",
        })),
        sourceFilename: action.sourceFilename,
        historyId: action.historyId || null,
        // Preserve the resolved account across the reset, like every other
        // review-entry case (START_STREAM, RECEIPT_READY_FOR_PENDING,
        // LOAD_BUFFERED_PROGRESS). ACCOUNTS_LOADED only re-fires when the
        // account list / config changes, so it does NOT re-heal a wipe here:
        // loading a pending/history receipt would zero selectedAccount and
        // block Import even though the picker still shows the first account.
        selectedAccount: state.selectedAccount,
        accountIsProvisional: state.accountIsProvisional,
      };
    case "RECEIPT_READY_FOR_PENDING": {
      // Apply only when viewing the streaming progress for this file and it
      // hasn't completed locally yet. Otherwise drop — the action arrived
      // for a file the user navigated away from, or for a local-upload
      // stream already finished. Distinct from LOAD_RECEIPT (user-initiated,
      // unconditional) because this path is driven by background watcher
      // events and must respect the current view/stream invariants.
      if (state.view !== "review" || state.sourceFilename !== action.filename || state.streamDone) {
        return state;
      }
      return {
        ...initialState,
        view: "review",
        streamDone: true,
        merchant: action.receipt.merchant,
        transactionDate: action.receipt.transactionDate,
        totalAmount: action.receipt.totalAmount,
        tax: action.receipt.tax ?? 0,
        shipping: action.receipt.shipping ?? 0,
        fees: action.receipt.fees ?? 0,
        discount: action.receipt.discount ?? 0,
        credit: action.receipt.credit ?? 0,
        creditLabel: action.receipt.creditLabel,
        refund: action.receipt.refund ?? 0,
        items: (action.receipt.lineItems ?? []).map((li) => ({
          productName: li.productName,
          quantity: li.quantity ?? 1,
          lineItemTotalAmount: li.lineItemTotalAmount,
          category: li.category || "",
        })),
        sourceFilename: action.filename,
        selectedAccount: state.selectedAccount,
        accountIsProvisional: state.accountIsProvisional,
      };
    }
    case "ACCOUNTS_LOADED": {
      if (action.accounts.length === 0) return state;
      const resolvedId =
        action.defaultAccountId && action.accounts.some((a) => a.id === action.defaultAccountId)
          ? action.defaultAccountId
          : null;
      // A committed selection (user pick, or a previously-resolved real
      // default) is never overridden — keeps re-dispatches on every poll
      // (useRetryableFetch returns a fresh array each time) idempotent.
      if (state.selectedAccount && !state.accountIsProvisional) return state;
      // The real default is known now: commit it. This also CORRECTS a
      // provisional first-account pick made on an earlier emit when
      // ynabAccountId hadn't been persisted yet (post-upgrade ordering).
      if (resolvedId) {
        return { ...state, selectedAccount: resolvedId, accountIsProvisional: false };
      }
      // No default yet and nothing chosen — provisionally show the first
      // account so the picker isn't empty; a later real default (above)
      // corrects it, a user pick (SET_ACCOUNT) supersedes it.
      if (!state.selectedAccount) {
        return { ...state, selectedAccount: action.accounts[0].id, accountIsProvisional: true };
      }
      return state; // keep the existing provisional pick
    }
    case "APPLY_PARSE_PROGRESS_EVENT": {
      const { event } = action;
      // Reducer-resident guard for the SSE parse-progress fan-out. The
      // dispatcher (handleParseProgress) is now a one-line emitter; the
      // view/sourceFilename check lives next to the state it reads.
      if (state.view !== "review" || state.sourceFilename !== event.filename) {
        return state;
      }
      return applyParseProgressEvent(state, event);
    }
    case "LOAD_BUFFERED_PROGRESS": {
      // Single-dispatch replay of buffered SSE events. Initializes a fresh
      // "review/parsing" state for the given filename, then folds the event
      // list over it in one reducer call. No inter-dispatch ordering
      // dependency: applyParseProgressEvent runs on the freshly-initialized
      // state we build below, not on whatever React.useReducer happens to
      // be queueing. The guard in APPLY_PARSE_PROGRESS_EVENT does not apply
      // here because we know we're in the target view (we just set it).
      const base: AppState = {
        ...initialState,
        view: "review",
        sourceFilename: action.filename,
        selectedAccount: state.selectedAccount,
        accountIsProvisional: state.accountIsProvisional,
      };
      return action.events.reduce(
        (acc, event) => applyParseProgressEvent(acc, event),
        base,
      );
    }
    default:
      return state;
  }
}

/** Apply a single parse-progress SSE event to the state. Caller is
 *  responsible for the view/sourceFilename guard. Pure; shared between
 *  APPLY_PARSE_PROGRESS_EVENT (guarded) and LOAD_BUFFERED_PROGRESS
 *  (unguarded — replay over a freshly-initialized base state). */
function applyParseProgressEvent(state: AppState, event: ParseProgressEvent): AppState {
  switch (event.event) {
    case "status":
      return { ...state, streamStatus: (event.data as { step: string }).step };
    case "header": {
      const d = event.data as { merchant: string; transactionDate: string };
      return { ...state, merchant: d.merchant, transactionDate: d.transactionDate };
    }
    case "item": {
      const it = event.data as { productName: string; quantity: number; lineText: string; amount: number };
      return {
        ...state,
        items: [
          ...state.items,
          {
            productName: it.productName,
            quantity: it.quantity,
            lineItemTotalAmount: it.amount,
            category: "",
          },
        ],
      };
    }
    case "total": {
      const t = event.data as { totalAmount: number; tax: number; shipping: number; fees: number; discount: number; credit: number; creditLabel?: string; refund: number };
      return {
        ...state,
        totalAmount: t.totalAmount,
        tax: t.tax ?? 0,
        shipping: t.shipping ?? 0,
        fees: t.fees ?? 0,
        discount: t.discount ?? 0,
        credit: t.credit ?? 0,
        creditLabel: t.creditLabel,
        refund: t.refund ?? 0,
      };
    }
    case "categories": {
      const cats = event.data as Record<string, string> | string[];
      const updated = state.items.map((item, i) => ({
        ...item,
        category: Array.isArray(cats)
          ? (cats[i] || item.category)
          : (cats[item.productName] ?? item.category),
      }));
      return { ...state, items: updated };
    }
    default:
      return state;
  }
}

// --- Dark mode ---

// --- App ---

export default function App() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const { history, refresh, remove } = useHistory();
  const { refresh: refreshStatus, loaded: statusLoaded, ...status } = useStatus();
  const { config: appConfig, loading: configLoading, save: saveConfig } = useConfig();
  // Read accounts/categories BARE: the server uses its own on-disk
  // config-active provider, which is authoritative and updates the moment a
  // provider switch is committed to the backend. Do NOT pass
  // appConfig.budgetProvider here — this App-level useConfig fetches /config
  // once and never refetches (no interval; onBack is a bare NAVIGATE), so
  // after an in-session switch it goes STALE and the main view would fetch the
  // OLD provider's accounts/categories while the backend is on the new one.
  // (Explicit ?provider= belongs in Settings, where the loader knows its own
  // provider synchronously and the rapid-switch read race actually lives.)
  const { accounts, refresh: refreshAccounts } = useAccounts(status.setupComplete);
  // Resync the account list when the user comes back to the app, so a
  // YNAB-side rename shows up without waiting for the next poll. The 60s
  // server cache bounds the API cost; 30s throttle bounds the trigger.
  useFocusRefresh(refreshAccounts, 30_000);
  const categories = useCategories(status.setupComplete);
  const { startStream, abort } = useReceiptStream(dispatch);
  const fetchPendingRef = useRef<(() => void) | undefined>(undefined);

  const handleParseProgress = useCallback((e: ParseProgressEvent) => {
    dispatch({ type: "APPLY_PARSE_PROGRESS_EVENT", event: e });
  }, []);

  const { pendingFiles, setPendingFiles, removePendingLocal, getBufferedProgress, progressMap, pruneStaleBuffers } = useWatcherEvents(
    refresh,
    () => fetchPendingRef.current?.(),
    handleParseProgress,
    () => {
      // Fired when YNAB reconnects after an offline period and the backend
      // cleared categories on receipts whose assignments no longer exist
      // upstream. Notify so the user understands why their picks changed.
      sendNotification("Categories changed", "Some categories changed in YNAB and were set to blank in pending receipts.");
    },
  );
  const { fetchPending, skipFile } = usePendingFiles(setPendingFiles, removePendingLocal, pruneStaleBuffers);
  fetchPendingRef.current = fetchPending;
  // App-level updater state: the hook fires its boot-time check when this
  // mounts (i.e., at app launch), not when Settings opens. The state is
  // passed down to SettingsView's UpdateRow.
  const appUpdate = useAppUpdate();
  useWatcherNotifications(pendingFiles, appConfig);
  useTrayClose(appConfig);

  const { preference: themePreference, setTheme } = useDarkMode();

  // Load pending files on mount
  useEffect(() => {
    fetchPending();
  }, [fetchPending]);

  // When a pending entry transitions to ready while the user is watching
  // its parse stream, hand the completed receipt to the reducer. The
  // reducer's RECEIPT_READY_FOR_PENDING guard enforces the
  // view/sourceFilename/streamDone invariants — this emitter only joins
  // pendingFiles to sourceFilename and dispatches when a receipt exists.
  useEffect(() => {
    if (!state.sourceFilename) return;
    const pending = pendingFiles.find((f) => f.filename === state.sourceFilename);
    if (pending?.status === "ready" && pending.receipt) {
      dispatch({
        type: "RECEIPT_READY_FOR_PENDING",
        filename: pending.filename,
        receipt: pending.receipt,
      });
    }
  }, [pendingFiles, state.sourceFilename]);

  // Thin emitter for default-account auto-selection. The reducer's
  // ACCOUNTS_LOADED case carries the preference logic (config default vs.
  // first account) and the "only fill if empty / non-empty list" guards,
  // so this effect just hands it the inputs. useRetryableFetch returns a
  // fresh array each poll — re-dispatches are no-ops by reducer design.
  // Import target is per-provider — seed the main-view account from the
  // ACTIVE provider's saved id, not the YNAB field unconditionally.
  const activeAccountId = appConfig.budgetProvider === "actual"
    ? appConfig.actualAccountId
    : appConfig.ynabAccountId;
  useEffect(() => {
    dispatch({ type: "ACCOUNTS_LOADED", accounts, defaultAccountId: activeAccountId });
  }, [accounts, activeAccountId]);

  const handleFile = (file: File) => {
    // If the LLM is still warming up, don't enter the review flow — the
    // parse will fail. Drop the file into the watcher inbox instead; the
    // backend's queueFile waits for llama-server, then parses, and the
    // pending list updates on its own. The user sees the file appear in
    // the pending list with a "Loading AI model" hint until LLM ready.
    if (!status.llmReady) {
      uploadToInbox(file)
        .then(() => fetchPending())
        .catch((err) => console.error("uploadToInbox failed:", err));
      return;
    }
    dispatch({ type: "SET_SOURCE_FILE", filename: "" });
    startStream(file);
  };

  // Global drag-and-drop: any PDF dropped anywhere in the app gets processed.
  // This also prevents the webview from rendering raw PDFs on drop.
  useEffect(() => {
    const preventDefault = (e: Event) => e.preventDefault();
    const handleGlobalDrop = (e: DragEvent) => {
      e.preventDefault();
      const file = e.dataTransfer?.files[0];
      if (file?.type === "application/pdf") {
        handleFile(file);
      }
    };
    const handleKeydown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "r") {
        e.preventDefault();
        window.location.reload();
      }
    };
    document.addEventListener("dragover", preventDefault);
    document.addEventListener("drop", handleGlobalDrop);
    document.addEventListener("keydown", handleKeydown);
    return () => {
      document.removeEventListener("dragover", preventDefault);
      document.removeEventListener("drop", handleGlobalDrop);
      document.removeEventListener("keydown", handleKeydown);
    };
  }, []);

  const handleReviewPending = (filename: string) => {
    const pending = pendingFiles.find((f) => f.filename === filename);
    if (pending?.receipt) {
      dispatch({ type: "LOAD_RECEIPT", receipt: pending.receipt, sourceFilename: filename });
    } else if (pending?.status === "parsing") {
      // Single-dispatch initialization-plus-replay. The reducer's
      // LOAD_BUFFERED_PROGRESS case builds a fresh review/parsing state
      // for `filename`, then folds the buffered SSE events over it in
      // one pass. No inter-dispatch ordering dependency — replay state
      // is computed from a fresh base, not from queued intermediate
      // dispatches.
      dispatch({
        type: "LOAD_BUFFERED_PROGRESS",
        filename,
        events: getBufferedProgress(filename),
      });
    }
  };

  const handleSkipPending = (filename: string, detectedAt?: string) => {
    // detectedAt is the version token — when the caller has it (PendingList
    // row), pass it through so the server can detect a stale-FE delete.
    // From in-review Discard we look it up off pendingFiles state.
    const token = detectedAt ?? pendingFiles.find((f) => f.filename === filename)?.detectedAt;
    skipFile(filename, token);
  };

  const handleViewHistory = (record: ImportRecord) => {
    if (record.receipt) {
      dispatch({ type: "LOAD_RECEIPT", receipt: record.receipt, sourceFilename: record.filename, historyId: record.id });
    }
  };

  const [importingFile, setImportingFile] = useState<string | null>(null);

  const handleQuickImport = async (filename: string) => {
    const pending = pendingFiles.find((f) => f.filename === filename);
    if (!pending?.receipt) return;
    const account = state.selectedAccount || accounts[0]?.id;
    if (!account) return;
    setImportingFile(filename);
    try {
      await apiPost("/import", {
        account,
        receipt: pending.receipt,
        sourceFilename: filename,
      });
      removePendingLocal(filename);
      refresh();
    } catch {
      // fall through — user can retry or review manually
    } finally {
      setImportingFile(null);
    }
  };

  const handleRetry = useCallback(() => {
    if (state.lastFile) {
      startStream(state.lastFile);
    }
  }, [state.lastFile, startStream]);

  const handleImport = async () => {
    dispatch({ type: "START_IMPORT" });
    try {
      const receipt: Receipt = {
        merchant: state.merchant,
        transactionDate: state.transactionDate,
        memo: "",
        totalAmount: state.totalAmount,
        category: state.items[0]?.category || "Uncategorized",
        lineItems: state.items,
        tax: state.tax,
        shipping: state.shipping,
        fees: state.fees,
        discount: state.discount,
        credit: state.credit,
        creditLabel: state.creditLabel,
        refund: state.refund,
      };
      const payload: Record<string, unknown> = { account: state.selectedAccount, receipt };
      if (state.sourceFilename) {
        payload.sourceFilename = state.sourceFilename;
      }
      await apiPost("/import", payload);
      if (state.sourceFilename) {
        removePendingLocal(state.sourceFilename);
      }
      dispatch({ type: "IMPORT_SUCCESS" });
      // 1.2s auto-transition from the imported success screen back to main.
      // Behavior change vs. the prior useEffect: the timer always fires
      // — no cleanup on view change. Safe today because the imported
      // view (see "Import success screen" render block) has no clickable
      // controls (SVG + text only), so the user cannot navigate away
      // before the timeout completes. If clickable controls are ever
      // added there, this needs to move back to an effect with cleanup.
      setTimeout(() => dispatch({ type: "RESET" }), 1200);
      refresh();
    } catch (err: unknown) {
      dispatch({
        type: "STREAM_ERROR",
        error: err instanceof Error ? err.message : "Import failed",
      });
    }
  };

  // Hard failure path — sidecar didn't deliver port + creds within the
  // initApiBase timeout. Surfacing the error here prevents the rest of
  // the app from mounting against empty auth and 401-looping silently.
  if (initFailure) {
    return <SplashScreen phase="init-failed" errorMessage={initFailure.reason} />;
  }

  // Wait for initial status check before deciding what to render.
  // While we wait, show a splash so the window is dragable and the user
  // sees what's happening rather than a frozen blank window.
  if (!statusLoaded && state.view !== "setup") {
    return <SplashScreen phase="connecting" />;
  }

  // Llama-server start failed — surface a recoverable error UI with a
  // path to Settings instead of leaving the user stuck on a "Loading AI
  // model…" splash that will never advance. Settings is exempt so the
  // user can navigate around the error to fix it.
  if (statusLoaded && status.setupComplete && status.llmStartError && state.view !== "settings" && state.view !== "setup") {
    return (
      <LlmStartErrorScreen
        error={status.llmStartError}
        onOpenSettings={() => dispatch({ type: "NAVIGATE", view: "settings" })}
      />
    );
  }

  // Setup wizard: show if explicitly navigated, or if setup not complete (and not dismissed)
  // (No splash gate for `!llmReady` — the main UI renders during AI warmup;
  // the DropZone disables drops with an inline message and the StatusBar's
  // bottom-right AI indicator shows "Loading AI model".)
  if (state.view === "setup" || (state.view === "main" && !status.setupComplete && !state.setupDismissed)) {
    return (
      <SetupWizard
        onComplete={() => {
          refreshStatus();
          dispatch({ type: "NAVIGATE", view: "main" });
        }}
        onSkip={() => dispatch({ type: "DISMISS_SETUP" })}
      />
    );
  }

  // Settings view
  if (state.view === "settings") {
    return (
      <SettingsView
        scrollToSection={state.settingsSection}
        onBack={() => dispatch({ type: "NAVIGATE", view: "main" })}
        onRunSetup={() => dispatch({ type: "NAVIGATE", view: "setup" })}
        themePreference={themePreference}
        onThemeChange={setTheme}
        config={appConfig}
        configLoading={configLoading}
        saveConfig={saveConfig}
        appUpdate={appUpdate}
      />
    );
  }

  // Import success screen
  if (state.view === "imported") {
    return (
      <div className="import-success" role="status" aria-live="assertive">
        <TitlebarRegion />
        <div className="import-success-content">
          <svg className="checkmark" viewBox="0 0 52 52" aria-hidden="true">
            <circle className="checkmark-circle" cx="26" cy="26" r="24" fill="none" />
            <path className="checkmark-check" fill="none" d="M15 27l7 7 15-15" />
          </svg>
          <div className="import-success-text">Imported</div>
        </div>
      </div>
    );
  }

  // Review view
  if (state.view === "review") {
    const hasMissingCategories = state.streamDone && state.items.some((item) => !item.category);

    return (
      <div className="review-view">
        <TitlebarRegion />
        <div className="review-toolbar">
          <button className="btn-ghost" onClick={abort} type="button" aria-label="Go back">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M10 3L5 8l5 5" />
            </svg>
            Back
          </button>
        </div>
        <ProgressTicker
          status={state.streamStatus}
          itemCount={state.items.length}
          done={state.streamDone}
        />
        {state.merchant && (
          <ReviewHeader
            merchant={state.merchant}
            transactionDate={state.transactionDate}
            onMerchantChange={(v) =>
              dispatch({ type: "UPDATE_FIELD", field: "merchant", value: v })
            }
            onDateChange={(v) =>
              dispatch({ type: "UPDATE_FIELD", field: "transactionDate", value: v })
            }
          />
        )}
        <div className="review-body">
          {state.error && (
            <ErrorBanner
              title="Something went wrong"
              description={state.error}
              onRetry={state.lastFile ? handleRetry : undefined}
              onSettings={() => dispatch({ type: "NAVIGATE", view: "settings" })}
            />
          )}
          {hasMissingCategories && !state.error && (
            <WarningBanner
              title="Some items aren't categorized"
              description="A few items couldn't be auto-categorized. They'll import uncategorized — you can set their categories in your budget afterward."
            />
          )}
          <ItemsCard
            items={state.items}
            streaming={!state.streamDone}
            totalAmount={state.totalAmount}
            tax={state.tax}
            shipping={state.shipping}
            fees={state.fees}
            discount={state.discount}
            credit={state.credit}
            creditLabel={state.creditLabel}
            refund={state.refund}
            discountMode={appConfig.discountMode}
            availableCategories={categories}
            onDeleteItem={(i) => dispatch({ type: "DELETE_ITEM", index: i })}
            onUpdateCategory={(i, cat) => dispatch({ type: "UPDATE_ITEM_CATEGORY", index: i, category: cat })}
            onUpdateName={(i, name) => dispatch({ type: "UPDATE_ITEM_NAME", index: i, name })}
            onUpdateAmount={(i, amount) => dispatch({ type: "UPDATE_ITEM_AMOUNT", index: i, amount })}
          />
        </div>
        <ReviewFooter
          accounts={accounts}
          selectedAccount={state.selectedAccount}
          onAccountChange={(a) => dispatch({ type: "SET_ACCOUNT", account: a })}
          onOpen={refreshAccounts}
          onDiscard={(() => {
            const dt = discardTargetFor(state);
            if (!dt) return undefined;
            return () => {
              if (dt.kind === "history") remove(dt.id);
              else handleSkipPending(dt.filename);
              abort();
            };
          })()}
          onImport={handleImport}
          importDisabled={!state.streamDone || state.items.length === 0 || !state.selectedAccount}
          importing={state.importing}
        />
      </div>
    );
  }

  // Main view
  return (
    <div className="main-view">
      <TitlebarRegion>
        <button
          className={`gear-btn${appUpdate.available ? " gear-btn-update-available" : ""}`}
          type="button"
          aria-label={appUpdate.available ? `Open settings (update available — v${appUpdate.available.version})` : "Open settings"}
          onClick={() => dispatch({ type: "NAVIGATE", view: "settings", settingsSection: appUpdate.available ? "update" : undefined })}
        >
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12.22 2h-.44a2 2 0 00-2 2v.18a2 2 0 01-1 1.73l-.43.25a2 2 0 01-2 0l-.15-.08a2 2 0 00-2.73.73l-.22.38a2 2 0 00.73 2.73l.15.1a2 2 0 011 1.72v.51a2 2 0 01-1 1.74l-.15.09a2 2 0 00-.73 2.73l.22.38a2 2 0 002.73.73l.15-.08a2 2 0 012 0l.43.25a2 2 0 011 1.73V20a2 2 0 002 2h.44a2 2 0 002-2v-.18a2 2 0 011-1.73l.43-.25a2 2 0 012 0l.15.08a2 2 0 002.73-.73l.22-.39a2 2 0 00-.73-2.73l-.15-.08a2 2 0 01-1-1.74v-.5a2 2 0 011-1.74l.15-.09a2 2 0 00.73-2.73l-.22-.38a2 2 0 00-2.73-.73l-.15.08a2 2 0 01-2 0l-.43-.25a2 2 0 01-1-1.73V4a2 2 0 00-2-2z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
          {appUpdate.available && <span className="gear-update-dot" aria-hidden="true" />}
        </button>
      </TitlebarRegion>
      <DropZone onFile={handleFile} />
      <PendingList
        files={pendingFiles}
        onReview={handleReviewPending}
        onSkip={handleSkipPending}
        onImport={handleQuickImport}
        importingFile={importingFile}
        progressMap={progressMap}
        llmReady={status.llmReady}
      />
      <HistoryList history={history} onView={handleViewHistory} onRemove={remove} />
      <StatusBar
        watcherRunning={status.watcherRunning}
        watcherPath={status.watcherPath}
        watcherInboxExists={status.watcherInboxExists}
        setupComplete={status.setupComplete}
        llmReady={status.llmReady}
        themePreference={themePreference}
        onThemeChange={setTheme}
        onSettingsClick={(section) => dispatch({ type: "NAVIGATE", view: "settings", settingsSection: section })}
      />
    </div>
  );
}

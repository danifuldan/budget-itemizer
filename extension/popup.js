// Budget Itemizer Extension — Popup Logic
// Simple state machine: check health → ready → capture → done/error

const $ = (sel) => document.getElementById(sel);

const STATES = [
  "state-checking",
  "state-offline",
  "state-ready",
  "state-capturing",
  "state-done",
  "state-error",
  "state-picking",
  "state-confirm",
  "state-batch-progress",
  "state-batch-done",
];

function showState(id) {
  for (const s of STATES) {
    const el = $(s);
    if (el) el.classList.toggle("hidden", s !== id);
  }
}

function msg(action, data = {}) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action, ...data }, resolve);
  });
}

// --- Settings ---

async function initSettings() {
  const port = await msg("getPort");
  $("port-input").value = port;
}

$("settings-btn").addEventListener("click", () => {
  $("settings-panel").classList.toggle("hidden");
});

$("settings-save").addEventListener("click", async () => {
  const port = parseInt($("port-input").value, 10);
  if (port > 0 && port <= 65535) {
    await msg("setPort", { port });
  }
  $("settings-panel").classList.add("hidden");
  init();
});

// --- Capture Flow ---

async function capture() {
  showState("state-capturing");

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) {
    showError("No active tab found");
    return;
  }

  const result = await msg("capture", { tabId: tab.id, pageTitle: tab.title });
  if (result?.success) {
    showState("state-done");
  } else {
    showError(result?.error || "Failed to capture page");
  }
}

function showError(message) {
  $("error-message").textContent = message;
  showState("state-error");
}

// --- Batch Capture Flow ---

let pendingLinks = [];

async function captureAll() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) {
    showError("No active tab found");
    return;
  }
  await msg("startPick", { tabId: tab.id });
  // Close popup so user can interact with the page
  window.close();
}

function cancelPick() {
  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    if (tab) chrome.tabs.sendMessage(tab.id, { action: "cancelPick" });
  });
  showState("state-ready");
}

function showConfirm(links) {
  pendingLinks = links;
  $("link-count").textContent = links.length;
  const list = $("link-list");
  list.innerHTML = "";
  for (const link of links) {
    const div = document.createElement("div");
    div.className = "link-item";
    div.textContent = link.text || link.href;
    div.title = link.href;
    list.appendChild(div);
  }
  showState("state-confirm");
}

function startBatch() {
  if (!pendingLinks.length) return;
  $("batch-current").textContent = "0";
  $("batch-total").textContent = pendingLinks.length;
  $("batch-page-title").textContent = "";
  $("progress-fill").style.width = "0%";
  showState("state-batch-progress");
  msg("batchCapture", { links: pendingLinks });
}

function onBatchProgress({ current, total, title }) {
  $("batch-current").textContent = current;
  $("batch-total").textContent = total;
  $("batch-page-title").textContent = title || "";
  $("progress-fill").style.width = Math.round((current / total) * 100) + "%";
}

function onBatchDone({ success, failed, total }) {
  $("batch-done-text").textContent = `Captured ${success} of ${total} orders`;
  const errEl = $("batch-errors-text");
  if (failed > 0) {
    errEl.textContent = `${failed} failed`;
    errEl.classList.remove("hidden");
  } else {
    errEl.classList.add("hidden");
  }
  showState("state-batch-done");
}

// --- Listen for background messages ---

chrome.runtime.onMessage.addListener((message) => {
  if (message.action === "pickResult") {
    if (message.links && message.links.length > 0) {
      showConfirm(message.links);
    } else {
      showError("No order links detected. Try clicking a different link.");
    }
  }
  if (message.action === "batchProgress") {
    onBatchProgress(message);
  }
  if (message.action === "batchDone") {
    onBatchDone(message);
  }
});

// --- Button Handlers ---

$("capture-btn").addEventListener("click", capture);
$("retry-btn").addEventListener("click", init);
$("error-retry-btn").addEventListener("click", capture);
$("capture-another-btn").addEventListener("click", capture);
$("capture-all-btn").addEventListener("click", captureAll);
$("cancel-pick-btn").addEventListener("click", cancelPick);
$("batch-start-btn").addEventListener("click", startBatch);
$("batch-cancel-btn").addEventListener("click", () => showState("state-ready"));
$("batch-done-btn").addEventListener("click", () => showState("state-ready"));

// --- Init ---

async function init() {
  showState("state-checking");
  await initSettings();

  const healthy = await msg("healthCheck");
  if (!healthy) {
    showState("state-offline");
    return;
  }

  // Check for pending pick results (from a previous Capture All session)
  const { pendingPick } = await chrome.storage.local.get("pendingPick");
  if (pendingPick && pendingPick.length > 0) {
    await msg("clearPendingPick");
    showConfirm(pendingPick);
    return;
  }

  showState("state-ready");
}

init();

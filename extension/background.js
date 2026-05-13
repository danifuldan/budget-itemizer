// Budget Itemizer Extension — Background Service Worker
// Captures current page as PDF and sends it to the desktop app's inbox.

const DEFAULT_PORT = 3456;

// --- Settings ---

async function getPort() {
  const { port } = await chrome.storage.local.get("port");
  return port || DEFAULT_PORT;
}

async function getBaseUrl() {
  const port = await getPort();
  return `http://localhost:${port}`;
}

async function getAuth() {
  const { auth } = await chrome.storage.local.get("auth");
  if (auth) return auth;

  try {
    const base = await getBaseUrl();
    const res = await fetch(`${base}/setup/status`);
    if (!res.ok) return null;
    const data = await res.json();
    if (data.auth) {
      await chrome.storage.local.set({ auth: data.auth });
      return data.auth;
    }
  } catch {
    // App not running
  }
  return null;
}

function authHeader(auth) {
  return "Basic " + btoa(`${auth.username}:${auth.password}`);
}

// --- Health Check ---

async function checkHealth() {
  try {
    const base = await getBaseUrl();
    const res = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

// --- CDP Page-to-PDF Capture ---

async function capturePDF(tabId) {
  await chrome.debugger.attach({ tabId }, "1.3");

  try {
    const result = await chrome.debugger.sendCommand({ tabId }, "Page.printToPDF", {
      printBackground: true,
      preferCSSPageSize: true,
      displayHeaderFooter: false,
      marginTop: 0.4,
      marginBottom: 0.4,
      marginLeft: 0.4,
      marginRight: 0.4,
    });

    return result.data; // base64-encoded PDF
  } finally {
    await chrome.debugger.detach({ tabId }).catch(() => {});
  }
}

// --- Send PDF to Desktop App Inbox ---

async function sendToInbox(base64pdf, pageTitle) {
  const auth = await getAuth();
  if (!auth) throw new Error("Could not get auth credentials from desktop app");

  const base = await getBaseUrl();

  const binaryString = atob(base64pdf);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  const blob = new Blob([bytes], { type: "application/pdf" });

  const safeName = (pageTitle || "receipt")
    .replace(/[^a-zA-Z0-9 _-]/g, "")
    .substring(0, 60)
    .trim()
    .replace(/\s+/g, "_");
  const filename = `${safeName}_${Date.now()}.pdf`;

  const formData = new FormData();
  formData.append("file", blob, filename);

  const response = await fetch(`${base}/watcher/inbox`, {
    method: "POST",
    headers: { Authorization: authHeader(auth) },
    body: formData,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Upload failed (${response.status}): ${text}`);
  }

  return await response.json();
}

// --- Batch Capture ---

async function batchCapture(links) {
  let success = 0;
  let failed = 0;
  const total = links.length;

  for (let i = 0; i < links.length; i++) {
    const link = links[i];
    let tab = null;

    try {
      // Open link in a background tab
      tab = await chrome.tabs.create({ url: link.href, active: false });

      // Wait for tab to finish loading
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          chrome.tabs.onUpdated.removeListener(listener);
          reject(new Error("Tab load timeout"));
        }, 30000);

        function listener(tabId, changeInfo) {
          if (tabId === tab.id && changeInfo.status === "complete") {
            chrome.tabs.onUpdated.removeListener(listener);
            clearTimeout(timeout);
            resolve();
          }
        }

        chrome.tabs.onUpdated.addListener(listener);
      });

      // Small delay to let page settle
      await new Promise((r) => setTimeout(r, 500));

      // Get the tab's actual title
      const updatedTab = await chrome.tabs.get(tab.id);
      const pageTitle = updatedTab.title || link.text || "receipt";

      // Capture and send
      const pdf = await capturePDF(tab.id);
      await sendToInbox(pdf, pageTitle);
      success++;

      // Notify popup of progress
      chrome.runtime.sendMessage({
        action: "batchProgress",
        current: i + 1,
        total,
        title: pageTitle,
      }).catch(() => {});
    } catch (err) {
      failed++;
      chrome.runtime.sendMessage({
        action: "batchProgress",
        current: i + 1,
        total,
        title: `(failed) ${link.text || link.href}`,
      }).catch(() => {});
    } finally {
      // Close the tab
      if (tab) {
        await chrome.tabs.remove(tab.id).catch(() => {});
      }
    }

    // Brief pause between captures
    if (i < links.length - 1) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  chrome.runtime.sendMessage({
    action: "batchDone",
    success,
    failed,
    total,
  }).catch(() => {});
}

// --- Message Handler ---

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "healthCheck") {
    checkHealth().then(sendResponse);
    return true;
  }

  if (message.action === "capture") {
    (async () => {
      try {
        const pdf = await capturePDF(message.tabId);
        await sendToInbox(pdf, message.pageTitle);
        sendResponse({ success: true });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }

  if (message.action === "setPort") {
    chrome.storage.local.set({ port: message.port }).then(() => {
      chrome.storage.local.remove("auth").then(() => sendResponse(true));
    });
    return true;
  }

  if (message.action === "getPort") {
    getPort().then(sendResponse);
    return true;
  }

  if (message.action === "startPick") {
    chrome.scripting.executeScript({
      target: { tabId: message.tabId },
      files: ["content-pick.js"],
    }).then(() => sendResponse({ success: true }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "pickResult") {
    // Store pick results — popup may be closed, will read on reopen
    const links = message.links || [];
    chrome.storage.local.set({ pendingPick: links });
    if (links.length > 0) {
      chrome.action.setBadgeText({ text: String(links.length) });
      chrome.action.setBadgeBackgroundColor({ color: "#4A855C" });
    }
    // Also try forwarding to popup (if it happens to be open)
    chrome.runtime.sendMessage({
      action: "pickResult",
      links,
    }).catch(() => {});
    sendResponse({ received: true });
    return true;
  }

  if (message.action === "clearPendingPick") {
    chrome.storage.local.remove("pendingPick");
    chrome.action.setBadgeText({ text: "" });
    sendResponse({ cleared: true });
    return true;
  }

  if (message.action === "batchCapture") {
    batchCapture(message.links);
    sendResponse({ started: true });
    return true;
  }
});

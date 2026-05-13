// Budget Itemizer Extension — Content Script for Order Link Detection
// Injected on demand when user clicks "Capture All Orders"
// Adds overlay, waits for user to click a link, finds repeating pattern, reports all links.

(function () {
  // Guard against double-injection
  if (window.__ynabPickerActive) return;
  window.__ynabPickerActive = true;

  // --- Overlay Banner ---
  const overlay = document.createElement("div");
  overlay.id = "__ynab-pick-overlay";
  Object.assign(overlay.style, {
    position: "fixed",
    top: "0",
    left: "0",
    right: "0",
    zIndex: "2147483647",
    background: "linear-gradient(135deg, #4A855C, #3F7550)",
    color: "white",
    fontFamily: "-apple-system, system-ui, sans-serif",
    fontSize: "14px",
    fontWeight: "500",
    textAlign: "center",
    padding: "10px 20px",
    boxShadow: "0 4px 20px rgba(0,0,0,0.15)",
    letterSpacing: "0.01em",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "12px",
  });

  const label = document.createElement("span");
  label.textContent = "Budget Itemizer: Click any order link — we'll find the rest automatically";
  label.style.fontWeight = "600";

  const cancelBtn = document.createElement("button");
  Object.assign(cancelBtn.style, {
    background: "rgba(255,255,255,0.2)",
    border: "1px solid rgba(255,255,255,0.4)",
    borderRadius: "6px",
    color: "white",
    padding: "4px 12px",
    fontSize: "12px",
    fontWeight: "600",
    cursor: "pointer",
    fontFamily: "-apple-system, system-ui, sans-serif",
    flexShrink: "0",
  });
  cancelBtn.textContent = "Cancel";
  cancelBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    cleanup();
  });

  overlay.appendChild(label);
  overlay.appendChild(cancelBtn);
  document.body.appendChild(overlay);

  // --- Highlight on hover ---
  let lastHighlighted = null;

  function onMouseOver(e) {
    const a = e.target.closest("a");
    if (!a || !a.href) return;
    if (lastHighlighted) lastHighlighted.style.outline = "";
    a.style.outline = "3px solid #4A855C";
    lastHighlighted = a;
  }

  function onMouseOut(e) {
    const a = e.target.closest("a");
    if (a) a.style.outline = "";
    if (lastHighlighted) lastHighlighted.style.outline = "";
    lastHighlighted = null;
  }

  document.addEventListener("mouseover", onMouseOver, true);
  document.addEventListener("mouseout", onMouseOut, true);

  // --- Click handler ---
  function onClick(e) {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    const clickedLink = e.target.closest("a");
    if (!clickedLink || !clickedLink.href) return;

    const links = findSiblingLinks(clickedLink);
    cleanup();
    chrome.runtime.sendMessage({ action: "pickResult", links });
  }

  document.addEventListener("click", onClick, true);

  // --- Pattern Detection ---
  function findSiblingLinks(anchor) {
    // Walk up from the anchor to find the repeating container
    let item = anchor;
    let container = null;
    let repeatingTag = null;
    let repeatingClasses = null;

    for (let i = 0; i < 10; i++) {
      const parent = item.parentElement;
      if (!parent || parent === document.body || parent === document.documentElement) break;

      // Check if parent has multiple children with the same structure as `item`
      const sig = elementSignature(item);
      const siblings = Array.from(parent.children).filter(
        (child) => child !== item && elementSignature(child) === sig
      );

      if (siblings.length >= 1) {
        container = parent;
        repeatingTag = item.tagName;
        repeatingClasses = item.className;
        break;
      }

      item = parent;
    }

    if (!container) {
      // Fallback: just return the clicked link
      return [{ href: anchor.href, text: linkText(anchor) }];
    }

    // Find the relative path from repeating item down to the anchor
    const relPath = getRelativePath(item, anchor);

    // Collect all matching links from sibling items
    const seen = new Set();
    const results = [];

    const matchingItems = Array.from(container.children).filter(
      (child) => elementSignature(child) === elementSignature(item)
    );

    for (const sibling of matchingItems) {
      let link;
      if (relPath) {
        link = sibling.querySelector(relPath);
      }
      // Fallback: find first link in the sibling
      if (!link) {
        link = sibling.querySelector("a[href]");
      }
      if (link && link.href && !seen.has(link.href)) {
        // Filter out fragment-only and javascript: links
        try {
          const url = new URL(link.href);
          if (url.protocol === "javascript:") continue;
          if (url.href === window.location.href + "#") continue;
        } catch {
          continue;
        }
        seen.add(link.href);
        results.push({ href: link.href, text: linkText(link) });
      }
    }

    return results;
  }

  function elementSignature(el) {
    // Tag + sorted class list as a fingerprint
    const classes = Array.from(el.classList).sort().join(".");
    return el.tagName + (classes ? "." + classes : "");
  }

  function getRelativePath(ancestor, target) {
    // Build a CSS selector path from ancestor down to target
    const parts = [];
    let current = target;

    while (current && current !== ancestor) {
      let selector = current.tagName.toLowerCase();
      if (current.classList.length > 0) {
        // Use the first class for specificity, avoid dynamic/unique classes
        const stableClass = Array.from(current.classList).find(
          (c) => !/^[a-f0-9]{6,}$/i.test(c) && !/\d{4,}/.test(c)
        );
        if (stableClass) {
          selector += "." + CSS.escape(stableClass);
        }
      }
      parts.unshift(selector);
      current = current.parentElement;
    }

    return parts.length > 0 ? parts.join(" > ") : null;
  }

  function linkText(a) {
    // Get meaningful text from the link
    const text = (a.textContent || "").trim().replace(/\s+/g, " ");
    return text.substring(0, 100) || a.href;
  }

  // --- Cleanup ---
  function cleanup() {
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("mouseover", onMouseOver, true);
    document.removeEventListener("mouseout", onMouseOut, true);
    if (lastHighlighted) lastHighlighted.style.outline = "";
    overlay.remove();
    window.__ynabPickerActive = false;
  }

  // Listen for cancel from popup
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === "cancelPick") {
      cleanup();
    }
  });
})();

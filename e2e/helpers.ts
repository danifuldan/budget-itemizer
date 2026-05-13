import type { Page } from "@playwright/test";

/**
 * Registers the standard set of backend mocks used across all E2E tests.
 *
 * Route precedence: Playwright uses last-registered-wins. To override a
 * default endpoint defined here, call `mockBackend(page)` first and THEN
 * register your override — your route will take precedence. (Calling overrides
 * BEFORE mockBackend has them silently shadowed by the defaults registered
 * after, unless the override is more specific than mockBackend's pattern,
 * e.g. a trailing star match like `/history?limit=10` vs plain `/history`.)
 */
export async function mockBackend(
  page: Page,
  overrides: {
    modelsDownloaded?: boolean;
  } = {},
) {
  const { modelsDownloaded = false } = overrides;

  // Auth bootstrap — called by ensureAuth() on the first API call.
  // Must come before any apiFetch call so the auth header is established.
  await page.route("**/setup/status", (route) => {
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        complete: false,
        config: {
          hasYnabApiKey: false,
          inboxPath: "/tmp/in",
          processedPath: "/tmp/out",
        },
        auth: { username: "u", password: "p" },
      }),
    });
  });

  // App status — drives splash-screen → wizard vs. main-view decision.
  await page.route("**/status", (route) => {
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        setup: false,
        llmReady: false,
        watcher: { running: false, path: "" },
      }),
    });
  });

  // Model list — step 1 of the wizard fetches this.
  await page.route("**/models/available", (route) => {
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        {
          id: "llama3.1-8b",
          name: "Llama 3.1 8B",
          size: "4.9 GB",
          downloaded: modelsDownloaded,
        },
      ]),
    });
  });

  // SSE token endpoint — required for watcher event stream.
  await page.route("**/auth/sse-token", (route) => {
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ token: "test-token" }),
    });
  });

  // Setup save — wizard calls this when persisting configuration.
  await page.route("**/setup/save", (route) => {
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ success: true }),
    });
  });

  // Pending files — main view polls this; return empty list.
  await page.route("**/pending", (route) => {
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([]),
    });
  });

  // History — main view loads import history; return empty list.
  await page.route("**/history", (route) => {
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([]),
    });
  });
}

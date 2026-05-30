// Process-level safety net for the backend sidecar.
//
// WHY (2026-05-29): @actual-app/api's downloadBudget()/_fullSync spawns a
// DETACHED background sync. When the configured Actual Sync ID doesn't exist
// on the server it rejects with `PostError: file-not-found` OFF the awaited
// chain, so no try/catch in ActualBudgetProvider.ensureBudget can catch it.
// With no `unhandledRejection` listener, Node promotes that orphan rejection
// to a fatal uncaughtException and the ENTIRE sidecar exits (code 1) — taking
// the LLM, the inbox watcher, and every endpoint down, just because the app
// was pointed at a budget that no longer exists.
//
// Registering a listener stops Node's fatal promotion: a stray rejection no
// longer kills the process, while the UI still gets the clean "Could not load
// the selected Actual budget — confirm the Sync ID" 500 from ensureBudget's
// own catch. We log loudly (with stack) so a swallowed rejection is never
// silent and stays diagnosable. See docs/DECISIONS.md 2026-05-29.
type Logger = Pick<Console, "error">;

export function makeRejectionHandler(logger: Logger) {
  return (reason: unknown): void => {
    const detail =
      reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
    logger.error(
      `[process-guard] Unhandled promise rejection — sidecar kept alive:\n${detail}`,
    );
  };
}

/** Install the process-level guards. Returns an uninstall fn (used by tests). */
export function installProcessGuards(logger: Logger = console): () => void {
  const handler = makeRejectionHandler(logger);
  process.on("unhandledRejection", handler);
  return () => {
    process.off("unhandledRejection", handler);
  };
}

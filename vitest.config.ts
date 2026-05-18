import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    // Default to node for backend tests; src/** runs in happy-dom for
    // React component testing (window/document/EventSource).
    environment: "node",
    environmentMatchGlobs: [["src/**", "happy-dom"]],
    include: ["**/*.test.ts", "**/*.test.tsx"],
    // Anchor with **/ so NESTED node_modules/dist (e.g. a stray
    // .claude/worktrees/*/node_modules) are excluded too — a bare
    // "node_modules/**" only matches the repo-root one and let a
    // worktree's bundled third-party tests (zod) into the run.
    exclude: ["**/node_modules/**", "**/dist/**", "src-tauri/**", "**/.claude/**"],
    restoreMocks: true,
  },
});

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    // Default to node for backend tests; src/** runs in happy-dom for
    // React component testing (window/document/EventSource).
    environment: "node",
    environmentMatchGlobs: [["src/**", "happy-dom"]],
    include: ["**/*.test.ts", "**/*.test.tsx"],
    exclude: ["node_modules/**", "dist/**", "src-tauri/**"],
    restoreMocks: true,
  },
});

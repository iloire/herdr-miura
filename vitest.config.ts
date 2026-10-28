import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // Agent worktrees hold other agents' unfinished work.
    exclude: ["**/node_modules/**", ".claude/**"],
  },
});

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
// @ts-expect-error type error without @types/node package
import process from "node:process";
// @ts-expect-error type error without @types/node package
import { execSync } from "node:child_process";
const host = process.env.TAURI_DEV_HOST;

/// The checked-out branch, so a dev window says which one it runs; empty on
/// `main` (the app in daily use), outside Git or on a detached HEAD.
function branch(): string {
  try {
    const name = execSync("git rev-parse --abbrev-ref HEAD", { encoding: "utf8" }).trim();
    return name === "HEAD" || name === "main" ? "" : name;
  } catch {
    return "";
  }
}

// https://vite.dev/config/
export default defineConfig(({ command }) => ({
  plugins: [react()],
  // `vite` serving (`tauri dev`) off `main` gets its branch. A built app shows no dev bar, unless
  // it is the Edge channel, which herdr-channels labels with its commit (docs/channels.md).
  define: { __DEV_BRANCH__: JSON.stringify(process.env.HERDR_BUILD_LABEL || (command === "serve" ? branch() : "")) },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));

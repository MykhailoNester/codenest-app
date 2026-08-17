import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Tauri expects a fixed port and prefers no auto-redirect.
// See: https://v2.tauri.app/start/frontend-configuration/vite/
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: "127.0.0.1",
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: "es2022",
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    // Vite 8 (rolldown) defaults to oxc minifier; do not pin esbuild here.
  },
  test: {
    environment: "jsdom",
    include: ["src/**/__tests__/**/*.test.ts", "src/**/__tests__/**/*.test.tsx"],
    // Fills jsdom's layout-shaped gaps (see the file) so a component that
    // observes its own box on mount is testable without every one of its test
    // files hand-rolling the same stub.
    setupFiles: ["src/test-setup.ts"],
  },
});

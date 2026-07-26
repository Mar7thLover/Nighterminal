import { defineConfig } from "vite";

// Tauri drives this dev server; keep the port fixed so tauri.conf.json can point at it.
export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: "127.0.0.1",
    watch: {
      // Rust sources are watched by the Tauri CLI, not Vite.
      ignored: ["**/src-tauri/**"],
    },
  },
  build: {
    // Tauri ships a modern WebView2, so nothing needs down-levelling. Vite 8
    // minifies with oxc; the esbuild path is deprecated and unbundled.
    target: "esnext",
    minify: "oxc",
    sourcemap: false,
  },
});

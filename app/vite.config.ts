import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    // engine 里有 1.6G venv 和 ComfyUI 源码，不参与前端热更新
    watch: { ignored: ["**/src-tauri/**", "**/engine/**"] },
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: "chrome110",
    minify: false,
    sourcemap: true,
  },
});

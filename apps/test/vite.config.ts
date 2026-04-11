import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import syncengine from "@syncengine/vite-plugin";

export default defineConfig({
  plugins: [syncengine(), react()],
  build: { target: "esnext" },
  server: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
  optimizeDeps: {
    exclude: ["@sqlite.org/sqlite-wasm"],
  },
});

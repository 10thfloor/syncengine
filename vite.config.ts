import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [
    react({
      exclude: [/workers\//, /\.worker\./],
    }),
  ],
  build: {
    target: 'esnext' // This natively enables top-level await
  },
  server: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
  optimizeDeps: {
    exclude: ['dbsp-engine', '@sqlite.org/sqlite-wasm'] 
  }
});
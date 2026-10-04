import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The client builds into dist/public, which the server serves; in dev, Vite
// proxies /api to the server started with `npm run dev:server`.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist/public",
    emptyOutDir: true,
    target: "safari16",
    chunkSizeWarningLimit: 1200,
  },
  worker: { format: "es" },
  server: {
    host: true,
    proxy: { "/api": "http://localhost:3000" },
  },
});

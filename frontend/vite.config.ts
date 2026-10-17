import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In development the app API runs on :4000; /api is proxied so the browser sees one origin.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/api": { target: process.env.API_URL ?? "http://localhost:4000", changeOrigin: true } },
  },
});

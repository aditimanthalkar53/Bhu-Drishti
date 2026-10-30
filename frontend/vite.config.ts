import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

// Writes .br and .gz copies next to every text asset in dist/, so the server sends compressed files
// (3-5x smaller) without compressing on each request.
function precompress(): Plugin {
  let outDir = "dist";
  return {
    name: "precompress",
    apply: "build",
    configResolved(c) { outDir = c.build.outDir; },
    closeBundle() {
      const walk = (dir: string): string[] =>
        readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]));
      for (const file of walk(outDir)) {
        if (!/\.(js|css|html|svg|json|txt)$/.test(file)) continue;
        const raw = readFileSync(file);
        if (raw.length < 1024) continue;
        writeFileSync(`${file}.br`, brotliCompressSync(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }));
        writeFileSync(`${file}.gz`, gzipSync(raw, { level: 9 }));
      }
    },
  };
}

// In development the app API runs on :4000; /api is proxied so the browser sees one origin.
export default defineConfig({
  plugins: [react(), precompress()],
  server: {
    port: 5173,
    proxy: { "/api": { target: process.env.API_URL ?? "http://localhost:4000", changeOrigin: true } },
  },
});

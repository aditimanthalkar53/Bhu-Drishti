import { existsSync } from "node:fs";
import { join } from "node:path";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";

/**
 * Serve the built website (frontend/dist) from the API itself, so the whole app runs as one process
 * behind one port. Unknown non-API paths get index.html (client-side routes like /app/dashboard).
 * `frameAncestors` lists extra sites allowed to embed the app (e.g. https://huggingface.co for a Space page).
 */
export async function webRoutes(app: FastifyInstance, root: string, frameAncestors: string[] = []) {
  if (!existsSync(join(root, "index.html"))) throw new Error(`STATIC_DIR has no index.html: ${root}`);

  const csp = [
    "default-src 'self'", "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com", "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: blob: https:", "connect-src 'self'", "worker-src 'self' blob:",
    "object-src 'none'", "base-uri 'self'", "form-action 'self'",
    `frame-ancestors 'self'${frameAncestors.map((a) => ` ${a}`).join("")}`,
  ].join("; ");

  app.addHook("onSend", async (_req, reply, payload) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "strict-origin-when-cross-origin");
    reply.header("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
    reply.header("Content-Security-Policy", csp);
    if (!frameAncestors.length) reply.header("X-Frame-Options", "SAMEORIGIN");
    // files may be sent brotli/gzip-encoded: caches must keep one copy per Accept-Encoding
    const vary = String(reply.getHeader("vary") ?? "");
    if (!/accept-encoding/i.test(vary)) reply.header("Vary", vary ? `${vary}, Accept-Encoding` : "Accept-Encoding");
    return payload;
  });

  await app.register(fastifyStatic, {
    root,
    wildcard: true,
    index: "index.html",
    cacheControl: false,   // the plugin's default (max-age=0) would overwrite the headers below
    preCompressed: true,   // send the .br/.gz copies the frontend build writes next to each file
    setHeaders(res, path) {
      // hashed build assets never change; everything else (index.html, theme-init.js) is revalidated
      res.setHeader("Cache-Control", /[\\/]assets[\\/]/.test(path) ? "public, max-age=31536000, immutable" : "no-cache");
    },
  });

  app.setNotFoundHandler((req, reply) => {
    if ((req.method === "GET" || req.method === "HEAD") && !req.url.startsWith("/api/")) {
      return reply.header("Cache-Control", "no-cache").sendFile("index.html");
    }
    return reply.code(404).send({ error: "not found" });
  });
}

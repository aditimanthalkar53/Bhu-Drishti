import { createHash, randomBytes, randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { authLimiter } from "./ratelimit.js";
import type { Store, User } from "./store/types.js";

declare module "fastify" {
  interface FastifyRequest {
    userId?: string;
  }
  interface FastifyInstance {
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: { sub: string; name: string };
    user: { sub: string; name: string };
  }
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export function publicUser(u: User) {
  return { id: u.id, email: u.email, name: u.name, guest: u.passwordHash === null };
}

/**
 * Accepts, in order: `x-api-key` header, `Authorization: Bearer <jwt>`, or `?token=<jwt>`
 * (the query form exists because browser EventSource cannot send headers).
 */
export function registerAuth(app: FastifyInstance, store: Store) {
  app.decorate("authenticate", async (req: FastifyRequest, reply: FastifyReply) => {
    const apiKey = req.headers["x-api-key"];
    if (typeof apiKey === "string" && apiKey) {
      const k = await store.apiKeyByHash(sha256(apiKey));
      if (!k) return reply.code(401).send({ error: "invalid API key" });
      req.userId = k.userId;
      return;
    }
    let token: string | undefined;
    const h = req.headers.authorization;
    if (h?.startsWith("Bearer ")) token = h.slice(7);
    else if (typeof (req.query as any)?.token === "string") token = (req.query as any).token;
    if (!token) return reply.code(401).send({ error: "authentication required" });
    try {
      const payload = app.jwt.verify<{ sub: string }>(token);
      req.userId = payload.sub;
    } catch {
      return reply.code(401).send({ error: "invalid or expired token" });
    }
  });
}

export function authRoutes(app: FastifyInstance, store: Store, opts: { allowGuest: boolean }) {
  const issue = (u: User) => ({ token: app.jwt.sign({ sub: u.id, name: u.name }, { expiresIn: "7d" }), user: publicUser(u) });

  app.post<{ Body: { email: string; password: string; name?: string } }>("/api/auth/register", {
    schema: {
      body: {
        type: "object", required: ["email", "password"],
        properties: { email: { type: "string", minLength: 3, maxLength: 200 }, password: { type: "string", minLength: 8, maxLength: 200 }, name: { type: "string", maxLength: 100 } },
      },
    },
  }, async (req, reply) => {
    const ip = req.ip;
    if (!authLimiter.check(`reg:${ip}`)) return reply.code(429).send({ error: "too many requests — try again in a minute" });
    const email = req.body.email.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return reply.code(400).send({ error: "invalid email" });
    if (await store.userByEmail(email)) return reply.code(409).send({ error: "email already registered" });
    const u = await store.createUser({
      id: randomUUID(), email, name: req.body.name?.trim() || email.split("@")[0],
      passwordHash: await bcrypt.hash(req.body.password, 10), createdAt: new Date().toISOString(),
    });
    await ensureDefaultProject(store, u.id);
    return reply.code(201).send(issue(u));
  });

  app.post<{ Body: { email: string; password: string } }>("/api/auth/login", {
    schema: { body: { type: "object", required: ["email", "password"], properties: { email: { type: "string" }, password: { type: "string" } } } },
  }, async (req, reply) => {
    const ip = req.ip;
    if (!authLimiter.check(`login:${ip}`)) return reply.code(429).send({ error: "too many requests — try again in a minute" });
    const u = await store.userByEmail(req.body.email.trim().toLowerCase());
    if (!u || !u.passwordHash || !(await bcrypt.compare(req.body.password, u.passwordHash))) {
      return reply.code(401).send({ error: "wrong email or password" });
    }
    return issue(u);
  });

  app.post("/api/auth/guest", async (_req, reply) => {
    if (!opts.allowGuest) return reply.code(403).send({ error: "guest access disabled" });
    const id = randomUUID();
    const u = await store.createUser({
      id, email: `guest-${id.slice(0, 8)}@guest.local`, name: "Guest", passwordHash: null, createdAt: new Date().toISOString(),
    });
    await ensureDefaultProject(store, u.id);
    return reply.code(201).send(issue(u));
  });

  app.get("/api/auth/me", { preHandler: app.authenticate }, async (req, reply) => {
    const u = await store.userById(req.userId!);
    if (!u) return reply.code(404).send({ error: "user not found" });
    return publicUser(u);
  });

  // API keys for programmatic access (shown once at creation)
  app.get("/api/keys", { preHandler: app.authenticate }, async (req) =>
    (await store.apiKeysFor(req.userId!)).map(({ hash: _h, ...k }) => k));

  app.post<{ Body: { label?: string } }>("/api/keys", { preHandler: app.authenticate }, async (req, reply) => {
    const key = `bd_${randomBytes(24).toString("base64url")}`;
    const k = await store.createApiKey({
      id: randomUUID(), userId: req.userId!, label: req.body?.label?.slice(0, 80) || "API key",
      prefix: key.slice(0, 10), hash: sha256(key), createdAt: new Date().toISOString(),
    });
    return reply.code(201).send({ id: k.id, label: k.label, prefix: k.prefix, createdAt: k.createdAt, key });
  });

  app.delete<{ Params: { id: string } }>("/api/keys/:id", { preHandler: app.authenticate }, async (req, reply) => {
    const ok = await store.deleteApiKey(req.userId!, req.params.id);
    return ok ? { ok: true } : reply.code(404).send({ error: "not found" });
  });
}

export async function ensureDefaultProject(store: Store, userId: string) {
  const existing = await store.projectsFor(userId);
  if (existing.length) return existing[0];
  return store.createProject({
    id: randomUUID(), ownerId: userId, name: "My first project",
    description: "Default project", createdAt: new Date().toISOString(),
  });
}

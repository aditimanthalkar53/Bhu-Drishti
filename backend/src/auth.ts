import { createHash, randomBytes, randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { authLimiter } from "./ratelimit.js";
import { sendMail, smtpConfigured } from "./email.js";
import type { Store, StoredRecord, User } from "./store/types.js";

const RESET_TTL_MS = 30 * 60_000;

/** Invalidate every login token of this user issued before now (password change/reset, "sign out everywhere"). */
export async function revokeTokens(store: Store, userId: string) {
  const now = Math.floor(Date.now() / 1000) * 1000;
  await store.putRecord("tokens", { id: userId, ownerId: userId, createdAt: new Date().toISOString(), validAfter: now });
}

declare module "fastify" {
  interface FastifyRequest {
    userId?: string;
    tokenIat?: number;
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
export function registerAuth(app: FastifyInstance, store: Store, opts: { allowGuest: boolean } = { allowGuest: false }) {
  app.decorate("authenticate", async (req: FastifyRequest, reply: FastifyReply) => {
    await authenticateInner(req, reply);
    if (reply.sent || !req.userId) return;
    // the application requires a real account: tokens of old guest sessions no longer work
    const u = await store.userById(req.userId);
    if (!u) return reply.code(401).send({ error: "account not found — please sign in again" });
    if (u.passwordHash === null && !opts.allowGuest) return reply.code(401).send({ error: "please sign in with an account" });
    // server-side sign-out: tokens issued before a password change / "sign out everywhere" are refused
    if (req.tokenIat !== undefined) {
      const rev = await store.getRecord<StoredRecord & { validAfter: number }>("tokens", u.id);
      if (rev && req.tokenIat * 1000 < rev.validAfter) return reply.code(401).send({ error: "your session has ended — please sign in again" });
    }
  });

  async function authenticateInner(req: FastifyRequest, reply: FastifyReply) {
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
      const payload = app.jwt.verify<{ sub: string; iat?: number }>(token);
      req.userId = payload.sub;
      req.tokenIat = payload.iat;
    } catch {
      return reply.code(401).send({ error: "invalid or expired token" });
    }
  }
}

export function authRoutes(app: FastifyInstance, store: Store, opts: { allowGuest: boolean; appUrl?: string }) {
  const issue = (u: User) => ({ token: app.jwt.sign({ sub: u.id, name: u.name }, { expiresIn: "24h" }), user: publicUser(u) });

  // ---- forgotten password: email a single-use link valid for 30 minutes. Always answers the same way,
  // so the endpoint cannot be used to find out which emails have accounts.
  app.post<{ Body: { email: string } }>("/api/auth/forgot", {
    schema: { body: { type: "object", required: ["email"], properties: { email: { type: "string", maxLength: 200 } } } },
  }, async (req, reply) => {
    if (!authLimiter.check(`forgot:${req.ip}`)) return reply.code(429).send({ error: "too many requests — try again in a minute" });
    const generic = { ok: true, message: "If an account exists for that email, a reset link is on its way. It is valid for 30 minutes." };
    if (!smtpConfigured()) {   // checked before the lookup, so the answer never depends on whether the account exists
      req.log.error("password reset requested but SMTP is not configured");
      return reply.code(503).send({ error: "Password reset by email is not available right now. Contact your administrator." });
    }
    const u = await store.userByEmail(req.body.email.trim().toLowerCase());
    if (!u || !u.passwordHash) return generic;
    const token = randomBytes(32).toString("base64url");
    await store.putRecord("reset", { id: sha256(token), ownerId: u.id, createdAt: new Date().toISOString(), expiresAt: Date.now() + RESET_TTL_MS });
    const link = `${opts.appUrl ?? "http://localhost:8081"}/reset-password?token=${encodeURIComponent(token)}`;
    try {
      await sendMail({
        to: u.email, subject: "Reset your Bhu-Drishti password",
        text: `Hello ${u.name},\n\nUse this link to choose a new password (valid for 30 minutes):\n${link}\n\nIf you did not ask for this, ignore this email — your password stays the same.\n\n— Bhu-Drishti`,
        html: `<p>Hello ${u.name.replace(/[<>&]/g, "")},</p><p><a href="${link}">Choose a new password</a> (valid for 30 minutes).</p>` +
          `<p style="color:#666;font-size:12px">If you did not ask for this, ignore this email — your password stays the same.</p>`,
      });
    } catch (e) {
      req.log.error({ err: e }, "password reset email failed");
    }
    return generic;
  });

  app.post<{ Body: { token: string; password: string } }>("/api/auth/reset", {
    schema: { body: { type: "object", required: ["token", "password"],
      properties: { token: { type: "string", minLength: 20, maxLength: 200 }, password: { type: "string", minLength: 8, maxLength: 200 } } } },
  }, async (req, reply) => {
    if (!authLimiter.check(`reset:${req.ip}`)) return reply.code(429).send({ error: "too many requests — try again in a minute" });
    const id = sha256(req.body.token);
    const rec = await store.getRecord<StoredRecord & { expiresAt: number }>("reset", id);
    if (!rec || rec.expiresAt < Date.now()) {
      if (rec) await store.deleteRecord("reset", id);
      return reply.code(400).send({ error: "This reset link is invalid or has expired. Ask for a new one." });
    }
    await store.deleteRecord("reset", id);   // single use
    await store.setPasswordHash(rec.ownerId, await bcrypt.hash(req.body.password, 10));
    await revokeTokens(store, rec.ownerId);
    const u = await store.userById(rec.ownerId);
    return issue(u!);
  });

  app.post("/api/auth/logout-everywhere", { preHandler: app.authenticate }, async (req) => {
    await revokeTokens(store, req.userId!);
    return { ok: true };
  });

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

  app.post<{ Body: { current: string; next: string } }>("/api/auth/password", {
    preHandler: app.authenticate,
    schema: { body: { type: "object", required: ["current", "next"],
      properties: { current: { type: "string", maxLength: 200 }, next: { type: "string", minLength: 8, maxLength: 200 } } } },
  }, async (req, reply) => {
    if (!authLimiter.check(`pw:${req.userId}`)) return reply.code(429).send({ error: "too many requests — try again in a minute" });
    const u = await store.userById(req.userId!);
    if (!u?.passwordHash || !(await bcrypt.compare(req.body.current, u.passwordHash))) {
      return reply.code(401).send({ error: "current password is wrong" });
    }
    await store.setPasswordHash(u.id, await bcrypt.hash(req.body.next, 10));
    await revokeTokens(store, u.id);       // sign out every other device
    return { ok: true, ...issue(u) };      // …but keep this one signed in
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

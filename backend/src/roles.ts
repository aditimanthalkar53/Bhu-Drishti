import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { audit } from "./delivery.js";
import type { Store, StoredRecord, User } from "./store/types.js";

/**
 * Three roles. Citizens and volunteers choose their own; authority is never self-assigned: it comes from the
 * AUTHORITY_EMAILS allow-list, or from an allow-listed authority granting it on the admin route.
 * The role lives in a "profile" record (no change to the users table), travels in the JWT for the website,
 * and is re-read from the profile on every role-guarded request so a removed authority loses access at once.
 */
export type Role = "citizen" | "volunteer" | "authority";
export const SELF_ROLES: Role[] = ["citizen", "volunteer"];
export const LANGUAGES = ["en", "hi", "kn", "as"] as const;
export type Language = (typeof LANGUAGES)[number];

export interface Profile extends StoredRecord {
  role: Role;
  email: string;
  displayName: string;
  phone?: string | null;
  ward?: string | null;
  language: Language;
  skills: string[];
  resources: string[];
  /** who granted authority on the admin route (absent for allow-listed and self-chosen roles) */
  grantedBy?: string | null;
}

declare module "fastify" {
  interface FastifyRequest {
    role?: Role;
  }
  interface FastifyInstance {
    roles: Roles;
  }
}

const now = () => new Date().toISOString();
const clean = (s: unknown, max: number) => (typeof s === "string" ? s.trim().slice(0, max) : "");
const list = (v: unknown, max = 12) => (Array.isArray(v) ? v.map((x) => clean(x, 60)).filter(Boolean).slice(0, max) : []);

export class Roles {
  private allow: Set<string>;
  constructor(private store: Store, authorityEmails: string[]) {
    this.allow = new Set(authorityEmails.map((e) => e.toLowerCase()));
  }

  isAllowListed(email: string) {
    return this.allow.has(email.toLowerCase());
  }

  /** The user's profile, created on first use (existing accounts become citizens). */
  async profile(u: User): Promise<Profile> {
    const p = await this.store.getRecord<Profile>("profile", u.id);
    if (p) return p;
    const fresh: Profile = { id: u.id, ownerId: u.id, createdAt: now(), role: "citizen", email: u.email, displayName: u.name,
      language: "en", skills: [], resources: [] };
    return this.store.putRecord("profile", fresh);
  }

  async roleOf(u: User): Promise<Role> {
    if (this.isAllowListed(u.email)) return "authority";
    const p = await this.profile(u);
    if (p.role === "authority" && !p.grantedBy) return "citizen";   // never trust an authority role nobody granted
    return p.role;
  }

  async roleOfId(userId: string): Promise<Role | null> {
    const u = await this.store.userById(userId);
    return u ? this.roleOf(u) : null;
  }

  /** User ids of every authority (allow-listed accounts that exist, plus granted ones). */
  async authorityIds(): Promise<string[]> {
    const ids = new Set<string>();
    for (const e of this.allow) {
      const u = await this.store.userByEmail(e);
      if (u) ids.add(u.id);
    }
    for (const p of await this.store.listRecords<Profile>("profile")) if (p.role === "authority" && p.grantedBy) ids.add(p.id);
    return [...ids];
  }

  /** preHandler (after app.authenticate): only these roles may continue. Sets req.role. */
  require(...roles: Role[]) {
    return async (req: FastifyRequest, reply: FastifyReply) => {
      if (reply.sent || !req.userId) return;
      const role = await this.roleOfId(req.userId);
      if (!role) return reply.code(401).send({ error: "account not found" });
      req.role = role;
      if (roles.length && !roles.includes(role)) return reply.code(403).send({ error: `this needs the ${roles.join(" or ")} role` });
    };
  }
}

/** Shorthand used by route files: authenticated + role check. */
export function guard(app: FastifyInstance, ...roles: Role[]) {
  return { preHandler: [app.authenticate, app.roles.require(...roles)] };
}

export function profileRoutes(app: FastifyInstance, store: Store) {
  const roles = app.roles;

  app.get("/api/profile", guard(app), async (req) => {
    const u = (await store.userById(req.userId!))!;
    return { ...(await roles.profile(u)), role: req.role };
  });

  app.patch<{ Body: Partial<Profile> }>("/api/profile", {
    ...guard(app),
    schema: { body: { type: "object", properties: {
      role: { type: "string", enum: SELF_ROLES }, displayName: { type: "string", maxLength: 100 }, phone: { type: ["string", "null"], maxLength: 30 },
      ward: { type: ["string", "null"], maxLength: 80 }, language: { type: "string", enum: [...LANGUAGES] },
      skills: { type: "array", maxItems: 12, items: { type: "string" } }, resources: { type: "array", maxItems: 12, items: { type: "string" } } } } },
  }, async (req, reply) => {
    const u = (await store.userById(req.userId!))!;
    const p = await roles.profile(u);
    const b = req.body;
    // an authority keeps the role; changing it away is done by an administrator
    if (b.role && req.role === "authority") return reply.code(409).send({ error: "authority accounts change role through an administrator" });
    const next: Profile = { ...p, updatedAt: now(),
      ...(b.role ? { role: b.role } : {}),
      ...(b.displayName !== undefined ? { displayName: clean(b.displayName, 100) || u.name } : {}),
      ...(b.phone !== undefined ? { phone: clean(b.phone, 30) || null } : {}),
      ...(b.ward !== undefined ? { ward: clean(b.ward, 80) || null } : {}),
      ...(b.language ? { language: b.language } : {}),
      ...(b.skills ? { skills: list(b.skills) } : {}),
      ...(b.resources ? { resources: list(b.resources) } : {}) };
    await store.putRecord("profile", next);
    return { ...next, role: await roles.roleOf(u) };
  });

  // ---- administration: authorities see people; only allow-listed authorities change roles
  app.get<{ Querystring: { role?: Role } }>("/api/admin/users", guard(app, "authority"), async (req) => {
    const out = [];
    for (const p of await store.listRecords<Profile>("profile")) {
      const u = await store.userById(p.id);
      if (!u || u.passwordHash === null) continue;
      const role = await roles.roleOf(u);
      if (req.query.role && role !== req.query.role) continue;
      out.push({ id: u.id, email: u.email, name: p.displayName || u.name, role, phone: p.phone ?? null, ward: p.ward ?? null,
        language: p.language, skills: p.skills, resources: p.resources, allowListed: roles.isAllowListed(u.email), createdAt: u.createdAt });
    }
    return out;
  });

  app.post<{ Params: { id: string }; Body: { role: Role } }>("/api/admin/users/:id/role", {
    ...guard(app, "authority"),
    schema: { body: { type: "object", required: ["role"], properties: { role: { type: "string", enum: ["citizen", "volunteer", "authority"] } } } },
  }, async (req, reply) => {
    const me = (await store.userById(req.userId!))!;
    if (!roles.isAllowListed(me.email)) return reply.code(403).send({ error: "only an allow-listed authority (AUTHORITY_EMAILS) can change roles" });
    const u = await store.userById(req.params.id);
    if (!u) return reply.code(404).send({ error: "user not found" });
    if (roles.isAllowListed(u.email)) return reply.code(409).send({ error: "this account is an authority through AUTHORITY_EMAILS; change it there" });
    const p = await roles.profile(u);
    const next: Profile = { ...p, role: req.body.role, grantedBy: req.body.role === "authority" ? me.id : null, updatedAt: now() };
    await store.putRecord("profile", next);
    await audit(store, me.id, me.id, "role.set", `user:${u.id}`, { role: req.body.role, email: u.email }, me.name);
    return { id: u.id, role: req.body.role };
  });
}

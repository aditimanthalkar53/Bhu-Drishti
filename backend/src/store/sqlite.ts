import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ApiKey, Project, QuerySession, RecordKind, Store, StoredRecord, User } from "./types.js";

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  password_hash TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS query_sessions (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, question TEXT NOT NULL, region_id TEXT NOT NULL,
  status TEXT NOT NULL, answer TEXT, estimate TEXT, result TEXT, source TEXT NOT NULL DEFAULT 'user',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_sessions_project ON query_sessions(project_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON query_sessions(user_id, created_at);
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, label TEXT NOT NULL,
  prefix TEXT NOT NULL, hash TEXT UNIQUE NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS records (
  kind TEXT NOT NULL, id TEXT NOT NULL, owner_id TEXT NOT NULL, data TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (kind, id));
CREATE INDEX IF NOT EXISTS idx_records_owner ON records(kind, owner_id, created_at);
`;

const parse = <T>(s: unknown): T | null => (typeof s === "string" && s ? (JSON.parse(s) as T) : null);
const json = (v: unknown) => (v === undefined || v === null ? null : JSON.stringify(v));

function toUser(r: any): User {
  return { id: r.id, email: r.email, name: r.name, passwordHash: r.password_hash ?? null, createdAt: r.created_at };
}
function toProject(r: any): Project {
  return { id: r.id, ownerId: r.owner_id, name: r.name, description: r.description, createdAt: r.created_at };
}
function toSession(r: any): QuerySession {
  return {
    id: r.id, projectId: r.project_id, userId: r.user_id, question: r.question, regionId: r.region_id, status: r.status,
    answer: r.answer ?? null, estimate: parse(r.estimate), result: parse(r.result), source: r.source ?? "user",
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}
function toKey(r: any): ApiKey {
  return { id: r.id, userId: r.user_id, label: r.label, prefix: r.prefix, hash: r.hash, createdAt: r.created_at };
}

/**
 * SQLite store (default): users and their login, projects, query sessions, API keys and the
 * product records, in one file. Uses Node's built-in `node:sqlite` (no native addon to compile).
 */
export class SqliteStore implements Store {
  private db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
  }

  async init() {
    this.db.exec(SCHEMA);
  }

  close() {
    this.db.close();
  }

  // ---------------------------------------------------------------- users
  async createUser(u: User) {
    this.db.prepare("INSERT INTO users (id,email,name,password_hash,created_at) VALUES (?,?,?,?,?)")
      .run(u.id, u.email.toLowerCase(), u.name, u.passwordHash, u.createdAt);
    return u;
  }
  async userByEmail(email: string) {
    const r = this.db.prepare("SELECT * FROM users WHERE email = ?").get(email.toLowerCase());
    return r ? toUser(r) : undefined;
  }
  async userById(id: string) {
    const r = this.db.prepare("SELECT * FROM users WHERE id = ?").get(id);
    return r ? toUser(r) : undefined;
  }
  async setPasswordHash(id: string, hash: string) {
    this.db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hash, id);
  }

  // ---------------------------------------------------------------- projects
  async createProject(p: Project) {
    this.db.prepare("INSERT INTO projects (id,owner_id,name,description,created_at) VALUES (?,?,?,?,?)")
      .run(p.id, p.ownerId, p.name, p.description, p.createdAt);
    return p;
  }
  async projectsFor(userId: string) {
    return this.db.prepare("SELECT * FROM projects WHERE owner_id = ? ORDER BY created_at DESC").all(userId).map(toProject);
  }
  async project(id: string) {
    const r = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id);
    return r ? toProject(r) : undefined;
  }

  // ---------------------------------------------------------------- sessions
  async createSession(s: QuerySession) {
    this.db.prepare(`INSERT INTO query_sessions (id,project_id,user_id,question,region_id,status,answer,estimate,result,source,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(s.id, s.projectId, s.userId, s.question, s.regionId, s.status, s.answer, json(s.estimate), json(s.result),
        s.source ?? "user", s.createdAt, s.updatedAt);
    return s;
  }
  async updateSession(id: string, patch: Partial<QuerySession>) {
    const cols: [keyof QuerySession, string, (v: unknown) => unknown][] = [
      ["status", "status", (v) => v], ["answer", "answer", (v) => v], ["estimate", "estimate", json], ["result", "result", json],
    ];
    const sets: string[] = [];
    const vals: (string | null)[] = [];
    for (const [k, col, conv] of cols) {
      if (k in patch) {
        sets.push(`${col} = ?`);
        vals.push(conv((patch as any)[k]) as string | null);
      }
    }
    if (!sets.length) return;
    vals.push(new Date().toISOString(), id);
    this.db.prepare(`UPDATE query_sessions SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`).run(...vals);
  }
  async session(id: string) {
    const r = this.db.prepare("SELECT * FROM query_sessions WHERE id = ?").get(id);
    return r ? toSession(r) : undefined;
  }
  async sessionsFor(projectId: string) {
    return this.db.prepare("SELECT * FROM query_sessions WHERE project_id = ? ORDER BY created_at DESC").all(projectId).map(toSession);
  }
  async sessionsForUser(userId: string, limit = 200) {
    return this.db.prepare("SELECT * FROM query_sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT ?").all(userId, limit).map(toSession);
  }

  // ---------------------------------------------------------------- API keys
  async createApiKey(k: ApiKey) {
    this.db.prepare("INSERT INTO api_keys (id,user_id,label,prefix,hash,created_at) VALUES (?,?,?,?,?,?)")
      .run(k.id, k.userId, k.label, k.prefix, k.hash, k.createdAt);
    return k;
  }
  async apiKeyByHash(hash: string) {
    const r = this.db.prepare("SELECT * FROM api_keys WHERE hash = ?").get(hash);
    return r ? toKey(r) : undefined;
  }
  async apiKeysFor(userId: string) {
    return this.db.prepare("SELECT * FROM api_keys WHERE user_id = ? ORDER BY created_at DESC").all(userId).map(toKey);
  }
  async deleteApiKey(userId: string, id: string) {
    return Number(this.db.prepare("DELETE FROM api_keys WHERE id = ? AND user_id = ?").run(id, userId).changes) > 0;
  }

  // ---------------------------------------------------------------- product records
  async putRecord<T extends StoredRecord>(kind: RecordKind, rec: T) {
    const now = new Date().toISOString();
    const data = { ...rec, updatedAt: now };
    this.db.prepare(`INSERT INTO records (kind,id,owner_id,data,created_at,updated_at) VALUES (?,?,?,?,?,?)
      ON CONFLICT(kind,id) DO UPDATE SET data = excluded.data, owner_id = excluded.owner_id, updated_at = excluded.updated_at`)
      .run(kind, rec.id, rec.ownerId, JSON.stringify(data), rec.createdAt, now);
    return data as T;
  }
  async getRecord<T extends StoredRecord>(kind: RecordKind, id: string) {
    const r = this.db.prepare("SELECT data FROM records WHERE kind = ? AND id = ?").get(kind, id) as { data: string } | undefined;
    return r ? (JSON.parse(r.data) as T) : undefined;
  }
  async listRecords<T extends StoredRecord>(kind: RecordKind, ownerId?: string) {
    const rows = (ownerId === undefined
      ? this.db.prepare("SELECT data FROM records WHERE kind = ? ORDER BY created_at DESC").all(kind)
      : this.db.prepare("SELECT data FROM records WHERE kind = ? AND owner_id = ? ORDER BY created_at DESC").all(kind, ownerId)) as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as T);
  }
  async deleteRecord(kind: RecordKind, id: string) {
    return Number(this.db.prepare("DELETE FROM records WHERE kind = ? AND id = ?").run(kind, id).changes) > 0;
  }
}

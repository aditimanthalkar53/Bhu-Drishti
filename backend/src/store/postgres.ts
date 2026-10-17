import pg from "pg";
import type { ApiKey, Project, QuerySession, RecordKind, Store, StoredRecord, User } from "./types.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  password_hash TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS query_sessions (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, question TEXT NOT NULL, region_id TEXT NOT NULL,
  status TEXT NOT NULL, answer TEXT, estimate JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS idx_sessions_project ON query_sessions(project_id);
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, label TEXT NOT NULL,
  prefix TEXT NOT NULL, hash TEXT UNIQUE NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
ALTER TABLE query_sessions ADD COLUMN IF NOT EXISTS result JSONB;
ALTER TABLE query_sessions ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'user';
CREATE INDEX IF NOT EXISTS idx_sessions_user ON query_sessions(user_id, created_at DESC);
CREATE TABLE IF NOT EXISTS records (
  kind TEXT NOT NULL, id TEXT NOT NULL, owner_id TEXT NOT NULL, data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, id));
CREATE INDEX IF NOT EXISTS idx_records_owner ON records(kind, owner_id, created_at DESC);
`;

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v));

function toUser(r: any): User {
  return { id: r.id, email: r.email, name: r.name, passwordHash: r.password_hash, createdAt: iso(r.created_at) };
}
function toProject(r: any): Project {
  return { id: r.id, ownerId: r.owner_id, name: r.name, description: r.description, createdAt: iso(r.created_at) };
}
function toSession(r: any): QuerySession {
  return {
    id: r.id, projectId: r.project_id, userId: r.user_id, question: r.question, regionId: r.region_id,
    status: r.status, answer: r.answer, estimate: r.estimate, result: r.result ?? null, source: r.source ?? "user",
    createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
  };
}
function toKey(r: any): ApiKey {
  return { id: r.id, userId: r.user_id, label: r.label, prefix: r.prefix, hash: r.hash, createdAt: iso(r.created_at) };
}

/** PostgreSQL (PostGIS-compatible) store. Enabled when DATABASE_URL is set. */
export class PostgresStore implements Store {
  private pool: pg.Pool;
  constructor(url: string) {
    this.pool = new pg.Pool({ connectionString: url });
  }

  async init() {
    await this.pool.query(SCHEMA);
  }

  async createUser(u: User) {
    await this.pool.query("INSERT INTO users (id,email,name,password_hash,created_at) VALUES ($1,$2,$3,$4,$5)", [
      u.id, u.email, u.name, u.passwordHash, u.createdAt,
    ]);
    return u;
  }
  async userByEmail(email: string) {
    const r = await this.pool.query("SELECT * FROM users WHERE email=$1", [email.toLowerCase()]);
    return r.rows[0] ? toUser(r.rows[0]) : undefined;
  }
  async userById(id: string) {
    const r = await this.pool.query("SELECT * FROM users WHERE id=$1", [id]);
    return r.rows[0] ? toUser(r.rows[0]) : undefined;
  }
  async setPasswordHash(id: string, hash: string) {
    await this.pool.query("UPDATE users SET password_hash=$1 WHERE id=$2", [hash, id]);
  }

  async createProject(p: Project) {
    await this.pool.query("INSERT INTO projects (id,owner_id,name,description,created_at) VALUES ($1,$2,$3,$4,$5)", [
      p.id, p.ownerId, p.name, p.description, p.createdAt,
    ]);
    return p;
  }
  async projectsFor(userId: string) {
    const r = await this.pool.query("SELECT * FROM projects WHERE owner_id=$1 ORDER BY created_at DESC", [userId]);
    return r.rows.map(toProject);
  }
  async project(id: string) {
    const r = await this.pool.query("SELECT * FROM projects WHERE id=$1", [id]);
    return r.rows[0] ? toProject(r.rows[0]) : undefined;
  }

  async createSession(s: QuerySession) {
    await this.pool.query(
      `INSERT INTO query_sessions (id,project_id,user_id,question,region_id,status,answer,estimate,result,source,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [s.id, s.projectId, s.userId, s.question, s.regionId, s.status, s.answer, s.estimate, s.result ?? null, s.source ?? "user",
        s.createdAt, s.updatedAt],
    );
    return s;
  }
  async sessionsForUser(userId: string, limit = 200) {
    const r = await this.pool.query("SELECT * FROM query_sessions WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2", [userId, limit]);
    return r.rows.map(toSession);
  }
  async updateSession(id: string, patch: Partial<QuerySession>) {
    const cols: Record<string, string> = { status: "status", answer: "answer", estimate: "estimate", result: "result" };
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, col] of Object.entries(cols)) {
      if (k in patch) {
        vals.push((patch as any)[k]);
        sets.push(`${col}=$${vals.length}`);
      }
    }
    if (!sets.length) return;
    vals.push(id);
    await this.pool.query(`UPDATE query_sessions SET ${sets.join(",")}, updated_at=now() WHERE id=$${vals.length}`, vals);
  }
  async session(id: string) {
    const r = await this.pool.query("SELECT * FROM query_sessions WHERE id=$1", [id]);
    return r.rows[0] ? toSession(r.rows[0]) : undefined;
  }
  async sessionsFor(projectId: string) {
    const r = await this.pool.query("SELECT * FROM query_sessions WHERE project_id=$1 ORDER BY created_at DESC", [projectId]);
    return r.rows.map(toSession);
  }

  async createApiKey(k: ApiKey) {
    await this.pool.query("INSERT INTO api_keys (id,user_id,label,prefix,hash,created_at) VALUES ($1,$2,$3,$4,$5,$6)", [
      k.id, k.userId, k.label, k.prefix, k.hash, k.createdAt,
    ]);
    return k;
  }
  async apiKeyByHash(hash: string) {
    const r = await this.pool.query("SELECT * FROM api_keys WHERE hash=$1", [hash]);
    return r.rows[0] ? toKey(r.rows[0]) : undefined;
  }
  async apiKeysFor(userId: string) {
    const r = await this.pool.query("SELECT * FROM api_keys WHERE user_id=$1 ORDER BY created_at DESC", [userId]);
    return r.rows.map(toKey);
  }
  async deleteApiKey(userId: string, id: string) {
    const r = await this.pool.query("DELETE FROM api_keys WHERE id=$1 AND user_id=$2", [id, userId]);
    return (r.rowCount ?? 0) > 0;
  }

  async putRecord<T extends StoredRecord>(kind: RecordKind, rec: T) {
    const now = new Date().toISOString();
    const data = { ...rec, updatedAt: now };
    await this.pool.query(
      `INSERT INTO records (kind,id,owner_id,data,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (kind,id) DO UPDATE SET data=EXCLUDED.data, owner_id=EXCLUDED.owner_id, updated_at=EXCLUDED.updated_at`,
      [kind, rec.id, rec.ownerId, data, rec.createdAt, now],
    );
    return data as T;
  }
  async getRecord<T extends StoredRecord>(kind: RecordKind, id: string) {
    const r = await this.pool.query("SELECT data FROM records WHERE kind=$1 AND id=$2", [kind, id]);
    return r.rows[0] ? (r.rows[0].data as T) : undefined;
  }
  async listRecords<T extends StoredRecord>(kind: RecordKind, ownerId?: string) {
    const r = ownerId === undefined
      ? await this.pool.query("SELECT data FROM records WHERE kind=$1 ORDER BY created_at DESC", [kind])
      : await this.pool.query("SELECT data FROM records WHERE kind=$1 AND owner_id=$2 ORDER BY created_at DESC", [kind, ownerId]);
    return r.rows.map((x) => x.data as T);
  }
  async deleteRecord(kind: RecordKind, id: string) {
    const r = await this.pool.query("DELETE FROM records WHERE kind=$1 AND id=$2", [kind, id]);
    return (r.rowCount ?? 0) > 0;
  }
}

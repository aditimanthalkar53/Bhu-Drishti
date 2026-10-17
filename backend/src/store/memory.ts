import type { ApiKey, Project, QuerySession, RecordKind, Store, StoredRecord, User } from "./types.js";

/** In-process store for development and tests. Data is lost on restart. */
export class MemoryStore implements Store {
  private users = new Map<string, User>();
  private projects = new Map<string, Project>();
  private sessions = new Map<string, QuerySession>();
  private keys = new Map<string, ApiKey>();
  private records = new Map<string, StoredRecord>();

  async init(): Promise<void> {}

  async createUser(u: User) {
    this.users.set(u.id, u);
    return u;
  }
  async userByEmail(email: string) {
    return [...this.users.values()].find((u) => u.email === email.toLowerCase());
  }
  async userById(id: string) {
    return this.users.get(id);
  }

  async createProject(p: Project) {
    this.projects.set(p.id, p);
    return p;
  }
  async projectsFor(userId: string) {
    return [...this.projects.values()].filter((p) => p.ownerId === userId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async project(id: string) {
    return this.projects.get(id);
  }

  async createSession(s: QuerySession) {
    this.sessions.set(s.id, s);
    return s;
  }
  async updateSession(id: string, patch: Partial<QuerySession>) {
    const s = this.sessions.get(id);
    if (s) this.sessions.set(id, { ...s, ...patch, updatedAt: new Date().toISOString() });
  }
  async session(id: string) {
    return this.sessions.get(id);
  }
  async sessionsFor(projectId: string) {
    return [...this.sessions.values()].filter((s) => s.projectId === projectId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async sessionsForUser(userId: string, limit = 200) {
    return [...this.sessions.values()].filter((s) => s.userId === userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
  }

  async createApiKey(k: ApiKey) {
    this.keys.set(k.id, k);
    return k;
  }
  async apiKeyByHash(hash: string) {
    return [...this.keys.values()].find((k) => k.hash === hash);
  }
  async apiKeysFor(userId: string) {
    return [...this.keys.values()].filter((k) => k.userId === userId);
  }
  async deleteApiKey(userId: string, id: string) {
    const k = this.keys.get(id);
    if (!k || k.userId !== userId) return false;
    return this.keys.delete(id);
  }

  async putRecord<T extends StoredRecord>(kind: RecordKind, rec: T) {
    const copy = structuredClone({ ...rec, updatedAt: new Date().toISOString() });
    this.records.set(`${kind}:${rec.id}`, copy);
    return structuredClone(copy) as T;
  }
  async getRecord<T extends StoredRecord>(kind: RecordKind, id: string) {
    const r = this.records.get(`${kind}:${id}`);
    return r ? (structuredClone(r) as T) : undefined;
  }
  async listRecords<T extends StoredRecord>(kind: RecordKind, ownerId?: string) {
    const out: T[] = [];
    for (const [k, v] of this.records) {
      if (k.startsWith(`${kind}:`) && (ownerId === undefined || v.ownerId === ownerId)) out.push(structuredClone(v) as T);
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async deleteRecord(kind: RecordKind, id: string) {
    return this.records.delete(`${kind}:${id}`);
  }
}

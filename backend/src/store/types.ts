export interface User {
  id: string;
  email: string;
  name: string;
  passwordHash: string | null; // null for guest users
  createdAt: string;
}

export interface Project {
  id: string;
  ownerId: string;
  name: string;
  description: string;
  createdAt: string;
}

export type SessionStatus = "queued" | "running" | "done" | "stopped" | "failed";

/** One natural-language question run against the engine. */
export interface QuerySession {
  id: string; // = engine job id
  projectId: string;
  userId: string;
  question: string;
  regionId: string;
  status: SessionStatus;
  answer: string | null;
  estimate: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface ApiKey {
  id: string;
  userId: string;
  label: string;
  prefix: string; // first chars, shown in UI
  hash: string; // sha256 of the full key
  createdAt: string;
}

export interface Store {
  init(): Promise<void>;
  createUser(u: User): Promise<User>;
  userByEmail(email: string): Promise<User | undefined>;
  userById(id: string): Promise<User | undefined>;

  createProject(p: Project): Promise<Project>;
  projectsFor(userId: string): Promise<Project[]>;
  project(id: string): Promise<Project | undefined>;

  createSession(s: QuerySession): Promise<QuerySession>;
  updateSession(id: string, patch: Partial<QuerySession>): Promise<void>;
  session(id: string): Promise<QuerySession | undefined>;
  sessionsFor(projectId: string): Promise<QuerySession[]>;

  createApiKey(k: ApiKey): Promise<ApiKey>;
  apiKeyByHash(hash: string): Promise<ApiKey | undefined>;
  apiKeysFor(userId: string): Promise<ApiKey[]>;
  deleteApiKey(userId: string, id: string): Promise<boolean>;
}

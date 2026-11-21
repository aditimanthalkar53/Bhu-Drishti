/**
 * Authentication state shared across the app.
 *
 * - Reads / writes the JWT in localStorage.
 * - Exposes the current user and login / register / logout helpers.
 * - The public website is open to everyone; every /app page needs a signed-in account
 *   (accounts are stored server-side in SQLite). There are no guest sessions.
 */
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api, post, setToken } from "./api";

export type Role = "citizen" | "volunteer" | "authority";

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  guest: boolean;
  /** set by the server; authority is never chosen by the user */
  role?: Role;
}

export interface SignupExtra { role?: "citizen" | "volunteer"; ward?: string; phone?: string; language?: string; skills?: string[]; resources?: string[] }

interface AuthCtx {
  user: AuthUser | null;
  loading: boolean;
  error: string | null;
  /** with a role, the account must have that role (each role signs in on its own page) */
  login(email: string, password: string, role?: Role): Promise<void>;
  register(email: string, password: string, name: string, extra?: SignupExtra): Promise<void>;
  logout(): void;
  clearError(): void;
}

const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // On mount, validate whatever token is in localStorage (old guest tokens are dropped).
  useEffect(() => {
    (async () => {
      try {
        const me = await api<AuthUser>("/api/auth/me");
        if (me.guest) throw new Error("guest sessions are no longer supported");
        setUser(me);
      } catch {
        setToken(null);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const handle = useCallback((r: { token: string; user: AuthUser }) => {
    setToken(r.token);
    setUser(r.user);
  }, []);

  const login = useCallback(async (email: string, password: string, role?: Role) => {
    setError(null);
    try {
      handle(await post<{ token: string; user: AuthUser }>("/api/auth/login", { email: email.trim(), password, ...(role ? { role } : {}) }));
    } catch (e) {
      setError((e as Error).message);
      throw e;
    }
  }, [handle]);

  const register = useCallback(async (email: string, password: string, name: string, extra: SignupExtra = {}) => {
    setError(null);
    try {
      const clean = Object.fromEntries(Object.entries(extra).filter(([, v]) => v !== undefined && v !== "" && !(Array.isArray(v) && v.length === 0)));
      handle(await post<{ token: string; user: AuthUser }>("/api/auth/register", { email: email.trim(), password, name: name.trim(), ...clean }));
    } catch (e) {
      setError((e as Error).message);
      throw e;
    }
  }, [handle]);

  const logout = useCallback(() => {
    setToken(null);
    setUser(null);
  }, []);

  const clearError = useCallback(() => setError(null), []);

  return (
    <Ctx.Provider value={{ user, loading, error, login, register, logout, clearError }}>
      {children}
    </Ctx.Provider>
  );
}

export function useAuth(): AuthCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}

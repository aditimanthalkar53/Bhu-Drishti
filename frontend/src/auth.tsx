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

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  guest: boolean;
}

interface AuthCtx {
  user: AuthUser | null;
  loading: boolean;
  error: string | null;
  login(email: string, password: string): Promise<void>;
  register(email: string, password: string, name: string): Promise<void>;
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

  const login = useCallback(async (email: string, password: string) => {
    setError(null);
    try {
      handle(await post<{ token: string; user: AuthUser }>("/api/auth/login", { email: email.trim(), password }));
    } catch (e) {
      setError((e as Error).message);
      throw e;
    }
  }, [handle]);

  const register = useCallback(async (email: string, password: string, name: string) => {
    setError(null);
    try {
      handle(await post<{ token: string; user: AuthUser }>("/api/auth/register", { email: email.trim(), password, name: name.trim() }));
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

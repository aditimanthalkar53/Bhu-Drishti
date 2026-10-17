/**
 * Authentication state and helpers shared across the whole app.
 *
 * - Reads / writes the JWT in localStorage.
 * - Exposes the current user, login / register / logout helpers, and a
 *   "guest session" creator used as the fallback for anonymous access.
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
  loginAsGuest(): Promise<void>;
  logout(): void;
  clearError(): void;
}

const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // On mount, validate whatever token is in localStorage.
  useEffect(() => {
    (async () => {
      try {
        const me = await api<AuthUser>("/api/auth/me");
        setUser(me);
      } catch {
        setToken(null);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const _handleAuth = useCallback(async (r: { token: string; user: AuthUser }) => {
    setToken(r.token);
    setUser(r.user);
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    setError(null);
    try {
      const r = await post<{ token: string; user: AuthUser }>("/api/auth/login", { email, password });
      await _handleAuth(r);
    } catch (e) {
      setError((e as Error).message);
      throw e;
    }
  }, [_handleAuth]);

  const register = useCallback(async (email: string, password: string, name: string) => {
    setError(null);
    try {
      const r = await post<{ token: string; user: AuthUser }>("/api/auth/register", { email, password, name });
      await _handleAuth(r);
    } catch (e) {
      setError((e as Error).message);
      throw e;
    }
  }, [_handleAuth]);

  const loginAsGuest = useCallback(async () => {
    setError(null);
    try {
      const r = await post<{ token: string; user: AuthUser }>("/api/auth/guest");
      await _handleAuth(r);
    } catch (e) {
      setError((e as Error).message);
      throw e;
    }
  }, [_handleAuth]);

  const logout = useCallback(() => {
    setToken(null);
    setUser(null);
  }, []);

  const clearError = useCallback(() => setError(null), []);

  return (
    <Ctx.Provider value={{ user, loading, error, login, register, loginAsGuest, logout, clearError }}>
      {children}
    </Ctx.Provider>
  );
}

export function useAuth(): AuthCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}

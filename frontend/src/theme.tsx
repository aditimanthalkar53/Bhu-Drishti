import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

export type Mode = "light" | "dark";
const KEY = "bd-theme";

function stored(): Mode | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : null;
  } catch {
    return null;
  }
}
const systemMode = (): Mode => (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");

/** Apply synchronously so anything reading CSS variables during the next render sees the new palette. */
function apply(mode: Mode) {
  const root = document.documentElement;
  root.dataset.theme = mode;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", mode === "light" ? "#f5f5f7" : "#050507");
}

/** Resolved value of a CSS custom property for the active theme (for canvas/WebGL code that can't use var()). */
export function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

const Ctx = createContext<{ mode: Mode; toggle(): void }>({ mode: "dark", toggle: () => undefined });

/** Follows the OS setting until the user picks a mode; the pick is remembered per browser. */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<Mode>(() => {
    const m = stored() ?? systemMode();
    apply(m);
    return m;
  });

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const on = () => { if (!stored()) { const m = systemMode(); apply(m); setMode(m); } };
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

  const toggle = useCallback(() => {
    setMode((cur) => {
      const next: Mode = cur === "dark" ? "light" : "dark";
      apply(next);
      try { localStorage.setItem(KEY, next); } catch { /* private mode: the choice just isn't remembered */ }
      return next;
    });
  }, []);

  return <Ctx.Provider value={{ mode, toggle }}>{children}</Ctx.Provider>;
}

export const useTheme = () => useContext(Ctx);

export function ThemeToggle({ className = "" }: { className?: string }) {
  const { mode, toggle } = useTheme();
  const next = mode === "dark" ? "light" : "dark";
  return (
    <button type="button" className={`btn btn-quiet theme-toggle ${className}`} onClick={toggle}
      aria-label={`Switch to ${next} mode`} title={`Switch to ${next} mode`}>
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {mode === "dark" ? (
          <path d="M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10Zm0-15v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
        ) : (
          <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
        )}
      </svg>
    </button>
  );
}

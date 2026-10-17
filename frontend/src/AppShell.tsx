import { useEffect, useRef, useState, type ReactElement } from "react";
import { NavLink, Route, Routes, useNavigate } from "react-router-dom";
import { api, post } from "./api";
import { useAuth } from "./auth";
import { AuthModal } from "./components/AuthModal";
import { ago } from "./format";
import { AlertsPage } from "./pages/AlertsPage";
import { AreasPage } from "./pages/AreasPage";
import { AuditPage } from "./pages/AuditPage";
import { DashboardPage } from "./pages/DashboardPage";
import { DataCatalogPage } from "./pages/DataCatalogPage";
import { HistoryPage } from "./pages/HistoryPage";
import { LandingPage } from "./pages/LandingPage";
import { MonitorsPage } from "./pages/MonitorsPage";
import { RecipientsPage } from "./pages/RecipientsPage";
import { ReportDetailPage, ReportsPage } from "./pages/ReportsPage";
import { SettingsPage } from "./pages/SettingsPage";
import { UsagePage } from "./pages/UsagePage";
import type { Notification } from "./types";
import App from "./App";

const NAV = [
  { to: "/app/dashboard", label: "Dashboard" },
  { to: "/app", label: "Explore", end: true },
  { to: "/app/areas", label: "Areas" },
  { to: "/app/monitors", label: "Monitors" },
  { to: "/app/alerts", label: "Alerts" },
  { to: "/app/reports", label: "Reports" },
  { to: "/app/recipients", label: "Recipients" },
  { to: "/app/history", label: "History" },
  { to: "/app/data", label: "Data" },
];

export function AppShell() {
  const { user, loading, logout, loginAsGuest } = useAuth();
  const navigate = useNavigate();
  const [showAuth, setShowAuth] = useState(false);

  // every app page needs a session; fall back to a guest one
  useEffect(() => {
    if (!loading && !user && window.location.pathname.startsWith("/app")) void loginAsGuest().catch(() => undefined);
  }, [loading, user, loginAsGuest]);

  const shell = (page: ReactElement, full = false) => (
    <div className="shell">
      <AppHeader user={user} loading={loading} onSignIn={() => setShowAuth(true)} onLogout={() => { logout(); navigate("/"); }} />
      <div className={full ? "shell-body shell-full" : "shell-body"}>{user ? page : <p className="muted page">Starting a session…</p>}</div>
    </div>
  );

  return (
    <>
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/app" element={shell(<App />, true)} />
        <Route path="/app/dashboard" element={shell(<DashboardPage />)} />
        <Route path="/app/areas" element={shell(<AreasPage />)} />
        <Route path="/app/monitors" element={shell(<MonitorsPage />)} />
        <Route path="/app/alerts" element={shell(<AlertsPage />)} />
        <Route path="/app/reports" element={shell(<ReportsPage />)} />
        <Route path="/app/reports/:id" element={shell(<ReportDetailPage />)} />
        <Route path="/app/recipients" element={shell(<RecipientsPage />)} />
        <Route path="/app/history" element={shell(<HistoryPage />)} />
        <Route path="/app/data" element={shell(<DataCatalogPage />)} />
        <Route path="/app/settings" element={shell(<SettingsPage />)} />
        <Route path="/app/usage" element={shell(<UsagePage />)} />
        <Route path="/app/audit" element={shell(<AuditPage />)} />
        <Route path="*" element={<main className="boot-error"><h1>Page not found</h1><a className="btn" href="/app/dashboard">Go to the dashboard</a></main>} />
      </Routes>
      {showAuth && <AuthModal onClose={() => setShowAuth(false)} />}
    </>
  );
}

interface HeaderProps {
  user: { name: string; email: string; guest: boolean } | null;
  loading: boolean;
  onSignIn(): void;
  onLogout(): void;
}

function AppHeader({ user, loading, onSignIn, onLogout }: HeaderProps) {
  return (
    <header className="app-header">
      <a className="app-header-brand" href="/">
        <Logo />
        <span>Bhu-Drishti</span>
      </a>
      <nav className="app-nav" aria-label="Main">
        {NAV.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => `app-nav-link ${isActive ? "active" : ""}`}>{n.label}</NavLink>
        ))}
      </nav>
      <div className="app-header-right">
        {user && <Bell />}
        {!loading && (
          user ? (
            <UserMenu user={user} onSignIn={onSignIn} onLogout={onLogout} />
          ) : (
            <button className="btn btn-primary" onClick={onSignIn}>Sign in</button>
          )
        )}
      </div>
    </header>
  );
}

function UserMenu({ user, onSignIn, onLogout }: { user: NonNullable<HeaderProps["user"]>; onSignIn(): void; onLogout(): void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);
  return (
    <div className="menu" ref={ref}>
      <button className="btn btn-quiet" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {user.guest ? "Guest" : user.name}{user.guest && <span className="guest-badge">guest</span>} ▾
      </button>
      {open && (
        <div className="menu-pop" role="menu">
          {user.guest && <button role="menuitem" className="menu-item" onClick={() => { setOpen(false); onSignIn(); }}>Sign in / create account</button>}
          <NavLink role="menuitem" className="menu-item" to="/app/settings" onClick={() => setOpen(false)}>Settings & API keys</NavLink>
          <NavLink role="menuitem" className="menu-item" to="/app/usage" onClick={() => setOpen(false)}>Usage</NavLink>
          <NavLink role="menuitem" className="menu-item" to="/app/audit" onClick={() => setOpen(false)}>Audit log</NavLink>
          <button role="menuitem" className="menu-item" onClick={onLogout}>Sign out</button>
        </div>
      )}
    </div>
  );
}

function Bell() {
  const [items, setItems] = useState<Notification[]>([]);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const load = () => api<Notification[]>("/api/notifications").then(setItems).catch(() => undefined);
  useEffect(() => {
    void load();
    const t = setInterval(load, 30_000);
    const h = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => { clearInterval(t); document.removeEventListener("mousedown", h); };
  }, []);
  const unread = items.filter((n) => !n.read).length;
  return (
    <div className="menu" ref={ref}>
      <button className="btn btn-quiet bell" aria-label={`Notifications${unread ? `, ${unread} unread` : ""}`} aria-expanded={open}
        onClick={() => setOpen((v) => !v)}>
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M12 22a2.5 2.5 0 0 0 2.45-2h-4.9A2.5 2.5 0 0 0 12 22Zm7-6V11a7 7 0 0 0-5.5-6.84V3a1.5 1.5 0 0 0-3 0v1.16A7 7 0 0 0 5 11v5l-2 2v1h18v-1l-2-2Z" /></svg>
        {unread > 0 && <span className="bell-count">{unread > 9 ? "9+" : unread}</span>}
      </button>
      {open && (
        <div className="menu-pop notif-pop" role="dialog" aria-label="Notifications">
          <div className="ev-head">
            <strong>Notifications</strong>
            {unread > 0 && <button className="link-btn" onClick={() => post("/api/notifications/read-all").then(load)}>Mark all read</button>}
          </div>
          {items.length === 0 && <p className="muted small">Monitor runs, alerts and report deliveries show up here.</p>}
          <ul className="notif-list">
            {items.slice(0, 20).map((n) => (
              <li key={n.id} className={n.read ? "" : "unread"}>
                <button className="menu-item" onClick={() => {
                  setOpen(false);
                  void post(`/api/notifications/${n.id}/read`).then(load);
                  if (n.link) navigate(n.link);
                }}>
                  <span className={`dot dot-${n.level}`} aria-hidden="true" />
                  <span><strong>{n.title}</strong><br /><span className="small">{n.body}</span><br /><span className="muted small">{ago(n.createdAt)}</span></span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function Logo({ size = 22 }: { size?: number }) {
  // an eye over a field grid: "Bhu-Drishti" = sight over the land
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} aria-hidden="true">
      <rect width="32" height="32" rx="7" fill="var(--ink)" />
      <g stroke="var(--paper)" strokeWidth="1" opacity="0.5">
        <path d="M4 22h24M4 26h24M10 18v10M16 18v10M22 18v10" />
      </g>
      <path d="M5 13c3-5 7-7 11-7s8 2 11 7c-3 5-7 7-11 7s-8-2-11-7Z" fill="none" stroke="var(--paper)" strokeWidth="1.6" />
      <circle cx="16" cy="13" r="3.6" fill="var(--water)" />
    </svg>
  );
}

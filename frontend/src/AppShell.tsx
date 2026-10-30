import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import { NavLink, Outlet, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { api, post } from "./api";
import { useAuth } from "./auth";
import { AuthModal } from "./components/AuthModal";
import { ago } from "./format";
import type { Notification, Region } from "./types";
import { gsap, pageEnter, useGsap } from "./motion";
import { ThemeToggle } from "./theme";

const AmbientField = lazy(() => import("./components/three/AmbientField"));

// Every page is its own script, fetched when first opened: the landing page doesn't download the
// map app (Leaflet) and the app doesn't download the landing page's animations.
const LandingPage = lazy(() => import("./pages/LandingPage").then((m) => ({ default: m.LandingPage })));
const ResetPasswordPage = lazy(() => import("./pages/ResetPasswordPage").then((m) => ({ default: m.ResetPasswordPage })));
const App = lazy(() => import("./App"));
const DashboardPage = lazy(() => import("./pages/DashboardPage").then((m) => ({ default: m.DashboardPage })));
const AreasPage = lazy(() => import("./pages/AreasPage").then((m) => ({ default: m.AreasPage })));
const MonitorsPage = lazy(() => import("./pages/MonitorsPage").then((m) => ({ default: m.MonitorsPage })));
const AlertsPage = lazy(() => import("./pages/AlertsPage").then((m) => ({ default: m.AlertsPage })));
const SachetPage = lazy(() => import("./pages/SachetPage").then((m) => ({ default: m.SachetPage })));
const ReportsPage = lazy(() => import("./pages/ReportsPage").then((m) => ({ default: m.ReportsPage })));
const ReportDetailPage = lazy(() => import("./pages/ReportsPage").then((m) => ({ default: m.ReportDetailPage })));
const RecipientsPage = lazy(() => import("./pages/RecipientsPage").then((m) => ({ default: m.RecipientsPage })));
const HistoryPage = lazy(() => import("./pages/HistoryPage").then((m) => ({ default: m.HistoryPage })));
const DataCatalogPage = lazy(() => import("./pages/DataCatalogPage").then((m) => ({ default: m.DataCatalogPage })));
const SettingsPage = lazy(() => import("./pages/SettingsPage").then((m) => ({ default: m.SettingsPage })));
const UsagePage = lazy(() => import("./pages/UsagePage").then((m) => ({ default: m.UsagePage })));
const AuditPage = lazy(() => import("./pages/AuditPage").then((m) => ({ default: m.AuditPage })));
const DetectionsPage = lazy(() => import("./pages/DetectionsPage").then((m) => ({ default: m.DetectionsPage })));
const TwinsPage = lazy(() => import("./pages/TwinsPage").then((m) => ({ default: m.TwinsPage })));
const pageLoading = <p className="muted page">Loading…</p>;

const ico = (d: string): ReactNode => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);
const NAV: { to: string; label: string; end?: boolean; icon: ReactNode; group: string; hideInSidebar?: boolean }[] = [
  { to: "/app/dashboard", label: "Dashboard", icon: ico("M3 13h8V3H3v10Zm0 8h8v-6H3v6Zm10 0h8V11h-8v10Zm0-18v6h8V3h-8Z"), group: "Overview" },
  { to: "/app", label: "Explore", end: true, icon: ico("M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm3.5-12.5-2 5-5 2 2-5 5-2Z"), group: "Overview" },
  { to: "/app/twins", label: "Digital twins", icon: ico("M12 3 3 8l9 5 9-5-9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5"), group: "Overview" },
  { to: "/app/areas", label: "Areas", icon: ico("M12 21s7-6.2 7-11.5A7 7 0 0 0 5 9.5C5 14.8 12 21 12 21Zm0-8.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z"), group: "Monitoring" },
  { to: "/app/monitors", label: "Monitors", icon: ico("M3 12h4l3-8 4 16 3-8h4"), group: "Monitoring" },
  { to: "/app/alerts", label: "Alerts", icon: ico("M12 3 2 20h20L12 3Zm0 6v5m0 3v.5"), group: "Monitoring", hideInSidebar: true },
  { to: "/app/sachet", label: "SACHET alerts", icon: ico("M12 3 4 6v6c0 4.5 3.4 8 8 9 4.6-1 8-4.5 8-9V6l-8-3Zm0 5v5m0 3v.5"), group: "Monitoring" },
  { to: "/app/reports", label: "Reports", icon: ico("M6 3h9l4 4v14H6V3Zm8 0v5h5M9 13h6M9 17h6"), group: "Delivery" },
  { to: "/app/recipients", label: "Recipients", icon: ico("M16 19v-1a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v1m13-9a3 3 0 1 0 0-6M21 19v-1a4 4 0 0 0-3-3.9M9.5 10a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z"), group: "Delivery" },
  { to: "/app/history", label: "History", icon: ico("M3 12a9 9 0 1 0 3-6.7L3 8m0-5v5h5m4-1v5l3 2"), group: "Data" },
  { to: "/app/data", label: "Data sources", icon: ico("M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3Zm0 0v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"), group: "Data" },
];
const TITLES: Record<string, string> = {
  "/app/settings": "Settings & API keys", "/app/usage": "Usage", "/app/audit": "Audit log",
};
function titleFor(path: string): string {
  const exact = NAV.find((n) => n.to === path);
  if (exact) return exact.label;
  if (TITLES[path]) return TITLES[path];
  const prefix = NAV.filter((n) => !n.end && path.startsWith(n.to + "/")).sort((x, y) => y.to.length - x.to.length)[0];
  return prefix?.label ?? "Bhu-Drishti";
}

export function AppShell() {
  const { user, loading, logout } = useAuth();
  const navigate = useNavigate();
  const [showAuth, setShowAuth] = useState(false);

  // one persistent layout for every /app page, so the sidebar and background scene survive navigation
  const layout = <Shell user={user} loading={loading} onSignIn={() => setShowAuth(true)} onLogout={() => { logout(); navigate("/"); }} />;

  return (
    <>
      <Suspense fallback={pageLoading}>
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/reset-password" element={<ResetPasswordPage />} />
        <Route path="/app" element={layout}>
          <Route index element={<App />} />
          <Route path="dashboard" element={<DashboardPage />} />
          <Route path="detect" element={<DetectionsPage />} />
          <Route path="twins" element={<TwinsPage />} />
          <Route path="areas" element={<AreasPage />} />
          <Route path="monitors" element={<MonitorsPage />} />
          <Route path="alerts" element={<AlertsPage />} />
          <Route path="sachet" element={<SachetPage />} />
          <Route path="reports" element={<ReportsPage />} />
          <Route path="reports/:id" element={<ReportDetailPage />} />
          <Route path="recipients" element={<RecipientsPage />} />
          <Route path="history" element={<HistoryPage />} />
          <Route path="data" element={<DataCatalogPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="usage" element={<UsagePage />} />
          <Route path="audit" element={<AuditPage />} />
        </Route>
        <Route path="*" element={<main className="boot-error"><h1>Page not found</h1><a className="btn" href="/app/dashboard">Go to the dashboard</a></main>} />
      </Routes>
      </Suspense>
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

function Shell({ user, loading, onSignIn, onLogout }: HeaderProps) {
  const { pathname } = useLocation();
  const full = pathname === "/app" || pathname === "/app/";
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, [open]);
  const groups = [...new Set(NAV.map((n) => n.group))];
  const body = useRef<HTMLDivElement>(null);
  const side = useRef<HTMLElement>(null);
  useGsap(body, pageEnter, [pathname]);
  useGsap(side, (el) => {
    gsap.from(el.querySelectorAll(".brand-link, .side-label, .side-link"), { x: -16, autoAlpha: 0, duration: 0.6, stagger: 0.03, clearProps: "all" });
  });
  return (
    <div className="shell">
      <Suspense fallback={null}><AmbientField /></Suspense>
      <aside ref={side} className={`sidebar ${open ? "open" : ""}`} aria-label="Primary">
        <a className="brand-link" href="/">
          <Logo size={30} />
          <span>Bhu-Drishti<small>Satellite flood intelligence</small></span>
        </a>
        <nav className="side-nav" aria-label="Main">
          {groups.map((g) => (
            <div key={g} className="side-nav">
              <span className="side-label">{g}</span>
              {NAV.filter((n) => n.group === g && !n.hideInSidebar).map((n) => (
                <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => `side-link ${isActive ? "active" : ""}`}>{n.icon}{n.label}</NavLink>
              ))}
            </div>
          ))}
        </nav>
        <div className="side-foot">
          <NavLink to="/app/settings" className={({ isActive }) => `side-link ${isActive ? "active" : ""}`}>
            {ico("M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm0-12v3m0 12v3M3 12h3m12 0h3M5.6 5.6l2.1 2.1m8.6 8.6 2.1 2.1m0-12.8-2.1 2.1M7.7 16.3l-2.1 2.1")}Settings
          </NavLink>
        </div>
      </aside>
      {open && <div className="side-scrim" onClick={() => setOpen(false)} aria-hidden="true" />}
      <header className="topbar">
        <button className="btn btn-quiet menu-toggle" aria-label="Open navigation" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {ico("M4 6h16M4 12h16M4 18h16")}
        </button>
        <h1>{titleFor(pathname)}</h1>
        {user && <GlobalSearch />}
        <div className="topbar-right">
          <ThemeToggle />
          {user && <Bell />}
          {!loading && (
            user ? <UserMenu user={user} onSignIn={onSignIn} onLogout={onLogout} />
              : <button className="btn btn-primary" onClick={onSignIn}>Sign in</button>
          )}
        </div>
      </header>
      <div ref={body} className={full ? "shell-body shell-full" : "shell-body"} key={pathname}>
        {user ? <Suspense fallback={pageLoading}><Outlet /></Suspense> : loading ? <p className="muted page">Loading…</p> : <SignInGate />}
      </div>
    </div>
  );
}

/** Every /app page needs an account: the website is public, the application is not. */
function SignInGate() {
  return (
    <main className="page signin-gate">
      <div className="card">
        <h2>Sign in to use Bhu-Drishti</h2>
        <p className="muted">The website is open to everyone. Asking questions, monitoring areas and sending reports need an account,
          so your work is saved and every report can be traced to a person.</p>
      </div>
      <AuthModal onClose={() => undefined} dismissible={false} />
    </main>
  );
}

/** Search districts (from /api/regions) and pages; choosing a district opens it in Explore. */
function GlobalSearch() {
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [regions, setRegions] = useState<Region[] | null>(null);
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);
  const load = () => { if (!regions) api<Region[]>("/api/regions").then(setRegions).catch(() => setRegions([])); };
  const term = q.trim().toLowerCase();
  const pages = term ? NAV.filter((n) => n.label.toLowerCase().includes(term)).slice(0, 4) : [];
  const places = term && regions
    ? regions.filter((r) => `${r.name} ${r.state ?? ""}`.toLowerCase().includes(term)).slice(0, 8) : [];
  const items = [
    ...pages.map((p) => ({ key: p.to, label: p.label, hint: "Page", go: () => navigate(p.to) })),
    ...places.map((r) => ({ key: r.id, label: r.name, hint: r.state ?? (r.simulated ? "Demo" : ""), go: () => navigate(`/app?region=${encodeURIComponent(r.id)}`) })),
  ];
  const choose = (i: number) => { items[i]?.go(); setOpen(false); setQ(""); };
  return (
    <div className="gsearch" ref={ref} role="search">
      {ico("m21 21-4.3-4.3M10.5 18a7.5 7.5 0 1 1 0-15 7.5 7.5 0 0 1 0 15Z")}
      <input type="search" placeholder="Search districts or pages…" aria-label="Search districts or pages" aria-expanded={open}
        value={q} onFocus={() => { load(); setOpen(true); }}
        onChange={(e) => { setQ(e.target.value); setSel(0); setOpen(true); }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); setSel((i) => Math.min(i + 1, items.length - 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setSel((i) => Math.max(i - 1, 0)); }
          else if (e.key === "Enter") { e.preventDefault(); choose(sel); }
          else if (e.key === "Escape") setOpen(false);
        }} />
      {open && term && (
        <ul className="gsearch-list" role="listbox">
          {items.length === 0 && <li className="gsearch-group">{regions ? "No matches" : "Loading…"}</li>}
          {items.map((it, i) => (
            <li key={it.key} role="option" aria-selected={i === sel} onMouseEnter={() => setSel(i)} onMouseDown={(e) => { e.preventDefault(); choose(i); }}>
              <span>{it.label}</span><span className="muted small">{it.hint}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function UserMenu({ user, onLogout }: { user: NonNullable<HeaderProps["user"]>; onSignIn(): void; onLogout(): void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);
  return (
    <div className="menu" ref={ref}>
      <button className="btn btn-quiet user-btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="avatar" aria-hidden="true">{user.name.slice(0, 1).toUpperCase()}</span>
        <span className="user-name">{user.name}</span>
      </button>
      {open && (
        <div className="menu-pop" role="menu">
          <div className="menu-head"><strong>{user.name}</strong><span className="muted small">{user.email}</span></div>
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
      <defs><linearGradient id="bd-g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" style={{ stopColor: "var(--water)" }} /><stop offset="1" style={{ stopColor: "var(--violet)" }} /></linearGradient></defs>
      <rect width="32" height="32" rx="8" fill="url(#bd-g)" />
      <g stroke="#fff" strokeWidth="1" opacity="0.45">
        <path d="M4 22h24M4 26h24M10 18v10M16 18v10M22 18v10" />
      </g>
      <path d="M5 13c3-5 7-7 11-7s8 2 11 7c-3 5-7 7-11 7s-8-2-11-7Z" fill="none" stroke="#fff" strokeWidth="1.6" />
      <circle cx="16" cy="13" r="3.6" fill="#fff" />
    </svg>
  );
}

import { useEffect, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth, type Role } from "../auth";
import { Logo } from "../AppShell";
import { ThemeToggle } from "../theme";

/**
 * Each role has its own sign-in page, with only the fields that role needs. An account can only sign in on the page
 * of its own role (the server checks it too). Authority accounts are never created here: an administrator lists them
 * in AUTHORITY_EMAILS or grants the role.
 */
export const ROLE_INFO: Record<Role, { title: string; path: string; tagline: string; can: string[]; icon: ReactNode }> = {
  citizen: {
    title: "Citizen", path: "/citizen", tagline: "Ask for help, report a problem, follow official updates.",
    can: ["SOS with your location", "Describe the situation in your own language", "Drain Watch photo reports", "Offer help", "Updates and alerts"],
    icon: <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 9a7 7 0 0 1 14 0" /></svg>,
  },
  volunteer: {
    title: "Volunteer", path: "/volunteer", tagline: "Take on tasks: rescues, deliveries and field checks.",
    can: ["Task board: claim and complete tasks", "Field checks for unreported need", "Offer resources", "Updates and alerts"],
    icon: <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M12 21s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 11c0 5.6-7 10-7 10Z" /></svg>,
  },
  authority: {
    title: "Authority", path: "/authority", tagline: "Coordinate the response and use the satellite tools.",
    can: ["Command view, requests and volunteers", "Official bulletins with two-person approval", "Estimates of unreported need", "Satellite analysis (AEQE), change detection, digital twins, monitors and reports"],
    icon: <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M12 3 4 6v6c0 4.5 3.4 8 8 9 4.6-1 8-4.5 8-9V6l-8-3Z" /></svg>,
  },
};

/** "Who are you?": three doors, one per role. */
export function RoleChooser({ onPick }: { onPick?(): void }) {
  return (
    <div className="role-cards">
      {(Object.keys(ROLE_INFO) as Role[]).map((r) => (
        <Link key={r} to={ROLE_INFO[r].path} className="role-card" onClick={onPick}>
          <span className="role-icon">{ROLE_INFO[r].icon}</span>
          <strong>{ROLE_INFO[r].title}</strong>
          <span className="muted small">{ROLE_INFO[r].tagline}</span>
        </Link>
      ))}
    </div>
  );
}

export function RoleChooserModal({ onClose }: { onClose(): void }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Choose how to sign in" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal modal-wide">
        <button className="modal-close" onClick={onClose} aria-label="Close">&times;</button>
        <h2 className="modal-title">Who are you?</h2>
        <p className="muted small">Each role has its own sign-in and sees only what it needs. In immediate danger, call 112.</p>
        <RoleChooser onPick={onClose} />
      </div>
    </div>
  );
}

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const list = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);

export function RoleAuthPage({ role }: { role: Role }) {
  const info = ROLE_INFO[role];
  const { user, loading, login, register, logout, error, clearError } = useAuth();
  const navigate = useNavigate();
  const canRegister = role !== "authority";
  const [tab, setTab] = useState<"login" | "register">("login");
  const [f, setF] = useState({ name: "", email: "", password: "", confirm: "", ward: "", phone: "", language: "en", skills: "", resources: "" });
  const [local, setLocal] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });

  useEffect(() => () => clearError(), [clearError]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLocal(null);
    if (!EMAIL.test(f.email.trim())) return setLocal("Enter a valid email address.");
    if (tab === "register") {
      if (!f.name.trim()) return setLocal("Enter your name.");
      if (f.password.length < 8) return setLocal("Use a password of at least 8 characters.");
      if (f.password !== f.confirm) return setLocal("The two passwords do not match.");
    }
    setBusy(true);
    try {
      if (tab === "login") await login(f.email, f.password, role);
      else await register(f.email, f.password, f.name, { role: role as "citizen" | "volunteer", ward: f.ward.trim(), phone: f.phone.trim(), language: f.language,
        ...(role === "volunteer" ? { skills: list(f.skills), resources: list(f.resources) } : {}) });
      navigate("/app/dashboard");
    } catch {
      // the message is shown from the auth context
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="role-page">
      <header className="role-top">
        <Link className="lx-brand" to="/"><Logo size={26} /><span>Bhu-Drishti · Maun</span></Link>
        <ThemeToggle />
      </header>
      <main className="role-main">
        <section className="card role-panel">
          <div className="role-head">
            <span className="role-icon">{info.icon}</span>
            <div><p className="eyebrow">{info.title}</p><h1>{tab === "login" ? `${info.title} sign-in` : `Join as a ${info.title.toLowerCase()}`}</h1></div>
          </div>
          <p className="muted">{info.tagline}</p>

          {!loading && user ? (
            <div className="stack">
              <p className="notice notice-ok">You are signed in as {user.name} ({user.role ?? "citizen"}).</p>
              <div className="row-actions">
                <button className="btn btn-primary" onClick={() => navigate("/app/dashboard")}>Continue</button>
                <button className="btn" onClick={logout}>Sign out</button>
              </div>
            </div>
          ) : (
            <>
              {canRegister && (
                <div className="modal-tabs" role="tablist">
                  <button role="tab" aria-selected={tab === "login"} className={tab === "login" ? "active" : ""} onClick={() => { setTab("login"); setLocal(null); clearError(); }}>Sign in</button>
                  <button role="tab" aria-selected={tab === "register"} className={tab === "register" ? "active" : ""} onClick={() => { setTab("register"); setLocal(null); clearError(); }}>Create account</button>
                </div>
              )}
              <form className="modal-form" onSubmit={submit} noValidate>
                {tab === "register" && <label className="field"><span>Name</span><input value={f.name} onChange={set("name")} autoComplete="name" maxLength={100} /></label>}
                <label className="field"><span>Email</span><input type="email" value={f.email} onChange={set("email")} autoComplete="email" maxLength={200} autoFocus /></label>
                <label className="field"><span>Password</span><input type="password" value={f.password} onChange={set("password")} autoComplete={tab === "login" ? "current-password" : "new-password"} maxLength={200}
                  placeholder={tab === "register" ? "At least 8 characters" : ""} /></label>
                {tab === "register" && (
                  <>
                    <label className="field"><span>Confirm password</span><input type="password" value={f.confirm} onChange={set("confirm")} autoComplete="new-password" maxLength={200} /></label>
                    <div className="field-row">
                      <label className="field"><span>Ward / area <span className="muted">(optional)</span></span><input value={f.ward} onChange={set("ward")} maxLength={80} placeholder="e.g. Ward 4, Barpeta" /></label>
                      <label className="field"><span>Language</span>
                        <select value={f.language} onChange={set("language")}>
                          <option value="en">English</option><option value="hi">हिन्दी (Hindi)</option><option value="kn">ಕನ್ನಡ (Kannada)</option><option value="as">অসমীয়া (Assamese)</option>
                        </select></label>
                    </div>
                    <label className="field"><span>Phone <span className="muted">(optional, shared with responders only)</span></span><input type="tel" value={f.phone} onChange={set("phone")} maxLength={30} autoComplete="tel" /></label>
                    {role === "volunteer" && (
                      <>
                        <label className="field"><span>Skills <span className="muted">(comma separated)</span></span><input value={f.skills} onChange={set("skills")} placeholder="first aid, swimming, driving" /></label>
                        <label className="field"><span>Resources you can bring <span className="muted">(comma separated)</span></span><input value={f.resources} onChange={set("resources")} placeholder="boat, tractor, generator" /></label>
                      </>
                    )}
                  </>
                )}
                {(local || error) && <p className="notice notice-error" role="alert">{local ?? error}</p>}
                <button className="btn btn-primary" type="submit" disabled={busy || !f.email || !f.password}>
                  {busy ? "Please wait…" : tab === "login" ? `Sign in as ${info.title.toLowerCase()}` : "Create account"}
                </button>
              </form>
              {role === "authority" && <p className="muted small">Authority accounts are set up by the administrator (AUTHORITY_EMAILS). There is no self sign-up.</p>}
            </>
          )}
        </section>
        <aside className="card role-side">
          <h2>As a {info.title.toLowerCase()} you can</h2>
          <ul className="small">{info.can.map((c) => <li key={c}>{c}</li>)}</ul>
          <p className="muted small">Not a {info.title.toLowerCase()}?{" "}
            {(Object.keys(ROLE_INFO) as Role[]).filter((r) => r !== role).map((r, i) => (
              <span key={r}>{i > 0 && " · "}<Link to={ROLE_INFO[r].path}>{ROLE_INFO[r].title} sign-in</Link></span>
            ))}
          </p>
          {role === "citizen" && <p className="notice notice-warn">In immediate danger, call <a href="tel:112">112</a>.</p>}
        </aside>
      </main>
    </div>
  );
}

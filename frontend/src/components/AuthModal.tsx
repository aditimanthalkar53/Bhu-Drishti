import { useEffect, useRef, useState } from "react";
import { post } from "../api";
import { useAuth } from "../auth";
import { DISASTER, PRODUCT } from "../featureFlags";

interface Props {
  onClose(): void;
  /** false on the app's sign-in gate: the dialog cannot be dismissed, only left via "Back to the website". */
  dismissible?: boolean;
  initialTab?: "login" | "register";
}

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function AuthModal({ onClose, dismissible = true, initialTab = "login" }: Props) {
  const { login, register, error, clearError } = useAuth();
  const [tab, setTab] = useState<"login" | "register">(initialTab);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<"citizen" | "volunteer">("citizen");
  const [ward, setWard] = useState("");
  const [phone, setPhone] = useState("");
  const [language, setLanguage] = useState("en");
  const [busy, setBusy] = useState(false);
  const [local, setLocal] = useState<string | null>(null);
  const emailRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    emailRef.current?.focus();
    return () => clearError();
  }, [clearError]);

  useEffect(() => {
    if (!dismissible) return;
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose, dismissible]);

  const switchTab = (t: "login" | "register") => { setTab(t); setLocal(null); clearError(); };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLocal(null);
    if (!EMAIL.test(email.trim())) return setLocal("Enter a valid email address.");
    if (tab === "register") {
      if (!name.trim()) return setLocal("Enter your name.");
      if (password.length < 8) return setLocal("Use a password of at least 8 characters.");
      if (password !== confirm) return setLocal("The two passwords do not match.");
    }
    setBusy(true);
    try {
      if (tab === "login") await login(email, password);
      else await register(email, password, name, { role, ward: ward.trim(), phone: phone.trim(), language });
      onClose();
    } catch {
      // error is set in the auth context
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={(e) => { if (dismissible && e.target === e.currentTarget) onClose(); }}
      role="dialog" aria-modal="true" aria-label={tab === "login" ? "Sign in" : "Create account"}>
      <div className="modal">
        {dismissible && <button className="modal-close" onClick={onClose} aria-label="Close">&times;</button>}
        <div>
          <h2 className="modal-title">{tab === "login" ? `Sign in to ${PRODUCT}` : "Create your account"}</h2>
          <p className="muted small">{DISASTER
            ? (tab === "login" ? "Use the email and password you signed up with." : "Ask for help, offer help and get official updates. Authority accounts are set up by the administrator.")
            : (tab === "login" ? "Use your work email and password." : "Your areas, monitors, reports and requests are saved to your account. Authority access is set up by the administrator.")}</p>
        </div>

        <div className="modal-tabs" role="tablist">
          <button role="tab" aria-selected={tab === "login"} className={tab === "login" ? "active" : ""} onClick={() => switchTab("login")}>Sign in</button>
          <button role="tab" aria-selected={tab === "register"} className={tab === "register" ? "active" : ""} onClick={() => switchTab("register")}>Create account</button>
        </div>

        <form className="modal-form" onSubmit={submit} noValidate>
          {tab === "register" && (
            <label className="field">
              <span>Name</span>
              <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" autoComplete="name" maxLength={100} />
            </label>
          )}
          <label className="field">
            <span>Email</span>
            <input ref={emailRef} type="email" value={email} onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com" autoComplete="email" required maxLength={200} />
          </label>
          <label className="field">
            <span>Password</span>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
              placeholder={tab === "register" ? "At least 8 characters" : ""}
              autoComplete={tab === "login" ? "current-password" : "new-password"} required minLength={8} maxLength={200} />
          </label>
          {tab === "register" && (
            <label className="field">
              <span>Confirm password</span>
              <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required maxLength={200} />
            </label>
          )}
          {tab === "register" && (
            <>
              <fieldset className="field fieldset">
                <span>I am joining as</span>
                <div className="seg" role="radiogroup" aria-label="Role">
                  <button type="button" role="radio" aria-checked={role === "citizen"} className={role === "citizen" ? "active" : ""} onClick={() => setRole("citizen")}>Citizen</button>
                  <button type="button" role="radio" aria-checked={role === "volunteer"} className={role === "volunteer" ? "active" : ""} onClick={() => setRole("volunteer")}>Volunteer</button>
                </div>
              </fieldset>
              <div className="field-row">
                <label className="field"><span>Ward / area <span className="muted">(optional)</span></span>
                  <input value={ward} onChange={(e) => setWard(e.target.value)} maxLength={80} placeholder="e.g. Ward 4, Barpeta" /></label>
                <label className="field"><span>Language</span>
                  <select value={language} onChange={(e) => setLanguage(e.target.value)}>
                    <option value="en">English</option><option value="hi">हिन्दी (Hindi)</option><option value="kn">ಕನ್ನಡ (Kannada)</option><option value="as">অসমীয়া (Assamese)</option>
                  </select></label>
              </div>
              <label className="field"><span>Phone <span className="muted">(optional, shared with responders only)</span></span>
                <input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={30} autoComplete="tel" /></label>
            </>
          )}

          {(local || error) && <p className="notice notice-error" role="alert">{local ?? error}</p>}

          <button className="btn btn-primary" type="submit" disabled={busy || !email || !password}>
            {busy ? "Please wait…" : tab === "login" ? "Sign in" : "Create account"}
          </button>
        </form>
        {tab === "login" && <ForgotPassword initialEmail={email} />}
        {!dismissible && <a className="link-btn modal-note" href="/">← Back to the website</a>}
      </div>
    </div>
  );
}


function ForgotPassword({ initialEmail }: { initialEmail: string }) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState(initialEmail);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  if (!open) return <button type="button" className="link-btn modal-note" onClick={() => { setOpen(true); setEmail(initialEmail); }}>Forgot password?</button>;
  return (
    <form className="modal-form forgot" onSubmit={async (e) => {
      e.preventDefault();
      if (!EMAIL.test(email.trim())) return setMsg({ ok: false, text: "Enter the email you signed up with." });
      setBusy(true);
      try {
        const r = await post<{ message: string }>("/api/auth/forgot", { email: email.trim() });
        setMsg({ ok: true, text: r.message });
      } catch (err) {
        setMsg({ ok: false, text: (err as Error).message });
      } finally {
        setBusy(false);
      }
    }}>
      <label className="field"><span>Email for the reset link</span>
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" /></label>
      {msg && <p className={`notice ${msg.ok ? "notice-ok" : "notice-error"}`} role="status">{msg.text}</p>}
      <button className="btn" type="submit" disabled={busy}>{busy ? "Sending…" : "Email me a reset link"}</button>
    </form>
  );
}
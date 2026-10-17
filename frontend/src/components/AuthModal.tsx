import { useEffect, useRef, useState } from "react";
import { useAuth } from "../auth";

interface Props {
  onClose(): void;
}

export function AuthModal({ onClose }: Props) {
  const { login, register, loginAsGuest, error, clearError } = useAuth();
  const [tab, setTab] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    emailRef.current?.focus();
    return () => clearError();
  }, [clearError]);

  // Close on Escape
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      if (tab === "login") {
        await login(email, password);
      } else {
        await register(email, password, name || email.split("@")[0]);
      }
      onClose();
    } catch {
      // error is set in auth context
    } finally {
      setBusy(false);
    }
  };

  const guest = async () => {
    setBusy(true);
    try {
      await loginAsGuest();
      onClose();
    } catch {
      // error shown below
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      role="dialog" aria-modal="true" aria-label={tab === "login" ? "Sign in" : "Create account"}>
      <div className="modal">
        <button className="modal-close" onClick={onClose} aria-label="Close">&times;</button>

        <div className="modal-tabs" role="tablist">
          <button role="tab" aria-selected={tab === "login"} className={tab === "login" ? "active" : ""}
            onClick={() => { setTab("login"); clearError(); }}>Sign in</button>
          <button role="tab" aria-selected={tab === "register"} className={tab === "register" ? "active" : ""}
            onClick={() => { setTab("register"); clearError(); }}>Create account</button>
        </div>

        <form className="modal-form" onSubmit={submit} noValidate>
          {tab === "register" && (
            <label className="field">
              <span>Name</span>
              <input type="text" value={name} onChange={(e) => setName(e.target.value)}
                placeholder="Your name" autoComplete="name" maxLength={100} />
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

          {error && <p className="notice notice-error" role="alert">{error}</p>}

          <button className="btn btn-primary" type="submit" disabled={busy || !email || !password}>
            {busy ? "…" : tab === "login" ? "Sign in" : "Create account"}
          </button>
        </form>

        <div className="modal-divider"><span>or</span></div>
        <button className="btn" onClick={guest} disabled={busy}>Continue as guest</button>
        <p className="muted small modal-note">
          Guest sessions are not saved across devices. Create an account to keep your analysis history.
        </p>
      </div>
    </div>
  );
}

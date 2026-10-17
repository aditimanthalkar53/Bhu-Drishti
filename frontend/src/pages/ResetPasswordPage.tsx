import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { post, setToken } from "../api";
import { Logo } from "../AppShell";

/** Landing point of the emailed reset link: choose a new password, then go straight into the app. */
export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password.length < 8) return setError("Use at least 8 characters.");
    if (password !== confirm) return setError("The two passwords do not match.");
    setBusy(true);
    try {
      const r = await post<{ token: string }>("/api/auth/reset", { token, password });
      setToken(r.token);
      window.location.assign("/app/dashboard");   // full reload so the session is picked up everywhere
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="boot-error">
      <a className="lx-brand" href="/"><Logo size={26} /><span>Bhu-Drishti</span></a>
      <h1>Choose a new password</h1>
      {!token ? (
        <>
          <p className="notice notice-error">This link is missing its reset code. Ask for a new link from the sign-in screen.</p>
          <button className="btn" onClick={() => navigate("/app")}>Go to sign in</button>
        </>
      ) : (
        <form className="modal-form" onSubmit={submit} noValidate>
          <label className="field"><span>New password (8+ characters)</span>
            <input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
          <label className="field"><span>Confirm new password</span>
            <input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} /></label>
          {error && <p className="notice notice-error" role="alert">{error}</p>}
          <button className="btn btn-primary" type="submit" disabled={busy || !password}>{busy ? "Saving…" : "Set new password"}</button>
          <p className="muted small">Saving signs you out on every other device.</p>
        </form>
      )}
    </main>
  );
}

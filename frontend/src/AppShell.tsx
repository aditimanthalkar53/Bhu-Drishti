import { useState } from "react";
import { Route, Routes, useNavigate } from "react-router-dom";
import { useAuth } from "./auth";
import { AuthModal } from "./components/AuthModal";
import { LandingPage } from "./pages/LandingPage";
import App from "./App";

export function AppShell() {
  const { user, loading, logout } = useAuth();
  const navigate = useNavigate();
  const [showAuth, setShowAuth] = useState(false);

  return (
    <>
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route
          path="/app"
          element={
            <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
              <AppHeader
                user={user}
                loading={loading}
                onSignIn={() => setShowAuth(true)}
                onLogout={() => { logout(); navigate("/"); }}
              />
              <div style={{ flex: 1, minHeight: 0 }}>
                <App />
              </div>
            </div>
          }
        />
      </Routes>
      {showAuth && (
        <AuthModal
          onClose={() => {
            setShowAuth(false);
            if (user) navigate("/app");
          }}
        />
      )}
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
        <span className="app-header-logo" aria-hidden="true">◫</span>
        SatQuery AI
      </a>
      <div className="app-header-right">
        {!loading && (
          user ? (
            <>
              <span className="app-header-user">
                {user.guest ? "Guest" : user.name}
                {user.guest && <span className="guest-badge">guest</span>}
              </span>
              <button className="btn" onClick={onLogout}>Sign out</button>
            </>
          ) : (
            <button className="btn btn-primary" onClick={onSignIn}>Sign in</button>
          )
        )}
      </div>
    </header>
  );
}

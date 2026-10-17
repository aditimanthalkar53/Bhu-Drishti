import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../auth";
import { Logo } from "../AppShell";
import { AuthModal } from "../components/AuthModal";

const USE_CASES = [
  { icon: "🌊", title: "Flooded cropland", body: "Share and area of cropland under water in any of India's 735 districts, from Sentinel-1 radar that sees through monsoon cloud." },
  { icon: "🔥", title: "Fires and stubble burning", body: "Every NASA FIRMS detection counted per village-sized tile, and burn-scar area on cropland measured from Sentinel-2." },
  { icon: "🏗️", title: "New construction", body: "New built-up area between two years from cloud-masked Sentinel-2 dry-season composites." },
  { icon: "🌾", title: "Recovery guidance", body: "Each result comes with next steps for officials — PMFBY loss reporting, contingency crops, residue-management support." },
];

const HOW_IT_WORKS = [
  { n: "1", title: "Ask a question", body: "Pick a district (or draw your own area) and ask in plain language. The question becomes a typed, checkable plan." },
  { n: "2", title: "Cheap signals score every tile", body: "A coarse radar overview, ESA WorldCover land cover and FIRMS fire density rank all tiles before any heavy imagery is read." },
  { n: "3", title: "Full-resolution analysis on a designed sample", body: "Only a statistically chosen sample of tiles is read at 10–20 m from Planetary Computer and Copernicus." },
  { n: "4", title: "An interval that stays honest", body: "The interval narrows after every batch and stays valid however often you look. Rainfall, MODIS flood maps and forecasts are attached as context." },
];

export function LandingPage() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const [showAuth, setShowAuth] = useState(false);

  const handleCta = () => {
    if (user) {
      navigate("/app");
    } else {
      setShowAuth(true);
    }
  };

  return (
    <div className="landing">
      {/* ---------- nav ---------- */}
      <nav className="landing-nav">
        <div className="landing-nav-brand">
          <Logo size={28} />
          <span>Bhu-Drishti</span>
        </div>
        <div className="landing-nav-actions">
          {!loading && (
            user ? (
              <button className="btn btn-primary" onClick={() => navigate("/app")}>Open workspace</button>
            ) : (
              <>
                <button className="btn" onClick={() => setShowAuth(true)}>Sign in</button>
                <button className="btn btn-primary" onClick={() => setShowAuth(true)}>Get started</button>
              </>
            )
          )}
        </div>
      </nav>

      {/* ---------- hero ---------- */}
      <section className="landing-hero">
        <div className="landing-hero-text">
          <h1 className="landing-h1">
            Satellite answers for every district<br />
            <span className="accent">with the uncertainty stated</span>
          </h1>
          <p className="landing-lead">
            Bhu-Drishti watches floods, fires and construction across India using Sentinel-1, Sentinel-2, NASA FIRMS and
            GPM rainfall. Its anytime query engine analyses only the tiles it needs, tells you how sure it is, monitors
            your districts on every new satellite pass, and sends approved reports to the officials who act on them.
          </p>
          <div className="landing-cta-row">
            <button className="btn btn-primary btn-lg" onClick={handleCta}>
              {user ? "Open workspace" : "Start for free"}
            </button>
            <a className="btn btn-lg" href="#how-it-works">See how it works</a>
          </div>
        </div>
        <div className="landing-hero-demo">
          <DemoCard />
        </div>
      </section>

      {/* ---------- use cases ---------- */}
      <section className="landing-section">
        <h2 className="section-h2">What you can analyse</h2>
        <div className="use-case-grid">
          {USE_CASES.map((uc) => (
            <div key={uc.title} className="use-case-card">
              <span className="use-case-icon" aria-hidden="true">{uc.icon}</span>
              <h3>{uc.title}</h3>
              <p className="muted">{uc.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ---------- how it works ---------- */}
      <section className="landing-section" id="how-it-works">
        <h2 className="section-h2">How it works</h2>
        <p className="section-lead muted">
          Reading full-resolution imagery for a whole district is slow. Bhu-Drishti's engine (AEQE) compiles your question
          into a sampling plan and returns a statistically justified interval after analysing a fraction of the tiles —
          then keeps watching the area and alerts you when a threshold is crossed.
        </p>
        <div className="steps-grid">
          {HOW_IT_WORKS.map((s) => (
            <div key={s.n} className="step-card">
              <div className="step-n" aria-hidden="true">{s.n}</div>
              <h3>{s.title}</h3>
              <p className="muted">{s.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ---------- statistical honesty ---------- */}
      <section className="landing-section landing-section-alt">
        <h2 className="section-h2">Honest uncertainty</h2>
        <div className="honesty-grid">
          <div>
            <h3>What the interval covers</h3>
            <p className="muted">
              The confidence interval covers <em>sampling error</em> — the difference between what the specialist model
              would report over every tile and what it reports over the sample. It does not cover the model's own error
              against ground truth.
            </p>
          </div>
          <div>
            <h3>Live data, labelled</h3>
            <p className="muted">
              Real districts use live satellite data and every result lists the scenes it used. Two demo districts with
              known ground truth stay available, clearly marked "simulated", so the engine's claims can be checked.
            </p>
          </div>
          <div>
            <h3>Reproducible traces</h3>
            <p className="muted">
              Every run records the random seed, sample ledger, oracle outputs, and stopping reason. Replay reproduces
              the same estimate bit-for-bit from the cache.
            </p>
          </div>
          <div>
            <h3>Not a proof of violation</h3>
            <p className="muted">
              Satellite observations alone cannot establish criminal conduct, regulatory violations, or individual
              wrongdoing. Results are screening outputs for human review, not legal evidence.
            </p>
          </div>
        </div>
      </section>

      {/* ---------- footer CTA ---------- */}
      <section className="landing-footer-cta">
        <h2>Ready to ask your first question?</h2>
        <p className="muted">Pick a district, ask a question, and get an answer with its sources and limits.</p>
        <button className="btn btn-primary btn-lg" onClick={handleCta}>
          {user ? "Open workspace" : "Get started"}
        </button>
      </section>

      <footer className="landing-footer">
        <p className="muted small">Bhu-Drishti — satellite monitoring for India, built on the Anytime Earth Observation Query Engine (AEQE) ·
          Data: Copernicus Sentinel (ESA), ESA WorldCover, Copernicus DEM, NASA FIRMS, NASA GPM IMERG, Open-Meteo/GloFAS, geoBoundaries (ODbL)</p>
      </footer>

      {showAuth && <AuthModal onClose={() => { setShowAuth(false); if (user) navigate("/app"); }} />}
    </div>
  );
}

/** A real run (live Sentinel-1 RTC data, Planetary Computer) recorded on 17 Oct 2026. */
function DemoCard() {
  return (
    <div className="demo-card">
      <div className="demo-question">
        “What percentage of cropland in Barpeta, Assam was flooded during 1–15 July 2024?”
      </div>
      <div className="demo-answer">
        <div className="demo-value">19.5<span className="demo-unit">%</span></div>
        <div className="demo-ci">95% interval 15.4 – 23.5% · ≈239 km² of 1,228 km² cropland</div>
        <div className="demo-meta muted small">138 of 2,123 tiles analysed · 3 Sentinel-1 passes vs 34 dry-season reference scenes · precision target met</div>
      </div>
      <div className="demo-bar-wrap" aria-hidden="true">
        <div className="demo-bar-track">
          <div className="demo-bar-fill" style={{ width: "19.5%" }} />
        </div>
        <div className="demo-bar-labels">
          <span>0%</span><span>50%</span><span>100%</span>
        </div>
      </div>
      <div className="demo-badge">Live data run · interval covers sampling error, not the radar model's own error</div>
    </div>
  );
}

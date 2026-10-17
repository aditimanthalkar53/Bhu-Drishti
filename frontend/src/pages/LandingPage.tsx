import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../auth";
import { AuthModal } from "../components/AuthModal";

const USE_CASES = [
  { icon: "🌊", title: "Flood monitoring", body: "Estimate flooded cropland extent with adaptive sampling — get a ±3 pp answer in seconds, not hours." },
  { icon: "🏗️", title: "Construction detection", body: "Detect new built-up area between two years using embedding drift and bi-temporal change models." },
  { icon: "🧱", title: "Brick kiln mapping", body: "Locate every kiln in a district with a certified recall guarantee using frontier verification." },
  { icon: "🌿", title: "Land-cover analysis", body: "Track urban expansion, cropland change, and deforestation with spatial evidence you can export." },
];

const HOW_IT_WORKS = [
  { n: "1", title: "Ask a question", body: "Type a natural-language question about a region and time period. The compiler converts it into a typed execution plan." },
  { n: "2", title: "Cheap proxies score every tile", body: "Precomputed embeddings and coarse satellite signals rank all tiles before any expensive model runs." },
  { n: "3", title: "Specialist models sample adaptively", body: "Batches of tiles go to flood segmentation, change detection, or object detection in proxy-guided order." },
  { n: "4", title: "The interval narrows in real time", body: "A statistically justified confidence interval updates after every batch. Stop when it's good enough, or let the budget run out." },
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
          <SatIcon />
          <span>SatQuery AI</span>
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
            Geospatial answers<br />
            <span className="accent">that tighten as they run</span>
          </h1>
          <p className="landing-lead">
            Ask a question about a region. AEQE — the Anytime Earth Observation Query Engine — scores every tile with
            cheap satellite embeddings, runs expensive specialist models only on a statistically designed sample, and
            delivers a result with a confidence interval in seconds, not hours.
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
        <h2 className="section-h2">How AEQE works</h2>
        <p className="section-lead muted">
          Standard Earth-observation agents run the specialist model on every tile. AEQE is a query engine: it
          compiles your question into a sampling plan and returns a statistically justified interval after analysing
          a fraction of the tiles.
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
            <h3>Simulated data for verification</h3>
            <p className="muted">
              The default provider generates a synthetic district with known ground truth. You can press "Compare with
              every tile" to verify that the engine's interval covers the exhaustive answer — and check the model's
              error against the simulated reality separately.
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
        <p className="muted">No setup required. The simulated provider works offline.</p>
        <button className="btn btn-primary btn-lg" onClick={handleCta}>
          {user ? "Open workspace" : "Get started"}
        </button>
      </section>

      <footer className="landing-footer">
        <p className="muted small">SatQuery AI — Anytime Earth Observation Query Engine (AEQE) · Research preview</p>
      </footer>

      {showAuth && <AuthModal onClose={() => { setShowAuth(false); if (user) navigate("/app"); }} />}
    </div>
  );
}

function SatIcon() {
  return (
    <svg viewBox="0 0 32 32" width="28" height="28" aria-hidden="true">
      <rect width="32" height="32" rx="6" fill="var(--ink)" />
      <g fill="none" stroke="var(--paper)" strokeWidth="1.5">
        <rect x="6" y="6" width="6" height="6" /><rect x="13" y="6" width="6" height="6" /><rect x="20" y="6" width="6" height="6" />
        <rect x="6" y="13" width="6" height="6" /><rect x="20" y="13" width="6" height="6" />
        <rect x="6" y="20" width="6" height="6" /><rect x="13" y="20" width="6" height="6" />
      </g>
      <rect x="13" y="13" width="6" height="6" fill="var(--water)" />
      <rect x="20" y="20" width="6" height="6" fill="var(--water)" />
    </svg>
  );
}

function DemoCard() {
  return (
    <div className="demo-card">
      <div className="demo-question">
        "What percentage of cropland was flooded during 1–15 July 2023?"
      </div>
      <div className="demo-answer">
        <div className="demo-value">18.4<span className="demo-unit">%</span></div>
        <div className="demo-ci">95% CI 16.1 – 20.7%</div>
        <div className="demo-meta muted small">Based on 143 of 1,842 tiles · 14.2 s · precision target met</div>
      </div>
      <div className="demo-bar-wrap" aria-hidden="true">
        <div className="demo-bar-track">
          <div className="demo-bar-fill" style={{ width: "18.4%" }} />
        </div>
        <div className="demo-bar-labels">
          <span>0%</span><span>50%</span><span>100%</span>
        </div>
      </div>
      <div className="demo-badge">Simulated · numbers are illustrative</div>
    </div>
  );
}

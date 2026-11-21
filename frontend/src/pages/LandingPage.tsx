import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../auth";
import { Logo } from "../AppShell";
import { AuthModal } from "../components/AuthModal";
import { gsap, magnetic, scrollCounters, scrollReveals, useGsap } from "../motion";
import { ThemeToggle } from "../theme";
import { DISASTER } from "../featureFlags";

const EarthScene = lazy(() => import("../components/three/EarthScene"));

const icon = (d: string) => (
  <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);

const USE_CASES: { icon: ReactNode; title: string; body: string; wide?: boolean; tag?: string }[] = [
  { icon: icon("M2 15c2.5 0 2.5-2 5-2s2.5 2 5 2 2.5-2 5-2 2.5 2 5 2M2 19c2.5 0 2.5-2 5-2s2.5 2 5 2 2.5-2 5-2 2.5 2 5 2M12 3v7m-3-3 3 3 3-3"), title: "Flooded cropland",
    body: "Share and area of cropland under water in any of India's 735 districts, from Sentinel-1 radar that sees through monsoon cloud.", wide: true, tag: "Sentinel-1 · WorldCover · DEM" },
  { icon: icon("M12 22c4 0 7-2.7 7-7 0-3.5-2.5-6-4-8-.5 2-1.5 3-3 3 0-3-1-6-4-8 0 4-3 6.5-3 11 0 4.3 3 9 7 9Z"), title: "Fires and stubble burning",
    body: "Every NASA FIRMS detection counted per village-sized tile and ranked for field review. Burn-scar area from Sentinel-2 is experimental.", tag: "NASA FIRMS" },
  { icon: icon("M3 21h18M5 21V9l7-5 7 5v12M9 21v-6h6v6"), title: "New construction",
    body: "New built-up area between two years from cloud-masked Sentinel-2 dry-season composites.", tag: "Sentinel-2" },
  { icon: icon("M12 21c-4-3-8-6.5-8-11a5 5 0 0 1 8-4 5 5 0 0 1 8 4c0 4.5-4 8-8 11Zm0-11v5m-2.5-2.5h5"), title: "Recovery guidance",
    body: "Each result comes with next steps for officials — PMFBY loss reporting, contingency crops, residue-management support.", wide: true, tag: "PMFBY · SDRF · ICAR-CRIDA" },
];

const HOW_IT_WORKS = [
  { n: "01", title: "Ask a question", body: "Pick a district (or draw your own area) and ask in plain language. The question becomes a typed, checkable plan." },
  { n: "02", title: "Cheap signals score every tile", body: "A coarse radar overview, ESA WorldCover land cover and FIRMS fire density rank all tiles before any heavy imagery is read." },
  { n: "03", title: "Full resolution on a designed sample", body: "Only a statistically chosen sample of tiles is read at 10–20 m from Planetary Computer and Copernicus." },
  { n: "04", title: "An interval that stays honest", body: "The interval narrows after every batch and stays valid however often you look. Rainfall, MODIS flood maps and forecasts are attached as context." },
];

/** The disaster edition has its own landing page; the full edition keeps the original one unchanged. */
export function LandingPage() {
  return DISASTER ? <MaunLanding /> : <SatelliteLanding />;
}

function SatelliteLanding() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const [showAuth, setShowAuth] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  const handleCta = () => (user ? navigate("/app") : setShowAuth(true));

  useEffect(() => {
    const on = () => setScrolled(window.scrollY > 24);
    on();
    window.addEventListener("scroll", on, { passive: true });
    return () => window.removeEventListener("scroll", on);
  }, []);

  useGsap(root, (el) => {
    // hero: headline lines rise in, then copy + CTAs
    gsap.timeline({ delay: 0.15 })
      .from(".lx-hero .lx-line", { yPercent: 110, duration: 1.1, stagger: 0.12, ease: "power4.out" })
      .from(".lx-hero .lx-fade", { y: 18, autoAlpha: 0, duration: 0.8, stagger: 0.08 }, "-=0.6");
    // hero scroll: the globe drifts back and fades as the page moves on (Apple-style scrub)
    gsap.to(".lx-globe", { scale: 0.82, yPercent: 14, autoAlpha: 0.25, ease: "none",
      scrollTrigger: { trigger: ".lx-hero", start: "top top", end: "bottom top", scrub: true } });
    gsap.to(".lx-hero-copy", { yPercent: -30, autoAlpha: 0, ease: "none",
      scrollTrigger: { trigger: ".lx-hero", start: "30% top", end: "bottom top", scrub: true } });
    // product shot: the interval bar fills and the card tilts flat as it enters
    gsap.from(".lx-shot", { rotateX: 18, y: 60, scale: 0.94, ease: "none",
      scrollTrigger: { trigger: ".lx-shot-wrap", start: "top 95%", end: "top 30%", scrub: true } });
    gsap.from(".lx-shot .demo-bar-fill", { width: 0, duration: 1.6, ease: "power2.out", scrollTrigger: { trigger: ".lx-shot", start: "top 70%" } });
    // steps: the progress rail draws as you scroll through
    gsap.from(".lx-rail-fill", { scaleY: 0, ease: "none", transformOrigin: "top",
      scrollTrigger: { trigger: ".lx-steps", start: "top 70%", end: "bottom 60%", scrub: true } });
    scrollReveals(el);
    scrollCounters(el);
    return magnetic(el);
  });

  return (
    <div className="landing lx" ref={root}>
      <nav className={`lx-nav ${scrolled ? "is-scrolled" : ""}`}>
        <a className="lx-brand" href="/"><Logo size={26} /><span>Bhu-Drishti</span></a>
        <div className="lx-links">
          <a href="#capabilities">Capabilities</a>
          <a href="#how-it-works">How it works</a>
          <a href="#honesty">Uncertainty</a>
        </div>
        <div className="lx-nav-actions">
          <ThemeToggle />
          {!loading && (user
            ? <button className="btn btn-primary btn-pill" onClick={() => navigate("/app")}>Open workspace</button>
            : <>
                <button className="btn btn-quiet btn-pill" onClick={() => setShowAuth(true)}>Sign in</button>
                <button className="btn btn-primary btn-pill" onClick={() => setShowAuth(true)}>Get started</button>
              </>)}
        </div>
      </nav>

      {/* ---------- hero ---------- */}
      <header className="lx-hero">
        <div className="lx-globe">
          <Suspense fallback={<div className="lx-globe-fallback" />}>
            <EarthScene className="lx-globe-canvas" />
          </Suspense>
        </div>
        <div className="lx-hero-copy">
          <p className="eyebrow lx-fade">Satellite intelligence for India</p>
          <h1 className="lx-h1">
            <span className="lx-mask"><span className="lx-line">Every district.</span></span>
            <span className="lx-mask"><span className="lx-line lx-grad">Seen from orbit.</span></span>
          </h1>
          <p className="lx-lead lx-fade">
            Floods, fires and construction measured from Sentinel-1, Sentinel-2, NASA FIRMS and GPM rainfall —
            with the uncertainty stated, on every new satellite pass.
          </p>
          <div className="lx-cta lx-fade">
            <button className="btn btn-primary btn-pill btn-xl" data-magnetic onClick={handleCta}>{user ? "Open workspace" : "Start for free"}</button>
            <a className="btn btn-glass btn-pill btn-xl" href="#how-it-works">See how it works <span aria-hidden="true">→</span></a>
          </div>
        </div>
        <a className="lx-scroll-cue lx-fade" href="#stats" aria-label="Scroll to content"><span /></a>
      </header>

      {/* ---------- stats band (all figures are real: product coverage and the recorded demo run below) ---------- */}
      <section className="lx-stats" id="stats" data-stagger>
        <div className="lx-stat"><strong><span data-count="735">735</span></strong><span>districts covered</span></div>
        <div className="lx-stat"><strong><span data-count="6.5" data-decimals="1">6.5</span>%</strong><span>of tiles analysed in the Barpeta run</span></div>
        <div className="lx-stat"><strong><span data-count="95">95</span>%</strong><span>confidence intervals, valid at any stop</span></div>
        <div className="lx-stat"><strong>10<small> m</small></strong><span>Sentinel radar &amp; optical resolution</span></div>
      </section>

      {/* ---------- product shot ---------- */}
      <section className="lx-section lx-shot-wrap">
        <div className="lx-head" data-reveal>
          <p className="eyebrow">A real answer</p>
          <h2 className="lx-h2">One question.<br /><span className="lx-grad">A number you can defend.</span></h2>
        </div>
        <div className="lx-shot-stage">
          <div className="lx-shot"><DemoCard /></div>
        </div>
      </section>

      {/* ---------- capabilities bento ---------- */}
      <section className="lx-section" id="capabilities">
        <div className="lx-head" data-reveal>
          <p className="eyebrow">Capabilities</p>
          <h2 className="lx-h2">What you can analyse.</h2>
        </div>
        <div className="lx-bento" data-stagger>
          {USE_CASES.map((uc) => (
            <article key={uc.title} className={`lx-tile ${uc.wide ? "lx-tile-wide" : ""}`}>
              <span className="lx-tile-icon">{uc.icon}</span>
              <h3>{uc.title}</h3>
              <p>{uc.body}</p>
              {uc.tag && <span className="lx-tag">{uc.tag}</span>}
            </article>
          ))}
        </div>
      </section>

      {/* ---------- how it works ---------- */}
      <section className="lx-section" id="how-it-works">
        <div className="lx-head" data-reveal>
          <p className="eyebrow">How it works</p>
          <h2 className="lx-h2">Read less imagery.<br /><span className="lx-grad">Know more.</span></h2>
          <p className="lx-sub">
            Reading full-resolution imagery for a whole district is slow. Bhu-Drishti's engine (AEQE) compiles your question
            into a sampling plan and returns a statistically justified interval after analysing a fraction of the tiles —
            then keeps watching the area and alerts you when a threshold is crossed.
          </p>
        </div>
        <ol className="lx-steps">
          <span className="lx-rail" aria-hidden="true"><span className="lx-rail-fill" /></span>
          {HOW_IT_WORKS.map((s) => (
            <li key={s.n} className="lx-step" data-reveal>
              <span className="lx-step-n">{s.n}</span>
              <div><h3>{s.title}</h3><p>{s.body}</p></div>
            </li>
          ))}
        </ol>
      </section>

      {/* ---------- statistical honesty ---------- */}
      <section className="lx-section" id="honesty">
        <div className="lx-head" data-reveal>
          <p className="eyebrow">Honest uncertainty</p>
          <h2 className="lx-h2">Clear about what it knows.</h2>
        </div>
        <div className="lx-honesty" data-stagger>
          <div className="lx-glass"><h3>What the interval covers</h3><p>The confidence interval covers <em>sampling error</em> — the difference between what the specialist model would report over every tile and what it reports over the sample. It does not cover the model's own error against ground truth.</p></div>
          <div className="lx-glass"><h3>Live data, labelled</h3><p>Real districts use live satellite data and every result lists the scenes it used. Two demo districts with known ground truth stay available, clearly marked "simulated", so the engine's claims can be checked.</p></div>
          <div className="lx-glass"><h3>Reproducible traces</h3><p>Every run records the random seed, sample ledger, oracle outputs, and stopping reason. Replay reproduces the same estimate bit-for-bit from the cache.</p></div>
          <div className="lx-glass"><h3>Not a proof of violation</h3><p>Satellite observations alone cannot establish criminal conduct, regulatory violations, or individual wrongdoing. Results are screening outputs for human review, not legal evidence.</p></div>
        </div>
      </section>

      {/* ---------- footer CTA ---------- */}
      <section className="lx-final" data-reveal>
        <h2 className="lx-h2">Ready to ask your<br /><span className="lx-grad">first question?</span></h2>
        <p className="lx-sub">Pick a district, ask a question, and get an answer with its sources and limits.</p>
        <button className="btn btn-primary btn-pill btn-xl" data-magnetic onClick={handleCta}>{user ? "Open workspace" : "Get started"}</button>
      </section>

      <footer className="lx-footer">
        <p className="muted small">Bhu-Drishti — satellite monitoring for India, built on the Anytime Earth Observation Query Engine (AEQE) ·
          Data: Copernicus Sentinel (ESA), ESA WorldCover, Copernicus DEM, NASA FIRMS, NASA GPM IMERG, Open-Meteo/GloFAS, geoBoundaries (ODbL)</p>
      </footer>

      {showAuth && <AuthModal onClose={() => { setShowAuth(false); if (user) navigate("/app"); }} />}
    </div>
  );
}

const ROLES = [
  { icon: icon("M12 3 2 20h20L12 3Zm0 6v5m0 3v.5"), title: "Citizens ask", wide: true, tag: "SOS · own language · Drain Watch",
    body: "One SOS with two taps sends your location, with 60 seconds to cancel a mistake. Or describe what is happening in English, Hindi, Kannada or Assamese, by typing or speaking. Your own words are kept next to the summary." },
  { icon: icon("M20 12v9H4v-9M2 7h20v5H2V7Zm10 0v14"), title: "Anyone can offer", tag: "boats · food · shelter",
    body: "Boats, vehicles, food, water, shelter, medical help or labour, with where and until when. The team matches offers to requests by type, distance and quantity." },
  { icon: icon("M9 11l3 3 8-8M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"), title: "Volunteers act", tag: "task board",
    body: "Claim a task, do it, report back. Deliveries, rescues and field checks, each on a map." },
  { icon: icon("M3 13h8V3H3v10Zm0 8h8v-6H3v6Zm10 0h8V11h-8v10Zm0-18v6h8V3h-8Z"), title: "Authorities coordinate", wide: true, tag: "two-person approval · audit log",
    body: "One command map with requests, offers, tasks and hazard layers. Official bulletins are drafted by one officer, approved by a second, then published and emailed. Every action is in the audit log." },
];

const MAUN_STEPS = [
  { n: "01", title: "Count who asked", body: "Requests, SOS and Drain Watch reports land on one map, sorted by severity and by how well each is corroborated." },
  { n: "02", title: "Read the hazard from many satellites", body: "Fires (NASA FIRMS), rainfall (GPM IMERG), flood (MODIS) and river forecasts (GloFAS) on one grid, each with when it last observed." },
  { n: "03", title: "Check a random sample on the ground", body: "Cells are grouped by predicted need and volunteers visit randomly chosen ones. An unreachable cell is never swapped for an easier one." },
  { n: "04", title: "Estimate the need nobody reported", body: "From those checks Maun estimates the true need and the hidden need, with a 95% range that stays valid however often you look. Silent zones are flagged for action." },
];

function MaunLanding() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const [showAuth, setShowAuth] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const go = () => (user ? navigate("/app/dashboard") : setShowAuth(true));
  useGsap(root, (el) => {
    gsap.timeline({ delay: 0.15 })
      .from(".lx-hero .lx-line", { yPercent: 110, duration: 1.1, stagger: 0.12, ease: "power4.out" })
      .from(".lx-hero .lx-fade", { y: 18, autoAlpha: 0, duration: 0.8, stagger: 0.08 }, "-=0.6");
    scrollReveals(el);
    return magnetic(el);
  });
  return (
    <div className="landing lx" ref={root}>
      <nav className="lx-nav is-scrolled">
        <a className="lx-brand" href="/"><Logo size={26} /><span>Maun</span></a>
        <div className="lx-links"><a href="#roles">How it helps</a><a href="#maun">Unreported need</a><a href="#honesty">Limits</a></div>
        <div className="lx-nav-actions">
          <ThemeToggle />
          {!loading && (user
            ? <button className="btn btn-primary btn-pill" onClick={() => navigate("/app/dashboard")}>Open Maun</button>
            : <><button className="btn btn-quiet btn-pill" onClick={() => setShowAuth(true)}>Sign in</button>
                <button className="btn btn-primary btn-pill" onClick={() => setShowAuth(true)}>Join</button></>)}
        </div>
      </nav>
      <header className="lx-hero">
        <div className="lx-globe"><Suspense fallback={<div className="lx-globe-fallback" />}><EarthScene className="lx-globe-canvas" /></Suspense></div>
        <div className="lx-hero-copy">
          <p className="eyebrow lx-fade">Maun (मौन): silence · disaster coordination</p>
          <h1 className="lx-h1">
            <span className="lx-mask"><span className="lx-line">Citizens ask. Volunteers act.</span></span>
            <span className="lx-mask"><span className="lx-line lx-grad">Authorities coordinate.</span></span>
          </h1>
          <p className="lx-lead lx-fade"><strong>We also find the people who couldn&apos;t ask.</strong> Requests, offers of help and official updates in one place,
            and an honest estimate of the need nobody reported.</p>
          <div className="lx-cta lx-fade">
            <button className="btn btn-primary btn-pill btn-xl" data-magnetic onClick={go}>{user ? "Open Maun" : "Ask for or offer help"}</button>
            <a className="btn btn-glass btn-pill btn-xl" href="#maun">How we find silent areas <span aria-hidden="true">→</span></a>
          </div>
          <p className="small lx-fade">In immediate danger, call <a href="tel:112">112</a>.</p>
        </div>
      </header>
      <section className="lx-section" id="roles">
        <div className="lx-head" data-reveal><p className="eyebrow">One place for everyone</p><h2 className="lx-h2">Requests, offers and<br /><span className="lx-grad">official updates.</span></h2></div>
        <div className="lx-bento" data-stagger>
          {ROLES.map((r) => (
            <article key={r.title} className={`lx-tile ${r.wide ? "lx-tile-wide" : ""}`}>
              <span className="lx-tile-icon">{r.icon}</span><h3>{r.title}</h3><p>{r.body}</p><span className="lx-tag">{r.tag}</span>
            </article>
          ))}
        </div>
      </section>
      <section className="lx-section" id="maun">
        <div className="lx-head" data-reveal>
          <p className="eyebrow">Maun</p>
          <h2 className="lx-h2">Silence is not safety.</h2>
          <p className="lx-sub">Every platform counts the people who asked for help. Where phones are dead or networks are down, the worst-hit places can be the quietest.
            Maun estimates the true need, including what nobody reported, and sends volunteers and satellite observation to the quiet areas first.</p>
        </div>
        <ol className="lx-steps">
          <span className="lx-rail" aria-hidden="true"><span className="lx-rail-fill" /></span>
          {MAUN_STEPS.map((s) => <li key={s.n} className="lx-step" data-reveal><span className="lx-step-n">{s.n}</span><div><h3>{s.title}</h3><p>{s.body}</p></div></li>)}
        </ol>
      </section>
      <section className="lx-section" id="honesty">
        <div className="lx-head" data-reveal><p className="eyebrow">Honest limits</p><h2 className="lx-h2">Clear about what it knows.</h2></div>
        <div className="lx-honesty" data-stagger>
          <div className="lx-glass"><h3>The range covers sampling error</h3><p>The 95% range covers the error from checking a sample of places. It does not cover counting mistakes in the field or a wrong population map.</p></div>
          <div className="lx-glass"><h3>Freshness varies by source</h3><p>No satellite watches continuously. Each hazard source shows when it last observed; forecasts are labelled as forecasts.</p></div>
          <div className="lx-glass"><h3>Simulations are labelled</h3><p>Demo data, simulated field checks and the simulated sharper-observation adapter are marked SIMULATED everywhere they appear.</p></div>
          <div className="lx-glass"><h3>Web only, needs a connection</h3><p>Maun runs in the browser and needs connectivity. Bulletins are coordination messages from the response team; official warnings come from NDMA SACHET.</p></div>
        </div>
      </section>
      <section className="lx-final" data-reveal>
        <h2 className="lx-h2">Need help, or<br /><span className="lx-grad">able to help?</span></h2>
        <button className="btn btn-primary btn-pill btn-xl" data-magnetic onClick={go}>{user ? "Open Maun" : "Join Maun"}</button>
      </section>
      <footer className="lx-footer">
        <p className="muted small">Maun, built on the Bhu-Drishti AEQE engine · Hazard data: NASA FIRMS, NASA GPM IMERG, MODIS NRT Global Flood Product, Open-Meteo / Copernicus GloFAS · Official alerts: NDMA SACHET</p>
      </footer>
      {showAuth && <AuthModal initialTab="register" onClose={() => { setShowAuth(false); if (user) navigate("/app/dashboard"); }} />}
    </div>
  );
}

/** A real run (live Sentinel-1 RTC data, Planetary Computer) recorded on 17 Oct 2026. */
function DemoCard() {
  return (
    <div className="demo-card">
      <div className="demo-window" aria-hidden="true"><span /><span /><span /></div>
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

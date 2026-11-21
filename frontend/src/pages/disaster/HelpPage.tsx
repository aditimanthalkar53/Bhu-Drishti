import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError, post } from "../../api";
import { Page, useData } from "../common";
import { getFix, lastFix, LANGUAGES, newClientId, REQUEST_LABEL, rememberFix, SEVERITY_LABEL, SPEECH_LANG, useFix, FixLine,
  type Fix, type HelpRequest, type RequestType } from "./shared";

const CANCEL_S = 60;

/** Citizen and volunteer entry point: SOS, describe in your own words, or the plain form. */
export function HelpPage() {
  return (
    <Page title="Ask for help" lead="In danger right now? Press SOS. Otherwise describe what is happening in your own words. Call 112 if you can.">
      <Sos />
      <Describe />
      <section className="card">
        <h2>Blocked or overflowing drain, open sewer, waterlogging?</h2>
        <p className="muted small">Take a photo with Drain Watch. It goes straight to the ward office.</p>
        <Link className="btn" to="/app/drain">Open Drain Watch</Link>
      </section>
    </Page>
  );
}

// ---------------------------------------------------------------------------- SOS: tap, confirm, send, 60 s to cancel
type SosState = { step: "idle" } | { step: "confirm" } | { step: "sending"; clientId: string; tries: number }
  | { step: "sent"; req: HelpRequest; at: number } | { step: "cancelled" } | { step: "failed"; clientId: string; error: string };

function Sos() {
  const [s, setS] = useState<SosState>({ step: "idle" });
  const [now, setNow] = useState(Date.now());
  const fixRef = useRef<Fix | null>(null);

  useEffect(() => {
    if (s.step !== "sent") return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [s.step]);

  // start locating as soon as the person shows intent, so the confirm tap sends at once
  const arm = () => {
    setS({ step: "confirm" });
    void getFix(10000).then((f) => { if (f) { fixRef.current = f; rememberFix(f); } });
  };

  const send = async (clientId: string, tries = 0): Promise<void> => {
    setS({ step: "sending", clientId, tries });
    const f = fixRef.current ?? (await getFix(4000)) ?? lastFix();
    try {
      const req = await post<HelpRequest>("/api/requests", { source: "sos", clientId, type: "rescue",
        ...(f ? { lat: f.lat, lng: f.lng, accuracyM: f.accuracyM, locationAt: f.at } : {}) });
      setS({ step: "sent", req, at: Date.now() });
    } catch (e) {
      const status = e instanceof ApiError ? e.status : 0;
      // network failure or server hiccup: retry the same SOS (same client id, so it is never duplicated)
      if ((status === 0 || status >= 500) && tries < 4) {
        await new Promise((r) => setTimeout(r, 1500 * (tries + 1)));
        return send(clientId, tries + 1);
      }
      setS({ step: "failed", clientId, error: (e as Error).message });
    }
  };

  const cancel = async (id: string) => {
    try {
      await post(`/api/requests/${id}/cancel`, { reason: "sent by mistake" });
      setS({ step: "cancelled" });
    } catch (e) {
      alert((e as Error).message);
    }
  };

  return (
    <section className="card sos-card" aria-live="polite">
      {s.step === "idle" && (
        <>
          <button className="sos-btn" onClick={arm} aria-label="SOS: ask for emergency help">SOS</button>
          <p className="muted small">Sends your location to the response team. No typing needed.</p>
        </>
      )}
      {s.step === "confirm" && (
        <>
          <h2>Are you sure? This alerts the emergency team now.</h2>
          <div className="row-actions sos-confirm">
            <button className="sos-btn sos-btn-confirm" onClick={() => void send(newClientId())}>Yes, send SOS</button>
            <button className="btn" onClick={() => setS({ step: "idle" })}>No, go back</button>
          </div>
        </>
      )}
      {s.step === "sending" && <h2>Sending SOS…{s.tries > 0 && ` (retry ${s.tries})`}</h2>}
      {s.step === "sent" && (() => {
        const left = Math.max(0, CANCEL_S - Math.floor((now - s.at) / 1000));
        return (
          <>
            <h2>SOS sent. Help is being coordinated.</h2>
            <p className="small">{s.req.lat != null ? `Your location (±${s.req.accuracyM ?? "?"} m) was shared.` : "Your location could not be read; the team has your area."}
              {" "}Stay where you are if it is safe. Keep your phone on.</p>
            {left > 0
              ? <button className="btn btn-danger" onClick={() => void cancel(s.req.id)}>Sent by mistake: cancel ({left} s)</button>
              : <p className="muted small">The cancel window has closed. <Link to="/app/my-requests">Follow your request</Link>.</p>}
          </>
        );
      })()}
      {s.step === "cancelled" && (
        <>
          <h2>SOS cancelled.</h2>
          <p className="muted small">The team has been told it was sent by mistake.</p>
          <button className="btn" onClick={() => setS({ step: "idle" })}>Back</button>
        </>
      )}
      {s.step === "failed" && (
        <>
          <p className="notice notice-error" role="alert">SOS not sent: {s.error}</p>
          <div className="row-actions">
            <button className="sos-btn sos-btn-confirm" onClick={() => void send(s.clientId)}>Try again</button>
            <a className="btn" href="tel:112">Call 112</a>
          </div>
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------- describe in your own words (any of 4 languages, typing or voice)
interface Draft { type: RequestType; severity: 1 | 2 | 3 | 4; people_affected: number | null; needs: string[]; location_hint: string; summary_en: string; summary_local: string; confidence: number }
type Intake = { ok: true; provider: string; draft: Draft } | { ok: false; provider: string; reason: string };

function Describe() {
  const profile = useData<{ language: string }>("/api/profile");
  const [lang, setLang] = useState("en");
  const [text, setText] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [provider, setProvider] = useState<string | null>(null);
  const [manual, setManual] = useState<string | null>(null);   // why the citizen fills in the type by hand
  // nothing is pre-selected: the person (or the reading of their words) chooses, so a guessed default never lowers the urgency
  const [type, setType] = useState<RequestType | "">("");
  const [severity, setSeverity] = useState<0 | 1 | 2 | 3 | 4>(0);
  const [skipped, setSkipped] = useState(false);
  const [people, setPeople] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<HelpRequest | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [edited, setEdited] = useState(false);
  const loc = useFix();
  const clientId = useRef(newClientId());

  useEffect(() => { if (profile.data?.language) setLang(profile.data.language); }, [profile.data]);
  useEffect(() => { void loc.locate(); }, [loc.locate]);

  const makeDraft = async () => {
    setBusy("draft"); setErr(null);
    try {
      const r = await post<Intake>("/api/intake", { text, language: lang });
      if (r.ok) {
        setDraft(r.draft); setProvider(r.provider); setManual(null); setSkipped(false);
        setType(r.draft.type); setSeverity(r.draft.severity); setPeople(r.draft.people_affected?.toString() ?? "");
      } else {
        setDraft(null); setManual(r.reason); setSkipped(false); setType(""); setSeverity(0);
      }
    } catch (e) {
      setManual((e as Error).message); setSkipped(false);
    } finally {
      setBusy(null);
    }
  };

  const send = async () => {
    setBusy("send"); setErr(null);
    try {
      const f = loc.fix;
      const r = await post<HelpRequest>("/api/requests", {
        clientId: clientId.current, source: "local_language", type: type as RequestType, severity: severity as 1 | 2 | 3 | 4, peopleAffected: people ? Number(people) : null,
        description: draft?.summary_local || text, originalText: text, originalLanguage: lang, summaryEn: draft?.summary_en ?? null, needs: draft?.needs ?? [],
        area: draft?.location_hint || null, ...(f ? { lat: f.lat, lng: f.lng, accuracyM: f.accuracyM, locationAt: f.at } : {}),
        intake: draft ? { provider: provider ?? "model", confidence: draft.confidence, edited } : null,
      });
      setDone(r);
      clientId.current = newClientId();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (done) return (
    <section className="card">
      <h2>Your request was sent.</h2>
      <p className="small">We kept your own words, so nothing is lost in translation. <Link to="/app/my-requests">Follow it in My requests</Link>.</p>
      <button className="btn" onClick={() => { setDone(null); setText(""); setDraft(null); setManual(null); }}>Ask for something else</button>
    </section>
  );

  return (
    <section className="card">
      <div className="ev-head">
        <h2>Describe it in your own words</h2>
        <select className="input" aria-label="Language" value={lang} onChange={(e) => setLang(e.target.value)}>
          {Object.entries(LANGUAGES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </div>
      <label className="field">
        <span>What is happening? Who needs help, how many people, and where?</span>
        <textarea value={text} maxLength={4000} onChange={(e) => { setText(e.target.value); setDraft(null); }} rows={4} lang={SPEECH_LANG[lang]} />
      </label>
      <div className="row-actions">
        <Voice lang={lang} onText={(t) => setText((x) => (x ? `${x} ${t}` : t))} />
        <button className="btn btn-primary" disabled={text.trim().length < 3 || !!busy} onClick={() => void makeDraft()}>{busy === "draft" ? "Reading… (up to a minute)" : "Check before sending"}</button>
        <button className="btn" disabled={text.trim().length < 3 || busy === "send"} onClick={() => { setDraft(null); setSkipped(true); setManual("skipped"); setType(""); setSeverity(0); }}>Send as it is</button>
      </div>
      <FixLine fix={loc.fix} state={loc.state} onLocate={() => void loc.locate()} />

      {(draft || manual) && (
        <div className="stack">
          {draft ? (
            <>
              <p className="notice notice-ok">Is this right? Change anything that is wrong, then send.</p>
              <p><strong>{draft.summary_local}</strong></p>
              {lang !== "en" && <p className="muted small">English for the team: {draft.summary_en}</p>}
            </>
          ) : (
            <p className="notice notice-warn">{skipped
              ? "Your words will be sent exactly as you wrote them. Choose the type of help and how urgent it is, then send."
              : `The automatic reading did not work (${manual}). Your words are sent exactly as written. Choose the type of help and how urgent it is, then send.`}</p>
          )}
          <div className="form-grid">
            <label className="field"><span>Type of help</span>
              <select value={type} onChange={(e) => { setType(e.target.value as RequestType); setEdited(true); }}>
                {!type && <option value="">Choose…</option>}
                {Object.entries(REQUEST_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select></label>
            <label className="field"><span>How urgent</span>
              <select value={severity} onChange={(e) => { setSeverity(Number(e.target.value) as 1 | 2 | 3 | 4); setEdited(true); }}>
                {!severity && <option value={0}>Choose…</option>}
                {[4, 3, 2, 1].map((s) => <option key={s} value={s}>{SEVERITY_LABEL[s]}</option>)}
              </select></label>
            <label className="field"><span>People affected</span>
              <input type="number" min={0} value={people} onChange={(e) => { setPeople(e.target.value); setEdited(true); }} /></label>
            {draft?.needs.length ? <p className="small span-2">Needs: {draft.needs.join(", ")}</p> : null}
          </div>
          {err && <p className="notice notice-error" role="alert">{err}</p>}
          <div className="row-actions"><button className="btn btn-primary" disabled={!!busy || !type || !severity} onClick={() => void send()}>{busy === "send" ? "Sending…" : "Send request"}</button>
            {(!type || !severity) && <span className="muted small">Choose the type and how urgent it is to send.</span>}</div>
        </div>
      )}
    </section>
  );
}

/** Browser speech recognition where it exists (Chrome, Edge, Android); typing always works. */
function Voice({ lang, onText }: { lang: string; onText(t: string): void }) {
  const Rec = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
  const [on, setOn] = useState(false);
  const rec = useRef<any>(null);
  if (!Rec) return null;
  const toggle = () => {
    if (on) { rec.current?.stop(); return; }
    const r = new Rec();
    r.lang = SPEECH_LANG[lang] ?? "en-IN";
    r.interimResults = false;
    r.continuous = true;
    r.onresult = (e: any) => onText(Array.from(e.results).slice(e.resultIndex).map((x: any) => x[0].transcript).join(" "));
    r.onend = () => setOn(false);
    r.onerror = () => setOn(false);
    rec.current = r;
    r.start();
    setOn(true);
  };
  return <button type="button" className={`btn ${on ? "btn-danger" : ""}`} onClick={toggle} aria-pressed={on}>{on ? "Stop speaking" : "Speak instead"}</button>;
}

/** Plain list of the person's own requests. */
export function MyRequestsPage() {
  const res = useData<HelpRequest[]>("/api/requests?mine=1");
  return (
    <Page title="My requests" lead="Everything you asked for, and where it stands." actions={<Link className="btn btn-primary" to="/app/help">Ask for help</Link>}>
      {res.error && <p className="notice notice-error">{res.error}</p>}
      {res.data?.length === 0 && <p className="muted">No requests yet.</p>}
      <div className="stack">
        {res.data?.map((r) => (
          <article key={r.id} className="card">
            <div className="ev-head">
              <h2>{r.source === "sos" ? "SOS" : REQUEST_LABEL[r.type]}</h2>
              <span className={`pill pill-${r.status === "resolved" ? "ok" : r.status === "cancelled" ? "muted" : "warn"}`}>{r.status.replace(/_/g, " ")}</span>
            </div>
            <p>{r.originalText || r.description}</p>
            <p className="muted small">{new Date(r.createdAt).toLocaleString()} · urgency {SEVERITY_LABEL[r.severity]}{r.drain ? ` · Drain Watch, ${r.drain.confirmations.length} confirmation(s)` : ""}</p>
            {r.status === "new" && r.source !== "sos" && (
              <button className="btn btn-small" onClick={async () => { await api(`/api/requests/${r.id}/cancel`, { method: "POST", body: "{}" }); await res.reload(); }}>Cancel request</button>
            )}
          </article>
        ))}
      </div>
    </Page>
  );
}

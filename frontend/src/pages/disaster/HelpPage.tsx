import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError, post } from "../../api";
import { Page, useData } from "../common";
import { getFix, languageName, lastFix, newClientId, REQUEST_LABEL, rememberFix, SEVERITY_LABEL, useFix, FixLine,
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

// ---------------------------------------------------------------------------- describe in your own words (any language, typing or voice)
// Nobody picks a language: the server detects it (the model, or the script when there is no model; Whisper for voice).
// A local model needs ~10 s per message on a CPU, so the message is read in the background as soon as it is written
// (typing pauses, or a voice message arrives); "Check before sending" then usually has the answer already.
interface Draft { language: string; type: RequestType; severity: 1 | 2 | 3 | 4; people_affected: number | null; needs: string[]; location_hint: string; summary_en: string; summary_local: string; confidence: number }
type Intake = { ok: true; provider: string; language: string; draft: Draft } | { ok: false; provider: string; language: string; reason: string };

function Describe() {
  const [spokenLang, setSpokenLang] = useState<string | null>(null);   // language Whisper heard, if any text was dictated
  const [voiceProblem, setVoiceProblem] = useState<string | null>(null);
  const [detected, setDetected] = useState<string | null>(null);
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
  const reading = useRef<{ text: string; result: Promise<Intake>; done: boolean } | null>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const [readingState, setReadingState] = useState<"idle" | "reading" | "ready">("idle");

  useEffect(() => { void loc.locate(); }, [loc.locate]);

  /** The model's reading of `t`: reuses one already started for the same text, otherwise starts it after any in flight. */
  const read = (t: string, lang: string | null): Promise<Intake> => {
    if (reading.current?.text === t) return reading.current.result;
    // the language heard in a voice message is passed only as a hint; the model still decides from the text
    const result = queue.current.catch(() => undefined).then(() => post<Intake>("/api/intake", lang ? { text: t, language: lang } : { text: t }));
    const entry = { text: t, result, done: false };
    reading.current = entry;
    queue.current = result;
    setReadingState("reading");
    result.finally(() => { entry.done = true; if (reading.current === entry) setReadingState("ready"); }).catch(() => undefined);
    return result;
  };

  // read in the background once the person pauses (voice text arrives all at once, so it starts almost at once)
  useEffect(() => {
    const t = text.trim();
    if (t.length < 12 || reading.current?.text === t) return;
    setReadingState("idle");
    const id = window.setTimeout(() => void read(t, spokenLang).catch(() => undefined), spokenLang ? 300 : 1500);
    return () => window.clearTimeout(id);
  }, [text, spokenLang]);

  const makeDraft = async () => {
    setBusy("draft"); setErr(null);
    try {
      const r = await read(text.trim(), spokenLang);
      setDetected(r.language);
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
        description: draft?.summary_local || text, originalText: text, ...(detected && detected !== "und" ? { originalLanguage: detected } : {}), summaryEn: draft?.summary_en ?? null, needs: draft?.needs ?? [],
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
      <button className="btn" onClick={() => { setDone(null); setText(""); setDraft(null); setManual(null); setDetected(null); setSpokenLang(null); reading.current = null; setReadingState("idle"); }}>Ask for something else</button>
    </section>
  );

  return (
    <section className="card">
      <h2>Describe it in your own words</h2>
      <label className="field">
        <span>What is happening? Who needs help, how many people, and where? Write in any language.</span>
        <textarea value={text} maxLength={4000} onChange={(e) => { setText(e.target.value); setDraft(null); setDetected(null); if (!e.target.value) setSpokenLang(null); }} rows={4} />
      </label>
      <div className="row-actions">
        <Voice onProblem={setVoiceProblem} onText={(t, l) => { setSpokenLang(l); setDetected(null); setDraft(null); setText((x) => (x ? `${x} ${t}` : t)); }} />
        <button className="btn btn-primary" disabled={text.trim().length < 3 || !!busy} onClick={() => void makeDraft()}>{busy === "draft" ? "Reading… (a few seconds)" : "Check before sending"}</button>
        <button className="btn" disabled={text.trim().length < 3 || busy === "send"} onClick={() => { setDraft(null); setSkipped(true); setManual("skipped"); setType(""); setSeverity(0); }}>Send as it is</button>
      </div>
      {readingState === "reading" && !busy && !draft && <p className="muted small" aria-live="polite">Reading your message in the background, so checking will be quick…</p>}
      {readingState === "ready" && !busy && !draft && reading.current?.text === text.trim() && <p className="muted small" aria-live="polite">Your message has been read. Press Check before sending to see it.</p>}
      {voiceProblem && <p className="notice notice-warn" role="alert">{voiceProblem}</p>}
      <FixLine fix={loc.fix} state={loc.state} onLocate={() => void loc.locate()} />

      {(draft || manual) && (
        <div className="stack">
          {draft ? (
            <>
              <p className="notice notice-ok">Is this right? Change anything that is wrong, then send.</p>
              {draft.language === "en" && <p><strong>{draft.summary_en}</strong></p>}
              {languageName(draft.language) && <p className="muted small">Language detected: {languageName(draft.language)}</p>}
              {draft.language !== "en" && <p className="muted small">English for the team: {draft.summary_en}</p>}
            </>
          ) : (
            <p className="notice notice-warn">{skipped
              ? "Your words will be sent exactly as you wrote them, and the team's system will also read them after sending. Choose the type of help and how urgent it is, then send."
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

/** What our speech endpoint returns: the words, and the language Whisper heard them in. */
interface Transcript { text: string; language: string; language_probability: number; duration_s: number; seconds: number }

const MAX_RECORDING_S = 120;
const blobToBase64 = (b: Blob) => new Promise<string>((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result));
  r.onerror = () => reject(r.error ?? new Error("could not read the recording"));
  r.readAsDataURL(b);
});

/**
 * Voice input: the browser only records; our own server turns the recording into text with Whisper and detects the
 * language itself, so nobody chooses a language. (Browsers' built-in recognition fails in Edge, does not exist in Brave
 * or Firefox, and has to be told the language in advance.) Typing always works.
 */
function Voice({ onText, onProblem }: { onText(text: string, language: string): void; onProblem(msg: string | null): void }) {
  const [state, setState] = useState<"idle" | "recording" | "transcribing">("idle");
  const [secs, setSecs] = useState(0);
  const rec = useRef<MediaRecorder | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const supported = typeof window !== "undefined" && "MediaRecorder" in window && !!navigator.mediaDevices?.getUserMedia;

  useEffect(() => () => { window.clearInterval(timer.current); rec.current?.stream.getTracks().forEach((t) => t.stop()); }, []);
  if (!supported) return null;

  const transcribe = async (blob: Blob) => {
    setState("transcribing");
    try {
      const r = await post<Transcript>("/api/speech", { audio: await blobToBase64(blob) });
      if (r.text.trim()) onText(r.text.trim(), r.language);
      else onProblem("No words were recognised in the recording. Try again a little closer to the microphone, or type instead.");
    } catch (e) {
      onProblem(`Your voice could not be turned into text (${(e as Error).message}). Please type instead.`);
    } finally {
      setState("idle");
    }
  };

  const start = async () => {
    onProblem(null);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (e) {
      const name = (e as DOMException).name;
      onProblem(name === "NotAllowedError" || name === "SecurityError"
        ? "The microphone is blocked for this site. Click the lock or microphone icon in the address bar, allow the microphone, then press Speak again."
        : name === "NotFoundError" ? "No microphone was found. Plug one in or check Windows sound settings, or type instead."
        : `The microphone could not be opened (${name}). Please type instead.`);
      return;
    }
    const type = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/webm", "audio/mp4"].find((t) => MediaRecorder.isTypeSupported(t));
    const r = new MediaRecorder(stream, type ? { mimeType: type, audioBitsPerSecond: 32000 } : undefined);
    const parts: Blob[] = [];
    r.ondataavailable = (e) => { if (e.data.size) parts.push(e.data); };
    r.onstop = () => {
      window.clearInterval(timer.current);
      stream.getTracks().forEach((t) => t.stop());
      const blob = new Blob(parts, { type: r.mimeType || type || "audio/webm" });
      if (blob.size < 1000) { setState("idle"); onProblem("The recording was empty. Press Speak, talk, then press Stop."); return; }
      void transcribe(blob);
    };
    rec.current = r;
    r.start(1000);
    setSecs(0);
    setState("recording");
    const began = Date.now();
    timer.current = window.setInterval(() => {
      const s = Math.floor((Date.now() - began) / 1000);
      setSecs(s);
      if (s >= MAX_RECORDING_S && r.state === "recording") r.stop();
    }, 250);
  };

  const label = state === "recording" ? `Stop (${secs}s)` : state === "transcribing" ? "Turning voice into text…" : "Speak instead";
  return (
    <button type="button" className={`btn ${state === "recording" ? "btn-danger" : ""}`} disabled={state === "transcribing"} aria-pressed={state === "recording"}
      onClick={() => (state === "recording" ? rec.current?.stop() : void start())}>{label}</button>
  );
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

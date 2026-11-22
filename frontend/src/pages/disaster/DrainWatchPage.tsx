import { useEffect, useRef, useState } from "react";
import { authUrl, post } from "../../api";
import { Page } from "../common";
import { compressImage, FixLine, newClientId, useFix, type HelpRequest } from "./shared";

const CATEGORIES: Record<string, string> = {
  open_sewer: "Open sewer / manhole", clogged_drain: "Clogged drain", overflowing_drain: "Overflowing drain",
  waterlogging: "Waterlogging", garbage_in_drain: "Garbage in drain", other: "Other",
};
/** merged: added to an existing report; duplicate: same spot or same photo today, so nothing was uploaded. */
type Sent = { request: HelpRequest; merged: boolean; duplicate?: boolean; reason?: string; confirmations?: number };
type Vision ={ ok: true; provider: string; result: { category: string; severity: number; confidence: number; description: string } } | { ok: false; reason: string };

export function DrainWatchPage() {
  const [photos, setPhotos] = useState<string[]>([]);
  const [category, setCategory] = useState("");
  const [description, setDescription] = useState("");
  const [vision, setVision] = useState<Vision | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<Sent | null>(null);
  const loc = useFix();
  const input = useRef<HTMLInputElement>(null);
  const clientId = useRef(newClientId());

  useEffect(() => { void loc.locate(); }, [loc.locate]);

  const add = async (files: FileList | null) => {
    if (!files) return;
    setErr(null);
    const next = [...photos];
    for (const f of Array.from(files).slice(0, 3 - photos.length)) {
      if (f.size > 25 * 1024 * 1024) { setErr("That photo is too large."); continue; }
      try { next.push(await compressImage(f)); } catch (e) { setErr((e as Error).message); }
    }
    setPhotos(next);
    if (!vision && next.length) {
      setBusy("ai");
      try {
        const v = await post<Vision>("/api/drain/analyze", { photo: next[0] });
        setVision(v);
        if (v.ok && v.result.category !== "not_a_drain" && !category) setCategory(v.result.category);
      } catch { setVision({ ok: false, reason: "analysis failed" }); }
      finally { setBusy(null); }
    }
  };

  const send = async () => {
    if (!loc.fix) return setErr("A location is needed. Allow location access and press “Use my location”.");
    setBusy("send"); setErr(null);
    try {
      const r = await post<Sent>("/api/drain", {
        photos, lat: loc.fix.lat, lng: loc.fix.lng, accuracyM: loc.fix.accuracyM, clientId: clientId.current,
        ...(category ? { category } : {}), ...(description.trim() ? { description: description.trim() } : {}) });
      setDone(r);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (done) {
    const r = done.request;
    return (
      <Page title="Drain Watch">
        <section className="card">
          {done.duplicate
            ? <><h2>Already reported today: {done.reason}.</h2><p className="small">Your photo was not uploaded again, so the response team sees this problem once. It now has {done.confirmations} report(s); more confirmations raise its priority.</p></>
            : done.merged
            ? <><h2>Thank you: this problem was already reported nearby.</h2><p className="small">Your photo was added as a confirmation ({done.confirmations} reports in total). More confirmations raise its priority.</p></>
            : <><h2>Reported to the ward office.</h2>
              <p className="small">{r.drain?.forwarded.to ? `It is forwarded to ${r.drain.forwarded.to}${r.drain.forwarded.status === "not_configured" ? " once email is set up on the server" : ""}.` : "The response team sees it on their board."}</p></>}
          <div className="row-actions">
            {!done.merged && <a className="btn" href={authUrl(`/api/drain/${r.id}/report.pdf`)} target="_blank" rel="noreferrer">View the PDF report</a>}
            <button className="btn" onClick={() => { setDone(null); setPhotos([]); setVision(null); setCategory(""); setDescription(""); clientId.current = newClientId(); }}>Report another</button>
          </div>
        </section>
      </Page>
    );
  }

  return (
    <Page title="Drain Watch" lead="Photograph an open sewer, a blocked or overflowing drain, or waterlogging. Up to 3 photos. Faces are not needed: point the camera at the drain.">
      <section className="card">
        <input ref={input} type="file" accept="image/*" capture="environment" multiple hidden onChange={(e) => { void add(e.target.files); e.target.value = ""; }} />
        <div className="photo-row">
          {photos.map((p, i) => (
            <figure key={i}>
              <img src={p} alt={`Photo ${i + 1}`} />
              <button className="link-btn" onClick={() => setPhotos(photos.filter((_, j) => j !== i))}>Remove</button>
            </figure>
          ))}
          {photos.length < 3 && <button className="btn photo-add" onClick={() => input.current?.click()}>{photos.length ? "Add another photo" : "Take a photo"}</button>}
        </div>
        <p className="muted small">Photos are shrunk on your phone and their hidden data (including the camera's GPS and device details) is removed before upload.</p>
        <FixLine fix={loc.fix} state={loc.state} onLocate={() => void loc.locate()} />
        {busy === "ai" && <p className="muted small">Looking at the photo… You don't have to wait: choose what it is and send.</p>}
        {vision?.ok && <p className="small">AI suggestion: <strong>{vision.result.category === "not_a_drain" ? "this may not be a drain" : CATEGORIES[vision.result.category]}</strong> ({Math.round(vision.result.confidence * 100)}% sure). {vision.result.description} You can change it.</p>}
        {vision && !vision.ok && <p className="muted small">No automatic suggestion available: please choose the category.</p>}
        <div className="form-grid">
          <label className="field"><span>What is it?</span>
            <select value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="">Choose…</option>
              {Object.entries(CATEGORIES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select></label>
          <label className="field"><span>Anything to add? <span className="muted">(optional)</span></span>
            <input value={description} maxLength={1000} onChange={(e) => setDescription(e.target.value)} placeholder="e.g. water entering houses since morning" /></label>
        </div>
        {err && <p className="notice notice-error" role="alert">{err}</p>}
        <div className="row-actions"><button className="btn btn-primary" disabled={!photos.length || !category || busy === "send"} onClick={() => void send()}>{busy === "send" ? "Sending…" : "Send report"}</button></div>
      </section>
    </Page>
  );
}

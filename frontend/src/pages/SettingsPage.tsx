import { useState } from "react";
import { del, post, setToken } from "../api";
import { useAuth } from "../auth";
import { ago, fmtDate } from "../format";
import type { Webhook } from "../types";
import { ErrorNote, Page, Pill, useAction, useData } from "./common";

interface ApiKey { id: string; label: string; prefix: string; createdAt: string }
interface Integrations { report_delivery: string; smtp_configured: boolean; public_url: string; webhook_events: string[]; allow_private_webhooks: boolean; auto_email?: string[] }

export function SettingsPage() {
  const { user } = useAuth();
  const keys = useData<ApiKey[]>("/api/keys");
  const hooks = useData<Webhook[]>("/api/webhooks");
  const integ = useData<Integrations>("/api/settings/integrations");
  const act = useAction();
  const [label, setLabel] = useState("n8n");
  const [newKey, setNewKey] = useState<string | null>(null);
  const [url, setUrl] = useState("http://n8n:5678/webhook/bhu-drishti");
  const [events, setEvents] = useState<string[]>(["report.approved", "alert.triggered"]);
  const [newSecret, setNewSecret] = useState<string | null>(null);
  const [testTo, setTestTo] = useState(user?.email ?? "");

  return (
    <Page title="Settings" lead="Profile, API keys for scripts and n8n, outgoing webhooks and email delivery.">
      <ErrorNote error={act.error ?? keys.error ?? hooks.error} />
      {act.message && <p className="notice notice-ok">{act.message}</p>}
      <section className="card">
        <h2>Profile</h2>
        <p>{user?.name} · {user?.email}</p>
        <ChangePassword />
      </section>

      <section className="card">
        <h2>Email delivery</h2>
        <p className="small">Mode: <strong>{integ.data?.report_delivery === "n8n" ? "n8n (reports are handed to your n8n workflow via the report.approved webhook)" : "direct SMTP"}</strong>
          {" · "}SMTP {integ.data?.smtp_configured ? <Pill tone="ok">configured</Pill> : <Pill tone="warn">not configured</Pill>}</p>
        <p className="small">Automatic copy of every generated report (summary + technical PDF):{" "}
          {integ.data?.auto_email?.length ? <strong>{integ.data.auto_email.join(", ")}</strong> : <span className="muted">off — set REPORT_AUTO_EMAIL in .env</span>}</p>
        <div className="row-actions">
          <input className="input" type="email" placeholder="you@example.org" value={testTo} onChange={(e) => setTestTo(e.target.value)} aria-label="Test email address" />
          <button className="btn btn-small" disabled={act.busy === "mail"} onClick={() => void act.run("mail", async () => {
            const r = await post<{ to: string }>("/api/settings/test-email", { email: testTo });
            return `Test email sent to ${r.to}.`;
          })}>Send test email</button>
        </div>
      </section>

      <section className="card">
        <h2>API keys</h2>
        <p className="muted small">For scripts and automation (n8n). Send as the <code>x-api-key</code> header. Keys are shown once.</p>
        <div className="row-actions">
          <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} aria-label="Key label" />
          <button className="btn btn-small" onClick={() => void act.run("key", async () => {
            const k = await post<{ key: string }>("/api/keys", { label });
            setNewKey(k.key);
            await keys.reload();
          })}>Create key</button>
        </div>
        {newKey && <p className="notice notice-ok">New key (copy it now, it will not be shown again): <code className="break">{newKey}</code></p>}
        <table className="tbl">
          <tbody>
            {keys.data?.map((k) => (
              <tr key={k.id}><td>{k.label}</td><td><code>{k.prefix}…</code></td><td className="small">{fmtDate(k.createdAt)}</td>
                <td><button className="btn btn-small btn-danger" onClick={() => void act.run(`k-${k.id}`, async () => { await del(`/api/keys/${k.id}`); await keys.reload(); })}>Revoke</button></td></tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card">
        <h2>Webhooks (n8n and other automation)</h2>
        <p className="muted small">
          Each POST is signed: <code>x-bhudrishti-signature: sha256=HMAC(secret, timestamp + "." + body)</code> with <code>x-bhudrishti-timestamp</code>.
          {integ.data && !integ.data.allow_private_webhooks && " Only public https URLs are allowed (set ALLOW_PRIVATE_WEBHOOKS=true for an n8n container on the same network)."}
        </p>
        <div className="form-grid">
          <label className="field span-2"><span>URL</span><input value={url} onChange={(e) => setUrl(e.target.value)} /></label>
          <fieldset className="field span-2 fieldset">
            <legend>Events</legend>
            <div className="check-grid">
              {(integ.data?.webhook_events ?? []).map((ev) => (
                <label key={ev}><input type="checkbox" checked={events.includes(ev)} onChange={() => setEvents(events.includes(ev) ? events.filter((x) => x !== ev) : [...events, ev])} /> <code>{ev}</code></label>
              ))}
            </div>
          </fieldset>
        </div>
        <div className="row-actions">
          <button className="btn btn-small" disabled={!events.length} onClick={() => void act.run("hook", async () => {
            const h = await post<Webhook>("/api/webhooks", { url, events });
            setNewSecret(h.secret ?? null);
            await hooks.reload();
          })}>Add webhook</button>
        </div>
        {newSecret && <p className="notice notice-ok">Signing secret (copy it into n8n now): <code className="break">{newSecret}</code></p>}
        <table className="tbl">
          <tbody>
            {hooks.data?.map((h) => (
              <tr key={h.id}>
                <td className="break small">{h.url}<div className="muted">{h.events.join(", ")}</div></td>
                <td className="small">{h.lastStatus == null ? "never called" : h.lastError ? <span className="error-text">{h.lastError}</span> : `HTTP ${h.lastStatus}`}{h.lastDeliveredAt && <div className="muted">{ago(h.lastDeliveredAt)}</div>}</td>
                <td className="row-actions">
                  <button className="btn btn-small" onClick={() => void act.run(`t-${h.id}`, async () => {
                    const r = await post<{ status: number; error: string | null }>(`/api/webhooks/${h.id}/test`);
                    await hooks.reload();
                    if (r.error) throw new Error(`Test failed: ${r.error}`);
                    return `Test delivered (HTTP ${r.status}).`;
                  })}>Test</button>
                  <button className="btn btn-small btn-danger" onClick={() => void act.run(`d-${h.id}`, async () => { await del(`/api/webhooks/${h.id}`); await hooks.reload(); })}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <details>
          <summary className="small">Setting up the n8n email workflow</summary>
          <ol className="small">
            <li>Open n8n at <code>http://localhost:5678</code> and import <code>n8n/bhu-drishti-reports.json</code> from the repository.</li>
            <li>Create an API key above (label “n8n”) and put it in the n8n credential “Bhu-Drishti API key” (Header Auth, name <code>x-api-key</code>).</li>
            <li>Add a webhook above with URL <code>http://n8n:5678/webhook/bhu-drishti</code> and the events <code>report.approved</code> and <code>alert.triggered</code>; paste the signing secret into the workflow's “Verify signature” node.</li>
            <li>Configure the SMTP credential in n8n, set <code>REPORT_DELIVERY=n8n</code> for the backend, and activate the workflow.</li>
            <li>Approving a report now hands it to n8n, which emails each recipient and posts the delivery result back.</li>
          </ol>
        </details>
      </section>
    </Page>
  );
}


function ChangePassword() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const act = useAction();
  return (
    <details>
      <summary className="small">Change password</summary>
      <div className="form-grid" style={{ marginTop: 8 }}>
        <label className="field"><span>Current password</span><input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} /></label>
        <span />
        <label className="field"><span>New password (8+ characters)</span><input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} /></label>
        <label className="field"><span>Confirm new password</span><input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} /></label>
      </div>
      <div className="row-actions">
        <button className="btn btn-small" disabled={!current || !next || act.busy === "pw"} onClick={() => void act.run("pw", async () => {
          if (next.length < 8) throw new Error("Use at least 8 characters.");
          if (next !== confirm) throw new Error("The new passwords do not match.");
          const r = await post<{ token: string }>("/api/auth/password", { current, next });
          setToken(r.token);   // the old token is revoked server-side; keep this browser signed in
          setCurrent(""); setNext(""); setConfirm("");
          return "Password changed. Other devices have been signed out.";
        })}>Change password</button>
        <button className="btn btn-small" disabled={act.busy === "out"} onClick={() => void act.run("out", async () => {
          if (!window.confirm("Sign out of Bhu-Drishti on every device, including this one?")) return "";
          await post("/api/auth/logout-everywhere", {});
          setToken(null);
          window.location.assign("/");
          return "";
        })}>Sign out on all devices</button>
      </div>
      <ErrorNote error={act.error} />
      {act.message && <p className="notice notice-ok">{act.message}</p>}
    </details>
  );
}
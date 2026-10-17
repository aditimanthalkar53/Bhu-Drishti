import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api } from "../api";

/** Load JSON from the API; ``reload`` refetches. Errors are surfaced, not swallowed. */
export function useData<T>(path: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!!path);
  const reload = useCallback(async () => {
    if (!path) return;
    setLoading(true);
    try {
      setData(await api<T>(path));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, ...deps]);
  useEffect(() => { void reload(); }, [reload]);
  return { data, error, loading, reload, setData };
}

export function Page({ title, lead, actions, children }: { title: string; lead?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <main className="page">
      <header className="page-head">
        <div>
          <h1>{title}</h1>
          {lead && <p className="muted">{lead}</p>}
        </div>
        {actions && <div className="page-actions">{actions}</div>}
      </header>
      {children}
    </main>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty-card">
      <h2>{title}</h2>
      {children && <div className="muted">{children}</div>}
    </div>
  );
}

export function ErrorNote({ error }: { error: string | null }) {
  return error ? <p className="notice notice-error" role="alert">{error}</p> : null;
}

export function Pill({ tone, children }: { tone: "ok" | "warn" | "error" | "info" | "muted"; children: ReactNode }) {
  return <span className={`pill pill-${tone}`}>{children}</span>;
}

const REPORT_TONE: Record<string, "ok" | "warn" | "error" | "info" | "muted"> = {
  draft: "muted", pending_approval: "warn", approved: "info", sending: "info", sent: "ok", partially_sent: "warn", failed: "error",
};
export function ReportStatus({ status }: { status: string }) {
  return <Pill tone={REPORT_TONE[status] ?? "muted"}>{status.replace(/_/g, " ")}</Pill>;
}

/** Run an async action with a busy flag and an error message. */
export function useAction() {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const run = async (name: string, fn: () => Promise<string | void>) => {
    setBusy(name);
    setError(null);
    setMessage(null);
    try {
      const m = await fn();
      if (m) setMessage(m);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return { busy, error, message, run, setError, setMessage };
}

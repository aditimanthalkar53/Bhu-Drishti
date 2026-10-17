import { fmtDate } from "../format";
import type { AuditEntry } from "../types";
import { Empty, ErrorNote, Page, useData } from "./common";

export function AuditPage() {
  const a = useData<AuditEntry[]>("/api/audit");
  return (
    <Page title="Audit log" lead="Who created, approved and sent what, and when.">
      <ErrorNote error={a.error} />
      {a.data && a.data.length === 0 && <Empty title="Nothing recorded yet" />}
      {a.data && a.data.length > 0 && (
        <section className="card">
          <div className="table-scroll">
            <table className="tbl">
              <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Target</th><th>Detail</th></tr></thead>
              <tbody>
                {a.data.map((e) => (
                  <tr key={e.id}>
                    <td className="small">{fmtDate(e.createdAt)}</td>
                    <td>{e.actor === "system" ? "system (monitor)" : e.actorName ?? e.actor}</td>
                    <td><code>{e.action}</code></td>
                    <td className="small">{e.target}</td>
                    <td className="small break">{e.detail ? JSON.stringify(e.detail) : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </Page>
  );
}

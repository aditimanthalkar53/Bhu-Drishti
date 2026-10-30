import { useState } from "react";
import { del, patch, post } from "../api";
import { RegionPicker } from "../components/RegionPicker";
import { LEVELS, type Group, type Recipient, type Region } from "../types";
import { Empty, ErrorNote, Page, Pill, useAction, useData } from "./common";

const DEPARTMENTS = ["DDMA", "SDMA", "Revenue", "Agriculture", "Water Resources", "Health", "Fire & Emergency", "Pollution Control Board", "Town Planning", "Other"];
const blank = { name: "", designation: "", department: "DDMA", email: "", phone: "", district: "", state: "", level: 1, reportsToId: "", regionIds: [] as string[], groupIds: [] as string[] };

/** Everyone under one official, shown as an indented chain. A person whose boss was removed shows at the top. */
function Chain({ people, boss, depth }: { people: Recipient[]; boss: string | null; depth: number }) {
  const rows = people.filter((p) => (p.reportsToId ?? null) === boss || (boss === null && p.reportsToId && !people.some((x) => x.id === p.reportsToId)));
  if (depth > 6 || rows.length === 0) return null;
  return (
    <ul className="org-tree">
      {rows.sort((a, b) => (b.level ?? 1) - (a.level ?? 1) || a.name.localeCompare(b.name)).map((p) => (
        <li key={p.id}>
          <span className={`org-node ${p.active ? "" : "row-off"}`}>
            <span className="pill pill-info">{LEVELS[p.level ?? 1]}</span> <strong>{p.name}</strong>{p.designation && <span className="muted small"> · {p.designation}</span>}
          </span>
          <Chain people={people} boss={p.id} depth={depth + 1} />
        </li>
      ))}
    </ul>
  );
}

export function RecipientsPage() {
  const recipients = useData<Recipient[]>("/api/recipients");
  const groups = useData<Group[]>("/api/groups");
  const regions = useData<Region[]>("/api/regions?kind=district");
  const [form, setForm] = useState(blank);
  const [region, setRegion] = useState("");
  const [groupName, setGroupName] = useState("");
  const [q, setQ] = useState("");
  const act = useAction();

  const regionName = (id: string) => regions.data?.find((r) => r.id === id)?.name ?? id;
  const list = (recipients.data ?? []).filter((r) => !q || `${r.name} ${r.designation} ${r.department} ${r.email} ${r.district}`.toLowerCase().includes(q.toLowerCase()));

  const save = () => act.run("save", async () => {
    const rg = regions.data?.find((r) => r.id === region);
    await post("/api/recipients", { ...form, reportsToId: form.reportsToId || null, regionIds: region ? [region] : [], district: form.district || rg?.name || "", state: form.state || rg?.state || "", channels: ["email"] });
    setForm(blank);
    setRegion("");
    await recipients.reload();
    return "Recipient added.";
  });

  return (
    <Page title="Recipients" lead="The officials who receive reports: DDMA, SDMA and line departments. Reports go out by email.">
      <ErrorNote error={recipients.error ?? groups.error} />
      <div className="two-col">
        <section className="card">
          <h2>Add a recipient</h2>
          <div className="form-grid">
            <label className="field"><span>Name</span><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} maxLength={120} /></label>
            <label className="field"><span>Designation</span><input value={form.designation} placeholder="e.g. District Magistrate" onChange={(e) => setForm({ ...form, designation: e.target.value })} /></label>
            <label className="field"><span>Department</span>
              <select value={form.department} onChange={(e) => setForm({ ...form, department: e.target.value })}>{DEPARTMENTS.map((d) => <option key={d}>{d}</option>)}</select>
            </label>
            <label className="field"><span>Level in the hierarchy</span>
              <select value={form.level} onChange={(e) => setForm({ ...form, level: Number(e.target.value) })}>
                {Object.entries(LEVELS).map(([k, v]) => <option key={k} value={k}>{k}. {v}</option>)}
              </select>
            </label>
            <label className="field"><span>Reports to</span>
              <select value={form.reportsToId} onChange={(e) => setForm({ ...form, reportsToId: e.target.value })}>
                <option value="">Nobody (top of the chain)</option>
                {(recipients.data ?? []).filter((r) => r.active).sort((a, b) => (b.level ?? 1) - (a.level ?? 1)).map((r) => <option key={r.id} value={r.id}>{r.name}, {LEVELS[r.level ?? 1]}</option>)}
              </select>
            </label>
            <label className="field"><span>Email</span><input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label>
            <label className="field"><span>Phone <span className="muted">(for WhatsApp/SMS later)</span></span><input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></label>
            {regions.data && <RegionPicker regions={regions.data} value={region} onChange={setRegion} label="Covers district (optional)" />}
            <fieldset className="field span-2 fieldset">
              <legend>Groups</legend>
              <div className="check-grid">
                {groups.data?.map((g) => (
                  <label key={g.id}><input type="checkbox" checked={form.groupIds.includes(g.id)}
                    onChange={() => setForm({ ...form, groupIds: form.groupIds.includes(g.id) ? form.groupIds.filter((x) => x !== g.id) : [...form.groupIds, g.id] })} /> {g.name}</label>
                ))}
                {groups.data?.length === 0 && <span className="muted small">Create groups on the right, e.g. “DDMA Barpeta”.</span>}
              </div>
            </fieldset>
          </div>
          <div className="row-actions">
            <button className="btn btn-primary btn-inline" disabled={!form.name || !form.email || act.busy === "save"} onClick={() => void save()}>Add recipient</button>
          </div>
          <ErrorNote error={act.error} />
          {act.message && <p className="notice notice-ok">{act.message}</p>}
        </section>
        <section className="card">
          <h2>Groups</h2>
          <div className="row-actions">
            <input className="input" placeholder="New group name" value={groupName} onChange={(e) => setGroupName(e.target.value)} aria-label="New group name" />
            <button className="btn btn-small" disabled={!groupName.trim()} onClick={() => void act.run("group", async () => {
              await post("/api/groups", { name: groupName.trim() });
              setGroupName("");
              await groups.reload();
            })}>Add group</button>
          </div>
          <ul className="list">
            {groups.data?.map((g) => (
              <li key={g.id} className="ev-head">
                <span>{g.name} <span className="muted small">({(recipients.data ?? []).filter((r) => r.groupIds.includes(g.id)).length} members)</span></span>
                <button className="btn btn-small btn-danger" onClick={() => void act.run(`g-${g.id}`, async () => {
                  if (!confirm(`Delete group “${g.name}”? Members stay in the directory.`)) return;
                  await del(`/api/groups/${g.id}`);
                  await Promise.all([groups.reload(), recipients.reload()]);
                })}>Delete</button>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <section className="card">
        <h2>Chain of command</h2>
        <p className="muted small">Alerts go to a monitor's own recipients first, then up this chain when they are severe or when nobody confirms in time.</p>
        {(recipients.data?.length ?? 0) === 0 ? <p className="muted small">Add recipients and say who each one reports to.</p> : <Chain people={recipients.data ?? []} boss={null} depth={0} />}
      </section>

      <section className="card">
        <div className="ev-head">
          <h2>Directory ({recipients.data?.length ?? 0})</h2>
          <input className="input" placeholder="Search name, department, district…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search recipients" />
        </div>
        {recipients.data && recipients.data.length === 0 && <Empty title="No recipients yet">Add the officials who should receive reports.</Empty>}
        {list.length > 0 && (
          <div className="table-scroll">
            <table className="tbl">
              <thead><tr><th>Name</th><th>Level</th><th>Reports to</th><th>Department</th><th>Email</th><th>District</th><th>Groups</th><th>Status</th><th /></tr></thead>
              <tbody>
                {list.map((r) => (
                  <tr key={r.id} className={r.active ? "" : "row-off"}>
                    <td><strong>{r.name}</strong><div className="muted small">{r.designation}</div></td>
                    <td>{LEVELS[r.level ?? 1]}</td>
                    <td>
                      <select className="input" aria-label={`Who ${r.name} reports to`} value={r.reportsToId ?? ""} onChange={(e) => void act.run(`rt-${r.id}`, async () => {
                        await patch(`/api/recipients/${r.id}`, { reportsToId: e.target.value || null });
                        await recipients.reload();
                      })}>
                        <option value="">Nobody</option>
                        {(recipients.data ?? []).filter((x) => x.id !== r.id).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                      </select>
                    </td>
                    <td>{r.department}</td>
                    <td>{r.email}</td>
                    <td>{r.district || (r.regionIds[0] ? regionName(r.regionIds[0]) : "–")}</td>
                    <td className="small">{r.groupIds.map((g) => groups.data?.find((x) => x.id === g)?.name).filter(Boolean).join(", ") || "–"}</td>
                    <td><Pill tone={r.active ? "ok" : "muted"}>{r.active ? "active" : "inactive"}</Pill></td>
                    <td className="row-actions">
                      <button className="btn btn-small" onClick={() => void act.run(`a-${r.id}`, async () => {
                        await patch(`/api/recipients/${r.id}`, { active: !r.active });
                        await recipients.reload();
                      })}>{r.active ? "Deactivate" : "Activate"}</button>
                      <button className="btn btn-small btn-danger" onClick={() => void act.run(`d-${r.id}`, async () => {
                        if (!confirm(`Remove ${r.name}?`)) return;
                        await del(`/api/recipients/${r.id}`);
                        await recipients.reload();
                      })}>Remove</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </Page>
  );
}

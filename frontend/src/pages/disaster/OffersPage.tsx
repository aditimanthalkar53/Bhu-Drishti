import { useEffect, useState } from "react";
import { patch, post } from "../../api";
import { useAuth } from "../../auth";
import { Empty, ErrorNote, Page, Pill, useAction, useData } from "../common";
import { FixLine, OFFER_LABEL, useFix, type Offer } from "./shared";

export function OffersPage() {
  const { user } = useAuth();
  const authority = user?.role === "authority";
  const offers = useData<Offer[]>("/api/offers");
  const act = useAction();
  const loc = useFix();
  const [f, setF] = useState({ type: "food", quantity: "1", unit: "", description: "", availableTo: "", contact: "" });
  useEffect(() => { void loc.locate(); }, [loc.locate]);

  const submit = () => act.run("add", async () => {
    await post("/api/offers", { type: f.type, quantity: Number(f.quantity) || 1, unit: f.unit || undefined, description: f.description,
      availableTo: f.availableTo ? new Date(f.availableTo).toISOString() : null, contact: f.contact || null,
      ...(loc.fix ? { lat: loc.fix.lat, lng: loc.fix.lng } : {}) });
    setF({ ...f, description: "", quantity: "1" });
    await offers.reload();
    return "Thank you. Your offer is visible to the response team.";
  });

  return (
    <Page title={authority ? "Offers of help" : "Offer help"} lead={authority ? "Resources people have offered. Match them to requests from the Requests page." : "Boats, vehicles, food, water, shelter, medical help or your own hands."}>
      {!authority && (
        <section className="card">
          <h2>What can you offer?</h2>
          <div className="form-grid">
            <label className="field"><span>Type</span>
              <select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>{Object.entries(OFFER_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
            <div className="field-row">
              <label className="field"><span>How many</span><input type="number" min={0} value={f.quantity} onChange={(e) => setF({ ...f, quantity: e.target.value })} /></label>
              <label className="field"><span>Unit</span><input value={f.unit} placeholder="seats, kg, litres, people…" maxLength={30} onChange={(e) => setF({ ...f, unit: e.target.value })} /></label>
            </div>
            <label className="field span-2"><span>Details</span><input value={f.description} maxLength={1000} placeholder="e.g. country boat with oarsman, 6 seats" onChange={(e) => setF({ ...f, description: e.target.value })} /></label>
            <label className="field"><span>Available until</span><input type="datetime-local" value={f.availableTo} onChange={(e) => setF({ ...f, availableTo: e.target.value })} /></label>
            <label className="field"><span>Contact <span className="muted">(optional)</span></span><input value={f.contact} maxLength={120} onChange={(e) => setF({ ...f, contact: e.target.value })} /></label>
          </div>
          <FixLine fix={loc.fix} state={loc.state} onLocate={() => void loc.locate()} />
          <ErrorNote error={act.error} />
          {act.message && <p className="notice notice-ok">{act.message}</p>}
          <button className="btn btn-primary" disabled={!!act.busy} onClick={() => void submit()}>Offer</button>
        </section>
      )}
      <section className="card">
        <h2>{authority ? `All offers (${offers.data?.length ?? 0})` : "Your offers"}</h2>
        <ErrorNote error={offers.error} />
        {offers.data?.length === 0 && <Empty title="No offers yet" />}
        {!!offers.data?.length && (
          <div className="table-scroll">
            <table className="tbl">
              <thead><tr><th>Type</th><th>Quantity</th><th>Details</th>{authority && <th>From</th>}<th>Until</th><th>Status</th><th /></tr></thead>
              <tbody>
                {offers.data.map((o) => (
                  <tr key={o.id}>
                    <td>{OFFER_LABEL[o.type] ?? o.type}</td><td className="num">{o.quantity} {o.unit}</td><td>{o.description}</td>
                    {authority && <td>{o.offeredByName}{o.contact ? <div className="muted small">{o.contact}</div> : null}</td>}
                    <td className="small">{o.availableTo ? new Date(o.availableTo).toLocaleString() : "–"}</td>
                    <td><Pill tone={o.status === "available" ? "ok" : o.status === "matched" ? "info" : "muted"}>{o.status}</Pill></td>
                    <td>{(o.status === "available" || o.status === "matched") && (
                      <button className="btn btn-small" onClick={() => void act.run(o.id, async () => { await patch(`/api/offers/${o.id}`, { status: authority ? "used" : "withdrawn" }); await offers.reload(); })}>
                        {authority ? "Mark used" : "Withdraw"}</button>)}</td>
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

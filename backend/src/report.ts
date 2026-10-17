import PDFDocument from "pdfkit";

/** Everything the PDF needs about one analysis run (from the stored session snapshot). */
export interface ReportQuery {
  queryId: string;
  question: string;
  status: string;
  answer: string | null;
  estimate: Record<string, any> | null;
  result?: Record<string, any> | null;
  createdAt?: string;
  /** optional map: region outline + per-tile evidence (GeoJSON) */
  regionGeometry?: any;
  evidence?: { features: any[] } | null;
}

export interface ReportData {
  reportId: string;
  title: string;
  summary?: string;
  status?: string;
  approvedBy?: string | null;
  queries: ReportQuery[];
  generatedFor?: string;
}

// Helvetica (WinAnsi) cannot draw some symbols used in answers; map them to readable ASCII.
const SUBS: Record<string, string> = { "≈": "~", "≥": ">=", "≤": "<=", "→": "->", "←": "<-", "∧": " and ", "¬": "not ", "‖": "|",
  "−": "-", "…": "...", "³": "3", "γ": "gamma", "α": "alpha", "Σ": "sum" };
export const pdfText = (s: unknown) => String(s ?? "").replace(/[≈≥≤→←∧¬‖−…³γαΣ]/g, (c) => SUBS[c] ?? "")
  .replace(/[^\x09\x0A\x0D\x20-\x7E -ÿ–—‘’“”•]/g, "");

const fmt = (v: unknown, d = 1) => (typeof v === "number" && Number.isFinite(v) ? v.toLocaleString("en-IN", { maximumFractionDigits: d }) : "-");

export function createReportPdf(data: ReportData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 50, bufferPages: true,
      info: { Title: pdfText(`Bhu-Drishti report — ${data.title}`), Author: "Bhu-Drishti" } });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const H = (t: string, size = 13) => { doc.moveDown(0.6); doc.font("Helvetica-Bold").fontSize(size).fillColor("#0b3d2e").text(pdfText(t)); doc.moveDown(0.25); doc.font("Helvetica").fontSize(10).fillColor("black"); };
    const P = (t: string, opts: any = {}) => doc.font("Helvetica").fontSize(10).fillColor(opts.color ?? "black").text(pdfText(t), opts);

    // ---- cover
    doc.font("Helvetica-Bold").fontSize(22).fillColor("#0b3d2e").text("Bhu-Drishti", { align: "left" });
    doc.font("Helvetica").fontSize(11).fillColor("#555").text("Satellite monitoring report");
    doc.moveDown(0.8);
    doc.font("Helvetica-Bold").fontSize(16).fillColor("black").text(pdfText(data.title));
    doc.moveDown(0.3);
    P(`Report ${data.reportId} · generated ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} IST`, { color: "#555" });
    if (data.approvedBy) P(`Approved for release by ${data.approvedBy}`, { color: "#555" });
    if (data.summary) { doc.moveDown(0.5); P(data.summary); }

    data.queries.forEach((q, qi) => {
      const r = q.result ?? {};
      const e = q.estimate ?? r.estimate ?? {};
      if (qi > 0) doc.addPage();
      H(`${qi + 1}. ${q.question}`, 13);
      if (r.data_mode === "simulated") P("SIMULATED DEMO DATA — not an observation of a real place.", { color: "#b00020" });
      const region = r.region;
      if (region) P(`Area: ${region.name}${region.state ? ", " + region.state : ""}${region.area_km2 ? ` (~${fmt(region.area_km2, 0)} km²)` : ""}`);
      P(`Status: ${q.status}${r.stop_reason ? ` · stopped because: ${String(r.stop_reason).replace(/_/g, " ")}` : ""}`);

      H("Answer", 11);
      P(q.answer ?? "No answer was produced.");

      H("Estimate", 11);
      const units = r.units?.short ?? "";
      const rows: [string, string][] = [];
      if (e.method === "census") {
        rows.push(["Count (exact)", `${fmt(e.value, 0)} ${units}`]);
        if (e.by_confidence) rows.push(["By confidence", Object.entries(e.by_confidence).map(([k, v]) => `${k} ${v}`).join(", ")]);
        if (e.on_cropland !== undefined) rows.push(["On cropland", fmt(e.on_cropland, 0)]);
        if (e.newest_detection) rows.push(["Newest detection", String(e.newest_detection)]);
      } else if (e.value !== undefined) {
        rows.push(["Estimate", `${fmt(e.value, 2)} ${units}`]);
        const anytime = String(e.interval_method ?? "").startsWith("anytime");
        const level = anytime ? "95% overall" : `${Math.round((e.interval_confidence ?? 0.95) * 100)}%`;
        rows.push([`Confidence interval (${level})`, `${fmt(e.lo, 2)} – ${fmt(e.hi, 2)} ${units}`]);
        if (e.interval_method) rows.push(["Interval method", String(e.interval_method)]);
        if (e.total_km2 !== undefined) rows.push(["Affected area", `${fmt(e.total_km2, 1)} km² of ${fmt(e.base_km2, 0)} km²`]);
      }
      if (r.n !== undefined) rows.push(["Tiles analysed", `${fmt(r.n, 0)} of ${fmt(r.population, 0)}`]);
      if (r.oracle?.name) rows.push(["Model", `${r.oracle.name} (${r.oracle.model_version}) on ${r.sensor}`]);
      if (r.missing_data_tiles) rows.push(["Tiles without usable imagery", fmt(r.missing_data_tiles, 0)]);
      table(doc, rows);

      if (q.evidence?.features?.length && q.regionGeometry) {
        H("Map of analysed tiles", 11);
        drawMap(doc, q.regionGeometry, q.evidence.features);
      }

      const ev: any[] = r.supporting_evidence ?? [];
      if (ev.length) {
        H("Supporting evidence (not used in the estimate)", 11);
        for (const x of ev) {
          P(`• ${x.title ?? x.id} [${x.status}]`, { continued: false });
          P(`   ${x.summary ?? ""}`, { color: "#333" });
          if (x.role) P(`   ${x.role}`, { color: "#777" });
        }
      }

      const inputs: any[] = r.inputs_summary ?? [];
      if (inputs.length) {
        H("Data sources used", 11);
        for (const s of inputs) P(`• ${s.source} / ${s.product}: ${s.items} item(s)${s.first ? `, ${s.first.slice(0, 10)} … ${String(s.last).slice(0, 10)}` : ""}`);
      }

      const cav: string[] = r.caveats ?? [];
      if (cav.length) {
        H("Limitations", 11);
        cav.forEach((c) => P(`• ${c}`));
      }

      const adv = r.advisory;
      if (adv?.items?.length) {
        H(`What can be done next — ${adv.headline ?? ""}`, 11);
        for (const it of adv.items) {
          doc.font("Helvetica-Bold").fontSize(10).text(pdfText(`• ${it.title}`));
          P(`   ${it.detail}`);
          P(`   Who: ${it.who} · When: ${it.when}${it.reference ? ` · See: ${it.reference}` : ""}`, { color: "#555" });
        }
        P(adv.disclaimer ?? "", { color: "#777" });
      }
    });

    // ---- footer on every page
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      // writing inside the bottom margin would make PDFKit start a new page
      const bottom = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc.font("Helvetica").fontSize(8).fillColor("#888").text(
        pdfText(`Bhu-Drishti · satellite-based estimates with stated uncertainty — verify on the ground before enforcement or relief decisions · page ${i + 1} of ${range.count}`),
        50, doc.page.height - 40, { width: doc.page.width - 100, align: "center", lineBreak: false });
      doc.page.margins.bottom = bottom;
    }
    doc.end();
  });
}

function table(doc: PDFKit.PDFDocument, rows: [string, string][]) {
  const x0 = doc.page.margins.left;
  const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  for (const [k, v] of rows) {
    const y = doc.y;
    doc.font("Helvetica-Bold").fontSize(10).fillColor("#333").text(pdfText(k), x0, y, { width: w * 0.38 });
    const yk = doc.y;
    doc.font("Helvetica").fillColor("black").text(pdfText(v), x0 + w * 0.4, y, { width: w * 0.6 });
    doc.y = Math.max(yk, doc.y) + 2;
    doc.x = x0;
  }
}

function rings(geom: any): number[][][] {
  if (!geom) return [];
  if (geom.type === "Polygon") return geom.coordinates;
  if (geom.type === "MultiPolygon") return geom.coordinates.flat();
  return [];
}

function drawMap(doc: PDFKit.PDFDocument, regionGeom: any, features: any[]) {
  const all = rings(regionGeom).flat();
  if (!all.length) return;
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of all) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  const W = 300, Hh = 220;
  if (doc.y + Hh + 30 > doc.page.height - 60) doc.addPage();
  const left = doc.page.margins.left, top = doc.y;
  const k = Math.min(W / (x1 - x0), Hh / (y1 - y0));
  const px = (x: number) => left + (x - x0) * k;
  const py = (y: number) => top + (y1 - y) * k;
  const vals = features.map((f) => Number(f.properties?.value ?? 0)).filter(Number.isFinite);
  const vmax = Math.max(...vals, 1e-9);
  for (const f of features) {
    const rs = rings(f.geometry);
    const v = Number(f.properties?.value ?? 0);
    const t = Math.min(1, Math.max(0, v / vmax));
    for (const r of rs) {
      doc.save();
      doc.polygon(...(r.map(([x, y]) => [px(x), py(y)]) as [number, number][]));
      doc.fillColor(v > 0 ? [Math.round(255 - 200 * t), Math.round(220 - 120 * t), 60] as any : "#cfd8dc").fillOpacity(0.9).fill();
      doc.restore();
    }
  }
  for (const r of rings(regionGeom)) {
    doc.save();
    doc.polygon(...(r.map(([x, y]) => [px(x), py(y)]) as [number, number][]));
    doc.lineWidth(0.8).strokeColor("#0b3d2e").stroke();
    doc.restore();
  }
  doc.y = top + (y1 - y0) * k + 8;
  doc.x = left;
  doc.font("Helvetica").fontSize(8).fillColor("#555").text(pdfText(
    `Analysed tiles (${features.length}); darker = higher model value; grey = analysed, none found. Lon ${x0.toFixed(2)}–${x1.toFixed(2)}, Lat ${y0.toFixed(2)}–${y1.toFixed(2)}.`));
  doc.fillColor("black");
}

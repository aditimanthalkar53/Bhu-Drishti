import PDFDocument from "pdfkit";
import { drawMap, pdfText, type ReportData, type ReportQuery } from "./report.js";

/**
 * The plain-language report: what was found, how sure we are, what it means and what to do —
 * written for district officials, panchayat members and farmers' groups, not for analysts.
 * The technical report (report.ts) keeps every statistic, source and limitation.
 */

const GREEN = "#0b3d2e";
const fmt = (v: number, d = 0) => v.toLocaleString("en-IN", { maximumFractionDigits: d, minimumFractionDigits: d });

function dateText(iso?: string | null) {
  if (!iso) return "";
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

function target(q: ReportQuery): string {
  const t = q.result?.query?.target;
  if (t) return t;
  const a = (q.answer ?? q.question).toLowerCase();
  if (a.includes("fire detection")) return "active_fire";
  if (a.includes("burn")) return "burned_cropland";
  if (a.includes("built")) return "new_builtup";
  if (a.includes("kiln")) return "brick_kiln";
  return "flooded_cropland";
}

/** "about 1 in 5" style ratio for a percentage. */
function oneIn(pct: number): string | null {
  if (pct <= 0 || pct > 60) return null;
  const n = Math.round(100 / pct);
  return n >= 2 && n <= 50 ? `about 1 in ${n}` : null;
}

function certainty(e: any): { label: string; text: string } {
  if (e?.method === "census") return { label: "Exact count", text: "Every part of the area was checked, so this is a full count of what the satellites saw." };
  const v = Math.abs(Number(e?.value ?? 0)), hw = Number(e?.halfwidth ?? (Number(e?.hi) - Number(e?.lo)) / 2);
  const rel = v > 0 ? hw / v : 1;
  if (rel <= 0.15) return { label: "Fairly certain", text: "The range is narrow: the true value is very likely close to our estimate." };
  if (rel <= 0.4) return { label: "Reasonably certain", text: "The range is moderate: use the estimate for planning, and the range for worst/best cases." };
  return { label: "Rough estimate", text: "The range is wide: treat the number as a first indication and confirm on the ground." };
}

interface Plain { headline: string; detail: string; meaning: string[] }

function explain(q: ReportQuery): Plain {
  const r = q.result ?? {};
  const e = q.estimate ?? r.estimate ?? {};
  const place = r.region ? `${r.region.name}${r.region.state ? `, ${r.region.state}` : ""}` : "the selected area";
  const from = dateText(r.query?.start), to = dateText(r.query?.end);
  const when = from && to ? (from === to ? `on ${from}` : `between ${from} and ${to}`) : "in the chosen period";
  const v = Number(e.value ?? 0), lo = Number(e.lo ?? 0), hi = Number(e.hi ?? 0);
  switch (target(q)) {
    case "flooded_cropland": {
      if (r.query?.task === "total") {
        return { headline: `About ${fmt(v)} km² of farmland in ${place} was under water ${when}.`,
          detail: `That is roughly ${fmt(v * 100)} hectares (very likely between ${fmt(lo)} and ${fmt(hi)} km²).`,
          meaning: ["Standing crops in these fields are at risk of damage or loss.", "Areas that flooded once are likely to flood again next season."] };
      }
      const ratio = oneIn(v);
      return {
        headline: ratio
          ? `${ratio[0].toUpperCase()}${ratio.slice(1)} farm fields (${fmt(v, 1)}%) in ${place} were under water ${when}.`
          : `${fmt(v, 1)}% of farmland in ${place} was under water ${when}.`,
        detail: e.total_km2 ? `That is about ${fmt(e.total_km2)} km² (${fmt(e.total_km2 * 100)} hectares) out of ${fmt(e.base_km2)} km² of farmland. ` +
          `The true share is very likely between ${fmt(lo, 1)}% and ${fmt(hi, 1)}%.` : `The true share is very likely between ${fmt(lo, 1)}% and ${fmt(hi, 1)}%.`,
        meaning: ["Standing crops in the flooded fields are at risk of damage or total loss.",
          "Farmers with crop insurance (PMFBY) must report flood losses within 72 hours.",
          "The map shows where flooding was found, so field surveys can start there."],
      };
    }
    case "active_fire": {
      const byc = e.by_confidence ?? {};
      return {
        headline: v === 0 ? `Satellites detected no fires in ${place} ${when}.` : `Satellites detected ${fmt(v)} fire${v === 1 ? "" : "s"} in ${place} ${when}.`,
        detail: (v === 0 ? "No fire was seen on farmland. "
          : v === 1 ? `${e.on_cropland ? "It was on farmland" : "It was not on farmland"}${byc.high ? " and was a high-confidence detection" : ""}. `
          : `${fmt(e.on_cropland ?? 0)} of them ${e.on_cropland === 1 ? "was" : "were"} on farmland, and ${fmt(byc.high ?? 0)} ${byc.high === 1 ? "was a high-confidence detection" : "were high-confidence detections"}. `) +
          (e.newest_detection ? `${v === 1 ? "It was" : "The most recent was"} seen on ${dateText(String(e.newest_detection).slice(0, 10))}.` : ""),
        meaning: ["Fires on farmland in this season are usually crop-residue (stubble) burning, which harms air quality and soil.",
          "A satellite detection shows heat at that spot; it does not show who lit the fire.",
          "The listed places should be visited by field staff before any action."],
      };
    }
    case "burned_cropland":
      return {
        headline: `An estimated ${fmt(v, 1)}${r.query?.task === "area_fraction" ? "%" : " km²"} of farmland in ${place} shows burn marks ${when}.`,
        detail: "This measurement is still experimental and has not been checked against field data. Use the fire count for decisions.",
        meaning: ["Treat this number as indicative only."],
      };
    case "new_builtup":
      return {
        headline: `About ${fmt(v)} km² of new buildings and paved land appeared in ${place}${r.query?.baseline_start ? ` since ${r.query.baseline_start.slice(0, 4)}` : ""}.`,
        detail: `The true figure is very likely between ${fmt(lo)} and ${fmt(hi)} km². That is about ${fmt(v * 100)} hectares.`,
        meaning: ["This shows where land changed from fields or open land to built-up land.",
          "It does not say whether any construction is legal — that needs records and a site visit."],
      };
    default:
      return { headline: q.answer ?? "Result", detail: "", meaning: [] };
  }
}

export function createSimpleReportPdf(data: ReportData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 56, bufferPages: true,
      info: { Title: pdfText(`Bhu-Drishti summary — ${data.title}`), Author: "Bhu-Drishti" } });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const H = (t: string) => { doc.moveDown(0.6); doc.font("Helvetica-Bold").fontSize(12.5).fillColor(GREEN).text(pdfText(t)); doc.moveDown(0.2); };
    const P = (t: string, color = "black", size = 11) => doc.font("Helvetica").fontSize(size).fillColor(color).text(pdfText(t), { lineGap: 1.5 });
    const bullet = (t: string) => P(`•  ${t}`);

    doc.font("Helvetica-Bold").fontSize(20).fillColor(GREEN).text("Bhu-Drishti");
    doc.font("Helvetica").fontSize(11).fillColor("#555").text("Satellite report — summary in plain language");
    doc.moveDown(0.6);
    doc.moveTo(56, doc.y).lineTo(doc.page.width - 56, doc.y).strokeColor("#cfd8d3").lineWidth(1).stroke();

    data.queries.forEach((q, i) => {
      if (i > 0) doc.addPage();
      const r = q.result ?? {};
      const e = q.estimate ?? r.estimate ?? {};
      const x = explain(q);
      doc.moveDown(0.8);
      doc.font("Helvetica").fontSize(10).fillColor("#666").text(pdfText(`Question: ${q.question}`));
      if (r.data_mode === "simulated") {
        doc.moveDown(0.3);
        P("Practice example — this area is simulated, not a real place.", "#b00020", 11);
      }
      doc.moveDown(0.5);
      doc.font("Helvetica-Bold").fontSize(17).fillColor("black").text(pdfText(x.headline), { lineGap: 3 });
      if (x.detail) { doc.moveDown(0.4); P(x.detail, "#333"); }

      const c = certainty(e);
      H(`How sure are we?  ${c.label}`);
      P(c.text);

      if (q.evidence?.features?.length && q.regionGeometry) {
        H("Where");
        const found = q.evidence.features.filter((f: any) => Number(f.properties?.value ?? 0) > 0).length;
        const ring = found > 0 && found <= 30;   // rings help find a few places; with many they only clutter
        drawMap(doc, q.regionGeometry, q.evidence.features, { w: 230, h: 150, caption: false, markFound: ring });
        P(target(q) === "active_fire"
          ? "Red circles mark the places where fires were detected."
          : `Coloured squares are the places the satellites checked closely; darker colour means more was found${ring ? ", red circles mark where it was found" : ""}.`,
        "#555", 9.5);
      }

      if (x.meaning.length) {
        H("What this means");
        x.meaning.forEach(bullet);
      }

      const adv = r.advisory;
      if (adv?.items?.length) {
        H("What to do now");
        for (const it of adv.items.slice(0, 3)) {
          doc.font("Helvetica-Bold").fontSize(11).fillColor("black").text(pdfText(`•  ${it.title}`));
          P(`    ${it.who} · ${it.when}`, "#555", 10);
        }
        P("The detailed report lists all steps with the schemes to refer to.", "#555", 10);
      }

      H("Good to know");
      bullet("These figures come from satellite images, not from people on the ground. Please confirm important findings with a field visit.");
      bullet("Clouds, smoke or missing images can hide part of the area.");
      bullet("The detailed (technical) report has the full method, data sources and limits.");
    });

    const range = doc.bufferedPageRange();
    for (let p = range.start; p < range.start + range.count; p++) {
      doc.switchToPage(p);
      const bottom = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc.font("Helvetica").fontSize(8.5).fillColor("#888").text(
        pdfText(`Bhu-Drishti · report ${data.reportId} · ${new Date().toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" })} · page ${p + 1} of ${range.count}`),
        56, doc.page.height - 40, { width: doc.page.width - 112, align: "center", lineBreak: false });
      doc.page.margins.bottom = bottom;
    }
    doc.end();
  });
}

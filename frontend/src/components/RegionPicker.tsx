import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { Region } from "../types";

interface Props {
  regions: Region[];
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
  label?: string;
}

const KIND_LABEL: Record<string, string> = { demo: "Demo districts (simulated)", custom: "My areas", district: "Indian districts (live data)" };

/** Searchable combobox over ~740 regions: type a district or state name. */
export function RegionPicker({ regions, value, onChange, disabled, label = "Region" }: Props) {
  const id = useId();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const current = regions.find((r) => r.id === value);

  const matches = useMemo(() => {
    const s = q.trim().toLowerCase();
    const scored = regions
      .filter((r) => !s || r.name.toLowerCase().includes(s) || (r.state ?? "").toLowerCase().includes(s))
      .map((r) => ({ r, score: !s ? 0 : r.name.toLowerCase().startsWith(s) ? 0 : r.name.toLowerCase().includes(s) ? 1 : 2 }));
    const order = { demo: 0, custom: 1, district: 2 } as Record<string, number>;
    scored.sort((a, b) => (order[a.r.kind ?? "district"] - order[b.r.kind ?? "district"]) || a.score - b.score || a.r.name.localeCompare(b.r.name));
    return scored.slice(0, 60).map((x) => x.r);
  }, [regions, q]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => { if (!boxRef.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const pick = (r: Region) => {
    onChange(r.id);
    setQ("");
    setOpen(false);
  };

  const describe = (r: Region) => (r.state ? `${r.name}, ${r.state}` : r.name);
  let lastKind = "";

  return (
    <div className="field region-picker" ref={boxRef}>
      <label htmlFor={`${id}-input`}>{label}</label>
      <input
        id={`${id}-input`} role="combobox" aria-expanded={open} aria-controls={`${id}-list`} aria-autocomplete="list"
        aria-activedescendant={open && matches[active] ? `${id}-opt-${active}` : undefined}
        disabled={disabled} autoComplete="off"
        placeholder={current ? describe(current) : "Search a district or state…"}
        value={open ? q : current ? describe(current) : q}
        onFocus={() => { setOpen(true); setQ(""); setActive(0); }}
        onChange={(e) => { setQ(e.target.value); setOpen(true); setActive(0); }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); setOpen(true); setActive((a) => Math.min(a + 1, matches.length - 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
          else if (e.key === "Enter" && open && matches[active]) { e.preventDefault(); pick(matches[active]); }
          else if (e.key === "Escape") setOpen(false);
        }}
      />
      {current && !open && (
        <span className={`mode-badge ${current.simulated ? "mode-sim" : "mode-live"}`}>{current.simulated ? "Simulated" : "Live data"}</span>
      )}
      {open && (
        <ul className="picker-list" id={`${id}-list`} role="listbox">
          {matches.length === 0 && <li className="muted small picker-empty">No district matches “{q}”.</li>}
          {matches.map((r, i) => {
            const head = r.kind !== lastKind ? (lastKind = r.kind ?? "district", KIND_LABEL[lastKind]) : null;
            return (
              <li key={r.id} role="presentation">
                {head && <div className="picker-group" aria-hidden="true">{head}</div>}
                <div id={`${id}-opt-${i}`} role="option" aria-selected={r.id === value}
                  className={`picker-opt ${i === active ? "active" : ""}`}
                  onMouseDown={(e) => { e.preventDefault(); pick(r); }} onMouseEnter={() => setActive(i)}>
                  <span>{r.name}</span>
                  <span className="muted small">{r.state || (r.simulated ? "simulated" : "")}{r.area_km2 ? ` · ${Math.round(r.area_km2).toLocaleString("en-IN")} km²` : ""}</span>
                </div>
              </li>
            );
          })}
          {regions.length > matches.length && <li className="muted small picker-empty">Type to search all {regions.length.toLocaleString("en-IN")} areas.</li>}
        </ul>
      )}
    </div>
  );
}

import type { Region } from "./types";

/**
 * Keeps the SACHET alerts page and Explore in step: which districts an alert names, which alerts apply to a district,
 * and which of Explore's questions fits the hazard. Matching is on the district names in the alert's own text
 * (SACHET gives area names, not district codes); nothing is guessed beyond that.
 */
export interface AlertLike {
  title: string; event: string; areaDesc: string | null; msgType?: string | null; expires?: string | null;
}

/** lower case, accents folded (the district list writes "Mahārāshtra"), punctuation to spaces, padded so whole words match */
const norm = (s: string) => ` ${s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9ऀ-ॿ]+/g, " ").trim()} `;
/** Some districts are named only by a direction or position (Delhi has "South", "North", "West", "East"). In alert text those words
 *  appear inside other places ("South Tripura"), so they cannot be matched by name. */
const GENERIC = new Set(["north", "south", "east", "west", "central", "north east", "north west", "south east", "south west", "new", "old", "upper", "lower", "middle"]);
const alertText = (a: AlertLike) => `${a.areaDesc ?? ""} ${a.title} ${a.event}`;

/** Districts named in the alert. A name shared by districts of different states is narrowed by the state if the alert names it. */
export function matchDistricts(a: AlertLike, regions: Region[], max = 6): Region[] {
  const hay = norm(alertText(a));
  const hits = regions.filter((r) => r.kind === "district" && r.name.length >= 4 && !GENERIC.has(norm(r.name).trim()) && hay.includes(norm(r.name)));
  const byName = new Map<string, Region[]>();
  for (const r of hits) byName.set(r.name.toLowerCase(), [...(byName.get(r.name.toLowerCase()) ?? []), r]);
  const out: Region[] = [];
  for (const group of byName.values()) {
    const withState = group.filter((r) => r.state && hay.includes(norm(r.state)));
    out.push(...(group.length > 1 && withState.length ? withState : group));
  }
  return out.slice(0, max);
}

/** The active (not cancelled, not expired) alerts that name this district. */
export function alertsForRegion<T extends AlertLike>(region: Region | undefined, alerts: T[], now = Date.now()): T[] {
  if (!region || region.kind !== "district") return [];
  return alerts.filter((a) => a.msgType !== "Cancel" && !(a.expires && Date.parse(a.expires) < now) && matchDistricts(a, [region]).length > 0);
}

/** Explore question for the hazard in the alert (the wording of Explore's own live examples), or null when none fits. */
export function suggestedQuestion(a: AlertLike): string | null {
  const t = alertText(a).toLowerCase();
  if (/\b(wild ?fire|forest fire|fire)\b/.test(t)) return "How many fire detections were there in the last 10 days?";
  if (/\b(flood|flash flood|heavy rain|very heavy rain|extremely heavy rain|rainfall|cloudburst|cyclone|inundation|waterlogging|river)\b/.test(t))
    return "What percentage of cropland was flooded in the last 14 days?";
  return null;
}

export const exploreUrl = (region: Region, question: string | null) =>
  `/app?region=${encodeURIComponent(region.id)}${question ? `&q=${encodeURIComponent(question)}` : ""}`;

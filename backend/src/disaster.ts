import { notify } from "./delivery.js";
import type { Roles } from "./roles.js";
import type { Store, StoredRecord } from "./store/types.js";

/** Shared vocabulary of the disaster-coordination features (requests, offers, updates, tasks). */
export const REQUEST_TYPES = ["rescue", "medical", "food_water", "shelter", "road_blocked", "power", "drain_or_sewer", "waterlogging", "other"] as const;
export type RequestType = (typeof REQUEST_TYPES)[number];
export const REQUEST_STATUSES = ["new", "verified", "assigned", "in_progress", "resolved", "cancelled"] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];
export const REQUEST_SOURCES = ["form", "sos", "local_language", "drain_watch"] as const;
export type RequestSource = (typeof REQUEST_SOURCES)[number];
export const OFFER_TYPES = ["boat", "vehicle", "food", "water", "shelter", "medical", "labour", "other"] as const;
export type OfferType = (typeof OFFER_TYPES)[number];
export const DRAIN_CATEGORIES = ["open_sewer", "clogged_drain", "overflowing_drain", "waterlogging", "garbage_in_drain", "other", "not_a_drain"] as const;
export type DrainCategory = (typeof DRAIN_CATEGORIES)[number];

export interface HistoryEntry { at: string; by: string; action: string; detail?: Record<string, unknown> }

export interface HelpRequest extends StoredRecord {
  type: RequestType;
  description: string;
  originalText: string | null;
  originalLanguage: string | null;
  summaryEn: string | null;
  needs: string[];
  lat: number | null;
  lng: number | null;
  accuracyM: number | null;
  locationAt: string | null;
  area: string | null;
  severity: 1 | 2 | 3 | 4;
  peopleAffected: number | null;
  contact: string | null;
  source: RequestSource;
  status: RequestStatus;
  priority: number | null;
  assigneeId: string | null;
  offerIds: string[];
  /** e.g. location_missing, possible_accidental, repeated, cancelled_by_reporter, duplicate_merged */
  flags: string[];
  clientId: string | null;
  reporterName: string;
  intake?: { provider: string; confidence: number | null; edited: boolean } | null;
  drain?: DrainInfo | null;
  history: HistoryEntry[];
}

export interface DrainInfo {
  category: DrainCategory;
  categorySource: "citizen" | "ai";
  photos: string[];                  // file names under uploads/drain/<id>/
  vision: { provider: string; category: DrainCategory; severity: number; confidence: number; description: string } | null;
  visionError: string | null;
  confirmations: { at: string; by: string; photos: string[] }[];
  forwarded: { to: string | null; status: "sent" | "failed" | "not_configured" | "pending"; at: string | null; error?: string | null };
}

export interface Offer extends StoredRecord {
  type: OfferType;
  quantity: number;
  unit: string;
  description: string;
  lat: number | null;
  lng: number | null;
  availableFrom: string | null;
  availableTo: string | null;
  contact: string | null;
  status: "available" | "matched" | "used" | "withdrawn";
  offeredByName: string;
  matchIds: string[];
}

export type UpdateSeverity = "info" | "advisory" | "warning" | "emergency";
export interface OfficialUpdate extends StoredRecord {
  title: string;
  body: string;
  area: string;
  severity: UpdateSeverity;
  expiresAt: string | null;
  status: "pending_approval" | "published" | "rejected";
  authorId: string;
  authorName: string;
  approvedBy: string | null;
  approvedByName: string | null;
  publishedAt: string | null;
  rejectedNote: string | null;
  recipientIds: string[];
  groupIds: string[];
  delivery: { sent: number; failed: number; note: string | null } | null;
}

export type TaskType = "field_check" | "rescue" | "delivery" | "assessment" | "general";
export interface Task extends StoredRecord {
  title: string;
  type: TaskType;
  description: string;
  requestId: string | null;
  offerId: string | null;
  runId: string | null;
  cellId: string | null;
  lat: number | null;
  lng: number | null;
  status: "open" | "claimed" | "done" | "unreachable" | "cancelled";
  claimedBy: string | null;
  claimedByName: string | null;
  claimedAt: string | null;
  completedAt: string | null;
  note: string | null;
  result: Record<string, unknown> | null;
  createdBy: string;
}

export interface Match extends StoredRecord {
  requestId: string;
  offerId: string;
  taskId: string | null;
  score: number | null;
  createdBy: string;
}

export const now = () => new Date().toISOString();

/** Great-circle distance in metres. */
export function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371_000, toR = Math.PI / 180;
  const dLat = (lat2 - lat1) * toR, dLng = (lng2 - lng1) * toR;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toR) * Math.cos(lat2 * toR) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

export const validLatLng = (lat: unknown, lng: unknown) =>
  typeof lat === "number" && typeof lng === "number" && Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;

export async function notifyAuthorities(store: Store, roles: Roles, title: string, body: string, level: "info" | "warning" | "critical", link?: string) {
  for (const id of await roles.authorityIds()) await notify(store, id, title, body, level, link);
}

// ---------------------------------------------------------------------------- confidence

/** Which offer types can serve which request type (used to rank suggested matches). */
export const SERVES: Record<RequestType, OfferType[]> = {
  rescue: ["boat", "vehicle", "labour"], medical: ["medical", "vehicle"], food_water: ["food", "water"], shelter: ["shelter"],
  road_blocked: ["labour", "vehicle"], power: ["labour"], drain_or_sewer: ["labour"], waterlogging: ["labour", "boat"], other: [...OFFER_TYPES],
};

export interface Confidence { score: number; factors: { corroboration: number; hazard: number | null; reporter: number } }

/**
 * How much independent support a request has, 0..1. Used only to sort; low confidence never hides a request.
 *  - corroboration (weight 0.4): other people's open requests within 500 m and 24 h (3 or more = full)
 *  - hazard agreement (0.3): the combined hazard score of the cell, when a hazard layer has been loaded
 *  - reporter history (0.3): (resolved or verified + 1) / (those + cancelled or flagged-accidental + 2)
 * A missing hazard layer drops its weight; the rest is rescaled.
 */
export function confidenceOf(r: HelpRequest, all: HelpRequest[], hazardAt: (lat: number, lng: number) => number | null): Confidence {
  let near = 0;
  const t = Date.parse(r.createdAt);
  if (r.lat != null && r.lng != null) {
    const seen = new Set<string>();
    for (const o of all) {
      if (o.id === r.id || o.ownerId === r.ownerId || o.status === "cancelled" || o.lat == null || o.lng == null) continue;
      if (Math.abs(Date.parse(o.createdAt) - t) > 24 * 3600_000 || seen.has(o.ownerId)) continue;
      if (haversineM(r.lat, r.lng, o.lat, o.lng) <= 500) { seen.add(o.ownerId); near++; }
    }
  }
  const corroboration = Math.min(near, 3) / 3;
  const hazard = r.lat != null && r.lng != null ? hazardAt(r.lat, r.lng) : null;
  const mine = all.filter((o) => o.ownerId === r.ownerId && o.id !== r.id);
  const good = mine.filter((o) => o.status === "resolved" || o.status === "verified").length;
  const bad = mine.filter((o) => o.status === "cancelled" || o.flags.includes("possible_accidental")).length;
  const reporter = (good + 1) / (good + bad + 2);
  const parts: [number, number][] = [[corroboration, 0.4], [reporter, 0.3]];
  if (hazard != null) parts.push([Math.max(0, Math.min(1, hazard)), 0.3]);
  const w = parts.reduce((s, [, x]) => s + x, 0);
  const score = parts.reduce((s, [v, x]) => s + v * x, 0) / w;
  return { score: Math.round(score * 100) / 100, factors: { corroboration: Math.round(corroboration * 100) / 100, hazard, reporter: Math.round(reporter * 100) / 100 } };
}

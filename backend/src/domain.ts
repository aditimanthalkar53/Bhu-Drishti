import type { StoredRecord } from "./store/types.js";

/** A saved area: an Indian district from the engine catalogue, or a drawn/uploaded polygon. */
export interface AOI extends StoredRecord {
  name: string;
  regionId: string;          // engine region id (district id or "aoi-…")
  kind: "district" | "custom" | "demo";
  state?: string;
  description?: string;
  areaKm2?: number | null;
}

export type Schedule =
  | { type: "interval"; hours: number }
  | { type: "daily"; time: string }     // "HH:MM" in Asia/Kolkata
  | { type: "new_pass" }                // run when a new Sentinel-1 pass appears over the area
  | { type: "manual" };

export interface Threshold {
  metric: "value" | "lo" | "hi";          // lo = lower confidence bound (conservative trigger)
  op: ">" | ">=" | "<" | "<=";
  value: number;
}

/** When an alert is not confirmed, or is severe, it moves up the recipients' reports-to chain. */
export interface Escalation {
  enabled: boolean;
  ackMinutes: number;               // unconfirmed this long: tell the next level up
  severeValue?: number | null;      // at or above this, also tell one level up straight away
  criticalValue?: number | null;    // at or above this, tell two levels up straight away
}

export interface Monitor extends StoredRecord {
  name: string;
  aoiId: string;
  regionId: string;
  question: string;           // natural language, compiled by the engine on every run
  schedule: Schedule;
  threshold?: Threshold | null;
  recipientIds: string[];
  groupIds: string[];
  escalation?: Escalation | null;
  autoReport: boolean;        // make a report after every run (else only when the threshold fires)
  requireApproval: boolean;   // reports wait for a human before anything is sent
  enabled: boolean;
  lastRunAt?: string | null;
  lastQueryId?: string | null;
  lastValue?: number | null;
  lastStatus?: string | null;
  lastError?: string | null;
  lastPass?: string | null;   // newest Sentinel-1 acquisition seen (for new_pass schedules)
  nextRunAt?: string | null;
}

export interface Alert extends StoredRecord {
  monitorId: string;
  queryId: string;
  regionId: string;
  title: string;
  message: string;
  value: number | null;
  threshold: Threshold;
  status: "open" | "acknowledged" | "resolved";
  assignee?: string | null;
  history: { at: string; by: string; action: string; note?: string }[];
  drill?: boolean;                       // a rehearsal: no satellite analysis was run
  escalation?: Escalation | null;        // the rule in force when the alert opened
  lastEscalatedAt?: string | null;
  notified: { at: string; recipientId: string; name: string; designation: string; level: number; email: string; channel: "email"; status: "sent" | "failed"; error?: string; reason: string }[];
  confirmedBy?: { recipientId: string; name: string; at: string }[];
}

export type ReportStatus = "draft" | "pending_approval" | "approved" | "sending" | "sent" | "partially_sent" | "failed";

export interface Report extends StoredRecord {
  title: string;
  queryIds: string[];
  regionId?: string | null;
  monitorId?: string | null;
  status: ReportStatus;
  origin: "user" | "monitor" | "schedule";
  summary: string;
  recipientIds: string[];
  groupIds: string[];
  approvedBy?: string | null;
  approvedAt?: string | null;
  sentAt?: string | null;
  note?: string;
}

export interface Recipient extends StoredRecord {
  name: string;
  designation: string;        // e.g. "District Magistrate", "DDMA Project Officer"
  department: string;         // e.g. "DDMA", "Agriculture", "SDMA", "Revenue"
  state?: string;
  district?: string;
  level?: number;             // 1 block/field, 2 district, 3 state, 4 national
  reportsToId?: string | null;// who they report to: alerts move up this chain
  regionIds: string[];        // areas this person covers (for ?area= lookups)
  email: string;
  phone?: string;
  channels: ("email" | "whatsapp" | "sms")[];
  groupIds: string[];
  active: boolean;
}

export interface Group extends StoredRecord {
  name: string;
  description?: string;
}

export interface Delivery extends StoredRecord {
  reportId: string;
  recipientId?: string | null;
  channel: "email" | "whatsapp" | "sms";
  to: string;
  status: "queued" | "sent" | "failed" | "opened";
  via: "smtp" | "n8n";
  error?: string | null;
  providerMessageId?: string | null;
}

export type WebhookEvent = "report.ready" | "report.approved" | "report.sent" | "alert.triggered" | "monitor.failed";
export const WEBHOOK_EVENTS: WebhookEvent[] = ["report.ready", "report.approved", "report.sent", "alert.triggered", "monitor.failed"];

export interface Webhook extends StoredRecord {
  url: string;
  events: WebhookEvent[];
  secret: string;             // HMAC-SHA256 signing secret (shown once)
  active: boolean;
  description?: string;
  lastStatus?: number | null;
  lastError?: string | null;
  lastDeliveredAt?: string | null;
}

export interface Notification extends StoredRecord {
  title: string;
  body: string;
  link?: string;
  level: "info" | "warning" | "critical";
  read: boolean;
}

export interface AuditEntry extends StoredRecord {
  actor: string;              // user id or "system"
  actorName?: string;
  action: string;             // e.g. "report.approve"
  target: string;             // e.g. "report:abc"
  detail?: Record<string, unknown>;
}

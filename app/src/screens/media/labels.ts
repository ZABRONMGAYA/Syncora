// Device letters, card metadata and status words shared by the media and sync screens.
import type { Device, MediaRow, Session, SyncSummary } from "../../api/contract";
import type { SyncStatus } from "../../design-system/components";
import { rateLabel } from "../../lib/format";

/** Cameras get letters A, B, C… (then AA, AB…); sound recorders R1, R2…; in device order. */
export function deviceLetters(devices: Device[]): Map<number, { letter: string; audio: boolean }> {
  const out = new Map<number, { letter: string; audio: boolean }>();
  let cam = 0;
  let rec = 0;
  for (const d of devices) {
    if (d.kind === "recorder") {
      rec += 1;
      out.set(d.id, { letter: `R${rec}`, audio: true });
    } else {
      out.set(d.id, { letter: columnName(cam), audio: false });
      cam += 1;
    }
  }
  return out;
}

function columnName(n: number): string {
  let s = "";
  let k = n + 1;
  while (k > 0) {
    const r = (k - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    k = Math.floor((k - 1) / 26);
  }
  return s;
}

export function resolutionLabel(row: Pick<MediaRow, "width" | "height">): string | null {
  if (!row.width || !row.height) return null;
  if (row.width >= 3800) return "4K";
  if (row.width >= 2500) return "2.7K";
  if (row.height >= 1080) return "HD";
  if (row.height >= 720) return "720p";
  return `${row.width}×${row.height}`;
}

export function cardMeta(row: MediaRow, sessions: Map<number, Session>): string {
  const parts: string[] = [];
  if (row.kind === "video") {
    const res = resolutionLabel(row);
    if (res) parts.push(res);
    if (row.fps) parts.push(`${rateLabel(row.fps)}p`);
  } else if (row.sample_rate) {
    parts.push(`${Math.round(row.sample_rate / 100) / 10} kHz`);
  }
  parts.push(row.channels ? `${row.channels}ch` : "no audio");
  const session = row.session_id !== null ? sessions.get(row.session_id) : undefined;
  if (session) parts.push(session.label);
  return parts.join(" · ");
}

/** The categories the app shows as synced; every other placed, unplaced or unreadable clip is not synced. */
export const SYNCED_CATEGORIES: ReadonlySet<MediaRow["category"]> = new Set([
  "synchronized",
  "confirmed",
  "high_confidence",
]);
const NOT_SYNCED_CATEGORIES: ReadonlySet<MediaRow["category"]> = new Set(["review", "manual", "failed"]);

export function isSynced(row: Pick<MediaRow, "category">): boolean {
  return SYNCED_CATEGORIES.has(row.category);
}

export function isNotSynced(row: Pick<MediaRow, "category">): boolean {
  return NOT_SYNCED_CATEGORIES.has(row.category);
}

/**
 * Clips that are not synced, as the media browser lists them: placed without certainty, not placed, or failed
 * after import. Files that could not be read at all never became clips (the import lists them) and do not count.
 */
export function notSyncedTotal(summary: Pick<SyncSummary, "counts" | "unreadable_files"> | null | undefined): number {
  if (!summary) return 0;
  const c = summary.counts;
  return (c.review ?? 0) + (c.manual ?? 0) + Math.max(0, (c.failed ?? 0) - (summary.unreadable_files ?? 0));
}

/** Clip → badge status: synced or not synced (until the first sync: analysing, or not synced yet). */
export function rowStatus(row: MediaRow): SyncStatus {
  if (isSynced(row)) return "synced";
  if (isNotSynced(row)) return "unsynced";
  if (row.category === "skipped") return "skipped";
  return row.analysis === "running" || row.probe === "running" ? "running" : "none";
}

export function squareFor(row: MediaRow): "ok" | "review" | "failed" | "none" {
  return isSynced(row) ? "ok" : isNotSynced(row) ? "failed" : "none";
}

export const CATEGORY_LABEL: Record<MediaRow["category"], string> = {
  synchronized: "Synced",
  confirmed: "Synced",
  high_confidence: "Synced",
  review: "Not synced",
  manual: "Not synced",
  failed: "Not synced",
  skipped: "Skipped",
  pending: "Not synced yet",
};

export function formatBytes(bytes: number): string {
  if (bytes >= 2 ** 40) return `${(bytes / 2 ** 40).toFixed(2)} TB`;
  if (bytes >= 2 ** 30) return `${(bytes / 2 ** 30).toFixed(1)} GB`;
  if (bytes >= 2 ** 20) return `${(bytes / 2 ** 20).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

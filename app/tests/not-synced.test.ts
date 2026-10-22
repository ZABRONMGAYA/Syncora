import { afterEach, describe, expect, it } from "vitest";

import type { MediaRow, SyncSummary } from "../src/api/contract";
import { loadSettings } from "../src/features/export/ExportDialog";
import { matchesStatus } from "../src/lib/query";
import { notSyncedTotal, rowStatus } from "../src/screens/media/labels";

const row = (category: MediaRow["category"]): MediaRow => ({ category, analysis: "done", probe: "done" }) as MediaRow;

describe("synced or not synced", () => {
  it("shows every clip as one or the other", () => {
    for (const c of ["synchronized", "confirmed", "high_confidence"] as const) expect(rowStatus(row(c))).toBe("synced");
    for (const c of ["review", "manual", "failed"] as const) expect(rowStatus(row(c))).toBe("unsynced");
    expect(rowStatus(row("pending"))).toBe("none"); // before the first sync
    expect(rowStatus(row("skipped"))).toBe("skipped"); // an ignored copy of another file
  });

  it("finds the clips that are not synced, whatever placed them", () => {
    for (const c of ["review", "manual", "failed", "pending"] as const)
      expect(matchesStatus(row(c), "unsynchronized")).toBe(true);
    expect(matchesStatus(row("synchronized"), "unsynchronized")).toBe(false);
  });
});

describe("export choice for clips that are not synced", () => {
  afterEach(() => localStorage.clear());

  it("puts them at the end of the timeline by default", () => {
    expect(loadSettings().notSynced).toBe("end");
  });

  it("keeps the earlier 'leave out clips that need review' choice", () => {
    localStorage.setItem("mcsync.exportOptions", JSON.stringify({ includeUncertain: false, rate: "25" }));
    const settings = loadSettings();
    expect(settings).toMatchObject({ notSynced: "omit", rate: "25" });
    expect(settings).not.toHaveProperty("includeUncertain");
  });
});

describe("counting clips that are not synced", () => {
  it("matches what the media browser lists: files that could never be read are not clips", () => {
    const counts = { review: 3, manual: 20, failed: 7 } as SyncSummary["counts"];
    expect(notSyncedTotal({ counts, unreadable_files: 5 })).toBe(25);
    expect(notSyncedTotal(null)).toBe(0);
  });
});

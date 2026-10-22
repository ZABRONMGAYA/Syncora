// New versions: checked once when Syncora opens (unless turned off in Settings → Updates) and on demand.
import { create } from "zustand";

import { bridge } from "../api/client";
import type { UpdateInfo } from "../lib/updates";

export const AUTO_CHECK_KEY = "syncora.updates.auto";
export const SKIPPED_KEY = "syncora.updates.skipped";

export function autoCheckEnabled(): boolean {
  try {
    return localStorage.getItem(AUTO_CHECK_KEY) !== "off";
  } catch {
    return true;
  }
}

export function setAutoCheck(on: boolean): void {
  try {
    localStorage.setItem(AUTO_CHECK_KEY, on ? "on" : "off");
  } catch {
    // the choice stays for this session only
  }
}

function skippedVersion(): string | null {
  try {
    return localStorage.getItem(SKIPPED_KEY);
  } catch {
    return null;
  }
}

interface UpdatesState {
  checking: boolean;
  info: UpdateInfo | null;
  error: string | null;
  checkedAt: number | null;
  /** The launch notice is showing. */
  notice: boolean;
  /** `launch`: the automatic check, which stays silent unless there is a version the user has not skipped. */
  check(options?: { launch?: boolean }): Promise<void>;
  /** Open the release page of the latest version. */
  download(): void;
  dismiss(): void;
  /** Hide the notice for this version until a newer one comes out. */
  skip(): void;
}

export const useUpdates = create<UpdatesState>((set, get) => ({
  checking: false,
  info: null,
  error: null,
  checkedAt: null,
  notice: false,
  async check(options) {
    if (get().checking) return;
    set({ checking: true, error: null });
    try {
      const result = await bridge().checkForUpdate();
      if (!result.ok) {
        set({ checking: false, error: result.error, checkedAt: Date.now() });
        return;
      }
      const info = result.info;
      const show = info.available && (!options?.launch || skippedVersion() !== info.latest);
      set({ checking: false, info, checkedAt: Date.now(), notice: show });
    } catch (err) {
      set({ checking: false, error: err instanceof Error ? err.message : String(err), checkedAt: Date.now() });
    }
  },
  download() {
    const info = get().info;
    if (info) void bridge().openRelease(info.pageUrl);
  },
  dismiss() {
    set({ notice: false });
  },
  skip() {
    const info = get().info;
    try {
      if (info) localStorage.setItem(SKIPPED_KEY, info.latest);
    } catch {
      // hidden for this session only
    }
    set({ notice: false });
  },
}));

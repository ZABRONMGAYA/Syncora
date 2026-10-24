// AI edit: a first cut of the synchronised timeline (engine: edit.first_cut), planned, reviewed, then exported as XML.
import { create } from "zustand";

import { EngineError, ErrorCode, bridge, call } from "../api/client";
import type { ExportFormat, FirstCutOptions, FirstCutPlan, FirstCutStyle } from "../api/contract";
import { loadSettings as loadExportDefaults } from "../features/export/ExportDialog";
import { useActivation } from "./activation";
import { useApp } from "./store";

const SETTINGS_KEY = "syncora.firstCut";

export interface FirstCutSettings {
  style: FirstCutStyle;
  /** Shot lengths in seconds; null: the style's own. */
  minShot: number | null;
  maxShot: number | null;
  tightenPauses: boolean;
  useReviewClips: boolean;
  format: ExportFormat;
}

/** The style's own lengths, as engine/src/mcsync/edit/firstcut.py defines them. */
export const STYLE_DEFAULTS: Record<FirstCutStyle, { minShot: number; maxShot: number }> = {
  wedding: { minShot: 3, maxShot: 12 },
  podcast: { minShot: 2, maxShot: 15 },
};

const DEFAULTS: FirstCutSettings = {
  style: "wedding",
  minShot: null,
  maxShot: null,
  tightenPauses: true,
  useReviewClips: false,
  format: "xmeml",
};

function loadSettings(): FirstCutSettings {
  try {
    return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}") as Partial<FirstCutSettings>) };
  } catch {
    return DEFAULTS;
  }
}

function saveSettings(settings: FirstCutSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // a convenience only
  }
}

/** A request the engine (or the main process) refused; without a running plan the dialog asks for a code from now on. */
function failed(err: unknown): void {
  useEdit.setState({ error: err instanceof Error ? err.message : String(err) });
  if (err instanceof EngineError && err.code === ErrorCode.activationRequired) void useActivation.getState().load();
}

export function cutOptions(settings: FirstCutSettings, speakerAngles: Record<string, string>): FirstCutOptions {
  const options: FirstCutOptions = {
    tighten_pauses: settings.tightenPauses,
    use_review_clips: settings.useReviewClips,
  };
  if (settings.minShot !== null) options.min_shot_s = settings.minShot;
  if (settings.maxShot !== null) options.max_shot_s = settings.maxShot;
  if (settings.style === "podcast" && Object.keys(speakerAngles).length) options.speaker_angles = speakerAngles;
  return options;
}

interface EditState {
  open: boolean;
  settings: FirstCutSettings;
  /** Speaker key → camera chosen by the user (podcast). */
  speakerAngles: Record<string, string>;
  jobId: string | null;
  purpose: "plan" | "export" | null;
  plan: FirstCutPlan | null;
  error: string | null;
  openDialog(): void;
  close(): void;
  update(changes: Partial<FirstCutSettings>): void;
  setSpeakerAngle(key: string, device: string | null): void;
  makePlan(): Promise<void>;
  exportCut(): Promise<void>;
  cancel(): Promise<void>;
  onJobDone(jobId: string, result: unknown): void;
  onJobFailed(jobId: string, error: string, cancelled: boolean): void;
}

export const useEdit = create<EditState>((set, get) => ({
  open: false,
  settings: loadSettings(),
  speakerAngles: {},
  jobId: null,
  purpose: null,
  plan: null,
  error: null,
  openDialog() {
    if (!useApp.getState().project) return;
    set({ open: true, error: null });
  },
  close() {
    set({ open: false });
  },
  update(changes) {
    const settings = { ...get().settings, ...changes };
    saveSettings(settings);
    // A different style or option makes the plan on screen stale.
    set({ settings, plan: changes.format !== undefined && Object.keys(changes).length === 1 ? get().plan : null });
  },
  setSpeakerAngle(key, device) {
    const speakerAngles = { ...get().speakerAngles };
    if (device) speakerAngles[key] = device;
    else delete speakerAngles[key];
    set({ speakerAngles });
    void get().makePlan();
  },
  async makePlan() {
    if (get().jobId) return;
    const { settings, speakerAngles } = get();
    set({ error: null });
    try {
      const { job_id } = await call("edit.first_cut", {
        style: settings.style,
        group: useApp.getState().group,
        options: cutOptions(settings, speakerAngles),
      });
      set({ jobId: job_id, purpose: "plan" });
    } catch (err) {
      failed(err);
    }
  },
  async exportCut() {
    if (get().jobId) return;
    const { settings, speakerAngles } = get();
    const project = useApp.getState().project;
    const path = await bridge().chooseExportPath(`${project?.name ?? "Syncora"} first cut`, settings.format);
    if (!path) return;
    set({ error: null });
    try {
      const { job_id } = await call("edit.first_cut", {
        style: settings.style,
        group: useApp.getState().group,
        options: cutOptions(settings, speakerAngles),
        format: settings.format,
        path,
        bins: loadExportDefaults().folderBins,
      });
      set({ jobId: job_id, purpose: "export" });
    } catch (err) {
      failed(err);
    }
  },
  async cancel() {
    const id = get().jobId;
    if (id) await call("job.cancel", { job_id: id }).catch(() => undefined);
  },
  onJobDone(jobId, result) {
    if (jobId !== get().jobId) return;
    const plan = result as FirstCutPlan;
    set({ jobId: null, purpose: null, plan });
    if (plan.export) {
      const name = plan.export.path.split(/[\\/]/).pop();
      useApp.getState().toast("success", `First cut written to ${name}: import it into your editing software.`);
    }
  },
  onJobFailed(jobId, error, cancelled) {
    if (jobId !== get().jobId) return;
    set({ jobId: null, purpose: null, error: cancelled ? null : error });
  },
}));

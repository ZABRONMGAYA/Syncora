// SH-2 status bar: engine and media state on the left, project facts on the right, preceded there by the activation
// item while Syncora is not activated, its plan ends within 7 days, or it has ended (it opens the Activate dialog).
import { CircleX, KeyRound, TriangleAlert } from "lucide-react";

import { statusLine } from "../lib/activation";
import { notSyncedTotal } from "../screens/media/labels";
import { useActivation } from "../state/activation";
import { useApp } from "../state/store";
import { useProd } from "../state/production";

const ACTIVATION_ICONS = { info: KeyRound, warn: TriangleAlert, error: CircleX };

export function StatusBar() {
  const engine = useApp((s) => s.engine);
  const project = useApp((s) => s.project);
  const offline = useProd((s) => s.offline?.volumes.reduce((n, v) => n + (v.ignored ? 0 : v.count), 0) ?? 0);
  const pipeline = useProd((s) => s.pipeline);
  const notSynced = useProd((s) => notSyncedTotal(s.summary));
  const selection = useProd((s) => s.selection.size);
  // The live media index: it counts clips while an import is still running.
  const clips = useProd((s) => (s.indexVersion >= 0 ? s.rows.length : null));

  const ok = engine.state === "ready";
  // The engine reports FFmpeg's banner ("ffmpeg version n8.1.3 Copyright …"); show the version only.
  const ffmpeg = engine.hello?.ffmpeg?.match(/ffmpeg version (\S+)/)?.[1] ?? engine.hello?.ffmpeg;
  let left: string;
  if (engine.state === "starting") left = "Starting engine…";
  else if (!ok) left = `Engine ${engine.state}${engine.error ? `: ${engine.error}` : ""}`;
  else if (!ffmpeg) left = "FFmpeg not found";
  else if (offline > 0) left = `${offline} clip${offline === 1 ? "" : "s"} offline`;
  else left = project ? "All media online" : "Ready";
  const tone = !ok || !ffmpeg ? "error" : offline > 0 ? "warn" : "ok";

  const running = pipeline?.running.length ?? 0;
  // Background jobs outside the pipeline (AI sync, model downloads): the latest one's progress.
  const job = useApp((s) => Object.values(s.jobs).find((j) => j.status === "running" && j.kind !== "sync"));
  const activation = useActivation((s) => s.status);
  const plan = activation ? statusLine(activation) : null;
  const PlanIcon = plan ? ACTIVATION_ICONS[plan.tone] : null;
  return (
    <footer className="sy-statusbar" data-testid="statusbar">
      <span className="sy-statusbar__item">
        <span className={`sy-dot sy-dot--${tone}`} aria-hidden />
        {left}
      </span>
      {pipeline && pipeline.state !== "idle" && (
        <span className="sy-statusbar__item">
          {pipeline.state === "paused" ? "Processing paused" : `Processing in background · ${running} running`}
        </span>
      )}
      {job && (
        <span className="sy-statusbar__item" data-testid="statusbar-job">
          {job.message || "Working…"} · {Math.round(job.progress * 100)}%
        </span>
      )}
      {notSynced > 0 && (
        <span className="sy-statusbar__item sy-statusbar__item--error" data-testid="statusbar-not-synced">
          {notSynced.toLocaleString()} not synced
        </span>
      )}
      {selection > 0 && <span className="sy-statusbar__item">{selection} selected</span>}
      <span className="sy-statusbar__right">
        {plan && PlanIcon && (
          <button
            type="button"
            className={`sy-statusbar__item sy-statusbar__activation sy-statusbar__item--${plan.tone}`}
            onClick={() => useActivation.getState().openDialog()}
            data-testid="statusbar-activation"
          >
            <PlanIcon size={12} aria-hidden />
            {plan.text}
            <span className="sy-statusbar__action">{plan.action}</span>
          </button>
        )}
        {project && (
          <span className="sy-statusbar__item" data-testid="statusbar-clips">
            {(clips ?? project.clips).toLocaleString()} clips
          </span>
        )}
        {ffmpeg && <span className="sy-statusbar__item">FFmpeg {ffmpeg}</span>}
        {engine.hello && <span className="sy-statusbar__item">Engine {engine.hello.version}</span>}
      </span>
    </footer>
  );
}

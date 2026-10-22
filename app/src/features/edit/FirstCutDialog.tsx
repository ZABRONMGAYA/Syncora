// AI edit: Syncora cuts a first version of the synchronised timeline (a wedding's long version, a podcast) from the
// cameras' positions, the transcripts and the sound, on this computer; the editor reviews it and exports it as XML.
import { Clapperboard } from "lucide-react";
import { useEffect } from "react";

import { bridge } from "../../api/client";
import type { ExportFormat, FirstCutPlan, FirstCutStyle } from "../../api/contract";
import { formatDuration, formatTime } from "../../lib/format";
import { STYLE_DEFAULTS, useEdit } from "../../state/edit";
import { useApp } from "../../state/store";

const STYLES: { value: FirstCutStyle; title: string; detail: string }[] = [
  {
    value: "wedding",
    title: "Wedding: long version",
    detail:
      "Every moment the cameras saw, in order, without the waiting in between. The main camera holds vows and speeches; other angles come in for variety, cutting on pauses.",
  },
  {
    value: "podcast",
    title: "Podcast or interview",
    detail:
      "From the first words to the last, long pauses tightened. Each speaker on their camera, the wide shot for cross-talk and long answers.",
  },
];

const FORMATS: { value: ExportFormat; label: string }[] = [
  { value: "xmeml", label: "Premiere Pro or DaVinci Resolve (.xml)" },
  { value: "fcpxml", label: "DaVinci Resolve or Final Cut Pro (.fcpxml)" },
];

function seconds(value: string): number | null {
  const n = Number(value);
  return value.trim() === "" || !Number.isFinite(n) ? null : n;
}

function Summary({ plan }: { plan: FirstCutPlan }) {
  const { setSpeakerAngle, speakerAngles, jobId } = useEdit();
  const total = Math.max(
    1,
    plan.cameras.reduce((sum, c) => sum + c.seconds, 0),
  );
  const names = Object.fromEntries(plan.cameras.map((c) => [c.device, c.name]));
  const removed = Math.max(0, plan.source_duration_s - plan.duration_s);
  return (
    <div className="first-cut__plan" data-testid="first-cut-plan">
      <p className="lead">
        A first cut of <strong>{formatDuration(plan.duration_s)}</strong> in {plan.shots.length} shots
        {removed >= 1 ? `, ${formatDuration(removed)} of waiting left out` : ""}.
      </p>
      <h3>Cameras</h3>
      <ul className="plain first-cut__cameras">
        {plan.cameras.map((c) => (
          <li key={c.device}>
            <span className="first-cut__camera-name">
              {c.name}
              {c.main ? <span className="badge">{plan.style === "podcast" ? "wide" : "main"}</span> : null}
            </span>
            <span className="first-cut__bar" aria-hidden>
              <span style={{ width: `${(100 * c.seconds) / total}%` }} />
            </span>
            <span className="muted">{formatDuration(c.seconds)}</span>
          </li>
        ))}
      </ul>
      {plan.style === "podcast" && plan.speakers.length > 0 && (
        <>
          <h3>Speakers</h3>
          <ul className="plain first-cut__speakers">
            {plan.speakers.map((s) => (
              <li key={s.key}>
                <span>{s.name ?? s.key}</span>
                <select
                  value={speakerAngles[s.key] ?? ""}
                  disabled={jobId !== null}
                  onChange={(e) => setSpeakerAngle(s.key, e.target.value || null)}
                  aria-label={`Camera for ${s.name ?? s.key}`}
                >
                  <option value="">
                    {s.device
                      ? `${names[s.device] ?? s.device} (${s.guessed ? "guessed" : "chosen"})`
                      : "Wide (no close-up)"}
                  </option>
                  {plan.cameras.map((c) => (
                    <option key={c.device} value={c.device}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </li>
            ))}
          </ul>
        </>
      )}
      {plan.chapters.length > 0 && (
        <>
          <h3>Markers</h3>
          <ul className="plain first-cut__chapters">
            {plan.chapters.slice(0, 12).map((c) => (
              <li key={`${c.t_s}-${c.label}`}>
                <span className="sy-mono muted">{formatTime(c.t_s, 0)}</span> {c.label}
              </li>
            ))}
            {plan.chapters.length > 12 && <li className="muted">and {plan.chapters.length - 12} more</li>}
          </ul>
        </>
      )}
      {plan.warnings.length > 0 && (
        <>
          <h3>Good to know</h3>
          <ul className="plain warnings">
            {plan.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

export function FirstCutDialog() {
  const { open, close, settings, update, plan, error, jobId, purpose, makePlan, exportCut, cancel } = useEdit();
  const job = useApp((s) => (jobId ? s.jobs[jobId] : undefined));
  const timeline = useApp((s) => s.timeline);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  if (!open) return null;
  const busy = jobId !== null;
  const synced = (timeline?.groups.length ?? 0) > 0;
  const defaults = STYLE_DEFAULTS[settings.style];
  const lastExport = plan?.export;

  return (
    <div className="modal-backdrop" onMouseDown={close}>
      <div
        className="modal first-cut"
        role="dialog"
        aria-modal="true"
        aria-labelledby="first-cut-title"
        onMouseDown={(e) => e.stopPropagation()}
        data-testid="first-cut-dialog"
      >
        <h2 id="first-cut-title">
          <Clapperboard size={16} aria-hidden /> AI first cut
        </h2>
        <p className="muted small">
          Syncora edits a first version from the synchronised cameras, the transcripts and the sound, on this computer.
          You refine it in your editing software.
        </p>
        {!synced && <p className="notice">Synchronise the footage first: the cut is made from the synced timeline.</p>}

        <fieldset className="formats" disabled={busy}>
          <legend>Style</legend>
          {STYLES.map((s) => (
            <label key={s.value} className={`format ${settings.style === s.value ? "chosen" : ""}`}>
              <input
                type="radio"
                name="first-cut-style"
                value={s.value}
                checked={settings.style === s.value}
                onChange={() => update({ style: s.value, minShot: null, maxShot: null })}
                data-testid={`first-cut-style-${s.value}`}
              />
              <span>
                <strong>{s.title}</strong>
                <span className="muted">{s.detail}</span>
              </span>
            </label>
          ))}
        </fieldset>

        <div className="fields">
          <label>
            Shortest shot (s)
            <input
              type="number"
              min={0.5}
              step={0.5}
              size={5}
              placeholder={String(defaults.minShot)}
              value={settings.minShot ?? ""}
              onChange={(e) => update({ minShot: seconds(e.target.value) })}
              disabled={busy}
            />
          </label>
          <label>
            Longest shot (s)
            <input
              type="number"
              min={1}
              step={1}
              size={5}
              placeholder={String(defaults.maxShot)}
              value={settings.maxShot ?? ""}
              onChange={(e) => update({ maxShot: seconds(e.target.value) })}
              disabled={busy}
            />
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={settings.tightenPauses}
              onChange={(e) => update({ tightenPauses: e.target.checked })}
              disabled={busy}
            />
            Leave out long pauses
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={settings.useReviewClips}
              onChange={(e) => update({ useReviewClips: e.target.checked })}
              disabled={busy}
            />
            Use clips that need review
          </label>
        </div>

        {busy && (
          <div className="first-cut__progress" role="status">
            <progress value={job?.progress ?? 0} max={1} />
            <span className="muted">{job?.message || (purpose === "export" ? "Writing the cut…" : "Cutting…")}</span>
            <button type="button" className="small" onClick={() => void cancel()}>
              Stop
            </button>
          </div>
        )}
        {error && <p className="notice error">{error}</p>}
        {plan && !busy && <Summary plan={plan} />}

        <div className="modal-actions first-cut__actions">
          {plan && !busy && (
            <label>
              For
              <select
                value={settings.format}
                onChange={(e) => update({ format: e.target.value as ExportFormat })}
                data-testid="first-cut-format"
              >
                {FORMATS.map((f) => (
                  <option key={f.value} value={f.value}>
                    {f.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          {lastExport && !busy && (
            <button type="button" onClick={() => void bridge().showInFolder(lastExport.path)}>
              Show in folder
            </button>
          )}
          <button type="button" onClick={close}>
            Close
          </button>
          {plan ? (
            <>
              <button type="button" onClick={() => void makePlan()} disabled={busy || !synced}>
                Cut again
              </button>
              <button
                type="button"
                className="primary"
                onClick={() => void exportCut()}
                disabled={busy || !synced}
                data-testid="first-cut-export"
              >
                Export first cut…
              </button>
            </>
          ) : (
            <button
              type="button"
              className="primary"
              onClick={() => void makePlan()}
              disabled={busy || !synced}
              data-testid="first-cut-make"
            >
              Create first cut
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

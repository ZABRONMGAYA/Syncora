"""The AI edit's engine methods (``edit.*``): a first cut of a synchronised group, as a job (mcsync.edit)."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

import numpy as np

from mcsync.edit import Angle, CutOptions, FirstCut, Sound, Utterance, build_cut_sequence, plan_first_cut
from mcsync.edit.firstcut import RATE
from mcsync.edit.loudness import loudness
from mcsync.export import FORMATS, ExportOptions, export_sequence
from mcsync.project.db import ClipRow
from mcsync.timecode import parse_frame_rate
from mcsync.timeline import build_timeline

from .jobs import Job
from .rpc import APP_ERROR, RpcError

if TYPE_CHECKING:
    from mcsync.project.db import Project
    from mcsync.sync.types import ClipInput

    from .jobs import JobManager

#: Loudness curves kept in memory between plans (each is 10 values a second: a 3-hour recording is 430 kB).
LOUDNESS_MEMO = 20_000
_OPTION_KEYS = {"min_shot_s", "max_shot_s", "max_pause_s", "tighten_pauses", "speaker_angles", "use_review_clips"}


def cut_options(style: str, options: dict | None) -> CutOptions:
    options = dict(options or {})
    unknown = set(options) - _OPTION_KEYS
    if unknown:
        raise ValueError(f"unknown first cut options: {', '.join(sorted(unknown))}")
    if "speaker_angles" in options:
        options["speaker_angles"] = {str(k): str(v) for k, v in (options["speaker_angles"] or {}).items() if v}
    cut = CutOptions(style=style, **options)
    cut.resolved()  # validates the style and lengths
    return cut


class EditMethods:
    """Mixed into :class:`~mcsync.service.app.EngineService`."""

    if TYPE_CHECKING:
        jobs: JobManager

        def _require_project(self) -> Project: ...  # pragma: no cover
        def _require_idle(self, kinds: set[str]) -> None: ...  # pragma: no cover
        def _settings(self) -> dict: ...  # pragma: no cover
        def _clip_inputs(self, rows: list[ClipRow], job: Any = None, *, extract: bool = True,
                         remember: bool = True) -> list[ClipInput]: ...  # pragma: no cover  # fmt: skip

    _loudness_memo: dict[tuple, np.ndarray]

    def edit_first_cut(
        self,
        style: str = "wedding",
        group: int = 0,
        options: dict | None = None,
        format: str | None = None,
        path: str | None = None,
        name: str | None = None,
        bins: bool = True,
        start_timecode: str = "01:00:00:00",
        sequence_rate: str | None = None,
    ) -> dict:
        """Plan a first cut of sync group ``group`` and, with ``path``, write it as ``format`` XML. A job: its result
        is the plan (shots, sound, chapters, speakers, warnings) and, when written, the export report."""
        self._require_idle({"sync"})
        project = self._require_project()
        opts = cut_options(style, options)
        if path is not None and format not in FORMATS:
            raise RpcError(APP_ERROR, f"unknown export format {format!r}; choose one of {', '.join(FORMATS)}")
        export = ExportOptions(
            name=name or f"{project.name} – first cut",
            sequence_rate=parse_frame_rate(sequence_rate) if sequence_rate else None,
            start_timecode=start_timecode,
            bins=bins,
            roots=tuple(r["path"] for r in project.import_roots()),
        )

        def work(job: Job) -> dict:
            cut, rows, starts, names, cameras = self._plan_cut(project, group, opts, job)
            result = cut_summary(cut, rows, names, cameras)
            if path is not None:
                job.report(0.95, "Writing the first cut")
                result["export"] = export_sequence(build_cut_sequence(cut, rows, starts, export), format or "", path)
            return result

        return {"job_id": self.jobs.start("first-cut", work).id}

    def _plan_cut(
        self, project: Project, group: int, opts: CutOptions, job: Job
    ) -> tuple[FirstCut, dict[int, ClipRow], dict[int, float], dict[str, str | None], dict[str, str]]:
        job.report(0.01, "Reading the synchronised timeline")
        rows = project.clips()
        by_id = {r.id: r for r in rows}
        timeline = build_timeline(rows, project.placements(), self._settings().get("reference_clip_id"))
        g = next((x for x in timeline.groups if x.group == group), None)
        if g is None:
            raise ValueError("synchronise first: there is no timeline to cut")
        placed = [c for c in g.clips if c.start_s is not None and c.media_status == "online" and c.clip_id in by_id]
        inputs = {int(c.clip_id): c for c in self._clip_inputs(rows, extract=False)}
        angles: list[Angle] = []
        sounds: list[Sound] = []
        cameras: dict[str, str] = {}
        starts: dict[int, float] = {}
        for k, c in enumerate(placed):
            job.check_cancelled()
            if k % 20 == 0:
                job.report(0.02 + 0.8 * k / max(1, len(placed)), f"Listening to the recordings ({k} of {len(placed)})")
            row = by_id[c.clip_id]
            start = float(c.start_s)  # type: ignore[arg-type]
            starts[c.clip_id] = start
            device = row.device_key or f"clip:{c.clip_id}"
            review = c.status == "needs_review"
            if c.has_video:
                angles.append(Angle(c.clip_id, device, c.device_name, start, start + c.duration_s, review))
                cameras[device] = c.device_name
            clip_input = inputs.get(c.clip_id)
            if c.has_audio and clip_input is not None and clip_input.audio is not None:
                loud = self._loudness(row, clip_input)
                begin = start + clip_input.audio_start_s
                kind = row.device_kind or c.kind
                sounds.append(Sound(c.clip_id, device, c.device_name, kind, begin, begin + len(loud) / RATE, loud,
                                    review))  # fmt: skip
        job.report(0.85, "Reading the transcripts")
        utterances = []
        for cid, start in starts.items():
            for seg in project.transcript(cid):
                utterances.append(Utterance(start + seg["start_s"], start + seg["end_s"], seg["speaker"], seg["text"]))
        names = {s["key"]: s["name"] for s in project.speakers()}
        job.report(0.9, "Choosing shots")
        cut = plan_first_cut(angles, sounds, utterances, opts, names)
        return cut, by_id, starts, names, cameras

    def _loudness(self, row: ClipRow, clip_input: ClipInput) -> np.ndarray:
        """The recording's loudness (mcsync.edit.loudness), kept for the next plan."""
        memo = self.__dict__.setdefault("_loudness_memo", {})
        key = (row.fingerprint, row.audio_stream, row.audio_channel)
        loud = memo.get(key)
        if loud is None:
            assert clip_input.audio is not None
            loud = loudness(clip_input.audio)
            if len(memo) >= LOUDNESS_MEMO:
                memo.pop(next(iter(memo)))
            memo[key] = loud
        return loud


def cut_summary(cut: FirstCut, rows: dict[int, ClipRow], names: dict[str, str | None], cameras: dict[str, str]) -> dict:
    """The plan as the app shows it: program times, shots by camera, chapters and speakers."""
    seconds: dict[str, float] = {}
    shots = []
    for s in cut.shots:
        seconds[s.device] = seconds.get(s.device, 0.0) + (s.end - s.start)
        shots.append({"start_s": round(cut.program_time(s.start), 3), "duration_s": round(s.end - s.start, 3),
                      "clip_id": s.clip_id, "name": rows[s.clip_id].name, "device": s.device,
                      "reason": s.reason})  # fmt: skip
    return {
        "style": cut.style,
        "duration_s": round(cut.duration, 3),
        "source_duration_s": round(cut.source_duration, 3),
        "sections": len(cut.sections),
        "shots": shots,
        "takes": len(cut.takes),
        "chapters": [{"t_s": round(cut.program_time(c.start), 3), "label": c.label} for c in cut.chapters],
        "cameras": [
            {"device": d, "name": n, "seconds": round(seconds.get(d, 0.0), 1), "main": d == cut.main_device}
            for d, n in sorted(cameras.items(), key=lambda kv: kv[1].casefold())
        ],
        "speakers": [
            {"key": k, "name": names.get(k), "device": d, "guessed": k in cut.guessed_speakers}
            for k, d in sorted(cut.speaker_angles.items())
        ],
        "warnings": cut.warnings,
    }

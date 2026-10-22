"""Export model: a synchronised timeline group as an NLE sequence, in exact rational time.

Positions arrive from the timeline in float seconds. From there everything is a :class:`~fractions.Fraction`: frame
rates, frame numbers and in points. Each position is rounded once, and every rounding is reported.

Placement (docs/TECHNICAL_SPEC.md §8):

* A clip with video starts at its first frame on the nearest sequence frame, so it is at most half a frame early or
  late, as in any NLE.
* An audio-only clip (the external recorder) starts on the first sequence frame at or after its true start, and its
  in point absorbs the difference. Formats with sub-frame in points place it to the sample: FCPXML does, and so does
  Premiere Pro through the ticks in xmeml. Other xmeml readers round the in point to a frame, which is again at most
  half a frame off.
"""

from __future__ import annotations

import math
from collections import Counter
from collections.abc import Mapping
from dataclasses import dataclass, replace
from fractions import Fraction

from mcsync.media.probe import AudioStreamInfo, MediaInfo
from mcsync.project.db import ClipRow
from mcsync.timecode import Timecode, parse_frame_rate, supports_drop_frame
from mcsync.timeline import Timeline, TimelineClip

from .bins import media_bins

DEFAULT_RATE = Fraction(25)
DEFAULT_SIZE = (1920, 1080)
SEQUENCE_SAMPLE_RATE = 48_000
_MICROSECOND = 1_000_000
_MAX_ROUNDING_OVERLAP_FRAMES = 2


class ExportError(ValueError):
    """The timeline cannot be exported as asked."""


NOT_SYNCED_MODES = ("end", "place", "omit")
#: After the synced timeline: a gap before the clips that are not synced, and between them on one track.
END_GAP_S = 5
END_SPACING_S = 1


@dataclass(frozen=True)
class ExportOptions:
    name: str = "Synchronised"
    #: Sequence frame rate; None picks the most common video rate among the exported clips.
    sequence_rate: Fraction | None = None
    #: Sequence start; ``;`` before the frames means drop-frame (29.97 and 59.94 only).
    start_timecode: str = "01:00:00:00"
    #: Timeline group: 0 is the reference and everything synced to it.
    group: int = 0
    #: Also export clips placed by uncertain matches or camera clocks only (see ``not_synced``).
    include_uncertain: bool = True
    #: Put each file in a bin that mirrors its folder (export/bins.py); off: one flat list, as the editor imports it.
    bins: bool = True
    #: The paths the user imported (files or folders): the top of every bin.
    roots: tuple[str, ...] = ()
    #: Clips that are not synced: ``"end"`` puts every one of them (wherever synchronisation left it, or nowhere)
    #: after the synced timeline, one after another on its camera's track; ``"place"`` keeps those that have a
    #: position there and leaves out those that have none; ``"omit"`` leaves them all out. None: ``"place"``, or
    #: ``"omit"`` when ``include_uncertain`` is off. Clips that are not synced carry the NLE's red label.
    not_synced: str | None = None
    #: The clips the app shows as synced; None: the clips the solver marked synced.
    synced_ids: frozenset[int] | None = None

    def not_synced_mode(self) -> str:
        mode = self.not_synced or ("place" if self.include_uncertain else "omit")
        if mode not in NOT_SYNCED_MODES:
            raise ExportError(f"not_synced must be one of {', '.join(NOT_SYNCED_MODES)}, not {mode!r}")
        return mode


@dataclass(frozen=True)
class SourceMedia:
    """One media file, as both XML formats describe it."""

    key: str  # "file-1": stable within one export
    name: str
    path: str
    duration: Fraction  # seconds
    video_rate: Fraction | None
    width: int | None
    height: int | None
    video_frames: int | None
    audio_channels: int
    sample_rate: int
    bit_depth: int
    #: Start timecode of the file (frames at ``timecode_rate``), if it has one.
    timecode_frames: int | None
    timecode_rate: Fraction | None
    drop_frame: bool
    #: Where the file's own time starts, in seconds: its timecode, or its BWF time reference.
    #: FCPXML asset starts use it; xmeml in points count from the first frame instead.
    start: Fraction
    track_names: tuple[str, ...] = ()
    #: Folders from the import root to the file (empty: no bins).
    bin: tuple[str, ...] = ()

    @property
    def has_video(self) -> bool:
        return self.video_rate is not None

    @property
    def is_ntsc(self) -> bool:
        return self.video_rate is not None and self.video_rate.denominator == 1001


@dataclass(frozen=True)
class ExportClip:
    clip_id: int
    name: str
    media: SourceMedia
    video_track: int | None  # 1-based; None for audio-only clips
    audio_tracks: tuple[int, ...]  # 1-based, one per channel
    start_frame: int  # sequence frames from the sequence start
    end_frame: int
    in_point: Fraction  # seconds from the file's first frame (or sample)
    true_start: Fraction  # where synchronisation put the clip's first frame, seconds from the sequence start
    status: str
    method: str
    drift_ppm: float = 0.0
    #: False: the clip is not synced (its position is a guess, or it was put after the synced timeline); the XML
    #: gives it the NLE's red label.
    synced: bool = True

    @property
    def duration_frames(self) -> int:
        return self.end_frame - self.start_frame

    def placed_start(self, rate: Fraction, *, subframe_in: bool) -> Fraction:
        """Where the clip's first frame ends up: exact in point, or the in point rounded to a frame."""
        in_point = self.in_point if subframe_in else Fraction(round(self.in_point * rate)) / rate
        return Fraction(self.start_frame) / rate - in_point

    def error(self, rate: Fraction, *, subframe_in: bool) -> Fraction:
        """Placement error in seconds (positive: later than synchronised)."""
        return self.placed_start(rate, subframe_in=subframe_in) - self.true_start


@dataclass(frozen=True)
class Track:
    index: int  # 1-based within its kind
    kind: str  # "video" | "audio"
    name: str
    device_name: str
    channel: int | None = None  # 1-based, audio tracks only


@dataclass(frozen=True)
class SequenceMarker:
    """A marker on the sequence (a chapter of a first cut)."""

    frame: int  # sequence frames from the sequence start
    name: str
    comment: str = ""


@dataclass(frozen=True)
class Skipped:
    clip_id: int
    name: str
    reason: str


@dataclass(frozen=True)
class ExportSequence:
    name: str
    rate: Fraction
    drop_frame: bool
    width: int
    height: int
    sample_rate: int
    start_frame: int  # timecode of the sequence start, in frames
    duration_frames: int
    video_tracks: tuple[Track, ...]
    audio_tracks: tuple[Track, ...]
    clips: tuple[ExportClip, ...]
    media: tuple[SourceMedia, ...]
    skipped: tuple[Skipped, ...] = ()
    warnings: tuple[str, ...] = ()
    markers: tuple[SequenceMarker, ...] = ()

    @property
    def is_ntsc(self) -> bool:
        return self.rate.denominator == 1001

    @property
    def start_timecode(self) -> Timecode:
        return Timecode.from_frames(self.start_frame, self.rate, self.drop_frame)

    def report(self, *, subframe_in: bool) -> dict:
        """What was exported and how exactly, for the user (JSON-ready)."""
        clips = []
        for c in sorted(self.clips, key=lambda c: (c.true_start, c.name)):
            err = c.error(self.rate, subframe_in=subframe_in)
            clips.append({
                "clip_id": c.clip_id,
                "name": c.name,
                "track": f"V{c.video_track}" if c.video_track else f"A{c.audio_tracks[0]}" if c.audio_tracks else "",
                "start_s": float(c.true_start),
                "placed_s": float(c.placed_start(self.rate, subframe_in=subframe_in)),
                "error_ms": round(float(err) * 1000, 3),
                "status": c.status,
                "synced": c.synced,
            })  # fmt: skip
        errors = [abs(c["error_ms"]) for c in clips if c["synced"]]
        return {
            "sequence": {
                "name": self.name,
                "rate": f"{self.rate.numerator}/{self.rate.denominator}",
                "width": self.width,
                "height": self.height,
                "start_timecode": str(self.start_timecode),
                "duration_s": float(Fraction(self.duration_frames) / self.rate),
                "video_tracks": len(self.video_tracks),
                "audio_tracks": len(self.audio_tracks),
            },
            "clips": clips,
            "max_error_ms": max(errors, default=0.0),
            "not_synced": sum(not c.synced for c in self.clips),
            "skipped": [{"clip_id": s.clip_id, "name": s.name, "reason": s.reason} for s in self.skipped],
            "warnings": list(self.warnings),
        }


# ---------------------------------------------------------------------------
# building
# ---------------------------------------------------------------------------


def _seconds(value: float) -> Fraction:
    """Float seconds from the timeline as an exact value (to the microsecond, far below a sample)."""
    return Fraction(round(value * _MICROSECOND), _MICROSECOND)


def _round_half_up(value: Fraction) -> int:
    return math.floor(value + Fraction(1, 2))


def _export_stream(row: ClipRow) -> AudioStreamInfo | None:
    """The audio the NLE should get: the stream chosen for syncing, else the file's first."""
    return row.audio_stream_info or row.info.primary_audio


def source_media(key: str, info: MediaInfo, stream: AudioStreamInfo | None) -> SourceMedia:
    video = info.primary_video
    rate = video.frame_rate if video else None
    duration = _seconds(info.duration_s)
    frames = None
    if video and rate:
        frames = video.frame_count or max(1, math.floor(duration * rate))
    tc = info.timecode
    tc_rate = tc.rate if tc and tc.rate else None
    tc_frames = round(tc.seconds * tc_rate) if tc and tc_rate else None
    sample_rate = stream.sample_rate if stream else SEQUENCE_SAMPLE_RATE
    if video is None and info.bwf and info.bwf.time_reference is not None and stream:
        start = Fraction(info.bwf.time_reference, stream.sample_rate)  # to the sample, as NLEs read it
    elif tc_frames is not None and tc_rate is not None:
        start = Fraction(tc_frames) / tc_rate
    else:
        start = Fraction(0)
    return SourceMedia(
        key=key,
        name=info.path.replace("\\", "/").rsplit("/", 1)[-1],  # Windows paths too, whatever the OS
        path=info.path,
        duration=duration,
        video_rate=rate,
        width=video.width if video else None,
        height=video.height if video else None,
        video_frames=frames,
        audio_channels=stream.channels if stream else 0,
        sample_rate=sample_rate,
        bit_depth=stream.bits_per_sample if stream and stream.bits_per_sample else 16,
        timecode_frames=tc_frames,
        timecode_rate=tc_rate,
        drop_frame=bool(tc and tc.drop_frame),
        start=start,
        track_names=info.bwf.track_names if info.bwf else (),
    )


def media_frames(src: SourceMedia, rate: Fraction) -> int:
    """How many whole frames of ``rate`` the file lasts."""
    if src.video_rate == rate and src.video_frames:
        return src.video_frames
    return math.floor(src.duration * rate)


def choose_rate(clips: list[tuple[TimelineClip, ClipRow]]) -> Fraction:
    """The most common video frame rate, weighted by duration; 25 fps for audio-only projects."""
    weight: Counter[Fraction] = Counter()
    for clip, row in clips:
        rate = row.info.frame_rate
        if rate is not None and clip.has_video:
            weight[rate] += clip.duration_s
    return max(weight, key=lambda r: (weight[r], r)) if weight else DEFAULT_RATE


def _choose_size(clips: list[tuple[TimelineClip, ClipRow]], rate: Fraction) -> tuple[int, int]:
    sizes: Counter[tuple[int, int]] = Counter()
    for _, row in clips:
        video = row.info.primary_video
        if video and video.width and video.height:
            # Clips at the sequence rate decide; others only break ties.
            sizes[(video.width, video.height)] += 1000 if video.frame_rate == rate else 1
    return max(sizes, key=lambda s: (sizes[s], s)) if sizes else DEFAULT_SIZE


def _sequence_start(options: ExportOptions, rate: Fraction) -> tuple[int, bool]:
    try:
        tc = Timecode.parse(options.start_timecode)
        if tc.drop_frame and not supports_drop_frame(rate):
            tc = replace(tc, drop_frame=False)
        return tc.to_frames(rate), tc.drop_frame
    except ValueError as exc:
        raise ExportError(f"invalid start timecode {options.start_timecode!r}: {exc}") from exc


def build_sequence(
    timeline: Timeline, rows: Mapping[int, ClipRow], options: ExportOptions | None = None
) -> ExportSequence:
    """Lay out one timeline group as an NLE sequence."""
    options = options or ExportOptions()
    group = next((g for g in timeline.groups if g.group == options.group), None)
    if group is None:
        if not timeline.groups:
            raise ExportError("nothing to export: synchronise first")
        raise ExportError(f"the timeline has no group {options.group}")

    mode = options.not_synced_mode()

    def synced(clip: TimelineClip) -> bool:
        if options.synced_ids is not None:
            return clip.clip_id in options.synced_ids
        return clip.status == "synced"

    # In place on the synced timeline, or after it (mode "end").
    skipped: list[Skipped] = []
    in_place: list[tuple[TimelineClip, ClipRow]] = []
    at_end: list[tuple[TimelineClip, ClipRow]] = []
    others = [(c, f"not linked to the exported group (group {g.group})") for g in timeline.groups
              if g.group != options.group for c in g.clips]  # fmt: skip
    others += [(c, "not placed") for c in timeline.unsynced]
    for clip in group.clips:
        if clip.media_status != "online":
            skipped.append(Skipped(clip.clip_id, clip.name, f"media {clip.media_status}"))
        elif clip.clip_id not in rows:
            skipped.append(Skipped(clip.clip_id, clip.name, "missing from the project"))
        elif synced(clip) or mode == "place":
            in_place.append((clip, rows[clip.clip_id]))
        elif mode == "end":
            at_end.append((clip, rows[clip.clip_id]))
        else:
            skipped.append(Skipped(clip.clip_id, clip.name, "not synced (left out)"))
    for clip, reason in others:
        if mode == "end" and clip.media_status == "online" and clip.clip_id in rows:
            at_end.append((clip, rows[clip.clip_id]))
        else:
            skipped.append(Skipped(clip.clip_id, clip.name, reason if mode != "omit" else "not synced (left out)"))
    chosen = in_place + at_end
    if not chosen:
        raise ExportError("no clips to export")

    rate = parse_frame_rate(options.sequence_rate) if options.sequence_rate else choose_rate(chosen)
    width, height = _choose_size(chosen, rate)
    start_frame, drop_frame = _sequence_start(options, rate)

    # One media entry per file, in timeline order, each in the bin of its folder.
    bins = media_bins((row.path for _, row in chosen), options.roots) if options.bins else {}
    media: dict[str, SourceMedia] = {}
    for _, row in chosen:
        if row.path not in media:
            src = source_media(f"file-{len(media) + 1}", row.info, _export_stream(row))
            media[row.path] = replace(src, bin=bins.get(row.path, ()))

    # Tracks follow the timeline's device tracks (cameras first, then recorders), then tracks for the devices of
    # clips after the synced timeline that have none in this group.
    specs: list[tuple[object, str, str]] = []  # (key, track name, device name)
    for t in group.tracks:
        specs.append((t.index, t.device_name if t.lane == 0 else f"{t.device_name} ({t.lane + 1})", t.device_name))
    main_track = {t.device_id: t.index for t in group.tracks if t.lane == 0 and t.device_id is not None}
    extra: dict[object, tuple[int, str]] = {}

    def track_key(clip: TimelineClip, after: bool) -> object:
        if clip.track is not None and (not after or clip.group == options.group):
            return clip.track
        if clip.device_id in main_track:
            return main_track[clip.device_id]
        key = ("device", clip.device_id if clip.device_id is not None else f"clip-{clip.clip_id}")
        extra.setdefault(key, (_KIND_ORDER.get(clip.kind, 3), clip.device_name))
        return key

    keyed = [(track_key(clip, False), clip, row, False) for clip, row in in_place]
    keyed += [(track_key(clip, True), clip, row, True) for clip, row in at_end]
    for key, (_, name) in sorted(extra.items(), key=lambda kv: (kv[1], str(kv[0]))):
        specs.append((key, name, name))
    by_track: dict[object, list[tuple[TimelineClip, ClipRow]]] = {}
    for key, clip, row, _ in keyed:
        by_track.setdefault(key, []).append((clip, row))
    video_tracks: list[Track] = []
    audio_tracks: list[Track] = []
    video_index: dict[object, int] = {}
    audio_index: dict[object, list[int]] = {}
    for key, name, device_name in specs:
        members = by_track.get(key, [])
        if not members:
            continue
        if any(clip.has_video and media[row.path].has_video for clip, row in members):
            video_tracks.append(Track(len(video_tracks) + 1, "video", name, device_name))
            video_index[key] = len(video_tracks)
        channels = max(media[row.path].audio_channels for _, row in members)
        names = next((media[row.path].track_names for _, row in members if media[row.path].track_names), ())
        audio_index[key] = []
        for ch in range(channels):
            label = names[ch] if ch < len(names) else str(ch + 1)
            audio_tracks.append(Track(len(audio_tracks) + 1, "audio", f"{name} {label}", device_name, ch + 1))
            audio_index[key].append(len(audio_tracks))

    warnings: list[str] = []
    clips: list[ExportClip] = []

    def add(key: object, clip: TimelineClip, row: ClipRow, first: int, last: int, in_point: Fraction,
            true_start: Fraction, is_synced: bool) -> None:  # fmt: skip
        src = media[row.path]
        video = clip.has_video and src.has_video
        clips.append(
            ExportClip(
                clip_id=clip.clip_id,
                name=clip.name,
                media=src,
                video_track=video_index.get(key) if video else None,
                audio_tracks=tuple(audio_index.get(key, [])[: src.audio_channels]),
                start_frame=first,
                end_frame=last,
                in_point=in_point,
                true_start=true_start,
                status=clip.status,
                method=clip.method,
                drift_ppm=clip.drift_ppm,
                synced=is_synced,
            )
        )

    for key, clip, row, after in keyed:
        if after:
            continue
        src = media[row.path]
        true_start = _seconds(clip.start_s)  # type: ignore[arg-type]
        if clip.has_video and src.has_video:
            first = _round_half_up(true_start * rate)
            in_point = Fraction(0)
            last = first + media_frames(src, rate)
        else:
            # Trim to the next frame boundary; the in point carries the sub-frame part, to the sample.
            first = math.ceil(true_start * rate)
            in_point = Fraction(first) / rate - true_start
            in_point = Fraction(round(in_point * src.sample_rate), src.sample_rate)
            last = math.floor((true_start + src.duration) * rate)
        if last <= first:
            skipped.append(Skipped(clip.clip_id, clip.name, "shorter than one sequence frame"))
            continue
        add(key, clip, row, first, last, in_point, true_start, synced(clip))
        if row.info.primary_video and row.info.primary_video.is_vfr:
            warnings.append(f"{clip.name}: variable frame rate; the NLE may conform it and shift it slightly.")
        half_span = abs(clip.drift_ppm) * 1e-6 * clip.duration_s / 2
        if half_span > 0.5 / float(rate) and synced(clip):
            warnings.append(
                f"{clip.name}: its clock drifts {abs(clip.drift_ppm):.1f} ppm; it is aligned in the middle and "
                f"{half_span * 1000:.0f} ms off at its ends."
            )

    # After the synced timeline: each track's clips one after another, in the order they were recorded.
    markers: list[SequenceMarker] = []
    if at_end:
        block = max((c.end_frame for c in clips), default=0)
        block += round(END_GAP_S * rate) if clips else 0
        markers.append(SequenceMarker(block, "Not synced"))
        cursor: dict[object, int] = {}
        for key, clip, row, after in sorted(keyed, key=lambda k: _recorded(k[2])):
            if not after:
                continue
            src = media[row.path]
            frames = media_frames(src, rate) if clip.has_video and src.has_video else math.floor(src.duration * rate)
            if frames <= 0:
                skipped.append(Skipped(clip.clip_id, clip.name, "shorter than one sequence frame"))
                continue
            first = cursor.get(key, block)
            add(key, clip, row, first, first + frames, Fraction(0), Fraction(first) / rate, False)
            cursor[key] = first + frames + round(END_SPACING_S * rate)

    clips = _resolve_rounding_overlaps(clips, warnings)
    duration = max(c.end_frame for c in clips)
    return ExportSequence(
        name=options.name,
        rate=rate,
        drop_frame=drop_frame,
        width=width,
        height=height,
        sample_rate=SEQUENCE_SAMPLE_RATE,
        start_frame=start_frame,
        duration_frames=duration,
        video_tracks=tuple(video_tracks),
        audio_tracks=tuple(audio_tracks),
        clips=tuple(sorted(clips, key=lambda c: (c.start_frame, c.clip_id))),
        media=tuple(media.values()),
        skipped=tuple(skipped),
        warnings=tuple(warnings),
        markers=tuple(markers),
    )


_KIND_ORDER = {"camera": 0, "phone": 1, "drone": 2, "other": 3, "recorder": 4}


def _recorded(row: ClipRow) -> tuple[float, str]:
    """When a file was recorded (files without a recording time last), then its name."""
    created = row.info.creation_time
    return (created.timestamp() if created is not None else math.inf, row.name)


def _resolve_rounding_overlaps(clips: list[ExportClip], warnings: list[str]) -> list[ExportClip]:
    """Back-to-back clips of one device can overlap by a frame after rounding: trim the earlier one."""
    out = {c.clip_id: c for c in clips}
    lanes: dict[tuple[str, int], list[int]] = {}
    for c in clips:
        keys = [("video", c.video_track)] if c.video_track else []
        keys += [("audio", t) for t in c.audio_tracks]
        for key in keys:
            lanes.setdefault(key, []).append(c.clip_id)  # type: ignore[arg-type]
    reported: set[tuple[int, int]] = set()  # one warning per pair, not per shared track
    for ids in lanes.values():
        ordered = sorted((out[i] for i in ids), key=lambda c: (c.start_frame, c.clip_id))
        for prev, cur in zip(ordered, ordered[1:], strict=False):
            prev = out[prev.clip_id]
            overlap = prev.end_frame - cur.start_frame
            if overlap <= 0:
                continue
            if overlap <= _MAX_ROUNDING_OVERLAP_FRAMES and cur.start_frame > prev.start_frame:
                out[prev.clip_id] = replace(prev, end_frame=cur.start_frame)
            elif (prev.clip_id, cur.clip_id) not in reported:
                reported.add((prev.clip_id, cur.clip_id))
                warnings.append(f"{prev.name} and {cur.name} overlap on one track by {overlap} frames.")
    return list(out.values())

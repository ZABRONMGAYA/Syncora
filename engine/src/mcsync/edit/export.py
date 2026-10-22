"""A first cut as an NLE sequence: the program picture on V1, the program sound on the audio tracks below it, and
chapter markers. It is an :class:`~mcsync.export.ExportSequence`, so both XML writers, bins and the export report
work as they do for the synchronised timeline.

The kept sections play back to back. Within one, every shot and take keeps the timing synchronisation found: a
clip's in point is computed from where its first frame (or sample) plays in the cut, so sound is placed to the sample
and picture within half a frame, as in the synchronised export.
"""

from __future__ import annotations

import bisect
import math
from collections import Counter
from collections.abc import Mapping
from dataclasses import replace
from fractions import Fraction

from mcsync.export.bins import media_bins
from mcsync.export.sequence import (
    DEFAULT_RATE,
    DEFAULT_SIZE,
    SEQUENCE_SAMPLE_RATE,
    ExportClip,
    ExportError,
    ExportOptions,
    ExportSequence,
    SequenceMarker,
    SourceMedia,
    Track,
    _export_stream,
    _round_half_up,
    _seconds,
    _sequence_start,
    source_media,
)
from mcsync.project.db import ClipRow
from mcsync.timecode import parse_frame_rate

from .firstcut import FirstCut

MAX_PROGRAM_CHANNELS = 8


class _Program:
    """Timeline seconds → seconds into the cut (exact)."""

    def __init__(self, cut: FirstCut) -> None:
        self.starts = [s.start for s in cut.sections]
        self.sections = cut.sections
        self.offsets: list[Fraction] = []
        p = Fraction(0)
        for s in cut.sections:
            self.offsets.append(p)
            p += _seconds(s.end) - _seconds(s.start)
        self.duration = p

    def section(self, t: float) -> int:
        return max(0, bisect.bisect_right(self.starts, t + 1e-9) - 1)

    def at(self, t: float, k: int | None = None) -> Fraction:
        k = self.section(t) if k is None else k
        return self.offsets[k] + _seconds(t) - _seconds(self.sections[k].start)


def build_cut_sequence(
    cut: FirstCut,
    rows: Mapping[int, ClipRow],
    starts: Mapping[int, float],
    options: ExportOptions | None = None,
) -> ExportSequence:
    """``starts``: each clip's start on the synchronised timeline (the timeline the cut was planned on)."""
    options = options or ExportOptions()
    if not cut.sections or not cut.shots:
        raise ExportError("the first cut is empty: " + ("; ".join(cut.warnings) or "nothing to keep"))
    missing = {x.clip_id for x in [*cut.shots, *cut.takes]} - set(rows)
    if missing:
        raise ExportError(f"{len(missing)} clips of the cut are no longer in the project")

    weight: Counter[Fraction] = Counter()
    sizes: Counter[tuple[int, int]] = Counter()
    for shot in cut.shots:
        video = rows[shot.clip_id].info.primary_video
        if video and video.frame_rate:
            weight[video.frame_rate] += shot.end - shot.start
        if video and video.width and video.height:
            sizes[(video.width, video.height)] += shot.end - shot.start
    if options.sequence_rate:
        rate = parse_frame_rate(options.sequence_rate)
    else:
        rate = max(weight, key=lambda r: (weight[r], r)) if weight else DEFAULT_RATE
    width, height = max(sizes, key=lambda s: (sizes[s], s)) if sizes else DEFAULT_SIZE
    start_frame, drop_frame = _sequence_start(options, rate)

    ordered: list[int] = []
    for x in [*cut.shots, *cut.takes]:
        if x.clip_id not in ordered:
            ordered.append(x.clip_id)
    paths = [rows[c].path for c in ordered]
    bins = media_bins(paths, options.roots) if options.bins else {}
    media: dict[str, SourceMedia] = {}
    for cid in ordered:
        row = rows[cid]
        if row.path not in media:
            src = source_media(f"file-{len(media) + 1}", row.info, _export_stream(row))
            media[row.path] = replace(src, bin=bins.get(row.path, ()))

    program = _Program(cut)
    channels = min(
        MAX_PROGRAM_CHANNELS, max((media[rows[t.clip_id].path].audio_channels for t in cut.takes), default=0)
    )
    video_tracks = (Track(1, "video", "First cut", "First cut"),)
    audio_tracks = tuple(Track(ch, "audio", f"Program sound {ch}", "First cut", ch) for ch in range(1, channels + 1))

    clips: list[ExportClip] = []
    skipped_pieces = 0

    def piece(clip_id: int, a: float, b: float, video: bool) -> None:
        nonlocal skipped_pieces
        row = rows[clip_id]
        src = media[row.path]
        k = program.section(a)
        first = _round_half_up(program.at(a, k) * rate)
        last = _round_half_up(program.at(b, k) * rate)
        # Where the clip's first frame (or sample) would play in this section: may be before the section starts.
        clip_start = program.at(starts[clip_id], k)
        in_point = Fraction(first) / rate - clip_start
        if in_point < 0:  # the piece begins with the clip itself: start on the frame after its first sample
            first = math.ceil(clip_start * rate)
            in_point = Fraction(first) / rate - clip_start
        # Picture: an in point on the sequence's frame grid, which every NLE keeps as it is (rounding it a second time
        # to another grid could add half a frame). Sound: to the sample.
        grid = rate if video else Fraction(src.sample_rate)
        in_point = Fraction(round(in_point * grid)) / grid
        if last <= first:
            skipped_pieces += 1
            return
        clips.append(
            ExportClip(
                clip_id=len(clips) + 1,
                name=src.name,
                media=src,
                video_track=1 if video else None,
                audio_tracks=() if video else tuple(range(1, min(channels, src.audio_channels) + 1)),
                start_frame=first,
                end_frame=last,
                in_point=in_point,
                true_start=clip_start,
                status="synced",
                method="edit",
            )
        )

    for shot in cut.shots:
        piece(shot.clip_id, shot.start, shot.end, video=True)
    for take in cut.takes:
        piece(take.clip_id, take.start, take.end, video=False)
    if not any(c.video_track for c in clips):
        raise ExportError("the first cut is empty: every shot is shorter than a frame")

    markers = tuple(SequenceMarker(_round_half_up(program.at(ch.start) * rate), ch.label) for ch in cut.chapters)
    warnings = list(cut.warnings)
    if skipped_pieces:
        warnings.append(f"{skipped_pieces} pieces shorter than a frame were left out.")
    clips.sort(key=lambda c: (c.start_frame, c.video_track is None, c.clip_id))
    return ExportSequence(
        name=options.name,
        rate=rate,
        drop_frame=drop_frame,
        width=width,
        height=height,
        sample_rate=SEQUENCE_SAMPLE_RATE,
        start_frame=start_frame,
        duration_frames=max(c.end_frame for c in clips),
        video_tracks=video_tracks,
        audio_tracks=audio_tracks,
        clips=tuple(clips),
        media=tuple(media.values()),
        warnings=tuple(warnings),
        markers=markers,
    )

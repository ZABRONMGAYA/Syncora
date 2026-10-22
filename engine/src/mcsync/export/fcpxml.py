"""FCPXML 1.10: imported by DaVinci Resolve (and Final Cut Pro), with rational, sample-accurate times.

Structure: formats and assets (one per file, with its own start: timecode or BWF time reference) under
``<resources>``; the sequence's spine holds one gap spanning the timeline, and every clip is connected to it:
cameras on lanes 1, 2, … (with their own audio), recorders on lanes −1, −2, ….

A clip's ``offset`` is on the sequence's frame grid; its ``start`` is the asset start plus the in point, which for
audio-only clips carries the sub-frame part of the synchronised position (to the sample).

Folders: every file is also a clip of the event, with a keyword naming its folder path ("Wedding / Cam A / CARD1"),
and each path is a keyword collection inside a collection folder named after the top folder. That is how Final Cut
Pro shows imported folders.
"""

from __future__ import annotations

import xml.etree.ElementTree as ET
from fractions import Fraction

from .sequence import ExportSequence, SourceMedia, media_frames
from .urls import file_url

VERSION = "1.10"


def fcp_time(t: Fraction, rate: Fraction | int | None = None) -> str:
    """``"3600s"``, ``"1001/24000s"``, ``"1824/48000s"``: a time on the grid of ``rate`` (frames or samples per
    second) is written over that grid's denominator, as Final Cut Pro writes it."""
    rate = Fraction(rate) if rate is not None else None
    if t.denominator == 1:
        return f"{t.numerator}s"
    if rate is not None and (t * rate).denominator == 1:
        frames = int(t * rate)
        return f"{frames * rate.denominator}/{rate.numerator}s"
    return f"{t.numerator}/{t.denominator}s"


def _el(parent: ET.Element, tag: str, **attrs: str) -> ET.Element:
    return ET.SubElement(parent, tag, attrs)


def keyword(bin: tuple[str, ...]) -> str:
    """A folder path as one Final Cut Pro keyword (commas would separate keywords)."""
    return " / ".join(name.replace(",", " ") for name in bin)


class _Writer:
    def __init__(self, seq: ExportSequence) -> None:
        self.seq = seq
        self.ids = 0
        self.formats: dict[tuple[Fraction, int, int], str] = {}
        self.assets: dict[str, str] = {}
        self.extents: dict[str, tuple[str, str]] = {}  # media key -> asset start and duration

    def _id(self) -> str:
        self.ids += 1
        return f"r{self.ids}"

    def format(self, resources: ET.Element, rate: Fraction, width: int, height: int) -> str:
        key = (rate, width, height)
        if key not in self.formats:
            self.formats[key] = self._id()
            _el(
                resources,
                "format",
                id=self.formats[key],
                frameDuration=fcp_time(1 / rate),
                width=str(width),
                height=str(height),
            )
        return self.formats[key]

    def asset(self, resources: ET.Element, media: SourceMedia) -> None:
        seq = self.seq
        rate = media.video_rate
        # The asset's format first, so ids run in document order.
        fmt = self.format(resources, rate, media.width or seq.width, media.height or seq.height) if rate else None
        attrs = {"id": self._id(), "name": media.name, "start": ""}
        if rate is not None and fmt is not None:
            attrs["start"] = fcp_time(media.start, rate)
            attrs["duration"] = fcp_time(Fraction(media_frames(media, rate)) / rate, rate)
            attrs |= {"hasVideo": "1", "format": fmt, "videoSources": "1"}
        else:
            attrs["start"] = fcp_time(media.start, media.sample_rate)
            samples = Fraction(round(media.duration * media.sample_rate), media.sample_rate)
            attrs["duration"] = fcp_time(samples, media.sample_rate)
        if media.audio_channels:
            attrs |= {
                "hasAudio": "1",
                "audioSources": "1",
                "audioChannels": str(media.audio_channels),
                "audioRate": str(media.sample_rate),
            }
        asset = _el(resources, "asset", **attrs)
        _el(asset, "media-rep", kind="original-media", src=file_url(media.path))
        self.assets[media.key] = attrs["id"]
        self.extents[media.key] = (attrs["start"], attrs["duration"])

    def browser(self, event: ET.Element) -> None:
        """Each file as an event clip keyed by its folder, and the folders as keyword collections."""
        collections: dict[str, list[str]] = {}
        for media in self.seq.media:
            if not media.bin:
                continue
            value = keyword(media.bin)
            start, duration = self.extents[media.key]
            attrs = {
                "ref": self.assets[media.key],
                "name": media.name,
                "start": start,
                "duration": duration,
                "tcFormat": "DF" if media.drop_frame else "NDF",
            }
            if media.audio_channels:
                attrs["audioRole"] = "dialogue"
            clip = _el(event, "asset-clip", **attrs)
            _el(clip, "keyword", start=start, duration=duration, value=value)
            names = collections.setdefault(media.bin[0], [])
            if value not in names:
                names.append(value)
        for top in sorted(collections, key=str.casefold):
            folder = _el(event, "collection-folder", name=top)
            for value in sorted(collections[top], key=str.casefold):
                _el(folder, "keyword-collection", name=value)

    def write(self) -> ET.Element:
        seq = self.seq
        rate = seq.rate
        root = ET.Element("fcpxml", version=VERSION)
        resources = _el(root, "resources")
        seq_format = self.format(resources, rate, seq.width, seq.height)
        for media in seq.media:
            self.asset(resources, media)

        library = _el(root, "library")
        event = _el(library, "event", name="Syncora")
        self.browser(event)
        project = _el(event, "project", name=seq.name)
        tc_start = Fraction(seq.start_frame) / rate
        duration = Fraction(seq.duration_frames) / rate
        sequence = _el(
            project,
            "sequence",
            format=seq_format,
            duration=fcp_time(duration, rate),
            tcStart=fcp_time(tc_start, rate),
            tcFormat="DF" if seq.drop_frame else "NDF",
            audioLayout="stereo",
            audioRate="48k" if seq.sample_rate == 48_000 else "44.1k",
        )
        spine = _el(sequence, "spine")
        gap = _el(
            spine,
            "gap",
            name="Gap",
            offset=fcp_time(tc_start, rate),
            start=fcp_time(tc_start, rate),
            duration=fcp_time(duration, rate),
        )

        # Recorder lanes below the spine, in audio-track order.
        audio_only = sorted({c.audio_tracks[0] for c in seq.clips if c.video_track is None and c.audio_tracks})
        audio_lane = {track: -(i + 1) for i, track in enumerate(audio_only)}
        for clip in seq.clips:
            media = clip.media
            if clip.video_track is not None:
                lane = clip.video_track
            elif clip.audio_tracks:
                lane = audio_lane[clip.audio_tracks[0]]
            else:
                continue
            grid = media.video_rate if clip.video_track else media.sample_rate
            attrs = {
                "ref": self.assets[media.key],
                "lane": str(lane),
                "offset": fcp_time(tc_start + Fraction(clip.start_frame) / rate, rate),
                "name": clip.name,
                "start": fcp_time(media.start + clip.in_point, grid),
                "duration": fcp_time(Fraction(clip.duration_frames) / rate, rate),
                "tcFormat": "DF" if media.drop_frame else "NDF",
            }
            if media.audio_channels:
                attrs["audioRole"] = "dialogue"
            item = _el(gap, "asset-clip", **attrs)
            if clip.review_note:
                # The reason as a marker at the clip's first frame, and a keyword to find every such clip.
                one_frame = fcp_time(1 / rate, rate)
                _el(item, "keyword", start=attrs["start"], duration=attrs["duration"], value="Check sync")
                _el(item, "marker", start=attrs["start"], duration=one_frame, value=clip.review_note)
        for m in seq.markers:  # after the clips, as the DTD orders a gap's children
            attrs = {"start": fcp_time(tc_start + Fraction(m.frame) / rate, rate), "duration": fcp_time(1 / rate, rate)}
            attrs["value"] = m.name
            if m.comment:
                attrs["note"] = m.comment
            _el(gap, "marker", **attrs)
        return root


def write_fcpxml(seq: ExportSequence) -> str:
    root = _Writer(seq).write()
    ET.indent(root, space="  ")
    body = ET.tostring(root, encoding="unicode")
    return f'<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE fcpxml>\n{body}\n'

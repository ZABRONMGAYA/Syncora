"""First cut: which moments to keep, which camera to show and which recording to hear, for a whole production.

The planner works on the synchronised timeline (seconds from the group's zero) on a grid of ``RATE`` cells per
second, so a twelve-hour wedding is a few hundred thousand cells of numpy arrays, never a loop per cell.

**Sound.** One program recording at a time: sound recorders before cameras (a lavalier or a mixer is cleaner than a
camera microphone), the longer recording when several cover the same moment, so the sound changes only where a
recording starts or ends.

**What to keep.** A moment is *active* when someone speaks (transcripts) or the program sound is clearly above its
recording's noise floor. Stretches with no picture are left out. Inactive stretches longer than ``max_pause_s`` are
shortened to ``keep_pause_s`` (half before the cut, half after); the head and tail are trimmed the same way.

* ``wedding`` (long version): everything the cameras saw, in order, without the dead time between moments.
* ``podcast``: from the first words to the last, with long pauses tightened.

**Which camera.**

* ``wedding``: the main camera (the one that covers the most) holds speeches and vows in long shots; other angles
  come in for variety between ``min_shot_s`` and ``max_shot_s``, more often when nobody speaks (music, the
  processional). Cuts wait for a pause in speech, up to ``SNAP_S``.
* ``podcast``: each speaker's camera while they talk (``speaker_angles``, or a guess from which camera microphone
  hears them loudest), the main (wide) camera for cross-talk, short turns and, briefly, after ``max_shot_s`` on
  one face. Cuts land ``lead_s`` before the speaker starts.

Every shot avoids the first and last ``EDGE_S`` of its clip (a camera starting or stopping shakes), and clips that
need review are not used unless ``use_review_clips`` is set: an angle in the wrong place would cut out of sync.
"""

from __future__ import annotations

import math
from collections import defaultdict
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field

import numpy as np

RATE = 10.0  # planning cells per second
EDGE_S = 0.5  # unused head and tail of every clip
SNAP_S = 1.5  # how long a wedding cut may wait for a pause in speech
ACTIVE_ABOVE_FLOOR_DB = 8.0
SILENCE_DB = -120.0
STYLES = ("wedding", "podcast")


@dataclass(frozen=True)
class StyleDefaults:
    min_shot_s: float
    max_shot_s: float
    max_pause_s: float
    keep_pause_s: float
    lead_s: float
    #: Speech is held longer than the rest (wedding): shots of ``max_shot_s`` during speech, half that otherwise.
    speech_holds: bool


DEFAULTS = {
    "wedding": StyleDefaults(min_shot_s=3.0, max_shot_s=12.0, max_pause_s=8.0, keep_pause_s=2.0, lead_s=0.0,
                             speech_holds=True),
    "podcast": StyleDefaults(min_shot_s=2.0, max_shot_s=15.0, max_pause_s=1.2, keep_pause_s=0.6, lead_s=0.3,
                             speech_holds=False),
}  # fmt: skip


# ---------------------------------------------------------------------------
# inputs
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Angle:
    """A clip with picture, where synchronisation put it."""

    clip_id: int
    device: str  # stable key of the camera
    device_name: str
    start: float
    end: float
    review: bool = False


@dataclass(frozen=True)
class Sound:
    """A clip with sound, where synchronisation put it, with its loudness."""

    clip_id: int
    device: str
    device_name: str
    kind: str  # recorder | camera | phone | drone | other
    start: float
    end: float
    #: dBFS at ``RATE`` cells per second from ``start``.
    loudness: np.ndarray = field(repr=False, compare=False)
    review: bool = False


@dataclass(frozen=True)
class Utterance:
    """Something said, in timeline seconds."""

    start: float
    end: float
    speaker: str | None
    text: str = ""


@dataclass(frozen=True)
class CutOptions:
    style: str = "wedding"
    min_shot_s: float | None = None
    max_shot_s: float | None = None
    max_pause_s: float | None = None
    #: Shorten long silences (off: keep every moment the cameras saw, silences included).
    tighten_pauses: bool = True
    #: Podcast: speaker key → camera (device key) that shows them. Speakers left out are guessed.
    speaker_angles: Mapping[str, str] = field(default_factory=dict)
    #: Also cut to clips that need review (their position may be off).
    use_review_clips: bool = False

    def resolved(self) -> StyleDefaults:
        if self.style not in DEFAULTS:
            raise ValueError(f"unknown style {self.style!r}; choose one of {', '.join(STYLES)}")
        d = DEFAULTS[self.style]
        min_shot = self.min_shot_s if self.min_shot_s is not None else d.min_shot_s
        max_shot = self.max_shot_s if self.max_shot_s is not None else d.max_shot_s
        if not 0.5 <= min_shot <= max_shot:
            raise ValueError("shots need 0.5 s ≤ shortest ≤ longest")
        return StyleDefaults(
            min_shot_s=min_shot,
            max_shot_s=max_shot,
            max_pause_s=self.max_pause_s if self.max_pause_s is not None else d.max_pause_s,
            keep_pause_s=min(d.keep_pause_s, self.max_pause_s) if self.max_pause_s is not None else d.keep_pause_s,
            lead_s=d.lead_s,
            speech_holds=d.speech_holds,
        )


# ---------------------------------------------------------------------------
# outputs
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Section:
    """A kept stretch of the timeline; the cut plays the sections back to back."""

    start: float
    end: float

    @property
    def duration(self) -> float:
        return self.end - self.start


@dataclass(frozen=True)
class Shot:
    start: float
    end: float
    clip_id: int
    device: str
    reason: str  # main | variety | speaker | wide | only angle


@dataclass(frozen=True)
class Take:
    """A stretch of program sound from one recording."""

    start: float
    end: float
    clip_id: int
    device: str


@dataclass(frozen=True)
class Chapter:
    start: float  # timeline seconds
    label: str


@dataclass
class FirstCut:
    style: str
    sections: list[Section]
    shots: list[Shot]
    takes: list[Take]
    chapters: list[Chapter]
    #: Podcast: speaker → camera used for them (None: the wide angle), and whether it was guessed.
    speaker_angles: dict[str, str | None] = field(default_factory=dict)
    guessed_speakers: set[str] = field(default_factory=set)
    main_device: str | None = None
    warnings: list[str] = field(default_factory=list)
    source_duration: float = 0.0

    @property
    def duration(self) -> float:
        return sum(s.duration for s in self.sections)

    def program_time(self, t: float) -> float:
        """Where timeline time ``t`` (inside a section, or at its end) plays in the cut."""
        before = 0.0
        for s in self.sections:
            if t <= s.end + 1e-9:
                return before + max(0.0, t - s.start)
            before += s.duration
        return before


# ---------------------------------------------------------------------------
# grid helpers
# ---------------------------------------------------------------------------


def _runs(values: np.ndarray) -> list[tuple[int, int, int]]:
    """``(start, stop, value)`` for each run of equal values."""
    if len(values) == 0:
        return []
    change = np.flatnonzero(np.diff(values)) + 1
    starts = np.concatenate(([0], change))
    stops = np.concatenate((change, [len(values)]))
    return [(int(a), int(b), int(values[a])) for a, b in zip(starts, stops, strict=True)]


def _true_runs(mask: np.ndarray) -> list[tuple[int, int]]:
    return [(a, b) for a, b, v in _runs(mask.astype(np.int8)) if v]


def _close_gaps(mask: np.ndarray, cells: int) -> np.ndarray:
    """Fill false runs shorter than ``cells`` that sit between true cells."""
    out = mask.copy()
    for a, b, v in _runs(mask.astype(np.int8)):
        if not v and b - a < cells and a > 0 and b < len(mask):
            out[a:b] = True
    return out


def _drop_short(mask: np.ndarray, cells: int) -> np.ndarray:
    out = mask.copy()
    for a, b in _true_runs(mask):
        if b - a < cells:
            out[a:b] = False
    return out


@dataclass
class _Grid:
    t0: float
    n: int

    def cell(self, t: float) -> int:
        return min(self.n, max(0, int(math.floor((t - self.t0) * RATE + 1e-6))))

    def cell_up(self, t: float) -> int:
        return min(self.n, max(0, int(math.ceil((t - self.t0) * RATE - 1e-6))))

    def time(self, cell: int) -> float:
        return self.t0 + cell / RATE

    def span(self, start: float, end: float, edge: float = 0.0) -> tuple[int, int]:
        """Cells fully inside ``[start + edge, end - edge)``."""
        return self.cell_up(start + edge), self.cell(end - edge)


# ---------------------------------------------------------------------------
# the planner
# ---------------------------------------------------------------------------


def plan_first_cut(
    angles: Sequence[Angle],
    sounds: Sequence[Sound],
    utterances: Sequence[Utterance] = (),
    options: CutOptions | None = None,
    speaker_names: Mapping[str, str | None] | None = None,
) -> FirstCut:
    options = options or CutOptions()
    style = options.resolved()
    names = speaker_names or {}
    warnings: list[str] = []

    review_angles = [a for a in angles if a.review]
    usable_angles = [a for a in angles if options.use_review_clips or not a.review]
    usable_sounds = [s for s in sounds if options.use_review_clips or not s.review]
    if review_angles and not options.use_review_clips:
        warnings.append(
            f"{len(review_angles)} camera clip{'s' if len(review_angles) != 1 else ''} that need review "
            "were left out of the cut; review them in Sync, or allow clips to review."
        )
    if not usable_angles:
        return FirstCut(options.style, [], [], [], [], warnings=[*warnings, "No synchronised camera clips to cut."])

    t0 = min(x.start for x in [*usable_angles, *usable_sounds])
    t1 = max(x.end for x in [*usable_angles, *usable_sounds])
    grid = _Grid(t0, max(1, int(math.ceil((t1 - t0) * RATE))))
    n = grid.n

    # Sound: which recording plays at each cell.
    owner = np.full(n, -1, dtype=np.int32)
    order = sorted(range(len(usable_sounds)), key=lambda k: _sound_rank(usable_sounds[k]))
    for k in order:  # lowest rank first, so better recordings overwrite
        s = usable_sounds[k]
        a, b = grid.span(s.start, s.end)
        owner[a:b] = k
    loud = np.full(n, SILENCE_DB)
    floors = np.full(len(usable_sounds), SILENCE_DB)
    for k, s in enumerate(usable_sounds):
        if len(s.loudness):
            finite = s.loudness[np.isfinite(s.loudness)]
            floors[k] = float(np.percentile(finite, 10)) if len(finite) else SILENCE_DB
        cells = np.flatnonzero(owner == k)
        if len(cells):
            idx = np.clip(np.round((grid.t0 + cells / RATE - s.start) * RATE).astype(np.int64), 0, None)
            values = np.full(len(cells), SILENCE_DB)
            inside = idx < len(s.loudness)
            values[inside] = s.loudness[idx[inside]]
            loud[cells] = np.nan_to_num(values, nan=SILENCE_DB, neginf=SILENCE_DB, posinf=0.0)

    # Speech, from transcripts, with each cell's speaker and how many speakers talk at once.
    speech = np.zeros(n, dtype=bool)
    talkers = np.zeros(n, dtype=np.int16)
    speaker_cells: dict[str, np.ndarray] = {}
    turns = _turns(utterances)
    for u in turns:
        a, b = grid.span(u.start, u.end)
        speech[a:b] = True
        talkers[a:b] += 1
        if u.speaker:
            m = speaker_cells.setdefault(u.speaker, np.zeros(n, dtype=bool))
            m[a:b] = True

    floor_at = np.where(owner >= 0, floors[np.maximum(owner, 0)], np.inf)
    active = speech | (loud > floor_at + ACTIVE_ABOVE_FLOOR_DB)
    active = _drop_short(_close_gaps(active, int(0.5 * RATE)), int(0.3 * RATE))
    if not turns:
        warnings.append("No transcripts: cuts follow the sound only. Transcribe in Analyze for cuts on speech.")

    # Picture: which clip of each camera covers each cell, and the main camera.
    devices = sorted({a.device for a in usable_angles})
    dev_index = {d: k for k, d in enumerate(devices)}
    clip_at = np.full((len(devices), n), -1, dtype=np.int32)
    for k, a in enumerate(usable_angles):
        if a.end - a.start < style.min_shot_s + 2 * EDGE_S:
            continue  # too short for a shot
        lo, hi = grid.span(a.start, a.end, EDGE_S)
        clip_at[dev_index[a.device], lo:hi] = k
    available = clip_at >= 0
    covered = available.any(axis=0)
    coverage = available.sum(axis=1)

    # Podcast: each speaker's camera first; the main (wide) camera is then the one no speaker has.
    speaker_angles: dict[str, str | None] = {}
    guessed: set[str] = set()
    if options.style == "podcast":
        speaker_angles, guessed = _speaker_cameras(
            speaker_cells, options.speaker_angles, devices, usable_sounds, owner_of_device(usable_sounds), grid
        )
    close_ups = {dev_index[d] for d in speaker_angles.values() if d is not None}
    wide = [k for k in range(len(devices)) if k not in close_ups] or list(range(len(devices)))
    main = max(wide, key=lambda k: (int(coverage[k]), -k))

    # What to keep.
    keep = covered.copy()
    if options.style == "podcast" and speech.any():
        first, last = np.flatnonzero(speech)[[0, -1]]
        pad = int(style.keep_pause_s * RATE)
        keep[: max(0, first - pad)] = False
        keep[last + 1 + pad :] = False
    if options.tighten_pauses:
        keep &= ~_long_pauses(active, keep, style)
    keep = _drop_short(keep, int(1.0 * RATE))
    gaps_without_picture = float((~covered).sum()) / RATE
    if gaps_without_picture > 60 and options.style == "wedding":
        warnings.append(f"Left out {_minutes(gaps_without_picture)} that no camera filmed.")

    sections = [Section(grid.time(a), grid.time(b)) for a, b in _true_runs(keep)]

    # Which camera.
    if options.style == "podcast":
        unknown = [s for s, d in speaker_angles.items() if d is None]
        if len(devices) > 1 and unknown:
            listed = ", ".join(names.get(s) or s for s in unknown[:4])
            warnings.append(f"No camera matched to {listed}: the wide angle shows them. Match speakers to cameras.")
        desired = _podcast_desired(n, main, dev_index, speaker_angles, speaker_cells, talkers, style, grid)
        choice = _podcast_choose(desired, available, keep, main, style)
    else:
        choice = _wedding_choose(available, keep, speech, main, style)

    shots = _shots(choice, clip_at, keep, usable_angles, devices, main, grid, options.style)
    takes: list[Take] = []
    for a, b in _true_runs(keep):
        for x, y, k in _runs(owner[a:b]):
            if k >= 0:
                s = usable_sounds[k]
                takes.append(Take(grid.time(a + x), grid.time(a + y), s.clip_id, s.device))
    if sections and not takes:
        warnings.append("No sound covers the kept moments: the cut has picture only.")
    if not sections:
        warnings.append("Nothing to keep: no moment has both a camera and activity.")
    return FirstCut(
        style=options.style,
        sections=sections,
        shots=shots,
        takes=takes,
        chapters=_chapters(sections, turns, names, options.style),
        speaker_angles=speaker_angles,
        guessed_speakers=guessed,
        main_device=devices[main],
        warnings=warnings,
        source_duration=t1 - t0,
    )


def owner_of_device(sounds: Sequence[Sound]) -> dict[str, list[int]]:
    out: dict[str, list[int]] = defaultdict(list)
    for k, s in enumerate(sounds):
        out[s.device].append(k)
    return out


def _sound_rank(s: Sound) -> tuple[int, float]:
    return (2 if s.kind == "recorder" else 1 if s.kind == "camera" else 0, s.end - s.start)


def _turns(utterances: Sequence[Utterance]) -> list[Utterance]:
    """Utterances once each: several recordings transcribe the same words; a copy overlapping one already kept by
    more than half its length is dropped."""
    kept: list[Utterance] = []
    ends: list[tuple[float, float, str | None]] = []
    for u in sorted(utterances, key=lambda u: (u.start, -(u.end - u.start))):
        if u.end <= u.start:
            continue
        dup = False
        for s, e, spk in ends[-8:]:
            overlap = min(e, u.end) - max(s, u.start)
            if overlap > 0.5 * (u.end - u.start) and (spk == u.speaker or spk is None or u.speaker is None):
                dup = True
                break
        if not dup:
            kept.append(u)
            ends.append((u.start, u.end, u.speaker))
    return kept


def _long_pauses(active: np.ndarray, keep: np.ndarray, style: StyleDefaults) -> np.ndarray:
    """Cells to drop: the middle of every inactive stretch longer than ``max_pause_s``, all but ``keep_pause_s / 2``
    of an inactive head or tail, and kept stretches with no activity at all."""
    drop = np.zeros(len(active), dtype=bool)
    half = int(round(style.keep_pause_s * RATE / 2))
    longest = int(round(style.max_pause_s * RATE))
    for a, b in _true_runs(keep):
        for x, y in _true_runs(~active[a:b]):
            head, tail = x == 0, y == b - a
            if head and tail:
                lo, hi = a, b  # nothing happens here
            elif head:
                lo, hi = a, a + y - half
            elif tail:
                lo, hi = a + x + half, b
            elif y - x > longest:
                lo, hi = a + x + half, a + y - half
            else:
                continue
            if hi > lo:
                drop[lo:hi] = True
    return drop


def _availability_end(available: np.ndarray) -> np.ndarray:
    """For each camera and cell: where its current run of availability ends (exclusive); the cell itself when not
    available."""
    ends = np.empty(available.shape, dtype=np.int64)
    for d in range(available.shape[0]):
        row = available[d]
        end = np.arange(len(row))
        for a, b in _true_runs(row):
            end[a:b] = b
        ends[d] = end
    return ends


def _wedding_choose(
    available: np.ndarray, keep: np.ndarray, speech: np.ndarray, main: int, style: StyleDefaults
) -> np.ndarray:
    """Camera per cell: long holds on the main camera through speech, variety between angles otherwise."""
    n_dev, n = available.shape
    choice = np.full(n, -1, dtype=np.int32)
    run_end = _availability_end(available)
    min_cells = int(style.min_shot_s * RATE)
    long_cells = int(style.max_shot_s * RATE)
    short_cells = max(min_cells, long_cells // 2)
    snap = int(SNAP_S * RATE)
    last_used = np.full(n_dev, -(10**9))
    for a, b in _true_runs(keep):
        i, current = a, -1
        while i < b:
            avail = [d for d in range(n_dev) if available[d, i]]
            if not avail:
                i += 1
                continue
            speaking = bool(speech[i : min(b, i + min_cells)].mean() > 0.5) if style.speech_holds else False
            scores = {}
            for d in avail:
                room = min(int(run_end[d, i]), b) - i
                scores[d] = (
                    room >= min_cells,  # a shot of at least the minimum length fits
                    (d == main) if speaking else (d != current),  # speech holds the main camera; else, change
                    0 if speaking else i - int(last_used[d]),  # the angle seen least recently
                    room,
                    -d,
                )
            d = max(avail, key=scores.__getitem__)
            target = long_cells if (speaking or len(avail) == 1) else short_cells
            end = min(b, run_end[d, i], i + target)
            if end < min(b, run_end[d, i]) and speech[end - 1]:
                # Wait for a pause in speech, within reach and while the angle lasts.
                limit = min(b, run_end[d, i], end + snap)
                pause = np.flatnonzero(~speech[end:limit])
                if len(pause):
                    end += int(pause[0])
            if b - end < min_cells and run_end[d, i] >= b:
                end = b  # no last shot shorter than the minimum
            choice[i:end] = d
            last_used[d] = end
            current, i = d, max(end, i + 1)
    return choice


def _speaker_cameras(
    speaker_cells: Mapping[str, np.ndarray],
    given: Mapping[str, str],
    devices: list[str],
    sounds: Sequence[Sound],
    by_device: Mapping[str, list[int]],
    grid: _Grid,
) -> tuple[dict[str, str | None], set[str]]:
    """Speaker → camera: as given, else the camera whose own microphone rises the most when they speak."""
    out: dict[str, str | None] = {}
    guessed: set[str] = set()
    taken = {d for d in given.values() if d in devices}
    rises: dict[str, dict[str, float]] = {}
    for spk, cells in speaker_cells.items():
        if spk in given:
            out[spk] = given[spk] if given[spk] in devices else None
            continue
        if cells.sum() < 10 * RATE:
            out[spk] = None
            continue
        rises[spk] = {}
        for dev in devices:
            if dev not in by_device:
                continue
            rise = _mic_rise(cells, [sounds[k] for k in by_device[dev]], grid)
            if rise is not None:
                rises[spk][dev] = rise
    # Greedy: the clearest speaker–camera pairs first, one camera per speaker while cameras last.
    pairs = sorted(((r, spk, dev) for spk, by in rises.items() for dev, r in by.items()), reverse=True)
    for rise, spk, dev in pairs:
        if spk in out or dev in taken:
            continue
        others = [r for d, r in rises[spk].items() if d != dev]
        if rise >= 1.0 and (not others or rise - max(others) >= 2.0):
            out[spk] = dev
            taken.add(dev)
            guessed.add(spk)
    for spk in speaker_cells:
        out.setdefault(spk, None)
    return out, guessed


def _mic_rise(cells: np.ndarray, sounds: Sequence[Sound], grid: _Grid) -> float | None:
    """How much louder a camera's microphone is while a speaker talks than its median (dB)."""
    talking, all_values = [], []
    idx = np.flatnonzero(cells)
    for s in sounds:
        if not len(s.loudness):
            continue
        all_values.append(s.loudness)
        k = np.round((grid.t0 + idx / RATE - s.start) * RATE).astype(np.int64)
        k = k[(k >= 0) & (k < len(s.loudness))]
        talking.append(s.loudness[k])
    if not all_values:
        return None
    t = np.concatenate(talking) if talking else np.zeros(0)
    t = t[np.isfinite(t)]
    a = np.concatenate(all_values)
    a = a[np.isfinite(a)]
    if len(t) < 5 * RATE or not len(a):
        return None
    return float(np.median(t) - np.median(a))


def _podcast_desired(
    n: int,
    main: int,
    dev_index: Mapping[str, int],
    speaker_angles: Mapping[str, str | None],
    speaker_cells: Mapping[str, np.ndarray],
    talkers: np.ndarray,
    style: StyleDefaults,
    grid: _Grid,
) -> np.ndarray:
    desired = np.full(n, main, dtype=np.int32)
    lead = int(style.lead_s * RATE)
    min_cells = int(style.min_shot_s * RATE)
    for spk, cells in speaker_cells.items():
        dev = speaker_angles.get(spk)
        if dev is None or dev not in dev_index:
            continue
        for a, b in _true_runs(_close_gaps(cells, int(0.8 * RATE))):
            if b - a >= min_cells:
                desired[max(0, a - lead) : b] = dev_index[dev]
    desired[talkers > 1] = main  # cross-talk: the wide angle
    # Long holds on one face: the wide angle for a few seconds every ``max_shot_s``.
    hold, breath = int(style.max_shot_s * RATE), int(3.0 * RATE)
    for a, b, d in _runs(desired):
        if d == main:
            continue
        k = a + hold
        while k + breath + min_cells <= b:
            desired[k : k + breath] = main
            k += breath + hold
    return desired


def _podcast_choose(
    desired: np.ndarray, available: np.ndarray, keep: np.ndarray, main: int, style: StyleDefaults
) -> np.ndarray:
    n_dev, n = available.shape
    choice = np.where(keep, desired, -1).astype(np.int32)
    # A wanted camera that is not there: the main one, else whichever is.
    for i in np.flatnonzero(keep & ~available[np.clip(choice, 0, n_dev - 1), np.arange(n)]):
        choice[i] = main if available[main, i] else next((d for d in range(n_dev) if available[d, i]), -1)
    # No shot shorter than the minimum: it joins the shot before it when that camera covers it.
    min_cells = int(style.min_shot_s * RATE)
    for _ in range(3):
        runs = _runs(choice)
        for k, (a, b, d) in enumerate(runs):
            if d < 0 or b - a >= min_cells or k == 0:
                continue
            prev = runs[k - 1][2]
            if prev >= 0 and available[prev, a:b].all():
                choice[a:b] = prev
    return choice


def _shots(
    choice: np.ndarray,
    clip_at: np.ndarray,
    keep: np.ndarray,
    angles: Sequence[Angle],
    devices: list[str],
    main: int,
    grid: _Grid,
    style: str,
) -> list[Shot]:
    shots: list[Shot] = []
    for a, b in _true_runs(keep):
        for x, y, d in _runs(choice[a:b]):
            if d < 0:
                continue
            x, y = a + x, a + y
            for p, q, k in _runs(clip_at[d, x:y]):
                if k < 0:
                    continue
                p, q = x + p, x + q
                if style == "podcast":
                    reason = "wide" if d == main else "speaker"
                else:
                    alone = int((clip_at[:, p] >= 0).sum()) == 1
                    reason = "only angle" if alone else "main" if d == main else "variety"
                shots.append(Shot(grid.time(p), grid.time(q), angles[k].clip_id, devices[d], reason))
    return shots


def _chapters(
    sections: Sequence[Section], turns: Sequence[Utterance], names: Mapping[str, str | None], style: str
) -> list[Chapter]:
    """Markers for the editor: a long gap left out (wedding), and long turns of one speaker."""
    chapters: list[Chapter] = []
    for prev, cur in zip(sections, sections[1:], strict=False):
        if style == "wedding" and cur.start - prev.end >= 60.0:
            chapters.append(Chapter(cur.start, f"After a {_minutes(cur.start - prev.end)} break"))
    longest = 30.0 if style == "wedding" else 60.0
    by_speaker: list[tuple[float, float, str | None, str]] = []
    for u in turns:
        if by_speaker and by_speaker[-1][2] == u.speaker and u.start - by_speaker[-1][1] < 2.0:
            s, _, spk, text = by_speaker[-1]
            by_speaker[-1] = (s, u.end, spk, text)
        else:
            by_speaker.append((u.start, u.end, u.speaker, u.text))
    for s, e, spk, text in by_speaker:
        if e - s >= longest and spk is not None:
            who = names.get(spk) or spk
            words = " ".join(text.split()[:8])
            chapters.append(Chapter(s, f"{who}: {words}…" if words else who))
    inside = [c for c in chapters if any(x.start - 1e-6 <= c.start <= x.end for x in sections)]
    return sorted(inside, key=lambda c: c.start)


def _minutes(seconds: float) -> str:
    m = round(seconds / 60)
    return f"{m} min" if m >= 1 else f"{round(seconds)} s"

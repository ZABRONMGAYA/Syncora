"""Clock corroboration: an audio match its camera's own clock confirms.

A clip whose audio evidence scores just below the review threshold (a short overlap, a noisy gimbal microphone) is
usually exactly right, and its camera's clock says so. Once a device's clock offset is calibrated from
``CALIBRATION_MIN_CLIPS`` or more of its clips that audio placed with high confidence, a clip whose audio placement
lands where that clock puts it holds two independent pieces of evidence. Its remaining doubt is halved
(``1 − (1 − c) · DOUBT_KEPT``) and it carries ``clock_corroborated``.

Positions never change here: they stay the audio's. A placement the clock does not confirm keeps its confidence, and
one that is already in doubt for another reason (ambiguous audio, a contradiction, a detached group) is left alone.
Measured on the hard multicamera benchmark (``python -m mcsync.testing.multicam --scenario hard``): the three
gimbal clips that audio placed exactly but below the threshold are synchronised, and nothing wrong is promoted.
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Mapping
from dataclasses import replace

import numpy as np

from .types import ClipPlacement, Flag, PlacementMethod, PlacementStatus

#: Clips of one device and group that calibrate its clock: high-confidence audio placements.
CALIBRATION_MIN_CLIPS = 3
CALIBRATION_CONFIDENCE = 0.95
#: How far from the calibrated clock a placement may be and still agree: camera clocks write whole seconds.
MIN_TOLERANCE_S = 1.5
SPREAD_FACTOR = 4.0
DOUBT_KEPT = 0.5

#: Doubts the clock cannot lift. Not ``CLOCK_MISMATCH``: on an audio placement it means that an uncertain match
#: touching the clip (usually another clip's) lost to a calibrated clock. The match that places the clip is checked
#: against its own clock here anyway.
_DISQUALIFYING = frozenset(
    {
        Flag.AMBIGUOUS,
        Flag.WEAK_CORRELATION,
        Flag.REJECTED_INCONSISTENT,
        Flag.CONFLICTING_MATCHES,
        Flag.TIMECODE_DISAGREES,
        Flag.DETACHED_GROUP,
        Flag.AI_PROPOSAL,
    }
)


def calibrate_clocks(
    placements: Mapping[str, ClipPlacement],
    clock_s: Mapping[str, float],
    device_of: Mapping[str, str | None],
) -> dict[tuple[str, int | None], tuple[float, float]]:
    """``(device, group) → (offset, tolerance)``: the median of ``start − clock`` over the device's high-confidence
    audio placements, and how far a placement may be from it (at least ``MIN_TOLERANCE_S``)."""
    offsets: dict[tuple[str, int | None], list[float]] = defaultdict(list)
    for cid, p in placements.items():
        device, clock = device_of.get(cid), clock_s.get(cid)
        if device is None or clock is None or p.start_s is None or p.status != PlacementStatus.SYNCED:
            continue
        if p.method in (PlacementMethod.AUDIO, PlacementMethod.REFERENCE) and p.confidence >= CALIBRATION_CONFIDENCE:
            offsets[(device, p.group)].append(p.start_s - clock)
    out = {}
    for key, values in offsets.items():
        if len(values) < CALIBRATION_MIN_CLIPS:
            continue
        v = np.asarray(values)
        median = float(np.median(v))
        spread = float(np.median(np.abs(v - median)) * 1.4826)
        out[key] = (median, max(MIN_TOLERANCE_S, SPREAD_FACTOR * spread))
    return out


def corroborate_with_clocks(
    placements: Mapping[str, ClipPlacement],
    clock_s: Mapping[str, float],
    device_of: Mapping[str, str | None],
    *,
    confident: float = 0.7,
) -> dict[str, ClipPlacement]:
    """The placements, with confident-but-not-certain audio placements their device's clock confirms raised.

    ``clock_s``: each clip's start by its device's own clock (its recording time, in seconds); ``device_of``: each
    clip's device.
    """
    calibration = calibrate_clocks(placements, clock_s, device_of)
    out = dict(placements)
    for cid, p in placements.items():
        if p.method != PlacementMethod.AUDIO or p.start_s is None or p.status != PlacementStatus.SYNCED:
            continue
        if not confident <= p.confidence < CALIBRATION_CONFIDENCE or _DISQUALIFYING.intersection(p.flags):
            continue
        device, clock = device_of.get(cid), clock_s.get(cid)
        cal = calibration.get((device, p.group)) if device is not None else None
        if cal is None or clock is None:
            continue
        offset, tolerance = cal
        if abs(p.start_s - clock - offset) > tolerance:
            continue
        out[cid] = replace(
            p,
            confidence=1.0 - (1.0 - p.confidence) * DOUBT_KEPT,
            flags=(*p.flags, Flag.CLOCK_CORROBORATED),
        )
    return out

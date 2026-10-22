from mcsync.sync.corroborate import MIN_TOLERANCE_S, calibrate_clocks, corroborate_with_clocks
from mcsync.sync.types import ClipPlacement, Flag, PlacementMethod, PlacementStatus

AUDIO, SYNCED = PlacementMethod.AUDIO, PlacementStatus.SYNCED
CLOCK_OFFSET = -7980.4  # the camera's clock was never set: 2 h 13 min off


def placed(cid: str, start: float, confidence: float, **kw) -> ClipPlacement:
    return ClipPlacement(cid, start, kw.pop("group", 0), kw.pop("method", AUDIO), confidence,
                         kw.pop("status", SYNCED), **kw)  # fmt: skip


def gimbal(extra: dict[str, ClipPlacement], clock_errors: dict[str, float] | None = None):
    """Four clips of one camera placed exactly by audio, plus ``extra`` clips of the same camera. Each clip's clock
    reading is its true start minus the camera's offset, truncated to whole seconds as cameras write them."""
    placements = {f"g{k}": placed(f"g{k}", 100.0 * k + 0.37 * k, 1.0) for k in range(1, 5)} | extra
    clock = {cid: float(int(p.start_s - CLOCK_OFFSET)) for cid, p in placements.items()}
    for cid, err in (clock_errors or {}).items():
        clock[cid] += err
    return placements, clock, {cid: "GIMBAL" for cid in placements}


def test_a_clock_needs_three_confident_clips():
    placements, clock, devices = gimbal({})
    ((offset, tolerance),) = calibrate_clocks(placements, clock, devices).values()
    assert abs(offset - CLOCK_OFFSET) < 1.0 and tolerance >= MIN_TOLERANCE_S
    few = {cid: p for cid, p in placements.items() if cid in ("g1", "g2")}
    assert calibrate_clocks(few, clock, devices) == {}


def test_a_match_the_clock_confirms_gains_confidence():
    placements, clock, devices = gimbal({"short": placed("short", 512.25, 0.82, flags=(Flag.SHORT_OVERLAP,))})
    out = corroborate_with_clocks(placements, clock, devices)
    assert out["short"].start_s == 512.25  # the position stays the audio's
    assert out["short"].confidence == 1 - (1 - 0.82) / 2
    assert out["short"].flags == (Flag.SHORT_OVERLAP, Flag.CLOCK_CORROBORATED)
    assert out["g1"] == placements["g1"]


def test_a_match_away_from_the_clock_is_left_alone():
    placements, clock, devices = gimbal({"far": placed("far", 512.25, 0.82)}, clock_errors={"far": 40.0})
    assert corroborate_with_clocks(placements, clock, devices)["far"] == placements["far"]


def test_doubts_the_clock_cannot_lift():
    extra = {
        "ambiguous": placed("ambiguous", 300.0, 0.8, flags=(Flag.AMBIGUOUS,)),
        "beat": placed("beat", 310.0, 0.8, flags=(Flag.WEAK_CORRELATION,)),
        "weak": placed("weak", 320.0, 0.5),  # below the confident threshold
        "review": placed("review", 330.0, 0.8, status=PlacementStatus.NEEDS_REVIEW),
        "clock": placed("clock", 340.0, 0.3, method=PlacementMethod.METADATA),  # placed by the clock itself
        "other": placed("other", 350.0, 0.8, group=1),  # another group: no calibration there
    }
    placements, clock, devices = gimbal(extra)
    out = corroborate_with_clocks(placements, clock, devices)
    assert all(out[cid] == placements[cid] for cid in extra)


def test_another_devices_clock_does_not_count():
    placements, clock, devices = gimbal({"phone": placed("phone", 512.25, 0.82)})
    devices["phone"] = "IPHONE"
    assert corroborate_with_clocks(placements, clock, devices)["phone"] == placements["phone"]

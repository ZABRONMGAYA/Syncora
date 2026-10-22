"""The AI edit's first cut (mcsync.edit): what is kept, which camera, which sound, and the XML it becomes."""

from __future__ import annotations

import xml.etree.ElementTree as ET
from fractions import Fraction

import numpy as np
import pytest

from mcsync.edit import Angle, CutOptions, Sound, Utterance, build_cut_sequence, plan_first_cut
from mcsync.edit.firstcut import EDGE_S, RATE
from mcsync.export import ExportError, ExportOptions, write_fcpxml, write_xmeml
from mcsync.export.sequence import _round_half_up, _seconds
from mcsync.testing.nle import read_fcpxml, read_xmeml
from test_export import CAM_A, CAM_B, ZOOM, clip_row, video_info, wav_info  # the tests' own helpers

LOUD, QUIET = -20.0, -62.0


def loudness(duration: float, loud: list[tuple[float, float]], base: float = QUIET, level: float = LOUD) -> np.ndarray:
    """A loudness curve: ``base`` everywhere, ``level`` over the ``loud`` spans (seconds from the clip's start)."""
    curve = np.full(int(duration * RATE), base, dtype=np.float32)
    for a, b in loud:
        curve[int(a * RATE) : int(b * RATE)] = level
    return curve


def assert_continuous(cut, tolerance: float = 1e-6) -> None:
    """Shots tile every kept section, each on a clip that covers it (away from the clip's ends)."""
    for section in cut.sections:
        inside = sorted(
            (s for s in cut.shots if section.start - tolerance <= s.start < section.end), key=lambda s: s.start
        )
        assert inside, section
        assert abs(inside[0].start - section.start) < tolerance and abs(inside[-1].end - section.end) < tolerance
        for prev, cur in zip(inside, inside[1:], strict=False):
            assert abs(prev.end - cur.start) < tolerance


# ---------------------------------------------------------------------------
# wedding
# ---------------------------------------------------------------------------


@pytest.fixture
def wedding():
    zoom_loud = [(0, 200), (320, 600)]  # 200-320 s: the guests wait in silence
    sounds = [
        Sound(1, "zoom", "ZOOM F8", "recorder", 0.0, 600.0, loudness(600, zoom_loud)),
        Sound(2, "cam-a", "Cam A", "camera", 0.0, 600.0, loudness(600, zoom_loud, base=-50, level=-30)),
    ]
    angles = [
        Angle(2, "cam-a", "Cam A", 0.0, 600.0),
        Angle(3, "cam-b", "Cam B", 50.0, 150.0),
        Angle(4, "cam-b", "Cam B", 350.0, 450.0),
        Angle(5, "gimbal", "Gimbal", 400.0, 420.0, review=True),  # placed by its clock only
    ]
    utterances = [
        Utterance(10.0, 35.0, "S1", "Dearly beloved, we are gathered here today"),
        Utterance(35.5, 60.0, "S1", "to join these two"),
        Utterance(400.0, 430.0, "S2", "I take you to be my wife"),
    ]
    return angles, sounds, utterances


def test_wedding_keeps_the_moments_and_drops_the_wait(wedding):
    cut = plan_first_cut(*wedding, CutOptions(style="wedding"))
    assert cut.main_device == "cam-a"
    # The silent wait (200-320 s) is shortened to two seconds; the rest is kept.
    assert len(cut.sections) == 2
    first, second = cut.sections
    assert first.start == pytest.approx(EDGE_S) and first.end == pytest.approx(201.0, abs=0.11)
    assert second.start == pytest.approx(319.0, abs=0.11) and second.end == pytest.approx(600 - EDGE_S)
    assert cut.duration == pytest.approx(first.duration + second.duration)
    assert_continuous(cut)
    # Sound: the recorder throughout.
    assert {t.clip_id for t in cut.takes} == {1}
    assert sum(t.end - t.start for t in cut.takes) == pytest.approx(cut.duration)


def test_wedding_holds_the_main_camera_through_speech_and_varies_otherwise(wedding):
    cut = plan_first_cut(*wedding, CutOptions(style="wedding"))
    on_main_while_speaking = sum(
        max(0.0, min(s.end, 60.0) - max(s.start, 10.0)) for s in cut.shots if s.device == "cam-a"
    )
    assert on_main_while_speaking >= 0.8 * 50.0
    # Between 60 and 150 s, nobody speaks and two cameras are there: both are used.
    devices = {s.device for s in cut.shots if s.start >= 60.0 and s.end <= 150.0}
    assert devices == {"cam-a", "cam-b"}
    # Every shot stays inside its clip, away from its first and last half second.
    clips = {a.clip_id: a for a in wedding[0]}
    for s in cut.shots:
        assert clips[s.clip_id].start + EDGE_S - 1e-6 <= s.start < s.end <= clips[s.clip_id].end - EDGE_S + 1e-6
    # No shot is shorter than the minimum unless the camera itself stops.
    short = [s for s in cut.shots if s.end - s.start < 3.0 - 1e-6]
    for s in short:
        assert any(abs(s.end - x.end) < 0.2 or abs(s.start - x.start) < 0.2 for x in cut.sections) or any(
            abs(s.end - (a.end - EDGE_S)) < 0.2 for a in wedding[0]
        )


def test_wedding_cuts_wait_for_pauses_in_speech(wedding):
    cut = plan_first_cut(*wedding, CutOptions(style="wedding"))
    speech = [(u.start, u.end) for u in wedding[2]]
    inside = [s.end for s in cut.shots[:-1] if any(a + 0.2 < s.end < b - 0.2 for a, b in speech)]
    # The ceremony's first speech runs 25 s without a pause: at most one cut lands inside it.
    assert len(inside) <= 1


def test_clips_to_review_are_left_out_unless_asked(wedding):
    cut = plan_first_cut(*wedding, CutOptions(style="wedding"))
    assert 5 not in {s.clip_id for s in cut.shots}
    assert any("need review" in w for w in cut.warnings)
    allowed = plan_first_cut(*wedding, CutOptions(style="wedding", use_review_clips=True))
    assert not any("need review" in w for w in allowed.warnings)


def test_keeping_every_pause(wedding):
    cut = plan_first_cut(*wedding, CutOptions(style="wedding", tighten_pauses=False))
    assert len(cut.sections) == 1 and cut.duration == pytest.approx(600 - 2 * EDGE_S)


def test_no_transcripts_still_cuts_on_sound(wedding):
    angles, sounds, _ = wedding
    cut = plan_first_cut(angles, sounds, [], CutOptions(style="wedding"))
    assert len(cut.sections) == 2 and any("No transcripts" in w for w in cut.warnings)
    assert_continuous(cut)


# ---------------------------------------------------------------------------
# podcast
# ---------------------------------------------------------------------------


@pytest.fixture
def podcast():
    talks = {
        "S1": [(5, 25), (51, 52.5), (80, 84), (90, 150)],
        "S2": [(26, 50), (54, 80), (81, 84)],
    }
    everyone = [span for spans in talks.values() for span in spans]
    sounds = [
        Sound(1, "mixer", "Mixer", "recorder", 0.0, 300.0, loudness(300, everyone)),
        Sound(2, "wide", "Wide", "camera", 0.0, 300.0, loudness(300, everyone, base=-55, level=-35)),
        # Each close-up camera's microphone hears its own guest loudest.
        Sound(3, "cam1", "Cam 1", "camera", 0.0, 300.0,
              loudness(300, talks["S1"], base=-55, level=-28) + loudness(300, talks["S2"], base=0, level=-8)),
        Sound(4, "cam2", "Cam 2", "camera", 0.0, 300.0,
              loudness(300, talks["S2"], base=-55, level=-28) + loudness(300, talks["S1"], base=0, level=-8)),
    ]  # fmt: skip
    angles = [
        Angle(2, "wide", "Wide", 0.0, 300.0),
        Angle(3, "cam1", "Cam 1", 0.0, 300.0),
        Angle(4, "cam2", "Cam 2", 0.0, 300.0),
    ]
    utterances = [Utterance(a, b, spk, "words") for spk, spans in talks.items() for a, b in spans]
    return angles, sounds, utterances, talks


def device_at(cut, t: float) -> str | None:
    return next((s.device for s in cut.shots if s.start <= t < s.end), None)


def test_podcast_shows_each_speaker_on_their_camera(podcast):
    angles, sounds, utterances, _ = podcast
    cut = plan_first_cut(angles, sounds, utterances, CutOptions(style="podcast"))
    assert cut.main_device == "wide"
    assert cut.speaker_angles == {"S1": "cam1", "S2": "cam2"} and cut.guessed_speakers == {"S1", "S2"}
    assert device_at(cut, 15.0) == "cam1"
    assert device_at(cut, 40.0) == "cam2"
    assert device_at(cut, 82.5) == "wide"  # both talk at once
    # S1's 1.5 s interjection is too short for a cut: the picture stays where it was.
    assert device_at(cut, 51.7) != "cam1"
    # A minute on one face: the wide angle comes in for a breath every 15 s.
    devices = {device_at(cut, t) for t in np.arange(91.0, 150.0, 0.5)}
    assert devices == {"cam1", "wide"}
    assert_continuous(cut)


def test_podcast_trims_the_head_and_tightens_pauses(podcast):
    angles, sounds, utterances, _ = podcast
    cut = plan_first_cut(angles, sounds, utterances, CutOptions(style="podcast"))
    assert cut.sections[0].start == pytest.approx(5.0 - 0.3, abs=0.11)  # 0.3 s before the first words
    assert cut.sections[-1].end == pytest.approx(150.0 + 0.3, abs=0.11)
    # The 6 s pause at 84-90 s is tightened to about 0.6 s.
    removed = sum(b.start - a.end for a, b in zip(cut.sections, cut.sections[1:], strict=False))
    assert removed >= 5.0
    assert cut.duration < 150.0 - 5.0


def test_podcast_speaker_cameras_can_be_set(podcast):
    angles, sounds, utterances, _ = podcast
    cut = plan_first_cut(angles, sounds, utterances, CutOptions(style="podcast", speaker_angles={"S1": "cam2"}))
    assert cut.speaker_angles["S1"] == "cam2" and "S1" not in cut.guessed_speakers
    assert device_at(cut, 15.0) == "cam2"


def test_an_unknown_style_is_refused():
    with pytest.raises(ValueError, match="unknown style"):
        plan_first_cut([], [], [], CutOptions(style="music video"))


# ---------------------------------------------------------------------------
# the cut as XML
# ---------------------------------------------------------------------------


@pytest.fixture
def shoot():
    """Clips for the wedding fixture's ids: a recorder, two cameras."""
    rows = {
        1: clip_row(1, wav_info("/Volumes/ZOOM/ZOOM0001.WAV", 600.0, channels=2, time_reference=0, names=("L", "R")),
                    ZOOM),
        2: clip_row(2, video_info("/Volumes/A/A001.MOV", "25", 600.0), CAM_A),
        3: clip_row(3, video_info("/Volumes/B/B001.MOV", "25", 100.0), CAM_B),
        4: clip_row(4, video_info("/Volumes/B/B002.MOV", "25", 100.0), CAM_B),
        5: clip_row(5, video_info("/Volumes/B/G001.MOV", "25", 20.0), CAM_B),
    }  # fmt: skip
    starts = {1: 0.0123, 2: 0.0, 3: 50.0, 4: 350.0, 5: 400.0}
    return rows, starts


def test_the_cut_plays_back_to_back_and_in_sync(wedding, shoot):
    rows, starts = shoot
    angles, sounds, utterances = wedding
    sounds = [Sound(s.clip_id, s.device, s.device_name, s.kind, starts[s.clip_id], starts[s.clip_id] + 600, s.loudness)
              for s in sounds]  # fmt: skip
    cut = plan_first_cut(angles, sounds, utterances, CutOptions(style="wedding"))
    seq = build_cut_sequence(cut, rows, starts, ExportOptions(name="First cut", bins=False))
    rate = seq.rate
    video = sorted((c for c in seq.clips if c.video_track), key=lambda c: c.start_frame)
    audio = sorted((c for c in seq.clips if not c.video_track), key=lambda c: c.start_frame)
    # V1 is one continuous program; the sound under it too.
    assert video[0].start_frame == 0 and video[-1].end_frame == seq.duration_frames
    assert all(p.end_frame == c.start_frame for p, c in zip(video, video[1:], strict=False))
    assert all(p.end_frame == c.start_frame for p, c in zip(audio, audio[1:], strict=False))
    assert abs(Fraction(seq.duration_frames) / rate - Fraction(cut.duration)) <= Fraction(1, 25)
    # Picture within half a frame of where synchronisation put it, sound to the sample.
    for c in video:
        assert abs(c.error(rate, subframe_in=True)) <= 1 / (2 * rate)
    for c in audio:
        assert abs(c.error(rate, subframe_in=True)) <= Fraction(1, 48000)
    # The silence removed is a cut in the program, at the same frame on V1 and A1.
    first = cut.sections[0]
    cut_frame = _round_half_up((_seconds(first.end) - _seconds(first.start)) * rate)
    assert cut_frame in {c.start_frame for c in video} and cut_frame in {c.start_frame for c in audio}

    for text in (write_xmeml(seq), write_fcpxml(seq)):
        assert text.startswith("<?xml")
    placed = read_xmeml(write_xmeml(seq))
    for c in video:
        assert c.placed_start(rate, subframe_in=True) in placed[c.name]
    fcp = read_fcpxml(write_fcpxml(seq))
    assert set(fcp) <= {c.name for c in seq.clips}


def test_chapters_become_sequence_markers(podcast):
    angles, sounds, utterances, _ = podcast
    names = {"S1": "Amina"}
    cut = plan_first_cut(angles, sounds, utterances, CutOptions(style="podcast"), names)
    assert [c.label.split(":")[0] for c in cut.chapters] == ["Amina"]  # the minute-long turn at 90 s
    rows = {
        2: clip_row(2, video_info("/Volumes/W/W001.MOV", "25", 300.0), CAM_A),
        3: clip_row(3, video_info("/Volumes/1/C001.MOV", "25", 300.0), CAM_B),
        4: clip_row(4, video_info("/Volumes/2/D001.MOV", "25", 300.0), CAM_B),
        1: clip_row(1, wav_info("/Volumes/M/MIX.WAV", 300.0, channels=2, time_reference=0, names=()), ZOOM),
    }
    seq = build_cut_sequence(cut, rows, dict.fromkeys(rows, 0.0), ExportOptions())
    (marker,) = seq.markers
    assert marker.name.startswith("Amina:")
    assert ET.fromstring(write_xmeml(seq)).find("sequence/marker/name").text == marker.name
    gap = ET.fromstring(write_fcpxml(seq)).find("library/event/project/sequence/spine/gap")
    assert gap.find("marker").get("value") == marker.name


def test_an_empty_cut_is_not_exported():
    cut = plan_first_cut([], [], [], CutOptions(style="wedding"))
    with pytest.raises(ExportError, match="empty"):
        build_cut_sequence(cut, {}, {}, ExportOptions())


# ---------------------------------------------------------------------------
# loudness, from the cached waveform overview
# ---------------------------------------------------------------------------


def test_loudness_from_the_overview_follows_the_signal(tmp_path):
    from mcsync.edit.loudness import OVERVIEW_LEVEL, loudness, loudness_from_signal
    from mcsync.media.waveform import PeakBuilder, write_peaks
    from mcsync.sync.signal import AnalysisSignal

    rate = 8000
    rng = np.random.default_rng(3)
    x = rng.normal(0, 0.01, 60 * rate).astype(np.float32)  # hiss
    x[10 * rate : 25 * rate] += rng.normal(0, 0.3, 15 * rate).astype(np.float32)  # someone speaks
    x[40 * rate : 41 * rate] += rng.normal(0, 0.3, rate).astype(np.float32)
    pcm = tmp_path / "pcm.f32"
    x.tofile(pcm)
    signal = AnalysisSignal(None, rate=rate, level_dbfs=-30.0, source=(str(pcm), "<f4", (len(x),), 0))

    from_signal = loudness_from_signal(signal)
    assert loudness(signal) == pytest.approx(from_signal)  # no overview yet: read from the signal
    builder = PeakBuilder()
    builder.feed(x)
    write_peaks(tmp_path, builder.finish())
    from_overview = loudness(signal)
    assert (tmp_path / f"peaks_{OVERVIEW_LEVEL}.i8").is_file()
    assert abs(len(from_overview) - len(from_signal)) <= 1 and len(from_overview) == 600
    # Same shape: loud where someone speaks, quiet elsewhere, by about the same contrast.
    loud, quiet = slice(110, 240), slice(270, 390)
    for curve in (from_signal, from_overview):
        assert curve[loud].mean() - curve[quiet].mean() > 20.0
    assert np.corrcoef(from_signal[:599], from_overview[:599])[0, 1] > 0.95

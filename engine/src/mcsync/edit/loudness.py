"""How loud a recording is over time, ``RATE`` values a second in dBFS, for the first cut (mcsync.edit.firstcut).

The waveform overview cached with every analysed recording (media/waveform.py: μ-law min/max peaks, 125 bins a
second) is enough for that and is 128 times smaller than the analysis signal: a 200-hour production reads 180 MB of
overviews instead of 23 GB of audio. The analysis signal is read only when its overview is missing.

Only the shape matters to the planner (activity above a recording's own noise floor, a camera microphone rising
when someone speaks), so the overview's mean-square peak level stands in for the RMS level; both are offset by the
recording's in-band level, which the analysis signal's normalisation removed.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np

from mcsync.media.waveform import PEAK_LEVELS, decode_peaks, peaks_path
from mcsync.sync.features import frame_energy
from mcsync.sync.signal import AnalysisSignal

from .firstcut import RATE

OVERVIEW_LEVEL = PEAK_LEVELS[0]  # 64 samples a bin: 8 ms at 8 kHz


def _db(mean_square: np.ndarray, level_dbfs: float) -> np.ndarray:
    with np.errstate(divide="ignore"):
        return (10.0 * np.log10(mean_square + 1e-12) + level_dbfs).astype(np.float32)


def loudness_from_peaks(peaks: np.ndarray, samples_per_bin: int, rate: int, level_dbfs: float) -> np.ndarray:
    """From an overview's ``(bins, 2)`` int8 (min, max) peaks."""
    if not len(peaks):
        return np.zeros(0, dtype=np.float32)
    amp = np.maximum(np.abs(decode_peaks(peaks[:, 0])), np.abs(decode_peaks(peaks[:, 1]))).astype(np.float64)
    bins_per_cell = rate / samples_per_bin / RATE
    cells = int(len(amp) / bins_per_cell)
    if cells == 0:
        return np.zeros(0, dtype=np.float32)
    edges = np.minimum(np.floor(np.arange(cells + 1) * bins_per_cell).astype(np.int64), len(amp))
    total = np.concatenate(([0.0], np.cumsum(amp**2)))
    counts = np.maximum(edges[1:] - edges[:-1], 1)
    return _db((total[edges[1:]] - total[edges[:-1]]) / counts, level_dbfs)


def loudness_from_signal(signal: AnalysisSignal) -> np.ndarray:
    """From the analysis signal itself (streamed from its cache file)."""
    hop = max(1, round(signal.rate / RATE))
    return _db(frame_energy(signal.samples, hop), signal.level_dbfs)


def loudness(signal: AnalysisSignal) -> np.ndarray:
    """From the cached overview next to the signal's file when there is one, else from the signal."""
    source = signal.source
    if source is not None:
        overview = peaks_path(Path(source[0]).parent, OVERVIEW_LEVEL)
        if overview.is_file() and overview.stat().st_size:
            peaks = np.fromfile(overview, dtype=np.int8).reshape(-1, 2)
            return loudness_from_peaks(peaks, OVERVIEW_LEVEL, signal.rate, signal.level_dbfs)
    return loudness_from_signal(signal)

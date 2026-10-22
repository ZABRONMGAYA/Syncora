"""AI edit: a first cut of a synchronised production (a wedding's long version, a podcast), ready to refine in an NLE.

Everything runs locally from what Syncora already knows: where every clip sits on the synchronised timeline, the
transcripts and speakers of the Analyze stage, and the loudness of each recording. See :mod:`mcsync.edit.firstcut`
for the editing rules and :mod:`mcsync.edit.export` for the XML.
"""

from .export import build_cut_sequence
from .firstcut import (
    STYLES,
    Angle,
    Chapter,
    CutOptions,
    FirstCut,
    Section,
    Shot,
    Sound,
    Take,
    Utterance,
    plan_first_cut,
)

__all__ = [
    "STYLES",
    "Angle",
    "Chapter",
    "CutOptions",
    "FirstCut",
    "Section",
    "Shot",
    "Sound",
    "Take",
    "Utterance",
    "build_cut_sequence",
    "plan_first_cut",
]

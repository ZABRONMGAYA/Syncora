"""Bins: the folder each exported file came from, so the editor's project mirrors the shoot's folders.

A file's bin is the folder the user imported (an import root), then the folders between that root and the file:
importing ``D:\\Wedding`` puts ``D:\\Wedding\\Cam A\\CARD1\\C0001.MP4`` in ``Wedding / Cam A / CARD1``. When roots
are nested, the innermost one counts. A file imported on its own, or under no root, goes in a bin named after its own
folder.

Paths are compared as the system that wrote them would: Windows paths (``C:\\…``, ``\\\\server\\share\\…``) without
regard to case, whatever the operating system the engine runs on.
"""

from __future__ import annotations

import re
from collections.abc import Iterable
from pathlib import PurePath, PurePosixPath, PureWindowsPath

_WINDOWS = re.compile(r"^(?:[A-Za-z]:[\\/]|\\\\|//)")
DEFAULT_BIN = "Media"


def _pure(path: str) -> PurePath:
    return PureWindowsPath(path) if _WINDOWS.match(path) else PurePosixPath(path)


def _key(p: PurePath) -> tuple[str, ...]:
    return tuple(part.lower() for part in p.parts) if isinstance(p, PureWindowsPath) else p.parts


def _name(folder: PurePath) -> str:
    """A folder's name; a drive or share root is named after the drive (``D:``) or share."""
    if folder.name:
        return folder.name
    return folder.drive.rstrip("\\/") or DEFAULT_BIN


def media_bins(paths: Iterable[str], roots: Iterable[str] = ()) -> dict[str, tuple[str, ...]]:
    """Each path's bin, from the outermost folder to the innermost."""
    candidates = [(_key(p), p) for p in map(_pure, roots)]
    out: dict[str, tuple[str, ...]] = {}
    for path in paths:
        folder = _pure(path).parent
        key = _key(folder)
        best: PurePath | None = None
        for root_key, root in candidates:
            if type(root) is not type(folder) or key[: len(root_key)] != root_key:
                continue
            if best is None or len(root.parts) > len(best.parts):
                best = root
        if best is None:
            out[path] = (_name(folder),)
        else:
            out[path] = (_name(best), *folder.parts[len(best.parts) :])
    return out

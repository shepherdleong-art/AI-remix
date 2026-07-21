"""
Background music library service.

- Scan the local MUSIC_DIR for .mp3 / .wav files.
- Extract duration (seconds) via ffprobe.
- Validate and resolve safe file paths within the music directory.
"""

import os
import json
import logging
import subprocess
from pathlib import Path

from config import MUSIC_DIR

logger = logging.getLogger(__name__)

SUPPORTED_EXTENSIONS = {".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac"}


def _ffmpeg() -> str:
    from config import FFMPEG_EXECUTABLE
    return FFMPEG_EXECUTABLE if os.path.exists(FFMPEG_EXECUTABLE) else "ffmpeg"


def _ffprobe() -> str:
    from config import FFMPEG_EXECUTABLE
    base = os.path.dirname(FFMPEG_EXECUTABLE)
    probe = os.path.join(base, "ffprobe.exe") if os.name == "nt" else "ffprobe"
    if os.path.exists(probe):
        return probe
    return "ffprobe"


def _get_duration_sec(filepath: str) -> float:
    """Return audio duration in seconds via ffprobe, or 0 on failure."""
    try:
        r = subprocess.run(
            [_ffprobe(), "-v", "quiet", "-print_format", "json",
             "-show_format", filepath],
            capture_output=True, timeout=15, text=True,
        )
        info = json.loads(r.stdout)
        return float(info.get("format", {}).get("duration", 0))
    except Exception:
        return 0.0


def list_music() -> list[dict]:
    """Scan MUSIC_DIR and return [{name, path, duration_sec}], sorted by name."""
    files = []
    try:
        for entry in sorted(MUSIC_DIR.iterdir()):
            if not entry.is_file():
                continue
            if entry.suffix.lower() not in SUPPORTED_EXTENSIONS:
                continue
            dur = _get_duration_sec(str(entry))
            files.append({
                "name": entry.name,
                "path": str(entry),
                "duration_sec": round(dur, 1),
            })
    except Exception as e:
        logger.warning(f"list_music scan failed: {e}")
    return files


def resolve_music_path(name: str) -> str | None:
    """Resolve a music file name to a safe absolute path inside MUSIC_DIR.

    Returns the full path if the file exists and is within MUSIC_DIR, or None.
    Guards against path traversal (e.g. ``../etc/passwd``).
    """
    clean = os.path.basename(name)  # strips any directory prefix
    if not clean or clean != name:
        return None
    target = (MUSIC_DIR / clean).resolve()
    if not str(target).startswith(str(MUSIC_DIR.resolve())):
        return None
    if not target.is_file():
        return None
    return str(target)


def import_music(uploaded_path: str) -> dict | None:
    """Copy an uploaded file into MUSIC_DIR and return its info.

    ``uploaded_path`` is a temp path from the file upload; it should already
    be a valid audio file.  The file is renamed to a safe basename and
    copied into the music directory.
    """
    if not os.path.isfile(uploaded_path):
        return None
    name = os.path.basename(uploaded_path)
    ext = os.path.splitext(name)[1].lower()
    if ext not in SUPPORTED_EXTENSIONS:
        return None
    dest = MUSIC_DIR / name
    # If already exists, append a counter
    stem, ext2 = os.path.splitext(name)
    counter = 1
    while dest.exists():
        dest = MUSIC_DIR / f"{stem}_{counter}{ext2}"
        counter += 1
    import shutil
    shutil.copy2(uploaded_path, str(dest))
    dur = _get_duration_sec(str(dest))
    return {"name": dest.name, "path": str(dest), "duration_sec": round(dur, 1)}


def delete_music(name: str) -> bool:
    """Remove a track from MUSIC_DIR by file name.

    Uses resolve_music_path() to guard against path traversal. Returns True
    if the file was removed, False if it did not exist or could not be removed.
    """
    target = resolve_music_path(name)
    if target is None:
        return False
    try:
        os.remove(target)
        return True
    except OSError:
        logger.warning(f"delete_music failed for {target}")
        return False

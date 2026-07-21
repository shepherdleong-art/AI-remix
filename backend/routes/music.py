"""
Music library API endpoints.

- GET  /api/music/list      → list all tracks in the local music directory
- POST /api/music/import    → upload a new .mp3 into the library
- GET  /api/music/stream    → stream an audio file for browser playback
"""
import os
import logging
from pathlib import Path

from fastapi import APIRouter, UploadFile, File, HTTPException, Query
from fastapi.responses import FileResponse

from services.music_service import list_music, import_music, resolve_music_path, delete_music
from config import MUSIC_DIR

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/music", tags=["music"])


@router.get("/list")
async def api_list_music():
    """Return all available background music tracks."""
    tracks = list_music()
    return {"code": 0, "data": tracks, "message": "ok"}


@router.post("/import")
async def api_import_music(file: UploadFile = File(...)):
    """Upload an audio file to the music library."""
    if not file.filename:
        raise HTTPException(400, "No file provided")
    import tempfile
    suffix = os.path.splitext(file.filename or "audio.mp3")[1] or ".mp3"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        content = await file.read()
        tmp.write(content)
        tmp_path = tmp.name
    try:
        info = import_music(tmp_path)
        if info is None:
            raise HTTPException(400, "Unsupported file format or import failed")
        return {"code": 0, "data": info, "message": "ok"}
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


@router.get("/stream")
async def api_stream_music(name: str = Query(..., description="File name in music library")):
    """Stream an audio file for browser playback (Web Audio / <audio>)."""
    path = resolve_music_path(name)
    if path is None:
        raise HTTPException(404, "Music file not found")
    return FileResponse(path, media_type="audio/mpeg")


@router.delete("/{name}")
async def api_delete_music(name: str):
    """Delete a track from the music library by its file name.

    ``name`` is URL-encoded by the client; resolve_music_path() strips any
    directory prefix to prevent traversal.
    """
    if not delete_music(name):
        raise HTTPException(404, "Music file not found")
    return {"code": 0, "data": {"name": name}, "message": "ok"}

"""
Project save/load API — persists full project state as JSON snapshots.
"""
import os, json, time, logging
from pathlib import Path

from fastapi import APIRouter, HTTPException

from config import APPDATA_DIR

router = APIRouter(prefix="/api/projects", tags=["projects"])
logger = logging.getLogger(__name__)

PROJECTS_DIR: Path = APPDATA_DIR / "projects"
PROJECTS_DIR.mkdir(parents=True, exist_ok=True)


def _ok(data=None, msg="success"):
    return {"code": 0, "message": msg, "data": data}


def _err(code: int, msg: str):
    return {"code": code, "message": msg, "data": None}


@router.post("/save")
async def save_project(req: dict):
    """Save current project state as a JSON snapshot."""
    name = req.get("name", f"project_{int(time.time())}")
    state = req.get("state", {})

    project_id = f"{int(time.time() * 1000)}"
    file_path = PROJECTS_DIR / f"{project_id}.json"

    record = {
        "id": project_id,
        "name": name,
        "created_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "state": state,
    }

    with open(file_path, "w", encoding="utf-8") as f:
        json.dump(record, f, ensure_ascii=False, indent=2)

    return _ok({"id": project_id, "name": name, "created_at": record["created_at"]})


@router.get("/list")
async def list_projects():
    """List all saved projects, newest first."""
    projects = []
    for f in sorted(PROJECTS_DIR.glob("*.json"), reverse=True):
        try:
            with open(f, encoding="utf-8") as fh:
                data = json.load(fh)
            projects.append({
                "id": data.get("id", f.stem),
                "name": data.get("name", f.stem),
                "created_at": data.get("created_at", ""),
                "script_preview": (data.get("state", {}).get("script", "") or "")[:80],
                "segment_count": len(data.get("state", {}).get("timeline", [])),
            })
        except Exception:
            pass
    return _ok({"projects": projects[:50]})


@router.get("/{project_id}")
async def load_project(project_id: str):
    """Load a saved project's full state."""
    file_path = PROJECTS_DIR / f"{project_id}.json"
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="Project not found")
    with open(file_path, encoding="utf-8") as f:
        data = json.load(f)
    return _ok(data)


@router.delete("/{project_id}")
async def delete_project(project_id: str):
    """Delete a saved project."""
    file_path = PROJECTS_DIR / f"{project_id}.json"
    if file_path.exists():
        os.unlink(file_path)
    return _ok()

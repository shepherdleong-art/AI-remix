"""
Templates API routes.

Endpoints for template CRUD, builtin templates, and duplication.
All responses follow the unified format: { code: int, message: str, data: object | null }

Endpoints:
    GET    /api/templates              — List all templates (with optional ?category=&search= filters)
    GET    /api/templates/builtin      — Get builtin preset templates
    GET    /api/templates/{id}         — Get a single template by ID
    POST   /api/templates              — Create a new template
    PUT    /api/templates/{id}         — Update an existing template
    DELETE /api/templates/{id}         — Delete a template
    POST   /api/templates/{id}/duplicate — Duplicate an existing template
"""

import os
import json
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException

from config import (
    TEMPLATES_DIR,
    ErrorCode,
)
from services.templates_builtin import ensure_builtin_templates

router = APIRouter(prefix="/api/templates", tags=["templates"])

# ─── Ensure templates directory exists ────────────────────

TEMPLATES_DIR.mkdir(parents=True, exist_ok=True)


# ─── Response helpers ──────────────────────────────────────

def _build_success(data=None, message: str = "success") -> dict:
    return {"code": 0, "message": message, "data": data}


def _build_error(code: int, message: str, data=None) -> dict:
    return {"code": code, "message": message, "data": data}


# ─── File I/O ──────────────────────────────────────────────

def _get_template_path(template_id: str) -> Path:
    """Get the file path for a template by ID."""
    return TEMPLATES_DIR / f"{template_id}.json"


def _load_template_from_file(template_id: str) -> Optional[dict]:
    """Load a template from its JSON file. Returns None if not found."""
    file_path: Path = _get_template_path(template_id)
    if not file_path.exists():
        return None
    try:
        with open(file_path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return None


def _save_template_to_file(template_data: dict) -> None:
    """Save a template to its JSON file."""
    file_path: Path = _get_template_path(template_data.get("id", ""))
    file_path.parent.mkdir(parents=True, exist_ok=True)
    with open(file_path, "w", encoding="utf-8") as f:
        json.dump(template_data, f, ensure_ascii=False, indent=2)


def _delete_template_file(template_id: str) -> bool:
    """Delete a template file. Returns True if deleted, False if not found."""
    file_path: Path = _get_template_path(template_id)
    if file_path.exists():
        try:
            os.unlink(file_path)
            return True
        except OSError:
            return False
    return False


def _list_all_template_files() -> list[dict]:
    """Load all template JSON files from the templates directory."""
    templates: list[dict] = []
    if not TEMPLATES_DIR.exists():
        return templates

    for file_path in sorted(TEMPLATES_DIR.glob("*.json")):
        try:
            with open(file_path, "r", encoding="utf-8") as f:
                data: dict = json.load(f)
                templates.append(data)
        except (json.JSONDecodeError, OSError):
            continue

    return templates


def _generate_id() -> str:
    """Generate a simple unique ID."""
    import uuid
    return str(uuid.uuid4())


def _now_iso() -> str:
    """Get current UTC timestamp in ISO 8601 format."""
    return datetime.now(timezone.utc).isoformat()


# ─── Validation ────────────────────────────────────────────

def _validate_template_data(data: dict, for_update: bool = False) -> Optional[dict]:
    """Validate template request data. Returns error dict if invalid."""
    if not for_update:
        # Required fields for creation
        if not data.get("name"):
            return _build_error(40001, "模板名称不能为空")

    # Validate segments if present
    segments: list = data.get("segments", [])
    if len(segments) > 100:
        return _build_error(40006, f"片段数量不能超过100个，当前: {len(segments)}")

    for i, seg in enumerate(segments):
        if not isinstance(seg, dict):
            return _build_error(40006, f"片段 #{i + 1} 格式无效")
        if seg.get("duration", 0) < 0.1:
            return _build_error(40006, f"片段 #{i + 1} 时长不能小于0.1秒")

    return None


# ─── Routes ────────────────────────────────────────────────

@router.get("")
async def list_templates(
    category: Optional[str] = None,
    search: Optional[str] = None,
):
    """
    Get all templates, optionally filtered by category and search query.

    Query params:
        category: Filter by category ID
        search: Search in name, description, and tags

    Returns:
        { code: 0, message: "success", data: [TemplateResponse, ...] }
    """
    # Ensure builtin templates exist
    ensure_builtin_templates()

    templates: list[dict] = _list_all_template_files()

    # Apply filters
    if category and category != "all":
        templates = [t for t in templates if t.get("category") == category]

    if search:
        query: str = search.lower().strip()
        filtered: list[dict] = []
        for t in templates:
            name: str = (t.get("name") or "").lower()
            desc: str = (t.get("description") or "").lower()
            tags: list = t.get("tags", [])
            if query in name or query in desc or any(query in (tag or "").lower() for tag in tags):
                filtered.append(t)
        templates = filtered

    return _build_success(templates)


@router.get("/builtin")
async def list_builtin_templates():
    """
    Get all built-in preset templates.

    Ensures builtin templates are generated on first access, then returns them.

    Returns:
        { code: 0, message: "success", data: [TemplateResponse, ...] }
    """
    ensure_builtin_templates()

    all_templates: list[dict] = _list_all_template_files()
    builtins: list[dict] = [t for t in all_templates if t.get("is_builtin", False)]

    return _build_success(builtins)


@router.get("/{template_id}")
async def get_template(template_id: str):
    """
    Get a single template by ID.

    Returns:
        { code: 0, message: "success", data: TemplateResponse }
    """
    template: Optional[dict] = _load_template_from_file(template_id)
    if template is None:
        return _build_error(40006, f"模板不存在: {template_id}")

    return _build_success(template)


@router.post("")
async def create_template(request: dict):
    """
    Create a new template.

    Request body: Template JSON (camelCase)

    Returns:
        { code: 0, message: "success", data: TemplateResponse }
    """
    # Validate
    error = _validate_template_data(request)
    if error:
        return error

    now: str = _now_iso()
    template_id: str = _generate_id()

    template_data: dict = {
        "id": template_id,
        "name": request.get("name", "未命名模板"),
        "description": request.get("description", ""),
        "category": request.get("category", "custom"),
        "thumbnail": request.get("thumbnail", ""),
        "segments": request.get("segments", []),
        "total_duration": request.get("total_duration", 0),
        "transition": request.get("transition", {"type": "none", "duration": 0.3}),
        "tags": request.get("tags", []),
        "created_at": now,
        "updated_at": now,
        "is_builtin": False,
    }

    # Recalculate total_duration from segments
    total_dur: float = sum(
        seg.get("duration", 0) for seg in template_data["segments"]
    )
    template_data["total_duration"] = round(total_dur, 2)

    _save_template_to_file(template_data)

    return _build_success(template_data, "模板创建成功")


@router.put("/{template_id}")
async def update_template(template_id: str, request: dict):
    """
    Update an existing template.

    Request body: Partial template JSON (camelCase)

    Returns:
        { code: 0, message: "success", data: TemplateResponse }
    """
    existing: Optional[dict] = _load_template_from_file(template_id)
    if existing is None:
        return _build_error(40006, f"模板不存在: {template_id}")

    # Merge fields
    for field in ("name", "description", "category", "thumbnail", "segments",
                  "transition", "tags"):
        if field in request:
            existing[field] = request[field]

    existing["updated_at"] = _now_iso()

    # Recalculate total_duration
    total_dur: float = sum(
        seg.get("duration", 0) for seg in existing.get("segments", [])
    )
    existing["total_duration"] = round(total_dur, 2)

    _save_template_to_file(existing)

    return _build_success(existing, "模板更新成功")


@router.delete("/{template_id}")
async def delete_template(template_id: str):
    """
    Delete a template.

    Returns:
        { code: 0, message: "success", data: null }
    """
    existing: Optional[dict] = _load_template_from_file(template_id)
    if existing is None:
        return _build_error(40006, f"模板不存在: {template_id}")

    # Don't allow deleting built-in templates
    if existing.get("is_builtin", False):
        return _build_error(40006, "不能删除内置模板")

    _delete_template_file(template_id)

    return _build_success(None, "模板已删除")


@router.post("/{template_id}/duplicate")
async def duplicate_template(template_id: str):
    """
    Duplicate an existing template.

    Returns:
        { code: 0, message: "success", data: TemplateResponse }
    """
    existing: Optional[dict] = _load_template_from_file(template_id)
    if existing is None:
        return _build_error(40006, f"模板不存在: {template_id}")

    now: str = _now_iso()
    new_id: str = _generate_id()

    # Deep copy segments
    import copy
    new_segments: list = copy.deepcopy(existing.get("segments", []))

    # Assign new IDs to segments
    for seg in new_segments:
        seg["id"] = _generate_id()

    duplicated: dict = {
        **existing,
        "id": new_id,
        "name": f"{existing.get('name', '模板')} (副本)",
        "is_builtin": False,
        "created_at": now,
        "updated_at": now,
        "segments": new_segments,
    }

    _save_template_to_file(duplicated)

    return _build_success(duplicated, "模板复制成功")

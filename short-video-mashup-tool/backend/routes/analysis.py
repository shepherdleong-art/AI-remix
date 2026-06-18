"""
Analysis API routes.

Endpoints for starting, monitoring, and retrieving analysis results.
All analysis runs in background threads. Status is polled via GET endpoints.

Endpoints:
    POST /api/analysis/start        — Start analysis for a single material
    GET  /api/analysis/status/{id}  — Query analysis progress
    GET  /api/analysis/result/{id}  — Get complete analysis result
    POST /api/analysis/batch        — Batch analyze multiple materials
    GET  /api/analysis/tags         — Get all available tags across analyses
"""

import uuid
import threading
import time
from typing import Optional

from fastapi import APIRouter, HTTPException

from config import ANALYSIS_SCENE_THRESHOLD, ErrorCode
from services.analyzer import (
    AnalysisEngine,
    AnalysisOutput,
    AnalysisSubStep,
    get_engine,
)

router = APIRouter(prefix="/api/analysis", tags=["analysis"])

# ─── In-memory analysis store ────────────────────────────────

# Maps analysis_id → AnalysisOutput
_analysis_store: dict[str, AnalysisOutput] = {}

# Maps analysis_id → threading.Thread
_analysis_threads: dict[str, threading.Thread] = {}

# Lock for thread-safe store access
_store_lock: threading.Lock = threading.Lock()


def _build_success(data=None, message: str = "success") -> dict:
    """Build a success response."""
    return {"code": 0, "message": message, "data": data}


def _build_error(code: int, message: str, data=None) -> dict:
    """Build an error response."""
    return {"code": code, "message": message, "data": data}


def _run_analysis_async(
    material_id: str,
    file_path: str,
    analysis_id: str,
) -> None:
    """
    Run analysis in a background thread and store result.

    This function is designed to be run via threading.Thread.
    It updates the in-memory store as progress changes.
    """
    engine: AnalysisEngine = get_engine(scene_threshold=ANALYSIS_SCENE_THRESHOLD)

    def progress_callback(step: str, pct: float) -> None:
        """Update intermediate progress in the store."""
        with _store_lock:
            if analysis_id in _analysis_store:
                current = _analysis_store[analysis_id]
                current.progress = pct

    try:
        result: AnalysisOutput = engine.analyze(
            material_id=material_id,
            file_path=file_path,
            progress_callback=progress_callback,
        )
        with _store_lock:
            _analysis_store[analysis_id] = result
    except Exception as e:
        with _store_lock:
            if analysis_id in _analysis_store:
                current = _analysis_store[analysis_id]
                current.status = "error"
                current.error_message = str(e)
                current.progress = 100.0


def _sub_step_to_dict(step_name: str, status: str) -> dict:
    """Convert a sub-step to a dict for API response."""
    label_map: dict[str, str] = {
        "scene_detection": "场景检测",
        "quality_analysis": "质量分析",
        "tag_generation": "标签生成",
        "highlight_detection": "亮点识别",
    }
    return {
        "step": step_name,
        "status": status,
        "label": label_map.get(step_name, step_name),
    }


def _result_to_response(result: AnalysisOutput) -> dict:
    """Convert an AnalysisOutput to API response format."""
    # Determine sub-step statuses from progress
    sub_steps: list[dict] = []
    step_names: list[str] = [
        "scene_detection",
        "quality_analysis",
        "tag_generation",
        "highlight_detection",
    ]

    if result.status == "pending":
        for name in step_names:
            sub_steps.append(_sub_step_to_dict(name, "pending"))
    elif result.status == "done":
        for name in step_names:
            sub_steps.append(_sub_step_to_dict(name, "done"))
    elif result.status == "error":
        for name in step_names:
            sub_steps.append(_sub_step_to_dict(name, "error"))
    else:
        # processing — determine which steps are done based on progress
        thresholds: list[tuple[str, float]] = [
            ("scene_detection", 30.0),
            ("quality_analysis", 55.0),
            ("tag_generation", 75.0),
            ("highlight_detection", 95.0),
        ]
        current_step_found: bool = False
        for name, threshold in thresholds:
            if result.progress >= threshold:
                if current_step_found:
                    sub_steps.append(_sub_step_to_dict(name, "pending"))
                else:
                    sub_steps.append(_sub_step_to_dict(name, "done"))
            elif not current_step_found:
                sub_steps.append(_sub_step_to_dict(name, "processing"))
                current_step_found = True
            else:
                sub_steps.append(_sub_step_to_dict(name, "pending"))

    data: dict = {
        "analysisId": result.analysis_id,
        "materialId": result.material_id,
        "status": result.status,
        "sceneCount": result.scene_count,
        "totalDuration": result.total_duration,
        "qualityScore": result.quality_score,
        "tags": [
            {
                "id": t.id,
                "label": t.label,
                "category": t.category,
            }
            for t in result.tags
        ],
        "scenes": [
            {
                "id": s.id,
                "startTime": s.start_time,
                "endTime": s.end_time,
                "thumbnail": s.thumbnail,
                "description": s.description,
                "confidence": s.confidence,
            }
            for s in result.scenes
        ],
        "highlights": [
            {
                "id": h.id,
                "timeRange": list(h.time_range),
                "score": h.score,
                "reason": h.reason,
                "thumbnail": h.thumbnail,
            }
            for h in result.highlights
        ],
        "qualityReport": {
            "brightness": result.quality_report.brightness,
            "contrast": result.quality_report.contrast,
            "sharpness": result.quality_report.sharpness,
            "stability": result.quality_report.stability,
            "audioQuality": result.quality_report.audio_quality,
            "overallScore": result.quality_report.overall_score,
        }
        if result.quality_report
        else None,
        "subSteps": sub_steps,
        "progress": result.progress,
        "analyzedAt": result.analyzed_at,
    }

    return data


def _status_to_response(result: AnalysisOutput) -> dict:
    """Build a status-only response."""
    step_names: list[str] = [
        "scene_detection",
        "quality_analysis",
        "tag_generation",
        "highlight_detection",
    ]
    sub_steps: list[dict] = []

    if result.status in ("done",):
        for name in step_names:
            sub_steps.append(_sub_step_to_dict(name, "done"))
    elif result.status in ("error",):
        for name in step_names:
            sub_steps.append(_sub_step_to_dict(name, "error"))
    elif result.status == "pending":
        for name in step_names:
            sub_steps.append(_sub_step_to_dict(name, "pending"))
    else:
        thresholds: list[tuple[str, float]] = [
            ("scene_detection", 30.0),
            ("quality_analysis", 55.0),
            ("tag_generation", 75.0),
            ("highlight_detection", 95.0),
        ]
        current_found: bool = False
        for name, threshold in thresholds:
            if result.progress >= threshold:
                if current_found:
                    sub_steps.append(_sub_step_to_dict(name, "pending"))
                else:
                    sub_steps.append(_sub_step_to_dict(name, "done"))
            elif not current_found:
                sub_steps.append(_sub_step_to_dict(name, "processing"))
                current_found = True
            else:
                sub_steps.append(_sub_step_to_dict(name, "pending"))

    return {
        "analysis_id": result.analysis_id,
        "status": result.status,
        "progress": result.progress,
        "sub_steps": sub_steps,
        "error_message": result.error_message,
    }


# ─── POST /start ─────────────────────────────────────────────

@router.post("/start")
async def start_analysis(request: dict):
    """
    Start analysis for a single material.

    Request body:
        { "material_id": "uuid", "file_path": "/path/to/video.mp4" }

    Returns:
        { code: 0, message: "success", data: { analysis_id: "uuid" } }
    """
    material_id: Optional[str] = request.get("material_id")
    file_path: Optional[str] = request.get("file_path")

    if not material_id or not file_path:
        return _build_error(40001, "缺少 material_id 或 file_path 参数")

    import os
    if not os.path.exists(file_path):
        return _build_error(40004, f"文件不存在: {file_path}")

    # Check if an analysis is already running for this material
    with _store_lock:
        for existing_id, existing in _analysis_store.items():
            if existing.material_id == material_id and existing.status == "processing":
                return _build_success(
                    {"analysis_id": existing_id},
                    "该素材正在分析中",
                )

    analysis_id: str = str(uuid.uuid4())

    # Create initial placeholder
    placeholder = AnalysisOutput(
        analysis_id=analysis_id,
        material_id=material_id,
        status="processing",
        scene_count=0,
        total_duration=0.0,
        quality_score=0,
    )

    with _store_lock:
        _analysis_store[analysis_id] = placeholder

    # Start background thread
    thread = threading.Thread(
        target=_run_analysis_async,
        args=(material_id, file_path, analysis_id),
        daemon=True,
    )
    thread.start()

    with _store_lock:
        _analysis_threads[analysis_id] = thread

    return _build_success({"analysis_id": analysis_id})


# ─── GET /status/{analysis_id} ────────────────────────────────

@router.get("/status/{analysis_id}")
async def get_analysis_status(analysis_id: str):
    """
    Query the status and progress of an analysis task.

    Returns:
        { code: 0, message: "success", data: { analysis_id, status, progress, sub_steps, error_message } }
    """
    with _store_lock:
        result: Optional[AnalysisOutput] = _analysis_store.get(analysis_id)

    if result is None:
        return _build_error(40004, f"分析任务不存在: {analysis_id}")

    return _build_success(_status_to_response(result))


# ─── GET /result/{analysis_id} ────────────────────────────────

@router.get("/result/{analysis_id}")
async def get_analysis_result(analysis_id: str):
    """
    Get the complete analysis result.

    Returns the full AnalysisResultResponse when analysis is done,
    or the current state if still processing.

    Returns:
        { code: 0, message: "success", data: { ... AnalysisResultResponse ... } }
    """
    with _store_lock:
        result: Optional[AnalysisOutput] = _analysis_store.get(analysis_id)

    if result is None:
        return _build_error(40004, f"分析任务不存在: {analysis_id}")

    if result.status == "processing":
        return _build_error(
            40005,
            f"分析尚未完成，当前进度: {result.progress:.0f}%",
            {"status": result.status, "progress": result.progress},
        )

    return _build_success(_result_to_response(result))


# ─── POST /batch ─────────────────────────────────────────────

@router.post("/batch")
async def batch_analysis(request: dict):
    """
    Start batch analysis for multiple materials.

    Request body:
        {
            "material_ids": ["id1", "id2"],
            "file_paths": { "id1": "/path/1.mp4", "id2": "/path/2.mp4" }
        }

    Returns:
        { code: 0, message: "success", data: { analysis_ids: ["id1", "id2"] } }
    """
    material_ids: Optional[list] = request.get("material_ids")
    file_paths: Optional[dict] = request.get("file_paths")

    if not material_ids or not file_paths:
        return _build_error(40001, "缺少 material_ids 或 file_paths 参数")

    import os

    analysis_ids: list[str] = []

    for material_id in material_ids:
        file_path: Optional[str] = file_paths.get(material_id)
        if not file_path or not os.path.exists(file_path):
            continue

        # Check for existing
        skip: bool = False
        with _store_lock:
            for existing in _analysis_store.values():
                if existing.material_id == material_id and existing.status == "processing":
                    analysis_ids.append(existing.analysis_id)
                    skip = True
                    break

        if skip:
            continue

        analysis_id: str = str(uuid.uuid4())

        placeholder = AnalysisOutput(
            analysis_id=analysis_id,
            material_id=material_id,
            status="processing",
            scene_count=0,
            total_duration=0.0,
            quality_score=0,
        )

        with _store_lock:
            _analysis_store[analysis_id] = placeholder

        thread = threading.Thread(
            target=_run_analysis_async,
            args=(material_id, file_path, analysis_id),
            daemon=True,
        )
        thread.start()

        with _store_lock:
            _analysis_threads[analysis_id] = thread

        analysis_ids.append(analysis_id)

    return _build_success({"analysis_ids": analysis_ids})


# ─── GET /tags ────────────────────────────────────────────────

@router.get("/tags")
async def get_all_tags():
    """
    Get all available tags across all completed analyses.

    Returns:
        { code: 0, message: "success", data: { tags: [...] } }
    """
    all_tags: list[dict] = []
    seen_ids: set[str] = set()

    with _store_lock:
        for result in _analysis_store.values():
            if result.status == "done":
                for tag in result.tags:
                    if tag.id not in seen_ids:
                        seen_ids.add(tag.id)
                        all_tags.append({
                            "id": tag.id,
                            "label": tag.label,
                            "category": tag.category,
                        })

    return _build_success({"tags": all_tags})

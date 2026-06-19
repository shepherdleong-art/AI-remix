"""
Render API routes.

Endpoints for render job management and output retrieval.
All responses follow the unified format: { code: int, message: str, data: object | null }

Endpoints:
    POST   /api/render/start            — Submit a new render job
    GET    /api/render/status/{jobId}   — Get render status + progress
    GET    /api/render/result/{jobId}   — Get completed render result info
    POST   /api/render/cancel/{jobId}   — Cancel an active render
    GET    /api/render/jobs             — List all render jobs
    DELETE /api/render/jobs/{jobId}     — Delete a job record
    GET    /api/render/output/{jobId}   — Download the output file
"""

import os
import base64
from typing import Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from config import ErrorCode
from services.renderer import get_render_queue, check_ffmpeg_available

router = APIRouter(prefix="/api/render", tags=["render"])

# ─── Response helpers ──────────────────────────────────────────

def _build_success(data=None, message: str = "success") -> dict:
    return {"code": 0, "message": message, "data": data}


def _build_error(code: int, message: str, data=None) -> dict:
    return {"code": code, "message": message, "data": data}


# ─── Helpers ────────────────────────────────────────────────────

def _job_to_response(job: dict) -> dict:
    """Convert an internal job dict to an API response format."""
    config: dict = job.get("config", {})
    return {
        "id": job.get("id", ""),
        "template_id": job.get("template_id", ""),
        "template_name": job.get("template_name", ""),
        "status": job.get("status", "pending"),
        "progress": job.get("progress", 0),
        "output_path": job.get("output_path", ""),
        "output_format": job.get("output_format", config.get("output_format", "mp4")),
        "resolution": job.get("resolution", config.get("resolution", "1080p")),
        "fps": job.get("fps", config.get("fps", 30)),
        "quality": job.get("quality", config.get("quality", "medium")),
        "started_at": job.get("started_at", ""),
        "completed_at": job.get("completed_at", ""),
        "estimated_remaining": job.get("estimated_remaining", 0),
        "error": job.get("error", ""),
        "current_step": job.get("current_step", ""),
        "thumbnail": job.get("thumbnail", ""),
        "config": {
            "output_format": config.get("output_format", "mp4"),
            "resolution": config.get("resolution", "1080p"),
            "fps": config.get("fps", 30),
            "quality": config.get("quality", "medium"),
            "include_audio": config.get("include_audio", True),
            "watermark": config.get("watermark", ""),
            "bitrate": config.get("bitrate", ""),
        },
    }


# ─── Endpoints ──────────────────────────────────────────────────

@router.get("/health")
async def render_health_check():
    """Check if the render service is available (including FFmpeg)."""
    ffmpeg_ok: bool = check_ffmpeg_available()
    return _build_success({
        "available": ffmpeg_ok,
        "message": "FFmpeg is ready" if ffmpeg_ok else "FFmpeg not found — please install FFmpeg",
    })


@router.post("/start")
async def start_render(body: dict):
    """
    Submit a new render job.

    Request body:
        template_id: str — the template to render
        template_name: str — display name
        config: {
            output_format: str ("mp4"|"webm"|"gif")
            resolution: str ("720p"|"1080p"|"original")
            fps: int (24|30|60)
            quality: str ("low"|"medium"|"high")
            include_audio: bool
            watermark: str
            bitrate: str
        }

    Note: The template and materials data are expected to be available
    from the templates and materials API — the backend loads them as needed.
    For MVP, the frontend should provide the full template data.

    Returns the created job with status "pending" or "queued".
    """
    template_id: str = body.get("template_id", "")
    template_name: str = body.get("template_name", "未命名模板")
    config: dict = body.get("config", {})

    if not template_id:
        return _build_error(ErrorCode.TEMPLATE_INVALID, "缺少 template_id 参数")

    # Validate config
    output_format: str = config.get("output_format", "mp4")
    if output_format not in ("mp4", "webm", "gif"):
        config["output_format"] = "mp4"

    resolution: str = config.get("resolution", "1080p")
    if resolution not in ("720p", "1080p", "original"):
        config["resolution"] = "1080p"

    fps: int = config.get("fps", 30)
    if fps not in (24, 30, 60):
        config["fps"] = 30

    quality: str = config.get("quality", "medium")
    if quality not in ("low", "medium", "high"):
        config["quality"] = "medium"

    # Check FFmpeg availability
    if not check_ffmpeg_available():
        return _build_error(
            ErrorCode.FFMPEG_NOT_FOUND,
            "FFmpeg 未找到，请安装 FFmpeg 后再试。可从 https://ffmpeg.org/download.html 下载安装。",
        )

    # For MVP, we need the full template data. The frontend should
    # have already loaded it. We try to load from templates endpoint data.
    # Since this is a simplified MVP, we accept template data inline.
    template: dict = body.get("template", {})
    materials: list = body.get("materials", [])

    if not template or not template.get("segments"):
        return _build_error(
            ErrorCode.TEMPLATE_INVALID,
            "模板数据不完整或没有可渲染的片段。请先在模板编辑器中添加片段。",
        )

    if not materials:
        return _build_error(
            ErrorCode.MISSING_REQUIRED_MATERIAL,
            "没有可用的素材文件。请先导入视频素材。",
        )

    render_queue = get_render_queue()
    job: dict = render_queue.create_job(
        template=template,
        materials=materials,
        config=config,
        template_name=template_name,
    )

    return _build_success(_job_to_response(job), "渲染任务已提交")


@router.get("/status/{job_id}")
async def get_render_status(job_id: str):
    """
    Get the current status and progress of a render job.

    Polled by the frontend every 500ms during active rendering.
    """
    render_queue = get_render_queue()
    job: Optional[dict] = render_queue.get_job(job_id)

    if not job:
        return _build_error(ErrorCode.NUMBER_NOT_CONSECUTIVE, f"渲染任务不存在: {job_id}")

    return _build_success(_job_to_response(job))


@router.get("/result/{job_id}")
async def get_render_result(job_id: str):
    """
    Get the completed render result, including output path and thumbnail.

    Returns error if the job hasn't completed yet.
    """
    render_queue = get_render_queue()
    job: Optional[dict] = render_queue.get_job(job_id)

    if not job:
        return _build_error(ErrorCode.NUMBER_NOT_CONSECUTIVE, f"渲染任务不存在: {job_id}")

    if job["status"] != "completed":
        return _build_error(
            ErrorCode.FFMPEG_FAILED,
            f"任务尚未完成，当前状态: {job['status']}",
        )

    response_data: dict = _job_to_response(job)
    output_path: str = job.get("output_path", "")
    if output_path and os.path.isfile(output_path):
        response_data["file_size"] = os.path.getsize(output_path)

    return _build_success(response_data)


@router.post("/cancel/{job_id}")
async def cancel_render(job_id: str):
    """
    Cancel an active or queued render job.
    """
    render_queue = get_render_queue()
    success: bool = render_queue.cancel_job(job_id)

    if not success:
        return _build_error(
            ErrorCode.CANCEL_FAILED,
            f"取消失败。任务可能不存在或无法取消: {job_id}",
        )

    return _build_success(None, "渲染任务已取消")


@router.get("/jobs")
async def list_jobs():
    """
    List all render jobs (active + history).
    """
    render_queue = get_render_queue()
    jobs: list = render_queue.get_all_jobs()
    job_responses: list = [_job_to_response(job) for job in jobs]
    return _build_success(job_responses)


@router.delete("/jobs/{job_id}")
async def delete_job(job_id: str):
    """
    Delete a render job record.

    Only jobs that are not actively processing can be deleted.
    """
    render_queue = get_render_queue()
    success: bool = render_queue.delete_job(job_id)

    if not success:
        return _build_error(
            ErrorCode.NUMBER_NOT_CONSECUTIVE,
            f"删除失败。任务可能不存在或正在渲染中: {job_id}",
        )

    return _build_success(None, "任务已删除")


@router.get("/output/{job_id}")
async def download_output(job_id: str):
    """
    Download the rendered output file.

    Returns the video file as a download response.
    """
    render_queue = get_render_queue()
    output_path: Optional[str] = render_queue.get_output_file_path(job_id)

    if not output_path:
        return _build_error(
            ErrorCode.EXPORT_PATH_INVALID,
            f"输出文件不存在或任务未完成: {job_id}",
        )

    if not os.path.isfile(output_path):
        return _build_error(
            ErrorCode.EXPORT_PATH_INVALID,
            "输出文件已被移动或删除",
        )

    filename: str = os.path.basename(output_path)
    return FileResponse(
        path=output_path,
        filename=filename,
        media_type="video/mp4",
    )


@router.get("/thumbnail/{job_id}")
async def get_thumbnail(job_id: str):
    """
    Get the thumbnail for a completed render job as base64 data.
    """
    render_queue = get_render_queue()
    job: Optional[dict] = render_queue.get_job(job_id)

    if not job:
        return _build_error(ErrorCode.NUMBER_NOT_CONSECUTIVE, f"渲染任务不存在: {job_id}")

    thumbnail: str = job.get("thumbnail", "")
    if not thumbnail:
        return _build_error(ErrorCode.NUMBER_NOT_CONSECUTIVE, "缩略图不可用")

    return _build_success({"thumbnail": thumbnail, "mime_type": "image/jpeg"})

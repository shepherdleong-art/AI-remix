"""
Built-in template generator service.

Provides 6 preset template definitions for common short-video styles:
- Fast-paced (快节奏)
- Vlog (Vlog)
- Product showcase (产品展示)
- Tutorial (教程)
- Festival (节日)
- Slideshow (幻灯片)

On first startup, the templates are automatically generated and saved
to the templates directory as JSON files.
"""

import json
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from config import TEMPLATES_DIR


def _generate_id() -> str:
    """Generate a UUID v4 identifier."""
    return str(uuid.uuid4())


def _now_iso() -> str:
    """Get current UTC timestamp in ISO 8601 format."""
    return datetime.now(timezone.utc).isoformat()


def _generate_segment_id() -> str:
    return _generate_id()


# ─── Segment templates ──────────────────────────────────────

def _make_segment(
    order: int,
    duration: float,
    material_id: str = "",
    transition_in_type: str = "fade",
    transition_out_type: str = "fade",
    transition_duration: float = 0.3,
    volume: float = 1.0,
    speed: float = 1.0,
    text_overlay: Optional[dict] = None,
    filters: Optional[list] = None,
) -> dict:
    """Create a segment dict with reasonable defaults."""
    return {
        "id": _generate_segment_id(),
        "material_id": material_id,
        "start_time": 0,
        "end_time": round(duration, 2),
        "duration": round(duration, 2),
        "order": order,
        "transition_in": {
            "type": transition_in_type,
            "duration": round(transition_duration, 2),
        },
        "transition_out": {
            "type": transition_out_type,
            "duration": round(transition_duration, 2),
        },
        "filters": filters or [],
        "text_overlay": text_overlay,
        "volume": volume,
        "speed": speed,
    }


# ─── Builtin Template Definitions ──────────────────────────

def _create_fast_paced_template() -> dict:
    """快节奏模板 — Fast-paced montage with quick cuts and high energy."""
    segments: list[dict] = []
    durations: list[float] = [2.0, 1.5, 1.8, 2.2, 1.3, 2.5, 1.8, 2.0, 1.5, 2.3]

    for i, dur in enumerate(durations):
        seg: dict = _make_segment(
            order=i,
            duration=dur,
            transition_in_type="wipe" if i > 0 else "none",
            transition_out_type="wipe" if i < len(durations) - 1 else "none",
            transition_duration=0.2,
            speed=1.1,
        )
        # Add contrast boost for edgy look
        seg["filters"] = [
            {"type": "contrast", "value": 120},
            {"type": "saturation", "value": 115},
        ]
        segments.append(seg)

    total_duration: float = round(sum(d / 1.1 for d in durations), 2)

    return {
        "id": "builtin-fast-paced-001",
        "name": "快节奏混剪",
        "description": "适合运动、街拍、快节奏内容的混剪模板。快速切换镜头，高对比度配色，让视频充满活力。",
        "category": "fast-paced",
        "thumbnail": "",
        "segments": segments,
        "total_duration": total_duration,
        "transition": {"type": "wipe", "duration": 0.2},
        "tags": ["快节奏", "运动", "活力", "混剪", "高能"],
        "created_at": _now_iso(),
        "updated_at": _now_iso(),
        "is_builtin": True,
    }


def _create_vlog_template() -> dict:
    """Vlog模板 — Casual daily vlog style with gentle transitions."""
    segments: list[dict] = []
    durations: list[float] = [4.0, 3.5, 5.0, 3.0, 4.5, 3.5, 5.5, 4.0]

    text_overlay_templates: list[Optional[dict]] = [
        {
            "text": "早上好！",
            "font": '"Microsoft YaHei", sans-serif',
            "font_size": 36,
            "color": "#FFFFFF",
            "position": "bottom-center",
            "start_time": 0.5,
            "duration": 3.0,
        },
        None,
        {
            "text": "今天的计划",
            "font": '"Microsoft YaHei", sans-serif',
            "font_size": 32,
            "color": "#FFD700",
            "position": "top-left",
            "start_time": 0,
            "duration": 4.0,
        },
        None,
        None,
        {
            "text": "结束一天",
            "font": '"Microsoft YaHei", sans-serif',
            "font_size": 36,
            "color": "#FFFFFF",
            "position": "bottom-center",
            "start_time": 1.0,
            "duration": 2.5,
        },
        None,
        None,
    ]

    for i, dur in enumerate(durations):
        seg: dict = _make_segment(
            order=i,
            duration=dur,
            transition_in_type="fade" if i > 0 else "none",
            transition_out_type="fade" if i < len(durations) - 1 else "none",
            transition_duration=0.5,
            volume=1.0,
            speed=1.0,
            text_overlay=text_overlay_templates[i] if i < len(text_overlay_templates) else None,
        )
        segments.append(seg)

    total_duration: float = round(sum(durations), 2)

    return {
        "id": "builtin-vlog-001",
        "name": "日常Vlog",
        "description": "适合日常Vlog、生活记录的模板。柔和转场，自然节奏，预设文字叠加位置。",
        "category": "vlog",
        "thumbnail": "",
        "segments": segments,
        "total_duration": total_duration,
        "transition": {"type": "fade", "duration": 0.5},
        "tags": ["Vlog", "日常", "生活", "自然", "柔和"],
        "created_at": _now_iso(),
        "updated_at": _now_iso(),
        "is_builtin": True,
    }


def _create_product_template() -> dict:
    """产品展示模板 — Product showcase with clean transitions."""
    segments: list[dict] = []
    durations: list[float] = [3.0, 2.5, 3.5, 2.0, 3.0, 2.5, 4.0, 2.0]

    for i, dur in enumerate(durations):
        seg: dict = _make_segment(
            order=i,
            duration=dur,
            transition_in_type="slide" if i > 0 else "none",
            transition_out_type="slide" if i < len(durations) - 1 else "none",
            transition_duration=0.4,
            volume=0.8,
            speed=1.0,
        )
        # Add sharpness for product detail
        seg["filters"] = [
            {"type": "sharpen", "value": 3},
            {"type": "brightness", "value": 105},
        ]
        segments.append(seg)

    # Product name overlay on first segment
    segments[0]["text_overlay"] = {
        "text": "产品展示",
        "font": '"Microsoft YaHei", sans-serif',
        "font_size": 40,
        "color": "#FFFFFF",
        "position": "center",
        "start_time": 0.5,
        "duration": 2.5,
    }

    total_duration: float = round(sum(durations), 2)

    return {
        "id": "builtin-product-001",
        "name": "产品展示",
        "description": "适合产品评测、开箱、展示视频。滑动转场，清晰锐利，突出产品细节。",
        "category": "product",
        "thumbnail": "",
        "segments": segments,
        "total_duration": total_duration,
        "transition": {"type": "slide", "duration": 0.4},
        "tags": ["产品", "开箱", "评测", "展示", "清晰"],
        "created_at": _now_iso(),
        "updated_at": _now_iso(),
        "is_builtin": True,
    }


def _create_tutorial_template() -> dict:
    """教程模板 — Tutorial/educational video style."""
    segments: list[dict] = []
    durations: list[float] = [6.0, 5.0, 4.5, 7.0, 5.5, 4.0, 6.0, 5.0]

    step_labels: list[str] = [
        "步骤一：准备材料",
        "步骤二：开始操作",
        "步骤三：关键要点",
        "步骤四：详细演示",
        "步骤五：常见错误",
        "步骤六：优化技巧",
        "步骤七：最终效果",
        "总结",
    ]

    for i, dur in enumerate(durations):
        text_overlay: dict = {
            "text": step_labels[i],
            "font": '"Microsoft YaHei", sans-serif',
            "font_size": 34,
            "color": "#FFFFFF",
            "position": "top-center",
            "start_time": 0,
            "duration": min(dur, 5.0),
        }

        seg: dict = _make_segment(
            order=i,
            duration=dur,
            transition_in_type="dissolve" if i > 0 else "none",
            transition_out_type="dissolve" if i < len(durations) - 1 else "none",
            transition_duration=0.6,
            volume=0.9,
            speed=1.0,
            text_overlay=text_overlay,
        )
        segments.append(seg)

    total_duration: float = round(sum(durations), 2)

    return {
        "id": "builtin-tutorial-001",
        "name": "教程讲解",
        "description": "适合教学视频、操作演示。每段预设步骤标题，溶解转场，清晰有序。",
        "category": "tutorial",
        "thumbnail": "",
        "segments": segments,
        "total_duration": total_duration,
        "transition": {"type": "dissolve", "duration": 0.6},
        "tags": ["教程", "教学", "步骤", "教育", "讲解"],
        "created_at": _now_iso(),
        "updated_at": _now_iso(),
        "is_builtin": True,
    }


def _create_festival_template() -> dict:
    """节日模板 — Festival celebration style with zoom transitions."""
    segments: list[dict] = []
    durations: list[float] = [3.0, 2.5, 2.0, 3.5, 2.0, 3.0, 2.5, 2.0, 3.5]

    for i, dur in enumerate(durations):
        seg: dict = _make_segment(
            order=i,
            duration=dur,
            transition_in_type="zoom" if i > 0 else "none",
            transition_out_type="zoom" if i < len(durations) - 1 else "none",
            transition_duration=0.3,
            volume=1.0,
            speed=1.05,
        )
        # Boost saturation for festive mood
        seg["filters"] = [
            {"type": "saturation", "value": 130},
            {"type": "contrast", "value": 110},
        ]
        segments.append(seg)

    # Opening and closing text overlays
    segments[0]["text_overlay"] = {
        "text": "节日快乐！",
        "font": '"Microsoft YaHei", sans-serif',
        "font_size": 48,
        "color": "#FFD700",
        "position": "center",
        "start_time": 0.3,
        "duration": 2.5,
    }

    total_duration: float = round(sum(durations), 2)

    return {
        "id": "builtin-festival-001",
        "name": "节日庆典",
        "description": "适合节日主题、庆祝活动的视频。缩放转场，高饱和度，喜庆氛围。",
        "category": "festival",
        "thumbnail": "",
        "segments": segments,
        "total_duration": total_duration,
        "transition": {"type": "zoom", "duration": 0.3},
        "tags": ["节日", "庆典", "喜庆", "聚会", "氛围"],
        "created_at": _now_iso(),
        "updated_at": _now_iso(),
        "is_builtin": True,
    }


def _create_slideshow_template() -> dict:
    """幻灯片模板 — Image slideshow with gentle fade transitions."""
    segments: list[dict] = []
    durations: list[float] = [3.0, 3.0, 3.0, 3.0, 3.0, 3.0, 3.0, 3.0, 3.0, 3.0]

    for i, dur in enumerate(durations):
        seg: dict = _make_segment(
            order=i,
            duration=dur,
            transition_in_type="fade" if i > 0 else "none",
            transition_out_type="fade" if i < len(durations) - 1 else "none",
            transition_duration=0.8,
            volume=0.0,  # Muted for slideshow
            speed=1.0,
        )

        # Caption overlay for each slide
        seg["text_overlay"] = {
            "text": f"第 {i + 1} 张",
            "font": '"Microsoft YaHei", sans-serif',
            "font_size": 28,
            "color": "#FFFFFF",
            "position": "bottom-center",
            "start_time": 0.5,
            "duration": 2.5,
        }

        segments.append(seg)

    total_duration: float = round(sum(durations), 2)

    return {
        "id": "builtin-slideshow-001",
        "name": "相册幻灯片",
        "description": "适合图片幻灯片、相册展示。柔和淡入淡出，每张图片带标题，适合回忆、旅行分享。",
        "category": "slideshow",
        "thumbnail": "",
        "segments": segments,
        "total_duration": total_duration,
        "transition": {"type": "fade", "duration": 0.8},
        "tags": ["幻灯片", "相册", "图片", "回忆", "旅行"],
        "created_at": _now_iso(),
        "updated_at": _now_iso(),
        "is_builtin": True,
    }


# ─── Builtin Template Registry ──────────────────────────────

BUILTIN_TEMPLATES: list[dict] = [
    _create_fast_paced_template(),
    _create_vlog_template(),
    _create_product_template(),
    _create_tutorial_template(),
    _create_festival_template(),
    _create_slideshow_template(),
]


def ensure_builtin_templates() -> None:
    """
    Ensure all built-in templates exist in the templates directory.

    Called on first access to template endpoints. Checks if each built-in
    template file exists; if not, generates and saves it.

    This function is idempotent — safe to call multiple times.
    """
    TEMPLATES_DIR.mkdir(parents=True, exist_ok=True)

    for template_data in BUILTIN_TEMPLATES:
        template_id: str = template_data.get("id", "")
        file_path: Path = TEMPLATES_DIR / f"{template_id}.json"

        if not file_path.exists():
            try:
                with open(file_path, "w", encoding="utf-8") as f:
                    json.dump(template_data, f, ensure_ascii=False, indent=2)
            except OSError:
                # Silently skip on write failure (e.g. permissions)
                pass

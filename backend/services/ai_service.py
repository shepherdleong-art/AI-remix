"""
AI Service module.

Provides:
- TTS (Text-to-Speech) via OpenAI-compatible API
- Vision-based video frame analysis
- Script-to-scene matching with AI
"""
import os
import asyncio
import base64
import json
import tempfile
import logging
from pathlib import Path
from typing import Optional

import httpx

from config import (
    AI_API_BASE_URL,
    AI_API_KEY,
    AI_TTS_MODEL,
    AI_VISION_MODEL,
    AI_TEXT_MODEL,
)

logger = logging.getLogger(__name__)

# ─── Retry / resilience helpers ────────────────────────────

# Retryable HTTP statuses for LLM API calls
_RETRYABLE_STATUSES: set[int] = {429, 502, 503, 504}
_MAX_RETRIES: int = 3
_RETRY_BACKOFF_BASE: float = 1.0  # seconds


async def _retry_with_backoff(
    fn,
    *args,
    max_retries: int = _MAX_RETRIES,
    backoff_base: float = _RETRY_BACKOFF_BASE,
    **kwargs,
):
    """Call an async function with exponential backoff on retryable errors."""
    last_exception = None
    for attempt in range(max_retries + 1):
        try:
            return await fn(*args, **kwargs)
        except httpx.HTTPStatusError as e:
            last_exception = e
            if e.response.status_code in _RETRYABLE_STATUSES and attempt < max_retries:
                delay = backoff_base * (2 ** attempt)
                logger.warning(
                    f"HTTP {e.response.status_code} on attempt {attempt + 1}/{max_retries + 1}, "
                    f"retrying in {delay:.1f}s"
                )
                await asyncio.sleep(delay)
                continue
            raise
        except (httpx.TimeoutException, httpx.ConnectError, httpx.RemoteProtocolError) as e:
            last_exception = e
            if attempt < max_retries:
                delay = backoff_base * (2 ** attempt)
                logger.warning(
                    f"Network error on attempt {attempt + 1}/{max_retries + 1}: {e}, "
                    f"retrying in {delay:.1f}s"
                )
                await asyncio.sleep(delay)
                continue
            raise
    raise last_exception  # type: ignore[misc]


def _extract_json_from_content(content: str, context: str = "response") -> str:
    """Extract JSON string from LLM response content.

    Handles:
    - Bare JSON array/object
    - JSON wrapped in ```json ... ``` blocks
    - JSON wrapped in ``` ... ``` blocks
    """
    content = content.strip()
    # Try bare JSON first
    if content.startswith("[") or content.startswith("{"):
        return content
    # Try ```json ... ``` block
    if "```json" in content:
        return content.split("```json")[1].split("```")[0].strip()
    # Try ``` ... ``` block
    if "```" in content:
        return content.split("```")[1].split("```")[0].strip()

    raise ValueError(
        f"Could not extract JSON from {context}. "
        f"Content starts with: {content[:200]}"
    )


def _validate_llm_response(data: dict, context: str = "response") -> None:
    """Validate that an LLM API response has the expected structure."""
    if not isinstance(data, dict):
        raise ValueError(f"Expected dict from LLM {context}, got {type(data).__name__}")
    if "choices" not in data:
        raise ValueError(f"Missing 'choices' in LLM {context}: keys={list(data.keys())}")
    choices = data.get("choices")
    if not isinstance(choices, list) or len(choices) == 0:
        raise ValueError(f"Empty or invalid 'choices' in LLM {context}")
    if "message" not in choices[0]:
        raise ValueError(f"Missing 'message' in first choice of LLM {context}")
    if "content" not in choices[0]["message"]:
        raise ValueError(f"Missing 'content' in message of LLM {context}")


def _headers(api_key: str = "") -> dict:
    key = api_key or AI_API_KEY
    return {
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    }


# ─── TTS ───────────────────────────────────────────────────

async def text_to_speech(
    text: str,
    voice: str = "alloy",
    output_path: Optional[str] = None,
    api_key: str = "",
    speed: float = 1.0,
) -> str:
    """
    Convert text to speech using AI TTS API.

    Args:
        text: Script text to speak.
        voice: Voice name.
        output_path: Where to save the MP3. If None, auto-generates temp path.
        speed: Speech speed multiplier (0.5 - 2.0).

    Returns:
        Path to the generated MP3 file.
    """
    key = api_key or AI_API_KEY
    if not key:
        raise ValueError("AI_API_KEY not configured. Set API key in the app or AI_API_KEY environment variable.")

    if not output_path:
        fd, output_path = tempfile.mkstemp(suffix=".mp3")
        os.close(fd)

    logger.info(f"TTS: {len(text)} chars, voice={voice}, speed={speed}, model={AI_TTS_MODEL}")

    async def _do_tts():
        async with httpx.AsyncClient(timeout=60.0) as client:
            body: dict = {
                "model": AI_TTS_MODEL,
                "input": text,
                "voice": voice,
            }
            if speed != 1.0:
                body["speed"] = speed
            resp = await client.post(
                f"{AI_API_BASE_URL}/audio/speech",
                headers=_headers(api_key),
                json=body,
            )
            if resp.status_code != 200:
                raise RuntimeError(f"TTS API error ({resp.status_code}): {resp.text[:500]}")
            return resp

    try:
        resp = await _retry_with_backoff(_do_tts)
    except Exception as e:
        raise RuntimeError(f"TTS API call failed after retries: {e}") from e

    content_type = resp.headers.get("content-type", "")

    # Case 1: OpenAI-compatible proxy returns raw audio bytes directly
    if "audio/" in content_type or "application/octet-stream" in content_type:
        with open(output_path, "wb") as f:
            f.write(resp.content)
        logger.info(f"TTS saved raw audio ({len(resp.content)} bytes)")
        return output_path

    # Case 2: Qwen native — JSON with download URL
    try:
        data = resp.json()
    except Exception:
        # Not JSON, save as raw bytes
        with open(output_path, "wb") as f:
            f.write(resp.content)
        logger.info(f"TTS saved non-JSON response ({len(resp.content)} bytes)")
        return output_path

    # Check for download URL (Qwen native format)
    audio_url = data.get("output", {}).get("audio", {}).get("url", "")
    if audio_url:
        async with httpx.AsyncClient(timeout=60.0) as client:
            dl_resp = await client.get(audio_url)
            if dl_resp.status_code != 200:
                raise RuntimeError(f"Failed to download TTS audio ({dl_resp.status_code})")
            with open(output_path, "wb") as f:
                f.write(dl_resp.content)
            logger.info(f"TTS downloaded from URL ({len(dl_resp.content)} bytes)")
            return output_path

    # Check for base64 data (Qwen alt format)
    audio_b64 = data.get("output", {}).get("audio", {}).get("data", "")
    if audio_b64:
        raw = base64.b64decode(audio_b64)
        with open(output_path, "wb") as f:
            f.write(raw)
        logger.info(f"TTS decoded base64 ({len(raw)} bytes)")
        return output_path

    raise RuntimeError(f"TTS API returned unrecognized format: {resp.text[:500]}")


# ─── Vision Analysis ──────────────────────────────────────

async def analyze_frame(image_path: str, prompt: str, api_key: str = "") -> str:
    """
    Analyze a single video frame/image using a vision model.

    Args:
        image_path: Path to JPEG/PNG image.
        prompt: What to ask about the image.

    Returns:
        Model's text response.
    """
    key = api_key or AI_API_KEY
    if not key:
        raise ValueError("AI_API_KEY not configured")

    # Read and encode image
    with open(image_path, "rb") as f:
        image_b64 = base64.b64encode(f.read()).decode("utf-8")

    ext = Path(image_path).suffix.lower()
    mime = "image/jpeg" if ext in (".jpg", ".jpeg") else "image/png"

    async def _do_vision():
        async with httpx.AsyncClient(timeout=120.0) as client:
            resp = await client.post(
                f"{AI_API_BASE_URL}/chat/completions",
                headers=_headers(api_key),
                json={
                    "model": AI_VISION_MODEL,
                    "messages": [
                        {
                            "role": "user",
                            "content": [
                                {"type": "text", "text": prompt},
                                {
                                    "type": "image_url",
                                    "image_url": {
                                        "url": f"data:{mime};base64,{image_b64}"
                                    },
                                },
                            ],
                        }
                    ],
                    "max_tokens": 500,
                },
            )
            if resp.status_code != 200:
                raise RuntimeError(f"Vision API error ({resp.status_code}): {resp.text[:500]}")
            return resp

    try:
        resp = await _retry_with_backoff(_do_vision)
    except Exception as e:
        raise RuntimeError(f"Vision API call failed after retries: {e}") from e

    data = resp.json()
    _validate_llm_response(data, "vision analysis")
    return data["choices"][0]["message"]["content"]


# Maximum concurrent vision API requests (avoid triggering rate limits)
_VISION_MAX_CONCURRENT: int = int(os.environ.get("MASHUP_VISION_CONCURRENT", "5"))
_vision_semaphore: asyncio.Semaphore = asyncio.Semaphore(_VISION_MAX_CONCURRENT)


async def _analyze_frame_with_semaphore(
    frame_path: str,
    prompt: str,
    api_key: str,
    index: int,
) -> tuple[int, str]:
    """Analyze a single frame with concurrency control. Returns (index, result)."""
    async with _vision_semaphore:
        try:
            result = await analyze_frame(frame_path, prompt, api_key)
            return (index, result.strip())
        except Exception as e:
            return (index, f"[分析失败] {str(e)[:100]}")


async def analyze_frames_batch(
    frame_paths: list[str],
    descriptions: list[str],
    api_key: str = "",
) -> list[str]:
    """
    Analyze multiple video frames concurrently and describe each.

    Uses asyncio.gather + Semaphore to limit concurrent API calls,
    avoiding server-side rate limiting while maximizing throughput.

    Args:
        frame_paths: List of paths to frame images.
        descriptions: List of contextual prompts for each frame.

    Returns:
        List of AI-generated scene descriptions (in same order as input).
    """
    tasks = []
    for i, (fp, desc) in enumerate(zip(frame_paths, descriptions)):
        prompt = f"简要描述这个视频画面的内容（1-2句话）：{desc}"
        tasks.append(_analyze_frame_with_semaphore(fp, prompt, api_key, i))

    # gather preserves insertion order
    results_with_index = await asyncio.gather(*tasks)

    # Sort by original index and extract results
    sorted_results = sorted(results_with_index, key=lambda x: x[0])
    return [r[1] for r in sorted_results]


# ─── Script Analysis & Scene Matching ────────────────────

async def analyze_script(script: str, api_key: str = "") -> list[dict]:
    """
    Analyze the narration script and break it into semantic segments.

    Returns list of segments:
    [{index, text, keywords, duration_hint}, ...]
    """
    key = api_key or AI_API_KEY
    if not key:
        raise ValueError("AI_API_KEY not configured")

    prompt = f"""你是一个短视频编辑AI。请将以下口播文案拆分为3-5个语义片段，
每个片段对应一段画面。15秒的口播大约150-200字。

对每个片段提取：
1. 片段文本内容
2. 3-5个画面关键词（用于匹配视频素材）
3. 建议时长（秒）

口播文案：
{script}

请以JSON数组格式输出，每个元素包含: index, text, keywords(数组), duration_hint(数字)。
只输出JSON，不要其他内容。"""

    logger.info(f"Analyzing script ({len(script)} chars) via {AI_API_BASE_URL} model={AI_TEXT_MODEL}")

    async def _do_script_analysis():
        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.post(
                f"{AI_API_BASE_URL}/chat/completions",
                headers=_headers(api_key),
                json={
                    "model": AI_TEXT_MODEL,
                    "messages": [{"role": "user", "content": prompt}],
                    "max_tokens": 1000,
                    "temperature": 0.3,
                },
            )
            if resp.status_code != 200:
                err_text = resp.text[:500]
                logger.error(f"Script analysis API error ({resp.status_code}): {err_text}")
                raise RuntimeError(f"Script analysis error ({resp.status_code}): {err_text}")
            return resp

    try:
        resp = await _retry_with_backoff(_do_script_analysis)
    except Exception as e:
        raise RuntimeError(f"Script analysis failed after retries: {e}") from e

    data = resp.json()
    _validate_llm_response(data, "script analysis")
    content = data["choices"][0]["message"]["content"]

    # Extract JSON from response (handles ```json blocks, bare JSON, etc.)
    json_str = _extract_json_from_content(content, "script analysis")
    try:
        segments = json.loads(json_str)
    except json.JSONDecodeError as e:
        raise ValueError(
            f"Failed to parse script analysis JSON: {e}\n"
            f"Raw content (first 500 chars): {content[:500]}"
        ) from e
    return segments


async def match_scenes_to_segments(
    segments: list[dict],
    scenes: list[dict],
    api_key: str = "",
) -> list[dict]:
    """
    Match AI-analyzed script segments to video scenes.

    Args:
        segments: Script segments [{index, text, keywords, duration_hint}, ...].
        scenes: Video scenes [{description, video_path, start, end, duration}, ...].

    Returns:
        Timeline: [{segment_index, segment_text, video_path, start_time, duration, reason}, ...]
    """
    key = api_key or AI_API_KEY
    if not key:
        raise ValueError("AI_API_KEY not configured")

    segment_text = "\n".join(
        f"片段{s['index']}: \"{s['text']}\" 关键词: {', '.join(s.get('keywords',[]))}"
        for s in segments
    )
    scene_text = "\n".join(
        f"场景{i}: {s['description']}"
        for i, s in enumerate(scenes)
    )

    prompt = f"""你是视频剪辑AI。请将以下口播片段匹配到最合适的视频场景。

口播片段：
{segment_text}

可用视频场景：
{scene_text}

为每个口播片段选择最匹配的场景编号，输出JSON数组格式：
[{{"segment_index": 0, "best_scene": 2, "reason": "..."}}, ...]
只输出JSON，不要其他内容。"""

    async def _do_match():
        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.post(
                f"{AI_API_BASE_URL}/chat/completions",
                headers=_headers(api_key),
                json={
                    "model": AI_TEXT_MODEL,
                    "messages": [{"role": "user", "content": prompt}],
                    "max_tokens": 800,
                    "temperature": 0.3,
                },
            )
            if resp.status_code != 200:
                raise RuntimeError(f"Scene matching error ({resp.status_code}): {resp.text[:500]}")
            return resp

    try:
        resp = await _retry_with_backoff(_do_match)
    except Exception as e:
        raise RuntimeError(f"Scene matching failed after retries: {e}") from e

    data = resp.json()
    _validate_llm_response(data, "scene matching")
    content = data["choices"][0]["message"]["content"]

    json_str = _extract_json_from_content(content, "scene matching")
    try:
        matches = json.loads(json_str)
    except json.JSONDecodeError as e:
        raise ValueError(
            f"Failed to parse scene matching JSON: {e}\n"
            f"Raw content (first 500 chars): {content[:500]}"
        ) from e

    # Build timeline with original video paths and timestamps
    timeline = []
    used_scenes: set = set()
    for m in matches:
        seg_idx = m["segment_index"]
        scene_idx = m["best_scene"]
        if not (0 <= seg_idx < len(segments)):
            continue
        if not (0 <= scene_idx < len(scenes)):
            continue

        sc = scenes[scene_idx]
        seg = segments[seg_idx]
        seg_duration = seg.get("duration_hint", 3.0)
        scene_duration = sc.get("duration", 5.0)

        # Clamp segment duration to available scene length
        actual_dur = min(float(seg_duration), float(scene_duration))
        start_offset = sc.get("start", 0.0)

        timeline.append({
            "segment_index": seg_idx,
            "segment_text": seg["text"],
            "video_path": sc["video_path"],
            "start_time": float(start_offset),
            "duration": actual_dur,
            "source_duration": float(sc.get("duration", scene_duration)),
            "reason": m.get("reason", ""),
        })
        used_scenes.add(scene_idx)

    return timeline

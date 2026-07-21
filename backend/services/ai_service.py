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
import re
import subprocess
import uuid
from pathlib import Path
from typing import Optional

import httpx

from config import (
    AI_API_BASE_URL,
    AI_API_KEY,
    AI_TTS_MODEL,
    AI_VISION_MODEL,
    AI_TEXT_MODEL,
    TTS_PROVIDER,
    DOUBAO_WSS_URL,
    DOUBAO_RESOURCE_ID,
    DOUBAO_VOICES,
    DOUBAO_MODEL,
    DOUBAO_DEFAULT_VOICE,
    DOUBAO_API_KEY,
    DOUBAO_APP_KEY,
    DOUBAO_ACCESS_KEY,
    FFMPEG_EXECUTABLE,
)

from services.doubao_proto import (
    connect as doubao_connect,
    send_event as doubao_send_event,
    recv_message as doubao_recv_message,
    EventType as DEvent,
    MsgType as DMsgType,
)

# 音频优先匹配：约束求解器 + 节拍检测（纯标准库 / 复用 video_service._ffmpeg）
from services.match_solver import MatchSolver
from services.beat_detect import BeatDetector

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

def _ffmpeg_bin() -> str:
    """Locate ffmpeg binary. Prefers FFMPEG_PATH; falls back to the bundled
    ffmpeg resolved by config.FFMPEG_EXECUTABLE (never bare 'ffmpeg', which
    is usually absent from PATH in packaged/standalone runs)."""
    p = os.environ.get("FFMPEG_PATH", "")
    if p and os.path.exists(p):
        return p
    return FFMPEG_EXECUTABLE


def normalize_audio(path: str, sr: int = 44100) -> str:
    """Re-encode audio to a standardized, player-safe format:
    44100 Hz, mono, MP3 (libmp3lame). Fixes two latent issues:
      - backend may save a WAV payload under a .mp3 extension (Qwen returns WAV),
      - non-standard 24000 Hz output can be mis-handled by some players.
    Replaces `path` in place; on any failure returns the original untouched.
    """
    tmp = f"{path}.norm.tmp.mp3"
    try:
        r = subprocess.run(
            [_ffmpeg_bin(), "-y", "-i", path,
             "-ar", str(sr), "-ac", "1", "-c:a", "libmp3lame", "-b:a", "128k", tmp],
            capture_output=True, text=True, timeout=120,
        )
        if r.returncode != 0 or not os.path.exists(tmp):
            logger.warning(f"normalize_audio failed (rc={r.returncode}): {r.stderr[-300:]}")
            return path
        os.replace(tmp, path)
    except Exception as e:
        logger.warning(f"normalize_audio error: {e}")
        return path
    return path


# Chinese language lock for multilingual TTS.
# qwen3-tts-flash (via the 3rd-party proxy) auto-detects language from the
# input text. Pure-CJK sentences with NO Chinese-exclusive function word
# (e.g. product-phrase copy like "高回弹海绵，久坐不塌。") are frequently
# mis-read as JAPANESE. Prepending a Chinese anchor word forces the model to
# detect Chinese. The anchor is configurable; it only applies to at-risk
# sentences so normal narration is never altered.
TTS_CN_ANCHOR = os.environ.get("TTS_CN_ANCHOR", "这款")

# Characters that ONLY appear in Chinese (not in Japanese kana, and not shared
# Sino-Japanese ideographs like 不/好/大) and strongly signal "this is Chinese"
# to the detector. If any is present, the sentence is considered safe and no
# anchor is added. NOTE: 不 is deliberately excluded — it appears in the failing
# sentence "久坐不塌" yet was still mis-read as Japanese, so it is NOT a reliable
# Chinese signal.
_CN_MARKERS = set(
    "的了吗呢啊哦呀啦咯嘛呗吧着过们我这那哪怎什么谁把被让给和跟与或但"
    "因所以在于是没别都也很太更最就才又再要会能可该得地时里下中个"
    "些种件台辆本其此等及并且若如虽各每诸余"
)
import re as _re

_CJK_IDEO = _re.compile(r"[\u4e00-\u9fff]")


def _needs_cn_anchor(text: str) -> bool:
    """True if the sentence is at risk of being read as Japanese:
    it contains CJK ideographs but no Chinese-exclusive marker character."""
    if not _CJK_IDEO.search(text or ""):
        return False
    if any(ch in _CN_MARKERS for ch in (text or "")):
        return False
    return True


def _apply_cn_anchor(text: str) -> str:
    """Prepend a configurable Chinese anchor to at-risk sentences so the
    multilingual TTS model reads them as Chinese instead of Japanese."""
    if _needs_cn_anchor(text):
        logger.info(f"[TTS-CN-LOCK] anchored at-risk sentence: {text!r} -> {TTS_CN_ANCHOR}{text!r}")
        return f"{TTS_CN_ANCHOR}{text}"
    return text


async def _qwen_tts(
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
            tts_input = _apply_cn_anchor(text)
            body: dict = {
                "model": AI_TTS_MODEL,
                "input": tts_input,
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
        return normalize_audio(output_path)

    # Case 2: Qwen native — JSON with download URL
    try:
        data = resp.json()
    except Exception:
        # Not JSON, save as raw bytes
        with open(output_path, "wb") as f:
            f.write(resp.content)
        logger.info(f"TTS saved non-JSON response ({len(resp.content)} bytes)")
        return normalize_audio(output_path)

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
            return normalize_audio(output_path)

    # Check for base64 data (Qwen alt format)
    audio_b64 = data.get("output", {}).get("audio", {}).get("data", "")
    if audio_b64:
        raw = base64.b64decode(audio_b64)
        with open(output_path, "wb") as f:
            f.write(raw)
        logger.info(f"TTS decoded base64 ({len(raw)} bytes)")
        return normalize_audio(output_path)

    raise RuntimeError(f"TTS API returned unrecognized format: {resp.text[:500]}")


# ─── Doubao (Volcano Engine) TTS provider ─────────────────
# Uses the official bidirectional WebSocket protocol. Critically, it sets
# `explicit_language: "zh-cn"` in the session params — this is ByteDance's
# native "read as Chinese only" switch, which 100% prevents the multilingual
# model from mis-reading pure-CJK copy (e.g. "高回弹海绵，久坐不塌。") as
# Japanese. No anchor word needed — the script text is passed verbatim.

async def doubao_tts(
    text: str,
    voice: str = "",
    output_path: Optional[str] = None,
    api_key: str = "",
    app_key: str = "",
    access_key: str = "",
    speed: float = 1.0,
) -> str:
    """Synthesize speech via Doubao (Volcano Engine) bidirectional TTS.

    Returns the path to a normalized MP3 file. Uses explicit_language=zh-cn
    so all Chinese copy is read correctly without any text alteration.

    Auth (per official Volcano Engine bidirection docs): either
      - a single API Key (new console) sent as ``X-Api-Key``
        (``api_key`` / env ``DOUBAO_API_KEY``), OR
      - a matched App-Key + Access-Key pair (old console)
        (``app_key``/``access_key`` / env ``DOUBAO_APP_KEY``/``DOUBAO_ACCESS_KEY``).
    The single ``api_key`` takes precedence when provided.
    """
    api_key = api_key or DOUBAO_API_KEY
    app_key = app_key or DOUBAO_APP_KEY
    access_key = access_key or DOUBAO_ACCESS_KEY
    if not (api_key or (app_key and access_key)):
        raise ValueError(
            "Doubao TTS requires either a single API Key (X-Api-Key) or a "
            "matched App-Key + Access-Key pair."
        )
    if not voice:
        voice = DOUBAO_DEFAULT_VOICE
    if not output_path:
        fd, output_path = tempfile.mkstemp(suffix=".mp3")
        os.close(fd)

    speaker = voice
    # 资源 ID 必须与该音色同属一个资源池，否则报
    # "resource ID is mismatched with speaker related resource"。
    # 经典版音色(zh_female_qingxin 等) → volc.service_type.10029；
    # 大模型音色(zh_female_vv_uranus_bigtts 等) → seed-tts-2.0。
    # 按音色查其所属资源池，查不到则回落到 DOUBAO_RESOURCE_ID 默认值。
    resource_id = DOUBAO_RESOURCE_ID
    for _v in DOUBAO_VOICES:
        if _v.get("id") == speaker and _v.get("resource_id"):
            resource_id = _v["resource_id"]
            break
    session_id = str(uuid.uuid4())
    connect_id = str(uuid.uuid4())
    # Doubao speech_rate: int [-50,100]; 100=2.0x, -50=0.5x, 0=1.0x
    speech_rate = max(-50, min(100, int(round((speed - 1.0) * 100))))

    # Bidirection protocol payloads (per Volcano Engine official docs / working
    # reference impl): the text must live under ``req_params`` (top-level
    # ``text`` is ignored, which made the server sit silent). ``namespace``,
    # ``user.uid`` and ``event`` are required envelope fields. session_id is
    # carried in the binary frame header, not the JSON body.
    audio_params = {
        "format": "mp3",
        "sample_rate": 24000,
        "speech_rate": speech_rate,
        "loudness_rate": 0,
        "explicit_language": "zh-cn",
    }
    additions = json.dumps({"disable_markdown_filter": True})
    uid = str(uuid.uuid4())
    start_session_payload = json.dumps({
        "user": {"uid": uid},
        "namespace": "BidirectionalTTS",
        "event": int(DEvent.StartSession),
        "req_params": {
            "speaker": speaker,
            "audio_params": audio_params,
            "additions": additions,
        },
    }).encode("utf-8")
    task_payload = json.dumps({
        "user": {"uid": uid},
        "namespace": "BidirectionalTTS",
        "event": int(DEvent.TaskRequest),
        "req_params": {
            "speaker": speaker,
            "audio_params": audio_params,
            "additions": additions,
            "text": text,
        },
    }).encode("utf-8")

    audio_chunks: list[bytes] = []
    conn = await doubao_connect(
        DOUBAO_WSS_URL,
        api_key=api_key,
        app_key=app_key,
        access_key=access_key,
        resource_id=resource_id,
        connect_id=connect_id,
    )
    try:
        async with conn:
            await doubao_send_event(conn, DEvent.StartConnection, "", b"{}")
            await _doubao_expect(conn, DEvent.ConnectionStarted)
            await doubao_send_event(conn, DEvent.StartSession, session_id, start_session_payload)
            await _doubao_expect(conn, DEvent.SessionStarted)
            await doubao_send_event(conn, DEvent.TaskRequest, session_id, task_payload)
            # Tell the server we're done sending text so it flushes audio and
            # emits SessionFinished. Without this frame the session hangs open.
            await doubao_send_event(conn, DEvent.FinishSession, session_id, b"{}")

            while True:
                msg = await doubao_recv_message(conn)
                if msg.type == DMsgType.AudioOnlyServer:
                    if msg.payload:
                        audio_chunks.append(msg.payload)
                elif msg.type == DMsgType.FullServerResponse and msg.event == DEvent.TTSResponse:
                    try:
                        d = json.loads(msg.payload.decode("utf-8", "ignore"))
                        a = d.get("audio") or d.get("data") or ""
                        if a:
                            audio_chunks.append(base64.b64decode(a))
                    except Exception:
                        pass
                elif msg.event == DEvent.SessionFinished:
                    break
                elif msg.type == DMsgType.Error or msg.event in (
                    DEvent.SessionFailed, DEvent.ConnectionFailed
                ):
                    detail = msg.payload.decode("utf-8", "ignore")[:300]
                    raise RuntimeError(f"Doubao TTS error: {detail}")
    except RuntimeError:
        raise
    except Exception as e:
        raise RuntimeError(f"Doubao TTS WebSocket error: {e}") from e

    if not audio_chunks:
        raise RuntimeError("Doubao TTS returned no audio data.")
    with open(output_path, "wb") as f:
        for c in audio_chunks:
            f.write(c)
    logger.info(f"Doubao TTS saved {len(audio_chunks)} chunks -> {output_path}")
    return normalize_audio(output_path)


async def _doubao_expect(conn, event_type: DEvent) -> None:
    """Receive one message and assert it is the expected event (or raise)."""
    msg = await doubao_recv_message(conn)
    if msg.event == event_type:
        return
    if msg.type == DMsgType.Error or msg.event in (DEvent.SessionFailed, DEvent.ConnectionFailed):
        detail = msg.payload.decode("utf-8", "ignore")[:300]
        raise RuntimeError(f"Doubao TTS unexpected failure ({msg.event}): {detail}")
    # Non-fatal out-of-order event (e.g. TTSSentenceStart) — keep waiting.
    logger.warning(f"[Doubao] expected {event_type}, got {msg.event}; continuing")


async def text_to_speech(
    text: str,
    voice: str = "alloy",
    output_path: Optional[str] = None,
    api_key: str = "",
    speed: float = 1.0,
    provider: str = "qwen",
    app_key: str = "",
    access_key: str = "",
) -> str:
    """Convert text to speech, dispatching by TTS provider.

    Args:
        provider: "qwen" (default, OpenAI-compatible HTTP via AI_API_BASE_URL,
                  with the Chinese-language anchor safety net) or "doubao"
                  (Volcano Engine WebSocket, native explicit_language=zh-cn).
        app_key / access_key: Doubao (Volcano Engine) matched credential pair.
    """
    provider = (provider or TTS_PROVIDER or "qwen").lower()
    if provider == "doubao":
        return await doubao_tts(
            text, voice, output_path, api_key, app_key, access_key, speed
        )
    return await _qwen_tts(text, voice, output_path, api_key, speed)


# ─── Vision Analysis ──────────────────────────────────────

async def analyze_frame(image_path: str, prompt: str, api_key: str = "", model: str = "") -> str:
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
                    "model": model or AI_VISION_MODEL,
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
    model: str = "",
) -> tuple[int, str]:
    """Analyze a single frame with concurrency control. Returns (index, result)."""
    async with _vision_semaphore:
        try:
            result = await analyze_frame(frame_path, prompt, api_key, model)
            return (index, result.strip())
        except Exception as e:
            return (index, f"[分析失败] {str(e)[:100]}")


async def analyze_frames_batch(
    frame_paths: list[str],
    descriptions: list[str],
    api_key: str = "",
    model: str = "",
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
        tasks.append(_analyze_frame_with_semaphore(fp, prompt, api_key, i, model))

    # gather preserves insertion order
    results_with_index = await asyncio.gather(*tasks)

    # Sort by original index and extract results
    sorted_results = sorted(results_with_index, key=lambda x: x[0])
    return [r[1] for r in sorted_results]


# ─── Script Analysis & Scene Matching ────────────────────

async def analyze_script(script: str, api_key: str = "", model: str = "") -> list[dict]:
    """
    Analyze the narration script and break it into semantic segments.

    Returns list of segments:
    [{index, text, keywords, duration_hint}, ...]
    """
    key = api_key or AI_API_KEY
    if not key:
        raise ValueError("AI_API_KEY not configured")

    prompt = f"""你是一个短视频编辑AI。请将以下口播文案按语义自然断句拆分为5-8个片段，每个片段对应一句口播画面。15秒的口播大约150-200字。

对每个片段提取：
1. 片段文本内容
2. 3-5个画面关键词（用于匹配视频素材）
3. 建议时长（秒）

注意：duration_hint 仅作上下文参考，真实时长以 TTS 为准，不要在这里臆测精确时长。

口播文案：
{script}

请以JSON数组格式输出，每个元素包含: index, text, keywords(数组), duration_hint(数字)。
只输出JSON，不要其他内容。"""

    logger.info(f"Analyzing script ({len(script)} chars) via {AI_API_BASE_URL} model={model or AI_TEXT_MODEL}")

    async def _do_script_analysis():
        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.post(
                f"{AI_API_BASE_URL}/chat/completions",
                headers=_headers(api_key),
                json={
                    "model": model or AI_TEXT_MODEL,
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


def _force_split_segments(segments: list[dict], min_count: int = 3) -> list[dict]:
    """If AI returns too few segments, forcibly split longer ones at punctuation."""
    if len(segments) >= min_count:
        return segments
    result = []
    for seg in segments:
        text = seg.get("text", "")
        dur = seg.get("duration_hint", 2)
        keywords = seg.get("keywords", [])
        # Split at Chinese/English punctuation
        parts = re.split(r'(?<=[，,。！？；：.!?;:])', text)
        parts = [p.strip() for p in parts if p.strip()]
        if len(parts) <= 1:
            result.append(seg)
            continue
        sub_dur = dur / len(parts)
        for j, part in enumerate(parts):
            result.append({
                "index": len(result),
                "text": part,
                "keywords": keywords,
                "duration_hint": round(sub_dur, 1),
            })
    return result if len(result) >= min_count else result + segments[len(result):]


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


# ─── Audio-First Match（音频优先混合匹配） ─────────────────


async def _llm_score_matrix(
    segments: list[dict],
    scenes: list[dict],
    api_key: str = "",
    model: str = "",
) -> tuple[list[list[float]], list[float]]:
    """调用 LLM 一次性产出『每句 × 每素材』语义相关分矩阵 [n][m]，取值 0-1。

    同时让模型产出每个素材的「钩子吸引力」 hook_scores（长度 m 的一维数组，取值 0-1），
    用于 Hook-first：开场段优先选钩子分高的素材。同一通 LLM 调用多问一句，零额外耗时。

    Returns:
        (score_matrix, hook_scores):
            score_matrix: list[list[float]]，形状 n(句) × m(素材)，元素 ∈ [0, 1]；
            hook_scores:  list[float]，长度 m，每个素材作为开场钩子的吸引力 ∈ [0, 1]。
    """
    key = api_key or AI_API_KEY
    if not key:
        raise ValueError("AI_API_KEY not configured")

    n = len(segments)
    m = len(scenes)
    if n == 0 or m == 0:
        raise ValueError("segments 与 scenes 均不能为空")

    seg_lines = "\n".join(
        f"句{i}: \"{s.get('text', '')}\" 关键词: {', '.join(s.get('keywords', []))}"
        for i, s in enumerate(segments)
    )
    scene_lines = "\n".join(
        f"素材{j}: {sc.get('description', '')}"
        for j, sc in enumerate(scenes)
    )
    prompt = f"""你是视频剪辑AI。请为下面的口播句逐一评估与每个视频素材的语义相关程度，并为每个素材评估「开场钩子吸引力」。

口播句（共{n}句）：
{seg_lines}

视频素材（共{m}个）：
{scene_lines}

请输出一个 JSON 对象，含两个字段：
1) "score_matrix"：二维数组，形状为 {n} 行（句）× {m} 列（素材）。score_matrix[i][j] 表示第 i 句与第 j 个素材的语义相关分，取值范围 0.0~1.0（1.0 最相关）。
2) "hook_scores"：一维数组，长度 {m}，hook_scores[j] 表示第 j 个素材作为「开场钩子」的吸引力（能否一眼抓住观众、制造好奇/冲击），取值范围 0.0~1.0（1.0 最吸睛）。

只输出 JSON 对象，不要其他内容。"""

    async def _do_score():
        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.post(
                f"{AI_API_BASE_URL}/chat/completions",
                headers=_headers(api_key),
                json={
                    "model": model or AI_TEXT_MODEL,
                    "messages": [{"role": "user", "content": prompt}],
                    "max_tokens": 1500,
                    "temperature": 0.2,
                },
            )
            if resp.status_code != 200:
                raise RuntimeError(f"Score matrix error ({resp.status_code}): {resp.text[:300]}")
            return resp

    try:
        resp = await _retry_with_backoff(_do_score)
    except Exception as e:
        raise RuntimeError(f"Score matrix failed after retries: {e}") from e

    data = resp.json()
    _validate_llm_response(data, "score matrix")
    content = data["choices"][0]["message"]["content"]

    json_str = _extract_json_from_content(content, "score matrix")
    try:
        parsed = json.loads(json_str)
    except json.JSONDecodeError as e:
        raise ValueError(
            f"Failed to parse score matrix JSON: {e}\n"
            f"Raw content (first 300 chars): {content[:300]}"
        ) from e

    # 兼容：模型可能仍只回二维数组（旧格式）→ hook_scores 全 0
    if isinstance(parsed, dict):
        matrix_raw = parsed.get("score_matrix", parsed)
        hook_raw = parsed.get("hook_scores", [0.0] * m)
    else:
        matrix_raw = parsed
        hook_raw = [0.0] * m

    # 规整为 n×m 浮点矩阵，元素截断到 [0, 1]
    norm: list[list[float]] = []
    for i in range(n):
        row = matrix_raw[i] if i < len(matrix_raw) else []
        new_row: list[float] = []
        for j in range(m):
            v = row[j] if j < len(row) else 0.0
            try:
                v = float(v)
            except (TypeError, ValueError):
                v = 0.0
            new_row.append(max(0.0, min(1.0, v)))
        norm.append(new_row)

    # 规整 hook_scores 为一维长度 m，截断到 [0, 1]
    hook_scores: list[float] = []
    for j in range(m):
        v = hook_raw[j] if j < len(hook_raw) else 0.0
        try:
            v = float(v)
        except (TypeError, ValueError):
            v = 0.0
        hook_scores.append(max(0.0, min(1.0, v)))

    return norm, hook_scores


async def match_scenes_audio_first(
    segments: list[dict],
    seg_durations: list[float],
    scenes: list[dict],
    api_key: str = "",
    beat_points: list[float] | None = None,
    options: dict | None = None,
    model: str = "",
) -> dict:
    """音频优先匹配编排（V2）：LLM 打分 → 约束求解器 → 可选节拍吸附 → 不变量校验。

    时长唯一基准为 ``seg_durations``（来自 split-tts），求解器令每段 duration = seg_durations[i]，
    由构造保证 ``Σduration == Σseg_durations == total_duration``，从根上消除结尾冻结。

    Args:
        segments: 口播片段（来自 analyze-script，与 split-tts 同一数组）。
        seg_durations: 每句真实时长（来自 split-tts）。
        scenes: 素材场景列表（含 video_path/start/end/duration）。
        api_key: LLM API Key。
        beat_points: 可选，来自 /detect-beats 的推荐切点（秒）。
        options: 可选，覆盖默认参数 {red_line, coverage_penalty, candidate_window}。

    Returns:
        {
            "timeline": [...],            # 每项含完整 Assignment 字段
            "total_duration": float,      # == Σseg_durations
            "debug": {                     # 可观测性（P2）
                "used_materials": int,
                "total_materials": int,
                "feasible": bool,
                "red_line": float,
                "coverage_penalty": float,
                "candidate_window": float,
                "backoff_segments": list[int],
            },
        }
    """
    n = len(segments)
    m = len(scenes)

    if n == 0:
        return {
            "timeline": [],
            "total_duration": 0.0,
            "debug": {
                "used_materials": 0,
                "total_materials": 0,
                "feasible": True,
                "red_line": 0.35,
                "coverage_penalty": 0.15,
                "candidate_window": 0.10,
                "backoff_segments": [],
            },
        }
    if m == 0:
        raise ValueError("没有可用素材场景，无法匹配")

    opts = options or {}
    red_line = float(opts.get("red_line", 0.35))
    coverage_penalty = float(opts.get("coverage_penalty", 0.15))
    candidate_window = float(opts.get("candidate_window", 0.10))

    # 1) 语义分矩阵 + 钩子分（失败则用均匀回退矩阵 + 零钩子分）
    try:
        score_matrix, llm_hook = await _llm_score_matrix(segments, scenes, api_key, model)
    except Exception as e:
        logger.warning(f"[MATCH] LLM 打分失败，使用均匀回退矩阵: {e}")
        score_matrix = [[0.6 for _ in range(m)] for _ in range(n)]
        llm_hook = [0.0] * m

    # 防御性规整形状
    if len(score_matrix) != n or any(len(r) != m for r in score_matrix):
        score_matrix = MatchSolver._normalize_matrix(score_matrix, n, m)

    # 钩子分合并：手动 isHook 素材强制 hook=1.0（覆盖 LLM 自动分），优先做开场钩子
    hook_scores = [
        1.0 if sc.get("isHook") else (llm_hook[j] if j < len(llm_hook) else 0.0)
        for j, sc in enumerate(scenes)
    ]

    # 2) 约束求解器（贪心 + 局部回退 + 覆盖惩罚 + 可选节拍吸附 + 开场钩子偏好）
    solver = MatchSolver(
        red_line=red_line,
        coverage_penalty=coverage_penalty,
        candidate_window=candidate_window,
    )
    segment_texts = [
        (s.get("text", "") or s.get("segment_text", "")) for s in segments
    ]
    timeline = solver.solve(
        seg_durations,
        scenes,
        score_matrix,
        beat_points=beat_points,
        segment_texts=segment_texts,
        hook_scores=hook_scores,
    )

    # 3) 组装可观测 debug
    total_duration = float(sum(float(d) for d in seg_durations))
    used_videos = {t["video_path"] for t in timeline if t["video_path"]}
    total_videos = {sc.get("video_path", "") for sc in scenes}
    debug = {
        "used_materials": len(used_videos),
        "total_materials": len(total_videos),
        "feasible": bool(solver.feasible),
        "red_line": red_line,
        "coverage_penalty": coverage_penalty,
        "candidate_window": candidate_window,
        "backoff_segments": list(solver.backoff_segments),
    }
    return {"timeline": timeline, "total_duration": total_duration, "debug": debug}

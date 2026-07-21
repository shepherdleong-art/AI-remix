"""
AI-powered voiceover editing API routes.

Endpoints:
    POST /api/ai-editing/analyze-script    — Analyze script into segments
    POST /api/ai-editing/analyze-video     — Scene detection + AI description
    POST /api/ai-editing/match-scenes      — Match script segments to video scenes
    POST /api/ai-editing/composite         — Composite video + TTS audio
    POST /api/ai-editing/full-pipeline     — Run the entire pipeline
"""
import os
import json
import logging
import subprocess
import hashlib
import tempfile
import glob
from datetime import datetime
from pathlib import Path
import asyncio

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response, FileResponse

from services.ai_service import (
    text_to_speech,
    analyze_script,
    analyze_frames_batch,
    match_scenes_to_segments,
    match_scenes_audio_first,
)
from services.video_service import (
    detect_scenes,
    extract_scene_frames,
    composite_clip,
    get_audio_duration,
    render_cover,
    _probe_audio_stream,
)
from services.video_service import _ffmpeg  # used by /thumb and /video endpoints
from services.beat_detect import BeatDetector
from services.scene_cache import scene_cache
from config import TEMP_DIR, FFMPEG_EXECUTABLE, DOUBAO_VOICES
import os
import logging
import time

logger = logging.getLogger(__name__)

# Diagnostic log persisted to a file (not only stdout) so it can be inspected
# without access to the Electron-spawned backend console.
_MIX_LOG_PATH = Path(__file__).resolve().parent.parent.parent / "_bgm_mix.log"


def _append_mix_log(msg: str) -> None:
    try:
        ts = time.strftime("%Y-%m-%d %H:%M:%S")
        with open(_MIX_LOG_PATH, "a", encoding="utf-8") as fh:
            fh.write(f"[{ts}] {msg}\n")
    except Exception:
        pass


router = APIRouter(prefix="/api/ai-editing", tags=["ai-editing"])


def _ok(data=None, msg="success"):
    return {"code": 0, "message": msg, "data": data}


def _err(code: int, msg: str):
    return {"code": code, "message": msg, "data": None}


def _tts_cache_tag(voice: str, speed: float, provider: str = "") -> str:
    """TTS 产物文件名标签：把音色/语速/服务商混入哈希。

    修复：此前 seg_/concat_/tts_ 文件名只哈希文案，换语速/音色后同路径覆盖，
    前端步骤3仍按旧路径持有旧音频 buffer，导致预览口播与字幕/画面错位（导出不受影响）。
    """
    return hashlib.md5(f"{voice}|{speed}|{provider}".encode()).hexdigest()[:6]


async def _analyze_single_video(
    video_path: str,
    api_key: str,
    model: str = "",
    skip_nonkeyframes: bool = False,
    lowres: int = 0,
) -> tuple[list, list, list]:
    """检测场景 + 带缓存的 vision 描述（音频优先匹配的 P1 场景缓存）。

    对每一帧：先查 ``scene_cache``（key 含 video_path+mtime+frame_index+prompt），
    命中则跳过 vision 调用；未命中才调 ``analyze_frames_batch``（并发）并写回缓存。

    Args:
        skip_nonkeyframes / lowres: F10 批量提速标志，默认 False/0（单条精细工作流
        走默认参数，行为不变）。批量路径由 concurrent_analyzer._default_analyze 注入。

    Returns:
        (scenes, descriptions, frame_paths)
    """
    scenes = await asyncio.to_thread(
        detect_scenes, video_path,
        skip_nonkeyframes=skip_nonkeyframes, lowres=lowres,
    )
    if not scenes:
        return [], [], []

    frame_dir = os.path.join(TEMP_DIR, "ai_frames", os.path.basename(video_path))
    # F1：抽帧是同步 subprocess（ffmpeg），放线程里避免阻塞事件循环——
    # 否则 _spawn=create_task 同循环时，多条素材的同步 ffmpeg 会拖死整条循环，
    # 导致 /analyze 响应刷不出去 + /status//stop 全排队 → 30s IPC 超时。
    frame_paths = await asyncio.to_thread(extract_scene_frames, video_path, scenes, frame_dir)

    try:
        mtime = os.path.getmtime(video_path)
    except OSError:
        mtime = 0.0

    cached: dict = {}
    miss_idx: list = []
    miss_ctx: list = []
    miss_frames: list = []
    for si, s in enumerate(scenes):
        ctx = f"时间点 {s['start']:.1f}s-{s['end']:.1f}s"
        prompt = f"简要描述这个视频画面的内容（1-2句话）：{ctx}"
        desc = scene_cache.get(video_path, mtime, s["index"], prompt)
        if desc is not None:
            cached[si] = desc
        else:
            miss_idx.append(si)
            miss_ctx.append(ctx)
            miss_frames.append(frame_paths[si])

    if miss_frames:
        new_descs = await analyze_frames_batch(miss_frames, miss_ctx, api_key, model)
        for k, desc in enumerate(new_descs):
            si = miss_idx[k]
            ctx = miss_ctx[k]
            prompt = f"简要描述这个视频画面的内容（1-2句话）：{ctx}"
            scene_cache.put(video_path, mtime, scenes[si]["index"], prompt, desc)
            cached[si] = desc

    descriptions = [cached.get(si, "") for si in range(len(scenes))]
    return scenes, descriptions, frame_paths



@router.post("/analyze-script")
async def analyze_script_endpoint(req: dict):
    """Analyze narration script into semantic segments."""
    script = req.get("script", "")
    api_key = req.get("api_key", "")
    model = req.get("model", "")
    if not script:
        return _err(40001, "缺少 script 参数")

    try:
        segments = await analyze_script(script, api_key, model)
        return _ok({
            "segments": segments,
            "count": len(segments),
        })
    except Exception as e:
        return _err(50001, f"分析失败: {str(e)}")


@router.post("/analyze-video")
async def analyze_video_endpoint(req: dict):
    """Detect scenes in a video and describe each with AI vision (with scene cache)."""
    video_path = req.get("file_path", "")
    api_key = req.get("api_key", "")
    model = req.get("model", "")
    if not video_path or not os.path.exists(video_path):
        return _err(40001, "视频文件不存在")

    try:
        scenes, descriptions, frame_paths = await _analyze_single_video(video_path, api_key, model)
        if not scenes:
            return _ok({"scenes": [], "descriptions": [], "frames": []})

        return _ok({
            "scenes": scenes,
            "descriptions": descriptions,
            "frames": frame_paths,
            "frame_count": len(frame_paths),
            "video_path": video_path,
        })
    except Exception as e:
        return _err(50001, f"视频分析失败: {str(e)}")


@router.post("/match-scenes-v2")
async def match_scenes_v2_endpoint(req: dict):
    """音频优先匹配入口（V2）。

    入参：segments（与 /split-tts 同一数组）、seg_durations（来自 split-tts）、
    scenes（来自 /analyze-video）、api_key、可选 beat_points（来自 /detect-beats）、
    可选 options（覆盖 red_line/coverage_penalty/candidate_window）。

    出参：{ code, message, data: { timeline, total_duration, debug } }。
    """
    segments = req.get("segments", [])
    seg_durations = req.get("seg_durations", [])
    scenes = req.get("scenes", [])

    if not segments or not seg_durations or not scenes:
        return _err(40001, "缺少 segments / seg_durations / scenes")

    # 长度对齐校验：seg_durations 必须与 segments 一一对应
    if len(seg_durations) != len(segments):
        return _err(40001, "seg_durations 与 segments 长度不一致")

    api_key = req.get("api_key", "")
    model = req.get("model", "")
    beat_points = req.get("beat_points", None)
    options = req.get("options", None)

    try:
        result = await match_scenes_audio_first(
            segments, seg_durations, scenes, api_key,
            beat_points=beat_points, options=options, model=model,
        )
        return _ok({
            "timeline": result["timeline"],
            "total_duration": result["total_duration"],
            "debug": result["debug"],
        })
    except Exception as e:
        return _err(50001, f"音频优先匹配失败: {str(e)}")


@router.post("/detect-beats")
async def detect_beats_endpoint(req: dict):
    """检测口播音频中的静音气口（节拍切点），供匹配吸附使用。

    入参：{ audio_path }
    出参：{ code, message, data: { beats:[{time,score}], count, fallback } }。
    """
    audio_path = req.get("audio_path", "")
    if not audio_path or not os.path.exists(audio_path):
        return _err(40001, "音频文件不存在")

    try:
        result = BeatDetector().detect(audio_path)
        return _ok(result)
    except Exception as e:
        return _err(50001, f"节拍检测失败: {str(e)}")


@router.post("/match-scenes")
async def match_scenes_endpoint(req: dict):
    """Match script segments to video scenes using full scene data."""
    segments = req.get("segments", [])
    scenes = req.get("scenes", [])

    if not segments or not scenes:
        return _err(40001, "缺少 segments 或 scenes")

    api_key = req.get("api_key", "")

    try:
        timeline = await match_scenes_to_segments(segments, scenes, api_key)

        # 补全 source_duration：为每个唯一视频计算场景的最大 end
        video_durations: dict = {}
        for sc in scenes:
            vp = sc.get("video_path", "")
            end_val = float(sc.get("end", sc.get("duration", 10)))
            if vp not in video_durations or end_val > video_durations[vp]:
                video_durations[vp] = end_val

        for item in timeline:
            vp = item.get("video_path", "")
            if item.get("source_duration", 0) <= 0:
                item["source_duration"] = video_durations.get(vp, item.get("duration", 5))

        return _ok({"timeline": timeline, "count": len(timeline)})
    except Exception as e:
        return _err(50001, f"匹配失败: {str(e)}")


@router.post("/composite")
async def composite_endpoint(req: dict):
    """
    Composite video segments with TTS audio into final output.
    Expects timeline segments with {video_path, start_time, duration}.
    """
    segments = req.get("segments", [])
    script = req.get("script", "")
    voice = req.get("voice", "Cherry")
    output_name = req.get("output_name", "final_output")
    target_width = int(req.get("width", 1080))
    target_height = int(req.get("height", 1920))
    api_key = req.get("api_key", "")
    existing_audio_path = req.get("audio_path", "")
    subtitle_style = req.get("subtitle_style", None)
    speed = float(req.get("speed", 1.0))
    provider = req.get("provider", "qwen")
    app_key = req.get("app_key", "")
    access_key = req.get("access_key", "")
    # BGM params
    bgm_name = req.get("bgm_name", "")
    bgm_volume = float(req.get("bgm_volume", 80)) / 100.0
    voice_volume_val = float(req.get("voice_volume", 100)) / 100.0

    # DEBUG: capture what segments look like for diagnostic
    seg_texts = []
    for i, s in enumerate(segments[:5]):
        txt = s.get("segment_text", "")
        seg_texts.append(f"seg[{i}]: '{txt[:40]}'")
    diag = {
        "n_segs": len(segments),
        "has_subtitle_style": subtitle_style is not None,
        "subtitle_style_keys": list(subtitle_style.keys()) if subtitle_style else [],
        "has_text": any(s.get("segment_text","").strip() for s in segments),
        "sample_texts": seg_texts,
    }

    if not segments or not script:
        return _err(40001, "缺少 segments 或 script")

    try:
        # 使用已有音频或重新生成
        if existing_audio_path and os.path.exists(existing_audio_path):
            audio_path = existing_audio_path
        else:
            tts_dir = os.path.join(TEMP_DIR, "tts")
            os.makedirs(tts_dir, exist_ok=True)
            audio_path = os.path.join(tts_dir, f"{output_name}_narration.mp3")
            await text_to_speech(script, voice, audio_path, api_key, speed,
                                 provider=provider, app_key=app_key, access_key=access_key)

        audio_duration = get_audio_duration(audio_path)

        # P2 一致性日志：输入总时长（Σseg.duration）vs 音频时长，便于排查冻结/拉伸
        input_total = sum(float(s.get("duration", 0)) for s in segments)
        logger.info(
            f"[COMPOSITE] 输入总时长={input_total:.3f}s vs 音频时长={audio_duration:.3f}s, "
            f"差异={abs(input_total - audio_duration):.3f}s, "
            f"复用已有音频={'是' if (existing_audio_path and os.path.exists(existing_audio_path)) else '否'}"
        )
        # 入口诊断：无条件写文件，便于无控制台时确认请求是否到达本后端
        _append_mix_log(
            f"[COMPOSITE] entry: bgm_name={bgm_name!r} n_segs={len(segments)} "
            f"seg_sum={input_total:.3f}s audio_duration={audio_duration:.3f}s"
        )

        # Composite with correct video_path + timestamps
        output_dir = os.path.join(TEMP_DIR, "outputs")
        os.makedirs(output_dir, exist_ok=True)
        output_path = os.path.join(output_dir, f"{output_name}.mp4")
        _append_mix_log(f"[COMPOSITE] output_path={output_path}")
        composite_clip(segments, audio_path, output_path, target_width, target_height, subtitle_style)

        # Prepend cover if provided
        cover = req.get("cover", None)
        cover_applied = False
        # ALWAYS log cover status for debugging
        logger.info(f"[COMPOSITE] cover received: {cover is not None}")
        if cover:
            logger.info(f"[COMPOSITE] cover keys: {list(cover.keys())}, title={str(cover.get('title',''))[:30]}, sub={str(cover.get('subtitle',''))[:30]}, has_video={bool(cover.get('video_path'))}")
            diag["cover_has_video"] = bool(cover.get("video_path"))
            diag["cover_has_title"] = bool(cover.get("title"))
            diag["cover_has_sub"] = bool(cover.get("subtitle"))
            diag["cover_condition"] = bool(cover.get("video_path") and (cover.get("title") or cover.get("subtitle")))
        if cover and cover.get("video_path") and (cover.get("title") or cover.get("subtitle")):
            try:
                logger.info(f"[COMPOSITE] Received cover data: title={str(cover.get('title',''))[:30]}, sub={str(cover.get('subtitle',''))[:30]}, video={os.path.basename(str(cover.get('video_path','')))}")
                cover_path = os.path.join(output_dir, f"{output_name}_cover.mp4")
                cover_style = {
                    "font": cover.get("font", subtitle_style.get("font", "Microsoft YaHei") if subtitle_style else "Microsoft YaHei"),
                    "font_path": cover.get("font_path", subtitle_style.get("font_path", "C:/Windows/Fonts/msyh.ttc") if subtitle_style else "C:/Windows/Fonts/msyh.ttc"),
                    "title_size": int(cover.get("title_size", 48)),
                    "sub_size": int(cover.get("sub_size", 24)),
                    "title_color": cover.get("title_color", "white"),
                    "sub_color": cover.get("sub_color", "#cccccc"),
                    "title_stroke_color": cover.get("title_stroke_color", "black"),
                    "title_stroke_width": int(cover.get("title_stroke_width", 2)),
                    "sub_stroke_color": cover.get("sub_stroke_color", "black"),
                    "sub_stroke_width": int(cover.get("sub_stroke_width", 2)),
                    "title_x": float(cover.get("title_x", 50)),
                    "title_y": float(cover.get("title_y", 35)),
                    "sub_x": float(cover.get("sub_x", 50)),
                    "sub_y": float(cover.get("sub_y", 55)),
                    "title_italic": bool(cover.get("title_italic", False)),
                    "sub_italic": bool(cover.get("sub_italic", False)),
                    "zoom": float(cover.get("zoom", 1.0)),
                    "offset_x": int(cover.get("offset_x", 0)),
                    "offset_y": int(cover.get("offset_y", 0)),
                }
                logger.info(f"[COMPOSITE] cover_style keys: {list(cover_style.keys())}")
                logger.info(f"[COMPOSITE] Using font for cover: {cover_style.get('font')} at {cover_style.get('font_path')}")
                # 封面跟随成片分辨率：用传入的 target_width/target_height 渲染，
                # 与前端 COVER_SCALE = 成片高/320 保持同比例 → 预览↔导出严格一致(WYSIWYG)。
                cw = target_width
                ch = target_height
                render_cover(cover["video_path"], float(cover.get("time", 0)),
                             cover.get("title", ""), cover.get("subtitle", ""),
                             cover_style, cover_path, cw, ch)
                # Use cover frame PNG directly in concat filter (avoids MP4 issues)
                cover_frame = cover_path + ".cover.png"
                final = os.path.join(output_dir, f"{output_name}_final.mp4")
                cover_dur = 0.5
                # ── Audio sync fix ──────────────────────────────
                # The cover PNG has video only (no audio). The previous command
                # mapped the main video's audio directly (``-map 1:a``), so the
                # audio started at output t=0 — i.e. 0.5s *early* relative to the
                # concat'd video (cover 0.5s + main video). Subtitles are burned
                # into the main-video frames (drawtext), which only appear after
                # 0.5s, so the narration ran ahead of the picture/subtitles.
                #
                # Fix: generate ``cover_dur`` seconds of silence (anullsrc) for
                # the cover segment and concat audio in lockstep with video
                # (``concat=n=2:v=1:a=1``), then map the resulting [outa].
                # The silence's sample rate / channel layout are matched to the
                # main video's audio (probed) so concat does not fail or corrupt
                # audio. aresample/aformat normalise the main audio as a safety
                # net for any format mismatch.
                audio_info = _probe_audio_stream(output_path)
                if audio_info is not None:
                    a_sr = audio_info.get("sample_rate", 44100)
                    a_cl = audio_info.get("channel_layout", "stereo")
                    # anullsrc only accepts standard layouts; collapse anything
                    # unusual to "stereo" (mono sources are up-mixed losslessly).
                    if a_cl not in ("mono", "stereo"):
                        a_cl = "stereo"
                    concat_filter = (
                        # Letterbox the cover to the main video resolution so its
                        # own aspect ratio is preserved. A plain scale=W:H would
                        # non-uniformly stretch/squash the cover frame (and its
                        # baked-in title) whenever cover aspect != main aspect
                        # (e.g. a 3:4 cover on a 9:16 reel squishes the title
                        # ~0.75x horizontally). Pad with black bars instead.
                        f"[0:v]scale={target_width}:{target_height}:force_original_aspect_ratio=decrease,"
                        f"pad={target_width}:{target_height}:(ow-iw)/2:(oh-ih)/2:color=black,"
                        f"format=yuv420p,setsar=1[v0];"
                        f"[1:v]scale={target_width}:{target_height},format=yuv420p,setsar=1[v1];"
                        f"anullsrc=channel_layout={a_cl}:sample_rate={a_sr},"
                        f"atrim=0:{cover_dur},asetpts=PTS-STARTPTS[a0];"
                        f"[1:a]aresample={a_sr},aformat=channel_layouts={a_cl}[a1];"
                        f"[v0][a0][v1][a1]concat=n=2:v=1:a=1[outv][outa]"
                    )
                    stream_maps = ["-map", "[outv]", "-map", "[outa]"]
                else:
                    # Main video has no audio — fall back to video-only concat
                    # (preserves the previous resolution/pixel-format normalisation).
                    concat_filter = (
                        # Letterbox the cover to the main video resolution (same
                        # rationale as the audio branch above): preserve the
                        # cover's own aspect ratio instead of stretching it to the
                        # main resolution, which distorts the title when cover
                        # aspect != main aspect.
                        f"[0:v]scale={target_width}:{target_height}:force_original_aspect_ratio=decrease,"
                        f"pad={target_width}:{target_height}:(ow-iw)/2:(oh-ih)/2:color=black,"
                        f"format=yuv420p,setsar=1[v0];"
                        f"[1:v]scale={target_width}:{target_height},format=yuv420p,setsar=1[v1];"
                        f"[v0][v1]concat=n=2:v=1[outv]"
                    )
                    stream_maps = ["-map", "[outv]"]
                r = subprocess.run([
                    _ffmpeg(),
                    "-loop", "1", "-t", str(cover_dur), "-i", cover_frame,
                    "-i", output_path,
                    "-filter_complex", concat_filter,
                    *stream_maps,
                    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23",
                    "-pix_fmt", "yuv420p",
                    "-c:a", "aac",
                    "-y", final,
                ], capture_output=True, timeout=120)
                if r.returncode != 0:
                    stderr_full = r.stderr.decode(errors='replace')
                    logger.error(f"[COVER CONCAT] FAILED returncode={r.returncode}")
                    logger.error(f"[COVER CONCAT] full stderr:\n{stderr_full}")
                    # Diagnose input files
                    for _label, _path in [("cover_frame", cover_frame), ("main_video", output_path)]:
                        if os.path.exists(_path):
                            logger.error(f"[COVER CONCAT] {_label}: {_path} exists, size={os.path.getsize(_path)} bytes")
                        else:
                            logger.error(f"[COVER CONCAT] {_label}: {_path} DOES NOT EXIST")
                    # Probe stream info for both inputs (ffmpeg prints stream info to stderr)
                    try:
                        probe = subprocess.run(
                            [_ffmpeg(), "-i", cover_frame, "-i", output_path],
                            capture_output=True, timeout=15,
                        )
                        logger.error(f"[COVER CONCAT] probe stderr:\n{probe.stderr.decode(errors='replace')[-800:]}")
                    except Exception as pe:
                        logger.error(f"[COVER CONCAT] probe failed: {pe}")
                    raise RuntimeError(f"Cover concat failed: {stderr_full[-800:]}")
                try: os.unlink(cover_path); os.unlink(cover_frame)
                except OSError: pass
                if os.path.exists(final):
                    os.replace(final, output_path)
                    cover_applied = True
            except Exception as e:
                import traceback
                logger.exception(f"Cover render failed: {e}")
                cover_error = f"{type(e).__name__}: {str(e)[:200]}"
                diag["cover_error"] = cover_error

        # ── BGM mixing ──
        bgm_applied = False
        if bgm_name:
            from services.music_service import resolve_music_path
            bgm_path = resolve_music_path(bgm_name)
            if bgm_path and os.path.isfile(bgm_path):
                try:
                    # Authoritative video length = the LONGEST of:
                    #   (a) Σ segment durations (intended timeline length)
                    #   (b) the narration/audio duration
                    #   (c) the ACTUAL composited video duration (probed)
                    # Using the max guarantees BGM always fills the real video,
                    # even when segments arrive without `duration` or the TTS
                    # audio is shorter than the video (previous bug: `video_dur`
                    # fell back to a too-short audio_duration and `-t` clipped
                    # the music to a few seconds).
                    seg_sum = sum(float(s.get("duration", 0)) for s in segments)
                    real_dur = -1.0
                    candidates = [seg_sum, audio_duration]
                    try:
                        real_dur = get_audio_duration(output_path)  # works on video too
                        candidates.append(real_dur)
                    except Exception as _pe:
                        logger.warning(f"[BGM] probe output duration failed: {_pe}")
                    video_dur = max((c for c in candidates if c > 0), default=0.0)
                    if video_dur <= 0:
                        logger.warning("[BGM] could not determine video_dur; skipping BGM")
                        _append_mix_log(f"[BGM] SKIP no video_dur bgm={bgm_name} output={output_path}")
                    else:
                        _append_mix_log(
                            f"[BGM] plan: seg_sum={seg_sum:.3f}s audio={audio_duration:.3f}s "
                            f"real={real_dur:.3f}s -> video_dur={video_dur:.3f}s bgm={bgm_name}"
                        )
                        # Mix: trim music to the authoritative video length, fade out
                        # the last 2s, and blend with the voice track.
                        #
                        # ROOT CAUSE (2026-07-15): `afade=t=out:d=2` with NO explicit
                        # start reads the input stream's *duration metadata* to compute
                        # its fade-out start (= duration - d). After `atrim`, that
                        # metadata is NOT propagated correctly, so `afade` mis-computes
                        # the start as ~1s — killing all BGM after the first second
                        # ("plays a few seconds then fades out"). FIX: pass an EXPLICIT
                        # start time `st = max(0, video_dur - 2)` so the fade-out always
                        # lands on the final 2 seconds regardless of metadata quirks.
                        # Output duration is forced to `video_dur` (-t) so the music can
                        # never be truncated by `-shortest` either.
                        fade_start = max(0.0, video_dur - 2.0)
                        mixed = output_path + ".bgm.mp4"
                        bgm_filter = (
                            f"[1:a]atrim=0:{video_dur:.3f},"
                            f"afade=t=out:st={fade_start:.3f}:d=2,"
                            f"volume={bgm_volume}[bgm];"
                            f"[0:a]volume={voice_volume_val}[voice];"
                            f"[bgm][voice]amix=inputs=2:duration=first[outa]"
                        )
                        r = subprocess.run([
                            _ffmpeg(), "-i", output_path, "-i", bgm_path,
                            "-filter_complex", bgm_filter,
                            "-map", "0:v", "-map", "[outa]",
                            "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
                            "-t", f"{video_dur:.3f}", "-y", mixed,
                        ], capture_output=True, timeout=60)
                        if r.returncode == 0 and os.path.exists(mixed):
                            os.replace(mixed, output_path)
                            bgm_applied = True
                            logger.info(f"[BGM] mixed ok: video_dur={video_dur:.3f}s bgm={bgm_name}")
                            _append_mix_log(f"[BGM] mixed ok: video_dur={video_dur:.3f}s bgm={bgm_name} output={output_path}")
                        else:
                            logger.warning(f"[BGM] ffmpeg failed (rc={r.returncode}): {r.stderr.decode(errors='replace')[-400:]}")
                            _append_mix_log(f"[BGM] FAILED rc={r.returncode} bgm={bgm_name} output={output_path} err={r.stderr.decode(errors='replace')[-200:]}")
                except Exception as e:
                    logger.warning(f"BGM mixing failed: {e}")

        # ── Timeline 快照（P1）：导出成功后把本次请求的 timeline 载荷写入输出目录，
        # 供「预览≠导出」问题排查。快照失败不阻断导出。
        try:
            snapshot = {
                "exported_at": datetime.now().isoformat(timespec="seconds"),
                "output_path": output_path,
                "output_name": output_name,
                "width": target_width,
                "height": target_height,
                # 画幅：请求顶层未携带时退而居其次取 cover.aspect（前端导出时会带）
                "aspect": req.get("aspect") or ((cover or {}).get("aspect") if isinstance(cover, dict) else None),
                "segments": segments,
                # 字幕覆盖在前端请求侧已合入 segments（segment_text / subtitle_x / subtitle_y）
                "subtitle_overrides": [
                    {"index": i, "text": s.get("segment_text"),
                     "x": s.get("subtitle_x"), "y": s.get("subtitle_y")}
                    for i, s in enumerate(segments)
                ],
                "subtitle_style": subtitle_style,
                "bgm_name": bgm_name,
                "bgm_volume": bgm_volume,
                "voice_volume": voice_volume_val,
            }
            snap_path = os.path.join(os.path.dirname(output_path), "timeline_snapshot.json")
            with open(snap_path, "w", encoding="utf-8") as f:
                json.dump(snapshot, f, ensure_ascii=False, indent=2)
            logger.info(f"[COMPOSITE] timeline snapshot -> {snap_path}")
        except Exception as _se:
            logger.warning(f"[COMPOSITE] timeline snapshot write failed: {_se}")

        return _ok({
            "output_path": output_path,
            "audio_path": audio_path,
            "audio_duration": audio_duration,
            "subtitle_applied": subtitle_style is not None,
            "cover_applied": cover_applied,
            "bgm_applied": bgm_applied,
            "_diag": diag,
        })
    except Exception as e:
        return _err(50001, f"合成失败: {str(e)}")


@router.post("/full-pipeline")
async def full_pipeline(req: dict):
    """
    音频优先 V2 编排：
    1. Analyze script
    2. Analyze all videos（场景检测 + 带缓存 vision）
    3. Split-TTS 前置（先于匹配，拿到每句真实时长 seg_durations 与总时长/音频路径）
    4. [Detect beats]（可选节拍检测，供匹配吸附）
    5. Match scenes (V2 约束求解)
    6. Composite 复用已有音频（existing_audio_path）
    """
    script = req.get("script", "")
    video_paths = req.get("video_paths", [])
    voice = req.get("voice", "Cherry")
    output_name = req.get("output_name", "ai_edit")
    api_key = req.get("api_key", "")
    model = req.get("model", "")
    speed = float(req.get("speed", 1.0))

    if not script:
        return _err(40001, "缺少 script 参数")
    if not video_paths:
        return _err(40001, "缺少 video_paths 参数")

    try:
        steps = []

        # Step 1: Analyze script
        segments = await analyze_script(script, api_key, model)
        steps.append({"step": "script_analysis", "status": "done", "segments": len(segments)})

        # Step 2: Analyze each video（带场景缓存）
        all_scenes = []
        for vp in video_paths:
            if not os.path.exists(vp):
                continue
            scenes, descriptions, _frames = await _analyze_single_video(vp, api_key, model)
            for sc, desc in zip(scenes, descriptions):
                all_scenes.append({**sc, "description": desc, "video_path": vp})
        steps.append({
            "step": "video_analysis", "status": "done",
            "videos_analyzed": len(video_paths), "total_scenes": len(all_scenes),
        })
        if not all_scenes:
            return _err(50001, "视频分析未提取到任何场景")

        # Step 3: Split-TTS 前置（先于匹配，拿到真实每句时长）
        tts_dir = os.path.join(TEMP_DIR, "tts")
        os.makedirs(tts_dir, exist_ok=True)
        seg_files = []
        seg_durations = []
        for i, seg in enumerate(segments):
            txt = (seg.get("text") or seg.get("segment_text") or "").strip()
            if not txt:
                seg_durations.append(0.5)
                continue
            seg_path = os.path.join(tts_dir, f"seg_{i:03d}_{hashlib.md5(txt.encode()).hexdigest()[:6]}_{_tts_cache_tag(voice, speed)}.mp3")
            await text_to_speech(txt, voice, seg_path, api_key, speed)
            dur = get_audio_duration(seg_path)
            seg_files.append(seg_path)
            seg_durations.append(dur)
        if not seg_files:
            return _err(50001, "无法生成分段时间轴音频")
        # 拼接完整音频（复用既有 split-tts 逻辑）
        concat_f = os.path.join(tts_dir, "concat_segs.txt")
        concat_audio = os.path.join(tts_dir, f"concat_{hashlib.md5(str(segments).encode()).hexdigest()[:10]}.mp3")
        with open(concat_f, "w") as f:
            for sf in seg_files:
                f.write(f"file '{sf}'\n")
        subprocess.run([
            _ffmpeg(), "-f", "concat", "-safe", "0", "-i", concat_f,
            "-c:a", "libmp3lame", "-q:a", "2", "-y", concat_audio,
        ], capture_output=True, timeout=60)
        try:
            os.unlink(concat_f)
        except OSError:
            pass
        total_duration = sum(seg_durations)
        steps.append({"step": "tts", "status": "done", "total_duration": total_duration})

        # Step 4: Detect beats（可选，供匹配吸附切点）
        beat_points = None
        try:
            bd = BeatDetector().detect(concat_audio)
            if not bd.get("fallback", True) and bd.get("beats"):
                beat_points = [b["time"] for b in bd["beats"]]
        except Exception as e:
            logger.warning(f"[FULL-PIPELINE] detect-beats skipped: {e}")
            beat_points = None

        # Step 5: Match scenes (V2 约束求解)
        match_result = await match_scenes_audio_first(
            segments, seg_durations, all_scenes, api_key, beat_points=beat_points, model=model
        )
        timeline = match_result.get("timeline", [])
        steps.append({
            "step": "scene_matching", "status": "done",
            "matched_segments": len(timeline),
            "debug": match_result.get("debug"),
        })

        # Step 6: Composite 复用已有音频（不重新生成 TTS）
        output_dir = os.path.join(TEMP_DIR, "outputs")
        os.makedirs(output_dir, exist_ok=True)
        output_path = os.path.join(output_dir, f"{output_name}.mp4")
        fp_aspect = req.get("video_aspect", "9:16")
        fp_resolution = req.get("video_resolution", "1080p")
        fp_w = 1440 if fp_resolution == "2K" else 1080
        fp_h = round(fp_w * (16 / 9 if fp_aspect == "9:16" else 4 / 3))
        composite_clip(timeline, concat_audio, output_path, fp_w, fp_h, None)
        steps.append({"step": "composite", "status": "done", "output_path": output_path})

        return _ok({
            "steps": steps,
            "output_path": output_path,
            "audio_path": concat_audio,
            "timeline": timeline,
            "total_duration": total_duration,
        })
    except Exception as e:
        return _err(50001, f"流水线执行失败: {str(e)}")


@router.post("/preview-voice")
async def preview_voice(req: dict):
    """Generate a short voice preview. Auto-detects audio format."""
    voice = req.get("voice", "Cherry")
    text = req.get("text", "你好，这是音色试听。让我们来听听这个声音的效果。")
    api_key = req.get("api_key", "")
    provider = req.get("provider", "qwen")
    speed = float(req.get("speed", 1.0))
    try:
        output_path = await text_to_speech(text, voice, "", api_key, speed, provider=provider)
        with open(output_path, "rb") as f:
            audio_data = f.read()
        # Detect format from magic bytes
        if audio_data[:3] == b'ID3' or audio_data[:2] == b'\xff\xfb':
            media_type = "audio/mpeg"
        elif audio_data[:4] == b'RIFF':
            media_type = "audio/wav"
        else:
            media_type = "audio/mpeg"  # fallback
        try:
            os.unlink(output_path)
        except OSError:
            pass
        return Response(content=audio_data, media_type=media_type)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/generate-tts")
async def generate_tts_endpoint(req: dict):
    """Generate TTS audio and return its path and duration."""
    script = req.get("script", "")
    voice = req.get("voice", "Cherry")
    api_key = req.get("api_key", "")
    speed = float(req.get("speed", 1.0))
    provider = req.get("provider", "qwen")
    app_key = req.get("app_key", "")
    access_key = req.get("access_key", "")

    if not script:
        return _err(40001, "缺少 script 参数")

    try:
        tts_dir = os.path.join(TEMP_DIR, "tts")
        os.makedirs(tts_dir, exist_ok=True)
        audio_path = os.path.join(tts_dir, f"tts_{hashlib.md5((script + _tts_cache_tag(voice, speed, provider)).encode()).hexdigest()[:12]}.mp3")
        await text_to_speech(script, voice, audio_path, api_key, speed,
                             provider=provider, app_key=app_key, access_key=access_key)
        duration = get_audio_duration(audio_path)
        return _ok({
            "audio_path": audio_path,
            "duration": duration,
        })
    except Exception as e:
        return _err(50001, f"TTS 生成失败: {str(e)}")


@router.post("/split-tts")
async def split_tts_endpoint(req: dict):
    """Generate TTS per segment, concatenate, return per-segment durations for perfect subtitle sync."""
    segments = req.get("segments", [])
    voice = req.get("voice", "Cherry")
    api_key = req.get("api_key", "")
    speed = float(req.get("speed", 1.0))
    provider = req.get("provider", "qwen")
    app_key = req.get("app_key", "")
    access_key = req.get("access_key", "")

    if not segments:
        return _err(40001, "缺少 segments 参数")

    try:
        tts_dir = os.path.join(TEMP_DIR, "tts")
        os.makedirs(tts_dir, exist_ok=True)
        tag = _tts_cache_tag(voice, speed, provider)
        seg_files = []
        seg_durations = []
        for i, seg in enumerate(segments):
            txt = (seg.get("text") or seg.get("segment_text") or "").strip()
            if not txt:
                seg_durations.append(0.5)
                continue
            seg_path = os.path.join(tts_dir, f"seg_{i:03d}_{hashlib.md5(txt.encode()).hexdigest()[:6]}_{tag}.mp3")
            await text_to_speech(txt, voice, seg_path, api_key, speed,
                                 provider=provider, app_key=app_key, access_key=access_key)
            dur = get_audio_duration(seg_path)
            seg_files.append(seg_path)
            seg_durations.append(dur)

        if not seg_files:
            return _err(50001, "无法生成任何分段时间轴音频")

        # Concatenate all segment audios
        concat_f = os.path.join(tts_dir, "concat_segs.txt")
        output_name = f"concat_{hashlib.md5((str(segments) + tag).encode()).hexdigest()[:10]}"
        concat_audio = os.path.join(tts_dir, f"{output_name}.mp3")
        with open(concat_f, "w") as f:
            for sf in seg_files:
                f.write(f"file '{sf}'\n")
        subprocess.run([
            _ffmpeg(), "-f", "concat", "-safe", "0", "-i", concat_f,
            "-c:a", "libmp3lame", "-q:a", "2", "-y", concat_audio,
        ], capture_output=True, timeout=60)
        try: os.unlink(concat_f)
        except OSError: pass

        return _ok({
            "audio_path": concat_audio,
            "total_duration": sum(seg_durations),
            "seg_durations": seg_durations,
        })
    except Exception as e:
        return _err(50001, f"片段TTS 生成失败: {str(e)}")


@router.get("/voices")
async def list_voices(provider: str = "qwen"):
    """List available TTS voices. provider: "qwen" (default) | "doubao"."""
    provider = (provider or "qwen").lower()
    if provider == "doubao":
        return _ok({"provider": "doubao", "voices": DOUBAO_VOICES})
    return _ok({
        "provider": "qwen",
        "voices": [
            {"id": "Cherry",   "name": "Cherry 芊悦 (阳光亲切小姐姐)",     "gender": "female"},
            {"id": "Ethan",    "name": "Ethan 晨煦 (阳光温暖男声)",          "gender": "male"},
            {"id": "Nofish",   "name": "Nofish 不吃鱼 (设计师)",              "gender": "male"},
            {"id": "Jennifer", "name": "Jennifer 詹妮弗 (电影级美语女声)",   "gender": "female"},
            {"id": "Ryan",     "name": "Ryan 甜茶 (戏感炸裂)",               "gender": "male"},
            {"id": "Katerina", "name": "Katerina 卡捷琳娜 (御姐音色)",       "gender": "female"},
            {"id": "Elias",    "name": "Elias 墨讲师 (知识讲解)",             "gender": "male"},
            {"id": "Jada",     "name": "Jada 上海-阿珍 (沪上阿姐)",          "gender": "female"},
            {"id": "Dylan",    "name": "Dylan 北京-晓东 (胡同少年)",         "gender": "male"},
            {"id": "Sunny",    "name": "Sunny 四川-晴儿 (甜心川妹子)",       "gender": "female"},
            {"id": "Eric",     "name": "Eric 四川-程川 (成都男子)",           "gender": "male"},
            {"id": "Peter",    "name": "Peter 天津-李彼得 (相声捧人)",       "gender": "male"},
            {"id": "Marcus",   "name": "Marcus 陕西-秦川 (老陕)",             "gender": "male"},
            {"id": "Roy",      "name": "Roy 闽南-阿杰 (台湾哥仔)",           "gender": "male"},
            {"id": "Rocky",    "name": "Rocky 粤语-阿强 (幽默风趣)",          "gender": "male"},
            {"id": "Kiki",     "name": "Kiki 粤语-阿清 (港妹闺蜜)",           "gender": "female"},
            {"id": "li",       "name": "li 南京-老李 (瑜伽老师)",             "gender": "male"},
        ],
    })


@router.post("/preview-video")
async def preview_video(req: dict):
    """Quick low-res preview render for timeline playback."""
    segments = req.get("segments", [])
    width = int(req.get("width", 480))
    height = int(req.get("height", 640))

    if not segments:
        return _err(40001, "缺少 segments")

    try:
        trimmed = []
        for i, seg in enumerate(segments):
            vp = seg.get("video_path", "")
            st = seg.get("start_time", 0)
            dur = seg.get("duration", 3)
            if not os.path.exists(vp): continue
            out = os.path.join(TEMP_DIR, "previews", f"p_{i:03d}.mp4")
            os.makedirs(os.path.dirname(out), exist_ok=True)
            subprocess.run([
                _ffmpeg(), "-ss", str(st), "-i", vp, "-t", str(dur),
                "-vf", f"scale={width}:{height}:force_original_aspect_ratio=increase,crop={width}:{height},setsar=1",
                "-c:v", "libx264", "-preset", "ultrafast", "-crf", "28",
                "-an", "-y", out,
            ], capture_output=True, timeout=30)
            if os.path.exists(out): trimmed.append(out)

        if not trimmed:
            return _err(50001, "无法生成预览")

        concat_f = os.path.join(TEMP_DIR, "previews", "concat.txt")
        with open(concat_f, "w") as f:
            for t in trimmed: f.write(f"file '{t}'\n")

        out_path = os.path.join(TEMP_DIR, "previews", f"preview_{hashlib.md5(str(segments).encode()).hexdigest()[:8]}.mp4")
        subprocess.run([
            _ffmpeg(), "-f", "concat", "-safe", "0", "-i", concat_f,
            "-c:v", "libx264", "-preset", "ultrafast", "-crf", "26",
            "-an", "-y", out_path,
        ], capture_output=True, timeout=60)

        return _ok({"url": f"/api/ai-editing/video?path={out_path}", "path": out_path})
    except Exception as e:
        return _err(50001, f"预览生成失败: {str(e)}")


@router.get("/fonts")
async def list_fonts():
    """List installed system fonts with display names and file paths."""
    font_dirs = [
        r"C:\Windows\Fonts",
        os.path.expanduser("~\\AppData\\Local\\Microsoft\\Windows\\Fonts"),
    ]
    entries = []
    for d in font_dirs:
        if os.path.exists(d):
            try:
                for f in glob.glob(os.path.join(d, "*.ttf")):
                    entries.append(f)
                for f in glob.glob(os.path.join(d, "*.ttc")):
                    entries.append(f)
                for f in glob.glob(os.path.join(d, "*.otf")):
                    entries.append(f)
            except Exception:
                pass
    # Build name→path, deduplicate
    seen = set()
    names, paths = [], []
    for fp in entries:
        name = os.path.splitext(os.path.basename(fp))[0]
        if name.lower() not in seen:
            seen.add(name.lower())
            names.append(name)
            paths.append(fp.replace("\\", "/"))
    # Always include common fonts as fallback
    common = [
        ("Microsoft YaHei", "C:/Windows/Fonts/msyh.ttc"),
        ("SimHei", "C:/Windows/Fonts/simhei.ttf"),
        ("SimSun", "C:/Windows/Fonts/simsun.ttc"),
        ("KaiTi", "C:/Windows/Fonts/simkai.ttf"),
        ("FangSong", "C:/Windows/Fonts/simfang.ttf"),
        ("Arial", "C:/Windows/Fonts/arial.ttf"),
    ]
    for cname, cpath in common:
        if cname.lower() not in seen and os.path.exists(cpath):
            seen.add(cname.lower())
            names.append(cname)
            paths.append(cpath)
    combined = sorted(zip(names, paths), key=lambda x: x[0].lower())
    return _ok({
        "fonts": [{"name": n, "path": p} for n, p in combined][:200]
    })


@router.get("/font-file")
async def serve_font(path: str):
    """Serve a font file as binary for @font-face loading."""
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="Font not found")
    ext = os.path.splitext(path)[1].lower()
    mime_map = {".ttf": "font/ttf", ".otf": "font/otf", ".ttc": "font/collection", ".woff": "font/woff", ".woff2": "font/woff2"}
    return FileResponse(path, media_type=mime_map.get(ext, "application/octet-stream"))


# ─── File Serving for Preview ──────────────────────────

@router.get("/video")
async def serve_video(path: str):
    """Serve generated MP4 video for browser preview."""
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="Video not found")
    return FileResponse(path, media_type="video/mp4")


@router.get("/audio")
async def serve_audio(path: str):
    """Serve generated MP3 audio for browser preview."""
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="Audio not found")
    return FileResponse(path, media_type="audio/mpeg")


@router.get("/thumb")
async def serve_thumbnail(
    path: str,
    t: float = 1.0,
    aspect: str = "9:16",
    w: int | None = None,
    h: int | None = None,
):
    """Extract and serve a video thumbnail at time t seconds.

    The frame is filled to the cover's target resolution
    (``aspect=9:16`` → 1080×1920, ``aspect=3:4`` → 1440×1920) via
    scale (force_original_aspect_ratio=increase) + crop, matching
    ``render_cover``'s export geometry 1:1 so the step-3 preview is
    WYSIWYG with the exported cover (no black letterbox bars that
    objectFit:'fill' would otherwise stretch into a dark frame).

    Optional ``w``/``h`` (P2 重选时段胶片条): request a SMALL thumbnail
    instead of the full-res cover frame (e.g. ``w=160``). When only one
    of w/h is given, the other is derived from ``aspect``. The cache key
    includes the final size, so small and full-res thumbs never collide.
    """
    path = os.path.normpath(path)
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail=f"Video not found: {path}")
    # Map aspect string to target cover resolution
    if aspect == "3:4":
        cw, ch = 1440, 1920
    else:
        cw, ch = 1080, 1920  # 9:16 (default)
    sized = w is not None or h is not None
    if sized:
        # Clamp to sane bounds so a bad query can't trigger a huge encode.
        if w is not None:
            w = max(16, min(2160, int(w)))
        if h is not None:
            h = max(16, min(3840, int(h)))
        if w is None:
            w = max(16, round(h * cw / ch))
        if h is None:
            h = max(16, round(w * ch / cw))
        # yuv420p/mjpeg 只支持偶数尺寸：奇数会被 ffmpeg 静默截断为偶数，
        # 导致返回尺寸与请求不符（实测 213→212）。这里先对齐，缓存键也用对齐后的值。
        w -= w % 2
        h -= h % 2
        cw, ch = w, h
    try:
        thumb_dir = os.path.join(TEMP_DIR, "thumbs")
        os.makedirs(thumb_dir, exist_ok=True)
        import hashlib
        # 无 w/h 时保持旧缓存键（命中既有缓存）；带尺寸时缓存键含最终宽高。
        hash_key = f"{path}:{t}:{cw}x{ch}" if sized else f"{path}:{t}:{aspect}"
        hash_name = hashlib.md5(hash_key.encode()).hexdigest()[:12]
        out_path = os.path.join(thumb_dir, f"{hash_name}.jpg")
        if not os.path.exists(out_path):
            subprocess.run([
                _ffmpeg(),
                "-ss", str(t),
                "-i", path,
                "-vframes", "1",
                # Fill the cover frame (scale + crop, NO letterbox) so the
                # preview matches render_cover's export geometry 1:1. The
                # step-3 preview uses objectFit:'fill' + CSS scale/translate
                # to mirror render_cover's zoom/pan, which assumes the source
                # frame already fills the cover aspect (no black bars). Using
                # force_original_aspect_ratio=increase + crop reproduces the
                # export's fill/crop exactly, instead of padding black bars
                # that objectFit:'fill' then stretches into a dark frame.
                "-vf", f"scale={cw}:{ch}:force_original_aspect_ratio=increase,"
                       f"crop={cw}:{ch}",
                "-q:v", "2",
                "-y", out_path,
            ], capture_output=True, timeout=10)
        if os.path.exists(out_path):
            return FileResponse(out_path, media_type="image/jpeg")
    except Exception:
        pass
    raise HTTPException(status_code=500, detail="Thumbnail generation failed")

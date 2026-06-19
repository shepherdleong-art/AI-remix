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
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response, FileResponse

from services.ai_service import (
    text_to_speech,
    analyze_script,
    analyze_frames_batch,
    match_scenes_to_segments,
)
from services.video_service import (
    detect_scenes,
    extract_scene_frames,
    composite_clip,
    get_audio_duration,
)
from services.video_service import _ffmpeg  # used by /thumb and /video endpoints
from config import TEMP_DIR, FFMPEG_EXECUTABLE

router = APIRouter(prefix="/api/ai-editing", tags=["ai-editing"])


def _ok(data=None, msg="success"):
    return {"code": 0, "message": msg, "data": data}


def _err(code: int, msg: str):
    return {"code": code, "message": msg, "data": None}


@router.post("/analyze-script")
async def analyze_script_endpoint(req: dict):
    """Analyze narration script into semantic segments."""
    script = req.get("script", "")
    api_key = req.get("api_key", "")
    if not script:
        return _err(40001, "缺少 script 参数")

    try:
        segments = await analyze_script(script, api_key)
        return _ok({
            "segments": segments,
            "count": len(segments),
        })
    except Exception as e:
        return _err(50001, f"分析失败: {str(e)}")


@router.post("/analyze-video")
async def analyze_video_endpoint(req: dict):
    """Detect scenes in a video and describe each with AI vision."""
    video_path = req.get("file_path", "")
    api_key = req.get("api_key", "")
    if not video_path or not os.path.exists(video_path):
        return _err(40001, "视频文件不存在")

    try:
        # Detect scenes
        scenes = detect_scenes(video_path)
        if not scenes:
            return _ok({"scenes": [], "descriptions": [], "frames": []})

        # Extract frames
        frame_dir = os.path.join(TEMP_DIR, "ai_frames")
        frame_paths = extract_scene_frames(video_path, scenes, frame_dir)

        # AI vision analysis
        prompts = [
            f"时间点 {s['start']:.1f}s-{s['end']:.1f}s"
            for s in scenes
        ]
        descriptions = await analyze_frames_batch(frame_paths, prompts, api_key)

        return _ok({
            "scenes": scenes,
            "descriptions": descriptions,
            "frames": frame_paths,
            "frame_count": len(frame_paths),
            "video_path": video_path,
        })
    except Exception as e:
        return _err(50001, f"视频分析失败: {str(e)}")


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
            await text_to_speech(script, voice, audio_path, api_key, speed)

        audio_duration = get_audio_duration(audio_path)

        # Composite with correct video_path + timestamps
        output_dir = os.path.join(TEMP_DIR, "outputs")
        os.makedirs(output_dir, exist_ok=True)
        output_path = os.path.join(output_dir, f"{output_name}.mp4")
        composite_clip(segments, audio_path, output_path, target_width, target_height, subtitle_style)

        return _ok({
            "output_path": output_path,
            "audio_path": audio_path,
            "audio_duration": audio_duration,
            "subtitle_applied": subtitle_style is not None,
        })
    except Exception as e:
        return _err(50001, f"合成失败: {str(e)}")


@router.post("/full-pipeline")
async def full_pipeline(req: dict):
    """
    Run the entire AI editing pipeline:
    1. Analyze script
    2. Analyze all videos (scene detection + AI vision)
    3. Match script segments to video scenes
    4. Generate TTS audio
    5. Composite final output
    """
    script = req.get("script", "")
    video_paths = req.get("video_paths", [])
    voice = req.get("voice", "Cherry")
    output_name = req.get("output_name", "ai_edit")
    api_key = req.get("api_key", "")
    target_width = int(req.get("width", 1080))
    target_height = int(req.get("height", 1920))

    if not script:
        return _err(40001, "缺少 script 参数")
    if not video_paths:
        return _err(40001, "缺少 video_paths 参数")

    try:
        steps = []

        # Step 1: Analyze script
        segments = await analyze_script(script, api_key)
        steps.append({
            "step": "script_analysis",
            "status": "done",
            "segments": len(segments),
        })

        # Step 2: Analyze each video
        # Build enriched scene list with video_path attached for matching
        enriched_scenes = []

        for vp in video_paths:
            if not os.path.exists(vp):
                continue
            scenes = detect_scenes(vp)
            frame_dir = os.path.join(TEMP_DIR, "ai_frames", os.path.basename(vp))
            frame_paths = extract_scene_frames(vp, scenes, frame_dir)
            prompts = [f"时间点 {s['start']:.1f}s-{s['end']:.1f}s" for s in scenes]
            descriptions = await analyze_frames_batch(frame_paths, prompts, api_key)

            for i, sc in enumerate(scenes):
                enriched_scenes.append({
                    "index": len(enriched_scenes),
                    "description": descriptions[i] if i < len(descriptions) else "",
                    "video_path": vp,
                    "start": sc["start"],
                    "end": sc["end"],
                    "duration": sc["duration"],
                })

        steps.append({
            "step": "video_analysis",
            "status": "done",
            "videos_analyzed": len(video_paths),
            "total_scenes": len(enriched_scenes),
        })

        # Step 3: Match script segments to enriched video scenes
        timeline = await match_scenes_to_segments(
            segments, enriched_scenes, api_key
        )

        # Build segments for compositing
        comp_segments = []
        for item in timeline:
            comp_segments.append({
                "video_path": item.get("video_path", ""),
                "start_time": item.get("start_time", 0.0),
                "duration": item.get("duration", 3.0),
                "segment_text": item.get("segment_text", ""),
            })

        steps.append({
            "step": "scene_matching",
            "status": "done",
            "matched_segments": len(timeline),
        })

        # Step 4: TTS + Composite
        tts_dir = os.path.join(TEMP_DIR, "tts")
        os.makedirs(tts_dir, exist_ok=True)
        audio_path = os.path.join(tts_dir, f"{output_name}_narration.mp3")
        await text_to_speech(script, voice, audio_path, api_key)

        output_dir = os.path.join(TEMP_DIR, "outputs")
        os.makedirs(output_dir, exist_ok=True)
        output_path = os.path.join(output_dir, f"{output_name}.mp4")
        composite_clip(comp_segments, audio_path, output_path,
                       target_width, target_height)

        steps.append({
            "step": "composite",
            "status": "done",
            "output_path": output_path,
        })

        return _ok({
            "steps": steps,
            "output_path": output_path,
            "audio_path": audio_path,
            "timeline": timeline,
        })
    except Exception as e:
        return _err(50001, f"流水线执行失败: {str(e)}")


@router.post("/preview-voice")
async def preview_voice(req: dict):
    """Generate a short voice preview. Auto-detects audio format."""
    voice = req.get("voice", "Cherry")
    text = req.get("text", "你好，这是音色试听。让我们来听听这个声音的效果。")
    api_key = req.get("api_key", "")
    speed = float(req.get("speed", 1.0))
    try:
        output_path = await text_to_speech(text, voice, "", api_key, speed)
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

    if not script:
        return _err(40001, "缺少 script 参数")

    try:
        tts_dir = os.path.join(TEMP_DIR, "tts")
        os.makedirs(tts_dir, exist_ok=True)
        audio_path = os.path.join(tts_dir, f"tts_{hashlib.md5(script.encode()).hexdigest()[:12]}.mp3")
        await text_to_speech(script, voice, audio_path, api_key, speed)
        duration = get_audio_duration(audio_path)
        return _ok({
            "audio_path": audio_path,
            "duration": duration,
        })
    except Exception as e:
        return _err(50001, f"TTS 生成失败: {str(e)}")


@router.get("/voices")
async def list_voices():
    """List available TTS voices for qwen3-tts-flash."""
    return _ok({
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

        return _ok({"url": f"{req.get('_api_base', 'http://127.0.0.1:18000')}/api/ai-editing/video?path={out_path}", "path": out_path})
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


# ─── Path safety helper ──────────────────────────────

def _is_safe_path(requested_path: str) -> bool:
    """Check that a path resides within allowed directories (TEMP_DIR or video_paths from request)."""
    allowed_dirs = [
        os.path.realpath(TEMP_DIR),
        os.path.realpath(os.path.join(TEMP_DIR, "outputs")),
        os.path.realpath(os.path.join(TEMP_DIR, "tts")),
        os.path.realpath(os.path.join(TEMP_DIR, "thumbs")),
        os.path.realpath(os.path.join(TEMP_DIR, "previews")),
        os.path.realpath(os.path.join(TEMP_DIR, "ai_frames")),
    ]
    try:
        real_path = os.path.realpath(requested_path)
    except (ValueError, OSError):
        return False
    for allowed in allowed_dirs:
        if real_path.startswith(allowed + os.sep) or real_path == allowed:
            return True
    return False


# ─── File Serving for Preview ──────────────────────────

@router.get("/video")
async def serve_video(path: str):
    """Serve generated MP4 video for browser preview."""
    if not _is_safe_path(path):
        raise HTTPException(status_code=403, detail="Access denied")
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="Video not found")
    return FileResponse(path, media_type="video/mp4")


@router.get("/audio")
async def serve_audio(path: str):
    """Serve generated MP3 audio for browser preview."""
    if not _is_safe_path(path):
        raise HTTPException(status_code=403, detail="Access denied")
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="Audio not found")
    return FileResponse(path, media_type="audio/mpeg")


@router.get("/thumb")
async def serve_thumbnail(path: str, t: float = 1.0):
    """Extract and serve a video thumbnail at time t seconds."""
    if not _is_safe_path(path):
        raise HTTPException(status_code=403, detail="Access denied")
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="Video not found")
    # Clamp t to reasonable range
    t = max(0.0, min(float(t), 3600.0))
    try:
        thumb_dir = os.path.join(TEMP_DIR, "thumbs")
        os.makedirs(thumb_dir, exist_ok=True)
        import hashlib
        hash_name = hashlib.md5(f"{path}:{t}".encode()).hexdigest()[:12]
        out_path = os.path.join(thumb_dir, f"{hash_name}.jpg")
        if not os.path.exists(out_path):
            subprocess.run([
                _ffmpeg(),
                "-ss", str(t),
                "-i", path,
                "-vframes", "1",
                "-q:v", "5",
                "-y", out_path,
            ], capture_output=True, timeout=10)
        if os.path.exists(out_path):
            return FileResponse(out_path, media_type="image/jpeg")
    except Exception:
        pass
    raise HTTPException(status_code=500, detail="Thumbnail generation failed")

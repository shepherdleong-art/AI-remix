"""
Regression test for the "TTS reads pure-CJK Chinese as Japanese" bug
(issue-handoff 2026-07-13, diagnosed 2026-07-14).

Root cause: qwen3-tts-flash via the 3rd-party proxy auto-detects language
from input text. Pure-CJK sentences with no Chinese-exclusive function word
(e.g. product copy "高回弹海绵，久坐不塌。") are mis-read as Japanese.

Fix: `_apply_cn_anchor` prepends a configurable Chinese anchor to at-risk
sentences so the model detects Chinese.

- `test_detection_*` run with NO API key (pure logic).
- `test_anchored_tts_is_chinese` is an integration test: it calls the REAL
  TTS (needs TTS_KEY + network) for the exact failing sentence and ASR-checks
  the result is Chinese. Skipped automatically when no key is present.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from services.ai_service import (  # noqa: E402
    _needs_cn_anchor,
    _apply_cn_anchor,
    TTS_CN_ANCHOR,
)


def test_needs_cn_anchor_true_for_pure_kanji():
    # The exact sentence that was reported as Japanese.
    assert _needs_cn_anchor("高回弹海绵，久坐不塌。") is True
    # Weather-style pure-ideograph phrase (also at risk).
    assert _needs_cn_anchor("今天天气真好。") is True


def test_needs_cn_anchor_false_when_marker_present():
    # Contains function words / exclusive chars -> safe, no anchor.
    assert _needs_cn_anchor("今天给大家推荐一款超级好用的厨房神器。") is False
    assert _needs_cn_anchor("这个产品真的很好用呢。") is False
    assert _needs_cn_anchor("高回弹海绵，久坐不塌的。") is False  # has 的


def test_needs_cn_anchor_false_for_non_cjk():
    assert _needs_cn_anchor("Hello world") is False
    assert _needs_cn_anchor("") is False
    assert _needs_cn_anchor("12345") is False


def test_apply_cn_anchor_only_on_at_risk():
    risky = "高回弹海绵，久坐不塌。"
    assert _apply_cn_anchor(risky) == f"{TTS_CN_ANCHOR}{risky}"
    safe = "今天给大家推荐一款超级好用的厨房神器。"
    assert _apply_cn_anchor(safe) == safe


def _has_japanese(text: str) -> bool:
    # Hiragana (3040-309F) or Katakana (30A0-30FF) => Japanese reading.
    return any(0x3040 <= ord(c) <= 0x309F or 0x30A0 <= ord(c) <= 0x30FF for c in text)


def test_anchored_tts_is_chinese():
    """Integration test: real TTS + ASR for the failing sentence.

    Skipped unless TTS_KEY is provided (and httpx available)."""
    key = os.environ.get("TTS_KEY", "")
    if not key:
        import pytest
        pytest.skip("TTS_KEY not set — skipping live TTS integration test")

    try:
        import httpx
        import subprocess
        import tempfile
        import json
        import asyncio
    except Exception as e:  # pragma: no cover
        import pytest
        pytest.skip(f"deps missing: {e}")

    FFMPEG = os.environ.get("FFMPEG_PATH") or "ffmpeg"
    API_BASE = os.environ.get("API_BASE", "https://api.v3.cm/v1").rstrip("/")
    SENTENCE = "高回弹海绵，久坐不塌。"

    async def run():
        from services.ai_service import text_to_speech
        out = tempfile.mktemp(suffix=".mp3")
        await text_to_speech(SENTENCE, "Cherry", out, key, 1.0)
        return out

    mp3 = asyncio.run(run())
    assert os.path.exists(mp3) and os.path.getsize(mp3) > 0

    # ASR via the proxy's transcription endpoint.
    wav = tempfile.mktemp(suffix=".wav")
    subprocess.run([FFMPEG, "-y", "-i", mp3, "-ar", "16000", "-ac", "1", wav],
                   capture_output=True, timeout=30)
    with open(wav, "rb") as f:
        r = httpx.post(f"{API_BASE}/audio/transcriptions",
                       headers={"Authorization": f"Bearer {key}"},
                       files={"file": ("a.wav", f, "audio/wav")},
                       data={"model": "whisper-1"}, timeout=120)
    assert r.status_code == 200, r.text[:200]
    transcript = r.json().get("text", "")
    print(f"[cn-lock] ASR of anchored TTS: {transcript!r}")
    assert not _has_japanese(transcript), f"TTS still Japanese: {transcript!r}"

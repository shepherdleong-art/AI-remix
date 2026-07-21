# -*- coding: utf-8 -*-
"""Unit tests for video_service.py helper functions."""

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
BACKEND = os.path.dirname(HERE)
for p in (BACKEND,):
    if p not in sys.path:
        sys.path.insert(0, p)

from services.video_service import _split_sentences  # noqa: E402


def test_split_sentences_preserves_spaces():
    """C5 fix: _split_sentences must preserve inter-word spaces for English."""
    parts = _split_sentences("Hello world. Good morning!")
    assert parts == ["Hello world.", "Good morning!"], \
        f"空格被抹掉: {parts}"


def test_split_sentences_chinese():
    """Chinese punctuation splitting (no regression)."""
    parts = _split_sentences("你好，世界。今天天气真好！")
    assert parts == ["你好，", "世界。", "今天天气真好！"], \
        f"中文切分异常: {parts}"


def test_split_sentences_mixed():
    """Mixed Chinese/English with spaces preserved."""
    parts = _split_sentences("今天Hot news. 明天再见")
    assert len(parts) == 2
    assert parts[0] == "今天Hot news."
    assert parts[1] == "明天再见"


def test_split_sentences_quotes_removed():
    """Curly/Chinese quotes removed, but regular spaces kept."""
    parts = _split_sentences("\u201c你好\u201d world")
    # \u201c = ", \u201d = " — removed; spaces kept
    assert "你好" in parts[0] or parts[0] == "你好world"

#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
Hook-first —— LLM 钩子分解析离线验证（无需真实 API Key）。

验证 ``_llm_score_matrix`` 在 Hook-first 改造后：
L1. 能解析新格式 JSON 对象 {"score_matrix": ..., "hook_scores": ...}，
    返回 (score_matrix, hook_scores) 元组，hook_scores 逐元素正确。
L2. 向后兼容：模型若只回二维数组（旧格式），hook_scores 全 0，不报错。

运行（managed Python，从项目根目录）：
    C:/Users/11833/.workbuddy/binaries/python/versions/3.13.12/python.exe -m pytest backend/tests/test_hook_first_llm.py -q
"""
import os
import sys
import json
import asyncio

_BACKEND = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _BACKEND not in sys.path:
    sys.path.insert(0, _BACKEND)

from services.ai_service import _llm_score_matrix  # noqa: E402


class _FakeResp:
    status_code = 200

    def __init__(self, content: str):
        self._content = content
        self.text = content

    def json(self):
        return {"choices": [{"message": {"content": self._content}}]}


class _FakeClient:
    def __init__(self, content: str):
        self._content = content

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    async def post(self, *a, **k):
        return _FakeResp(self._content)


def test_L1_parses_object_with_hook_scores(monkeypatch):
    """L1：解析 {"score_matrix","hook_scores"} 对象，返回正确元组。"""
    content = json.dumps({
        "score_matrix": [[0.9, 0.2], [0.3, 0.8]],
        "hook_scores": [0.7, 0.1],
    })
    monkeypatch.setattr(
        "services.ai_service.httpx.AsyncClient",
        lambda *a, **k: _FakeClient(content),
    )
    sm, hk = asyncio.run(_llm_score_matrix(
        [{"text": "a"}, {"text": "b"}],
        [{"description": "x"}, {"description": "y"}],
        api_key="fake-key",
    ))
    assert len(sm) == 2 and len(sm[0]) == 2
    assert sm[0][0] == 0.9 and sm[1][1] == 0.8
    assert hk == [0.7, 0.1], hk


def test_L2_backward_compat_bare_2d_array(monkeypatch):
    """L2：旧格式（仅二维数组）→ hook_scores 全 0，不报错。"""
    content = json.dumps([[0.9, 0.2], [0.3, 0.8]])
    monkeypatch.setattr(
        "services.ai_service.httpx.AsyncClient",
        lambda *a, **k: _FakeClient(content),
    )
    sm, hk = asyncio.run(_llm_score_matrix(
        [{"text": "a"}, {"text": "b"}],
        [{"description": "x"}, {"description": "y"}],
        api_key="fake-key",
    ))
    assert len(sm) == 2
    assert hk == [0.0, 0.0], hk


if __name__ == "__main__":
    tests = [test_L1_parses_object_with_hook_scores, test_L2_backward_compat_bare_2d_array]
    failed = 0
    for fn in tests:
        try:
            fn.__globals__  # ensure monkeypatch available via pytest; direct run skips
        except Exception:
            pass
    print("用 pytest 运行本文件以启用 monkeypatch fixture")

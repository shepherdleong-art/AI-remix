"""
Offline unit tests for the multi-provider TTS architecture (qwen + doubao).

Coverage (all offline — no network / no API key required):
  - doubao_proto: binary Message marshal/unmarshal round-trip; connect() sends
    the correct X-Api-* auth headers.
  - doubao_tts: builds the StartSession payload with explicit_language=zh-cn and
    the correct speech_rate mapping; passes the script text VERBATIM (no anchor);
    forwards the configured WSS URL / key / resource-id to connect().
  - text_to_speech: provider dispatch (qwen -> _qwen_tts, doubao -> doubao_tts),
    case-insensitive; unknown / omitted provider falls back to qwen.
  - /voices route: returns the right provider key + voice list per provider.

Live end-to-end verification (real WebSocket + the user's Doubao key) is handled
separately by the user-driven e2e check, not by these offline tests.
"""
import asyncio
import json
import os
import sys
import tempfile
from unittest.mock import AsyncMock, patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from services import ai_service
from services.doubao_proto import (
    Message, MsgType, MsgTypeFlagBits, VersionBits, HeaderSizeBits,
    SerializationBits, CompressionBits, EventType,
)
from routes.ai_editing import list_voices
from config import (
    DOUBAO_VOICES, DOUBAO_MODEL, DOUBAO_WSS_URL, DOUBAO_RESOURCE_ID,
    DOUBAO_DEFAULT_VOICE, DOUBAO_APP_KEY, DOUBAO_ACCESS_KEY,
)


# ─── protocol: marshal/unmarshal round-trip ───────────────
def test_proto_message_roundtrip():
    msg = Message(
        version=VersionBits.Version1,
        header_size=HeaderSizeBits.HeaderSize4,
        type=MsgType.FullServerResponse,
        flag=MsgTypeFlagBits.WithEvent,
        serialization=SerializationBits.JSON,
        compression=CompressionBits.None_,
        event=EventType.TTSResponse,
        session_id="sess-123",
        payload=b'{"audio":"base64data"}',
    )
    raw = msg.marshal()
    back = Message.from_bytes(raw)
    assert back.event == EventType.TTSResponse
    assert back.session_id == "sess-123"
    assert back.payload == b'{"audio":"base64data"}'
    assert back.type == MsgType.FullServerResponse
    assert back.serialization == SerializationBits.JSON


def test_proto_connect_sends_auth_headers():
    async def run():
        captured = {}

        async def fake_ws_connect(uri, **kwargs):
            captured["uri"] = uri
            captured["kwargs"] = kwargs
            conn = AsyncMock()
            conn.__aenter__.return_value = conn
            conn.__aexit__.return_value = False
            return conn

        from services.doubao_proto import connect as raw_connect
        with patch("services.doubao_proto.websockets.connect", new=fake_ws_connect):
            await raw_connect(
                DOUBAO_WSS_URL, app_key="MYAPPKEY", access_key="MYACCESS",
                resource_id=DOUBAO_RESOURCE_ID, connect_id="conn-9",
            )
        return captured

    captured = asyncio.run(run())
    assert captured["uri"] == DOUBAO_WSS_URL
    hdr = captured["kwargs"].get("additional_headers", {})
    assert hdr.get("X-Api-App-Key") == "MYAPPKEY"
    assert hdr.get("X-Api-Access-Key") == "MYACCESS"
    assert "X-Api-Key" not in hdr
    assert hdr.get("X-Api-Resource-Id") == DOUBAO_RESOURCE_ID
    assert hdr.get("X-Api-Connect-Id") == "conn-9"


def test_proto_connect_sends_single_api_key():
    async def run():
        captured = {}

        async def fake_ws_connect(uri, **kwargs):
            captured["uri"] = uri
            captured["kwargs"] = kwargs
            conn = AsyncMock()
            conn.__aenter__.return_value = conn
            conn.__aexit__.return_value = False
            return conn

        from services.doubao_proto import connect as raw_connect
        with patch("services.doubao_proto.websockets.connect", new=fake_ws_connect):
            await raw_connect(
                DOUBAO_WSS_URL, api_key="MYSINGLEKEY",
                resource_id=DOUBAO_RESOURCE_ID, connect_id="conn-10",
            )
        return captured

    captured = asyncio.run(run())
    hdr = captured["kwargs"].get("additional_headers", {})
    assert hdr.get("X-Api-Key") == "MYSINGLEKEY"
    assert "X-Api-App-Key" not in hdr
    assert "X-Api-Access-Key" not in hdr
    assert hdr.get("X-Api-Resource-Id") == DOUBAO_RESOURCE_ID


# ─── doubao_tts: payload + verbatim text + connect forwarding ─
def _run_doubao(voice: str, speed: float):
    sent = []
    audio_data = b"\x00\x01audio"

    conn_started = Message(type=MsgType.FullServerResponse, flag=MsgTypeFlagBits.WithEvent,
                            event=EventType.ConnectionStarted)
    sess_started = Message(type=MsgType.FullServerResponse, flag=MsgTypeFlagBits.WithEvent,
                            event=EventType.SessionStarted)
    audio_msg = Message(type=MsgType.AudioOnlyServer, payload=audio_data)
    finished = Message(type=MsgType.FullServerResponse, flag=MsgTypeFlagBits.WithEvent,
                       event=EventType.SessionFinished)
    recv_q = iter([conn_started, sess_started, audio_msg, finished])

    conn = AsyncMock()
    conn.__aenter__.return_value = conn
    conn.__aexit__.return_value = False

    async def fake_send(ws, event, session_id, payload):
        sent.append((event, session_id, payload))

    async def fake_recv(ws):
        return next(recv_q)

    captured_connect = {}

    async def fake_ws_connect(uri, **kwargs):
        captured_connect["uri"] = uri
        captured_connect["kwargs"] = kwargs
        return conn

    out_path = tempfile.mktemp(suffix=".mp3")

    async def _go():
        with patch("services.doubao_proto.websockets.connect", new=fake_ws_connect), \
             patch.object(ai_service, "doubao_send_event", new=fake_send), \
             patch.object(ai_service, "doubao_recv_message", new=fake_recv), \
             patch.object(ai_service, "normalize_audio", new=lambda p: p):
            result = await ai_service.doubao_tts(
                "高回弹海绵，久坐不塌。", voice=voice,
                output_path=out_path, app_key="DBAPP", access_key="DBACCESS", speed=speed,
            )
        return result

    result = asyncio.run(_go())
    return sent, result, captured_connect


def test_doubao_tts_builds_explicit_language_payload():
    sent, result, cap = _run_doubao(voice="zh_female_qingxin", speed=1.5)

    # connect() forwarded the configured URL / key / resource
    assert cap["uri"] == DOUBAO_WSS_URL
    hdr = cap["kwargs"].get("additional_headers", {})
    assert hdr.get("X-Api-App-Key") == "DBAPP"
    assert hdr.get("X-Api-Access-Key") == "DBACCESS"
    assert hdr.get("X-Api-Resource-Id") == DOUBAO_RESOURCE_ID

    # StartSession payload: namespace/user envelope + explicit_language forces
    # Chinese-only reading. Text is NOT here (it goes in TaskRequest).
    start = [p for (ev, _sid, p) in sent if ev == EventType.StartSession]
    assert len(start) == 1
    payload = json.loads(start[0].decode("utf-8"))
    assert payload["namespace"] == "BidirectionalTTS"
    assert payload["event"] == int(EventType.StartSession)
    rp = payload["req_params"]
    ap = rp["audio_params"]
    assert ap["explicit_language"] == "zh-cn"
    assert ap["sample_rate"] == 24000
    assert rp["speaker"] == "zh_female_qingxin"
    # additions must be a JSON *string* (server rejects an object)
    assert isinstance(rp["additions"], str)
    assert json.loads(rp["additions"])["disable_markdown_filter"] is True
    # speech_rate mapping: 1.5x -> int(round(0.5*100)) = 50
    assert ap["speech_rate"] == 50

    # TaskRequest carries the script text under req_params.text (VERBATIM, no
    # anchor word). Top-level "text" is intentionally NOT used.
    task = [p for (ev, _sid, p) in sent if ev == EventType.TaskRequest]
    assert len(task) == 1
    tp = json.loads(task[0].decode("utf-8"))
    assert tp["req_params"]["text"] == "高回弹海绵，久坐不塌。"
    # client must also emit a FinishSession frame after the text
    finish = [p for (ev, _sid, p) in sent if ev == EventType.FinishSession]
    assert len(finish) == 1

    assert result.endswith(".mp3")


def test_doubao_tts_default_voice_when_empty():
    sent, _result, _cap = _run_doubao(voice="", speed=1.0)
    start = [p for (ev, _sid, p) in sent if ev == EventType.StartSession]
    payload = json.loads(start[0].decode("utf-8"))
    # empty voice -> backend default voice is used
    assert payload["req_params"]["speaker"] == DOUBAO_DEFAULT_VOICE


def test_doubao_tts_speech_rate_mapping():
    # 0.5x -> -50, 2.0x -> 100
    _s1, _r1, _c1 = _run_doubao(voice="x", speed=0.5)
    _s2, _r2, _c2 = _run_doubao(voice="x", speed=2.0)
    sr1 = json.loads([p for (ev, _sid, p) in _s1 if ev == EventType.StartSession][0].decode("utf-8"))["req_params"]["audio_params"]["speech_rate"]
    sr2 = json.loads([p for (ev, _sid, p) in _s2 if ev == EventType.StartSession][0].decode("utf-8"))["req_params"]["audio_params"]["speech_rate"]
    assert sr1 == -50
    assert sr2 == 100


# ─── text_to_speech: provider dispatch ───────────────────
def test_text_to_speech_dispatches_by_provider():
    async def run(provider):
        qwen = AsyncMock(return_value="/tmp/q.mp3")
        doubao = AsyncMock(return_value="/tmp/d.mp3")
        with patch.object(ai_service, "_qwen_tts", new=qwen), \
             patch.object(ai_service, "doubao_tts", new=doubao):
            await ai_service.text_to_speech("hi", "v", "/tmp/o.mp3", "k", 1.0, provider=provider)
        return qwen, doubao

    async def run_default():
        qwen = AsyncMock(return_value="/tmp/q.mp3")
        doubao = AsyncMock(return_value="/tmp/d.mp3")
        with patch.object(ai_service, "_qwen_tts", new=qwen), \
             patch.object(ai_service, "doubao_tts", new=doubao):
            await ai_service.text_to_speech("hi", "v", "/tmp/o.mp3", "k", 1.0)
        return qwen, doubao

    q, d = asyncio.run(run("qwen"))
    assert q.await_count == 1 and d.await_count == 0

    q, d = asyncio.run(run("doubao"))
    assert d.await_count == 1 and q.await_count == 0

    q, d = asyncio.run(run("DOUBAO"))  # case-insensitive
    assert d.await_count == 1 and q.await_count == 0

    q, d = asyncio.run(run("nonsense"))  # unknown -> qwen fallback
    assert q.await_count == 1 and d.await_count == 0

    q, d = asyncio.run(run_default())  # omitted -> qwen
    assert q.await_count == 1 and d.await_count == 0


# ─── /voices endpoint: per-provider lists ────────────────
def test_voices_endpoint_per_provider():
    d = asyncio.run(list_voices("doubao"))
    assert d["code"] == 0
    assert d["data"]["provider"] == "doubao"
    vs = d["data"]["voices"]
    assert len(vs) == len(DOUBAO_VOICES) and len(vs) > 0
    assert all("id" in v and "name" in v for v in vs)

    q = asyncio.run(list_voices("qwen"))
    assert q["data"]["provider"] == "qwen"
    assert len(q["data"]["voices"]) >= 16
    assert all("id" in v and "name" in v for v in q["data"]["voices"])

    default = asyncio.run(list_voices("QWEN"))  # case-insensitive
    assert default["data"]["provider"] == "qwen"

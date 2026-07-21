"""
Doubao (Volcano Engine / 字节) bidirectional TTS WebSocket protocol.

Vendored & trimmed from the official "TTS Websocket Bidirection protocols"
reference. This is a binary framing protocol (not JSON-over-text), so the
exact bit layout below MUST match the server's expectation.

Public helpers:
  - connect(uri, api_key, resource_id, connect_id) -> websockets connection
  - send_event(ws, event, session_id, payload_bytes)
  - recv_message(ws) -> Message
  - the Message class (marshal / unmarshal)

Only dependency: `websockets`.
"""
from __future__ import annotations

import io
import json
import logging
import struct
from dataclasses import dataclass
from enum import IntEnum
from typing import Callable

import websockets

logger = logging.getLogger(__name__)


class MsgType(IntEnum):
    Invalid = 0
    FullClientRequest = 0b1
    AudioOnlyClient = 0b10
    FullServerResponse = 0b1001
    AudioOnlyServer = 0b1011
    FrontEndResultServer = 0b1100
    Error = 0b1111


class MsgTypeFlagBits(IntEnum):
    NoSeq = 0
    PositiveSeq = 0b1
    LastNoSeq = 0b10
    NegativeSeq = 0b11
    WithEvent = 0b100


class VersionBits(IntEnum):
    Version1 = 1
    Version2 = 2
    Version3 = 3
    Version4 = 4


class HeaderSizeBits(IntEnum):
    HeaderSize4 = 1
    HeaderSize8 = 2
    HeaderSize12 = 3
    HeaderSize16 = 4


class SerializationBits(IntEnum):
    Raw = 0
    JSON = 0b1
    Thrift = 0b11
    Custom = 0b1111


class CompressionBits(IntEnum):
    None_ = 0
    Gzip = 0b1
    Custom = 0b1111


class EventType(IntEnum):
    None_ = 0
    StartConnection = 1
    FinishConnection = 2
    ConnectionStarted = 50
    ConnectionFailed = 51
    ConnectionFinished = 52
    StartSession = 100
    CancelSession = 101
    FinishSession = 102
    SessionStarted = 150
    SessionCanceled = 151
    SessionFinished = 152
    SessionFailed = 153
    TaskRequest = 200
    TTSSentenceStart = 350
    TTSSentenceEnd = 351
    TTSResponse = 352
    TTSSubtitle = 364
    TTSEnded = 359


@dataclass
class Message:
    version: VersionBits = VersionBits.Version1
    header_size: HeaderSizeBits = HeaderSizeBits.HeaderSize4
    type: MsgType = MsgType.Invalid
    flag: MsgTypeFlagBits = MsgTypeFlagBits.NoSeq
    serialization: SerializationBits = SerializationBits.JSON
    compression: CompressionBits = CompressionBits.None_

    event: EventType = EventType.None_
    session_id: str = ""
    connect_id: str = ""
    sequence: int = 0
    error_code: int = 0

    payload: bytes = b""

    # ── marshalling ───────────────────────────────────────
    def marshal(self) -> bytes:
        buffer = io.BytesIO()
        header = [
            (self.version << 4) | self.header_size,
            (self.type << 4) | self.flag,
            (self.serialization << 4) | self.compression,
        ]
        header_size = 4 * self.header_size
        if padding := header_size - len(header):
            header.extend([0] * padding)
        buffer.write(bytes(header))

        for writer in self._get_writers():
            writer(buffer)
        return buffer.getvalue()

    def unmarshal(self, data: bytes) -> None:
        buffer = io.BytesIO(data)
        version_and_header_size = buffer.read(1)[0]
        self.version = VersionBits(version_and_header_size >> 4)
        self.header_size = HeaderSizeBits(version_and_header_size & 0b00001111)
        type_flag = buffer.read(1)[0]
        self.type = MsgType(type_flag >> 4)
        self.flag = MsgTypeFlagBits(type_flag & 0b00001111)
        serialization_compression = buffer.read(1)[0]
        self.serialization = SerializationBits(serialization_compression >> 4)
        self.compression = CompressionBits(serialization_compression & 0b00001111)
        header_size = 4 * self.header_size
        read_size = 3
        if padding_size := header_size - read_size:
            buffer.read(padding_size)
        for reader in self._get_readers():
            reader(buffer)

    def _get_writers(self) -> list[Callable[[io.BytesIO], None]]:
        writers: list[Callable[[io.BytesIO], None]] = []
        if self.flag == MsgTypeFlagBits.WithEvent:
            writers.extend([self._write_event, self._write_session_id])
        if self.type in [
            MsgType.FullClientRequest,
            MsgType.FullServerResponse,
            MsgType.FrontEndResultServer,
            MsgType.AudioOnlyClient,
            MsgType.AudioOnlyServer,
        ]:
            if self.flag in [MsgTypeFlagBits.PositiveSeq, MsgTypeFlagBits.NegativeSeq]:
                writers.append(self._write_sequence)
        elif self.type == MsgType.Error:
            writers.append(self._write_error_code)
        else:
            raise ValueError(f"Unsupported message type: {self.type}")
        writers.append(self._write_payload)
        return writers

    def _get_readers(self) -> list[Callable[[io.BytesIO], None]]:
        readers: list[Callable[[io.BytesIO], None]] = []
        if self.type in [
            MsgType.FullClientRequest,
            MsgType.FullServerResponse,
            MsgType.FrontEndResultServer,
            MsgType.AudioOnlyClient,
            MsgType.AudioOnlyServer,
        ]:
            if self.flag in [MsgTypeFlagBits.PositiveSeq, MsgTypeFlagBits.NegativeSeq]:
                readers.append(self._read_sequence)
        elif self.type == MsgType.Error:
            readers.append(self._read_error_code)
        else:
            raise ValueError(f"Unsupported message type: {self.type}")
        if self.flag == MsgTypeFlagBits.WithEvent:
            readers.extend([self._read_event, self._read_session_id, self._read_connect_id])
        readers.append(self._read_payload)
        return readers

    def _write_event(self, buffer: io.BytesIO) -> None:
        buffer.write(struct.pack(">i", int(self.event)))

    def _write_session_id(self, buffer: io.BytesIO) -> None:
        if self.event in [
            EventType.StartConnection,
            EventType.FinishConnection,
            EventType.ConnectionStarted,
            EventType.ConnectionFailed,
        ]:
            return
        sid = self.session_id.encode("utf-8")
        buffer.write(struct.pack(">I", len(sid)))
        if sid:
            buffer.write(sid)

    def _write_sequence(self, buffer: io.BytesIO) -> None:
        buffer.write(struct.pack(">i", self.sequence))

    def _write_error_code(self, buffer: io.BytesIO) -> None:
        buffer.write(struct.pack(">I", self.error_code))

    def _write_payload(self, buffer: io.BytesIO) -> None:
        buffer.write(struct.pack(">I", len(self.payload)))
        buffer.write(self.payload)

    def _read_event(self, buffer: io.BytesIO) -> None:
        b = buffer.read(4)
        if b:
            try:
                self.event = EventType(struct.unpack(">i", b)[0])
            except ValueError:
                self.event = EventType(struct.unpack(">i", b)[0])  # keep raw int

    def _read_session_id(self, buffer: io.BytesIO) -> None:
        if self.event in [
            EventType.StartConnection,
            EventType.FinishConnection,
            EventType.ConnectionStarted,
            EventType.ConnectionFailed,
            EventType.ConnectionFinished,
        ]:
            return
        b = buffer.read(4)
        if b:
            size = struct.unpack(">I", b)[0]
            if size > 0:
                self.session_id = buffer.read(size).decode("utf-8")

    def _read_connect_id(self, buffer: io.BytesIO) -> None:
        if self.event in [
            EventType.ConnectionStarted,
            EventType.ConnectionFailed,
            EventType.ConnectionFinished,
        ]:
            b = buffer.read(4)
            if b:
                size = struct.unpack(">I", b)[0]
                if size > 0:
                    self.connect_id = buffer.read(size).decode("utf-8")

    def _read_sequence(self, buffer: io.BytesIO) -> None:
        b = buffer.read(4)
        if b:
            self.sequence = struct.unpack(">i", b)[0]

    def _read_error_code(self, buffer: io.BytesIO) -> None:
        b = buffer.read(4)
        if b:
            self.error_code = struct.unpack(">I", b)[0]

    def _read_payload(self, buffer: io.BytesIO) -> None:
        b = buffer.read(4)
        if b:
            size = struct.unpack(">I", b)[0]
            if size > 0:
                self.payload = buffer.read(size)

    @classmethod
    def from_bytes(cls, data: bytes) -> "Message":
        if len(data) < 3:
            raise ValueError(f"Data too short: expected >=3 bytes, got {len(data)}")
        msg = cls()
        msg.unmarshal(data)
        return msg


# ─── high-level helpers ────────────────────────────────────

def _new_event(event: EventType, session_id: str, payload: bytes) -> Message:
    msg = Message(
        type=MsgType.FullClientRequest,
        flag=MsgTypeFlagBits.WithEvent,
        serialization=SerializationBits.JSON,
        compression=CompressionBits.None_,
        event=event,
        session_id=session_id,
        payload=payload,
    )
    return msg


async def send_event(ws, event: EventType, session_id: str, payload: bytes) -> None:
    msg = _new_event(event, session_id, payload)
    await ws.send(msg.marshal())


async def recv_message(ws) -> Message:
    data = await ws.recv()
    if isinstance(data, str):
        raise ValueError(f"Unexpected text frame from Doubao WS: {data[:200]}")
    return Message.from_bytes(data)


async def connect(
    uri: str,
    api_key: str = "",
    app_key: str = "",
    access_key: str = "",
    resource_id: str = "",
    connect_id: str = "",
):
    """Open a Doubao TTS WebSocket connection with auth headers.

    Volcano Engine's openspeech TTS service supports two auth models (per
    the official bidirection WebSocket docs):
      - New console (recommended): a single API Key sent as ``X-Api-Key``,
        obtained from 控制台 > API Key 管理.
      - Old console: a matched pair ``X-Api-App-Key`` (App Key) +
        ``X-Api-Access-Key`` (Access Token) that belong to the same app.
    If ``api_key`` is provided it is used as the single ``X-Api-Key``;
    otherwise the app_key/access_key pair is sent.
    """
    headers = {
        "X-Api-Resource-Id": resource_id,
        "X-Api-Connect-Id": connect_id,
    }
    if api_key:
        headers["X-Api-Key"] = api_key
    else:
        if app_key:
            headers["X-Api-App-Key"] = app_key
        if access_key:
            headers["X-Api-Access-Key"] = access_key
    return await websockets.connect(uri, additional_headers=headers)

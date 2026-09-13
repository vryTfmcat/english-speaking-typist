#!/usr/bin/env python3
"""Local-only server for the English Speaking Typist prototype."""

from __future__ import annotations

import argparse
import hashlib
import json
import mimetypes
import os
import shutil
import subprocess
import tempfile
import threading
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Tuple, Union
from urllib.parse import unquote, urlparse


ROOT = Path(__file__).resolve().parent
STATIC_ROOT = ROOT / "static"
DATA_ROOT = ROOT / "data"
PHONEMES_PATH = DATA_ROOT / "phonemes.json"
HOST = "127.0.0.1"
PORT = 8775
MAX_TEXT_CHARS = 256
MAX_BODY_BYTES = 4096
DEFAULT_RATE = 145
MIN_RATE = 80
MAX_RATE = 250
CACHE_ROOT = Path(tempfile.gettempdir()) / "english-speaking-typist-v2"
BUILD_ID = "phoneme-direct-v2"


class ApiError(Exception):
    """An error safe to return to the browser."""

    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


def normalize_text(value: object) -> str:
    if not isinstance(value, str):
        raise ApiError(HTTPStatus.BAD_REQUEST, "text 必须是字符串")
    normalized = " ".join(value.strip().split())
    if not normalized:
        raise ApiError(HTTPStatus.BAD_REQUEST, "请输入英文内容")
    if len(normalized) > MAX_TEXT_CHARS:
        raise ApiError(
            HTTPStatus.REQUEST_ENTITY_TOO_LARGE,
            "输入不能超过 {} 个字符".format(MAX_TEXT_CHARS),
        )
    return normalized


def normalize_rate(value: object) -> int:
    if value is None:
        return DEFAULT_RATE
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ApiError(HTTPStatus.BAD_REQUEST, "rate 必须是数字")
    rate = int(value)
    if not MIN_RATE <= rate <= MAX_RATE:
        raise ApiError(
            HTTPStatus.BAD_REQUEST,
            "rate 必须在 {} 到 {} 之间".format(MIN_RATE, MAX_RATE),
        )
    return rate


def find_espeak() -> Path:
    executable = shutil.which("espeak-ng")
    if not executable:
        raise ApiError(
            HTTPStatus.SERVICE_UNAVAILABLE,
            "找不到 eSpeak NG，请先运行 brew install espeak-ng",
        )
    return Path(executable)


def load_phonemes(path: Path = PHONEMES_PATH) -> Tuple[List[dict], Dict[str, dict]]:
    records = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(records, list):
        raise RuntimeError("phonemes.json 必须是数组")
    by_id = {record["id"]: record for record in records}
    if len(records) != 40 or len(by_id) != 40:
        raise RuntimeError("phonemes.json 必须包含 40 个唯一音素")
    return records, by_id


class SpeechService:
    """Safe eSpeak wrapper with a temp-directory WAV cache."""

    def __init__(self, executable: Optional[Path] = None) -> None:
        self.executable = executable or find_espeak()
        self.phonemes, self.phonemes_by_id = load_phonemes()
        self.cache_root = CACHE_ROOT
        self.cache_root.mkdir(parents=True, exist_ok=True)
        self._cache_lock = threading.Lock()

    def version(self) -> str:
        completed = subprocess.run(
            [str(self.executable), "--version"],
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=5,
        )
        return completed.stdout.decode("utf-8", errors="replace").splitlines()[0]

    def _run(self, arguments: Iterable[str], text: str) -> bytes:
        completed = subprocess.run(
            [str(self.executable)] + list(arguments),
            input=text.encode("utf-8"),
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=10,
        )
        return completed.stdout

    def analyze(self, value: object) -> dict:
        text = normalize_text(value)
        ipa = self._run(["-q", "--ipa", "-v", "en-us"], text).decode(
            "utf-8", errors="replace"
        )
        espeak = self._run(["-q", "-x", "-v", "en-us"], text).decode(
            "utf-8", errors="replace"
        )
        return {
            "text": text,
            "ipa": " ".join(ipa.strip().split()),
            "espeak": " ".join(espeak.strip().split()),
        }

    def phoneme_expression(self, value: object) -> Tuple[List[str], str]:
        if not isinstance(value, list) or not value:
            raise ApiError(
                HTTPStatus.BAD_REQUEST,
                "phonemes 模式的 value 必须是非空音素 ID 数组",
            )
        if len(value) > 80:
            raise ApiError(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "音素序列过长")

        ids: List[str] = []
        expressions: List[str] = []
        for item in value:
            if item == "BOUNDARY":
                ids.append(item)
                expressions.append(" ")
                continue
            if not isinstance(item, str) or item not in self.phonemes_by_id:
                raise ApiError(HTTPStatus.BAD_REQUEST, "包含未知音素 ID")
            ids.append(item)
            expressions.append(self.phonemes_by_id[item]["espeak"])

        expression = "".join(expressions).strip()
        if not expression:
            raise ApiError(HTTPStatus.BAD_REQUEST, "音素序列不能为空")
        return ids, expression

    def _cache_key(self, mode: str, value: Union[str, List[str]], rate: int) -> str:
        payload = json.dumps(
            {"mode": mode, "value": value, "rate": rate, "voice": "en-us"},
            ensure_ascii=False,
            sort_keys=True,
        ).encode("utf-8")
        return hashlib.sha256(payload).hexdigest()

    def synthesize(self, mode: object, value: object, rate_value: object) -> bytes:
        if mode not in {"text", "phonemes"}:
            raise ApiError(HTTPStatus.BAD_REQUEST, "mode 必须是 text 或 phonemes")
        rate = normalize_rate(rate_value)

        if mode == "text":
            normalized: Union[str, List[str]] = normalize_text(value)
            source_text = normalized
            arguments = ["-v", "en-us", "-s", str(rate), "--stdout"]
        else:
            ids, expression = self.phoneme_expression(value)
            normalized = ids
            # eSpeak's [[...]] direct-phoneme mode must not be followed by an
            # SSML closing tag: after leaving the brackets it would pronounce
            # </speak> literally as "slash speak". Feed the whitelisted direct
            # phonemes without XML markup instead.
            source_text = "[[{}]]".format(expression)
            arguments = ["-v", "en-us", "-s", str(rate), "--stdout"]

        cache_path = self.cache_root / (self._cache_key(mode, normalized, rate) + ".wav")
        with self._cache_lock:
            if cache_path.is_file():
                return cache_path.read_bytes()
            wav = self._run(arguments, str(source_text))
            if not wav.startswith(b"RIFF"):
                raise ApiError(HTTPStatus.BAD_GATEWAY, "eSpeak 没有返回有效 WAV")
            temporary = cache_path.with_suffix(".tmp")
            temporary.write_bytes(wav)
            os.replace(str(temporary), str(cache_path))
            return wav

    def warm_cache(self) -> None:
        for letter in "abcdefghijklmnopqrstuvwxyz":
            try:
                self.synthesize("text", letter, DEFAULT_RATE)
            except Exception as exc:  # pragma: no cover - startup diagnostic
                print("预生成字母音频失败 {}: {}".format(letter, exc))
        for record in self.phonemes:
            try:
                self.synthesize("phonemes", [record["id"]], DEFAULT_RATE)
            except Exception as exc:  # pragma: no cover - startup diagnostic
                print("预生成音素音频失败 {}: {}".format(record["id"], exc))


SERVICE: Optional[SpeechService] = None


class AppHandler(BaseHTTPRequestHandler):
    server_version = "EnglishSpeakingTypist/1.0"

    def log_message(self, fmt: str, *args: object) -> None:
        print("[{}] {}".format(self.log_date_time_string(), fmt % args))

    def _send_bytes(
        self, status: int, body: bytes, content_type: str, cache: str = "no-store"
    ) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def _send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self._send_bytes(status, body, "application/json; charset=utf-8")

    def _read_json(self) -> dict:
        content_length = self.headers.get("Content-Length")
        if content_length is None:
            raise ApiError(HTTPStatus.LENGTH_REQUIRED, "缺少 Content-Length")
        try:
            size = int(content_length)
        except ValueError:
            raise ApiError(HTTPStatus.BAD_REQUEST, "无效的 Content-Length")
        if size < 0 or size > MAX_BODY_BYTES:
            raise ApiError(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "请求正文过大")
        try:
            payload = json.loads(self.rfile.read(size).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise ApiError(HTTPStatus.BAD_REQUEST, "请求必须是 UTF-8 JSON")
        if not isinstance(payload, dict):
            raise ApiError(HTTPStatus.BAD_REQUEST, "请求 JSON 必须是对象")
        return payload

    def _static_target(self, request_path: str) -> Optional[Path]:
        if request_path == "/":
            return STATIC_ROOT / "index.html"
        roots = (("/static/", STATIC_ROOT), ("/data/", DATA_ROOT))
        for prefix, root in roots:
            if request_path.startswith(prefix):
                relative = unquote(request_path[len(prefix) :])
                target = (root / relative).resolve()
                try:
                    target.relative_to(root.resolve())
                except ValueError:
                    return None
                return target
        return None

    def do_GET(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if path == "/api/health":
            if SERVICE is None:
                self._send_json(
                    HTTPStatus.SERVICE_UNAVAILABLE,
                    {"ok": False, "error": "语音服务尚未初始化"},
                )
                return
            try:
                self._send_json(
                    HTTPStatus.OK,
                    {
                        "ok": True,
                        "engine": SERVICE.version(),
                        "voice": "en-us",
                        "build": BUILD_ID,
                    },
                )
            except Exception as exc:
                self._send_json(
                    HTTPStatus.SERVICE_UNAVAILABLE,
                    {"ok": False, "error": str(exc)},
                )
            return

        target = self._static_target(path)
        if target is None or not target.is_file():
            self._send_json(HTTPStatus.NOT_FOUND, {"error": "未找到资源"})
            return
        content_type = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
        if content_type.startswith("text/") or content_type in {
            "application/javascript",
            "application/json",
        }:
            content_type += "; charset=utf-8"
        self._send_bytes(HTTPStatus.OK, target.read_bytes(), content_type, "no-cache")

    def do_POST(self) -> None:  # noqa: N802
        if SERVICE is None:
            self._send_json(
                HTTPStatus.SERVICE_UNAVAILABLE,
                {"error": "语音服务尚未初始化"},
            )
            return
        try:
            payload = self._read_json()
            path = urlparse(self.path).path
            if path == "/api/analyze":
                self._send_json(HTTPStatus.OK, SERVICE.analyze(payload.get("text")))
            elif path == "/api/speech":
                wav = SERVICE.synthesize(
                    payload.get("mode"), payload.get("value"), payload.get("rate")
                )
                self._send_bytes(HTTPStatus.OK, wav, "audio/wav")
            else:
                self._send_json(HTTPStatus.NOT_FOUND, {"error": "未找到接口"})
        except ApiError as exc:
            self._send_json(exc.status, {"error": exc.message})
        except subprocess.TimeoutExpired:
            self._send_json(HTTPStatus.GATEWAY_TIMEOUT, {"error": "语音合成超时"})
        except subprocess.CalledProcessError as exc:
            message = exc.stderr.decode("utf-8", errors="replace").strip()
            self._send_json(
                HTTPStatus.BAD_GATEWAY,
                {"error": message or "eSpeak 执行失败"},
            )
        except Exception as exc:  # pragma: no cover - final safety net
            self._send_json(
                HTTPStatus.INTERNAL_SERVER_ERROR,
                {"error": "服务错误：{}".format(exc)},
            )


def create_server(port: int = PORT) -> ThreadingHTTPServer:
    return ThreadingHTTPServer((HOST, port), AppHandler)


def parse_args(argv: Optional[List[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="启动英语发声打字机本地服务")
    parser.add_argument(
        "--port",
        type=int,
        default=PORT,
        help="监听端口（默认：{}）".format(PORT),
    )
    args = parser.parse_args(argv)
    if not 1 <= args.port <= 65535:
        parser.error("--port 必须在 1 到 65535 之间")
    return args


def main(argv: Optional[List[str]] = None) -> int:
    global SERVICE
    args = parse_args(argv)
    try:
        SERVICE = SpeechService()
    except ApiError as exc:
        print(exc.message)
        return 1

    server = create_server(args.port)
    warmer = threading.Thread(target=SERVICE.warm_cache, daemon=True)
    warmer.start()
    print("英语发声打字机：http://{}:{}".format(HOST, args.port))
    print("按 Ctrl+C 停止；所有数据只保存在本机。")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止。")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

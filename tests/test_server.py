from __future__ import annotations

import json
import shutil
import sys
import tempfile
import threading
import unittest
import urllib.request
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import server as app_server  # noqa: E402


class ValidationTests(unittest.TestCase):
    def test_port_argument(self) -> None:
        self.assertEqual(app_server.parse_args(["--port", "8780"]).port, 8780)

    def test_text_is_normalized_and_limited(self) -> None:
        self.assertEqual(app_server.normalize_text("  hello   world  "), "hello world")
        with self.assertRaises(app_server.ApiError) as context:
            app_server.normalize_text("a" * 257)
        self.assertEqual(context.exception.status, 413)

    def test_missing_espeak_is_reported(self) -> None:
        with mock.patch("server.shutil.which", return_value=None):
            with self.assertRaises(app_server.ApiError) as context:
                app_server.find_espeak()
        self.assertEqual(context.exception.status, 503)

    def test_unknown_phoneme_is_rejected(self) -> None:
        service = app_server.SpeechService(executable=Path("/fake/espeak-ng"))
        with self.assertRaises(app_server.ApiError):
            service.phoneme_expression(["K", "NOT_A_PHONE"])

    def test_phoneme_expression_uses_whitelist(self) -> None:
        service = app_server.SpeechService(executable=Path("/fake/espeak-ng"))
        ids, expression = service.phoneme_expression(["K", "AE", "T"])
        self.assertEqual(ids, ["K", "AE", "T"])
        self.assertEqual(expression, "kat")

    def test_analyze_parses_ipa_and_espeak_output(self) -> None:
        service = app_server.SpeechService(executable=Path("/fake/espeak-ng"))
        with mock.patch.object(service, "_run", side_effect=[b"k\xcb\x88\xc3\xa6t\n", b"k'at\n"]):
            result = service.analyze("cat")
        self.assertEqual(result["text"], "cat")
        self.assertEqual(result["ipa"], "kˈæt")
        self.assertEqual(result["espeak"], "k'at")

    def test_synthesize_requires_valid_wav(self) -> None:
        service = app_server.SpeechService(executable=Path("/fake/espeak-ng"))
        with tempfile.TemporaryDirectory() as directory:
            service.cache_root = Path(directory)
            with mock.patch.object(service, "_run", return_value=b"not wave data"):
                with self.assertRaises(app_server.ApiError):
                    service.synthesize("text", "unique invalid fixture", 145)

    def test_phoneme_synthesis_does_not_pronounce_ssml_closing_tag(self) -> None:
        service = app_server.SpeechService(executable=Path("/fake/espeak-ng"))
        with tempfile.TemporaryDirectory() as directory:
            service.cache_root = Path(directory)
            with mock.patch.object(service, "_run", return_value=b"RIFFfixture") as run:
                service.synthesize("phonemes", ["K", "AE", "T"], 145)
        arguments, source_text = run.call_args.args
        self.assertNotIn("-m", arguments)
        self.assertEqual(source_text, "[[kat]]")


class DataTests(unittest.TestCase):
    def test_lesson_and_phoneme_data_are_consistent(self) -> None:
        phonemes = json.loads((ROOT / "data" / "phonemes.json").read_text(encoding="utf-8"))
        lessons = json.loads((ROOT / "data" / "lessons.json").read_text(encoding="utf-8"))
        ids = {record["id"] for record in phonemes}
        self.assertEqual(len(phonemes), 40)
        self.assertEqual(len(ids), 40)
        self.assertEqual(len(lessons), 30)
        self.assertEqual({item["category"] for item in lessons}, {"界面英语", "编程英语"})
        self.assertEqual(sum(item["category"] == "界面英语" for item in lessons), 15)
        self.assertEqual(sum(item["category"] == "编程英语" for item in lessons), 15)
        for lesson in lessons:
            self.assertEqual("".join(part["letters"] for part in lesson["segments"]), lesson["word"])
            self.assertTrue(set(lesson["phonemes"]).issubset(ids), lesson["word"])
            for segment in lesson["segments"]:
                self.assertTrue(set(segment["phonemes"]).issubset(ids), lesson["word"])


@unittest.skipUnless(shutil.which("espeak-ng"), "eSpeak NG is not installed")
class HttpIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.previous_service = app_server.SERVICE
        app_server.SERVICE = app_server.SpeechService()
        cls.httpd = app_server.create_server(0)
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()
        cls.base_url = "http://127.0.0.1:{}".format(cls.httpd.server_address[1])

    @classmethod
    def tearDownClass(cls) -> None:
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.thread.join(timeout=2)
        app_server.SERVICE = cls.previous_service

    def test_health_and_wav_response_headers(self) -> None:
        with urllib.request.urlopen(self.base_url + "/api/health", timeout=5) as response:
            health = json.loads(response.read().decode("utf-8"))
            self.assertTrue(health["ok"])

        request = urllib.request.Request(
            self.base_url + "/api/speech",
            data=json.dumps({"mode": "text", "value": "header fixture", "rate": 145}).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=10) as response:
            body = response.read()
            self.assertEqual(response.headers.get_content_type(), "audio/wav")
            self.assertTrue(body.startswith(b"RIFF"))


if __name__ == "__main__":
    unittest.main()

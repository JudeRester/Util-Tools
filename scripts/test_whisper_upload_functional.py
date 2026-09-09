"""
scripts/test_whisper_upload_functional.py
Whisper Audio Drag & Drop & Upload Endpoint Functional Verification Tests
"""

import os
import sys
import json
import io
import time
import wave
import struct
import tempfile
import unittest
from pathlib import Path

# Workspace Root
_PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(_PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(_PROJECT_ROOT))

# Ensure UTF-8 console output on Windows
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

from bottle import request, response, FileUpload
from core.paths import AUDIO_DIR
from services.whisper_service import (
    handle_audio_upload,
    add_audio_files,
    get_audio_library,
    delete_audio_file
)
from services.db_service import get_db_connection


def create_test_wav_bytes(duration_sec: float = 1.0, sample_rate: int = 16000) -> bytes:
    """메모리 상에서 유효한 16kHz mono WAV 바이너리 데이터 생성"""
    buf = io.BytesIO()
    num_frames = int(duration_sec * sample_rate)
    with wave.open(buf, 'wb') as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(sample_rate)
        data = struct.pack(f'<{num_frames}h', *([0] * num_frames))
        wav_file.writeframes(data)
    return buf.getvalue()


def create_test_mp3_bytes(duration_sec: float = 1.0, sample_rate: int = 16000) -> bytes:
    """PyAV를 사용해 메모리 상에서 유효한 MP3 바이너리 생성"""
    import av, numpy as np
    t = np.linspace(0, duration_sec, int(sample_rate * duration_sec), endpoint=False)
    samples = (np.sin(2 * np.pi * 440 * t) * 16384).astype(np.int16)
    temp_f = tempfile.NamedTemporaryFile(suffix='.mp3', delete=False)
    temp_path = temp_f.name
    temp_f.close()
    try:
        with av.open(temp_path, mode='w') as container:
            stream = container.add_stream('mp3', rate=sample_rate)
            frame = av.AudioFrame.from_ndarray(samples.reshape(1, -1), format='s16', layout='mono')
            frame.sample_rate = sample_rate
            frame.pts = 0
            for packet in stream.encode(frame):
                container.mux(packet)
            for packet in stream.encode():
                container.mux(packet)
        with open(temp_path, 'rb') as f:
            return f.read()
    finally:
        if os.path.exists(temp_path):
            os.remove(temp_path)


def create_test_ogg_bytes(duration_sec: float = 1.0, sample_rate: int = 16000) -> bytes:
    """PyAV를 사용해 메모리 상에서 유효한 OGG 바이너리 생성"""
    import av, numpy as np
    t = np.linspace(0, duration_sec, int(sample_rate * duration_sec), endpoint=False)
    samples = (np.sin(2 * np.pi * 440 * t) * 16384).astype(np.int16)
    temp_f = tempfile.NamedTemporaryFile(suffix='.ogg', delete=False)
    temp_path = temp_f.name
    temp_f.close()
    try:
        with av.open(temp_path, mode='w', format='ogg') as container:
            stream = container.add_stream('flac', rate=sample_rate)
            frame = av.AudioFrame.from_ndarray(samples.reshape(1, -1), format='s16', layout='mono')
            frame.sample_rate = sample_rate
            frame.pts = 0
            for packet in stream.encode(frame):
                container.mux(packet)
            for packet in stream.encode():
                container.mux(packet)
        with open(temp_path, 'rb') as f:
            return f.read()
    finally:
        if os.path.exists(temp_path):
            os.remove(temp_path)


class TestWhisperAudioUploadFunctional(unittest.TestCase):
    """Whisper 바이너리 업로드 엔드포인트 및 드래그 앤 드롭 백엔드 로직 검증"""

    def setUp(self):
        self.cleanup_audio_ids = []
        self.cleanup_files = []

    def tearDown(self):
        conn = get_db_connection()
        try:
            for aid in self.cleanup_audio_ids:
                try:
                    delete_audio_file(aid)
                except Exception:
                    pass
        finally:
            conn.close()

        for fp in self.cleanup_files:
            if os.path.exists(fp):
                try:
                    os.remove(fp)
                except OSError:
                    pass

    def _setup_request_env(self, files_dict=None, headers=None, method="POST"):
        """Bottle request 환경을 모의 구성"""
        request.environ.clear()
        request.environ["REQUEST_METHOD"] = method
        request.environ["REMOTE_ADDR"] = "127.0.0.1"
        request.environ["HTTP_HOST"] = "127.0.0.1:8000"
        request.environ["HTTP_SEC_FETCH_SITE"] = "same-origin"

        if headers:
            for k, v in headers.items():
                env_key = "HTTP_" + k.upper().replace("-", "_")
                request.environ[env_key] = v

        # files 설정
        request.files.clear()
        if files_dict:
            for field, upload_list in files_dict.items():
                for up in upload_list:
                    request.files[field] = up

    def test_upload_valid_wav_file(self):
        """정상 WAV 오디오 파일 업로드 시 data/audio 저장 및 DB 등록 검증"""
        wav_bytes = create_test_wav_bytes(duration_sec=1.5)
        file_obj = io.BytesIO(wav_bytes)
        upload = FileUpload(file_obj, "file", "test_recording.wav")

        self._setup_request_env(files_dict={"file": [upload]})
        res_json = handle_audio_upload()
        res = json.loads(res_json)

        self.assertTrue(res.get("success"), f"업로드 실패: {res}")
        self.assertEqual(len(res["added"]), 1)
        item = res["added"][0]
        self.cleanup_audio_ids.append(item["id"])
        self.cleanup_files.append(item["file_path"])

        self.assertTrue(os.path.exists(item["file_path"]), "오디오 파일이 디스크에 존재하지 않음")
        self.assertEqual(item["file_size"], len(wav_bytes))
        self.assertAlmostEqual(item["duration_sec"], 1.5, delta=0.2)
        self.assertTrue(item["file_path"].startswith(os.path.abspath(AUDIO_DIR)))

    def test_upload_duplicate_file_reuse(self):
        """동일한 내용의 파일을 재업로드할 때 디스크 중복 생성 없이 기존 레코드 재사용 검증"""
        wav_bytes = create_test_wav_bytes(duration_sec=1.0)

        # 1차 업로드
        upload1 = FileUpload(io.BytesIO(wav_bytes), "file", "dup_test.wav")
        self._setup_request_env(files_dict={"file": [upload1]})
        res1 = json.loads(handle_audio_upload())
        self.assertTrue(res1["success"])
        item1 = res1["added"][0]
        self.cleanup_audio_ids.append(item1["id"])
        self.cleanup_files.append(item1["file_path"])

        # 2차 업로드 (동일 파일명, 동일 내용)
        upload2 = FileUpload(io.BytesIO(wav_bytes), "file", "dup_test.wav")
        self._setup_request_env(files_dict={"file": [upload2]})
        res2 = json.loads(handle_audio_upload())
        self.assertTrue(res2["success"])
        item2 = res2["added"][0]

        # 동일한 오디오 ID가 반환되어야 함
        self.assertEqual(item1["id"], item2["id"], "동일 파일 업로드 시 기존 레코드가 재사용되지 않음")
        self.assertEqual(item1["file_path"], item2["file_path"])

    def test_upload_invalid_extension(self):
        """지원되지 않는 확장자 업로드 시 거부 검증"""
        dummy_bytes = b"NOT AN AUDIO"
        upload = FileUpload(io.BytesIO(dummy_bytes), "file", "dangerous_script.exe")

        self._setup_request_env(files_dict={"file": [upload]})
        res_json = handle_audio_upload()
        res = json.loads(res_json)

        self.assertFalse(res.get("success"))
        self.assertEqual(res.get("skipped_count"), 1)

    def test_upload_empty_file(self):
        """0바이트 빈 파일 업로드 시 거부 검증"""
        upload = FileUpload(io.BytesIO(b""), "file", "empty_voice.ogg")

        self._setup_request_env(files_dict={"file": [upload]})
        res_json = handle_audio_upload()
        res = json.loads(res_json)

        self.assertFalse(res.get("success"))
        self.assertEqual(res.get("skipped_count"), 1)

    def test_upload_mp3_and_ogg_files(self):
        """실제 MP3 및 OGG 파일 업로드 시 PyAV 디코딩 및 DB 등록 정상 동작 검증"""
        mp3_bytes = create_test_mp3_bytes(duration_sec=1.0)
        ogg_bytes = create_test_ogg_bytes(duration_sec=1.0)

        upload_mp3 = FileUpload(io.BytesIO(mp3_bytes), "file", "test_track.mp3")
        upload_ogg = FileUpload(io.BytesIO(ogg_bytes), "file", "test_speech.ogg")

        self._setup_request_env(files_dict={"file": [upload_mp3, upload_ogg]})
        res = json.loads(handle_audio_upload())

        self.assertTrue(res.get("success"), f"MP3/OGG 업로드 실패: {res}")
        self.assertEqual(len(res.get("added", [])), 2)

        for item in res["added"]:
            self.cleanup_audio_ids.append(item["id"])
            self.cleanup_files.append(item["file_path"])
            self.assertTrue(os.path.exists(item["file_path"]))
            self.assertGreater(item["file_size"], 0)
            self.assertAlmostEqual(item["duration_sec"], 1.0, delta=0.2)

    def test_delete_uploaded_audio_file_cleanup(self):
        """업로드된 오디오 삭제 시 data/audio의 물리 파일도 정상 정리되는지 검증"""
        wav_bytes = create_test_wav_bytes(duration_sec=0.5)
        upload = FileUpload(io.BytesIO(wav_bytes), "file", "to_be_deleted.wav")

        self._setup_request_env(files_dict={"file": [upload]})
        res = json.loads(handle_audio_upload())
        self.assertTrue(res["success"])
        item = res["added"][0]
        file_path = item["file_path"]
        audio_id = item["id"]

        self.assertTrue(os.path.exists(file_path))

        # 삭제 호출
        del_res = delete_audio_file(audio_id)
        self.assertTrue(del_res["success"])

        # 물리 파일 삭제 확인
        self.assertFalse(os.path.exists(file_path), "delete_audio_file 후 물리 파일이 디스크에 남아있음")


if __name__ == "__main__":
    suite = unittest.TestLoader().loadTestsFromTestCase(TestWhisperAudioUploadFunctional)
    runner = unittest.TextTestRunner(verbosity=2)
    result = runner.run(suite)
    sys.exit(0 if result.wasSuccessful() else 1)

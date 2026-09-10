"""
음성 전사(STT) 및 화자 분리(Diarization) 서비스 모듈 (services/whisper_service.py)
- faster-whisper (CTranslate2) 기반 고성능 로컬 음성 전사 (CUDA float16 / CPU int8)
- sherpa-onnx (pyannote-segmentation-3.0 + 3D-Speaker) 기반 로컬 화자 분리 (CPU)
- Active Interval Sweep 기반 단어-화자 시간축 중첩 정합 (Temporal Overlap Alignment)
- Bottle 206 Partial Content 네이티브 HTTP Range 오디오 스트리밍
- FIFO 단일 작업 큐(concurrency=1) 및 협조적 취소 지원
- 실시간 EWMA RTF 및 단계별 진행률 추적 (STT -> Diarization -> Alignment)
"""

import os
import sys
import json
import time
import math
import queue
import urllib.request
import threading
import traceback
import hashlib
from typing import List, Dict, Any, Optional

import av
import numpy as np
import eel
from bottle import request, response
import ctranslate2
from faster_whisper import WhisperModel, decode_audio
import sherpa_onnx

from core.paths import (
    APP_DIR,
    BUNDLE_DIR,
    DATA_DIR,
    WHISPER_MODELS_DIR,
    DIARIZATION_MODELS_DIR,
    AUDIO_DIR
)
from core.logger import log_info, log_warn, log_error, log_success
from services.db_service import get_db_connection

# ==============================================================================
# 1. 디렉토리 및 상수 설정
# ==============================================================================
def _ensure_dirs():
    os.makedirs(DATA_DIR, exist_ok=True)
    os.makedirs(WHISPER_MODELS_DIR, exist_ok=True)
    os.makedirs(DIARIZATION_MODELS_DIR, exist_ok=True)
    os.makedirs(AUDIO_DIR, exist_ok=True)

_ensure_dirs()

PYANNOTE_MODEL_FILENAME = "pyannote-segmentation-3.0.onnx"
SPEAKER_3D_MODEL_FILENAME = "3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx"

PYANNOTE_MODEL_URL = "https://huggingface.co/csukuangfj/sherpa-onnx-pyannote-segmentation-3-0/resolve/main/model.onnx"
SPEAKER_3D_MODEL_URL = "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx"
SPEAKER_3D_MODEL_BACKUP_URL = "https://huggingface.co/csukuangfj/speaker-recongition-models/resolve/main/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx"

ALLOWED_AUDIO_EXTENSIONS = {
    "mp3", "wav", "m4a", "flac", "ogg", "aac", "wma", "opus", "mp4", "mkv", "webm", "avi"
}
MAX_AUDIO_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024  # 2GB

# ==============================================================================
# 2. 오디오 전처리 모듈 (PyAV 기반)
# ==============================================================================
class AudioPreprocessor:
    """오디오 메타데이터 추출 및 16kHz mono float32 디코딩"""

    @staticmethod
    def get_audio_duration(file_path: str) -> float:
        """PyAV 컨테이너 기반 오디오 총 재생 시간(초) 산출"""
        if not os.path.exists(file_path):
            return 0.0
        try:
            with av.open(file_path) as container:
                if container.duration is not None and av.time_base:
                    return float(container.duration) / float(av.time_base)
                for stream in container.streams.audio:
                    if stream.duration is not None and stream.time_base is not None:
                        return float(stream.duration * stream.time_base)
        except Exception as e:
            log_error("Whisper", f"오디오 메타데이터 추출 오류 ({file_path}): {e}", exc=e)
        return 0.0

    @staticmethod
    def load_audio_16k_mono(file_path: str) -> np.ndarray:
        """PyAV 및 faster-whisper 기반 16kHz mono float32 [-1.0, 1.0] ndarray 반환"""
        return decode_audio(file_path, sampling_rate=16000)


# ==============================================================================
# 3. 모델 프로비저닝 관리자 (100% 로컬 추론 및 안전 다운로드 보장)
# ==============================================================================
class ModelManager:
    """로컬 모델 검증 및 원자적 다운로드 매니저"""

    _download_lock = threading.Lock()
    _is_downloading = False

    @classmethod
    def get_pyannote_path(cls) -> str:
        return os.path.join(DIARIZATION_MODELS_DIR, PYANNOTE_MODEL_FILENAME)

    @classmethod
    def get_3dspeaker_path(cls) -> str:
        return os.path.join(DIARIZATION_MODELS_DIR, SPEAKER_3D_MODEL_FILENAME)

    @classmethod
    def are_diarization_models_available(cls) -> bool:
        py_path = cls.get_pyannote_path()
        spk_path = cls.get_3dspeaker_path()
        # 파일 존재 및 최소 크기 검증 (pyannote > 4MB, 3dspeaker > 30MB)
        if os.path.exists(py_path) and os.path.getsize(py_path) > 4 * 1024 * 1024:
            if os.path.exists(spk_path) and os.path.getsize(spk_path) > 30 * 1024 * 1024:
                return True
        return False

    @classmethod
    def get_system_info(cls) -> Dict[str, Any]:
        has_cuda = ctranslate2.get_cuda_device_count() > 0
        diar_ready = cls.are_diarization_models_available()
        return {
            "has_cuda": has_cuda,
            "cuda_device_count": ctranslate2.get_cuda_device_count(),
            "diarization_ready": diar_ready,
            "whisper_models_dir": WHISPER_MODELS_DIR,
            "diarization_models_dir": DIARIZATION_MODELS_DIR,
            "is_downloading_models": cls._is_downloading
        }

    @classmethod
    def download_diarization_models_if_needed(cls, progress_callback=None) -> bool:
        if cls.are_diarization_models_available():
            return True

        with cls._download_lock:
            if cls.are_diarization_models_available():
                return True

            cls._is_downloading = True
            try:
                _ensure_dirs()
                py_path = cls.get_pyannote_path()
                spk_path = cls.get_3dspeaker_path()

                # 1. Pyannote Segmentation 다운로드
                if not (os.path.exists(py_path) and os.path.getsize(py_path) > 4 * 1024 * 1024):
                    cls._download_file_atomic(
                        url=PYANNOTE_MODEL_URL,
                        target_path=py_path,
                        expected_min_bytes=4 * 1024 * 1024,
                        label="화자 세그멘테이션 모델 (pyannote 3.0)",
                        progress_callback=progress_callback
                    )

                # 2. 3D-Speaker Embedding 모델 다운로드
                if not (os.path.exists(spk_path) and os.path.getsize(spk_path) > 30 * 1024 * 1024):
                    try:
                        cls._download_file_atomic(
                            url=SPEAKER_3D_MODEL_URL,
                            target_path=spk_path,
                            expected_min_bytes=30 * 1024 * 1024,
                            label="화자 임베딩 모델 (3D-Speaker)",
                            progress_callback=progress_callback
                        )
                    except Exception as e1:
                        log_warn("Whisper", f"화자 분리 모델 1차 다운로드 실패({SPEAKER_3D_MODEL_URL}): {e1}, 미러 사이트로 재시도합니다.")
                        cls._download_file_atomic(
                            url=SPEAKER_3D_MODEL_BACKUP_URL,
                            target_path=spk_path,
                            expected_min_bytes=30 * 1024 * 1024,
                            label="화자 임베딩 모델 (3D-Speaker 미러)",
                            progress_callback=progress_callback
                        )

                return cls.are_diarization_models_available()
            finally:
                cls._is_downloading = False

    @staticmethod
    def _download_file_atomic(url: str, target_path: str, expected_min_bytes: int, label: str, progress_callback=None):
        tmp_path = target_path + ".tmp"
        if os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except Exception:
                pass

        log_info("Whisper", f"{label} 다운로드 시작: {url}")
        req = urllib.request.Request(
            url,
            headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) UtilTools/1.0"}
        )

        with urllib.request.urlopen(req, timeout=120) as response, open(tmp_path, "wb") as out_file:
            total_size = int(response.headers.get("content-length", 0))
            downloaded = 0
            chunk_size = 64 * 1024

            while True:
                chunk = response.read(chunk_size)
                if not chunk:
                    break
                out_file.write(chunk)
                downloaded += len(chunk)
                if progress_callback and total_size > 0:
                    pct = round((downloaded / total_size) * 100.0, 1)
                    progress_callback(label, pct, downloaded, total_size)

        actual_size = os.path.getsize(tmp_path)
        if actual_size < expected_min_bytes:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)
            raise IOError(f"{label} 다운로드 파일 크기 부족 ({actual_size} < {expected_min_bytes} bytes)")

        os.replace(tmp_path, target_path)
        log_success("Whisper", f"{label} 다운로드 및 원자적 교체 완료 ({actual_size:,} bytes)")


# ==============================================================================
# 4. 실시간 진행률 추적기 (EWMA RTF 및 다단계 상태 전이)
# ==============================================================================
class WindowProgressTracker:
    """윈도우 델타 기반 실시간 RTF(Real-Time Factor) 및 ETA 계산기"""

    def __init__(self, run_id: int, audio_id: int, total_duration: float, enable_diarization: bool):
        self.run_id = run_id
        self.audio_id = audio_id
        self.total_duration = max(0.1, total_duration)
        self.enable_diarization = enable_diarization

        self.last_audio_sec = 0.0
        self.last_wall_time = time.perf_counter()
        self.start_wall_time = self.last_wall_time
        self.rtf = 0.0
        self.current_phase = "STT"
        self.last_broadcast_time = 0.0

    def update_stt(self, current_audio_sec: float, force: bool = False):
        now = time.perf_counter()
        delta_audio = current_audio_sec - self.last_audio_sec
        delta_wall = now - self.last_wall_time

        if delta_audio > 0.3:
            instant_rtf = delta_wall / delta_audio
            if self.rtf <= 0.0:
                self.rtf = instant_rtf
            else:
                self.rtf = 0.8 * self.rtf + 0.2 * instant_rtf
            self.last_audio_sec = current_audio_sec
            self.last_wall_time = now

        # STT 단계 비율: diarization 활성화 시 0% ~ 70%, 미활성화 시 0% ~ 95%
        ratio_max = 70.0 if self.enable_diarization else 95.0
        stt_ratio = min(1.0, current_audio_sec / self.total_duration)
        progress = stt_ratio * ratio_max

        rem_audio = max(0.0, self.total_duration - current_audio_sec)
        active_rtf = self.rtf if self.rtf > 0.0 else 0.5
        eta_sec = rem_audio * active_rtf

        if force or (now - self.last_broadcast_time >= 0.4):
            self.last_broadcast_time = now
            self._broadcast(
                status="TRANSCRIBING",
                phase="STT",
                progress=round(progress, 1),
                rtf=round(self.rtf, 2),
                eta_sec=round(eta_sec, 1),
                phase_message=f"음성 텍스트 변환 중 ({current_audio_sec:.1f}s / {self.total_duration:.1f}s)"
            )

    def update_diarization(self, processed_chunks: int, total_chunks: int, force: bool = False):
        now = time.perf_counter()
        total_chunks = max(1, total_chunks)
        chunk_ratio = min(1.0, processed_chunks / total_chunks)
        # Diarization 단계 비율: 70% ~ 95%
        progress = 70.0 + (chunk_ratio * 25.0)

        if force or (now - self.last_broadcast_time >= 0.4):
            self.last_broadcast_time = now
            self._broadcast(
                status="DIARIZING",
                phase="DIARIZATION",
                progress=round(progress, 1),
                rtf=round(self.rtf, 2),
                eta_sec=0.0,
                phase_message=f"화자 분리 분석 중 ({processed_chunks}/{total_chunks} 청크)"
            )

    def update_alignment(self):
        self._broadcast(
            status="ALIGNING",
            phase="ALIGNMENT",
            progress=97.0,
            rtf=round(self.rtf, 2),
            eta_sec=0.0,
            phase_message="단어 시간축 정합 및 세그먼트 생성 중..."
        )

    def finish(self):
        self._broadcast(
            status="COMPLETED",
            phase="FINISHED",
            progress=100.0,
            rtf=round(self.rtf, 2),
            eta_sec=0.0,
            phase_message="전사 및 화자 분리 완료"
        )

    def fail(self, err_msg: str):
        self._broadcast(
            status="FAILED",
            phase="ERROR",
            progress=0.0,
            rtf=round(self.rtf, 2),
            eta_sec=0.0,
            phase_message=f"오류 발생: {err_msg}"
        )

    def cancel(self):
        self._broadcast(
            status="CANCELLED",
            phase="CANCELLED",
            progress=0.0,
            rtf=0.0,
            eta_sec=0.0,
            phase_message="사용자에 의해 취소됨"
        )

    def _broadcast(self, status: str, phase: str, progress: float, rtf: float, eta_sec: float, phase_message: str):
        payload = {
            "run_id": self.run_id,
            "audio_id": self.audio_id,
            "status": status,
            "current_phase": phase,
            "progress": progress,
            "rtf": rtf,
            "eta_sec": eta_sec,
            "total_duration": round(self.total_duration, 1),
            "phase_message": phase_message
        }
        # 프론트엔드 비동기 브로드캐스트
        try:
            eel.on_whisper_progress(payload)
        except Exception:
            pass


# ==============================================================================
# 5. Active Interval Sweep 정합기 (단어-화자 시간축 정합 & 가독성 세그먼트 분할)
# ==============================================================================
class ActiveIntervalSweepAligner:
    """
    단어 구간(word intervals)과 화자 턴 구간(speaker turns) 간
    시간축 중첩(Overlap Duration) 최대화 기반 정합 알고리즘 ($O(W + T + K)$)
    """

    @staticmethod
    def align(words: List[Dict[str, Any]], turns: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """
        단어 리스트와 화자 턴 리스트를 결합하여 Canonical Segments 리스트 생성
        """
        if not words:
            return []

        words = sorted(words, key=lambda x: x["start"])
        turns = sorted(turns, key=lambda x: x["start"])

        prev_speaker = "SPEAKER_00"
        turn_idx = 0
        num_turns = len(turns)

        aligned_words = []
        for w in words:
            w_start = w["start"]
            w_end = w["end"]

            # 1. 단어 시작점 이전에 이미 종료된 턴 포인터 전진
            while turn_idx < num_turns and turns[turn_idx]["end"] <= w_start:
                turn_idx += 1

            best_speaker = None
            best_overlap = 0.0

            # 2. Active Interval Sweep: 단어 종료점 이전에 시작하는 유효 턴 순회
            cur = turn_idx
            while cur < num_turns and turns[cur]["start"] < w_end:
                t = turns[cur]
                overlap = max(0.0, min(w_end, t["end"]) - max(w_start, t["start"]))
                if overlap > best_overlap:
                    best_overlap = overlap
                    best_speaker = t["speaker"]
                elif overlap > 0.0 and abs(overlap - best_overlap) < 1e-5:
                    # 동률 시 직전 화자 연속성 우선(tie-breaking)
                    if t["speaker"] == prev_speaker:
                        best_speaker = prev_speaker
                cur += 1

            # 3. 0초 중첩 무음 구간은 SPEAKER_UNKNOWN 배정
            if best_overlap > 0.0 and best_speaker:
                chosen_speaker = best_speaker
                prev_speaker = chosen_speaker
            else:
                chosen_speaker = "SPEAKER_UNKNOWN" if num_turns > 0 else "SPEAKER_00"

            aligned_words.append({
                "word": w["word"],
                "start": round(w_start, 2),
                "end": round(w_end, 2),
                "probability": round(w.get("probability", 1.0), 2),
                "speaker": chosen_speaker
            })

        # 4. 가독성 세그먼트 자연스러운 분할 (Segment Grouping)
        # 분할 기준: 화자 변경 OR 공백 > 1.0s OR 길이 > 7.0s OR 글자수 > 60자
        canonical_segments = []
        current_words = [aligned_words[0]]
        seg_speaker = aligned_words[0]["speaker"]
        seg_start = aligned_words[0]["start"]

        for i in range(1, len(aligned_words)):
            w = aligned_words[i]
            prev_w = aligned_words[i - 1]

            pause = w["start"] - prev_w["end"]
            duration = w["end"] - seg_start
            char_count = sum(len(x["word"]) for x in current_words) + len(w["word"])

            split = False
            if w["speaker"] != seg_speaker:
                split = True
            elif pause > 1.0:
                split = True
            elif duration > 7.0:
                split = True
            elif char_count > 60:
                split = True

            if split:
                text = " ".join(x["word"].strip() for x in current_words if x["word"].strip()).strip()
                if text:
                    canonical_segments.append({
                        "id": len(canonical_segments) + 1,
                        "start": round(seg_start, 2),
                        "end": round(prev_w["end"], 2),
                        "speaker": seg_speaker,
                        "text": text,
                        "words": current_words
                    })
                current_words = [w]
                seg_speaker = w["speaker"]
                seg_start = w["start"]
            else:
                current_words.append(w)

        if current_words:
            text = " ".join(x["word"].strip() for x in current_words if x["word"].strip()).strip()
            if text:
                canonical_segments.append({
                    "id": len(canonical_segments) + 1,
                    "start": round(seg_start, 2),
                    "end": round(current_words[-1]["end"], 2),
                    "speaker": seg_speaker,
                    "text": text,
                    "words": current_words
                })

        return canonical_segments


# ==============================================================================
# 6. 화자 분리 추론 실행기 (sherpa-onnx CPU)
# ==============================================================================
class SherpaDiarizationManager:
    """sherpa-onnx 기반 고성능 오프라인 화자 분리 실행기"""

    @classmethod
    def run_diarization(
        cls,
        pcm_samples: np.ndarray,
        num_speakers: int = 0,
        cluster_threshold: float = 0.5,
        progress_cb = None,
        cancel_check = None
    ) -> List[Dict[str, Any]]:
        """
        화자 분리 추론 실행 및 정렬된 화자 턴 구간 리스트 반환
        Contract 1: num_speakers <= 0이면 num_clusters = -1 (자동 화자 수 탐색)
        """
        # 모델 준비 보장
        if not ModelManager.are_diarization_models_available():
            ModelManager.download_diarization_models_if_needed()

        pyannote_path = ModelManager.get_pyannote_path()
        speaker_3d_path = ModelManager.get_3dspeaker_path()

        # 1. 세그멘테이션 설정 (pyannote 3.0)
        seg_config = sherpa_onnx.OfflineSpeakerSegmentationModelConfig()
        seg_config.pyannote.model = pyannote_path
        seg_config.num_threads = 2
        seg_config.provider = "cpu"

        # 2. 임베딩 추출기 설정 (3D-Speaker)
        emb_config = sherpa_onnx.SpeakerEmbeddingExtractorConfig()
        emb_config.model = speaker_3d_path
        emb_config.num_threads = 2
        emb_config.provider = "cpu"

        # 3. 클러스터링 설정 (Contract 1 sentinel 규격 준수)
        num_clusters = -1 if num_speakers <= 0 else int(num_speakers)
        clust_config = sherpa_onnx.FastClusteringConfig()
        clust_config.num_clusters = num_clusters
        clust_config.threshold = float(cluster_threshold)

        diar_config = sherpa_onnx.OfflineSpeakerDiarizationConfig(
            segmentation=seg_config,
            embedding=emb_config,
            clustering=clust_config,
            min_duration_on=0.3,
            min_duration_off=0.5
        )

        sd = sherpa_onnx.OfflineSpeakerDiarization(diar_config)

        # 4. 청크 콜백 및 취소 검사
        def chunk_callback(num_processed: int, num_total: int) -> int:
            if cancel_check and cancel_check():
                return 1  # 0이 아닌 값 반환 시 sherpa-onnx 처리 즉시 중단
            if progress_cb:
                progress_cb(num_processed, num_total)
            return 0

        # float32 1D numpy array 전달
        samples_list = pcm_samples.astype(np.float32)
        result = sd.process(samples_list, callback=chunk_callback)

        segments = result.sort_by_start_time()
        turns = []
        for s in segments:
            turns.append({
                "start": float(s.start),
                "end": float(s.end),
                "speaker": f"SPEAKER_{s.speaker:02d}"
            })

        return turns


# ==============================================================================
# 7. 단일 작업자 큐 및 백그라운드 워커 (FIFO, concurrency = 1)
# ==============================================================================
class WhisperWorker:
    """단일 스레드 순차 처리 FIFO 작업 큐 및 협조적 취소 관리자"""

    def __init__(self):
        self._queue = queue.Queue()
        self._cancelled_runs = set()
        self._active_run_id = None
        self._lock = threading.Lock()
        self._worker_thread = threading.Thread(target=self._run_loop, daemon=True)
        self._worker_thread.start()

    def enqueue_run(self, run_id: int):
        with self._lock:
            if run_id in self._cancelled_runs:
                self._cancelled_runs.remove(run_id)
        self._queue.put(run_id)

    def cancel_run(self, run_id: int):
        with self._lock:
            self._cancelled_runs.add(run_id)
        log_warn("Whisper", f"사용자 전사 취소 요청 (Run #{run_id})")

        # DB 상태 즉시 반영 (대기 중인 경우)
        conn = get_db_connection()
        try:
            conn.execute("""
                UPDATE transcription_runs
                SET status = 'CANCELLED', current_phase = 'CANCELLED', updated_at = datetime('now', 'localtime')
                WHERE id = ? AND status = 'PENDING'
            """, (run_id,))
            conn.commit()
        finally:
            conn.close()

    def is_cancelled(self, run_id: int) -> bool:
        with self._lock:
            return run_id in self._cancelled_runs

    def _run_loop(self):
        while True:
            try:
                run_id = self._queue.get()
                if run_id is None:
                    break

                if self.is_cancelled(run_id):
                    self._update_run_status(run_id, status="CANCELLED", phase="CANCELLED")
                    self._queue.task_done()
                    continue

                self._active_run_id = run_id
                try:
                    self._process_run(run_id)
                except Exception as e:
                    log_error("Whisper", f"작업 처리 중 오류 발생 (Run #{run_id}): {e}", exc=e)
                    self._update_run_status(run_id, status="FAILED", phase="ERROR", error_msg=str(e))
                finally:
                    self._active_run_id = None
                    self._queue.task_done()
            except Exception as e:
                log_error("Whisper", f"워커 루프 미처리 예외 발생: {e}", exc=e)
                time.sleep(0.5)

    def _update_run_status(self, run_id: int, status: str, phase: str, progress: float = 0.0, error_msg: str = ""):
        conn = get_db_connection()
        try:
            conn.execute("""
                UPDATE transcription_runs
                SET status = ?, current_phase = ?, progress = ?, error_message = ?, updated_at = datetime('now', 'localtime')
                WHERE id = ?
            """, (status, phase, progress, error_msg, run_id))
            conn.commit()
        finally:
            conn.close()

    def _process_run(self, run_id: int):
        conn = get_db_connection()
        run = None
        audio = None
        try:
            run = conn.execute("SELECT * FROM transcription_runs WHERE id = ?", (run_id,)).fetchone()
            if not run:
                return
            audio = conn.execute("SELECT * FROM audio_files WHERE id = ?", (run["audio_id"],)).fetchone()
            if not audio:
                self._update_run_status(run_id, "FAILED", "ERROR", error_msg="오디오 파일을 찾을 수 없습니다.")
                return
        finally:
            conn.close()

        file_path = audio["file_path"]
        if not os.path.exists(file_path):
            self._update_run_status(run_id, "FAILED", "ERROR", error_msg="오디오 파일이 디스크에 존재하지 않습니다.")
            return

        model_name = run["model_name"] or "small"
        language = run["language"] or "ko"
        stt_device = run["stt_device"] or "cuda"
        enable_diarization = bool(run["enable_diarization"])
        num_speakers = int(run["num_speakers"] or 0)
        cluster_threshold = float(run["cluster_threshold"] or 0.5)

        # 디바이스 가용성 검증
        if stt_device == "cuda" and ctranslate2.get_cuda_device_count() == 0:
            log_warn("Whisper", "CUDA 지원 장치가 감지되지 않아 CPU 모드로 자동 전환합니다.")
            stt_device = "cpu"
        compute_type = "float16" if stt_device == "cuda" else "int8"

        # 오디오 재생 시간 산출
        total_duration = float(audio["duration_sec"] or 0.0)
        if total_duration <= 0.0:
            total_duration = AudioPreprocessor.get_audio_duration(file_path)
            if total_duration > 0.0:
                conn = get_db_connection()
                try:
                    conn.execute("UPDATE audio_files SET duration_sec = ? WHERE id = ?", (total_duration, audio["id"]))
                    conn.commit()
                finally:
                    conn.close()

        tracker = WindowProgressTracker(
            run_id=run_id,
            audio_id=audio["id"],
            total_duration=total_duration,
            enable_diarization=enable_diarization
        )

        # 상태: TRANSCRIBING 전이
        self._update_run_status(run_id, "TRANSCRIBING", "STT", progress=1.0)
        tracker.update_stt(0.0, force=True)

        if self.is_cancelled(run_id):
            log_warn("Whisper", f"작업 시작 전 취소 감지 (Run #{run_id})")
            tracker.cancel()
            return

        # ======================================================================
        # Phase 1: faster-whisper STT 전사 (Word Timestamps 활성화)
        # ======================================================================
        log_info("Whisper", f"STT 시작 (Model={model_name}, Device={stt_device}, Compute={compute_type}, AudioDuration={total_duration:.1f}s)")
        whisper_model = None
        try:
            whisper_model = WhisperModel(
                model_size_or_path=model_name,
                download_root=WHISPER_MODELS_DIR,
                device=stt_device,
                compute_type=compute_type
            )
        except Exception as e:
            if stt_device == "cuda":
                log_warn("Whisper", f"CUDA 가속 모델 로딩 실패 ({e}). CPU(int8) 모드로 자동 폴백합니다.")
                stt_device = "cpu"
                compute_type = "int8"
                whisper_model = WhisperModel(
                    model_size_or_path=model_name,
                    download_root=WHISPER_MODELS_DIR,
                    device="cpu",
                    compute_type="int8"
                )
            else:
                raise

        def _do_transcribe(m):
            return m.transcribe(
                file_path,
                language=language if language != "auto" else None,
                task="transcribe",
                word_timestamps=True,
                vad_filter=True,
                vad_parameters=dict(min_silence_duration_ms=500)
            )

        raw_words = []
        try:
            segments_gen, info = _do_transcribe(whisper_model)
            for seg in segments_gen:
                if self.is_cancelled(run_id):
                    log_warn("Whisper", f"STT 전사 중 취소 감지 (Run #{run_id})")
                    tracker.cancel()
                    self._update_run_status(run_id, "CANCELLED", "CANCELLED")
                    return

                tracker.update_stt(seg.end)

                if seg.words:
                    for w in seg.words:
                        raw_words.append({
                            "word": w.word,
                            "start": float(w.start),
                            "end": float(w.end),
                            "probability": float(w.probability)
                        })
                else:
                    # 단어 타임스탬프가 비어 있는 경우 세그먼트 단위 폴백
                    raw_words.append({
                        "word": seg.text,
                        "start": float(seg.start),
                        "end": float(seg.end),
                        "probability": 1.0
                    })
        except Exception as e:
            err_str = str(e).lower()
            if stt_device == "cuda" and ("out of memory" in err_str or "cuda" in err_str):
                log_warn("Whisper", f"CUDA 세그먼트 전사 중 VRAM 부족(OOM) 감지 ({e}). CPU(int8) 모드로 전환하여 전체 재시도합니다.")
                stt_device = "cpu"
                compute_type = "int8"
                whisper_model = WhisperModel(
                    model_size_or_path=model_name,
                    download_root=WHISPER_MODELS_DIR,
                    device="cpu",
                    compute_type="int8"
                )
                raw_words = []
                tracker.update_stt(0.0, force=True)
                segments_gen, info = _do_transcribe(whisper_model)
                for seg in segments_gen:
                    if self.is_cancelled(run_id):
                        log_warn("Whisper", f"STT 전사 중 취소 감지 (Run #{run_id})")
                        tracker.cancel()
                        self._update_run_status(run_id, "CANCELLED", "CANCELLED")
                        return

                    tracker.update_stt(seg.end)

                    if seg.words:
                        for w in seg.words:
                            raw_words.append({
                                "word": w.word,
                                "start": float(w.start),
                                "end": float(w.end),
                                "probability": float(w.probability)
                            })
                    else:
                        raw_words.append({
                            "word": seg.text,
                            "start": float(seg.start),
                            "end": float(seg.end),
                            "probability": 1.0
                        })
            else:
                raise

        tracker.update_stt(total_duration, force=True)

        if self.is_cancelled(run_id):
            log_warn("Whisper", f"STT 완료 후 취소 감지 (Run #{run_id})")
            tracker.cancel()
            self._update_run_status(run_id, "CANCELLED", "CANCELLED")
            return

        # ======================================================================
        # Phase 2: sherpa-onnx 화자 분리 (선택적 활성화)
        # ======================================================================
        turns = []
        if enable_diarization:
            log_info("Whisper", f"화자 분리(Diarization) 시작 (Run #{run_id}, NumSpeakers={num_speakers}, Threshold={cluster_threshold})")
            self._update_run_status(run_id, "DIARIZING", "DIARIZATION", progress=70.0)
            tracker.update_diarization(0, 100, force=True)

            pcm_samples = AudioPreprocessor.load_audio_16k_mono(file_path)

            def diar_progress(processed, total):
                tracker.update_diarization(processed, total)

            def diar_cancel_check():
                return self.is_cancelled(run_id)

            turns = SherpaDiarizationManager.run_diarization(
                pcm_samples=pcm_samples,
                num_speakers=num_speakers,
                cluster_threshold=cluster_threshold,
                progress_cb=diar_progress,
                cancel_check=diar_cancel_check
            )

            if self.is_cancelled(run_id):
                log_warn("Whisper", f"화자 분리 중 취소 감지 (Run #{run_id})")
                tracker.cancel()
                self._update_run_status(run_id, "CANCELLED", "CANCELLED")
                return

        # ======================================================================
        # Phase 3: Active Interval Sweep 단어-화자 시간축 정합
        # ======================================================================
        log_info("Whisper", f"단어-화자 정합 및 세그먼트 생성 시작 (Run #{run_id}, RawWords={len(raw_words)}, Turns={len(turns)})")
        self._update_run_status(run_id, "ALIGNING", "ALIGNMENT", progress=97.0)
        tracker.update_alignment()

        canonical_segments = ActiveIntervalSweepAligner.align(raw_words, turns)

        # 화자 ID 목록 추출 및 기본 이름 매핑 생성
        speaker_ids = sorted(list(set(seg["speaker"] for seg in canonical_segments)))
        speaker_names = {}
        for idx, spk in enumerate(speaker_ids):
            if spk == "SPEAKER_UNKNOWN":
                speaker_names[spk] = "미확인 화자"
            else:
                speaker_names[spk] = f"화자 {idx + 1}"

        # ======================================================================
        # Phase 4: 영속성 저장 (SQLite Canonical SSOT 보관)
        # ======================================================================
        conn = get_db_connection()
        try:
            conn.execute("""
                UPDATE transcription_runs
                SET status = 'COMPLETED',
                    current_phase = 'FINISHED',
                    progress = 100.0,
                    rtf = ?,
                    eta_sec = 0.0,
                    segments_json = ?,
                    speaker_names_json = ?,
                    error_message = '',
                    updated_at = datetime('now', 'localtime')
                WHERE id = ?
            """, (
                tracker.rtf,
                json.dumps(canonical_segments, ensure_ascii=False),
                json.dumps(speaker_names, ensure_ascii=False),
                run_id
            ))
            conn.commit()
        finally:
            conn.close()

        tracker.finish()
        elapsed_sec = time.perf_counter() - tracker.start_wall_time
        log_success("Whisper", f"전사 및 정합 완료 (Run #{run_id}, Segments={len(canonical_segments)}, RTF={tracker.rtf:.2f}, 소요 시간={elapsed_sec:.1f}초)")


# 전역 백그라운드 워커 인스턴스
_worker = WhisperWorker()


# ==============================================================================
# 8. Bottle 206 Partial Content 오디오 스트리밍 엔드포인트
# ==============================================================================
@eel.btl.route("/api/whisper/audio/<audio_id:int>")
def stream_audio(audio_id: int):
    """
    브라우저 네이티브 <audio> 태그 시크바 즉각 점프를 위한
    HTTP Range 206 Partial Content 스트리밍 핸들러
    """
    conn = get_db_connection()
    try:
        row = conn.execute("SELECT file_path FROM audio_files WHERE id = ?", (audio_id,)).fetchone()
        if not row:
            return eel.btl.HTTPError(404, "Audio record not found")
        file_path = row["file_path"]
        if not os.path.exists(file_path):
            return eel.btl.HTTPError(404, "Audio file not found on disk")
        dirname = os.path.dirname(os.path.abspath(file_path))
        filename = os.path.basename(file_path)
        return eel.btl.static_file(filename, root=dirname)
    finally:
        conn.close()


def _is_safe_whisper_request() -> bool:
    """루프백 IP 및 로컬 호스트 검증 (Same-Origin / Loopback 방어)"""
    client_ip = request.environ.get("REMOTE_ADDR", "")
    if client_ip not in ("127.0.0.1", "::1", "localhost"):
        return False
    host = request.headers.get("Host", "")
    if not (host.startswith("localhost") or host.startswith("127.0.0.1")):
        return False
    sec_fetch_site = request.headers.get("Sec-Fetch-Site", "")
    if sec_fetch_site and sec_fetch_site not in ("same-origin", "none", "same-site"):
        return False
    return True


@eel.btl.route("/api/whisper/upload", method=["POST", "OPTIONS"])
def handle_audio_upload():
    """
    드래그 앤 드롭 및 웹 환경 오디오 바이너리 업로드 수신 핸들러
    - chunked 스트림으로 data/audio 디렉토리에 안전 저장
    - 중복 해시 검증을 통한 디스크 중복 방지
    - PyAV 메타데이터(재생 시간, 포맷) 추출 및 audio_files 테이블 등록
    """
    if request.method == "OPTIONS":
        return {}

    if not _is_safe_whisper_request():
        response.status = 403
        response.content_type = "application/json; charset=utf-8"
        return json.dumps({"success": False, "message": "접근이 거부되었습니다 (로컬 요청만 허용)."}, ensure_ascii=False)

    uploaded_files = request.files.getall("file") or request.files.getall("files")
    if not uploaded_files:
        f = request.files.get("file") or request.files.get("files")
        if f:
            uploaded_files = [f]

    if not uploaded_files:
        response.status = 400
        response.content_type = "application/json; charset=utf-8"
        return json.dumps({"success": False, "message": "업로드된 오디오 파일이 없습니다."}, ensure_ascii=False)

    _ensure_dirs()
    conn = get_db_connection()
    added_files = []
    skipped_count = 0
    errors = []

    try:
        for upload in uploaded_files:
            raw_filename = upload.filename or "uploaded_audio.mp3"
            # 파일명 경로 순회(Path Traversal) 방지 및 정규화
            safe_filename = os.path.basename(raw_filename.replace("\\", "/")).strip()
            if not safe_filename:
                safe_filename = f"audio_{int(time.time())}.mp3"

            ext = safe_filename.rsplit(".", 1)[-1].lower() if "." in safe_filename else ""
            if ext not in ALLOWED_AUDIO_EXTENSIONS:
                errors.append(f"'{safe_filename}': 지원되지 않는 파일 형식입니다 (.${ext})")
                skipped_count += 1
                continue

            # 임시 파일 경로 생성 및 청크 스트리밍 쓰기 + MD5 산출
            temp_path = os.path.join(AUDIO_DIR, f".tmp_{int(time.time() * 1000)}_{os.urandom(4).hex()}_{safe_filename}")
            hasher = hashlib.md5()
            total_bytes = 0

            try:
                with open(temp_path, "wb") as f_out:
                    while True:
                        chunk = upload.file.read(64 * 1024)
                        if not chunk:
                            break
                        total_bytes += len(chunk)
                        if total_bytes > MAX_AUDIO_UPLOAD_BYTES:
                            raise ValueError(f"파일 크기가 최대 제한(2GB)을 초과했습니다.")
                        hasher.update(chunk)
                        f_out.write(chunk)

                if total_bytes == 0:
                    try:
                        os.remove(temp_path)
                    except OSError:
                        pass
                    errors.append(f"'{safe_filename}': 0바이트 빈 파일입니다.")
                    skipped_count += 1
                    continue

                file_hash = hasher.hexdigest()

                # 동일 파일명 및 파일 크기가 DB에 이미 존재하는지 검사 (디스크 중복 방지)
                existing = conn.execute(
                    "SELECT * FROM audio_files WHERE filename = ? AND file_size = ?",
                    (safe_filename, total_bytes)
                ).fetchone()

                if existing and os.path.exists(existing["file_path"]):
                    try:
                        with open(existing["file_path"], "rb") as ef:
                            existing_hasher = hashlib.md5()
                            while True:
                                ec = ef.read(64 * 1024)
                                if not ec:
                                    break
                                existing_hasher.update(ec)
                        if existing_hasher.hexdigest() == file_hash:
                            try:
                                os.remove(temp_path)
                            except OSError:
                                pass
                            added_files.append(dict(existing))
                            continue
                    except Exception:
                        pass

                # 신규 파일명 결정 (중복 방지 넘버링)
                base_name, file_ext = os.path.splitext(safe_filename)
                target_path = os.path.join(AUDIO_DIR, safe_filename)
                counter = 1
                while os.path.exists(target_path):
                    target_path = os.path.join(AUDIO_DIR, f"{base_name}_{counter}{file_ext}")
                    counter += 1

                # 임시 파일을 최종 목적지로 이동
                os.replace(temp_path, target_path)

                target_filename = os.path.basename(target_path)
                file_size = os.path.getsize(target_path)
                duration = AudioPreprocessor.get_audio_duration(target_path)

                cursor = conn.execute("""
                    INSERT INTO audio_files (file_path, filename, file_size, duration_sec)
                    VALUES (?, ?, ?, ?)
                """, (target_path, target_filename, file_size, duration))
                conn.commit()

                added_files.append({
                    "id": cursor.lastrowid,
                    "file_path": target_path,
                    "filename": target_filename,
                    "file_size": file_size,
                    "duration_sec": round(duration, 2)
                })

            except Exception as fe:
                try:
                    if os.path.exists(temp_path):
                        os.remove(temp_path)
                except OSError:
                    pass
                errors.append(f"'{safe_filename}': {str(fe)}")
                skipped_count += 1

        response.content_type = "application/json; charset=utf-8"
        if not added_files and errors:
            response.status = 400
            return json.dumps({
                "success": False,
                "message": "\n".join(errors),
                "skipped_count": skipped_count
            }, ensure_ascii=False)

        return json.dumps({
            "success": True,
            "added": added_files,
            "skipped_count": skipped_count,
            "errors": errors
        }, ensure_ascii=False)

    finally:
        conn.close()


# ==============================================================================
# 9. Eel RPC Expose 함수 목록
# ==============================================================================
@eel.expose
def add_audio_files(file_paths: List[str]) -> Dict[str, Any]:
    """사용자가 선택한 오디오 파일들을 라이브러리에 등록"""
    if not file_paths:
        return {"success": False, "message": "선택된 파일이 없습니다."}

    conn = get_db_connection()
    added_files = []
    skipped_count = 0

    try:
        for fp in file_paths:
            fp = os.path.abspath(fp.strip('"').strip("'"))
            if not os.path.exists(fp):
                continue
            filename = os.path.basename(fp)
            file_size = os.path.getsize(fp)
            duration = AudioPreprocessor.get_audio_duration(fp)

            try:
                cursor = conn.execute("""
                    INSERT INTO audio_files (file_path, filename, file_size, duration_sec)
                    VALUES (?, ?, ?, ?)
                """, (fp, filename, file_size, duration))
                conn.commit()
                added_files.append({
                    "id": cursor.lastrowid,
                    "file_path": fp,
                    "filename": filename,
                    "file_size": file_size,
                    "duration_sec": round(duration, 2)
                })
            except Exception:
                # 중복 파일인 경우 기존 레코드 확인
                existing = conn.execute("SELECT * FROM audio_files WHERE file_path = ?", (fp,)).fetchone()
                if existing:
                    added_files.append(dict(existing))
                skipped_count += 1

        return {
            "success": True,
            "added": added_files,
            "skipped_count": skipped_count
        }
    finally:
        conn.close()


@eel.expose
def get_audio_library() -> List[Dict[str, Any]]:
    """모든 오디오 파일 목록 및 최신 전사 상태 반환"""
    conn = get_db_connection()
    try:
        rows = conn.execute("""
            SELECT
                a.*,
                r.id AS latest_run_id,
                r.status AS latest_status,
                r.progress AS latest_progress,
                r.current_phase AS latest_phase,
                r.model_name AS latest_model,
                r.enable_diarization AS latest_diarization,
                r.updated_at AS latest_run_updated_at
            FROM audio_files a
            LEFT JOIN transcription_runs r ON r.id = (
                SELECT id FROM transcription_runs
                WHERE audio_id = a.id
                ORDER BY id DESC LIMIT 1
            )
            ORDER BY a.id DESC
        """).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


@eel.expose
def get_audio_runs(audio_id: int) -> List[Dict[str, Any]]:
    """특정 오디오 파일의 모든 전사 런 이력 반환"""
    conn = get_db_connection()
    try:
        rows = conn.execute("""
            SELECT id, audio_id, model_name, language, stt_device, enable_diarization,
                   num_speakers, cluster_threshold, status, progress, current_phase,
                   rtf, eta_sec, error_message, created_at, updated_at
            FROM transcription_runs
            WHERE audio_id = ?
            ORDER BY id DESC
        """, (audio_id,)).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


@eel.expose
def get_run_detail(run_id: int) -> Optional[Dict[str, Any]]:
    """단일 전사 런의 세그먼트 및 화자 이름 포함 상세 데이터 반환"""
    conn = get_db_connection()
    try:
        row = conn.execute("SELECT * FROM transcription_runs WHERE id = ?", (run_id,)).fetchone()
        if not row:
            return None
        d = dict(row)
        try:
            d["segments"] = json.loads(d["segments_json"] or "[]")
        except Exception:
            d["segments"] = []
        try:
            d["speaker_names"] = json.loads(d["speaker_names_json"] or "{}")
        except Exception:
            d["speaker_names"] = {}
        return d
    finally:
        conn.close()


@eel.expose
def start_transcription_run(audio_id: int, options: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """신규 전사 및 화자 분리 런 시작 (FIFO 큐 등록)"""
    options = options or {}
    model_name = options.get("model_name", "small")
    language = options.get("language", "ko")
    stt_device = options.get("stt_device", "cuda")
    enable_diarization = 1 if options.get("enable_diarization") else 0
    num_speakers = int(options.get("num_speakers", 0))
    cluster_threshold = float(options.get("cluster_threshold", 0.5))

    conn = get_db_connection()
    try:
        audio = conn.execute("SELECT id FROM audio_files WHERE id = ?", (audio_id,)).fetchone()
        if not audio:
            return {"success": False, "message": "오디오 파일을 찾을 수 없습니다."}

        cursor = conn.execute("""
            INSERT INTO transcription_runs (
                audio_id, model_name, language, stt_device,
                enable_diarization, num_speakers, cluster_threshold,
                status, current_phase, progress
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', 'PENDING', 0.0)
        """, (audio_id, model_name, language, stt_device, enable_diarization, num_speakers, cluster_threshold))
        conn.commit()
        run_id = cursor.lastrowid

        # 워커 큐 등록
        _worker.enqueue_run(run_id)
        log_info("Whisper", f"신규 전사 요청 등록 (Run #{run_id}, AudioID={audio_id}, Model={model_name}, Diarization={bool(enable_diarization)})")
        return {"success": True, "run_id": run_id}
    finally:
        conn.close()


@eel.expose
def cancel_transcription_run(run_id: int) -> Dict[str, Any]:
    """진행 중이거나 대기 중인 런 취소 요청"""
    _worker.cancel_run(run_id)
    return {"success": True, "run_id": run_id}


@eel.expose
def update_segment_text(run_id: int, segment_id: int, new_text: str) -> Dict[str, Any]:
    """
    세그먼트 단일 진실 공급원(SSOT) 텍스트 수정
    수정 사항을 SQLite DB에 보존하고 최신 런 상세 반환
    """
    conn = get_db_connection()
    try:
        row = conn.execute("SELECT segments_json FROM transcription_runs WHERE id = ?", (run_id,)).fetchone()
        if not row:
            return {"success": False, "message": "런을 찾을 수 없습니다."}

        try:
            segments = json.loads(row["segments_json"] or "[]")
        except Exception:
            segments = []

        found = False
        for seg in segments:
            if seg["id"] == segment_id:
                seg["text"] = new_text.strip()
                found = True
                break

        if not found:
            return {"success": False, "message": "세그먼트를 찾을 수 없습니다."}

        conn.execute("""
            UPDATE transcription_runs
            SET segments_json = ?, updated_at = datetime('now', 'localtime')
            WHERE id = ?
        """, (json.dumps(segments, ensure_ascii=False), run_id))
        conn.commit()

        return {"success": True, "segments": segments}
    finally:
        conn.close()


@eel.expose
def rename_speaker(run_id: int, speaker_id: str, display_name: str) -> Dict[str, Any]:
    """
    화자 표시명 O(1) 인라인 치환 매핑 업데이트
    예: {"SPEAKER_00": "홍길동 팀장"}
    """
    conn = get_db_connection()
    try:
        row = conn.execute("SELECT speaker_names_json FROM transcription_runs WHERE id = ?", (run_id,)).fetchone()
        if not row:
            return {"success": False, "message": "런을 찾을 수 없습니다."}

        try:
            speaker_names = json.loads(row["speaker_names_json"] or "{}")
        except Exception:
            speaker_names = {}

        speaker_names[speaker_id] = display_name.strip()

        conn.execute("""
            UPDATE transcription_runs
            SET speaker_names_json = ?, updated_at = datetime('now', 'localtime')
            WHERE id = ?
        """, (json.dumps(speaker_names, ensure_ascii=False), run_id))
        conn.commit()

        return {"success": True, "speaker_names": speaker_names}
    finally:
        conn.close()


def _format_timecode(seconds: float, delimiter: str = ",") -> str:
    """초 단위를 HH:MM:SS,mmm 포맷으로 변환"""
    hrs = int(seconds // 3600)
    mins = int((seconds % 3600) // 60)
    secs = int(seconds % 60)
    ms = int(round((seconds - int(seconds)) * 1000))
    if ms >= 1000:
        ms = 999
    return f"{hrs:02d}:{mins:02d}:{secs:02d}{delimiter}{ms:03d}"


@eel.expose
def export_subtitles(run_id: int, export_format: str = "srt") -> Dict[str, Any]:
    """자막 파일(SRT, VTT, TXT) 생성 및 텍스트 데이터 반환"""
    conn = get_db_connection()
    try:
        row = conn.execute("""
            SELECT r.*, a.filename
            FROM transcription_runs r
            JOIN audio_files a ON a.id = r.audio_id
            WHERE r.id = ?
        """, (run_id,)).fetchone()
        if not row:
            return {"success": False, "message": "런을 찾을 수 없습니다."}

        try:
            segments = json.loads(row["segments_json"] or "[]")
        except Exception:
            segments = []
        try:
            speaker_names = json.loads(row["speaker_names_json"] or "{}")
        except Exception:
            speaker_names = {}

        export_format = export_format.lower().strip()
        lines = []

        if export_format == "srt":
            for idx, seg in enumerate(segments, start=1):
                start_tc = _format_timecode(seg["start"], ",")
                end_tc = _format_timecode(seg["end"], ",")
                spk = seg.get("speaker", "SPEAKER_00")
                spk_label = speaker_names.get(spk, spk)
                lines.append(str(idx))
                lines.append(f"{start_tc} --> {end_tc}")
                lines.append(f"[{spk_label}] {seg['text']}")
                lines.append("")
        elif export_format == "vtt":
            lines.append("WEBVTT")
            lines.append("")
            for idx, seg in enumerate(segments, start=1):
                start_tc = _format_timecode(seg["start"], ".")
                end_tc = _format_timecode(seg["end"], ".")
                spk = seg.get("speaker", "SPEAKER_00")
                spk_label = speaker_names.get(spk, spk)
                lines.append(str(idx))
                lines.append(f"{start_tc} --> {end_tc}")
                lines.append(f"<v {spk_label}>{seg['text']}</v>")
                lines.append("")
        else:  # txt
            for seg in segments:
                mins = int(seg["start"] // 60)
                secs = int(seg["start"] % 60)
                spk = seg.get("speaker", "SPEAKER_00")
                spk_label = speaker_names.get(spk, spk)
                lines.append(f"[{mins:02d}:{secs:02d}] {spk_label}: {seg['text']}")

        content = "\n".join(lines)
        base_name = os.path.splitext(row["filename"])[0]
        out_filename = f"{base_name}_run{run_id}.{export_format}"

        return {
            "success": True,
            "filename": out_filename,
            "format": export_format,
            "content": content
        }
    finally:
        conn.close()


@eel.expose
def delete_audio_file(audio_id: int) -> Dict[str, Any]:
    """오디오 파일 및 연관된 모든 전사 런 영구 삭제 (CASCADE)"""
    conn = get_db_connection()
    try:
        row = conn.execute("SELECT file_path FROM audio_files WHERE id = ?", (audio_id,)).fetchone()
        conn.execute("DELETE FROM audio_files WHERE id = ?", (audio_id,))
        conn.commit()

        # data/audio 디렉토리에 업로드된 파일인 경우 디스크 정리
        if row and row["file_path"]:
            fp = row["file_path"]
            norm_audio_dir = os.path.abspath(AUDIO_DIR)
            norm_fp = os.path.abspath(fp)
            if norm_fp.startswith(norm_audio_dir):
                remaining = conn.execute("SELECT COUNT(*) FROM audio_files WHERE file_path = ?", (fp,)).fetchone()[0]
                if remaining == 0 and os.path.exists(fp):
                    try:
                        os.remove(fp)
                    except OSError:
                        pass

        return {"success": True, "audio_id": audio_id}
    finally:
        conn.close()


@eel.expose
def delete_transcription_run(run_id: int) -> Dict[str, Any]:
    """단일 전사 런 삭제"""
    conn = get_db_connection()
    try:
        conn.execute("DELETE FROM transcription_runs WHERE id = ?", (run_id,))
        conn.commit()
        return {"success": True, "run_id": run_id}
    finally:
        conn.close()


@eel.expose
def get_whisper_system_info() -> Dict[str, Any]:
    """하드웨어 및 AI 모델 가용성 정보 반환"""
    return ModelManager.get_system_info()


@eel.expose
def download_diarization_models() -> Dict[str, Any]:
    """화자 분리 모델 사전 다운로드 시작 (비동기 스레드)"""
    if ModelManager.are_diarization_models_available():
        return {"success": True, "already_available": True}

    def _worker_dl():
        def _cb(label, pct, dl, tot):
            try:
                eel.on_diarization_model_download_progress({
                    "label": label,
                    "percent": pct,
                    "downloaded": dl,
                    "total": tot
                })
            except Exception:
                pass

        try:
            ok = ModelManager.download_diarization_models_if_needed(progress_callback=_cb)
            try:
                eel.on_diarization_model_download_progress({
                    "label": "완료",
                    "percent": 100.0,
                    "downloaded": 0,
                    "total": 0,
                    "success": ok
                })
            except Exception:
                pass
        except Exception as e:
            try:
                eel.on_diarization_model_download_progress({
                    "label": f"다운로드 실패: {e}",
                    "percent": 0.0,
                    "downloaded": 0,
                    "total": 0,
                    "error": str(e)
                })
            except Exception:
                pass

    t = threading.Thread(target=_worker_dl, daemon=True)
    t.start()
    return {"success": True, "started": True}

"""
통합 기능 테스트 스크립트: 전역 시스템 로깅 및 백그라운드 예외 크래시 방어 검증
(scripts/test_logging_crash_guard_functional.py)
- sys.stdout / sys.stderr 리디렉션 및 태그 파싱 링버퍼 수집 검증
- threading.excepthook 백그라운드 스레드 미처리 예외 캡처 및 프로세스 생존 검증
- WhisperWorker 루프 예외 격리 및 지속성 검증
"""
import sys
import os
import time
import threading
import traceback
from unittest.mock import patch, MagicMock

if sys.stdout and hasattr(sys.stdout, 'reconfigure'):
    try:
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass
if sys.stderr and hasattr(sys.stderr, 'reconfigure'):
    try:
        sys.stderr.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass

# 프로젝트 루트 경로 등록
ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT_DIR not in sys.path:
    sys.path.insert(0, ROOT_DIR)

import core.logger as logger
from services.whisper_service import WhisperWorker, WindowProgressTracker
from services.db_service import init_db, get_db_connection


def test_stream_redirection():
    print("--- [테스트 1] sys.stdout / sys.stderr 리디렉션 및 링버퍼 수집 검증 ---")
    logger.setup_logger()

    init_len = len(logger._log_buffer)

    # 1. 일반 print() 호출
    test_msg_1 = "테스트 표준 콘솔 출력 메시지입니다."
    print(test_msg_1)

    # 2. 태그 포함 print() 호출
    test_msg_2 = "화자 분리 프로세스 초기화 테스트"
    print(f"[SherpaDiarization] {test_msg_2}")

    # 3. sys.stderr 출력
    test_err_msg = "표준 에러 스트림 경고 테스트 메시지입니다."
    sys.stderr.write(f"{test_err_msg}\n")
    sys.stderr.flush()

    # 버퍼 검증
    recent_logs = list(logger._log_buffer)[init_len:]
    assert any(test_msg_1 in l['message'] and l['category'] == 'Console' for l in recent_logs), "일반 print() 수집 실패"
    assert any(test_msg_2 in l['message'] and l['category'] == 'SherpaDiarization' for l in recent_logs), "태그 파싱 print() 수집 실패"
    assert any(test_err_msg in l['message'] and l['category'] == 'Stderr' for l in recent_logs), "sys.stderr 수집 실패"

    print("[PASS] 스트림 리디렉션 및 태그 자동 파싱 정상 작동")


def test_thread_excepthook():
    print("--- [테스트 2] 백그라운드 스레드 미처리 예외 캡처 및 크래시 방어 검증 ---")
    logger.setup_logger()
    init_len = len(logger._log_buffer)

    exc_triggered = threading.Event()

    def buggy_thread_func():
        try:
            time.sleep(0.05)
            raise RuntimeError("테스트용 백그라운드 스레드 고의 발생 예외")
        finally:
            exc_triggered.set()

    th = threading.Thread(target=buggy_thread_func, name="BuggyTestThread", daemon=True)
    th.start()
    th.join(timeout=2.0)
    time.sleep(0.1)

    recent_logs = list(logger._log_buffer)[init_len:]
    matched = [
        l for l in recent_logs 
        if "테스트용 백그라운드 스레드 고의 발생 예외" in l['message'] and "Thread:BuggyTestThread" in l['category']
    ]

    assert len(matched) > 0, "threading.excepthook 예외 캡처 실패"
    assert matched[0]['level'] == 'error', "로그 레벨이 error가 아님"
    assert "Traceback" in matched[0]['details'], "스택 트레이스 세부사항 누락"

    print("[PASS] 백그라운드 스레드 예외 캡처 및 프로세스 정상 지속 확인")


def test_whisper_worker_isolation():
    print("--- [테스트 3] WhisperWorker 큐 예외 격리 및 연속 실행 지속성 검증 ---")
    init_db()
    conn = get_db_connection()
    try:
        # 테스트용 가상 오디오 및 런 등록
        cursor = conn.execute("""
            INSERT INTO audio_files (file_path, filename, file_size, duration_sec)
            VALUES ('test_non_existent.mp3', 'test_non_existent.mp3', 1024, 10.0)
        """)
        audio_id = cursor.lastrowid

        cursor = conn.execute("""
            INSERT INTO transcription_runs (audio_id, model_name, language, stt_device, status, current_phase, progress)
            VALUES (?, 'tiny', 'ko', 'cpu', 'PENDING', 'PENDING', 0.0)
        """, (audio_id,))
        run_id_1 = cursor.lastrowid

        cursor = conn.execute("""
            INSERT INTO transcription_runs (audio_id, model_name, language, stt_device, status, current_phase, progress)
            VALUES (?, 'tiny', 'ko', 'cpu', 'PENDING', 'PENDING', 0.0)
        """, (audio_id,))
        run_id_2 = cursor.lastrowid
        conn.commit()
    finally:
        conn.close()

    worker = WhisperWorker()

    try:
        # run_id_1은 파일 미존재로 FAILED 처리되어야 함
        worker.enqueue_run(run_id_1)
        # run_id_2는 큐 등록 후 즉시 취소 요청 (대기열 취소 검증)
        worker.enqueue_run(run_id_2)
        worker.cancel_run(run_id_2)

        # 작업 완료 대기
        max_wait = 10.0
        start_t = time.time()
        run_1_status = None
        run_2_status = None

        while time.time() - start_t < max_wait:
            conn = get_db_connection()
            try:
                r1 = conn.execute("SELECT status FROM transcription_runs WHERE id = ?", (run_id_1,)).fetchone()
                r2 = conn.execute("SELECT status FROM transcription_runs WHERE id = ?", (run_id_2,)).fetchone()
                run_1_status = r1["status"] if r1 else None
                run_2_status = r2["status"] if r2 else None
                if run_1_status in ("FAILED", "COMPLETED") and run_2_status == "CANCELLED":
                    break
            finally:
                conn.close()
            time.sleep(0.1)

        assert run_1_status == "FAILED", f"Run 1 상태 예상 FAILED, 실제: {run_1_status}"
        assert run_2_status == "CANCELLED", f"Run 2 상태 예상 CANCELLED, 실제: {run_2_status}"

        # 워커 스레드가 살아있는지 확인
        assert worker._worker_thread.is_alive(), "워커 스레드가 예외로 인해 비정상 종료됨"
    finally:
        # 테스트 데이터 정리
        conn = get_db_connection()
        try:
            conn.execute("DELETE FROM transcription_runs WHERE id IN (?, ?)", (run_id_1, run_id_2))
            conn.execute("DELETE FROM audio_files WHERE id = ?", (audio_id,))
            conn.commit()
        finally:
            conn.close()

    print("[PASS] WhisperWorker 예외 격리, 취소 감지 및 스레드 지속성 검증 완료")


def test_cuda_fallback_logic():
    print("--- [테스트 4] CUDA 로딩 오류 / OOM 시 CPU 폴백 시뮬레이션 검증 ---")
    init_db()

    conn = get_db_connection()
    try:
        cursor = conn.execute("""
            INSERT INTO audio_files (file_path, filename, file_size, duration_sec)
            VALUES ('dummy.mp3', 'dummy.mp3', 2048, 5.0)
        """)
        audio_id = cursor.lastrowid
        cursor = conn.execute("""
            INSERT INTO transcription_runs (audio_id, model_name, language, stt_device, status, current_phase, progress)
            VALUES (?, 'tiny', 'ko', 'cuda', 'PENDING', 'PENDING', 0.0)
        """, (audio_id,))
        run_id = cursor.lastrowid
        conn.commit()
    finally:
        conn.close()

    # WhisperModel 초기화 시 CUDA 예외를 모킹하여 CPU 폴백이 일어나는지 검증
    mock_model = MagicMock()
    # transcribe 결과 mock
    mock_seg = MagicMock()
    mock_seg.end = 5.0
    mock_seg.words = []
    mock_seg.text = "안녕하세요 테스트입니다"
    mock_seg.start = 0.0
    mock_model.transcribe.return_value = ([mock_seg], None)

    cuda_attempted = []

    def mock_whisper_init(model_size_or_path, download_root, device, compute_type):
        cuda_attempted.append(device)
        if device == "cuda":
            raise RuntimeError("CUDA out of memory: simulated VRAM exhaustion")
        return mock_model

    worker = WhisperWorker()

    with patch("os.path.exists", return_value=True), \
         patch("services.whisper_service.WhisperModel", side_effect=mock_whisper_init):
        worker._process_run(run_id)

    assert "cuda" in cuda_attempted, "CUDA 시도가 이루어지지 않음"
    assert "cpu" in cuda_attempted, "CUDA 실패 후 CPU 폴백이 이루어지지 않음"

    conn = get_db_connection()
    try:
        r = conn.execute("SELECT status, segments_json FROM transcription_runs WHERE id = ?", (run_id,)).fetchone()
        assert r["status"] == "COMPLETED", f"폴백 후 완료 상태가 아님: {r['status']}"
        conn.execute("DELETE FROM transcription_runs WHERE id = ?", (run_id,))
        conn.execute("DELETE FROM audio_files WHERE id = ?", (audio_id,))
        conn.commit()
    finally:
        conn.close()

    # 로그 버퍼에 폴백 경고가 남았는지 확인
    recent_logs = list(logger._log_buffer)
    assert any("CPU(int8) 모드로 자동 폴백" in l['message'] for l in recent_logs), "폴백 경고 로그 미기록"

    print("[PASS] CUDA OOM 오류 시 CPU(int8) 자동 폴백 및 복구 검증 완료")


if __name__ == "__main__":
    print("====================================================================")
    print("   [TEST] 시스템 로깅 파이프라인 & 크래시 가드 런타임 기능 검증 시작")
    print("====================================================================")
    test_stream_redirection()
    test_thread_excepthook()
    test_whisper_worker_isolation()
    test_cuda_fallback_logic()
    print("====================================================================")
    print("   [ALL PASS] 모든 런타임 기능 테스트 통과 (100% PASS)")
    print("====================================================================")

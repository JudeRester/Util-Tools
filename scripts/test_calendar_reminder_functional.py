"""
캘린더 개별 일정 알림 기능 및 SQLite 영속화 동작 검증 테스트 스크립트
"""
import os
import sys
import datetime
import time

# 루트 경로 추가
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from services import db_service, calendar_service


def test_calendar_reminder_crud():
    print("[TEST 1] Calendar Reminder CRUD 검증 시작...")
    test_uid = "test_event_uid_12345"
    test_cal = "테스트 캘린더"
    test_title = "중요 미팅 일정"
    start_dt = (datetime.datetime.now() + datetime.timedelta(minutes=15)).strftime("%Y-%m-%d %H:%M")

    # 1. 설정 등록
    ok = db_service.set_calendar_reminder(
        event_uid=test_uid,
        calendar_name=test_cal,
        title=test_title,
        start_datetime=start_dt,
        reminder_minutes=10,
        is_enabled=1
    )
    assert ok is True, "set_calendar_reminder 실패"
    print("  -> 알림 등록(UPSERT) 성공")

    # 2. 조회 검증
    reminders = db_service.get_calendar_reminders(only_active=True)
    found = next((r for r in reminders if r["event_uid"] == test_uid), None)
    assert found is not None, "등록된 알림이 조회되지 않음"
    assert found["title"] == test_title, "제목 불일치"
    assert found["reminder_minutes"] == 10, "알림 시간 불일치"
    assert found["is_notified"] == 0, "초기 is_notified 값 오류"
    print("  -> 활성 알림 조회 성공")

    # 3. 알림 발송 완료 처리 검증
    ok = db_service.mark_calendar_reminder_notified(test_uid)
    assert ok is True, "mark_calendar_reminder_notified 실패"
    
    # 4. 완료 처리 후 활성 알림 목록에서 제외 확인
    active_reminders = db_service.get_calendar_reminders(only_active=True)
    found_active = next((r for r in active_reminders if r["event_uid"] == test_uid), None)
    assert found_active is None, "완료 처리된 알림이 활성 목록에 남아있음"
    print("  -> 발송 완료 처리 및 활성 목록 제외 성공")

    # 5. 알림 해제(삭제) 검증
    ok = db_service.delete_calendar_reminder(test_uid)
    assert ok is True, "delete_calendar_reminder 실패"
    all_reminders = db_service.get_calendar_reminders()
    found_all = next((r for r in all_reminders if r["event_uid"] == test_uid), None)
    assert found_all is None, "삭제 후에도 알림이 남아있음"
    print("  -> 알림 삭제(DELETE) 성공")

    print("[PASS] Test 1: Calendar Reminder CRUD 정상 완료")


def test_ics_uid_parsing():
    print("[TEST 2] ICS UID 파싱 및 결정론적 해시 폴백 검증 시작...")
    
    # UID가 있는 ICS
    ics_with_uid = """BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:sample-uid-unique-999
SUMMARY:UID 포함 일정
DTSTART:20261015T140000
DTEND:20261015T150000
END:VEVENT
END:VCALENDAR"""

    events = calendar_service.parse_ics_content(ics_with_uid, {"name": "캘린더A", "color": "#ef4444"})
    assert len(events) == 1, "이벤트 파싱 실패"
    assert events[0]["uid"] == "sample-uid-unique-999", f"UID 파싱 오류: {events[0]['uid']}"
    print("  -> 표준 UID 파싱 성공")

    # UID가 없는 ICS (폴백 해시 생성 검증)
    ics_without_uid = """BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
SUMMARY:UID 미포함 일정
DTSTART:20261015T140000
DTEND:20261015T150000
END:VEVENT
END:VCALENDAR"""

    events2 = calendar_service.parse_ics_content(ics_without_uid, {"name": "캘린더B", "color": "#3b82f6"})
    assert len(events2) == 1, "이벤트 파싱 실패"
    assert events2[0]["uid"].startswith("gen_"), f"폴백 UID 생성 오류: {events2[0]['uid']}"
    print(f"  -> 폴백 UID 생성 성공: {events2[0]['uid']}")

    print("[PASS] Test 2: ICS UID 파싱 정상 완료")


def test_exposed_reminder_apis():
    print("[TEST 3] Eel Exposed 알림 API 검증 시작...")
    test_uid = "exposed_test_uid_555"
    
    # 1. 알림 설정 API
    res = calendar_service.set_event_reminder(
        event_uid=test_uid,
        calendar_name="공식 캘린더",
        title="릴리스 회의",
        start_datetime="2026-10-20 10:00",
        reminder_minutes=15
    )
    assert res.get("status") == "success", f"set_event_reminder 실패: {res}"
    print("  -> set_event_reminder 성공")

    # 2. 목록 조회 API
    list_res = calendar_service.get_event_reminders()
    assert list_res.get("status") == "success", f"get_event_reminders 실패: {list_res}"
    found = next((r for r in list_res.get("data", []) if r["event_uid"] == test_uid), None)
    assert found is not None, "목록에서 테스트 알림 미발견"
    assert found["reminder_minutes"] == 15, "알림 분 설정값 불일치"
    print("  -> get_event_reminders 성공")

    # 3. 알림 삭제 API
    del_res = calendar_service.delete_event_reminder(test_uid)
    assert del_res.get("status") == "success", f"delete_event_reminder 실패: {del_res}"
    print("  -> delete_event_reminder 성공")

    list_res2 = calendar_service.get_event_reminders()
    found2 = next((r for r in list_res2.get("data", []) if r["event_uid"] == test_uid), None)
    assert found2 is None, "삭제 후에도 알림이 남아있음"
    print("  -> 삭제 후 목록 확인 성공")

    print("[PASS] Test 3: Eel Exposed 알림 API 정상 완료")


if __name__ == "__main__":
    test_calendar_reminder_crud()
    test_ics_uid_parsing()
    test_exposed_reminder_apis()
    print("\n[ALL PASS] Backend functional test completed successfully.")

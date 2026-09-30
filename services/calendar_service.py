"""
구글 캘린더 및 iCal(ICS) 일정 구독 및 동기화 서비스 모듈
"""
import os
import re
import json
import base64
import hashlib
import threading
import time
import urllib.request
import urllib.parse
import datetime
import eel
from core.paths import CALENDAR_CONFIG_PATH as CALENDAR_CONFIG_FILE, CALENDAR_CONFIG_EXAMPLE_PATH as CALENDAR_CONFIG_EXAMPLE_FILE
import core.logger
from services import db_service

DEFAULT_CONFIG = {
    "ics_urls": [
        {
            "id": "1",
            "name": "대한민국 공휴일",
            "url": "https://calendar.google.com/calendar/ical/ko.south_korea%23holiday%40group.v.calendar.google.com/public/basic.ics",
            "color": "#ef4444"
        }
    ],
    "auto_refresh_minutes": 30
}


def normalize_calendar_url(url_str):
    """
    다양한 구글 캘린더 링크 형식(?cid=Base64..., webcal://, embed?src=...)을
    표준 iCal(basic.ics) 주소로 자동 변환/정규화
    """
    url_str = (url_str or "").strip()
    if not url_str:
        return ""

    # 1. webcal:// -> https://
    if url_str.startswith("webcal://"):
        url_str = "https://" + url_str[9:]

    # 2. 구글 캘린더 웹 링크 감지 (?cid=... 또는 ?src=...)
    if "calendar.google.com" in url_str and not url_str.endswith(".ics"):
        try:
            parsed = urllib.parse.urlparse(url_str)
            qs = urllib.parse.parse_qs(parsed.query)
            cid = qs.get("cid", [None])[0] or qs.get("src", [None])[0]
            if cid:
                # Base64 인코딩된 CID일 경우 자동 디코딩
                if "@" not in cid:
                    try:
                        padded = cid + "=" * ((4 - len(cid) % 4) % 4)
                        decoded = base64.b64decode(padded).decode("utf-8", errors="ignore")
                        if "@" in decoded:
                            cid = decoded
                    except Exception:
                        pass

                encoded_cid = urllib.parse.quote(cid)
                return f"https://calendar.google.com/calendar/ical/{encoded_cid}/public/basic.ics"
        except Exception:
            pass

    return url_str


def _parse_ics_datetime(dt_str):
    """ICS 날짜/시간 문자열(YYYYMMDD 또는 YYYYMMDDTHHMMSSZ)을 포맷팅된 문자열로 변환"""
    dt_str = dt_str.strip()
    # 날짜만 있는 경우 (YYYYMMDD)
    if len(dt_str) == 8 and dt_str.isdigit():
        return {
            "date": f"{dt_str[:4]}-{dt_str[4:6]}-{dt_str[6:8]}",
            "time": None,
            "allDay": True
        }

    # 일시 (YYYYMMDDTHHMMSS or YYYYMMDDTHHMMSSZ)
    match = re.match(r'(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?', dt_str)
    if match:
        year, month, day, hour, minute, second, is_utc = match.groups()
        dt = datetime.datetime(int(year), int(month), int(day), int(hour), int(minute), int(second))
        if is_utc:
            # UTC -> KST (+9시간)
            dt += datetime.timedelta(hours=9)
        return {
            "date": dt.strftime("%Y-%m-%d"),
            "time": dt.strftime("%H:%M"),
            "allDay": False
        }

    # 기본 반환
    if len(dt_str) >= 8:
        return {
            "date": f"{dt_str[:4]}-{dt_str[4:6]}-{dt_str[6:8]}",
            "time": None,
            "allDay": True
        }
    return {"date": dt_str, "time": None, "allDay": True}


def parse_ics_content(ics_text, calendar_info):
    """ICS 텍스트 파싱하여 이벤트 목록 추출"""
    events = []

    # RFC 5545 라인 언폴딩 (줄바꿈 후 공백으로 이어지는 긴 라인 합치기)
    unfolded_text = re.sub(r'\r?\n[ \t]', '', ics_text)
    lines = unfolded_text.splitlines()

    # 캘린더 원본 이름 감지 (X-WR-CALNAME)
    cal_detected_name = calendar_info.get("name")
    for l in lines[:20]:
        if l.startswith("X-WR-CALNAME:"):
            detected = l.split(":", 1)[1].strip()
            if detected and (not cal_detected_name or cal_detected_name == "캘린더"):
                cal_detected_name = detected
            break

    cal_name = cal_detected_name or "캘린더"
    cal_color = calendar_info.get("color", "#6366f1")

    current_event = None
    in_event = False

    for line in lines:
        line = line.strip()
        if not line:
            continue

        if line == 'BEGIN:VEVENT':
            in_event = True
            current_event = {
                "id": str(len(events) + 1),
                "uid": "",
                "calendarName": cal_name,
                "color": cal_color,
                "title": "(제목 없음)",
                "startDate": "",
                "startTime": None,
                "endDate": "",
                "endTime": None,
                "allDay": True,
                "location": "",
                "description": ""
            }
            continue

        if line == 'END:VEVENT':
            if in_event and current_event and current_event.get("startDate"):
                # UID가 비어있는 경우(비표준 ICS 등) 결정론적 고유 해시 키 자동 생성
                if not current_event.get("uid"):
                    hash_src = f"{cal_name}_{current_event.get('title')}_{current_event.get('startDate')}_{current_event.get('startTime')}"
                    current_event["uid"] = f"gen_{hashlib.sha256(hash_src.encode('utf-8')).hexdigest()[:16]}"

                # RFC 5545 표준: 종일 일정(allDay)의 DTEND는 배타적(Exclusive)이므로 실제 일정 종료일은 DTEND - 1일임
                if current_event.get("allDay"):
                    end_str = current_event.get("endDate")
                    start_str = current_event.get("startDate")
                    if end_str and end_str > start_str:
                        try:
                            end_dt = datetime.datetime.strptime(end_str, "%Y-%m-%d") - datetime.timedelta(days=1)
                            current_event["endDate"] = end_dt.strftime("%Y-%m-%d")
                        except Exception:
                            current_event["endDate"] = start_str
                    else:
                        current_event["endDate"] = start_str
                else:
                    if not current_event.get("endDate"):
                        current_event["endDate"] = current_event["startDate"]
                events.append(current_event)
            in_event = False
            current_event = None
            continue

        if in_event and current_event is not None:
            if line.startswith('UID'):
                val = line.split(':', 1)[1] if ':' in line else ''
                current_event["uid"] = val.strip()
            elif line.startswith('SUMMARY'):
                val = line.split(':', 1)[1] if ':' in line else ''
                current_event["title"] = val.replace('\\,', ',').replace('\\;', ';').replace('\\n', ' ')
            elif line.startswith('DTSTART'):
                val = line.split(':', 1)[1] if ':' in line else ''
                dt_info = _parse_ics_datetime(val)
                current_event["startDate"] = dt_info["date"]
                current_event["startTime"] = dt_info["time"]
                current_event["allDay"] = dt_info["allDay"]
            elif line.startswith('DTEND'):
                val = line.split(':', 1)[1] if ':' in line else ''
                dt_info = _parse_ics_datetime(val)
                current_event["endDate"] = dt_info["date"]
                current_event["endTime"] = dt_info["time"]
            elif line.startswith('LOCATION'):
                val = line.split(':', 1)[1] if ':' in line else ''
                current_event["location"] = val.replace('\\,', ',').replace('\\n', ' ')
            elif line.startswith('DESCRIPTION'):
                val = line.split(':', 1)[1] if ':' in line else ''
                current_event["description"] = val.replace('\\,', ',').replace('\\n', '\n')

    return events


@eel.expose
def get_calendar_config():
    """캘린더 설정 목록 불러오기"""
    try:
        if not os.path.exists(CALENDAR_CONFIG_FILE):
            initial_data = DEFAULT_CONFIG
            if os.path.exists(CALENDAR_CONFIG_EXAMPLE_FILE):
                try:
                    with open(CALENDAR_CONFIG_EXAMPLE_FILE, 'r', encoding='utf-8') as ef:
                        initial_data = json.load(ef)
                except Exception:
                    initial_data = DEFAULT_CONFIG

            with open(CALENDAR_CONFIG_FILE, 'w', encoding='utf-8') as f:
                json.dump(initial_data, f, ensure_ascii=False, indent=2)
            return {"status": "success", "data": initial_data}

        with open(CALENDAR_CONFIG_FILE, 'r', encoding='utf-8') as f:
            data = json.load(f)
            return {"status": "success", "data": data}
    except Exception as e:
        return {"status": "error", "message": str(e), "data": DEFAULT_CONFIG}


@eel.expose
def save_calendar_config(config):
    """캘린더 설정 저장하기 (로컬 calendar_config.json)"""
    try:
        # 저장 시 모든 url 정규화
        if "ics_urls" in config:
            for item in config["ics_urls"]:
                item["url"] = normalize_calendar_url(item.get("url", ""))

        with open(CALENDAR_CONFIG_FILE, 'w', encoding='utf-8') as f:
            json.dump(config, f, ensure_ascii=False, indent=2)
        return {"status": "success", "message": "캘린더 설정이 저장되었습니다."}
    except Exception as e:
        return {"status": "error", "message": str(e)}


@eel.expose
def fetch_calendar_events(force_refresh=False):
    """구독된 모든 iCal URL에서 일정을 가져와 합산 반환"""
    try:
        cfg_res = get_calendar_config()
        config = cfg_res.get("data", DEFAULT_CONFIG)
        ics_urls = config.get("ics_urls", [])

        if not ics_urls:
            return {"status": "success", "events": [], "count": 0}

        all_events = []
        errors = []

        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }

        for cal in ics_urls:
            raw_url = cal.get("url", "").strip()
            name = cal.get("name", "캘린더")
            if not raw_url:
                continue

            url = normalize_calendar_url(raw_url)

            try:
                req = urllib.request.Request(url, headers=headers)
                with urllib.request.urlopen(req, timeout=6) as response:
                    ics_data = response.read().decode('utf-8', errors='ignore')
                    cal_events = parse_ics_content(ics_data, cal)
                    all_events.extend(cal_events)
            except Exception as ex:
                errors.append(f"[{name}] 동기화 실패: {str(ex)}")

        # 시작 날짜 및 시간순 정렬
        all_events.sort(key=lambda x: (x.get("startDate", ""), x.get("startTime") or "00:00"))

        # DB에 저장된 개별 일정 알림 정보 조회 및 이벤트 객체에 병합
        try:
            reminders = db_service.get_calendar_reminders()
            reminder_map = {r["event_uid"]: r for r in reminders}
            for e in all_events:
                uid = e.get("uid")
                r = reminder_map.get(uid)
                if r and r.get("is_enabled"):
                    e["reminderMinutes"] = r.get("reminder_minutes", 10)
                    e["hasReminder"] = True
                    e["isNotified"] = bool(r.get("is_notified"))
                else:
                    e["reminderMinutes"] = None
                    e["hasReminder"] = False
                    e["isNotified"] = False
        except Exception as rem_ex:
            core.logger.log_warn("Calendar", f"알림 정보 병합 실패: {rem_ex}")

        if errors:
            core.logger.log_warn("Calendar", f"일부 캘린더 동기화 실패 ({len(errors)}건)", details="\n".join(errors))

        return {
            "status": "success" if not errors else "partial",
            "events": all_events,
            "count": len(all_events),
            "errors": errors,
            "lastUpdated": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        }
    except Exception as e:
        core.logger.log_error("Calendar", f"캘린더 조회 실패: {str(e)}", exc=e)
        return {"status": "error", "message": str(e), "events": []}


@eel.expose
def set_event_reminder(event_uid, calendar_name, title, start_datetime, reminder_minutes=10):
    """개별 일정에 대한 시작 N분 전 알림 설정 (기본 10분)"""
    try:
        reminder_minutes = int(reminder_minutes)
        db_service.set_calendar_reminder(
            event_uid=event_uid,
            calendar_name=calendar_name or "",
            title=title or "(제목 없음)",
            start_datetime=start_datetime,
            reminder_minutes=reminder_minutes,
            is_enabled=1
        )
        return {"status": "success", "message": f"{reminder_minutes}분 전 알림이 설정되었습니다."}
    except Exception as e:
        core.logger.log_error("Calendar", f"알림 설정 실패: {e}", exc=e)
        return {"status": "error", "message": str(e)}


@eel.expose
def delete_event_reminder(event_uid):
    """개별 일정 알림 해제"""
    try:
        db_service.delete_calendar_reminder(event_uid)
        return {"status": "success", "message": "알림이 해제되었습니다."}
    except Exception as e:
        core.logger.log_error("Calendar", f"알림 해제 실패: {e}", exc=e)
        return {"status": "error", "message": str(e)}


@eel.expose
def get_event_reminders():
    """모든 알림 설정 목록 조회"""
    try:
        reminders = db_service.get_calendar_reminders()
        return {"status": "success", "data": reminders}
    except Exception as e:
        return {"status": "error", "message": str(e), "data": []}


# =====================================================================
# 캘린더 백그라운드 알림 감시 데몬 (Calendar Reminder Daemon)
# =====================================================================
_reminder_daemon_thread = None
_reminder_daemon_running = False
_reminder_daemon_lock = threading.Lock()


def _reminder_daemon_worker():
    """30초 주기로 활성 알림을 검사하여 OS 트레이 알림 및 인앱 토스트 발송"""
    global _reminder_daemon_running
    while _reminder_daemon_running:
        try:
            active_reminders = db_service.get_calendar_reminders(only_active=True)
            if active_reminders:
                now = datetime.datetime.now()
                for r in active_reminders:
                    start_str = r.get("start_datetime", "").strip()
                    if not start_str:
                        continue

                    # 날짜 형식 파싱 ("YYYY-MM-DD HH:MM")
                    try:
                        start_dt = datetime.datetime.strptime(start_str, "%Y-%m-%d %H:%M")
                    except Exception:
                        continue

                    remind_min = r.get("reminder_minutes", 10)
                    trigger_time = start_dt - datetime.timedelta(minutes=remind_min)
                    expire_time = start_dt + datetime.timedelta(hours=1)

                    # 알림 조건 도달 (trigger_time <= now < expire_time)
                    if trigger_time <= now < expire_time:
                        title = r.get("title") or "일정"
                        cal_name = r.get("calendar_name") or ""
                        time_display = start_dt.strftime("%H:%M")
                        
                        body_msg = f"[{cal_name}] {title}\n시작: {time_display}" if cal_name else f"{title}\n시작: {time_display}"
                        
                        # 1. Windows 시스템 트레이 알림
                        try:
                            from core.tray import show_tray_notification
                            show_tray_notification(f"📅 일정 알림 ({remind_min}분 전)", body_msg)
                        except Exception as tray_err:
                            core.logger.log_warn("CalendarReminder", f"트레이 알림 전송 실패: {tray_err}")

                        # 2. Eel 웹 프론트엔드 실시간 알림 통지
                        try:
                            eel.on_calendar_reminder_triggered({
                                "event_uid": r["event_uid"],
                                "title": title,
                                "calendar_name": cal_name,
                                "start_datetime": start_str,
                                "time_display": time_display,
                                "reminder_minutes": remind_min
                            })()
                        except Exception:
                            pass

                        # 3. 알림 발송 완료 플래그 갱신
                        db_service.mark_calendar_reminder_notified(r["event_uid"])
                        core.logger.log_info("CalendarReminder", f"알림 발송 완료: '{title}' ({remind_min}분 전)")

                    elif now >= expire_time:
                        # 1시간 이상 지난 과거 일정은 자동으로 완료 처리하여 검사 대상에서 제외
                        db_service.mark_calendar_reminder_notified(r["event_uid"])

        except Exception as e:
            core.logger.log_error("CalendarReminder", f"데몬 루프 에러: {e}")

        # 30초 대기
        for _ in range(30):
            if not _reminder_daemon_running:
                break
            time.sleep(1)


def start_calendar_reminder_daemon():
    """캘린더 알림 데몬 스레드 시작"""
    global _reminder_daemon_thread, _reminder_daemon_running
    with _reminder_daemon_lock:
        if _reminder_daemon_running:
            return
        _reminder_daemon_running = True
        _reminder_daemon_thread = threading.Thread(
            target=_reminder_daemon_worker,
            name="CalendarReminderDaemon",
            daemon=True
        )
        _reminder_daemon_thread.start()
        core.logger.log_info("CalendarReminder", "캘린더 알림 감시 데몬이 시작되었습니다. (주기: 30초)")


def stop_calendar_reminder_daemon():
    """캘린더 알림 데몬 스레드 중지"""
    global _reminder_daemon_running
    with _reminder_daemon_lock:
        _reminder_daemon_running = False


# 서비스 모듈 로드 시 데몬 자동 가동
start_calendar_reminder_daemon()


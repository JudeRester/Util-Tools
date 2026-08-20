"""
빠른 메모(Notes / Scratchpad) 데이터 관리 및 영속화 서비스 모듈
"""
import os
import json
import datetime
import eel

base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NOTES_FILE = os.path.join(base_dir, 'notes.json')
NOTES_EXAMPLE_FILE = os.path.join(base_dir, 'notes.example.json')

DEFAULT_NOTES = [
    {
        "id": "1",
        "title": "📌 오늘의 할 일",
        "content": "- [ ] 주간 업무 정리\n- [ ] 코드 리뷰 및 테스트\n- [ ] 서버 상태 점검",
        "updatedAt": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    },
    {
        "id": "2",
        "title": "🧪 임시 스크래치패드",
        "content": "// 임시 SQL 쿼리, JSON, 토큰, 명령어 등을 자유롭게 적어두세요.\n// 입력하는 즉시 로컬 PC에 안전하게 자동 저장됩니다.",
        "updatedAt": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    }
]


@eel.expose
def get_notes():
    """저장된 메모 목록 불러오기 (없으면 example.json 또는 기본값으로 생성)"""
    try:
        if not os.path.exists(NOTES_FILE):
            initial_data = DEFAULT_NOTES
            if os.path.exists(NOTES_EXAMPLE_FILE):
                try:
                    with open(NOTES_EXAMPLE_FILE, 'r', encoding='utf-8') as ef:
                        initial_data = json.load(ef)
                except Exception:
                    initial_data = DEFAULT_NOTES

            with open(NOTES_FILE, 'w', encoding='utf-8') as f:
                json.dump(initial_data, f, ensure_ascii=False, indent=2)
            return {"status": "success", "data": initial_data}

        with open(NOTES_FILE, 'r', encoding='utf-8') as f:
            data = json.load(f)
            return {"status": "success", "data": data}
    except Exception as e:
        return {"status": "error", "message": str(e), "data": DEFAULT_NOTES}


@eel.expose
def save_notes(notes_data):
    """메모 목록 저장하기 (로컬 notes.json)"""
    try:
        with open(NOTES_FILE, 'w', encoding='utf-8') as f:
            json.dump(notes_data, f, ensure_ascii=False, indent=2)
        return {"status": "success", "message": "메모가 자동 저장되었습니다."}
    except Exception as e:
        return {"status": "error", "message": str(e)}

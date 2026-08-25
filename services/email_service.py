import os
import json
import uuid
import time
import email
from email import policy
from email.parser import BytesParser
import tkinter as tk
from tkinter import filedialog
import eel

base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EMAILS_JSON_PATH = os.path.join(base_dir, "emails.json")
EMAILS_EXAMPLE_PATH = os.path.join(base_dir, "emails.example.json")
EMAILS_DIR = os.path.join(base_dir, "emails")

# 기본 프리셋 카테고리 목록
DEFAULT_CATEGORIES = ["업무/프로젝트", "회의록", "견적/계약", "인사/총무", "시스템/알림", "기타"]


def _ensure_emails_dir():
    if not os.path.exists(EMAILS_DIR):
        os.makedirs(EMAILS_DIR, exist_ok=True)


def _load_emails_from_disk():
    _ensure_emails_dir()
    if os.path.exists(EMAILS_JSON_PATH):
        try:
            with open(EMAILS_JSON_PATH, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception as e:
            print(f"⚠️ emails.json 로드 실패: {e}")
    
    if os.path.exists(EMAILS_EXAMPLE_PATH):
        try:
            with open(EMAILS_EXAMPLE_PATH, "r", encoding="utf-8") as f:
                data = json.load(f)
                _save_emails_to_disk(data)
                return data
        except Exception:
            pass
    return []


def _save_emails_to_disk(emails_data):
    _ensure_emails_dir()
    try:
        with open(EMAILS_JSON_PATH, "w", encoding="utf-8") as f:
            json.dump(emails_data, f, ensure_ascii=False, indent=2)
        return True
    except Exception as e:
        print(f"❌ emails.json 저장 오류: {e}")
        return False


def _auto_classify_category(subject, body_text):
    """제목 및 본문 키워드 기반 카테고리 자동 추천"""
    text = (subject + " " + body_text).lower()
    
    if any(k in text for k in ["회의", "미팅", "회의록", "agenda", "minutes", "간담회"]):
        return "회의록"
    if any(k in text for k in ["견적", "계약", "비용", "단가", "금액", "quote", "invoice", "결제", "정산", "영수증", "발주"]):
        return "견적/계약"
    if any(k in text for k in ["점검", "패치", "장애", "모니터링", "notice", "alert", "인프라", "보안", "백업", "공지"]):
        return "시스템/알림"
    if any(k in text for k in ["인사", "복지", "연차", "휴가", "채용", "교육", "총무", "인수인계", "사원", "증명서"]):
        return "인사/총무"
    if any(k in text for k in ["프로젝트", "개발", "기능", "요구사항", "배포", "release", "jira", "sprint", "api", "기획"]):
        return "업무/프로젝트"
    return "기타"


def _parse_eml_bytes(raw_bytes, source_filename=""):
    """raw 바이트로부터 EML 헤더 및 본문 추출"""
    msg = BytesParser(policy=policy.default).parsebytes(raw_bytes)
    
    subject = msg.get("subject", "(제목 없음)") or "(제목 없음)"
    from_addr = msg.get("from", "") or ""
    to_addr = msg.get("to", "") or ""
    date_str = msg.get("date", "") or ""
    
    body_text = ""
    body_html = ""
    attachments = []
    
    if msg.is_multipart():
        for part in msg.walk():
            content_type = part.get_content_type()
            content_disposition = str(part.get("Content-Disposition") or "")
            
            if "attachment" in content_disposition:
                filename = part.get_filename() or "attachment"
                payload = part.get_payload(decode=True)
                size_bytes = len(payload) if payload else 0
                if size_bytes > 1024 * 1024:
                    size_str = f"{size_bytes / (1024 * 1024):.1f} MB"
                elif size_bytes > 1024:
                    size_str = f"{size_bytes / 1024:.1f} KB"
                else:
                    size_str = f"{size_bytes} B"
                attachments.append({"filename": filename, "size": size_str})
                continue
                
            if content_type == "text/plain" and not body_text:
                try:
                    body_text = part.get_content()
                except Exception:
                    pass
            elif content_type == "text/html" and not body_html:
                try:
                    body_html = part.get_content()
                except Exception:
                    pass
    else:
        content_type = msg.get_content_type()
        try:
            if content_type == "text/html":
                body_html = msg.get_content()
            else:
                body_text = msg.get_content()
        except Exception:
            pass
            
    # body_text가 없고 body_html만 있는 경우 간단히 텍스트 생성
    if not body_text and body_html:
        import re
        body_text = re.sub(r"<[^>]+>", " ", body_html).strip()
        body_text = re.sub(r"\s+", " ", body_text)
        
    snippet = body_text[:160].replace("\n", " ").strip() if body_text else ""
    category = _auto_classify_category(subject, body_text)
    
    return {
        "subject": subject,
        "from": from_addr,
        "to": to_addr,
        "date": date_str,
        "category": category,
        "snippet": snippet,
        "body_text": body_text,
        "body_html": body_html,
        "attachments": attachments
    }


# ==========================================
# Eel Exposed API 함수들
# ==========================================

@eel.expose
def get_all_emails():
    """저장된 전체 이메일 목록 반환"""
    return _load_emails_from_disk()


@eel.expose
def get_email_categories():
    """현재 사용 중인 카테고리 목록 반환"""
    emails = _load_emails_from_disk()
    categories = set(DEFAULT_CATEGORIES)
    for em in emails:
        cat = em.get("category")
        if cat:
            categories.add(cat)
    return sorted(list(categories))


@eel.expose
def import_eml_files_dialog():
    """Tkinter 파일 다이얼로그를 통해 여러 EML 파일을 선택하여 아카이브에 추가"""
    root = tk.Tk()
    root.withdraw()
    root.attributes("-topmost", True)
    
    file_paths = filedialog.askopenfilenames(
        title="가져올 .eml 이메일 파일들을 선택하세요",
        filetypes=[("Email Messages", "*.eml *.msg"), ("All Files", "*.*")]
    )
    root.destroy()
    
    if not file_paths:
        return {"success": False, "message": "파일 선택이 취소되었습니다."}
        
    emails = _load_emails_from_disk()
    imported_count = 0
    total = len(file_paths)

    if total > 1:
        try:
            eel.on_eml_import_progress(0, total, "가져오기 준비 중...", 0)()
        except Exception:
            pass
    
    for idx, path in enumerate(file_paths, 1):
        filename = os.path.basename(path)
        try:
            with open(path, "rb") as f:
                raw_bytes = f.read()
                
            parsed = _parse_eml_bytes(raw_bytes, filename)
            email_id = f"eml_{uuid.uuid4().hex[:10]}"
            
            # 원본 EML 파일 복사본 저장
            dest_filename = f"{email_id}_{filename}"
            dest_path = os.path.join(EMAILS_DIR, dest_filename)
            with open(dest_path, "wb") as f_out:
                f_out.write(raw_bytes)
                
            item = {
                "id": email_id,
                "subject": parsed["subject"],
                "from": parsed["from"],
                "to": parsed["to"],
                "date": parsed["date"],
                "category": parsed["category"],
                "snippet": parsed["snippet"],
                "body_text": parsed["body_text"],
                "body_html": parsed["body_html"],
                "attachments": parsed["attachments"],
                "file_path": dest_path,
                "created_at": time.strftime("%Y-%m-%dT%H:%M:%S")
            }
            emails.insert(0, item)
            imported_count += 1
        except Exception as e:
            print(f"⚠️ EML 파싱 실패 ({path}): {e}")
            
        if total > 1:
            pct = int((idx / total) * 100)
            try:
                eel.on_eml_import_progress(idx, total, filename, pct)()
            except Exception:
                pass
            eel.sleep(0.002)
            
    if imported_count > 0:
        _save_emails_to_disk(emails)
        return {
            "success": True,
            "imported_count": imported_count,
            "emails": emails,
            "message": f"총 {imported_count}개의 EML 이메일을 성공적으로 불러왔습니다!"
        }
    else:
        return {"success": False, "message": "유효한 EML 파일을 가져오지 못했습니다."}


@eel.expose
def import_eml_folder_dialog():
    """폴더 내의 모든 .eml 파일을 재귀적으로 탐색하여 일괄 가져오기 (프로그레스 지원)"""
    root = tk.Tk()
    root.withdraw()
    root.attributes("-topmost", True)
    
    folder_path = filedialog.askdirectory(title="EML 파일들이 들어있는 폴더를 선택하세요")
    root.destroy()
    
    if not folder_path:
        return {"success": False, "message": "폴더 선택이 취소되었습니다."}
        
    eml_files = []
    for root_dir, _, files in os.walk(folder_path):
        for file in files:
            if file.lower().endswith((".eml", ".msg")):
                eml_files.append(os.path.join(root_dir, file))
                
    if not eml_files:
        return {"success": False, "message": "선택한 폴더에 .eml 파일이 존재하지 않습니다."}
        
    emails = _load_emails_from_disk()
    imported_count = 0
    total = len(eml_files)

    try:
        eel.on_eml_import_progress(0, total, f"총 {total}개 파일 검색 완료, 등록 시작...", 0)()
    except Exception:
        pass
    
    for idx, path in enumerate(eml_files, 1):
        filename = os.path.basename(path)
        try:
            with open(path, "rb") as f:
                raw_bytes = f.read()
            parsed = _parse_eml_bytes(raw_bytes, filename)
            email_id = f"eml_{uuid.uuid4().hex[:10]}"
            
            dest_filename = f"{email_id}_{filename}"
            dest_path = os.path.join(EMAILS_DIR, dest_filename)
            with open(dest_path, "wb") as f_out:
                f_out.write(raw_bytes)
                
            item = {
                "id": email_id,
                "subject": parsed["subject"],
                "from": parsed["from"],
                "to": parsed["to"],
                "date": parsed["date"],
                "category": parsed["category"],
                "snippet": parsed["snippet"],
                "body_text": parsed["body_text"],
                "body_html": parsed["body_html"],
                "attachments": parsed["attachments"],
                "file_path": dest_path,
                "created_at": time.strftime("%Y-%m-%dT%H:%M:%S")
            }
            emails.insert(0, item)
            imported_count += 1
        except Exception as e:
            print(f"⚠️ EML 파싱 실패 ({path}): {e}")
            
        pct = int((idx / total) * 100)
        try:
            eel.on_eml_import_progress(idx, total, filename, pct)()
        except Exception:
            pass
        eel.sleep(0.002)
            
    if imported_count > 0:
        _save_emails_to_disk(emails)
        return {
            "success": True,
            "imported_count": imported_count,
            "emails": emails,
            "message": f"총 {imported_count}개의 EML 이메일을 일괄 등록했습니다!"
        }
    else:
        return {"success": False, "message": "EML 파일을 불러오지 못했습니다."}


@eel.expose
def import_eml_raw_text(filename, raw_content, custom_category=None):
    """드래그 앤 드롭 또는 브라우저 파일 리더로 읽은 텍스트/바이트 직접 파싱"""
    try:
        if isinstance(raw_content, str):
            raw_bytes = raw_content.encode("utf-8", errors="replace")
        else:
            raw_bytes = bytes(raw_content)
            
        parsed = _parse_eml_bytes(raw_bytes, filename)
        email_id = f"eml_{uuid.uuid4().hex[:10]}"
        
        dest_filename = f"{email_id}_{filename or 'email.eml'}"
        dest_path = os.path.join(EMAILS_DIR, dest_filename)
        with open(dest_path, "wb") as f_out:
            f_out.write(raw_bytes)
            
        item = {
            "id": email_id,
            "subject": parsed["subject"],
            "from": parsed["from"],
            "to": parsed["to"],
            "date": parsed["date"],
            "category": custom_category or parsed["category"],
            "snippet": parsed["snippet"],
            "body_text": parsed["body_text"],
            "body_html": parsed["body_html"],
            "attachments": parsed["attachments"],
            "file_path": dest_path,
            "created_at": time.strftime("%Y-%m-%dT%H:%M:%S")
        }
        
        emails = _load_emails_from_disk()
        emails.insert(0, item)
        _save_emails_to_disk(emails)
        
        return {"success": True, "email": item, "emails": emails}
    except Exception as e:
        return {"success": False, "message": str(e)}


@eel.expose
def update_email_category(email_id, new_category):
    """이메일 카테고리 변경"""
    emails = _load_emails_from_disk()
    found = False
    for em in emails:
        if em.get("id") == email_id:
            em["category"] = new_category.strip() or "기타"
            found = True
            break
            
    if found:
        _save_emails_to_disk(emails)
        return {"success": True, "emails": emails}
    return {"success": False, "message": "해당 이메일을 찾을 수 없습니다."}


@eel.expose
def delete_email(email_id):
    """이메일 삭제 및 원본 EML 파일 제거"""
    emails = _load_emails_from_disk()
    target = None
    new_list = []
    for em in emails:
        if em.get("id") == email_id:
            target = em
        else:
            new_list.append(em)
            
    if target:
        file_path = target.get("file_path")
        if file_path and os.path.exists(file_path):
            try:
                os.remove(file_path)
            except Exception:
                pass
        _save_emails_to_disk(new_list)
        return {"success": True, "emails": new_list}
    return {"success": False, "message": "삭제할 이메일을 찾을 수 없습니다."}


@eel.expose
def clear_all_emails():
    """전체 이메일 목록 비우기"""
    _save_emails_to_disk([])
    return {"success": True, "emails": []}


@eel.expose
def open_eml_in_os(email_id):
    """원본 EML 파일을 Windows 기본 메일 클라이언트(Outlook 등)로 열기"""
    emails = _load_emails_from_disk()
    for em in emails:
        if em.get("id") == email_id:
            file_path = em.get("file_path")
            if file_path and os.path.exists(file_path):
                try:
                    os.startfile(file_path)
                    return {"success": True}
                except Exception as e:
                    return {"success": False, "message": f"실행 실패: {e}"}
            else:
                return {"success": False, "message": "원본 .eml 파일이 디스크에 존재하지 않습니다."}
    return {"success": False, "message": "해당 이메일을 찾을 수 없습니다."}

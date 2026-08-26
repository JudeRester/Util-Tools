import os
import json
import uuid
import time
import re
import email
from email import policy
from email.parser import BytesParser
import tkinter as tk
from tkinter import filedialog
import eel

from services.db_service import get_db_connection, clean_subject as db_clean_subject

base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EMAILS_DIR = os.path.join(base_dir, "emails")

# 기본 프리셋 카테고리 목록
DEFAULT_CATEGORIES = ["업무/프로젝트", "회의록", "견적/계약", "인사/총무", "시스템/알림", "기타"]


def _ensure_emails_dir():
    if not os.path.exists(EMAILS_DIR):
        os.makedirs(EMAILS_DIR, exist_ok=True)


def _clean_subject(subject):
    """이메일 제목에서 회신/전달/상태 접두사를 제거하고 정규화된 스레드 제목 반환"""
    return db_clean_subject(subject)


def _auto_classify_category(subject, body_text):
    """제목 및 본문 키워드 기반 카테고리 자동 추천"""
    text = (str(subject or "") + " " + str(body_text or "")).lower()
    
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
    clean_sub = _clean_subject(subject)
    from_addr = msg.get("from", "") or ""
    to_addr = msg.get("to", "") or ""
    date_str = msg.get("date", "") or ""
    message_id = msg.get("message-id", "") or msg.get("Message-ID", "") or ""
    in_reply_to = msg.get("in-reply-to", "") or msg.get("In-Reply-To", "") or ""
    references = msg.get("references", "") or msg.get("References", "") or ""
    
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
        body_text = re.sub(r"<[^>]+>", " ", body_html).strip()
        body_text = re.sub(r"\s+", " ", body_text)
        
    snippet = body_text[:160].replace("\n", " ").strip() if body_text else ""
    category = _auto_classify_category(subject, body_text)
    
    return {
        "subject": subject,
        "clean_subject": clean_sub,
        "message_id": str(message_id).strip(),
        "in_reply_to": str(in_reply_to).strip(),
        "references": str(references).strip(),
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
# Eel Exposed API 함수들 (SQLite 엔진 기반)
# ==========================================

@eel.expose
def get_emails_chunk(offset=0, limit=300):
    """
    이메일 목록 청크(Chunk) 분할 조회 API (IPC 패킷 과부하 및 웹소켓 프레임 버퍼 오버플로우 방지)
    - 300건씩 분할하여 100KB 미만의 초경량 패킷으로 전송
    """
    offset = max(0, int(offset))
    limit = max(1, min(int(limit), 1000))
    
    conn = get_db_connection()
    try:
        cursor = conn.cursor()
        total_count = cursor.execute("SELECT COUNT(*) FROM emails").fetchone()[0]
        
        cursor.execute("""
            SELECT 
                id, 
                subject, 
                clean_subject, 
                thread_key, 
                from_addr as 'from', 
                to_addr as 'to', 
                date_str as 'date', 
                category, 
                substr(snippet, 1, 80) as snippet, 
                attachments_json, 
                message_id, 
                in_reply_to, 
                references_header as 'references', 
                created_at 
            FROM emails 
            ORDER BY created_at DESC, date_str DESC
            LIMIT ? OFFSET ?
        """, (limit, offset))
        rows = cursor.fetchall()
        
        items = []
        for row in rows:
            em = dict(row)
            raw_att = em.pop("attachments_json", "[]") or "[]"
            try:
                att_list = json.loads(raw_att) if isinstance(raw_att, str) else raw_att
                if isinstance(att_list, list):
                    em["attachments"] = [{"filename": a.get("filename", "첨부파일"), "size": a.get("size", ""), "type": a.get("type", "")} for a in att_list]
                else:
                    em["attachments"] = []
            except Exception:
                em["attachments"] = []
            
            em["attachment_count"] = len(em["attachments"])
            if not em.get("clean_subject"):
                em["clean_subject"] = _clean_subject(em.get("subject", ""))
            if not em.get("thread_key"):
                em["thread_key"] = em["clean_subject"].lower()
            items.append(em)
            
        return {
            "status": "success",
            "total_count": total_count,
            "offset": offset,
            "limit": limit,
            "items": items
        }
    finally:
        conn.close()


@eel.expose
def get_all_emails_summary():
    """이메일 목록 렌더링용 가벼운 메타데이터 요약본 반환 (SQLite 고속 인덱스 조회)"""
    conn = get_db_connection()
    try:
        cursor = conn.cursor()
        cursor.execute("""
            SELECT 
                id, 
                subject, 
                clean_subject, 
                thread_key, 
                from_addr as 'from', 
                to_addr as 'to', 
                date_str as 'date', 
                category, 
                substr(snippet, 1, 80) as snippet, 
                attachments_json, 
                message_id, 
                in_reply_to, 
                references_header as 'references', 
                created_at 
            FROM emails 
            ORDER BY created_at DESC, date_str DESC
        """)
        rows = cursor.fetchall()
        summaries = []
        for row in rows:
            em = dict(row)
            raw_att = em.pop("attachments_json", "[]") or "[]"
            try:
                att_list = json.loads(raw_att) if isinstance(raw_att, str) else raw_att
                if isinstance(att_list, list):
                    em["attachments"] = [{"filename": a.get("filename", "첨부파일"), "size": a.get("size", ""), "type": a.get("type", "")} for a in att_list]
                else:
                    em["attachments"] = []
            except Exception:
                em["attachments"] = []
            
            em["attachment_count"] = len(em["attachments"])
            if not em.get("clean_subject"):
                em["clean_subject"] = _clean_subject(em.get("subject", ""))
            if not em.get("thread_key"):
                em["thread_key"] = em["clean_subject"].lower()
            summaries.append(em)
        return summaries
    finally:
        conn.close()


@eel.expose
def get_email_detail(email_id):
    """선택된 특정 이메일 1건의 전체 본문(HTML/텍스트) 반환 (Lazy Loading)"""
    if not email_id:
        return {"success": False, "message": "이메일 ID가 지정되지 않았습니다."}
    conn = get_db_connection()
    try:
        cursor = conn.cursor()
        cursor.execute("""
            SELECT 
                id, 
                subject, 
                clean_subject, 
                thread_key, 
                from_addr as 'from', 
                to_addr as 'to', 
                date_str as 'date', 
                category, 
                snippet, 
                body_text, 
                body_html, 
                attachments_json as attachments, 
                message_id, 
                in_reply_to, 
                references_header as 'references', 
                file_path, 
                created_at 
            FROM emails 
            WHERE id = ?
        """, (email_id,))
        row = cursor.fetchone()
        if row:
            em = dict(row)
            raw_att = em.get("attachments")
            if isinstance(raw_att, str):
                try:
                    em["attachments"] = json.loads(raw_att) if raw_att else []
                except Exception:
                    em["attachments"] = []
            elif raw_att is None:
                em["attachments"] = []
            if not em.get("clean_subject"):
                em["clean_subject"] = _clean_subject(em.get("subject", ""))
            if not em.get("thread_key"):
                em["thread_key"] = em["clean_subject"].lower()
            return {"success": True, "email": em}
        return {"success": False, "message": "해당 이메일을 찾을 수 없습니다."}
    finally:
        conn.close()


def _get_eml_file_path(email_id):
    """email_id에 해당하는 실제 .eml 물리 파일 경로 검색 (상대/절대/파일명 정규화 지원)"""
    if not email_id:
        return None
    
    conn = get_db_connection()
    try:
        row = conn.execute("SELECT file_path FROM emails WHERE id = ?", (email_id,)).fetchone()
        if row and row['file_path']:
            fp = row['file_path']
            if os.path.exists(fp):
                return fp
            rel_path = os.path.join(base_dir, fp)
            if os.path.exists(rel_path):
                return rel_path
            emails_fp = os.path.join(EMAILS_DIR, os.path.basename(fp))
            if os.path.exists(emails_fp):
                return emails_fp
    finally:
        conn.close()
    
    # DB에 저장된 경로가 유효하지 않은 경우 emails 디렉토리에서 glob 검색
    import glob
    escaped_id = glob.escape(str(email_id))
    candidates = glob.glob(os.path.join(EMAILS_DIR, f"*{escaped_id}*.eml"))
    if candidates and os.path.exists(candidates[0]):
        return candidates[0]
        
    direct_path = os.path.join(EMAILS_DIR, f"{email_id}.eml")
    if os.path.exists(direct_path):
        return direct_path
        
    return None


def _extract_attachments_from_eml(file_path):
    """EML 파일로부터 첨부파일 바이너리 데이터 및 메타데이터 추출"""
    if not file_path or not os.path.exists(file_path):
        return []
        
    try:
        with open(file_path, "rb") as f:
            raw_bytes = f.read()
        msg = BytesParser(policy=policy.default).parsebytes(raw_bytes)
        attachments = []
        
        if msg.is_multipart():
            for part in msg.walk():
                content_disposition = str(part.get("Content-Disposition") or "")
                filename = part.get_filename()
                
                if "attachment" in content_disposition or filename:
                    if not filename:
                        filename = f"attachment_{len(attachments) + 1}"
                    
                    # 파일명에 유효하지 않은 문자 정제
                    clean_fn = re.sub(r'[\\/*?:"<>|]', '_', filename).strip()
                    if not clean_fn:
                        clean_fn = f"attachment_{len(attachments) + 1}"
                        
                    payload = part.get_payload(decode=True)
                    if payload is not None:
                        size_bytes = len(payload)
                        if size_bytes > 1024 * 1024:
                            size_str = f"{size_bytes / (1024 * 1024):.1f} MB"
                        elif size_bytes > 1024:
                            size_str = f"{size_bytes / 1024:.1f} KB"
                        else:
                            size_str = f"{size_bytes} B"
                            
                        attachments.append({
                            "index": len(attachments),
                            "filename": clean_fn,
                            "size": size_str,
                            "size_bytes": size_bytes,
                            "payload": payload,
                            "content_type": part.get_content_type()
                        })
        return attachments
    except Exception as e:
        print(f"[EmailService] 첨부파일 파싱 오류: {e}")
        return []


def _extract_attachments_for_email(email_id):
    """이메일 ID에 대한 첨부파일 목록 추출 (물리 EML 파싱 및 샘플 데이터 가상 생성 지원)"""
    file_path = _get_eml_file_path(email_id)
    if file_path and os.path.exists(file_path):
        atts = _extract_attachments_from_eml(file_path)
        if atts:
            return atts
            
    # 물리 파일이 없거나 파싱 실패 시, DB의 attachments_json 메타데이터 기반 가상 첨부 생성 (샘플 데이터 호환)
    conn = get_db_connection()
    try:
        row = conn.execute("SELECT subject, attachments_json FROM emails WHERE id = ?", (email_id,)).fetchone()
        if row and row['attachments_json']:
            raw_att = row['attachments_json']
            meta_list = json.loads(raw_att) if isinstance(raw_att, str) else raw_att
            if isinstance(meta_list, list) and len(meta_list) > 0:
                virtual_atts = []
                for idx, m in enumerate(meta_list):
                    fn = m.get('filename') or f'attachment_{idx + 1}.txt'
                    dummy_text = (
                        f"[샘플 데이터 안내]\n"
                        f"이메일 제목: {row['subject']}\n"
                        f"첨부파일명: {fn}\n\n"
                        f"※ 본 데이터는 프로그램 초기 제공 샘플 데이터입니다.\n"
                        f"실제 .eml 파일을 등록(드래그&드롭)하시면 원본 파일이 정상 추출 및 다운로드됩니다.\n"
                    )
                    payload = dummy_text.encode('utf-8')
                    virtual_atts.append({
                        "index": idx,
                        "filename": fn,
                        "size": m.get('size', f"{len(payload)} B"),
                        "size_bytes": len(payload),
                        "payload": payload,
                        "content_type": "application/octet-stream"
                    })
                return virtual_atts
    except Exception as e:
        print(f"[EmailService] 가상 첨부파일 생성 오류: {e}")
    finally:
        conn.close()
        
    return []


@eel.expose
def open_email_attachment(email_id, attachment_index=0, filename=None):
    """선택된 첨부파일을 임시 폴더에 추출한 후 Windows 기본 연결 프로그램으로 즉시 실행"""
    try:
        attachments = _extract_attachments_for_email(email_id)
        if not attachments:
            return {"status": "error", "message": "해당 메일에 첨부파일이 없거나 추출에 실패했습니다."}
            
        # 파일명 또는 인덱스로 타깃 첨부파일 매칭
        target_att = None
        if filename:
            for att in attachments:
                if att["filename"] == filename:
                    target_att = att
                    break
        if not target_att:
            idx = max(0, min(int(attachment_index), len(attachments) - 1))
            target_att = attachments[idx]
            
        # 임시 폴더에 파일 쓰기
        temp_dir = os.path.join(base_dir, "data", "temp_attachments", str(email_id))
        os.makedirs(temp_dir, exist_ok=True)
        
        dest_path = os.path.join(temp_dir, target_att["filename"])
        with open(dest_path, "wb") as f:
            f.write(target_att["payload"])
            
        # OS 기본 앱으로 파일 실행
        os.startfile(dest_path)
        return {
            "status": "success",
            "message": f"'{target_att['filename']}' 파일을 열었습니다.",
            "path": dest_path
        }
    except Exception as e:
        return {"status": "error", "message": f"첨부파일 열기 실패: {str(e)}"}


@eel.expose
def save_email_attachment_dialog(email_id, attachment_index=0, filename=None):
    """첨부파일 1건 다른 이름으로 저장 (Tkinter 파일 저장 대화상자)"""
    try:
        attachments = _extract_attachments_for_email(email_id)
        if not attachments:
            return {"status": "error", "message": "해당 메일에 첨부파일이 없습니다."}
            
        target_att = None
        if filename:
            for att in attachments:
                if att["filename"] == filename:
                    target_att = att
                    break
        if not target_att:
            idx = max(0, min(int(attachment_index), len(attachments) - 1))
            target_att = attachments[idx]
            
        initial_name = target_att["filename"]
        ext = os.path.splitext(initial_name)[1]
        
        root = tk.Tk()
        root.withdraw()
        root.attributes('-topmost', True)
        save_path = filedialog.asksaveasfilename(
            title="첨부파일 저장",
            initialfile=initial_name,
            defaultextension=ext,
            filetypes=[("기본 확장자", f"*{ext}"), ("모든 파일", "*.*")] if ext else [("모든 파일", "*.*")]
        )
        root.destroy()
        
        if not save_path:
            return {"status": "cancelled", "message": "저장이 취소되었습니다."}
            
        save_path = os.path.normpath(save_path)
        with open(save_path, "wb") as f:
            f.write(target_att["payload"])
            
        return {
            "status": "success",
            "message": f"'{initial_name}' 파일이 저장되었습니다.",
            "path": save_path
        }
    except Exception as e:
        return {"status": "error", "message": f"첨부파일 저장 실패: {str(e)}"}


@eel.expose
def save_all_email_attachments_dialog(email_id):
    """메일에 포함된 모든 첨부파일을 지정한 폴더에 일괄 저장"""
    try:
        attachments = _extract_attachments_for_email(email_id)
        if not attachments:
            return {"status": "error", "message": "해당 메일에 첨부파일이 없습니다."}
            
        root = tk.Tk()
        root.withdraw()
        root.attributes('-topmost', True)
        dest_dir = filedialog.askdirectory(title="첨부파일들을 일괄 저장할 대상 폴더 선택")
        root.destroy()
        
        if not dest_dir:
            return {"status": "cancelled", "message": "저장이 취소되었습니다."}
            
        dest_dir = os.path.normpath(dest_dir)
        saved_files = []
        
        for att in attachments:
            base_name, ext = os.path.splitext(att["filename"])
            target_path = os.path.join(dest_dir, att["filename"])
            counter = 1
            while os.path.exists(target_path):
                target_path = os.path.join(dest_dir, f"{base_name} ({counter}){ext}")
                counter += 1
                
            with open(target_path, "wb") as f:
                f.write(att["payload"])
            saved_files.append(os.path.basename(target_path))
            
        return {
            "status": "success",
            "count": len(saved_files),
            "folder": dest_dir,
            "saved_files": saved_files,
            "message": f"총 {len(saved_files)}개의 첨부파일이 '{dest_dir}'에 성공적으로 저장되었습니다."
        }
    except Exception as e:
        return {"status": "error", "message": f"일괄 저장 실패: {str(e)}"}


@eel.expose
def open_email_source_file(email_id):
    """원본 .eml 파일을 시스템 기본 이메일 프로그램(Outlook 등)으로 열기"""
    try:
        file_path = _get_eml_file_path(email_id)
        if not file_path or not os.path.exists(file_path):
            return {"status": "error", "message": "해당 이메일의 원본 .eml 파일을 찾을 수 없습니다."}
            
        os.startfile(file_path)
        return {"status": "success", "message": f"EML 원본 파일을 열었습니다: {os.path.basename(file_path)}"}
    except Exception as e:
        return {"status": "error", "message": f"EML 파일 열기 실패: {str(e)}"}


@eel.expose
def get_all_emails():
    """저장된 전체 이메일 목록 반환 (하위 호환)"""
    conn = get_db_connection()
    try:
        cursor = conn.cursor()
        cursor.execute("""
            SELECT 
                id, 
                subject, 
                clean_subject, 
                thread_key, 
                from_addr as 'from', 
                to_addr as 'to', 
                date_str as 'date', 
                category, 
                substr(snippet, 1, 100) as snippet, 
                attachments_json as attachments, 
                message_id, 
                in_reply_to, 
                references_header as 'references', 
                created_at 
            FROM emails 
            ORDER BY created_at DESC, date_str DESC
        """)
        rows = cursor.fetchall()
        emails = []
        for row in rows:
            em = dict(row)
            raw_att = em.get("attachments")
            if isinstance(raw_att, str):
                try:
                    em["attachments"] = json.loads(raw_att) if raw_att else []
                except Exception:
                    em["attachments"] = []
            elif raw_att is None:
                em["attachments"] = []
            if not em.get("clean_subject"):
                em["clean_subject"] = _clean_subject(em.get("subject", ""))
            if not em.get("thread_key"):
                em["thread_key"] = em["clean_subject"].lower()
            emails.append(em)
        return emails
    finally:
        conn.close()


@eel.expose
def get_email_categories():
    """현재 사용 중인 카테고리 목록 반환"""
    categories = set(DEFAULT_CATEGORIES)
    conn = get_db_connection()
    try:
        cursor = conn.cursor()
        cursor.execute("SELECT DISTINCT category FROM emails WHERE category IS NOT NULL AND category != ''")
        for row in cursor.fetchall():
            cat = row[0]
            if cat:
                categories.add(cat)
        return sorted(list(categories))
    finally:
        conn.close()


@eel.expose
def import_eml_files_dialog():
    """Tkinter 파일 다이얼로그를 통해 여러 EML 파일을 선택하여 SQLite DB에 추가"""
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
        
    _ensure_emails_dir()
    imported_count = 0
    total = len(file_paths)
    records = []

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
                
            clean_sub = parsed.get("clean_subject") or _clean_subject(parsed["subject"])
            thread_key = clean_sub.lower()
            att_json = json.dumps(parsed.get("attachments", []), ensure_ascii=False)
            created_at = time.strftime("%Y-%m-%dT%H:%M:%S")

            records.append((
                email_id,
                parsed["subject"],
                clean_sub,
                thread_key,
                parsed["from"],
                parsed["to"],
                parsed["date"],
                parsed["category"],
                parsed["snippet"],
                parsed["body_text"],
                parsed["body_html"],
                att_json,
                parsed.get("message_id", ""),
                parsed.get("in_reply_to", ""),
                parsed.get("references", ""),
                dest_path,
                created_at
            ))
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
            
    if records:
        conn = get_db_connection()
        try:
            with conn:
                conn.executemany("""
                    INSERT OR REPLACE INTO emails (
                        id, subject, clean_subject, thread_key,
                        from_addr, to_addr, date_str, category,
                        snippet, body_text, body_html, attachments_json,
                        message_id, in_reply_to, references_header,
                        file_path, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, records)
        finally:
            conn.close()

    if imported_count > 0:
        return {
            "success": True,
            "imported_count": imported_count,
            "message": f"총 {imported_count}개의 EML 이메일을 성공적으로 불러왔습니다!"
        }
    else:
        return {"success": False, "message": "유효한 EML 파일을 가져오지 못했습니다."}


@eel.expose
def import_eml_folder_dialog():
    """폴더 내의 모든 .eml 파일을 재귀적으로 탐색하여 일괄 SQLite DB에 등록 (프로그레스 지원)"""
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
        
    _ensure_emails_dir()
    imported_count = 0
    total = len(eml_files)
    records = []

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
                
            clean_sub = parsed.get("clean_subject") or _clean_subject(parsed["subject"])
            thread_key = clean_sub.lower()
            att_json = json.dumps(parsed.get("attachments", []), ensure_ascii=False)
            created_at = time.strftime("%Y-%m-%dT%H:%M:%S")

            records.append((
                email_id,
                parsed["subject"],
                clean_sub,
                thread_key,
                parsed["from"],
                parsed["to"],
                parsed["date"],
                parsed["category"],
                parsed["snippet"],
                parsed["body_text"],
                parsed["body_html"],
                att_json,
                parsed.get("message_id", ""),
                parsed.get("in_reply_to", ""),
                parsed.get("references", ""),
                dest_path,
                created_at
            ))
            imported_count += 1
        except Exception as e:
            print(f"⚠️ EML 파싱 실패 ({path}): {e}")
            
        pct = int((idx / total) * 100)
        try:
            eel.on_eml_import_progress(idx, total, filename, pct)()
        except Exception:
            pass
        eel.sleep(0.002)
            
    if records:
        conn = get_db_connection()
        try:
            with conn:
                conn.executemany("""
                    INSERT OR REPLACE INTO emails (
                        id, subject, clean_subject, thread_key,
                        from_addr, to_addr, date_str, category,
                        snippet, body_text, body_html, attachments_json,
                        message_id, in_reply_to, references_header,
                        file_path, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, records)
        finally:
            conn.close()

    if imported_count > 0:
        return {
            "success": True,
            "imported_count": imported_count,
            "message": f"총 {imported_count}개의 EML 이메일을 일괄 등록했습니다!"
        }
    else:
        return {"success": False, "message": "EML 파일을 불러오지 못했습니다."}


@eel.expose
def import_eml_raw_text(filename, raw_content, custom_category=None):
    """드래그 앤 드롭 또는 브라우저 파일 리더로 읽은 텍스트/바이트 직접 파싱 및 SQLite 저장"""
    try:
        if isinstance(raw_content, str):
            raw_bytes = raw_content.encode("utf-8", errors="replace")
        else:
            raw_bytes = bytes(raw_content)
            
        parsed = _parse_eml_bytes(raw_bytes, filename)
        email_id = f"eml_{uuid.uuid4().hex[:10]}"
        
        _ensure_emails_dir()
        dest_filename = f"{email_id}_{filename or 'email.eml'}"
        dest_path = os.path.join(EMAILS_DIR, dest_filename)
        with open(dest_path, "wb") as f_out:
            f_out.write(raw_bytes)
            
        clean_sub = parsed.get("clean_subject") or _clean_subject(parsed["subject"])
        thread_key = clean_sub.lower()
        category = custom_category or parsed["category"]
        att_json = json.dumps(parsed.get("attachments", []), ensure_ascii=False)
        created_at = time.strftime("%Y-%m-%dT%H:%M:%S")

        conn = get_db_connection()
        try:
            with conn:
                conn.execute("""
                    INSERT OR REPLACE INTO emails (
                        id, subject, clean_subject, thread_key,
                        from_addr, to_addr, date_str, category,
                        snippet, body_text, body_html, attachments_json,
                        message_id, in_reply_to, references_header,
                        file_path, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, (
                    email_id,
                    parsed["subject"],
                    clean_sub,
                    thread_key,
                    parsed["from"],
                    parsed["to"],
                    parsed["date"],
                    category,
                    parsed["snippet"],
                    parsed["body_text"],
                    parsed["body_html"],
                    att_json,
                    parsed.get("message_id", ""),
                    parsed.get("in_reply_to", ""),
                    parsed.get("references", ""),
                    dest_path,
                    created_at
                ))
        finally:
            conn.close()

        item = {
            "id": email_id,
            "subject": parsed["subject"],
            "clean_subject": clean_sub,
            "thread_key": thread_key,
            "message_id": parsed.get("message_id", ""),
            "in_reply_to": parsed.get("in_reply_to", ""),
            "references": parsed.get("references", ""),
            "from": parsed["from"],
            "to": parsed["to"],
            "date": parsed["date"],
            "category": category,
            "snippet": parsed["snippet"],
            "body_text": parsed["body_text"],
            "body_html": parsed["body_html"],
            "attachments": parsed["attachments"],
            "file_path": dest_path,
            "created_at": created_at
        }
        
        return {"success": True, "email": item}
    except Exception as e:
        return {"success": False, "message": str(e)}


@eel.expose
def update_email_category(email_id, new_category):
    """이메일 카테고리 변경"""
    cat = (new_category or "기타").strip() or "기타"
    conn = get_db_connection()
    try:
        with conn:
            cursor = conn.cursor()
            cursor.execute("UPDATE emails SET category = ? WHERE id = ?", (cat, email_id))
            if cursor.rowcount > 0:
                return {"success": True}
        return {"success": False, "message": "해당 이메일을 찾을 수 없습니다."}
    except Exception as e:
        return {"success": False, "message": str(e)}
    finally:
        conn.close()


@eel.expose
def delete_email(email_id):
    """이메일 삭제 및 원본 EML 파일 제거"""
    conn = get_db_connection()
    try:
        cursor = conn.cursor()
        cursor.execute("SELECT file_path FROM emails WHERE id = ?", (email_id,))
        row = cursor.fetchone()
        if not row:
            return {"success": False, "message": "삭제할 이메일을 찾을 수 없습니다."}
        
        file_path = row["file_path"]
        if file_path and os.path.exists(file_path):
            try:
                os.remove(file_path)
            except Exception:
                pass
        
        with conn:
            conn.execute("DELETE FROM emails WHERE id = ?", (email_id,))
        return {"success": True}
    except Exception as e:
        return {"success": False, "message": str(e)}
    finally:
        conn.close()


@eel.expose
def clear_all_emails():
    """전체 이메일 목록 비우기 및 디스크 파일 정리"""
    conn = get_db_connection()
    try:
        with conn:
            conn.execute("DELETE FROM emails")
            
        if os.path.exists(EMAILS_DIR):
            for fname in os.listdir(EMAILS_DIR):
                fpath = os.path.join(EMAILS_DIR, fname)
                if os.path.isfile(fpath):
                    try:
                        os.remove(fpath)
                    except Exception:
                        pass
        return {"success": True, "emails": []}
    except Exception as e:
        return {"success": False, "message": str(e)}
    finally:
        conn.close()


@eel.expose
def open_eml_in_os(email_id):
    """원본 EML 파일을 Windows 기본 메일 클라이언트(Outlook 등)로 열기"""
    if not email_id:
        return {"success": False, "message": "이메일 ID가 유효하지 않습니다."}
    try:
        file_path = _get_eml_file_path(email_id)
        if file_path and os.path.exists(file_path):
            os.startfile(file_path)
            return {"success": True, "message": f"EML 원본 파일 열기 성공: {os.path.basename(file_path)}"}
        return {"success": False, "message": "원본 .eml 파일이 디스크에 존재하지 않습니다."}
    except Exception as e:
        return {"success": False, "message": f"실행 실패: {e}"}

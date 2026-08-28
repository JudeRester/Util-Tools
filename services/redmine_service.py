"""
Redmine REST API 연동 서비스 모듈
- 일감(Issues) 조회, 생성, 상태/진척도 변경, 댓글(Notes) 작성
- 프로젝트 위키(Wiki) 조회, 마크다운 렌더링, 편집 및 발행
- 프로젝트/상태/트래커/우선순위 메타데이터 동기화
- SQLite 오프라인 로컬 캐싱 및 백그라운드 변경 감지
"""

import os
import json
import sqlite3
import urllib.request
import urllib.parse
import urllib.error
import ssl
from datetime import datetime
import eel
from services.db_service import get_db_connection


# SSL 컨텍스트 (사내 사설 인증서/자체 서명 HTTPS 대응)
_SSL_CONTEXT = ssl.create_default_context()
_SSL_CONTEXT.check_hostname = False
_SSL_CONTEXT.verify_mode = ssl.CERT_NONE


def _normalize_url(url: str) -> str:
    """서버 URL 정규화 (끝부분 슬래시 제거)"""
    if not url:
        return ""
    u = str(url).strip()
    return u[:-1] if u.endswith('/') else u


def _request_redmine_api(server_url: str, api_key: str, endpoint: str, method: str = 'GET', data: dict = None, timeout: int = 10):
    """
    Redmine REST API 공통 HTTP 요청 함수
    """
    base = _normalize_url(server_url)
    if not base or not api_key:
        return {"status": "error", "message": "Redmine 서버 URL 및 API 키가 설정되지 않았습니다."}

    full_url = f"{base}/{endpoint.lstrip('/')}"
    headers = {
        "X-Redmine-API-Key": str(api_key).strip(),
        "Content-Type": "application/json; charset=utf-8",
        "User-Agent": "UtilTools-Redmine/1.0"
    }

    req_body = None
    if data is not None and method in ['POST', 'PUT']:
        req_body = json.dumps(data, ensure_ascii=False).encode('utf-8')

    req = urllib.request.Request(full_url, data=req_body, headers=headers, method=method)

    try:
        with urllib.request.urlopen(req, timeout=timeout, context=_SSL_CONTEXT) as response:
            status_code = response.getcode()
            resp_bytes = response.read()
            if not resp_bytes:
                return {"status": "success", "code": status_code, "data": {}}
            try:
                resp_json = json.loads(resp_bytes.decode('utf-8', errors='replace'))
                return {"status": "success", "code": status_code, "data": resp_json}
            except Exception:
                return {"status": "success", "code": status_code, "raw": resp_bytes.decode('utf-8', errors='replace')}
    except urllib.error.HTTPError as e:
        err_msg = f"HTTP {e.code} {e.reason}"
        try:
            err_body = e.read().decode('utf-8', errors='replace')
            err_json = json.loads(err_body)
            if 'errors' in err_json:
                if isinstance(err_json['errors'], list):
                    err_msg = ", ".join(err_json['errors'])
                elif isinstance(err_json['errors'], dict):
                    err_msg = json.dumps(err_json['errors'], ensure_ascii=False)
        except Exception:
            pass
        return {"status": "error", "code": e.code, "message": f"Redmine 서버 오류 ({err_msg})"}
    except urllib.error.URLError as e:
        return {"status": "error", "message": f"Redmine 서버에 연결할 수 없습니다 ({e.reason})"}
    except Exception as e:
        return {"status": "error", "message": f"요청 실패: {str(e)}"}


# ==========================================
# 1. 설정 및 연결 테스트
# ==========================================

@eel.expose
def get_redmine_config():
    """저장된 Redmine 연결 설정 조회"""
    conn = get_db_connection()
    try:
        row = conn.execute("SELECT * FROM redmine_config WHERE id = 'default'").fetchone()
        if not row:
            return {
                "status": "success",
                "configured": False,
                "config": {
                    "server_url": "",
                    "api_key": "",
                    "user_id": None,
                    "user_name": "",
                    "user_login": "",
                    "auto_sync": 1,
                    "sync_interval_min": 5
                }
            }
        cfg = dict(row)
        masked_key = cfg.get('api_key', '')
        if len(masked_key) > 8:
            masked_key = masked_key[:4] + '*' * (len(masked_key) - 8) + masked_key[-4:]
        cfg['masked_api_key'] = masked_key
        return {
            "status": "success",
            "configured": bool(cfg.get('server_url') and cfg.get('api_key')),
            "config": cfg
        }
    except Exception as e:
        return {"status": "error", "message": str(e)}
    finally:
        conn.close()


@eel.expose
def test_redmine_connection(server_url: str, api_key: str):
    """Redmine 서버 연결 및 API Key 유효성 검증 (/users/current.json)"""
    res = _request_redmine_api(server_url, api_key, "users/current.json", timeout=8)
    if res.get("status") == "success":
        user_info = res.get("data", {}).get("user", {})
        return {
            "status": "success",
            "message": f"연결 성공! ({user_info.get('firstname', '')} {user_info.get('lastname', '')} 님)",
            "user": {
                "id": user_info.get("id"),
                "login": user_info.get("login"),
                "name": f"{user_info.get('firstname', '')} {user_info.get('lastname', '')}".strip() or user_info.get("login"),
                "mail": user_info.get("mail"),
                "admin": user_info.get("admin", False)
            }
        }
    return res


@eel.expose
def save_redmine_config(server_url: str, api_key: str, auto_sync: bool = True, sync_interval_min: int = 5):
    """Redmine 설정 저장 및 초기 동기화"""
    server_url = _normalize_url(server_url)
    api_key = str(api_key).strip()

    # 연결 테스트로 사용자 정보 획득
    test_res = test_redmine_connection(server_url, api_key)
    if test_res.get("status") != "success":
        return {"status": "error", "message": f"설정 저장 실패: {test_res.get('message')}"}

    user = test_res.get("user", {})
    now_str = datetime.now().isoformat()

    conn = get_db_connection()
    try:
        conn.execute("""
            INSERT OR REPLACE INTO redmine_config 
            (id, server_url, api_key, user_id, user_name, user_login, auto_sync, sync_interval_min, updated_at)
            VALUES ('default', ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            server_url,
            api_key,
            user.get("id"),
            user.get("name"),
            user.get("login"),
            1 if auto_sync else 0,
            sync_interval_min,
            now_str
        ))
        conn.commit()

        # 백그라운드 전체 메타데이터 및 내 일감 동기화 트리거
        sync_res = sync_redmine_all(force=True)

        return {
            "status": "success",
            "message": "Redmine 설정이 저장되었으며 동기화가 완료되었습니다.",
            "user": user,
            "sync": sync_res
        }
    except Exception as e:
        return {"status": "error", "message": f"DB 저장 실패: {str(e)}"}
    finally:
        conn.close()


# ==========================================
# 2. 프로젝트 & 메타데이터 동기화
# ==========================================

@eel.expose
def fetch_redmine_metadata():
    """트래커, 일감 상태, 우선순위 등 메타데이터 서버 동기화"""
    conn = get_db_connection()
    try:
        row = conn.execute("SELECT server_url, api_key FROM redmine_config WHERE id = 'default'").fetchone()
        if not row or not row['server_url'] or not row['api_key']:
            return {"status": "error", "message": "Redmine 설정이 필요합니다."}

        server_url, api_key = row['server_url'], row['api_key']

        # 1. Trackers
        t_res = _request_redmine_api(server_url, api_key, "trackers.json")
        trackers = t_res.get("data", {}).get("trackers", []) if t_res.get("status") == "success" else []

        # 2. Issue Statuses
        s_res = _request_redmine_api(server_url, api_key, "issue_statuses.json")
        statuses = s_res.get("data", {}).get("issue_statuses", []) if s_res.get("status") == "success" else []

        # 3. Priorities
        p_res = _request_redmine_api(server_url, api_key, "enumerations/issue_priorities.json")
        priorities = p_res.get("data", {}).get("issue_priorities", []) if p_res.get("status") == "success" else []

        meta_data = {
            "trackers": trackers,
            "statuses": statuses,
            "priorities": priorities,
            "updated_at": datetime.now().isoformat()
        }

        conn.execute("""
            INSERT OR REPLACE INTO redmine_meta (key, data_json, updated_at)
            VALUES ('metadata', ?, ?)
        """, (json.dumps(meta_data, ensure_ascii=False), datetime.now().isoformat()))
        conn.commit()

        return {"status": "success", "metadata": meta_data}
    except Exception as e:
        return {"status": "error", "message": str(e)}
    finally:
        conn.close()


@eel.expose
def get_redmine_metadata():
    """캐시된 메타데이터 조회 (트래커, 상태, 우선순위)"""
    conn = get_db_connection()
    try:
        row = conn.execute("SELECT data_json FROM redmine_meta WHERE key = 'metadata'").fetchone()
        if row and row['data_json']:
            return {"status": "success", "metadata": json.loads(row['data_json'])}
        return fetch_redmine_metadata()
    except Exception as e:
        return {"status": "error", "message": str(e)}
    finally:
        conn.close()


@eel.expose
def fetch_redmine_projects():
    """참여 중인 전체 프로젝트 목록 서버 동기화"""
    conn = get_db_connection()
    try:
        row = conn.execute("SELECT server_url, api_key FROM redmine_config WHERE id = 'default'").fetchone()
        if not row or not row['server_url'] or not row['api_key']:
            return {"status": "error", "message": "Redmine 설정이 필요합니다."}

        res = _request_redmine_api(row['server_url'], row['api_key'], "projects.json?limit=100")
        if res.get("status") != "success":
            return res

        projects = res.get("data", {}).get("projects", [])

        conn.execute("DELETE FROM redmine_projects")
        for p in projects:
            conn.execute("""
                INSERT OR REPLACE INTO redmine_projects (id, name, identifier, description, status)
                VALUES (?, ?, ?, ?, ?)
            """, (p.get('id'), p.get('name'), p.get('identifier'), p.get('description', ''), p.get('status', 1)))
        conn.commit()

        return {"status": "success", "count": len(projects), "projects": projects}
    except Exception as e:
        return {"status": "error", "message": str(e)}
    finally:
        conn.close()


@eel.expose
def get_redmine_projects():
    """캐시된 프로젝트 목록 조회"""
    conn = get_db_connection()
    try:
        rows = conn.execute("SELECT * FROM redmine_projects ORDER BY name ASC").fetchall()
        projects = [dict(r) for r in rows]
        if not projects:
            res = fetch_redmine_projects()
            if res.get("status") == "success":
                return res
        return {"status": "success", "projects": projects}
    except Exception as e:
        return {"status": "error", "message": str(e)}
    finally:
        conn.close()


# ==========================================
# 3. 일감 (Issues) CRUD & 캐시
# ==========================================

@eel.expose
def sync_redmine_issues(project_id: int = None, limit: int = 100):
    """
    서버로부터 일감 목록 동기화 (내게 할당된 일감 + 프로젝트 전체 일감)
    """
    conn = get_db_connection()
    try:
        cfg = conn.execute("SELECT server_url, api_key, user_id FROM redmine_config WHERE id = 'default'").fetchone()
        if not cfg or not cfg['server_url'] or not cfg['api_key']:
            return {"status": "error", "message": "Redmine 설정이 필요합니다."}

        server_url, api_key, my_user_id = cfg['server_url'], cfg['api_key'], cfg['user_id']

        # 1. 내게 할당된 일감 (열린 일감)
        my_endpoint = "issues.json?assigned_to_id=me&status_id=open&limit=100&sort=updated_on:desc"
        res_my = _request_redmine_api(server_url, api_key, my_endpoint)
        my_issues = res_my.get("data", {}).get("issues", []) if res_my.get("status") == "success" else []

        # 2. 추가 프로젝트별 일감 (선택된 경우)
        all_fetched = list(my_issues)
        if project_id:
            proj_endpoint = f"issues.json?project_id={project_id}&status_id=open&limit={limit}&sort=updated_on:desc"
            res_proj = _request_redmine_api(server_url, api_key, proj_endpoint)
            if res_proj.get("status") == "success":
                proj_issues = res_proj.get("data", {}).get("issues", [])
                existing_ids = {iss['id'] for iss in all_fetched}
                for iss in proj_issues:
                    if iss['id'] not in existing_ids:
                        all_fetched.append(iss)

        # SQLite에 일괄 갱신
        for iss in all_fetched:
            p = iss.get('project', {})
            t = iss.get('tracker', {})
            s = iss.get('status', {})
            pr = iss.get('priority', {})
            a = iss.get('author', {})
            asg = iss.get('assigned_to', {})

            is_my = 1 if (asg.get('id') == my_user_id or my_user_id is None) else 0

            conn.execute("""
                INSERT OR REPLACE INTO redmine_issues 
                (id, project_id, project_name, tracker_id, tracker_name, status_id, status_name, 
                 priority_id, priority_name, author_id, author_name, assigned_to_id, assigned_to_name,
                 subject, description, start_date, due_date, done_ratio, estimated_hours,
                 updated_on, created_on, is_my_issue, raw_json)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                iss.get('id'),
                p.get('id'), p.get('name', ''),
                t.get('id'), t.get('name', ''),
                s.get('id'), s.get('name', ''),
                pr.get('id'), pr.get('name', ''),
                a.get('id'), a.get('name', ''),
                asg.get('id'), asg.get('name', ''),
                iss.get('subject', '(제목 없음)'),
                iss.get('description', ''),
                iss.get('start_date', ''),
                iss.get('due_date', ''),
                iss.get('done_ratio', 0),
                iss.get('estimated_hours'),
                iss.get('updated_on', ''),
                iss.get('created_on', ''),
                is_my,
                json.dumps(iss, ensure_ascii=False)
            ))
        conn.commit()

        return {"status": "success", "count": len(all_fetched), "my_count": len(my_issues)}
    except Exception as e:
        return {"status": "error", "message": f"일감 동기화 실패: {str(e)}"}
    finally:
        conn.close()


@eel.expose
def get_redmine_issues(filter_my: bool = True, project_id: int = None, status_id: int = None, 
                       tracker_id: int = None, priority_id: int = None, search_query: str = None):
    """
    SQLite 로컬 캐시에서 일감 목록 고속 조회 (0.01초)
    """
    conn = get_db_connection()
    try:
        clauses = []
        params = []

        if filter_my:
            clauses.append("is_my_issue = 1")
        if project_id:
            clauses.append("project_id = ?")
            params.append(project_id)
        if status_id:
            clauses.append("status_id = ?")
            params.append(status_id)
        if tracker_id:
            clauses.append("tracker_id = ?")
            params.append(tracker_id)
        if priority_id:
            clauses.append("priority_id = ?")
            params.append(priority_id)
        if search_query:
            q = f"%{search_query.strip()}%"
            clauses.append("(subject LIKE ? OR description LIKE ? OR id LIKE ?)")
            params.extend([q, q, q])

        where_sql = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        sql = f"SELECT * FROM redmine_issues {where_sql} ORDER BY updated_on DESC, id DESC"

        rows = conn.execute(sql, params).fetchall()
        issues = [dict(r) for r in rows]

        # 요약 통계 계산
        stats = {
            "total": len(issues),
            "in_progress": 0,
            "new": 0,
            "resolved": 0,
            "due_today": 0
        }
        today_str = datetime.now().strftime("%Y-%m-%d")
        for iss in issues:
            st = str(iss.get('status_name', '')).lower()
            if '진행' in st or 'progress' in st:
                stats['in_progress'] += 1
            elif '신규' in st or 'new' in st:
                stats['new'] += 1
            elif '해결' in st or '피드백' in st or 'resolved' in st or 'feedback' in st:
                stats['resolved'] += 1

            if iss.get('due_date') == today_str:
                stats['due_today'] += 1

        return {
            "status": "success",
            "count": len(issues),
            "stats": stats,
            "issues": issues
        }
    except Exception as e:
        return {"status": "error", "message": str(e)}
    finally:
        conn.close()


@eel.expose
def get_redmine_issue_detail(issue_id: int, refresh_from_server: bool = True):
    """
    일감 상세 정보 및 변경 이력(Journals), 첨부파일 조회
    """
    conn = get_db_connection()
    try:
        cfg = conn.execute("SELECT server_url, api_key FROM redmine_config WHERE id = 'default'").fetchone()
        
        # 1. 서버에서 최신 상세 내역(Journals, Attachments 포함) 조회
        if refresh_from_server and cfg and cfg['server_url'] and cfg['api_key']:
            endpoint = f"issues/{issue_id}.json?include=journals,attachments,relations,children"
            res = _request_redmine_api(cfg['server_url'], cfg['api_key'], endpoint)
            if res.get("status") == "success":
                issue_data = res.get("data", {}).get("issue", {})
                
                # 로컬 캐시 갱신
                p = issue_data.get('project', {})
                t = issue_data.get('tracker', {})
                s = issue_data.get('status', {})
                pr = issue_data.get('priority', {})
                a = issue_data.get('author', {})
                asg = issue_data.get('assigned_to', {})

                conn.execute("""
                    UPDATE redmine_issues SET
                        project_id = ?, project_name = ?,
                        tracker_id = ?, tracker_name = ?,
                        status_id = ?, status_name = ?,
                        priority_id = ?, priority_name = ?,
                        author_id = ?, author_name = ?,
                        assigned_to_id = ?, assigned_to_name = ?,
                        subject = ?, description = ?,
                        start_date = ?, due_date = ?,
                        done_ratio = ?, estimated_hours = ?,
                        updated_on = ?, raw_json = ?
                    WHERE id = ?
                """, (
                    p.get('id'), p.get('name', ''),
                    t.get('id'), t.get('name', ''),
                    s.get('id'), s.get('name', ''),
                    pr.get('id'), pr.get('name', ''),
                    a.get('id'), a.get('name', ''),
                    asg.get('id'), asg.get('name', ''),
                    issue_data.get('subject', ''),
                    issue_data.get('description', ''),
                    issue_data.get('start_date', ''),
                    issue_data.get('due_date', ''),
                    issue_data.get('done_ratio', 0),
                    issue_data.get('estimated_hours'),
                    issue_data.get('updated_on', ''),
                    json.dumps(issue_data, ensure_ascii=False),
                    issue_id
                ))
                conn.commit()

                # 서버 URL 붙여서 웹 링크 제공
                issue_data['web_url'] = f"{_normalize_url(cfg['server_url'])}/issues/{issue_id}"
                return {"status": "success", "source": "server", "issue": issue_data}

        # 2. 로컬 캐시 fallback
        row = conn.execute("SELECT * FROM redmine_issues WHERE id = ?", (issue_id,)).fetchone()
        if row:
            d = dict(row)
            if d.get('raw_json'):
                try:
                    full_obj = json.loads(d['raw_json'])
                    if cfg and cfg['server_url']:
                        full_obj['web_url'] = f"{_normalize_url(cfg['server_url'])}/issues/{issue_id}"
                    return {"status": "success", "source": "cache", "issue": full_obj}
                except Exception:
                    pass
            return {"status": "success", "source": "cache_basic", "issue": d}

        return {"status": "error", "message": f"일감 #{issue_id} 정보를 찾을 수 없습니다."}
    except Exception as e:
        return {"status": "error", "message": str(e)}
    finally:
        conn.close()


@eel.expose
def update_redmine_issue(issue_id: int, status_id: int = None, done_ratio: int = None, 
                         notes: str = None, priority_id: int = None, assigned_to_id: int = None):
    """
    일감 상태, 진척도(%), 코멘트(Notes) 원클릭 업데이트 (PUT /issues/{id}.json)
    """
    conn = get_db_connection()
    try:
        cfg = conn.execute("SELECT server_url, api_key FROM redmine_config WHERE id = 'default'").fetchone()
        if not cfg or not cfg['server_url'] or not cfg['api_key']:
            return {"status": "error", "message": "Redmine 연결 설정이 필요합니다."}

        payload = {"issue": {}}
        if status_id is not None:
            payload["issue"]["status_id"] = int(status_id)
        if done_ratio is not None:
            payload["issue"]["done_ratio"] = int(done_ratio)
        if notes is not None and str(notes).strip():
            payload["issue"]["notes"] = str(notes).strip()
        if priority_id is not None:
            payload["issue"]["priority_id"] = int(priority_id)
        if assigned_to_id is not None:
            payload["issue"]["assigned_to_id"] = int(assigned_to_id)

        if not payload["issue"]:
            return {"status": "error", "message": "변경할 항목이 없습니다."}

        endpoint = f"issues/{issue_id}.json"
        res = _request_redmine_api(cfg['server_url'], cfg['api_key'], endpoint, method='PUT', data=payload)

        if res.get("status") == "success":
            # 업데이트 후 상세 내역 재동기화
            get_redmine_issue_detail(issue_id, refresh_from_server=True)
            return {"status": "success", "message": f"일감 #{issue_id}이 성공적으로 갱신되었습니다."}
        return res
    except Exception as e:
        return {"status": "error", "message": f"일감 수정 오류: {str(e)}"}
    finally:
        conn.close()


@eel.expose
def create_redmine_issue(project_id: int, subject: str, description: str = "", tracker_id: int = None,
                         status_id: int = None, priority_id: int = None, assigned_to_id: int = None, 
                         due_date: str = None, done_ratio: int = 0):
    """
    새 일감 등록 (POST /issues.json)
    """
    conn = get_db_connection()
    try:
        cfg = conn.execute("SELECT server_url, api_key FROM redmine_config WHERE id = 'default'").fetchone()
        if not cfg or not cfg['server_url'] or not cfg['api_key']:
            return {"status": "error", "message": "Redmine 연결 설정이 필요합니다."}

        if not project_id:
            return {"status": "error", "message": "프로젝트를 선택해 주세요."}
        if not subject or not str(subject).strip():
            return {"status": "error", "message": "일감 제목을 입력해 주세요."}

        issue_payload = {
            "project_id": int(project_id),
            "subject": str(subject).strip(),
            "description": str(description or "").strip(),
            "done_ratio": int(done_ratio or 0)
        }
        if tracker_id:
            issue_payload["tracker_id"] = int(tracker_id)
        if status_id:
            issue_payload["status_id"] = int(status_id)
        if priority_id:
            issue_payload["priority_id"] = int(priority_id)
        if assigned_to_id:
            issue_payload["assigned_to_id"] = int(assigned_to_id)
        if due_date:
            issue_payload["due_date"] = str(due_date).strip()

        res = _request_redmine_api(cfg['server_url'], cfg['api_key'], "issues.json", method='POST', data={"issue": issue_payload})

        if res.get("status") == "success":
            new_issue = res.get("data", {}).get("issue", {})
            new_id = new_issue.get("id")
            # 동기화
            sync_redmine_issues(project_id=project_id)
            return {
                "status": "success",
                "message": f"새 일감 #{new_id} 등록이 완료되었습니다! 🎉",
                "issue_id": new_id,
                "issue": new_issue
            }
        return res
    except Exception as e:
        return {"status": "error", "message": f"일감 생성 오류: {str(e)}"}
    finally:
        conn.close()


# ==========================================
# 4. 위키 (Wiki) CRUD & 캐시
# ==========================================

@eel.expose
def fetch_project_wikis(project_id_or_ident: str):
    """프로젝트 위키 목차 목록 조회 (GET /projects/{project_id}/wiki/index.json)"""
    conn = get_db_connection()
    try:
        cfg = conn.execute("SELECT server_url, api_key FROM redmine_config WHERE id = 'default'").fetchone()
        if not cfg or not cfg['server_url'] or not cfg['api_key']:
            return {"status": "error", "message": "Redmine 설정이 필요합니다."}

        proj_key = str(project_id_or_ident).strip()
        endpoint = f"projects/{proj_key}/wiki/index.json"
        res = _request_redmine_api(cfg['server_url'], cfg['api_key'], endpoint)

        if res.get("status") != "success":
            return res

        wiki_pages = res.get("data", {}).get("wiki_pages", [])

        # SQLite 캐시 갱신
        for wp in wiki_pages:
            title = wp.get("title", "")
            pk = f"{proj_key}:{title}"
            conn.execute("""
                INSERT OR REPLACE INTO redmine_wikis 
                (id, project_id, project_name, title, version, created_on, updated_on, raw_json)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                pk,
                proj_key,
                proj_key,
                title,
                wp.get("version", 1),
                wp.get("created_on", ""),
                wp.get("updated_on", ""),
                json.dumps(wp, ensure_ascii=False)
            ))
        conn.commit()

        return {"status": "success", "count": len(wiki_pages), "wiki_pages": wiki_pages}
    except Exception as e:
        return {"status": "error", "message": f"위키 목록 조회 실패: {str(e)}"}
    finally:
        conn.close()


@eel.expose
def get_redmine_wikis(project_id_or_ident: str):
    """캐시된 위키 목록 조회"""
    conn = get_db_connection()
    try:
        proj_key = str(project_id_or_ident).strip()
        rows = conn.execute("SELECT * FROM redmine_wikis WHERE project_id = ? ORDER BY title ASC", (proj_key,)).fetchall()
        wikis = [dict(r) for r in rows]
        if not wikis:
            res = fetch_project_wikis(proj_key)
            if res.get("status") == "success":
                return res
        return {"status": "success", "wiki_pages": wikis}
    except Exception as e:
        return {"status": "error", "message": str(e)}
    finally:
        conn.close()


@eel.expose
def get_redmine_wiki_detail(project_id_or_ident: str, title: str, refresh_from_server: bool = True):
    """위키 본문 내용 및 메타데이터 조회 (GET /projects/{project_id}/wiki/{title}.json)"""
    conn = get_db_connection()
    try:
        cfg = conn.execute("SELECT server_url, api_key FROM redmine_config WHERE id = 'default'").fetchone()
        proj_key = str(project_id_or_ident).strip()
        safe_title = urllib.parse.quote(str(title).strip())

        if refresh_from_server and cfg and cfg['server_url'] and cfg['api_key']:
            endpoint = f"projects/{proj_key}/wiki/{safe_title}.json?include=attachments"
            res = _request_redmine_api(cfg['server_url'], cfg['api_key'], endpoint)
            if res.get("status") == "success":
                wiki_page = res.get("data", {}).get("wiki_page", {})
                
                pk = f"{proj_key}:{title}"
                author = wiki_page.get("author", {}).get("name", "")
                conn.execute("""
                    INSERT OR REPLACE INTO redmine_wikis 
                    (id, project_id, project_name, title, version, author_name, comments, text, updated_on, created_on, raw_json)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, (
                    pk,
                    proj_key,
                    proj_key,
                    wiki_page.get("title", title),
                    wiki_page.get("version", 1),
                    author,
                    wiki_page.get("comments", ""),
                    wiki_page.get("text", ""),
                    wiki_page.get("updated_on", ""),
                    wiki_page.get("created_on", ""),
                    json.dumps(wiki_page, ensure_ascii=False)
                ))
                conn.commit()

                wiki_page['web_url'] = f"{_normalize_url(cfg['server_url'])}/projects/{proj_key}/wiki/{safe_title}"
                return {"status": "success", "source": "server", "wiki_page": wiki_page}

        # 로컬 캐시
        pk = f"{proj_key}:{title}"
        row = conn.execute("SELECT * FROM redmine_wikis WHERE id = ?", (pk,)).fetchone()
        if row:
            d = dict(row)
            if cfg and cfg['server_url']:
                d['web_url'] = f"{_normalize_url(cfg['server_url'])}/projects/{proj_key}/wiki/{safe_title}"
            return {"status": "success", "source": "cache", "wiki_page": d}

        return {"status": "error", "message": f"위키 문서 '{title}'를 찾을 수 없습니다."}
    except Exception as e:
        return {"status": "error", "message": str(e)}
    finally:
        conn.close()


@eel.expose
def save_redmine_wiki_page(project_id_or_ident: str, title: str, text: str, comments: str = ""):
    """위키 문서 작성 / 수정 (PUT /projects/{project_id}/wiki/{title}.json)"""
    conn = get_db_connection()
    try:
        cfg = conn.execute("SELECT server_url, api_key FROM redmine_config WHERE id = 'default'").fetchone()
        if not cfg or not cfg['server_url'] or not cfg['api_key']:
            return {"status": "error", "message": "Redmine 설정이 필요합니다."}

        proj_key = str(project_id_or_ident).strip()
        safe_title = urllib.parse.quote(str(title).strip())

        payload = {
            "wiki_page": {
                "text": str(text),
                "comments": str(comments or "Updated via Util-Tools").strip()
            }
        }

        endpoint = f"projects/{proj_key}/wiki/{safe_title}.json"
        res = _request_redmine_api(cfg['server_url'], cfg['api_key'], endpoint, method='PUT', data=payload)

        if res.get("status") == "success":
            get_redmine_wiki_detail(proj_key, title, refresh_from_server=True)
            return {"status": "success", "message": f"위키 문서 '{title}' 저장이 완료되었습니다! 💾"}
        return res
    except Exception as e:
        return {"status": "error", "message": f"위키 저장 오류: {str(e)}"}
    finally:
        conn.close()


# ==========================================
# 5. 종합 동기화 & 백그라운드 변경 감지
# ==========================================

@eel.expose
def sync_redmine_all(force: bool = False):
    """
    프로젝트, 메타데이터, 내 일감 일괄 동기화
    """
    meta_res = fetch_redmine_metadata()
    proj_res = fetch_redmine_projects()
    iss_res = sync_redmine_issues()

    return {
        "status": "success",
        "message": "Redmine 전체 데이터 동기화 완료",
        "metadata_status": meta_res.get("status"),
        "projects_count": proj_res.get("count", 0),
        "issues_count": iss_res.get("count", 0),
        "my_issues_count": iss_res.get("my_count", 0),
        "synced_at": datetime.now().isoformat()
    }


@eel.expose
def check_redmine_updates_for_notification(last_check_iso: str = None):
    """
    백그라운드에서 내게 할당된 새 일감 또는 최근 변경 일감 감지 (트레이 알림용)
    """
    conn = get_db_connection()
    try:
        cfg = conn.execute("SELECT server_url, api_key, user_id FROM redmine_config WHERE id = 'default'").fetchone()
        if not cfg or not cfg['server_url'] or not cfg['api_key']:
            return {"status": "skipped", "reason": "not_configured"}

        # 서버에서 최신 내 일감 조회
        res = _request_redmine_api(cfg['server_url'], cfg['api_key'], "issues.json?assigned_to_id=me&status_id=open&limit=20&sort=updated_on:desc")
        if res.get("status") != "success":
            return {"status": "error", "message": res.get("message")}

        issues = res.get("data", {}).get("issues", [])
        if not issues:
            return {"status": "success", "new_items": []}

        new_items = []
        if last_check_iso:
            for iss in issues:
                updated_on = iss.get("updated_on", "")
                if updated_on and updated_on > last_check_iso:
                    new_items.append({
                        "id": iss.get("id"),
                        "subject": iss.get("subject"),
                        "tracker": iss.get("tracker", {}).get("name"),
                        "status": iss.get("status", {}).get("name"),
                        "project": iss.get("project", {}).get("name"),
                        "author": iss.get("author", {}).get("name"),
                        "updated_on": updated_on
                    })

        # 캐시 갱신
        sync_redmine_issues()

        return {
            "status": "success",
            "new_count": len(new_items),
            "new_items": new_items,
            "checked_at": datetime.now().isoformat()
        }
    except Exception as e:
        return {"status": "error", "message": str(e)}
    finally:
        conn.close()

"""
Redmine REST API 연동 서비스 모듈
- 일감(Issues) 조회, 생성, 상태/진척도 변경, 댓글(Notes) 작성
- 프로젝트 위키(Wiki) 조회, 마크다운 렌더링, 편집 및 발행
- 프로젝트/상태/트래커/우선순위 메타데이터 동기화
- SQLite 오프라인 로컬 캐싱 및 백그라운드 변경 감지
"""

import os
import re
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
    """
    서버 URL 지능형 정규화
    - 끝부분 슬래시(/) 제거
    - 브라우저 주소창에서 복사한 하위 경로(/projects/..., /issues/..., /my/page, /wiki/... 등)
      자동 감지 및 Redmine Base Server URL로 정제
    """
    if not url:
        return ""
    u = str(url).strip().rstrip('/')
    # Redmine 대표 웹 경로 패턴 제거 (Base URL만 추출)
    # 예: http://220.73.178.169:8081/redmine/projects/customize-ez -> http://220.73.178.169:8081/redmine
    # 예: http://redmine.example.com/issues/123 -> http://redmine.example.com
    pattern = r'/(projects|issues|my|wiki|users|settings|admin|enumerations|custom_fields|news|time_entries)(/.*)?$'
    u = re.sub(pattern, '', u, flags=re.IGNORECASE).rstrip('/')
    return u


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
def save_redmine_config(server_url: str, api_key: str, auto_sync: bool = True, sync_interval_min: int = 5,
                        sync_scope: str = "all_open", sync_limit: int = 300, sync_project_id: int = 0):
    """Redmine 설정 저장 및 동기화 범위 반영"""
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
            (id, server_url, api_key, user_id, user_name, user_login, auto_sync, sync_interval_min,
             sync_scope, sync_limit, sync_project_id, updated_at)
            VALUES ('default', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            server_url,
            api_key,
            user.get("id"),
            user.get("name"),
            user.get("login"),
            1 if auto_sync else 0,
            sync_interval_min,
            sync_scope,
            int(sync_limit) if sync_limit else 300,
            int(sync_project_id) if sync_project_id else 0,
            now_str
        ))
        conn.commit()

        # 백그라운드 전체 메타데이터 및 설정된 범위의 일감 동기화 트리거
        sync_res = sync_redmine_all(force=True)

        return {
            "status": "success",
            "message": "Redmine 연동 설정 및 동기화 범위가 성공적으로 저장되었습니다.",
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
def sync_redmine_issues(project_id: int = None, limit: int = None, scope: str = None):
    """
    서버로부터 일감 목록 동기화
    - scope: 'all_open' (내 참여 프로젝트 전체 열린 일감 + 미할당 일감 포함)
             'my_only' (내게 할당된 일감만)
             'all_with_closed' (최근 닫힌 일감 포함 전체)
    """
    conn = get_db_connection()
    try:
        cfg = conn.execute("SELECT server_url, api_key, user_id, sync_scope, sync_limit, sync_project_id FROM redmine_config WHERE id = 'default'").fetchone()
        if not cfg or not cfg['server_url'] or not cfg['api_key']:
            return {"status": "error", "message": "Redmine 설정이 필요합니다."}

        server_url = cfg['server_url']
        api_key = cfg['api_key']
        my_user_id = cfg['user_id']
        
        cfg_dict = dict(cfg)
        sync_scope = scope or cfg_dict.get('sync_scope') or 'all_open'
        max_limit = limit or cfg_dict.get('sync_limit') or 300
        target_project_id = project_id if project_id is not None else (cfg_dict.get('sync_project_id') or 0)

        all_fetched_map = {}

        # 1. 내게 할당된 열린 일감은 어떤 스코프에서도 항상 우선 확보
        my_endpoint = "issues.json?assigned_to_id=me&status_id=open&limit=100&sort=updated_on:desc"
        res_my = _request_redmine_api(server_url, api_key, my_endpoint)
        if res_my.get("status") == "success":
            for iss in res_my.get("data", {}).get("issues", []):
                all_fetched_map[iss['id']] = iss

        # 2. 동기화 범위(Scope)에 따른 확장 일감 수집 (미할당 및 팀 일감 포함)
        status_param = "open" if sync_scope != "all_with_closed" else "*"
        
        if sync_scope in ["all_open", "all_with_closed"]:
            offset = 0
            page_size = min(100, max_limit)
            while offset < max_limit:
                base_query = f"issues.json?status_id={status_param}&limit={page_size}&offset={offset}&sort=updated_on:desc"
                if target_project_id and int(target_project_id) > 0:
                    base_query += f"&project_id={target_project_id}"

                res_scope = _request_redmine_api(server_url, api_key, base_query)
                if res_scope.get("status") != "success":
                    break

                page_issues = res_scope.get("data", {}).get("issues", [])
                if not page_issues:
                    break

                for iss in page_issues:
                    all_fetched_map[iss['id']] = iss

                offset += len(page_issues)
                if len(page_issues) < page_size:
                    break

        elif sync_scope == "my_only" and target_project_id and int(target_project_id) > 0:
            proj_endpoint = f"issues.json?project_id={target_project_id}&status_id=open&limit=100&sort=updated_on:desc"
            res_proj = _request_redmine_api(server_url, api_key, proj_endpoint)
            if res_proj.get("status") == "success":
                for iss in res_proj.get("data", {}).get("issues", []):
                    all_fetched_map[iss['id']] = iss

        all_fetched = list(all_fetched_map.values())

        # SQLite에 일괄 갱신
        for iss in all_fetched:
            p = iss.get('project') or {}
            t = iss.get('tracker') or {}
            s = iss.get('status') or {}
            pr = iss.get('priority') or {}
            a = iss.get('author') or {}
            asg = iss.get('assigned_to') or {}

            asg_id = asg.get('id')
            asg_name = asg.get('name', '') if asg_id else '미할당'
            is_my = 1 if (asg_id == my_user_id and my_user_id is not None) else 0

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
                asg_id, asg_name,
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

        my_count = sum(1 for iss in all_fetched if (iss.get('assigned_to') or {}).get('id') == my_user_id)
        unassigned_count = sum(1 for iss in all_fetched if not (iss.get('assigned_to') or {}).get('id'))

        return {
            "status": "success",
            "count": len(all_fetched),
            "my_count": my_count,
            "unassigned_count": unassigned_count,
            "scope": sync_scope
        }
    except Exception as e:
        return {"status": "error", "message": f"일감 동기화 실패: {str(e)}"}
    finally:
        conn.close()


@eel.expose
def get_redmine_issues(filter_my: bool = False, project_id=None, status_id=None, 
                       tracker_id=None, priority_id=None, search_query: str = None,
                       assignee: str = None, due_today: bool = False, *args, **kwargs):
    """
    SQLite 로컬 캐시에서 일감 목록 고속 조회 (0.01초)
    - stats: 전체(또는 선택된 프로젝트) 기준 불변 요약 통계
    - issues: 사용자의 현재 세부 필터 조건에 부합하는 일감 리스트
    """
    def _safe_int(val):
        if val is None or val == "" or str(val).lower() in ("null", "undefined", "none", "0"):
            return None
        try:
            i = int(val)
            return i if i > 0 else None
        except (ValueError, TypeError):
            return None

    project_id = _safe_int(project_id)
    status_id = _safe_int(status_id)
    tracker_id = _safe_int(tracker_id)
    priority_id = _safe_int(priority_id)
    filter_my = bool(filter_my)
    due_today = bool(due_today)
    search_query = str(search_query).strip() if search_query else ""
    assignee = str(assignee).strip() if assignee else ""

    conn = get_db_connection()
    try:
        # 1. 상단 대시보드 요약 통계 계산 (프로젝트 및 내 일감 기준 고정 통계)
        stat_clauses = []
        stat_params = []
        if project_id:
            stat_clauses.append("project_id = ?")
            stat_params.append(project_id)
        if filter_my or assignee == 'me':
            stat_clauses.append("is_my_issue = 1")

        stat_where = f"WHERE {' AND '.join(stat_clauses)}" if stat_clauses else ""
        stat_rows = conn.execute(f"SELECT status_name, due_date, is_my_issue, assigned_to_id, assigned_to_name FROM redmine_issues {stat_where}", stat_params).fetchall()

        today_str = datetime.now().strftime("%Y-%m-%d")
        stats = {
            "total": len(stat_rows),
            "in_progress": 0,
            "new": 0,
            "resolved": 0,
            "due_today": 0,
            "my_total": 0,
            "unassigned_total": 0
        }
        for r in stat_rows:
            st = str(r['status_name'] or '').lower()
            if '진행' in st or 'progress' in st:
                stats['in_progress'] += 1
            elif '신규' in st or 'new' in st or '접수' in st:
                stats['new'] += 1
            elif '해결' in st or '피드백' in st or '완료' in st or 'resolved' in st or 'feedback' in st:
                stats['resolved'] += 1

            if r['due_date'] == today_str:
                stats['due_today'] += 1

            if r['is_my_issue'] == 1:
                stats['my_total'] += 1
            if not r['assigned_to_id'] or r['assigned_to_name'] == '미할당':
                stats['unassigned_total'] += 1

        # 2. 일감 카드 목록 필터링
        clauses = []
        params = []

        if filter_my or assignee == 'me':
            clauses.append("is_my_issue = 1")
        elif assignee == 'unassigned':
            clauses.append("(assigned_to_id IS NULL OR assigned_to_name = '미할당' OR assigned_to_name = '')")
        elif assignee:
            clauses.append("assigned_to_name = ?")
            params.append(assignee)

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
        if due_today:
            clauses.append("due_date = ?")
            params.append(today_str)
        if search_query:
            q = f"%{search_query.strip()}%"
            clauses.append("(subject LIKE ? OR description LIKE ? OR id LIKE ? OR assigned_to_name LIKE ?)")
            params.extend([q, q, q, q])

        where_sql = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        sql = f"SELECT * FROM redmine_issues {where_sql} ORDER BY updated_on DESC, id DESC"

        rows = conn.execute(sql, params).fetchall()
        issues = [dict(r) for r in rows]

        # 전체 고유 담당자 목록 추출 (프론트엔드 드롭다운용)
        all_assignees_rows = conn.execute("SELECT DISTINCT assigned_to_name FROM redmine_issues WHERE assigned_to_name IS NOT NULL AND assigned_to_name != '' AND assigned_to_name != '미할당' ORDER BY assigned_to_name").fetchall()
        assignees_list = [r['assigned_to_name'] for r in all_assignees_rows]

        return {
            "status": "success",
            "count": len(issues),
            "stats": stats,
            "assignees": assignees_list,
            "issues": issues
        }
    except Exception as e:
        return {"status": "error", "message": f"일감 조회 실패: {str(e)}"}
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
def get_redmine_project_members(project_id: int, *args, **kwargs):
    """
    프로젝트 멤버/그룹 목록 조회 (GET /projects/{project_id}/memberships.json)
    """
    conn = get_db_connection()
    try:
        cfg = conn.execute("SELECT server_url, api_key FROM redmine_config WHERE id = 'default'").fetchone()
        if not cfg or not cfg['server_url'] or not cfg['api_key']:
            return {"status": "error", "message": "Redmine 연결 설정이 필요합니다."}

        res = _request_redmine_api(cfg['server_url'], cfg['api_key'], f"projects/{project_id}/memberships.json?limit=100")
        if res.get("status") == "success":
            memberships = res.get("data", {}).get("memberships", [])
            members = []
            seen_ids = set()
            for m in memberships:
                u = m.get("user") or m.get("group")
                if u and u.get("id") not in seen_ids:
                    seen_ids.add(u.get("id"))
                    members.append({
                        "id": u.get("id"),
                        "name": u.get("name")
                    })
            return {"status": "success", "members": members}
        return res
    except Exception as e:
        return {"status": "error", "message": f"멤버 조회 실패: {str(e)}"}
    finally:
        conn.close()


@eel.expose
def update_redmine_issue(issue_id: int, status_id=None, done_ratio=None, 
                         notes: str = None, priority_id=None, assigned_to_id=None,
                         tracker_id=None, due_date: str = None, start_date: str = None,
                         estimated_hours=None, subject: str = None, *args, **kwargs):
    """
    일감 속성(상태, 진척도, 담당자, 우선순위, 유형, 마감일, 시작일, 코멘트 등) 실시간 업데이트 (PUT /issues/{id}.json)
    """
    conn = get_db_connection()
    try:
        cfg = conn.execute("SELECT server_url, api_key FROM redmine_config WHERE id = 'default'").fetchone()
        if not cfg or not cfg['server_url'] or not cfg['api_key']:
            return {"status": "error", "message": "Redmine 연결 설정이 필요합니다."}

        payload = {"issue": {}}
        if status_id is not None and str(status_id) != "":
            payload["issue"]["status_id"] = int(status_id)
        if done_ratio is not None and str(done_ratio) != "":
            payload["issue"]["done_ratio"] = int(done_ratio)
        if notes is not None and str(notes).strip():
            payload["issue"]["notes"] = str(notes).strip()
        if priority_id is not None and str(priority_id) != "":
            payload["issue"]["priority_id"] = int(priority_id)
        if tracker_id is not None and str(tracker_id) != "":
            payload["issue"]["tracker_id"] = int(tracker_id)
        if due_date is not None:
            payload["issue"]["due_date"] = str(due_date).strip() if str(due_date).strip() else ""
        if start_date is not None:
            payload["issue"]["start_date"] = str(start_date).strip() if str(start_date).strip() else ""
        if estimated_hours is not None and str(estimated_hours) != "":
            payload["issue"]["estimated_hours"] = float(estimated_hours)
        if subject is not None and str(subject).strip():
            payload["issue"]["subject"] = str(subject).strip()

        # 담당자 변경 처리: 빈 문자열("") 또는 "0"인 경우 미할당(담당자 해제)
        if assigned_to_id is not None:
            if str(assigned_to_id).strip() in ("", "0", "null", "none", "unassigned"):
                payload["issue"]["assigned_to_id"] = ""
            else:
                payload["issue"]["assigned_to_id"] = int(assigned_to_id)

        if not payload["issue"]:
            return {"status": "error", "message": "변경할 항목이 없습니다."}

        endpoint = f"issues/{issue_id}.json"
        res = _request_redmine_api(cfg['server_url'], cfg['api_key'], endpoint, method='PUT', data=payload)

        if res.get("status") == "success":
            # 업데이트 후 상세 내역 재동기화 및 최신 일감 반환
            detail_res = get_redmine_issue_detail(issue_id, refresh_from_server=True)
            return {
                "status": "success", 
                "message": f"일감 #{issue_id}이 성공적으로 갱신되었습니다.",
                "issue": detail_res.get("issue")
            }
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

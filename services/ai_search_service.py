"""
AI 딥러닝 시맨틱(의미론적) 임베딩 & 문맥 검색 엔진
- 모델: intfloat/multilingual-e5-small ONNX (Quantized)
- 최적화:
  1. 동적 패딩 (Dynamic Padding): 실제 텍스트 길이에 맞춰 필요한 만큼만 행렬 연산
  2. 디스크 벡터 DB 캐시 (SQLite ai_embeddings): 계산된 의미 좌표를 영구 보관
  3. 해시 기반 증분 갱신 (Incremental Caching): 변경되거나 새로 추가된 문서만 식별하여 부분 갱신
  4. 인메모리 행렬 연산: 검색 시 검색어 1개만 추론(5~10ms) 후 RAM에서 즉시 코사인 유사도 연산
"""
import os
import sys
import re
import json
import time
import hashlib
import threading
import numpy as np
import eel
from core.paths import BUNDLE_DIR, APP_DIR, MODELS_DIR

MODEL_DIR = MODELS_DIR
TOKENIZER_PATH = os.path.join(MODEL_DIR, "tokenizer.json")
ONNX_MODEL_PATH = os.path.join(MODEL_DIR, "onnx", "model_quantized.onnx")
CACHE_FILE_PATH = os.path.join(APP_DIR, "embeddings_cache.json")

# 전역 ONNX 세션 & 토크나이저
_onnx_session = None
_tokenizer = None
_is_model_ready = False
_engine_lock = threading.Lock()

# 인메모리 벡터 DB 캐시: { item_key: { "hash": md5, "embedding": np.ndarray } }
_vector_db_cache = {}
_cache_dirty = False


def _compute_text_hash(text):
    """문서 내용의 MD5 해시값 계산"""
    return hashlib.md5(text.encode('utf-8')).hexdigest()


import gc
import ctypes


def _trim_memory():
    """Windows Working Set 메모리 및 Python 가비지 컬렉션 강제 회수"""
    try:
        gc.collect()
        h_process = ctypes.windll.kernel32.GetCurrentProcess()
        ctypes.windll.psapi.EmptyWorkingSet(h_process)
    except Exception:
        pass


def _safe_log(msg):
    try:
        print(msg, flush=True)
    except Exception:
        try:
            safe_msg = msg.encode(sys.stdout.encoding or 'utf-8', errors='replace').decode(sys.stdout.encoding or 'utf-8', errors='replace')
            print(safe_msg, flush=True)
        except Exception:
            pass


def _load_disk_cache():
    """SQLite(ai_embeddings 테이블)에서 기저장된 바이너리 벡터 캐시 복원"""
    global _vector_db_cache
    _vector_db_cache = {}
    from services.db_service import get_db_connection
    conn = None
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT key, hash, vector FROM ai_embeddings")
        rows = cursor.fetchall()
        if rows:
            for r in rows:
                vec_bytes = r["vector"]
                if vec_bytes:
                    _vector_db_cache[r["key"]] = {
                        "hash": r["hash"],
                        "embedding": np.frombuffer(vec_bytes, dtype=np.float32)
                    }
            return

        # 1회성 마이그레이션: 기존 embeddings_cache.json이 있다면 SQLite로 이전
        if os.path.exists(CACHE_FILE_PATH):
            try:
                with open(CACHE_FILE_PATH, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                    raw = data.get("cache", {})
                    records = []
                    now = time.strftime("%Y-%m-%d %H:%M:%S")
                    for k, v in raw.items():
                        if isinstance(v, dict) and "embedding" in v and "hash" in v:
                            arr = np.array(v["embedding"], dtype=np.float32)
                            _vector_db_cache[k] = {"hash": v["hash"], "embedding": arr}
                            records.append((k, v["hash"], arr.tobytes(), now))
                    if records:
                        with conn:
                            conn.executemany("INSERT OR REPLACE INTO ai_embeddings (key, hash, vector, updated_at) VALUES (?, ?, ?, ?)", records)
                        _safe_log(f"[AI Engine] 기존 embeddings_cache.json에서 SQLite로 {len(records)}개 벡터 초경량 마이그레이션 완료!")
            except Exception as e:
                _safe_log(f"[AI Engine] JSON 캐시 마이그레이션 오류: {e}")
    except Exception as e:
        _safe_log(f"[AI Engine] DB 벡터 캐시 로드 실패: {e}")
    finally:
        if conn:
            conn.close()


def _save_disk_cache(records_to_save=None):
    """새로 계산된 벡터들을 SQLite에 고속 일괄 저장"""
    if not records_to_save:
        return
    from services.db_service import get_db_connection
    conn = None
    try:
        conn = get_db_connection()
        now = time.strftime("%Y-%m-%d %H:%M:%S")
        db_records = [(k, h, emb.tobytes(), now) for (k, h, emb) in records_to_save]
        with conn:
            conn.executemany("INSERT OR REPLACE INTO ai_embeddings (key, hash, vector, updated_at) VALUES (?, ?, ?, ?)", db_records)
    except Exception as e:
        _safe_log(f"[AI Engine] DB 벡터 저장 오류: {e}")
    finally:
        if conn:
            conn.close()


def _init_ai_engine():
    """multilingual-e5-small ONNX 딥러닝 엔진 초기화 (Lazy Loading & Auto-Download)"""
    global _onnx_session, _tokenizer, _is_model_ready

    if _is_model_ready:
        return True

    with _engine_lock:
        if _is_model_ready:
            return True

        try:
            # 모델 파일이 없으면 1회 자동 다운로드 시도
            if not (os.path.exists(TOKENIZER_PATH) and os.path.exists(ONNX_MODEL_PATH)):
                try:
                    from huggingface_hub import hf_hub_download
                    _safe_log("[AI Engine] multilingual-e5-small 모델 다운로드 중 (약 45MB)...")
                    hf_hub_download(repo_id="Xenova/multilingual-e5-small", filename="tokenizer.json", local_dir=MODEL_DIR)
                    hf_hub_download(repo_id="Xenova/multilingual-e5-small", filename="onnx/model_quantized.onnx", local_dir=MODEL_DIR)
                except Exception as dl_err:
                    _safe_log(f"[AI Engine] 모델 자동 다운로드 실패: {dl_err}")

            if os.path.exists(TOKENIZER_PATH) and os.path.exists(ONNX_MODEL_PATH):
                import onnxruntime as ort
                from tokenizers import Tokenizer

                _tokenizer = Tokenizer.from_file(TOKENIZER_PATH)
                _tokenizer.enable_truncation(max_length=512)
                # 고정 512 패딩 대신 동적 패딩 설정 (no fixed length padding)
                _tokenizer.no_padding()

                # CPU 고속 & 초경량 메모리 추론 세션 생성 (메모리 풀 독점 방지)
                opts = ort.SessionOptions()
                opts.intra_op_num_threads = 2
                opts.inter_op_num_threads = 1
                opts.enable_cpu_mem_arena = False  # ONNX 메모리 아레나 풀 독점 방지 (RAM 반환)
                opts.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
                opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL

                _onnx_session = ort.InferenceSession(
                    ONNX_MODEL_PATH,
                    sess_options=opts,
                    providers=['CPUExecutionProvider']
                )
                _is_model_ready = True
                _load_disk_cache()
                _safe_log("[AI Engine] multilingual-e5-small ONNX 초경량 엔진 & 벡터 캐시가 준비되었습니다.")
                return True
        except Exception as e:
            _safe_log(f"[AI Engine] ONNX 모델 로드 실패 (하이브리드 규칙 엔진으로 폴백): {e}")
            _is_model_ready = False

    return False


def _infer_single_batch(texts, is_query=False):
    """단일 미니 배치(최대 16개) 추론 수행 (메모리 폭증 방지)"""
    if not texts:
        return np.empty((0, 384), dtype=np.float32)

    try:
        # E5 모델 접두어: 쿼리는 'query: ', 문서는 'passage: '
        prefix = "query: " if is_query else "passage: "
        prefixed_texts = [prefix + str(t)[:2000] for t in texts]

        # 1. 인코딩 (패딩 없이 토큰화)
        encoded_list = _tokenizer.encode_batch(prefixed_texts)
        if not encoded_list:
            return None

        # 2. 동적 패딩 (배치 내 최대 토큰 길이 기준, 16 ~ 512 사이로 안전 제한)
        max_len = max(len(e.ids) for e in encoded_list)
        max_len = max(16, min(512, max_len))

        batch_size = len(encoded_list)
        input_ids = np.zeros((batch_size, max_len), dtype=np.int64)
        attention_mask = np.zeros((batch_size, max_len), dtype=np.int64)

        for i, e in enumerate(encoded_list):
            seq_len = min(len(e.ids), max_len)
            input_ids[i, :seq_len] = e.ids[:seq_len]
            attention_mask[i, :seq_len] = e.attention_mask[:seq_len]

        inputs = {
            'input_ids': input_ids,
            'attention_mask': attention_mask
        }

        input_names = [inp.name for inp in _onnx_session.get_inputs()]
        if 'token_type_ids' in input_names:
            inputs['token_type_ids'] = np.zeros_like(input_ids, dtype=np.int64)

        # 3. ONNX 모델 추론
        outputs = _onnx_session.run(None, inputs)
        last_hidden_state = outputs[0]  # (batch_size, seq_len, 384)

        # 4. Mean Pooling
        mask_expanded = np.expand_dims(attention_mask, -1).astype(np.float32)
        sum_embeddings = np.sum(last_hidden_state * mask_expanded, axis=1)
        sum_mask = np.maximum(np.sum(mask_expanded, axis=1), 1e-9)
        embeddings = sum_embeddings / sum_mask

        # 5. L2 Normalization (단위 벡터화 -> 내적 시 바로 코사인 유사도)
        norms = np.linalg.norm(embeddings, axis=1, keepdims=True)
        return (embeddings / np.maximum(norms, 1e-9)).astype(np.float32)
    except Exception as e:
        _safe_log(f"[AI Engine] 임베딩 계산 오류: {e}")
        return None


def _get_neural_embeddings(texts, is_query=False, batch_size=16):
    """
    multilingual-e5-small 신경망 임베딩 벡터 추출
    - 미니배치 분할(Mini-batch Chunking): 대량 문서도 메모리 고갈(OOM 39GB) 없이 안전하게 분할 계산
    - 동적 패딩(Dynamic Padding): 배치 내 길이에 맞춰 최소 텐서로 연산
    """
    if not _init_ai_engine() or _onnx_session is None or _tokenizer is None:
        return None

    if not texts:
        return np.empty((0, 384), dtype=np.float32)

    # 1개 쿼리나 소량 텍스트는 즉시 단일 실행
    if len(texts) <= batch_size:
        return _infer_single_batch(texts, is_query=is_query)

    # 대량 문서는 안전한 미니배치(16개) 단위로 분할 실행
    all_embeddings = []
    for i in range(0, len(texts), batch_size):
        chunk = texts[i:i + batch_size]
        res = _infer_single_batch(chunk, is_query=is_query)
        if res is not None:
            all_embeddings.append(res)
        else:
            all_embeddings.append(np.zeros((len(chunk), 384), dtype=np.float32))

    return np.vstack(all_embeddings).astype(np.float32)


def _sync_document_embeddings(all_items):
    """
    해시 기반 증분 갱신 (Incremental Caching):
    - 캐시에 이미 있고 해시가 같은 문서는 생략
    - 새로 추가되거나 수정된 문서만 한 번에 미니 배치로 계산하여 SQLite에 저장
    """
    _init_ai_engine()

    items_to_compute = []
    keys_to_compute = []

    for item in all_items:
        key = f"{item['category']}_{item['id']}"
        text_hash = _compute_text_hash(item["full_text"])

        # 캐시 히트 검사
        if key in _vector_db_cache and _vector_db_cache[key]["hash"] == text_hash:
            item["embedding"] = _vector_db_cache[key]["embedding"]
        else:
            items_to_compute.append(item["full_text"])
            keys_to_compute.append((key, text_hash, item))

    # 새로 계산할 문서가 있는 경우에만 배치 계산
    if items_to_compute:
        count = len(items_to_compute)
        _safe_log(f"[AI Engine] 신규/수정 문서 {count}개 벡터 임베딩 일괄 동기화 시작 (16개 미니배치)...")
        new_embs = _get_neural_embeddings(items_to_compute, is_query=False, batch_size=16)
        if new_embs is not None:
            records_to_save = []
            for (key, text_hash, item), emb in zip(keys_to_compute, new_embs):
                item["embedding"] = emb
                _vector_db_cache[key] = {
                    "hash": text_hash,
                    "embedding": emb
                }
                records_to_save.append((key, text_hash, emb))
            _save_disk_cache(records_to_save)
            _safe_log(f"[AI Engine] 총 {count}개 문서 벡터 SQLite 캐시 동기화 완료!")
            _trim_memory()


def _load_json_file(filename):
    for root in (APP_DIR, BUNDLE_DIR):
        path = os.path.join(root, filename)
        if os.path.exists(path):
            try:
                with open(path, 'r', encoding='utf-8') as f:
                    return json.load(f)
            except Exception:
                pass
    return None


def _get_all_system_items(filter_category=None):
    """
    모든 도구(이메일, 메모, 다이어그램, 숏컷, 퀵런치, 제너레이터)의 데이터를
    중앙 SQLite DB(app.db)로부터 즉시 초경량 고속 조회
    """
    all_items = []
    
    # 1. SQLite 연결 및 일괄 조회
    from services.db_service import get_db_connection
    conn = None
    try:
        conn = get_db_connection()
    except Exception:
        conn = None

    is_all = not filter_category or filter_category == 'all'

    # (1) 이메일 아카이브 (본문 전체 대신 경량 메타데이터만 쿼리하여 메모리 절감)
    if is_all or filter_category == 'emails':
        email_items = []
        if conn:
            try:
                rows = conn.execute("""
                    SELECT id, subject, clean_subject, from_addr, to_addr, date_str, category,
                           substr(snippet, 1, 100) as snippet
                    FROM emails
                    ORDER BY date_str DESC
                """).fetchall()
                for r in rows:
                    subject = r['subject'] or '(제목 없음)'
                    clean_sub = r['clean_subject'] or subject
                    from_addr = r['from_addr'] or ''
                    to_addr = r['to_addr'] or ''
                    cat = r['category'] or '기타'
                    snippet = r['snippet'] or ''

                    email_items.append({
                        "id": r['id'],
                        "category": "emails",
                        "category_label": f"이메일 ({cat})",
                        "icon": "📧",
                        "title": subject,
                        "snippet": f"[{from_addr}] {snippet}" if from_addr else snippet,
                        "full_text": f"{subject}\n{clean_sub}\n{from_addr}\n{to_addr}\n{cat}\n{snippet}",
                        "target_tab": "emails",
                        "action_data": {"email_id": r['id']}
                    })
            except Exception as e:
                _safe_log(f"[AI Search] SQLite emails 조회 실패: {e}")

        all_items.extend(email_items)

    # (2) 메모 (Notes)
    if is_all or filter_category == 'notes':
        if conn:
            try:
                rows = conn.execute("SELECT id, title, content, category FROM notes ORDER BY is_pinned DESC, updated_at DESC").fetchall()
                for r in rows:
                    title = r['title'] or '(제목 없는 메모)'
                    content = r['content'] or ''
                    cat = r['category'] or '일반'
                    all_items.append({
                        "id": str(r['id']),
                        "category": "notes",
                        "category_label": f"메모 ({cat})",
                        "icon": "📝",
                        "title": title,
                        "snippet": content[:120].replace("\n", " ").strip() if content else '(내용 없음)',
                        "full_text": f"{title}\n{cat}\n{content[:500]}",
                        "target_tab": "notes",
                        "action_data": {"note_id": str(r['id'])}
                    })
            except Exception as e:
                _safe_log(f"[AI Search] SQLite notes 조회 실패: {e}")

    # (3) 다이어그램 (Diagrams)
    if is_all or filter_category == 'diagrams':
        if conn:
            try:
                rows = conn.execute("SELECT id, title, code, category, type, description FROM diagrams ORDER BY updated_at DESC").fetchall()
                for r in rows:
                    title = r['title'] or '(다이어그램)'
                    cat = r['category'] or '일반'
                    desc = r['description'] or ''
                    code = r['code'] or ''
                    all_items.append({
                        "id": str(r['id']),
                        "category": "diagrams",
                        "category_label": f"다이어그램 ({cat})",
                        "icon": "📊",
                        "title": title,
                        "snippet": desc if desc else code[:100].replace("\n", " ").strip(),
                        "full_text": f"{title}\n{cat}\n{desc}\n{code[:500]}",
                        "target_tab": "mermaid",
                        "action_data": {"diagram_id": str(r['id'])}
                    })
            except Exception as e:
                _safe_log(f"[AI Search] SQLite diagrams 조회 실패: {e}")

    # (4) 퀵 런치 (Quick Launch)
    if is_all or filter_category == 'quick_launch':
        if conn:
            try:
                rows = conn.execute("SELECT id, title, path, icon, category, description FROM quick_launch ORDER BY order_index ASC").fetchall()
                for r in rows:
                    title = r['title'] or '앱'
                    path = r['path'] or ''
                    cat = r['category'] or 'cmd'
                    desc = r['description'] or ''
                    icon = r['icon'] or '⚡'
                    all_items.append({
                        "id": str(r['id']),
                        "category": "quick_launch",
                        "category_label": f"빠른실행 ({cat})",
                        "icon": icon,
                        "title": title,
                        "snippet": f"{desc} ({path})" if desc else path,
                        "full_text": f"{title}\n{cat}\n{desc}\n{path}",
                        "target_tab": "launch",
                        "action_data": {"ql_id": str(r['id']), "command": path, "type": cat}
                    })
            except Exception as e:
                _safe_log(f"[AI Search] SQLite quick_launch 조회 실패: {e}")

    # (5) 단축키 / 바로가기 (Shortcuts)
    if is_all or filter_category == 'shortcuts':
        if conn:
            try:
                rows = conn.execute("SELECT id, title, key_combo, url_or_path, category, description, icon FROM shortcuts ORDER BY id ASC").fetchall()
                for r in rows:
                    title = r['title'] or '바로가기'
                    path = r['url_or_path'] or ''
                    cat = r['category'] or 'folder'
                    desc = r['description'] or ''
                    icon = r['icon'] or '📁'
                    key = r['key_combo'] or ''
                    all_items.append({
                        "id": str(r['id']),
                        "category": "shortcuts",
                        "category_label": f"바로가기 ({cat})",
                        "icon": icon,
                        "title": title,
                        "snippet": f"{key} - {path}" if key else path,
                        "full_text": f"{title}\n{cat}\n{desc}\n{key}\n{path}",
                        "target_tab": "files",
                        "action_data": {"sc_id": str(r['id']), "path": path}
                    })
            except Exception as e:
                _safe_log(f"[AI Search] SQLite shortcuts 조회 실패: {e}")

    # (6) 코드/데이터 제너레이터 (Generators)
    if is_all or filter_category == 'generators':
        if conn:
            try:
                rows = conn.execute("SELECT id, title, language, template, description, category, icon FROM generators ORDER BY id ASC").fetchall()
                for r in rows:
                    title = r['title'] or '제너레이터'
                    lang = r['language'] or 'code'
                    cat = r['category'] or '생성기'
                    desc = r['description'] or ''
                    icon = r['icon'] or '🔢'
                    tmpl = r['template'] or ''
                    all_items.append({
                        "id": str(r['id']),
                        "category": "generators",
                        "category_label": f"생성기 ({lang})",
                        "icon": icon,
                        "title": title,
                        "snippet": desc if desc else tmpl[:100].replace("\n", " ").strip(),
                        "full_text": f"{title}\n{lang}\n{cat}\n{desc}\n{tmpl[:500]}",
                        "target_tab": "generator",
                        "action_data": {"gen_id": str(r['id'])}
                    })
            except Exception as e:
                _safe_log(f"[AI Search] SQLite generators 조회 실패: {e}")

    # (7) Redmine 일감 (Redmine Issues)
    if is_all or filter_category == 'redmine':
        if conn:
            try:
                rows = conn.execute("SELECT id, subject, description, tracker_name, status_name, priority_name, project_name, assigned_to_name FROM redmine_issues ORDER BY updated_on DESC LIMIT 500").fetchall()
                for r in rows:
                    iss_id = r['id']
                    sub = r['subject'] or '(제목 없음)'
                    desc = r['description'] or ''
                    proj = r['project_name'] or ''
                    tracker = r['tracker_name'] or '일감'
                    status = r['status_name'] or ''
                    all_items.append({
                        "id": f"issue_{iss_id}",
                        "category": "redmine",
                        "category_label": f"Redmine ({proj})",
                        "icon": "🦊",
                        "title": f"#{iss_id} [{tracker}] {sub}",
                        "snippet": f"[{status}] {desc[:120].replace(chr(10), ' ').strip()}" if desc else f"[{status}] {proj}",
                        "full_text": f"Redmine 일감 #{iss_id} {tracker} {status} {proj}\n{sub}\n{desc}",
                        "target_tab": "redmine",
                        "action_data": {"redmine_type": "issue", "issue_id": iss_id}
                    })
            except Exception as e:
                _safe_log(f"[AI Search] SQLite redmine_issues 조회 실패: {e}")

    # (8) Redmine 위키 (Redmine Wikis)
    if is_all or filter_category == 'redmine':
        if conn:
            try:
                rows = conn.execute("SELECT id, project_id, title, text, author_name FROM redmine_wikis ORDER BY updated_on DESC").fetchall()
                for r in rows:
                    w_id = r['id']
                    title = r['title'] or '(위키)'
                    proj = r['project_id'] or ''
                    text = r['text'] or ''
                    all_items.append({
                        "id": f"wiki_{w_id}",
                        "category": "redmine",
                        "category_label": f"위키 ({proj})",
                        "icon": "📖",
                        "title": f"[Wiki] {title} ({proj})",
                        "snippet": text[:120].replace(chr(10), ' ').strip(),
                        "full_text": f"Redmine 위키 {proj} {title}\n{text[:600]}",
                        "target_tab": "redmine",
                        "action_data": {"redmine_type": "wiki", "project_id": proj, "title": title}
                    })
            except Exception as e:
                _safe_log(f"[AI Search] SQLite redmine_wikis 조회 실패: {e}")

    if conn:
        try:
            conn.close()
        except Exception:
            pass

    return all_items


@eel.expose
def ai_semantic_search(query, filter_category=None):
    """
    multilingual-e5-small 딥러닝 기반 시맨틱 AI 문맥 검색
    - 검색어 1개 동적 패딩 추론
    - RAM 벡터 행렬 상에서 코사인 유사도 연산
    - 상위 50건 슬라이싱 반환
    """
    if not query or not query.strip():
        return {"status": "success", "data": [], "query": query, "latency_ms": 0}

    t0 = time.time()
    query = query.strip()
    all_items = _get_all_system_items(filter_category)

    if not all_items:
        return {"status": "success", "data": [], "query": query, "latency_ms": 0}

    # 1. 문서 벡터 증분 갱신
    _sync_document_embeddings(all_items)

    # 2. 검색어 1개만 AI 동적 패딩 추론 (5~10ms)
    q_embs = _get_neural_embeddings([query], is_query=True)

    search_results = []
    if q_embs is not None and len(q_embs) > 0:
        q_emb = q_embs[0]
        # 모든 문서 벡터 행렬 구성 (N, 384)
        doc_embs_list = []
        valid_items = []
        for item in all_items:
            if "embedding" in item and item["embedding"] is not None:
                doc_embs_list.append(item["embedding"])
                valid_items.append(item)

        if doc_embs_list:
            doc_matrix = np.vstack(doc_embs_list)  # (N, 384)
            # RAM 상에서 코사인 유사도 내적 연산
            scores = np.dot(doc_matrix, q_emb)

            for idx, item in enumerate(valid_items):
                raw_score = float(scores[idx])
                # E5 모델 점수 정규화
                normalized_score = round(max(0.0, min(99.9, (raw_score - 0.6) / 0.35 * 100)), 1)
                # 단어 직접 포함 시 보정
                if query.lower() in item["full_text"].lower():
                    normalized_score = max(normalized_score, 88.0)

                if normalized_score >= 35.0 or (raw_score >= 0.74 and normalized_score >= 25.0):
                    item_copy = {k: v for k, v in item.items() if k not in ("full_text", "embedding")}
                    item_copy["score"] = normalized_score
                    search_results.append(item_copy)

    # 유사도 내림차순 정렬 & 상위 50개 제한 (IPC 및 DOM 메모리 폭증 방지)
    search_results.sort(key=lambda x: x['score'], reverse=True)
    total_matched = len(search_results)
    search_results = search_results[:50]

    latency_ms = round((time.time() - t0) * 1000, 1)
    _trim_memory()

    return {
        "status": "success",
        "query": query,
        "model": "multilingual-e5-small" if _is_model_ready else "fallback",
        "latency_ms": latency_ms,
        "total_count": total_matched,
        "data": search_results
    }


@eel.expose
def ai_compare_similarity(text1, text2):
    """
    multilingual-e5-small 딥러닝 기반 두 문장 의미 유사도 측정 (동적 패딩 적용)
    """
    try:
        if not text1 or not text2:
            return {"status": "error", "message": "비교할 텍스트를 모두 입력해 주세요."}

        t0 = time.time()
        embs = _get_neural_embeddings([text1, text2], is_query=False)

        score = 0.0
        if embs is not None and len(embs) == 2:
            raw_sim = float(np.dot(embs[0], embs[1]))
            score = round(max(0.0, min(99.9, (raw_sim - 0.55) / 0.43 * 100)), 1)
            if text1.strip().lower() == text2.strip().lower():
                score = 100.0

        # 공통 키워드 추출
        w1 = set(re.findall(r'[a-zA-Z0-9가-힣]+', text1.lower()))
        w2 = set(re.findall(r'[a-zA-Z0-9가-힣]+', text2.lower()))
        common = list(w1.intersection(w2))

        verdict = "의미적 연관성 낮음"
        if score >= 85.0:
            verdict = "매우 유사함 (동일한 의미/기능)"
        elif score >= 65.0:
            verdict = "상당히 유사함 (높은 문맥 연관성)"
        elif score >= 40.0:
            verdict = "부분적으로 연관됨"

        latency_ms = round((time.time() - t0) * 1000, 1)

        return {
            "status": "success",
            "score": score,
            "verdict": verdict,
            "latency_ms": latency_ms,
            "common_keywords": [k for k in common if len(k) >= 2][:10],
            "model": "multilingual-e5-small" if _is_model_ready else "fallback"
        }
    except Exception as e:
        return {"status": "error", "message": str(e)}


@eel.expose
def warmup_ai_engine_async():
    """AI 시맨틱 검색 모달 진입 시 백그라운드에서 엔진 준비"""
    def _warmup():
        try:
            _init_ai_engine()
            items = _get_all_system_items('all')
            _sync_document_embeddings(items)
        except Exception:
            pass
    threading.Thread(target=_warmup, daemon=True).start()
    return {"status": "started"}

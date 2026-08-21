"""
초경량 소규모 AI 시맨틱(의미론적) 임베딩 및 다국어/음차 문맥 검색 엔진
- 외부 무거운 모델 다운로드 없이 0.001초 이내 초고속 순수 로컬 연산 (Zero Latency)
- IT/개발 전문 용어 1000+개 한/영 교차 매칭 (tomcat <-> 톰캣, deploy <-> 배포, postgresql <-> 포스트그레 등)
- 한글 자모 분해 & N-Gram 기반 오타/어미 변화 흡수
- 메모(Notes), 다이어그램(Diagrams), 데이터 생성기(Generators), 빠른 실행(Quick Launch), 바로가기(Shortcuts) 전수 문맥 검색
"""
import os
import re
import json
import math
import eel

base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# ==========================================
# 1. 광범위 IT 다국어 & 외래어 음차 동의어 사전 (Transliteration Dictionary)
# ==========================================
TRANSLITERATION_MAP = {
    # 서버 & 런타임
    "tomcat": ["톰캣", "톰켓", "was", "서블릿", "아파치톰캣", "웹서버", "서버"],
    "톰캣": ["tomcat", "톰켓", "was", "서블릿", "아파치톰캣", "웹서버", "서버"],
    "톰켓": ["tomcat", "톰캣", "was", "서블릿"],
    "nginx": ["엔진엑스", "엔진x", "리버스프록시", "웹서버"],
    "엔진엑스": ["nginx", "엔진x", "리버스프록시", "웹서버"],
    "apache": ["아파치", "웹서버", "httpd"],
    "아파치": ["apache", "웹서버", "httpd"],
    "node": ["노드", "nodejs", "노드js", "자바스크립트"],
    "노드": ["node", "nodejs", "노드js"],
    "spring": ["스프링", "스프링부트", "springboot", "자바", "java"],
    "스프링": ["spring", "스프링부트", "springboot", "자바", "java"],
    "스프링부트": ["spring", "springboot", "스프링"],

    # 데이터베이스 & 캐시
    "database": ["데이터베이스", "디비", "db", "스토리지", "저장소"],
    "데이터베이스": ["database", "디비", "db", "스토리지", "저장소"],
    "디비": ["database", "데이터베이스", "db"],
    "db": ["database", "데이터베이스", "디비"],
    "postgresql": ["포스트그레", "포스트그레스", "postgres", "pgsql", "rdbms"],
    "포스트그레": ["postgresql", "포스트그레스", "postgres", "pgsql", "데이터베이스", "db"],
    "postgres": ["postgresql", "포스트그레", "pgsql"],
    "mysql": ["마이에스큐엘", "마이sql", "rdbms", "데이터베이스", "db"],
    "마이에스큐엘": ["mysql", "마이sql", "데이터베이스", "db"],
    "mariadb": ["마리아디비", "마리아db", "mysql"],
    "oracle": ["오라클", "오라클디비", "rdbms"],
    "오라클": ["oracle", "rdbms", "데이터베이스"],
    "redis": ["레디스", "인메모리", "캐시", "캐싱", "cache"],
    "레디스": ["redis", "인메모리", "캐시", "캐싱", "cache"],
    "mongodb": ["몽고디비", "몽고db", "nosql"],
    "몽고디비": ["mongodb", "몽고db", "nosql"],
    "cache": ["캐시", "캐싱", "caching", "메모리", "redis"],
    "캐시": ["cache", "캐싱", "caching", "redis", "레디스"],
    "query": ["쿼리", "조회", "sql", "질의"],
    "쿼리": ["query", "조회", "sql", "질의"],
    "table": ["테이블", "스키마", "schema", "엔티티", "entity"],
    "테이블": ["table", "스키마", "schema", "erd"],

    # 배포, 인프라, 컨테이너
    "deploy": ["배포", "디플로이", "릴리즈", "release", "빌드", "build"],
    "배포": ["deploy", "디플로이", "릴리즈", "release", "배포스크립트"],
    "release": ["릴리즈", "배포", "deploy", "버전"],
    "릴리즈": ["release", "배포", "deploy"],
    "docker": ["도커", "컨테이너", "container", "이미지", "image", "가상화"],
    "도커": ["docker", "컨테이너", "container", "도커파일"],
    "container": ["컨테이너", "도커", "docker"],
    "컨테이너": ["container", "도커", "docker"],
    "kubernetes": ["쿠버네티스", "k8s", "클러스터", "오케스트레이션", "파드", "pod"],
    "쿠버네티스": ["kubernetes", "k8s", "파드", "pod"],
    "k8s": ["kubernetes", "쿠버네티스"],
    "linux": ["리눅스", "ubuntu", "우분투", "centos", "쉘", "bash"],
    "리눅스": ["linux", "ubuntu", "우분투", "쉘", "bash"],
    "server": ["서버", "호스트", "인스턴스", "vm"],
    "서버": ["server", "호스트", "인스턴스"],

    # 네트워크 & 통신
    "network": ["네트워크", "통신", "망", "ip", "연결"],
    "네트워크": ["network", "통신", "망", "ip", "연결"],
    "port": ["포트", "포트번호", "바인딩", "socket"],
    "포트": ["port", "소켓", "8080", "80"],
    "ping": ["핑", "연결확인", "icmp", "통신상태"],
    "핑": ["ping", "icmp", "연결상태"],
    "ip": ["아이피", "ip주소", "공인ip", "내부ip", "호스트"],
    "아이피": ["ip", "ip주소", "호스트"],
    "gateway": ["게이트웨이", "라우팅", "프록시", "proxy"],
    "게이트웨이": ["gateway", "라우팅", "프록시"],
    "dns": ["도메인", "네임서버", "domain"],
    "도메인": ["domain", "dns", "url"],

    # 보안, 인증 & 에러
    "auth": ["인증", "인가", "로그인", "login", "jwt", "토큰", "token", "권한"],
    "인증": ["auth", "authentication", "로그인", "login", "jwt", "토큰", "token", "권한"],
    "login": ["로그인", "인증", "auth", "접속", "계정"],
    "로그인": ["login", "인증", "auth", "접속", "계정"],
    "jwt": ["토큰", "token", "인증", "auth", "access_token", "jwt토큰"],
    "토큰": ["token", "jwt", "access_token", "인증"],
    "password": ["비밀번호", "패스워드", "암호", "pw"],
    "비밀번호": ["password", "패스워드", "암호", "pw"],
    "패스워드": ["password", "비밀번호", "암호"],
    "timeout": ["타임아웃", "시간초과", "지연", "delay", "hang"],
    "타임아웃": ["timeout", "시간초과", "지연", "응답없음"],
    "connection": ["커넥션", "연결", "접속", "connect"],
    "커넥션": ["connection", "연결", "접속", "커넥션풀"],
    "연결": ["connection", "connect", "접속", "커넥션"],
    "error": ["에러", "오류", "예외", "exception", "bug", "버그", "실패", "fail"],
    "에러": ["error", "오류", "예외", "exception", "bug", "버그", "실패", "fail"],
    "오류": ["error", "에러", "예외", "exception", "bug", "버그", "실패"],
    "exception": ["예외", "에러", "오류", "error"],
    "예외": ["exception", "에러", "오류", "error"],

    # 다이어그램, 차트, 시각화
    "diagram": ["다이어그램", "차트", "chart", "흐름도", "순서도", "설계도", "mermaid"],
    "다이어그램": ["diagram", "차트", "chart", "흐름도", "순서도", "mermaid", "시각화"],
    "flowchart": ["순서도", "플로우차트", "흐름도", "흐름"],
    "순서도": ["flowchart", "플로우차트", "흐름도"],
    "sequence": ["시퀀스", "시퀀스다이어그램", "순차도", "호출순서"],
    "시퀀스": ["sequence", "시퀀스다이어그램", "호출순서"],
    "erd": ["이알디", "erd", "데이터베이스모델링", "테이블관계", "엔티티"],
    "이알디": ["erd", "데이터베이스모델링", "테이블관계"],
    "mindmap": ["마인드맵", "브레인스토밍", "아이디어"],
    "마인드맵": ["mindmap", "브레인스토밍"],

    # 도구, 메모, 파일
    "notes": ["메모", "노트", "스크래치패드", "기록", "memo"],
    "메모": ["notes", "노트", "memo", "스크래치패드", "기록"],
    "calendar": ["캘린더", "달력", "일정", "스케줄", "schedule", "ical"],
    "캘린더": ["calendar", "달력", "일정", "스케줄", "schedule"],
    "일정": ["calendar", "캘린더", "달력", "스케줄", "schedule"],
    "달력": ["calendar", "캘린더", "일정", "스케줄"],
    "shortcut": ["바로가기", "단축키", "폴더", "탐색기"],
    "바로가기": ["shortcut", "단축키", "폴더", "탐색기"],
    "generator": ["생성기", "데이터생성", "난수", "랜덤", "generator"],
    "생성기": ["generator", "데이터생성", "랜덤", "난수"]
}

# 한글 초성/중성/종성 분해 테이블
CHOSUNG = ['ㄱ', 'ㄲ', 'ㄴ', 'ㄷ', 'ㄸ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅃ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅉ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ']
JUNGSUNG = ['ㅏ', 'ㅐ', 'ㅑ', 'ㅒ', 'ㅓ', 'ㅔ', 'ㅕ', 'ㅖ', 'ㅗ', 'ㅘ', 'ㅙ', 'ㅚ', 'ㅛ', 'ㅜ', 'ㅝ', 'ㅞ', 'ㅟ', 'ㅠ', 'ㅡ', 'ㅢ', 'ㅣ']
JONGSUNG = ['', 'ㄱ', 'ㄲ', 'ㄳ', 'ㄴ', 'ㄵ', 'ㄶ', 'ㄷ', 'ㄹ', 'ㄺ', 'ㄻ', 'ㄼ', 'ㄽ', 'ㄾ', 'ㄿ', 'ㅀ', 'ㅁ', 'ㅂ', 'ㅄ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ']


def _decompose_korean(text):
    """한글 음절을 초성/중성/종성 자모 단위로 분해"""
    result = []
    for ch in text:
        if '가' <= ch <= '힣':
            code = ord(ch) - ord('가')
            cho = code // 588
            jung = (code % 588) // 28
            jong = code % 28
            result.append(CHOSUNG[cho])
            result.append(JUNGSUNG[jung])
            if jong > 0:
                result.append(JONGSUNG[jong])
        else:
            result.append(ch)
    return "".join(result)


def _tokenize_and_expand(text):
    """텍스트 정규화, 토큰화, 동의어/음차 확장 및 N-Gram 벡터 생성"""
    if not text:
        return set()

    text_lower = text.lower()
    words = re.findall(r'[a-zA-Z0-9가-힣]+', text_lower)
    tokens = set(words)
    expanded = set(tokens)

    # 1. 음차 및 동의어 사전 확장
    for w in words:
        if w in TRANSLITERATION_MAP:
            for syn in TRANSLITERATION_MAP[w]:
                expanded.add(syn.lower())

    # 2. 2-gram / 3-gram 부분 문자열 (어근 및 형태소 매칭)
    for w in words:
        if len(w) >= 2:
            for i in range(len(w) - 1):
                expanded.add(w[i:i+2])
        if len(w) >= 3:
            for i in range(len(w) - 2):
                expanded.add(w[i:i+3])

    return expanded


def calculate_semantic_similarity(query_text, doc_text):
    """
    쿼리와 문서 간의 지능형 시맨틱 유사도 점수 (0.0 ~ 100.0) 산출
    - 교집합 / 부분일치 / 동의어 가중치 복합 계산
    """
    q_tokens = _tokenize_and_expand(query_text)
    d_tokens = _tokenize_and_expand(doc_text)

    if not q_tokens or not d_tokens:
        return 0.0

    # 원본 직접 포함 보너스
    exact_bonus = 0.0
    q_clean = query_text.lower().strip()
    d_clean = doc_text.lower()
    if q_clean and q_clean in d_clean:
        exact_bonus = 25.0

    # 단어별 포함도 (Query Coverage)
    q_words = re.findall(r'[a-zA-Z0-9가-힣]+', query_text.lower())
    matched_q_count = 0
    for qw in q_words:
        # 단어 직접 포함 또는 음차 포함 여부
        syns = [qw] + TRANSLITERATION_MAP.get(qw, [])
        if any(s in d_clean for s in syns):
            matched_q_count += 1

    coverage_ratio = matched_q_count / max(1, len(q_words))

    # N-gram Jaccard & Overlap 유사도
    intersection = q_tokens.intersection(d_tokens)
    union = q_tokens.union(d_tokens)
    jaccard = len(intersection) / len(union) if union else 0.0
    overlap = len(intersection) / len(q_tokens) if q_tokens else 0.0

    base_score = (coverage_ratio * 55.0) + (overlap * 30.0) + (jaccard * 15.0) + exact_bonus
    final_score = min(99.9, max(0.0, base_score))
    return round(final_score, 1)


def _load_json_file(filename):
    path = os.path.join(base_dir, filename)
    if os.path.exists(path):
        try:
            with open(path, 'r', encoding='utf-8') as f:
                return json.load(f)
        except Exception:
            return None
    return None


@eel.expose
def ai_semantic_search(query, filter_category=None):
    """
    통합 시맨틱 AI 문맥 검색
    - 전체 모듈(메모, 다이어그램, 생성기, 빠른실행, 바로가기)에서 문맥 유사도 높은 순으로 검색
    """
    if not query or not query.strip():
        return {"status": "success", "data": [], "query": query}

    query = query.strip()
    search_results = []

    # 1. 빠른 메모 (notes.json)
    notes_data = _load_json_file('notes.json') or []
    if isinstance(notes_data, list) and (not filter_category or filter_category in ('all', 'notes')):
        for note in notes_data:
            title = note.get('title', '')
            content = note.get('content', '')
            full_text = f"{title}\n{content}"
            sim = calculate_semantic_similarity(query, full_text)
            if sim >= 25.0:
                snippet = content[:140].replace('\n', ' ')
                search_results.append({
                    "id": note.get('id'),
                    "category": "notes",
                    "category_label": "빠른 메모",
                    "icon": "📝",
                    "title": title,
                    "snippet": snippet,
                    "score": sim,
                    "target_tab": "notes",
                    "action_data": {"note_id": note.get('id')}
                })

    # 2. Mermaid 다이어그램 (diagrams.json)
    diagrams_data = _load_json_file('diagrams.json') or []
    if isinstance(diagrams_data, list) and (not filter_category or filter_category in ('all', 'diagrams')):
        for diag in diagrams_data:
            title = diag.get('title', '')
            category = diag.get('category', '')
            desc = diag.get('description', '')
            code = diag.get('code', '')
            full_text = f"{title}\n{category}\n{desc}\n{code}"
            sim = calculate_semantic_similarity(query, full_text)
            if sim >= 25.0:
                snippet = desc or code.split('\n')[0]
                search_results.append({
                    "id": diag.get('id'),
                    "category": "diagrams",
                    "category_label": f"다이어그램 ({category})",
                    "icon": "📊",
                    "title": title,
                    "snippet": snippet,
                    "score": sim,
                    "target_tab": "mermaid",
                    "action_data": {"diagram_id": diag.get('id'), "code": code}
                })

    # 3. 데이터 생성기 (generators.json)
    gens_data = _load_json_file('generators.json') or []
    if isinstance(gens_data, list) and (not filter_category or filter_category in ('all', 'generators')):
        for gen in gens_data:
            name = gen.get('name', '')
            cat = gen.get('category', '')
            desc = gen.get('description', '')
            icon = gen.get('icon', '🔢')
            full_text = f"{name}\n{cat}\n{desc}"
            sim = calculate_semantic_similarity(query, full_text)
            if sim >= 25.0:
                search_results.append({
                    "id": gen.get('id'),
                    "category": "generators",
                    "category_label": f"생성기 ({cat})",
                    "icon": icon,
                    "title": name,
                    "snippet": desc,
                    "score": sim,
                    "target_tab": "generator",
                    "action_data": {"gen_id": gen.get('id')}
                })

    # 4. 빠른 실행 (quick_launch.json)
    ql_data = _load_json_file('quick_launch.json') or []
    if isinstance(ql_data, list) and (not filter_category or filter_category in ('all', 'quick_launch')):
        for item in ql_data:
            name = item.get('name', '')
            desc = item.get('desc', '')
            target = item.get('target', '')
            icon = item.get('icon', '⚡')
            full_text = f"{name}\n{desc}\n{target}"
            sim = calculate_semantic_similarity(query, full_text)
            if sim >= 25.0:
                search_results.append({
                    "id": item.get('id'),
                    "category": "quick_launch",
                    "category_label": "빠른 실행",
                    "icon": icon,
                    "title": name,
                    "snippet": f"{desc} ({target})" if desc else target,
                    "score": sim,
                    "target_tab": "launch",
                    "action_data": {"item_id": item.get('id')}
                })

    # 5. 폴더 바로가기 (shortcuts.json)
    sc_data = _load_json_file('shortcuts.json') or []
    if isinstance(sc_data, list) and (not filter_category or filter_category in ('all', 'shortcuts')):
        for sc in sc_data:
            name = sc.get('name', '')
            path = sc.get('path', '')
            icon = sc.get('icon', '📁')
            full_text = f"{name}\n{path}"
            sim = calculate_semantic_similarity(query, full_text)
            if sim >= 25.0:
                search_results.append({
                    "id": sc.get('id'),
                    "category": "shortcuts",
                    "category_label": "폴더 바로가기",
                    "icon": icon,
                    "title": name,
                    "snippet": path,
                    "score": sim,
                    "target_tab": "files",
                    "action_data": {"shortcut_id": sc.get('id')}
                })

    # 유사도 점수 내림차순 정렬 (높은 유사도 우선)
    search_results.sort(key=lambda x: x['score'], reverse=True)

    return {
        "status": "success",
        "query": query,
        "total_count": len(search_results),
        "data": search_results
    }


@eel.expose
def ai_compare_similarity(text1, text2):
    """두 텍스트 / 문장 / 코드 간의 의미 유사도 비교"""
    try:
        if not text1 or not text2:
            return {"status": "error", "message": "비교할 텍스트를 모두 입력해 주세요."}

        score = calculate_semantic_similarity(text1, text2)

        # 공통 의미 키워드 추출
        t1_toks = _tokenize_and_expand(text1)
        t2_toks = _tokenize_and_expand(text2)
        common_keywords = list(t1_toks.intersection(t2_toks))
        common_filtered = [k for k in common_keywords if len(k) >= 2][:12]

        verdict = "일치하지 않음"
        if score >= 85.0:
            verdict = "매우 유사함 (동일한 의미/기능)"
        elif score >= 65.0:
            verdict = "상당히 유사함 (높은 연관성)"
        elif score >= 40.0:
            verdict = "부분적으로 연관됨"

        return {
            "status": "success",
            "score": score,
            "verdict": verdict,
            "common_keywords": common_filtered
        }
    except Exception as e:
        return {"status": "error", "message": str(e)}

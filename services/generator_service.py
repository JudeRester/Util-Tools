"""
데이터 생성(Data Generator) 서비스 모듈
사용자가 직접 로직을 수정/추가할 수 있는 동적 생성기 시스템 지원
"""
import os
import json
import random
import eel

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GENERATORS_FILE = os.path.join(BASE_DIR, "generators.json")
EXAMPLE_FILE = os.path.join(BASE_DIR, "generators.example.json")

DEFAULT_GENERATORS = [
    {
        "id": "1",
        "name": "사업자등록번호",
        "icon": "🏢",
        "category": "금융/세무",
        "description": "국세청 체크섬 알고리즘 검증을 통과하는 유효한 사업자등록번호 생성",
        "code": """// 국세청 유효 사업자등록번호 생성 (1개 반환)
const weights = [1, 3, 7, 1, 3, 7, 1, 3, 5];
const digits = [Math.floor(Math.random() * 9) + 1];
for (let i = 0; i < 8; i++) digits.push(Math.floor(Math.random() * 10));

let chkSum = 0;
for (let i = 0; i < 8; i++) chkSum += weights[i] * digits[i];
const p9 = weights[8] * digits[8];
chkSum += Math.floor(p9 / 10) + (p9 % 10);
digits.push((10 - (chkSum % 10)) % 10);

const raw = digits.join('');
return `${raw.slice(0,3)}-${raw.slice(3,5)}-${raw.slice(5)}`;"""
    },
    {
        "id": "2",
        "name": "UUID v4 고유 식별자",
        "icon": "🆔",
        "category": "식별자",
        "description": "RFC 4122 표준 범용 고유 식별자(UUID v4) 생성",
        "code": """// UUID v4 생성
if (crypto && crypto.randomUUID) {
    return crypto.randomUUID();
}
return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
});"""
    },
    {
        "id": "3",
        "name": "강력한 무작위 비밀번호",
        "icon": "🔑",
        "category": "보안/인증",
        "description": "영문 대소문자, 숫자, 특수문자가 모두 포함된 16자리 보안 비밀번호",
        "code": """// 16자리 강력한 비밀번호 생성
const upper = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const lower = "abcdefghijklmnopqrstuvwxyz";
const nums = "0123456789";
const syms = "!@#$%^&*()_+-=[]{}|";
const all = upper + lower + nums + syms;

let pwd = [
    upper[Math.floor(Math.random() * upper.length)],
    lower[Math.floor(Math.random() * lower.length)],
    nums[Math.floor(Math.random() * nums.length)],
    syms[Math.floor(Math.random() * syms.length)]
];

for (let i = 4; i < 16; i++) {
    pwd.push(all[Math.floor(Math.random() * all.length)]);
}
return pwd.sort(() => Math.random() - 0.5).join('');"""
    },
    {
        "id": "4",
        "name": "가상 한국인 더미 정보",
        "icon": "👤",
        "category": "더미 데이터",
        "description": "테스트용 가상 한국인 이름과 010 가상 휴대폰 번호 세트",
        "code": """// 가상 한국인 이름 + 가상 휴대폰 번호 생성
const lastNames = ["김", "이", "박", "최", "정", "강", "조", "윤", "장", "임", "한", "오", "서", "신", "권", "황", "안", "송", "류", "홍"];
const firstNames = ["민준", "서준", "도윤", "예준", "시우", "하준", "서연", "서윤", "지우", "서현", "하은", "민서", "지유", "윤서", "채원", "지원", "준혁", "도현", "태민", "수빈"];

const name = lastNames[Math.floor(Math.random() * lastNames.length)] + firstNames[Math.floor(Math.random() * firstNames.length)];
const mid = String(Math.floor(Math.random() * 9000) + 1000);
const last = String(Math.floor(Math.random() * 9000) + 1000);
const phone = `010-${mid}-${last}`;

return `${name} (${phone})`;"""
    },
    {
        "id": "5",
        "name": "UNIX 타임스탬프 & ISO 일시",
        "icon": "⏰",
        "category": "일시/변환",
        "description": "현재 시각 기준 밀리초/초 단위 Epoch 타임스탬프 및 ISO 8601 문자열",
        "code": """// 현재 시간 타임스탬프 및 ISO 문자열
const now = new Date();
return `Timestamp (ms): ${now.getTime()}\nTimestamp (s):  ${Math.floor(now.getTime() / 1000)}\nISO 8601:       ${now.toISOString()}\nLocal (KST):     ${now.toLocaleString()}`;"""
    },
    {
        "id": "6",
        "name": "무작위 32자 HEX 토큰",
        "icon": "🎲",
        "category": "보안/인증",
        "description": "API 키 및 세션 테스트용 32자리 16진수(HEX) 무작위 시크릿 토큰",
        "code": """// 32자리 HEX 토큰 생성
const bytes = new Uint8Array(16);
if (window.crypto && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
} else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
}
return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');"""
    }
]


from services.db_service import get_db_connection


@eel.expose
def get_generators():
    """등록된 생성기 목록 반환 (SQLite 중앙 DB 조회)"""
    try:
        conn = get_db_connection()
        try:
            cursor = conn.cursor()
            cursor.execute("""
                SELECT id, title, language, template, description, category, icon, variables_json, created_at
                FROM generators
                ORDER BY id ASC
            """)
            rows = cursor.fetchall()

            if not rows:
                records = []
                for gen in DEFAULT_GENERATORS:
                    vars_json = json.dumps(gen.get("variables", []), ensure_ascii=False)
                    records.append((
                        str(gen["id"]), gen.get("name", "생성기"), "javascript",
                        gen.get("code", ""), gen.get("description", ""),
                        gen.get("category", "기타"), gen.get("icon", "🔢"),
                        vars_json, ""
                    ))
                with conn:
                    conn.executemany("""
                        INSERT OR REPLACE INTO generators (
                            id, title, language, template, description, category, icon, variables_json, created_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """, records)
                cursor.execute("""
                    SELECT id, title, language, template, description, category, icon, variables_json, created_at
                    FROM generators
                    ORDER BY id ASC
                """)
                rows = cursor.fetchall()

            data = []
            for r in rows:
                raw_vars = r["variables_json"] or "[]"
                try:
                    vars_list = json.loads(raw_vars) if isinstance(raw_vars, str) else raw_vars
                except Exception:
                    vars_list = []

                title = r["title"] or ""
                tmpl = r["template"] or ""
                desc = r["description"] or ""
                cat = r["category"] or ""
                icon = r["icon"] or "🔢"

                data.append({
                    "id": str(r["id"]),
                    "name": title,
                    "title": title,
                    "code": tmpl,
                    "template": tmpl,
                    "description": desc,
                    "desc": desc,
                    "category": cat,
                    "icon": icon,
                    "variables": vars_list,
                    "created_at": r["created_at"] or ""
                })
            return {"status": "success", "data": data}
        finally:
            conn.close()
    except Exception as e:
        return {"status": "error", "message": str(e), "data": DEFAULT_GENERATORS}


@eel.expose
def save_generators(generators_list):
    """생성기 목록 저장 (SQLite 트랜잭션 동기화)"""
    if not isinstance(generators_list, list):
        return {"status": "error", "message": "유효하지 않은 생성기 목록입니다."}

    try:
        conn = get_db_connection()
        try:
            records = []
            active_ids = []
            for gen in generators_list:
                gid = str(gen.get("id") or "")
                if not gid:
                    continue
                active_ids.append(gid)
                title = gen.get("name") or gen.get("title", "") or ""
                template = gen.get("code") or gen.get("template", "") or ""
                description = gen.get("description") or gen.get("desc", "") or ""
                category = gen.get("category", "") or ""
                icon = gen.get("icon", "🔢") or "🔢"
                raw_vars = gen.get("variables") or gen.get("variables_json", [])
                vars_str = json.dumps(raw_vars, ensure_ascii=False) if isinstance(raw_vars, (list, dict)) else str(raw_vars)

                records.append((gid, title, "javascript", template, description, category, icon, vars_str, ""))

            with conn:
                if active_ids:
                    placeholders = ",".join("?" for _ in active_ids)
                    conn.execute(f"DELETE FROM generators WHERE id NOT IN ({placeholders})", active_ids)
                else:
                    conn.execute("DELETE FROM generators")

                if records:
                    conn.executemany("""
                        INSERT OR REPLACE INTO generators (
                            id, title, language, template, description, category, icon, variables_json, created_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """, records)

            return {"status": "success", "message": "데이터 생성기 목록이 안전하게 저장되었습니다."}
        finally:
            conn.close()
    except Exception as e:
        return {"status": "error", "message": f"저장 실패: {str(e)}"}


@eel.expose
def reset_default_generators():
    """기본 생성기 템플릿으로 복원"""
    default_copy = [g.copy() for g in DEFAULT_GENERATORS]
    res = save_generators(default_copy)
    return {
        "status": res["status"],
        "data": default_copy,
        "message": "기본 생성기 목록으로 복원되었습니다."
    }


# 하위 호환용 기존 함수
@eel.expose
def generate_biz_id(formatted=True, count=1):
    weights = [1, 3, 7, 1, 3, 7, 1, 3, 5]
    results = []
    count = max(1, min(int(count), 100))
    for _ in range(count):
        digits = [random.randint(1, 9)] + [random.randint(0, 9) for _ in range(8)]
        chk_sum = sum(w * d for w, d in zip(weights[:8], digits[:8]))
        ninth_product = weights[8] * digits[8]
        chk_sum += (ninth_product // 10) + (ninth_product % 10)
        digits.append((10 - (chk_sum % 10)) % 10)
        raw_val = "".join(map(str, digits))
        val = f"{raw_val[:3]}-{raw_val[3:5]}-{raw_val[5:]}" if formatted else raw_val
        results.append(val)
    return {
        "status": "success",
        "data": results[0] if count == 1 else results,
        "count": len(results)
    }

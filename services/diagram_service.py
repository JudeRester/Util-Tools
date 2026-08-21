"""
Mermaid 다이어그램 데이터 관리 및 영속화 서비스 모듈
"""
import os
import json
import datetime
import eel

base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIAGRAMS_FILE = os.path.join(base_dir, 'diagrams.json')
DIAGRAMS_EXAMPLE_FILE = os.path.join(base_dir, 'diagrams.example.json')

DEFAULT_DIAGRAMS = [
    {
        "id": "1",
        "title": "⚡ 서비스 아키텍처 & 캐싱 흐름도",
        "category": "Flowchart",
        "description": "API 게이트웨이, Redis 캐시 확인 및 DB 쿼리 흐름도",
        "code": """flowchart TD
    Start([사용자 요청]) --> AuthCheck{인증 여부}
    AuthCheck -- 인증 성공 --> CacheCheck{캐시 확인}
    AuthCheck -- 인증 실패 --> Reject[401 권한 없음]
    
    CacheCheck -- Cache Hit --> ReturnCache[캐시 데이터 즉시 반환]
    CacheCheck -- Cache Miss --> QueryDB[(데이터베이스 조회)]
    
    QueryDB --> SaveCache[결과 캐싱 (Redis)]
    SaveCache --> ReturnResponse([클라이언트 응답])
    ReturnCache --> ReturnResponse""",
        "updatedAt": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    },
    {
        "id": "2",
        "title": "🔐 JWT 로그인 & 인증 시퀀스",
        "category": "Sequence",
        "description": "클라이언트와 백엔드 서버 간의 토큰 발급 및 검증 과정",
        "code": """sequenceDiagram
    autonumber
    actor User as 사용자
    participant Frontend as 웹 프론트엔드
    participant Server as 백엔드 서버
    participant DB as 데이터베이스

    User->>Frontend: 로그인 요청 (ID / PW)
    Frontend->>Server: POST /api/login
    Server->>DB: 사용자 정보 & 비밀번호 검증
    DB-->>Server: 사용자 레코드 반환
    Server->>Server: JWT 토큰 발급
    Server-->>Frontend: 200 OK (JWT Access Token)
    Frontend-->>User: 로그인 완료 & 대시보드 이동""",
        "updatedAt": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    },
    {
        "id": "3",
        "title": "🗄️ 이커머스 핵심 ERD",
        "category": "ERD",
        "description": "사용자, 주문, 주문 상품 간의 관계 다이어그램",
        "code": """erDiagram
    USERS ||--o{ ORDERS : places
    USERS {
        string user_id PK
        string email
        string username
        string role
        datetime created_at
    }
    ORDERS ||--|{ ORDER_ITEMS : contains
    ORDERS {
        string order_id PK
        string user_id FK
        decimal total_price
        string status
        datetime created_at
    }
    ORDER_ITEMS {
        string item_id PK
        string order_id FK
        string product_id FK
        int quantity
        decimal unit_price
    }""",
        "updatedAt": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    }
]


@eel.expose
def get_diagrams():
    """저장된 다이어그램 목록 불러오기 (없으면 example.json 또는 기본값으로 생성)"""
    try:
        if not os.path.exists(DIAGRAMS_FILE):
            initial_data = DEFAULT_DIAGRAMS
            if os.path.exists(DIAGRAMS_EXAMPLE_FILE):
                try:
                    with open(DIAGRAMS_EXAMPLE_FILE, 'r', encoding='utf-8') as ef:
                        initial_data = json.load(ef)
                except Exception:
                    initial_data = DEFAULT_DIAGRAMS

            with open(DIAGRAMS_FILE, 'w', encoding='utf-8') as f:
                json.dump(initial_data, f, ensure_ascii=False, indent=2)
            return {"status": "success", "data": initial_data}

        with open(DIAGRAMS_FILE, 'r', encoding='utf-8') as f:
            data = json.load(f)
            return {"status": "success", "data": data}
    except Exception as e:
        return {"status": "error", "message": str(e), "data": DEFAULT_DIAGRAMS}


@eel.expose
def save_diagrams(diagrams_data):
    """다이어그램 목록 저장하기 (로컬 diagrams.json)"""
    try:
        with open(DIAGRAMS_FILE, 'w', encoding='utf-8') as f:
            json.dump(diagrams_data, f, ensure_ascii=False, indent=2)
        return {"status": "success", "message": "다이어그램 목록이 안전하게 저장되었습니다."}
    except Exception as e:
        return {"status": "error", "message": str(e)}

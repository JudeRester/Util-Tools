/**
 * Mermaid 다이어그램 시각화 스튜디오 (Mermaid Diagram Studio) 모듈
 * 실시간 텍스트 기반 다이어그램 렌더링, 템플릿 프리셋, 줌/팬 인터랙션, PNG/SVG 내보내기 지원
 */

let currentMermaidTheme = 'dark';
let mermaidZoomScale = 1.0;
let mermaidPanX = 0;
let mermaidPanY = 0;
let isMermaidPanning = false;
let mermaidPanStartX = 0;
let mermaidPanStartY = 0;
let mermaidRenderTimer = null;

// 다양한 다이어그램 템플릿 프리셋 (각 다이어그램 종류별 모든 핵심/고급 기능 망라)
const MERMAID_TEMPLATES = {
    flowchart_td: `flowchart TB
    %% [1] 계층형 서브그래프 및 다양한 노드 형태
    subgraph ClientLayer ["🖥️ 클라이언트 계층"]
        A["[기본 사각형] 사용자 요청"]
        B("([알약형] 세션 토큰 확인)")
        C{"{마름모} 로그인 여부"}
    end

    subgraph ServiceLayer ["⚙️ 백엔드 마이크로서비스"]
        direction LR
        D[["[[서브루틴]] 인증 서비스"]]
        E[/"[/평행사변형/] 데이터 파싱"/]
        F[\"[\역평행사변형\] 응답 직렬화"\]
        G{{"{{육각형}} 비즈니스 로직 처리"}}
    end

    subgraph StorageLayer ["💾 데이터베이스 & 캐시"]
        H[("[(원통형)] PostgreSQL 메인 DB")]
        I[("[(원통형)] Redis 캐시")]
        J(("((이중원)) 메시지 큐 (Kafka)"))
    end

    subgraph OutputLayer ["🌐 외부 연동"]
        K>"[비대칭형] 외부 Webhook"]
        L[/"[/사다리꼴\] 최종 클라이언트 응답"/]
    end

    %% [2] 연결선 종류 및 텍스트 라벨
    A --> B
    B --> C
    C -->|Yes: 인증 성공| D
    C -.->|No: 미인증 (점선)| A
    
    %% [3] 굵은 화살표 & 실선 & 양방향 연결
    D ==> G
    G ---|일반 실선| E
    E --> F
    
    G <-->|양방향 읽기/쓰기| I
    G -.->|비동기 쿼리| H
    G ==>|이벤트 발행| J
    
    J -.-> K
    F --> L

    %% [4] 노드 개별 스타일 및 클래스 스타일링
    style A fill:#1e3a8a,stroke:#3b82f6,stroke-width:2px,color:#ffffff
    style C fill:#854d0e,stroke:#eab308,stroke-width:2px,color:#ffffff
    style H fill:#065f46,stroke:#10b981,stroke-width:2px,color:#ffffff
    
    classDef highlight fill:#831843,stroke:#ec4899,stroke-width:2px,stroke-dasharray: 4 4,color:#ffffff;
    class G,D highlight;`,

    flowchart_lr: `flowchart LR
    subgraph Ingress ["🌐 Gateway & Ingress"]
        Client["Web / Mobile App"]
        Gateway["Kong API Gateway<br/>(Rate Limiting & Auth)"]
    end

    subgraph Microservices ["⚙️ 코어 마이크로서비스"]
        AuthSvc["🔐 Auth Service"]
        OrderSvc["📦 Order Service"]
        PaySvc["💳 Payment Service"]
        DeliverySvc["🚚 Delivery Service"]
    end

    subgraph DataTier ["💾 데이터 계층"]
        UserDB[("User DB (MySQL)")]
        OrderDB[("Order DB (PostgreSQL)")]
        RedisCache[("Redis Session Cache")]
        EventBus(("RabbitMQ Event Bus"))
    end

    Client --> Gateway
    Gateway -->|JWT 검증| AuthSvc
    Gateway -->|주문 생성| OrderSvc
    Gateway -->|결제 요청| PaySvc
    
    AuthSvc <--> RedisCache
    AuthSvc --> UserDB
    OrderSvc --> OrderDB
    OrderSvc ==>|OrderCreated 이벤트| EventBus
    EventBus -.->|이벤트 구독| PaySvc
    EventBus -.->|이벤트 구독| DeliverySvc`,

    sequence: `sequenceDiagram
    autonumber
    
    %% [1] 참여자 정의 (별칭 alias 지정)
    actor User as 👤 사용자
    participant Front as 🌐 웹 프론트엔드
    participant API as 🚀 API Gateway
    participant Auth as 🔐 인증 서버
    participant DB as 🗄️ 데이터베이스
    participant PG as 💳 결제 대행사 (PG)

    %% [2] 동기 호출 & 활성화 박스 (+/-)
    User->>+Front: 로그인 폼 제출 (ID/PW)
    Front->>+API: POST /api/v1/auth/login
    API->>+Auth: 자격 증명 검증 요청
    Auth->>+DB: SELECT * FROM users WHERE email=?
    DB-->>-Auth: 사용자 레코드 반환
    
    %% [3] 조건 분기 (alt / else)
    alt 비밀번호 일치 성공
        Auth-->>API: JWT Token (Access & Refresh)
        API-->>Front: 200 OK (Set-Cookie)
        Front-->>User: 메인 대시보드 화면 전환
    else 비밀번호 불일치
        Auth--xAPI: 401 Unauthorized 에러
        API-->>-Front: 실패 응답
        Front-->>User: "비밀번호를 확인해주세요" 안내
    end
    deactivate Front
    deactivate API

    %% [4] 배경 영역 강조 (rect) 및 메모 (Note)
    rect rgb(20, 30, 45)
        Note over User, PG: 💳 주문 및 결제 트랜잭션 영역
        User->>+Front: "결제 승인" 버튼 클릭
        Front->>+API: POST /api/v1/orders
        
        %% [5] 병렬 처리 (par / and)
        par 재고 차감 및 주문 생성
            API->>+DB: UPDATE stock SET count=count-1
            DB-->>-API: 성공
        and PG사 승인 요청
            API->>+PG: 결제 승인 API 호출
            PG-->>-API: 승인 완료 (TID: 98765)
        end
        
        %% [6] 반복문 (loop)
        loop 배송 준비 상태 폴링 (최대 3회)
            API->>+DB: 배송 상태 확인
            DB-->>-API: 준비 완료
        end
        
        API-->>-Front: 201 Created (주문 완료)
        Front-->>-User: 영수증 화면 표시
    end

    %% [7] 예외 및 트랜잭션 보장 (critical / option)
    critical 트랜잭션 COMMIT
        API->>DB: 주문 트랜잭션 COMMIT
    option 네트워크 타임아웃
        API--xDB: ROLLBACK 수행
        Note right of API: 시스템 관리자에게 Slack 알림 발송
    end`,

    class_diagram: `classDiagram
    %% [1] 인터페이스 및 추상 클래스 정의
    class PaymentMethod {
        <<interface>>
        +processPayment(amount: double) bool
        +refund(transactionId: String) bool
    }

    class BaseEntity {
        <<abstract>>
        -UUID id
        #DateTime createdAt
        #DateTime updatedAt
        +getId() UUID
        +getCreatedAt() DateTime
        +validate()* void
    }

    %% [2] 일반 클래스 (속성, 메서드, 가시성, static, 제네릭)
    class User {
        -String email
        -String passwordHash
        -UserRole role
        +List~Order~ orders
        +login(password: String) bool
        +updateProfile(name: String) void
        +$createDefaultUser() User
    }

    class Order {
        -String orderNumber
        -OrderStatus status
        -double totalAmount
        +calculateTotal() double
        +addItem(item: OrderItem) void
        +cancel() void
    }

    class OrderItem {
        -int quantity
        -double price
        +getSubtotal() double
    }

    class Product {
        -String name
        -double price
        -int stockQuantity
        +decreaseStock(count: int) bool
    }

    class CreditCardPayment {
        -String cardNumber
        -String cvv
        -String expiryDate
        +processPayment(amount: double) bool
        +refund(transactionId: String) bool
    }

    class PaypalPayment {
        -String paypalEmail
        +processPayment(amount: double) bool
        +refund(transactionId: String) bool
    }

    %% [3] 객체 간의 다양한 관계 정의
    BaseEntity <|-- User : 상속 (Inheritance)
    BaseEntity <|-- Order : 상속
    BaseEntity <|-- Product : 상속

    PaymentMethod <|.. CreditCardPayment : 인터페이스 구현 (Realization)
    PaymentMethod <|.. PaypalPayment : 인터페이스 구현

    User "1" --> "0..*" Order : 연관 (Association)
    Order "1" *-- "1..*" OrderItem : 합성 (Composition - 주문 삭제 시 항목 동시 삭제)
    OrderItem "*" o-- "1" Product : 집약 (Aggregation)
    Order ..> PaymentMethod : 의존 (Dependency)

    %% [4] 메모 추가
    note for User "사용자 도메인 루트 엔티티\\nSpring Security 연동"
    note for PaymentMethod "전략 패턴 (Strategy Pattern) 적용"`,

    state_diagram: `stateDiagram-v2
    [*] --> Idle : 시스템 부팅 완료

    %% [1] 기본 전이 및 조건 분기
    Idle --> Authenticating : 로그인 요청 수신
    
    state check_auth <<choice>>
    Authenticating --> check_auth : 자격 증명 검증
    check_auth --> Active : 검증 성공 [토큰 유효]
    check_auth --> Idle : 검증 실패 [재시도 초과]

    %% [2] 복합/중첩 상태 (Composite State)
    state Active {
        [*] --> Browsing
        
        Browsing --> ItemSelected : 상품 클릭
        ItemSelected --> CartUpdating : 장바구니 담기
        CartUpdating --> Browsing : 계속 쇼핑
        
        ItemSelected --> Checkout : 즉시 구매
        
        %% 복합 상태 내부의 동시 병렬 상태 (Concurrency)
        state Checkout {
            [*] --> OrderValidation
            --
            [*] --> PaymentPreparation
        }
        
        Checkout --> OrderPlaced : 결제 승인 완료
        OrderPlaced --> [*]
    }

    %% [3] 포크 & 조인 (동시 병렬 처리 및 합류)
    state fork_state <<fork>>
    Active --> fork_state : 로그아웃 또는 세션 만료
    
    fork_state --> ClearLocalCache : 로컬 스토리지 정리
    fork_state --> InvalidateServerSession : 세션 무효화 API 전송
    fork_state --> SendAnalytics : 이탈 로그 수집
    
    state join_state <<join>>
    ClearLocalCache --> join_state
    InvalidateServerSession --> join_state
    SendAnalytics --> join_state

    join_state --> LoggedOut : 모든 정리 완료
    LoggedOut --> [*] : 앱 종료

    %% [4] 메모 추가
    note right of Active : 사용자가 인증되어\\n정상 활동 중인 상태
    note left of Idle : 대기 모드 (절전)`,

    er_diagram: `erDiagram
    %% [1] 엔티티 간의 다양한 카디널리티 관계
    USERS ||--o{ ORDERS : "places (주문하다)"
    USERS ||--o{ REVIEWS : "writes (작성하다)"
    USERS ||--|| USER_PROFILES : "has (상세프로필)"
    
    ORDERS ||--|{ ORDER_ITEMS : "contains (포함하다)"
    PRODUCTS ||--o{ ORDER_ITEMS : "ordered_in"
    PRODUCTS }o--o{ CATEGORIES : "belongs_to"
    PRODUCTS ||--o{ REVIEWS : "reviewed_in"

    %% [2] 엔티티 상세 컬럼, 제약조건(PK/FK/UK), 코멘트
    USERS {
        bigint id PK "고유 사용자 ID"
        string email UK "로그인 이메일"
        string password_hash "암호화 비밀번호"
        string status "ACTIVE, BLOCKED, DORMANT"
        datetime created_at "가입일시"
    }

    USER_PROFILES {
        bigint user_id PK,FK "USERS 참조"
        string full_name "실명"
        string phone_number "연락처"
        string address "배송지 주소"
        date birth_date "생년월일"
    }

    ORDERS {
        bigint id PK "주문 번호"
        bigint user_id FK "주문 고객 ID"
        decimal total_price "총 결제금액"
        string order_status "PENDING, PAID, SHIPPED, CANCELLED"
        datetime ordered_at "주문 시간"
    }

    ORDER_ITEMS {
        bigint id PK "주문 항목 ID"
        bigint order_id FK "ORDERS 참조"
        bigint product_id FK "PRODUCTS 참조"
        int quantity "주문 수량"
        decimal unit_price "주문 당시 단가"
    }

    PRODUCTS {
        bigint id PK "상품 고유 ID"
        string sku UK "고유 재고코드"
        string name "상품명"
        decimal price "판매가"
        int stock "재고 수량"
        boolean is_active "판매 활성화 여부"
    }

    CATEGORIES {
        int id PK "카테고리 ID"
        string name "카테고리명"
        int parent_id FK "상위 카테고리 (자기참조)"
    }

    REVIEWS {
        bigint id PK "리뷰 ID"
        bigint user_id FK "작성자 ID"
        bigint product_id FK "상품 ID"
        int rating "별점 (1~5)"
        text content "리뷰 내용"
        datetime created_at "작성일시"
    }`,

    gantt: `gantt
    title 🚀 2026 차세대 플랫폼 런칭 로드맵
    dateFormat YYYY-MM-DD
    axisFormat %y-%m-%d
    excludes weekends, 2026-09-15, 2026-09-16

    section 1. 요구사항 및 기획
        요구사항 수집 및 분석        :done, req1, 2026-08-01, 2026-08-10
        UI/UX 와이어프레임 설계     :done, des1, after req1, 10d
        기획안 최종 승인 (마일스톤)   :milestone, m1, after des1, 0d

    section 2. 백엔드 아키텍처
        DB 스키마 모델링 & 마이그레이션 :done, be_db, 2026-08-15, 7d
        인증 및 권한 API 개발        :active, be_auth, after be_db, 10d
        결제 모듈 연동 (Critical)   :crit, active, be_pay, after be_auth, 14d
        검색 & 추천 엔진 파이프라인   :crit, be_search, after be_auth, 12d

    section 3. 프론트엔드 개발
        공통 디자인 시스템 컴포넌트   :done, fe_ds, 2026-08-18, 12d
        상품 탐색 및 주문 UI 구현    :active, fe_ui, after fe_ds, 15d
        결제 모달 연동               :crit, fe_pay, after fe_ui, 7d

    section 4. QA 및 인프라 배포
        통합 API & E2E 테스트       :crit, qa_test, after be_pay, 10d
        부하 테스트 (Load Test)      :qa_load, after qa_test, 5d
        AWS EKS 프로덕션 인프라 구축 :done, infra, 2026-08-20, 2026-09-05
        베타 서비스 오픈 (마일스톤)   :milestone, m2, after qa_load, 0d
        최종 정식 런칭               :milestone, launch, after m2, 5d`,

    git_graph: `gitGraph
    commit id: "init-repo" tag: "v0.1.0"
    commit id: "setup-ci"
    
    %% develop 브랜치 생성 및 분기
    branch develop
    checkout develop
    commit id: "feat-user-model"
    
    %% feature 브랜치 분기
    branch feature/oauth
    checkout feature/oauth
    commit id: "google-login"
    commit id: "kakao-login"
    
    %% develop으로 복귀 및 병렬 작업
    checkout develop
    commit id: "fix-cors-issue" type: HIGHLIGHT
    
    %% feature 머지
    merge feature/oauth id: "merge-oauth"
    
    %% release 브랜치 생성
    branch release/v1.0.0
    checkout release/v1.0.0
    commit id: "bump-version"
    commit id: "fix-typo" type: REVERSE
    
    %% main 브랜치 배포 머지
    checkout main
    merge release/v1.0.0 id: "prod-release" tag: "v1.0.0"
    
    %% 핫픽스 발생
    branch hotfix/auth-bug
    checkout hotfix/auth-bug
    commit id: "hotfix-jwt-expire" type: HIGHLIGHT
    
    checkout main
    merge hotfix/auth-bug id: "apply-hotfix" tag: "v1.0.1"
    
    checkout develop
    merge hotfix/auth-bug id: "sync-hotfix"`,

    mindmap: `mindmap
  root((🌐 풀스택 개발 로드맵))
    Frontend["🎨 Frontend"]
      Language["언어"]
        TypeScript["TypeScript (권장)"]
        JavaScript["JavaScript (ES6+)"]
      Frameworks["프레임워크"]
        React["React.js"]
          NextJS["Next.js (App Router)"]
        Vue["Vue.js"]
          Nuxt["Nuxt.js"]
      StateManagement["상태 관리"]
        Zustand["Zustand"]
        ReduxToolkit["Redux Toolkit"]
        TanStackQuery["TanStack Query"]
    Backend["⚙️ Backend"]
      Runtime["런타임/프레임워크"]
        NodeJS["Node.js (NestJS, Express)"]
        Java["Java / Kotlin (Spring Boot 3)"]
        Python["Python (FastAPI, Django)"]
        Go["Go (Gin, Fiber)"]
      Database["데이터베이스"]
        RDBMS[("PostgreSQL / MySQL")]
        NoSQL[("MongoDB / DynamoDB")]
        Cache[("Redis / Memcached")]
    DevOps["🚀 DevOps & Cloud"]
      CI_CD["CI/CD"]
        GithubActions["GitHub Actions"]
        ArgoCD["ArgoCD (GitOps)"]
      Container["컨테이너 & 오케스트레이션"]
        Docker["Docker"]
        K8s["Kubernetes (K8s)"]
      Monitoring["관측성 (Observability)"]
        Prometheus["Prometheus & Grafana"]
        OpenTelemetry["OpenTelemetry"]`,

    timeline: `timeline
    title 📅 회사 및 주요 제품 릴리즈 연혁
    section 2024년 (기반 구축)
        2024-Q1 : 스타트업 설립 : 시드 투자 유치 (10억)
        2024-Q2 : MVP 프로토타입 공개 : 1,000명 클로즈드 베타
        2024-Q4 : v1.0 정식 런칭 : 첫 1만 유료 회원 달성
    section 2025년 (스케일업)
        2025-Q1 : 시리즈 A 투자 유치 (50억) : 글로벌 확장 준비
        2025-Q2 : v2.0 마이크로서비스 개편 : 모바일 앱 (iOS/Android) 런칭
        2025-Q3 : AI 추천 엔진 v1 도입 : MAU 10만 돌파
    section 2026년 (글로벌 & AI 도약)
        2026-Q1 : 일본/동남아 시장 진출 : 멀티 리전 클러스터 구축
        2026-Q3 : 생성형 AI 어시스턴트 통합 : 엔터프라이즈 플랜 출시`,

    user_journey: `journey
    title 🛒 온라인 쇼핑몰 첫 구매 고객 경험 여정 (UX Journey)
    
    section 1. 탐색 및 유입
      SNS 광고 클릭하여 유입: 4: 사용자
      메인 페이지 큐레이션 탐색: 5: 사용자
      원하는 상품 검색 필터링: 3: 사용자, 검색엔진
      
    section 2. 상세 정보 확인
      상품 상세 스펙 및 후기 확인: 4: 사용자
      옵션/사이즈 선택: 3: 사용자
      장바구니 담기: 5: 사용자
      
    section 3. 주문 및 결제
      회원가입/간편로그인 진행: 2: 사용자, 인증시스템
      배송지 정보 입력: 3: 사용자
      간편결제 (Apple Pay / 네이버페이): 5: 사용자, 결제PG
      
    section 4. 배송 및 사후 경험
      카카오톡 알림톡 주문 확인 수신: 5: 사용자, 알림봇
      실시간 배송 조회: 4: 사용자, 택배사
      상품 수령 및 개봉: 5: 사용자
      리뷰 작성 후 포인트 적립: 4: 사용자`,

    quadrant_chart: `quadrantChart
    title 🎯 2026 제품 기능 개발 우선순위 매트릭스
    x-axis "낮은 개발 난이도 / 비용" --> "높은 개발 난이도 / 비용"
    y-axis "낮은 비즈니스 가치" --> "높은 비즈니스 가치 (ROI)"
    
    quadrant-1 "전략적 투자 (Strategic Big Bets)"
    quadrant-2 "즉시 실행 (Quick Wins - 필수)"
    quadrant-3 "보류 / 재검토 (Low Priority)"
    quadrant-4 "비효율 / 신중 접근 (Time Sinks)"

    "간편결제 추가": [0.25, 0.85]
    "다크 모드 지원": [0.20, 0.40]
    "AI 맞춤 상품 추천": [0.80, 0.90]
    "레거시 DB 완전 리팩토링": [0.85, 0.65]
    "소셜 공유 버튼 추가": [0.15, 0.20]
    "블록체인 멤버십 연동": [0.90, 0.15]
    "검색 자동완성 속도 개선": [0.35, 0.75]
    "관리자 통계 엑셀 다운로드": [0.30, 0.60]`,

    pie_chart: `pie showData
    title 📊 2026 클라우드 인프라 비용 지출 비중
    "AWS EC2 / EKS (컴퓨팅)" : 42.5
    "Amazon RDS / Aurora (데이터베이스)" : 24.0
    "S3 & CloudFront (스토리지/CDN)" : 15.2
    "Datadog / CloudWatch (모니터링)" : 10.3
    "기타 네트워크 & 보안" : 8.0`,

    xy_chart: `xychart-beta
    title "월별 매출 및 활성 사용자(MAU) 추이"
    x-axis ["1월", "2월", "3월", "4월", "5월", "6월", "7월", "8월"]
    y-axis "매출 (백만원)" 0 --> 100
    bar [25, 32, 45, 52, 60, 75, 82, 95]
    line [20, 28, 40, 48, 55, 68, 79, 90]`,

    requirement_diagram: `requirementDiagram

    requirement req_sec_01 {
        id: SEC-01
        text: 모든 사용자 비밀번호 및 민감정보는 단방향 해시(Argon2id)로 암호화 저장되어야 한다.
        risk: High
        verifymethod: Test
    }

    requirement req_perf_01 {
        id: PERF-01
        text: 95%의 읽기 API 요청은 200ms 이내에 응답해야 한다.
        risk: Medium
        verifymethod: Demonstration
    }

    element auth_service {
        type: Microservice
        docref: architecture/auth_module.md
    }

    element redis_cache {
        type: In-Memory Cache
        docref: infrastructure/redis.md
    }

    auth_service - satisfies -> req_sec_01
    redis_cache - satisfies -> req_perf_01`,

    ai_search_arch: `flowchart TD
    subgraph Client["🖥️ 사용자 입력 (Frontend)"]
        UserQuery["🔍 검색어 입력<br/>('톰캣 포트', '디비 타임아웃')"]
        KeyShort["⚡ 단축키 (Ctrl + K)"]
    end

    subgraph SearchEngine["🧠 AI 시맨틱 검색 파이프라인 (Backend)"]
        Tokenizer["🔤 Dynamic Tokenizer<br/>(동적 길이 패딩)"]
        ONNX["⚡ multilingual-e5-small ONNX<br/>(Query Embedding: 5~10ms)"]
        CosineSim["📐 Cosine Similarity 내적 연산<br/>(RAM 상에서 0.1ms 매칭)"]
        Ranking["📊 유사도 랭킹 & 하이라이팅<br/>(0% ~ 100% Score)"]
    end

    subgraph VectorCache["💾 벡터 DB 캐시 레이어"]
        DiskCache[("📁 embeddings_cache.json<br/>(디스크 영구 보관)")]
        RAMCache["⚡ In-Memory Matrix<br/>(N x 384 차원 벡터)"]
        IncrementalSync["🔄 MD5 해시 증분 갱신<br/>(변경된 문서만 0.02s 갱신)"]
    end

    subgraph DataSources["📚 대상 시스템 데이터 (JSON)"]
        Notes["📝 빠른 메모 (notes.json)"]
        Diagrams["📊 다이어그램 (diagrams.json)"]
        Generators["🔢 데이터 생성기 (generators.json)"]
        QuickLaunch["⚡ 빠른 실행 (quick_launch.json)"]
        Shortcuts["📁 바로가기 (shortcuts.json)"]
    end

    %% 연결 관계
    UserQuery --> Tokenizer
    KeyShort --> UserQuery
    Tokenizer --> ONNX
    ONNX --> CosineSim
    
    DataSources --> IncrementalSync
    IncrementalSync --> DiskCache
    DiskCache <--> RAMCache
    RAMCache --> CosineSim
    
    CosineSim --> Ranking
    Ranking -->|"⚡ 6ms 초고속 결과 반환"| UserResult["🎉 스마트 검색 결과 노출<br/>(원클릭 해당 탭 이동)"]`
};

let isMermaidEditorCollapsed = false;

// 1. Mermaid 초기화
function initMermaidDiagram() {
    try {
        if (typeof mermaid !== 'undefined') {
            mermaid.initialize({
                startOnLoad: false,
                theme: currentMermaidTheme,
                securityLevel: 'loose',
                flowchart: { curve: 'basis' }
            });
        }
    } catch (e) {
        console.error("Mermaid 초기화 실패:", e);
    }

    initMermaidEditorTabKey();
    initMermaidResizer();
    initMermaidPanZoom();

    // 에디터 접힘 상태 복원
    isMermaidEditorCollapsed = localStorage.getItem('mermaid_editor_collapsed') === '1';
    applyMermaidEditorCollapsedState();

    // 로컬스토리지에서 이전 작업 내용 복원
    const saved = localStorage.getItem('mermaid_saved_code');
    const editor = document.getElementById('mermaid-code-editor');
    if (editor) {
        editor.value = saved || MERMAID_TEMPLATES.flowchart_td;
    }

    // 저장된 다이어그램 목록 불러오기
    loadSavedDiagrams();

    // 초기 렌더링
    setTimeout(() => {
        renderMermaid(true);
    }, 100);
}

// 에디터 접기/펼치기 토글
function toggleMermaidEditor() {
    isMermaidEditorCollapsed = !isMermaidEditorCollapsed;
    applyMermaidEditorCollapsedState();
    localStorage.setItem('mermaid_editor_collapsed', isMermaidEditorCollapsed ? '1' : '0');
    setTimeout(() => {
        fitMermaidToViewport();
    }, 220);
}

function applyMermaidEditorCollapsedState() {
    const editorPane = document.getElementById('mermaid-editor-pane');
    const resizer = document.getElementById('mermaid-resizer');
    const toggleIcon = document.getElementById('mermaid-editor-toggle-icon');
    const toggleText = document.getElementById('mermaid-editor-toggle-text');
    const openEditorBtn = document.getElementById('mermaid-open-editor-btn');

    if (!editorPane) return;

    if (isMermaidEditorCollapsed) {
        editorPane.classList.add('collapsed');
        if (resizer) resizer.classList.add('hidden');
        if (toggleIcon) toggleIcon.textContent = '▶';
        if (toggleText) toggleText.textContent = '에디터 펼치기';
        if (openEditorBtn) openEditorBtn.style.display = 'inline-flex';
    } else {
        editorPane.classList.remove('collapsed');
        if (resizer) resizer.classList.remove('hidden');
        if (toggleIcon) toggleIcon.textContent = '◀';
        if (toggleText) toggleText.textContent = '에디터 접기';
        if (openEditorBtn) openEditorBtn.style.display = 'none';
    }
}

// 에디터 Tab 키 4칸 들여쓰기 지원
function initMermaidEditorTabKey() {
    const editor = document.getElementById('mermaid-code-editor');
    if (!editor) return;

    editor.addEventListener('keydown', function(e) {
        if (e.key === 'Tab') {
            e.preventDefault();
            const start = this.selectionStart;
            const end = this.selectionEnd;
            this.value = this.value.substring(0, start) + "    " + this.value.substring(end);
            this.selectionStart = this.selectionEnd = start + 4;
            onMermaidCodeChange();
        }
    });
}

// 에디터 내용 변경 시 실시간 디바운스 렌더링
function onMermaidCodeChange() {
    if (mermaidRenderTimer) clearTimeout(mermaidRenderTimer);
    mermaidRenderTimer = setTimeout(() => {
        renderMermaid(false);
    }, 250);
}

// 다이어그램 렌더링
async function renderMermaid(force = false) {
    const editor = document.getElementById('mermaid-code-editor');
    const outputEl = document.getElementById('mermaid-render-output');
    const errorBar = document.getElementById('mermaid-error-bar');
    const errorText = document.getElementById('mermaid-error-text');

    if (!editor || !outputEl) return;

    const code = editor.value.trim();
    if (!code) {
        outputEl.innerHTML = '<div style="color:var(--text-secondary); text-align:center; padding:30px;">코드를 입력하면 다이어그램이 실시간으로 렌더링됩니다.</div>';
        if (errorBar) errorBar.style.display = 'none';
        return;
    }

    if (typeof mermaid === 'undefined') {
        outputEl.innerHTML = '<div style="color:#ef4444; padding:20px;">Mermaid 라이브러리를 불러오지 못했습니다.</div>';
        return;
    }

    try {
        const uniqueId = 'mermaid-svg-' + Date.now();
        const { svg } = await mermaid.render(uniqueId, code);
        outputEl.innerHTML = svg;
        outputEl.style.opacity = '1';

        if (errorBar) errorBar.style.display = 'none';

        // 성공 시 로컬스토리지 자동 저장
        localStorage.setItem('mermaid_saved_code', editor.value);

        if (force) {
            fitMermaidToViewport();
        }
    } catch (err) {
        console.warn("Mermaid 렌더링 문법 오류:", err);
        if (errorBar && errorText) {
            errorText.textContent = (err.message || err.str || '문법 오류가 발생했습니다. 문법을 확인해 주세요.').split('\n')[0];
            errorBar.style.display = 'flex';
        }
        if (outputEl.firstChild) {
            outputEl.style.opacity = '0.4';
        }
    }
}

// 템플릿 불러오기
function loadMermaidTemplate(key) {
    const tpl = MERMAID_TEMPLATES[key];
    if (!tpl) return;

    const editor = document.getElementById('mermaid-code-editor');
    if (editor) {
        editor.value = tpl;
        renderMermaid(true);
        logToConsole('Mermaid 템플릿 로드', `템플릿: [${key}] 적용 완료`);
    }
}

// 테마 변경
async function changeMermaidTheme(theme) {
    currentMermaidTheme = theme;
    try {
        mermaid.initialize({
            startOnLoad: false,
            theme: theme,
            securityLevel: 'loose',
            flowchart: { curve: 'basis' }
        });
        await renderMermaid(false);
        logToConsole('Mermaid 테마 변경', `테마: [${theme}]`);
    } catch (e) {
        console.error("테마 변경 오류:", e);
    }
}

// 에디터 비우기
function clearMermaidEditor() {
    const editor = document.getElementById('mermaid-code-editor');
    if (editor) {
        editor.value = '';
        renderMermaid(true);
        if (editor) editor.focus();
    }
}

// 코드 클립보드 복사
async function copyMermaidCode() {
    const editor = document.getElementById('mermaid-code-editor');
    if (!editor || !editor.value.trim()) {
        await showAppAlert('복사할 코드가 없습니다.', '알림', 'ℹ️');
        return;
    }
    navigator.clipboard.writeText(editor.value);
    logToConsole('코드 복사 완료', 'Mermaid 스크립트가 클립보드에 복사되었습니다.');
    showAppAlert('Mermaid 코드가 클립보드에 복사되었습니다! 📋', '복사 완료', '✅');
}

// SVG 벡터 코드 복사
async function copyMermaidSvg() {
    const outputEl = document.getElementById('mermaid-render-output');
    const svg = outputEl?.querySelector('svg');
    if (!svg) {
        await showAppAlert('복사할 다이어그램 SVG가 없습니다.', '알림', '⚠️');
        return;
    }
    const svgCode = svg.outerHTML;
    navigator.clipboard.writeText(svgCode);
    logToConsole('SVG 복사 완료', 'SVG 벡터 코드가 클립보드에 복사되었습니다.');
    showAppAlert('SVG 벡터 코드가 클립보드에 복사되었습니다! 📐', '복사 완료', '✅');
}

// 다이어그램 이미지를 클립보드에 복사 (Ctrl+V 붙여넣기용)
async function copyMermaidImageToClipboard() {
    const outputEl = document.getElementById('mermaid-render-output');
    const svg = outputEl?.querySelector('svg');
    if (!svg) {
        await showAppAlert('복사할 다이어그램이 없습니다.', '알림', '⚠️');
        return;
    }

    try {
        const blob = await svgToPngBlob(svg);
        if (blob && navigator.clipboard && navigator.clipboard.write) {
            await navigator.clipboard.write([
                new ClipboardItem({ 'image/png': blob })
            ]);
            logToConsole('이미지 클립보드 복사 완료', '메신저나 문서에 Ctrl+V로 붙여넣을 수 있습니다.');
            await showAppAlert('다이어그램 이미지가 클립보드에 복사되었습니다! 🖼️\n(문서나 메신저에 바로 Ctrl+V로 붙여넣기 가능)', '복사 완료', '✅');
        } else {
            downloadMermaidPng();
        }
    } catch (e) {
        console.error("클립보드 복사 실패:", e);
        downloadMermaidPng();
    }
}

// 고해상도 PNG 파일 다운로드
async function downloadMermaidPng() {
    const outputEl = document.getElementById('mermaid-render-output');
    const svg = outputEl?.querySelector('svg');
    if (!svg) {
        await showAppAlert('다운로드할 다이어그램이 없습니다.', '알림', '⚠️');
        return;
    }

    try {
        const blob = await svgToPngBlob(svg);
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `mermaid-diagram-${Date.now()}.png`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        logToConsole('PNG 다운로드 완료', a.download);
    } catch (e) {
        logToConsole('PNG 생성 실패', e.message || e);
    }
}

// SVG -> PNG Blob 변환 헬퍼 (배경색 및 2배 고해상도 렌더링)
function svgToPngBlob(svgElement) {
    return new Promise((resolve, reject) => {
        try {
            const svgString = new XMLSerializer().serializeToString(svgElement);
            const svgBlob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
            const URLObj = window.URL || window.webkitURL || window;
            const blobURL = URLObj.createObjectURL(svgBlob);

            const bbox = svgElement.getBoundingClientRect();
            const width = Math.max(bbox.width, 400) * 2;
            const height = Math.max(bbox.height, 300) * 2;

            const image = new Image();
            image.onload = () => {
                const canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');

                // 다크 배경 채우기
                ctx.fillStyle = currentMermaidTheme === 'dark' ? '#0d1117' : '#ffffff';
                ctx.fillRect(0, 0, width, height);

                ctx.drawImage(image, 0, 0, width, height);
                URLObj.revokeObjectURL(blobURL);

                canvas.toBlob(blob => {
                    if (blob) resolve(blob);
                    else reject(new Error('Canvas to Blob 실패'));
                }, 'image/png');
            };
            image.onerror = (e) => reject(e);
            image.src = blobURL;
        } catch (e) {
            reject(e);
        }
    });
}

// 2. 줌 및 패닝 (Zoom & Pan) 기능
function initMermaidPanZoom() {
    const viewport = document.getElementById('mermaid-viewport');
    if (!viewport) return;

    // 마우스 휠 줌
    viewport.addEventListener('wheel', function(e) {
        e.preventDefault();
        const delta = e.deltaY < 0 ? 0.1 : -0.1;
        zoomMermaid(delta);
    }, { passive: false });

    // 마우스 드래그 패닝
    viewport.addEventListener('mousedown', function(e) {
        if (e.target.closest('button')) return;
        isMermaidPanning = true;
        mermaidPanStartX = e.clientX - mermaidPanX;
        mermaidPanStartY = e.clientY - mermaidPanY;
        viewport.classList.add('panning');
    });

    window.addEventListener('mousemove', function(e) {
        if (!isMermaidPanning) return;
        mermaidPanX = e.clientX - mermaidPanStartX;
        mermaidPanY = e.clientY - mermaidPanStartY;
        updateCanvasTransform();
    });

    window.addEventListener('mouseup', function() {
        if (isMermaidPanning) {
            isMermaidPanning = false;
            viewport.classList.remove('panning');
        }
    });
}

function zoomMermaid(delta) {
    mermaidZoomScale = Math.max(0.2, Math.min(3.0, mermaidZoomScale + delta));
    updateCanvasTransform();
}

function resetMermaidZoom() {
    mermaidZoomScale = 1.0;
    mermaidPanX = 0;
    mermaidPanY = 0;
    updateCanvasTransform();
}

function fitMermaidToViewport() {
    mermaidZoomScale = 1.0;
    mermaidPanX = 0;
    mermaidPanY = 0;
    updateCanvasTransform();
}

function updateCanvasTransform() {
    const canvas = document.getElementById('mermaid-canvas');
    if (canvas) {
        canvas.style.transform = `translate(${mermaidPanX}px, ${mermaidPanY}px) scale(${mermaidZoomScale})`;
    }
}

// 3. 좌우 스플리터 리사이저
function initMermaidResizer() {
    const resizer = document.getElementById('mermaid-resizer');
    const editorPane = document.getElementById('mermaid-editor-pane');
    const container = document.getElementById('mermaid-split');

    if (!resizer || !editorPane || !container) return;

    let isResizing = false;

    resizer.addEventListener('mousedown', (e) => {
        isResizing = true;
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
    });

    document.addEventListener('mousemove', (e) => {
        if (!isResizing) return;
        const rect = container.getBoundingClientRect();
        const newWidth = e.clientX - rect.left;
        const totalWidth = rect.width;
        const percent = (newWidth / totalWidth) * 100;

        if (percent >= 20 && percent <= 80) {
            editorPane.style.flex = `0 0 ${percent}%`;
        }
    });

    document.addEventListener('mouseup', () => {
        if (isResizing) {
            isResizing = false;
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
        }
    });
}

// ==========================================
// 4. 저장된 다이어그램 목록 관리 및 영속화 (Write-Back)
// ==========================================
let savedDiagrams = [];
let draftSavedDiagrams = [];
let diagramSearchQuery = '';
let editingDiagramId = null;

const DEFAULT_DIAGRAMS_FALLBACK = [
    {
        id: "1",
        title: "⚡ 서비스 아키텍처 & 캐싱 흐름도",
        category: "Flowchart",
        description: "API 게이트웨이, Redis 캐시 확인 및 DB 쿼리 흐름도",
        code: MERMAID_TEMPLATES.flowchart_td,
        updatedAt: new Date().toISOString().slice(0, 19).replace('T', ' ')
    },
    {
        id: "2",
        title: "🔐 JWT 로그인 & 주문 결제 시퀀스",
        category: "Sequence",
        description: "동기/비동기 호출, alt 분기, loop 반복, par 병렬 처리 및 critical 트랜잭션",
        code: MERMAID_TEMPLATES.sequence,
        updatedAt: new Date().toISOString().slice(0, 19).replace('T', ' ')
    },
    {
        id: "3",
        title: "🗄️ 이커머스 핵심 도메인 ERD",
        category: "ERD",
        description: "사용자, 프로필, 주문, 상품, 카테고리, 리뷰 간의 관계형 모델링",
        code: MERMAID_TEMPLATES.er_diagram,
        updatedAt: new Date().toISOString().slice(0, 19).replace('T', ' ')
    },
    {
        id: "4",
        title: "🧠 AI 시맨틱 검색 & 벡터 DB 캐시 아키텍처",
        category: "Flowchart",
        description: "multilingual-e5-small ONNX 모델, 동적 패딩 및 증분 벡터 캐싱 파이프라인",
        code: MERMAID_TEMPLATES.ai_search_arch,
        updatedAt: new Date().toISOString().slice(0, 19).replace('T', ' ')
    },
    {
        id: "5",
        title: "🚀 2026 차세대 플랫폼 런칭 로드맵",
        category: "Gantt",
        description: "기획/백엔드/프론트엔드/QA 마일스톤 및 의존성 간트 차트",
        code: MERMAID_TEMPLATES.gantt,
        updatedAt: new Date().toISOString().slice(0, 19).replace('T', ' ')
    },
    {
        id: "6",
        title: "🎯 2026 제품 기능 개발 우선순위 매트릭스",
        category: "Quadrant",
        description: "난이도 대비 비즈니스 가치(ROI) 4분면 분석 차트",
        code: MERMAID_TEMPLATES.quadrant_chart,
        updatedAt: new Date().toISOString().slice(0, 19).replace('T', ' ')
    }
];

async function loadSavedDiagrams() {
    try {
        if (window.eel && typeof eel.get_diagrams === 'function') {
            const res = await eel.get_diagrams()();
            if (res.status === 'success' && Array.isArray(res.data) && res.data.length > 0) {
                savedDiagrams = res.data;
            } else {
                savedDiagrams = DEFAULT_DIAGRAMS_FALLBACK;
            }
        } else {
            const saved = localStorage.getItem('user_saved_diagrams');
            savedDiagrams = saved ? JSON.parse(saved) : DEFAULT_DIAGRAMS_FALLBACK;
        }
    } catch (e) {
        savedDiagrams = DEFAULT_DIAGRAMS_FALLBACK;
    }
    updateDiagramsCountBadge();
}

function updateDiagramsCountBadge() {
    const badge = document.getElementById('mermaid-saved-count-badge');
    if (badge) badge.textContent = savedDiagrams.length;
}

async function saveSavedDiagramsToBackend() {
    try {
        localStorage.setItem('user_saved_diagrams', JSON.stringify(savedDiagrams));
        if (window.eel && typeof eel.save_diagrams === 'function') {
            await eel.save_diagrams(savedDiagrams)();
        }
    } catch (e) {
        console.error("다이어그램 저장 실패:", e);
    }
}

// 다이어그램 목록 모달 열기
function openDiagramListModal() {
    draftSavedDiagrams = JSON.parse(JSON.stringify(savedDiagrams));
    diagramSearchQuery = '';
    const searchInput = document.getElementById('diagram-search-input');
    const clearBtn = document.getElementById('diagram-search-clear-btn');
    if (searchInput) searchInput.value = '';
    if (clearBtn) clearBtn.style.display = 'none';

    renderDiagramsManageList();
    document.getElementById('diagram-list-modal').classList.add('show');
}

function closeDiagramListModal() {
    draftSavedDiagrams = [];
    document.getElementById('diagram-list-modal').classList.remove('show');
}

// 다이어그램 목록 렌더링
function renderDiagramsManageList() {
    const listEl = document.getElementById('diagrams-manage-list');
    const countEl = document.getElementById('diagram-saved-count');
    if (countEl) countEl.textContent = draftSavedDiagrams.length;
    if (!listEl) return;

    // 검색 필터링
    const filtered = draftSavedDiagrams.filter(item => {
        if (!diagramSearchQuery) return true;
        const t = (item.title || '').toLowerCase();
        const d = (item.description || '').toLowerCase();
        const c = (item.category || '').toLowerCase();
        const code = (item.code || '').toLowerCase();
        return t.includes(diagramSearchQuery) || d.includes(diagramSearchQuery) || c.includes(diagramSearchQuery) || code.includes(diagramSearchQuery);
    });

    if (filtered.length === 0) {
        if (draftSavedDiagrams.length === 0) {
            listEl.innerHTML = '<div style="color:var(--text-secondary); text-align:center; padding:25px;">저장된 다이어그램이 없습니다. [➕ 현재 스크립트 저장]을 눌러 저장해 보세요!</div>';
        } else {
            listEl.innerHTML = `<div style="color:var(--text-secondary); text-align:center; padding:25px;">'${escapeHtml(diagramSearchQuery)}' 검색어와 일치하는 다이어그램이 없습니다.</div>`;
        }
        return;
    }

    listEl.innerHTML = filtered.map((item, idx) => {
        const timeStr = item.updatedAt ? `<span style="font-size:0.7rem; color:var(--text-secondary); margin-left:6px;">🕒 ${item.updatedAt}</span>` : '';
        const catBadge = item.category ? `<span class="gen-card-cat" style="margin-left:6px;">${escapeHtml(item.category)}</span>` : '';
        const descStr = item.description || item.code.split('\n').filter(Boolean).slice(0, 2).join(' | ');

        return `
            <div class="manage-item" style="padding: 10px 14px;">
                <div class="manage-item-info">
                    <div class="manage-item-name" style="font-weight: 600; font-size: 0.92rem;">
                        📊 ${escapeHtml(item.title)}
                        ${catBadge}
                        ${timeStr}
                    </div>
                    <div class="manage-item-path" title="${escapeHtml(descStr)}">${escapeHtml(descStr)}</div>
                </div>
                <div class="manage-item-actions" style="gap: 6px;">
                    <button type="button" class="form-btn add-btn" onclick="loadDiagramIntoEditor('${item.id}')" title="에디터로 불러와서 보기/수정" style="padding: 3px 10px; font-size: 0.76rem;">📥 불러오기</button>
                    <button type="button" class="item-edit-btn" onclick="editSavedDiagramMeta('${item.id}')" title="제목/설명 수정">✏️</button>
                    <button type="button" class="item-delete-btn" onclick="deleteSavedDiagram('${item.id}')" title="삭제">삭제</button>
                </div>
            </div>
        `;
    }).join('');
}

// 다이어그램 에디터로 불러오기
async function loadDiagramIntoEditor(id) {
    const item = draftSavedDiagrams.find(d => String(d.id) === String(id)) || savedDiagrams.find(d => String(d.id) === String(id));
    if (!item) return;

    const editor = document.getElementById('mermaid-code-editor');
    if (editor) {
        editor.value = item.code || '';
        renderMermaid(true);
        closeDiagramListModal();
        logToConsole('다이어그램 불러오기 완료', `'${item.title}' 다이어그램을 에디터에 로드했습니다.`);
        await showAppAlert(`'${item.title}' 다이어그램을 성공적으로 불러왔습니다! 📥`, '불러오기 완료', '✅');
    }
}

// 다이어그램 메타데이터 수정
function editSavedDiagramMeta(id) {
    const item = draftSavedDiagrams.find(d => String(d.id) === String(id));
    if (!item) return;

    editingDiagramId = id;
    document.getElementById('save-diagram-modal-title').textContent = `✏️ '${item.title}' 정보 수정`;
    document.getElementById('save-diagram-title').value = item.title || '';
    document.getElementById('save-diagram-category').value = item.category || '';
    document.getElementById('save-diagram-desc').value = item.description || '';

    document.getElementById('save-diagram-modal').classList.add('show');
    document.getElementById('save-diagram-title').focus();
}

// 다이어그램 삭제
async function deleteSavedDiagram(id) {
    const item = draftSavedDiagrams.find(d => String(d.id) === String(id));
    const confirmed = await showAppConfirm(`'${item ? item.title : '선택한'}' 다이어그램을 삭제하시겠습니까?\n(하단의 [💾 변경사항 저장]을 눌러야 최종 반영됩니다)`, {
        title: '다이어그램 삭제',
        icon: '🗑️',
        confirmText: '삭제',
        isDanger: true
    });
    if (!confirmed) return;

    draftSavedDiagrams = draftSavedDiagrams.filter(d => String(d.id) !== String(id));
    renderDiagramsManageList();
}

// 기본값 복원
async function resetDefaultDiagrams() {
    const confirmed = await showAppConfirm('기본 샘플 다이어그램 목록으로 되돌리시겠습니까?\n(하단의 [💾 변경사항 저장]을 눌러야 최종 반영됩니다)', {
        title: '기본값 복원',
        icon: '🔄',
        confirmText: '복원',
        isDanger: true
    });
    if (confirmed) {
        draftSavedDiagrams = JSON.parse(JSON.stringify(DEFAULT_DIAGRAMS_FALLBACK));
        renderDiagramsManageList();
    }
}

// 다이어그램 변경사항 영구 저장 (Write-Back)
async function saveDiagramChanges() {
    savedDiagrams = JSON.parse(JSON.stringify(draftSavedDiagrams));
    await saveSavedDiagramsToBackend();
    updateDiagramsCountBadge();
    closeDiagramListModal();
    logToConsole('다이어그램 목록 저장 완료', `총 ${savedDiagrams.length}개의 다이어그램 설정이 안전하게 저장되었습니다.`);
}

// 현재 에디터 스크립트 저장 모달 열기
async function openSaveCurrentDiagramPrompt() {
    const editor = document.getElementById('mermaid-code-editor');
    if (!editor || !editor.value.trim()) {
        await showAppAlert('저장할 다이어그램 스크립트가 없습니다. 먼저 코드를 작성해 주세요.', '알림', '⚠️');
        return;
    }

    editingDiagramId = null;
    document.getElementById('save-diagram-modal-title').textContent = '💾 현재 다이어그램 저장';
    
    // 첫 줄이나 내용에서 카테고리/제목 자동 유추
    const code = editor.value.trim();
    let guessedCategory = 'Flowchart';
    if (code.startsWith('sequenceDiagram')) guessedCategory = 'Sequence';
    else if (code.startsWith('classDiagram')) guessedCategory = 'Class';
    else if (code.startsWith('erDiagram')) guessedCategory = 'ERD';
    else if (code.startsWith('stateDiagram')) guessedCategory = 'State';
    else if (code.startsWith('gantt')) guessedCategory = 'Gantt';
    else if (code.startsWith('mindmap')) guessedCategory = 'Mindmap';
    else if (code.startsWith('gitGraph')) guessedCategory = 'Git Graph';
    else if (code.startsWith('pie')) guessedCategory = 'Pie Chart';

    document.getElementById('save-diagram-title').value = '';
    document.getElementById('save-diagram-category').value = guessedCategory;
    document.getElementById('save-diagram-desc').value = '';

    document.getElementById('save-diagram-modal').classList.add('show');
    document.getElementById('save-diagram-title').focus();
}

function closeSaveDiagramModal() {
    editingDiagramId = null;
    document.getElementById('save-diagram-modal').classList.remove('show');
}

// 다이어그램 저장 확정
async function confirmSaveDiagram() {
    const title = document.getElementById('save-diagram-title').value.trim();
    const category = document.getElementById('save-diagram-category').value.trim() || 'General';
    const desc = document.getElementById('save-diagram-desc').value.trim();

    if (!title) {
        await showAppAlert('다이어그램 제목을 입력해 주세요.', '입력 필요', '⚠️');
        return;
    }

    const editor = document.getElementById('mermaid-code-editor');
    const nowStr = new Date().toISOString().slice(0, 19).replace('T', ' ');

    if (editingDiagramId !== null) {
        // 기존 항목 수정
        const target = (draftSavedDiagrams.length > 0 ? draftSavedDiagrams : savedDiagrams).find(d => String(d.id) === String(editingDiagramId));
        if (target) {
            target.title = title;
            target.category = category;
            target.description = desc;
            target.updatedAt = nowStr;
        }
        if (draftSavedDiagrams.length === 0) {
            await saveSavedDiagramsToBackend();
        }
    } else {
        // 신규 추가
        const newItem = {
            id: Date.now().toString(),
            title,
            category,
            description: desc,
            code: editor ? editor.value : '',
            updatedAt: nowStr
        };

        if (draftSavedDiagrams.length > 0) {
            draftSavedDiagrams.unshift(newItem);
        } else {
            savedDiagrams.unshift(newItem);
            await saveSavedDiagramsToBackend();
        }
    }

    closeSaveDiagramModal();
    updateDiagramsCountBadge();

    if (document.getElementById('diagram-list-modal').classList.contains('show')) {
        renderDiagramsManageList();
    } else {
        logToConsole('다이어그램 저장 완료', `[${title}] 저장되었습니다.`);
        await showAppAlert(`'${title}' 다이어그램이 성공적으로 저장되었습니다! 💾`, '저장 완료', '✅');
    }
}

// 검색 핸들러
function onDiagramSearchInput(val) {
    diagramSearchQuery = (val || '').trim().toLowerCase();
    const clearBtn = document.getElementById('diagram-search-clear-btn');
    if (clearBtn) {
        clearBtn.style.display = diagramSearchQuery ? 'inline-block' : 'none';
    }
    renderDiagramsManageList();
}

function clearDiagramSearch() {
    const input = document.getElementById('diagram-search-input');
    const clearBtn = document.getElementById('diagram-search-clear-btn');
    if (input) input.value = '';
    if (clearBtn) clearBtn.style.display = 'none';
    diagramSearchQuery = '';
    renderDiagramsManageList();
    if (input) input.focus();
}


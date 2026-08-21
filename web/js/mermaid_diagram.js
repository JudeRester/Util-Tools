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

// 다양한 다이어그램 템플릿 프리셋
const MERMAID_TEMPLATES = {
    flowchart_td: `flowchart TD
    Start([사용자 요청]) --> AuthCheck{인증 여부}
    AuthCheck -- 인증 성공 --> CacheCheck{캐시 확인}
    AuthCheck -- 인증 실패 --> Reject[401 권한 없음]
    
    CacheCheck -- Cache Hit --> ReturnCache[캐시 데이터 즉시 반환]
    CacheCheck -- Cache Miss --> QueryDB[(데이터베이스 조회)]
    
    QueryDB --> SaveCache[결과 캐싱 (Redis)]
    SaveCache --> ReturnResponse([클라이언트 응답])
    ReturnCache --> ReturnResponse`,

    flowchart_lr: `flowchart LR
    Client[Web Client] --> Gateway[API Gateway]
    Gateway --> AuthSvc[Auth Service]
    Gateway --> OrderSvc[Order Service]
    Gateway --> PaySvc[Payment Service]
    
    OrderSvc --> OrderDB[(Order DB)]
    PaySvc --> PG[(Payment Gateway)]`,

    sequence: `sequenceDiagram
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
    Frontend-->>User: 로그인 완료 & 대시보드 이동`,

    class_diagram: `classDiagram
    class User {
        +String userId
        +String email
        -String passwordHash
        +login(password) Boolean
        +updateProfile(data) Void
    }

    class Admin {
        +String role
        +banUser(userId) Void
        +viewAuditLogs() List
    }

    class Order {
        +String orderId
        +DateTime createdAt
        +Double totalAmount
        +processPayment() Boolean
    }

    User <|-- Admin : 상속 (Inheritance)
    User "1" *-- "many" Order : 주문 목록 보유`,

    er_diagram: `erDiagram
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
    }`,

    state_diagram: `stateDiagram-v2
    [*] --> 결제대기 : 주문 생성
    결제대기 --> 결제완료 : 결제 승인
    결제대기 --> 주문취소 : 타임아웃 / 취소
    
    결제완료 --> 상품준비중 : 재고 확인
    상품준비중 --> 배송중 : 택배사 인계
    배송중 --> 배송완료 : 수령 완료
    
    배송완료 --> [*] : 구매 확정
    주문취소 --> [*]`,

    gantt: `gantt
    title 프로젝트 개발 일정 (Q3 Release)
    dateFormat  YYYY-MM-DD
    section 요구사항 & 기획
    요구사항 분석       :done,    des1, 2026-08-01, 2026-08-07
    UI/UX 화면 설계      :done,    des2, 2026-08-08, 2026-08-15
    section 개발 단계
    백엔드 API 구현     :active,  dev1, 2026-08-16, 2026-08-30
    프론트엔드 연동     :         dev2, 2026-08-23, 2026-09-06
    section 배포 & QA
    통합 테스트 & QA    :         qa1,  2026-09-07, 2026-09-15
    운영 서버 릴리즈    :milestone, m1, 2026-09-16, 2026-09-16`,

    mindmap: `mindmap
  root((Full-Stack 개발))
    프론트엔드
      HTML5 / CSS3
      JavaScript / TypeScript
      React / Vue / Svelte
      TailwindCSS
    백엔드
      Node.js / Express
      Python / FastAPI / Django
      Java / Spring Boot
      Go / Gin
    데이터베이스
      Relational
        PostgreSQL
        MySQL
      NoSQL / Cache
        MongoDB
        Redis
    DevOps & 인프라
      Docker / Kubernetes
      CI/CD Pipelines
      AWS / GCP / Cloud`,

    git_graph: `gitGraph
    commit id: "v1.0.0"
    commit id: "메인 구조 설계"
    branch develop
    checkout develop
    commit id: "기능 추가 #1"
    commit id: "기능 추가 #2"
    checkout main
    merge develop id: "v1.1.0 릴리즈"
    branch feature/mermaid
    checkout feature/mermaid
    commit id: "Mermaid 스튜디오 추가"
    commit id: "PNG/SVG 내보내기 구현"
    checkout develop
    merge feature/mermaid id: "PR 승인"
    checkout main
    merge develop id: "v1.2.0 배포"`,

    pie_chart: `pie title 2026년 주간 개발 작업 비율
    "신규 기능 개발" : 45
    "버그 수정 & 리팩토링" : 25
    "코드 리뷰 & 설계" : 15
    "문서화 & 회의" : 10
    "기타" : 5`,

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
        title: "🔐 JWT 로그인 & 인증 시퀀스",
        category: "Sequence",
        description: "클라이언트와 백엔드 서버 간의 토큰 발급 및 검증 과정",
        code: MERMAID_TEMPLATES.sequence,
        updatedAt: new Date().toISOString().slice(0, 19).replace('T', ' ')
    },
    {
        id: "3",
        title: "🗄️ 이커머스 핵심 ERD",
        category: "ERD",
        description: "사용자, 주문, 주문 상품 간의 관계 다이어그램",
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


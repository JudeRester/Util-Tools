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
    "기타" : 5`
};

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

    // 로컬스토리지에서 이전 작업 내용 복원
    const saved = localStorage.getItem('mermaid_saved_code');
    const editor = document.getElementById('mermaid-code-editor');
    if (editor) {
        editor.value = saved || MERMAID_TEMPLATES.flowchart_td;
    }

    // 초기 렌더링
    setTimeout(() => {
        renderMermaid(true);
    }, 100);
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

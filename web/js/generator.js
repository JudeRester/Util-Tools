/**
 * 커스텀 데이터 생성기 스튜디오 (Custom Data Generator Studio) 모듈
 */

let currentGenerators = [];
let editingGeneratorId = null;

const DEFAULT_GENERATORS_FALLBACK = [
    {
        "id": "1",
        "name": "사업자등록번호",
        "icon": "🏢",
        "category": "금융/세무",
        "description": "국세청 체크섬 알고리즘 검증을 통과하는 유효한 사업자등록번호 생성",
        "code": `// 국세청 유효 사업자등록번호 생성
const weights = [1, 3, 7, 1, 3, 7, 1, 3, 5];
const digits = [Math.floor(Math.random() * 9) + 1];
for (let i = 0; i < 8; i++) digits.push(Math.floor(Math.random() * 10));

let chkSum = 0;
for (let i = 0; i < 8; i++) chkSum += weights[i] * digits[i];
const p9 = weights[8] * digits[8];
chkSum += Math.floor(p9 / 10) + (p9 % 10);
digits.push((10 - (chkSum % 10)) % 10);

const raw = digits.join('');
return \`\${raw.slice(0,3)}-\${raw.slice(3,5)}-\${raw.slice(5)}\`;`
    },
    {
        "id": "2",
        "name": "UUID v4 고유 식별자",
        "icon": "🆔",
        "category": "식별자",
        "description": "RFC 4122 표준 범용 고유 식별자(UUID v4) 생성",
        "code": `// UUID v4 생성
if (crypto && crypto.randomUUID) {
    return crypto.randomUUID();
}
return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
});`
    },
    {
        "id": "3",
        "name": "강력한 무작위 비밀번호",
        "icon": "🔑",
        "category": "보안/인증",
        "description": "영문 대소문자, 숫자, 특수문자가 모두 포함된 16자리 보안 비밀번호",
        "code": `// 16자리 강력한 비밀번호 생성
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
return pwd.sort(() => Math.random() - 0.5).join('');`
    },
    {
        "id": "4",
        "name": "가상 한국인 더미 정보",
        "icon": "👤",
        "category": "더미 데이터",
        "description": "테스트용 가상 한국인 이름과 010 가상 휴대폰 번호 세트",
        "code": `// 가상 한국인 이름 + 가상 휴대폰 번호 생성
const lastNames = ["김", "이", "박", "최", "정", "강", "조", "윤", "장", "임", "한", "오", "서", "신", "권", "황", "안", "송", "류", "홍"];
const firstNames = ["민준", "서준", "도윤", "예준", "시우", "하준", "서연", "서윤", "지우", "서현", "하은", "민서", "지유", "윤서", "채원", "지원", "준혁", "도현", "태민", "수빈"];

const name = lastNames[Math.floor(Math.random() * lastNames.length)] + firstNames[Math.floor(Math.random() * firstNames.length)];
const mid = String(Math.floor(Math.random() * 9000) + 1000);
const last = String(Math.floor(Math.random() * 9000) + 1000);
const phone = \`010-\${mid}-\${last}\`;

return \`\${name} (\${phone})\`;`
    },
    {
        "id": "5",
        "name": "UNIX 타임스탬프 & ISO 일시",
        "icon": "⏰",
        "category": "일시/변환",
        "description": "현재 시각 기준 밀리초/초 단위 Epoch 타임스탬프 및 ISO 8601 문자열",
        "code": `// 현재 시간 타임스탬프 및 ISO 문자열
const now = new Date();
return \`Timestamp (ms): \${now.getTime()}\\nTimestamp (s):  \${Math.floor(now.getTime() / 1000)}\\nISO 8601:       \${now.toISOString()}\\nLocal (KST):     \${now.toLocaleString()}\`;`
    },
    {
        "id": "6",
        "name": "무작위 32자 HEX 토큰",
        "icon": "🎲",
        "category": "보안/인증",
        "description": "API 키 및 세션 테스트용 32자리 16진수(HEX) 무작위 시크릿 토큰",
        "code": `// 32자리 HEX 토큰 생성
const bytes = new Uint8Array(16);
if (window.crypto && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
} else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
}
return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');`
    }
];

// 1. 초기 로드
async function loadGenerators() {
    try {
        if (window.eel && typeof eel.get_generators === 'function') {
            const res = await eel.get_generators()();
            if (res.status === 'success' && Array.isArray(res.data) && res.data.length > 0) {
                currentGenerators = res.data;
            } else {
                currentGenerators = DEFAULT_GENERATORS_FALLBACK;
            }
        } else {
            const saved = localStorage.getItem('user_generators');
            currentGenerators = saved ? JSON.parse(saved) : DEFAULT_GENERATORS_FALLBACK;
        }
    } catch (e) {
        currentGenerators = DEFAULT_GENERATORS_FALLBACK;
    }

    renderGeneratorsUI();
}

// 2. 메인 카드 그리드 렌더링
function renderGeneratorsUI() {
    const grid = document.getElementById('generators-grid');
    const totalCountEl = document.getElementById('generator-total-count');
    const badgeCountEl = document.getElementById('gen-count-badge');

    if (totalCountEl) totalCountEl.textContent = currentGenerators.length;
    if (badgeCountEl) badgeCountEl.textContent = currentGenerators.length;
    if (!grid) return;

    if (currentGenerators.length === 0) {
        grid.innerHTML = `
            <div class="empty-state" style="grid-column: 1 / -1; padding: 40px 20px; text-align: center; color: var(--text-secondary);">
                <div style="font-size: 2rem; margin-bottom: 8px;">🔢</div>
                <p>등록된 데이터 생성기가 없습니다.</p>
                <button class="form-btn add-btn" style="margin-top: 10px;" onclick="openAddGeneratorModal()">➕ 새 생성기 추가</button>
            </div>
        `;
        return;
    }

    grid.innerHTML = currentGenerators.map(gen => {
        const icon = gen.icon || '🎲';
        const name = escapeHtml(gen.name || '생성기');
        const desc = escapeHtml(gen.description || '');
        const cat = escapeHtml(gen.category || '기타');

        return `
            <div class="generator-card" title="${desc}">
                <div class="gen-card-header">
                    <div class="gen-card-icon">${icon}</div>
                    <div class="gen-card-info">
                        <div class="gen-card-title-row">
                            <span class="gen-card-title">${name}</span>
                            <span class="gen-card-cat">${cat}</span>
                        </div>
                        <div class="gen-card-desc">${desc}</div>
                    </div>
                </div>
                <div class="gen-card-actions">
                    <button class="gen-btn primary" onclick="runGenerator('${gen.id}', 1)" title="1개 생성 후 클립보드 자동 복사">
                        <span>⚡</span> 생성 (1개)
                    </button>
                    <button class="gen-btn secondary" onclick="runGenerator('${gen.id}', 5)" title="5개 일괄 생성 후 복사">
                        <span>📋</span> 5개 생성
                    </button>
                </div>
            </div>
        `;
    }).join('');
}

// 3. 생성기 스크립트 실행 함수
async function runGenerator(genId, count = 1) {
    const gen = currentGenerators.find(g => String(g.id) === String(genId));
    if (!gen) {
        alert('생성기 정보를 찾을 수 없습니다.');
        return;
    }

    const code = gen.code || '';
    if (!code.trim()) {
        alert('생성기 스크립트 코드가 비어있습니다.');
        return;
    }

    try {
        const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
        const fn = new AsyncFunction(code);

        const results = [];
        for (let i = 0; i < count; i++) {
            const val = await fn();
            results.push(typeof val === 'object' ? JSON.stringify(val) : String(val));
        }

        const copyText = results.join('\n');
        copyTextToClipboard(copyText);

        logToConsole(`[${gen.icon || '🎲'} ${gen.name}] 데이터 생성 완료 (${count}개)`, {
            생성기: gen.name,
            카테고리: gen.category || '기타',
            생성개수: `${count}개`,
            결과미리보기: count === 1 ? results[0] : results,
            클립보드: '자동 복사 완료'
        });
    } catch (err) {
        console.error('생성기 실행 오류:', err);
        logToConsole(`🚨 [${gen.name}] 생성기 실행 오류`, err.message || String(err));
        alert(`생성기 실행 중 오류가 발생했습니다:\n${err.message}`);
    }
}

// 클립보드 복사 헬퍼
function copyTextToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).catch(() => {});
    }
}

// 4. 모달 관리 및 폼 제어
function openGeneratorsModal() {
    const modal = document.getElementById('generators-modal');
    if (!modal) return;
    cancelEditGenerator();
    renderGeneratorsManageList();
    modal.classList.add('show');
}

function openAddGeneratorModal() {
    openGeneratorsModal();
    const nameInput = document.getElementById('gen-name-input');
    if (nameInput) nameInput.focus();
}

function closeGeneratorsModal() {
    const modal = document.getElementById('generators-modal');
    if (modal) modal.classList.remove('show');
    cancelEditGenerator();
}

function renderGeneratorsManageList() {
    const listEl = document.getElementById('generators-manage-list');
    const badgeEl = document.getElementById('gen-count-badge');
    if (badgeEl) badgeEl.textContent = currentGenerators.length;
    if (!listEl) return;

    if (currentGenerators.length === 0) {
        listEl.innerHTML = '<div style="padding:15px; text-align:center; color:var(--text-secondary);">등록된 생성기가 없습니다.</div>';
        return;
    }

    listEl.innerHTML = currentGenerators.map((gen, idx) => `
        <div class="manage-item" draggable="true" data-index="${idx}" data-id="${gen.id}">
            <div class="item-drag-handle" title="드래그하여 순서 변경">⋮⋮</div>
            <div class="item-icon-preview">${escapeHtml(gen.icon || '🎲')}</div>
            <div class="item-info">
                <div class="item-name">${escapeHtml(gen.name || '생성기')} <span style="font-size:0.7rem; color:#a5b4fc;">[${escapeHtml(gen.category || '기타')}]</span></div>
                <div class="item-path">${escapeHtml(gen.description || '')}</div>
            </div>
            <div class="item-actions">
                <button class="item-btn edit-btn" onclick="editGenerator('${gen.id}')" title="생성기 스크립트 수정">✏️ 수정</button>
                <button class="item-btn delete-btn" onclick="deleteGenerator('${gen.id}')" title="생성기 삭제">🗑️ 삭제</button>
            </div>
        </div>
    `).join('');

    initGeneratorsDragAndDrop();
}

function initGeneratorsDragAndDrop() {
    const listEl = document.getElementById('generators-manage-list');
    if (!listEl) return;

    let dragSrcEl = null;
    const items = listEl.querySelectorAll('.manage-item');

    items.forEach(item => {
        item.addEventListener('dragstart', (e) => {
            dragSrcEl = item;
            item.classList.add('dragging');
            e.dataTransfer.effectAllowed = 'move';
        });

        item.addEventListener('dragend', () => {
            item.classList.remove('dragging');
            items.forEach(i => i.classList.remove('drag-over'));
        });

        item.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            item.classList.add('drag-over');
        });

        item.addEventListener('dragleave', () => {
            item.classList.remove('drag-over');
        });

        item.addEventListener('drop', (e) => {
            e.preventDefault();
            item.classList.remove('drag-over');
            if (dragSrcEl !== item) {
                const fromIdx = parseInt(dragSrcEl.getAttribute('data-index'), 10);
                const toIdx = parseInt(item.getAttribute('data-index'), 10);

                const movedItem = currentGenerators.splice(fromIdx, 1)[0];
                currentGenerators.splice(toIdx, 0, movedItem);

                saveGeneratorsToServer();
                renderGeneratorsManageList();
                renderGeneratorsUI();
            }
        });
    });
}

function editGenerator(id) {
    const gen = currentGenerators.find(g => String(g.id) === String(id));
    if (!gen) return;

    editingGeneratorId = id;
    document.getElementById('generator-form-title').textContent = '✏️ 생성기 스크립트 수정';
    document.getElementById('gen-icon-input').value = gen.icon || '🎲';
    document.getElementById('gen-name-input').value = gen.name || '';
    document.getElementById('gen-category-input').value = gen.category || '';
    document.getElementById('gen-desc-input').value = gen.description || '';
    document.getElementById('gen-code-input').value = gen.code || '';

    const submitBtn = document.getElementById('gen-submit-btn');
    const cancelBtn = document.getElementById('gen-cancel-btn');
    if (submitBtn) submitBtn.textContent = '수정 완료';
    if (cancelBtn) cancelBtn.style.display = 'inline-block';

    document.getElementById('gen-name-input').focus();
}

function cancelEditGenerator() {
    editingGeneratorId = null;
    const formTitle = document.getElementById('generator-form-title');
    if (formTitle) formTitle.textContent = '➕ 새로운 데이터 생성기 추가';

    const iconIn = document.getElementById('gen-icon-input');
    const nameIn = document.getElementById('gen-name-input');
    const catIn = document.getElementById('gen-category-input');
    const descIn = document.getElementById('gen-desc-input');
    const codeIn = document.getElementById('gen-code-input');

    if (iconIn) iconIn.value = '🎲';
    if (nameIn) nameIn.value = '';
    if (catIn) catIn.value = '';
    if (descIn) descIn.value = '';
    if (codeIn) codeIn.value = '';

    const submitBtn = document.getElementById('gen-submit-btn');
    const cancelBtn = document.getElementById('gen-cancel-btn');
    if (submitBtn) submitBtn.textContent = '추가';
    if (cancelBtn) cancelBtn.style.display = 'none';
}

async function submitGeneratorForm() {
    const icon = (document.getElementById('gen-icon-input')?.value || '🎲').trim();
    const name = (document.getElementById('gen-name-input')?.value || '').trim();
    const category = (document.getElementById('gen-category-input')?.value || '사용자 정의').trim();
    const description = (document.getElementById('gen-desc-input')?.value || '').trim();
    const code = (document.getElementById('gen-code-input')?.value || '').trim();

    if (!name) {
        alert('생성기 이름을 입력해 주세요.');
        document.getElementById('gen-name-input')?.focus();
        return;
    }

    if (!code) {
        alert('JavaScript 생성 스크립트 코드를 입력해 주세요.');
        document.getElementById('gen-code-input')?.focus();
        return;
    }

    if (editingGeneratorId) {
        const gen = currentGenerators.find(g => String(g.id) === String(editingGeneratorId));
        if (gen) {
            gen.icon = icon;
            gen.name = name;
            gen.category = category;
            gen.description = description;
            gen.code = code;
        }
    } else {
        const newGen = {
            id: Date.now().toString(),
            name,
            icon,
            category,
            description,
            code
        };
        currentGenerators.unshift(newGen);
    }

    await saveGeneratorsToServer();
    cancelEditGenerator();
    renderGeneratorsManageList();
    renderGeneratorsUI();
}

async function deleteGenerator(id) {
    const gen = currentGenerators.find(g => String(g.id) === String(id));
    if (!gen) return;

    if (!confirm(`'${gen.name}' 생성기를 정말 삭제하시겠습니까?`)) return;

    currentGenerators = currentGenerators.filter(g => String(g.id) !== String(id));
    await saveGeneratorsToServer();
    renderGeneratorsManageList();
    renderGeneratorsUI();
}

async function resetDefaultGenerators() {
    if (!confirm('모든 생성기를 기본 템플릿 목록으로 복원하시겠습니까? (사용자가 추가한 생성기는 초기화됩니다)')) return;

    try {
        if (window.eel && typeof eel.reset_default_generators === 'function') {
            const res = await eel.reset_default_generators()();
            if (res.status === 'success') {
                currentGenerators = res.data;
            }
        } else {
            currentGenerators = JSON.parse(JSON.stringify(DEFAULT_GENERATORS_FALLBACK));
        }
    } catch (e) {
        currentGenerators = JSON.parse(JSON.stringify(DEFAULT_GENERATORS_FALLBACK));
    }

    await saveGeneratorsToServer();
    renderGeneratorsManageList();
    renderGeneratorsUI();
}

async function saveGeneratorsToServer() {
    try {
        localStorage.setItem('user_generators', JSON.stringify(currentGenerators));
        if (window.eel && typeof eel.save_generators === 'function') {
            await eel.save_generators(currentGenerators)();
        }
    } catch (e) {
        console.error('생성기 목록 저장 실패:', e);
    }
}

// 템플릿 코드 원클릭 삽입
function insertGenCodeTemplate(type) {
    const codeArea = document.getElementById('gen-code-input');
    if (!codeArea) return;

    const templates = {
        uuid: `// UUID v4 고유 식별자 반환\nreturn crypto.randomUUID();`,
        randomNum: `// 6자리 무작위 정수 난수 반환 (100000 ~ 999999)\nreturn Math.floor(Math.random() * 900000) + 100000;`,
        randomStr: `// 8자리 영숫자 무작위 문자열 반환\nreturn Math.random().toString(36).substring(2, 10).toUpperCase();`,
        timestamp: `// 현재 Unix 타임스탬프 (밀리초)\nreturn Date.now();`
    };

    if (templates[type]) {
        codeArea.value = templates[type];
        codeArea.focus();
    }
}

// 하위 호환용 기존 함수 바인딩
function callGenerateBizID(formatted) {
    runGenerator("1", 1);
}

function callGenerateBizIDBulk(count = 5) {
    runGenerator("1", count);
}

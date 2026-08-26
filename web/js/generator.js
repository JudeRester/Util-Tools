/**
 * 커스텀 데이터 생성기 스튜디오 (Custom Data Generator Studio) 모듈
 * 2-Column 인터랙티브 스튜디오 (좌측 목록 사이드바 + 우측 전문 코드 에디터)
 */

let currentGenerators = [];
let selectedStudioGenId = null;
let selectedGenCategory = 'ALL';
let genSearchQuery = '';

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
    initGenCodeEditorTabKey();
}

// 2. 메인 카드 그리드 렌더링 (카테고리 필터 + 검색 지원)
function renderGeneratorsUI() {
    const grid = document.getElementById('generators-grid');
    const totalCountEl = document.getElementById('generator-total-count');
    const badgeCountEl = document.getElementById('gen-count-badge');

    if (totalCountEl) totalCountEl.textContent = currentGenerators.length;
    if (badgeCountEl) badgeCountEl.textContent = currentGenerators.length;

    renderGeneratorCategoryChips();

    if (!grid) return;

    // 필터링 적용 (카테고리 + 검색어)
    const filtered = currentGenerators.filter(gen => {
        // 1) 카테고리 필터
        if (selectedGenCategory !== 'ALL' && (gen.category || '기타') !== selectedGenCategory) {
            return false;
        }

        // 2) 검색어 필터
        if (genSearchQuery) {
            const name = (gen.name || '').toLowerCase();
            const desc = (gen.description || '').toLowerCase();
            const cat = (gen.category || '').toLowerCase();
            if (!name.includes(genSearchQuery) && !desc.includes(genSearchQuery) && !cat.includes(genSearchQuery)) {
                return false;
            }
        }
        return true;
    });

    if (filtered.length === 0) {
        if (currentGenerators.length === 0) {
            grid.innerHTML = `
                <div class="empty-state" style="grid-column: 1 / -1; padding: 40px 20px; text-align: center; color: var(--text-secondary);">
                    <div style="font-size: 2rem; margin-bottom: 8px;">🔢</div>
                    <p>등록된 데이터 생성기가 없습니다.</p>
                    <button class="form-btn add-btn" style="margin-top: 10px;" onclick="openAddGeneratorModal()">➕ 새 생성기 추가</button>
                </div>
            `;
        } else if (genSearchQuery) {
            grid.innerHTML = `
                <div class="empty-state" style="grid-column: 1 / -1; padding: 30px 20px; text-align: center; color: var(--text-secondary);">
                    <div style="font-size: 1.8rem; margin-bottom: 8px;">🔍</div>
                    <p>'${escapeHtml(genSearchQuery)}' 검색어와 일치하는 데이터 생성기가 없습니다.</p>
                    <button class="form-btn close-btn" style="margin-top: 10px;" onclick="clearGeneratorSearch()">검색어 초기화</button>
                </div>
            `;
        } else {
            grid.innerHTML = `
                <div class="empty-state" style="grid-column: 1 / -1; padding: 30px 20px; text-align: center; color: var(--text-secondary);">
                    <div style="font-size: 1.8rem; margin-bottom: 8px;">🏷️</div>
                    <p>'${escapeHtml(selectedGenCategory)}' 카테고리에 등록된 생성기가 없습니다.</p>
                    <button class="form-btn close-btn" style="margin-top: 10px;" onclick="setGeneratorCategoryFilter('ALL')">전체 보기</button>
                </div>
            `;
        }
        return;
    }

    grid.innerHTML = filtered.map(gen => {
        const icon = gen.icon || '🎲';
        const name = escapeHtml(gen.name || '생성기');
        const desc = escapeHtml(gen.description || '');
        const cat = escapeHtml(gen.category || '기타');

        return `
            <div class="gen-tool-card" onclick="runGenerator('${gen.id}', 1)" title="${desc} (클릭 시 1개 생성 및 복사)">
                <div class="gen-card-top-bar">
                    <div class="gen-card-icon-group">
                        <span class="gen-card-badge-icon">${icon}</span>
                        <span class="gen-card-cat" onclick="event.stopPropagation(); setGeneratorCategoryFilter('${escapeJsString(gen.category || '기타')}')" title="이 카테고리만 모아보기">${cat}</span>
                    </div>
                    <button class="gen-bulk-btn" onclick="event.stopPropagation(); runGenerator('${gen.id}', 5)" title="5개 일괄 생성 및 복사">
                        5개 📋
                    </button>
                </div>
                <div class="gen-card-main-info">
                    <h3 class="gen-card-main-title">${name}</h3>
                    <p class="gen-card-main-desc">${desc}</p>
                </div>
            </div>
        `;
    }).join('');
}

// 상단 카테고리 필터 칩 렌더링
function renderGeneratorCategoryChips() {
    const chipBar = document.getElementById('gen-category-chips');
    if (!chipBar) return;

    if (currentGenerators.length === 0) {
        chipBar.innerHTML = '';
        return;
    }

    // 카테고리별 개수 집계
    const catCounts = { 'ALL': currentGenerators.length };
    currentGenerators.forEach(gen => {
        const cat = gen.category || '기타';
        catCounts[cat] = (catCounts[cat] || 0) + 1;
    });

    const categories = ['ALL', ...Object.keys(catCounts).filter(k => k !== 'ALL')];

    // 만약 현재 선택된 카테고리가 삭제 등으로 없어졌다면 ALL로 자동 복귀
    if (selectedGenCategory !== 'ALL' && !catCounts[selectedGenCategory]) {
        selectedGenCategory = 'ALL';
    }

    chipBar.innerHTML = categories.map(cat => {
        const isActive = selectedGenCategory === cat;
        const label = cat === 'ALL' ? '전체' : cat;
        const count = catCounts[cat] || 0;

        return `
            <button type="button" class="gen-filter-chip ${isActive ? 'active' : ''}" onclick="setGeneratorCategoryFilter('${escapeJsString(cat)}')">
                <span>${escapeHtml(label)}</span>
                <span class="gen-filter-chip-count">${count}</span>
            </button>
        `;
    }).join('');
}

function setGeneratorCategoryFilter(cat) {
    selectedGenCategory = cat;
    renderGeneratorsUI();
}

let genSearchDebounceTimer = null;

function onGeneratorSearchInput(val) {
    const trimmed = (val || '').trim().toLowerCase();
    const clearBtn = document.getElementById('gen-search-clear-btn');
    if (clearBtn) {
        clearBtn.style.display = trimmed ? 'inline-block' : 'none';
    }

    clearTimeout(genSearchDebounceTimer);
    if (!trimmed) {
        genSearchQuery = '';
        renderGeneratorsUI();
        return;
    }

    genSearchDebounceTimer = setTimeout(() => {
        genSearchQuery = trimmed;
        renderGeneratorsUI();
    }, 200);
}

function clearGeneratorSearch() {
    clearTimeout(genSearchDebounceTimer);
    const input = document.getElementById('gen-search-input');
    const clearBtn = document.getElementById('gen-search-clear-btn');
    if (input) input.value = '';
    if (clearBtn) clearBtn.style.display = 'none';
    genSearchQuery = '';
    renderGeneratorsUI();
    if (input) input.focus();
}

// 3. 생성기 스크립트 실행 함수
async function runGenerator(genId, count = 1) {
    const gen = currentGenerators.find(g => String(g.id) === String(genId));
    if (!gen) {
        await showAppAlert('생성기 정보를 찾을 수 없습니다.', '생성기 오류', '⚠️');
        return;
    }

    const code = gen.code || '';
    if (!code.trim()) {
        await showAppAlert('생성기 스크립트 코드가 비어있습니다.', '코드 확인', '⚠️');
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
        await showAppAlert(`생성기 실행 중 오류가 발생했습니다:\n${err.message}`, '실행 오류', '🚨');
    }
}

// 클립보드 복사 헬퍼
function copyTextToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).catch(() => {});
    }
}

let studioDraftGenerators = [];

// ==========================================
// 4. 2컬럼 스튜디오 모달 제어 (Write-Back Draft 버퍼링 방식)
// ==========================================

function openGeneratorsModal() {
    const modal = document.getElementById('generators-modal');
    if (!modal) return;

    // 1) Write-Back용 깊은 복사본(Draft 버퍼) 생성
    studioDraftGenerators = JSON.parse(JSON.stringify(currentGenerators));

    if (studioDraftGenerators.length > 0) {
        selectedStudioGenId = studioDraftGenerators[0].id;
    } else {
        selectedStudioGenId = null;
    }

    renderGeneratorsManageList();
    loadGeneratorToEditor(selectedStudioGenId);
    modal.classList.add('show');
}

function openAddGeneratorModal() {
    openGeneratorsModal();
    selectGeneratorInStudio(null);
}

function closeGeneratorsModal() {
    const modal = document.getElementById('generators-modal');
    if (modal) modal.classList.remove('show');
    hideTestOutput();
    studioDraftGenerators = []; // Draft 폐기 (디스크 불변, 완벽 롤백)
}

// 현재 폼 입력을 Draft 버퍼에 실시간 동기화
function syncCurrentEditorToDraft() {
    const icon = (document.getElementById('gen-icon-input')?.value || '🎲').trim();
    const name = (document.getElementById('gen-name-input')?.value || '').trim();
    const category = (document.getElementById('gen-category-input')?.value || '사용자 정의').trim();
    const description = (document.getElementById('gen-desc-input')?.value || '').trim();
    const code = (document.getElementById('gen-code-input')?.value || '').trim();

    if (selectedStudioGenId) {
        const gen = studioDraftGenerators.find(g => String(g.id) === String(selectedStudioGenId));
        if (gen) {
            gen.icon = icon;
            gen.name = name;
            gen.category = category;
            gen.description = description;
            gen.code = code;
        }
    }
}

function selectGeneratorInStudio(id) {
    // 1) 현재 편집 중이던 내용을 먼저 Draft 버퍼에 안전하게 저장
    syncCurrentEditorToDraft();

    selectedStudioGenId = id;
    hideTestOutput();

    if (id === null) {
        // '새 생성기 추가' 클릭 시 Draft에 새 임시 생성기 객체 즉시 생성
        const newId = Date.now().toString();
        const newGen = {
            id: newId,
            name: '새 데이터 생성기',
            icon: '🎲',
            category: '사용자 정의',
            description: '',
            code: `// JavaScript 생성 코드를 작성하세요 (return 값으로 데이터 반환)\nconst rand = Math.floor(Math.random() * 900000) + 100000;\nreturn 'DATA_' + rand;`
        };
        studioDraftGenerators.unshift(newGen);
        selectedStudioGenId = newId;
    }

    renderGeneratorsManageList();
    loadGeneratorToEditor(selectedStudioGenId);
}

function loadGeneratorToEditor(id) {
    const formTitle = document.getElementById('generator-form-title');
    const modeIcon = document.getElementById('gen-form-mode-icon');
    const iconIn = document.getElementById('gen-icon-input');
    const nameIn = document.getElementById('gen-name-input');
    const catIn = document.getElementById('gen-category-input');
    const descIn = document.getElementById('gen-desc-input');
    const codeIn = document.getElementById('gen-code-input');
    const deleteBtn = document.getElementById('gen-delete-btn');

    if (id) {
        const gen = studioDraftGenerators.find(g => String(g.id) === String(id));
        if (gen) {
            if (formTitle) formTitle.textContent = `생성기 편집: ${gen.name || '무제'}`;
            if (modeIcon) modeIcon.textContent = '✏️';
            if (iconIn) iconIn.value = gen.icon || '🎲';
            if (nameIn) nameIn.value = gen.name || '';
            if (catIn) catIn.value = gen.category || '';
            if (descIn) descIn.value = gen.description || '';
            if (codeIn) codeIn.value = gen.code || '';
            if (deleteBtn) deleteBtn.style.display = 'inline-block';
        }
    } else {
        if (formTitle) formTitle.textContent = '➕ 새로운 데이터 생성기 추가';
        if (modeIcon) modeIcon.textContent = '➕';
        if (iconIn) iconIn.value = '🎲';
        if (nameIn) nameIn.value = '';
        if (catIn) catIn.value = '사용자 정의';
        if (descIn) descIn.value = '';
        if (codeIn) codeIn.value = '';
        if (deleteBtn) deleteBtn.style.display = 'none';
    }
}

// 실시간 에디터 입력 시 좌측 사이드바 목록과 동기화
function onStudioFieldInput() {
    syncCurrentEditorToDraft();
    renderGeneratorsManageList(false); // 드래그 이벤트 재등록 없이 DOM만 실시간 갱신
}

function renderGeneratorsManageList(rebindEvents = true) {
    const listEl = document.getElementById('generators-manage-list');
    const badgeEl = document.getElementById('gen-count-badge');
    if (badgeEl) badgeEl.textContent = studioDraftGenerators.length;
    if (!listEl) return;

    if (studioDraftGenerators.length === 0) {
        listEl.innerHTML = '<div style="padding:20px; text-align:center; color:var(--text-secondary); font-size:0.8rem;">등록된 생성기가 없습니다.</div>';
        return;
    }

    listEl.innerHTML = studioDraftGenerators.map((gen, idx) => {
        const isActive = selectedStudioGenId && String(gen.id) === String(selectedStudioGenId);
        return `
            <div class="gen-studio-item ${isActive ? 'active' : ''}" draggable="true" data-index="${idx}" data-id="${gen.id}" onclick="selectGeneratorInStudio('${gen.id}')">
                <div class="drag-handle" title="드래그하여 순서 변경" onclick="event.stopPropagation()">⋮⋮</div>
                <div style="font-size: 1.3rem; padding: 2px; line-height: 1;">${escapeHtml(gen.icon || '🎲')}</div>
                <div class="gen-item-info">
                    <div class="gen-item-title-line">
                        <span class="gen-item-title">${escapeHtml(gen.name || '생성기')}</span>
                        <span class="gen-card-cat" style="font-size:0.6rem; padding:1px 4px;">${escapeHtml(gen.category || '기타')}</span>
                    </div>
                    <div class="gen-item-sub">${escapeHtml(gen.description || '(설명 없음)')}</div>
                </div>
            </div>
        `;
    }).join('');

    if (rebindEvents) {
        initGeneratorsDragAndDrop();
    }
}

function initGeneratorsDragAndDrop() {
    const listEl = document.getElementById('generators-manage-list');
    if (!listEl) return;

    let dragSrcEl = null;
    const items = listEl.querySelectorAll('.gen-studio-item');

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

                // Draft 배열 내 순서만 변경 (디스크 쓰기 없음!)
                const movedItem = studioDraftGenerators.splice(fromIdx, 1)[0];
                studioDraftGenerators.splice(toIdx, 0, movedItem);

                renderGeneratorsManageList();
            }
        });
    });
}

// 5. 작성 중인 스크립트 즉시 테스트 실행
async function testGeneratorCode() {
    const codeIn = document.getElementById('gen-code-input');
    const outputBar = document.getElementById('gen-test-output-bar');
    const outputText = document.getElementById('gen-test-output-text');
    const timeText = document.getElementById('gen-test-time');
    if (!codeIn || !outputBar || !outputText) return;

    const code = codeIn.value.trim();
    if (!code) {
        await showAppAlert('테스트할 JavaScript 코드가 비어있습니다.', '코드 확인', '⚠️');
        return;
    }

    outputBar.style.display = 'block';
    const startTime = performance.now();

    try {
        const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
        const fn = new AsyncFunction(code);
        const result = await fn();
        const duration = (performance.now() - startTime).toFixed(2);

        outputBar.className = 'gen-test-output-bar';
        if (timeText) timeText.textContent = `⏱️ ${duration}ms (정상 반환)`;
        outputText.textContent = typeof result === 'object' ? JSON.stringify(result, null, 2) : String(result);
    } catch (err) {
        const duration = (performance.now() - startTime).toFixed(2);
        outputBar.className = 'gen-test-output-bar error';
        if (timeText) timeText.textContent = `⏱️ ${duration}ms (오류 발생)`;
        outputText.textContent = `🚨 ${err.name}: ${err.message}`;
    }
}

function hideTestOutput() {
    const outputBar = document.getElementById('gen-test-output-bar');
    if (outputBar) outputBar.style.display = 'none';
}

// 6. Draft에서 현재 선택된 생성기 삭제 (디스크 저장 없음)
async function deleteCurrentGenerator() {
    if (!selectedStudioGenId) return;

    const gen = studioDraftGenerators.find(g => String(g.id) === String(selectedStudioGenId));
    if (!gen) return;

    const confirmed = await showAppConfirm(
        `'${gen.name}' 생성기를 목록에서 제거하시겠습니까?\n(하단의 [💾 변경사항 저장]을 눌러야 최종 반영되며, [취소] 시 복구됩니다)`,
        { title: '생성기 삭제', icon: '🗑️', confirmText: '삭제', isDanger: true }
    );
    if (!confirmed) return;

    // Draft에서만 삭제
    studioDraftGenerators = studioDraftGenerators.filter(g => String(g.id) !== String(selectedStudioGenId));

    selectedStudioGenId = studioDraftGenerators.length > 0 ? studioDraftGenerators[0].id : null;
    renderGeneratorsManageList();
    loadGeneratorToEditor(selectedStudioGenId);
}

// 7. Draft에 기본 템플릿 로드 (디스크 저장 없음)
async function resetDefaultGenerators() {
    const confirmed = await showAppConfirm(
        '모든 생성기를 기본 템플릿 목록으로 되돌리시겠습니까?\n(하단의 [💾 변경사항 저장]을 눌러야 최종 반영됩니다)',
        { title: '기본값 복원', icon: '🔄', confirmText: '복원', isDanger: true }
    );
    if (!confirmed) return;

    studioDraftGenerators = JSON.parse(JSON.stringify(DEFAULT_GENERATORS_FALLBACK));
    selectedStudioGenId = studioDraftGenerators.length > 0 ? studioDraftGenerators[0].id : null;
    renderGeneratorsManageList();
    loadGeneratorToEditor(selectedStudioGenId);
}

// 8. Write-Back 최종 커밋 & 디스크 영구 저장
async function saveStudioChanges() {
    syncCurrentEditorToDraft();

    // 유효성 검사: 이름이나 코드가 빈 항목이 있는지 검사
    for (let i = 0; i < studioDraftGenerators.length; i++) {
        const g = studioDraftGenerators[i];
        if (!g.name || !g.name.trim()) {
            await showAppAlert(`[항목 #${i+1}] 생성기 이름을 입력해 주세요.`, '입력 필요', '⚠️');
            selectGeneratorInStudio(g.id);
            document.getElementById('gen-name-input')?.focus();
            return;
        }
        if (!g.code || !g.code.trim()) {
            await showAppAlert(`'${g.name}' 생성기의 JavaScript 코드를 입력해 주세요.`, '코드 입력 필요', '⚠️');
            selectGeneratorInStudio(g.id);
            document.getElementById('gen-code-input')?.focus();
            return;
        }
    }

    // 1) Draft 버퍼를 실제 마스터에 커밋
    currentGenerators = JSON.parse(JSON.stringify(studioDraftGenerators));

    // 2) 디스크 파일에 1회 최종 Write-Back 기록
    await saveGeneratorsToServer();

    // 3) 메인 화면 갱신 및 모달 닫기
    renderGeneratorsUI();
    closeGeneratorsModal();

    logToConsole('데이터 생성기 변경사항 저장 완료', {
        메시지: `총 ${currentGenerators.length}개의 데이터 생성기 설정이 안전하게 영구 저장되었습니다.`,
        등록목록: currentGenerators.map(g => `${g.icon} ${g.name}`)
    });
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
        syncCurrentEditorToDraft();
        codeArea.focus();
    }
}

// 에디터 Tab 키 4칸 들여쓰기 및 실시간 입력 동기화
function initGenCodeEditorTabKey() {
    const editor = document.getElementById('gen-code-input');
    if (editor) {
        editor.addEventListener('keydown', (e) => {
            if (e.key === 'Tab') {
                e.preventDefault();
                const start = editor.selectionStart;
                const end = editor.selectionEnd;
                editor.value = editor.value.substring(0, start) + '    ' + editor.value.substring(end);
                editor.selectionStart = editor.selectionEnd = start + 4;
                syncCurrentEditorToDraft();
            }
        });
        editor.addEventListener('input', onStudioFieldInput);
    }

    ['gen-name-input', 'gen-icon-input', 'gen-category-input', 'gen-desc-input'].forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.addEventListener('input', onStudioFieldInput);
        }
    });
}

// 하위 호환용 기존 함수 바인딩
function callGenerateBizID(formatted) {
    runGenerator("1", 1);
}

function callGenerateBizIDBulk(count = 5) {
    runGenerator("1", count);
}

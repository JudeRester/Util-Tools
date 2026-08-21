/**
 * Mermaid 다이어그램 시각화 스튜디오 (Mermaid Diagram Studio) 모듈
 * 실시간 텍스트 기반 다이어그램 렌더링, 템플릿 프리셋 연동, 줌/팬 인터랙션, PNG/SVG 내보내기 지원
 * (템플릿 데이터는 js/mermaid_templates.js 에서 분리 로드)
 */

let currentMermaidTheme = 'dark';
let mermaidZoomScale = 1.0;
let mermaidPanX = 0;
let mermaidPanY = 0;
let isMermaidPanning = false;
let mermaidPanStartX = 0;
let mermaidPanStartY = 0;
let mermaidRenderTimer = null;
let isMermaidEditorCollapsed = false;

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


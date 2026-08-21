/**
 * 폴더 바로가기 실시간 관리 및 탐색기/터미널 연동 모듈
 */

let currentShortcuts = [];
let editingShortcutId = null;

const DEFAULT_SHORTCUTS = [
    {"id": "1", "name": "현재 도구 모음", "path": ".", "icon": "📂"},
    {"id": "2", "name": "C 드라이브", "path": "C:\\", "icon": "💽"}
];

// 초기 로드
async function loadFolderShortcuts() {
    try {
        if (window.eel && eel.get_folder_shortcuts) {
            const res = await eel.get_folder_shortcuts()();
            if (res.status === 'success' && Array.isArray(res.data)) {
                currentShortcuts = res.data;
            } else {
                currentShortcuts = DEFAULT_SHORTCUTS;
            }
        } else {
            const saved = localStorage.getItem('folder_shortcuts');
            currentShortcuts = saved ? JSON.parse(saved) : DEFAULT_SHORTCUTS;
        }
    } catch (e) {
        currentShortcuts = DEFAULT_SHORTCUTS;
    }
    renderShortcutsUI();
}

// UI 렌더링 (그리드, 드롭다운, 모달 리스트)
function renderShortcutsUI() {
    // 1) 상단 터미널 드롭다운 갱신
    const selectEl = document.getElementById('terminal-path-select');
    if (selectEl) {
        const prevValue = selectEl.value;
        selectEl.innerHTML = currentShortcuts.map(item => `
            <option value="${escapeHtml(item.path)}">${item.icon || '📁'} ${escapeHtml(item.name)} (${escapeHtml(item.path)})</option>
        `).join('');
        if (prevValue && currentShortcuts.some(s => s.path === prevValue)) {
            selectEl.value = prevValue;
        }
    }

    // 2) 파일/폴더 탭 카드 그리드 갱신
    const gridEl = document.getElementById('folder-shortcuts-grid');
    if (gridEl) {
        if (currentShortcuts.length === 0) {
            gridEl.innerHTML = `
                <div style="grid-column: 1 / -1; padding: 24px; text-align: center; color: var(--text-secondary);">
                    등록된 폴더 바로가기가 없습니다. 상단의 <b>[⚙️ 편집]</b> 버튼을 눌러 추가해 보세요!
                </div>
            `;
        } else {
            gridEl.innerHTML = currentShortcuts.map(item => {
                const tooltip = `${item.name}\n경로: ${item.path}`;
                return `
                    <button class="tool-btn" onclick="callOpenDirectory('${escapeJsString(item.path)}')" title="${escapeHtml(tooltip)}">
                        <div class="btn-icon">${item.icon || '📁'}</div>
                        <div class="btn-text">
                            <h3>${escapeHtml(item.name)}</h3>
                            <p>${escapeHtml(item.path)}</p>
                        </div>
                    </button>
                `;
            }).join('');
        }
    }

    // 3) 모달 관리 리스트 갱신
    renderShortcutsManageList();
}

let draftShortcuts = [];

// 모달 관리 목록 렌더링 (Draft 기준)
function renderShortcutsManageList() {
    const list = document.getElementById('shortcuts-modal')?.classList.contains('show') ? draftShortcuts : currentShortcuts;
    const countBadge = document.getElementById('shortcut-count-badge');
    if (countBadge) countBadge.textContent = list.length;

    const manageListEl = document.getElementById('shortcuts-manage-list');
    if (!manageListEl) return;

    if (list.length === 0) {
        manageListEl.innerHTML = '<div style="color:var(--text-secondary); text-align:center; padding:15px; font-size:0.85rem;">등록된 바로가기가 없습니다.</div>';
        return;
    }

    manageListEl.innerHTML = list.map((item, idx) => `
        <div class="manage-item ${editingShortcutId === (item.id || idx.toString()) ? 'editing' : ''}" draggable="true" data-index="${idx}">
            <span class="drag-handle" title="마우스로 드래그하여 순서 변경">⋮⋮</span>
            <div class="manage-item-info">
                <div class="manage-item-name">${item.icon || '📁'} ${escapeHtml(item.name)}</div>
                <div class="manage-item-path" title="${escapeHtml(item.path)}">${escapeHtml(item.path)}</div>
            </div>
            <div class="manage-item-actions">
                <button type="button" class="item-edit-btn" onclick="startEditShortcut('${item.id || idx}')" title="수정">✏️</button>
                <button type="button" class="item-move-btn" onclick="moveShortcut(${idx}, -1)" ${idx === 0 ? 'disabled' : ''} title="위로 이동">▲</button>
                <button type="button" class="item-move-btn" onclick="moveShortcut(${idx}, 1)" ${idx === list.length - 1 ? 'disabled' : ''} title="아래로 이동">▼</button>
                <button type="button" class="item-delete-btn" onclick="deleteShortcut('${item.id || idx}')" title="삭제">삭제</button>
            </div>
        </div>
    `).join('');

    // 드래그 앤 드롭 이벤트 바인딩
    attachListDragAndDrop('shortcuts-manage-list', reorderShortcuts);
}

// 숏컷 드래그 앤 드롭 재정렬 (Draft 내에서만 순서 변경)
function reorderShortcuts(fromIndex, toIndex) {
    if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0) return;
    const movedItem = draftShortcuts.splice(fromIndex, 1)[0];
    draftShortcuts.splice(toIndex, 0, movedItem);
    renderShortcutsManageList();
}

// 숏컷 순서 변경 (위 / 아래)
function moveShortcut(index, direction) {
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= draftShortcuts.length) return;

    const temp = draftShortcuts[index];
    draftShortcuts[index] = draftShortcuts[targetIndex];
    draftShortcuts[targetIndex] = temp;

    renderShortcutsManageList();
}

// 숏컷 저장 (마스터 -> 디스크)
async function saveShortcuts() {
    try {
        localStorage.setItem('folder_shortcuts', JSON.stringify(currentShortcuts));
        if (window.eel && eel.save_folder_shortcuts) {
            await eel.save_folder_shortcuts(currentShortcuts)();
        }
    } catch (e) {
        console.error("저장 실패:", e);
    }
}

// 모달 열기/닫기 (Write-Back)
function openShortcutsModal() {
    draftShortcuts = JSON.parse(JSON.stringify(currentShortcuts));
    cancelEditShortcut();
    renderShortcutsManageList();
    document.getElementById('shortcuts-modal').classList.add('show');
}

function closeShortcutsModal() {
    cancelEditShortcut();
    draftShortcuts = [];
    document.getElementById('shortcuts-modal').classList.remove('show');
}

// 수정 모드 시작
function startEditShortcut(id) {
    const item = draftShortcuts.find((it, idx) => (it.id || idx.toString()) === id.toString());
    if (!item) return;

    editingShortcutId = id;
    document.getElementById('new-name-input').value = item.name;
    document.getElementById('new-path-input').value = item.path;

    document.getElementById('shortcut-form-title').textContent = `✏️ '${item.name}' 바로가기 수정`;
    const submitBtn = document.getElementById('shortcut-submit-btn');
    submitBtn.textContent = '💾 수정 완료';
    submitBtn.className = 'form-btn add-btn';

    document.getElementById('shortcut-cancel-btn').style.display = 'inline-block';
    document.getElementById('new-name-input').focus();
    renderShortcutsManageList();
}

// 수정 모드 취소
function cancelEditShortcut() {
    editingShortcutId = null;
    const nameIn = document.getElementById('new-name-input');
    const pathIn = document.getElementById('new-path-input');
    if (nameIn) nameIn.value = '';
    if (pathIn) pathIn.value = '';

    const titleEl = document.getElementById('shortcut-form-title');
    if (titleEl) titleEl.textContent = '➕ 새로운 바로가기 추가';

    const submitBtn = document.getElementById('shortcut-submit-btn');
    if (submitBtn) submitBtn.textContent = '추가';

    const cancelBtn = document.getElementById('shortcut-cancel-btn');
    if (cancelBtn) cancelBtn.style.display = 'none';

    renderShortcutsManageList();
}

// 탐색기로 폴더 선택 대화상자 호출
async function pickFolderFromExplorer() {
    try {
        if (window.eel && eel.select_folder_dialog) {
            const res = await eel.select_folder_dialog()();
            if (res.status === 'success' && res.path) {
                document.getElementById('new-path-input').value = res.path;
                const nameInput = document.getElementById('new-name-input');
                if (!nameInput.value.trim()) {
                    const parts = res.path.split(/[\\/]/).filter(Boolean);
                    nameInput.value = parts.length > 0 ? parts[parts.length - 1] : '새 폴더';
                }
            }
        } else {
            await showAppAlert('폴더 선택 대화상자를 지원하지 않는 환경입니다. 직접 경로를 입력해 주세요.', '알림', 'ℹ️');
        }
    } catch (e) {
        logToConsole('폴더 선택 오류:', e);
    }
}

// 새 숏컷 추가 또는 기존 숏컷 수정 완료 (Draft에만 반영)
async function addNewShortcut() {
    const nameInput = document.getElementById('new-name-input');
    const pathInput = document.getElementById('new-path-input');

    const name = nameInput.value.trim();
    const path = pathInput.value.trim();

    if (!name || !path) {
        await showAppAlert('이름과 폴더 경로를 모두 입력해 주세요.', '입력 필요', '⚠️');
        return;
    }

    const icon = path.includes(':') && path.length <= 3 ? '💽' : '📁';

    if (editingShortcutId !== null) {
        // 수정 모드
        const targetIdx = draftShortcuts.findIndex((it, idx) => (it.id || idx.toString()) === editingShortcutId.toString());
        if (targetIdx !== -1) {
            draftShortcuts[targetIdx].name = name;
            draftShortcuts[targetIdx].path = path;
            draftShortcuts[targetIdx].icon = icon;
        }
        cancelEditShortcut();
    } else {
        // 신규 추가 모드
        const newObj = {
            id: Date.now().toString(),
            name: name,
            path: path,
            icon: icon
        };
        draftShortcuts.push(newObj);
        nameInput.value = '';
        pathInput.value = '';
        cancelEditShortcut();
    }

    renderShortcutsManageList();
}

// 숏컷 삭제 (Draft에서만 제거)
async function deleteShortcut(id) {
    if (editingShortcutId === id) {
        cancelEditShortcut();
    }
    const item = draftShortcuts.find((it, idx) => (it.id || idx.toString()) === id.toString());
    const confirmed = await showAppConfirm(`'${item ? item.name : '선택한'}' 바로가기를 삭제하시겠습니까?\n(하단의 [💾 변경사항 저장]을 눌러야 최종 반영됩니다)`, {
        title: '바로가기 삭제',
        icon: '🗑️',
        confirmText: '삭제',
        isDanger: true
    });
    if (!confirmed) return;

    draftShortcuts = draftShortcuts.filter((it, idx) => (it.id || idx.toString()) !== id.toString());
    renderShortcutsManageList();
}

// 기본값 복원 (Draft에만 적용)
async function resetDefaultShortcuts() {
    const confirmed = await showAppConfirm('기본 폴더 바로가기 목록으로 되돌리시겠습니까?\n(하단의 [💾 변경사항 저장]을 눌러야 최종 반영됩니다)', {
        title: '기본값 복원',
        icon: '🔄',
        confirmText: '복원',
        isDanger: true
    });
    if (confirmed) {
        cancelEditShortcut();
        draftShortcuts = JSON.parse(JSON.stringify(DEFAULT_SHORTCUTS));
        renderShortcutsManageList();
    }
}

// Write-Back 최종 영구 저장
async function saveShortcutsChanges() {
    currentShortcuts = JSON.parse(JSON.stringify(draftShortcuts));
    await saveShortcuts();
    renderShortcutsUI();
    closeShortcutsModal();

    logToConsole('바로가기 변경사항 저장 완료', `총 ${currentShortcuts.length}개의 폴더 바로가기 설정이 안전하게 저장되었습니다.`);
}

// 탐색기로 열기 백엔드 호출
async function callOpenDirectory(path) {
    logToConsole('폴더 열기 요청...', path);
    try {
        if (window.eel && eel.open_directory) {
            const result = await eel.open_directory(path)();
            logToConsole('폴더 열기 결과', result.message || result);
        } else {
            logToConsole('실행 환경 안내', 'Eel 백엔드 연결 환경에서 실행 가능합니다.');
        }
    } catch (err) {
        logToConsole('호출 실패', err.message || err);
    }
}

// 선택된 드롭다운 위치에서 터미널 열기
async function callOpenTerminalAtDropdown(terminalType) {
    const selectEl = document.getElementById('terminal-path-select');
    if (!selectEl) return;
    const selectedPath = selectEl.value;

    logToConsole(`[${terminalType.toUpperCase()}] 터미널 실행 요청...`, `위치: ${selectedPath}`);
    try {
        if (window.eel && eel.open_terminal_at) {
            const result = await eel.open_terminal_at(selectedPath, terminalType)();
            logToConsole('터미널 실행 결과', result.message || result);
        } else {
            logToConsole('실행 환경 안내', 'Eel 백엔드 연결 환경에서 실행 가능합니다.');
        }
    } catch (err) {
        logToConsole('호출 실패', err.message || err);
    }
}

// HTML onclick="launchSelectedTerminal('powershell'|'cmd')" 호환용 래퍼
function launchSelectedTerminal(terminalType) {
    callOpenTerminalAtDropdown(terminalType);
}


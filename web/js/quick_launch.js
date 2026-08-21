/**
 * 빠른 실행(Quick Launch) 실시간 커스텀 관리 및 실행 모듈
 */

let currentQuickLaunch = [];
let editingQuickLaunchId = null;

const DEFAULT_QUICK_LAUNCH = [
    {"id": "1", "name": "계산기", "desc": "Windows 기본 계산기", "icon": "🔢", "type": "cmd", "command": "calc.exe"},
    {"id": "2", "name": "메모장", "desc": "간단한 텍스트 편집기", "icon": "📝", "type": "cmd", "command": "notepad.exe"},
    {"id": "3", "name": "작업 관리자", "desc": "프로세스 및 성능 모니터링", "icon": "📊", "type": "cmd", "command": "taskmgr.exe"},
    {"id": "4", "name": "명령 프롬프트", "desc": "CMD 콘솔 창 열기", "icon": "💻", "type": "cmd", "command": "cmd.exe"},
    {"id": "5", "name": "PowerShell", "desc": "파워쉘 콘솔 창 열기", "icon": "🟦", "type": "cmd", "command": "powershell.exe"},
    {"id": "6", "name": "레지스트리 편집기", "desc": "Windows Registry Editor", "icon": "⚙️", "type": "cmd", "command": "regedit.exe"},
    {"id": "7", "name": "SSH 서버 예시", "desc": "원격 SSH 접속 예시", "icon": "🔒", "type": "ssh", "command": "user@192.168.1.100"}
];

async function loadQuickLaunchItems() {
    try {
        if (window.eel && eel.get_quick_launch_items) {
            const res = await eel.get_quick_launch_items()();
            if (res.status === 'success' && Array.isArray(res.data)) {
                currentQuickLaunch = res.data;
            } else {
                currentQuickLaunch = DEFAULT_QUICK_LAUNCH;
            }
        } else {
            const saved = localStorage.getItem('quick_launch_items');
            currentQuickLaunch = saved ? JSON.parse(saved) : DEFAULT_QUICK_LAUNCH;
        }
    } catch (e) {
        currentQuickLaunch = DEFAULT_QUICK_LAUNCH;
    }
    renderQuickLaunchUI();
}

function renderQuickLaunchUI() {
    const gridEl = document.getElementById('quick-launch-grid');
    if (gridEl) {
        if (currentQuickLaunch.length === 0) {
            gridEl.innerHTML = `
                <div style="grid-column: 1 / -1; padding: 24px; text-align: center; color: var(--text-secondary);">
                    등록된 빠른 실행 항목이 없습니다. 상단의 <b>[⚙️ 편집]</b> 버튼을 눌러 원하는 앱을 추가해 보세요!
                </div>
            `;
        } else {
            gridEl.innerHTML = currentQuickLaunch.map((item, idx) => {
                const tooltip = `${item.name}\n${item.desc ? `설명: ${item.desc}\n` : ''}명령어: ${item.command}`;
                return `
                    <button class="tool-btn" onclick="callExecuteQuickLaunchItem(${idx})" title="${escapeHtml(tooltip)}">
                        <div class="btn-icon">${item.icon || '⚡'}</div>
                        <div class="btn-text">
                            <h3>${escapeHtml(item.name)}</h3>
                            <p>${escapeHtml(item.desc || item.command)}</p>
                        </div>
                    </button>
                `;
            }).join('');
        }
    }

    const countBadge = document.getElementById('ql-count-badge');
    if (countBadge) countBadge.textContent = currentQuickLaunch.length;

    const manageListEl = document.getElementById('ql-manage-list');
    if (manageListEl) {
        if (currentQuickLaunch.length === 0) {
            manageListEl.innerHTML = '<div style="color:var(--text-secondary); text-align:center; padding:15px; font-size:0.85rem;">등록된 항목이 없습니다.</div>';
        } else {
            manageListEl.innerHTML = currentQuickLaunch.map((item, idx) => `
                <div class="manage-item ${editingQuickLaunchId === (item.id || idx.toString()) ? 'editing' : ''}" draggable="true" data-index="${idx}">
                    <span class="drag-handle" title="마우스로 드래그하여 순서 변경">⋮⋮</span>
                    <div class="manage-item-info">
                        <div class="manage-item-name">
                            ${item.icon || '⚡'} ${escapeHtml(item.name)}
                            <span class="shortcut-tip" style="font-size:0.7rem; font-weight:normal;">${escapeHtml(item.type || 'cmd')}</span>
                        </div>
                        <div class="manage-item-path" title="${escapeHtml(item.command)}">
                            ${escapeHtml(item.desc ? `${item.desc} (${item.command})` : item.command)}
                        </div>
                    </div>
                    <div class="manage-item-actions">
                        <button type="button" class="item-edit-btn" onclick="startEditQuickLaunch('${item.id || idx}')" title="수정">✏️</button>
                        <button type="button" class="item-move-btn" onclick="moveQuickLaunchItem(${idx}, -1)" ${idx === 0 ? 'disabled' : ''} title="위로 이동">▲</button>
                        <button type="button" class="item-move-btn" onclick="moveQuickLaunchItem(${idx}, 1)" ${idx === currentQuickLaunch.length - 1 ? 'disabled' : ''} title="아래로 이동">▼</button>
                        <button type="button" class="item-delete-btn" onclick="deleteQuickLaunchItem('${item.id || idx}')" title="삭제">삭제</button>
                    </div>
                </div>
            `).join('');

            // 드래그 앤 드롭 이벤트 바인딩
            attachListDragAndDrop('ql-manage-list', reorderQuickLaunch);
        }
    }
}

async function callExecuteQuickLaunchItem(idx) {
    const item = currentQuickLaunch[idx];
    if (!item) return;

    logToConsole(`실행 요청: ${item.name}`, `[타입: ${item.type || 'cmd'}] ${item.command}`);
    try {
        if (window.eel && eel.execute_quick_launch_item) {
            const res = await eel.execute_quick_launch_item(item)();
            logToConsole('실행 결과:', res.message || res);
        } else {
            if (item.type === 'url') {
                window.open(item.command, '_blank');
            } else {
                logToConsole('실행 안내', 'Eel 백엔드 연결 환경에서 실행 가능합니다.');
            }
        }
    } catch (err) {
        logToConsole('실행 실패:', err.message || err);
    }
}

async function saveQuickLaunch() {
    try {
        localStorage.setItem('quick_launch_items', JSON.stringify(currentQuickLaunch));
        if (window.eel && eel.save_quick_launch_items) {
            await eel.save_quick_launch_items(currentQuickLaunch)();
        }
    } catch (e) {
        console.error("저장 실패:", e);
    }
}

function openQuickLaunchModal() {
    cancelEditQuickLaunch();
    renderQuickLaunchUI();
    document.getElementById('quick-launch-modal').classList.add('show');
}

function closeQuickLaunchModal() {
    cancelEditQuickLaunch();
    document.getElementById('quick-launch-modal').classList.remove('show');
}

// 빠른 실행 수정 모드 시작
function startEditQuickLaunch(id) {
    const item = currentQuickLaunch.find((it, idx) => (it.id || idx.toString()) === id.toString());
    if (!item) return;

    editingQuickLaunchId = id;
    document.getElementById('new-ql-icon').value = item.icon || '🚀';
    document.getElementById('new-ql-name').value = item.name || '';
    document.getElementById('new-ql-type').value = item.type || 'cmd';
    document.getElementById('new-ql-desc').value = item.desc || '';
    document.getElementById('new-ql-command').value = item.command || '';

    onQuickLaunchTypeChange(item.type || 'cmd');

    document.getElementById('ql-form-title').textContent = `✏️ '${item.name}' 항목 수정`;
    const submitBtn = document.getElementById('ql-submit-btn');
    submitBtn.textContent = '💾 수정 완료';
    submitBtn.className = 'form-btn add-btn';

    document.getElementById('ql-cancel-btn').style.display = 'inline-block';
    document.getElementById('new-ql-name').focus();
    renderQuickLaunchUI();
}

// 빠른 실행 수정 모드 취소
function cancelEditQuickLaunch() {
    editingQuickLaunchId = null;
    document.getElementById('new-ql-icon').value = '🚀';
    document.getElementById('new-ql-name').value = '';
    document.getElementById('new-ql-type').value = 'cmd';
    document.getElementById('new-ql-desc').value = '';
    document.getElementById('new-ql-command').value = '';

    onQuickLaunchTypeChange('cmd');

    const titleEl = document.getElementById('ql-form-title');
    if (titleEl) titleEl.textContent = '➕ 새로운 빠른 실행 항목 추가';

    const submitBtn = document.getElementById('ql-submit-btn');
    if (submitBtn) submitBtn.textContent = '추가';

    const cancelBtn = document.getElementById('ql-cancel-btn');
    if (cancelBtn) cancelBtn.style.display = 'none';

    renderQuickLaunchUI();
}

function onQuickLaunchTypeChange(type) {
    const cmdInput = document.getElementById('new-ql-command');
    const browseBtn = document.getElementById('ql-browse-btn');
    const iconInput = document.getElementById('new-ql-icon');

    if (type === 'ssh') {
        cmdInput.placeholder = 'SSH 대상 (예: user@192.168.1.100 또는 192.168.1.100)';
        browseBtn.style.display = 'none';
        if (iconInput.value === '🚀' || !iconInput.value) iconInput.value = '🔒';
    } else if (type === 'url') {
        cmdInput.placeholder = '웹 URL (예: https://github.com 또는 http://localhost:8080)';
        browseBtn.style.display = 'none';
        if (iconInput.value === '🚀' || !iconInput.value) iconInput.value = '🌐';
    } else if (type === 'powershell_cmd') {
        cmdInput.placeholder = '실행할 PowerShell 명령어 (예: Get-Process | Select-Object -First 10)';
        browseBtn.style.display = 'none';
        if (iconInput.value === '🚀' || !iconInput.value) iconInput.value = '🟦';
    } else {
        cmdInput.placeholder = '명령어 또는 실행 파일 경로 (예: calc.exe 또는 C:\\Program Files\\...)';
        browseBtn.style.display = 'block';
        if (iconInput.value === '🚀' || !iconInput.value) iconInput.value = '💻';
    }
}

async function pickExecutableFromExplorer() {
    try {
        if (window.eel && eel.select_file_dialog) {
            const res = await eel.select_file_dialog()();
            if (res.status === 'success' && res.path) {
                document.getElementById('new-ql-command').value = res.path;
                const nameInput = document.getElementById('new-ql-name');
                if (!nameInput.value.trim()) {
                    const filename = res.path.split(/[\\/]/).pop().replace(/\.[^/.]+$/, '');
                    nameInput.value = filename;
                }
            }
        }
    } catch (e) {
        logToConsole('파일 선택 오류:', e);
    }
}

// 새 빠른 실행 추가 또는 기존 항목 수정 완료
async function addNewQuickLaunchItem() {
    const icon = document.getElementById('new-ql-icon').value.trim() || '⚡';
    const name = document.getElementById('new-ql-name').value.trim();
    const type = document.getElementById('new-ql-type').value;
    const desc = document.getElementById('new-ql-desc').value.trim();
    const command = document.getElementById('new-ql-command').value.trim();

    if (!name || !command) {
        await showAppAlert('이름과 실행 명령어/경로를 모두 입력해 주세요.', '입력 필요', '⚠️');
        return;
    }

    if (editingQuickLaunchId !== null) {
        // 수정 모드
        const targetIdx = currentQuickLaunch.findIndex((it, idx) => (it.id || idx.toString()) === editingQuickLaunchId.toString());
        if (targetIdx !== -1) {
            currentQuickLaunch[targetIdx].name = name;
            currentQuickLaunch[targetIdx].desc = desc || command;
            currentQuickLaunch[targetIdx].icon = icon;
            currentQuickLaunch[targetIdx].type = type;
            currentQuickLaunch[targetIdx].command = command;
            logToConsole('빠른 실행 항목 수정 완료', `[${name}] ${command}`);
        }
        cancelEditQuickLaunch();
    } else {
        // 신규 추가 모드
        const newItem = {
            id: Date.now().toString(),
            name,
            desc: desc || command,
            icon,
            type,
            command
        };
        currentQuickLaunch.push(newItem);
        document.getElementById('new-ql-name').value = '';
        document.getElementById('new-ql-desc').value = '';
        document.getElementById('new-ql-command').value = '';
        document.getElementById('new-ql-icon').value = '🚀';
        logToConsole('빠른 실행 항목 추가 완료', `[${name}] ${command}`);
    }

    await saveQuickLaunch();
    renderQuickLaunchUI();
}

async function deleteQuickLaunchItem(id) {
    if (editingQuickLaunchId === id) {
        cancelEditQuickLaunch();
    }
    currentQuickLaunch = currentQuickLaunch.filter((item, idx) => (item.id || idx.toString()) !== id.toString());
    await saveQuickLaunch();
    renderQuickLaunchUI();
    logToConsole('빠른 실행 항목 삭제 완료', `ID: ${id}`);
}

async function moveQuickLaunchItem(index, direction) {
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= currentQuickLaunch.length) return;

    const temp = currentQuickLaunch[index];
    currentQuickLaunch[index] = currentQuickLaunch[targetIndex];
    currentQuickLaunch[targetIndex] = temp;

    await saveQuickLaunch();
    renderQuickLaunchUI();
}

async function resetDefaultQuickLaunch() {
    const confirmed = await showAppConfirm('기본 빠른 실행 목록으로 복원하시겠습니까?', {
        title: '기본값 복원',
        icon: '🔄',
        confirmText: '복원',
        isDanger: true
    });
    if (confirmed) {
        cancelEditQuickLaunch();
        currentQuickLaunch = JSON.parse(JSON.stringify(DEFAULT_QUICK_LAUNCH));
        await saveQuickLaunch();
        renderQuickLaunchUI();
        logToConsole('빠른 실행 초기화', '기본값으로 복원되었습니다.');
    }
}

// 빠른 실행 드래그 앤 드롭 재정렬
async function reorderQuickLaunch(fromIndex, toIndex) {
    if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0) return;
    const movedItem = currentQuickLaunch.splice(fromIndex, 1)[0];
    currentQuickLaunch.splice(toIndex, 0, movedItem);
    await saveQuickLaunch();
    renderQuickLaunchUI();
    logToConsole('순서 변경 완료', `'${movedItem.name}' 위치 이동 (${fromIndex + 1}번 ➔ ${toIndex + 1}번)`);
}

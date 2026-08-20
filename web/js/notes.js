/**
 * 빠른 메모 / 스크래치패드(Notes & Scratchpad) 관리 모듈
 */

let currentNotes = [];
let activeNoteId = null;
let noteSaveTimeout = null;
let noteSearchKeyword = '';

const DEFAULT_NOTES_FALLBACK = [
    {
        "id": "1",
        "title": "📌 오늘의 할 일",
        "content": "- [ ] 주간 업무 정리\n- [ ] 코드 리뷰 및 테스트\n- [ ] 서버 상태 점검",
        "updatedAt": "2026-08-20 12:00:00"
    },
    {
        "id": "2",
        "title": "🧪 임시 스크래치패드",
        "content": "// 임시 SQL 쿼리, JSON, 토큰, 명령어 등을 자유롭게 적어두세요.\n// 입력하는 즉시 로컬 PC에 안전하게 자동 저장됩니다.",
        "updatedAt": "2026-08-20 12:00:00"
    }
];

// 실시간 검색 처리
function onNoteSearch(keyword) {
    noteSearchKeyword = (keyword || '').trim().toLowerCase();

    const clearBtn = document.getElementById('notes-search-clear-btn');
    if (clearBtn) {
        clearBtn.style.display = noteSearchKeyword ? 'block' : 'none';
    }

    renderNotesUI();
}

function clearNoteSearch() {
    const searchInput = document.getElementById('notes-search-input');
    if (searchInput) {
        searchInput.value = '';
        searchInput.focus();
    }
    onNoteSearch('');
}

// 초기 로드
async function loadNotes() {
    initNotesResizer();
    try {
        if (window.eel && eel.get_notes) {
            const res = await eel.get_notes()();
            if (res.status === 'success' && Array.isArray(res.data) && res.data.length > 0) {
                currentNotes = res.data;
            } else {
                currentNotes = DEFAULT_NOTES_FALLBACK;
            }
        } else {
            const saved = localStorage.getItem('user_notes');
            currentNotes = saved ? JSON.parse(saved) : DEFAULT_NOTES_FALLBACK;
        }
    } catch (e) {
        currentNotes = DEFAULT_NOTES_FALLBACK;
    }

    if (!activeNoteId && currentNotes.length > 0) {
        activeNoteId = currentNotes[0].id;
    }

    renderNotesUI();
}

// 메모장 좌우 스플리터(Resizer) 초기화 및 너비 드래그 제어
function initNotesResizer() {
    const resizer = document.getElementById('notes-resizer');
    const sidebar = document.getElementById('notes-sidebar');
    const container = document.querySelector('.notes-container');
    if (!resizer || !sidebar || !container) return;

    // 저장된 좌측 너비 복원
    const savedWidth = (typeof appSettings !== 'undefined' && appSettings.notes_sidebar_width) || localStorage.getItem('notes_sidebar_width');
    if (savedWidth) {
        sidebar.style.flex = 'none';
        sidebar.style.width = `${savedWidth}px`;
    }

    let isDragging = false;
    let startX = 0;
    let startWidth = 0;

    resizer.addEventListener('mousedown', (e) => {
        isDragging = true;
        startX = e.clientX;
        startWidth = sidebar.getBoundingClientRect().width;

        resizer.classList.add('dragging');
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';

        const onMouseMove = (moveEvent) => {
            if (!isDragging) return;
            const deltaX = moveEvent.clientX - startX;
            let newWidth = startWidth + deltaX;

            const containerWidth = container.getBoundingClientRect().width;
            const minWidth = 180;
            const maxWidth = containerWidth - 260; // 우측 에디터 최소 260px 확보

            if (newWidth < minWidth) newWidth = minWidth;
            if (newWidth > maxWidth) newWidth = maxWidth;

            sidebar.style.flex = 'none';
            sidebar.style.width = `${newWidth}px`;
        };

        const onMouseUp = () => {
            if (!isDragging) return;
            isDragging = false;
            resizer.classList.remove('dragging');
            document.body.style.cursor = '';
            document.body.style.userSelect = '';

            const finalWidth = Math.round(sidebar.getBoundingClientRect().width);
            if (typeof saveAppSettingKey === 'function') {
                saveAppSettingKey('notes_sidebar_width', finalWidth);
            } else {
                localStorage.setItem('notes_sidebar_width', finalWidth);
            }

            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
        };

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
    });
}

function renderNotesUI() {
    // 0. 검색 필터링 적용
    const filteredNotes = noteSearchKeyword
        ? currentNotes.filter(n =>
            (n.title || '').toLowerCase().includes(noteSearchKeyword) ||
            (n.content || '').toLowerCase().includes(noteSearchKeyword)
        )
        : currentNotes;

    // 1. 메모 수 뱃지
    const countBadge = document.getElementById('notes-count-badge');
    if (countBadge) {
        countBadge.textContent = noteSearchKeyword
            ? `${filteredNotes.length}/${currentNotes.length}`
            : currentNotes.length;
    }

    // 2. 좌측 목록 렌더링
    const listEl = document.getElementById('notes-list-items');
    if (listEl) {
        if (filteredNotes.length === 0) {
            if (noteSearchKeyword) {
                listEl.innerHTML = `
                    <div style="color:var(--text-secondary); text-align:center; padding:20px; font-size:0.82rem;">
                        '${escapeHtml(noteSearchKeyword)}' 검색 결과가 없습니다.
                    </div>
                `;
            } else {
                listEl.innerHTML = '<div style="color:var(--text-secondary); text-align:center; padding:20px; font-size:0.85rem;">메모가 없습니다.<br>상단 [+ 새 메모]를 눌러보세요.</div>';
            }
        } else {
            listEl.innerHTML = filteredNotes.map(note => {
                const isActive = note.id === activeNoteId;
                const preview = (note.content || '').trim().split('\n')[0] || '(빈 내용)';
                return `
                    <div class="note-list-item ${isActive ? 'active' : ''}" onclick="selectNote('${note.id}')">
                        <div class="note-item-title">${escapeHtml(note.title || '제목 없음')}</div>
                        <div class="note-item-preview">${escapeHtml(preview)}</div>
                        <div class="note-item-date">${escapeHtml(note.updatedAt || '')}</div>
                    </div>
                `;
            }).join('');
        }
    }

    // 3. 우측 에디터 렌더링
    const activeNote = currentNotes.find(n => n.id === activeNoteId);
    const titleInput = document.getElementById('note-title-input');
    const contentEditor = document.getElementById('note-content-editor');

    if (activeNote) {
        if (titleInput) {
            titleInput.value = activeNote.title || '';
            titleInput.disabled = false;
        }
        if (contentEditor) {
            contentEditor.value = activeNote.content || '';
            contentEditor.disabled = false;
        }
        updateNoteStats(activeNote.content || '');
    } else {
        if (titleInput) {
            titleInput.value = '';
            titleInput.placeholder = '메모를 선택하거나 새로 생성하세요';
            titleInput.disabled = true;
        }
        if (contentEditor) {
            contentEditor.value = '';
            contentEditor.placeholder = '메모가 없습니다.';
            contentEditor.disabled = true;
        }
        updateNoteStats('');
    }
}

function selectNote(id) {
    activeNoteId = id;
    renderNotesUI();
    const contentEditor = document.getElementById('note-content-editor');
    if (contentEditor) contentEditor.focus();
}

async function addNewNote() {
    return await createNoteWithContent(`📝 새 메모 ${currentNotes.length + 1}`, "");
}

async function createNoteWithContent(title, content) {
    const newId = Date.now().toString();
    const nowStr = new Date().toLocaleString();
    const newNote = {
        id: newId,
        title: title || `📝 새 메모 ${currentNotes.length + 1}`,
        content: content || "",
        updatedAt: nowStr
    };
    currentNotes.unshift(newNote);
    activeNoteId = newId;

    await saveNotesImmediately();
    renderNotesUI();

    const titleInput = document.getElementById('note-title-input');
    if (titleInput) {
        titleInput.focus();
        titleInput.select();
    }
    return newNote;
}

function onNoteTitleChange(newTitle) {
    const activeNote = currentNotes.find(n => n.id === activeNoteId);
    if (!activeNote) return;

    activeNote.title = newTitle;
    activeNote.updatedAt = new Date().toLocaleString();

    // 좌측 목록 실시간 갱신 (선택 상태 유지)
    const listEl = document.getElementById('notes-list-items');
    if (listEl) {
        const itemEl = listEl.querySelector(`.note-list-item.active .note-item-title`);
        if (itemEl) itemEl.textContent = newTitle || '제목 없음';
    }

    triggerAutoSave();
}

function onNoteContentChange(newContent) {
    const activeNote = currentNotes.find(n => n.id === activeNoteId);
    if (!activeNote) return;

    activeNote.content = newContent;
    activeNote.updatedAt = new Date().toLocaleString();

    // 미리보기 및 통계 갱신
    updateNoteStats(newContent);
    const listEl = document.getElementById('notes-list-items');
    if (listEl) {
        const previewEl = listEl.querySelector(`.note-list-item.active .note-item-preview`);
        const firstLine = newContent.trim().split('\n')[0] || '(빈 내용)';
        if (previewEl) previewEl.textContent = firstLine;
    }

    triggerAutoSave();
}

function updateNoteStats(text) {
    const charCountEl = document.getElementById('note-char-count');
    if (!charCountEl) return;

    const chars = text.length;
    const lines = text ? text.split('\n').length : 0;
    charCountEl.textContent = `${chars.toLocaleString()} 글자 | ${lines.toLocaleString()} 줄`;
}

function bringNoteToTop(id) {
    if (!id) return false;
    const idx = currentNotes.findIndex(n => n.id === id);
    if (idx > 0) {
        const [note] = currentNotes.splice(idx, 1);
        currentNotes.unshift(note);
        return true;
    }
    return false;
}

function triggerAutoSave() {
    const statusEl = document.getElementById('note-save-status');
    if (statusEl) {
        statusEl.textContent = '⏳ 저장 중...';
        statusEl.className = 'save-status saving';
    }

    clearTimeout(noteSaveTimeout);
    noteSaveTimeout = setTimeout(async () => {
        const moved = bringNoteToTop(activeNoteId);
        await saveNotesImmediately();
        if (moved) {
            renderNotesUI();
        }
    }, 450);
}

async function saveNotesImmediately() {
    try {
        localStorage.setItem('user_notes', JSON.stringify(currentNotes));
        if (window.eel && eel.save_notes) {
            await eel.save_notes(currentNotes)();
        }
        const statusEl = document.getElementById('note-save-status');
        if (statusEl) {
            statusEl.textContent = '💾 자동 저장됨';
            statusEl.className = 'save-status';
        }
    } catch (e) {
        console.error("메모 저장 실패:", e);
        const statusEl = document.getElementById('note-save-status');
        if (statusEl) {
            statusEl.textContent = '⚠️ 저장 실패';
            statusEl.className = 'save-status error';
        }
    }
}

async function copyCurrentNote() {
    const activeNote = currentNotes.find(n => n.id === activeNoteId);
    if (!activeNote || !activeNote.content) {
        alert('복사할 메모 내용이 없습니다.');
        return;
    }

    try {
        await navigator.clipboard.writeText(activeNote.content);
        activeNote.updatedAt = new Date().toLocaleString();
        
        // 최근 복사된 메모를 목록 맨 위로 이동
        bringNoteToTop(activeNoteId);
        await saveNotesImmediately();
        renderNotesUI();

        logToConsole('클립보드 복사 완료', `'${activeNote.title}' 내용이 복사되어 목록 맨 위로 이동되었습니다.`);
    } catch (e) {
        alert('클립보드 복사 실패: ' + e.message);
    }
}

async function moveCurrentNoteToTop() {
    const activeNote = currentNotes.find(n => n.id === activeNoteId);
    if (!activeNote) return;

    activeNote.updatedAt = new Date().toLocaleString();
    const moved = bringNoteToTop(activeNoteId);
    if (moved) {
        await saveNotesImmediately();
        renderNotesUI();
        logToConsole('상단 이동', `'${activeNote.title}' 메모가 목록 맨 위로 이동되었습니다.`);
    }
}

function clearCurrentNote() {
    const activeNote = currentNotes.find(n => n.id === activeNoteId);
    if (!activeNote) return;

    if (confirm(`'${activeNote.title}' 메모의 내용을 모두 비우시겠습니까?`)) {
        activeNote.content = '';
        activeNote.updatedAt = new Date().toLocaleString();
        const editor = document.getElementById('note-content-editor');
        if (editor) {
            editor.value = '';
            editor.focus();
        }
        updateNoteStats('');
        triggerAutoSave();
    }
}

async function deleteCurrentNote() {
    const activeNote = currentNotes.find(n => n.id === activeNoteId);
    if (!activeNote) return;

    if (confirm(`'${activeNote.title}' 메모를 영구 삭제하시겠습니까?`)) {
        currentNotes = currentNotes.filter(n => n.id !== activeNoteId);
        activeNoteId = currentNotes.length > 0 ? currentNotes[0].id : null;

        await saveNotesImmediately();
        renderNotesUI();
        logToConsole('메모 삭제', `'${activeNote.title}' 메모가 삭제되었습니다.`);
    }
}

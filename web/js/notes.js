/**
 * 빠른 메모 / 스크래치패드(Notes & Scratchpad) 관리 모듈
 * - 상위 보관함(카테고리) 분류 및 순서 관리
 * - 4대 정렬 옵션(수정순/최신순/과거순/가나다순) 및 📌 상단 고정(Pin)
 * - 비차단 인레이어 보관함 관리 모달
 * - 에디터 Tab/Shift+Tab 다중 라인 들여쓰기/내어쓰기 지원
 */

let currentNotes = [];
let activeNoteId = null;
let noteSaveTimeout = null;
let noteSearchKeyword = '';

// 보관함(카테고리) 및 정렬 상태 관리
let noteCategories = [];
let activeNoteCategory = 'all';
let noteSortOption = localStorage.getItem('notes_sort_option') || 'updated_desc';
let editingCategoryId = null;

const DEFAULT_CATEGORIES_FALLBACK = [
    { id: 'all', name: '전체', icon: '📌', sort_order: 0, is_system: 1, notes_count: 0 },
    { id: 'scratch', name: '스크래치패드', icon: '🧪', sort_order: 1, is_system: 1, notes_count: 0 },
    { id: 'work', name: '업무', icon: '💼', sort_order: 2, is_system: 0, notes_count: 0 },
    { id: 'personal', name: '개인', icon: '🏠', sort_order: 3, is_system: 0, notes_count: 0 }
];

const DEFAULT_NOTES_FALLBACK = [
    {
        "id": "1",
        "title": "📌 오늘의 할 일",
        "content": "- [ ] 주간 업무 정리\n- [ ] 코드 리뷰 및 테스트\n- [ ] 서버 상태 점검",
        "category": "work",
        "is_pinned": 1,
        "createdAt": "2026-08-20 12:00:00",
        "updatedAt": "2026-08-20 12:00:00"
    },
    {
        "id": "2",
        "title": "🧪 임시 스크래치패드",
        "content": "// 임시 SQL 쿼리, JSON, 토큰, 명령어 등을 자유롭게 적어두세요.\n// 입력하는 즉시 로컬 PC에 안전하게 자동 저장됩니다.",
        "category": "scratch",
        "is_pinned": 0,
        "createdAt": "2026-08-20 12:00:00",
        "updatedAt": "2026-08-20 12:00:00"
    }
];

// 실시간 검색 처리 (디바운스 200ms)
let noteSearchDebounceTimer = null;

function onNoteSearch(keyword) {
    const trimmed = (keyword || '').trim().toLowerCase();
    const clearBtn = document.getElementById('notes-search-clear-btn');
    if (clearBtn) {
        clearBtn.style.display = trimmed ? 'block' : 'none';
    }

    clearTimeout(noteSearchDebounceTimer);
    if (!trimmed) {
        noteSearchKeyword = '';
        renderNotesUI();
        return;
    }

    noteSearchDebounceTimer = setTimeout(() => {
        noteSearchKeyword = trimmed;
        renderNotesUI();
    }, 200);
}

function clearNoteSearch() {
    clearTimeout(noteSearchDebounceTimer);
    const searchInput = document.getElementById('notes-search-input');
    if (searchInput) {
        searchInput.value = '';
        searchInput.focus();
    }
    onNoteSearch('');
}

// 정렬 옵션 변경 핸들러
function onNoteSortChange(newSort) {
    noteSortOption = newSort || 'updated_desc';
    localStorage.setItem('notes_sort_option', noteSortOption);
    renderNotesUI();
}

// 초기 로드
async function loadNotes() {
    initNotesResizer();
    initNotesTabKeyHandler();

    // 정렬 셀렉트 박스 동기화
    const sortSelect = document.getElementById('notes-sort-select');
    if (sortSelect) {
        sortSelect.value = noteSortOption;
    }

    // 1. 카테고리(보관함) 목록 로드
    await loadNoteCategories();

    // 2. 메모 목록 로드
    try {
        if (window.eel && eel.get_notes) {
            const res = await eel.get_notes()();
            if (res.status === 'success' && Array.isArray(res.data) && res.data.length > 0) {
                currentNotes = res.data.map(n => ({
                    ...n,
                    category: n.category || 'scratch',
                    is_pinned: n.is_pinned ? 1 : 0
                }));
                try {
                    localStorage.setItem('user_notes', JSON.stringify(currentNotes));
                } catch (lsErr) {}
            } else {
                currentNotes = DEFAULT_NOTES_FALLBACK;
            }
        } else {
            const saved = localStorage.getItem('user_notes');
            currentNotes = saved ? JSON.parse(saved) : DEFAULT_NOTES_FALLBACK;
        }
    } catch (e) {
        console.error("메모 데이터 로드 실패:", e);
        currentNotes = DEFAULT_NOTES_FALLBACK;
    }

    // 활성 메모 지정
    const filtered = getFilteredAndSortedNotes();
    if (filtered.length > 0) {
        activeNoteId = filtered[0].id;
    } else if (currentNotes.length > 0) {
        activeNoteId = currentNotes[0].id;
    }

    renderCategoryBar();
    renderNotesUI();
}

// 카테고리 목록 조회
async function loadNoteCategories() {
    try {
        if (window.eel && eel.get_note_categories) {
            const res = await eel.get_note_categories()();
            if (res.status === 'success' && Array.isArray(res.data) && res.data.length > 0) {
                noteCategories = res.data;
            } else {
                noteCategories = DEFAULT_CATEGORIES_FALLBACK;
            }
        } else {
            const saved = localStorage.getItem('note_categories');
            noteCategories = saved ? JSON.parse(saved) : DEFAULT_CATEGORIES_FALLBACK;
        }
    } catch (e) {
        console.error("카테고리 로드 실패:", e);
        noteCategories = DEFAULT_CATEGORIES_FALLBACK;
    }
}

// 특정 카테고리의 소속 메모 수 계산
function getCategoryCount(catId) {
    if (catId === 'all') {
        return currentNotes.length;
    }
    return currentNotes.filter(n => (n.category || 'scratch') === catId).length;
}

// 특정 카테고리 정보 조회
function getCategoryInfo(catId) {
    return noteCategories.find(c => c.id === catId) || { id: catId, name: '기본 보관함', icon: '📁' };
}

// 상단 보관함 칩 바 렌더링
function renderCategoryBar() {
    const bar = document.getElementById('notes-category-bar');
    if (!bar) return;

    if (!noteCategories || noteCategories.length === 0) {
        noteCategories = DEFAULT_CATEGORIES_FALLBACK;
    }

    bar.innerHTML = noteCategories.map(cat => {
        const isActive = cat.id === activeNoteCategory;
        const count = getCategoryCount(cat.id);
        return `
            <button type="button" class="notes-category-chip ${isActive ? 'active' : ''}" 
                    onclick="selectNoteCategory('${cat.id}')" 
                    title="${escapeHtml(cat.name)} (${count}개)">
                <span class="cat-chip-icon">${cat.icon || '📁'}</span>
                <span class="cat-chip-name">${escapeHtml(cat.name)}</span>
                <span class="cat-chip-count">${count}</span>
            </button>
        `;
    }).join('');
}

// 카테고리 선택
function selectNoteCategory(catId) {
    activeNoteCategory = catId;
    renderCategoryBar();

    // 현재 선택된 메모가 필터링 결과에 포함되지 않으면 첫 번째 결과 선택
    const filtered = getFilteredAndSortedNotes();
    if (filtered.length > 0 && !filtered.some(n => n.id === activeNoteId)) {
        activeNoteId = filtered[0].id;
    } else if (filtered.length === 0) {
        activeNoteId = null;
    }

    renderNotesUI();
}

// 에디터 상단 보관함 드롭다운 렌더링
function renderCategoryEditorSelect() {
    const selectEl = document.getElementById('note-category-select');
    if (!selectEl) return;

    // 'all'을 제외한 실제 보관함만 표출
    const selectableCats = noteCategories.filter(c => c.id !== 'all');
    selectEl.innerHTML = selectableCats.map(c => `
        <option value="${c.id}">${c.icon || '📁'} ${escapeHtml(c.name)}</option>
    `).join('');

    const activeNote = currentNotes.find(n => n.id === activeNoteId);
    if (activeNote) {
        selectEl.value = activeNote.category || 'scratch';
        selectEl.disabled = false;
    } else {
        selectEl.disabled = true;
    }
}

// 필터링 및 4대 정렬 적용 목록 계산
function getFilteredAndSortedNotes() {
    // 1. 카테고리 필터링
    let filtered = currentNotes;
    if (activeNoteCategory !== 'all') {
        filtered = filtered.filter(n => (n.category || 'scratch') === activeNoteCategory);
    }

    // 2. 검색어 필터링
    if (noteSearchKeyword) {
        filtered = filtered.filter(n =>
            (n.title || '').toLowerCase().includes(noteSearchKeyword) ||
            (n.content || '').toLowerCase().includes(noteSearchKeyword)
        );
    }

    // 3. 정렬 로직 (1순위: 📌 상단 고정, 2순위: 선택된 정렬 옵션)
    const list = [...filtered];
    list.sort((a, b) => {
        const pinA = a.is_pinned ? 1 : 0;
        const pinB = b.is_pinned ? 1 : 0;
        if (pinA !== pinB) {
            return pinB - pinA; // 고정된 메모 우선
        }

        switch (noteSortOption) {
            case 'created_desc': {
                const ca = a.created_at || a.createdAt || a.updated_at || a.updatedAt || '';
                const cb = b.created_at || b.createdAt || b.updated_at || b.updatedAt || '';
                return cb.localeCompare(ca);
            }
            case 'created_asc': {
                const ca = a.created_at || a.createdAt || a.updated_at || a.updatedAt || '';
                const cb = b.created_at || b.createdAt || b.updated_at || b.updatedAt || '';
                return ca.localeCompare(cb);
            }
            case 'title_asc': {
                const ta = (a.title || '').toLowerCase();
                const tb = (b.title || '').toLowerCase();
                return ta.localeCompare(tb, 'ko');
            }
            case 'updated_desc':
            default: {
                const ua = a.updated_at || a.updatedAt || '';
                const ub = b.updated_at || b.updatedAt || '';
                return ub.localeCompare(ua);
            }
        }
    });

    return list;
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

// 빠른메모 에디터 Tab 및 Shift+Tab 들여쓰기/내어쓰기 핸들러
let notesTabHandlerInitialized = false;

function initNotesTabKeyHandler() {
    if (notesTabHandlerInitialized) return;
    const editor = document.getElementById('note-content-editor');
    if (!editor) return;

    notesTabHandlerInitialized = true;

    editor.addEventListener('keydown', function(e) {
        if (e.key !== 'Tab') return;
        e.preventDefault();

        const start = this.selectionStart;
        const end = this.selectionEnd;
        const val = this.value;

        // 다중 라인 블록 선택 여부 판정 (블록 내에 개행 문자가 포함되어 있는 경우)
        const isMultiLine = start !== end && val.substring(start, end).includes('\n');

        if (isMultiLine) {
            // 다중 라인 선택 블록 들여쓰기 / 내어쓰기
            const lineStart = val.lastIndexOf('\n', start - 1) + 1;
            let lineEnd = val.indexOf('\n', end);
            if (lineEnd === -1) lineEnd = val.length;

            const targetText = val.substring(lineStart, lineEnd);
            const lines = targetText.split('\n');

            if (e.shiftKey) {
                // Shift + Tab : 일괄 내어쓰기 (Outdent)
                let firstLineRemoved = 0;
                let totalRemoved = 0;

                const newLines = lines.map((line, idx) => {
                    let removed = 0;
                    let newLine = line;
                    if (newLine.startsWith('\t')) {
                        newLine = newLine.substring(1);
                        removed = 1;
                    } else if (newLine.startsWith('    ')) {
                        newLine = newLine.substring(4);
                        removed = 4;
                    } else {
                        const match = newLine.match(/^ +/);
                        if (match) {
                            const count = Math.min(match[0].length, 4);
                            newLine = newLine.substring(count);
                            removed = count;
                        }
                    }

                    if (idx === 0) firstLineRemoved = removed;
                    totalRemoved += removed;
                    return newLine;
                });

                const replacement = newLines.join('\n');
                this.setRangeText(replacement, lineStart, lineEnd, 'select');

                // 선택 영역 보정 (첫 줄 및 전체 줄어든 문자 수 반영)
                const newStart = Math.max(lineStart, start - firstLineRemoved);
                const newEnd = Math.max(newStart, end - totalRemoved);
                this.setSelectionRange(newStart, newEnd);
            } else {
                // Tab : 일괄 들여쓰기 (Indent)
                const newLines = lines.map(line => '\t' + line);
                const replacement = newLines.join('\n');
                this.setRangeText(replacement, lineStart, lineEnd, 'select');

                // 선택 영역 보정 (첫 줄 +1, 전체 라인 수만큼 끝점 확장)
                const newStart = start + 1;
                const newEnd = end + lines.length;
                this.setSelectionRange(newStart, newEnd);
            }

            onNoteContentChange(this.value);
        } else {
            // 단일 커서 또는 단일 라인 내 선택
            if (e.shiftKey) {
                // Shift + Tab : 현재 라인 선행 들여쓰기 제거
                const lineStart = val.lastIndexOf('\n', start - 1) + 1;
                let lineEnd = val.indexOf('\n', start);
                if (lineEnd === -1) lineEnd = val.length;

                const line = val.substring(lineStart, lineEnd);
                let removed = 0;
                let newLine = line;

                if (newLine.startsWith('\t')) {
                    newLine = newLine.substring(1);
                    removed = 1;
                } else if (newLine.startsWith('    ')) {
                    newLine = newLine.substring(4);
                    removed = 4;
                } else {
                    const match = newLine.match(/^ +/);
                    if (match) {
                        const count = Math.min(match[0].length, 4);
                        newLine = newLine.substring(count);
                        removed = count;
                    }
                }

                if (removed > 0) {
                    this.setRangeText(newLine, lineStart, lineEnd, 'preserve');
                    const newCursor = Math.max(lineStart, start - removed);
                    this.setSelectionRange(newCursor, newCursor);
                    onNoteContentChange(this.value);
                }
            } else {
                // Tab : 커서 위치에 \t 삽입 (브라우저 Undo 히스토리 보존을 위해 execCommand 1순위 시도)
                let success = false;
                try {
                    success = document.execCommand('insertText', false, '\t');
                } catch (cmdErr) {
                    success = false;
                }

                if (!success) {
                    this.setRangeText('\t', start, end, 'end');
                }

                onNoteContentChange(this.value);
            }
        }
    });
}

function renderNotesUI() {
    const filteredNotes = getFilteredAndSortedNotes();

    // 1. 메모 수 뱃지
    const countBadge = document.getElementById('notes-count-badge');
    if (countBadge) {
        const isFiltered = activeNoteCategory !== 'all' || noteSearchKeyword;
        countBadge.textContent = isFiltered
            ? `${filteredNotes.length}/${currentNotes.length}`
            : currentNotes.length;
    }

    // 2. 좌측 목록 렌더링
    const listEl = document.getElementById('notes-list-items');
    if (listEl) {
        if (filteredNotes.length === 0) {
            if (noteSearchKeyword) {
                listEl.innerHTML = `
                    <div style="color:var(--text-secondary); text-align:center; padding:24px 16px; font-size:0.82rem;">
                        '${escapeHtml(noteSearchKeyword)}' 검색 결과가 없습니다.
                    </div>
                `;
            } else if (activeNoteCategory !== 'all') {
                const catInfo = getCategoryInfo(activeNoteCategory);
                listEl.innerHTML = `
                    <div style="color:var(--text-secondary); text-align:center; padding:24px 16px; font-size:0.85rem;">
                        '${catInfo.icon} ${escapeHtml(catInfo.name)}' 보관함에 메모가 없습니다.<br>
                        상단 [+ 새 메모]로 메모를 추가해보세요.
                    </div>
                `;
            } else {
                listEl.innerHTML = '<div style="color:var(--text-secondary); text-align:center; padding:24px 16px; font-size:0.85rem;">메모가 없습니다.<br>상단 [+ 새 메모]를 눌러보세요.</div>';
            }
        } else {
            listEl.innerHTML = filteredNotes.map(note => {
                const isActive = note.id === activeNoteId;
                const isPinned = Boolean(note.is_pinned);
                const cat = getCategoryInfo(note.category || 'scratch');
                const preview = (note.content || '').trim().split('\n')[0] || '(빈 내용)';
                const displayDate = note.updated_at || note.updatedAt || '';

                return `
                    <div class="note-list-item ${isActive ? 'active' : ''} ${isPinned ? 'pinned' : ''}" onclick="selectNote('${note.id}')">
                        <div class="note-item-header">
                            <span class="note-item-title">${escapeHtml(note.title || '제목 없음')}</span>
                            ${isPinned ? '<span class="note-item-pin-badge" title="상단 고정됨">📌</span>' : ''}
                        </div>
                        <div class="note-item-preview">${escapeHtml(preview)}</div>
                        <div class="note-item-meta">
                            <span class="note-item-cat-badge">${cat.icon || '📁'} ${escapeHtml(cat.name)}</span>
                            <span class="note-item-date">${escapeHtml(displayDate)}</span>
                        </div>
                    </div>
                `;
            }).join('');
        }
    }

    // 3. 우측 에디터 렌더링
    const activeNote = currentNotes.find(n => n.id === activeNoteId);
    const titleInput = document.getElementById('note-title-input');
    const contentEditor = document.getElementById('note-content-editor');
    const pinBtn = document.getElementById('note-pin-btn');

    if (activeNote) {
        if (titleInput) {
            titleInput.value = activeNote.title || '';
            titleInput.disabled = false;
        }
        if (contentEditor) {
            contentEditor.value = activeNote.content || '';
            contentEditor.disabled = false;
        }
        if (pinBtn) {
            pinBtn.disabled = false;
            const isPinned = Boolean(activeNote.is_pinned);
            if (isPinned) {
                pinBtn.classList.add('pinned');
                pinBtn.title = '상단 고정 해제';
                document.getElementById('note-pin-text').textContent = '고정 해제';
            } else {
                pinBtn.classList.remove('pinned');
                pinBtn.title = '상단 고정';
                document.getElementById('note-pin-text').textContent = '고정';
            }
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
        if (pinBtn) {
            pinBtn.disabled = true;
            pinBtn.classList.remove('pinned');
            document.getElementById('note-pin-text').textContent = '고정';
        }
        updateNoteStats('');
    }

    // 에디터 보관함 셀렉터 상태 동기화
    renderCategoryEditorSelect();
}

function selectNote(id) {
    activeNoteId = id;
    renderNotesUI();
    const contentEditor = document.getElementById('note-content-editor');
    if (contentEditor) contentEditor.focus();
}

async function addNewNote() {
    // 현재 활성화된 보관함에 따라 기본 카테고리 결정
    const targetCat = (activeNoteCategory && activeNoteCategory !== 'all') ? activeNoteCategory : 'scratch';
    return await createNoteWithContent(`📝 새 메모 ${currentNotes.length + 1}`, "", targetCat);
}

async function createNoteWithContent(title, content, category = 'scratch') {
    const newId = Date.now().toString();
    const nowStr = new Date().toLocaleString();
    const newNote = {
        id: newId,
        title: title || `📝 새 메모 ${currentNotes.length + 1}`,
        content: content || "",
        category: category || 'scratch',
        is_pinned: 0,
        created_at: nowStr,
        updated_at: nowStr,
        createdAt: nowStr,
        updatedAt: nowStr
    };
    currentNotes.unshift(newNote);
    activeNoteId = newId;

    await saveNotesImmediately();
    renderCategoryBar();
    renderNotesUI();

    const titleInput = document.getElementById('note-title-input');
    if (titleInput) {
        titleInput.focus();
        titleInput.select();
    }
    return newNote;
}

// 현재 메모의 보관함 이동
async function onCurrentNoteCategoryChange(newCatId) {
    const activeNote = currentNotes.find(n => n.id === activeNoteId);
    if (!activeNote || !newCatId) return;

    activeNote.category = newCatId;
    activeNote.updated_at = new Date().toLocaleString();
    activeNote.updatedAt = activeNote.updated_at;

    await saveNotesImmediately();
    renderCategoryBar();
    renderNotesUI();

    const catInfo = getCategoryInfo(newCatId);
    if (typeof showToast === 'function') {
        showToast('보관함 이동', `'${activeNote.title}' 메모가 '${catInfo.name}'(으)로 이동되었습니다.`, '📁');
    }
}

// 현재 메모의 📌 상단 고정 토글
async function toggleCurrentNotePin() {
    const activeNote = currentNotes.find(n => n.id === activeNoteId);
    if (!activeNote) return;

    activeNote.is_pinned = activeNote.is_pinned ? 0 : 1;
    activeNote.updated_at = new Date().toLocaleString();
    activeNote.updatedAt = activeNote.updated_at;

    await saveNotesImmediately();
    renderNotesUI();

    const msg = activeNote.is_pinned ? `'${activeNote.title}' 메모가 목록 상단에 고정되었습니다.` : `'${activeNote.title}' 메모의 상단 고정이 해제되었습니다.`;
    if (typeof showToast === 'function') {
        showToast('고정 상태 변경', msg, activeNote.is_pinned ? '📌' : '📍');
    }
}

function onNoteTitleChange(newTitle) {
    const activeNote = currentNotes.find(n => n.id === activeNoteId);
    if (!activeNote) return;

    activeNote.title = newTitle;
    activeNote.updated_at = new Date().toLocaleString();
    activeNote.updatedAt = activeNote.updated_at;

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
    activeNote.updated_at = new Date().toLocaleString();
    activeNote.updatedAt = activeNote.updated_at;

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
        if (noteSortOption === 'updated_desc') {
            bringNoteToTop(activeNoteId);
        }
        await saveNotesImmediately();
        renderNotesUI();
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
        await showAppAlert('복사할 메모 내용이 없습니다.', '알림', 'ℹ️');
        return;
    }

    try {
        await navigator.clipboard.writeText(activeNote.content);
        activeNote.updated_at = new Date().toLocaleString();
        activeNote.updatedAt = activeNote.updated_at;
        
        // 최근 복사된 메모를 목록 맨 위로 이동
        bringNoteToTop(activeNoteId);
        await saveNotesImmediately();
        renderNotesUI();

        logToConsole('클립보드 복사 완료', `'${activeNote.title}' 내용이 복사되어 목록 맨 위로 이동되었습니다.`);
    } catch (e) {
        await showAppAlert('클립보드 복사 실패: ' + e.message, '오류', '❌');
    }
}

async function moveCurrentNoteToTop() {
    const activeNote = currentNotes.find(n => n.id === activeNoteId);
    if (!activeNote) return;

    activeNote.updated_at = new Date().toLocaleString();
    activeNote.updatedAt = activeNote.updated_at;
    const moved = bringNoteToTop(activeNoteId);
    if (moved) {
        await saveNotesImmediately();
        renderNotesUI();
        logToConsole('상단 이동', `'${activeNote.title}' 메모가 목록 맨 위로 이동되었습니다.`);
    }
}

async function clearCurrentNote() {
    const activeNote = currentNotes.find(n => n.id === activeNoteId);
    if (!activeNote) return;

    const confirmed = await showAppConfirm(`'${activeNote.title}' 메모의 내용을 모두 비우시겠습니까?`, {
        title: '메모 비우기',
        icon: '🧹',
        confirmText: '비우기',
        isDanger: true
    });
    if (confirmed) {
        activeNote.content = '';
        activeNote.updated_at = new Date().toLocaleString();
        activeNote.updatedAt = activeNote.updated_at;
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

    const confirmed = await showAppConfirm(`'${activeNote.title}' 메모를 영구 삭제하시겠습니까?`, {
        title: '메모 영구 삭제',
        icon: '🗑️',
        confirmText: '영구 삭제',
        isDanger: true
    });
    if (confirmed) {
        currentNotes = currentNotes.filter(n => n.id !== activeNoteId);
        const filtered = getFilteredAndSortedNotes();
        activeNoteId = filtered.length > 0 ? filtered[0].id : (currentNotes.length > 0 ? currentNotes[0].id : null);

        await saveNotesImmediately();
        renderCategoryBar();
        renderNotesUI();
        logToConsole('메모 삭제', `'${activeNote.title}' 메모가 삭제되었습니다.`);
    }
}

// ==========================================
// 보관함(카테고리) 관리 인레이어 모달 로직
// ==========================================

function openNoteCategoriesModal() {
    const modal = document.getElementById('note-categories-modal');
    if (!modal) return;

    modal.classList.add('active');
    cancelEditNoteCategory();
    renderCategoriesManageList();
}

function closeNoteCategoriesModal() {
    const modal = document.getElementById('note-categories-modal');
    if (!modal) return;

    modal.classList.remove('active');
    cancelEditNoteCategory();
}

function renderCategoriesManageList() {
    const listEl = document.getElementById('note-categories-manage-list');
    const badgeEl = document.getElementById('note-cat-count-badge');
    if (!listEl) return;

    if (badgeEl) {
        badgeEl.textContent = noteCategories.length;
    }

    if (!noteCategories || noteCategories.length === 0) {
        listEl.innerHTML = '<div style="color:var(--text-secondary); text-align:center; padding:16px;">등록된 보관함이 없습니다.</div>';
        return;
    }

    listEl.innerHTML = noteCategories.map((cat, index) => {
        const isSystem = Boolean(cat.is_system);
        const count = getCategoryCount(cat.id);
        const isAll = cat.id === 'all';
        const isScratch = cat.id === 'scratch';

        return `
            <div class="shortcut-manage-item" style="display:flex; align-items:center; justify-content:space-between; padding:8px 12px; border-bottom:1px solid var(--border-color, #333);">
                <div style="display:flex; align-items:center; gap:8px;">
                    <span style="font-size:1.2rem;">${cat.icon || '📁'}</span>
                    <div>
                        <strong style="color:var(--text-primary); font-size:0.95rem;">${escapeHtml(cat.name)}</strong>
                        ${isSystem ? '<span style="margin-left:6px; font-size:0.75rem; color:var(--text-muted); background:var(--bg-secondary); padding:2px 6px; border-radius:4px;">시스템 기본</span>' : ''}
                        <div style="font-size:0.75rem; color:var(--text-muted);">메모 ${count}개</div>
                    </div>
                </div>
                <div style="display:flex; align-items:center; gap:4px;">
                    ${!isAll ? `
                        <button type="button" class="mini-tool-btn" onclick="moveCategoryOrder('${cat.id}', 'up')" title="위로 이동" ${index <= 1 ? 'disabled' : ''}>▲</button>
                        <button type="button" class="mini-tool-btn" onclick="moveCategoryOrder('${cat.id}', 'down')" title="아래로 이동" ${index === noteCategories.length - 1 ? 'disabled' : ''}>▼</button>
                    ` : ''}
                    ${!isAll ? `
                        <button type="button" class="mini-tool-btn" onclick="startEditNoteCategory('${cat.id}')" title="수정">✏️</button>
                    ` : ''}
                    ${(!isSystem && !isScratch) ? `
                        <button type="button" class="mini-tool-btn danger" onclick="deleteCategory('${cat.id}')" title="삭제">🗑️</button>
                    ` : ''}
                </div>
            </div>
        `;
    }).join('');
}

function startEditNoteCategory(catId) {
    const cat = noteCategories.find(c => c.id === catId);
    if (!cat) return;

    editingCategoryId = catId;
    const titleEl = document.getElementById('note-cat-form-title');
    const iconSelect = document.getElementById('new-note-cat-icon');
    const nameInput = document.getElementById('new-note-cat-name');
    const submitBtn = document.getElementById('note-cat-submit-btn');
    const cancelBtn = document.getElementById('note-cat-cancel-btn');

    if (titleEl) titleEl.textContent = `✏️ '${cat.name}' 보관함 수정`;
    if (iconSelect) iconSelect.value = cat.icon || '📁';
    if (nameInput) {
        nameInput.value = cat.name || '';
        nameInput.focus();
    }
    if (submitBtn) submitBtn.textContent = '저장';
    if (cancelBtn) cancelBtn.style.display = 'inline-block';
}

function cancelEditNoteCategory() {
    editingCategoryId = null;
    const titleEl = document.getElementById('note-cat-form-title');
    const iconSelect = document.getElementById('new-note-cat-icon');
    const nameInput = document.getElementById('new-note-cat-name');
    const submitBtn = document.getElementById('note-cat-submit-btn');
    const cancelBtn = document.getElementById('note-cat-cancel-btn');

    if (titleEl) titleEl.textContent = '➕ 새로운 보관함 추가';
    if (iconSelect) iconSelect.value = '📁';
    if (nameInput) nameInput.value = '';
    if (submitBtn) submitBtn.textContent = '추가';
    if (cancelBtn) cancelBtn.style.display = 'none';
}

async function submitNoteCategoryForm() {
    const iconSelect = document.getElementById('new-note-cat-icon');
    const nameInput = document.getElementById('new-note-cat-name');
    const icon = (iconSelect ? iconSelect.value : '📁') || '📁';
    const name = (nameInput ? nameInput.value : '').trim();

    if (!name) {
        await showAppAlert('보관함 이름을 입력해 주세요.', '입력 확인', '⚠️');
        if (nameInput) nameInput.focus();
        return;
    }

    try {
        if (window.eel && eel.save_note_category) {
            const res = await eel.save_note_category(editingCategoryId, name, icon)();
            if (res.status === 'success') {
                if (typeof showToast === 'function') {
                    showToast('보관함 저장 완료', res.message || '보관함이 저장되었습니다.', '💾');
                }
            } else {
                await showAppAlert(res.message || '보관함 저장에 실패했습니다.', '오류', '❌');
                return;
            }
        } else {
            if (editingCategoryId) {
                const target = noteCategories.find(c => c.id === editingCategoryId);
                if (target) {
                    target.name = name;
                    target.icon = icon;
                }
            } else {
                noteCategories.push({
                    id: `cat_${Date.now()}`,
                    name,
                    icon,
                    sort_order: noteCategories.length,
                    is_system: 0,
                    notes_count: 0
                });
            }
            localStorage.setItem('note_categories', JSON.stringify(noteCategories));
        }

        cancelEditNoteCategory();
        await loadNoteCategories();
        renderCategoriesManageList();
        renderCategoryBar();
        renderNotesUI();
    } catch (e) {
        console.error("보관함 저장 실패:", e);
        await showAppAlert('보관함 저장 중 오류가 발생했습니다: ' + e.message, '오류', '❌');
    }
}

async function deleteCategory(catId) {
    const cat = noteCategories.find(c => c.id === catId);
    if (!cat) return;

    if (cat.is_system) {
        await showAppAlert('시스템 기본 보관함은 삭제할 수 없습니다.', '안내', 'ℹ️');
        return;
    }

    const count = getCategoryCount(catId);
    const confirmMsg = count > 0
        ? `'${cat.name}' 보관함을 삭제하시겠습니까?\n소속된 메모 ${count}개는 '스크래치패드'로 안전하게 이전됩니다.`
        : `'${cat.name}' 보관함을 삭제하시겠습니까?`;

    const confirmed = await showAppConfirm(confirmMsg, {
        title: '보관함 삭제',
        icon: '🗑️',
        confirmText: '삭제',
        isDanger: true
    });

    if (!confirmed) return;

    try {
        if (window.eel && eel.delete_note_category) {
            const res = await eel.delete_note_category(catId)();
            if (res.status === 'success') {
                if (typeof showToast === 'function') {
                    showToast('보관함 삭제 완료', res.message, '🗑️');
                }
            } else {
                await showAppAlert(res.message || '보관함 삭제에 실패했습니다.', '오류', '❌');
                return;
            }
        } else {
            currentNotes.forEach(n => {
                if (n.category === catId) n.category = 'scratch';
            });
            noteCategories = noteCategories.filter(c => c.id !== catId);
            localStorage.setItem('note_categories', JSON.stringify(noteCategories));
            localStorage.setItem('user_notes', JSON.stringify(currentNotes));
        }

        // 현재 선택된 보관함이 삭제된 경우 'all'로 리셋
        if (activeNoteCategory === catId) {
            activeNoteCategory = 'all';
        }

        // 메모 목록 다시 로드 및 화면 갱신
        if (window.eel && eel.get_notes) {
            const nres = await eel.get_notes()();
            if (nres.status === 'success' && Array.isArray(nres.data)) {
                currentNotes = nres.data;
            }
        }

        await loadNoteCategories();
        renderCategoriesManageList();
        renderCategoryBar();
        renderNotesUI();
    } catch (e) {
        console.error("보관함 삭제 실패:", e);
        await showAppAlert('보관함 삭제 중 오류가 발생했습니다: ' + e.message, '오류', '❌');
    }
}

async function moveCategoryOrder(catId, direction) {
    const idx = noteCategories.findIndex(c => c.id === catId);
    if (idx === -1) return;

    const targetIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (targetIdx <= 0 || targetIdx >= noteCategories.length) {
        // 0번('all') 앞이나 배열 범위 밖으로는 이동 불가
        return;
    }

    // 위치 교환
    const temp = noteCategories[idx];
    noteCategories[idx] = noteCategories[targetIdx];
    noteCategories[targetIdx] = temp;

    const orderedIds = noteCategories.map(c => c.id);

    try {
        if (window.eel && eel.reorder_note_categories) {
            await eel.reorder_note_categories(orderedIds)();
        } else {
            localStorage.setItem('note_categories', JSON.stringify(noteCategories));
        }
        await loadNoteCategories();
        renderCategoriesManageList();
        renderCategoryBar();
    } catch (e) {
        console.error("순서 변경 실패:", e);
    }
}

/**
 * EML 이메일 아카이브 & 뷰어 (Email Archive & Viewer) 모듈
 * EML 파일 로드/저장, 카테고리 분류 & 필터링, HTML/텍스트 뷰어,
 * multilingual-e5-small AI 시맨틱 검색 연동 지원
 */

let emailState = {
    emails: [],
    categories: ["전체", "업무/프로젝트", "회의록", "견적/계약", "인사/총무", "시스템/알림", "기타"],
    activeCategory: "전체",
    selectedEmailId: null,
    searchQuery: "",
    viewMode: "html", // 'html' | 'text'
    listWidthPercent: 38
};

// ==========================================
// 1. 초기화 및 로드
// ==========================================
async function initEmailViewer() {
    initEmailResizer();
    initEmailDropZone();
    await loadAllEmails();
}

async function loadAllEmails() {
    try {
        if (window.eel && typeof eel.get_all_emails === 'function') {
            const list = await eel.get_all_emails()();
            emailState.emails = Array.isArray(list) ? list : [];
        } else {
            emailState.emails = [];
        }
    } catch (e) {
        console.warn("이메일 목록 로드 실패 (로컬 더미 사용):", e);
        emailState.emails = [];
    }

    updateCategoriesList();
    renderEmailCategoryChips();
    renderEmailList();

    if (emailState.emails.length > 0 && !emailState.selectedEmailId) {
        selectEmail(emailState.emails[0].id);
    } else if (emailState.selectedEmailId) {
        renderEmailDetail(emailState.selectedEmailId);
    } else {
        renderEmptyEmailDetail();
    }
}

function updateCategoriesList() {
    const defaultCats = ["업무/프로젝트", "회의록", "견적/계약", "인사/총무", "시스템/알림", "기타"];
    const set = new Set(defaultCats);
    emailState.emails.forEach(em => {
        if (em.category) set.add(em.category);
    });
    emailState.categories = ["전체", ...Array.from(set)];
}

// ==========================================
// 2. 카테고리 칩 & 필터링
// ==========================================
function renderEmailCategoryChips() {
    const container = document.getElementById('email-category-chips');
    if (!container) return;

    let html = '';
    emailState.categories.forEach(cat => {
        let count = 0;
        if (cat === '전체') {
            count = emailState.emails.length;
        } else {
            count = emailState.emails.filter(e => (e.category || '기타') === cat).length;
        }

        const activeClass = emailState.activeCategory === cat ? 'active' : '';
        const badgeColor = getCategoryColorClass(cat);

        html += `
            <button type="button" class="gen-cat-chip email-cat-chip ${activeClass}" onclick="filterEmailsByCategory('${escapeHtml(cat)}')">
                <span class="cat-chip-dot ${badgeColor}"></span>
                <span class="cat-chip-name">${escapeHtml(cat)}</span>
                <span class="cat-chip-count">${count}</span>
            </button>
        `;
    });

    html += `
        <button type="button" class="gen-cat-chip email-add-cat-chip" onclick="promptAddEmailCategory()" title="새 카테고리 태그 추가">
            <span>➕ 분류 추가</span>
        </button>
    `;

    container.innerHTML = html;
}

function getCategoryColorClass(cat) {
    switch (cat) {
        case '업무/프로젝트': return 'dot-indigo';
        case '회의록': return 'dot-emerald';
        case '견적/계약': return 'dot-amber';
        case '인사/총무': return 'dot-purple';
        case '시스템/알림': return 'dot-rose';
        case '기타': return 'dot-slate';
        default: return 'dot-cyan';
    }
}

function filterEmailsByCategory(cat) {
    emailState.activeCategory = cat;
    renderEmailCategoryChips();
    renderEmailList();
}

function onEmailSearchInput(val) {
    emailState.searchQuery = (val || '').trim();
    const clearBtn = document.getElementById('email-search-clear-btn');
    if (clearBtn) {
        clearBtn.style.display = emailState.searchQuery ? 'block' : 'none';
    }
    renderEmailList();
}

function clearEmailSearch() {
    const input = document.getElementById('email-search-input');
    if (input) input.value = '';
    onEmailSearchInput('');
}

// ==========================================
// 3. 이메일 목록 렌더링
// ==========================================
function renderEmailList() {
    const container = document.getElementById('email-list-items');
    const totalCountEl = document.getElementById('email-total-count');
    if (!container) return;

    let filtered = emailState.emails;

    // 1) 카테고리 필터
    if (emailState.activeCategory && emailState.activeCategory !== '전체') {
        filtered = filtered.filter(e => (e.category || '기타') === emailState.activeCategory);
    }

    // 2) 검색어 필터
    if (emailState.searchQuery) {
        const q = emailState.searchQuery.toLowerCase();
        filtered = filtered.filter(e => {
            return (e.subject || '').toLowerCase().includes(q) ||
                   (e.from || '').toLowerCase().includes(q) ||
                   (e.snippet || '').toLowerCase().includes(q) ||
                   (e.category || '').toLowerCase().includes(q) ||
                   (e.body_text || '').toLowerCase().includes(q);
        });
    }

    if (totalCountEl) {
        totalCountEl.textContent = `${filtered.length} / ${emailState.emails.length}건`;
    }

    if (filtered.length === 0) {
        container.innerHTML = `
            <div class="empty-placeholder" style="padding: 40px 10px;">
                <div class="empty-icon">📭</div>
                <div class="empty-title">조건에 맞는 이메일이 없습니다</div>
                <div class="empty-desc">.eml 파일을 드래그 앤 드롭하거나 [📂 파일 불러오기]로 등록해 보세요.</div>
            </div>
        `;
        return;
    }

    let html = '';
    filtered.forEach(em => {
        const isSelected = em.id === emailState.selectedEmailId ? 'selected' : '';
        const cat = em.category || '기타';
        const colorClass = getCategoryColorClass(cat);
        const hasAttach = em.attachments && em.attachments.length > 0;

        const subjectHighlighted = highlightSearchText(em.subject || '(제목 없음)', emailState.searchQuery);
        const fromHighlighted = highlightSearchText(em.from || '', emailState.searchQuery);
        const snippetHighlighted = highlightSearchText(em.snippet || '', emailState.searchQuery);

        html += `
            <div class="email-list-card ${isSelected}" onclick="selectEmail('${em.id}')">
                <div class="email-card-top">
                    <div class="email-card-category-badge ${colorClass}">
                        <span class="cat-dot"></span>
                        <span class="cat-name">${escapeHtml(cat)}</span>
                    </div>
                    <span class="email-card-date">${formatEmailDate(em.date || em.created_at)}</span>
                </div>
                <div class="email-card-subject">${subjectHighlighted}</div>
                <div class="email-card-from">👤 ${fromHighlighted}</div>
                <div class="email-card-snippet">${snippetHighlighted}</div>
                <div class="email-card-bottom">
                    ${hasAttach ? `<span class="email-card-attach-badge">📎 ${em.attachments.length}개</span>` : '<span></span>'}
                    <div class="email-card-actions" onclick="event.stopPropagation();">
                        <button class="email-mini-action-btn" onclick="openEmailInOsApp('${em.id}')" title="Windows 기본 메일 앱(Outlook 등)으로 열기">📨</button>
                        <button class="email-mini-action-btn danger" onclick="deleteEmailItem('${em.id}')" title="이메일 삭제">🗑️</button>
                    </div>
                </div>
            </div>
        `;
    });

    container.innerHTML = html;
}

function selectEmail(id) {
    emailState.selectedEmailId = id;
    renderEmailList();
    renderEmailDetail(id);
}

// ==========================================
// 4. 이메일 상세 본문 렌더링
// ==========================================
function renderEmailDetail(id) {
    const container = document.getElementById('email-detail-container');
    if (!container) return;

    const email = emailState.emails.find(e => e.id === id);
    if (!email) {
        renderEmptyEmailDetail();
        return;
    }

    const cat = email.category || '기타';
    const hasAttach = email.attachments && email.attachments.length > 0;
    const catOptions = emailState.categories
        .filter(c => c !== '전체')
        .map(c => `<option value="${escapeHtml(c)}" ${c === cat ? 'selected' : ''}>${escapeHtml(c)}</option>`)
        .join('');

    let attachmentsHtml = '';
    if (hasAttach) {
        attachmentsHtml = `
            <div class="email-attachments-bar">
                <span class="attach-title">📎 첨부파일 (${email.attachments.length}개):</span>
                <div class="attach-items-list">
                    ${email.attachments.map(att => `
                        <span class="attach-item-chip" title="${escapeHtml(att.filename)} (${att.size})">
                            📄 ${escapeHtml(att.filename)} <span class="attach-size">(${att.size})</span>
                        </span>
                    `).join('')}
                </div>
            </div>
        `;
    }

    let bodyContentHtml = '';
    if (emailState.viewMode === 'html' && email.body_html) {
        bodyContentHtml = `
            <div class="email-body-html-wrapper">
                <iframe id="email-html-iframe" class="email-html-iframe" sandbox="allow-same-origin" srcdoc="${escapeHtmlAttr(email.body_html)}"></iframe>
            </div>
        `;
    } else {
        bodyContentHtml = `
            <div class="email-body-text-wrapper">
                <pre class="email-body-text">${escapeHtml(email.body_text || email.snippet || '(본문 내용이 없습니다)')}</pre>
            </div>
        `;
    }

    container.innerHTML = `
        <div class="email-detail-header">
            <div class="email-detail-title-row">
                <h2 class="email-detail-subject">${escapeHtml(email.subject || '(제목 없음)')}</h2>
                <div class="email-detail-category-selector">
                    <label for="email-cat-select-${email.id}">분류:</label>
                    <select id="email-cat-select-${email.id}" class="email-cat-dropdown" onchange="changeEmailCategory('${email.id}', this.value)">
                        ${catOptions}
                    </select>
                </div>
            </div>

            <div class="email-meta-grid">
                <div class="email-meta-item">
                    <span class="meta-label">보낸사람:</span>
                    <span class="meta-value">${escapeHtml(email.from || '-')}</span>
                </div>
                <div class="email-meta-item">
                    <span class="meta-label">받는사람:</span>
                    <span class="meta-value">${escapeHtml(email.to || '-')}</span>
                </div>
                <div class="email-meta-item">
                    <span class="meta-label">작성일시:</span>
                    <span class="meta-value">${escapeHtml(email.date || email.created_at || '-')}</span>
                </div>
            </div>

            <div class="email-detail-toolbar">
                <div class="email-view-mode-tabs">
                    <button class="email-mode-btn ${emailState.viewMode === 'html' ? 'active' : ''}" onclick="setEmailViewMode('html')">
                        <span>🌐</span> HTML 뷰
                    </button>
                    <button class="email-mode-btn ${emailState.viewMode === 'text' ? 'active' : ''}" onclick="setEmailViewMode('text')">
                        <span>📄</span> 텍스트 뷰
                    </button>
                </div>

                <div class="email-action-btn-group">
                    <button class="mini-tool-btn" onclick="copyEmailBody('${email.id}')" title="이메일 본문 텍스트 복사">
                        <span>📋</span> 본문 복사
                    </button>
                    <button class="mini-tool-btn" onclick="openEmailInOsApp('${email.id}')" title="Windows 기본 메일 앱으로 열기">
                        <span>📨</span> 메일 앱으로 열기
                    </button>
                    <button class="mini-tool-btn danger" onclick="deleteEmailItem('${email.id}')" title="이메일 영구 삭제">
                        <span>🗑️</span> 삭제
                    </button>
                </div>
            </div>

            ${attachmentsHtml}
        </div>

        <div class="email-detail-body">
            ${bodyContentHtml}
        </div>
    `;
}

function renderEmptyEmailDetail() {
    const container = document.getElementById('email-detail-container');
    if (!container) return;
    container.innerHTML = `
        <div class="email-empty-reader">
            <div class="empty-icon">📧</div>
            <div class="empty-title">선택된 이메일이 없습니다</div>
            <div class="empty-desc">좌측 목록에서 열람할 이메일을 선택하거나 .eml 파일을 추가해 주세요.</div>
        </div>
    `;
}

function setEmailViewMode(mode) {
    emailState.viewMode = mode;
    if (emailState.selectedEmailId) {
        renderEmailDetail(emailState.selectedEmailId);
    }
}

// ==========================================
// 5. 카테고리 변경 & 추가
// ==========================================
async function changeEmailCategory(emailId, newCategory) {
    if (!newCategory) return;
    try {
        if (window.eel && typeof eel.update_email_category === 'function') {
            const res = await eel.update_email_category(emailId, newCategory)();
            if (res.success) {
                emailState.emails = res.emails || [];
                updateCategoriesList();
                renderEmailCategoryChips();
                renderEmailList();
                renderEmailDetail(emailId);
                logToConsole('이메일 분류 변경', `카테고리: [${newCategory}] 로 변경 완료`);
            }
        }
    } catch (e) {
        console.error("카테고리 변경 실패:", e);
    }
}

async function promptAddEmailCategory() {
    const newCat = prompt("새로운 메일 카테고리 이름을 입력하세요 (예: 거래처, 세미나, 개발/QA):");
    if (!newCat || !newCat.trim()) return;
    const catName = newCat.trim();
    if (!emailState.categories.includes(catName)) {
        emailState.categories.push(catName);
        filterEmailsByCategory(catName);
    }
}

// ==========================================
// 6. 파일 가져오기 & 드래그 앤 드롭 (프로그레스 바 지원)
// ==========================================
if (window.eel) {
    try {
        eel.expose(on_eml_import_progress);
    } catch (e) {}
}

function on_eml_import_progress(current, total, filename, percent) {
    const modal = document.getElementById('eml-progress-modal');
    const countEl = document.getElementById('eml-progress-count');
    const percentEl = document.getElementById('eml-progress-percent');
    const fillEl = document.getElementById('eml-progress-fill');
    const filenameEl = document.getElementById('eml-progress-filename');

    if (modal) {
        if (!modal.classList.contains('show') && current < total) {
            modal.classList.add('show');
        }
    }

    if (countEl) countEl.textContent = `${current} / ${total}개 처리 중...`;
    if (percentEl) percentEl.textContent = `${percent}%`;
    if (fillEl) fillEl.style.width = `${percent}%`;
    if (filenameEl) filenameEl.textContent = filename || '-';

    if (current >= total && total > 0) {
        setTimeout(() => {
            if (modal) modal.classList.remove('show');
        }, 400);
    }
}

function hideEmlProgressModal() {
    const modal = document.getElementById('eml-progress-modal');
    if (modal) modal.classList.remove('show');
}

async function importEmlFiles() {
    try {
        if (window.eel && typeof eel.import_eml_files_dialog === 'function') {
            const res = await eel.import_eml_files_dialog()();
            hideEmlProgressModal();
            if (res.success) {
                emailState.emails = res.emails || [];
                updateCategoriesList();
                renderEmailCategoryChips();
                renderEmailList();
                if (emailState.emails.length > 0) {
                    selectEmail(emailState.emails[0].id);
                }
                logToConsole('EML 가져오기 완료', res.message);
                await showAppAlert(res.message, '가져오기 성공', '✅');
            } else if (res.message && !res.message.includes('취소')) {
                await showAppAlert(res.message, '가져오기 오류', '⚠️');
            }
        }
    } catch (e) {
        hideEmlProgressModal();
        console.error("EML 파일 가져오기 오류:", e);
    }
}

async function importEmlFolder() {
    try {
        if (window.eel && typeof eel.import_eml_folder_dialog === 'function') {
            const res = await eel.import_eml_folder_dialog()();
            hideEmlProgressModal();
            if (res.success) {
                emailState.emails = res.emails || [];
                updateCategoriesList();
                renderEmailCategoryChips();
                renderEmailList();
                if (emailState.emails.length > 0) {
                    selectEmail(emailState.emails[0].id);
                }
                logToConsole('EML 폴더 일괄 등록 완료', res.message);
                await showAppAlert(res.message, '일괄 등록 성공', '🎉');
            } else if (res.message && !res.message.includes('취소')) {
                await showAppAlert(res.message, '일괄 등록 오류', '⚠️');
            }
        }
    } catch (e) {
        hideEmlProgressModal();
        console.error("EML 폴더 일괄 등록 오류:", e);
    }
}

function initEmailDropZone() {
    const pane = document.getElementById('tab-emails');
    const overlay = document.getElementById('email-drop-overlay');
    if (!pane || !overlay) return;

    ['dragenter', 'dragover'].forEach(eventName => {
        pane.addEventListener(eventName, (e) => {
            e.preventDefault();
            e.stopPropagation();
            overlay.style.display = 'flex';
        }, false);
    });

    ['dragleave', 'drop'].forEach(eventName => {
        pane.addEventListener(eventName, (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (eventName === 'dragleave' && e.target === overlay) {
                overlay.style.display = 'none';
            } else if (eventName === 'drop') {
                overlay.style.display = 'none';
            }
        }, false);
    });

    pane.addEventListener('drop', async (e) => {
        const files = e.dataTransfer.files;
        if (!files || files.length === 0) return;

        let successCount = 0;
        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            if (file.name.toLowerCase().endsWith('.eml') || file.name.toLowerCase().endsWith('.msg') || file.type.includes('email')) {
                try {
                    const arrayBuffer = await file.arrayBuffer();
                    const uint8Array = new Uint8Array(arrayBuffer);
                    const bytesArray = Array.from(uint8Array);

                    if (window.eel && typeof eel.import_eml_raw_text === 'function') {
                        const res = await eel.import_eml_raw_text(file.name, bytesArray)();
                        if (res.success) {
                            emailState.emails = res.emails || [];
                            successCount++;
                        }
                    }
                } catch (err) {
                    console.error("드롭 파일 파싱 실패:", err);
                }
            }
        }

        if (successCount > 0) {
            updateCategoriesList();
            renderEmailCategoryChips();
            renderEmailList();
            if (emailState.emails.length > 0) {
                selectEmail(emailState.emails[0].id);
            }
            logToConsole('EML 드래그 드롭 등록', `총 ${successCount}개 이메일 등록 완료`);
            await showAppAlert(`총 ${successCount}개의 .eml 이메일을 성공적으로 등록했습니다! 📧`, '등록 완료', '✅');
        }
    });
}

// ==========================================
// 7. 액션 (복사, 열기, 삭제, 비우기)
// ==========================================
async function openEmailInOsApp(emailId) {
    try {
        if (window.eel && typeof eel.open_eml_in_os === 'function') {
            const res = await eel.open_eml_in_os(emailId)();
            if (!res.success) {
                await showAppAlert(res.message, '실행 오류', '⚠️');
            }
        }
    } catch (e) {
        console.error("이메일 앱 열기 실패:", e);
    }
}

async function copyEmailBody(emailId) {
    const email = emailState.emails.find(e => e.id === emailId);
    if (!email) return;

    const textToCopy = `제목: ${email.subject}\n보낸사람: ${email.from}\n받는사람: ${email.to}\n작성일시: ${email.date}\n\n${email.body_text || email.snippet || ''}`;
    await navigator.clipboard.writeText(textToCopy);
    logToConsole('이메일 본문 복사 완료', `${email.subject}`);
    await showAppAlert('이메일 내용이 클립보드에 복사되었습니다! 📋', '복사 완료', '✅');
}

async function deleteEmailItem(emailId) {
    const ok = await showAppConfirm('이 이메일을 아카이브에서 삭제하시겠습니까?\n(원본 .eml 파일도 함께 제거됩니다)', {
        title: '이메일 삭제',
        confirmText: '삭제',
        isDanger: true
    });
    if (!ok) return;

    try {
        if (window.eel && typeof eel.delete_email === 'function') {
            const res = await eel.delete_email(emailId)();
            if (res.success) {
                emailState.emails = res.emails || [];
                updateCategoriesList();
                renderEmailCategoryChips();
                if (emailState.selectedEmailId === emailId) {
                    emailState.selectedEmailId = emailState.emails.length > 0 ? emailState.emails[0].id : null;
                }
                renderEmailList();
                if (emailState.selectedEmailId) {
                    renderEmailDetail(emailState.selectedEmailId);
                } else {
                    renderEmptyEmailDetail();
                }
                logToConsole('이메일 삭제 완료', `ID: ${emailId}`);
            }
        }
    } catch (e) {
        console.error("이메일 삭제 오류:", e);
    }
}

async function clearAllEmailArchive() {
    if (emailState.emails.length === 0) return;
    const ok = await showAppConfirm('등록된 모든 이메일을 비우시겠습니까?\n이 작업은 되돌릴 수 없습니다.', {
        title: '전체 이메일 비우기',
        confirmText: '전체 삭제',
        isDanger: true
    });
    if (!ok) return;

    try {
        if (window.eel && typeof eel.clear_all_emails === 'function') {
            await eel.clear_all_emails()();
            emailState.emails = [];
            emailState.selectedEmailId = null;
            renderEmailCategoryChips();
            renderEmailList();
            renderEmptyEmailDetail();
            logToConsole('이메일 아카이브 비우기 완료', '전체 데이터 초기화');
        }
    } catch (e) {
        console.error("이메일 비우기 실패:", e);
    }
}

// AI 검색 결과에서 이메일 클릭 시 바로 열기
function openEmailFromAiSearch(emailId) {
    if (typeof switchTab === 'function') {
        switchTab('emails');
    }
    emailState.activeCategory = '전체';
    renderEmailCategoryChips();
    selectEmail(emailId);
}

// ==========================================
// 8. 좌우 스플리터 리사이저
// ==========================================
function initEmailResizer() {
    const resizer = document.getElementById('email-resizer');
    const listPane = document.getElementById('email-list-panel');
    const container = document.getElementById('email-split-container');

    if (!resizer || !listPane || !container) return;

    const savedWidth = localStorage.getItem('email_list_width_pct');
    if (savedWidth) {
        const pct = parseFloat(savedWidth);
        if (pct >= 20 && pct <= 60) {
            listPane.style.width = pct + '%';
            emailState.listWidthPercent = pct;
        }
    }

    let isResizing = false;

    resizer.addEventListener('mousedown', () => {
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

        if (percent >= 20 && percent <= 60) {
            listPane.style.width = `${percent}%`;
            emailState.listWidthPercent = percent;
        }
    });

    document.addEventListener('mouseup', () => {
        if (isResizing) {
            isResizing = false;
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
            try {
                localStorage.setItem('email_list_width_pct', emailState.listWidthPercent);
            } catch (e) {}
        }
    });
}

// ==========================================
// 9. 헬퍼 유틸
// ==========================================
function formatEmailDate(dateStr) {
    if (!dateStr) return '';
    try {
        const d = new Date(dateStr);
        if (isNaN(d.getTime())) return dateStr.slice(0, 16);
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        const hh = String(d.getHours()).padStart(2, '0');
        const mm = String(d.getMinutes()).padStart(2, '0');
        return `${y}-${m}-${day} ${hh}:${mm}`;
    } catch (e) {
        return dateStr;
    }
}

function highlightSearchText(text, query) {
    if (!text) return '';
    if (!query) return escapeHtml(text);
    const escaped = escapeHtml(text);
    const q = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`(${q})`, 'gi');
    return escaped.replace(regex, '<span class="csv-match-highlight">$1</span>');
}

function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function escapeHtmlAttr(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;');
}

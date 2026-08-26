/**
 * EML 이메일 아카이브 & 대화 스레드 뷰어 (Email Conversation Threading Viewer)
 * - 비파괴적 대화 스레드(Conversation Threading) 묶기 & 타임라인 아코디언
 * - Re:, Fwd:, [회수] 등 반복 회신 접두어 자동 정규화
 * - 초경량 요약 메타데이터 IPC 전송 (98% 용량 감축)
 * - 온디맨드 상세 본문 지연 로드 (Lazy Loading & Detail Cache)
 * - 3,000+개 대용량 데이터 인피니트 스크롤(50개씩 가상 렌더링)
 */

let emailState = {
    emails: [],                // 요약 메타데이터 목록 (가벼운 배열)
    detailCache: {},           // 열람한 이메일 상세 본문 캐시 { [id]: fullEmailObj }
    categories: ["전체", "업무/프로젝트", "회의록", "견적/계약", "인사/총무", "시스템/알림", "기타"],
    activeCategory: "전체",
    selectedEmailId: null,
    searchQuery: "",
    viewMode: "html",          // 'html' | 'text'
    listWidthPercent: 38,
    displayedLimit: 50,        // 인피니트 스크롤 1회 렌더링 개수
    isThreadView: true,        // 대화별 묶어보기 모드 (기본 ON)
    expandedThreadCardIds: new Set() // 현재 타임라인에서 펼쳐진 메일 ID 목록
};

// ==========================================
// 1. 초기화 및 로드
// ==========================================
async function initEmailViewer() {
    initEmailResizer();
    initEmailDropZone();
    initEmailScrollListener();
    await loadAllEmails();
}

async function loadAllEmails() {
    try {
        if (window.eel && typeof eel.get_emails_chunk === 'function') {
            // 1단계: 첫 번째 청크(300건) 초고속 로드 (< 20ms)
            const firstChunk = await eel.get_emails_chunk(0, 300)();
            if (firstChunk && firstChunk.status === 'success') {
                emailState.emails = firstChunk.items || [];
                const totalCount = firstChunk.total_count || emailState.emails.length;

                // 즉시 1차 UI 렌더링
                emailState.displayedLimit = 50;
                updateCategoriesList();
                renderEmailCategoryChips();
                renderEmailList();

                const displayList = getProcessedEmailList();
                if (displayList.length > 0 && !emailState.selectedEmailId) {
                    selectEmail(displayList[0].id);
                }

                // 2단계: 300건 초과 데이터가 있는 경우 백그라운드 청크 분할 로드 (500건씩 안전 패킷 수신)
                if (totalCount > 300) {
                    setTimeout(async () => {
                        let currentOffset = 300;
                        const chunkSize = 500;
                        while (currentOffset < totalCount) {
                            try {
                                const nextChunk = await eel.get_emails_chunk(currentOffset, chunkSize)();
                                if (nextChunk && nextChunk.items && nextChunk.items.length > 0) {
                                    emailState.emails = emailState.emails.concat(nextChunk.items);
                                    currentOffset += nextChunk.items.length;
                                    updateCategoriesList();
                                    renderEmailCategoryChips();
                                    renderEmailList();
                                } else {
                                    break;
                                }
                            } catch (chunkErr) {
                                console.warn("이메일 청크 추가 로드 오류:", chunkErr);
                                break;
                            }
                        }
                    }, 50);
                }
                return;
            }
        }

        // 폴백: 기존 전체 요약본 API
        if (window.eel && typeof eel.get_all_emails_summary === 'function') {
            const list = await eel.get_all_emails_summary()();
            emailState.emails = Array.isArray(list) ? list : [];
        } else {
            emailState.emails = [];
        }
    } catch (e) {
        console.warn("이메일 목록 로드 실패:", e);
        emailState.emails = [];
    }

    emailState.displayedLimit = 50;
    updateCategoriesList();
    renderEmailCategoryChips();
    renderEmailList();

    const displayList = getProcessedEmailList();
    if (displayList.length > 0 && !emailState.selectedEmailId) {
        selectEmail(displayList[0].id);
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
// 2. 대화 스레드(Thread) 정규화 & 그룹화 엔진
// ==========================================
function cleanSubject(subject) {
    if (!subject) return '제목 없음';
    let s = String(subject).trim();
    let prev = null;
    const prefixRegex = /^(?:(?:re|fwd?|fw|답장|전달)(?:\[\d+\]|\(\d+\))?\s*[:：\-]\s*|\[(?:re|fwd?|fw|회수|공유|답장|전달|참고|재전달)\]\s*|\((?:re|fwd?|fw|회수|공유|답장|전달|참고|재전달|remind|추가설명)\)\s*|(?:회수|공유|답장|전달|재전달)\s*[:：\-]\s*)+/i;
    
    while (prev !== s) {
        prev = s;
        s = s.replace(prefixRegex, '').trim();
    }
    s = s.replace(/\s+/g, ' ').trim();
    return s || '제목 없음';
}

function groupEmailsIntoThreads(items) {
    const groups = new Map();

    for (const item of items) {
        const cleanSub = item.clean_subject || cleanSubject(item.subject);
        const key = (item.thread_key || cleanSub).toLowerCase();

        if (!groups.has(key)) {
            groups.set(key, []);
        }
        groups.get(key).push(item);
    }

    const threads = [];
    for (const [key, emailList] of groups.entries()) {
        // 시간순(과거 -> 최신) 정렬
        emailList.sort((a, b) => {
            const timeA = new Date(a.date || a.created_at || 0).getTime() || 0;
            const timeB = new Date(b.date || b.created_at || 0).getTime() || 0;
            return timeA - timeB;
        });

        // 가장 최근 메일을 대표 카드로 선정
        const latestEmail = emailList[emailList.length - 1];
        const cleanSub = latestEmail.clean_subject || cleanSubject(latestEmail.subject);

        threads.push({
            ...latestEmail,
            clean_subject: cleanSub,
            thread_key: key,
            thread_count: emailList.length,
            thread_emails: emailList,
            thread_senders: [...new Set(emailList.map(e => extractSenderName(e.from)))]
        });
    }

    // 최신 대화 순으로 정렬
    threads.sort((a, b) => {
        const timeA = new Date(a.date || a.created_at || 0).getTime() || 0;
        const timeB = new Date(b.date || b.created_at || 0).getTime() || 0;
        return timeB - timeA;
    });

    return threads;
}

function extractSenderName(fromStr) {
    if (!fromStr) return '알 수 없음';
    const match = fromStr.match(/^"?'?([^<"']+)'?"?\s*</);
    if (match && match[1].trim()) return match[1].trim();
    const emailMatch = fromStr.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
    if (emailMatch) return emailMatch[1];
    return fromStr.slice(0, 16);
}

function getAvatarColorClass(name) {
    const colors = ['avatar-indigo', 'avatar-emerald', 'avatar-amber', 'avatar-purple', 'avatar-rose', 'avatar-cyan', 'avatar-blue'];
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
        hash = name.charCodeAt(i) + ((hash << 5) - hash);
    }
    return colors[Math.abs(hash) % colors.length];
}

// ==========================================
// 3. 카테고리 칩 & 대화 묶기 토글
// ==========================================
function toggleThreadView() {
    emailState.isThreadView = !emailState.isThreadView;
    const btn = document.getElementById('email-thread-toggle-btn');
    const textEl = document.getElementById('email-thread-toggle-text');

    if (btn) {
        btn.classList.toggle('active', emailState.isThreadView);
    }
    if (textEl) {
        textEl.textContent = emailState.isThreadView ? '대화별 묶기' : '개별 메일 보기';
    }

    emailState.displayedLimit = 50;
    renderEmailList();

    const displayList = getProcessedEmailList();
    if (displayList.length > 0) {
        selectEmail(displayList[0].id);
    }
}

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
                <span class="cat-chip-count">${count.toLocaleString()}</span>
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
    emailState.displayedLimit = 50;
    renderEmailCategoryChips();
    renderEmailList();
}

let emailSearchDebounceTimer = null;

function onEmailSearchInput(val) {
    const trimmed = (val || '').trim();
    const clearBtn = document.getElementById('email-search-clear-btn');
    if (clearBtn) {
        clearBtn.style.display = trimmed ? 'block' : 'none';
    }

    clearTimeout(emailSearchDebounceTimer);
    if (!trimmed) {
        emailState.searchQuery = '';
        emailState.displayedLimit = 50;
        renderEmailList();
        return;
    }

    emailSearchDebounceTimer = setTimeout(() => {
        emailState.searchQuery = trimmed;
        emailState.displayedLimit = 50;
        renderEmailList();
    }, 250);
}

function handleEmailSearchKeydown(event) {
    if (event.key === 'Enter') {
        clearTimeout(emailSearchDebounceTimer);
        const input = document.getElementById('email-search-input');
        if (input) {
            emailState.searchQuery = (input.value || '').trim();
            emailState.displayedLimit = 50;
            renderEmailList();
        }
    }
}

function clearEmailSearch() {
    clearTimeout(emailSearchDebounceTimer);
    const input = document.getElementById('email-search-input');
    if (input) input.value = '';
    onEmailSearchInput('');
}

// ==========================================
// 4. 이메일 목록 렌더링
// ==========================================
function getProcessedEmailList() {
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
                   (e.clean_subject || '').toLowerCase().includes(q) ||
                   (e.category || '').toLowerCase().includes(q);
        });
    }

    // 3) 대화 스레드 묶기 또는 최신순 정렬
    if (emailState.isThreadView) {
        return groupEmailsIntoThreads(filtered);
    } else {
        // 단일 메일 목록: 최신 수신 날짜순(내림차순) 정렬
        return [...filtered].sort((a, b) => {
            const timeA = new Date(a.date || a.created_at || 0).getTime() || 0;
            const timeB = new Date(b.date || b.created_at || 0).getTime() || 0;
            return timeB - timeA;
        });
    }
}

function renderEmailList() {
    const container = document.getElementById('email-list-items');
    const totalCountEl = document.getElementById('email-total-count');
    if (!container) return;

    const list = getProcessedEmailList();

    if (totalCountEl) {
        if (emailState.isThreadView) {
            totalCountEl.textContent = `${list.length.toLocaleString()}개 대화 타래 (${emailState.emails.length.toLocaleString()}건)`;
        } else {
            totalCountEl.textContent = `${list.length.toLocaleString()} / ${emailState.emails.length.toLocaleString()}건`;
        }
    }

    if (list.length === 0) {
        container.innerHTML = `
            <div class="empty-placeholder" style="padding: 40px 10px;">
                <div class="empty-icon">📭</div>
                <div class="empty-title">조건에 맞는 이메일이 없습니다</div>
                <div class="empty-desc">.eml 파일을 드래그 앤 드롭하거나 [📂 파일 불러오기]로 등록해 보세요.</div>
            </div>
        `;
        return;
    }

    const visibleItems = list.slice(0, emailState.displayedLimit);
    let html = '';

    visibleItems.forEach(item => {
        const isSelected = item.id === emailState.selectedEmailId ? 'selected' : '';
        const cat = item.category || '기타';
        const colorClass = getCategoryColorClass(cat);
        const hasAttach = item.attachments && item.attachments.length > 0;
        const threadCount = item.thread_count || 1;

        const displayTitle = emailState.isThreadView ? (item.clean_subject || cleanSubject(item.subject)) : (item.subject || '(제목 없음)');
        const subjectHighlighted = highlightSearchText(displayTitle, emailState.searchQuery);
        const fromHighlighted = highlightSearchText(item.from || '', emailState.searchQuery);
        const snippetHighlighted = highlightSearchText(item.snippet || '', emailState.searchQuery);

        const threadBadgeHtml = (emailState.isThreadView && threadCount > 1)
            ? `<span class="email-thread-badge" title="${threadCount}개의 답장/전달 메일이 묶여있습니다">💬 ${threadCount}</span>`
            : '';

        html += `
            <div class="email-list-card ${isSelected}" onclick="selectEmail('${item.id}')" data-email-id="${item.id}">
                <div class="email-card-top">
                    <div class="email-card-category-badge ${colorClass}">
                        <span class="cat-dot"></span>
                        <span class="cat-name">${escapeHtml(cat)}</span>
                    </div>
                    <span class="email-card-date">${formatEmailDate(item.date || item.created_at)}</span>
                </div>
                <div class="email-card-subject">
                    ${subjectHighlighted}
                    ${threadBadgeHtml}
                </div>
                <div class="email-card-from">👤 ${fromHighlighted}</div>
                <div class="email-card-snippet">${snippetHighlighted}</div>
                <div class="email-card-bottom">
                    ${hasAttach ? `<span class="email-card-attach-badge">📎 ${item.attachments.length}개</span>` : '<span></span>'}
                    <div class="email-card-actions" onclick="event.stopPropagation();">
                        <button class="email-mini-action-btn" onclick="openEmailInOsApp('${item.id}')" title="Windows 기본 메일 앱(Outlook 등)으로 열기">📨</button>
                        <button class="email-mini-action-btn danger" onclick="deleteEmailItem('${item.id}')" title="이메일 삭제">🗑️</button>
                    </div>
                </div>
            </div>
        `;
    });

    if (list.length > emailState.displayedLimit) {
        const remaining = list.length - emailState.displayedLimit;
        html += `
            <div class="email-load-more-card" onclick="loadMoreEmails()">
                <span>스크롤하여 더 보기 (남은 ${remaining.toLocaleString()}개) ▾</span>
            </div>
        `;
    }

    container.innerHTML = html;
}

function loadMoreEmails() {
    const list = getProcessedEmailList();
    if (emailState.displayedLimit < list.length) {
        emailState.displayedLimit += 50;
        renderEmailList();
    }
}

function initEmailScrollListener() {
    const listPanel = document.getElementById('email-list-panel');
    if (!listPanel) return;

    listPanel.addEventListener('scroll', () => {
        if (listPanel.scrollTop + listPanel.clientHeight >= listPanel.scrollHeight - 150) {
            const list = getProcessedEmailList();
            if (emailState.displayedLimit < list.length) {
                emailState.displayedLimit += 50;
                renderEmailList();
            }
        }
    }, { passive: true });
}

function selectEmail(id) {
    emailState.selectedEmailId = id;

    const cards = document.querySelectorAll('.email-list-card');
    cards.forEach(c => {
        if (c.getAttribute('data-email-id') === id) {
            c.classList.add('selected');
        } else {
            c.classList.remove('selected');
        }
    });

    renderEmailDetail(id);
}

// ==========================================
// 5. 이메일 상세 리더 & 대화 타임라인 렌더링
// ==========================================
async function renderEmailDetail(id) {
    const container = document.getElementById('email-detail-container');
    if (!container) return;

    const processedList = getProcessedEmailList();
    // 1) 스레드 대표 ID 또는 스레드 내 포함된 하위 메일 탐색
    let item = processedList.find(e => e.id === id);
    if (!item) {
        item = processedList.find(e => e.thread_emails && e.thread_emails.some(m => m.id === id));
    }
    if (!item) {
        item = emailState.emails.find(e => e.id === id);
    }

    // 2) 메모리 목록에 없는 경우(청크 미로드 등), 백엔드 SQLite DB에서 즉시 단건 직접 조회!
    if (!item) {
        try {
            renderEmailDetailLoadingHeader({ id, subject: '이메일 불러오는 중...', from: '', date: '' });
            if (window.eel && typeof eel.get_email_detail === 'function') {
                const res = await eel.get_email_detail(id)();
                if (res && res.success && res.email) {
                    item = res.email;
                    cacheEmailDetail(id, item);
                    await renderSingleEmailDetail(item);
                    return;
                }
            }
        } catch (e) {
            console.error("이메일 단건 직접 조회 실패:", e);
        }

        renderEmptyEmailDetail();
        return;
    }

    // 대화 스레드에 속한 다중 메일인지 판별
    const threadEmails = (emailState.isThreadView && item.thread_emails && item.thread_emails.length > 1)
        ? item.thread_emails
        : [item];

    if (threadEmails.length > 1) {
        // 다중 대화 타래 타임라인 렌더링
        await renderConversationTimeline(item, threadEmails);
    } else {
        // 단일 메일 렌더링
        await renderSingleEmailDetail(item);
    }
}

async function renderSingleEmailDetail(summary) {
    const container = document.getElementById('email-detail-container');
    if (!container) return;

    // 캐시 확인
    let email = emailState.detailCache[summary.id];
    if (!email) {
        renderEmailDetailLoadingHeader(summary);
        try {
            if (window.eel && typeof eel.get_email_detail === 'function') {
                const res = await eel.get_email_detail(summary.id)();
                if (res.success && res.email) {
                    email = res.email;
                    cacheEmailDetail(summary.id, email);
                }
            }
        } catch (e) {
            console.error("이메일 본문 상세 로드 실패:", e);
        }
    }

    email = email || summary;
    renderSingleEmailContent(email);
}

// 공통 첨부파일 칩 렌더러 (단일 뷰 및 스레드 타임라인 공용)
function renderEmailAttachmentsBar(email, customStyle = '') {
    if (!email || !email.attachments || email.attachments.length === 0) return '';
    const styleAttr = customStyle ? `style="${customStyle}"` : '';
    const attList = email.attachments;
    return `
        <div class="email-attachments-bar" ${styleAttr}>
            <div class="attach-bar-header">
                <span class="attach-title">📎 첨부파일 (${attList.length}개)</span>
                ${attList.length > 1 ? `
                    <button class="attach-save-all-btn" onclick="event.stopPropagation(); saveAllEmailAttachments('${email.id}')" title="이 메일의 모든 첨부파일을 선택한 폴더에 일괄 저장">
                        <span>💾</span> 전체 저장
                    </button>
                ` : ''}
            </div>
            <div class="attach-items-list">
                ${attList.map((att, idx) => {
                    const fname = att.filename || att.name || '첨부파일';
                    const fsize = att.size || '';
                    return `
                        <div class="attach-item-chip" title="${escapeHtml(fname)} ${fsize ? '(' + fsize + ')' : ''}" onclick="event.stopPropagation();">
                            <span class="attach-chip-main" onclick="openEmailAttachment('${email.id}', ${idx}, '${escapeHtmlAttr(fname)}')" title="클릭하여 즉시 열기">
                                <span class="attach-icon">${getFileIcon(fname)}</span>
                                <span class="attach-name">${escapeHtml(fname)}</span>
                                ${fsize ? `<span class="attach-size">(${fsize})</span>` : ''}
                            </span>
                            <div class="attach-chip-actions">
                                <button class="attach-action-btn" onclick="openEmailAttachment('${email.id}', ${idx}, '${escapeHtmlAttr(fname)}')" title="열기">
                                    👁️ 열기
                                </button>
                                <button class="attach-action-btn" onclick="saveEmailAttachment('${email.id}', ${idx}, '${escapeHtmlAttr(fname)}')" title="다른 이름으로 저장">
                                    💾 저장
                                </button>
                            </div>
                        </div>
                    `;
                }).join('')}
            </div>
        </div>
    `;
}

function renderSingleEmailContent(email) {
    const container = document.getElementById('email-detail-container');
    if (!container) return;

    const cat = email.category || '기타';
    const hasAttach = email.attachments && email.attachments.length > 0;
    const catOptions = emailState.categories
        .filter(c => c !== '전체')
        .map(c => `<option value="${escapeHtml(c)}" ${c === cat ? 'selected' : ''}>${escapeHtml(c)}</option>`)
        .join('');

    const attachmentsHtml = renderEmailAttachmentsBar(email);

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

// ==========================================
// 6. 다중 대화 타래(Conversation Timeline) 렌더링
// ==========================================
async function renderConversationTimeline(threadObj, threadEmails) {
    const container = document.getElementById('email-detail-container');
    if (!container) return;

    const baseTitle = threadObj.clean_subject || cleanSubject(threadObj.subject);
    const cat = threadObj.category || '기타';
    const participants = threadObj.thread_senders || [...new Set(threadEmails.map(e => extractSenderName(e.from)))];

    // 기본적으로 가장 마지막(최신) 메일만 펼치고 나머지는 접음
    const latestEmailId = threadEmails[threadEmails.length - 1].id;
    if (emailState.expandedThreadCardIds.size === 0) {
        emailState.expandedThreadCardIds.add(latestEmailId);
    }

    const catOptions = emailState.categories
        .filter(c => c !== '전체')
        .map(c => `<option value="${escapeHtml(c)}" ${c === cat ? 'selected' : ''}>${escapeHtml(c)}</option>`)
        .join('');

    // 헤더 렌더링
    let timelineCardsHtml = '';
    threadEmails.forEach((em, idx) => {
        const isLatest = (idx === threadEmails.length - 1);
        const isExpanded = emailState.expandedThreadCardIds.has(em.id);
        const senderName = extractSenderName(em.from);
        const avatarColor = getAvatarColorClass(senderName);
        const avatarLetter = senderName.charAt(0).toUpperCase();

        const cached = emailState.detailCache[em.id] || em;
        const hasAttach = cached.attachments && cached.attachments.length > 0;

        let bodyHtml = '';
        if (isExpanded) {
            if (emailState.viewMode === 'html' && cached.body_html) {
                bodyHtml = `
                    <div class="thread-body-content">
                        <iframe class="thread-body-html-frame" sandbox="allow-same-origin" srcdoc="${escapeHtmlAttr(cached.body_html)}"></iframe>
                    </div>
                `;
            } else {
                bodyHtml = `
                    <div class="thread-body-content">
                        <pre class="thread-body-text">${escapeHtml(cached.body_text || cached.snippet || '(본문 없음)')}</pre>
                    </div>
                `;
            }
        }

        timelineCardsHtml += `
            <div id="thread-card-${em.id}" class="email-thread-card ${isExpanded ? 'expanded' : 'collapsed'}">
                <div class="email-thread-card-header" onclick="toggleThreadCardExpansion('${em.id}')">
                    <div class="thread-header-left">
                        <div class="email-thread-avatar ${avatarColor}">${avatarLetter}</div>
                        <div class="thread-header-info">
                            <div class="thread-author-row">
                                <span class="thread-author-name">${escapeHtml(senderName)}</span>
                                <span class="thread-author-email">&lt;${escapeHtml(em.from)}&gt;</span>
                                ${isLatest ? '<span class="thread-latest-badge">✨ 최신 답장</span>' : `<span class="thread-seq-badge">#${idx + 1}</span>`}
                            </div>
                            <div class="thread-recipient-row">
                                <span class="thread-to-label">수신:</span> <span class="thread-to-val">${escapeHtml(em.to || '-')}</span>
                            </div>
                            <div class="thread-snippet-preview">${escapeHtml(em.snippet || '')}</div>
                        </div>
                    </div>
                    <div class="thread-header-right">
                        <span class="thread-date">${formatEmailDate(em.date || em.created_at)}</span>
                        <div class="thread-card-actions" onclick="event.stopPropagation();">
                            <button class="email-mini-action-btn" onclick="openEmailInOsApp('${em.id}')" title="메일 앱으로 열기">📨</button>
                            <button class="email-mini-action-btn" onclick="copyEmailBody('${em.id}')" title="본문 복사">📋</button>
                            <button class="email-mini-action-btn danger" onclick="deleteEmailItem('${em.id}')" title="삭제">🗑️</button>
                        </div>
                        <span class="thread-toggle-chevron">▾</span>
                    </div>
                </div>

                <div class="email-thread-card-body">
                    ${renderEmailAttachmentsBar(cached, 'margin-bottom: 8px;')}
                    ${bodyHtml}
                </div>
            </div>
        `;
    });

    container.innerHTML = `
        <div class="email-detail-header">
            <div class="email-detail-title-row">
                <h2 class="email-detail-subject">${escapeHtml(baseTitle)}</h2>
                <div class="email-detail-category-selector">
                    <label for="email-cat-select-${threadObj.id}">분류:</label>
                    <select id="email-cat-select-${threadObj.id}" class="email-cat-dropdown" onchange="changeThreadCategory('${threadObj.thread_key}', this.value)">
                        ${catOptions}
                    </select>
                </div>
            </div>

            <div class="email-thread-summary-banner">
                <div class="thread-summary-left">
                    <span class="thread-summary-pill">💬 총 ${threadEmails.length}건의 대화 타래</span>
                    <span class="thread-participants-list">참여자: ${escapeHtml(participants.join(', '))}</span>
                </div>
                <button class="thread-expand-all-btn" onclick="toggleAllThreadCards()">
                    전체 펼치기 / 접기
                </button>
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
                    <button class="mini-tool-btn" onclick="openEmailInOsApp('${latestEmailId}')" title="최신 메일을 Windows 메일 앱으로 열기">
                        <span>📨</span> 최신 메일 열기
                    </button>
                </div>
            </div>
        </div>

        <div class="email-thread-timeline-wrapper">
            <div class="email-thread-timeline">
                ${timelineCardsHtml}
            </div>
        </div>
    `;

    // 펼쳐진 카드 중 아직 상세 본문 캐시가 없는 메일은 비동기로 지연 로드
    for (const em of threadEmails) {
        if (emailState.expandedThreadCardIds.has(em.id) && !emailState.detailCache[em.id]) {
            fetchAndRenderThreadCardBody(em.id);
        }
    }
}

async function toggleThreadCardExpansion(emailId) {
    if (emailState.expandedThreadCardIds.has(emailId)) {
        emailState.expandedThreadCardIds.delete(emailId);
    } else {
        emailState.expandedThreadCardIds.add(emailId);
    }

    const card = document.getElementById(`thread-card-${emailId}`);
    if (!card) return;

    const isExpanded = emailState.expandedThreadCardIds.has(emailId);
    card.classList.toggle('expanded', isExpanded);
    card.classList.toggle('collapsed', !isExpanded);

    if (isExpanded) {
        await fetchAndRenderThreadCardBody(emailId);
    }
}

function toggleAllThreadCards() {
    const list = getProcessedEmailList();
    const item = list.find(e => e.id === emailState.selectedEmailId);
    if (!item || !item.thread_emails) return;

    const allIds = item.thread_emails.map(e => e.id);
    const areAllExpanded = allIds.every(id => emailState.expandedThreadCardIds.has(id));

    if (areAllExpanded) {
        emailState.expandedThreadCardIds.clear();
    } else {
        allIds.forEach(id => emailState.expandedThreadCardIds.add(id));
    }

    renderEmailDetail(emailState.selectedEmailId);
}

async function fetchAndRenderThreadCardBody(emailId) {
    let email = emailState.detailCache[emailId];
    if (!email) {
        try {
            if (window.eel && typeof eel.get_email_detail === 'function') {
                const res = await eel.get_email_detail(emailId)();
                if (res.success && res.email) {
                    email = res.email;
                    cacheEmailDetail(emailId, email);
                }
            }
        } catch (e) {
            console.error("스레드 메일 상세 로드 실패:", e);
        }
    }

    const card = document.getElementById(`thread-card-${emailId}`);
    if (!card) return;

    const bodyContainer = card.querySelector('.email-thread-card-body');
    if (!bodyContainer) return;

    email = email || emailState.emails.find(e => e.id === emailId);
    if (!email) return;

    const hasAttach = email.attachments && email.attachments.length > 0;
    let contentHtml = '';

    if (emailState.viewMode === 'html' && email.body_html) {
        contentHtml = `
            <div class="thread-body-content">
                <iframe class="thread-body-html-frame" sandbox="allow-same-origin" srcdoc="${escapeHtmlAttr(email.body_html)}"></iframe>
            </div>
        `;
    } else {
        contentHtml = `
            <div class="thread-body-content">
                <pre class="thread-body-text">${escapeHtml(email.body_text || email.snippet || '(본문 내용이 없습니다)')}</pre>
            </div>
        `;
    }

    bodyContainer.innerHTML = `
        ${renderEmailAttachmentsBar(email, 'margin-bottom: 8px;')}
        ${contentHtml}
    `;
}

async function changeThreadCategory(threadKey, newCategory) {
    if (!newCategory) return;
    const threadEmails = emailState.emails.filter(e => (e.thread_key || cleanSubject(e.subject)).toLowerCase() === threadKey);
    for (const em of threadEmails) {
        await changeEmailCategory(em.id, newCategory);
    }
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

function renderEmailDetailLoadingHeader(summary) {
    const container = document.getElementById('email-detail-container');
    if (!container) return;

    container.innerHTML = `
        <div class="email-detail-header">
            <div class="email-detail-title-row">
                <h2 class="email-detail-subject">${escapeHtml(summary.subject || '(제목 없음)')}</h2>
            </div>
            <div class="email-meta-grid">
                <div class="email-meta-item">
                    <span class="meta-label">보낸사람:</span>
                    <span class="meta-value">${escapeHtml(summary.from || '-')}</span>
                </div>
                <div class="email-meta-item">
                    <span class="meta-label">작성일시:</span>
                    <span class="meta-value">${escapeHtml(summary.date || summary.created_at || '-')}</span>
                </div>
            </div>
        </div>
        <div class="email-detail-body">
            <div class="email-body-text-wrapper" style="display: flex; align-items: center; justify-content: center; color: var(--text-secondary);">
                <span>⏳ 이메일 본문 불러오는 중...</span>
            </div>
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
// 7. 카테고리 변경 & 추가
// ==========================================
async function changeEmailCategory(emailId, newCategory) {
    if (!newCategory) return;
    try {
        if (window.eel && typeof eel.update_email_category === 'function') {
            const res = await eel.update_email_category(emailId, newCategory)();
            if (res.success) {
                const targetSummary = emailState.emails.find(e => e.id === emailId);
                if (targetSummary) targetSummary.category = newCategory;
                if (emailState.detailCache[emailId]) emailState.detailCache[emailId].category = newCategory;

                updateCategoriesList();
                renderEmailCategoryChips();
                renderEmailList();
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
// 8. 파일 가져오기 & 드래그 앤 드롭 (프로그레스 바 지원)
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

    if (countEl) countEl.textContent = `${current.toLocaleString()} / ${total.toLocaleString()}개 처리 중...`;
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
                await loadAllEmails();
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
                await loadAllEmails();
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
                            successCount++;
                        }
                    }
                } catch (err) {
                    console.error("드롭 파일 파싱 실패:", err);
                }
            }
        }

        if (successCount > 0) {
            await loadAllEmails();
            logToConsole('EML 드래그 드롭 등록', `총 ${successCount}개 이메일 등록 완료`);
            await showAppAlert(`총 ${successCount}개의 .eml 이메일을 성공적으로 등록했습니다! 📧`, '등록 완료', '✅');
        }
    });
}

// ==========================================
// 9. 첨부파일 & 이메일 액션 (열기, 저장, 일괄저장, 복사, 삭제, 비우기)
// ==========================================
function getFileIcon(filename) {
    if (!filename) return '📎';
    const ext = filename.split('.').pop().toLowerCase();
    if (['pdf'].includes(ext)) return '📄';
    if (['xlsx', 'xls', 'csv'].includes(ext)) return '📊';
    if (['docx', 'doc', 'hwp', 'hwpx', 'txt', 'rtf', 'md'].includes(ext)) return '📝';
    if (['pptx', 'ppt'].includes(ext)) return '📑';
    if (['png', 'jpg', 'jpeg', 'gif', 'bmp', 'svg', 'webp'].includes(ext)) return '🖼️';
    if (['zip', '7z', 'rar', 'tar', 'gz', 'iso'].includes(ext)) return '📦';
    if (['mp3', 'wav', 'ogg', 'mp4', 'avi', 'mkv'].includes(ext)) return '🎬';
    if (['json', 'js', 'py', 'java', 'cpp', 'html', 'css', 'xml'].includes(ext)) return '💻';
    return '📎';
}

async function openEmailAttachment(emailId, index, filename) {
    try {
        if (window.eel && typeof eel.open_email_attachment === 'function') {
            logToConsole('첨부파일 열기', `'${filename}' 파일을 임시 폴더에 추출하여 여는 중...`);
            const res = await eel.open_email_attachment(emailId, index, filename)();
            if (res.status === 'success') {
                logToConsole('첨부파일 열기 완료', res.message);
            } else {
                await showAppAlert(`첨부파일 열기 실패: ${res.message}`, '오류', '⚠️');
            }
        }
    } catch (e) {
        console.error("첨부파일 열기 오류:", e);
        await showAppAlert(`첨부파일 열기 중 오류가 발생했습니다: ${e.message || e}`, '오류', '⚠️');
    }
}

async function saveEmailAttachment(emailId, index, filename) {
    try {
        if (window.eel && typeof eel.save_email_attachment_dialog === 'function') {
            const res = await eel.save_email_attachment_dialog(emailId, index, filename)();
            if (res.status === 'success') {
                logToConsole('첨부파일 저장 완료', res.message);
                await showAppAlert(`'${filename}' 파일이 성공적으로 저장되었습니다! 💾`, '저장 완료', '✅');
            } else if (res.status === 'error') {
                await showAppAlert(`첨부파일 저장 실패: ${res.message}`, '저장 실패', '⚠️');
            }
        }
    } catch (e) {
        console.error("첨부파일 저장 오류:", e);
    }
}

async function saveAllEmailAttachments(emailId) {
    try {
        if (window.eel && typeof eel.save_all_email_attachments_dialog === 'function') {
            logToConsole('첨부파일 일괄 저장', '저장할 대상 폴더를 선택해주세요...');
            const res = await eel.save_all_email_attachments_dialog(emailId)();
            if (res.status === 'success') {
                logToConsole('첨부파일 일괄 저장 완료', res.message);
                await showAppAlert(`총 ${res.count}개의 첨부파일이 저장되었습니다! 📦\n경로: ${res.folder}`, '일괄 저장 완료', '✅');
            } else if (res.status === 'error') {
                await showAppAlert(`일괄 저장 실패: ${res.message}`, '저장 실패', '⚠️');
            }
        }
    } catch (e) {
        console.error("첨부파일 일괄 저장 오류:", e);
    }
}

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
    let email = emailState.detailCache[emailId];
    if (!email) {
        if (window.eel && typeof eel.get_email_detail === 'function') {
            const res = await eel.get_email_detail(emailId)();
            if (res.success && res.email) {
                email = res.email;
                emailState.detailCache[emailId] = email;
            }
        }
    }
    if (!email) email = emailState.emails.find(e => e.id === emailId);
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
                delete emailState.detailCache[emailId];
                emailState.emails = emailState.emails.filter(e => e.id !== emailId);
                updateCategoriesList();
                renderEmailCategoryChips();
                if (emailState.selectedEmailId === emailId) {
                    const list = getProcessedEmailList();
                    emailState.selectedEmailId = list.length > 0 ? list[0].id : null;
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
            emailState.detailCache = {};
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
    clearEmailSearch();
    emailState.activeCategory = '전체';
    renderEmailCategoryChips();

    // 해당 emailId가 포함된 스레드나 카드가 있는지 찾기
    const processedList = getProcessedEmailList();
    let targetThread = processedList.find(t => t.id === emailId || (t.thread_emails && t.thread_emails.some(m => m.id === emailId)));
    const targetId = targetThread ? targetThread.id : emailId;

    // 해당 카드가 displayedLimit 바깥에 있다면 displayedLimit 확장
    const targetIdx = processedList.findIndex(t => t.id === targetId);
    if (targetIdx >= emailState.displayedLimit) {
        emailState.displayedLimit = targetIdx + 30;
    }

    renderEmailList();
    selectEmail(targetId);

    // 해당 카드로 좌측 스크롤 자동 이동
    setTimeout(() => {
        const card = document.querySelector(`.email-list-card[data-email-id="${targetId}"]`);
        if (card) {
            card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    }, 120);
}

// ==========================================
// 10. 좌우 스플리터 리사이저
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
// 11. 헬퍼 유틸
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

// ==========================================
// 12. 메모리 최적화: LRU 캐시 및 탭 이탈 정리
// ==========================================
function cacheEmailDetail(emailId, detailObj) {
    if (!emailId || !detailObj) return;
    emailState.detailCache[emailId] = detailObj;

    // LRU 캐시: 최대 10개만 메모리에 유지하고 오래된 본문 해제
    const keys = Object.keys(emailState.detailCache);
    if (keys.length > 10) {
        const removeCount = keys.length - 10;
        for (let i = 0; i < removeCount; i++) {
            if (keys[i] !== emailState.selectedEmailId) {
                delete emailState.detailCache[keys[i]];
            }
        }
    }
}

function teardownEmailViewer() {
    // 탭을 벗어날 때 iframe 본문 및 오래된 캐시 정리
    const iframes = document.querySelectorAll('.email-html-iframe, .thread-body-html-frame');
    iframes.forEach(f => {
        try {
            f.srcdoc = '';
        } catch (e) {}
    });
    // 현재 열람 중인 메일 1개만 남기고 캐시 비우기
    const selId = emailState.selectedEmailId;
    if (selId && emailState.detailCache[selId]) {
        emailState.detailCache = { [selId]: emailState.detailCache[selId] };
    } else {
        emailState.detailCache = {};
    }
}

/**
 * AI 시맨틱 문맥 검색 & 의미 유사도 비교 제어 모듈
 * - 다국어/음차(tomcat <-> 톰캣 등) 의미 기반 매칭
 * - 전역 단축키 Ctrl+K 지원
 */

let currentAiSearchCategory = 'all';
let aiSearchDebounceTimer = null;
let lastAiSearchQuery = '';

// 1. 모달 열기 / 닫기
function openAiSearchModal(initialQuery = '') {
    const modal = document.getElementById('ai-search-modal');
    if (!modal) return;

    modal.classList.add('show');
    switchAiSubTab('search');

    // 모달을 열었을 때 비동기로 AI 엔진 준비 (온디맨드)
    if (window.eel && typeof eel.warmup_ai_engine_async === 'function') {
        eel.warmup_ai_engine_async()().catch(() => {});
    }

    const input = document.getElementById('ai-search-input');
    if (input) {
        if (initialQuery) {
            input.value = initialQuery;
            onAiSearchInputChange(initialQuery);
        } else if (!input.value.trim()) {
            // 추천 기본 검색어 프리뷰
            renderAiSearchEmptyState();
        }
        setTimeout(() => input.focus(), 80);
    }
}

function closeAiSearchModal() {
    const modal = document.getElementById('ai-search-modal');
    if (modal) modal.classList.remove('show');
}

// 2. 서브 탭 전환
function switchAiSubTab(tab) {
    const searchBtn = document.getElementById('ai-subtab-search');
    const compareBtn = document.getElementById('ai-subtab-compare');
    const searchPane = document.getElementById('ai-search-pane');
    const comparePane = document.getElementById('ai-compare-pane');

    if (tab === 'search') {
        searchBtn?.classList.add('active');
        compareBtn?.classList.remove('active');
        if (searchPane) searchPane.style.display = 'block';
        if (comparePane) comparePane.style.display = 'none';
        const input = document.getElementById('ai-search-input');
        if (input) setTimeout(() => input.focus(), 60);
    } else {
        compareBtn?.classList.add('active');
        searchBtn?.classList.remove('active');
        if (comparePane) comparePane.style.display = 'block';
        if (searchPane) searchPane.style.display = 'none';
    }
}

// 3. 실시간 AI 검색 입력 처리 (디바운스 300ms & 엔터키 즉시 검색)
function onAiSearchInputChange(val) {
    const clearBtn = document.getElementById('ai-search-clear-btn');
    if (clearBtn) {
        clearBtn.style.display = val ? 'inline-block' : 'none';
    }

    clearTimeout(aiSearchDebounceTimer);
    if (!val || !val.trim()) {
        renderAiSearchEmptyState();
        return;
    }

    aiSearchDebounceTimer = setTimeout(() => {
        executeAiSearch(val.trim());
    }, 300);
}

function handleAiSearchKeydown(event) {
    if (event.key === 'Enter') {
        clearTimeout(aiSearchDebounceTimer);
        const input = document.getElementById('ai-search-input');
        if (input && input.value.trim()) {
            executeAiSearch(input.value.trim());
        }
    }
}

function clearAiSearchInput() {
    const input = document.getElementById('ai-search-input');
    if (input) {
        input.value = '';
        input.focus();
    }
    const clearBtn = document.getElementById('ai-search-clear-btn');
    if (clearBtn) clearBtn.style.display = 'none';
    renderAiSearchEmptyState();
}

// 4. 카테고리 필터 설정
function setAiSearchCategory(cat) {
    currentAiSearchCategory = cat;
    document.querySelectorAll('.ai-chip-btn').forEach(btn => {
        btn.classList.toggle('active', btn.getAttribute('data-cat') === cat);
    });

    const input = document.getElementById('ai-search-input');
    if (input && input.value.trim()) {
        executeAiSearch(input.value.trim());
    }
}

// 5. 검색 실행 (백엔드 Eel AI 서비스 호출)
async function executeAiSearch(query) {
    lastAiSearchQuery = query;
    const listEl = document.getElementById('ai-results-list');
    const countEl = document.getElementById('ai-results-count');

    if (countEl) countEl.innerHTML = `<span>⚡ '<b>${escapeHtml(query)}</b>' 문맥 분석 중...</span>`;

    try {
        let results = [];
        let latencyMs = 0;
        if (window.eel && typeof eel.ai_semantic_search === 'function') {
            const res = await eel.ai_semantic_search(query, currentAiSearchCategory)();
            if (res.status === 'success' && Array.isArray(res.data)) {
                results = res.data;
                latencyMs = res.latency_ms || 0;
            }
        }

        renderAiSearchResults(results, query, latencyMs);
    } catch (err) {
        console.error("AI 검색 실패:", err);
        if (listEl) {
            listEl.innerHTML = `<div style="color:var(--danger-color); text-align:center; padding:24px;">검색 처리 중 오류가 발생했습니다: ${err.message}</div>`;
        }
    }
}

// 6. 검색 결과 렌더링
function renderAiSearchResults(results, query, latencyMs = 0) {
    const listEl = document.getElementById('ai-results-list');
    const countEl = document.getElementById('ai-results-count');
    if (!listEl) return;

    if (countEl) {
        const timeBadge = latencyMs > 0 ? `<span style="font-size:0.75rem; color:#34d399; margin-left:6px;">⚡ ${latencyMs}ms</span>` : '';
        if (results.length > 0) {
            countEl.innerHTML = `<span>총 <b>${results.length}개</b> 연관 항목 발견 ${timeBadge}</span>`;
        } else {
            countEl.innerHTML = `<span>'<b>${escapeHtml(query)}</b>'와 관련된 내용을 찾지 못했습니다. ${timeBadge}</span>`;
        }
    }

    if (results.length === 0) {
        listEl.innerHTML = `
            <div style="color:var(--text-secondary); text-align:center; padding:30px 10px;">
                <div style="font-size: 2rem; margin-bottom: 8px;">🔍</div>
                <div style="font-weight: 500;">일치하는 문맥 결과가 없습니다.</div>
                <div style="font-size: 0.78rem; margin-top: 6px; color: #94a3b8;">
                    다른 동의어나 기술 키워드(예: 톰캣, 토큰, 디비, 배포 등)로 검색해 보세요.
                </div>
            </div>
        `;
        return;
    }

    listEl.innerHTML = results.map(item => {
        let scoreClass = 'ai-score-low';
        if (item.score >= 80) scoreClass = 'ai-score-high';
        else if (item.score >= 50) scoreClass = 'ai-score-mid';

        const safeTitle = escapeHtml(item.title);
        const safeSnippet = escapeHtml(item.snippet || '');

        return `
            <div class="ai-result-item" onclick="navigateToAiSearchResult(${JSON.stringify(item).replace(/"/g, '&quot;')})">
                <div class="ai-result-left">
                    <div class="ai-result-title-row">
                        <span>${item.icon}</span>
                        <span>${safeTitle}</span>
                        <span class="ai-result-tag">${escapeHtml(item.category_label)}</span>
                    </div>
                    <div class="ai-result-snippet" title="${safeSnippet}">${safeSnippet || '내용 요약 없음'}</div>
                </div>
                <div style="display: flex; align-items: center; gap: 8px;">
                    <span class="ai-score-badge ${scoreClass}">
                        ${item.score >= 90 ? '🔥 ' : ''}${item.score}% 일치
                    </span>
                    <button class="form-btn add-btn" style="padding: 3px 8px; font-size: 0.75rem; white-space: nowrap;">
                        이동 ➔
                    </button>
                </div>
            </div>
        `;
    }).join('');
}

// 빈 검색창 추천 상태
function renderAiSearchEmptyState() {
    const listEl = document.getElementById('ai-results-list');
    const countEl = document.getElementById('ai-results-count');

    if (countEl) {
        countEl.textContent = '검색어를 입력하면 실시간 문맥 유사도 순으로 분석됩니다.';
    }
    if (!listEl) return;

    listEl.innerHTML = `
        <div style="color:var(--text-secondary); padding: 18px 12px; text-align: center;">
            <div style="font-size: 0.88rem; font-weight: 600; color: #c084fc; margin-bottom: 8px;">
                💡 이런 자연어로 검색해 보세요:
            </div>
            <div style="display: flex; gap: 6px; justify-content: center; flex-wrap: wrap;">
                <button class="mini-chip-btn" onclick="quickAiSearch('톰캣 포트')">톰캣 포트</button>
                <button class="mini-chip-btn" onclick="quickAiSearch('디비 타임아웃')">디비 타임아웃</button>
                <button class="mini-chip-btn" onclick="quickAiSearch('토큰 로그인')">토큰 로그인</button>
                <button class="mini-chip-btn" onclick="quickAiSearch('배포 스크립트')">배포 스크립트</button>
                <button class="mini-chip-btn" onclick="quickAiSearch('순서도 흐름')">순서도 흐름</button>
                <button class="mini-chip-btn" onclick="quickAiSearch('난수 생성')">난수 생성</button>
            </div>
        </div>
    `;
}

function quickAiSearch(term) {
    const input = document.getElementById('ai-search-input');
    if (input) {
        input.value = term;
        onAiSearchInputChange(term);
    }
}

// 7. 검색 결과 클릭 시 해당 탭 및 항목으로 즉시 이동 (Smart Navigation)
async function navigateToAiSearchResult(item) {
    closeAiSearchModal();

    if (!item) return;

    // 탭 이름 정규화 (구버전 캐시 데이터 및 호환성 보장)
    let targetTab = item.target_tab;
    if (!targetTab) {
        if (item.category === 'notes') targetTab = 'notes';
        else if (item.category === 'emails') targetTab = 'emails';
        else if (item.category === 'diagrams') targetTab = 'mermaid';
        else if (item.category === 'quick_launch') targetTab = 'launch';
        else if (item.category === 'shortcuts') targetTab = 'files';
        else if (item.category === 'generators') targetTab = 'generator';
    }
    if (targetTab === 'scratchpad') targetTab = 'notes';
    if (targetTab === 'diagram-viewer' || targetTab === 'diagram') targetTab = 'mermaid';
    if (targetTab === 'quick-launch' || targetTab === 'quick_launch') targetTab = 'launch';
    if (targetTab === 'shortcuts') targetTab = 'files';
    if (targetTab === 'generators') targetTab = 'generator';

    // 해당 탭으로 전환
    if (typeof switchTab === 'function') {
        switchTab(targetTab);
    }

    if (item.category === 'notes' && item.action_data?.note_id) {
        // 지연 로딩된 메모가 준비될 때까지 안전하게 선택 (재시도 폴링)
        const noteId = item.action_data.note_id;
        const trySelectNote = (retries = 10) => {
            if (typeof currentNotes !== 'undefined' && currentNotes.length > 0 && typeof selectNote === 'function') {
                selectNote(noteId);
            } else if (retries > 0) {
                setTimeout(() => trySelectNote(retries - 1), 50);
            }
        };
        trySelectNote();
        logToConsole('AI 검색 이동', `'${item.title}' 메모로 이동`);
    } else if (item.category === 'emails' && item.action_data?.email_id) {
        // AI 검색 이메일 즉시 열람 (스레드 탐색 및 SQLite 온디맨드 로드)
        const emailId = item.action_data.email_id;
        const tryOpenEmail = (retries = 10) => {
            if (typeof openEmailFromAiSearch === 'function') {
                openEmailFromAiSearch(emailId);
            } else if (retries > 0) {
                setTimeout(() => tryOpenEmail(retries - 1), 50);
            }
        };
        tryOpenEmail();
        logToConsole('AI 검색 이동', `'${item.title}' 이메일로 이동`);
    } else if (item.category === 'diagrams' && item.action_data?.code) {
        // 다이어그램 에디터에 로드
        const editor = document.getElementById('mermaid-code-editor');
        if (editor) {
            editor.value = item.action_data.code;
            if (typeof renderMermaid === 'function') renderMermaid(true);
        }
        logToConsole('AI 검색 이동', `'${item.title}' 다이어그램 로드`);
    } else {
        logToConsole('AI 검색 이동', `[${item.category_label || item.category}] '${item.title}' 항목으로 이동`);
    }
}

// 8. 문장 의미 유사도 측정기 (Similarity Matcher)
async function runAiSimilarityCompare() {
    const textA = document.getElementById('ai-compare-text-a')?.value.trim();
    const textB = document.getElementById('ai-compare-text-b')?.value.trim();
    const resultBox = document.getElementById('ai-compare-result-card');

    if (!textA || !textB) {
        await showAppAlert('비교할 텍스트 A와 B를 모두 입력해 주세요.', '입력 필요', '⚠️');
        return;
    }

    try {
        let res = null;
        if (window.eel && typeof eel.ai_compare_similarity === 'function') {
            res = await eel.ai_compare_similarity(textA, textB)();
        }

        if (res && res.status === 'success') {
            const score = res.score;
            const verdict = res.verdict;
            const keywords = res.common_keywords || [];

            if (resultBox) {
                resultBox.style.display = 'block';
                resultBox.innerHTML = `
                    <div class="ai-compare-score-row">
                        <div>
                            <span style="font-size: 0.82rem; color: var(--text-secondary);">의미 일치율:</span>
                            <div class="ai-compare-score-num">${score}%</div>
                        </div>
                        <div style="text-align: right;">
                            <span style="font-size: 0.82rem; color: var(--text-secondary);">AI 분석 판정:</span>
                            <div class="ai-compare-verdict">${verdict}</div>
                        </div>
                    </div>
                    <div class="ai-progress-bar-bg">
                        <div class="ai-progress-bar-fill" style="width: ${Math.max(4, score)}%;"></div>
                    </div>
                    ${keywords.length > 0 ? `
                        <div style="margin-top: 8px;">
                            <span style="font-size: 0.78rem; color: #c084fc; font-weight: 600;">🔗 매칭된 핵심 의미 토큰:</span>
                            <div class="ai-keywords-chips" style="margin-top: 4px;">
                                ${keywords.map(k => `<span class="ai-key-chip">${escapeHtml(k)}</span>`).join('')}
                            </div>
                        </div>
                    ` : ''}
                `;
            }
        }
    } catch (e) {
        console.error("유사도 비교 오류:", e);
        await showAppAlert(`유사도 분석 실패: ${e.message}`, '오류', '⚠️');
    }
}

// 9. 전역 단축키 Ctrl+K 바인딩
document.addEventListener('keydown', function(e) {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        const modal = document.getElementById('ai-search-modal');
        if (modal && modal.classList.contains('show')) {
            closeAiSearchModal();
        } else {
            openAiSearchModal();
        }
    }
});

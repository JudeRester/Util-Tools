/**
 * 텍스트 차이점 비교 도구 (Diff Checker) 프론트엔드 모듈 (web/js/diff_checker.js)
 * - 원본(Original)과 수정본(Modified) 텍스트/코드의 행 및 인라인 단어/문자 비교
 * - Split View (나란히 보기, 양방향 스크롤 동기화) 및 Unified View (단일 통합 보기)
 * - 로컬 파일 열기(Tkinter/Eel) 및 드래그 앤 드롭 파일 로드 지원
 * - Git 표준 Unified Diff 패치 클립보드 복사 지원
 */

var diffState = {
    viewMode: 'split',      // 'split' | 'unified'
    lastResult: null,       // 백엔드 반환 결과 캐시
    isComparing: false,
    inputsCollapsed: false
};

let isSyncingScroll = false;

/**
 * HTML 특수문자 이스케이프 유틸리티
 */
function _diffEscape(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

/**
 * Diff Checker 모듈 온디맨드 초기화
 */
function initDiffChecker() {
    setupDiffDropZone('diff-orig-drop-zone', 'diff-orig-text');
    setupDiffDropZone('diff-mod-drop-zone', 'diff-mod-text');
    updateDiffInputCounts();
}

/**
 * 드래그 앤 드롭 파일 로드 이벤트 바인딩
 */
function setupDiffDropZone(dropZoneId, textareaId) {
    const dropZone = document.getElementById(dropZoneId);
    const textarea = document.getElementById(textareaId);
    if (!dropZone || !textarea) return;

    let dragCounter = 0;

    dropZone.addEventListener('dragenter', (e) => {
        e.preventDefault();
        dragCounter++;
        dropZone.classList.add('drag-over');
    });

    dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
    });

    dropZone.addEventListener('dragleave', (e) => {
        e.preventDefault();
        dragCounter--;
        if (dragCounter <= 0) {
            dragCounter = 0;
            dropZone.classList.remove('drag-over');
        }
    });

    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        dragCounter = 0;
        dropZone.classList.remove('drag-over');

        const files = e.dataTransfer?.files;
        if (!files || files.length === 0) return;

        const file = files[0];
        const reader = new FileReader();
        reader.onload = (event) => {
            textarea.value = event.target.result;
            updateDiffInputCounts();
            if (typeof showToast === 'function') {
                showToast('파일 로드 완료', `${file.name} 내용이 입력되었습니다.`, 'success');
            }
        };
        reader.onerror = () => {
            if (typeof showToast === 'function') {
                showToast('파일 읽기 실패', `${file.name} 파일을 읽을 수 없습니다.`, 'error');
            }
        };
        reader.readAsText(file);
    });
}

/**
 * 입력창 텍스트 행 수 및 글자 수 카운터 실시간 갱신
 */
function updateDiffInputCounts() {
    const origText = document.getElementById('diff-orig-text')?.value || '';
    const modText = document.getElementById('diff-mod-text')?.value || '';

    const origLines = origText ? origText.split('\n').length : 0;
    const modLines = modText ? modText.split('\n').length : 0;

    const origCountEl = document.getElementById('diff-orig-count');
    const modCountEl = document.getElementById('diff-mod-count');

    if (origCountEl) origCountEl.textContent = `${origLines}행, ${origText.length.toLocaleString()}자`;
    if (modCountEl) modCountEl.textContent = `${modLines}행, ${modText.length.toLocaleString()}자`;
}

/**
 * 좌우 텍스트 에디터 접기/펼치기 토글
 */
function toggleDiffInputPanels() {
    const inputsWrapper = document.getElementById('diff-inputs-wrapper');
    const iconEl = document.getElementById('diff-toggle-input-icon');
    const textEl = document.getElementById('diff-toggle-input-text');
    if (!inputsWrapper) return;

    diffState.inputsCollapsed = !diffState.inputsCollapsed;
    if (diffState.inputsCollapsed) {
        inputsWrapper.style.display = 'none';
        if (iconEl) iconEl.textContent = '🔽';
        if (textEl) textEl.textContent = '입력창 펼치기';
    } else {
        inputsWrapper.style.display = 'grid';
        if (iconEl) iconEl.textContent = '🔼';
        if (textEl) textEl.textContent = '입력창 접기';
    }
}

/**
 * 뷰 모드 설정 (Split vs Unified)
 */
function setDiffViewMode(mode) {
    if (mode !== 'split' && mode !== 'unified') return;
    diffState.viewMode = mode;

    const splitBtn = document.getElementById('diff-mode-split-btn');
    const unifiedBtn = document.getElementById('diff-mode-unified-btn');
    const splitContainer = document.getElementById('diff-split-container');
    const unifiedContainer = document.getElementById('diff-unified-container');

    if (mode === 'split') {
        splitBtn?.classList.add('active');
        unifiedBtn?.classList.remove('active');
        if (splitContainer) splitContainer.style.display = 'grid';
        if (unifiedContainer) unifiedContainer.style.display = 'none';
    } else {
        splitBtn?.classList.remove('active');
        unifiedBtn?.classList.add('active');
        if (splitContainer) splitContainer.style.display = 'none';
        if (unifiedContainer) unifiedContainer.style.display = 'block';
    }

    if (diffState.lastResult && diffState.lastResult.items) {
        renderDiffView(diffState.lastResult.items);
    }
}

/**
 * Diff 비교 연산 비동기 호출
 */
async function runDiffComparison() {
    if (diffState.isComparing) return;

    const origText = document.getElementById('diff-orig-text')?.value || '';
    const modText = document.getElementById('diff-mod-text')?.value || '';

    if (!origText && !modText) {
        if (typeof showToast === 'function') {
            showToast('비교 대상 없음', '비교할 텍스트를 입력해주세요.', 'warning');
        }
        return;
    }

    const options = {
        granularity: document.getElementById('diff-granularity-select')?.value || 'word',
        ignore_whitespace: document.getElementById('diff-opt-whitespace')?.checked || false,
        ignore_case: document.getElementById('diff-opt-case')?.checked || false,
        ignore_blank_lines: document.getElementById('diff-opt-blank')?.checked || false
    };

    const runBtn = document.getElementById('diff-run-btn');
    const stateBadge = document.getElementById('diff-status-state');
    const timeBadge = document.getElementById('diff-time-badge');

    diffState.isComparing = true;
    if (runBtn) {
        runBtn.disabled = true;
        runBtn.innerHTML = '<span class="spinner-inline"></span> 비교 분석 중...';
    }

    const startTime = performance.now();

    try {
        if (!window.eel || typeof window.eel.compute_text_diff !== 'function') {
            throw new Error('Diff 백엔드 서비스(eel.compute_text_diff)가 바인딩되지 않았습니다.');
        }

        const res = await window.eel.compute_text_diff(origText, modText, options)();
        const duration = (performance.now() - startTime).toFixed(1);

        if (res.status !== 'success') {
            throw new Error(res.message || '알 수 없는 오류');
        }

        diffState.lastResult = res;
        if (timeBadge) timeBadge.textContent = `⏱️ ${duration}ms`;

        updateDiffStats(res.stats);
        renderDiffView(res.items);

    } catch (err) {
        console.error('[DiffChecker Error]', err);
        if (typeof showToast === 'function') {
            showToast('Diff 비교 실패', err.message, 'error');
        }
        if (stateBadge) {
            stateBadge.className = 'diff-badge badge-danger';
            stateBadge.textContent = '오류 발생';
        }
    } finally {
        diffState.isComparing = false;
        if (runBtn) {
            runBtn.disabled = false;
            runBtn.innerHTML = '<span class="btn-icon">▶️</span><span class="btn-text">차이점 비교 실행</span>';
        }
    }
}

/**
 * 통계 요약 바 갱신
 */
function updateDiffStats(stats) {
    if (!stats) return;

    const stateBadge = document.getElementById('diff-status-state');
    const statAdd = document.getElementById('diff-stat-add');
    const statDel = document.getElementById('diff-stat-del');
    const statMod = document.getElementById('diff-stat-mod');
    const statUnc = document.getElementById('diff-stat-unc');

    if (statAdd) statAdd.textContent = `➕ ${stats.additions} 추가`;
    if (statDel) statDel.textContent = `➖ ${stats.deletions} 삭제`;
    if (statMod) statMod.textContent = `✏️ ${stats.modifications} 수정`;
    if (statUnc) statUnc.textContent = `⚖️ ${stats.unchanged} 동일`;

    if (stateBadge) {
        if (stats.is_identical) {
            stateBadge.className = 'diff-badge badge-success';
            stateBadge.textContent = '✨ 완전히 동일함';
        } else {
            const totalDiffs = stats.additions + stats.deletions + stats.modifications;
            stateBadge.className = 'diff-badge badge-warning';
            stateBadge.textContent = `⚡ ${totalDiffs}개 차이 발견`;
        }
    }
}

/**
 * 현재 뷰 모드에 따라 렌더링 분기
 */
function renderDiffView(items) {
    if (diffState.viewMode === 'split') {
        renderSplitView(items);
    } else {
        renderUnifiedView(items);
    }
}

/**
 * 인라인 단어/문자 세부 차이점 토큰 HTML 변환
 */
function renderInlineParts(parts) {
    if (!parts || parts.length === 0) return '&nbsp;';
    return parts.map(p => {
        const text = _diffEscape(p.text);
        if (p.type === 'del') {
            return `<span class="diff-word-del">${text}</span>`;
        } else if (p.type === 'ins') {
            return `<span class="diff-word-ins">${text}</span>`;
        }
        return `<span>${text}</span>`;
    }).join('');
}

/**
 * Split View (나란히 보기) 렌더링
 */
function renderSplitView(items) {
    const origBody = document.getElementById('diff-split-orig-body');
    const modBody = document.getElementById('diff-split-mod-body');
    if (!origBody || !modBody) return;

    if (!items || items.length === 0) {
        const emptyHtml = '<div class="diff-empty-placeholder">비교할 텍스트가 비어있습니다.</div>';
        origBody.innerHTML = emptyHtml;
        modBody.innerHTML = emptyHtml;
        return;
    }

    let origLinesHtml = '';
    let modLinesHtml = '';

    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const type = item.type;

        // 좌측 (Original)
        if (type === 'equal') {
            origLinesHtml += `<div class="diff-line diff-line-equal"><span class="diff-line-num">${item.orig_line_num}</span><span class="diff-line-content">${_diffEscape(item.orig_text) || '&nbsp;'}</span></div>`;
            modLinesHtml += `<div class="diff-line diff-line-equal"><span class="diff-line-num">${item.mod_line_num}</span><span class="diff-line-content">${_diffEscape(item.mod_text) || '&nbsp;'}</span></div>`;
        } else if (type === 'replace') {
            origLinesHtml += `<div class="diff-line diff-line-del"><span class="diff-line-num">${item.orig_line_num}</span><span class="diff-line-content">${renderInlineParts(item.orig_parts)}</span></div>`;
            modLinesHtml += `<div class="diff-line diff-line-ins"><span class="diff-line-num">${item.mod_line_num}</span><span class="diff-line-content">${renderInlineParts(item.mod_parts)}</span></div>`;
        } else if (type === 'delete') {
            origLinesHtml += `<div class="diff-line diff-line-del"><span class="diff-line-num">${item.orig_line_num}</span><span class="diff-line-content">${_diffEscape(item.orig_text) || '&nbsp;'}</span></div>`;
            modLinesHtml += `<div class="diff-line diff-line-empty"><span class="diff-line-num"></span><span class="diff-line-content">&nbsp;</span></div>`;
        } else if (type === 'insert') {
            origLinesHtml += `<div class="diff-line diff-line-empty"><span class="diff-line-num"></span><span class="diff-line-content">&nbsp;</span></div>`;
            modLinesHtml += `<div class="diff-line diff-line-ins"><span class="diff-line-num">${item.mod_line_num}</span><span class="diff-line-content">${_diffEscape(item.mod_text) || '&nbsp;'}</span></div>`;
        }
    }

    origBody.innerHTML = origLinesHtml;
    modBody.innerHTML = modLinesHtml;
}

/**
 * Unified View (통합 보기) 렌더링
 */
function renderUnifiedView(items) {
    const unifiedBody = document.getElementById('diff-unified-body');
    if (!unifiedBody) return;

    if (!items || items.length === 0) {
        unifiedBody.innerHTML = '<div class="diff-empty-placeholder">비교할 텍스트가 비어있습니다.</div>';
        return;
    }

    let linesHtml = '';

    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const type = item.type;

        if (type === 'equal') {
            linesHtml += `<div class="diff-line diff-line-equal"><span class="diff-line-num orig">${item.orig_line_num}</span><span class="diff-line-num mod">${item.mod_line_num}</span><span class="diff-sign"> </span><span class="diff-line-content">${_diffEscape(item.orig_text) || '&nbsp;'}</span></div>`;
        } else if (type === 'delete') {
            linesHtml += `<div class="diff-line diff-line-del"><span class="diff-line-num orig">${item.orig_line_num}</span><span class="diff-line-num mod"></span><span class="diff-sign">-</span><span class="diff-line-content">${_diffEscape(item.orig_text) || '&nbsp;'}</span></div>`;
        } else if (type === 'insert') {
            linesHtml += `<div class="diff-line diff-line-ins"><span class="diff-line-num orig"></span><span class="diff-line-num mod">${item.mod_line_num}</span><span class="diff-sign">+</span><span class="diff-line-content">${_diffEscape(item.mod_text) || '&nbsp;'}</span></div>`;
        } else if (type === 'replace') {
            linesHtml += `<div class="diff-line diff-line-del"><span class="diff-line-num orig">${item.orig_line_num}</span><span class="diff-line-num mod"></span><span class="diff-sign">-</span><span class="diff-line-content">${renderInlineParts(item.orig_parts)}</span></div>`;
            linesHtml += `<div class="diff-line diff-line-ins"><span class="diff-line-num orig"></span><span class="diff-line-num mod">${item.mod_line_num}</span><span class="diff-sign">+</span><span class="diff-line-content">${renderInlineParts(item.mod_parts)}</span></div>`;
        }
    }

    unifiedBody.innerHTML = linesHtml;
}

/**
 * Split View 좌우 스크롤 동기화 핸들러 (무한 루프 방지 래퍼)
 */
function syncDiffScroll(source) {
    if (isSyncingScroll) return;
    isSyncingScroll = true;

    const origBody = document.getElementById('diff-split-orig-body');
    const modBody = document.getElementById('diff-split-mod-body');

    if (!origBody || !modBody) {
        isSyncingScroll = false;
        return;
    }

    if (source === 'orig') {
        modBody.scrollTop = origBody.scrollTop;
        modBody.scrollLeft = origBody.scrollLeft;
    } else {
        origBody.scrollTop = modBody.scrollTop;
        origBody.scrollLeft = modBody.scrollLeft;
    }

    requestAnimationFrame(() => {
        isSyncingScroll = false;
    });
}

/**
 * 원본과 수정본 텍스트 맞바꾸기
 */
function swapDiffTexts() {
    const origEl = document.getElementById('diff-orig-text');
    const modEl = document.getElementById('diff-mod-text');
    if (!origEl || !modEl) return;

    const temp = origEl.value;
    origEl.value = modEl.value;
    modEl.value = temp;

    updateDiffInputCounts();
    if (origEl.value || modEl.value) {
        runDiffComparison();
    }
}

/**
 * 내장 예시 코드/텍스트 샘플 로드
 */
async function loadDiffSample() {
    try {
        if (!window.eel || typeof window.eel.get_diff_sample_texts !== 'function') return;

        const res = await window.eel.get_diff_sample_texts()();
        if (res.status === 'success') {
            const origEl = document.getElementById('diff-orig-text');
            const modEl = document.getElementById('diff-mod-text');
            if (origEl) origEl.value = res.orig_text;
            if (modEl) modEl.value = res.mod_text;

            updateDiffInputCounts();
            await runDiffComparison();

            if (typeof showToast === 'function') {
                showToast('샘플 코드 로드', '테스트용 샘플 코드가 입력되었습니다.', 'info');
            }
        }
    } catch (e) {
        console.error('Failed to load sample:', e);
    }
}

/**
 * 표준 Git Unified Diff 패치 클립보드 복사
 */
async function copyUnifiedDiff() {
    if (!diffState.lastResult || !diffState.lastResult.unified_patch) {
        if (typeof showToast === 'function') {
            showToast('복사할 Diff 없음', '먼저 [차이점 비교 실행]을 수행해주세요.', 'warning');
        }
        return;
    }

    try {
        await navigator.clipboard.writeText(diffState.lastResult.unified_patch);
        if (typeof showToast === 'function') {
            showToast('Diff 복사 완료', 'Git 표준 패치 내용이 클립보드에 복사되었습니다.', 'success');
        }
    } catch (err) {
        console.error('Clipboard copy failed:', err);
        if (typeof showToast === 'function') {
            showToast('복사 실패', '클립보드 접근 권한을 확인해주세요.', 'error');
        }
    }
}

/**
 * 특정 입력창 비우기
 */
function clearDiffPane(side) {
    const id = side === 'orig' ? 'diff-orig-text' : 'diff-mod-text';
    const el = document.getElementById(id);
    if (el) {
        el.value = '';
        updateDiffInputCounts();
    }
}

/**
 * 전체 입력 및 결과 초기화
 */
function clearDiffAll() {
    const origEl = document.getElementById('diff-orig-text');
    const modEl = document.getElementById('diff-mod-text');
    if (origEl) origEl.value = '';
    if (modEl) modEl.value = '';
    updateDiffInputCounts();

    diffState.lastResult = null;

    const stateBadge = document.getElementById('diff-status-state');
    if (stateBadge) {
        stateBadge.className = 'diff-badge badge-neutral';
        stateBadge.textContent = '대기 중';
    }

    const statAdd = document.getElementById('diff-stat-add');
    const statDel = document.getElementById('diff-stat-del');
    const statMod = document.getElementById('diff-stat-mod');
    const statUnc = document.getElementById('diff-stat-unc');
    const timeBadge = document.getElementById('diff-time-badge');

    if (statAdd) statAdd.textContent = '➕ 0 추가';
    if (statDel) statDel.textContent = '➖ 0 삭제';
    if (statMod) statMod.textContent = '✏️ 0 수정';
    if (statUnc) statUnc.textContent = '⚖️ 0 동일';
    if (timeBadge) timeBadge.textContent = '⏱️ 0.0ms';

    const placeholder = '<div class="diff-empty-placeholder">비교할 텍스트를 입력하고 [차이점 비교 실행] 버튼을 클릭하세요.</div>';
    const origBody = document.getElementById('diff-split-orig-body');
    const modBody = document.getElementById('diff-split-mod-body');
    const unifiedBody = document.getElementById('diff-unified-body');

    if (origBody) origBody.innerHTML = placeholder;
    if (modBody) modBody.innerHTML = placeholder;
    if (unifiedBody) unifiedBody.innerHTML = placeholder;
}

/**
 * 로컬 파일 선택 다이얼로그 열기 및 텍스트 로드
 */
async function openDiffFileDialog(side) {
    try {
        if (!window.eel || typeof window.eel.select_and_read_diff_file !== 'function') return;

        const res = await window.eel.select_and_read_diff_file(side)();
        if (res.status === 'success') {
            const targetId = side === 'orig' ? 'diff-orig-text' : 'diff-mod-text';
            const targetEl = document.getElementById(targetId);
            if (targetEl) {
                targetEl.value = res.content;
                updateDiffInputCounts();
                if (typeof showToast === 'function') {
                    showToast('파일 열기 성공', `${res.filename} (${res.encoding}) 로드 완료`, 'success');
                }
            }
        }
    } catch (e) {
        console.error('File dialog error:', e);
        if (typeof showToast === 'function') {
            showToast('파일 열기 실패', String(e), 'error');
        }
    }
}

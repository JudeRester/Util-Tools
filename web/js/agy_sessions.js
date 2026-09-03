/**
 * Antigravity CLI (agy) 세션 목록화 및 대화형 터미널 런처 연동 모듈 (테이블 뷰)
 */

const agyState = {
    enabled: false,
    detected: false,
    cliPath: '',
    currentFilter: 'current', // 'current' | 'all'
    searchKeyword: '',
    sessions: [],
    loading: false
};

/**
 * agy 연동 설정 및 환경 상태 초기화
 */
async function initAgyIntegration() {
    try {
        // 1. 앱 설정에서 사용 여부 로드
        if (window.eel && eel.get_app_settings) {
            const settingsRes = await eel.get_app_settings()();
            if (settingsRes && settingsRes.status === 'success' && settingsRes.data) {
                agyState.enabled = Boolean(settingsRes.data.enable_agy_integration);
            }
        }

        // 2. agy-cli 로컬 환경 감지 상태 확인
        if (window.eel && eel.get_agy_environment_status) {
            const envRes = await eel.get_agy_environment_status()();
            if (envRes && envRes.status === 'success') {
                agyState.detected = Boolean(envRes.detected);
                agyState.cliPath = envRes.cli_path || '';
            }
        }

        // 3. 시스템 탭 설정 UI 반영
        const toggleEl = document.getElementById('agy-enable-toggle');
        const labelEl = document.getElementById('agy-toggle-label');
        const badgeEl = document.getElementById('agy-env-badge');
        const sectionEl = document.getElementById('agy-launch-section');

        if (toggleEl) toggleEl.checked = agyState.enabled;
        if (labelEl) {
            labelEl.textContent = agyState.enabled ? '활성화됨' : '비활성화됨';
            labelEl.classList.toggle('active', agyState.enabled);
        }
        if (badgeEl) {
            if (agyState.detected) {
                badgeEl.style.display = 'inline-flex';
                badgeEl.title = agyState.cliPath ? `CLI 경로: ${agyState.cliPath}` : '로컬 agy 환경이 감지되었습니다.';
            } else {
                badgeEl.style.display = 'none';
            }
        }

        // 4. 빠른 실행 탭 내 섹션 표시 여부
        if (sectionEl) {
            sectionEl.style.display = agyState.enabled ? 'block' : 'none';
        }

        // 5. 활성화되어 있는 경우 세션 목록 즉시 로드
        if (agyState.enabled) {
            loadAgySessions();
        }
    } catch (e) {
        console.error('[agy_sessions] 초기화 실패:', e);
    }
}

/**
 * 시스템 탭에서 토글 스위치 변경 시 호출
 */
async function onToggleAgyIntegration(isChecked) {
    agyState.enabled = isChecked;

    const labelEl = document.getElementById('agy-toggle-label');
    const sectionEl = document.getElementById('agy-launch-section');

    if (labelEl) {
        labelEl.textContent = isChecked ? '활성화됨' : '비활성화됨';
        labelEl.classList.toggle('active', isChecked);
    }

    if (sectionEl) {
        sectionEl.style.display = isChecked ? 'block' : 'none';
    }

    // 설정 영구 저장
    if (window.eel && eel.save_app_settings) {
        try {
            await eel.save_app_settings({ enable_agy_integration: isChecked })();
        } catch (e) {
            console.error('[agy_sessions] 설정 저장 오류:', e);
        }
    }

    if (typeof showToast === 'function') {
        showToast(
            isChecked ? 'Antigravity CLI 연동이 활성화되었습니다.' : 'Antigravity CLI 연동이 비활성화되었습니다.',
            isChecked ? 'success' : 'info'
        );
    }

    if (isChecked) {
        loadAgySessions();
    }
}

/**
 * agy 세션 목록 불러오기
 */
async function loadAgySessions() {
    if (!agyState.enabled) return;

    const tbodyEl = document.getElementById('agy-sessions-tbody');
    if (!tbodyEl) return;

    agyState.loading = true;
    tbodyEl.innerHTML = `
        <tr>
            <td colspan="6" style="padding: 28px; text-align: center; color: var(--text-secondary);">
                <span class="spinner" style="display: inline-block; margin-right: 8px;">🔄</span> agy 세션 목록을 조회하는 중...
            </td>
        </tr>
    `;

    try {
        if (window.eel && eel.get_agy_sessions) {
            const res = await eel.get_agy_sessions(30, agyState.currentFilter)();
            if (res && res.status === 'success' && Array.isArray(res.sessions)) {
                agyState.sessions = res.sessions;
            } else {
                agyState.sessions = [];
            }
        }
    } catch (e) {
        console.error('[agy_sessions] 세션 로드 오류:', e);
        agyState.sessions = [];
    } finally {
        agyState.loading = false;
        renderAgySessionsUI();
    }
}

/**
 * 실시간 검색 입력 핸들러
 */
function onAgySearchInput(keyword) {
    agyState.searchKeyword = (keyword || '').trim().toLowerCase();
    renderAgySessionsUI();
}

/**
 * 세션 필터(현재 프로젝트 vs 전체 세션) 전환
 */
function filterAgySessions(filterType) {
    if (agyState.currentFilter === filterType) return;
    agyState.currentFilter = filterType;

    const currentBtn = document.getElementById('agy-filter-current-btn');
    const allBtn = document.getElementById('agy-filter-all-btn');

    if (currentBtn) currentBtn.classList.toggle('active', filterType === 'current');
    if (allBtn) allBtn.classList.toggle('active', filterType === 'all');

    loadAgySessions();
}

/**
 * 새로고침 버튼
 */
function refreshAgySessions() {
    loadAgySessions();
    if (typeof showToast === 'function') {
        showToast('agy 세션 목록을 새로고침했습니다.', 'info');
    }
}

/**
 * 세션 목록 테이블 렌더링
 */
function renderAgySessionsUI() {
    const tbodyEl = document.getElementById('agy-sessions-tbody');
    const countBadgeEl = document.getElementById('agy-session-count-badge');
    if (!tbodyEl) return;

    // 검색 필터 적용
    const filtered = agyState.sessions.filter(s => {
        if (!agyState.searchKeyword) return true;
        const kw = agyState.searchKeyword;
        const title = (s.title || '').toLowerCase();
        const path = (s.primary_workspace || '').toLowerCase();
        const id = (s.conversation_id || '').toLowerCase();
        return title.includes(kw) || path.includes(kw) || id.includes(kw);
    });

    if (countBadgeEl) {
        countBadgeEl.textContent = `${filtered.length}개`;
    }

    if (filtered.length === 0) {
        const filterText = agyState.currentFilter === 'current' ? '현재 프로젝트' : '전체';
        tbodyEl.innerHTML = `
            <tr>
                <td colspan="6" style="padding: 36px 16px; text-align: center; color: var(--text-secondary);">
                    <div style="font-size: 1.8rem; margin-bottom: 8px;">🤖</div>
                    <div style="font-weight: 600; margin-bottom: 4px; color: var(--text-primary);">
                        ${agyState.searchKeyword ? '검색된 세션이 없습니다.' : `조회된 ${filterText} agy 세션이 없습니다.`}
                    </div>
                    <div style="font-size: 0.8rem; color: var(--text-muted);">
                        ${agyState.searchKeyword ? '검색어를 변경하거나 지워보세요.' : (agyState.currentFilter === 'current' ? '상단의 <b>[🌐 전체 세션]</b>을 선택하여 다른 프로젝트의 세션을 확인해 보세요.' : '터미널에서 <code>agy</code> 명령어로 새 세션을 시작할 수 있습니다.')}
                    </div>
                </td>
            </tr>
        `;
        return;
    }

    tbodyEl.innerHTML = filtered.map(s => {
        const title = escapeHtml(s.title || 'Untitled Session');
        const fullId = s.conversation_id || '';
        const shortId = fullId.length >= 8 ? fullId.slice(0, 8) : fullId;
        const workspacePath = s.primary_workspace || '';
        const safeWorkspacePath = escapeHtml(workspacePath);
        const baseName = escapeHtml(getBaseName(workspacePath) || '루트');
        const lastModified = s.last_modified || '';
        const stepCount = s.step_count || 0;
        const isCurrent = Boolean(s.is_current);

        return `
            <tr class="agy-table-row">
                <td class="agy-cell-title" title="${title}">
                    <div class="agy-title-wrapper">
                        <span class="agy-row-icon">🤖</span>
                        <span class="agy-title-text">${title}</span>
                    </div>
                </td>
                <td class="agy-cell-project">
                    <div class="agy-project-wrapper">
                        <span class="agy-project-badge ${isCurrent ? 'current' : ''}" title="${safeWorkspacePath}">
                            ${isCurrent ? '📍' : '📁'} ${baseName}
                        </span>
                        <div class="agy-path-subtext" title="${safeWorkspacePath}">${safeWorkspacePath}</div>
                    </div>
                </td>
                <td class="agy-cell-id">
                    <button class="agy-copy-id-btn" onclick="copySessionId('${fullId}', event)" title="클릭하여 전체 세션 UUID 복사">
                        <code>#${shortId}</code> <span class="copy-icon">📋</span>
                    </button>
                </td>
                <td class="agy-cell-step" style="text-align: center;">
                    <span class="agy-step-badge">${stepCount} 스텝</span>
                </td>
                <td class="agy-cell-time" style="text-align: center;">
                    <span class="agy-time-text">${lastModified}</span>
                </td>
                <td class="agy-cell-action" style="text-align: center;">
                    <button class="compact-btn powershell agy-run-btn" onclick="launchAgyTerminal('${fullId}', '${encodeURIComponent(workspacePath)}')" title="이 작업 디렉토리에서 터미널 열기">
                        <span>⚡</span> 실행
                    </button>
                </td>
            </tr>
        `;
    }).join('');
}

/**
 * 세션 UUID 클립보드 복사
 */
async function copySessionId(id, event) {
    if (event) event.stopPropagation();
    if (!id) return;

    try {
        await navigator.clipboard.writeText(id);
        if (typeof showToast === 'function') {
            showToast(`세션 ID가 복사되었습니다: #${id.slice(0, 8)}`, 'success');
        }
    } catch (e) {
        console.error('클립보드 복사 실패:', e);
    }
}

/**
 * 경로에서 마지막 디렉토리 명칭 추출
 */
function getBaseName(pathStr) {
    if (!pathStr) return '';
    const parts = pathStr.replace(/\\/g, '/').split('/').filter(Boolean);
    return parts.length > 0 ? parts[parts.length - 1] : pathStr;
}

/**
 * 세션 터미널 실행
 */
async function launchAgyTerminal(conversationId, encodedWorkspacePath) {
    if (!conversationId) return;
    const workspacePath = decodeURIComponent(encodedWorkspacePath || '');

    try {
        if (window.eel && eel.launch_agy_session) {
            const res = await eel.launch_agy_session(conversationId, workspacePath)();
            if (res && res.status === 'success') {
                if (typeof showToast === 'function') {
                    showToast(res.message || 'Antigravity CLI 터미널을 실행했습니다.', 'success');
                }
                if (typeof logToConsole === 'function') {
                    logToConsole('Antigravity CLI 실행', res.message);
                }
            } else {
                if (typeof showToast === 'function') {
                    showToast(res ? res.message : '터미널 실행 실패', 'error');
                }
            }
        }
    } catch (e) {
        console.error('[agy_sessions] 세션 실행 오류:', e);
        if (typeof showToast === 'function') {
            showToast('터미널 실행 중 오류가 발생했습니다.', 'error');
        }
    }
}

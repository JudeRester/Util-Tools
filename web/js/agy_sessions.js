/**
 * Antigravity CLI (agy) 세션 목록화 및 대화형 터미널 런처 연동 모듈
 */

const agyState = {
    enabled: false,
    detected: false,
    cliPath: '',
    currentFilter: 'current', // 'current' | 'all'
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
            labelEl.style.color = agyState.enabled ? 'var(--accent-color)' : 'var(--text-secondary)';
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
        labelEl.style.color = isChecked ? 'var(--accent-color)' : 'var(--text-secondary)';
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

    const gridEl = document.getElementById('agy-sessions-grid');
    if (!gridEl) return;

    agyState.loading = true;
    gridEl.innerHTML = `
        <div style="grid-column: 1 / -1; padding: 24px; text-align: center; color: var(--text-secondary);">
            <span class="spinner" style="display: inline-block; margin-right: 8px;">🔄</span> agy 세션 목록을 조회하는 중...
        </div>
    `;

    try {
        if (window.eel && eel.get_agy_sessions) {
            const res = await eel.get_agy_sessions(24, agyState.currentFilter)();
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
 * 세션 목록 카드 렌더링
 */
function renderAgySessionsUI() {
    const gridEl = document.getElementById('agy-sessions-grid');
    if (!gridEl) return;

    if (agyState.sessions.length === 0) {
        const filterText = agyState.currentFilter === 'current' ? '현재 프로젝트' : '전체';
        gridEl.innerHTML = `
            <div style="grid-column: 1 / -1; padding: 28px; text-align: center; color: var(--text-secondary); background: rgba(255,255,255,0.02); border-radius: var(--radius-md); border: 1px dashed var(--border-color);">
                <div style="font-size: 1.6rem; margin-bottom: 8px;">🤖</div>
                <div style="font-weight: 500; margin-bottom: 4px;">조회된 ${filterText} agy 세션이 없습니다.</div>
                <div style="font-size: 0.8rem; color: var(--text-muted);">
                    ${agyState.currentFilter === 'current' ? '상단의 <b>[전체 세션]</b> 필터를 클릭하여 다른 프로젝트의 세션을 확인해 보세요.' : '터미널에서 <code>agy</code>를 실행하여 새 세션을 시작할 수 있습니다.'}
                </div>
            </div>
        `;
        return;
    }

    gridEl.innerHTML = agyState.sessions.map(s => {
        const title = escapeHtml(s.title || 'Untitled Session');
        const shortId = s.conversation_id ? s.conversation_id.slice(0, 8) : '';
        const workspacePath = s.primary_workspace || '';
        const safeWorkspacePath = escapeHtml(workspacePath);
        const lastModified = s.last_modified || '';
        const stepCount = s.step_count || 0;

        return `
            <div class="tool-btn agy-session-card" onclick="launchAgyTerminal('${s.conversation_id}', '${encodeURIComponent(workspacePath)}')">
                <div class="btn-icon">🤖</div>
                <div class="btn-text" style="width: 100%;">
                    <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 4px;">
                        <h3 style="margin: 0; font-size: 0.92rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${title}">${title}</h3>
                        <span class="agy-step-badge" title="총 진행된 대화 스텝 수">${stepCount} 스텝</span>
                    </div>
                    <div class="agy-meta-row" style="display: flex; align-items: center; justify-content: space-between; font-size: 0.74rem; color: var(--text-secondary); gap: 6px;">
                        <span class="agy-workspace-label" title="${safeWorkspacePath}" style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 60%;">
                            📁 ${safeWorkspacePath ? getBaseName(workspacePath) : '루트'}
                        </span>
                        <span class="agy-time-label" style="white-space: nowrap;">🕒 ${lastModified}</span>
                    </div>
                    <div style="margin-top: 8px; display: flex; align-items: center; justify-content: space-between;">
                        <span style="font-size: 0.7rem; color: var(--text-muted); font-family: monospace;">#${shortId}</span>
                        <span class="compact-btn" style="padding: 2px 8px; font-size: 0.72rem; pointer-events: none;">
                            ⚡ 터미널 열기
                        </span>
                    </div>
                </div>
            </div>
        `;
    }).join('');
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

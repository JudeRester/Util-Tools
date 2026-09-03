/**
 * Antigravity CLI (agy) 세션 목록화 및 대화형 터미널 런처 연동 모듈 (테이블 뷰 & 실시간 알림 감시 & 프로젝트 멀티 드롭다운)
 */

const agyState = {
    enabled: false,
    detected: false,
    cliPath: '',
    selectedWorkspaces: new Set(), // 체크된 프로젝트 워크스페이스 Set (비어있으면 전체)
    searchKeyword: '',
    sessions: [],
    watchedSessions: new Set(),
    loading: false,
    dropdownOpen: false
};

// Eel 백엔드 알림 리스너 노출 등록
if (window.eel) {
    eel.expose(on_agy_session_completed);
}

// 드롭다운 외부 클릭 시 자동 닫기 리스너 등록
document.addEventListener('click', (e) => {
    const container = document.getElementById('agy-project-dropdown-container');
    if (container && !container.contains(e.target)) {
        closeAgyProjectDropdown();
    }
});

// ESC 키 입력 시 드롭다운 닫기
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && agyState.dropdownOpen) {
        closeAgyProjectDropdown();
    }
});

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

        // 5. 활성화되어 있는 경우 세션 목록 및 감시 목록 즉시 로드
        if (agyState.enabled) {
            await loadWatchedSessions();
            await loadAgySessions();
        }
    } catch (e) {
        console.error('[agy_sessions] 초기화 실패:', e);
    }
}

/**
 * 시스템 탭에서 토글 스위치 변경 시 호출 (Strict Gated)
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

    if (!isChecked) {
        agyState.watchedSessions.clear();
    }

    // 백엔드 스레드 생명주기 즉시 동기화
    if (window.eel && eel.on_agy_toggle_changed) {
        try {
            await eel.on_agy_toggle_changed(isChecked)();
        } catch (e) {
            console.error('[agy_sessions] 백엔드 토글 동기화 오류:', e);
        }
    }

    // 설정 파일 영구 저장
    if (window.eel && eel.save_app_settings) {
        try {
            await eel.save_app_settings({ enable_agy_integration: isChecked })();
        } catch (e) {
            console.error('[agy_sessions] 설정 저장 오류:', e);
        }
    }

    if (typeof showToast === 'function') {
        showToast(
            isChecked ? 'Antigravity CLI 연동이 활성화되었습니다.' : 'Antigravity CLI 연동이 비활성화되었습니다. (모든 감시 중단)',
            isChecked ? 'success' : 'info'
        );
    }

    if (isChecked) {
        await loadWatchedSessions();
        await loadAgySessions();
    }
}

/**
 * 백엔드에서 현재 감시 중인 세션 목록 조회
 */
async function loadWatchedSessions() {
    if (!agyState.enabled) return;
    try {
        if (window.eel && eel.get_watched_agy_sessions) {
            const list = await eel.get_watched_agy_sessions()();
            if (Array.isArray(list)) {
                agyState.watchedSessions = new Set(list);
            }
        }
    } catch (e) {
        console.error('[agy_sessions] 감시 목록 로드 오류:', e);
    }
}

/**
 * agy 세션 목록 불러오기 (전체 세션을 1회 로드 후 클라이언트 사이드 멀티 필터링)
 */
async function loadAgySessions() {
    if (!agyState.enabled) return;

    const tbodyEl = document.getElementById('agy-sessions-tbody');
    if (!tbodyEl) return;

    agyState.loading = true;
    tbodyEl.innerHTML = `
        <tr>
            <td colspan="7" style="padding: 28px; text-align: center; color: var(--text-secondary);">
                <span class="spinner" style="display: inline-block; margin-right: 8px;">🔄</span> agy 세션 목록을 조회하는 중...
            </td>
        </tr>
    `;

    try {
        if (window.eel && eel.get_agy_sessions) {
            const res = await eel.get_agy_sessions(100, 'all')();
            if (res && res.status === 'success' && Array.isArray(res.sessions)) {
                agyState.sessions = res.sessions;
                // 최초 1회 로드 시 모든 프로젝트를 기본 선택 상태로 초기화
                if (agyState.selectedWorkspaces.size === 0) {
                    const uniqueWorkspaces = new Set(res.sessions.map(s => s.primary_workspace || '기타'));
                    agyState.selectedWorkspaces = uniqueWorkspaces;
                }
            } else {
                agyState.sessions = [];
            }
        }
    } catch (e) {
        console.error('[agy_sessions] 세션 로드 오류:', e);
        agyState.sessions = [];
    } finally {
        agyState.loading = false;
        buildProjectDropdownUI();
        renderAgySessionsUI();
    }
}

/**
 * 프로젝트 드롭다운 메뉴 토글
 */
function toggleAgyProjectDropdown(event) {
    if (event) event.stopPropagation();
    agyState.dropdownOpen = !agyState.dropdownOpen;
    const menuEl = document.getElementById('agy-project-dropdown-menu');
    if (menuEl) {
        menuEl.style.display = agyState.dropdownOpen ? 'block' : 'none';
    }
}

/**
 * 프로젝트 드롭다운 메뉴 닫기
 */
function closeAgyProjectDropdown() {
    agyState.dropdownOpen = false;
    const menuEl = document.getElementById('agy-project-dropdown-menu');
    if (menuEl) {
        menuEl.style.display = 'none';
    }
}

/**
 * 프로젝트 체크박스 리스트 동적 구성
 */
function buildProjectDropdownUI() {
    const listEl = document.getElementById('agy-project-checkbox-list');
    if (!listEl) return;

    // 세션들로부터 고유 워크스페이스 및 카운트 집계
    const counts = {};
    agyState.sessions.forEach(s => {
        const ws = s.primary_workspace || '기타';
        counts[ws] = (counts[ws] || 0) + 1;
    });

    const workspaces = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);

    if (workspaces.length === 0) {
        listEl.innerHTML = '<div style="padding: 8px; text-align: center; color: var(--text-muted); font-size: 0.75rem;">등록된 프로젝트가 없습니다.</div>';
        updateDropdownButtonLabel();
        return;
    }

    listEl.innerHTML = workspaces.map(ws => {
        const isChecked = agyState.selectedWorkspaces.has(ws);
        const baseName = escapeHtml(getBaseName(ws) || '루트');
        const safeWs = escapeHtml(ws);
        const count = counts[ws] || 0;

        return `
            <label class="agy-project-checkbox-item">
                <input type="checkbox" ${isChecked ? 'checked' : ''} onchange="onToggleProjectFilter('${safeWs}', this.checked)">
                <div class="agy-project-item-info">
                    <div class="agy-project-item-name" title="${safeWs}">${baseName}</div>
                    <div class="agy-project-item-path" title="${safeWs}">${safeWs}</div>
                </div>
                <span class="agy-project-item-count">${count}</span>
            </label>
        `;
    }).join('');

    updateDropdownButtonLabel();
}

/**
 * 프로젝트 체크박스 개별 토글
 */
function onToggleProjectFilter(workspacePath, isChecked) {
    if (isChecked) {
        agyState.selectedWorkspaces.add(workspacePath);
    } else {
        agyState.selectedWorkspaces.delete(workspacePath);
    }
    updateDropdownButtonLabel();
    renderAgySessionsUI();
}

/**
 * 프로젝트 전체 선택 / 선택 해제
 */
function selectAllAgyProjects(selectAll, event) {
    if (event) event.stopPropagation();

    const uniqueWorkspaces = new Set(agyState.sessions.map(s => s.primary_workspace || '기타'));
    if (selectAll) {
        agyState.selectedWorkspaces = uniqueWorkspaces;
    } else {
        agyState.selectedWorkspaces.clear();
    }

    // 체크박스 UI 상태 갱신
    const listEl = document.getElementById('agy-project-checkbox-list');
    if (listEl) {
        const checkboxes = listEl.querySelectorAll('input[type="checkbox"]');
        checkboxes.forEach(cb => cb.checked = selectAll);
    }

    updateDropdownButtonLabel();
    renderAgySessionsUI();
}

/**
 * 드롭다운 버튼 라벨 업데이트
 */
function updateDropdownButtonLabel() {
    const labelEl = document.getElementById('agy-dropdown-label');
    if (!labelEl) return;

    const allWorkspaces = Array.from(new Set(agyState.sessions.map(s => s.primary_workspace || '기타')));
    const totalCount = allWorkspaces.length;
    const selectedCount = agyState.selectedWorkspaces.size;

    if (totalCount === 0 || selectedCount === totalCount) {
        labelEl.textContent = `프로젝트 (전체 ${totalCount}개)`;
    } else if (selectedCount === 0) {
        labelEl.textContent = '프로젝트 선택 (0개)';
    } else if (selectedCount === 1) {
        const onlyWs = Array.from(agyState.selectedWorkspaces)[0];
        const baseName = getBaseName(onlyWs);
        labelEl.textContent = `📁 ${baseName}`;
    } else {
        const firstWs = Array.from(agyState.selectedWorkspaces)[0];
        const firstBaseName = getBaseName(firstWs);
        labelEl.textContent = `📁 ${firstBaseName} 외 ${selectedCount - 1}개`;
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
 * 새로고침 버튼
 */
function refreshAgySessions() {
    loadWatchedSessions();
    loadAgySessions();
    if (typeof showToast === 'function') {
        showToast('agy 세션 목록을 새로고침했습니다.', 'info');
    }
}

/**
 * 세션 알림 구독 토글 (🔔 Watchlist)
 */
async function toggleAgySessionWatch(conversationId, event) {
    if (event) event.stopPropagation();
    if (!conversationId) return;

    const isCurrentlyWatched = agyState.watchedSessions.has(conversationId);
    const nextState = !isCurrentlyWatched;

    try {
        if (window.eel && eel.toggle_agy_watch_session) {
            const res = await eel.toggle_agy_watch_session(conversationId, nextState)();
            if (res && res.status === 'success') {
                if (nextState) {
                    agyState.watchedSessions.add(conversationId);
                } else {
                    agyState.watchedSessions.delete(conversationId);
                }
                renderAgySessionsUI();

                if (typeof showToast === 'function') {
                    showToast(
                        nextState ? `🔔 알림 감시 시작: #${conversationId.slice(0, 8)}` : `🔕 알림 감시 해제: #${conversationId.slice(0, 8)}`,
                        nextState ? '작업이 완료되면 Windows 트레이 알림 및 알림음으로 알려드립니다.' : '감시가 해제되었습니다.',
                        nextState ? '🔔' : '🔕',
                        4000
                    );
                }
            } else {
                if (typeof showToast === 'function') {
                    showToast(res ? res.message : '알림 설정 변경 실패', 'error');
                }
            }
        }
    } catch (e) {
        console.error('[agy_sessions] 알림 구독 오류:', e);
    }
}

/**
 * 백엔드에서 세션 응답 완료 시 푸시되는 실시간 이벤트 콜백 (Eel exposed)
 */
function on_agy_session_completed(sessionInfo) {
    if (!agyState.enabled || !sessionInfo) return;

    const convId = sessionInfo.conversation_id || '';
    const title = sessionInfo.title || '세션';
    const shortId = convId.length >= 8 ? convId.slice(0, 8) : convId;
    const stepCount = sessionInfo.step_count || 0;

    // 감시 목록에서 자동 제거
    agyState.watchedSessions.delete(convId);
    renderAgySessionsUI();

    // 1. 소리 알림 (Web Audio API 기반 딩동 사운드)
    playAgyNotificationSound();

    // 2. 앱 내 토스트 알림 팝업
    if (typeof showToast === 'function') {
        showToast(
            `🔔 agy 작업 완료 (#${shortId})`,
            `[${title}] 에이전트 응답이 완료되었습니다. (스텝 ${stepCount})`,
            '🤖',
            7000
        );
    }

    if (typeof logToConsole === 'function') {
        logToConsole('Antigravity CLI 작업 완료', `세션 #${shortId}: [${title}] 완료 (스텝 ${stepCount})`);
    }
}

/**
 * Web Audio API를 활용한 알림 사운드 재생 (0 외부 사운드 파일 의존)
 */
function playAgyNotificationSound() {
    try {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (!AudioContext) return;

        const ctx = new AudioContext();
        const now = ctx.currentTime;

        // 1음 (523Hz - C5)
        const osc1 = ctx.createOscillator();
        const gain1 = ctx.createGain();
        osc1.type = 'sine';
        osc1.frequency.setValueAtTime(523.25, now);
        gain1.gain.setValueAtTime(0.15, now);
        gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
        osc1.connect(gain1);
        gain1.connect(ctx.destination);
        osc1.start(now);
        osc1.stop(now + 0.18);

        // 2음 (659Hz - E5)
        const osc2 = ctx.createOscillator();
        const gain2 = ctx.createGain();
        osc2.type = 'sine';
        osc2.frequency.setValueAtTime(659.25, now + 0.12);
        gain2.gain.setValueAtTime(0.2, now + 0.12);
        gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
        osc2.connect(gain2);
        gain2.connect(ctx.destination);
        osc2.start(now + 0.12);
        osc2.stop(now + 0.35);
    } catch (e) {
        // 오디오 정책 또는 미지원 시 무시
    }
}

/**
 * 세션 목록 테이블 렌더링
 */
function renderAgySessionsUI() {
    const tbodyEl = document.getElementById('agy-sessions-tbody');
    const countBadgeEl = document.getElementById('agy-session-count-badge');
    if (!tbodyEl) return;

    // 1. 프로젝트 멀티 체크박스 필터 & 검색 필터 적용
    const filtered = agyState.sessions.filter(s => {
        // 워크스페이스 체크박스 필터
        const ws = s.primary_workspace || '기타';
        if (agyState.selectedWorkspaces.size > 0 && !agyState.selectedWorkspaces.has(ws)) {
            return false;
        }

        // 검색어 필터
        if (agyState.searchKeyword) {
            const kw = agyState.searchKeyword;
            const title = (s.title || '').toLowerCase();
            const path = (s.primary_workspace || '').toLowerCase();
            const id = (s.conversation_id || '').toLowerCase();
            return title.includes(kw) || path.includes(kw) || id.includes(kw);
        }
        return true;
    });

    if (countBadgeEl) {
        countBadgeEl.textContent = `${filtered.length}개`;
    }

    if (filtered.length === 0) {
        tbodyEl.innerHTML = `
            <tr>
                <td colspan="7" style="padding: 36px 16px; text-align: center; color: var(--text-secondary);">
                    <div style="font-size: 1.8rem; margin-bottom: 8px;">🤖</div>
                    <div style="font-weight: 600; margin-bottom: 4px; color: var(--text-primary);">
                        ${agyState.searchKeyword ? '검색된 세션이 없습니다.' : '선택된 프로젝트에 해당하는 세션이 없습니다.'}
                    </div>
                    <div style="font-size: 0.8rem; color: var(--text-muted);">
                        ${agyState.searchKeyword ? '검색어를 변경하거나 지워보세요.' : '상단의 프로젝트 드롭다운에서 다른 프로젝트를 선택해 보세요.'}
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
        const isWatched = agyState.watchedSessions.has(fullId);

        return `
            <tr class="agy-table-row ${isWatched ? 'row-watched' : ''}">
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
                <td class="agy-cell-notify" style="text-align: center;">
                    <button class="agy-notify-btn ${isWatched ? 'active' : ''}" onclick="toggleAgySessionWatch('${fullId}', event)" title="${isWatched ? '알림 감시 중 (클릭하여 해제)' : '작업 완료 알림 받기'}">
                        ${isWatched ? '🔔' : '🔕'}
                    </button>
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

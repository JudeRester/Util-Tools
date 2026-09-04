/**
 * Antigravity CLI (agy) 세션 목록화 및 대화형 터미널 런처 연동 모듈
 * (테이블 뷰 & 1회성/지속 알림 감시 & 프로젝트 멀티 드롭다운)
 */

const agyState = {
    enabled: false,
    detected: false,
    cliPath: '',
    sourceFilter: 'all', // 'all' | 'agy' | 'ocx'
    selectedWorkspaces: new Set(), // 체크된 프로젝트 워크스페이스 Set
    filterInitialized: false,
    searchKeyword: '',
    sessions: [],
    watchedSessions: new Map(), // Map<conversationId, 'once' | 'persistent'>
    loading: false,
    dropdownOpen: false
};

// Eel 백엔드 알림 리스너 노출 등록
if (window.eel) {
    eel.expose(on_agy_session_completed);
    eel.expose(on_agy_permission_requested);
}

// 외부 클릭 시 드롭다운 및 팝오버 메뉴 자동 닫기 리스너
document.addEventListener('click', (e) => {
    // 1. 프로젝트 드롭다운 닫기
    const projectContainer = document.getElementById('agy-project-dropdown-container');
    if (projectContainer && !projectContainer.contains(e.target)) {
        closeAgyProjectDropdown();
    }

    // 2. 알림 모드 팝오버 닫기
    const popover = document.getElementById('agy-notify-popover');
    if (popover && !popover.contains(e.target) && !e.target.closest('.agy-notify-btn')) {
        closeAgyNotifyMenu();
    }
});

// ESC 키 입력 시 메뉴 닫기
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        if (agyState.dropdownOpen) closeAgyProjectDropdown();
        closeAgyNotifyMenu();
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

        // 2. agy-cli 및 OpenCodex 로컬 환경 감지 상태 확인
        if (window.eel && eel.get_agy_environment_status) {
            const envRes = await eel.get_agy_environment_status()();
            if (envRes && envRes.status === 'success') {
                agyState.detected = Boolean(envRes.detected);
                agyState.cliPath = envRes.cli_path || '';
                agyState.ocxInstalled = Boolean(envRes.ocx_installed);

                const ocxBadgeEl = document.getElementById('ocx-env-badge');
                if (ocxBadgeEl) {
                    ocxBadgeEl.style.display = envRes.ocx_installed ? 'inline-flex' : 'none';
                    if (envRes.ocx_installed) {
                        ocxBadgeEl.title = '로컬 OpenCodex (.codex) 환경이 감지되었습니다.';
                    }
                }
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
 * 백엔드에서 현재 감시 중인 세션 목록 및 모드 조회
 */
async function loadWatchedSessions() {
    if (!agyState.enabled) return;
    try {
        if (window.eel && eel.get_watched_agy_sessions) {
            const mapData = await eel.get_watched_agy_sessions()();
            if (mapData && typeof mapData === 'object') {
                agyState.watchedSessions = new Map(Object.entries(mapData));
            } else if (Array.isArray(mapData)) {
                // 이전 버전 호환 (배열인 경우 once 모드로 간주)
                agyState.watchedSessions = new Map(mapData.map(id => [id, 'once']));
            }
        }
    } catch (e) {
        console.error('[agy_sessions] 감시 목록 로드 오류:', e);
    }
}

/**
 * 소스 엔진 필터 선택 ('all' | 'agy' | 'ocx')
 */
function setAiSourceFilter(source) {
    agyState.sourceFilter = source;
    document.querySelectorAll('.ai-source-chip').forEach(el => {
        el.classList.toggle('active', el.id === `ai-chip-${source}`);
    });
    loadAgySessions();
}

/**
 * AI 세션 목록 불러오기 (전체 세션을 로드 후 클라이언트 사이드 멀티 필터링)
 */
async function loadAgySessions() {
    if (!agyState.enabled) return;

    const tbodyEl = document.getElementById('agy-sessions-tbody');
    if (!tbodyEl) return;

    agyState.loading = true;
    tbodyEl.innerHTML = `
        <tr>
            <td colspan="7" style="padding: 28px; text-align: center; color: var(--text-secondary);">
                <span class="spinner" style="display: inline-block; margin-right: 8px;">🔄</span> AI 코딩 세션 목록을 조회하는 중...
            </td>
        </tr>
    `;

    try {
        if (window.eel && eel.get_all_ai_sessions) {
            const res = await eel.get_all_ai_sessions(agyState.sourceFilter || 'all', 100, 'all')();
            if (res && res.status === 'success' && Array.isArray(res.sessions)) {
                agyState.sessions = res.sessions;
                // 최초 1회 로드 시 모든 프로젝트를 기본 선택 상태로 초기화
                if (!agyState.filterInitialized) {
                    const uniqueWorkspaces = new Set(res.sessions.map(s => s.primary_workspace || s.workspace_path || '기타'));
                    agyState.selectedWorkspaces = uniqueWorkspaces;
                    agyState.filterInitialized = true;
                }
            } else {
                agyState.sessions = [];
            }
        } else if (window.eel && eel.get_agy_sessions) {
            const res = await eel.get_agy_sessions(100, 'all')();
            if (res && res.status === 'success' && Array.isArray(res.sessions)) {
                agyState.sessions = res.sessions;
                if (!agyState.filterInitialized) {
                    const uniqueWorkspaces = new Set(res.sessions.map(s => s.primary_workspace || '기타'));
                    agyState.selectedWorkspaces = uniqueWorkspaces;
                    agyState.filterInitialized = true;
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
        const encodedWs = encodeURIComponent(ws);

        return `
            <label class="agy-project-checkbox-item">
                <input type="checkbox" data-ws="${encodedWs}" ${isChecked ? 'checked' : ''} onchange="onToggleProjectFilter(this)">
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
 * 프로젝트 체크박스 개별 토글 (data-ws attribute에서 안전하게 디코딩)
 */
function onToggleProjectFilter(checkboxEl) {
    if (!checkboxEl) return;
    const ws = decodeURIComponent(checkboxEl.getAttribute('data-ws') || '');
    if (!ws) return;

    if (checkboxEl.checked) {
        agyState.selectedWorkspaces.add(ws);
    } else {
        agyState.selectedWorkspaces.delete(ws);
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
        agyState.selectedWorkspaces = new Set(uniqueWorkspaces);
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
 * 알림 설정 팝오버 메뉴 열기 (1회성 vs 지속 알림 선택)
 */
function openAgyNotifyMenu(conversationId, event) {
    if (event) event.stopPropagation();
    closeAgyNotifyMenu(); // 기존 팝오버 닫기

    const btn = event.currentTarget;
    const rect = btn.getBoundingClientRect();
    const currentMode = agyState.watchedSessions.get(conversationId) || '';

    const popover = document.createElement('div');
    popover.id = 'agy-notify-popover';
    popover.className = 'agy-notify-popover';
    popover.style.top = `${rect.bottom + 6}px`;
    popover.style.left = `${Math.max(10, rect.left - 130)}px`;

    popover.innerHTML = `
        <div class="agy-popover-item ${currentMode === 'once' ? 'selected' : ''}" onclick="setAgyWatchMode('${conversationId}', 'once', event)">
            <span class="agy-popover-icon">🔔</span>
            <div class="agy-popover-text">
                <div class="agy-popover-title">1회 알림 (One-Shot)</div>
                <div class="agy-popover-desc">이번 턴 작업 완료 시 1회 알림 후 자동 해제</div>
            </div>
            ${currentMode === 'once' ? '<span class="agy-popover-check">✓</span>' : ''}
        </div>
        <div class="agy-popover-item ${currentMode === 'persistent' ? 'selected' : ''}" onclick="setAgyWatchMode('${conversationId}', 'persistent', event)">
            <span class="agy-popover-icon">🔁</span>
            <div class="agy-popover-text">
                <div class="agy-popover-title">지속 알림 (Persistent)</div>
                <div class="agy-popover-desc">직접 끄기 전까지 매 턴 완료 시마다 계속 알림</div>
            </div>
            ${currentMode === 'persistent' ? '<span class="agy-popover-check">✓</span>' : ''}
        </div>
        ${currentMode ? `
        <div class="agy-popover-divider"></div>
        <div class="agy-popover-item danger" onclick="setAgyWatchMode('${conversationId}', 'off', event)">
            <span class="agy-popover-icon">🔕</span>
            <div class="agy-popover-text">
                <div class="agy-popover-title">알림 해제 (Off)</div>
                <div class="agy-popover-desc">작업 완료 감시를 즉시 중단합니다</div>
            </div>
        </div>` : ''}
    `;

    document.body.appendChild(popover);
}

/**
 * 알림 설정 팝오버 메뉴 닫기
 */
function closeAgyNotifyMenu() {
    const existing = document.getElementById('agy-notify-popover');
    if (existing) {
        existing.remove();
    }
}

/**
 * 세션 알림 모드 설정 ('once' | 'persistent' | 'off')
 */
async function setAgyWatchMode(conversationId, mode, event) {
    if (event) event.stopPropagation();
    closeAgyNotifyMenu();
    if (!conversationId) return;

    const enable = (mode !== 'off');
    const watchMode = enable ? mode : 'once';

    try {
        if (window.eel && eel.toggle_agy_watch_session) {
            const res = await eel.toggle_agy_watch_session(conversationId, enable, watchMode)();
            if (res && res.status === 'success') {
                if (enable) {
                    agyState.watchedSessions.set(conversationId, watchMode);
                } else {
                    agyState.watchedSessions.delete(conversationId);
                }
                renderAgySessionsUI();

                if (typeof showToast === 'function') {
                    const shortId = conversationId.slice(0, 8);
                    if (!enable) {
                        showToast(`🔕 알림 감시 해제: #${shortId}`, '감시가 해제되었습니다.', '🔕', 3000);
                    } else if (watchMode === 'once') {
                        showToast(`🔔 1회 알림 시작: #${shortId}`, '이번 턴 작업 완료 시 1회 알림 후 자동 해제됩니다.', '🔔', 4000);
                    } else {
                        showToast(`🔁 지속 알림 시작: #${shortId}`, '직접 끄기 전까지 매 턴 작업 완료 시마다 계속 알림을 드립니다.', '🔁', 4000);
                    }
                }
            } else {
                if (typeof showToast === 'function') {
                    showToast(res ? res.message : '알림 설정 변경 실패', 'error');
                }
            }
        }
    } catch (e) {
        console.error('[agy_sessions] 알림 모드 설정 오류:', e);
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
    const mode = sessionInfo.mode || 'once';

    // 1회 알림인 경우에만 감시 목록에서 자동 제거
    if (mode === 'once') {
        agyState.watchedSessions.delete(convId);
    }
    renderAgySessionsUI();

    // 1. 소리 알림 (Web Audio API 기반 딩동 사운드)
    playAgyNotificationSound();

    // 2. 앱 내 토스트 알림 팝업
    const modeLabel = mode === 'once' ? '1회 알림' : '지속 알림';
    if (typeof showToast === 'function') {
        showToast(
            `🔔 agy 작업 완료 (${modeLabel} #${shortId})`,
            `[${title}] 에이전트 응답이 완료되었습니다. (스텝 ${stepCount})`,
            mode === 'once' ? '🔔' : '🔁',
            7000
        );
    }

    if (typeof logToConsole === 'function') {
        logToConsole('Antigravity CLI 작업 완료', `세션 #${shortId}: [${title}] 완료 (스텝 ${stepCount}, ${modeLabel})`);
    }
}

/**
 * 터미널에서 권한 승인(BypassSandbox 등) 대기 중일 때 푸시되는 실시간 이벤트 콜백
 */
function on_agy_permission_requested(permInfo) {
    if (!agyState.enabled || !permInfo) return;

    const convId = permInfo.conversation_id || '';
    const title = permInfo.title || '세션';
    const shortId = convId.length >= 8 ? convId.slice(0, 8) : convId;
    const stepCount = permInfo.step_count || 0;
    const desc = permInfo.description || '터미널에서 실행 권한 승인을 기다리고 있습니다.';

    // 주의 집중 사운드 재생
    playAgyPermissionSound();

    // 앱 내 토스트 알림 팝업
    if (typeof showToast === 'function') {
        showToast(
            `🔐 agy 권한 승인 대기 (#${shortId})`,
            `[${title}] ${desc} (스텝 ${stepCount})`,
            '🔐',
            8000
        );
    }

    if (typeof logToConsole === 'function') {
        logToConsole('Antigravity CLI 권한 승인 대기', `세션 #${shortId}: [${title}] ${desc}`);
    }
}

/**
 * 권한 승인 대기 전용 주의 알림 사운드 (Web Audio API 2단 고주파 비프음)
 */
function playAgyPermissionSound() {
    try {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (!AudioContext) return;

        const ctx = new AudioContext();
        const now = ctx.currentTime;

        // 1음 (784Hz - G5)
        const osc1 = ctx.createOscillator();
        const gain1 = ctx.createGain();
        osc1.type = 'triangle';
        osc1.frequency.setValueAtTime(783.99, now);
        gain1.gain.setValueAtTime(0.2, now);
        gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
        osc1.connect(gain1);
        gain1.connect(ctx.destination);
        osc1.start(now);
        osc1.stop(now + 0.12);

        // 2음 (880Hz - A5)
        const osc2 = ctx.createOscillator();
        const gain2 = ctx.createGain();
        osc2.type = 'triangle';
        osc2.frequency.setValueAtTime(880.0, now + 0.1);
        gain2.gain.setValueAtTime(0.25, now + 0.1);
        gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.28);
        osc2.connect(gain2);
        gain2.connect(ctx.destination);
        osc2.start(now + 0.1);
        osc2.stop(now + 0.28);
    } catch (e) {
        // 무시
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
        if (!agyState.selectedWorkspaces.has(ws)) {
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
        const fullId = s.conversation_id || s.id || '';
        const shortId = fullId.length >= 8 ? fullId.slice(0, 8) : fullId;
        const workspacePath = s.primary_workspace || s.workspace_path || '';
        const safeWorkspacePath = escapeHtml(workspacePath);
        const baseName = escapeHtml(getBaseName(workspacePath) || '루트');
        const lastModified = s.last_modified || '';
        const stepCount = s.step_count || 0;
        const isCurrent = Boolean(s.is_current || s.is_current_workspace);
        const source = s.source || 'agy';
        const isOcx = source === 'ocx';
        const sourceBadgeHtml = isOcx
            ? '<span class="badge-source ocx">🟣 OCX</span>'
            : '<span class="badge-source agy">🤖 AGY</span>';
        const modelBadgeHtml = s.model ? `<span class="agy-model-badge">${escapeHtml(s.model)}</span>` : '';

        // 알림 모드 판별
        const watchMode = agyState.watchedSessions.get(fullId) || '';
        let btnContent = '🔕';
        let btnClass = 'agy-notify-btn';
        let btnTitle = '알림 모드 선택 (1회성 / 지속 알림)';
        let rowWatchedClass = '';

        if (watchMode === 'once') {
            btnClass += ' mode-once';
            btnContent = '🔔 <span class="agy-mode-tag">1회</span>';
            btnTitle = '1회 알림 감시 중 (완료 시 자동 해제)';
            rowWatchedClass = 'row-watched-once';
        } else if (watchMode === 'persistent') {
            btnClass += ' mode-persistent';
            btnContent = '🔁 <span class="agy-mode-tag">지속</span>';
            btnTitle = '지속 알림 감시 중 (직접 끄기 전까지 매 턴 알림)';
            rowWatchedClass = 'row-watched-persistent';
        }

        const isCliActive = !!s.is_cli_active;
        const activeTagHtml = isCliActive ? '<span class="agy-active-pulse" title="현재 다른 터미널 CLI에서 활성 실행 중">🟢 실행 중</span>' : '';

        return `
            <tr class="agy-table-row ${rowWatchedClass} ${isCliActive ? 'row-cli-active' : ''}">
                <td class="agy-cell-title" title="${title} (클릭하여 실시간 세션 모니터 열기)" style="cursor: pointer;" onclick="openAgyLiveInspector('${fullId}', '${encodeURIComponent(workspacePath)}', '${source}')">
                    <div class="agy-title-wrapper">
                        ${sourceBadgeHtml}
                        <span class="agy-title-text">${title}</span>
                        ${modelBadgeHtml}
                        ${activeTagHtml}
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
                        <code>#${shortId}</code>
                        <span class="agy-copy-icon">📋</span>
                    </button>
                </td>
                <td class="agy-cell-steps" style="text-align: center;">
                    <span class="agy-step-badge">${stepCount} 스텝</span>
                </td>
                <td class="agy-cell-time" style="text-align: center;">
                    <span class="agy-time-text">${lastModified}</span>
                </td>
                <td class="agy-cell-notify" style="text-align: center;">
                    <button class="${btnClass}" onclick="openAgyNotifyMenu('${fullId}', event)" title="${btnTitle}">
                        ${btnContent}
                    </button>
                </td>
                <td class="agy-cell-action" style="text-align: center;">
                    <div class="agy-action-btn-group">
                        <button class="compact-btn secondary agy-view-btn" onclick="openAgyLiveInspector('${fullId}', '${encodeURIComponent(workspacePath)}', '${source}')" title="실시간 세션 모니터 열기">
                            <span>👁️</span> 보기
                        </button>
                        <button class="compact-btn powershell agy-run-btn" onclick="launchAgyTerminal('${fullId}', '${encodeURIComponent(workspacePath)}', '${source}')" title="터미널 창 전환 또는 새로 열기">
                            <span>⚡</span> 실행
                        </button>
                    </div>
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
 * 세션 터미널 실행 또는 기존 창 화면 맨 앞으로 전환
 */
async function launchAgyTerminal(conversationId, encodedWorkspacePath, source = 'agy', force = false) {
    if (!conversationId) return;
    const workspacePath = decodeURIComponent(encodedWorkspacePath || '');

    try {
        if (window.eel && eel.launch_ai_session) {
            const res = await eel.launch_ai_session(conversationId, workspacePath, source, force)();
            if (res && res.status === 'success') {
                const toastType = res.activated ? 'info' : 'success';
                if (typeof showToast === 'function') {
                    showToast(res.message || 'AI 세션 터미널을 실행했습니다.', toastType);
                }
                if (typeof logToConsole === 'function') {
                    logToConsole('AI 세션 실행', res.message);
                }
            } else if (res && res.status === 'warning' && res.already_active) {
                const confirmed = await showAppConfirm(
                    `${res.message}\n\n그래도 새 터미널 창을 강제로 실행하시겠습니까?`,
                    { title: '세션 실행 확인', icon: '⚠️', confirmText: '강제 실행', cancelText: '취소' }
                );
                if (confirmed) {
                    await launchAgyTerminal(conversationId, encodedWorkspacePath, source, true);
                }
            } else {
                if (typeof showToast === 'function') {
                    showToast(res ? res.message : '터미널 실행 실패', 'error');
                }
            }
        } else if (window.eel && eel.launch_agy_session) {
            const res = await eel.launch_agy_session(conversationId, workspacePath, force)();
            if (res && res.status === 'success') {
                const toastType = res.activated ? 'info' : 'success';
                if (typeof showToast === 'function') {
                    showToast(res.message || 'Antigravity CLI 터미널을 실행했습니다.', toastType);
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

// ==============================================================================
// Antigravity CLI 실시간 세션 인스펙터 (Live Inspector)
// ==============================================================================
let agyInspectorActiveId = null;
let agyInspectorActiveWorkspace = '';
let agyInspectorActiveSource = 'agy';
let agyInspectorTimer = null;

/**
 * 실시간 세션 모니터 모달 열기
 */
async function openAgyLiveInspector(conversationId, encodedWorkspacePath, source = 'agy') {
    if (!conversationId) return;
    agyInspectorActiveId = conversationId;
    agyInspectorActiveWorkspace = decodeURIComponent(encodedWorkspacePath || '');
    agyInspectorActiveSource = source || 'agy';

    const modal = document.getElementById('agy-live-inspector-modal');
    if (modal) modal.style.display = 'flex';

    // 기본 로딩 뷰 표시
    const streamEl = document.getElementById('agy-inspector-stream');
    if (streamEl) {
        streamEl.innerHTML = `
            <div class="agy-inspector-loading">
                <span class="agy-spin">⏳</span>
                <span>세션 [${conversationId.slice(0, 8)}] 실시간 스트림을 분석하는 중...</span>
            </div>
        `;
    }

    const autoToggle = document.getElementById('agy-inspector-auto-toggle');
    if (autoToggle) {
        // 기본값: 자동 갱신 ON
        autoToggle.checked = true;
    }

    await refreshAgyLiveInspector();

    // 3초 주기 자동 갱신 시작
    startAgyInspectorTimer();
}

/**
 * 실시간 세션 모니터 모달 닫기
 */
function closeAgyLiveInspector() {
    stopAgyInspectorTimer();
    agyInspectorActiveId = null;
    const modal = document.getElementById('agy-live-inspector-modal');
    if (modal) modal.style.display = 'none';
}

/**
 * 자동 갱신 토글
 */
function toggleAgyInspectorAutoRefresh(enabled) {
    if (enabled) {
        startAgyInspectorTimer();
    } else {
        stopAgyInspectorTimer();
    }
}

function startAgyInspectorTimer() {
    stopAgyInspectorTimer();
    agyInspectorTimer = setInterval(() => {
        const modal = document.getElementById('agy-live-inspector-modal');
        if (agyInspectorActiveId && modal && modal.style.display !== 'none') {
            refreshAgyLiveInspector(true);
        } else {
            stopAgyInspectorTimer();
        }
    }, 3000);
}

function stopAgyInspectorTimer() {
    if (agyInspectorTimer) {
        clearInterval(agyInspectorTimer);
        agyInspectorTimer = null;
    }
}

/**
 * 최신 transcript.jsonl 실시간 데이터 폴링 및 렌더링
 */
async function refreshAgyLiveInspector(isSilent = false) {
    if (!agyInspectorActiveId) return;
    const cid = agyInspectorActiveId;
    const src = agyInspectorActiveSource || 'agy';

    try {
        if (window.eel && eel.get_ai_session_live_tail) {
            const res = await eel.get_ai_session_live_tail(cid, src, 20)();
            if (res && res.status === 'success') {
                renderAgyLiveInspectorData(res);
            } else if (!isSilent) {
                const streamEl = document.getElementById('agy-inspector-stream');
                if (streamEl) {
                    streamEl.innerHTML = `<div class="agy-stream-empty">⚠️ ${res ? res.message : '데이터를 가져올 수 없습니다.'}</div>`;
                }
            }
        } else if (window.eel && eel.get_agy_session_live_tail) {
            const res = await eel.get_agy_session_live_tail(cid, 20)();
            if (res && res.status === 'success') {
                renderAgyLiveInspectorData(res);
            } else if (!isSilent) {
                const streamEl = document.getElementById('agy-inspector-stream');
                if (streamEl) {
                    streamEl.innerHTML = `<div class="agy-stream-empty">⚠️ ${res ? res.message : '데이터를 가져올 수 없습니다.'}</div>`;
                }
            }
        }
    } catch (e) {
        console.error('[agy_sessions] 인스펙터 새로고침 오류:', e);
    }
}

/**
 * 인스펙터 데이터 화면 렌더링
 */
function renderAgyLiveInspectorData(data) {
    const titleText = document.getElementById('agy-inspector-title-text');
    const idBadge = document.getElementById('agy-inspector-id');
    const stepBadge = document.getElementById('agy-inspector-step-badge');
    const statusBadge = document.getElementById('agy-inspector-status-badge');
    const permAlert = document.getElementById('agy-inspector-perm-alert');
    const permDesc = document.getElementById('agy-inspector-perm-desc');
    const streamEl = document.getElementById('agy-inspector-stream');

    if (titleText) titleText.textContent = data.title || `세션 ${data.conversation_id.slice(0, 8)}`;
    if (idBadge) idBadge.textContent = `#${data.conversation_id.slice(0, 8)}`;
    if (stepBadge) stepBadge.textContent = `${data.total_steps || 0} 스텝`;

    // 권한 대기 알림 바
    if (data.is_permission_waiting) {
        if (statusBadge) {
            statusBadge.className = 'agy-inspector-badge badge-perm';
            statusBadge.textContent = '🔐 권한 승인 대기';
        }
        if (permAlert) {
            permAlert.style.display = 'flex';
            if (permDesc) permDesc.textContent = data.permission_desc || '터미널에서 명령어 실행 승인을 대기 중입니다.';
        }
    } else {
        if (statusBadge) {
            statusBadge.className = 'agy-inspector-badge badge-idle';
            statusBadge.textContent = '대기 / 준비';
        }
        if (permAlert) permAlert.style.display = 'none';
    }

    if (!streamEl) return;

    const steps = data.steps || [];
    if (steps.length === 0) {
        streamEl.innerHTML = `
            <div class="agy-stream-empty">
                <span>📭 아직 기록된 대화/작업 이벤트가 없습니다.</span>
            </div>
        `;
        return;
    }

    const html = steps.map(step => {
        const isUser = step.type === 'USER_INPUT' || step.source === 'USER_EXPLICIT';
        const isPlanner = step.type === 'PLANNER_RESPONSE';
        const stepNum = step.step_index !== undefined ? step.step_index : '';
        const timeStr = step.created_at ? new Date(step.created_at).toLocaleTimeString() : '';

        // 도구 호출 블록 렌더링
        let toolCallsHtml = '';
        if (step.tool_calls && step.tool_calls.length > 0) {
            toolCallsHtml = step.tool_calls.map(tc => {
                const isBypass = tc.args && (tc.args.BypassSandbox === true || tc.args.BypassSandbox === 'true');
                const cmd = tc.args && tc.args.CommandLine ? tc.args.CommandLine : '';
                return `
                    <div class="agy-stream-tool-call ${isBypass ? 'perm-call' : ''}">
                        <div class="agy-stream-tool-header">
                            <span class="agy-tool-tag">${isBypass ? '🔐' : '🔧'} ${escapeHtml(tc.name)}</span>
                            <span class="agy-tool-summary">${escapeHtml(tc.summary || tc.action || '')}</span>
                        </div>
                        ${cmd ? `<pre class="agy-stream-code"><code>${escapeHtml(cmd)}</code></pre>` : ''}
                    </div>
                `;
            }).join('');
        }

        // 생각(Thinking) 블록
        let thinkingHtml = '';
        if (step.thinking) {
            thinkingHtml = `
                <details class="agy-stream-thinking">
                    <summary>💭 모델 생각 과정 (Thinking)</summary>
                    <div class="agy-stream-thinking-content">${escapeHtml(step.thinking)}</div>
                </details>
            `;
        }

        // 본문 내용 블록
        let contentHtml = '';
        if (step.content) {
            contentHtml = `<div class="agy-stream-content">${escapeHtml(step.content)}</div>`;
        }

        const cardTypeClass = isUser ? 'card-user' : (isPlanner ? 'card-planner' : 'card-generic');
        const senderLabel = isUser ? '👤 사용자' : (isPlanner ? '🤖 에이전트' : '⚙️ 시스템');

        return `
            <div class="agy-stream-card ${cardTypeClass}">
                <div class="agy-stream-card-header">
                    <span class="agy-stream-sender">${senderLabel}</span>
                    <span class="agy-stream-step-tag">Step ${stepNum}</span>
                    <span class="agy-stream-time">${timeStr}</span>
                </div>
                ${thinkingHtml}
                ${toolCallsHtml}
                ${contentHtml}
            </div>
        `;
    }).join('');

    // 이전 스크롤 위치 유지 또는 최하단 스크롤
    const isAtBottom = streamEl.scrollHeight - streamEl.scrollTop <= streamEl.clientHeight + 80;
    streamEl.innerHTML = html;
    if (isAtBottom) {
        streamEl.scrollTop = streamEl.scrollHeight;
    }
}

/**
 * 인스펙터 모달 내부에서 터미널 전환/실행
 */
async function launchAgyInspectorTerminal() {
    if (!agyInspectorActiveId) return;
    await launchAgyTerminal(agyInspectorActiveId, encodeURIComponent(agyInspectorActiveWorkspace || ''), agyInspectorActiveSource || 'agy');
}

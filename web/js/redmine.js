/**
 * Redmine REST API 클라이언트 및 일감/위키 대시보드 모듈
 */

const redmineState = {
    configured: false,
    config: null,
    projects: [],
    metadata: { statuses: [], trackers: [], priorities: [] },
    assignees: [],
    projectMembers: {},
    activeSubTab: 'issues', // 'issues' | 'wiki' | 'config'
    selectedProjectId: null,
    filterFavoriteProjectsOnly: false,
    filterMyOnly: false,
    filterAssignee: '',
    filterStatusId: null,
    filterTrackerId: null,
    filterPriorityId: null,
    quickFilterDueToday: false,
    searchQuery: '',
    selectedIssueId: null,
    selectedWikiTitle: null,
    wikiEditMode: false,
    autoSyncTimer: null,
    lastCheckTime: null
};

function formatErrorMessage(err) {
    if (!err) return '알 수 없는 오류가 발생했습니다.';
    if (typeof err === 'string') return err;
    if (err.message && typeof err.message === 'string') return err.message;
    if (err.error && typeof err.error === 'string') return err.error;
    if (err.error && typeof err.error === 'object') return formatErrorMessage(err.error);
    try {
        const jsonStr = JSON.stringify(err);
        if (jsonStr && jsonStr !== '{}') return jsonStr;
    } catch (e) {}
    return String(err);
}

// ==========================================
// 1. 초기화 및 설정 관리
// ==========================================

async function initRedmineTab() {
    await checkRedmineConfig();
    if (redmineState.configured) {
        await loadRedmineProjectsAndMeta();
        await loadRedmineIssues();
        startRedmineBackgroundPolling();
    } else {
        renderRedmineUnconfiguredView();
    }
}

async function checkRedmineConfig() {
    try {
        if (window.eel && typeof eel.get_redmine_config === 'function') {
            const res = await eel.get_redmine_config()();
            if (res && res.status === 'success') {
                redmineState.configured = !!res.configured;
                redmineState.config = res.config;
                updateRedmineHeaderStatus();
                return res.configured;
            }
        }
    } catch (e) {
        console.error("Redmine 설정 확인 실패:", e);
    }
    return false;
}

function updateRedmineHeaderStatus() {
    const statusEl = document.getElementById('redmine-connection-badge');
    if (!statusEl) return;

    if (redmineState.configured && redmineState.config) {
        const uName = redmineState.config.user_name || redmineState.config.user_login || '연결됨';
        statusEl.innerHTML = `<span class="badge-dot green"></span> <strong>${escapeHtml(uName)}</strong>`;
        statusEl.className = 'redmine-conn-badge connected';
        statusEl.title = `서버: ${redmineState.config.server_url}`;
    } else {
        statusEl.innerHTML = `<span class="badge-dot gray"></span> 미연결`;
        statusEl.className = 'redmine-conn-badge disconnected';
        statusEl.title = 'Redmine 서버 연결이 필요합니다.';
    }
}

function switchRedmineSubTab(subTabName) {
    redmineState.activeSubTab = subTabName;

    document.querySelectorAll('.redmine-subtab-btn').forEach(btn => {
        btn.classList.toggle('active', btn.getAttribute('data-subtab') === subTabName);
    });

    const paneIssues = document.getElementById('redmine-pane-issues');
    const paneWiki = document.getElementById('redmine-pane-wiki');
    const paneConfig = document.getElementById('redmine-pane-config');

    if (paneIssues) paneIssues.style.display = (subTabName === 'issues') ? 'flex' : 'none';
    if (paneWiki) paneWiki.style.display = (subTabName === 'wiki') ? 'flex' : 'none';
    if (paneConfig) paneConfig.style.display = (subTabName === 'config') ? 'block' : 'none';

    if (subTabName === 'issues') {
        loadRedmineIssues();
    } else if (subTabName === 'wiki') {
        loadRedmineWikiView();
    } else if (subTabName === 'config') {
        populateRedmineConfigForm();
    }
}

function renderRedmineUnconfiguredView() {
    const paneIssues = document.getElementById('redmine-pane-issues');
    if (!paneIssues) return;

    paneIssues.innerHTML = `
        <div class="redmine-empty-placeholder">
            <div class="empty-icon">🦊</div>
            <h3>Redmine 연결 설정이 필요합니다</h3>
            <p>회사 또는 개인 Redmine 서버 주소와 API 접근 키(Access Key)를 등록하면<br>내 일감 실시간 모니터링, 상태 변경, 위키 문서를 즉시 관리할 수 있습니다.</p>
            <button class="btn btn-primary" onclick="switchRedmineSubTab('config')">
                <span>⚙️</span> Redmine 연동 설정하기
            </button>
        </div>
    `;
}

function populateRedmineConfigForm() {
    const urlInput = document.getElementById('redmine-cfg-url');
    const keyInput = document.getElementById('redmine-cfg-key');
    const syncCheckbox = document.getElementById('redmine-cfg-sync');
    const intervalSelect = document.getElementById('redmine-cfg-interval');
    const scopeSelect = document.getElementById('redmine-cfg-scope');
    const limitSelect = document.getElementById('redmine-cfg-limit');

    if (redmineState.config) {
        if (urlInput) urlInput.value = redmineState.config.server_url || '';
        if (keyInput) keyInput.value = redmineState.config.api_key || '';
        if (syncCheckbox) syncCheckbox.checked = (redmineState.config.auto_sync !== 0);
        if (intervalSelect) intervalSelect.value = redmineState.config.sync_interval_min || 5;
        if (scopeSelect) scopeSelect.value = redmineState.config.sync_scope || 'all_open';
        if (limitSelect) limitSelect.value = redmineState.config.sync_limit || 300;
    }
}

function normalizeRedmineUrl(url) {
    if (!url) return '';
    let u = String(url).trim().replace(/\/+$/, '');
    // 브라우저에서 복사한 /projects/xxx, /issues/xxx 등의 하위 웹 경로를 Base URL로 자동 정제
    u = u.replace(/\/(projects|issues|my|wiki|users|settings|admin|enumerations|custom_fields|news|time_entries)(\/.*)?$/i, '').replace(/\/+$/, '');
    return u;
}

async function testRedmineConnectionAction() {
    const urlInput = document.getElementById('redmine-cfg-url');
    const keyInput = document.getElementById('redmine-cfg-key');
    const testResultEl = document.getElementById('redmine-test-result');

    let url = urlInput ? urlInput.value.trim() : '';
    const key = keyInput ? keyInput.value.trim() : '';

    if (!url || !key) {
        showToast('입력 확인', '서버 URL과 API Key를 모두 입력해 주세요.', '⚠️');
        return;
    }

    // URL 지능형 정규화 및 입력창 갱신
    url = normalizeRedmineUrl(url);
    if (urlInput) urlInput.value = url;

    if (testResultEl) {
        testResultEl.innerHTML = '<span class="loading-spinner"></span> 서버 연결 확인 중...';
        testResultEl.className = 'redmine-test-msg testing';
    }

    try {
        if (window.eel && typeof eel.test_redmine_connection === 'function') {
            const res = await eel.test_redmine_connection(url, key)();
            if (res.status === 'success') {
                if (testResultEl) {
                    testResultEl.innerHTML = `✅ ${escapeHtml(res.message)}`;
                    testResultEl.className = 'redmine-test-msg success';
                }
                showToast('연결 성공', res.message, '🎉');
            } else {
                if (testResultEl) {
                    testResultEl.innerHTML = `❌ ${escapeHtml(res.message)}`;
                    testResultEl.className = 'redmine-test-msg error';
                }
                showToast('연결 실패', res.message, '⚠️');
            }
        }
    } catch (e) {
        if (testResultEl) {
            testResultEl.innerHTML = `❌ 연결 오류: ${escapeHtml(e.message || e)}`;
            testResultEl.className = 'redmine-test-msg error';
        }
    }
}

async function saveRedmineConfigAction() {
    const urlInput = document.getElementById('redmine-cfg-url');
    const keyInput = document.getElementById('redmine-cfg-key');
    const syncCheckbox = document.getElementById('redmine-cfg-sync');
    const intervalSelect = document.getElementById('redmine-cfg-interval');
    const scopeSelect = document.getElementById('redmine-cfg-scope');
    const limitSelect = document.getElementById('redmine-cfg-limit');

    let url = urlInput ? urlInput.value.trim() : '';
    const key = keyInput ? keyInput.value.trim() : '';
    const autoSync = syncCheckbox ? syncCheckbox.checked : true;
    const intervalMin = intervalSelect ? parseInt(intervalSelect.value, 10) : 5;
    const syncScope = scopeSelect ? scopeSelect.value : 'all_open';
    const syncLimit = limitSelect ? parseInt(limitSelect.value, 10) : 300;

    if (!url || !key) {
        showToast('입력 확인', '서버 URL과 API Key를 모두 입력해 주세요.', '⚠️');
        return;
    }

    // URL 지능형 정규화 및 입력창 갱신
    url = normalizeRedmineUrl(url);
    if (urlInput) urlInput.value = url;

    try {
        if (window.eel && typeof eel.save_redmine_config === 'function') {
            const res = await eel.save_redmine_config(url, key, autoSync, intervalMin, syncScope, syncLimit)();
            if (res.status === 'success') {
                redmineState.configured = true;
                redmineState.config = {
                    server_url: url,
                    api_key: key,
                    user_name: res.user ? res.user.name : '',
                    auto_sync: autoSync ? 1 : 0,
                    sync_interval_min: intervalMin,
                    sync_scope: syncScope,
                    sync_limit: syncLimit
                };
                updateRedmineHeaderStatus();
                showToast('설정 저장 완료', 'Redmine 연동 설정 및 동기화 범위가 저장되었습니다! 🎉', '✅');
                
                // 설정 완료 후 일감 탭으로 복귀
                await loadRedmineProjectsAndMeta();
                switchRedmineSubTab('issues');
            } else {
                showToast('설정 저장 실패', res.message, '⚠️');
            }
        }
    } catch (e) {
        showToast('저장 오류', e.message || String(e), '⚠️');
    }
}

// ==========================================
// 2. 프로젝트 & 메타데이터 로드
// ==========================================

async function loadRedmineProjectsAndMeta() {
    try {
        if (window.eel) {
            // 프로젝트 목록
            if (typeof eel.get_redmine_projects === 'function') {
                const pRes = await eel.get_redmine_projects()();
                if (pRes.status === 'success') {
                    redmineState.projects = pRes.projects || [];
                    renderProjectDropdowns();
                }
            }
            // 메타데이터 (트래커, 상태, 우선순위)
            if (typeof eel.get_redmine_metadata === 'function') {
                const mRes = await eel.get_redmine_metadata()();
                if (mRes.status === 'success' && mRes.metadata) {
                    redmineState.metadata = mRes.metadata;
                    renderFilterDropdowns();
                }
            }
        }
    } catch (e) {
        console.error("프로젝트/메타데이터 로드 실패:", e);
    }
}

function renderProjectDropdowns() {
    const projSelect = document.getElementById('redmine-project-filter');
    const wikiProjSelect = document.getElementById('redmine-wiki-project-filter');
    const modalProjSelect = document.getElementById('redmine-create-project');

    const favProjects = redmineState.projects.filter(p => p.is_favorite == 1);
    const otherProjects = redmineState.projects.filter(p => p.is_favorite != 1);

    // 1. 일감 필터 드롭다운 옵션 생성
    let filterOptions = '<option value="">전체 프로젝트</option>';
    if (favProjects.length > 0) {
        filterOptions += `<optgroup label="⭐ 주요 관심 프로젝트 (${favProjects.length})">`;
        filterOptions += favProjects.map(p => `<option value="${p.id}">⭐ ${escapeHtml(p.name)}</option>`).join('');
        filterOptions += `</optgroup>`;
        if (otherProjects.length > 0) {
            filterOptions += `<optgroup label="📁 전체 프로젝트 (${otherProjects.length})">`;
            filterOptions += otherProjects.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');
            filterOptions += `</optgroup>`;
        }
    } else {
        filterOptions += redmineState.projects.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');
    }

    if (projSelect) {
        const curVal = projSelect.value;
        projSelect.innerHTML = filterOptions;
        if (curVal) projSelect.value = curVal;
    }
    
    // 2. 위키 프로젝트 드롭다운 옵션 생성
    if (wikiProjSelect) {
        let wikiOptions = '';
        if (favProjects.length > 0) {
            wikiOptions += `<optgroup label="⭐ 주요 관심 프로젝트 (${favProjects.length})">`;
            wikiOptions += favProjects.map(p => `<option value="${p.identifier || p.id}">⭐ ${escapeHtml(p.name)}</option>`).join('');
            wikiOptions += `</optgroup>`;
            if (otherProjects.length > 0) {
                wikiOptions += `<optgroup label="📁 전체 프로젝트 (${otherProjects.length})">`;
                wikiOptions += otherProjects.map(p => `<option value="${p.identifier || p.id}">${escapeHtml(p.name)}</option>`).join('');
                wikiOptions += `</optgroup>`;
            }
        } else {
            wikiOptions = redmineState.projects.map(p => 
                `<option value="${p.identifier || p.id}">${escapeHtml(p.name)}</option>`
            ).join('');
        }
        wikiProjSelect.innerHTML = wikiOptions || '<option value="">등록된 프로젝트 없음</option>';
    }

    // 3. 일감 등록 모달 드롭다운 옵션 생성
    if (modalProjSelect) {
        let modalOptions = '<option value="">프로젝트 선택...</option>';
        if (favProjects.length > 0) {
            modalOptions += `<optgroup label="⭐ 주요 관심 프로젝트">`;
            modalOptions += favProjects.map(p => `<option value="${p.id}">⭐ ${escapeHtml(p.name)}</option>`).join('');
            modalOptions += `</optgroup>`;
            if (otherProjects.length > 0) {
                modalOptions += `<optgroup label="📁 전체 프로젝트">`;
                modalOptions += otherProjects.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');
                modalOptions += `</optgroup>`;
            }
        } else {
            modalOptions += redmineState.projects.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');
        }

        modalProjSelect.innerHTML = modalOptions;

        modalProjSelect.onchange = () => {
            const pId = modalProjSelect.value ? parseInt(modalProjSelect.value, 10) : null;
            if (pId) {
                loadProjectMembersForIssue(pId, '', 'redmine-create-assignee');
            }
        };
    }
}

function renderFilterDropdowns() {
    const statusSelect = document.getElementById('redmine-status-filter');
    const trackerSelect = document.getElementById('redmine-tracker-filter');
    const prioritySelect = document.getElementById('redmine-priority-filter');

    if (statusSelect && redmineState.metadata.statuses) {
        statusSelect.innerHTML = [
            '<option value="">전체 상태</option>',
            ...redmineState.metadata.statuses.map(s => `<option value="${s.id}">${escapeHtml(s.name)}</option>`)
        ].join('');
    }

    if (trackerSelect && redmineState.metadata.trackers) {
        trackerSelect.innerHTML = [
            '<option value="">전체 유형 (Tracker)</option>',
            ...redmineState.metadata.trackers.map(t => `<option value="${t.id}">${escapeHtml(t.name)}</option>`)
        ].join('');
    }

    if (prioritySelect && redmineState.metadata.priorities) {
        prioritySelect.innerHTML = [
            '<option value="">전체 우선순위</option>',
            ...redmineState.metadata.priorities.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`)
        ].join('');
    }

    // 새 일감 생성 모달 드롭다운 채우기
    const createTracker = document.getElementById('redmine-create-tracker');
    const createPriority = document.getElementById('redmine-create-priority');
    if (createTracker && redmineState.metadata.trackers) {
        createTracker.innerHTML = redmineState.metadata.trackers.map(t => 
            `<option value="${t.id}">${escapeHtml(t.name)}</option>`
        ).join('');
    }
    if (createPriority && redmineState.metadata.priorities) {
        createPriority.innerHTML = redmineState.metadata.priorities.map(p => 
            `<option value="${p.id}">${escapeHtml(p.name)}</option>`
        ).join('');
    }
}

// ==========================================
// 3. 일감 (Issues) 대시보드 & 뷰어
// ==========================================

async function loadRedmineIssues() {
    if (!redmineState.configured) {
        renderRedmineUnconfiguredView();
        return;
    }

    const listContainer = document.getElementById('redmine-issues-list');
    if (!listContainer) return;

    listContainer.innerHTML = '<div class="redmine-loading">⚡ 일감 목록 로드 중...</div>';

    try {
        if (window.eel && typeof eel.get_redmine_issues === 'function') {
            const res = await eel.get_redmine_issues(
                redmineState.filterMyOnly,
                redmineState.selectedProjectId,
                redmineState.filterStatusId,
                redmineState.filterTrackerId,
                redmineState.filterPriorityId,
                redmineState.searchQuery,
                redmineState.filterAssignee,
                !!redmineState.quickFilterDueToday,
                !!redmineState.filterFavoriteProjectsOnly
            )();

            if (res && res.status === 'success') {
                renderIssueStats(res.stats);
                updateAssigneeDropdown(res.assignees || []);
                renderIssueCards(res.issues);
                
                // 첫 번째 일감 자동 선택
                if (res.issues && res.issues.length > 0) {
                    if (!redmineState.selectedIssueId || !res.issues.some(i => i.id === redmineState.selectedIssueId)) {
                        selectRedmineIssue(res.issues[0].id);
                    }
                } else {
                    renderEmptyIssueDetail();
                }
            } else {
                const errMsg = res ? (res.message || '서버 응답 오류') : '백엔드 응답이 없습니다.';
                listContainer.innerHTML = `<div class="redmine-error">일감 로드 실패: ${escapeHtml(errMsg)}</div>`;
            }
        } else {
            listContainer.innerHTML = `<div class="redmine-error">백엔드 API 연결 준비 중...</div>`;
        }
    } catch (e) {
        console.error("Redmine 일감 로드 예외:", e);
        listContainer.innerHTML = `<div class="redmine-error">오류: ${escapeHtml(formatErrorMessage(e))}</div>`;
    }
}

function updateAssigneeDropdown(assignees) {
    const select = document.getElementById('redmine-assignee-filter');
    if (!select) return;
    const currentVal = redmineState.filterAssignee || select.value;
    
    const baseOptions = [
        '<option value="">전체 담당자</option>',
        '<option value="me">👤 내 일감</option>',
        '<option value="unassigned">❓ 미할당 일감</option>'
    ];
    
    if (assignees && assignees.length > 0) {
        assignees.forEach(name => {
            if (name && name !== '미할당') {
                baseOptions.push(`<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`);
            }
        });
    }
    
    select.innerHTML = baseOptions.join('');
    select.value = currentVal;
}

function renderIssueStats(stats) {
    if (!stats) return;
    const elTotal = document.getElementById('redmine-stat-total');
    const elProgress = document.getElementById('redmine-stat-progress');
    const elNew = document.getElementById('redmine-stat-new');
    const elResolved = document.getElementById('redmine-stat-resolved');
    const elDue = document.getElementById('redmine-stat-due');

    if (elTotal) elTotal.textContent = stats.total || 0;
    if (elProgress) elProgress.textContent = stats.in_progress || 0;
    if (elNew) elNew.textContent = stats.new || 0;
    if (elResolved) elResolved.textContent = stats.resolved || 0;
    if (elDue) elDue.textContent = stats.due_today || 0;
}

function renderIssueCards(issues) {
    const container = document.getElementById('redmine-issues-list');
    if (!container) return;

    if (!issues || issues.length === 0) {
        container.innerHTML = `
            <div class="redmine-empty-list">
                <div class="empty-icon">📭</div>
                <p>조건에 일치하는 일감이 없습니다.</p>
            </div>
        `;
        return;
    }

    const todayStr = new Date().toISOString().split('T')[0];

    container.innerHTML = issues.map(iss => {
        const isSelected = (iss.id === redmineState.selectedIssueId);
        const trackerName = iss.tracker_name || '일감';
        const statusName = iss.status_name || '신규';
        const priorityName = iss.priority_name || '보통';
        const doneRatio = iss.done_ratio || 0;
        
        let priorityClass = 'priority-normal';
        if (priorityName.includes('긴급') || priorityName.includes('Urgent') || priorityName.includes('Immediate')) {
            priorityClass = 'priority-urgent';
        } else if (priorityName.includes('높음') || priorityName.includes('High')) {
            priorityClass = 'priority-high';
        } else if (priorityName.includes('낮음') || priorityName.includes('Low')) {
            priorityClass = 'priority-low';
        }

        let dueBadge = '';
        if (iss.due_date) {
            if (iss.due_date < todayStr && doneRatio < 100) {
                dueBadge = `<span class="redmine-due-badge overdue" title="기한 초과">지연 (${iss.due_date})</span>`;
            } else if (iss.due_date === todayStr) {
                dueBadge = `<span class="redmine-due-badge today" title="오늘 마감">오늘 마감</span>`;
            } else {
                dueBadge = `<span class="redmine-due-badge" title="마감일">~${iss.due_date}</span>`;
            }
        }

        const asgName = iss.assigned_to_name || '미할당';
        const isUnassigned = (!iss.assigned_to_id || asgName === '미할당');
        const assigneeBadge = isUnassigned
            ? `<span class="issue-assignee unassigned" title="담당자가 지정되지 않은 일감입니다">❓ 미할당</span>`
            : `<span class="issue-assignee ${iss.is_my_issue ? 'my' : ''}">👤 ${escapeHtml(asgName)}</span>`;

        const pObj = redmineState.projects.find(p => p.id === iss.project_id);
        const isFav = pObj && pObj.is_favorite == 1;

        return `
            <div class="redmine-issue-card ${isSelected ? 'active' : ''}" onclick="selectRedmineIssue(${iss.id})">
                <div class="issue-card-header">
                    <span class="issue-id">#${iss.id}</span>
                    <span class="issue-tracker-badge">${escapeHtml(trackerName)}</span>
                    <span class="issue-status-badge">${escapeHtml(statusName)}</span>
                    <span class="issue-priority-badge ${priorityClass}">${escapeHtml(priorityName)}</span>
                    ${dueBadge}
                </div>
                <div class="issue-card-title">${escapeHtml(iss.subject)}</div>
                <div class="issue-card-meta">
                    <span class="issue-project" title="프로젝트: ${escapeHtml(iss.project_name || '')}">
                        📁 ${escapeHtml(iss.project_name || '')}
                        <button type="button" class="issue-proj-star-btn ${isFav ? 'favorited' : ''}" data-project-id="${iss.project_id || ''}" onclick="toggleProjectFavoriteInline(${iss.project_id}, event)" title="${isFav ? '주요 관심 프로젝트에서 해제' : '주요 관심 프로젝트(⭐)로 등록'}">
                            ${isFav ? '⭐' : '☆'}
                        </button>
                    </span>
                    ${assigneeBadge}
                </div>
                <div class="issue-card-progress-bar">
                    <div class="progress-fill" style="width: ${doneRatio}%"></div>
                    <span class="progress-text">${doneRatio}%</span>
                </div>
            </div>
        `;
    }).join('');
}

async function selectRedmineIssue(issueId) {
    redmineState.selectedIssueId = issueId;

    // 카드 active 스타일 토글
    document.querySelectorAll('.redmine-issue-card').forEach(card => {
        card.classList.toggle('active', card.innerHTML.includes(`#${issueId}<`));
    });

    const detailContainer = document.getElementById('redmine-issue-detail-pane');
    if (!detailContainer) return;

    detailContainer.innerHTML = '<div class="redmine-loading">⚡ 일감 상세 및 히스토리 조회 중...</div>';

    try {
        if (window.eel && typeof eel.get_redmine_issue_detail === 'function') {
            const res = await eel.get_redmine_issue_detail(issueId, true)();
            if (res.status === 'success' && res.issue) {
                renderIssueDetail(res.issue);
            } else {
                detailContainer.innerHTML = `<div class="redmine-error">상세 정보 로드 실패: ${escapeHtml(res.message)}</div>`;
            }
        }
    } catch (e) {
        console.error("일감 상세 로드 예외:", e);
        detailContainer.innerHTML = `<div class="redmine-error">오류: ${escapeHtml(formatErrorMessage(e))}</div>`;
    }
}

function sanitizeHtmlContent(html) {
    if (!html) return '';
    // 위험한 script, iframe, object, embed 태그 및 인라인 이벤트 핸들러 제거
    return html
        .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
        .replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, '')
        .replace(/<object\b[^<]*(?:(?!<\/object>)<[^<]*)*<\/object>/gi, '')
        .replace(/<embed\b[^<]*(?:(?!<\/embed>)<[^<]*)*<\/embed>/gi, '')
        .replace(/\son\w+\s*=\s*(?:'[^']*'|"[^"]*"|[^\s>]+)/gi, '')
        .replace(/javascript\s*:/gi, '');
}

function formatRedmineContent(rawText) {
    if (!rawText) return '';
    
    // 1. 이미 HTML 태그가 포함되어 있는 경우 (CKEditor / RichText 서식)
    const hasHtmlTags = /<(?:p|div|span|h[1-6]|blockquote|table|ul|ol|li|br|strong|em|b|i|u|s|a|code|pre|img|hr)\b/i.test(rawText);
    if (hasHtmlTags) {
        return sanitizeHtmlContent(rawText);
    }
    
    // 2. Markdown / Textile 포맷인 경우 Markdown Studio 파서 활용
    if (typeof parseMarkdownToHtml === 'function') {
        // Redmine Textile 헤더 (h1. h2. 등)를 마크다운 헤더로 변환
        let normalizedMd = rawText
            .replace(/^h1\.\s+(.+)$/gm, '# $1')
            .replace(/^h2\.\s+(.+)$/gm, '## $1')
            .replace(/^h3\.\s+(.+)$/gm, '### $1')
            .replace(/^h4\.\s+(.+)$/gm, '#### $1')
            .replace(/^h5\.\s+(.+)$/gm, '##### $1');
        return parseMarkdownToHtml(normalizedMd);
    }
    
    // 3. 일반 텍스트인 경우 줄바꿈 유지
    return escapeHtml(rawText).replace(/\n/g, '<br>');
}

function renderIssueDetail(iss) {
    const container = document.getElementById('redmine-issue-detail-pane');
    if (!container) return;

    const trackerName = (iss.tracker && iss.tracker.name) || iss.tracker_name || '일감';
    const statusName = (iss.status && iss.status.name) || iss.status_name || '신규';
    const priorityName = (iss.priority && iss.priority.name) || iss.priority_name || '보통';
    const authorName = (iss.author && iss.author.name) || iss.author_name || '';
    const assigneeName = (iss.assigned_to && iss.assigned_to.name) || iss.assigned_to_name || '미할당';
    const projectName = (iss.project && iss.project.name) || iss.project_name || '';
    const projectId = (iss.project && iss.project.id) || iss.project_id || null;
    const doneRatio = iss.done_ratio || 0;
    const webUrl = iss.web_url || '';

    const currentStatusId = (iss.status && iss.status.id) || iss.status_id;
    const currentPriorityId = (iss.priority && iss.priority.id) || iss.priority_id;
    const currentTrackerId = (iss.tracker && iss.tracker.id) || iss.tracker_id;
    const currentAssigneeId = (iss.assigned_to && iss.assigned_to.id) || iss.assigned_to_id || '';

    // 1. 상태 옵션
    const statusOptions = (redmineState.metadata.statuses || []).map(s => {
        const sel = (s.id === currentStatusId || s.name === statusName) ? 'selected' : '';
        return `<option value="${s.id}" ${sel}>${escapeHtml(s.name)}</option>`;
    }).join('');

    // 2. 진척도 옵션
    const progressOptions = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map(pct => {
        const sel = (pct === doneRatio) ? 'selected' : '';
        return `<option value="${pct}" ${sel}>${pct}%</option>`;
    }).join('');

    // 3. 우선순위 옵션
    const priorityOptions = (redmineState.metadata.priorities || []).map(p => {
        const sel = (p.id === currentPriorityId || p.name === priorityName) ? 'selected' : '';
        return `<option value="${p.id}" ${sel}>${escapeHtml(p.name)}</option>`;
    }).join('');

    // 4. 유형 옵션
    const trackerOptions = (redmineState.metadata.trackers || []).map(t => {
        const sel = (t.id === currentTrackerId || t.name === trackerName) ? 'selected' : '';
        return `<option value="${t.id}" ${sel}>${escapeHtml(t.name)}</option>`;
    }).join('');

    // 5. 담당자 옵션 (캐시된 프로젝트 멤버 또는 기본 목록)
    const members = (projectId && redmineState.projectMembers[projectId]) || [];
    const myId = (redmineState.config && redmineState.config.user_id) || null;
    const myName = (redmineState.config && redmineState.config.user_name) || '나';

    let assigneeOptionsArr = [
        `<option value="" ${!currentAssigneeId ? 'selected' : ''}>❓ 미할당 (담당자 없음)</option>`
    ];

    if (myId) {
        const isMe = (String(currentAssigneeId) === String(myId));
        assigneeOptionsArr.push(`<option value="${myId}" ${isMe ? 'selected' : ''}>👤 나 (${escapeHtml(myName)})</option>`);
    }

    if (members.length > 0) {
        members.forEach(m => {
            if (myId && String(m.id) === String(myId)) return;
            const sel = (String(m.id) === String(currentAssigneeId)) ? 'selected' : '';
            assigneeOptionsArr.push(`<option value="${m.id}" ${sel}>👤 ${escapeHtml(m.name)}</option>`);
        });
    } else if (currentAssigneeId && assigneeName && (!myId || String(currentAssigneeId) !== String(myId))) {
        assigneeOptionsArr.push(`<option value="${currentAssigneeId}" selected>👤 ${escapeHtml(assigneeName)}</option>`);
    }

    const assigneeOptions = assigneeOptionsArr.join('');

    // 비동기 프로젝트 멤버 로드 (캐시에 없을 경우)
    if (projectId && !redmineState.projectMembers[projectId]) {
        setTimeout(() => loadProjectMembersForIssue(projectId, currentAssigneeId, 'quick-issue-assignee-select'), 10);
    }

    // 첨부파일 목록
    let attachmentsHtml = '';
    if (iss.attachments && iss.attachments.length > 0) {
        attachmentsHtml = `
            <div class="detail-section attachments-section">
                <div class="section-title">📎 첨부파일 (${iss.attachments.length}개)</div>
                <div class="attachment-list">
                    ${iss.attachments.map(att => `
                        <div class="attachment-item">
                            <span class="att-name">${escapeHtml(att.filename)}</span>
                            <span class="att-size">(${(att.filesize / 1024).toFixed(1)} KB)</span>
                            <a href="${escapeHtml(att.content_url || '#')}" target="_blank" class="att-link">열기 ↗</a>
                        </div>
                    `).join('')}
                </div>
            </div>
        `;
    }

    // 변경 이력 & 댓글 (Journals)
    let journalsHtml = '';
    if (iss.journals && iss.journals.length > 0) {
        journalsHtml = `
            <div class="detail-section journals-section">
                <div class="section-title">💬 진행 히스토리 & 코멘트 (${iss.journals.length}건)</div>
                <div class="journals-timeline">
                    ${iss.journals.map(j => {
                        const jUser = (j.user && j.user.name) || '작성자';
                        const jDate = j.created_on ? j.created_on.replace('T', ' ').substring(0, 16) : '';
                        const jNotes = j.notes ? formatRedmineContent(j.notes) : '';
                        
                        // 변경 상세 (Details)
                        let detailsStr = '';
                        if (j.details && j.details.length > 0) {
                            detailsStr = `<div class="journal-details-list">` + j.details.map(d => {
                                return `<span class="journal-detail-chip">🏷️ ${escapeHtml(d.name)}: ${escapeHtml(d.old_value || '없음')} ➔ <strong>${escapeHtml(d.new_value || '')}</strong></span>`;
                            }).join('') + `</div>`;
                        }

                        if (!jNotes && !detailsStr) return '';

                        return `
                            <div class="journal-card">
                                <div class="journal-header">
                                    <span class="journal-user">👤 ${escapeHtml(jUser)}</span>
                                    <span class="journal-date">${jDate}</span>
                                </div>
                                ${detailsStr}
                                ${jNotes ? `<div class="journal-body">${jNotes}</div>` : ''}
                            </div>
                        `;
                    }).join('')}
                </div>
            </div>
        `;
    }

    // 본문 설명 (Description)
    const descHtml = iss.description 
        ? `<div class="detail-description-body">${formatRedmineContent(iss.description)}</div>`
        : `<div class="detail-description-body empty">설명이 등록되지 않았습니다.</div>`;

    const pObj = redmineState.projects.find(p => p.id === projectId);
    const isFav = pObj && pObj.is_favorite == 1;

    container.innerHTML = `
        <div class="issue-detail-header">
            <div class="detail-top-row">
                <span class="detail-issue-id">#${iss.id}</span>
                <span class="detail-tracker">${escapeHtml(trackerName)}</span>
                <span class="detail-project">
                    📁 ${escapeHtml(projectName)}
                    ${projectId ? `
                        <button type="button" id="detail-proj-star-btn" class="detail-proj-star-btn ${isFav ? 'favorited' : ''}" data-project-id="${projectId}" onclick="toggleProjectFavoriteInline(${projectId}, event)" title="${isFav ? '주요 관심 프로젝트에서 해제' : '주요 관심 프로젝트(⭐)로 등록'}">
                            ${isFav ? '<span>⭐</span> 주요 프로젝트' : '<span>☆</span> 주요 프로젝트 등록'}
                        </button>
                    ` : ''}
                </span>
                ${webUrl ? `<a href="${escapeHtml(webUrl)}" target="_blank" class="redmine-web-link" title="Redmine 웹페이지에서 열기">🔗 Redmine 웹 ↗</a>` : ''}
            </div>
            <h2 class="detail-subject">${escapeHtml(iss.subject)}</h2>
            <div class="detail-info-grid">
                <div class="info-cell"><span class="info-lbl">상태:</span> <span class="info-val highlight">${escapeHtml(statusName)}</span></div>
                <div class="info-cell"><span class="info-lbl">진척도:</span> <span class="info-val">${doneRatio}%</span></div>
                <div class="info-cell"><span class="info-lbl">담당자:</span> <span class="info-val">👤 ${escapeHtml(assigneeName)}</span></div>
                <div class="info-cell"><span class="info-lbl">우선순위:</span> <span class="info-val">${escapeHtml(priorityName)}</span></div>
                <div class="info-cell"><span class="info-lbl">유형:</span> <span class="info-val">${escapeHtml(trackerName)}</span></div>
                <div class="info-cell"><span class="info-lbl">마감일:</span> <span class="info-val">${iss.due_date || '-'}</span></div>
                <div class="info-cell"><span class="info-lbl">작성자:</span> <span class="info-val">${escapeHtml(authorName)}</span></div>
                <div class="info-cell"><span class="info-lbl">시작일:</span> <span class="info-val">${iss.start_date || '-'}</span></div>
            </div>
        </div>

        <!-- 일감 속성 실시간 빠른 변경 바 -->
        <div class="issue-quick-action-bar">
            <div class="quick-action-row">
                <div class="action-group">
                    <label>상태:</label>
                    <select id="quick-issue-status-select" class="form-select" onchange="onQuickPropertyChange(${iss.id}, 'status_id', this.value)">
                        ${statusOptions}
                    </select>
                </div>
                <div class="action-group">
                    <label>진척도:</label>
                    <select id="quick-issue-progress-select" class="form-select" onchange="onQuickPropertyChange(${iss.id}, 'done_ratio', this.value)">
                        ${progressOptions}
                    </select>
                </div>
                <div class="action-group">
                    <label>우선순위:</label>
                    <select id="quick-issue-priority-select" class="form-select" onchange="onQuickPropertyChange(${iss.id}, 'priority_id', this.value)">
                        ${priorityOptions}
                    </select>
                </div>
                <div class="action-group">
                    <label>유형:</label>
                    <select id="quick-issue-tracker-select" class="form-select" onchange="onQuickPropertyChange(${iss.id}, 'tracker_id', this.value)">
                        ${trackerOptions}
                    </select>
                </div>
            </div>
            <div class="quick-action-row">
                <div class="action-group" style="flex: 1.2;">
                    <label>담당자:</label>
                    <select id="quick-issue-assignee-select" class="form-select" onchange="onQuickPropertyChange(${iss.id}, 'assigned_to_id', this.value)">
                        ${assigneeOptions}
                    </select>
                </div>
                <div class="action-group">
                    <label>마감일:</label>
                    <input type="date" id="quick-issue-due-date" class="form-input quick-date-input" value="${iss.due_date || ''}" onchange="onQuickPropertyChange(${iss.id}, 'due_date', this.value)">
                    ${iss.due_date ? `<button type="button" class="btn btn-xs btn-secondary" onclick="onQuickPropertyChange(${iss.id}, 'due_date', '')" title="마감일 삭제">✕</button>` : ''}
                </div>
                <div class="action-group right">
                    <button class="btn btn-sm btn-primary" onclick="openCommentModal(${iss.id})">💬 코멘트 등록</button>
                </div>
            </div>
        </div>

        <!-- 본문 설명 -->
        <div class="detail-section description-section">
            <div class="section-title">📄 일감 설명</div>
            ${descHtml}
        </div>

        ${attachmentsHtml}
        ${journalsHtml}
    `;
}

async function loadProjectMembersForIssue(projectId, currentAssigneeId, selectElId) {
    if (!projectId) return;
    if (!redmineState.projectMembers[projectId]) {
        try {
            if (window.eel && typeof eel.get_redmine_project_members === 'function') {
                const res = await eel.get_redmine_project_members(projectId)();
                if (res && res.status === 'success' && res.members) {
                    redmineState.projectMembers[projectId] = res.members;
                }
            }
        } catch (e) {
            console.warn("프로젝트 멤버 조회 예외:", e);
        }
    }

    const select = document.getElementById(selectElId);
    if (!select) return;

    const members = redmineState.projectMembers[projectId] || [];
    let baseOptions = [
        `<option value="" ${!currentAssigneeId ? 'selected' : ''}>❓ 미할당 (담당자 없음)</option>`
    ];

    let myId = (redmineState.config && redmineState.config.user_id) || null;
    let myName = (redmineState.config && redmineState.config.user_name) || '나';

    if (myId) {
        const isMe = (String(currentAssigneeId) === String(myId));
        baseOptions.push(`<option value="${myId}" ${isMe ? 'selected' : ''}>👤 나 (${escapeHtml(myName)})</option>`);
    }

    members.forEach(m => {
        if (myId && String(m.id) === String(myId)) return;
        const sel = (String(m.id) === String(currentAssigneeId)) ? 'selected' : '';
        baseOptions.push(`<option value="${m.id}" ${sel}>👤 ${escapeHtml(m.name)}</option>`);
    });

    select.innerHTML = baseOptions.join('');
}

async function onQuickPropertyChange(issueId, fieldName, value) {
    if (!issueId) return;

    try {
        if (window.eel && typeof eel.update_redmine_issue === 'function') {
            const updateParams = {
                status_id: null,
                done_ratio: null,
                notes: null,
                priority_id: null,
                assigned_to_id: null,
                tracker_id: null,
                due_date: null
            };
            updateParams[fieldName] = value;

            const res = await eel.update_redmine_issue(
                issueId,
                updateParams.status_id,
                updateParams.done_ratio,
                updateParams.notes,
                updateParams.priority_id,
                updateParams.assigned_to_id,
                updateParams.tracker_id,
                updateParams.due_date
            )();

            if (res && res.status === 'success') {
                const fieldLabels = {
                    status_id: '상태',
                    done_ratio: '진척도',
                    priority_id: '우선순위',
                    tracker_id: '유형',
                    assigned_to_id: '담당자',
                    due_date: '마감일'
                };
                const label = fieldLabels[fieldName] || '일감 속성';
                showToast('일감 속성 변경 완료', `#${issueId} ${label}이(가) 성공적으로 변경되었습니다. 💾`, '✅');

                // 좌측 목록 및 상단 통계 새로고침
                await loadRedmineIssues();
                // 상세 뷰 새로고침
                await selectRedmineIssue(issueId);
            } else {
                const errMsg = res ? (res.message || '수정 실패') : '백엔드 응답이 없습니다.';
                showToast('일감 변경 실패', errMsg, '⚠️');
            }
        }
    } catch (e) {
        showToast('수정 오류', formatErrorMessage(e), '⚠️');
    }
}

function renderEmptyIssueDetail() {
    const container = document.getElementById('redmine-issue-detail-pane');
    if (!container) return;
    container.innerHTML = `
        <div class="redmine-empty-placeholder">
            <div class="empty-icon">👈</div>
            <h3>일감을 선택해 주세요</h3>
            <p>좌측 목록에서 일감을 선택하면 상세 내용과 변경 이력, 첨부파일을 확인할 수 있습니다.</p>
        </div>
    `;
}

function openCommentModal(issueId) {
    const modal = document.getElementById('redmine-comment-modal');
    const idInput = document.getElementById('redmine-comment-issue-id');
    const textarea = document.getElementById('redmine-comment-text');

    if (idInput) idInput.value = issueId;
    if (textarea) textarea.value = '';
    if (modal) modal.classList.add('show');
}

function closeCommentModal() {
    const modal = document.getElementById('redmine-comment-modal');
    if (modal) modal.classList.remove('show');
}

async function submitIssueComment() {
    const idInput = document.getElementById('redmine-comment-issue-id');
    const textarea = document.getElementById('redmine-comment-text');

    const issueId = idInput ? parseInt(idInput.value, 10) : null;
    const comment = textarea ? textarea.value.trim() : '';

    if (!issueId || !comment) {
        showToast('입력 확인', '코멘트 내용을 입력해 주세요.', '⚠️');
        return;
    }

    try {
        if (window.eel && typeof eel.update_redmine_issue === 'function') {
            const res = await eel.update_redmine_issue(issueId, null, null, comment)();
            if (res.status === 'success') {
                closeCommentModal();
                showToast('코멘트 등록 완료', `일감 #${issueId}에 코멘트가 등록되었습니다.`, '💬');
                await selectRedmineIssue(issueId);
            } else {
                showToast('코멘트 등록 실패', res.message, '⚠️');
            }
        }
    } catch (e) {
        showToast('오류', e.message || String(e), '⚠️');
    }
}

// ==========================================
// 4. 새 일감 등록 모달
// ==========================================

function openCreateIssueModal() {
    if (!redmineState.configured) {
        showToast('설정 필요', 'Redmine 연동 설정을 먼저 완료해 주세요.', '⚠️');
        return;
    }
    const modal = document.getElementById('redmine-create-issue-modal');
    const projSelect = document.getElementById('redmine-create-project');
    
    // 현재 선택된 프로젝트 자동 지정
    if (projSelect && redmineState.selectedProjectId) {
        projSelect.value = redmineState.selectedProjectId;
        loadProjectMembersForIssue(redmineState.selectedProjectId, '', 'redmine-create-assignee');
    } else if (projSelect && redmineState.projects.length > 0) {
        projSelect.value = redmineState.projects[0].id;
        loadProjectMembersForIssue(redmineState.projects[0].id, '', 'redmine-create-assignee');
    }

    if (modal) modal.classList.add('show');
}

function closeCreateIssueModal() {
    const modal = document.getElementById('redmine-create-issue-modal');
    if (modal) modal.classList.remove('show');
}

async function submitCreateIssue() {
    const projSelect = document.getElementById('redmine-create-project');
    const trackerSelect = document.getElementById('redmine-create-tracker');
    const prioritySelect = document.getElementById('redmine-create-priority');
    const assigneeSelect = document.getElementById('redmine-create-assignee');
    const subjectInput = document.getElementById('redmine-create-subject');
    const descInput = document.getElementById('redmine-create-desc');
    const dueInput = document.getElementById('redmine-create-due');

    const projectId = projSelect ? projSelect.value : null;
    const trackerId = trackerSelect ? trackerSelect.value : null;
    const priorityId = prioritySelect ? prioritySelect.value : null;
    const assigneeId = assigneeSelect ? assigneeSelect.value : null;
    const subject = subjectInput ? subjectInput.value.trim() : '';
    const description = descInput ? descInput.value.trim() : '';
    const dueDate = dueInput ? dueInput.value : null;

    if (!projectId) {
        showToast('입력 확인', '프로젝트를 선택해 주세요.', '⚠️');
        return;
    }
    if (!subject) {
        showToast('입력 확인', '일감 제목을 입력해 주세요.', '⚠️');
        return;
    }

    try {
        if (window.eel && typeof eel.create_redmine_issue === 'function') {
            const res = await eel.create_redmine_issue(
                parseInt(projectId, 10),
                subject,
                description,
                trackerId ? parseInt(trackerId, 10) : null,
                null,
                priorityId ? parseInt(priorityId, 10) : null,
                assigneeId ? parseInt(assigneeId, 10) : null,
                dueDate,
                0
            )();

            if (res.status === 'success') {
                closeCreateIssueModal();
                showToast('일감 등록 완료', `새 일감 #${res.issue_id}이 성공적으로 등록되었습니다! 🎉`, '✅');
                
                if (subjectInput) subjectInput.value = '';
                if (descInput) descInput.value = '';

                await loadRedmineIssues();
                if (res.issue_id) {
                    await selectRedmineIssue(res.issue_id);
                }
            } else {
                showToast('일감 등록 실패', res.message, '⚠️');
            }
        }
    } catch (e) {
        showToast('오류', formatErrorMessage(e), '⚠️');
    }
}

// ==========================================
// 5. 위키 (Wiki) 뷰어 & 에디터
// ==========================================

async function loadRedmineWikiView() {
    const wikiProjSelect = document.getElementById('redmine-wiki-project-filter');
    let projKey = wikiProjSelect ? wikiProjSelect.value : null;

    if (!projKey && redmineState.projects.length > 0) {
        projKey = redmineState.projects[0].identifier || redmineState.projects[0].id;
        if (wikiProjSelect) wikiProjSelect.value = projKey;
    }

    if (!projKey) return;
    await loadProjectWikis(projKey);
}

async function loadProjectWikis(projKey) {
    const treeContainer = document.getElementById('redmine-wiki-tree');
    if (!treeContainer) return;

    treeContainer.innerHTML = '<div class="redmine-loading">⚡ 위키 목차 로드 중...</div>';

    try {
        if (window.eel && typeof eel.get_redmine_wikis === 'function') {
            const res = await eel.get_redmine_wikis(projKey)();
            if (res.status === 'success') {
                renderWikiTree(projKey, res.wiki_pages || []);
            } else {
                treeContainer.innerHTML = `<div class="redmine-error">위키 로드 실패: ${escapeHtml(res.message)}</div>`;
            }
        }
    } catch (e) {
        console.error("위키 목차 로드 예외:", e);
        treeContainer.innerHTML = `<div class="redmine-error">오류: ${escapeHtml(formatErrorMessage(e))}</div>`;
    }
}

function renderWikiTree(projKey, pages) {
    const container = document.getElementById('redmine-wiki-tree');
    if (!container) return;

    if (!pages || pages.length === 0) {
        container.innerHTML = `
            <div class="redmine-empty-list">
                <div class="empty-icon">📖</div>
                <p>등록된 위키 문서가 없습니다.</p>
            </div>
        `;
        renderEmptyWikiDetail();
        return;
    }

    container.innerHTML = pages.map(p => {
        const title = p.title || 'Wiki';
        const isSelected = (title === redmineState.selectedWikiTitle);
        const version = p.version ? `v${p.version}` : '';
        return `
            <div class="wiki-tree-item ${isSelected ? 'active' : ''}" onclick="selectWikiPage('${escapeJsString(projKey)}', '${escapeJsString(title)}')">
                <span class="wiki-icon">📄</span>
                <span class="wiki-title">${escapeHtml(title)}</span>
                <span class="wiki-version">${version}</span>
            </div>
        `;
    }).join('');

    // 첫 번째 위키 문서 자동 선택
    if (!redmineState.selectedWikiTitle && pages.length > 0) {
        selectWikiPage(projKey, pages[0].title);
    }
}

async function selectWikiPage(projKey, title) {
    redmineState.selectedWikiTitle = title;
    redmineState.wikiEditMode = false;

    // 트리 active 상태 갱신
    document.querySelectorAll('.wiki-tree-item').forEach(item => {
        item.classList.toggle('active', item.querySelector('.wiki-title') && item.querySelector('.wiki-title').textContent === title);
    });

    const readerContainer = document.getElementById('redmine-wiki-content-pane');
    if (!readerContainer) return;

    readerContainer.innerHTML = '<div class="redmine-loading">⚡ 위키 본문 로드 중...</div>';

    try {
        if (window.eel && typeof eel.get_redmine_wiki_detail === 'function') {
            const res = await eel.get_redmine_wiki_detail(projKey, title, true)();
            if (res.status === 'success' && res.wiki_page) {
                renderWikiReader(projKey, res.wiki_page);
            } else {
                readerContainer.innerHTML = `<div class="redmine-error">위키 본문 로드 실패: ${escapeHtml(res.message)}</div>`;
            }
        }
    } catch (e) {
        console.error("위키 본문 로드 예외:", e);
        readerContainer.innerHTML = `<div class="redmine-error">오류: ${escapeHtml(formatErrorMessage(e))}</div>`;
    }
}

function renderWikiReader(projKey, wiki) {
    const container = document.getElementById('redmine-wiki-content-pane');
    if (!container) return;

    const title = wiki.title || redmineState.selectedWikiTitle || 'Wiki';
    const version = wiki.version || 1;
    const author = (wiki.author && wiki.author.name) || wiki.author_name || '';
    const updatedOn = wiki.updated_on ? wiki.updated_on.replace('T', ' ').substring(0, 16) : '';
    const webUrl = wiki.web_url || '';
    const rawText = wiki.text || '';

    // 현재 선택된 위키 상태 저장 (HTML 속성 인라인 탈출 버그 원천 차단)
    redmineState.currentWikiText = rawText;
    redmineState.currentWikiProject = projKey;
    redmineState.currentWikiTitle = title;

    // 지능형 포맷터 (HTML / Markdown / Textile 자동 감지)
    const renderedHtml = formatRedmineContent(rawText);

    container.innerHTML = `
        <div class="wiki-header">
            <div class="wiki-header-top">
                <span class="wiki-badge">📖 Redmine Wiki</span>
                <span class="wiki-proj-badge">📁 ${escapeHtml(projKey)}</span>
                <span class="wiki-ver-badge">v${version}</span>
                ${webUrl ? `<a href="${escapeHtml(webUrl)}" target="_blank" class="redmine-web-link">🔗 Redmine 웹 ↗</a>` : ''}
            </div>
            <h2 class="wiki-main-title">${escapeHtml(title)}</h2>
            <div class="wiki-meta-row">
                <span>👤 최종 수정: ${escapeHtml(author)}</span>
                <span>🕒 일시: ${updatedOn}</span>
            </div>
            <div class="wiki-action-toolbar">
                <button type="button" class="btn btn-sm btn-secondary" onclick="toggleWikiEditMode()">
                    <span>✏️</span> 편집 모드
                </button>
                <button type="button" class="btn btn-sm btn-secondary" onclick="copyCurrentWikiToMarkdownStudio()">
                    <span>📝</span> Markdown 스튜디오로 복사
                </button>
                <button type="button" class="btn btn-sm btn-secondary" onclick="copyCurrentWikiRawText()">
                    <span>📋</span> 원본 복사
                </button>
            </div>
        </div>

        <div id="wiki-reader-body" class="wiki-body markdown-body">
            ${renderedHtml || '<p class="empty-wiki-text">내용이 비어있습니다.</p>'}
        </div>

        <div id="wiki-editor-body" class="wiki-editor-container" style="display: none;">
            <textarea id="wiki-edit-textarea" class="wiki-textarea" placeholder="위키 마크다운 / 텍스타일 / HTML 본문을 입력하세요..."></textarea>
            <div class="wiki-editor-actions">
                <button type="button" class="btn btn-primary" onclick="submitSaveCurrentWikiPage()">
                    <span>💾</span> 저장 및 위키 발행
                </button>
                <button type="button" class="btn btn-secondary" onclick="cancelCurrentWikiEdit()">
                    <span>✕</span> 취소
                </button>
            </div>
        </div>
    `;

    // 에디터 textarea에 DOM 프로퍼티로 안전하게 값 설정
    const textarea = document.getElementById('wiki-edit-textarea');
    if (textarea) {
        textarea.value = rawText;
    }
}

function renderEmptyWikiDetail() {
    const container = document.getElementById('redmine-wiki-content-pane');
    if (!container) return;
    container.innerHTML = `
        <div class="redmine-empty-placeholder">
            <div class="empty-icon">📖</div>
            <h3>위키 문서를 선택해 주세요</h3>
            <p>좌측 목차에서 문서를 선택하면 기술 문서와 매뉴얼을 열람할 수 있습니다.</p>
        </div>
    `;
}

function toggleWikiEditMode() {
    const reader = document.getElementById('wiki-reader-body');
    const editor = document.getElementById('wiki-editor-body');
    const textarea = document.getElementById('wiki-edit-textarea');
    if (reader && editor) {
        if (textarea && redmineState.currentWikiText !== undefined) {
            textarea.value = redmineState.currentWikiText;
        }
        reader.style.display = 'none';
        editor.style.display = 'flex';
    }
}

function cancelCurrentWikiEdit() {
    const reader = document.getElementById('wiki-reader-body');
    const editor = document.getElementById('wiki-editor-body');
    if (reader && editor) {
        reader.style.display = 'block';
        editor.style.display = 'none';
    }
}

async function submitSaveCurrentWikiPage() {
    const projKey = redmineState.currentWikiProject;
    const title = redmineState.currentWikiTitle;
    const textarea = document.getElementById('wiki-edit-textarea');
    if (!textarea || !projKey || !title) return;
    const text = textarea.value;

    try {
        if (window.eel && typeof eel.save_redmine_wiki_page === 'function') {
            const res = await eel.save_redmine_wiki_page(projKey, title, text)();
            if (res.status === 'success') {
                showToast('위키 저장 완료', `위키 문서 '${title}'가 저장되었습니다! 💾`, '✅');
                await selectWikiPage(projKey, title);
            } else {
                showToast('위키 저장 실패', res.message, '⚠️');
            }
        }
    } catch (e) {
        showToast('저장 오류', e.message || String(e), '⚠️');
    }
}

function copyCurrentWikiToMarkdownStudio() {
    if (typeof switchTab === 'function') {
        switchTab('markdown');
        if (typeof applyLoadedMarkdown === 'function') {
            const text = redmineState.currentWikiText || '';
            const title = redmineState.currentWikiTitle || 'Redmine_Wiki';
            applyLoadedMarkdown(text, `${title}.md`);
            showToast('Markdown 스튜디오 이동', '위키 본문이 마크다운 에디터로 로드되었습니다. 📝', '✅');
        }
    }
}

async function copyCurrentWikiRawText() {
    try {
        const text = redmineState.currentWikiText || '';
        await navigator.clipboard.writeText(text);
        showToast('복사 완료', '위키 원본 코드가 클립보드에 복사되었습니다. 📋', '✅');
    } catch (e) {
        showToast('복사 실패', '클립보드 접근 권한이 없습니다.', '⚠️');
    }
}

// ==========================================
// 6. 새로고침 및 백그라운드 동기화
// ==========================================

async function syncRedmineNow() {
    const syncBtn = document.getElementById('redmine-sync-btn');
    if (syncBtn) syncBtn.classList.add('spinning');

    showToast('Redmine 동기화', '서버로부터 프로젝트, 일감, 메타데이터를 갱신 중...', '🔄');

    try {
        if (window.eel && typeof eel.sync_redmine_all === 'function') {
            const res = await eel.sync_redmine_all(true)();
            if (res.status === 'success') {
                showToast('동기화 완료', `내 일감 ${res.my_issues_count}건, 프로젝트 ${res.projects_count}개 갱신 완료`, '✅');
                await loadRedmineProjectsAndMeta();
                if (redmineState.activeSubTab === 'issues') {
                    await loadRedmineIssues();
                } else if (redmineState.activeSubTab === 'wiki') {
                    await loadRedmineWikiView();
                }
            } else {
                showToast('동기화 실패', res.message, '⚠️');
            }
        }
    } catch (e) {
        showToast('동기화 오류', e.message || String(e), '⚠️');
    } finally {
        if (syncBtn) syncBtn.classList.remove('spinning');
    }
}

function startRedmineBackgroundPolling() {
    if (redmineState.autoSyncTimer) {
        clearInterval(redmineState.autoSyncTimer);
        redmineState.autoSyncTimer = null;
    }

    const intervalMin = (redmineState.config && redmineState.config.sync_interval_min) || 5;
    const intervalMs = Math.max(1, intervalMin) * 60 * 1000;

    redmineState.lastCheckTime = new Date().toISOString();

    redmineState.autoSyncTimer = setInterval(async () => {
        try {
            if (window.eel && typeof eel.check_redmine_updates_for_notification === 'function') {
                const res = await eel.check_redmine_updates_for_notification(redmineState.lastCheckTime)();
                if (res.status === 'success') {
                    redmineState.lastCheckTime = res.checked_at;
                    if (res.new_items && res.new_items.length > 0) {
                        const firstItem = res.new_items[0];
                        showToast(
                            `🔔 Redmine 일감 업데이트 (${res.new_count}건)`,
                            `#${firstItem.id} [${firstItem.tracker}] ${firstItem.subject}`,
                            '🦊',
                            6000
                        );
                    }
                }
            }
        } catch (e) {
            console.warn("Redmine 백그라운드 폴링 오류:", e);
        }
    }, intervalMs);
}

// 필터 이벤트 바인딩
function onRedmineAssigneeFilterChange() {
    const assigneeSelect = document.getElementById('redmine-assignee-filter');
    const myCheckbox = document.getElementById('redmine-filter-my-checkbox');
    const val = assigneeSelect ? assigneeSelect.value : '';
    
    redmineState.filterAssignee = val;
    if (val === 'me') {
        redmineState.filterMyOnly = true;
        if (myCheckbox) myCheckbox.checked = true;
    } else {
        redmineState.filterMyOnly = false;
        if (myCheckbox) myCheckbox.checked = false;
    }
    
    onRedmineFilterChange();
}

function onRedmineMyCheckboxChange() {
    const myCheckbox = document.getElementById('redmine-filter-my-checkbox');
    const assigneeSelect = document.getElementById('redmine-assignee-filter');
    const isChecked = myCheckbox ? myCheckbox.checked : false;
    
    redmineState.filterMyOnly = isChecked;
    if (isChecked) {
        redmineState.filterAssignee = 'me';
        if (assigneeSelect) assigneeSelect.value = 'me';
    } else {
        if (redmineState.filterAssignee === 'me') {
            redmineState.filterAssignee = '';
            if (assigneeSelect) assigneeSelect.value = '';
        }
    }
    
    onRedmineFilterChange();
}

function quickFilterByStat(type) {
    const statusSelect = document.getElementById('redmine-status-filter');
    
    // 통계 카드 active 상태 토글
    document.querySelectorAll('.redmine-stats-summary-bar .stat-card').forEach(c => c.classList.remove('active'));
    const targetCard = document.getElementById(`stat-card-${type}`);
    if (targetCard) targetCard.classList.add('active');

    if (type === 'all') {
        if (statusSelect) statusSelect.value = '';
        redmineState.quickFilterDueToday = false;
    } else if (type === 'progress') {
        redmineState.quickFilterDueToday = false;
        // 메타데이터 상태 중 '진행' 또는 'progress' 매칭
        const progStatus = (redmineState.metadata.statuses || []).find(s => 
            s.name.includes('진행') || s.name.toLowerCase().includes('progress')
        );
        if (statusSelect && progStatus) {
            statusSelect.value = progStatus.id;
        }
    } else if (type === 'new') {
        redmineState.quickFilterDueToday = false;
        // 메타데이터 상태 중 '신규' 또는 'new' 매칭
        const newStatus = (redmineState.metadata.statuses || []).find(s => 
            s.name.includes('신규') || s.name.toLowerCase().includes('new') || s.name.includes('접수')
        );
        if (statusSelect && newStatus) {
            statusSelect.value = newStatus.id;
        }
    } else if (type === 'resolved') {
        redmineState.quickFilterDueToday = false;
        // 메타데이터 상태 중 '해결', '피드백', '완료' 매칭
        const resStatus = (redmineState.metadata.statuses || []).find(s => 
            s.name.includes('해결') || s.name.includes('피드백') || s.name.includes('완료') || s.name.toLowerCase().includes('resolved')
        );
        if (statusSelect && resStatus) {
            statusSelect.value = resStatus.id;
        }
    } else if (type === 'due_today') {
        if (statusSelect) statusSelect.value = '';
        redmineState.quickFilterDueToday = true;
    }

    onRedmineFilterChange();
}

let redmineSearchDebounceTimer = null;

function onRedmineSearchInput(val) {
    clearTimeout(redmineSearchDebounceTimer);
    redmineState.searchQuery = (val || '').trim();
    redmineSearchDebounceTimer = setTimeout(() => {
        onRedmineFilterChange();
    }, 250);
}

function onRedmineFilterChange() {
    clearTimeout(redmineSearchDebounceTimer);

    const projSelect = document.getElementById('redmine-project-filter');
    const statusSelect = document.getElementById('redmine-status-filter');
    const trackerSelect = document.getElementById('redmine-tracker-filter');
    const prioritySelect = document.getElementById('redmine-priority-filter');
    const searchInput = document.getElementById('redmine-search-input');
    const assigneeSelect = document.getElementById('redmine-assignee-filter');
    const myCheckbox = document.getElementById('redmine-filter-my-checkbox');

    redmineState.selectedProjectId = projSelect && projSelect.value ? parseInt(projSelect.value, 10) : null;
    redmineState.filterStatusId = statusSelect && statusSelect.value ? parseInt(statusSelect.value, 10) : null;
    redmineState.filterTrackerId = trackerSelect && trackerSelect.value ? parseInt(trackerSelect.value, 10) : null;
    redmineState.filterPriorityId = prioritySelect && prioritySelect.value ? parseInt(prioritySelect.value, 10) : null;
    redmineState.searchQuery = searchInput ? searchInput.value.trim() : '';
    redmineState.filterAssignee = assigneeSelect ? assigneeSelect.value : '';
    redmineState.filterMyOnly = myCheckbox ? myCheckbox.checked : false;

    // 만약 상태 드롭다운이 변경되었는데 오늘마감 필터가 켜져있었다면 해제
    if (statusSelect && statusSelect.value && redmineState.quickFilterDueToday) {
        redmineState.quickFilterDueToday = false;
    }

    loadRedmineIssues();
}

// ==========================================
// 8. 주요 관심 프로젝트 (⭐ 즐겨찾기) 관리 & 우선 필터링
// ==========================================

let favModalSearchQuery = '';
let tempFavProjectIds = new Set();

function toggleRedmineFavoriteProjectsFilter() {
    const favProjects = redmineState.projects.filter(p => p.is_favorite == 1);
    const favBtn = document.getElementById('redmine-filter-fav-btn');

    if (!redmineState.filterFavoriteProjectsOnly) {
        if (favProjects.length === 0) {
            showToast('주요 프로젝트 설정 필요', '아직 지정된 주요 관심 프로젝트가 없습니다. 관리 창에서 ⭐를 선택해 주세요.', '⭐', 3500);
            openRedmineFavoriteProjectsModal();
            return;
        }
        redmineState.filterFavoriteProjectsOnly = true;
        if (favBtn) favBtn.classList.add('active');
        
        // 특정 단일 프로젝트가 선택되어 있었다면 '전체 프로젝트'로 리셋하여 주요 프로젝트 전체 모아보기
        const projSelect = document.getElementById('redmine-project-filter');
        if (projSelect && projSelect.value) {
            projSelect.value = '';
            redmineState.selectedProjectId = null;
        }
        showToast('주요 프로젝트 필터링', `⭐ 주요 관심 프로젝트 (${favProjects.length}개) 일감을 우선 조회합니다.`, '⭐', 2500);
    } else {
        redmineState.filterFavoriteProjectsOnly = false;
        if (favBtn) favBtn.classList.remove('active');
    }

    onRedmineFilterChange();
}

function openRedmineFavoriteProjectsModal() {
    tempFavProjectIds = new Set(redmineState.projects.filter(p => p.is_favorite == 1).map(p => p.id));
    favModalSearchQuery = '';
    const searchInput = document.getElementById('redmine-fav-proj-search');
    if (searchInput) searchInput.value = '';
    renderFavProjectsModalList();
    const modal = document.getElementById('redmine-fav-projects-modal');
    if (modal) modal.classList.add('show');
}

function closeRedmineFavoriteProjectsModal() {
    const modal = document.getElementById('redmine-fav-projects-modal');
    if (modal) modal.classList.remove('show');
}

function onRedmineFavProjSearchInput(query) {
    favModalSearchQuery = (query || '').toLowerCase().trim();
    renderFavProjectsModalList();
}

function renderFavProjectsModalList() {
    const listContainer = document.getElementById('redmine-fav-projects-list');
    const badgeEl = document.getElementById('fav-projects-count-badge');
    if (!listContainer) return;

    const filtered = redmineState.projects.filter(p => {
        if (!favModalSearchQuery) return true;
        const name = (p.name || '').toLowerCase();
        const ident = (p.identifier || '').toLowerCase();
        return name.includes(favModalSearchQuery) || ident.includes(favModalSearchQuery);
    });

    if (badgeEl) {
        badgeEl.textContent = `총 ${tempFavProjectIds.size}개 프로젝트 선택됨`;
    }

    if (filtered.length === 0) {
        listContainer.innerHTML = `<div class="fav-proj-empty" style="grid-column: 1/-1; text-align: center; padding: 20px; color: #94a3b8;">일치하는 프로젝트가 없습니다.</div>`;
        return;
    }

    listContainer.innerHTML = filtered.map(p => {
        const isChecked = tempFavProjectIds.has(p.id);
        return `
            <div class="fav-proj-card ${isChecked ? 'selected' : ''}" onclick="toggleFavProjectModalItem(${p.id})">
                <input type="checkbox" ${isChecked ? 'checked' : ''} onclick="event.stopPropagation(); toggleFavProjectModalItem(${p.id})">
                <span class="fav-star-icon">${isChecked ? '⭐' : '☆'}</span>
                <div class="fav-proj-info">
                    <span class="fav-proj-name" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</span>
                    <span class="fav-proj-sub">${escapeHtml(p.identifier || '')}</span>
                </div>
            </div>
        `;
    }).join('');
}

function toggleFavProjectModalItem(id) {
    if (tempFavProjectIds.has(id)) {
        tempFavProjectIds.delete(id);
    } else {
        tempFavProjectIds.add(id);
    }
    renderFavProjectsModalList();
}

function batchSelectAllFavProjects(selectAll) {
    if (selectAll) {
        tempFavProjectIds = new Set(redmineState.projects.map(p => p.id));
    } else {
        tempFavProjectIds.clear();
    }
    renderFavProjectsModalList();
}

async function saveRedmineFavoriteProjectsFromModal() {
    try {
        const ids = Array.from(tempFavProjectIds);
        if (window.eel && typeof eel.set_redmine_favorite_projects === 'function') {
            await eel.set_redmine_favorite_projects(ids)();
        }
        // 로컬 상태 동기화
        redmineState.projects.forEach(p => {
            p.is_favorite = tempFavProjectIds.has(p.id) ? 1 : 0;
        });
        // 즐겨찾기 기준 정렬
        redmineState.projects.sort((a, b) => (b.is_favorite || 0) - (a.is_favorite || 0) || a.name.localeCompare(b.name));
        
        renderProjectDropdowns();
        closeRedmineFavoriteProjectsModal();
        showToast('저장 완료', `주요 관심 프로젝트 ${ids.length}개가 등록되었습니다! ⭐`, '✅');
        
        if (redmineState.filterFavoriteProjectsOnly) {
            loadRedmineIssues();
        }
    } catch (e) {
        console.error("즐겨찾기 저장 실패:", e);
        showToast('저장 실패', formatErrorMessage(e), '⚠️');
    }
}

async function toggleProjectFavoriteInline(projectId, event) {
    if (event) event.stopPropagation();
    if (!projectId) return;

    try {
        if (window.eel && typeof eel.toggle_redmine_project_favorite === 'function') {
            const res = await eel.toggle_redmine_project_favorite(projectId)();
            if (res && res.status === 'success') {
                const target = redmineState.projects.find(p => p.id === projectId);
                if (target) {
                    target.is_favorite = res.is_favorite;
                }
                // 재정렬
                redmineState.projects.sort((a, b) => (b.is_favorite || 0) - (a.is_favorite || 0) || a.name.localeCompare(b.name));
                renderProjectDropdowns();
                showToast('주요 프로젝트', res.message, '⭐', 2500);

                if (redmineState.filterFavoriteProjectsOnly) {
                    loadRedmineIssues();
                } else {
                    // 현재 렌더링된 카드 및 상세 헤더 별표 즉시 갱신
                    document.querySelectorAll(`.issue-proj-star-btn[data-project-id="${projectId}"]`).forEach(btn => {
                        btn.className = `issue-proj-star-btn ${res.is_favorite ? 'favorited' : ''}`;
                        btn.textContent = res.is_favorite ? '⭐' : '☆';
                        btn.title = res.is_favorite ? '주요 관심 프로젝트에서 해제' : '주요 관심 프로젝트(⭐)로 등록';
                    });
                    const detailBtn = document.getElementById('detail-proj-star-btn');
                    if (detailBtn && detailBtn.getAttribute('data-project-id') == projectId) {
                        detailBtn.className = `detail-proj-star-btn ${res.is_favorite ? 'favorited' : ''}`;
                        detailBtn.innerHTML = res.is_favorite ? '<span>⭐</span> 주요 프로젝트' : '<span>☆</span> 주요 프로젝트 등록';
                    }
                }
            }
        }
    } catch (e) {
        console.error("인라인 즐겨찾기 토글 실패:", e);
    }
}

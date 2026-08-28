/**
 * Redmine REST API 클라이언트 및 일감/위키 대시보드 모듈
 */

const redmineState = {
    configured: false,
    config: null,
    projects: [],
    metadata: { statuses: [], trackers: [], priorities: [] },
    activeSubTab: 'issues', // 'issues' | 'wiki' | 'config'
    selectedProjectId: null,
    filterMyOnly: true,
    filterStatusId: null,
    filterTrackerId: null,
    filterPriorityId: null,
    searchQuery: '',
    selectedIssueId: null,
    selectedWikiTitle: null,
    wikiEditMode: false,
    autoSyncTimer: null,
    lastCheckTime: null
};

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

    if (redmineState.config) {
        if (urlInput) urlInput.value = redmineState.config.server_url || '';
        if (keyInput) keyInput.value = redmineState.config.api_key || '';
        if (syncCheckbox) syncCheckbox.checked = (redmineState.config.auto_sync !== 0);
        if (intervalSelect) intervalSelect.value = redmineState.config.sync_interval_min || 5;
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

    let url = urlInput ? urlInput.value.trim() : '';
    const key = keyInput ? keyInput.value.trim() : '';
    const autoSync = syncCheckbox ? syncCheckbox.checked : true;
    const intervalMin = intervalSelect ? parseInt(intervalSelect.value, 10) : 5;

    if (!url || !key) {
        showToast('입력 확인', '서버 URL과 API Key를 모두 입력해 주세요.', '⚠️');
        return;
    }

    // URL 지능형 정규화 및 입력창 갱신
    url = normalizeRedmineUrl(url);
    if (urlInput) urlInput.value = url;

    try {
        if (window.eel && typeof eel.save_redmine_config === 'function') {
            const res = await eel.save_redmine_config(url, key, autoSync, intervalMin)();
            if (res.status === 'success') {
                redmineState.configured = true;
                redmineState.config = {
                    server_url: url,
                    api_key: key,
                    user_name: res.user ? res.user.name : '',
                    auto_sync: autoSync ? 1 : 0,
                    sync_interval_min: intervalMin
                };
                updateRedmineHeaderStatus();
                showToast('설정 저장 완료', 'Redmine 연동이 성공적으로 저장되었습니다! 🎉', '✅');
                
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

    const options = [
        '<option value="">전체 프로젝트</option>',
        ...redmineState.projects.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`)
    ].join('');

    if (projSelect) projSelect.innerHTML = options;
    
    if (wikiProjSelect) {
        const wikiOptions = redmineState.projects.map(p => 
            `<option value="${p.identifier || p.id}">${escapeHtml(p.name)}</option>`
        ).join('');
        wikiProjSelect.innerHTML = wikiOptions || '<option value="">등록된 프로젝트 없음</option>';
    }

    if (modalProjSelect) {
        modalProjSelect.innerHTML = [
            '<option value="">프로젝트 선택...</option>',
            ...redmineState.projects.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`)
        ].join('');
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
                redmineState.searchQuery
            )();

            if (res.status === 'success') {
                renderIssueStats(res.stats);
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
                listContainer.innerHTML = `<div class="redmine-error">일감 로드 실패: ${escapeHtml(res.message)}</div>`;
            }
        }
    } catch (e) {
        listContainer.innerHTML = `<div class="redmine-error">오류: ${escapeHtml(e.message || e)}</div>`;
    }
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
                    <span class="issue-project">📁 ${escapeHtml(iss.project_name || '')}</span>
                    <span class="issue-assignee">👤 ${escapeHtml(iss.assigned_to_name || '미배정')}</span>
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
        detailContainer.innerHTML = `<div class="redmine-error">오류: ${escapeHtml(e.message || e)}</div>`;
    }
}

function renderIssueDetail(iss) {
    const container = document.getElementById('redmine-issue-detail-pane');
    if (!container) return;

    const trackerName = (iss.tracker && iss.tracker.name) || iss.tracker_name || '일감';
    const statusName = (iss.status && iss.status.name) || iss.status_name || '신규';
    const priorityName = (iss.priority && iss.priority.name) || iss.priority_name || '보통';
    const authorName = (iss.author && iss.author.name) || iss.author_name || '';
    const assigneeName = (iss.assigned_to && iss.assigned_to.name) || iss.assigned_to_name || '미배정';
    const projectName = (iss.project && iss.project.name) || iss.project_name || '';
    const doneRatio = iss.done_ratio || 0;
    const webUrl = iss.web_url || '';

    // 상태 변경 옵션
    const statusOptions = (redmineState.metadata.statuses || []).map(s => {
        const sel = (s.name === statusName || s.id === (iss.status && iss.status.id)) ? 'selected' : '';
        return `<option value="${s.id}" ${sel}>${escapeHtml(s.name)}</option>`;
    }).join('');

    // 진척도 옵션
    const progressOptions = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map(pct => {
        const sel = (pct === doneRatio) ? 'selected' : '';
        return `<option value="${pct}" ${sel}>${pct}%</option>`;
    }).join('');

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
                        const jNotes = j.notes ? escapeHtml(j.notes).replace(/\n/g, '<br>') : '';
                        
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

    // 본문 설명 (Description) - 마크다운/텍스트 줄바꿈 처리
    const descHtml = iss.description 
        ? `<div class="detail-description-body">${escapeHtml(iss.description).replace(/\n/g, '<br>')}</div>`
        : `<div class="detail-description-body empty">설명이 등록되지 않았습니다.</div>`;

    container.innerHTML = `
        <div class="issue-detail-header">
            <div class="detail-top-row">
                <span class="detail-issue-id">#${iss.id}</span>
                <span class="detail-tracker">${escapeHtml(trackerName)}</span>
                <span class="detail-project">📁 ${escapeHtml(projectName)}</span>
                ${webUrl ? `<a href="${escapeHtml(webUrl)}" target="_blank" class="redmine-web-link" title="Redmine 웹페이지에서 열기">🔗 Redmine 웹 ↗</a>` : ''}
            </div>
            <h2 class="detail-subject">${escapeHtml(iss.subject)}</h2>
            <div class="detail-info-grid">
                <div class="info-cell"><span class="info-lbl">상태:</span> <span class="info-val highlight">${escapeHtml(statusName)}</span></div>
                <div class="info-cell"><span class="info-lbl">우선순위:</span> <span class="info-val">${escapeHtml(priorityName)}</span></div>
                <div class="info-cell"><span class="info-lbl">담당자:</span> <span class="info-val">👤 ${escapeHtml(assigneeName)}</span></div>
                <div class="info-cell"><span class="info-lbl">작성자:</span> <span class="info-val">${escapeHtml(authorName)}</span></div>
                <div class="info-cell"><span class="info-lbl">시작일:</span> <span class="info-val">${iss.start_date || '-'}</span></div>
                <div class="info-cell"><span class="info-lbl">마감일:</span> <span class="info-val">${iss.due_date || '-'}</span></div>
                <div class="info-cell"><span class="info-lbl">진척도:</span> <span class="info-val">${doneRatio}%</span></div>
                <div class="info-cell"><span class="info-lbl">추정시간:</span> <span class="info-val">${iss.estimated_hours ? iss.estimated_hours + 'h' : '-'}</span></div>
            </div>
        </div>

        <!-- 빠른 상태/진척도 변경 바 -->
        <div class="issue-quick-action-bar">
            <div class="action-group">
                <label>상태 변경:</label>
                <select id="quick-issue-status-select" class="form-select" onchange="onQuickStatusChange(${iss.id})">
                    ${statusOptions}
                </select>
            </div>
            <div class="action-group">
                <label>진척도:</label>
                <select id="quick-issue-progress-select" class="form-select" onchange="onQuickProgressChange(${iss.id})">
                    ${progressOptions}
                </select>
            </div>
            <div class="action-group right">
                <button class="btn btn-sm btn-primary" onclick="openCommentModal(${iss.id})">💬 코멘트 등록</button>
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

async function onQuickStatusChange(issueId) {
    const select = document.getElementById('quick-issue-status-select');
    if (!select) return;
    const newStatusId = select.value;

    try {
        if (window.eel && typeof eel.update_redmine_issue === 'function') {
            const res = await eel.update_redmine_issue(issueId, newStatusId)();
            if (res.status === 'success') {
                showToast('상태 변경 완료', `일감 #${issueId} 상태가 갱신되었습니다.`, '✅');
                await loadRedmineIssues();
                await selectRedmineIssue(issueId);
            } else {
                showToast('상태 변경 실패', res.message, '⚠️');
            }
        }
    } catch (e) {
        showToast('오류', e.message || String(e), '⚠️');
    }
}

async function onQuickProgressChange(issueId) {
    const select = document.getElementById('quick-issue-progress-select');
    if (!select) return;
    const newRatio = select.value;

    try {
        if (window.eel && typeof eel.update_redmine_issue === 'function') {
            const res = await eel.update_redmine_issue(issueId, null, newRatio)();
            if (res.status === 'success') {
                showToast('진척도 갱신 완료', `일감 #${issueId} 진척도가 ${newRatio}%로 설정되었습니다.`, '✅');
                await loadRedmineIssues();
                await selectRedmineIssue(issueId);
            } else {
                showToast('진척도 변경 실패', res.message, '⚠️');
            }
        }
    } catch (e) {
        showToast('오류', e.message || String(e), '⚠️');
    }
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
    const subjectInput = document.getElementById('redmine-create-subject');
    const descInput = document.getElementById('redmine-create-desc');
    const dueInput = document.getElementById('redmine-create-due');

    const projectId = projSelect ? projSelect.value : null;
    const trackerId = trackerSelect ? trackerSelect.value : null;
    const priorityId = prioritySelect ? prioritySelect.value : null;
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
                null,
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
        showToast('오류', e.message || String(e), '⚠️');
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
        treeContainer.innerHTML = `<div class="redmine-error">오류: ${escapeHtml(e.message || e)}</div>`;
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
        readerContainer.innerHTML = `<div class="redmine-error">오류: ${escapeHtml(e.message || e)}</div>`;
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

    // 마크다운 파서 렌더링 (Markdown Viewer 내장 파서 활용)
    let renderedHtml = '';
    if (typeof parseMarkdownText === 'function') {
        renderedHtml = parseMarkdownText(rawText);
    } else {
        renderedHtml = escapeHtml(rawText).replace(/\n/g, '<br>');
    }

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
                <button class="btn btn-sm btn-secondary" onclick="toggleWikiEditMode('${escapeJsString(projKey)}', '${escapeJsString(title)}')">
                    <span>✏️</span> 편집 모드
                </button>
                <button class="btn btn-sm btn-secondary" onclick="copyWikiToMarkdownStudio('${escapeJsString(rawText)}')">
                    <span>📝</span> Markdown 스튜디오로 복사
                </button>
                <button class="btn btn-sm btn-secondary" onclick="navigator.clipboard.writeText(\`${escapeJsString(rawText)}\`); showToast('복사 완료', '위키 원본 코드가 클립보드에 복사되었습니다.', '📋');">
                    <span>📋</span> 원본 복사
                </button>
            </div>
        </div>

        <div id="wiki-reader-body" class="wiki-body markdown-body">
            ${renderedHtml || '<p class="empty-wiki-text">내용이 비어있습니다.</p>'}
        </div>

        <div id="wiki-editor-body" class="wiki-editor-container" style="display: none;">
            <textarea id="wiki-edit-textarea" class="wiki-textarea" placeholder="위키 마크다운 / 텍스타일 본문을 입력하세요...">${escapeHtml(rawText)}</textarea>
            <div class="wiki-editor-actions">
                <button class="btn btn-primary" onclick="submitSaveWikiPage('${escapeJsString(projKey)}', '${escapeJsString(title)}')">
                    <span>💾</span> 저장 및 위키 발행
                </button>
                <button class="btn btn-secondary" onclick="cancelWikiEdit('${escapeJsString(projKey)}', '${escapeJsString(title)}')">
                    <span>✕</span> 취소
                </button>
            </div>
        </div>
    `;
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

function toggleWikiEditMode(projKey, title) {
    const reader = document.getElementById('wiki-reader-body');
    const editor = document.getElementById('wiki-editor-body');
    if (reader && editor) {
        reader.style.display = 'none';
        editor.style.display = 'flex';
    }
}

function cancelWikiEdit(projKey, title) {
    const reader = document.getElementById('wiki-reader-body');
    const editor = document.getElementById('wiki-editor-body');
    if (reader && editor) {
        reader.style.display = 'block';
        editor.style.display = 'none';
    }
}

async function submitSaveWikiPage(projKey, title) {
    const textarea = document.getElementById('wiki-edit-textarea');
    if (!textarea) return;
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

function copyWikiToMarkdownStudio(text) {
    if (typeof switchTab === 'function') {
        switchTab('markdown');
        if (typeof applyLoadedMarkdown === 'function') {
            applyLoadedMarkdown(text, 'Redmine_Wiki.md');
            showToast('Markdown 스튜디오 이동', '위키 본문이 마크다운 에디터로 로드되었습니다. 📝', '✅');
        }
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
function onRedmineFilterChange() {
    const projSelect = document.getElementById('redmine-project-filter');
    const statusSelect = document.getElementById('redmine-status-filter');
    const trackerSelect = document.getElementById('redmine-tracker-filter');
    const prioritySelect = document.getElementById('redmine-priority-filter');
    const searchInput = document.getElementById('redmine-search-input');
    const myCheckbox = document.getElementById('redmine-filter-my-checkbox');

    redmineState.selectedProjectId = projSelect && projSelect.value ? parseInt(projSelect.value, 10) : null;
    redmineState.filterStatusId = statusSelect && statusSelect.value ? parseInt(statusSelect.value, 10) : null;
    redmineState.filterTrackerId = trackerSelect && trackerSelect.value ? parseInt(trackerSelect.value, 10) : null;
    redmineState.filterPriorityId = prioritySelect && prioritySelect.value ? parseInt(prioritySelect.value, 10) : null;
    redmineState.searchQuery = searchInput ? searchInput.value.trim() : '';
    redmineState.filterMyOnly = myCheckbox ? myCheckbox.checked : true;

    loadRedmineIssues();
}

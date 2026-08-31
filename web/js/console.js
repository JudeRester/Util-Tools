/**
 * 콘솔 로그 출력 및 하단 스플리터(높이 조절기) 모듈
 * - [📋 최근 실행 결과]: 사용자가 실행한 도구/생성기/스크립트의 최신 단일 결과 출력
 * - [📜 시스템 로그]: 백엔드 에러/예외, API 통신 장애, 런타임 이벤트가 시간 순서대로 영구 누적
 */

if (typeof window.escapeHtml !== 'function') {
    window.escapeHtml = function(str) {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    };
}

const consoleState = {
    activeTab: 'result', // 'result' | 'logs'
    lastResult: '기능 버튼을 클릭하면 여기에 최근 실행 결과가 표시됩니다.',
    logs: [], // { id, time, level: 'info'|'warn'|'error'|'success', category, message, details }
    logFilter: 'all' // 'all' | 'error' | 'warn' | 'info'
};

// ==========================================
// 1. 탭 전환 & 필터 관리
// ==========================================

function switchConsoleTab(tab) {
    consoleState.activeTab = tab;
    const resultBtn = document.getElementById('console-tab-result-btn');
    const logsBtn = document.getElementById('console-tab-logs-btn');
    const resultView = document.getElementById('console-output');
    const logsView = document.getElementById('console-logs-stream');
    const filtersBar = document.getElementById('console-log-filters');

    if (tab === 'result') {
        if (resultBtn) resultBtn.classList.add('active');
        if (logsBtn) logsBtn.classList.remove('active');
        if (resultView) {
            resultView.style.display = 'block';
            resultView.classList.add('active');
        }
        if (logsView) {
            logsView.style.display = 'none';
            logsView.classList.remove('active');
        }
        if (filtersBar) filtersBar.style.display = 'none';
    } else {
        if (resultBtn) resultBtn.classList.remove('active');
        if (logsBtn) logsBtn.classList.add('active');
        if (resultView) {
            resultView.style.display = 'none';
            resultView.classList.remove('active');
        }
        if (logsView) {
            logsView.style.display = 'flex';
            logsView.classList.add('active');
            logsView.scrollTop = logsView.scrollHeight;
        }
        if (filtersBar) filtersBar.style.display = 'inline-flex';
    }
}

function setSystemLogFilter(filter) {
    consoleState.logFilter = filter;

    // 필터 버튼 활성화 상태 갱신
    document.querySelectorAll('.log-filter-btn').forEach(btn => {
        btn.classList.toggle('active', btn.getAttribute('data-filter') === filter);
    });

    // 로그 항목 필터링 표시/숨김
    const logsStreamEl = document.getElementById('console-logs-stream');
    if (!logsStreamEl) return;

    const entries = logsStreamEl.querySelectorAll('.log-entry');
    entries.forEach(entry => {
        const level = entry.getAttribute('data-level');
        if (filter === 'all' || level === filter) {
            entry.style.display = 'block';
        } else {
            entry.style.display = 'none';
        }
    });
}

// ==========================================
// 2. 최근 실행 결과 (Execution Result Only)
// ==========================================

function setExecutionResult(title, content) {
    const timestamp = new Date().toLocaleTimeString();
    let detailStr = '';
    if (typeof content === 'object' && content !== null) {
        try {
            detailStr = JSON.stringify(content, null, 2);
        } catch (e) {
            detailStr = String(content);
        }
    } else {
        detailStr = String(content !== undefined && content !== null ? content : '');
    }

    let textContent = `[${timestamp}] ${title}\n`;
    if (detailStr) {
        textContent += detailStr;
    }
    consoleState.lastResult = textContent;

    const consoleEl = document.getElementById('console-output');
    if (consoleEl) {
        consoleEl.textContent = textContent;
        consoleEl.scrollTop = 0;
    }

    // 하단 콘솔이 접혀있을 때 실시간 토스트 팝업
    if (isConsoleCollapsed) {
        showToast(title, content);
    }
}

// 기존 코드와의 100% 호환을 위한 alias
function logToConsole(title, content) {
    setExecutionResult(title, content);
}

// ==========================================
// 3. 시스템 로그 스트림 (Backend Errors & Diagnostics)
// ==========================================

function logSystemEvent(level = 'info', category = 'System', message = '', details = '') {
    const fullTimeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    const logItem = {
        id: `${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
        time: fullTimeStr,
        level: level,
        category: category,
        message: String(message || ''),
        details: String(details || '')
    };

    consoleState.logs.push(logItem);
    if (consoleState.logs.length > 1000) {
        consoleState.logs.shift();
    }

    // 뱃지 및 에러 강조 갱신
    updateSystemLogBadge();

    // DOM에 로그 엘리먼트 추가
    const logsStreamEl = document.getElementById('console-logs-stream');
    if (logsStreamEl) {
        const emptyMsg = logsStreamEl.querySelector('.console-log-empty');
        if (emptyMsg) emptyMsg.remove();

        const logRow = document.createElement('div');
        logRow.className = `log-entry log-entry-${level}`;
        logRow.setAttribute('data-level', level);

        // 현재 필터 조건 적용
        if (consoleState.logFilter !== 'all' && consoleState.logFilter !== level) {
            logRow.style.display = 'none';
        }

        let detailsHtml = '';
        if (logItem.details) {
            detailsHtml = `
                <div class="log-entry-details">
                    <pre>${escapeHtml(logItem.details)}</pre>
                </div>
            `;
        }

        logRow.innerHTML = `
            <div class="log-entry-header">
                <span class="log-time">${escapeHtml(fullTimeStr)}</span>
                <span class="log-cat-badge">${escapeHtml(category)}</span>
                <span class="log-title">${escapeHtml(logItem.message)}</span>
            </div>
            ${detailsHtml}
        `;

        logsStreamEl.appendChild(logRow);

        // 사용자가 로그 탭을 보고 있을 때 자동 최하단 스크롤
        if (consoleState.activeTab === 'logs') {
            logsStreamEl.scrollTop = logsStreamEl.scrollHeight;
        }
    }

    // 에러 발생 시 토스트로도 알림
    if (level === 'error' && isConsoleCollapsed) {
        showToast(`🚨 [${category}] 에러`, message, '❌', 4500);
    }
}

function updateSystemLogBadge() {
    const badge = document.getElementById('console-log-count-badge');
    if (!badge) return;

    const total = consoleState.logs.length;
    const errors = consoleState.logs.filter(l => l.level === 'error').length;

    if (errors > 0) {
        badge.textContent = `🚨 ${errors} | ${total}`;
        badge.classList.add('has-error');
    } else {
        badge.textContent = `${total}`;
        badge.classList.remove('has-error');
    }
}

// Eel 백엔드에서 호출하는 실시간 로그 리스너
if (window.eel) {
    window.eel.expose(on_backend_log);
}
function on_backend_log(level, category, message, details) {
    logSystemEvent(level, category, message, details);
}

// 앱 부팅 시 백엔드 버퍼 로그 동기화 및 전역 JS 에러 핸들러 설정
async function initSystemLogger() {
    // 1. 백엔드 초기 로그 가져오기
    if (window.eel && typeof eel.get_backend_system_logs === 'function') {
        try {
            const logs = await eel.get_backend_system_logs()();
            if (Array.isArray(logs) && logs.length > 0) {
                logs.forEach(l => {
                    logSystemEvent(l.level, l.category, l.message, l.details);
                });
            }
        } catch (e) {
            console.error('Failed to load initial backend logs:', e);
        }
    }

    // 2. 브라우저 전역 에러 핸들러 등록
    window.addEventListener('error', (e) => {
        const stack = e.error && e.error.stack ? e.error.stack : `${e.filename || 'unknown'}:${e.lineno || 0}:${e.colno || 0}`;
        logSystemEvent('error', 'JS Runtime', e.message || 'JavaScript 런타임 오류', stack);
    });

    window.addEventListener('unhandledrejection', (e) => {
        const reason = e.reason;
        const msg = (reason && reason.message) || String(reason || 'Unhandled Promise Rejection');
        const stack = (reason && reason.stack) || '';
        logSystemEvent('error', 'Promise Rejection', msg, stack);
    });
}

// 자동 초기화 실행
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initSystemLogger);
} else {
    initSystemLogger();
}

// ==========================================
// 4. 지우기 & 복사
// ==========================================

function clearConsole() {
    if (consoleState.activeTab === 'result') {
        consoleState.lastResult = '기능 버튼을 클릭하면 여기에 최근 실행 결과가 표시됩니다.';
        const consoleEl = document.getElementById('console-output');
        if (consoleEl) {
            consoleEl.textContent = consoleState.lastResult;
        }
        showToast('실행 결과 초기화', '최근 실행 결과 창이 비워졌습니다.', '🧹', 2000);
    } else {
        consoleState.logs = [];
        const logsStreamEl = document.getElementById('console-logs-stream');
        if (logsStreamEl) {
            logsStreamEl.innerHTML = '<div class="console-log-empty">시스템 로그가 비워졌습니다. 새로운 시스템 이벤트나 백엔드 에러가 발생하면 계속 누적됩니다.</div>';
        }
        updateSystemLogBadge();
        showToast('시스템 로그 초기화', '누적된 시스템 로그가 모두 비워졌습니다.', '🧹', 2000);
    }
}

async function copyConsoleOutput() {
    let textToCopy = '';
    if (consoleState.activeTab === 'result') {
        const consoleEl = document.getElementById('console-output');
        textToCopy = consoleEl ? consoleEl.textContent : '';
    } else {
        if (consoleState.logs.length === 0) {
            showToast('복사 알림', '복사할 시스템 로그가 없습니다.', '⚠️');
            return;
        }
        textToCopy = consoleState.logs.map(l => {
            return `[${l.time}] [${(l.level || 'info').toUpperCase()}] [${l.category || 'System'}] ${l.message}${l.details ? '\n' + l.details : ''}`;
        }).join('\n\n----------------------------------------\n\n');
    }

    if (textToCopy) {
        try {
            await navigator.clipboard.writeText(textToCopy);
            const tabName = consoleState.activeTab === 'result' ? '최근 실행 결과' : '전체 시스템 로그';
            showToast('복사 완료', `${tabName}가 클립보드에 복사되었습니다! 📋`, '✅');
        } catch (e) {
            showToast('복사 실패', String(e), '⚠️');
        }
    }
}

function showToast(title, content, icon = '🔔', duration = 3800) {
    const container = document.getElementById('toast-container');
    if (!container) return;

    let bodyText = '';
    if (typeof content === 'object' && content !== null) {
        try {
            bodyText = JSON.stringify(content);
        } catch (e) {
            bodyText = String(content);
        }
    } else {
        bodyText = String(content || '');
    }

    const toast = document.createElement('div');
    toast.className = 'toast-card';
    toast.title = '클릭하면 하단 로그창이 펼쳐집니다';
    
    const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    const formattedBody = escapeHtml(bodyText).replace(/\n/g, '<br>');

    toast.innerHTML = `
        <div class="toast-header">
            <span class="toast-title">${icon} ${escapeHtml(title)}</span>
            <span class="toast-time">${timeStr}</span>
        </div>
        <div class="toast-body">${formattedBody}</div>
        <div class="toast-tip">클릭하여 로그창 열기 ↗</div>
    `;

    // 클릭 시 로그창 펼치기 및 토스트 닫기
    toast.addEventListener('click', () => {
        if (isConsoleCollapsed) {
            toggleConsole();
        }
        removeToast(toast);
    });

    // 자동 소멸 타이머 관리 (마우스 오버 시 일시 정지, 벗어나면 재개)
    let autoRemoveTimer = null;
    const DURATION = duration || 3800;

    function startTimer() {
        if (autoRemoveTimer) clearTimeout(autoRemoveTimer);
        autoRemoveTimer = setTimeout(() => {
            removeToast(toast);
        }, DURATION);
    }

    function stopTimer() {
        if (autoRemoveTimer) {
            clearTimeout(autoRemoveTimer);
            autoRemoveTimer = null;
        }
    }

    toast.addEventListener('mouseenter', stopTimer);
    toast.addEventListener('mouseleave', startTimer);

    startTimer();

    // 최대 3개까지만 유지 (화면 가림 방지 및 초과분 즉시 DOM 제거)
    while (container.children.length > 3) {
        const first = container.firstElementChild;
        if (first) {
            container.removeChild(first);
        } else {
            break;
        }
    }
}

function removeToast(toast, immediate = false) {
    if (!toast) return;
    if (immediate) {
        if (toast.parentNode) {
            toast.parentNode.removeChild(toast);
        }
        return;
    }
    if (toast.classList.contains('hide')) return;
    toast.classList.add('hide');
    setTimeout(() => {
        if (toast && toast.parentNode) {
            toast.parentNode.removeChild(toast);
        }
    }, 350);
}

function showAppToast(message, type = 'info') {
    const title = type === 'success' ? '완료' : type === 'error' ? '오류' : type === 'warning' ? '경고' : '알림';
    showToast(title, message);
}

let isConsoleCollapsed = false;

function toggleConsole() {
    const consoleEl = document.getElementById('app-console');
    const toggleIcon = document.getElementById('console-toggle-icon');
    const toggleText = document.getElementById('console-toggle-text');
    if (!consoleEl) return;

    isConsoleCollapsed = !isConsoleCollapsed;

    if (isConsoleCollapsed) {
        consoleEl.classList.add('collapsed');
        if (toggleIcon) toggleIcon.textContent = '🔼';
        if (toggleText) toggleText.textContent = '펼치기';
    } else {
        consoleEl.classList.remove('collapsed');
        if (toggleIcon) toggleIcon.textContent = '🔽';
        if (toggleText) toggleText.textContent = '접기';

        // 저장된 높이 복원
        const savedHeight = (typeof appSettings !== 'undefined' && appSettings.console_height) || localStorage.getItem('console_height') || 180;
        consoleEl.style.height = `${savedHeight}px`;
    }

    if (typeof saveAppSettingKey === 'function') {
        saveAppSettingKey('console_collapsed', isConsoleCollapsed);
    }
}

function initConsoleResizer() {
    const resizer = document.getElementById('console-resizer');
    const consoleEl = document.getElementById('app-console');
    if (!resizer || !consoleEl) return;

    // 저장된 접힘 상태 복원
    const savedCollapsed = (typeof appSettings !== 'undefined' && appSettings.console_collapsed) || false;
    if (savedCollapsed) {
        isConsoleCollapsed = true;
        consoleEl.classList.add('collapsed');
        const toggleIcon = document.getElementById('console-toggle-icon');
        const toggleText = document.getElementById('console-toggle-text');
        if (toggleIcon) toggleIcon.textContent = '🔼';
        if (toggleText) toggleText.textContent = '펼치기';
    } else {
        // 저장된 높이 복원
        const savedHeight = (typeof appSettings !== 'undefined' && appSettings.console_height) || localStorage.getItem('console_height');
        if (savedHeight) {
            consoleEl.style.height = `${savedHeight}px`;
        }
    }

    let isDragging = false;
    let startY = 0;
    let startHeight = 0;

    resizer.addEventListener('mousedown', (e) => {
        // 접힌 상태에서 드래그 시 자동으로 펼치기
        if (isConsoleCollapsed) {
            isConsoleCollapsed = false;
            consoleEl.classList.remove('collapsed');
            const toggleIcon = document.getElementById('console-toggle-icon');
            const toggleText = document.getElementById('console-toggle-text');
            if (toggleIcon) toggleIcon.textContent = '🔽';
            if (toggleText) toggleText.textContent = '접기';
            if (typeof saveAppSettingKey === 'function') {
                saveAppSettingKey('console_collapsed', false);
            }
        }

        isDragging = true;
        startY = e.clientY;
        startHeight = consoleEl.getBoundingClientRect().height;

        resizer.classList.add('dragging');
        document.body.style.cursor = 'row-resize';
        document.body.style.userSelect = 'none';

        const onMouseMove = (moveEvent) => {
            if (!isDragging) return;
            const deltaY = startY - moveEvent.clientY;
            let newHeight = startHeight + deltaY;

            // 최소 48px, 최대 80vh 범위 제한
            const minHeight = 48;
            const maxHeight = window.innerHeight * 0.8;
            newHeight = Math.max(minHeight, Math.min(newHeight, maxHeight));

            consoleEl.style.height = `${newHeight}px`;
        };

        const onMouseUp = () => {
            if (isDragging) {
                isDragging = false;
                resizer.classList.remove('dragging');
                document.body.style.cursor = '';
                document.body.style.userSelect = '';

                // 최종 높이 백엔드 파일 및 로컬 저장
                const finalHeight = Math.round(consoleEl.getBoundingClientRect().height);
                if (typeof saveAppSettingKey === 'function') {
                    saveAppSettingKey('console_height', finalHeight);
                } else {
                    localStorage.setItem('console_height', finalHeight);
                }

                document.removeEventListener('mousemove', onMouseMove);
                document.removeEventListener('mouseup', onMouseUp);
            }
        };

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
    });
}

// ==========================================
// 공통 인레이어 팝업 다이얼로그 (In-Layer Alert & Confirm)
// ==========================================

function showAppAlert(message, title = '알림', icon = 'ℹ️') {
    return new Promise((resolve) => {
        const modal = document.getElementById('app-dialog-modal');
        const iconEl = document.getElementById('dialog-icon');
        const titleEl = document.getElementById('dialog-title');
        const msgEl = document.getElementById('dialog-message');
        const cancelBtn = document.getElementById('dialog-cancel-btn');
        const confirmBtn = document.getElementById('dialog-confirm-btn');
        if (!modal) {
            console.log(`[Alert] ${title}: ${message}`);
            return resolve();
        }

        iconEl.textContent = icon;
        titleEl.textContent = title;
        msgEl.textContent = message;
        cancelBtn.style.display = 'none';
        confirmBtn.className = 'form-btn add-btn';
        confirmBtn.textContent = '확인';

        const cleanup = () => {
            modal.classList.remove('show');
            document.removeEventListener('keydown', onKeyDown);
        };

        const onConfirm = () => {
            cleanup();
            resolve();
        };

        const onKeyDown = (e) => {
            if (e.key === 'Enter' || e.key === 'Escape') {
                e.preventDefault();
                onConfirm();
            }
        };

        confirmBtn.onclick = onConfirm;
        document.addEventListener('keydown', onKeyDown);
        modal.classList.add('show');
        confirmBtn.focus();
    });
}

function showAppConfirm(message, options = {}) {
    const opts = typeof options === 'string' ? { title: options } : options;
    const {
        title = '확인',
        icon = '❓',
        confirmText = '확인',
        cancelText = '취소',
        isDanger = false
    } = opts;

    return new Promise((resolve) => {
        const modal = document.getElementById('app-dialog-modal');
        const iconEl = document.getElementById('dialog-icon');
        const titleEl = document.getElementById('dialog-title');
        const msgEl = document.getElementById('dialog-message');
        const cancelBtn = document.getElementById('dialog-cancel-btn');
        const confirmBtn = document.getElementById('dialog-confirm-btn');
        if (!modal) return resolve(false);

        iconEl.textContent = icon;
        titleEl.textContent = title;
        msgEl.textContent = message;
        cancelBtn.style.display = 'inline-block';
        cancelBtn.textContent = cancelText;
        confirmBtn.className = isDanger ? 'form-btn danger-btn' : 'form-btn add-btn';
        confirmBtn.textContent = confirmText;

        const cleanup = () => {
            modal.classList.remove('show');
            document.removeEventListener('keydown', onKeyDown);
        };

        const onConfirm = () => {
            cleanup();
            resolve(true);
        };

        const onCancel = () => {
            cleanup();
            resolve(false);
        };

        const onKeyDown = (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                onConfirm();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                onCancel();
            }
        };

        confirmBtn.onclick = onConfirm;
        cancelBtn.onclick = onCancel;
        document.addEventListener('keydown', onKeyDown);
        modal.classList.add('show');
        confirmBtn.focus();
    });
}


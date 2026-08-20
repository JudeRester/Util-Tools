/**
 * 콘솔 로그 출력 및 하단 스플리터(높이 조절기) 모듈
 */

function logToConsole(title, content) {
    const consoleEl = document.getElementById('console-output');
    if (!consoleEl) return;
    const timestamp = new Date().toLocaleTimeString();
    
    let textContent = `[${timestamp}] ${title}\n`;
    if (typeof content === 'object') {
        textContent += JSON.stringify(content, null, 2);
    } else {
        textContent += content;
    }
    
    consoleEl.textContent = textContent;
    consoleEl.scrollTop = 0;

    // 하단 로그창이 접혀있는 상태인 경우 우측 하단에 실시간 토스트 알림 팝업!
    if (isConsoleCollapsed) {
        showToast(title, content);
    }
}

function showToast(title, content) {
    const container = document.getElementById('toast-container');
    if (!container) return;

    let bodyText = '';
    if (typeof content === 'object') {
        try {
            // 깔끔한 1줄 요약
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

    toast.innerHTML = `
        <div class="toast-header">
            <span class="toast-title">🔔 ${escapeHtml(title)}</span>
            <span class="toast-time">${timeStr}</span>
        </div>
        <div class="toast-body">${escapeHtml(bodyText)}</div>
        <div class="toast-tip">클릭하여 로그창 열기 ↗</div>
    `;

    // 클릭 시 로그창 펼치기 및 토스트 닫기
    toast.addEventListener('click', () => {
        if (isConsoleCollapsed) {
            toggleConsole();
        }
        removeToast(toast);
    });

    container.appendChild(toast);

    // 최대 3개까지만 유지 (화면 가림 방지)
    while (container.children.length > 3) {
        removeToast(container.firstElementChild);
    }

    // 3.8초 후 자동 제거
    setTimeout(() => {
        removeToast(toast);
    }, 3800);
}

function removeToast(toast) {
    if (!toast || toast.classList.contains('hide')) return;
    toast.classList.add('hide');
    setTimeout(() => {
        if (toast && toast.parentNode) {
            toast.parentNode.removeChild(toast);
        }
    }, 350);
}

function clearConsole() {
    const consoleEl = document.getElementById('console-output');
    if (consoleEl) {
        consoleEl.textContent = '로그가 초기화되었습니다.';
    }
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

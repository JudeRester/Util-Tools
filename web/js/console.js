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
}

function clearConsole() {
    const consoleEl = document.getElementById('console-output');
    if (consoleEl) {
        consoleEl.textContent = '로그가 초기화되었습니다.';
    }
}

function initConsoleResizer() {
    const resizer = document.getElementById('console-resizer');
    const consoleEl = document.getElementById('app-console');
    if (!resizer || !consoleEl) return;

    // 저장된 높이 복원
    const savedHeight = (typeof appSettings !== 'undefined' && appSettings.console_height) || localStorage.getItem('console_height');
    if (savedHeight) {
        consoleEl.style.height = `${savedHeight}px`;
    }

    let isDragging = false;
    let startY = 0;
    let startHeight = 0;

    resizer.addEventListener('mousedown', (e) => {
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

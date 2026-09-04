/**
 * 시스템 사양 조회, 타임스탬프, 네트워크 핑 호출 모듈
 */

async function callGetSystemInfo() {
    logToConsole('시스템 정보 조회 중...', '잠시만 기다려주세요 (Local 및 Public IP 확인 중)...');
    try {
        if (window.eel && eel.get_system_info) {
            const result = await eel.get_system_info()();
            if (result.status === 'success') {
                logToConsole('시스템 사양 및 네트워크 정보', result.data);
            } else {
                logToConsole('시스템 정보 조회 오류', result.message);
            }
        } else {
            logToConsole('실행 환경 안내', 'Eel 백엔드 연결 환경에서 실행 가능합니다.');
        }
    } catch (err) {
        logToConsole('호출 실패', err.message || err);
    }
}

async function callGetTimestamp() {
    try {
        if (window.eel && eel.get_current_timestamp) {
            const result = await eel.get_current_timestamp()();
            logToConsole('현재 타임스탬프', result.data);
        } else {
            const now = new Date();
            logToConsole('현재 타임스탬프 (브라우저)', {
                formatted: now.toLocaleString(),
                iso: now.toISOString(),
                timestamp: Math.floor(now.getTime() / 1000)
            });
        }
    } catch (err) {
        logToConsole('호출 실패', err.message || err);
    }
}

async function callCheckPing(host) {
    logToConsole(`Ping 테스트 진행 중: ${host}`, '응답을 대기하고 있습니다...');
    try {
        if (window.eel && eel.check_network_ping) {
            const result = await eel.check_network_ping(host)();
            logToConsole(`Ping 결과: ${host}`, result.message);
        } else {
            logToConsole('실행 환경 안내', 'Ping 테스트는 백엔드 환경에서만 지원됩니다.');
        }
    } catch (err) {
        logToConsole('호출 실패', err.message || err);
    }
}

/**
 * 백엔드 서버 및 트레이 완전 종료 확인 모달 (Non-blocking In-layer Confirm)
 */
async function confirmShutdownApp(event) {
    if (event) event.stopPropagation();

    const confirmed = await showAppConfirm(
        'Utility Toolkit 백엔드 서버와 트레이 프로세스를 완전히 종료하시겠습니까?\n\n현재 열려 있는 웹 창과 백그라운드 프로세스가 즉시 종료됩니다.',
        {
            title: '애플리케이션 완전 종료',
            icon: '🚪',
            confirmText: '완전 종료',
            cancelText: '취소',
            danger: true
        }
    );

    if (!confirmed) return;

    try {
        if (typeof showToast === 'function') {
            showToast('백엔드 서버 및 애플리케이션을 종료합니다...', 'info');
        }
        if (window.eel && eel.shutdown_app) {
            await eel.shutdown_app()();
        }
        setTimeout(() => {
            window.close();
        }, 500);
    } catch (e) {
        console.error('서버 종료 요청 실패:', e);
        window.close();
    }
}

/**
 * 백엔드 서버 재시작 확인 모달 (파이썬 코드 변경 반영)
 */
async function confirmRestartApp(event) {
    if (event) event.stopPropagation();

    const confirmed = await showAppConfirm(
        '백엔드 서버를 재시작하시겠습니까?\n\n수정된 파이썬(.py) 코드가 즉시 반영되며, 새 윈도우 창이 자동으로 다시 열립니다.',
        {
            title: '백엔드 서버 재시작',
            icon: '🔄',
            confirmText: '재시작',
            cancelText: '취소'
        }
    );

    if (!confirmed) return;

    try {
        if (typeof showToast === 'function') {
            showToast('백엔드 서버를 재시작하는 중입니다. 잠시 후 새 창이 열립니다...', 'info');
        }
        if (window.eel && eel.restart_app) {
            await eel.restart_app()();
        }
        setTimeout(() => {
            window.close();
        }, 600);
    } catch (e) {
        console.error('서버 재시작 요청 실패:', e);
    }
}


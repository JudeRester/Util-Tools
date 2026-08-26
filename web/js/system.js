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


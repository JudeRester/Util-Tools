/**
 * 한국 사업자등록번호 생성 및 데이터 생성기 모듈
 */

function generateValidBizID(formatted) {
    const weights = [1, 3, 7, 1, 3, 7, 1, 3, 5];
    const digits = [];
    let chkSum = 0;
    let i;

    // 앞자리가 0이 되지 않도록 생성 (1~9)
    digits[0] = Math.floor(Math.random() * 9) + 1;

    // 나머지 앞 8자리 생성 (0~9)
    for (i = 1; i < 9; i++) {
        digits[i] = Math.floor(Math.random() * 10);
    }

    // 첫 8자리 계산
    for (i = 0; i <= 7; i++) {
        chkSum += weights[i] * digits[i];
    }

    // 9번째 자리 × 5의 십의 자리와 일의 자리 합산
    const ninthProduct = weights[8] * digits[8];
    chkSum += Math.floor(ninthProduct / 10);
    chkSum += ninthProduct % 10;

    // 마지막 검증 숫자 생성
    digits[9] = (10 - (chkSum % 10)) % 10;

    const value = digits.join("");

    if (formatted) {
        return value.substring(0, 3)
            + "-"
            + value.substring(3, 5)
            + "-"
            + value.substring(5);
    }

    return value;
}

function generateFrontendBizID(formatted) {
    const bizId = generateValidBizID(formatted);

    logToConsole('사업자등록번호 생성 (프론트엔드)', {
        번호: bizId,
        형식: formatted ? '포맷 적용 (000-00-00000)' : '숫자만 (10자리)',
        설명: '국세청 유효성 검증 알고리즘 통과 번호 (클립보드 복사됨)'
    });

    copyTextToClipboard(bizId, `${bizId} 이(가) 클립보드에 복사되었습니다.`);
}

function generateBulkFrontendBizID() {
    const list = [];
    for (let i = 0; i < 5; i++) {
        list.push(generateValidBizID(true));
    }

    logToConsole('사업자등록번호 5개 일괄 생성', {
        생성목록: list,
        설명: '클립보드에 줄바꿈으로 복사되었습니다.'
    });

    copyTextToClipboard(list.join('\n'), '사업자등록번호 5개가 클립보드에 복사되었습니다.');
}

async function generateBackendBizID(formatted) {
    try {
        if (window.eel && eel.generate_biz_id) {
            const res = await eel.generate_biz_id(formatted, 1)();
            if (res.status === 'success') {
                const bizId = res.data;

                logToConsole('사업자등록번호 생성 (Python 백엔드)', {
                    번호: bizId,
                    형식: formatted ? '포맷 적용' : '숫자만',
                    설명: '클립보드에 복사되었습니다.'
                });

                copyTextToClipboard(bizId, `${bizId} 이(가) 클립보드에 복사되었습니다.`);
            }
        } else {
            generateFrontendBizID(formatted);
        }
    } catch (err) {
        logToConsole('사업자등록번호 생성 오류', err.message || err);
    }
}

async function copyTextToClipboard(text, successMsg) {
    try {
        await navigator.clipboard.writeText(text);
        if (successMsg) logToConsole('클립보드 복사 완료', successMsg);
    } catch (err) {
        console.error('클립보드 복사 실패:', err);
    }
}

// HTML onclick 호환용 래퍼 함수들
function callGenerateBizID(formatted) {
    generateFrontendBizID(formatted);
}

function callGenerateBizIDBulk(count) {
    generateBulkFrontendBizID();
}


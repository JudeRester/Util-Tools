/**
 * web/js/ocr.js - Util-Tools 로컬 OCR(광학 문자 인식) 스튜디오 클라이언트 모듈
 * - 기본 엔진: Windows.Media.Ocr (via winocr)
 * - 런타임 언어 capability 검사 및 안내 배너
 * - 캔버스 렌더링, 라인/단어 Bounding Box 오버레이 및 클릭 클립보드 복사
 * - 마우스 드래그 기반 관심 영역(ROI) Crop -> 재인식 -> 원본 좌표 오프셋 복원
 * - 실측 지연시간(latency_ms) 벤치마크 뱃지 표시
 * - 이미지 슬라이서(slicer) 인메모리 zero-disk 연동 브리지
 * - 빠른 메모(notes) 연동 브리지 (createNoteWithContent 직접 재사용)
 * - OCR 탭 수명주기 스코프 paste 이벤트 바인딩 (initOcrStudio / teardownOcrStudio)
 * - 비차단 인레이어 UI 규정 준수 (showToast, showAppConfirm, showAppAlert)
 */

let ocrState = {
    sourceId: null,           // opaque source handle from backend
    currentRequestId: 0,      // 비동기 요청 식별 세대 번호 (race 및 stale 응답 차단)
    image: null,              // Image DOM object
    dataUrl: null,            // string (data:image/...) legacy fallback
    sourceType: 'clipboard',  // 'clipboard' | 'file' | 'slicer' | 'roi'
    filename: '',             // string
    lang: 'ko',               // 'ko' | 'en'
    rotation: 0,              // 0, 90, 180, 270 (degrees)
    transportMode: 'none',    // 'registered_file' | 'binary_multipart' | 'legacy_base64'
    sessionToken: '',         // 프로세스 격리 세션 토큰 (X-UtilTools-Token)
    blocks: [],               // array of line blocks with words & bboxes
    rawText: '',              // string
    currentRoi: null,         // {x, y, width, height} in original image pixels
    imageWidth: 0,
    imageHeight: 0,
    boxMode: 'line',          // 'line' | 'word' | 'none'
    roiSelectionMode: false,  // true if dragging ROI mode is actively forced
    isDraggingRoi: false,
    roiDragStart: null,       // {x, y} on canvas
    roiDragCurrent: null,     // {x, y} on canvas
    hoveredItem: null,        // {type: 'line'|'word', data: {...}, rect: {...}}
    latencyMs: 0.0,
    coreOcrMs: 0.0,
    timings: null,
    totalE2eMs: 0.0,
    textAngle: 0.0,           // detected text orientation angle in degrees
    scaleApplied: 1.0,        // internal adaptive upscale factor (1.0 or 2.0)
    scale: 1.0,
    offsetX: 0,
    offsetY: 0,
    capabilities: null,
    isInitialized: false,
    historyDrawerOpen: false
};

/**
 * OCR 관련 에러를 표준화하여 사용자 친화적인 인레이어 모달(showAppAlert)로 안내
 * @param {Error|Object|string} errOrRes - 에러 객체 또는 백엔드 에러 응답
 * @param {string} fallbackTitle - 기본 모달 타이틀
 */
function handleOcrError(errOrRes, fallbackTitle = 'OCR 오류') {
    showOcrLoading(false);

    let errorCode = '';
    let errorMessage = '';

    if (!errOrRes) {
        showAppAlert('알 수 없는 오류가 발생했습니다.', fallbackTitle, '❌');
        return;
    }

    if (errOrRes instanceof Error) {
        errorMessage = errOrRes.message || String(errOrRes);
    } else if (typeof errOrRes === 'object') {
        errorCode = errOrRes.error_code || errOrRes.code || '';
        errorMessage = errOrRes.error || errOrRes.message || '';
    } else {
        errorMessage = String(errOrRes);
    }

    // 메시지 내에 에러 코드가 포함되어 있는 경우 추출
    if (!errorCode) {
        if (errorMessage.includes('SOURCE_EXPIRED') || errorMessage.includes('404')) {
            errorCode = 'SOURCE_EXPIRED';
        } else if (errorMessage.includes('PAYLOAD_TOO_LARGE') || errorMessage.includes('413')) {
            errorCode = 'PAYLOAD_TOO_LARGE';
        } else if (errorMessage.includes('UNSUPPORTED_FORMAT') || errorMessage.includes('415')) {
            errorCode = 'UNSUPPORTED_FORMAT';
        } else if (errorMessage.includes('INVALID_IMAGE') || errorMessage.includes('DECOMPRESSION_BOMB') || errorMessage.includes('400')) {
            errorCode = 'INVALID_IMAGE';
        } else if (errorMessage.includes('OCR_LANGUAGE_UNAVAILABLE') || errorMessage.includes('422')) {
            errorCode = 'OCR_LANGUAGE_UNAVAILABLE';
        } else if (errorMessage.includes('INVALID_SESSION') || errorMessage.includes('403')) {
            errorCode = 'INVALID_SESSION';
        }
    }

    switch (errorCode) {
        case 'SOURCE_EXPIRED':
            showAppAlert(
                '이미지 세션이 만료되었거나 삭제되었습니다.\n이미지를 다시 열거나 붙여넣어 주세요.',
                '세션 만료',
                '⏳'
            );
            break;
        case 'PAYLOAD_TOO_LARGE':
            showAppAlert(
                '이미지 파일 크기가 25MB 상한선을 초과했습니다.\n더 작은 이미지를 선택하거나 해상도를 조절해 주세요.',
                '용량 초과',
                '⚠️'
            );
            break;
        case 'UNSUPPORTED_FORMAT':
            showAppAlert(
                '지원하지 않는 이미지 형식입니다.\nPNG, JPG, WebP, BMP, TIFF 형식의 이미지를 사용해 주세요.',
                '형식 오류',
                '⚠️'
            );
            break;
        case 'INVALID_IMAGE':
            showAppAlert(
                '이미지 파일이 손상되었거나 허용 해상도(최대 10000px, 3000만 화소)를 초과하여 안전하게 차단되었습니다.',
                '이미지 검증 실패',
                '❌'
            );
            break;
        case 'OCR_LANGUAGE_UNAVAILABLE':
            showAppAlert(
                '선택한 언어의 Windows OCR 언어 팩이 설치되어 있지 않습니다.\n[Windows 설정] > [시간 및 언어] > [언어 및 지역]에서 해당 언어의 광학 문자 인식을 추가해 주세요.',
                '언어 팩 미설치',
                '🌐'
            );
            break;
        case 'INVALID_SESSION':
            showAppAlert(
                '로컬 프로세스 보안 토큰 검증에 실패했습니다.\n앱을 재시작하거나 페이지를 새로고침해 주세요.',
                '보안 인증 실패',
                '🔒'
            );
            break;
        default:
            showAppAlert(
                errorMessage || '문자 인식 처리 중 오류가 발생했습니다.',
                fallbackTitle,
                '❌'
            );
            break;
    }
}

/**
 * 인메모리 이미지 90도/270도 회전 (sourceId 기반 0-전송 재실행)
 * @param {number} degrees - 회전 각도 (+90: 시계 방향, -90: 반시계 방향)
 */
function rotateOcrImage(degrees) {
    if (!ocrState.sourceId && !ocrState.image) {
        showToast('알림', '회전할 이미지가 없습니다. 이미지를 먼저 열거나 붙여넣으세요.', '⚠️');
        return;
    }

    if (ocrState.sourceId) {
        const reqId = ++ocrState.currentRequestId;
        ocrState.rotation = (ocrState.rotation + degrees + 360) % 360;
        ocrState.currentRoi = null; // 회전 시 ROI 리셋
        const resetBtn = document.getElementById('ocr-roi-reset-btn');
        if (resetBtn) resetBtn.style.display = 'none';

        showOcrLoading(true, '이미지 회전 및 재인식 실행 중...');

        // 캔버스 이미지 회전된 preview 로드 및 백엔드 OCR 재실행 병렬 처리
        const rotUrl = `/api/ocr/source/${ocrState.sourceId}/preview?rotation=${ocrState.rotation}&t=${Date.now()}`;
        const img = new Image();
        const imgPromise = new Promise((resolve, reject) => {
            img.onload = () => resolve(img);
            img.onerror = () => reject(new Error('회전된 프리뷰 로드 실패'));
            img.src = rotUrl;
        });

        const langSelect = document.getElementById('ocr-lang-select');
        const selectedLang = langSelect ? langSelect.value : ocrState.lang;
        const tRpcStart = performance.now();
        const ocrPromise = eel.recognize_ocr_source(ocrState.sourceId, selectedLang, null, ocrState.rotation, true)();

        Promise.all([imgPromise, ocrPromise]).then(([loadedImg, ocrRes]) => {
            if (reqId !== ocrState.currentRequestId) {
                console.log(`[OCR] Stale rotate request discarded (reqId=${reqId}, current=${ocrState.currentRequestId})`);
                return;
            }
            const tRpcEnd = performance.now();
            ocrState.image = loadedImg;
            ocrState.imageWidth = loadedImg.naturalWidth;
            ocrState.imageHeight = loadedImg.naturalHeight;
            applyOcrResultToUi(ocrRes, performance.now(), tRpcStart, tRpcEnd, 'source_reexecution');
            showToast('이미지 회전', `${degrees > 0 ? '시계' : '반시계'} 방향 90° 회전 후 재인식 완료.`, '🔄');
        }).catch(err => {
            if (reqId !== ocrState.currentRequestId) return;
            handleOcrError(err, '이미지 회전 실패');
        });

        return;
    }

    // 레거시 폴백 (dataUrl 기반)
    const srcImg = ocrState.image;
    const offCanvas = document.createElement('canvas');
    const rad = (degrees * Math.PI) / 180;
    const isQuarter = Math.abs(degrees) % 180 === 90;
    offCanvas.width = isQuarter ? srcImg.naturalHeight : srcImg.naturalWidth;
    offCanvas.height = isQuarter ? srcImg.naturalWidth : srcImg.naturalHeight;

    const ctx = offCanvas.getContext('2d');
    ctx.translate(offCanvas.width / 2, offCanvas.height / 2);
    ctx.rotate(rad);
    ctx.drawImage(srcImg, -srcImg.naturalWidth / 2, -srcImg.naturalHeight / 2);

    const rotatedDataUrl = offCanvas.toDataURL('image/png');
    loadOcrFromDataUrl(rotatedDataUrl, ocrState.filename, ocrState.sourceType, null);
    showToast('이미지 회전', `${degrees > 0 ? '시계' : '반시계'} 방향 90° 회전 후 재인식합니다.`, '🔄');
}

// ==============================================================================
// 1. 탭 수명주기 훅 (init, teardown, resume)
// ==============================================================================
async function initOcrStudio() {
    if (ocrState.isInitialized) {
        resumeOcrStudio();
        return;
    }
    ocrState.isInitialized = true;

    // 0) 백엔드 세션 토큰 조회 (로컬 HTTP 헤더 인증용)
    if (window.eel && typeof eel.get_ocr_session_token === 'function') {
        try {
            ocrState.sessionToken = await eel.get_ocr_session_token()();
        } catch (err) {
            console.warn('[OCR] Session token fetch error:', err);
        }
    }

    // 1) 전역 paste 이벤트 리스너 등록 (OCR 탭 활성 시 동작)
    document.addEventListener('paste', handleOcrGlobalPaste);

    // 2) 캔버스 마우스 & 드래그 앤 드롭 리스너 바인딩
    initOcrCanvasEvents();
    initOcrDropzoneEvents();
    initOcrResizer();

    // 3) 언어 capability 비동기 검사
    await checkAndDisplayOcrCapabilities();

    // 4) 히스토리 목록 사전 조회
    await loadOcrHistory();

    // 5) 텍스트 에디터 글자 수 카운터 리스너
    const editor = document.getElementById('ocr-text-output');
    if (editor) {
        editor.addEventListener('input', () => updateOcrTextLengthBadge(editor.value));
    }
}

function teardownOcrStudio() {
    // 탭 이탈 시 대기 중인 비동기 요청 무효화 (stale response drop)
    ocrState.currentRequestId++;
    // 타 탭(메모, 콘솔 등)에서의 붙여넣기 간섭을 차단하기 위해 이벤트 리스너 해제
    document.removeEventListener('paste', handleOcrGlobalPaste);
}

function resumeOcrStudio() {
    // 탭 복귀 시 다시 paste 이벤트 바인딩
    document.removeEventListener('paste', handleOcrGlobalPaste);
    document.addEventListener('paste', handleOcrGlobalPaste);

    // 화면 캔버스 재렌더링
    if (ocrState.image) {
        renderOcrCanvas();
    }
}


// ==============================================================================
// 2. 언어 Capability 검사 & 가이드 안내
// ==============================================================================
async function checkAndDisplayOcrCapabilities() {
    try {
        if (window.eel && typeof eel.get_ocr_capabilities === 'function') {
            const caps = await eel.get_ocr_capabilities()();
            ocrState.capabilities = caps;

            const banner = document.getElementById('ocr-capability-banner');
            const msgEl = document.getElementById('ocr-capability-message');
            if (banner && msgEl) {
                if (caps.guide_message) {
                    msgEl.textContent = caps.guide_message;
                    banner.style.display = 'flex';
                } else {
                    banner.style.display = 'none';
                }
            }
        }
    } catch (err) {
        console.warn('OCR capabilities check failed:', err);
    }
}


// ==============================================================================
// 3. 네이티브 파일 대화상자 & 클립보드/드롭 고속 Transport 파이프라인
// ==============================================================================
async function openOcrImageFile() {
    try {
        if (!window.eel || typeof eel.open_ocr_file_dialog !== 'function') {
            const fileInput = document.getElementById('ocr-file-input');
            if (fileInput) fileInput.click();
            return;
        }

        const tEventStart = performance.now();
        showOcrLoading(true, '파일 선택 중...');
        const res = await eel.open_ocr_file_dialog()();

        if (!res || res.status === 'cancelled') {
            showOcrLoading(false);
            return;
        }

        if (res.status !== 'success' || !res.source_id) {
            handleOcrError(res, '파일 열기 실패');
            return;
        }

        await loadOcrFromNativeSource(res.source_id, res.filename, 'file', res.width, res.height, tEventStart);
    } catch (err) {
        handleOcrError(err, '파일 열기 실패');
    }
}

async function loadOcrFromNativeSource(sourceId, filename, sourceType, width, height, tEventStart) {
    const reqId = ++ocrState.currentRequestId;
    ocrState.sourceId = sourceId;
    ocrState.filename = filename || 'image.png';
    ocrState.sourceType = sourceType || 'file';
    ocrState.rotation = 0;
    ocrState.currentRoi = null;
    ocrState.frontendEncodeMs = 0.0;
    ocrState.eventStartTime = tEventStart || performance.now();

    // UI 표시 전환 (placeholder 숨김, canvas 표시)
    const placeholder = document.getElementById('ocr-empty-placeholder');
    const canvas = document.getElementById('ocr-interactive-canvas');
    if (placeholder) placeholder.style.display = 'none';
    if (canvas) canvas.style.display = 'block';

    showOcrLoading(true, '이미지 로드 및 문자 인식 실행 중...');

    // 1) 캔버스 이미지 로드 (GET /api/ocr/source/{source_id}/preview)
    const previewUrl = `/api/ocr/source/${sourceId}/preview`;
    const img = new Image();
    const imgPromise = new Promise((resolve, reject) => {
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('프리뷰 이미지 로드 실패'));
        img.src = previewUrl;
    });

    // 2) 백엔드 OCR 실행 (recognize_ocr_source) 병렬 진행 (전송 데이터 0바이트)
    const langSelect = document.getElementById('ocr-lang-select');
    const selectedLang = langSelect ? langSelect.value : ocrState.lang;

    const tRpcStart = performance.now();
    const ocrPromise = eel.recognize_ocr_source(sourceId, selectedLang, null, 0, true)();

    try {
        const [loadedImg, ocrRes] = await Promise.all([imgPromise, ocrPromise]);
        const tRpcEnd = performance.now();

        if (reqId !== ocrState.currentRequestId) {
            console.log(`[OCR] Stale native source load request discarded (reqId=${reqId}, current=${ocrState.currentRequestId})`);
            return;
        }

        if (!ocrRes || !ocrRes.success) {
            handleOcrError(ocrRes, '인식 처리 실패');
            return;
        }

        ocrState.image = loadedImg;
        ocrState.imageWidth = loadedImg.naturalWidth;
        ocrState.imageHeight = loadedImg.naturalHeight;

        applyOcrResultToUi(ocrRes, ocrState.eventStartTime, tRpcStart, tRpcEnd, 'registered_file');
    } catch (err) {
        if (reqId !== ocrState.currentRequestId) return;
        handleOcrError(err, '이미지 로드 및 OCR 실패');
    }
}

async function handleOcrBinaryUpload(blob, filename, sourceType, tEventStart) {
    if (!blob) return;

    const reqId = ++ocrState.currentRequestId;
    showOcrLoading(true, '이미지 전송 및 문자 인식 실행 중...');
    const tUploadStart = performance.now();
    const effectiveEventStart = tEventStart || tUploadStart;
    ocrState.frontendEncodeMs = 0.0; // 바이너리 스트리밍이므로 DataURL 인코딩 지연 0ms
    ocrState.eventStartTime = effectiveEventStart;

    const langSelect = document.getElementById('ocr-lang-select');
    const selectedLang = langSelect ? langSelect.value : ocrState.lang;
    ocrState.lang = selectedLang;

    try {
        const fd = new FormData();
        fd.append('file', blob, filename || 'clipboard.png');
        fd.append('lang', selectedLang);
        fd.append('source_type', sourceType || 'clipboard');
        fd.append('save_history', 'true');

        const headers = {};
        if (ocrState.sessionToken) {
            headers['X-UtilTools-Token'] = ocrState.sessionToken;
        }

        const tFetchStart = performance.now();
        const resp = await fetch('/api/ocr/source', {
            method: 'POST',
            headers: headers,
            body: fd
        });

        if (reqId !== ocrState.currentRequestId) {
            console.log(`[OCR] Stale binary upload request discarded (reqId=${reqId}, current=${ocrState.currentRequestId})`);
            return;
        }

        if (!resp.ok) {
            let errData = null;
            try {
                errData = await resp.json();
            } catch (e) {
                const errTxt = await resp.text();
                errData = { error: errTxt, message: errTxt };
            }
            handleOcrError(errData, '업로드 실패');
            return;
        }

        const res = await resp.json();
        const tFetchEnd = performance.now();

        if (reqId !== ocrState.currentRequestId) {
            console.log(`[OCR] Stale binary upload request discarded (reqId=${reqId}, current=${ocrState.currentRequestId})`);
            return;
        }

        if (!res.success) {
            handleOcrError(res, '인식 처리 실패');
            return;
        }

        ocrState.sourceId = res.source_id;
        ocrState.filename = res.filename || filename;
        ocrState.sourceType = sourceType || 'clipboard';
        ocrState.rotation = 0;
        ocrState.currentRoi = null;

        // UI 표시 전환
        const placeholder = document.getElementById('ocr-empty-placeholder');
        const canvas = document.getElementById('ocr-interactive-canvas');
        if (placeholder) placeholder.style.display = 'none';
        if (canvas) canvas.style.display = 'block';

        const img = new Image();
        img.onload = () => {
            if (reqId !== ocrState.currentRequestId) return;
            ocrState.image = img;
            ocrState.imageWidth = img.naturalWidth;
            ocrState.imageHeight = img.naturalHeight;
            applyOcrResultToUi(res, effectiveEventStart, tFetchStart, tFetchEnd, 'binary_multipart');
        };
        img.onerror = () => {
            if (reqId !== ocrState.currentRequestId) return;
            handleOcrError(new Error('프리뷰 이미지를 로드하지 못했습니다.'), '오류');
        };
        img.src = `/api/ocr/source/${res.source_id}/preview`;

    } catch (err) {
        if (reqId !== ocrState.currentRequestId) return;
        console.error('[OCR] handleOcrBinaryUpload error:', err);
        handleOcrError(err, '이미지 업로드 및 OCR 실패');
    }
}

function handleOcrGlobalPaste(e) {
    if (typeof currentActiveTab !== 'undefined' && currentActiveTab !== 'ocr') return;

    const activeEl = document.activeElement;
    if (activeEl && (activeEl.tagName === 'TEXTAREA' || activeEl.tagName === 'INPUT')) {
        return;
    }

    if (!e.clipboardData || !e.clipboardData.items) return;

    for (let i = 0; i < e.clipboardData.items.length; i++) {
        const item = e.clipboardData.items[i];
        if (item.type.indexOf('image') !== -1) {
            e.preventDefault();
            const tEventStart = performance.now();
            const blob = item.getAsFile();
            handleOcrBinaryUpload(blob, 'clipboard_capture.png', 'clipboard', tEventStart);
            break;
        }
    }
}

async function pasteImageFromClipboard() {
    try {
        if (navigator.clipboard && navigator.clipboard.read) {
            const items = await navigator.clipboard.read();
            for (const item of items) {
                for (const type of item.types) {
                    if (type.startsWith('image/')) {
                        const tEventStart = performance.now();
                        const blob = await item.getType(type);
                        handleOcrBinaryUpload(blob, 'clipboard.png', 'clipboard', tEventStart);
                        return;
                    }
                }
            }
            showToast('알림', '클립보드에 이미지 데이터가 없습니다. 스크린샷(Win+Shift+S)을 먼저 복사하세요.', '⚠️');
        } else {
            showToast('안내', '클립보드 이미지를 붙여넣으려면 키보드로 Ctrl + V 를 누르세요.', 'ℹ️');
        }
    } catch (err) {
        showToast('안내', '브라우저 권한 제한으로 Ctrl + V 단축키로 이미지를 붙여넣어 주세요.', 'ℹ️');
    }
}

function onOcrFileInputChange(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;

    const tEventStart = performance.now();
    handleOcrBinaryUpload(file, file.name, 'file', tEventStart);
    e.target.value = '';
}

function initOcrDropzoneEvents() {
    const dropzone = document.getElementById('ocr-canvas-dropzone');
    if (!dropzone) return;

    ['dragenter', 'dragover'].forEach(name => {
        dropzone.addEventListener(name, (e) => {
            e.preventDefault();
            e.stopPropagation();
            dropzone.classList.add('drag-over');
        });
    });

    ['dragleave', 'drop'].forEach(name => {
        dropzone.addEventListener(name, (e) => {
            e.preventDefault();
            e.stopPropagation();
            dropzone.classList.remove('drag-over');
        });
    });

    dropzone.addEventListener('drop', (e) => {
        const dt = e.dataTransfer;
        const file = dt && dt.files && dt.files[0];
        if (file && file.type.startsWith('image/')) {
            const tEventStart = performance.now();
            handleOcrBinaryUpload(file, file.name, 'file', tEventStart);
        }
    });
}


// ==============================================================================
// 4. 슬라이서 연동 & 레거시 DataURL 브리지 & 실행 파이프라인
// ==============================================================================
async function loadOcrFromSlice(dataUrl, roiRect, sliceTitle) {
    const tEventStart = performance.now();
    if (typeof switchTab === 'function') {
        switchTab('ocr');
    }
    try {
        const resp = await fetch(dataUrl);
        const blob = await resp.blob();
        await handleOcrBinaryUpload(blob, sliceTitle || 'slice.png', 'slicer', tEventStart);
        if (roiRect && ocrState.sourceId) {
            runOcrPipeline(roiRect);
        }
    } catch (e) {
        loadOcrFromDataUrl(dataUrl, sliceTitle || 'slice.png', 'slicer', roiRect, tEventStart);
    }
}

function loadOcrFromDataUrl(dataUrl, filename, sourceType, roi = null, tEventStart = null) {
    if (!dataUrl) return;

    // DataURL을 Blob으로 즉시 변환하여 고속 바이너리 채널로 라우팅
    fetch(dataUrl)
        .then(res => res.blob())
        .then(blob => {
            handleOcrBinaryUpload(blob, filename || 'image.png', sourceType || 'file', tEventStart);
        })
        .catch(err => {
            console.error('[OCR] dataUrl to blob conversion failed:', err);
        });
}

async function runOcrPipeline(roi = null, tEventStart = null) {
    const reqId = ++ocrState.currentRequestId;
    const tClientStart = performance.now();
    const effectiveEventStart = tEventStart || ocrState.eventStartTime || tClientStart;

    const langSelect = document.getElementById('ocr-lang-select');
    const selectedLang = langSelect ? langSelect.value : ocrState.lang;
    ocrState.lang = selectedLang;

    showOcrLoading(true, roi ? '선택 영역(ROI) 정밀 인식 중...' : '문자 인식 실행 중...');

    try {
        let res = null;
        let tRpcStart = performance.now();
        let transportMode = 'source_reexecution';

        if (ocrState.sourceId && window.eel && typeof eel.recognize_ocr_source === 'function') {
            transportMode = ocrState.transportMode || 'source_reexecution';
            res = await eel.recognize_ocr_source(
                ocrState.sourceId,
                selectedLang,
                roi,
                ocrState.rotation || 0,
                true
            )();
        } else if (ocrState.dataUrl && window.eel && typeof eel.recognize_ocr_base64 === 'function') {
            transportMode = 'legacy_base64';
            res = await eel.recognize_ocr_base64(
                ocrState.dataUrl,
                roi,
                selectedLang,
                ocrState.filename,
                roi ? 'roi' : ocrState.sourceType,
                true
            )();
        } else {
            showToast('오류', '인식할 이미지 소스가 준비되지 않았습니다.', '❌');
            showOcrLoading(false);
            return;
        }

        const tRpcEnd = performance.now();

        if (reqId !== ocrState.currentRequestId) {
            console.log(`[OCR] Stale OCR pipeline request discarded (reqId=${reqId}, current=${ocrState.currentRequestId})`);
            return;
        }

        if (!res || !res.success) {
            handleOcrError(res, '인식 처리 실패');
            return;
        }

        applyOcrResultToUi(res, effectiveEventStart, tRpcStart, tRpcEnd, transportMode);

    } catch (err) {
        if (reqId !== ocrState.currentRequestId) return;
        console.error('runOcrPipeline error:', err);
        handleOcrError(err, 'OCR 처리 예외');
    }
}

function applyOcrResultToUi(res, effectiveEventStart, tRpcStart, tRpcEnd, transportMode) {
    showOcrLoading(false);
    if (!res || !res.success) {
        handleOcrError(res, '인식 처리 실패');
        return;
    }

    const rpcDurationMs = Math.round((tRpcEnd - tRpcStart) * 10) / 10;
    ocrState.blocks = res.blocks || [];
    ocrState.rawText = res.text || '';
    ocrState.latencyMs = res.latency_ms || 0.0;
    ocrState.coreOcrMs = (typeof res.core_ocr_ms === 'number') ? res.core_ocr_ms : (res.latency_ms || 0.0);
    ocrState.currentRoi = res.roi || null;
    ocrState.textAngle = (typeof res.text_angle === 'number') ? res.text_angle : 0.0;
    ocrState.scaleApplied = (typeof res.scale_applied === 'number') ? res.scale_applied : 1.0;
    ocrState.transportMode = transportMode;

    const t = res.timings || {};
    const backendTotalMs = t.backend_total_ms || res.latency_ms || 0;
    const rpcOverheadMs = Math.max(0, Math.round((rpcDurationMs - backendTotalMs) * 10) / 10);

    // 에디터 텍스트 주입
    const editor = document.getElementById('ocr-text-output');
    if (editor) {
        editor.value = res.text || '';
        updateOcrTextLengthBadge(editor.value);
    }

    // ROI 리셋 버튼 가시성
    const resetBtn = document.getElementById('ocr-roi-reset-btn');
    if (resetBtn) {
        resetBtn.style.display = ocrState.currentRoi ? 'inline-flex' : 'none';
    }

    // 캔버스 렌더링 (Bounding Box 오버레이 포함)
    const tRenderStart = performance.now();
    renderOcrCanvas();
    const tRenderEnd = performance.now();
    const renderMs = Math.round((tRenderEnd - tRenderStart) * 10) / 10;

    // 전체 End-to-End 소요시간
    const totalE2eMs = Math.round((tRenderEnd - effectiveEventStart) * 10) / 10;
    ocrState.totalE2eMs = totalE2eMs;

    const frontendEncodeMs = ocrState.frontendEncodeMs || 0.0;
    const unaccountedMs = Math.max(0, Math.round((totalE2eMs - frontendEncodeMs - rpcDurationMs - renderMs) * 10) / 10);

    ocrState.timings = {
        ...t,
        transport_mode: transportMode,
        frontend_encode_ms: frontendEncodeMs,
        rpc_duration_ms: rpcDurationMs,
        rpc_overhead_ms: rpcOverheadMs,
        backend_total_ms: backendTotalMs,
        render_ms: renderMs,
        unaccounted_ms: unaccountedMs,
        ui_e2e_ms: totalE2eMs
    };

    console.log('[OCR Timing Breakdown]', {
        transport_mode: transportMode,
        frontend_encode_ms: frontendEncodeMs,
        rpc_duration_ms: rpcDurationMs,
        backend_total_ms: backendTotalMs,
        rpc_overhead_ms: rpcOverheadMs,
        render_ms: renderMs,
        unaccounted_ms: unaccountedMs,
        ui_e2e_ms: totalE2eMs,
        backend_breakdown: {
            transport_register_ms: t.transport_register_ms || 0.0,
            file_io_ms: t.file_io_ms || 0.0,
            decode_ms: t.decode_ms || 0.0,
            preprocess_ms: t.preprocess_ms || 0.0,
            core_ocr_ms: ocrState.coreOcrMs,
            postprocess_ms: t.postprocess_ms || 0.0,
            history_ms: t.history_ms || 0.0
        },
        scale_applied: ocrState.scaleApplied,
        text_angle: ocrState.textAngle
    });

    updateOcrStatsBadges();
    loadOcrHistory();

    showToast('OCR 완료', `${ocrState.blocks.length}개 블록 추출 (코어: ${ocrState.coreOcrMs}ms / E2E: ${totalE2eMs}ms)`, '⚡');
}

function showOcrLoading(show, message = '문자 인식 중...') {
    const loadingEl = document.getElementById('ocr-canvas-loading');
    const loadingText = document.getElementById('ocr-loading-text');
    if (loadingEl) {
        loadingEl.style.display = show ? 'flex' : 'none';
    }
    if (loadingText && message) {
        loadingText.textContent = message;
    }
}

function updateOcrStatsBadges() {
    const latencyBadge = document.getElementById('ocr-badge-latency');
    const scaleBadge = document.getElementById('ocr-badge-scale');
    const angleBadge = document.getElementById('ocr-badge-angle');
    const resBadge = document.getElementById('ocr-badge-res');
    const countBadge = document.getElementById('ocr-badge-count');

    if (latencyBadge) {
        const t = ocrState.timings || {};
        const backendMs = t.backend_total_ms || ocrState.latencyMs || 0;
        latencyBadge.textContent = `⚡ 코어 ${ocrState.coreOcrMs}ms | 백엔드 ${backendMs}ms | E2E ${ocrState.totalE2eMs}ms`;
        const pipelineMs = Math.round(((t.preprocess_ms || 0) + (t.core_ocr_ms || 0) + (t.postprocess_ms || 0)) * 10) / 10;
        const tooltip = [
            `[실측 지연시간 세부 계측 (Breakdown)]`,
            `• frontend_encode_ms (클립보드/파일 DataURL 변환): ${t.frontend_encode_ms || 0} ms`,
            `• rpc_duration_ms (Eel WebSocket RPC 호출 왕복): ${t.rpc_duration_ms || 0} ms`,
            `  ├─ backend_total_ms (Python 백엔드 전체 처리): ${backendMs} ms`,
            `  │   ├─ decode_ms (Base64 디코딩/PIL 로드): ${t.decode_ms || t.file_io_ms || 0} ms`,
            `  │   ├─ preprocess_ms (Lanczos 리샘플링): ${t.preprocess_ms || 0} ms`,
            `  │   ├─ core_ocr_ms (Windows OCR 엔진 코어): ${t.core_ocr_ms || 0} ms`,
            `  │   ├─ postprocess_ms (좌표 복원/Line Union): ${t.postprocess_ms || 0} ms`,
            `  │   └─ history_ms (DB 저장 & 썸네일 디스크IO): ${t.history_ms || 0} ms`,
            `  └─ rpc_overhead_ms (WebSocket 직렬화/전송 오버헤드): ${t.rpc_overhead_ms || 0} ms`,
            `• render_ms (브라우저 Canvas 렌더링): ${t.render_ms || 0} ms`,
            `• unaccounted_ms (브라우저 이벤트/스케줄링 지연): ${t.unaccounted_ms || 0} ms`,
            `----------------------------------------`,
            `• ui_e2e_ms (총 End-to-End 소요시간): ${ocrState.totalE2eMs} ms`
        ].join('\n');
        latencyBadge.title = tooltip;
        latencyBadge.style.display = 'inline-flex';
    }
    if (scaleBadge) {
        const scaleVal = typeof ocrState.scaleApplied === 'number' ? ocrState.scaleApplied : 1.0;
        scaleBadge.textContent = `🔍 ${scaleVal}x`;
        scaleBadge.title = `적응형 전처리 배율: ${scaleVal}배\n(Upscaling Pixel Budget: 최대 2.5M px 한도 내 업스케일 허용, 다운스케일 없음)`;
        scaleBadge.style.display = 'inline-flex';
    }
    if (angleBadge) {
        if (ocrState.textAngle !== null && ocrState.textAngle !== undefined && Math.abs(ocrState.textAngle) >= 0.1) {
            const angleVal = Number(ocrState.textAngle).toFixed(1);
            angleBadge.textContent = `🔄 ${angleVal}°`;
            angleBadge.title = `감지된 텍스트 대표 기울기: ${angleVal}°\n(Microsoft 규격: 이미지 중심 기준 대표 회전각, 개별 단어별 독립 각도가 아님)`;
            angleBadge.style.display = 'inline-flex';
        } else {
            angleBadge.style.display = 'none';
        }
    }
    if (resBadge) {
        resBadge.textContent = `📐 ${ocrState.imageWidth} × ${ocrState.imageHeight} px`;
        resBadge.style.display = 'inline-flex';
    }
    if (countBadge) {
        countBadge.textContent = `📦 ${ocrState.blocks.length}개 블록`;
        countBadge.style.display = 'inline-flex';
    }
}

async function deleteOcrSource(sourceId) {
    if (!sourceId) return;
    try {
        const headers = {};
        if (ocrState.sessionToken) {
            headers['X-UtilTools-Token'] = ocrState.sessionToken;
        }
        await fetch(`/api/ocr/source/${sourceId}`, {
            method: 'DELETE',
            headers: headers
        });
    } catch (err) {
        console.warn('[OCR] deleteOcrSource error:', err);
    }
}

function updateOcrTextLengthBadge(text) {
    const badge = document.getElementById('ocr-text-length-badge');
    if (badge) {
        badge.textContent = `${(text || '').length}자`;
    }
}

function onOcrLangChange(lang) {
    ocrState.lang = lang;
    if (ocrState.image) {
        runOcrPipeline(ocrState.currentRoi);
    }
}

function resetOcrRoi() {
    ocrState.currentRoi = null;
    const resetBtn = document.getElementById('ocr-roi-reset-btn');
    if (resetBtn) resetBtn.style.display = 'none';
    runOcrPipeline(null);
}

function toggleOcrRoiMode() {
    ocrState.roiSelectionMode = !ocrState.roiSelectionMode;
    const btn = document.getElementById('ocr-roi-mode-btn');
    if (btn) {
        if (ocrState.roiSelectionMode) {
            btn.classList.add('active');
            btn.innerHTML = '<span>🎯</span> ROI 선택 중 (캔버스 드래그)';
        } else {
            btn.classList.remove('active');
            btn.innerHTML = '<span>🎯</span> ROI 영역 추출';
        }
    }
    renderOcrCanvas();
}

function setOcrBoxMode(mode) {
    ocrState.boxMode = mode;
    ['line', 'word', 'none'].forEach(m => {
        const b = document.getElementById(`ocr-box-${m}-btn`);
        if (b) {
            if (m === mode) b.classList.add('active');
            else b.classList.remove('active');
        }
    });
    renderOcrCanvas();
}


// ==============================================================================
// 5. 캔버스 렌더링 & 바운딩 박스 / ROI 오버레이
// ==============================================================================
function renderOcrCanvas() {
    const canvas = document.getElementById('ocr-interactive-canvas');
    const pane = document.getElementById('ocr-canvas-pane');
    if (!canvas || !pane || !ocrState.image) return;

    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;

    // 패널 가용 크기 계산 (패딩 여백 감안)
    const availW = Math.max(100, pane.clientWidth - 32);
    const availH = Math.max(100, pane.clientHeight - 80);

    const imgW = ocrState.imageWidth;
    const imgH = ocrState.imageHeight;

    // 화면 비율에 맞는 스케일 계산
    const scale = Math.min(availW / imgW, availH / imgH, 2.5); // 최대 2.5배 확대
    const drawW = Math.round(imgW * scale);
    const drawH = Math.round(imgH * scale);

    canvas.width = Math.round(drawW * dpr);
    canvas.height = Math.round(drawH * dpr);
    canvas.style.width = `${drawW}px`;
    canvas.style.height = `${drawH}px`;

    ocrState.scale = scale;
    const drawX = ocrState.offsetX || 0;
    const drawY = ocrState.offsetY || 0;

    ctx.save();
    ctx.scale(dpr, dpr);

    // 1. 원본 이미지 렌더링 (drawX, drawY 오프셋 반영)
    ctx.drawImage(ocrState.image, drawX, drawY, drawW, drawH);

    // 2. ROI(관심 영역) 강조 표시 (ROI 외부 음영 처리)
    if (ocrState.currentRoi) {
        const rx = drawX + ocrState.currentRoi.x * scale;
        const ry = drawY + ocrState.currentRoi.y * scale;
        const rw = (ocrState.currentRoi.width || ocrState.currentRoi.w) * scale;
        const rh = (ocrState.currentRoi.height || ocrState.currentRoi.h) * scale;

        ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
        // Top
        ctx.fillRect(0, 0, drawW, ry);
        // Bottom
        ctx.fillRect(0, ry + rh, drawW, drawH - (ry + rh));
        // Left
        ctx.fillRect(0, ry, rx, rh);
        // Right
        ctx.fillRect(rx + rw, ry, drawW - (rx + rw), rh);

        // ROI 경계 테두리
        ctx.strokeStyle = '#3b82f6';
        ctx.lineWidth = 2;
        ctx.setLineDash([5, 4]);
        ctx.strokeRect(rx, ry, rw, rh);
        ctx.setLineDash([]);
    }

    // 3. Bounding Box 오버레이 (Line vs Word, 이미지 중심 기준 textAngle 회전)
    if (ocrState.boxMode !== 'none' && ocrState.blocks && ocrState.blocks.length > 0) {
        const hasAngle = ocrState.textAngle && Math.abs(ocrState.textAngle) >= 0.1;
        const rad = hasAngle ? (ocrState.textAngle * Math.PI) / 180 : 0;

        ctx.save();
        if (hasAngle) {
            // Microsoft 공식 규격: TextAngle은 이미지 중심(drawX + drawW/2, drawY + drawH/2)을 기준으로 한 시계 방향 회전각
            const centerX = drawX + drawW / 2.0;
            const centerY = drawY + drawH / 2.0;
            ctx.translate(centerX, centerY);
            ctx.rotate(rad);
            ctx.translate(-centerX, -centerY);
        }

        if (ocrState.boxMode === 'line') {
            ocrState.blocks.forEach(block => {
                const bx = drawX + block.x * scale;
                const by = drawY + block.y * scale;
                const bw = block.width * scale;
                const bh = block.height * scale;

                const isHovered = ocrState.hoveredItem &&
                                  ocrState.hoveredItem.type === 'line' &&
                                  ocrState.hoveredItem.data === block;

                if (isHovered) {
                    ctx.fillStyle = 'rgba(234, 179, 8, 0.35)';
                    ctx.strokeStyle = 'rgba(234, 179, 8, 0.95)';
                    ctx.lineWidth = 2;
                } else {
                    ctx.fillStyle = 'rgba(59, 130, 246, 0.18)';
                    ctx.strokeStyle = 'rgba(59, 130, 246, 0.75)';
                    ctx.lineWidth = 1;
                }

                ctx.fillRect(bx, by, bw, bh);
                ctx.strokeRect(bx, by, bw, bh);
            });
        } else if (ocrState.boxMode === 'word') {
            ocrState.blocks.forEach(block => {
                (block.words || []).forEach(w => {
                    const wx = drawX + w.x * scale;
                    const wy = drawY + w.y * scale;
                    const ww = w.width * scale;
                    const wh = w.height * scale;

                    const isHovered = ocrState.hoveredItem &&
                                      ocrState.hoveredItem.type === 'word' &&
                                      ocrState.hoveredItem.data === w;

                    if (isHovered) {
                        ctx.fillStyle = 'rgba(234, 179, 8, 0.4)';
                        ctx.strokeStyle = 'rgba(234, 179, 8, 1.0)';
                        ctx.lineWidth = 2;
                    } else {
                        ctx.fillStyle = 'rgba(168, 85, 247, 0.2)';
                        ctx.strokeStyle = 'rgba(168, 85, 247, 0.8)';
                        ctx.lineWidth = 1;
                    }

                    ctx.fillRect(wx, wy, ww, wh);
                    ctx.strokeRect(wx, wy, ww, wh);
                });
            });
        }
        ctx.restore();
    }

    // 4. 실시간 마우스 드래그 중인 임시 사각 영역 (Selection Rect)
    if (ocrState.isDraggingRoi && ocrState.roiDragStart && ocrState.roiDragCurrent) {
        const start = ocrState.roiDragStart;
        const cur = ocrState.roiDragCurrent;

        const x = Math.min(start.x, cur.x);
        const y = Math.min(start.y, cur.y);
        const w = Math.abs(cur.x - start.x);
        const h = Math.abs(cur.y - start.y);

        ctx.fillStyle = 'rgba(234, 179, 8, 0.25)';
        ctx.fillRect(x, y, w, h);
        ctx.strokeStyle = '#eab308';
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 4]);
        ctx.strokeRect(x, y, w, h);
        ctx.setLineDash([]);
    }

    ctx.restore();
}


// ==============================================================================
// 6. 캔버스 인터랙션 (호버, 박스 클릭 복사, 드래그 ROI)
// ==============================================================================
function initOcrCanvasEvents() {
    const canvas = document.getElementById('ocr-interactive-canvas');
    if (!canvas) return;

    window.addEventListener('resize', () => {
        if (ocrState.image && typeof currentActiveTab !== 'undefined' && currentActiveTab === 'ocr') {
            renderOcrCanvas();
        }
    });

    canvas.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return; // 좌클릭만
        const rect = canvas.getBoundingClientRect();
        const cx = e.clientX - rect.left;
        const cy = e.clientY - rect.top;

        // Shift 키를 누르고 있거나 ROI 모드 버튼이 활성화된 경우 드래그 시작
        if (e.shiftKey || ocrState.roiSelectionMode) {
            ocrState.isDraggingRoi = true;
            ocrState.roiDragStart = { x: cx, y: cy };
            ocrState.roiDragCurrent = { x: cx, y: cy };
        } else {
            // 박스 클릭 복사를 위한 시작점 기록
            ocrState.clickStart = { x: cx, y: cy };
        }
    });

    canvas.addEventListener('mousemove', (e) => {
        const rect = canvas.getBoundingClientRect();
        const cx = e.clientX - rect.left;
        const cy = e.clientY - rect.top;

        if (ocrState.isDraggingRoi) {
            ocrState.roiDragCurrent = { x: cx, y: cy };
            renderOcrCanvas();
            return;
        }

        // 호버 히트테스트 (라인 / 단어)
        const hit = findHitItem(cx, cy);
        if (hit !== ocrState.hoveredItem) {
            ocrState.hoveredItem = hit;
            canvas.style.cursor = hit ? 'pointer' : (ocrState.roiSelectionMode ? 'crosshair' : 'default');
            renderOcrCanvas();
        }
    });

    canvas.addEventListener('mouseup', (e) => {
        const rect = canvas.getBoundingClientRect();
        const cx = e.clientX - rect.left;
        const cy = e.clientY - rect.top;

        if (ocrState.isDraggingRoi && ocrState.roiDragStart) {
            const start = ocrState.roiDragStart;
            ocrState.isDraggingRoi = false;
            ocrState.roiDragStart = null;
            ocrState.roiDragCurrent = null;

            const x = Math.min(start.x, cx);
            const y = Math.min(start.y, cy);
            const w = Math.abs(cx - start.x);
            const h = Math.abs(cy - start.y);

            // 최소 12px 이상 드래그했을 때만 유효한 ROI로 인식
            if (w >= 12 && h >= 12 && ocrState.scale > 0) {
                const imgX = Math.round(x / ocrState.scale);
                const imgY = Math.round(y / ocrState.scale);
                const imgW = Math.round(w / ocrState.scale);
                const imgH = Math.round(h / ocrState.scale);

                runOcrPipeline({
                    x: imgX,
                    y: imgY,
                    width: imgW,
                    height: imgH
                });
            } else {
                renderOcrCanvas();
            }
            return;
        }

        // 단순 클릭인 경우 바운딩 박스 텍스트 복사 처리
        if (ocrState.clickStart) {
            const dist = Math.hypot(cx - ocrState.clickStart.x, cy - ocrState.clickStart.y);
            ocrState.clickStart = null;

            if (dist <= 5) {
                const hit = findHitItem(cx, cy);
                if (hit && hit.data && hit.data.text) {
                    const text = hit.data.text.trim();
                    if (text) {
                        navigator.clipboard.writeText(text).then(() => {
                            showToast('텍스트 복사됨', text, '📋');
                        }).catch(() => {
                            showToast('복사 완료', text, '📋');
                        });
                    }
                }
            }
        }
    });

    canvas.addEventListener('mouseleave', () => {
        if (ocrState.hoveredItem) {
            ocrState.hoveredItem = null;
            canvas.style.cursor = 'default';
            renderOcrCanvas();
        }
    });
}

function findHitItem(cx, cy) {
    if (!ocrState.scale || ocrState.boxMode === 'none' || !ocrState.blocks) return null;

    const scale = ocrState.scale;
    const drawX = ocrState.offsetX || 0;
    const drawY = ocrState.offsetY || 0;
    let imgX = (cx - drawX) / scale;
    let imgY = (cy - drawY) / scale;

    const hasAngle = ocrState.textAngle && Math.abs(ocrState.textAngle) >= 0.1;
    if (hasAngle) {
        // Microsoft 공식 규격: TextAngle은 이미지 중심을 기준으로 한 시계 방향 회전각이므로,
        // 마우스 포인터를 이미지 중심 기준으로 -TextAngle만큼 역회전 변환하여 원본 BBox와 정합
        const origCenterX = ocrState.imageWidth / 2.0;
        const origCenterY = ocrState.imageHeight / 2.0;
        const invRad = -(ocrState.textAngle * Math.PI) / 180;
        const cos = Math.cos(invRad);
        const sin = Math.sin(invRad);

        const dx = imgX - origCenterX;
        const dy = imgY - origCenterY;
        imgX = dx * cos - dy * sin + origCenterX;
        imgY = dx * sin + dy * cos + origCenterY;
    }

    const isPointInItem = (item) => {
        return (
            imgX >= item.x && imgX <= item.x + item.width &&
            imgY >= item.y && imgY <= item.y + item.height
        );
    };

    if (ocrState.boxMode === 'word') {
        for (const block of ocrState.blocks) {
            for (const w of (block.words || [])) {
                if (isPointInItem(w)) {
                    return { type: 'word', data: w };
                }
            }
        }
    } else if (ocrState.boxMode === 'line') {
        for (const block of ocrState.blocks) {
            if (isPointInItem(block)) {
                return { type: 'line', data: block };
            }
        }
    }
    return null;
}


// ==============================================================================
// 7. 텍스트 에디터 도구 (복사, 정규화, 빠른 메모 연동, 비우기)
// ==============================================================================
function copyOcrText() {
    const editor = document.getElementById('ocr-text-output');
    if (!editor || !editor.value.trim()) {
        showToast('알림', '복사할 텍스트가 없습니다.', '⚠️');
        return;
    }

    navigator.clipboard.writeText(editor.value).then(() => {
        showToast('클립보드 복사', `${editor.value.length}자 텍스트가 클립보드에 복사되었습니다.`, '📋');
    }).catch(err => {
        showToast('복사 실패', err.message || '클립보드 쓰기 실패', '❌');
    });
}

function formatOcrText(mode) {
    const editor = document.getElementById('ocr-text-output');
    if (!editor || !editor.value) return;

    let text = editor.value;

    if (mode === 'merge') {
        // 문단 사이의 단일 줄바꿈을 공백으로 병합 (빈 줄로 분리된 문단은 보존)
        text = text.split(/\n\s*\n/).map(para => {
            return para.replace(/\n+/g, ' ').replace(/\s{2,}/g, ' ').trim();
        }).join('\n\n');
        showToast('줄 병합 완료', '줄바꿈을 공백으로 병합했습니다.', '✨');
    } else if (mode === 'clean') {
        // 연속된 중복 공백 및 불필요한 공백 문자 정리
        text = text.replace(/[ \t]+/g, ' ').trim();
        showToast('공백 정리 완료', '연속 공백을 단일 공백으로 정리했습니다.', '✨');
    }

    editor.value = text;
    updateOcrTextLengthBadge(text);
}

/**
 * 빠른 메모(Notes & Scratchpad) 연동
 * 기존 web/js/notes.js의 createNoteWithContent() 함수를 직접 재사용
 */
async function sendOcrTextToNotes() {
    const editor = document.getElementById('ocr-text-output');
    const content = editor ? editor.value.trim() : '';
    if (!content) {
        showToast('알림', '메모로 보낼 텍스트가 없습니다.', '⚠️');
        return;
    }

    const title = ocrState.filename
        ? `📷 OCR: ${ocrState.filename}`
        : `📷 OCR 추출 메모 (${new Date().toLocaleTimeString()})`;

    if (typeof createNoteWithContent === 'function') {
        await createNoteWithContent(title, content);
        if (typeof switchTab === 'function') {
            switchTab('notes');
        }
        showToast('메모 등록 완료', '새 메모가 생성되어 Notes 탭으로 이동했습니다.', '📝');
    } else {
        showToast('오류', 'Notes 모듈을 찾을 수 없습니다.', '❌');
    }
}

async function clearOcrWorkspace() {
    if (ocrState.image || (document.getElementById('ocr-text-output') && document.getElementById('ocr-text-output').value)) {
        const confirmed = await showAppConfirm('작업 공간을 비우시겠습니까?\n현재 로드된 이미지와 텍스트가 초기화됩니다.', {
            title: '작업 공간 초기화',
            icon: '🗑️',
            confirmText: '비우기',
            cancelText: '취소'
        });
        if (!confirmed) return;
    }

    ocrState.image = null;
    ocrState.dataUrl = null;
    ocrState.blocks = [];
    ocrState.rawText = '';
    ocrState.currentRoi = null;
    ocrState.hoveredItem = null;
    ocrState.textAngle = 0.0;
    ocrState.scaleApplied = 1.0;

    const canvas = document.getElementById('ocr-interactive-canvas');
    const placeholder = document.getElementById('ocr-empty-placeholder');
    const editor = document.getElementById('ocr-text-output');
    const resetBtn = document.getElementById('ocr-roi-reset-btn');

    if (canvas) canvas.style.display = 'none';
    if (placeholder) placeholder.style.display = 'flex';
    if (editor) editor.value = '';
    if (resetBtn) resetBtn.style.display = 'none';

    updateOcrTextLengthBadge('');
    ['latency', 'scale', 'angle', 'res', 'count'].forEach(id => {
        const el = document.getElementById(`ocr-badge-${id}`);
        if (el) el.style.display = 'none';
    });
}


// ==============================================================================
// 8. OCR 히스토리 드로어 & 관리
// ==============================================================================
async function loadOcrHistory() {
    try {
        if (window.eel && typeof eel.get_ocr_history === 'function') {
            const items = await eel.get_ocr_history(50)();
            renderOcrHistoryList(items);

            const countBadge = document.getElementById('ocr-history-count-badge');
            if (countBadge) {
                countBadge.textContent = items.length;
            }
        }
    } catch (err) {
        console.warn('OCR history load failed:', err);
    }
}

function renderOcrHistoryList(items) {
    const listEl = document.getElementById('ocr-history-list');
    if (!listEl) return;

    if (!items || items.length === 0) {
        listEl.innerHTML = `
            <div class="history-empty">
                <span>🕒</span>
                <p>최근 인식 기록이 없습니다.</p>
            </div>
        `;
        return;
    }

    listEl.innerHTML = items.map(item => {
        const sourceIcon = item.source_type === 'clipboard' ? '📋' :
                           item.source_type === 'slicer' ? '✂️' :
                           item.source_type === 'roi' ? '🎯' : '📁';
        const preview = escapeHtml((item.extracted_text || '').replace(/\s+/g, ' ').substring(0, 75));
        const filename = escapeHtml(item.filename || '무제');

        return `
            <div class="ocr-history-item" onclick="loadOcrHistoryItem(${item.id})">
                <div class="history-thumb-wrap">
                    ${item.thumbnail_url
                        ? `<img src="${item.thumbnail_url}" class="history-thumb" alt="thumbnail" loading="lazy">`
                        : `<div class="history-thumb-placeholder">${sourceIcon}</div>`
                    }
                </div>
                <div class="history-info">
                    <div class="history-title-row">
                        <span class="history-source-badge">${sourceIcon} ${escapeHtml(item.source_type)}</span>
                        <span class="history-name" title="${filename}">${filename}</span>
                    </div>
                    <div class="history-preview-text">${preview || '(텍스트 없음)'}</div>
                    <div class="history-meta-row">
                        <span class="history-latency">⚡ ${item.latency_ms}ms</span>
                        <span class="history-date">${escapeHtml(item.created_at || '')}</span>
                    </div>
                </div>
                <button type="button" class="history-delete-btn" onclick="deleteSingleOcrHistory(event, ${item.id})" title="이 기록 삭제">&times;</button>
            </div>
        `;
    }).join('');
}

function toggleOcrHistoryDrawer() {
    const drawer = document.getElementById('ocr-history-drawer');
    if (!drawer) return;
    ocrState.historyDrawerOpen = !ocrState.historyDrawerOpen;
    drawer.style.display = ocrState.historyDrawerOpen ? 'flex' : 'none';
    if (ocrState.historyDrawerOpen) {
        loadOcrHistory();
    }
}

async function loadOcrHistoryItem(id) {
    try {
        if (window.eel && typeof eel.get_ocr_history === 'function') {
            const items = await eel.get_ocr_history(100)();
            const found = items.find(i => i.id === id);
            if (!found) return;

            // 텍스트 에디터에 주입
            const editor = document.getElementById('ocr-text-output');
            if (editor) {
                editor.value = found.extracted_text || '';
                updateOcrTextLengthBadge(editor.value);
            }

            ocrState.blocks = found.blocks || [];
            ocrState.latencyMs = found.latency_ms || 0.0;
            ocrState.filename = found.filename || '';
            ocrState.sourceType = found.source_type || 'file';
            ocrState.imageWidth = found.image_width || 0;
            ocrState.imageHeight = found.image_height || 0;

            updateOcrStatsBadges();

            // 썸네일 이미지를 캔버스에 로드
            if (found.thumbnail_url) {
                const img = new Image();
                img.onload = () => {
                    ocrState.image = img;
                    const placeholder = document.getElementById('ocr-empty-placeholder');
                    const canvas = document.getElementById('ocr-interactive-canvas');
                    if (placeholder) placeholder.style.display = 'none';
                    if (canvas) canvas.style.display = 'block';
                    renderOcrCanvas();
                };
                img.src = found.thumbnail_url;
            }

            showToast('기록 불러오기', `${found.filename || '기록'} 텍스트를 불러왔습니다.`, '🕒');
        }
    } catch (err) {
        showToast('오류', `기록 로드 실패: ${err.message || err}`, '❌');
    }
}

async function deleteSingleOcrHistory(e, id) {
    if (e) e.stopPropagation();
    try {
        if (window.eel && typeof eel.delete_ocr_history === 'function') {
            await eel.delete_ocr_history(id)();
            await loadOcrHistory();
            showToast('삭제 완료', '기록이 삭제되었습니다.', '🗑️');
        }
    } catch (err) {
        showToast('오류', '기록 삭제 실패', '❌');
    }
}

async function confirmClearOcrHistory() {
    const confirmed = await showAppConfirm('모든 OCR 인식 기록과 썸네일을 완전히 삭제하시겠습니까?', {
        title: 'OCR 기록 전체 삭제',
        icon: '🗑️',
        confirmText: '전체 삭제',
        cancelText: '취소'
    });
    if (!confirmed) return;

    try {
        if (window.eel && typeof eel.clear_ocr_history === 'function') {
            await eel.clear_ocr_history()();
            await loadOcrHistory();
            showToast('초기화 완료', '모든 OCR 기록이 삭제되었습니다.', '✨');
        }
    } catch (err) {
        showToast('오류', '기록 초기화 실패', '❌');
    }
}


// ==============================================================================
// 9. 분할 뷰 리사이저 (좌우 패널 너비 조절)
// ==============================================================================
function initOcrResizer() {
    const resizer = document.getElementById('ocr-resizer');
    const canvasPane = document.getElementById('ocr-canvas-pane');
    const editorPane = document.getElementById('ocr-editor-pane');
    const workspace = document.querySelector('.ocr-workspace');
    if (!resizer || !canvasPane || !editorPane || !workspace) return;

    let isResizing = false;

    resizer.addEventListener('mousedown', (e) => {
        isResizing = true;
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
    });

    document.addEventListener('mousemove', (e) => {
        if (!isResizing) return;
        const wsRect = workspace.getBoundingClientRect();
        const offsetX = e.clientX - wsRect.left;
        const totalW = wsRect.width;

        const minW = 260;
        const maxW = totalW - 260;
        const clampedW = Math.max(minW, Math.min(maxW, offsetX));

        const leftPct = (clampedW / totalW) * 100;
        canvasPane.style.flex = `0 0 ${leftPct}%`;
        editorPane.style.flex = `0 0 ${100 - leftPct}%`;

        if (ocrState.image) {
            renderOcrCanvas();
        }
    });

    document.addEventListener('mouseup', () => {
        if (isResizing) {
            isResizing = false;
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
        }
    });
}

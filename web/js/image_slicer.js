/**
 * 인터랙티브 이미지 슬라이서 스튜디오 (web/js/image_slicer.js)
 * - 클립보드(Ctrl+V), 드래그&드롭, 파일 선택 대화상자 이미지 로드
 * - 다중 절단선 일괄 생성: 고정 px 간격 분할, 균등 N등분, 여백 자동 감지, 연속 클릭 추가
 * - 줌 & 패닝, 절단선 드래그 이동/삭제, 실시간 조각 계산
 * - ZIP 압축 일괄 다운로드, 대상 폴더 일괄 파일 저장, 조각별 클립보드 복사
 */

const slicerState = {
    image: null,
    dataUrl: '',
    fileName: '',
    fileSize: 0,
    imgWidth: 0,
    imgHeight: 0,
    cutLinesX: [], // [x1, x2, ...] sorted
    cutLinesY: [], // [y1, y2, ...] sorted
    mode: 'line_h', // 'line_h' | 'line_v' | 'select'
    continuousAdd: true,
    hoverLine: null, // { axis: 'x'|'y', index: number } | null
    draggingLine: null, // { axis: 'x'|'y', index: number } | null
    selectedLine: null, // { axis: 'x'|'y', index: number } | null
    zoom: 1.0,
    panX: 0,
    panY: 0,
    isPanning: false,
    panStartX: 0,
    panStartY: 0,
    slices: [], // [{ id, index, x, y, w, h, dataUrl, label }]
    exportFormat: 'png',
    exportQuality: 95
};

// ==========================================
// 1. 초기화 & 이벤트 리스너 등록
// ==========================================

function initImageSlicer() {
    const canvas = document.getElementById('slicer-canvas');
    const container = document.getElementById('slicer-canvas-wrapper');
    if (!canvas || !container) return;

    // 캔버스 마우스 인터랙션 바인딩
    canvas.addEventListener('mousedown', onSlicerMouseDown);
    window.addEventListener('mousemove', onSlicerMouseMove);
    window.addEventListener('mouseup', onSlicerMouseUp);
    container.addEventListener('wheel', onSlicerWheel, { passive: false });
    container.addEventListener('contextmenu', (e) => e.preventDefault());

    // 전역 클립보드 붙여넣기 (Ctrl + V)
    window.addEventListener('paste', onSlicerGlobalPaste);

    // 드래그 앤 드롭
    container.addEventListener('dragover', (e) => {
        e.preventDefault();
        container.classList.add('drag-over');
    });
    container.addEventListener('dragleave', () => {
        container.classList.remove('drag-over');
    });
    container.addEventListener('drop', onSlicerFileDrop);

    // 키보드 단축키
    window.addEventListener('keydown', onSlicerKeyDown);

    // 리사이즈 옵저버
    const resizeObserver = new ResizeObserver(() => {
        if (slicerState.image) renderSlicerCanvas();
    });
    resizeObserver.observe(container);
}

document.addEventListener('DOMContentLoaded', initImageSlicer);

// ==========================================
// 2. 이미지 로드 (파일 / 붙여넣기 / 드롭)
// ==========================================

async function openSlicerFileDialog() {
    if (window.eel && typeof eel.pick_image_file === 'function') {
        try {
            const res = await eel.pick_image_file()();
            if (res && res.status === 'success') {
                loadSlicerImage(res.data_url, res.file_name, res.file_size, res.width, res.height);
                logToConsole('이미지 로드 완료', `${res.file_name} (${res.width}×${res.height}px, ${(res.file_size / 1024).toFixed(1)} KB)`);
            } else if (res && res.status === 'error') {
                showToast('이미지 열기 오류', res.message, '⚠️');
            }
        } catch (e) {
            showToast('오류 발생', String(e), '⚠️');
        }
    } else {
        // 브라우저 input fallback
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*';
        input.onchange = (e) => {
            const file = e.target.files[0];
            if (file) handleLocalImageFile(file);
        };
        input.click();
    }
}

function handleLocalImageFile(file) {
    if (!file || !file.type.startsWith('image/')) {
        showToast('파일 형식 오류', '유효한 이미지 파일이 아닙니다.', '⚠️');
        return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
        const dataUrl = e.target.result;
        loadSlicerImage(dataUrl, file.name, file.size);
    };
    reader.readAsDataURL(file);
}

function onSlicerFileDrop(e) {
    e.preventDefault();
    const container = document.getElementById('slicer-canvas-wrapper');
    if (container) container.classList.remove('drag-over');

    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith('image/')) {
        handleLocalImageFile(file);
    }
}

function onSlicerGlobalPaste(e) {
    // 슬라이서 탭이 활성화되어 있을 때만 클립보드 이미지 처리
    const tabPane = document.getElementById('tab-slicer');
    if (!tabPane || !tabPane.classList.contains('active')) return;

    const items = (e.clipboardData || e.originalEvent.clipboardData).items;
    for (const item of items) {
        if (item.type.indexOf('image') !== -1) {
            const blob = item.getAsFile();
            const nowStr = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            handleLocalImageFile(new File([blob], `clipboard_${nowStr}.png`, { type: blob.type }));
            showToast('클립보드 이미지 로드', '클립보드의 이미지를 슬라이서로 가져왔습니다! 📋', '✅', 2500);
            e.preventDefault();
            break;
        }
    }
}

function loadSlicerImage(dataUrl, fileName = 'image.png', fileSize = 0, preW = 0, preH = 0) {
    const img = new Image();
    img.onload = () => {
        slicerState.image = img;
        slicerState.dataUrl = dataUrl;
        slicerState.fileName = fileName;
        slicerState.fileSize = fileSize || Math.round(dataUrl.length * 0.75);
        slicerState.imgWidth = img.naturalWidth || img.width;
        slicerState.imgHeight = img.naturalHeight || img.height;

        // 절단선 초기화
        slicerState.cutLinesX = [];
        slicerState.cutLinesY = [];
        slicerState.selectedLine = null;
        slicerState.hoverLine = null;

        // 화면 중앙 맞춤 배율 계산
        fitSlicerZoomToContainer();

        // UI 갱신
        document.getElementById('slicer-drop-zone').style.display = 'none';
        document.getElementById('slicer-canvas').style.display = 'block';
        updateSlicerHeaderInfo();
        recalculateSlices();
    };
    img.src = dataUrl;
}

function fitSlicerZoomToContainer() {
    const container = document.getElementById('slicer-canvas-wrapper');
    if (!container || !slicerState.imgWidth || !slicerState.imgHeight) return;

    const cw = container.clientWidth - 40;
    const ch = container.clientHeight - 40;

    const scaleX = cw / slicerState.imgWidth;
    const scaleY = ch / slicerState.imgHeight;
    const fitScale = Math.min(1.0, scaleX, scaleY);

    slicerState.zoom = Math.max(0.1, Math.min(fitScale, 3.0));
    slicerState.panX = Math.round((container.clientWidth - slicerState.imgWidth * slicerState.zoom) / 2);
    slicerState.panY = Math.round((container.clientHeight - slicerState.imgHeight * slicerState.zoom) / 2);

    renderSlicerCanvas();
    updateZoomBadge();
}

function resetSlicerZoom() {
    const container = document.getElementById('slicer-canvas-wrapper');
    if (!container || !slicerState.imgWidth || !slicerState.imgHeight) return;

    slicerState.zoom = 1.0;
    slicerState.panX = Math.round((container.clientWidth - slicerState.imgWidth) / 2);
    slicerState.panY = Math.round((container.clientHeight - slicerState.imgHeight) / 2);

    renderSlicerCanvas();
    updateZoomBadge();
}

function updateZoomBadge() {
    const badge = document.getElementById('slicer-zoom-indicator');
    if (badge) {
        badge.textContent = `${Math.round(slicerState.zoom * 100)}%`;
    }
}

function updateSlicerHeaderInfo() {
    const infoEl = document.getElementById('slicer-image-info');
    if (!infoEl) return;

    if (!slicerState.image) {
        infoEl.innerHTML = `<span>✂️ 이미지를 불러와 분할선을 추가하세요</span>`;
        return;
    }

    const sizeStr = (slicerState.fileSize / 1024).toFixed(1) + ' KB';
    infoEl.innerHTML = `
        <span class="slicer-file-badge">📁 ${escapeHtml(slicerState.fileName)} (${sizeStr})</span>
        <span class="slicer-res-badge">📐 ${slicerState.imgWidth} × ${slicerState.imgHeight} px</span>
    `;
}

// ==========================================
// 3. 다중 절단선 일괄 생성 (Batch Multi-Cut Tools)
// ==========================================

function addCutLine(axis, pos) {
    pos = Math.round(pos);
    const maxVal = axis === 'y' ? slicerState.imgHeight : slicerState.imgWidth;
    if (pos <= 0 || pos >= maxVal) return false;

    const list = axis === 'y' ? slicerState.cutLinesY : slicerState.cutLinesX;
    if (list.includes(pos)) return false;

    list.push(pos);
    list.sort((a, b) => a - b);
    return true;
}

// 3-1. 고정 px 간격 일괄 생성 (예: 매 500px마다 절단선 추가)
async function promptBatchLinesEveryPx() {
    if (!slicerState.image) {
        showToast('알림', '먼저 이미지를 불러와주세요.', '⚠️');
        return;
    }

    const defaultPx = Math.min(800, Math.round(slicerState.imgHeight / 3) || 500);
    const input = await showAppPrompt(
        `몇 px 간격으로 가로 절단선을 생성하시겠습니까?\n(이미지 전체 높이: ${slicerState.imgHeight}px)`,
        String(defaultPx),
        { title: '고정 픽셀(px) 간격 일괄 분할', icon: '📏' }
    );
    if (!input) return;

    const interval = parseInt(input.trim(), 10);
    if (isNaN(interval) || interval <= 10) {
        showToast('입력 오류', '유효한 픽셀 단위(10px 이상)를 입력해주세요.', '⚠️');
        return;
    }

    let addedCount = 0;
    for (let y = interval; y < slicerState.imgHeight; y += interval) {
        if (addCutLine('y', y)) addedCount++;
    }

    recalculateSlices();
    renderSlicerCanvas();
    showToast('일괄 생성 완료', `매 ${interval}px 마다 총 ${addedCount}개의 가로 절단선이 일괄 생성되었습니다! 📏`, '✅');
}

// 3-2. 균등 N등분 일괄 분할 (가로/세로)
async function promptEqualSplit() {
    if (!slicerState.image) {
        showToast('알림', '먼저 이미지를 불러와주세요.', '⚠️');
        return;
    }

    const input = await showAppPrompt(
        `가로 몇 등분으로 균등 분할하시겠습니까? (2 ~ 50)`,
        '4',
        { title: '균등 N등분 일괄 분할', icon: '🔢' }
    );
    if (!input) return;

    const count = parseInt(input.trim(), 10);
    if (isNaN(count) || count < 2 || count > 50) {
        showToast('입력 오류', '2부터 50 사이의 등분 숫자를 입력해주세요.', '⚠️');
        return;
    }

    const step = slicerState.imgHeight / count;
    let addedCount = 0;
    for (let i = 1; i < count; i++) {
        const y = Math.round(i * step);
        if (addCutLine('y', y)) addedCount++;
    }

    recalculateSlices();
    renderSlicerCanvas();
    showToast('N등분 생성 완료', `가로 ${count}등분 (${addedCount}개 절단선)이 균등하게 생성되었습니다! 🔢`, '✅');
}

// 3-3. M x N 그리드 바둑판 일괄 분할
async function promptGridSplit() {
    if (!slicerState.image) {
        showToast('알림', '먼저 이미지를 불러와주세요.', '⚠️');
        return;
    }

    const rowsInput = await showAppPrompt(
        `가로 행(Rows) 개수를 입력하세요 (1 ~ 20):`,
        '3',
        { title: '바둑판 그리드 행(Rows) 설정', icon: '▦' }
    );
    if (!rowsInput) return;
    const colsInput = await showAppPrompt(
        `세로 열(Columns) 개수를 입력하세요 (1 ~ 20):`,
        '3',
        { title: '바둑판 그리드 열(Columns) 설정', icon: '▦' }
    );
    if (!colsInput) return;

    const rows = parseInt(rowsInput.trim(), 10) || 1;
    const cols = parseInt(colsInput.trim(), 10) || 1;

    if (rows < 1 || cols < 1 || (rows === 1 && cols === 1)) {
        showToast('입력 오류', '올바른 행/열 숫자를 입력해주세요.', '⚠️');
        return;
    }

    if (rows > 1) {
        const stepY = slicerState.imgHeight / rows;
        for (let r = 1; r < rows; r++) addCutLine('y', Math.round(r * stepY));
    }
    if (cols > 1) {
        const stepX = slicerState.imgWidth / cols;
        for (let c = 1; c < cols; c++) addCutLine('x', Math.round(c * stepX));
    }

    recalculateSlices();
    renderSlicerCanvas();
    showToast('그리드 생성 완료', `${rows}행 × ${cols}열 (총 ${rows * cols}개 조각) 분할선이 생성되었습니다! 🔲`, '✅');
}

// 3-4. 여백 자동 감지 (Gap Detection)
async function autoDetectSmartGaps() {
    if (!slicerState.image || !slicerState.dataUrl) {
        showToast('알림', '먼저 이미지를 불러와주세요.', '⚠️');
        return;
    }

    showToast('여백 분석 중', '이미지 내의 수평 단색 여백을 스캔하고 있습니다... ⏳', '⏳', 1500);

    if (window.eel && typeof eel.detect_image_gaps === 'function') {
        try {
            const res = await eel.detect_image_gaps(slicerState.dataUrl, 15)();
            if (res && res.status === 'success') {
                const gaps = res.cut_lines_y || [];
                if (gaps.length === 0) {
                    showToast('여백 감지 결과', '자동 분할할 만한 15px 이상의 빈 여백을 찾지 못했습니다.', 'ℹ️');
                    return;
                }

                let added = 0;
                gaps.forEach(y => {
                    if (addCutLine('y', y)) added++;
                });

                recalculateSlices();
                renderSlicerCanvas();
                showToast('여백 감지 완료', `콘텐츠 사이의 여백에 ${added}개의 절단선이 자동 배치되었습니다! 💡`, '✅', 4000);
            } else {
                showToast('감지 실패', (res && res.message) || '여백 감지에 실패했습니다.', '⚠️');
            }
        } catch (e) {
            showToast('오류 발생', String(e), '⚠️');
        }
    } else {
        showToast('지원 불가', '여백 감지 백엔드 API가 준비되지 않았습니다.', '⚠️');
    }
}

// 3-5. 절단선 전체 삭제
function clearAllCutLines() {
    if (slicerState.cutLinesX.length === 0 && slicerState.cutLinesY.length === 0) return;

    slicerState.cutLinesX = [];
    slicerState.cutLinesY = [];
    slicerState.selectedLine = null;
    slicerState.hoverLine = null;

    recalculateSlices();
    renderSlicerCanvas();
    showToast('절단선 초기화', '모든 절단선이 삭제되었습니다. 🧹', 'ℹ️', 1800);
}

function setSlicerToolMode(mode) {
    slicerState.mode = mode;
    document.querySelectorAll('.slicer-tool-btn').forEach(btn => {
        btn.classList.toggle('active', btn.getAttribute('data-mode') === mode);
    });
}

// ==========================================
// 4. 캔버스 렌더러 & 조각 시각화
// ==========================================

function renderSlicerCanvas() {
    const canvas = document.getElementById('slicer-canvas');
    const container = document.getElementById('slicer-canvas-wrapper');
    if (!canvas || !container || !slicerState.image) return;

    const ctx = canvas.getContext('2d');
    canvas.width = container.clientWidth;
    canvas.height = container.clientHeight;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const { zoom, panX, panY, imgWidth, imgHeight } = slicerState;
    const destW = imgWidth * zoom;
    const destH = imgHeight * zoom;

    // 1. 배경 어두운 모눈 격자
    ctx.save();
    ctx.fillStyle = '#0f1117';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // 2. 원본 이미지 렌더링
    ctx.drawImage(slicerState.image, panX, panY, destW, destH);

    // 이미지 외곽선 테두리
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
    ctx.lineWidth = 1;
    ctx.strokeRect(panX, panY, destW, destH);
    ctx.restore();

    // 3. 조각 분할 영역 및 번호 뱃지 렌더링
    renderSliceOverlays(ctx);

    // 4. 절단선 렌더링 (가로 & 세로)
    renderCutLines(ctx);
}

function renderSliceOverlays(ctx) {
    const { zoom, panX, panY, slices } = slicerState;
    if (!slices || slices.length === 0) return;

    ctx.save();
    slices.forEach((slice, idx) => {
        const sx = panX + slice.x * zoom;
        const sy = panY + slice.y * zoom;
        const sw = slice.w * zoom;
        const sh = slice.h * zoom;

        // 각 조각 교차 은은한 하이라이트
        const isEven = idx % 2 === 0;
        ctx.fillStyle = isEven ? 'rgba(99, 102, 241, 0.04)' : 'rgba(56, 189, 248, 0.04)';
        ctx.fillRect(sx, sy, sw, sh);

        // 조각 번호 뱃지 (#1, #2, ...)
        if (sw > 30 && sh > 20) {
            ctx.fillStyle = 'rgba(15, 23, 42, 0.75)';
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
            ctx.lineWidth = 1;

            const badgeText = `#${idx + 1} (${slice.w}×${slice.h})`;
            ctx.font = 'bold 11px Inter, sans-serif';
            const textWidth = ctx.measureText(badgeText).width;

            const bw = Math.min(sw - 8, textWidth + 12);
            const bh = 20;
            const bx = sx + 6;
            const by = sy + 6;

            ctx.beginPath();
            ctx.roundRect(bx, by, bw, bh, 4);
            ctx.fill();
            ctx.stroke();

            ctx.fillStyle = '#f8fafc';
            ctx.textBaseline = 'middle';
            ctx.fillText(badgeText, bx + 6, by + bh / 2, bw - 10);
        }
    });
    ctx.restore();
}

function renderCutLines(ctx) {
    const { zoom, panX, panY, imgWidth, imgHeight, cutLinesX, cutLinesY, hoverLine, selectedLine } = slicerState;
    const destW = imgWidth * zoom;
    const destH = imgHeight * zoom;

    ctx.save();

    // 1) 가로 절단선 (Horizontal)
    cutLinesY.forEach((y, idx) => {
        const screenY = panX + y * zoom; // Y 좌표
        const sy = panY + y * zoom;
        const isHover = hoverLine && hoverLine.axis === 'y' && hoverLine.index === idx;
        const isSelected = selectedLine && selectedLine.axis === 'y' && selectedLine.index === idx;

        // 선 스타일링
        ctx.beginPath();
        ctx.strokeStyle = isHover || isSelected ? '#f43f5e' : '#38bdf8';
        ctx.lineWidth = isHover || isSelected ? 2.5 : 1.5;
        ctx.setLineDash(isHover || isSelected ? [] : [6, 4]);

        ctx.moveTo(panX - 20, sy);
        ctx.lineTo(panX + destW + 20, sy);
        ctx.stroke();

        // 좌우 끝 드래그 핸들 / 라벨
        ctx.setLineDash([]);
        ctx.fillStyle = isHover || isSelected ? '#f43f5e' : '#0284c7';
        ctx.beginPath();
        ctx.roundRect(panX + destW + 4, sy - 10, 48, 20, 3);
        ctx.fill();

        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 10px monospace';
        ctx.textBaseline = 'middle';
        ctx.fillText(`${y}px`, panX + destW + 8, sy);
    });

    // 2) 세로 절단선 (Vertical)
    cutLinesX.forEach((x, idx) => {
        const sx = panX + x * zoom;
        const isHover = hoverLine && hoverLine.axis === 'x' && hoverLine.index === idx;
        const isSelected = selectedLine && selectedLine.axis === 'x' && selectedLine.index === idx;

        ctx.beginPath();
        ctx.strokeStyle = isHover || isSelected ? '#f43f5e' : '#38bdf8';
        ctx.lineWidth = isHover || isSelected ? 2.5 : 1.5;
        ctx.setLineDash(isHover || isSelected ? [] : [6, 4]);

        ctx.moveTo(sx, panY - 20);
        ctx.lineTo(sx, panY + destH + 20);
        ctx.stroke();

        // 상단 끝 라벨
        ctx.setLineDash([]);
        ctx.fillStyle = isHover || isSelected ? '#f43f5e' : '#0284c7';
        ctx.beginPath();
        ctx.roundRect(sx - 24, panY - 24, 48, 18, 3);
        ctx.fill();

        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 10px monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(`${x}px`, sx, panY - 15);
    });

    ctx.restore();
}

// ==========================================
// 5. 마우스 & 키보드 인터랙션
// ==========================================

function getMousePosInCanvas(e) {
    const canvas = document.getElementById('slicer-canvas');
    const rect = canvas.getBoundingClientRect();
    return {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top
    };
}

function canvasToImageCoords(cx, cy) {
    const { zoom, panX, panY, imgWidth, imgHeight } = slicerState;
    const imgX = (cx - panX) / zoom;
    const imgY = (cy - panY) / zoom;
    return {
        x: Math.max(0, Math.min(imgWidth, imgX)),
        y: Math.max(0, Math.min(imgHeight, imgY))
    };
}

function findLineNearMouse(cx, cy) {
    const { zoom, panX, panY, cutLinesX, cutLinesY } = slicerState;
    const threshold = 8; // 8px 이내 감지

    // 가로선 체크
    for (let i = 0; i < cutLinesY.length; i++) {
        const sy = panY + cutLinesY[i] * zoom;
        if (Math.abs(cy - sy) <= threshold) {
            return { axis: 'y', index: i };
        }
    }

    // 세로선 체크
    for (let i = 0; i < cutLinesX.length; i++) {
        const sx = panX + cutLinesX[i] * zoom;
        if (Math.abs(cx - sx) <= threshold) {
            return { axis: 'x', index: i };
        }
    }

    return null;
}

function onSlicerMouseDown(e) {
    if (!slicerState.image) return;

    const { x, y } = getMousePosInCanvas(e);

    // 스페이스바 누른 상태 또는 우클릭/휠클릭 -> 패닝 모드
    if (e.button === 1 || e.button === 2 || e.spaceKey || e.shiftKey && e.button === 0 && slicerState.mode === 'pan') {
        slicerState.isPanning = true;
        slicerState.panStartX = e.clientX - slicerState.panX;
        slicerState.panStartY = e.clientY - slicerState.panY;
        return;
    }

    if (e.button !== 0) return; // 좌클릭만 처리

    // 1. 기존 절단선 클릭 체크 -> 드래그 시작
    const nearLine = findLineNearMouse(x, y);
    if (nearLine) {
        slicerState.draggingLine = nearLine;
        slicerState.selectedLine = nearLine;
        renderSlicerCanvas();
        return;
    }

    // 2. 신규 절단선 추가
    const imgPos = canvasToImageCoords(x, y);
    if (slicerState.mode === 'line_h') {
        if (addCutLine('y', imgPos.y)) {
            recalculateSlices();
            renderSlicerCanvas();
        }
    } else if (slicerState.mode === 'line_v') {
        if (addCutLine('x', imgPos.x)) {
            recalculateSlices();
            renderSlicerCanvas();
        }
    }
}

function onSlicerMouseMove(e) {
    const canvas = document.getElementById('slicer-canvas');
    if (!canvas || !slicerState.image) return;

    if (slicerState.isPanning) {
        slicerState.panX = e.clientX - slicerState.panStartX;
        slicerState.panY = e.clientY - slicerState.panStartY;
        renderSlicerCanvas();
        return;
    }

    const { x, y } = getMousePosInCanvas(e);

    // 절단선 드래그 이동 중
    if (slicerState.draggingLine) {
        const imgPos = canvasToImageCoords(x, y);
        const { axis, index } = slicerState.draggingLine;
        if (axis === 'y') {
            slicerState.cutLinesY[index] = Math.round(Math.max(5, Math.min(slicerState.imgHeight - 5, imgPos.y)));
        } else {
            slicerState.cutLinesX[index] = Math.round(Math.max(5, Math.min(slicerState.imgWidth - 5, imgPos.x)));
        }
        recalculateSlices();
        renderSlicerCanvas();
        return;
    }

    // 호버 감지 및 커서 변경
    const nearLine = findLineNearMouse(x, y);
    slicerState.hoverLine = nearLine;

    if (nearLine) {
        canvas.style.cursor = nearLine.axis === 'y' ? 'row-resize' : 'col-resize';
    } else if (slicerState.mode === 'line_h') {
        canvas.style.cursor = 'crosshair';
    } else if (slicerState.mode === 'line_v') {
        canvas.style.cursor = 'crosshair';
    } else {
        canvas.style.cursor = 'default';
    }

    renderSlicerCanvas();
}

function onSlicerMouseUp(e) {
    if (slicerState.isPanning) {
        slicerState.isPanning = false;
    }
    if (slicerState.draggingLine) {
        slicerState.draggingLine = null;
        slicerState.cutLinesX.sort((a, b) => a - b);
        slicerState.cutLinesY.sort((a, b) => a - b);
        recalculateSlices();
        renderSlicerCanvas();
    }
}

function onSlicerWheel(e) {
    if (!slicerState.image) return;
    e.preventDefault();

    const { x, y } = getMousePosInCanvas(e);
    const zoomFactor = e.deltaY < 0 ? 1.15 : 0.85;
    const newZoom = Math.max(0.1, Math.min(slicerState.zoom * zoomFactor, 5.0));

    // 마우스 위치 기준으로 줌 중심 고정
    slicerState.panX = x - (x - slicerState.panX) * (newZoom / slicerState.zoom);
    slicerState.panY = y - (y - slicerState.panY) * (newZoom / slicerState.zoom);
    slicerState.zoom = newZoom;

    renderSlicerCanvas();
    updateZoomBadge();
}

function onSlicerKeyDown(e) {
    const tabPane = document.getElementById('tab-slicer');
    if (!tabPane || !tabPane.classList.contains('active')) return;

    // Delete / Backspace: 선택된 선 삭제
    if ((e.key === 'Delete' || e.key === 'Backspace') && slicerState.selectedLine) {
        const { axis, index } = slicerState.selectedLine;
        if (axis === 'y') {
            slicerState.cutLinesY.splice(index, 1);
        } else {
            slicerState.cutLinesX.splice(index, 1);
        }
        slicerState.selectedLine = null;
        slicerState.hoverLine = null;
        recalculateSlices();
        renderSlicerCanvas();
        showToast('선 삭제', '선택된 절단선이 삭제되었습니다.', '🗑️', 1500);
        e.preventDefault();
    }
}

// ==========================================
// 6. 조각 분할 계산 & 썸네일 갤러리 렌더링
// ==========================================

function recalculateSlices() {
    if (!slicerState.image) {
        slicerState.slices = [];
        renderSlicesGallery();
        return;
    }

    const { imgWidth, imgHeight, cutLinesX, cutLinesY } = slicerState;

    const xs = [0, ...cutLinesX, imgWidth];
    const ys = [0, ...cutLinesY, imgHeight];

    const slices = [];
    let sliceIdx = 1;

    for (let r = 0; r < ys.length - 1; r++) {
        for (let c = 0; c < xs.length - 1; c++) {
            const x = xs[c];
            const y = ys[r];
            const w = xs[c + 1] - xs[c];
            const h = ys[r + 1] - ys[r];

            if (w > 0 && h > 0) {
                slices.push({
                    id: `slice_${sliceIdx}`,
                    index: sliceIdx,
                    x: x,
                    y: y,
                    w: w,
                    h: h,
                    label: `조각 #${sliceIdx}`
                });
                sliceIdx++;
            }
        }
    }

    slicerState.slices = slices;
    renderSlicesGallery();
}

function renderSlicesGallery() {
    const galleryEl = document.getElementById('slicer-gallery-grid');
    const badgeEl = document.getElementById('slicer-slice-count-badge');
    if (!galleryEl) return;

    const total = slicerState.slices.length;
    if (badgeEl) {
        badgeEl.textContent = `${total}개 조각`;
    }

    if (total === 0) {
        galleryEl.innerHTML = `<div class="slicer-empty-gallery">절단선을 추가하면 여기에 잘릴 조각 썸네일과 다운로드 버튼이 표시됩니다.</div>`;
        return;
    }

    let html = '';
    slicerState.slices.forEach((slice, idx) => {
        html += `
            <div class="slice-card" data-slice-idx="${idx}">
                <div class="slice-card-thumb-wrap">
                    <canvas id="slice-thumb-${idx}" class="slice-thumb-canvas" width="${slice.w}" height="${slice.h}"></canvas>
                    <span class="slice-num-tag">#${idx + 1}</span>
                </div>
                <div class="slice-card-info">
                    <div class="slice-card-title">조각 #${idx + 1}</div>
                    <div class="slice-card-res">${slice.w} × ${slice.h} px</div>
                    <div class="slice-card-actions">
                        <button type="button" class="mini-tool-btn" onclick="copySingleSliceToClipboard(${idx})" title="이 조각 클립보드 복사">📋 복사</button>
                        <button type="button" class="mini-tool-btn primary" onclick="downloadSingleSlice(${idx})" title="이 조각 파일 다운로드">💾 저장</button>
                    </div>
                </div>
            </div>
        `;
    });

    galleryEl.innerHTML = html;

    // 조각 썸네일 렌더링 (Canvas drawImage crop)
    slicerState.slices.forEach((slice, idx) => {
        const thumbCanvas = document.getElementById(`slice-thumb-${idx}`);
        if (thumbCanvas && slicerState.image) {
            const ctx = thumbCanvas.getContext('2d');
            ctx.drawImage(
                slicerState.image,
                slice.x, slice.y, slice.w, slice.h,
                0, 0, slice.w, slice.h
            );
        }
    });
}

// ==========================================
// 7. 내보내기 & 저장 (ZIP / 폴더 / 클립보드)
// ==========================================

function getSlicesBBoxes() {
    return slicerState.slices.map(s => [s.x, s.y, s.w, s.h]);
}

async function exportSlicesAsZip() {
    if (!slicerState.image || slicerState.slices.length === 0) {
        showToast('알림', '내보낼 슬라이스 조각이 없습니다.', '⚠️');
        return;
    }

    const bboxes = getSlicesBBoxes();
    const baseName = slicerState.fileName ? slicerState.fileName.replace(/\.[^/.]+$/, '') : 'slices';
    const zipName = `${baseName}_slices.zip`;

    showToast('ZIP 압축 중', `총 ${bboxes.length}개 조각을 ZIP 파일로 압축 생성하고 있습니다... ⏳`, '📦', 2000);

    if (window.eel && typeof eel.slice_and_export_zip === 'function') {
        try {
            const res = await eel.slice_and_export_zip(
                slicerState.dataUrl,
                bboxes,
                zipName,
                'slice',
                slicerState.exportFormat,
                slicerState.exportQuality
            )();

            if (res && res.status === 'success') {
                logToConsole('ZIP 압축 저장 완료', `${res.file_name} (${res.count}개 조각)`);
                showToast('ZIP 저장 완료', `총 ${res.count}개의 조각이 ZIP 파일로 성공적으로 저장되었습니다! 📦\n(${res.zip_path})`, '✅');
            } else if (res && res.status === 'cancelled') {
                // 사용자 취소
            } else {
                showToast('저장 실패', (res && res.message) || 'ZIP 생성에 실패했습니다.', '⚠️');
            }
        } catch (e) {
            showToast('오류 발생', String(e), '⚠️');
        }
    } else {
        showToast('지원 불가', 'ZIP 내보내기 백엔드 API가 준비되지 않았습니다.', '⚠️');
    }
}

async function saveSlicesToFolder() {
    if (!slicerState.image || slicerState.slices.length === 0) {
        showToast('알림', '저장할 슬라이스 조각이 없습니다.', '⚠️');
        return;
    }

    const bboxes = getSlicesBBoxes();

    if (window.eel && typeof eel.slice_and_save_to_folder === 'function') {
        try {
            const res = await eel.slice_and_save_to_folder(
                slicerState.dataUrl,
                bboxes,
                '', // 폴더 선택창 자동 오픈
                'slice',
                slicerState.exportFormat,
                slicerState.exportQuality
            )();

            if (res && res.status === 'success') {
                logToConsole('조각 파일 저장 완료', `총 ${res.count}개 파일 -> ${res.folder_path}`);
                showToast('저장 완료', `총 ${res.count}개의 슬라이스 파일이 대상 폴더에 성공적으로 저장되었습니다! 📂\n(${res.folder_path})`, '✅');
            } else if (res && res.status === 'cancelled') {
                // 취소
            } else {
                showToast('저장 실패', (res && res.message) || '파일 저장에 실패했습니다.', '⚠️');
            }
        } catch (e) {
            showToast('오류 발생', String(e), '⚠️');
        }
    }
}

async function copySingleSliceToClipboard(sliceIdx) {
    const slice = slicerState.slices[sliceIdx];
    if (!slice || !slicerState.image) return;

    try {
        const offCanvas = document.createElement('canvas');
        offCanvas.width = slice.w;
        offCanvas.height = slice.h;
        const ctx = offCanvas.getContext('2d');
        ctx.drawImage(
            slicerState.image,
            slice.x, slice.y, slice.w, slice.h,
            0, 0, slice.w, slice.h
        );

        offCanvas.toBlob(async (blob) => {
            if (blob && navigator.clipboard && navigator.clipboard.write) {
                await navigator.clipboard.write([
                    new ClipboardItem({ 'image/png': blob })
                ]);
                showToast('클립보드 복사 완료', `조각 #${sliceIdx + 1} (${slice.w}×${slice.h}px) 이미지가 클립보드에 복사되었습니다! 📋`, '✅', 2500);
            }
        }, 'image/png');
    } catch (e) {
        showToast('복사 실패', String(e), '⚠️');
    }
}

function downloadSingleSlice(sliceIdx) {
    const slice = slicerState.slices[sliceIdx];
    if (!slice || !slicerState.image) return;

    const offCanvas = document.createElement('canvas');
    offCanvas.width = slice.w;
    offCanvas.height = slice.h;
    const ctx = offCanvas.getContext('2d');
    ctx.drawImage(
        slicerState.image,
        slice.x, slice.y, slice.w, slice.h,
        0, 0, slice.w, slice.h
    );

    const baseName = slicerState.fileName ? slicerState.fileName.replace(/\.[^/.]+$/, '') : 'image';
    const filename = `${baseName}_slice_${String(sliceIdx + 1).padStart(2, '0')}.png`;

    const a = document.createElement('a');
    a.href = offCanvas.toDataURL('image/png');
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    showToast('다운로드 완료', `${filename} 파일이 다운로드되었습니다! 💾`, '✅', 2000);
}

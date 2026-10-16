/**
 * web/js/qr_toolkit.js
 * QR 코드 스캐너 & 생성기 통합 프론트엔드 모듈
 * - 실시간 웹캠 비디오 스캔 (BarcodeDetector 우선 / jsQR 폴백)
 * - 이미지 파일 드래그 앤 드롭 & 클립보드 붙여넣기 (Ctrl+V) 인식
 * - 다목적 QR 생성기 (URL, Wi-Fi, 이메일, 전화번호, vCard)
 * - PNG 다운로드 & 클립보드 복사
 * - SQLite DB 연동 스캔/생성 이력 관리
 * - 비차단 인레이어 UI (showToast, showAppConfirm) 적용
 */

let qrCameraStream = null;
let qrScanAnimFrameId = null;
let qrBarcodeDetector = null;
let qrGeneratorInstance = null;
let qrCurrentDetectedData = "";
let qrCurrentDetectedUrl = "";
let qrLastScannedContent = "";
let qrLastScannedTime = 0;

// =============================================================================
// 1. 서브탭 전환 및 라이프사이클 관리
// =============================================================================

function switchQrSubTab(tabName) {
    const tabs = ["scanner", "generator", "history"];
    tabs.forEach(t => {
        const btn = document.getElementById(`qr-subtab-${t}-btn`);
        const pane = document.getElementById(`qr-pane-${t}`);
        if (btn) btn.classList.toggle("active", t === tabName);
        if (pane) {
            pane.style.display = (t === tabName) ? "block" : "none";
            pane.classList.toggle("active", t === tabName);
        }
    });

    if (tabName !== "scanner") {
        // 스캐너 탭을 벗어날 때 카메라 자동 중지
        stopQrCamera();
    } else {
        // 스캐너 서브탭 진입 시
    }

    if (tabName === "generator") {
        setTimeout(renderGeneratedQr, 50);
    } else if (tabName === "history") {
        loadQrHistory();
    }
}

// =============================================================================
// 2. BarcodeDetector 초기화 (브라우저 가속 지원 시)
// =============================================================================

async function initBarcodeDetector() {
    if ("BarcodeDetector" in window) {
        try {
            const formats = await window.BarcodeDetector.getSupportedFormats();
            if (formats.includes("qr_code")) {
                qrBarcodeDetector = new window.BarcodeDetector({ formats: ["qr_code"] });
                console.log("[QR] 네이티브 BarcodeDetector 활성화");
                return;
            }
        } catch (e) {
            console.warn("[QR] BarcodeDetector 초기화 실패, jsQR 폴백 사용:", e);
        }
    }
    console.log("[QR] jsQR 소프트웨어 디코더 사용");
}

// =============================================================================
// 3. 웹캠/카메라 실시간 스캔
// =============================================================================

async function toggleQrCamera() {
    if (qrCameraStream) {
        stopQrCamera();
    } else {
        await startQrCamera();
    }
}

async function startQrCamera(deviceId = null) {
    const video = document.getElementById("qr-video");
    const videoWrapper = document.getElementById("qr-video-wrapper");
    const staticWrapper = document.getElementById("qr-static-wrapper");
    const btn = document.getElementById("qr-camera-toggle-btn");
    const btnIcon = document.getElementById("qr-camera-btn-icon");
    const btnText = document.getElementById("qr-camera-btn-text");
    const selectWrap = document.getElementById("qr-camera-select-wrap");

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        if (typeof showToast === "function") {
            showToast("카메라 미지원", "현재 브라우저/환경에서는 카메라 API를 지원하지 않습니다.", "warn");
        }
        return;
    }

    try {
        const constraints = {
            video: deviceId ? { deviceId: { exact: deviceId } } : { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } }
        };

        qrCameraStream = await navigator.mediaDevices.getUserMedia(constraints);
        video.srcObject = qrCameraStream;
        await video.play();

        videoWrapper.style.display = "block";
        staticWrapper.style.display = "none";

        if (btn) btn.classList.replace("add-btn", "delete-btn");
        if (btnIcon) btnIcon.textContent = "⏹️";
        if (btnText) btnText.textContent = "카메라 스캔 중지";

        await populateCameraDevices();
        if (selectWrap) selectWrap.style.display = "inline-flex";

        if (typeof showToast === "function") {
            showToast("카메라 시작", "QR 코드를 카메라에 비추면 자동으로 인식합니다.", "info");
        }

        // 스캔 루프 시작
        scanVideoFrameLoop();
    } catch (err) {
        console.error("[QR] 카메라 시작 실패:", err);
        if (typeof showToast === "function") {
            showToast("카메라 접근 실패", `카메라에 접근할 수 없습니다: ${err.message || err.name}`, "error");
        }
        stopQrCamera();
    }
}

function stopQrCamera() {
    if (qrScanAnimFrameId) {
        cancelAnimationFrame(qrScanAnimFrameId);
        qrScanAnimFrameId = null;
    }

    if (qrCameraStream) {
        qrCameraStream.getTracks().forEach(track => track.stop());
        qrCameraStream = null;
    }

    const video = document.getElementById("qr-video");
    if (video) video.srcObject = null;

    const videoWrapper = document.getElementById("qr-video-wrapper");
    const staticWrapper = document.getElementById("qr-static-wrapper");
    const btn = document.getElementById("qr-camera-toggle-btn");
    const btnIcon = document.getElementById("qr-camera-btn-icon");
    const btnText = document.getElementById("qr-camera-btn-text");
    const selectWrap = document.getElementById("qr-camera-select-wrap");

    if (videoWrapper) videoWrapper.style.display = "none";
    if (staticWrapper) staticWrapper.style.display = "block";
    if (btn) btn.classList.replace("delete-btn", "add-btn");
    if (btnIcon) btnIcon.textContent = "📹";
    if (btnText) btnText.textContent = "카메라 스캔 시작";
    if (selectWrap) selectWrap.style.display = "none";
}

async function populateCameraDevices() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const videoDevices = devices.filter(d => d.kind === "videoinput");
        const select = document.getElementById("qr-camera-device-select");
        if (!select) return;

        const currentTracks = qrCameraStream ? qrCameraStream.getVideoTracks() : [];
        const currentDeviceId = currentTracks.length > 0 ? currentTracks[0].getSettings().deviceId : null;

        select.innerHTML = "";
        videoDevices.forEach((dev, idx) => {
            const opt = document.createElement("option");
            opt.value = dev.deviceId;
            opt.textContent = dev.label || `카메라 ${idx + 1}`;
            if (dev.deviceId === currentDeviceId) opt.selected = true;
            select.appendChild(opt);
        });
    } catch (e) {
        console.warn("[QR] 디바이스 목록 조회 실패:", e);
    }
}

function onQrCameraDeviceChange(deviceId) {
    if (!deviceId) return;
    stopQrCamera();
    startQrCamera(deviceId);
}

async function scanVideoFrameLoop() {
    if (!qrCameraStream) return;
    const video = document.getElementById("qr-video");

    if (video && video.readyState === video.HAVE_ENOUGH_DATA) {
        let detectedRaw = null;

        // 1) BarcodeDetector 시도
        if (qrBarcodeDetector) {
            try {
                const barcodes = await qrBarcodeDetector.detect(video);
                if (barcodes && barcodes.length > 0) {
                    detectedRaw = barcodes[0].rawValue;
                }
            } catch (e) {
                // 무시하고 jsQR 시도
            }
        }

        // 2) BarcodeDetector 없거나 실패 시 jsQR 사용
        if (!detectedRaw && typeof jsQR === "function") {
            const canvas = document.createElement("canvas");
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            const ctx = canvas.getContext("2d");
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const code = jsQR(imgData.data, imgData.width, imgData.height, {
                inversionAttempts: "dontInvert"
            });
            if (code && code.data) {
                detectedRaw = code.data;
            }
        }

        if (detectedRaw) {
            const now = Date.now();
            // 동일 내용 연속 인식 방지 (1.5초 쿨다운)
            if (detectedRaw !== qrLastScannedContent || (now - qrLastScannedTime) > 1500) {
                qrLastScannedContent = detectedRaw;
                qrLastScannedTime = now;
                handleQrDetectionSuccess(detectedRaw, "camera");
            }
        }
    }

    if (qrCameraStream) {
        qrScanAnimFrameId = requestAnimationFrame(scanVideoFrameLoop);
    }
}

// =============================================================================
// 4. 이미지 파일 / 클립보드 스캔
// =============================================================================

function openQrImageFile() {
    const input = document.getElementById("qr-file-input");
    if (input) {
        input.value = "";
        input.click();
    }
}

function onQrFileInputChange(event) {
    const file = event.target.files && event.target.files[0];
    if (file) {
        loadAndDecodeImageFile(file);
    }
}

function loadAndDecodeImageFile(file) {
    if (!file.type.startsWith("image/")) {
        if (typeof showToast === "function") {
            showToast("지원되지 않는 파일", "이미지 파일(PNG, JPG, WebP 등)을 선택해 주세요.", "warn");
        }
        return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
            decodeImageElement(img);
        };
        img.src = e.target.result;
    };
    reader.readAsDataURL(file);
}

async function pasteQrFromClipboard() {
    try {
        if (!navigator.clipboard || !navigator.clipboard.read) {
            if (typeof showToast === "function") {
                showToast("붙여넣기 안내", "화면에서 Ctrl + V를 눌러 캡처 이미지를 붙여넣으세요.", "info");
            }
            return;
        }

        const items = await navigator.clipboard.read();
        let foundImage = false;
        for (const item of items) {
            const imageType = item.types.find(t => t.startsWith("image/"));
            if (imageType) {
                const blob = await item.getType(imageType);
                loadAndDecodeImageFile(blob);
                foundImage = true;
                break;
            }
        }

        if (!foundImage) {
            if (typeof showToast === "function") {
                showToast("이미지 없음", "클립보드에 이미지 데이터가 없습니다. Win+Shift+S 등으로 캡처 후 다시 시도하세요.", "warn");
            }
        }
    } catch (e) {
        console.warn("[QR] 클립보드 읽기 API 실패, 단축키 안내:", e);
        if (typeof showToast === "function") {
            showToast("붙여넣기 안내", "화면에서 단축키 Ctrl + V를 직접 눌러 붙여넣으세요.", "info");
        }
    }
}

async function decodeImageElement(img) {
    stopQrCamera();

    const canvas = document.getElementById("qr-canvas");
    const placeholder = document.getElementById("qr-drop-placeholder");
    const ctx = canvas.getContext("2d");

    // 뷰포트에 맞게 캔버스 크기 설정
    canvas.width = img.width;
    canvas.height = img.height;
    ctx.drawImage(img, 0, 0);

    canvas.style.display = "block";
    if (placeholder) placeholder.style.display = "none";

    let detectedRaw = null;

    // 1) BarcodeDetector 시도
    if (qrBarcodeDetector) {
        try {
            const barcodes = await qrBarcodeDetector.detect(canvas);
            if (barcodes && barcodes.length > 0) {
                detectedRaw = barcodes[0].rawValue;
            }
        } catch (e) {
            console.warn("[QR] BarcodeDetector 이미지 실패, jsQR 시도:", e);
        }
    }

    // 2) jsQR 디코딩 시도
    if (!detectedRaw && typeof jsQR === "function") {
        const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(imgData.data, imgData.width, imgData.height, {
            inversionAttempts: "attemptBoth"
        });
        if (code && code.data) {
            detectedRaw = code.data;
            // QR 위치 바운딩 박스 그리기
            drawQrBoundingBox(ctx, code.location);
        }
    }

    if (detectedRaw) {
        handleQrDetectionSuccess(detectedRaw, "image");
    } else {
        if (typeof showToast === "function") {
            showToast("QR 코드 미발견", "이미지에서 QR 코드를 인식하지 못했습니다.", "warn");
        }
    }
}

function drawQrBoundingBox(ctx, location) {
    if (!location) return;
    ctx.lineWidth = 4;
    ctx.strokeStyle = "#38bdf8";

    ctx.beginPath();
    ctx.moveTo(location.topLeftCorner.x, location.topLeftCorner.y);
    ctx.lineTo(location.topRightCorner.x, location.topRightCorner.y);
    ctx.lineTo(location.bottomRightCorner.x, location.bottomRightCorner.y);
    ctx.lineTo(location.bottomLeftCorner.x, location.bottomLeftCorner.y);
    ctx.closePath();
    ctx.stroke();
}

function resetQrScanner() {
    stopQrCamera();
    const canvas = document.getElementById("qr-canvas");
    const placeholder = document.getElementById("qr-drop-placeholder");
    if (canvas) {
        const ctx = canvas.getContext("2d");
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        canvas.style.display = "none";
    }
    if (placeholder) placeholder.style.display = "flex";

    qrCurrentDetectedData = "";
    qrCurrentDetectedUrl = "";
    qrLastScannedContent = "";

    const emptyHint = document.getElementById("qr-result-empty");
    const contentWrap = document.getElementById("qr-result-content-wrap");
    const badge = document.getElementById("qr-result-type-badge");
    const quickActions = document.getElementById("qr-result-quick-actions");

    if (emptyHint) emptyHint.style.display = "block";
    if (contentWrap) contentWrap.style.display = "none";
    if (badge) badge.style.display = "none";
    if (quickActions) quickActions.style.display = "none";
}

// =============================================================================
// 5. 스캔 결과 표시 및 포맷 파싱
// =============================================================================

async function handleQrDetectionSuccess(content, source = "camera") {
    qrCurrentDetectedData = content;

    const emptyHint = document.getElementById("qr-result-empty");
    const contentWrap = document.getElementById("qr-result-content-wrap");
    const badge = document.getElementById("qr-result-type-badge");
    const quickActions = document.getElementById("qr-result-quick-actions");
    const rawText = document.getElementById("qr-result-raw-text");
    const parsedBox = document.getElementById("qr-parsed-details");
    const openUrlBtn = document.getElementById("qr-open-url-btn");

    if (emptyHint) emptyHint.style.display = "none";
    if (contentWrap) contentWrap.style.display = "block";
    if (quickActions) quickActions.style.display = "inline-flex";
    if (rawText) rawText.value = content;

    // 백엔드 파싱 API 호출
    let formatType = "text";
    let parsedData = {};

    try {
        if (window.eel && eel.parse_qr_data) {
            const res = await eel.parse_qr_data(content)();
            if (res && res.status === "success") {
                formatType = res.format_type;
                parsedData = res.parsed_data;
            }
        }
    } catch (e) {
        console.warn("[QR] 파싱 백엔드 오류:", e);
    }

    // 뱃지 및 상세 영역 렌더링
    renderParsedResult(formatType, parsedData, content);

    // URL 버튼 노출 여부
    if (formatType === "url" || content.startsWith("http://") || content.startsWith("https://")) {
        qrCurrentDetectedUrl = parsedData.url || content.trim();
        if (openUrlBtn) openUrlBtn.style.display = "inline-flex";
    } else {
        qrCurrentDetectedUrl = "";
        if (openUrlBtn) openUrlBtn.style.display = "none";
    }

    if (typeof showToast === "function") {
        showToast("QR 코드 인식 완료", `${formatType.toUpperCase()}: ${content.slice(0, 35)}...`, "info");
    }

    // 이력 자동 저장
    try {
        if (window.eel && eel.save_qr_history) {
            await eel.save_qr_history("scan", content, "", formatType)();
            updateHistoryCountBadge();
        }
    } catch (e) {
        console.warn("[QR] 이력 저장 실패:", e);
    }
}

function renderParsedResult(formatType, data, rawContent) {
    const badge = document.getElementById("qr-result-type-badge");
    const parsedBox = document.getElementById("qr-parsed-details");

    const badgeMap = {
        url: { text: "🌐 웹 링크 (URL)", cls: "badge-primary" },
        wifi: { text: "📶 Wi-Fi 네트워크", cls: "badge-success" },
        email: { text: "📧 이메일", cls: "badge-info" },
        tel: { text: "📞 전화번호", cls: "badge-warning" },
        vcard: { text: "📇 연락처(vCard)", cls: "badge-secondary" },
        text: { text: "📄 일반 텍스트", cls: "badge-neutral" }
    };

    const bInfo = badgeMap[formatType] || badgeMap.text;
    if (badge) {
        badge.style.display = "inline-block";
        badge.textContent = bInfo.text;
        badge.className = `qr-badge ${bInfo.cls}`;
    }

    if (!parsedBox) return;

    if (formatType === "wifi") {
        parsedBox.style.display = "block";
        parsedBox.innerHTML = `
            <div class="qr-parsed-card">
                <div class="qr-parsed-row"><strong>네트워크(SSID):</strong> <span>${escapeHtml(data.ssid || "-")}</span></div>
                <div class="qr-parsed-row"><strong>비밀번호:</strong> <span class="qr-code-highlight">${escapeHtml(data.password || "(없음)")}</span></div>
                <div class="qr-parsed-row"><strong>보안 방식:</strong> <span>${escapeHtml(data.auth_type || "WPA")}</span></div>
            </div>
        `;
    } else if (formatType === "url") {
        parsedBox.style.display = "block";
        parsedBox.innerHTML = `
            <div class="qr-parsed-card">
                <div class="qr-parsed-row"><strong>URL:</strong> <a href="#" onclick="openQrDetectedUrl(); return false;" class="qr-link">${escapeHtml(data.url || rawContent)}</a></div>
            </div>
        `;
    } else if (formatType === "email") {
        parsedBox.style.display = "block";
        parsedBox.innerHTML = `
            <div class="qr-parsed-card">
                <div class="qr-parsed-row"><strong>이메일:</strong> <span>${escapeHtml(data.email || "-")}</span></div>
            </div>
        `;
    } else if (formatType === "tel") {
        parsedBox.style.display = "block";
        parsedBox.innerHTML = `
            <div class="qr-parsed-card">
                <div class="qr-parsed-row"><strong>전화번호:</strong> <span>${escapeHtml(data.phone || "-")}</span></div>
            </div>
        `;
    } else if (formatType === "vcard") {
        parsedBox.style.display = "block";
        parsedBox.innerHTML = `
            <div class="qr-parsed-card">
                <div class="qr-parsed-row"><strong>이름:</strong> <span>${escapeHtml(data.name || "-")}</span></div>
                <div class="qr-parsed-row"><strong>전화번호:</strong> <span>${escapeHtml(data.phone || "-")}</span></div>
                <div class="qr-parsed-row"><strong>이메일:</strong> <span>${escapeHtml(data.email || "-")}</span></div>
                <div class="qr-parsed-row"><strong>조직/회사:</strong> <span>${escapeHtml(data.org || "-")}</span></div>
            </div>
        `;
    } else {
        parsedBox.style.display = "none";
        parsedBox.innerHTML = "";
    }
}

async function openQrDetectedUrl() {
    if (!qrCurrentDetectedUrl) return;
    try {
        if (window.eel && eel.open_external_url) {
            await eel.open_external_url(qrCurrentDetectedUrl)();
        } else {
            window.open(qrCurrentDetectedUrl, "_blank");
        }
    } catch (e) {
        console.error("[QR] 링크 열기 실패:", e);
    }
}

async function copyQrResultText() {
    if (!qrCurrentDetectedData) return;
    try {
        await navigator.clipboard.writeText(qrCurrentDetectedData);
        if (typeof showToast === "function") {
            showToast("복사 완료", "QR 코드 텍스트가 클립보드에 복사되었습니다.", "info");
        }
    } catch (e) {
        console.error("[QR] 복사 실패:", e);
    }
}

// =============================================================================
// 6. QR 코드 생성기 (Generator)
// =============================================================================

let currentGenType = "text";

function switchQrGenType(type) {
    currentGenType = type;
    const typeTabs = document.querySelectorAll(".qr-type-tab-btn");
    typeTabs.forEach(btn => {
        btn.classList.toggle("active", btn.getAttribute("data-type") === type);
    });

    const panes = ["text", "wifi", "email", "tel", "vcard"];
    panes.forEach(p => {
        const pane = document.getElementById(`qr-gen-input-${p}`);
        if (pane) {
            pane.style.display = (p === type) ? "block" : "none";
            pane.classList.toggle("active", p === type);
        }
    });

    renderGeneratedQr();
}

function buildQrContentString() {
    switch (currentGenType) {
        case "wifi": {
            const ssid = (document.getElementById("qr-wifi-ssid")?.value || "").trim();
            const pwd = document.getElementById("qr-wifi-password")?.value || "";
            const auth = document.getElementById("qr-wifi-auth")?.value || "WPA";
            const hidden = document.getElementById("qr-wifi-hidden")?.checked || false;
            if (!ssid) return "";
            // Escape special characters in SSID & PWD (\, ;, ,, :)
            const esc = (s) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/:/g, "\\:");
            return `WIFI:T:${auth};S:${esc(ssid)};P:${esc(pwd)};H:${hidden};;`;
        }
        case "email": {
            const addr = (document.getElementById("qr-email-addr")?.value || "").trim();
            const subject = encodeURIComponent(document.getElementById("qr-email-subject")?.value || "");
            const body = encodeURIComponent(document.getElementById("qr-email-body")?.value || "");
            if (!addr) return "";
            let res = `mailto:${addr}`;
            const params = [];
            if (subject) params.push(`subject=${subject}`);
            if (body) params.push(`body=${body}`);
            if (params.length > 0) res += `?${params.join("&")}`;
            return res;
        }
        case "tel": {
            const tel = (document.getElementById("qr-tel-number")?.value || "").trim();
            if (!tel) return "";
            return `tel:${tel}`;
        }
        case "vcard": {
            const name = (document.getElementById("qr-vcard-name")?.value || "").trim();
            const tel = (document.getElementById("qr-vcard-tel")?.value || "").trim();
            const email = (document.getElementById("qr-vcard-email")?.value || "").trim();
            const org = (document.getElementById("qr-vcard-org")?.value || "").trim();
            if (!name && !tel && !email) return "";
            let vcard = "BEGIN:VCARD\nVERSION:3.0\n";
            if (name) vcard += `FN:${name}\n`;
            if (tel) vcard += `TEL:${tel}\n`;
            if (email) vcard += `EMAIL:${email}\n`;
            if (org) vcard += `ORG:${org}\n`;
            vcard += "END:VCARD";
            return vcard;
        }
        case "text":
        default: {
            return (document.getElementById("qr-input-text-val")?.value || "").trim();
        }
    }
}

function renderGeneratedQr() {
    const target = document.getElementById("qr-gen-target");
    const emptyHint = document.getElementById("qr-gen-empty-hint");
    if (!target) return;

    const content = buildQrContentString();
    const fgColor = document.getElementById("qr-opt-fg-color")?.value || "#000000";
    const bgColor = document.getElementById("qr-opt-bg-color")?.value || "#ffffff";
    const size = parseInt(document.getElementById("qr-opt-size")?.value || "256", 10);
    const eccStr = document.getElementById("qr-opt-ecc")?.value || "M";

    // 헥스 레이블 업데이트
    const fgHex = document.getElementById("qr-fg-color-hex");
    const bgHex = document.getElementById("qr-bg-color-hex");
    if (fgHex) fgHex.textContent = fgColor.toUpperCase();
    if (bgHex) bgHex.textContent = bgColor.toUpperCase();

    if (!content) {
        target.innerHTML = "";
        if (emptyHint) emptyHint.style.display = "block";
        return;
    }

    if (emptyHint) emptyHint.style.display = "none";
    target.innerHTML = "";

    if (typeof QRCode !== "function") {
        target.innerHTML = "<div class='qr-error'>QRCode 라이브러리를 로드하지 못했습니다.</div>";
        return;
    }

    const eccLevelMap = {
        L: QRCode.CorrectLevel.L,
        M: QRCode.CorrectLevel.M,
        Q: QRCode.CorrectLevel.Q,
        H: QRCode.CorrectLevel.H
    };

    try {
        qrGeneratorInstance = new QRCode(target, {
            text: content,
            width: size,
            height: size,
            colorDark: fgColor,
            colorLight: bgColor,
            correctLevel: eccLevelMap[eccStr] || QRCode.CorrectLevel.M
        });
    } catch (e) {
        console.error("[QR] 생성 실패:", e);
        target.innerHTML = `<div class='qr-error'>QR 생성 실패: ${escapeHtml(e.message)}</div>`;
    }
}

function getGeneratedCanvas() {
    const target = document.getElementById("qr-gen-target");
    if (!target) return null;
    return target.querySelector("canvas");
}

function downloadQrPng() {
    const canvas = getGeneratedCanvas();
    if (!canvas) {
        if (typeof showToast === "function") {
            showToast("다운로드 실패", "먼저 QR 코드를 생성해 주세요.", "warn");
        }
        return;
    }

    const dataUrl = canvas.toDataURL("image/png");
    const link = document.createElement("a");
    link.download = `qrcode_${Date.now()}.png`;
    link.href = dataUrl;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    if (typeof showToast === "function") {
        showToast("다운로드 완료", "QR 코드 이미지를 다운로드했습니다.", "info");
    }
}

async function copyQrImageToClipboard() {
    const canvas = getGeneratedCanvas();
    if (!canvas) {
        if (typeof showToast === "function") {
            showToast("복사 실패", "먼저 QR 코드를 생성해 주세요.", "warn");
        }
        return;
    }

    try {
        canvas.toBlob(async (blob) => {
            if (!blob) return;
            await navigator.clipboard.write([
                new ClipboardItem({ "image/png": blob })
            ]);
            if (typeof showToast === "function") {
                showToast("복사 완료", "QR 코드 이미지가 클립보드에 복사되었습니다.", "info");
            }
        });
    } catch (e) {
        console.error("[QR] 이미지 복사 실패:", e);
        if (typeof showToast === "function") {
            showToast("복사 실패", "브라우저 클립보드 권한을 확인하세요.", "error");
        }
    }
}

async function saveGeneratedQrToHistory() {
    const content = buildQrContentString();
    if (!content) {
        if (typeof showToast === "function") {
            showToast("저장 실패", "생성할 내용이 없습니다.", "warn");
        }
        return;
    }

    try {
        if (window.eel && eel.save_qr_history) {
            await eel.save_qr_history("generate", content, "", currentGenType)();
            updateHistoryCountBadge();
            if (typeof showToast === "function") {
                showToast("저장 완료", "생성된 QR 코드가 이력에 저장되었습니다.", "info");
            }
        }
    } catch (e) {
        console.error("[QR] 이력 저장 실패:", e);
    }
}

// =============================================================================
// 7. 이력 관리 (History)
// =============================================================================

async function loadQrHistory() {
    const tbody = document.getElementById("qr-history-tbody");
    const searchInput = document.getElementById("qr-history-search-input");
    const search = searchInput ? searchInput.value.trim() : "";

    if (!tbody) return;

    try {
        if (window.eel && eel.get_qr_history) {
            const res = await eel.get_qr_history(50, search)();
            if (res && res.status === "success") {
                renderHistoryTable(res.items);
                updateHistoryCountBadge(res.items.length);
            }
        }
    } catch (e) {
        console.error("[QR] 이력 로드 실패:", e);
    }
}

function renderHistoryTable(items) {
    const tbody = document.getElementById("qr-history-tbody");
    if (!tbody) return;

    if (!items || items.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" class="qr-history-empty">저장된 QR 이력이 없습니다.</td></tr>`;
        return;
    }

    let html = "";
    items.forEach(item => {
        const isScan = item.action_type === "scan";
        const actionBadge = isScan
            ? `<span class="qr-badge badge-primary">📷 스캔</span>`
            : `<span class="qr-badge badge-success">✨ 생성</span>`;

        const typeBadge = `<span class="qr-badge badge-neutral">${escapeHtml(item.format_type || "text")}</span>`;

        html += `
            <tr data-id="${item.id}">
                <td>${actionBadge}</td>
                <td>${typeBadge}</td>
                <td class="qr-history-cell-content" title="${escapeHtml(item.content)}">
                    <div class="qr-history-title">${escapeHtml(item.title || item.content.slice(0, 40))}</div>
                    <div class="qr-history-sub">${escapeHtml(item.content.slice(0, 80))}</div>
                </td>
                <td class="qr-history-time">${escapeHtml(item.created_at || "")}</td>
                <td class="qr-history-actions-col">
                    <button type="button" class="mini-tool-btn" onclick="copyHistoryContent(${item.id})" title="내용 복사">📋</button>
                    ${item.format_type === "url" ? `<button type="button" class="mini-tool-btn" onclick="openHistoryUrl(${item.id})" title="브라우저 열기">🌐</button>` : ""}
                    <button type="button" class="mini-tool-btn" onclick="loadToGenerator(${item.id})" title="생성기로 불러오기">✏️</button>
                    <button type="button" class="mini-tool-btn delete-mini-btn" onclick="deleteHistoryItem(${item.id})" title="삭제">🗑️</button>
                </td>
            </tr>
        `;
    });

    tbody.innerHTML = html;
}

let historyCache = {};

async function updateHistoryCountBadge(count = null) {
    const badge = document.getElementById("qr-history-count");
    if (!badge) return;

    if (count !== null) {
        badge.textContent = count;
        return;
    }

    try {
        if (window.eel && eel.get_qr_history) {
            const res = await eel.get_qr_history(100)();
            if (res && res.status === "success") {
                badge.textContent = res.items.length;
            }
        }
    } catch (e) {
        // 무시
    }
}

async function deleteHistoryItem(id) {
    try {
        if (window.eel && eel.delete_qr_history) {
            await eel.delete_qr_history(id)();
            loadQrHistory();
        }
    } catch (e) {
        console.error("[QR] 이력 삭제 실패:", e);
    }
}

async function confirmClearQrHistory() {
    if (typeof showAppConfirm === "function") {
        const ok = await showAppConfirm("QR 스캔 및 생성 이력을 모두 삭제하시겠습니까?", {
            title: "이력 전체 삭제",
            icon: "⚠️"
        });
        if (!ok) return;
    }

    try {
        if (window.eel && eel.clear_qr_history) {
            await eel.clear_qr_history()();
            loadQrHistory();
            if (typeof showToast === "function") {
                showToast("초기화 완료", "모든 QR 이력이 삭제되었습니다.", "info");
            }
        }
    } catch (e) {
        console.error("[QR] 이력 초기화 실패:", e);
    }
}

async function copyHistoryContent(id) {
    const row = document.querySelector(`tr[data-id="${id}"]`);
    const content = row ? row.querySelector(".qr-history-cell-content").getAttribute("title") : "";
    if (content) {
        await navigator.clipboard.writeText(content);
        if (typeof showToast === "function") {
            showToast("복사 완료", "클립보드에 복사되었습니다.", "info");
        }
    }
}

async function openHistoryUrl(id) {
    const row = document.querySelector(`tr[data-id="${id}"]`);
    const content = row ? row.querySelector(".qr-history-cell-content").getAttribute("title") : "";
    if (content && window.eel && eel.open_external_url) {
        await eel.open_external_url(content)();
    }
}

function loadToGenerator(id) {
    const row = document.querySelector(`tr[data-id="${id}"]`);
    const content = row ? row.querySelector(".qr-history-cell-content").getAttribute("title") : "";
    if (!content) return;

    switchQrSubTab("generator");
    switchQrGenType("text");
    const input = document.getElementById("qr-input-text-val");
    if (input) {
        input.value = content;
        renderGeneratedQr();
    }
}

// =============================================================================
// 8. 전역 드래그 앤 드롭 및 단축키(Ctrl+V) 리스너
// =============================================================================

function setupQrDropZone() {
    const dropZone = document.getElementById("qr-drop-zone");
    if (!dropZone) return;

    ["dragenter", "dragover"].forEach(name => {
        dropZone.addEventListener(name, (e) => {
            e.preventDefault();
            e.stopPropagation();
            dropZone.classList.add("drag-over");
        });
    });

    ["dragleave", "drop"].forEach(name => {
        dropZone.addEventListener(name, (e) => {
            e.preventDefault();
            e.stopPropagation();
            dropZone.classList.remove("drag-over");
        });
    });

    dropZone.addEventListener("drop", (e) => {
        const files = e.dataTransfer && e.dataTransfer.files;
        if (files && files.length > 0) {
            loadAndDecodeImageFile(files[0]);
        }
    });
}

function setupGlobalPasteListener() {
    window.addEventListener("paste", (e) => {
        // QR 탭이 활성화되어 있을 때만 전역 붙여넣기 수신
        const tabPane = document.getElementById("tab-qr");
        if (!tabPane || !tabPane.classList.contains("active")) return;

        // 텍스트 영역 등에 포커스되어 있는 경우 기본 동작 허용
        const activeTag = document.activeElement ? document.activeElement.tagName.toLowerCase() : "";
        if (activeTag === "textarea" || activeTag === "input") return;

        const clipboardData = e.clipboardData;
        if (!clipboardData || !clipboardData.items) return;

        for (let i = 0; i < clipboardData.items.length; i++) {
            const item = clipboardData.items[i];
            if (item.type.indexOf("image") !== -1) {
                const blob = item.getAsFile();
                if (blob) {
                    e.preventDefault();
                    switchQrSubTab("scanner");
                    loadAndDecodeImageFile(blob);
                    break;
                }
            }
        }
    });
}

// 유틸리티
function escapeHtml(str) {
    if (!str) return "";
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

// 탭 진입 시 온디맨드 초기화
function initQrToolkit() {
    initBarcodeDetector();
    setupQrDropZone();
    updateHistoryCountBadge();
    switchQrSubTab("scanner");
}

// 초기화
document.addEventListener("DOMContentLoaded", () => {
    initBarcodeDetector();
    setupQrDropZone();
    setupGlobalPasteListener();
    updateHistoryCountBadge();
});

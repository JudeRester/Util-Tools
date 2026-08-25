/**
 * Mermaid 다이어그램 시각화 스튜디오 (Mermaid Diagram Studio) 모듈
 * 실시간 텍스트 기반 다이어그램 렌더링, 템플릿 프리셋 연동, 줌/팬 인터랙션, PNG/SVG 내보내기 지원
 * (템플릿 데이터 및 기본 샘플은 js/mermaid_templates.js 에서 분리 로드)
 */

let currentMermaidTheme = 'dark';
let mermaidZoomScale = 1.0;
let mermaidPanX = 0;
let mermaidPanY = 0;
let isMermaidPanning = false;
let mermaidPanStartX = 0;
let mermaidPanStartY = 0;
let mermaidRenderTimer = null;

let isMermaidEditorCollapsed = false;

// 1. Mermaid 초기화
function initMermaidDiagram() {
    try {
        if (typeof mermaid !== 'undefined') {
            mermaid.initialize({
                startOnLoad: false,
                theme: currentMermaidTheme,
                securityLevel: 'loose',
                flowchart: { curve: 'basis' }
            });
        }
    } catch (e) {
        console.error("Mermaid 초기화 실패:", e);
    }

    initMermaidEditorTabKey();
    initMermaidResizer();
    initMermaidPanZoom();

    // 에디터 접힘 상태 복원
    isMermaidEditorCollapsed = localStorage.getItem('mermaid_editor_collapsed') === '1';
    applyMermaidEditorCollapsedState();

    // 로컬스토리지에서 이전 작업 내용 복원
    const saved = localStorage.getItem('mermaid_saved_code');
    const editor = document.getElementById('mermaid-code-editor');
    if (editor) {
        editor.value = saved || MERMAID_TEMPLATES.flowchart_td;
    }

    // 저장된 다이어그램 목록 불러오기
    loadSavedDiagrams();

    // 초기 렌더링
    setTimeout(() => {
        renderMermaid(true);
    }, 100);
}

// 에디터 접기/펼치기 토글
function toggleMermaidEditor() {
    isMermaidEditorCollapsed = !isMermaidEditorCollapsed;
    applyMermaidEditorCollapsedState();
    localStorage.setItem('mermaid_editor_collapsed', isMermaidEditorCollapsed ? '1' : '0');
    setTimeout(() => {
        fitMermaidToViewport();
    }, 220);
}

function applyMermaidEditorCollapsedState() {
    const editorPane = document.getElementById('mermaid-editor-pane');
    const resizer = document.getElementById('mermaid-resizer');
    const toggleIcon = document.getElementById('mermaid-editor-toggle-icon');
    const toggleText = document.getElementById('mermaid-editor-toggle-text');
    const openEditorBtn = document.getElementById('mermaid-open-editor-btn');

    if (!editorPane) return;

    if (isMermaidEditorCollapsed) {
        editorPane.classList.add('collapsed');
        if (resizer) resizer.classList.add('hidden');
        if (toggleIcon) toggleIcon.textContent = '▶';
        if (toggleText) toggleText.textContent = '에디터 펼치기';
        if (openEditorBtn) openEditorBtn.style.display = 'inline-flex';
    } else {
        editorPane.classList.remove('collapsed');
        if (resizer) resizer.classList.remove('hidden');
        if (toggleIcon) toggleIcon.textContent = '◀';
        if (toggleText) toggleText.textContent = '에디터 접기';
        if (openEditorBtn) openEditorBtn.style.display = 'none';
    }
}

// 에디터 Tab 키 4칸 들여쓰기 지원
function initMermaidEditorTabKey() {
    const editor = document.getElementById('mermaid-code-editor');
    if (!editor) return;

    editor.addEventListener('keydown', function(e) {
        if (e.key === 'Tab') {
            e.preventDefault();
            const start = this.selectionStart;
            const end = this.selectionEnd;
            this.value = this.value.substring(0, start) + "    " + this.value.substring(end);
            this.selectionStart = this.selectionEnd = start + 4;
            onMermaidCodeChange();
        }
    });
}

// 에디터 내용 변경 시 실시간 디바운스 렌더링
function onMermaidCodeChange() {
    if (mermaidRenderTimer) clearTimeout(mermaidRenderTimer);
    mermaidRenderTimer = setTimeout(() => {
        renderMermaid(false);
    }, 250);
}

// 다이어그램 렌더링
async function renderMermaid(force = false) {
    const editor = document.getElementById('mermaid-code-editor');
    const outputEl = document.getElementById('mermaid-render-output');
    const errorBar = document.getElementById('mermaid-error-bar');
    const errorText = document.getElementById('mermaid-error-text');

    if (!editor || !outputEl) return;

    const code = editor.value.trim();
    if (!code) {
        outputEl.innerHTML = '<div style="color:var(--text-secondary); text-align:center; padding:30px;">코드를 입력하면 다이어그램이 실시간으로 렌더링됩니다.</div>';
        if (errorBar) errorBar.style.display = 'none';
        return;
    }

    if (typeof mermaid === 'undefined') {
        outputEl.innerHTML = '<div style="color:#ef4444; padding:20px;">Mermaid 라이브러리를 불러오지 못했습니다.</div>';
        return;
    }

    try {
        const uniqueId = 'mermaid-svg-' + Date.now();
        const { svg } = await mermaid.render(uniqueId, code);
        outputEl.innerHTML = svg;
        outputEl.style.opacity = '1';

        if (errorBar) errorBar.style.display = 'none';

        // 성공 시 로컬스토리지 자동 저장
        localStorage.setItem('mermaid_saved_code', editor.value);

        if (force) {
            fitMermaidToViewport();
        }
    } catch (err) {
        console.warn("Mermaid 렌더링 문법 오류:", err);
        if (errorBar && errorText) {
            errorText.textContent = (err.message || err.str || '문법 오류가 발생했습니다. 문법을 확인해 주세요.').split('\n')[0];
            errorBar.style.display = 'flex';
        }
        if (outputEl.firstChild) {
            outputEl.style.opacity = '0.4';
        }
    }
}

// 템플릿 불러오기
function loadMermaidTemplate(key) {
    const tpl = MERMAID_TEMPLATES[key];
    if (!tpl) return;

    const editor = document.getElementById('mermaid-code-editor');
    if (editor) {
        editor.value = tpl;
        renderMermaid(true);
        logToConsole('Mermaid 템플릿 로드', `템플릿: [${key}] 적용 완료`);
    }
}

// 테마 변경
async function changeMermaidTheme(theme) {
    currentMermaidTheme = theme;
    try {
        mermaid.initialize({
            startOnLoad: false,
            theme: theme,
            securityLevel: 'loose',
            flowchart: { curve: 'basis' }
        });
        await renderMermaid(false);
        logToConsole('Mermaid 테마 변경', `테마: [${theme}]`);
    } catch (e) {
        console.error("테마 변경 오류:", e);
    }
}

// 에디터 비우기
function clearMermaidEditor() {
    const editor = document.getElementById('mermaid-code-editor');
    if (editor) {
        editor.value = '';
        renderMermaid(true);
        if (editor) editor.focus();
    }
}

// 코드 클립보드 복사
async function copyMermaidCode() {
    const editor = document.getElementById('mermaid-code-editor');
    if (!editor || !editor.value.trim()) {
        await showAppAlert('복사할 코드가 없습니다.', '알림', 'ℹ️');
        return;
    }
    navigator.clipboard.writeText(editor.value);
    logToConsole('코드 복사 완료', 'Mermaid 스크립트가 클립보드에 복사되었습니다.');
    showAppAlert('Mermaid 코드가 클립보드에 복사되었습니다! 📋', '복사 완료', '✅');
}

// XML 파서 호환 SVG 포맷팅 헬퍼 (<br> -> <br/> 자동 변환)
function formatSvgForXmlExport(svgElement) {
    const clone = svgElement.cloneNode(true);

    if (!clone.getAttribute('xmlns')) {
        clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    }
    if (!clone.getAttribute('xmlns:xlink')) {
        clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
    }

    let xmlString = new XMLSerializer().serializeToString(clone);

    // XML 파서 Mismatch 에러 방지를 위해 void 태그들을 self-closing(<br/>)으로 변환
    xmlString = xmlString
        .replace(/<br(?:\s*[\/]?>|\s+[^>]*?[\/]?>)/gi, (m) => m.endsWith('/>') ? m : m.slice(0, -1) + '/>')
        .replace(/<img([^>]*?)(?<!\/)>/gi, '<img$1/>')
        .replace(/<hr([^>]*?)(?<!\/)>/gi, '<hr$1/>');

    if (!xmlString.startsWith('<?xml')) {
        xmlString = '<?xml version="1.0" encoding="UTF-8"?>\n' + xmlString;
    }

    return xmlString;
}

// SVG 벡터 코드 복사
async function copyMermaidSvg() {
    const outputEl = document.getElementById('mermaid-render-output');
    const svg = outputEl?.querySelector('svg');
    if (!svg) {
        await showAppAlert('복사할 다이어그램 SVG가 없습니다.', '알림', '⚠️');
        return;
    }

    const svgCode = formatSvgForXmlExport(svg);
    navigator.clipboard.writeText(svgCode);
    logToConsole('SVG 복사 완료', 'SVG 벡터 코드가 클립보드에 복사되었습니다.');
    showAppAlert('SVG 벡터 코드가 클립보드에 복사되었습니다! 📐', '복사 완료', '✅');
}

// 다이어그램 이미지를 클립보드에 복사 (Ctrl+V 붙여넣기용)
async function copyMermaidImageToClipboard() {
    const outputEl = document.getElementById('mermaid-render-output');
    const svg = outputEl?.querySelector('svg');
    if (!svg) {
        await showAppAlert('복사할 다이어그램이 없습니다.', '알림', '⚠️');
        return;
    }

    try {
        const blob = await svgToPngBlob(svg);
        if (blob && navigator.clipboard && navigator.clipboard.write) {
            await navigator.clipboard.write([
                new ClipboardItem({ 'image/png': blob })
            ]);
            logToConsole('이미지 클립보드 복사 완료', '메신저나 문서에 Ctrl+V로 붙여넣을 수 있습니다.');
            await showAppAlert('다이어그램 이미지가 클립보드에 복사되었습니다! 🖼️\n(문서나 메신저에 바로 Ctrl+V로 붙여넣기 가능)', '복사 완료', '✅');
        } else {
            downloadMermaidPng();
        }
    } catch (e) {
        console.error("클립보드 복사 실패:", e);
        downloadMermaidPng();
    }
}

// 고해상도 PNG 파일 다운로드
async function downloadMermaidPng() {
    const outputEl = document.getElementById('mermaid-render-output');
    const svg = outputEl?.querySelector('svg');
    if (!svg) {
        await showAppAlert('다운로드할 다이어그램이 없습니다.', '알림', '⚠️');
        return;
    }

    try {
        const blob = await svgToPngBlob(svg);
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `mermaid-diagram-${Date.now()}.png`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        logToConsole('PNG 다운로드 완료', a.download);
    } catch (e) {
        logToConsole('PNG 생성 실패', e.message || e);
    }
}

// SVG -> PNG Blob 변환 헬퍼 (배경색 및 2배 고해상도 렌더링)
// SVG -> PNG Blob 변환 헬퍼 (Base64 Data URL 방식으로 Tainted Canvas 방지)
function svgToPngBlob(svgElement) {
    return new Promise((resolve, reject) => {
        try {
            const clone = svgElement.cloneNode(true);
            
            if (!clone.getAttribute('xmlns')) {
                clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
            }
            if (!clone.getAttribute('xmlns:xlink')) {
                clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
            }

            const bbox = svgElement.getBoundingClientRect();
            const width = Math.max(bbox.width || 400, 300) * 2;
            const height = Math.max(bbox.height || 300, 200) * 2;

            clone.setAttribute('width', width);
            clone.setAttribute('height', height);

            // Blob URL 대신 Base64 Data URL 사용
            const svgString = new XMLSerializer().serializeToString(clone);
            const base64Data = btoa(unescape(encodeURIComponent(svgString)));
            const dataUrl = 'data:image/svg+xml;base64,' + base64Data;

            const image = new Image();
            image.crossOrigin = 'anonymous';

            image.onload = () => {
                try {
                    const canvas = document.createElement('canvas');
                    canvas.width = width;
                    canvas.height = height;
                    const ctx = canvas.getContext('2d');

                    ctx.fillStyle = currentMermaidTheme === 'dark' ? '#0d1117' : '#ffffff';
                    ctx.fillRect(0, 0, width, height);

                    ctx.drawImage(image, 0, 0, width, height);

                    canvas.toBlob(blob => {
                        if (blob) resolve(blob);
                        else reject(new Error('Canvas to Blob 변환 실패'));
                    }, 'image/png');
                } catch (canvasErr) {
                    reject(canvasErr);
                }
            };

            image.onerror = (e) => reject(new Error('SVG 로드 실패: ' + (e.message || 'Data URL 에러')));
            image.src = dataUrl;
        } catch (e) {
            reject(e);
        }
    });
}

// 2. 줌 및 패닝 (Zoom & Pan) 기능
function initMermaidPanZoom() {
    const viewport = document.getElementById('mermaid-viewport');
    if (!viewport) return;

    // 마우스 휠 줌 (커서 위치 중심 부드러운 확대/축소 및 최대 1500% 지원)
    viewport.addEventListener('wheel', function(e) {
        e.preventDefault();
        
        const zoomFactor = e.deltaY < 0 ? 1.15 : 0.87;
        const targetScale = Math.max(0.1, Math.min(15.0, mermaidZoomScale * zoomFactor));

        if (targetScale === mermaidZoomScale) return;

        // 마우스 커서 위치 기준 확대 중심점 보정
        const rect = viewport.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        // 새로운 패닝 좌표 계산: 커서 위치가 확대 후에도 고정되도록 조정
        mermaidPanX = mouseX - (mouseX - mermaidPanX) * (targetScale / mermaidZoomScale);
        mermaidPanY = mouseY - (mouseY - mermaidPanY) * (targetScale / mermaidZoomScale);
        mermaidZoomScale = targetScale;

        updateCanvasTransform();
    }, { passive: false });

    // 마우스 드래그 패닝
    viewport.addEventListener('mousedown', function(e) {
        if (e.target.closest('button')) return;
        isMermaidPanning = true;
        mermaidPanStartX = e.clientX - mermaidPanX;
        mermaidPanStartY = e.clientY - mermaidPanY;
        viewport.classList.add('panning');
    });

    window.addEventListener('mousemove', function(e) {
        if (!isMermaidPanning) return;
        mermaidPanX = e.clientX - mermaidPanStartX;
        mermaidPanY = e.clientY - mermaidPanStartY;
        updateCanvasTransform();
    });

    window.addEventListener('mouseup', function() {
        if (isMermaidPanning) {
            isMermaidPanning = false;
            viewport.classList.remove('panning');
        }
    });
}

function zoomMermaid(delta) {
    if (delta > 0) {
        mermaidZoomScale = Math.min(15.0, mermaidZoomScale * 1.25);
    } else {
        mermaidZoomScale = Math.max(0.1, mermaidZoomScale * 0.8);
    }
    updateCanvasTransform();
}

function resetMermaidZoom() {
    mermaidZoomScale = 1.0;
    mermaidPanX = 0;
    mermaidPanY = 0;
    updateCanvasTransform();
}

function fitMermaidToViewport() {
    const viewport = document.getElementById('mermaid-viewport');
    const svg = document.querySelector('#mermaid-render-output svg');
    if (viewport && svg) {
        const vRect = viewport.getBoundingClientRect();
        const sRect = svg.getBoundingClientRect();
        const svgW = svg.viewBox?.baseVal?.width || sRect.width || 800;
        const svgH = svg.viewBox?.baseVal?.height || sRect.height || 600;

        if (svgW > 0 && svgH > 0 && vRect.width > 0 && vRect.height > 0) {
            const scaleX = (vRect.width - 60) / svgW;
            const scaleY = (vRect.height - 60) / svgH;
            mermaidZoomScale = Math.max(0.1, Math.min(3.0, Math.min(scaleX, scaleY)));
            mermaidPanX = 0;
            mermaidPanY = 0;
            updateCanvasTransform();
            return;
        }
    }
    resetMermaidZoom();
}

function updateCanvasTransform() {
    const canvas = document.getElementById('mermaid-canvas');
    if (canvas) {
        canvas.style.transform = `translate(${mermaidPanX}px, ${mermaidPanY}px) scale(${mermaidZoomScale})`;
    }
    const badge = document.getElementById('mermaid-zoom-badge');
    if (badge) {
        badge.textContent = `${Math.round(mermaidZoomScale * 100)}%`;
    }
}

// 3. 좌우 스플리터 리사이저
function initMermaidResizer() {
    const resizer = document.getElementById('mermaid-resizer');
    const editorPane = document.getElementById('mermaid-editor-pane');
    const container = document.getElementById('mermaid-split');

    if (!resizer || !editorPane || !container) return;

    let isResizing = false;

    resizer.addEventListener('mousedown', (e) => {
        isResizing = true;
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
    });

    document.addEventListener('mousemove', (e) => {
        if (!isResizing) return;
        const rect = container.getBoundingClientRect();
        const newWidth = e.clientX - rect.left;
        const totalWidth = rect.width;
        const percent = (newWidth / totalWidth) * 100;

        if (percent >= 20 && percent <= 80) {
            editorPane.style.flex = `0 0 ${percent}%`;
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

// ==========================================
// 4. 저장된 다이어그램 목록 관리 및 영속화 (Write-Back)
// ==========================================
let savedDiagrams = [];
let draftSavedDiagrams = [];
let diagramSearchQuery = '';
let editingDiagramId = null;

async function loadSavedDiagrams() {
    try {
        if (window.eel && typeof eel.get_diagrams === 'function') {
            const res = await eel.get_diagrams()();
            if (res.status === 'success' && Array.isArray(res.data) && res.data.length > 0) {
                savedDiagrams = res.data;
            } else {
                savedDiagrams = DEFAULT_DIAGRAMS_FALLBACK;
            }
        } else {
            const saved = localStorage.getItem('user_saved_diagrams');
            savedDiagrams = saved ? JSON.parse(saved) : DEFAULT_DIAGRAMS_FALLBACK;
        }
    } catch (e) {
        savedDiagrams = DEFAULT_DIAGRAMS_FALLBACK;
    }
    updateDiagramsCountBadge();
}

function updateDiagramsCountBadge() {
    const badge = document.getElementById('mermaid-saved-count-badge');
    if (badge) badge.textContent = savedDiagrams.length;
}

async function saveSavedDiagramsToBackend() {
    try {
        localStorage.setItem('user_saved_diagrams', JSON.stringify(savedDiagrams));
        if (window.eel && typeof eel.save_diagrams === 'function') {
            await eel.save_diagrams(savedDiagrams)();
        }
    } catch (e) {
        console.error("다이어그램 저장 실패:", e);
    }
}

// 다이어그램 목록 모달 열기
function openDiagramListModal() {
    draftSavedDiagrams = JSON.parse(JSON.stringify(savedDiagrams));
    diagramSearchQuery = '';
    const searchInput = document.getElementById('diagram-search-input');
    const clearBtn = document.getElementById('diagram-search-clear-btn');
    if (searchInput) searchInput.value = '';
    if (clearBtn) clearBtn.style.display = 'none';

    renderDiagramsManageList();
    document.getElementById('diagram-list-modal').classList.add('show');
}

function closeDiagramListModal() {
    draftSavedDiagrams = [];
    document.getElementById('diagram-list-modal').classList.remove('show');
}

// 다이어그램 목록 렌더링
function renderDiagramsManageList() {
    const listEl = document.getElementById('diagrams-manage-list');
    const countEl = document.getElementById('diagram-saved-count');
    if (countEl) countEl.textContent = draftSavedDiagrams.length;
    if (!listEl) return;

    // 검색 필터링
    const filtered = draftSavedDiagrams.filter(item => {
        if (!diagramSearchQuery) return true;
        const t = (item.title || '').toLowerCase();
        const d = (item.description || '').toLowerCase();
        const c = (item.category || '').toLowerCase();
        const code = (item.code || '').toLowerCase();
        return t.includes(diagramSearchQuery) || d.includes(diagramSearchQuery) || c.includes(diagramSearchQuery) || code.includes(diagramSearchQuery);
    });

    if (filtered.length === 0) {
        if (draftSavedDiagrams.length === 0) {
            listEl.innerHTML = '<div style="color:var(--text-secondary); text-align:center; padding:25px;">저장된 다이어그램이 없습니다. [➕ 현재 스크립트 저장]을 눌러 저장해 보세요!</div>';
        } else {
            listEl.innerHTML = `<div style="color:var(--text-secondary); text-align:center; padding:25px;">'${escapeHtml(diagramSearchQuery)}' 검색어와 일치하는 다이어그램이 없습니다.</div>`;
        }
        return;
    }

    listEl.innerHTML = filtered.map((item, idx) => {
        const timeStr = item.updatedAt ? `<span style="font-size:0.7rem; color:var(--text-secondary); margin-left:6px;">🕒 ${item.updatedAt}</span>` : '';
        const catBadge = item.category ? `<span class="gen-card-cat" style="margin-left:6px;">${escapeHtml(item.category)}</span>` : '';
        const descStr = item.description || item.code.split('\n').filter(Boolean).slice(0, 2).join(' | ');

        return `
            <div class="manage-item" style="padding: 10px 14px;">
                <div class="manage-item-info">
                    <div class="manage-item-name" style="font-weight: 600; font-size: 0.92rem;">
                        📊 ${escapeHtml(item.title)}
                        ${catBadge}
                        ${timeStr}
                    </div>
                    <div class="manage-item-path" title="${escapeHtml(descStr)}">${escapeHtml(descStr)}</div>
                </div>
                <div class="manage-item-actions" style="gap: 6px;">
                    <button type="button" class="form-btn add-btn" onclick="loadDiagramIntoEditor('${item.id}')" title="에디터로 불러와서 보기/수정" style="padding: 3px 10px; font-size: 0.76rem;">📥 불러오기</button>
                    <button type="button" class="item-edit-btn" onclick="editSavedDiagramMeta('${item.id}')" title="제목/설명 수정">✏️</button>
                    <button type="button" class="item-delete-btn" onclick="deleteSavedDiagram('${item.id}')" title="삭제">삭제</button>
                </div>
            </div>
        `;
    }).join('');
}

// 다이어그램 에디터로 불러오기
async function loadDiagramIntoEditor(id) {
    const item = draftSavedDiagrams.find(d => String(d.id) === String(id)) || savedDiagrams.find(d => String(d.id) === String(id));
    if (!item) return;

    const editor = document.getElementById('mermaid-code-editor');
    if (editor) {
        editor.value = item.code || '';
        renderMermaid(true);
        closeDiagramListModal();
        logToConsole('다이어그램 불러오기 완료', `'${item.title}' 다이어그램을 에디터에 로드했습니다.`);
        await showAppAlert(`'${item.title}' 다이어그램을 성공적으로 불러왔습니다! 📥`, '불러오기 완료', '✅');
    }
}

// 다이어그램 메타데이터 수정
function editSavedDiagramMeta(id) {
    const item = draftSavedDiagrams.find(d => String(d.id) === String(id));
    if (!item) return;

    editingDiagramId = id;
    document.getElementById('save-diagram-modal-title').textContent = `✏️ '${item.title}' 정보 수정`;
    document.getElementById('save-diagram-title').value = item.title || '';
    document.getElementById('save-diagram-category').value = item.category || '';
    document.getElementById('save-diagram-desc').value = item.description || '';

    document.getElementById('save-diagram-modal').classList.add('show');
    document.getElementById('save-diagram-title').focus();
}

// 다이어그램 삭제
async function deleteSavedDiagram(id) {
    const item = draftSavedDiagrams.find(d => String(d.id) === String(id));
    const confirmed = await showAppConfirm(`'${item ? item.title : '선택한'}' 다이어그램을 삭제하시겠습니까?\n(하단의 [💾 변경사항 저장]을 눌러야 최종 반영됩니다)`, {
        title: '다이어그램 삭제',
        icon: '🗑️',
        confirmText: '삭제',
        isDanger: true
    });
    if (!confirmed) return;

    draftSavedDiagrams = draftSavedDiagrams.filter(d => String(d.id) !== String(id));
    renderDiagramsManageList();
}

// 기본값 복원
async function resetDefaultDiagrams() {
    const confirmed = await showAppConfirm('기본 샘플 다이어그램 목록으로 되돌리시겠습니까?\n(하단의 [💾 변경사항 저장]을 눌러야 최종 반영됩니다)', {
        title: '기본값 복원',
        icon: '🔄',
        confirmText: '복원',
        isDanger: true
    });
    if (confirmed) {
        draftSavedDiagrams = JSON.parse(JSON.stringify(DEFAULT_DIAGRAMS_FALLBACK));
        renderDiagramsManageList();
    }
}

// 다이어그램 변경사항 영구 저장 (Write-Back)
async function saveDiagramChanges() {
    savedDiagrams = JSON.parse(JSON.stringify(draftSavedDiagrams));
    await saveSavedDiagramsToBackend();
    updateDiagramsCountBadge();
    closeDiagramListModal();
    logToConsole('다이어그램 목록 저장 완료', `총 ${savedDiagrams.length}개의 다이어그램 설정이 안전하게 저장되었습니다.`);
}

// 현재 에디터 스크립트 저장 모달 열기
async function openSaveCurrentDiagramPrompt() {
    const editor = document.getElementById('mermaid-code-editor');
    if (!editor || !editor.value.trim()) {
        await showAppAlert('저장할 다이어그램 스크립트가 없습니다. 먼저 코드를 작성해 주세요.', '알림', '⚠️');
        return;
    }

    editingDiagramId = null;
    document.getElementById('save-diagram-modal-title').textContent = '💾 현재 다이어그램 저장';
    
    // 첫 줄이나 내용에서 카테고리/제목 자동 유추
    const code = editor.value.trim();
    let guessedCategory = 'Flowchart';
    if (code.startsWith('sequenceDiagram')) guessedCategory = 'Sequence';
    else if (code.startsWith('classDiagram')) guessedCategory = 'Class';
    else if (code.startsWith('erDiagram')) guessedCategory = 'ERD';
    else if (code.startsWith('stateDiagram')) guessedCategory = 'State';
    else if (code.startsWith('gantt')) guessedCategory = 'Gantt';
    else if (code.startsWith('mindmap')) guessedCategory = 'Mindmap';
    else if (code.startsWith('gitGraph')) guessedCategory = 'Git Graph';
    else if (code.startsWith('pie')) guessedCategory = 'Pie Chart';

    document.getElementById('save-diagram-title').value = '';
    document.getElementById('save-diagram-category').value = guessedCategory;
    document.getElementById('save-diagram-desc').value = '';

    document.getElementById('save-diagram-modal').classList.add('show');
    document.getElementById('save-diagram-title').focus();
}

function closeSaveDiagramModal() {
    editingDiagramId = null;
    document.getElementById('save-diagram-modal').classList.remove('show');
}

// 다이어그램 저장 확정
async function confirmSaveDiagram() {
    const title = document.getElementById('save-diagram-title').value.trim();
    const category = document.getElementById('save-diagram-category').value.trim() || 'General';
    const desc = document.getElementById('save-diagram-desc').value.trim();

    if (!title) {
        await showAppAlert('다이어그램 제목을 입력해 주세요.', '입력 필요', '⚠️');
        return;
    }

    const editor = document.getElementById('mermaid-code-editor');
    const nowStr = new Date().toISOString().slice(0, 19).replace('T', ' ');

    if (editingDiagramId !== null) {
        // 기존 항목 수정
        const target = (draftSavedDiagrams.length > 0 ? draftSavedDiagrams : savedDiagrams).find(d => String(d.id) === String(editingDiagramId));
        if (target) {
            target.title = title;
            target.category = category;
            target.description = desc;
            target.updatedAt = nowStr;
        }
        if (draftSavedDiagrams.length === 0) {
            await saveSavedDiagramsToBackend();
        }
    } else {
        // 신규 추가
        const newItem = {
            id: Date.now().toString(),
            title,
            category,
            description: desc,
            code: editor ? editor.value : '',
            updatedAt: nowStr
        };

        if (draftSavedDiagrams.length > 0) {
            draftSavedDiagrams.unshift(newItem);
        } else {
            savedDiagrams.unshift(newItem);
            await saveSavedDiagramsToBackend();
        }
    }

    closeSaveDiagramModal();
    updateDiagramsCountBadge();

    if (document.getElementById('diagram-list-modal').classList.contains('show')) {
        renderDiagramsManageList();
    } else {
        logToConsole('다이어그램 저장 완료', `[${title}] 저장되었습니다.`);
        await showAppAlert(`'${title}' 다이어그램이 성공적으로 저장되었습니다! 💾`, '저장 완료', '✅');
    }
}

// 검색 핸들러
function onDiagramSearchInput(val) {
    diagramSearchQuery = (val || '').trim().toLowerCase();
    const clearBtn = document.getElementById('diagram-search-clear-btn');
    if (clearBtn) {
        clearBtn.style.display = diagramSearchQuery ? 'inline-block' : 'none';
    }
    renderDiagramsManageList();
}

function clearDiagramSearch() {
    const input = document.getElementById('diagram-search-input');
    const clearBtn = document.getElementById('diagram-search-clear-btn');
    if (input) input.value = '';
    if (clearBtn) clearBtn.style.display = 'none';
    diagramSearchQuery = '';
    renderDiagramsManageList();
    if (input) input.focus();
}


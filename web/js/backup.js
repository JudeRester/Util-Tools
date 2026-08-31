/**
 * 통합 데이터 백업 & 복원 (Export / Import) 제어 모듈 (web/js/backup.js)
 * - Python 백엔드 Zero-Memory 직접 파일 I/O 연동 (대용량 파일도 브라우저 랙 0)
 * - Windows 표준 파일 대화상자로 JSON 및 ZIP 백업 파일 직접 저장/로드
 * - 백엔드 DATA_REGISTRY와 연동되어 신규 모듈 자동 감지 및 실시간 UI 갱신
 */

let registeredBackupModules = [];
let selectedExportKeys = new Set();
let incomingBackupFile = null; // { file_path, file_name, file_size_str, exported_at, modules: [] }
let incomingImportPayload = null; // 인라인 JSON 텍스트 직접 입력 fallback
let selectedImportKeys = new Set();

// ==========================================
// 1. 모달 열기/닫기
// ==========================================
async function openBackupModal() {
    await fetchRegisteredBackupModules();
    switchBackupTab('export');
    const modal = document.getElementById('backup-modal');
    if (modal) modal.classList.add('show');
}

function closeBackupModal() {
    const modal = document.getElementById('backup-modal');
    if (modal) modal.classList.remove('show');
    resetImportForm();
}

// ==========================================
// 2. 백엔드 등록 모듈 동적 로드
// ==========================================
async function fetchRegisteredBackupModules() {
    try {
        if (window.eel && typeof eel.get_registered_backup_modules === 'function') {
            const res = await eel.get_registered_backup_modules()();
            if (res && res.status === 'success' && Array.isArray(res.data)) {
                registeredBackupModules = res.data;
            }
        }
    } catch (e) {
        console.warn("등록 모듈 로드 실패 (기본값 사용):", e);
    }

    if (registeredBackupModules.length === 0) {
        registeredBackupModules = [
            { key: "shortcuts", label: "폴더 바로가기", icon: "📁", item_count: 0 },
            { key: "quick_launch", label: "빠른 실행", icon: "⚡", item_count: 0 },
            { key: "generators", label: "데이터 생성기", icon: "🔢", item_count: 0 },
            { key: "notes", label: "빠른 메모", icon: "📝", item_count: 0 },
            { key: "calendar", label: "달력 & 일정 구독", icon: "📅", item_count: 0 },
            { key: "diagrams", label: "Mermaid 다이어그램", icon: "📊", item_count: 0 },
            { key: "emails", label: "이메일 아카이브", icon: "📧", item_count: 0 },
            { key: "mock_templates", label: "모의 데이터 양식", icon: "🎲", item_count: 0 },
            { key: "settings", label: "앱 설정 & UI 레이아웃", icon: "⚙️", item_count: 0 },
            { key: "redmine_config", label: "Redmine 연동 설정", icon: "🦊", item_count: 0 }
        ];
    }

    // 기본 전체 선택
    selectedExportKeys = new Set(registeredBackupModules.map(m => m.key));
    renderExportModulesList();
}

// ==========================================
// 3. 서브 탭 전환 (Export vs Import)
// ==========================================
function switchBackupTab(tab) {
    const exportBtn = document.getElementById('backup-tab-export');
    const importBtn = document.getElementById('backup-tab-import');
    const exportPane = document.getElementById('backup-export-pane');
    const importPane = document.getElementById('backup-import-pane');

    if (tab === 'export') {
        if (exportBtn) exportBtn.classList.add('active');
        if (importBtn) importBtn.classList.remove('active');
        if (exportPane) exportPane.style.display = 'block';
        if (importPane) importPane.style.display = 'none';
        renderExportModulesList();
    } else {
        if (importBtn) importBtn.classList.add('active');
        if (exportBtn) exportBtn.classList.remove('active');
        if (importPane) importPane.style.display = 'block';
        if (exportPane) exportPane.style.display = 'none';
    }
}

// ==========================================
// 4. 내보내기(Export) 모듈 목록 & 실행
// ==========================================
function renderExportModulesList() {
    const listEl = document.getElementById('backup-export-modules-list');
    const selectAllCb = document.getElementById('export-select-all');
    const countBadge = document.getElementById('export-selected-count');

    if (countBadge) {
        countBadge.textContent = `선택: ${selectedExportKeys.size} / ${registeredBackupModules.length}개`;
    }
    if (selectAllCb) {
        selectAllCb.checked = selectedExportKeys.size === registeredBackupModules.length;
    }
    if (!listEl) return;

    listEl.innerHTML = registeredBackupModules.map(m => {
        const isChecked = selectedExportKeys.has(m.key);
        const countText = m.item_count !== undefined ? `${m.item_count}개 항목` : '설정 파일';

        return `
            <div class="backup-module-card ${isChecked ? 'selected' : ''}" onclick="toggleExportKey('${m.key}')">
                <input type="checkbox" ${isChecked ? 'checked' : ''} onclick="event.stopPropagation(); toggleExportKey('${m.key}')">
                <div class="backup-module-info">
                    <div class="backup-module-title">${m.icon} ${escapeHtml(m.label)}</div>
                    <div class="backup-module-sub">${countText}</div>
                </div>
            </div>
        `;
    }).join('');
}

function toggleExportKey(key) {
    if (selectedExportKeys.has(key)) {
        selectedExportKeys.delete(key);
    } else {
        selectedExportKeys.add(key);
    }
    renderExportModulesList();
}

function toggleAllExportCheckboxes(checked) {
    if (checked) {
        selectedExportKeys = new Set(registeredBackupModules.map(m => m.key));
    } else {
        selectedExportKeys.clear();
    }
    renderExportModulesList();
}

// 4-1. 백엔드 Zero-Memory 직접 파일 저장 (JSON 또는 ZIP)
async function executeExportDownload() {
    if (selectedExportKeys.size === 0) {
        await showAppAlert('내보낼 데이터 항목을 최소 1개 이상 선택해 주세요.', '선택 필요', '⚠️');
        return;
    }

    try {
        const keys = Array.from(selectedExportKeys);

        // 1. Python 백엔드 직접 파일 저장 (Zero-Memory)
        if (window.eel && typeof eel.export_toolkit_to_file === 'function') {
            const res = await eel.export_toolkit_to_file(keys, 'json')();
            if (res && res.status === 'success') {
                logToConsole('데이터 백업 파일 저장 완료', `[${res.file_name}] (${res.file_size_str}) -> ${res.file_path}`);
                showToast('백업 완료', `백업 파일(${res.file_name}, ${res.file_size_str})이 성공적으로 저장되었습니다! 💾`, '✅', 3500);
                return;
            } else if (res && res.status === 'cancelled') {
                // 사용자가 저장 취소
                return;
            } else if (res && res.status === 'error') {
                throw new Error(res.message);
            }
        }

        // 2. 브라우저 로컬스토리지 Fallback Export
        let exportData = null;
        let filename = `utility-toolkit-backup-${new Date().toISOString().slice(0, 10)}.json`;

        if (window.eel && typeof eel.export_toolkit_data === 'function') {
            const res = await eel.export_toolkit_data(keys)();
            if (res.status === 'success') {
                exportData = res.payload;
                if (res.filename) filename = res.filename;
            }
        }

        if (!exportData) {
            exportData = {
                app: "Utility-Toolkit",
                version: "2.0.0",
                exported_at: new Date().toISOString().slice(0, 19).replace('T', ' '),
                data: {}
            };
            if (keys.includes('shortcuts')) exportData.data.shortcuts = JSON.parse(localStorage.getItem('folder_shortcuts') || '[]');
            if (keys.includes('quick_launch')) exportData.data.quick_launch = JSON.parse(localStorage.getItem('quick_launch_items') || '[]');
            if (keys.includes('generators')) exportData.data.generators = JSON.parse(localStorage.getItem('user_generators') || '[]');
            if (keys.includes('notes')) exportData.data.notes = JSON.parse(localStorage.getItem('user_notes') || '[]');
            if (keys.includes('calendar')) exportData.data.calendar = JSON.parse(localStorage.getItem('calendar_config') || '{}');
            if (keys.includes('diagrams')) exportData.data.diagrams = JSON.parse(localStorage.getItem('user_saved_diagrams') || '[]');
            if (keys.includes('settings')) exportData.data.settings = JSON.parse(localStorage.getItem('app_settings') || '{}');
        }

        const jsonStr = JSON.stringify(exportData, null, 2);
        const blob = new Blob([jsonStr], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        logToConsole('데이터 백업 완료', `[${filename}] ${keys.length}개 모듈 내보내기 완료`);
        showToast('백업 완료', `백업 파일(${filename})이 다운로드되었습니다! 💾`, '✅');
    } catch (err) {
        console.error("내보내기 오류:", err);
        await showAppAlert(`내보내기 중 오류가 발생했습니다: ${err.message}`, '오류', '⚠️');
    }
}

async function copyExportJsonToClipboard() {
    if (selectedExportKeys.size === 0) {
        await showAppAlert('내보낼 데이터 항목을 선택해 주세요.', '선택 필요', '⚠️');
        return;
    }

    try {
        const keys = Array.from(selectedExportKeys);
        let exportData = null;

        if (window.eel && typeof eel.export_toolkit_data === 'function') {
            const res = await eel.export_toolkit_data(keys)();
            if (res && res.status === 'success') {
                exportData = res.payload;
            }
        }

        if (!exportData) {
            exportData = {
                app: "Utility-Toolkit",
                exported_at: new Date().toISOString(),
                data: {}
            };
        }

        const jsonStr = JSON.stringify(exportData, null, 2);
        await navigator.clipboard.writeText(jsonStr);
        logToConsole('백업 JSON 복사 완료', `${keys.length}개 모듈 JSON이 클립보드에 복사되었습니다.`);
        showToast('복사 완료', '백업 JSON 텍스트가 클립보드에 복사되었습니다! 📋', '✅');
    } catch (e) {
        await showAppAlert('클립보드 복사 실패', '오류', '⚠️');
    }
}

// ==========================================
// 5. 가져오기(Import) - Zero-Memory 파일 선택 및 요약
// ==========================================

async function triggerImportFileInput() {
    // 1. Python 백엔드 OS 탐색기 직접 열기 (Zero-Memory)
    if (window.eel && typeof eel.pick_backup_file_and_get_summary === 'function') {
        try {
            const res = await eel.pick_backup_file_and_get_summary()();
            if (res && res.status === 'success') {
                incomingBackupFile = res;
                incomingImportPayload = null;
                renderImportFileSummary(res);
                return;
            } else if (res && res.status === 'cancelled') {
                // 사용자 취소
                return;
            } else if (res && res.status === 'error') {
                showToast('백업 파일 열기 실패', res.message, '⚠️');
                return;
            }
        } catch (e) {
            console.warn("백엔드 파일 선택 실패, 브라우저 input fallback:", e);
        }
    }

    // 2. 브라우저 input fallback
    const input = document.getElementById('backup-file-input');
    if (input) input.click();
}

function handleBackupFileSelect(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
        const content = e.target.result;
        parseAndPreviewImportJson(content, file.name, file.size);
    };
    reader.readAsText(file);
}

function renderImportFileSummary(fileInfo) {
    const bannerEl = document.getElementById('import-file-banner');
    const previewBox = document.getElementById('import-preview-box');
    const checklist = document.getElementById('import-modules-checklist');
    const restoreBtn = document.getElementById('execute-import-btn');
    const dropzone = document.getElementById('backup-dropzone');

    if (bannerEl) {
        bannerEl.style.display = 'flex';
        bannerEl.innerHTML = `
            <div class="import-file-meta">
                <span class="file-icon">📦</span>
                <div class="file-details">
                    <span class="file-name">${escapeHtml(fileInfo.file_name)}</span>
                    <span class="file-sub">크기: <b>${fileInfo.file_size_str}</b> | 백업 일시: ${escapeHtml(fileInfo.exported_at || '알 수 없음')}</span>
                </div>
            </div>
            <button type="button" class="mini-tool-btn" onclick="triggerImportFileInput()" title="다른 백업 파일 선택">🔄 파일 변경</button>
        `;
    }

    if (dropzone) dropzone.style.display = 'none';

    // 모듈 체크리스트 렌더링
    selectedImportKeys = new Set((fileInfo.modules || []).map(m => m.key));

    if (checklist) {
        checklist.innerHTML = (fileInfo.modules || []).map(m => {
            return `
                <div class="backup-module-card selected" onclick="toggleImportKey('${m.key}', this)">
                    <input type="checkbox" checked onclick="event.stopPropagation(); toggleImportKey('${m.key}', this.closest('.backup-module-card'))">
                    <div class="backup-module-info">
                        <div class="backup-module-title">${m.icon} ${escapeHtml(m.label)}</div>
                        <div class="backup-module-sub">${m.count_str}</div>
                    </div>
                </div>
            `;
        }).join('');
    }

    if (previewBox) previewBox.style.display = 'block';
    if (restoreBtn) restoreBtn.disabled = selectedImportKeys.size === 0;
}

function onImportJsonTextChange() {
    const textarea = document.getElementById('import-json-textarea');
    if (textarea && textarea.value.trim()) {
        incomingBackupFile = null;
        parseAndPreviewImportJson(textarea.value);
    }
}

// 6. JSON 텍스트 직접 입력 미리보기 파싱
function parseAndPreviewImportJson(rawText, fileName = '', fileSize = 0) {
    const previewBox = document.getElementById('import-preview-box');
    const checklist = document.getElementById('import-modules-checklist');
    const restoreBtn = document.getElementById('execute-import-btn');

    if (!rawText.trim()) {
        incomingImportPayload = null;
        if (previewBox) previewBox.style.display = 'none';
        if (restoreBtn) restoreBtn.disabled = true;
        return;
    }

    try {
        const parsed = JSON.parse(rawText);
        if (!parsed || typeof parsed !== 'object' || !parsed.data) {
            throw new Error('올바른 Utility Toolkit 백업 형식이 아닙니다 (data 필드 없음).');
        }

        incomingImportPayload = parsed;
        const availableKeys = Object.keys(parsed.data);

        if (availableKeys.length === 0) {
            throw new Error('백업 파일 내에 복원 가능한 데이터가 없습니다.');
        }

        selectedImportKeys = new Set(availableKeys);

        if (checklist) {
            checklist.innerHTML = availableKeys.map(key => {
                const regMeta = registeredBackupModules.find(m => m.key === key) || { label: key, icon: '📦' };
                const val = parsed.data[key];
                let countStr = '';
                if (Array.isArray(val)) countStr = `${val.length}개 항목`;
                else if (val && typeof val === 'object') {
                    countStr = key === 'calendar' && val.ics_urls ? `${val.ics_urls.length}개 구독` : `${Object.keys(val).length}개 설정`;
                }

                return `
                    <div class="backup-module-card selected" onclick="toggleImportKey('${key}', this)">
                        <input type="checkbox" checked onclick="event.stopPropagation(); toggleImportKey('${key}', this.closest('.backup-module-card'))">
                        <div class="backup-module-info">
                            <div class="backup-module-title">${regMeta.icon} ${escapeHtml(regMeta.label)}</div>
                            <div class="backup-module-sub">${countStr}</div>
                        </div>
                    </div>
                `;
            }).join('');
        }

        if (previewBox) previewBox.style.display = 'block';
        if (restoreBtn) restoreBtn.disabled = false;
    } catch (e) {
        incomingImportPayload = null;
        if (previewBox) previewBox.style.display = 'none';
        if (restoreBtn) restoreBtn.disabled = true;
    }
}

function toggleImportKey(key, cardEl) {
    if (selectedImportKeys.has(key)) {
        selectedImportKeys.delete(key);
        if (cardEl) {
            cardEl.classList.remove('selected');
            const cb = cardEl.querySelector('input[type="checkbox"]');
            if (cb) cb.checked = false;
        }
    } else {
        selectedImportKeys.add(key);
        if (cardEl) {
            cardEl.classList.add('selected');
            const cb = cardEl.querySelector('input[type="checkbox"]');
            if (cb) cb.checked = true;
        }
    }

    const restoreBtn = document.getElementById('execute-import-btn');
    if (restoreBtn) restoreBtn.disabled = selectedImportKeys.size === 0;
}

function resetImportForm() {
    const textarea = document.getElementById('import-json-textarea');
    const previewBox = document.getElementById('import-preview-box');
    const restoreBtn = document.getElementById('execute-import-btn');
    const fileInput = document.getElementById('backup-file-input');
    const bannerEl = document.getElementById('import-file-banner');
    const dropzone = document.getElementById('backup-dropzone');

    if (textarea) textarea.value = '';
    if (previewBox) previewBox.style.display = 'none';
    if (restoreBtn) restoreBtn.disabled = true;
    if (fileInput) fileInput.value = '';
    if (bannerEl) bannerEl.style.display = 'none';
    if (dropzone) dropzone.style.display = 'flex';

    incomingBackupFile = null;
    incomingImportPayload = null;
    selectedImportKeys.clear();
}

// ==========================================
// 7. 데이터 복원 실행 (Zero-Memory Backend Restore)
// ==========================================
async function executeImportRestore() {
    if ((!incomingBackupFile && !incomingImportPayload) || selectedImportKeys.size === 0) {
        await showAppAlert('복원할 데이터 모듈을 선택해 주세요.', '알림', '⚠️');
        return;
    }

    const modeInput = document.querySelector('input[name="import-mode"]:checked');
    const mode = modeInput ? modeInput.value : 'replace';

    const confirmed = await showAppConfirm(`선택한 ${selectedImportKeys.size}개의 데이터 모듈을 시스템에 복원하시겠습니까?\n(방식: ${mode === 'replace' ? '기존 데이터 덮어쓰기' : '기존 데이터에 병합'})`, {
        title: '데이터 복원 확인',
        icon: '📥',
        confirmText: '복원 실행',
        isDanger: mode === 'replace'
    });
    if (!confirmed) return;

    try {
        const keys = Array.from(selectedImportKeys);
        let success = false;
        let restoredCount = 0;

        // 1. Python 백엔드 디스크 직접 고속 복원 (Zero-Memory)
        if (incomingBackupFile && window.eel && typeof eel.restore_toolkit_from_file === 'function') {
            showToast('데이터 복원 중', 'Python 백엔드에서 SQLite DB로 고속 복원하고 있습니다... ⏳', '📦', 2000);
            const res = await eel.restore_toolkit_from_file(incomingBackupFile.file_path, keys, mode)();
            if (res && res.status === 'success') {
                success = true;
                restoredCount = res.restored_keys ? res.restored_keys.length : keys.length;
            } else {
                throw new Error((res && res.message) || '백엔드 파일 복원 오류');
            }
        } 
        // 2. 인라인 JSON 텍스트 복원
        else if (incomingImportPayload && window.eel && typeof eel.import_toolkit_data === 'function') {
            const res = await eel.import_toolkit_data(incomingImportPayload, keys, mode)();
            if (res && res.status === 'success') {
                success = true;
                restoredCount = res.restored_keys ? res.restored_keys.length : keys.length;
            } else {
                throw new Error((res && res.message) || '백엔드 데이터 복원 오류');
            }
        }
        // 3. 브라우저 로컬스토리지 fallback
        else if (incomingImportPayload) {
            const data = incomingImportPayload.data;
            if (keys.includes('shortcuts') && data.shortcuts) localStorage.setItem('folder_shortcuts', JSON.stringify(data.shortcuts));
            if (keys.includes('quick_launch') && data.quick_launch) localStorage.setItem('quick_launch_items', JSON.stringify(data.quick_launch));
            if (keys.includes('generators') && data.generators) localStorage.setItem('user_generators', JSON.stringify(data.generators));
            if (keys.includes('notes') && data.notes) localStorage.setItem('user_notes', JSON.stringify(data.notes));
            if (keys.includes('calendar') && data.calendar) localStorage.setItem('calendar_config', JSON.stringify(data.calendar));
            if (keys.includes('diagrams') && data.diagrams) localStorage.setItem('user_saved_diagrams', JSON.stringify(data.diagrams));
            if (keys.includes('settings') && data.settings) localStorage.setItem('app_settings', JSON.stringify(data.settings));
            success = true;
            restoredCount = keys.length;
        }

        if (success) {
            // 전체 탭 UI 실시간 리로드
            if (typeof loadFolderShortcuts === 'function') loadFolderShortcuts();
            if (typeof loadQuickLaunchItems === 'function') loadQuickLaunchItems();
            if (typeof loadGenerators === 'function') loadGenerators();
            if (typeof loadNotes === 'function') loadNotes();
            if (typeof initCalendar === 'function') initCalendar();
            if (typeof loadSavedDiagrams === 'function') loadSavedDiagrams();
            if (typeof loadAppSettings === 'function') await loadAppSettings();
            if (typeof initEmailViewer === 'function') initEmailViewer();

            closeBackupModal();
            logToConsole('데이터 복원 완료', `총 ${restoredCount}개의 데이터 모듈이 안전하게 복원되었습니다.`);
            showToast('데이터 복원 완료', `총 ${restoredCount}개의 데이터 모듈이 성공적으로 복원되었습니다! 🎉`, '✅', 4000);
        }
    } catch (err) {
        console.error("복원 실패:", err);
        await showAppAlert(`데이터 복원 중 오류가 발생했습니다: ${err.message}`, '복원 실패', '⚠️');
    }
}

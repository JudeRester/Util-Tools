/**
 * 메인 애플리케이션 진입점 및 탭 네비게이션 제어 모듈
 */

// ==========================================
// 1. 공통 유틸리티 함수
// ==========================================
function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/[&<>"']/g, m => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[m]));
}

function escapeJsString(str) {
    if (!str) return '';
    return String(str).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}


// ==========================================
// 2. 반응형 모바일 햄버거 & 탭 드롭다운 제어
// ==========================================
function toggleMobileNav(e) {
    if (e) e.stopPropagation();
    const wrapper = document.getElementById('tab-btn-wrapper');
    const hamburgerBtn = document.getElementById('hamburger-menu-btn');
    if (!wrapper) return;

    const isOpen = wrapper.classList.toggle('open');
    if (hamburgerBtn) {
        hamburgerBtn.innerHTML = isOpen
            ? '<span class="hamburger-icon">✕</span> 닫기'
            : '<span class="hamburger-icon">☰</span> 메뉴';
    }
}

function closeMobileNav() {
    const wrapper = document.getElementById('tab-btn-wrapper');
    const hamburgerBtn = document.getElementById('hamburger-menu-btn');
    if (wrapper && wrapper.classList.contains('open')) {
        wrapper.classList.remove('open');
        if (hamburgerBtn) {
            hamburgerBtn.innerHTML = '<span class="hamburger-icon">☰</span> 메뉴';
        }
    }
}

function toggleViewerDiagramDropdown(e) {
    if (e) e.stopPropagation();
    const dropdown = document.getElementById('viewer-diagram-dropdown');
    if (dropdown) {
        dropdown.classList.toggle('open');
    }
}

function closeViewerDiagramDropdown() {
    const dropdown = document.getElementById('viewer-diagram-dropdown');
    if (dropdown && dropdown.classList.contains('open')) {
        dropdown.classList.remove('open');
    }
}

function selectDropdownTab(tabName, icon, label, e) {
    if (e) e.stopPropagation();
    closeViewerDiagramDropdown();
    switchTab(tabName);
}


// ==========================================
// 3. 통합 앱 설정(app_settings.json) 및 탭 영속화
// ==========================================
let appSettings = {
    active_tab_id: 'system',
    console_height: 180,
    console_collapsed: false,
    calendar_month_width: null,
    notes_sidebar_width: null,
    js_editor_width: null
};

async function loadAppSettings() {
    try {
        if (window.eel && typeof eel.get_app_settings === 'function') {
            const res = await eel.get_app_settings()();
            if (res.status === 'success' && res.data) {
                appSettings = Object.assign({}, appSettings, res.data);
                // 로컬스토리지에도 동기화
                Object.keys(appSettings).forEach(k => {
                    if (appSettings[k] !== null && appSettings[k] !== undefined) {
                        localStorage.setItem(k, appSettings[k]);
                    }
                });
            }
        }
    } catch (e) {
        console.warn('앱 설정 로드 실패 (로컬스토리지 fallback 사용):', e);
    }
}

function saveAppSettingKey(key, value) {
    appSettings[key] = value;
    try {
        localStorage.setItem(key, value);
    } catch (e) {}

    // 백엔드 app_settings.json 파일에 비동기 영구 저장
    if (window.eel && typeof eel.save_app_settings === 'function') {
        eel.save_app_settings({ [key]: value })().catch(err => {
            console.warn(`설정 ${key} 저장 오류:`, err);
        });
    }
}

let currentActiveTab = null;
const initializedTabs = new Set();

function initTabOnDemand(tabName) {
    if (!tabName) return;

    if (initializedTabs.has(tabName)) {
        // 이미 로드된 탭으로 복귀 시 화면 재개(Resume)
        if (tabName === 'mermaid' && typeof resumeMermaidDiagram === 'function') {
            resumeMermaidDiagram();
        }
        return;
    }

    initializedTabs.add(tabName);

    switch (tabName) {
        case 'system':
            // 시스템 정보는 system.js에서 주기적으로 갱신
            break;
        case 'launch':
            if (typeof loadQuickLaunchItems === 'function') loadQuickLaunchItems();
            break;
        case 'files':
            if (typeof loadFolderShortcuts === 'function') loadFolderShortcuts();
            break;
        case 'generator':
            if (typeof loadGenerators === 'function') loadGenerators();
            if (typeof initMockDataStudio === 'function') initMockDataStudio();
            break;
        case 'jsrunner':
            if (typeof initJsPlayground === 'function') initJsPlayground();
            break;
        case 'notes':
            if (typeof loadNotes === 'function') loadNotes();
            break;
        case 'calendar':
            if (typeof initCalendar === 'function') initCalendar();
            break;
        case 'mermaid':
            if (typeof initMermaidDiagram === 'function') initMermaidDiagram();
            break;
        case 'csv':
            if (typeof initCsvViewer === 'function') initCsvViewer();
            break;
        case 'markdown':
            if (typeof initMarkdownViewer === 'function') initMarkdownViewer();
            break;
        case 'emails':
            if (typeof initEmailViewer === 'function') initEmailViewer();
            break;
    }
}

function teardownTab(tabName) {
    if (!tabName) return;

    if (tabName === 'mermaid') {
        if (typeof teardownMermaidDiagram === 'function') {
            teardownMermaidDiagram();
        }
    } else if (tabName === 'emails') {
        if (typeof teardownEmailViewer === 'function') {
            teardownEmailViewer();
        }
    }

    // V8 가비지 컬렉터 강제 호출 (Chrome --js-flags=--expose-gc 옵션 활성화 시 동작)
    if (typeof window.gc === 'function') {
        try {
            window.gc();
        } catch (e) {}
    }
}

function switchTab(targetTab) {
    if (!targetTab) return;

    // 이전 탭에서 벗어날 때 무거운 리소스 정리 및 GC 실행
    if (currentActiveTab && currentActiveTab !== targetTab) {
        teardownTab(currentActiveTab);
    }
    currentActiveTab = targetTab;

    const tabButtons = document.querySelectorAll('.tab-btn:not(.tab-dropdown-trigger)');
    const dropdownBtn = document.getElementById('viewer-diagram-tab-btn');
    const dropdownItems = document.querySelectorAll('.tab-dropdown-item');
    const tabPanes = document.querySelectorAll('.tab-pane');
    const mobileActiveText = document.getElementById('mobile-active-tab-text');

    // 1) 버튼 활성화 상태 변경
    tabButtons.forEach(b => b.classList.remove('active'));
    dropdownItems.forEach(item => item.classList.remove('active'));

    let activeIcon = '';
    let activeLabel = '';

    if (targetTab === 'csv' || targetTab === 'markdown' || targetTab === 'mermaid' || targetTab === 'emails') {
        if (dropdownBtn) dropdownBtn.classList.add('active');
        const activeItem = document.querySelector(`.tab-dropdown-item[data-tab="${targetTab}"]`);
        if (activeItem) activeItem.classList.add('active');

        if (targetTab === 'csv') {
            activeIcon = '📋';
            activeLabel = 'CSV 뷰어';
        } else if (targetTab === 'markdown') {
            activeIcon = '📝';
            activeLabel = 'Markdown 뷰어';
        } else if (targetTab === 'emails') {
            activeIcon = '📧';
            activeLabel = '이메일 아카이브';
        } else {
            activeIcon = '📊';
            activeLabel = '다이어그램';
        }

        const dropdownIconEl = document.getElementById('viewer-diagram-icon');
        const dropdownLabelEl = document.getElementById('viewer-diagram-label');
        if (dropdownIconEl) dropdownIconEl.textContent = activeIcon;
        if (dropdownLabelEl) dropdownLabelEl.textContent = activeLabel;
    } else {
        if (dropdownBtn) dropdownBtn.classList.remove('active');
        const targetBtn = document.querySelector(`.tab-btn[data-tab="${targetTab}"]`);
        if (targetBtn) {
            targetBtn.classList.add('active');
            activeIcon = targetBtn.querySelector('.tab-icon')?.textContent || '';
            activeLabel = targetBtn.querySelector('.tab-label')?.textContent || targetBtn.textContent.trim();
        }
    }

    // 2) 좁은 화면용 활성 탭 인디케이터 텍스트 갱신
    if (mobileActiveText && activeLabel) {
        mobileActiveText.innerHTML = `<span class="tab-icon">${activeIcon}</span> <span class="active-tab-name">${escapeHtml(activeLabel)}</span>`;
    }

    // 3) 탭 콘텐츠 표시 전환
    tabPanes.forEach(pane => {
        pane.classList.remove('active');
        if (pane.id === `tab-${targetTab}`) {
            pane.classList.add('active');
        }
    });

    // 4) 온디맨드 지연 로딩 수행 (해당 탭을 처음 열 때만 초기화)
    initTabOnDemand(targetTab);

    // 5) 백엔드 파일 및 로컬스토리지에 마지막 활성 탭 영구 저장
    saveAppSettingKey('active_tab_id', targetTab);

    // 6) 모바일 드롭다운 및 탭 드롭다운 메뉴 자동 닫기
    closeMobileNav();
    closeViewerDiagramDropdown();

    // 7) 다이어그램 탭 전환 시 뷰포트 맞춤 렌더링
    if (targetTab === 'mermaid' && typeof fitMermaidToViewport === 'function') {
        setTimeout(() => fitMermaidToViewport(), 50);
    }
}


// ==========================================
// 4. DOMContentLoaded 앱 초기화 (초경량 부팅)
// ==========================================
document.addEventListener('DOMContentLoaded', async () => {
    // 백엔드 app_settings.json 영구 설정 로드
    await loadAppSettings();

    // 탭 버튼 클릭 이벤트 바인딩
    const tabButtons = document.querySelectorAll('.tab-btn');
    tabButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            const targetTab = btn.getAttribute('data-tab');
            if (targetTab) {
                switchTab(targetTab);
            }
        });
    });

    // 드롭다운 및 햄버거 메뉴 바깥 영역 클릭 시 자동 닫기
    document.addEventListener('click', (e) => {
        const dropdown = document.getElementById('viewer-diagram-dropdown');
        if (dropdown && !dropdown.contains(e.target)) {
            closeViewerDiagramDropdown();
        }
        const nav = document.getElementById('main-tab-nav');
        if (nav && !nav.contains(e.target)) {
            closeMobileNav();
        }
    });

    // 공통 콘솔 높이 조절기 초기화
    initConsoleResizer();

    // 마지막으로 사용했던 탭 1개만 온디맨드 로드 (초기 램 500MB -> 40MB 대폭 감축)
    const savedTab = appSettings.active_tab_id || localStorage.getItem('active_tab_id') || 'system';
    switchTab(savedTab);
});

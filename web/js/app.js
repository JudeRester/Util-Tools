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
// 2. DOMContentLoaded 앱 초기화
// ==========================================
document.addEventListener('DOMContentLoaded', () => {
    // 탭 버튼 전환 이벤트
    const tabButtons = document.querySelectorAll('.tab-btn');
    const tabPanes = document.querySelectorAll('.tab-pane');

    tabButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            const targetTab = btn.getAttribute('data-tab');

            // 버튼 활성화 상태 변경
            tabButtons.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');

            // 탭 콘텐츠 표시 전환
            tabPanes.forEach(pane => {
                pane.classList.remove('active');
                if (pane.id === `tab-${targetTab}`) {
                    pane.classList.add('active');
                }
            });
        });
    });

    // 1) 폴더 바로가기 로드
    loadFolderShortcuts();

    // 2) 빠른 실행 항목 로드
    loadQuickLaunchItems();

    // 3) 콘솔 높이 드래그 조절기 초기화
    initConsoleResizer();

    // 4) JS 실행기(Playground) 초기화
    initJsPlayground();

    // 5) 빠른 메모(Notes) 로드
    loadNotes();
});

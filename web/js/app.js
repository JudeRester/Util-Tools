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
// 2. 반응형 모바일 햄버거 네비게이션 제어
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


// ==========================================
// 3. DOMContentLoaded 앱 초기화
// ==========================================
document.addEventListener('DOMContentLoaded', () => {
    // 탭 버튼 전환 이벤트
    const tabButtons = document.querySelectorAll('.tab-btn');
    const tabPanes = document.querySelectorAll('.tab-pane');
    const mobileActiveText = document.getElementById('mobile-active-tab-text');

    tabButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            const targetTab = btn.getAttribute('data-tab');

            // 버튼 활성화 상태 변경
            tabButtons.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');

            // 좁은 화면용 활성 탭 인디케이터 텍스트 갱신
            if (mobileActiveText) {
                const icon = btn.querySelector('.tab-icon')?.textContent || '';
                const label = btn.querySelector('.tab-label')?.textContent || btn.textContent.trim();
                mobileActiveText.innerHTML = `<span class="tab-icon">${icon}</span> <span class="active-tab-name">${escapeHtml(label)}</span>`;
            }

            // 탭 콘텐츠 표시 전환
            tabPanes.forEach(pane => {
                pane.classList.remove('active');
                if (pane.id === `tab-${targetTab}`) {
                    pane.classList.add('active');
                }
            });

            // 모바일 드롭다운 메뉴 자동 닫기
            closeMobileNav();
        });
    });

    // 햄버거 메뉴 바깥 영역 클릭 시 자동 닫기
    document.addEventListener('click', (e) => {
        const nav = document.getElementById('main-tab-nav');
        if (nav && !nav.contains(e.target)) {
            closeMobileNav();
        }
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

    // 6) 캘린더(Calendar) 로드
    initCalendar();
});

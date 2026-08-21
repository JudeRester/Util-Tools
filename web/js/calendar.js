/**
 * 구글 캘린더 및 iCal 일정 동기화 / 월간 달력 모듈
 */

let calendarEvents = [];
let calendarConfig = { ics_urls: [] };
let currentCalendarYear = new Date().getFullYear();
let currentCalendarMonth = new Date().getMonth(); // 0-indexed (0: 1월, 11: 12월)
let selectedDateStr = new Date().toISOString().slice(0, 10);
let editingCalendarUrlId = null;
let midnightTimer = null;
let periodicSyncInterval = null;

const DEFAULT_CALENDAR_CONFIG_FALLBACK = {
    "ics_urls": [
        {
            "id": "1",
            "name": "대한민국 공휴일",
            "url": "https://calendar.google.com/calendar/ical/ko.south_korea%23holiday%40group.v.calendar.google.com/public/basic.ics",
            "color": "#ef4444"
        }
    ],
    "auto_refresh_minutes": 30
};

// 1. 초기 로드
async function initCalendar() {
    initCalendarYearMonthSelect();
    initCalendarResizer();
    await loadCalendarConfig();
    renderCalendarUI();
    
    // 백그라운드 최초 1회 일정 동기화 실행
    syncCalendarEvents(false);

    // 자정(00:00) 자동 배치 동기화 및 주기적 백그라운드 동기화 스케줄링
    setupMidnightAndPeriodicSync();
}

// 연도 선택 드롭다운 옵션 초기화 (2020 ~ 2035)
function initCalendarYearMonthSelect() {
    const yearSelect = document.getElementById('cal-year-select');
    if (!yearSelect) return;

    yearSelect.innerHTML = '';
    const startYear = 2020;
    const endYear = 2035;
    for (let y = startYear; y <= endYear; y++) {
        const opt = document.createElement('option');
        opt.value = y;
        opt.textContent = `${y}년`;
        if (y === currentCalendarYear) opt.selected = true;
        yearSelect.appendChild(opt);
    }
}

// 좌우 스플리터(Resizer) 초기화 및 너비 드래그 제어
function initCalendarResizer() {
    const resizer = document.getElementById('calendar-resizer');
    const monthView = document.getElementById('calendar-month-view');
    const container = document.getElementById('calendar-main-grid');
    if (!resizer || !monthView || !container) return;

    // 저장된 좌측 너비 복원
    const savedWidth = (typeof appSettings !== 'undefined' && appSettings.calendar_month_width) || localStorage.getItem('calendar_month_width');
    if (savedWidth) {
        monthView.style.flex = 'none';
        monthView.style.width = `${savedWidth}px`;
    }

    let isDragging = false;
    let startX = 0;
    let startWidth = 0;

    resizer.addEventListener('mousedown', (e) => {
        isDragging = true;
        startX = e.clientX;
        startWidth = monthView.getBoundingClientRect().width;

        resizer.classList.add('dragging');
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';

        const onMouseMove = (moveEvent) => {
            if (!isDragging) return;
            const deltaX = moveEvent.clientX - startX;
            let newWidth = startWidth + deltaX;

            const containerWidth = container.getBoundingClientRect().width;
            const minWidth = 320;
            const maxWidth = containerWidth - 220; // 우측 일정 패널 최소 220px 확보

            if (newWidth < minWidth) newWidth = minWidth;
            if (newWidth > maxWidth) newWidth = maxWidth;

            monthView.style.flex = 'none';
            monthView.style.width = `${newWidth}px`;
        };

        const onMouseUp = () => {
            if (!isDragging) return;
            isDragging = false;
            resizer.classList.remove('dragging');
            document.body.style.cursor = '';
            document.body.style.userSelect = '';

            const finalWidth = Math.round(monthView.getBoundingClientRect().width);
            if (typeof saveAppSettingKey === 'function') {
                saveAppSettingKey('calendar_month_width', finalWidth);
            } else {
                localStorage.setItem('calendar_month_width', finalWidth);
            }

            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
        };

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
    });
}

// 매일 자정(00:00:05) 자동 배치 동기화 및 주기적 새로고침 등록
function setupMidnightAndPeriodicSync() {
    // 1) 자정 정각 배치 타이머 스케줄링
    scheduleNextMidnightSync();

    // 2) 주기적 백그라운드 동기화 (기본 30분)
    const refreshMinutes = calendarConfig.auto_refresh_minutes || 30;
    if (periodicSyncInterval) clearInterval(periodicSyncInterval);
    periodicSyncInterval = setInterval(() => {
        syncCalendarEvents(false);
    }, refreshMinutes * 60 * 1000);
}

function scheduleNextMidnightSync() {
    if (midnightTimer) clearTimeout(midnightTimer);

    const now = new Date();
    // 다음 날 00:00:05 (자정 5초 뒤)
    const nextMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 5);
    const msUntilMidnight = nextMidnight.getTime() - now.getTime();

    midnightTimer = setTimeout(async () => {
        const todayStr = new Date().toISOString().slice(0, 10);
        logToConsole('자정 배치 동기화', `${todayStr} 자정 자동 일정 동기화 및 오늘 날짜 갱신 완료.`);

        // 자정이 지나 날짜가 바뀌었으므로 달력과 일정 화면 자동 갱신
        selectedDateStr = todayStr;
        currentCalendarYear = new Date().getFullYear();
        currentCalendarMonth = new Date().getMonth();

        await syncCalendarEvents(true);
        renderCalendarUI();

        // 다음 날 자정을 위해 재귀 스케줄링
        scheduleNextMidnightSync();
    }, msUntilMidnight);
}

// 설정 불러오기
async function loadCalendarConfig() {
    try {
        if (window.eel && eel.get_calendar_config) {
            const res = await eel.get_calendar_config()();
            if (res.status === 'success' && res.data) {
                calendarConfig = res.data;
            } else {
                calendarConfig = DEFAULT_CALENDAR_CONFIG_FALLBACK;
            }
        } else {
            const saved = localStorage.getItem('user_calendar_config');
            calendarConfig = saved ? JSON.parse(saved) : DEFAULT_CALENDAR_CONFIG_FALLBACK;
        }
    } catch (e) {
        calendarConfig = DEFAULT_CALENDAR_CONFIG_FALLBACK;
    }
}

// 캘린더 일정 동기화 (iCal fetch)
async function syncCalendarEvents(force = false) {
    const syncStatusEl = document.getElementById('calendar-sync-time');
    if (syncStatusEl) {
        syncStatusEl.textContent = '⏳ 일정 동기화 중...';
        syncStatusEl.className = 'cal-sync-status syncing';
    }

    if (force) {
        logToConsole('캘린더 동기화 요청', '구독된 구글 캘린더 iCal 일정을 동기화하는 중입니다...');
    }

    try {
        if (window.eel && typeof eel.fetch_calendar_events === 'function') {
            const res = await eel.fetch_calendar_events(force)();
            if (res.status === 'success' || res.status === 'partial') {
                calendarEvents = res.events || [];
                const updatedTime = res.lastUpdated ? res.lastUpdated.slice(11) : '완료';
                if (syncStatusEl) {
                    syncStatusEl.textContent = `동기화: ${updatedTime} (${calendarEvents.length}개)`;
                    syncStatusEl.className = 'cal-sync-status';
                }

                // 캘린더별 통계 집계
                const calStats = {};
                calendarEvents.forEach(e => {
                    const cName = e.calendarName || '기타';
                    calStats[cName] = (calStats[cName] || 0) + 1;
                });

                logToConsole('캘린더 동기화 완료', {
                    총일정수: `${calendarEvents.length}개`,
                    캘린더별일정: calStats,
                    동기화시각: res.lastUpdated || new Date().toLocaleString(),
                    오류: res.errors && res.errors.length > 0 ? res.errors : '없음 (정상)'
                });
            } else {
                if (syncStatusEl) {
                    syncStatusEl.textContent = '⚠️ 동기화 실패';
                    syncStatusEl.className = 'cal-sync-status error';
                }
                logToConsole('캘린더 동기화 오류', res.message || '일정을 가져오지 못했습니다.');
            }
        } else {
            if (syncStatusEl) {
                syncStatusEl.textContent = '⚠️ 앱 재실행 필요';
                syncStatusEl.className = 'cal-sync-status error';
            }
            logToConsole('캘린더 동기화 실패 (앱 재실행 필요)', 
                '⚠️ Python 백엔드 서비스(calendar_service)가 아직 로드되지 않았습니다.\n' +
                '시스템 트레이(시계 옆)에서 앱을 우클릭하여 [종료]한 후, 다시 실행해 주세요.'
            );
        }
    } catch (err) {
        console.error("일정 동기화 오류:", err);
        if (syncStatusEl) {
            syncStatusEl.textContent = '⚠️ 연결 실패';
            syncStatusEl.className = 'cal-sync-status error';
        }
        logToConsole('캘린더 통신 예외 발생', err.message || String(err));
    }

    renderCalendarUI();
}

let disabledCalendarNames = new Set();

// 2. UI 렌더링 총괄
function renderCalendarUI() {
    renderCalendarHeader();
    renderCalendarFilterBar();
    renderCalendarMonthGrid();
    renderAgendaPanel();
    renderCalendarManageList();
}

// 구독 캘린더 실시간 필터 칩 바 렌더링
function renderCalendarFilterBar() {
    const chipsEl = document.getElementById('cal-filter-chips');
    if (!chipsEl) return;

    const urls = calendarConfig.ics_urls || [];
    if (urls.length === 0) {
        chipsEl.innerHTML = '<span style="color:var(--text-secondary); font-size:0.75rem;">(구독된 캘린더 없음)</span>';
        return;
    }

    // 캘린더 이름 목록 (중복 제거)
    const calList = [];
    urls.forEach(u => {
        const name = u.name || '캘린더';
        if (!calList.find(c => c.name === name)) {
            calList.push({ name, color: u.color || '#6366f1' });
        }
    });

    chipsEl.innerHTML = calList.map(cal => {
        const isDisabled = disabledCalendarNames.has(cal.name);
        const isActive = !isDisabled;
        return `
            <div class="cal-filter-chip ${isActive ? 'active' : 'disabled'}" onclick="toggleCalendarFilter('${escapeJsString(cal.name)}')" title="${isActive ? '클릭하여 이 캘린더 일정 숨기기' : '클릭하여 이 캘린더 일정 표시'}">
                <span class="cal-filter-dot" style="background: ${cal.color};"></span>
                <span>${escapeHtml(cal.name)}</span>
                <span style="font-size:0.65rem; margin-left:2px;">${isActive ? '✓' : '✕'}</span>
            </div>
        `;
    }).join('');
}

function toggleCalendarFilter(calName) {
    if (disabledCalendarNames.has(calName)) {
        disabledCalendarNames.delete(calName);
    } else {
        disabledCalendarNames.add(calName);
    }
    renderCalendarUI();
}

// 현재 활성화(필터링 통과)된 일정 목록 반환
function getVisibleCalendarEvents() {
    return calendarEvents.filter(e => !disabledCalendarNames.has(e.calendarName || '캘린더'));
}

// 헤더 년/월 드롭다운 값 동기화
function renderCalendarHeader() {
    const yearSelect = document.getElementById('cal-year-select');
    const monthSelect = document.getElementById('cal-month-select');
    if (yearSelect) yearSelect.value = currentCalendarYear;
    if (monthSelect) monthSelect.value = currentCalendarMonth;
}

function onCalendarYearChange(yearVal) {
    currentCalendarYear = parseInt(yearVal, 10);
    renderCalendarMonthGrid();
    renderAgendaPanel();
}

function onCalendarMonthChange(monthVal) {
    currentCalendarMonth = parseInt(monthVal, 10);
    renderCalendarMonthGrid();
    renderAgendaPanel();
}

// 월간 날짜 그리드 렌더링
function renderCalendarMonthGrid() {
    const gridEl = document.getElementById('calendar-days-grid');
    if (!gridEl) return;

    // 해당 월의 첫 날과 마지막 날 계산
    const firstDayIndex = new Date(currentCalendarYear, currentCalendarMonth, 1).getDay(); // 0(일) ~ 6(토)
    const lastDate = new Date(currentCalendarYear, currentCalendarMonth + 1, 0).getDate();
    const prevMonthLastDate = new Date(currentCalendarYear, currentCalendarMonth, 0).getDate();

    const todayStr = new Date().toISOString().slice(0, 10);
    let html = '';

    // 1) 이전 달 날짜들 (비활성 셀)
    for (let i = firstDayIndex - 1; i >= 0; i--) {
        const dateNum = prevMonthLastDate - i;
        const prevMonth = currentCalendarMonth === 0 ? 11 : currentCalendarMonth - 1;
        const prevYear = currentCalendarMonth === 0 ? currentCalendarYear - 1 : currentCalendarYear;
        const dateStr = `${prevYear}-${String(prevMonth + 1).padStart(2, '0')}-${String(dateNum).padStart(2, '0')}`;

        html += `
            <div class="calendar-day-cell other-month" onclick="selectCalendarDate('${dateStr}')">
                <div class="day-number">${dateNum}</div>
                <div class="day-events">${renderDayEventBadges(dateStr)}</div>
            </div>
        `;
    }

    // 2) 현재 달 날짜들
    for (let dateNum = 1; dateNum <= lastDate; dateNum++) {
        const dateStr = `${currentCalendarYear}-${String(currentCalendarMonth + 1).padStart(2, '0')}-${String(dateNum).padStart(2, '0')}`;
        const isToday = dateStr === todayStr;
        const isSelected = dateStr === selectedDateStr;
        const dayOfWeek = new Date(currentCalendarYear, currentCalendarMonth, dateNum).getDay();
        const isWeekend = dayOfWeek === 0 ? 'sun' : (dayOfWeek === 6 ? 'sat' : '');

        html += `
            <div class="calendar-day-cell ${isToday ? 'today' : ''} ${isSelected ? 'selected' : ''} ${isWeekend}" onclick="selectCalendarDate('${dateStr}')">
                <div class="day-number">
                    <span>${dateNum}</span>
                    ${isToday ? '<span class="today-tag">오늘</span>' : ''}
                </div>
                <div class="day-events">${renderDayEventBadges(dateStr)}</div>
            </div>
        `;
    }

    // 3) 다음 달 날짜들 (그리드 빈칸 채우기, 35칸 또는 42칸 맞춤)
    const totalCells = firstDayIndex + lastDate;
    const nextMonthDays = (totalCells > 35 ? 42 : 35) - totalCells;

    for (let dateNum = 1; dateNum <= nextMonthDays; dateNum++) {
        const nextMonth = currentCalendarMonth === 11 ? 0 : currentCalendarMonth + 1;
        const nextYear = currentCalendarMonth === 11 ? currentCalendarYear + 1 : currentCalendarYear;
        const dateStr = `${nextYear}-${String(nextMonth + 1).padStart(2, '0')}-${String(dateNum).padStart(2, '0')}`;

        html += `
            <div class="calendar-day-cell other-month" onclick="selectCalendarDate('${dateStr}')">
                <div class="day-number">${dateNum}</div>
                <div class="day-events">${renderDayEventBadges(dateStr)}</div>
            </div>
        `;
    }

    gridEl.innerHTML = html;
}

// 날짜 셀 안의 이벤트 뱃지들 렌더링
function renderDayEventBadges(dateStr) {
    const visibleEvents = getVisibleCalendarEvents();
    const dayEvents = visibleEvents.filter(e => {
        const start = e.startDate;
        const end = e.endDate || e.startDate;
        return dateStr >= start && dateStr <= end;
    });

    if (dayEvents.length === 0) return '';

    const maxDisplay = 2;
    const displayEvents = dayEvents.slice(0, maxDisplay);
    const extraCount = dayEvents.length - maxDisplay;

    let badgesHtml = displayEvents.map(e => `
        <div class="event-badge" style="border-left-color: ${e.color || '#6366f1'};" title="${escapeHtml(e.title)} (${e.startTime || '하루 종일'})">
            <span class="event-badge-title">${escapeHtml(e.title)}</span>
        </div>
    `).join('');

    if (extraCount > 0) {
        badgesHtml += `<div class="event-badge-more">+${extraCount}개 더보기</div>`;
    }

    return badgesHtml;
}

// 날짜 선택
function selectCalendarDate(dateStr) {
    selectedDateStr = dateStr;
    const [y, m, d] = dateStr.split('-').map(Number);
    if (y !== currentCalendarYear || m - 1 !== currentCalendarMonth) {
        currentCalendarYear = y;
        currentCalendarMonth = m - 1;
        renderCalendarHeader();
    }
    renderCalendarMonthGrid();
    renderAgendaPanel();
}

// 우측 일정 상세(Agenda) 렌더링
function renderAgendaPanel() {
    const titleEl = document.getElementById('agenda-date-title');
    const listEl = document.getElementById('agenda-events-list');
    if (!titleEl || !listEl) return;

    const [y, m, d] = selectedDateStr.split('-').map(Number);
    const dateObj = new Date(y, m - 1, d);
    const weekNames = ['일', '월', '화', '수', '목', '금', '토'];
    const weekName = weekNames[dateObj.getDay()];

    titleEl.innerHTML = `📌 <b>${selectedDateStr} (${weekName})</b> 일정`;

    const visibleEvents = getVisibleCalendarEvents();
    const dayEvents = visibleEvents.filter(e => {
        const start = e.startDate;
        const end = e.endDate || e.startDate;
        return selectedDateStr >= start && selectedDateStr <= end;
    });

    if (dayEvents.length === 0) {
        listEl.innerHTML = `
            <div class="agenda-empty">
                <div class="empty-icon">☕</div>
                <p>등록된 일정이 없습니다.</p>
                <span class="empty-sub">여유로운 하루를 보내세요!</span>
            </div>
        `;
    } else {
        listEl.innerHTML = dayEvents.map(e => `
            <div class="agenda-card" style="border-left-color: ${e.color || '#6366f1'};">
                <div class="agenda-card-header">
                    <span class="agenda-cal-name" style="background: ${e.color || '#6366f1'}22; color: ${e.color || '#6366f1'};">
                        ${escapeHtml(e.calendarName || '캘린더')}
                    </span>
                    <span class="agenda-time">${e.allDay ? '하루 종일' : `${e.startTime || ''} ~ ${e.endTime || ''}`}</span>
                </div>
                <div class="agenda-title">${escapeHtml(e.title)}</div>
                ${e.location ? `<div class="agenda-location">📍 ${escapeHtml(e.location)}</div>` : ''}
                ${e.description ? `<div class="agenda-desc">${escapeHtml(e.description)}</div>` : ''}
            </div>
        `).join('');
    }
}

// 월 이동
function changeCalendarMonth(delta) {
    currentCalendarMonth += delta;
    if (currentCalendarMonth < 0) {
        currentCalendarMonth = 11;
        currentCalendarYear -= 1;
    } else if (currentCalendarMonth > 11) {
        currentCalendarMonth = 0;
        currentCalendarYear += 1;
    }
    renderCalendarHeader();
    renderCalendarMonthGrid();
}

// 오늘로 이동
function goToCalendarToday() {
    const today = new Date();
    currentCalendarYear = today.getFullYear();
    currentCalendarMonth = today.getMonth();
    selectedDateStr = today.toISOString().slice(0, 10);
    renderCalendarUI();
}

// 3. 캘린더 구독 설정 모달 관련 로직 (Write-Back Draft 버퍼링 방식)
let draftCalendarConfig = null;

function openCalendarModal() {
    draftCalendarConfig = JSON.parse(JSON.stringify(calendarConfig));
    cancelEditCalendarUrl();
    renderCalendarManageList();
    document.getElementById('calendar-modal').classList.add('show');
}

function closeCalendarModal() {
    cancelEditCalendarUrl();
    draftCalendarConfig = null;
    document.getElementById('calendar-modal').classList.remove('show');
}

function renderCalendarManageList() {
    const cfg = draftCalendarConfig || calendarConfig;
    const countBadge = document.getElementById('cal-count-badge');
    const urls = cfg.ics_urls || [];
    if (countBadge) countBadge.textContent = urls.length;

    const listEl = document.getElementById('cal-manage-list');
    if (!listEl) return;

    if (urls.length === 0) {
        listEl.innerHTML = '<div style="color:var(--text-secondary); text-align:center; padding:15px; font-size:0.85rem;">구독 중인 캘린더가 없습니다.</div>';
    } else {
        listEl.innerHTML = urls.map((item, idx) => `
            <div class="manage-item ${editingCalendarUrlId === item.id ? 'editing' : ''}">
                <div class="manage-item-info">
                    <div class="manage-item-name">
                        <span style="display:inline-block; width:10px; height:10px; border-radius:50%; background:${item.color || '#6366f1'}; margin-right:6px;"></span>
                        ${escapeHtml(item.name)}
                    </div>
                    <div class="manage-item-path" title="${escapeHtml(item.url)}">${escapeHtml(item.url)}</div>
                </div>
                <div class="manage-item-actions">
                    <button type="button" class="item-edit-btn" onclick="startEditCalendarUrl('${item.id}')" title="수정">✏️</button>
                    <button type="button" class="item-delete-btn" onclick="deleteCalendarUrl('${item.id}')" title="삭제">삭제</button>
                </div>
            </div>
        `).join('');
    }
}

function startEditCalendarUrl(id) {
    const cfg = draftCalendarConfig || calendarConfig;
    const urls = cfg.ics_urls || [];
    const item = urls.find(u => u.id === id);
    if (!item) return;

    editingCalendarUrlId = id;
    document.getElementById('new-cal-name').value = item.name || '';
    document.getElementById('new-cal-color').value = item.color || '#ef4444';
    document.getElementById('new-cal-url').value = item.url || '';

    document.getElementById('cal-form-title').textContent = `✏️ '${item.name}' 캘린더 수정`;
    const submitBtn = document.getElementById('cal-submit-btn');
    submitBtn.textContent = '💾 수정 완료';
    submitBtn.className = 'form-btn add-btn';

    document.getElementById('cal-cancel-btn').style.display = 'inline-block';
    document.getElementById('new-cal-name').focus();
    renderCalendarManageList();
}

function cancelEditCalendarUrl() {
    editingCalendarUrlId = null;
    document.getElementById('new-cal-name').value = '';
    document.getElementById('new-cal-color').value = '#ef4444';
    document.getElementById('new-cal-url').value = '';

    const titleEl = document.getElementById('cal-form-title');
    if (titleEl) titleEl.textContent = '➕ 새로운 캘린더 구독 추가';

    const submitBtn = document.getElementById('cal-submit-btn');
    if (submitBtn) submitBtn.textContent = '추가';

    const cancelBtn = document.getElementById('cal-cancel-btn');
    if (cancelBtn) cancelBtn.style.display = 'none';

    renderCalendarManageList();
}

function normalizeCalendarUrl(url) {
    url = (url || '').trim();
    if (!url) return '';

    if (url.startsWith('webcal://')) {
        url = 'https://' + url.slice(9);
    }

    if (url.includes('calendar.google.com') && !url.endsWith('.ics')) {
        try {
            const urlObj = new URL(url);
            let cid = urlObj.searchParams.get('cid') || urlObj.searchParams.get('src');
            if (cid) {
                if (!cid.includes('@')) {
                    try {
                        const decoded = atob(cid);
                        if (decoded.includes('@')) {
                            cid = decoded;
                        }
                    } catch (e) {}
                }
                return `https://calendar.google.com/calendar/ical/${encodeURIComponent(cid)}/public/basic.ics`;
            }
        } catch (e) {}
    }

    return url;
}

// 새 캘린더 추가/수정 (Draft에만 반영)
async function addNewCalendarUrl() {
    const name = document.getElementById('new-cal-name').value.trim();
    const color = document.getElementById('new-cal-color').value;
    const rawUrl = document.getElementById('new-cal-url').value.trim();

    if (!name || !rawUrl) {
        await showAppAlert('캘린더 이름과 구글 캘린더 주소를 모두 입력해 주세요.', '입력 필요', '⚠️');
        return;
    }

    const url = normalizeCalendarUrl(rawUrl);

    if (!draftCalendarConfig) {
        draftCalendarConfig = JSON.parse(JSON.stringify(calendarConfig));
    }
    if (!draftCalendarConfig.ics_urls) {
        draftCalendarConfig.ics_urls = [];
    }

    if (editingCalendarUrlId !== null) {
        // 수정 모드
        const target = draftCalendarConfig.ics_urls.find(u => u.id === editingCalendarUrlId);
        if (target) {
            target.name = name;
            target.color = color;
            target.url = url;
        }
        cancelEditCalendarUrl();
    } else {
        // 신규 추가 모드
        const newItem = {
            id: Date.now().toString(),
            name,
            color,
            url
        };
        draftCalendarConfig.ics_urls.push(newItem);
        cancelEditCalendarUrl();
    }

    renderCalendarManageList();
}

// 캘린더 삭제 (Draft에서만 제거)
async function deleteCalendarUrl(id) {
    if (!draftCalendarConfig) {
        draftCalendarConfig = JSON.parse(JSON.stringify(calendarConfig));
    }
    const item = (draftCalendarConfig.ics_urls || []).find(u => u.id === id);
    const confirmed = await showAppConfirm(`'${item ? item.name : '선택한'}' 캘린더 구독을 삭제하시겠습니까?\n(하단의 [💾 변경사항 저장]을 눌러야 최종 반영됩니다)`, {
        title: '캘린더 삭제',
        icon: '🗑️',
        confirmText: '삭제',
        isDanger: true
    });
    if (confirmed) {
        if (editingCalendarUrlId === id) {
            cancelEditCalendarUrl();
        }
        draftCalendarConfig.ics_urls = (draftCalendarConfig.ics_urls || []).filter(u => u.id !== id);
        renderCalendarManageList();
    }
}

// 기본값 복원 (Draft에만 적용)
async function resetDefaultCalendarConfig() {
    const confirmed = await showAppConfirm('캘린더 설정을 기본값(대한민국 공휴일)으로 되돌리시겠습니까?\n(하단의 [💾 변경사항 저장]을 눌러야 최종 반영됩니다)', {
        title: '기본값 복원',
        icon: '🔄',
        confirmText: '복원',
        isDanger: true
    });
    if (confirmed) {
        cancelEditCalendarUrl();
        draftCalendarConfig = JSON.parse(JSON.stringify(DEFAULT_CALENDAR_CONFIG_FALLBACK));
        renderCalendarManageList();
    }
}

// Write-Back 최종 영구 저장
async function saveCalendarManageChanges() {
    if (draftCalendarConfig) {
        calendarConfig = JSON.parse(JSON.stringify(draftCalendarConfig));
    }
    await saveCalendarConfigLocally();
    syncCalendarEvents(true);
    closeCalendarModal();

    logToConsole('캘린더 설정 변경사항 저장 완료', `총 ${(calendarConfig.ics_urls || []).length}개의 캘린더 구독 설정이 안전하게 저장되었습니다.`);
}

async function saveCalendarConfigLocally() {
    try {
        localStorage.setItem('user_calendar_config', JSON.stringify(calendarConfig));
        if (window.eel && eel.save_calendar_config) {
            await eel.save_calendar_config(calendarConfig)();
        }
    } catch (e) {
        console.error("캘린더 설정 저장 실패:", e);
    }
}

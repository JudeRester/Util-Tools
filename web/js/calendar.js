/**
 * 구글 캘린더 및 iCal 일정 동기화 / 월간 달력 모듈
 */

let calendarEvents = [];
let calendarConfig = { ics_urls: [] };
let currentCalendarYear = new Date().getFullYear();
let currentCalendarMonth = new Date().getMonth(); // 0-indexed (0: 1월, 11: 12월)
let selectedDateStr = new Date().toISOString().slice(0, 10);
let editingCalendarUrlId = null;

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
    await loadCalendarConfig();
    renderCalendarUI();
    // 백그라운드 일정 동기화 실행
    syncCalendarEvents(false);
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

    try {
        if (window.eel && eel.fetch_calendar_events) {
            const res = await eel.fetch_calendar_events(force)();
            if (res.status === 'success' || res.status === 'partial') {
                calendarEvents = res.events || [];
                if (syncStatusEl) {
                    syncStatusEl.textContent = `동기화: ${res.lastUpdated ? res.lastUpdated.slice(11) : '완료'} (${calendarEvents.length}개)`;
                    syncStatusEl.className = 'cal-sync-status';
                }
                logToConsole('캘린더 동기화 완료', {
                    가져온일정수: calendarEvents.length,
                    구독캘린더수: (calendarConfig.ics_urls || []).length,
                    오류: res.errors && res.errors.length > 0 ? res.errors : '없음'
                });
            } else {
                if (syncStatusEl) {
                    syncStatusEl.textContent = '⚠️ 동기화 실패';
                    syncStatusEl.className = 'cal-sync-status error';
                }
                logToConsole('캘린더 동기화 오류', res.message);
            }
        } else {
            if (syncStatusEl) {
                syncStatusEl.textContent = '로컬 모드';
                syncStatusEl.className = 'cal-sync-status';
            }
        }
    } catch (err) {
        console.error("일정 동기화 오류:", err);
        if (syncStatusEl) {
            syncStatusEl.textContent = '⚠️ 연결 실패';
            syncStatusEl.className = 'cal-sync-status error';
        }
    }

    renderCalendarUI();
}

// 2. UI 렌더링 총괄
function renderCalendarUI() {
    renderCalendarHeader();
    renderCalendarMonthGrid();
    renderAgendaPanel();
    renderCalendarManageList();
}

// 헤더 년/월 표시
function renderCalendarHeader() {
    const titleEl = document.getElementById('calendar-month-year-title');
    if (titleEl) {
        titleEl.textContent = `${currentCalendarYear}년 ${currentCalendarMonth + 1}월`;
    }
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
    const dayEvents = calendarEvents.filter(e => {
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

    const dayEvents = calendarEvents.filter(e => {
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

// 3. 캘린더 구독 설정 모달 관련 로직
function openCalendarModal() {
    cancelEditCalendarUrl();
    renderCalendarManageList();
    document.getElementById('calendar-modal').classList.add('show');
}

function closeCalendarModal() {
    cancelEditCalendarUrl();
    document.getElementById('calendar-modal').classList.remove('show');
}

function renderCalendarManageList() {
    const countBadge = document.getElementById('cal-count-badge');
    const urls = calendarConfig.ics_urls || [];
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
    const urls = calendarConfig.ics_urls || [];
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

async function addNewCalendarUrl() {
    const name = document.getElementById('new-cal-name').value.trim();
    const color = document.getElementById('new-cal-color').value;
    const url = document.getElementById('new-cal-url').value.trim();

    if (!name || !url) {
        alert('캘린더 이름과 iCal 주소를 모두 입력해 주세요.');
        return;
    }

    if (!calendarConfig.ics_urls) {
        calendarConfig.ics_urls = [];
    }

    if (editingCalendarUrlId !== null) {
        // 수정 모드
        const target = calendarConfig.ics_urls.find(u => u.id === editingCalendarUrlId);
        if (target) {
            target.name = name;
            target.color = color;
            target.url = url;
            logToConsole('캘린더 수정 완료', `[${name}] ${url}`);
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
        calendarConfig.ics_urls.push(newItem);
        document.getElementById('new-cal-name').value = '';
        document.getElementById('new-cal-url').value = '';
        logToConsole('캘린더 추가 완료', `[${name}] ${url}`);
    }

    await saveCalendarConfigLocally();
    renderCalendarManageList();
    // 새 캘린더 추가/수정 후 즉시 일정 동기화
    syncCalendarEvents(true);
}

async function deleteCalendarUrl(id) {
    if (confirm('이 캘린더 구독을 삭제하시겠습니까?')) {
        if (editingCalendarUrlId === id) {
            cancelEditCalendarUrl();
        }
        calendarConfig.ics_urls = (calendarConfig.ics_urls || []).filter(u => u.id !== id);
        await saveCalendarConfigLocally();
        renderCalendarManageList();
        syncCalendarEvents(true);
        logToConsole('캘린더 삭제', `ID: ${id}`);
    }
}

async function resetDefaultCalendarConfig() {
    if (confirm('캘린더 설정을 기본값(대한민국 공휴일)으로 복원하시겠습니까?')) {
        cancelEditCalendarUrl();
        calendarConfig = JSON.parse(JSON.stringify(DEFAULT_CALENDAR_CONFIG_FALLBACK));
        await saveCalendarConfigLocally();
        renderCalendarManageList();
        syncCalendarEvents(true);
        logToConsole('캘린더 초기화', '기본값으로 복원되었습니다.');
    }
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

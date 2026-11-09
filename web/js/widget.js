/**
 * web/js/widget.js
 * Util-Tools pywebview Quick Widget Client Interaction Controller
 * - 250ms Hover Dwell 타이머 기반 자연스러운 확장
 * - mousedown 즉시 호버 타이머 취소 및 드래그 제스처 중재
 * - 400ms MouseLeave 자동 축소 및 핀(Pin) 고정 지원
 * - Eel RPC 연동: 빠른 실행 목록 조회/실행, 실시간 시스템 메트릭, 퀵 메모
 */

(function () {
    'use strict';

    // State
    let isPinned = false;
    let isModalOpen = false;
    let dwellTimer = null;
    let collapseTimer = null;
    let dragOccurred = false;
    let pointerDownPos = { x: 0, y: 0 };
    let sysMetricInterval = null;

    // DOM Elements
    const body = document.body;
    const edgeHandle = document.getElementById('edge-handle');
    const widgetPanel = document.getElementById('widget-panel');
    const btnSizeMenu = document.getElementById('btn-size-menu');
    const sizeMenuDropdown = document.getElementById('size-menu-dropdown');
    const sizeOptBtns = document.querySelectorAll('.size-opt-btn');
    const btnPin = document.getElementById('btn-pin');
    const btnOpenMain = document.getElementById('btn-open-main');
    const btnCollapse = document.getElementById('btn-collapse');
    const tabBtns = document.querySelectorAll('.wtab-btn');
    const tabContents = document.querySelectorAll('.wtab-content');
    const quickLaunchList = document.getElementById('quick-launch-list');
    const btnRefreshLaunch = document.getElementById('btn-refresh-launch');
    const memoInput = document.getElementById('widget-memo-input');
    const memoStatus = document.getElementById('memo-status');
    const btnRefreshSys = document.getElementById('btn-refresh-sys');
    const btnWidgetRestart = document.getElementById('btn-widget-restart');
    const btnWidgetShutdown = document.getElementById('btn-widget-shutdown');
    const modalOverlay = document.getElementById('widget-modal-overlay');
    const modalIcon = document.getElementById('widget-modal-icon');
    const modalTitle = document.getElementById('widget-modal-title');
    const modalMsg = document.getElementById('widget-modal-msg');
    const modalBtnCancel = document.getElementById('widget-modal-btn-cancel');
    const modalBtnConfirm = document.getElementById('widget-modal-btn-confirm');

    function isCollapsed() {
        return body.classList.contains('state-collapsed');
    }

    // =========================================================================
    // 1. Python Bridge Global Callbacks
    // =========================================================================

    window.onWidgetStateChanged = function (state) {
        if (state === 'EXPANDED') {
            body.classList.remove('state-collapsed');
            body.classList.add('state-expanded');
            onExpanded();
        } else if (state === 'COLLAPSED') {
            body.classList.remove('state-expanded');
            body.classList.add('state-collapsed');
            onCollapsed();
        }
    };

    window.onEdgeChanged = function (edge) {
        if (edge === 'left') {
            body.classList.remove('edge-right');
            body.classList.add('edge-left');
        } else {
            body.classList.remove('edge-left');
            body.classList.add('edge-right');
        }
    };

    window.onHandleSizeChanged = function (sizeKey) {
        body.setAttribute('data-handle-size', sizeKey);
        sizeOptBtns.forEach((btn) => {
            btn.classList.toggle('active', btn.getAttribute('data-size') === sizeKey);
        });
    };

    // =========================================================================
    // 2. Hover Dwell & Gesture Mediation
    // =========================================================================

    let isPointerDown = false;
    let dragCooldown = false;
    let dragCooldownTimer = null;

    function isMouseButtonActive(e) {
        if (isPointerDown) return true;
        if (e && typeof e.buttons === 'number' && e.buttons !== 0) return true;
        return false;
    }

    function cancelDwell() {
        if (dwellTimer) {
            clearTimeout(dwellTimer);
            dwellTimer = null;
        }
    }

    function cancelDragCooldown() {
        if (dragCooldownTimer) {
            clearTimeout(dragCooldownTimer);
            dragCooldownTimer = null;
        }
        dragCooldown = false;
    }

    if (edgeHandle) {
        // Hover Dwell (250ms)
        const startDwell = (e) => {
            // 1. 마우스 다운 중이거나 드래그 쿨다운 상태면 호버 확장 원천 차단
            if (isMouseButtonActive(e) || dragCooldown) {
                cancelDwell();
                return;
            }

            // 2. 축소 상태이며 이미 대기 중인 타이머가 없는 경우에만 Dwell 개시
            if (isCollapsed() && !dwellTimer) {
                dwellTimer = setTimeout(() => {
                    dwellTimer = null;
                    // 3. 만료 시점 2중 방어 (마우스 다운, 드래그 쿨다운, 또는 드래그 발생 시 확장 취소)
                    if (isPointerDown || dragCooldown || dragOccurred) return;
                    expandWidget();
                }, 250);
            }
        };

        edgeHandle.addEventListener('mouseenter', startDwell);
        edgeHandle.addEventListener('mouseover', startDwell);

        edgeHandle.addEventListener('mouseleave', () => {
            cancelDwell();
            cancelDragCooldown();
        });

        // Mousedown (드래그 제스처 시작 시 모든 대기 호버 확장 즉시 취소)
        const onPointerDown = (e) => {
            cancelDwell();
            cancelDragCooldown();
            isPointerDown = true;
            pointerDownPos = { x: e.screenX, y: e.screenY };
            dragOccurred = false;
        };

        edgeHandle.addEventListener('mousedown', onPointerDown);
        window.addEventListener('mousedown', (e) => {
            // 창 내부 어디서든 마우스가 눌리면 호버 타이머 즉시 취소
            cancelDwell();
            if (e.target === edgeHandle || edgeHandle.contains(e.target)) {
                onPointerDown(e);
            }
        });

        window.addEventListener('mousemove', (e) => {
            // 마우스 버튼 릴리즈 동기화 (창 밖에서 업이 발생한 경우 대비)
            if (e.buttons === 0 && isPointerDown) {
                isPointerDown = false;
            }

            if (isPointerDown) {
                // 마우스가 눌려있는 동안 발생하는 모든 호버 확장 억제
                cancelDwell();

                if (Math.abs(e.screenX - pointerDownPos.x) > 6 || Math.abs(e.screenY - pointerDownPos.y) > 6) {
                    dragOccurred = true;
                }
            }
        });

        window.addEventListener('mouseup', (e) => {
            cancelDwell();
            isPointerDown = false;

            if (dragOccurred) {
                // 드래그 완료 후 손을 뗀 직후(mouseup) 400ms 동안 의도치 않은 자동 호버 팝업 억제
                dragCooldown = true;
                if (dragCooldownTimer) clearTimeout(dragCooldownTimer);
                dragCooldownTimer = setTimeout(() => {
                    dragCooldown = false;
                    dragCooldownTimer = null;
                }, 400);
            }
        });

        // 클릭 토글 (드래그하지 않고 클릭했을 때 즉시 확장)
        edgeHandle.addEventListener('click', (e) => {
            cancelDwell();
            if (dragOccurred) {
                dragOccurred = false;
                return;
            }
            expandWidget();
        });
    }


    // Auto-collapse on MouseLeave (400ms delay if not pinned and modal not open)
    if (widgetPanel) {
        widgetPanel.addEventListener('mouseleave', () => {
            if (!isPinned && !isCollapsed() && !isModalOpen) {
                collapseTimer = setTimeout(() => {
                    if (!isModalOpen) {
                        collapseWidget();
                    }
                }, 400);
            }
        });

        widgetPanel.addEventListener('mouseenter', () => {
            if (collapseTimer) {
                clearTimeout(collapseTimer);
                collapseTimer = null;
            }
        });
    }

    function expandWidget() {
        if (window.pywebview && window.pywebview.api) {
            window.pywebview.api.expand();
        } else {
            window.onWidgetStateChanged('EXPANDED');
        }
    }

    function collapseWidget() {
        if (window.pywebview && window.pywebview.api) {
            window.pywebview.api.collapse();
        } else {
            window.onWidgetStateChanged('COLLAPSED');
        }
    }

    // =========================================================================
    // 3. Header Controls
    // =========================================================================

    if (btnSizeMenu && sizeMenuDropdown) {
        btnSizeMenu.addEventListener('click', (e) => {
            e.stopPropagation();
            sizeMenuDropdown.classList.toggle('open');
        });

        document.addEventListener('click', (e) => {
            if (!sizeMenuDropdown.contains(e.target) && e.target !== btnSizeMenu) {
                sizeMenuDropdown.classList.remove('open');
            }
        });

        sizeOptBtns.forEach((btn) => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const sizeKey = btn.getAttribute('data-size');
                if (sizeKey) {
                    window.onHandleSizeChanged(sizeKey);
                    if (window.pywebview && window.pywebview.api && window.pywebview.api.set_handle_size) {
                        try {
                            await window.pywebview.api.set_handle_size(sizeKey);
                        } catch (err) {
                            console.error('Failed to set handle size:', err);
                        }
                    }
                }
                sizeMenuDropdown.classList.remove('open');
            });
        });
    }

    if (btnPin) {
        btnPin.addEventListener('click', () => {
            isPinned = !isPinned;
            btnPin.classList.toggle('active', isPinned);
            if (collapseTimer) {
                clearTimeout(collapseTimer);
                collapseTimer = null;
            }
        });
    }

    if (btnOpenMain) {
        btnOpenMain.addEventListener('click', async () => {
            if (window.eel && window.eel.open_main_window) {
                try {
                    await window.eel.open_main_window()();
                } catch (e) {
                    console.error('Failed to open main window:', e);
                }
            }
            collapseWidget();
        });
    }

    if (btnCollapse) {
        btnCollapse.addEventListener('click', () => {
            collapseWidget();
        });
    }

    // =========================================================================
    // 4. Tabs Navigation
    // =========================================================================

    tabBtns.forEach((btn) => {
        btn.addEventListener('click', () => {
            const targetTab = btn.getAttribute('data-tab');
            tabBtns.forEach((b) => b.classList.remove('active'));
            tabContents.forEach((c) => c.classList.remove('active'));

            btn.classList.add('active');
            const content = document.getElementById(`wtab-${targetTab}`);
            if (content) content.classList.add('active');

            if (targetTab === 'launch') loadQuickLaunchItems();
            if (targetTab === 'system') updateSystemMetrics();
            if (targetTab === 'stock') loadStockDashboard();
        });
    });

    // =========================================================================
    // 5. Tab Content: Quick Launch
    // =========================================================================

    async function loadQuickLaunchItems() {
        if (!window.eel || !window.eel.get_quick_launch_items) return;
        try {
            const res = await window.eel.get_quick_launch_items()();
            if (res && res.status === 'success' && Array.isArray(res.data)) {
                renderQuickLaunchItems(res.data);
            }
        } catch (e) {
            console.error('Failed to load quick launch items:', e);
        }
    }

    function renderQuickLaunchItems(items) {
        if (!quickLaunchList) return;
        quickLaunchList.innerHTML = '';

        if (!items || items.length === 0) {
            quickLaunchList.innerHTML = '<div class="launch-empty">등록된 빠른 실행 항목이 없습니다.</div>';
            return;
        }

        items.forEach((item) => {
            const card = document.createElement('div');
            card.className = 'launch-item-card';
            card.title = item.description || item.command || item.name;

            const iconSpan = document.createElement('span');
            iconSpan.className = 'launch-item-icon';
            iconSpan.textContent = item.icon || '⚡';

            const nameSpan = document.createElement('span');
            nameSpan.className = 'launch-item-name';
            nameSpan.textContent = item.name || item.title || '앱';

            card.appendChild(iconSpan);
            card.appendChild(nameSpan);

            card.addEventListener('click', async (e) => {
                e.stopPropagation();
                if (window.eel && window.eel.execute_quick_launch_item) {
                    try {
                        await window.eel.execute_quick_launch_item(item)();
                    } catch (err) {
                        console.error('Launch failed:', err);
                    }
                }
            });

            quickLaunchList.appendChild(card);
        });
    }

    if (btnRefreshLaunch) {
        btnRefreshLaunch.addEventListener('click', () => {
            loadQuickLaunchItems();
        });
    }

    // =========================================================================
    // 6. Tab Content: Quick Memo
    // =========================================================================

    const MEMO_STORAGE_KEY = 'utiltools_widget_quick_memo';
    let memoSaveTimer = null;

    function initMemo() {
        if (!memoInput) return;
        const saved = localStorage.getItem(MEMO_STORAGE_KEY) || '';
        memoInput.value = saved;

        memoInput.addEventListener('input', () => {
            if (memoStatus) memoStatus.textContent = '저장 중...';
            if (memoSaveTimer) clearTimeout(memoSaveTimer);
            memoSaveTimer = setTimeout(() => {
                localStorage.setItem(MEMO_STORAGE_KEY, memoInput.value);
                if (memoStatus) memoStatus.textContent = '자동 저장됨';
            }, 300);
        });
    }

    // =========================================================================
    // 7. Tab Content: System Metrics
    // =========================================================================

    async function updateSystemMetrics() {
        if (!window.eel || !window.eel.get_system_metrics) return;
        try {
            const res = await window.eel.get_system_metrics()();
            if (res && res.status === 'success' && res.data) {
                const d = res.data;
                const cpuVal = document.getElementById('metric-cpu-val');
                const cpuBar = document.getElementById('metric-cpu-bar');
                const memVal = document.getElementById('metric-mem-val');
                const memBar = document.getElementById('metric-mem-bar');
                const powerVal = document.getElementById('metric-power-val');

                if (cpuVal && cpuBar) {
                    const cpu = Math.round(d.cpu_percent || 0);
                    cpuVal.textContent = `${cpu}%`;
                    cpuBar.style.width = `${cpu}%`;
                }
                if (memVal && memBar) {
                    const mem = Math.round(d.memory_percent || 0);
                    memVal.textContent = `${mem}%`;
                    memBar.style.width = `${mem}%`;
                }
                if (powerVal) {
                    powerVal.textContent = d.power_status || '정상 (AC 전원)';
                }
            }
        } catch (e) {
            console.error('Failed to get system metrics:', e);
        }
    }

    function onExpanded() {
        loadQuickLaunchItems();
        updateSystemMetrics();
        const stockTab = document.getElementById('wtab-stock');
        if (stockTab && stockTab.classList.contains('active')) {
            loadStockDashboard();
        }
        if (!sysMetricInterval) {
            sysMetricInterval = setInterval(() => {
                const sysTab = document.getElementById('wtab-system');
                if (sysTab && sysTab.classList.contains('active')) {
                    updateSystemMetrics();
                }
            }, 2000);
        }
    }

    function onCollapsed() {
        if (sysMetricInterval) {
            clearInterval(sysMetricInterval);
            sysMetricInterval = null;
        }
    }

    if (btnRefreshSys) {
        btnRefreshSys.addEventListener('click', () => {
            updateSystemMetrics();
        });
    }

    // =========================================================================
    // 7-1. In-layer Confirmation Modal
    // =========================================================================

    function showWidgetConfirm(options) {
        const opts = Object.assign({
            title: '확인',
            message: '계속하시겠습니까?',
            icon: '❓',
            confirmText: '확인',
            cancelText: '취소',
            danger: false
        }, options || {});

        return new Promise((resolve) => {
            if (!modalOverlay || !modalBtnCancel || !modalBtnConfirm) {
                resolve(false);
                return;
            }

            isModalOpen = true;
            if (collapseTimer) {
                clearTimeout(collapseTimer);
                collapseTimer = null;
            }

            if (modalIcon) modalIcon.textContent = opts.icon;
            if (modalTitle) modalTitle.textContent = opts.title;
            if (modalMsg) modalMsg.textContent = opts.message;
            if (modalBtnCancel) modalBtnCancel.textContent = opts.cancelText;
            if (modalBtnConfirm) {
                modalBtnConfirm.textContent = opts.confirmText;
                modalBtnConfirm.classList.toggle('danger', !!opts.danger);
            }

            modalOverlay.style.display = 'flex';

            const onCancel = (e) => {
                if (e) e.stopPropagation();
                cleanup(false);
            };

            const onConfirm = (e) => {
                if (e) e.stopPropagation();
                cleanup(true);
            };

            const cleanup = (result) => {
                modalOverlay.style.display = 'none';
                isModalOpen = false;
                modalBtnCancel.removeEventListener('click', onCancel);
                modalBtnConfirm.removeEventListener('click', onConfirm);
                resolve(result);
            };

            modalBtnCancel.addEventListener('click', onCancel);
            modalBtnConfirm.addEventListener('click', onConfirm);
        });
    }

    function showWidgetPrompt(opts) {
        return new Promise((resolve) => {
            const modalInput = document.getElementById('widget-modal-input');
            if (!modalOverlay || !modalInput) {
                const val = window.prompt(opts.message || opts.title || '', opts.defaultValue || '');
                resolve(val);
                return;
            }

            isModalOpen = true;
            if (modalIcon) modalIcon.textContent = opts.icon || '✏️';
            if (modalTitle) modalTitle.textContent = opts.title || '입력';
            if (modalMsg) modalMsg.textContent = opts.message || '';
            modalInput.style.display = 'block';
            modalInput.value = opts.defaultValue || '';
            modalInput.placeholder = opts.placeholder || '';
            if (modalBtnCancel) modalBtnCancel.textContent = opts.cancelText || '취소';
            if (modalBtnConfirm) {
                modalBtnConfirm.textContent = opts.confirmText || '확인';
                modalBtnConfirm.classList.remove('danger');
            }

            modalOverlay.style.display = 'flex';
            setTimeout(() => modalInput.focus(), 50);

            const onKeyDown = (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    cleanup(modalInput.value.trim());
                } else if (e.key === 'Escape') {
                    e.preventDefault();
                    cleanup(null);
                }
            };
            const onCancel = (e) => { if (e) e.stopPropagation(); cleanup(null); };
            const onConfirm = (e) => { if (e) e.stopPropagation(); cleanup(modalInput.value.trim()); };

            const cleanup = (result) => {
                modalOverlay.style.display = 'none';
                modalInput.style.display = 'none';
                isModalOpen = false;
                modalBtnCancel.removeEventListener('click', onCancel);
                modalBtnConfirm.removeEventListener('click', onConfirm);
                modalInput.removeEventListener('keydown', onKeyDown);
                resolve(result);
            };
            modalBtnCancel.addEventListener('click', onCancel);
            modalBtnConfirm.addEventListener('click', onConfirm);
            modalInput.addEventListener('keydown', onKeyDown);
        });
    }

    // =========================================================================
    // 7-2. System Power Controls (Restart & Shutdown)
    // =========================================================================

    if (btnWidgetRestart) {
        btnWidgetRestart.addEventListener('click', async (e) => {
            e.stopPropagation();
            const confirmed = await showWidgetConfirm({
                title: '백엔드 서버 재시작',
                message: 'Util-Tools 백엔드 서버와 위젯을 재시작하시겠습니까?\n\n수정된 코드 및 설정이 즉시 반영되며, 새 윈도우가 자동으로 열립니다.',
                icon: '🔄',
                confirmText: '재시작',
                cancelText: '취소',
                danger: false
            });

            if (!confirmed) return;

            try {
                if (window.eel && window.eel.restart_app) {
                    await window.eel.restart_app()();
                }
            } catch (err) {
                console.error('재시작 요청 실패:', err);
            }
        });
    }

    if (btnWidgetShutdown) {
        btnWidgetShutdown.addEventListener('click', async (e) => {
            e.stopPropagation();
            const confirmed = await showWidgetConfirm({
                title: '애플리케이션 완전 종료',
                message: 'Utility Toolkit 백엔드 서버, 시스템 트레이 및 위젯을 완전히 종료하시겠습니까?',
                icon: '🚪',
                confirmText: '완전 종료',
                cancelText: '취소',
                danger: true
            });

            if (!confirmed) return;

            try {
                if (window.eel && window.eel.shutdown_app) {
                    await window.eel.shutdown_app()();
                }
            } catch (err) {
                console.error('종료 요청 실패:', err);
            }
        });
    }

    // =========================================================================
    // 7-3. Real-Time Stock & FX Integration
    // =========================================================================

    let stockSearchDebounce = null;
    let stockGroups = [];
    let activeStockGroupId = 'g_default';
    let stockWatchlistData = [];

    window.onStockTickUpdate = function (tick) {
        if (!tick || !tick.code) return;
        const cached = stockWatchlistData.find(w => w.code === tick.code);
        if (cached) Object.assign(cached, tick);
        const card = document.querySelector(`.stock-card[data-code="${tick.code}"]`);
        if (!card) return;

        const priceEl = card.querySelector('.stock-price');
        const changeEl = card.querySelector('.stock-change');
        const sessEl = card.querySelector('.session-badge');

        if (priceEl && tick.formatted_price) {
            priceEl.textContent = tick.formatted_price;
        }

        if (changeEl && typeof tick.change === 'number') {
            const sign = tick.change > 0 ? '+' : (tick.change < 0 ? '-' : '');
            const isKrw = tick.currency === 'KRW' || (tick.code && /^\d+$/.test(tick.code));
            const formattedChange = isKrw
                ? Math.abs(tick.change).toLocaleString()
                : Math.abs(tick.change).toFixed(2);
            const rate = typeof tick.change_rate === 'number' ? tick.change_rate : 0.0;
            const rateFormatted = `${sign}${Math.abs(rate).toFixed(2)}%`;
            changeEl.textContent = `${sign}${formattedChange} (${rateFormatted})`;
            changeEl.className = `stock-change ${tick.change > 0 ? 'up' : (tick.change < 0 ? 'down' : 'flat')}`;
        }

        if (sessEl && tick.session) {
            sessEl.textContent = tick.session;
            sessEl.className = `session-badge badge-${tick.session.toLowerCase()}`;
        }

        // Pulse animation
        const flashClass = (tick.change >= 0) ? 'tick-flash-up' : 'tick-flash-down';
        if (!card.classList.contains('tick-flash-up') && !card.classList.contains('tick-flash-down')) {
            card.classList.add(flashClass);
            setTimeout(() => card.classList.remove(flashClass), 600);
        }
    };

    async function loadStockDashboard() {
        if (!window.eel || !window.eel.get_stock_dashboard_data) return;
        try {
            const res = await window.eel.get_stock_dashboard_data()();
            if (res && res.status === 'success') {
                renderStockDashboard(res);
            }
        } catch (e) {
            console.error('Failed to load stock dashboard:', e);
        }
    }

    function renderStockDashboard(data) {
        stockGroups = data.groups || [];
        activeStockGroupId = data.active_group_id || (stockGroups[0] ? stockGroups[0].id : 'g_default');
        stockWatchlistData = data.watchlist || [];

        // FX Ticker Bar
        const fx = data.fx || {};
        if (fx.USD) {
            const rateEl = document.getElementById('fx-rate-usd');
            const chgEl = document.getElementById('fx-change-usd');
            if (rateEl) rateEl.textContent = fx.USD.formatted;
            if (chgEl) {
                const sign = fx.USD.change > 0 ? '+' : '';
                chgEl.textContent = `${sign}${fx.USD.change} (${sign}${fx.USD.change_rate}%)`;
                chgEl.className = `fx-change ${fx.USD.change > 0 ? 'up' : (fx.USD.change < 0 ? 'down' : 'flat')}`;
            }
        }
        if (fx.JPY) {
            const rateEl = document.getElementById('fx-rate-jpy');
            const chgEl = document.getElementById('fx-change-jpy');
            if (rateEl) rateEl.textContent = fx.JPY.formatted;
            if (chgEl) {
                const sign = fx.JPY.change > 0 ? '+' : '';
                chgEl.textContent = `${sign}${fx.JPY.change} (${sign}${fx.JPY.change_rate}%)`;
                chgEl.className = `fx-change ${fx.JPY.change > 0 ? 'up' : (fx.JPY.change < 0 ? 'down' : 'flat')}`;
            }
        }

        // Key configuration notice
        const noticeEl = document.getElementById('stock-key-notice');
        if (noticeEl) {
            noticeEl.style.display = data.api_configured ? 'none' : 'flex';
        }

        // Watchlist cards
        const listEl = document.getElementById('stock-card-list');
        const badgeEl = document.getElementById('stock-count-badge');
        const watchlist = data.watchlist || [];

        if (badgeEl) badgeEl.textContent = watchlist.length;
        if (!listEl) return;

        listEl.innerHTML = '';
        if (watchlist.length === 0) {
            listEl.innerHTML = '<div class="stock-empty">등록된 관심 종목이 없습니다. [+ 종목 추가]로 추가하세요.</div>';
            return;
        }

        watchlist.forEach((item) => {
            const card = document.createElement('div');
            card.className = 'stock-card';
            card.setAttribute('data-code', item.code);

            const mktClass = item.market === 'US' ? 'market-us' : 'market-kr';
            const sessClass = `badge-${(item.session || 'reg').toLowerCase()}`;
            const chgClass = item.change > 0 ? 'up' : (item.change < 0 ? 'down' : 'flat');
            const sign = item.change > 0 ? '+' : (item.change < 0 ? '-' : '');
            const isKrw = item.currency === 'KRW' || item.market === 'KR' || /^\d+$/.test(item.code);
            const formattedChange = isKrw
                ? Math.abs(item.change || 0).toLocaleString()
                : Math.abs(item.change || 0).toFixed(2);
            const rate = typeof item.change_rate === 'number' ? item.change_rate : 0.0;
            const rateFormatted = `${sign}${Math.abs(rate).toFixed(2)}%`;
            const changeDisplay = `${sign}${formattedChange} (${rateFormatted})`;

            card.innerHTML = `
                <div class="stock-card-left">
                    <div class="stock-name-row">
                        <span class="stock-name" title="${item.name}">${item.name}</span>
                        <span class="stock-market-tag ${mktClass}">${item.market}</span>
                    </div>
                    <div class="stock-code-row">
                        <span class="stock-code">${item.code}</span>
                        <span class="session-badge ${sessClass}">${item.session || 'REG'}</span>
                    </div>
                </div>
                <div class="stock-card-right">
                    <div class="stock-price-col">
                        <span class="stock-price">${item.formatted_price || '--'}</span>
                        <span class="stock-change ${chgClass}">${changeDisplay}</span>
                    </div>
                    <button class="stock-btn-del" title="관심 종목 삭제">✕</button>
                </div>
            `;

            const delBtn = card.querySelector('.stock-btn-del');
            if (delBtn) {
                delBtn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    if (window.eel && window.eel.remove_stock_symbol) {
                        try {
                            const r = await window.eel.remove_stock_symbol(item.code)();
                            if (r && r.success) {
                                card.remove();
                                const curCnt = document.querySelectorAll('.stock-card').length;
                                if (badgeEl) badgeEl.textContent = curCnt;
                            }
                        } catch (err) {
                            console.error('Failed to remove stock:', err);
                        }
                    }
                });
            }

            listEl.appendChild(card);
        });
    }

    function initStockUI() {
        const btnStockRefresh = document.getElementById('btn-stock-refresh');
        const btnStockAdd = document.getElementById('btn-stock-add');
        const btnStockApiKey = document.getElementById('btn-stock-api-key');
        const btnNoticeConfig = document.getElementById('btn-stock-notice-config');

        const modalSearch = document.getElementById('modal-stock-search');
        const btnCloseSearch = document.getElementById('btn-close-stock-search');
        const inputSearch = document.getElementById('input-stock-search');
        const resultsContainer = document.getElementById('stock-search-results');

        const modalKey = document.getElementById('modal-stock-key');
        const btnCloseKey = document.getElementById('btn-close-stock-key');
        const btnCancelKey = document.getElementById('btn-stock-key-cancel');
        const btnSaveKey = document.getElementById('btn-stock-key-save');
        const inputClientId = document.getElementById('input-stock-client-id');
        const inputClientSecret = document.getElementById('input-stock-client-secret');
        const currentIpEl = document.getElementById('stock-current-ip');
        const keyStatus = document.getElementById('stock-key-status');

        if (btnStockRefresh) {
            btnStockRefresh.addEventListener('click', async () => {
                btnStockRefresh.classList.add('spinning');
                if (window.eel && window.eel.refresh_stock_data) {
                    try {
                        const res = await window.eel.refresh_stock_data()();
                        if (res) renderStockDashboard(res);
                    } catch (e) {
                        console.error('Refresh error:', e);
                    }
                }
                setTimeout(() => btnStockRefresh.classList.remove('spinning'), 600);
            });
        }

        // Search Modal
        function openStockSearch() {
            if (!modalSearch) return;
            isModalOpen = true;
            modalSearch.style.display = 'flex';
            if (inputSearch) {
                inputSearch.value = '';
                inputSearch.focus();
            }
            if (resultsContainer) {
                resultsContainer.innerHTML = '<div class="search-hint">검색어를 1글자 이상 입력하세요.</div>';
            }
        }

        function closeStockSearch() {
            if (!modalSearch) return;
            modalSearch.style.display = 'none';
            isModalOpen = false;
        }

        if (btnStockAdd) btnStockAdd.addEventListener('click', openStockSearch);
        if (btnCloseSearch) btnCloseSearch.addEventListener('click', closeStockSearch);

        if (inputSearch) {
            inputSearch.addEventListener('input', () => {
                const query = inputSearch.value.trim();
                clearTimeout(stockSearchDebounce);
                if (query.length === 0) {
                    if (resultsContainer) {
                        resultsContainer.innerHTML = '<div class="search-hint">검색어를 1글자 이상 입력하세요.</div>';
                    }
                    return;
                }

                stockSearchDebounce = setTimeout(async () => {
                    if (window.eel && window.eel.search_stock_master) {
                        try {
                            const list = await window.eel.search_stock_master(query)();
                            if (!resultsContainer) return;
                            resultsContainer.innerHTML = '';
                            if (!list || list.length === 0) {
                                resultsContainer.innerHTML = '<div class="search-hint">검색 결과가 없습니다. 엔터를 눌러 직접 코드로 등록할 수 있습니다.</div>';
                                return;
                            }
                            list.forEach((m) => {
                                const item = document.createElement('div');
                                item.className = 'stock-search-item';
                                const mktClass = m.market === 'US' ? 'market-us' : 'market-kr';
                                item.innerHTML = `
                                    <div class="search-item-info">
                                        <span class="search-item-name">${m.name}</span>
                                        <span class="search-item-code">${m.code}</span>
                                    </div>
                                    <span class="stock-market-tag ${mktClass}">${m.market}</span>
                                `;
                                item.addEventListener('click', async () => {
                                    if (window.eel && window.eel.add_stock_symbol) {
                                        const r = await window.eel.add_stock_symbol(m.code, m.name, m.market, activeStockGroupId)();
                                        if (r && r.success) {
                                            closeStockSearch();
                                            loadStockDashboard();
                                        }
                                    }
                                });
                                resultsContainer.appendChild(item);
                            });
                        } catch (err) {
                            console.error('Master stock search failed:', err);
                        }
                    }
                }, 200);
            });

            // Enter key direct registration
            inputSearch.addEventListener('keydown', async (e) => {
                if (e.key === 'Enter') {
                    const val = inputSearch.value.trim().toUpperCase();
                    if (val && window.eel && window.eel.add_stock_symbol) {
                        const mkt = /^\d{6}$/.test(val) ? 'KR' : 'US';
                        const r = await window.eel.add_stock_symbol(val, val, mkt, activeStockGroupId)();
                        if (r && r.success) {
                            closeStockSearch();
                            loadStockDashboard();
                        }
                    }
                }
            });
        }

        // Key Modal
        async function openStockKeyModal() {
            if (!modalKey) return;
            isModalOpen = true;
            modalKey.style.display = 'flex';
            if (keyStatus) {
                keyStatus.textContent = '';
                keyStatus.className = 'stock-key-status';
            }

            if (currentIpEl) {
                currentIpEl.textContent = '조회 중...';
                try {
                    const resp = await fetch('https://api.ipify.org?format=json');
                    const ipData = await resp.json();
                    if (ipData && ipData.ip) {
                        currentIpEl.textContent = ipData.ip;
                    }
                } catch (e) {
                    currentIpEl.textContent = '확인 불가 (포털 확인 요망)';
                }
            }
        }

        function closeStockKeyModal() {
            if (!modalKey) return;
            modalKey.style.display = 'none';
            isModalOpen = false;
        }

        if (btnStockApiKey) btnStockApiKey.addEventListener('click', openStockKeyModal);
        if (btnNoticeConfig) btnNoticeConfig.addEventListener('click', openStockKeyModal);
        if (btnCloseKey) btnCloseKey.addEventListener('click', closeStockKeyModal);
        if (btnCancelKey) btnCancelKey.addEventListener('click', closeStockKeyModal);

        if (btnSaveKey) {
            btnSaveKey.addEventListener('click', async () => {
                const cid = inputClientId ? inputClientId.value.trim() : '';
                const csec = inputClientSecret ? inputClientSecret.value.trim() : '';
                if (keyStatus) {
                    keyStatus.textContent = '인증 검증 중...';
                    keyStatus.className = 'stock-key-status';
                }
                if (window.eel && window.eel.save_stock_api_keys) {
                    try {
                        const res = await window.eel.save_stock_api_keys(cid, csec)();
                        if (res && res.success) {
                            if (keyStatus) {
                                keyStatus.textContent = res.message || '저장되었습니다.';
                                keyStatus.className = 'stock-key-status success';
                            }
                            setTimeout(() => {
                                closeStockKeyModal();
                                loadStockDashboard();
                            }, 800);
                        } else {
                            if (keyStatus) {
                                keyStatus.textContent = (res && res.error) ? res.error : '인증 실패';
                                keyStatus.className = 'stock-key-status error';
                            }
                        }
                    } catch (err) {
                        if (keyStatus) {
                            keyStatus.textContent = '네트워크/서버 오류';
                            keyStatus.className = 'stock-key-status error';
                        }
                    }
                }
            });
        }
    }

    // =========================================================================
    // 8. Initialization
    // =========================================================================

    document.addEventListener('DOMContentLoaded', () => {
        initMemo();
        initStockUI();
        // pywebview ready 대기
        window.addEventListener('pywebviewready', async () => {
            if (window.pywebview && window.pywebview.api) {
                try {
                    const info = await window.pywebview.api.get_state();
                    if (info && info.edge) {
                        window.onEdgeChanged(info.edge);
                    }
                    if (window.pywebview.api.get_handle_size) {
                        const curSize = await window.pywebview.api.get_handle_size();
                        if (curSize) {
                            window.onHandleSizeChanged(curSize);
                        }
                    }
                } catch (e) {
                    console.error('Failed to fetch initial widget state:', e);
                }
            }
        });
    });
})();

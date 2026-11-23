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
    let isStockDragging = false;
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
            if (!isPinned && !isCollapsed() && !isModalOpen && !isStockDragging) {
                collapseTimer = setTimeout(() => {
                    if (!isModalOpen && !isStockDragging) {
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
    const lastTickPrices = {};
    const cardFlashTimers = {};
    const BUY_FEE_RATE = 0.001;       // 매수 수수료 0.1% (매수가 기준)
    const SELL_FEE_RATE = 0.0010206;  // 매도 수수료 0.1% + 제비용 0.00206% (매도가 기준)
    const TARGET_PROFIT_STORAGE_KEY = 'util_widget_stock_target_pct';
    let stockTargetProfitPct = (() => {
        try {
            const saved = parseFloat(localStorage.getItem(TARGET_PROFIT_STORAGE_KEY));
            if (Number.isFinite(saved) && saved >= 0 && saved <= 100) return saved;
        } catch (e) {}
        return 1;
    })();

    function formatTargetPctLabel(pct) {
        const val = Number.isFinite(pct) && pct >= 0 ? pct : 0;
        return Number(val.toFixed(2)).toString();
    }

    function computeSellPriceInfo(price, isKrw, targetPct) {
        const num = Number(price);
        const pct = Number.isFinite(Number(targetPct)) && Number(targetPct) >= 0 ? Number(targetPct) : 0;
        const pctLabel = formatTargetPctLabel(pct);
        const isZero = pct === 0;

        if (!Number.isFinite(num) || num <= 0) {
            return {
                formatted: '--',
                tooltip: isZero
                    ? '매수 0.1%·매도 0.10206% 분리 기준 본전가'
                    : `매수 0.1%·매도 0.10206% 분리 기준 순수익 +${pctLabel}% 목표가`
            };
        }

        const targetRate = pct / 100;
        const exact = num * ((1 + BUY_FEE_RATE) * (1 + targetRate)) / (1 - SELL_FEE_RATE);
        if (isKrw) {
            const ceilVal = Math.ceil(exact - 1e-9);
            const formatted = `${ceilVal.toLocaleString()}원`;
            return {
                formatted,
                tooltip: isZero
                    ? `매수 0.1%·매도 0.10206% 분리 기준 본전가: ${exact.toLocaleString(undefined, { maximumFractionDigits: 2 })}원 (${formatted} 이상 매도 시 수익)`
                    : `매수 0.1%·매도 0.10206% 분리 기준 +${pctLabel}% 목표가: ${exact.toLocaleString(undefined, { maximumFractionDigits: 2 })}원 (${formatted} 이상 매도 시 순수익 ≥ ${pctLabel}%)`
            };
        }

        const ceilCents = Math.ceil(exact * 100 - 1e-9) / 100;
        const formatted = `$${ceilCents.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
        return {
            formatted,
            tooltip: isZero
                ? `매수 0.1%·매도 0.10206% 분리 기준 본전가: $${exact.toFixed(4)} (${formatted} 이상 매도 시 수익)`
                : `매수 0.1%·매도 0.10206% 분리 기준 +${pctLabel}% 목표가: $${exact.toFixed(4)} (${formatted} 이상 매도 시 순수익 ≥ ${pctLabel}%)`
        };
    }

    function computeSellPrices(price, isKrw) {
        return {
            breakeven: computeSellPriceInfo(price, isKrw, 0),
            target: computeSellPriceInfo(price, isKrw, stockTargetProfitPct),
            targetLabel: formatTargetPctLabel(stockTargetProfitPct)
        };
    }

    function escapeAttr(str) {
        return String(str ?? '')
            .replace(/&/g, '&amp;')
            .replace(/"/g, '&quot;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    function normalizeTrendInfo(trend, kind) {
        const defaultTooltip = kind === 'scalp' ? '단타(1분봉): 집계 중' : '스윙(일봉): 집계 중';
        if (!trend || typeof trend !== 'object') {
            return { level: 'unknown', emoji: '·', tooltip: defaultTooltip };
        }
        return {
            level: trend.level || 'unknown',
            emoji: trend.emoji || '·',
            tooltip: trend.tooltip || defaultTooltip
        };
    }

    function applyTrendBadge(el, trend, kind) {
        if (!el || !trend || typeof trend !== 'object') return;
        const info = normalizeTrendInfo(trend, kind);
        const nextClass = `stock-trend-icon stock-trend-${kind} trend-${info.level}`;
        if (el.textContent !== info.emoji) {
            el.textContent = info.emoji;
        }
        if (el.title !== info.tooltip) {
            el.title = info.tooltip;
        }
        if (el.className !== nextClass) {
            el.className = nextClass;
        }
    }

    window.onStockTickUpdate = function (tick) {
        if (!tick || !tick.code) return;
        const cached = stockWatchlistData.find(w => w.code === tick.code);
        const prevPrice = (typeof lastTickPrices[tick.code] === 'number' && lastTickPrices[tick.code] > 0)
            ? lastTickPrices[tick.code]
            : ((cached && typeof cached.price === 'number' && cached.price > 0)
                ? cached.price
                : (typeof tick.prev_price === 'number' ? tick.prev_price : null));

        const newPrice = typeof tick.price === 'number' ? tick.price : null;
        let tickDiff = 0;
        if (newPrice !== null && prevPrice !== null && prevPrice > 0) {
            tickDiff = newPrice - prevPrice;
        } else if (typeof tick.tick_diff === 'number') {
            tickDiff = tick.tick_diff;
        }

        if (newPrice !== null && newPrice > 0) {
            lastTickPrices[tick.code] = newPrice;
        }
        if (cached) Object.assign(cached, tick);

        const card = document.querySelector(`.stock-card[data-code="${tick.code}"]`);
        if (!card) return;

        const priceEl = card.querySelector('.stock-price');
        const changeEl = card.querySelector('.stock-change');
        const sessEl = card.querySelector('.session-badge');
        const scalpEl = card.querySelector('.stock-trend-scalp');
        const swingEl = card.querySelector('.stock-trend-swing');
        const breakevenRow = card.querySelector('.stock-sell-breakeven');
        const breakevenPriceEl = card.querySelector('.stock-breakeven-price');
        const targetRow = card.querySelector('.stock-sell-target');
        const targetTagEl = card.querySelector('.stock-target-tag');
        const targetPriceEl = card.querySelector('.stock-target-price');
        const isKrw = tick.currency === 'KRW' || (tick.code && /^\d+$/.test(tick.code));

        if (scalpEl && tick.scalp_trend) {
            applyTrendBadge(scalpEl, tick.scalp_trend, 'scalp');
        }
        if (swingEl && tick.swing_trend) {
            applyTrendBadge(swingEl, tick.swing_trend, 'swing');
        }

        if (priceEl && tick.formatted_price) {
            priceEl.textContent = tick.formatted_price;
        }

        if ((breakevenPriceEl || targetPriceEl) && typeof tick.price === 'number') {
            const sellInfo = computeSellPrices(tick.price, isKrw);
            if (breakevenPriceEl) breakevenPriceEl.textContent = sellInfo.breakeven.formatted;
            if (breakevenRow) breakevenRow.title = sellInfo.breakeven.tooltip;
            if (targetTagEl) targetTagEl.textContent = `+${sellInfo.targetLabel}%`;
            if (targetPriceEl) targetPriceEl.textContent = sellInfo.target.formatted;
            if (targetRow) targetRow.title = sellInfo.target.tooltip;
        }

        if (changeEl && typeof tick.change === 'number') {
            const sign = tick.change > 0 ? '+' : (tick.change < 0 ? '-' : '');
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

        if (tick.silent) return;

        // Pulse animation based on movement relative to the immediately preceding tick
        const flashClass = tickDiff > 0
            ? 'tick-flash-up'
            : (tickDiff < 0 ? 'tick-flash-down' : 'tick-flash-flat');

        card.classList.remove('tick-flash-up', 'tick-flash-down', 'tick-flash-flat');
        void card.offsetWidth; // Force reflow so rapid consecutive ticks re-trigger animation
        card.classList.add(flashClass);

        if (cardFlashTimers[tick.code]) {
            clearTimeout(cardFlashTimers[tick.code]);
        }
        cardFlashTimers[tick.code] = setTimeout(() => {
            card.classList.remove('tick-flash-up', 'tick-flash-down', 'tick-flash-flat');
            delete cardFlashTimers[tick.code];
        }, 600);
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
        stockWatchlistData.forEach((item) => {
            if (item && item.code && typeof item.price === 'number' && item.price > 0) {
                lastTickPrices[item.code] = item.price;
            }
        });

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

        // Key configuration notice & mode button indicator
        const noticeEl = document.getElementById('stock-key-notice');
        if (noticeEl) {
            noticeEl.style.display = data.api_configured ? 'none' : 'flex';
        }
        const apiKeyBtn = document.getElementById('btn-stock-api-key');
        if (apiKeyBtn) {
            const isRelay = data.connection_mode === 'relay';
            apiKeyBtn.textContent = isRelay ? '🔗 릴레이' : '🔑 API 키';
            apiKeyBtn.title = isRelay
                ? `개인 릴레이 서버 연결됨 (${data.relay_url || ''})`
                : 'Toss API 키 / 릴레이 서버 설정';
            apiKeyBtn.classList.toggle('is-relay-active', isRelay);
        }

        // Watchlist cards & Custom Group Tabs
        renderStockGroupTabs();
        renderStockCards();
    }

    function renderStockGroupTabs() {
        const bar = document.getElementById('stock-groups-bar');
        if (!bar) return;
        bar.innerHTML = '';

        stockGroups.forEach((grp) => {
            const tab = document.createElement('div');
            tab.className = `stock-group-tab ${grp.id === activeStockGroupId ? 'active' : ''}`;
            tab.setAttribute('data-group-id', grp.id);
            const count = (grp.codes || []).length;
            tab.innerHTML = `
                <span class="tab-name" title="${grp.name}">${grp.name}</span>
                <span class="tab-count">${count}</span>
                <div class="stock-group-tab-actions">
                    <button class="tab-action-btn tab-btn-edit" title="그룹명 변경">✎</button>
                    ${stockGroups.length > 1 ? '<button class="tab-action-btn tab-btn-del" title="그룹 삭제">✕</button>' : ''}
                </div>
            `;

            tab.addEventListener('click', async (e) => {
                if (e.target.closest('.tab-action-btn')) return;
                if (activeStockGroupId === grp.id) return;
                activeStockGroupId = grp.id;
                renderStockGroupTabs();
                renderStockCards();
                if (window.eel && window.eel.set_active_stock_group) {
                    try { await window.eel.set_active_stock_group(grp.id)(); } catch (err) {}
                }
            });

            const editBtn = tab.querySelector('.tab-btn-edit');
            if (editBtn) {
                editBtn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    const newName = await showWidgetPrompt({
                        title: '그룹 이름 변경',
                        message: `'${grp.name}' 그룹의 새 이름을 입력하세요:`,
                        defaultValue: grp.name,
                        confirmText: '변경'
                    });
                    if (!newName || newName === grp.name) return;
                    if (window.eel && window.eel.rename_stock_group) {
                        const res = await window.eel.rename_stock_group(grp.id, newName)();
                        if (res && res.success) {
                            grp.name = newName;
                            renderStockGroupTabs();
                        }
                    }
                });
            }

            const delBtn = tab.querySelector('.tab-btn-del');
            if (delBtn) {
                delBtn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    const confirmed = await showWidgetConfirm({
                        title: '그룹 삭제',
                        message: `'${grp.name}' 그룹을 삭제하시겠습니까?`,
                        icon: '🗑️',
                        confirmText: '삭제',
                        danger: true
                    });
                    if (!confirmed) return;
                    if (window.eel && window.eel.remove_stock_group) {
                        const res = await window.eel.remove_stock_group(grp.id)();
                        if (res && res.success) {
                            stockGroups = res.groups;
                            activeStockGroupId = res.active_group_id;
                            await loadStockDashboard();
                        }
                    }
                });
            }
            bar.appendChild(tab);
        });

        const addBtn = document.createElement('button');
        addBtn.className = 'stock-group-add-btn';
        addBtn.title = '새 그룹 추가';
        addBtn.innerHTML = '+';
        addBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const name = await showWidgetPrompt({
                title: '새 관심종목 그룹 추가',
                message: '그룹 이름을 입력하세요:',
                placeholder: '예: 반도체, 배당주',
                confirmText: '추가'
            });
            if (!name) return;
            if (window.eel && window.eel.add_stock_group) {
                const res = await window.eel.add_stock_group(name)();
                if (res && res.success) {
                    stockGroups = res.groups;
                    activeStockGroupId = res.active_group_id;
                    renderStockGroupTabs();
                    renderStockCards();
                }
            }
        });
        bar.appendChild(addBtn);
    }

    let activeStockDrag = null;

    function getStockOrderedCodes(listEl) {
        return Array.from(listEl.querySelectorAll('.stock-card'))
            .map(el => el.getAttribute('data-code'))
            .filter(Boolean);
    }

    function getStockScrollContainer(listEl) {
        if (!listEl) return null;
        if (listEl.scrollHeight > listEl.clientHeight + 1) return listEl;
        const bodyEl = listEl.closest('.widget-body');
        if (bodyEl && bodyEl.scrollHeight > bodyEl.clientHeight + 1) return bodyEl;
        return listEl;
    }

    function updateStockFloatingAndSlot(clientY) {
        const drag = activeStockDrag;
        if (!drag) return;

        const { listEl, cardEl, floatingEl, cardRect, grabOffsetY } = drag;
        const scrollContainer = getStockScrollContainer(listEl);
        const containerRect = scrollContainer ? scrollContainer.getBoundingClientRect() : listEl.getBoundingClientRect();

        const rawTop = clientY - grabOffsetY;
        const minTop = containerRect.top - 12;
        const maxTop = containerRect.bottom - cardRect.height + 12;
        const clampedTop = Math.max(minTop, Math.min(maxTop, rawTop));

        if (floatingEl) {
            floatingEl.style.top = `${clampedTop}px`;
        }

        const refY = clampedTop + cardRect.height / 2;
        const siblings = Array.from(listEl.querySelectorAll('.stock-card')).filter(el => el !== cardEl);
        let insertBeforeEl = null;
        for (const sib of siblings) {
            const rect = sib.getBoundingClientRect();
            const midpoint = rect.top + rect.height / 2;
            if (refY < midpoint) {
                insertBeforeEl = sib;
                break;
            }
        }

        if (insertBeforeEl === null) {
            if (listEl.lastElementChild !== cardEl) {
                listEl.appendChild(cardEl);
            }
        } else if (cardEl.nextElementSibling !== insertBeforeEl) {
            listEl.insertBefore(cardEl, insertBeforeEl);
        }
    }

    function runStockAutoScrollStep() {
        const drag = activeStockDrag;
        if (!drag) return;

        const { listEl, lastClientY } = drag;
        const scrollContainer = getStockScrollContainer(listEl);
        if (scrollContainer) {
            const rect = scrollContainer.getBoundingClientRect();
            const edgeZone = 34;
            const maxScroll = Math.max(0, scrollContainer.scrollHeight - scrollContainer.clientHeight);
            let scrolled = 0;

            if (lastClientY < rect.top + edgeZone && scrollContainer.scrollTop > 0) {
                const dist = (rect.top + edgeZone) - lastClientY;
                const speed = Math.min(18, Math.max(2, Math.round(dist / 6)));
                const prevTop = scrollContainer.scrollTop;
                scrollContainer.scrollTop = Math.max(0, prevTop - speed);
                scrolled = prevTop - scrollContainer.scrollTop;
                listEl.classList.add('auto-scroll-top');
                listEl.classList.remove('auto-scroll-bottom');
            } else if (lastClientY > rect.bottom - edgeZone && scrollContainer.scrollTop < maxScroll) {
                const dist = lastClientY - (rect.bottom - edgeZone);
                const speed = Math.min(18, Math.max(2, Math.round(dist / 6)));
                const prevTop = scrollContainer.scrollTop;
                scrollContainer.scrollTop = Math.min(maxScroll, prevTop + speed);
                scrolled = scrollContainer.scrollTop - prevTop;
                listEl.classList.add('auto-scroll-bottom');
                listEl.classList.remove('auto-scroll-top');
            } else {
                listEl.classList.remove('auto-scroll-top', 'auto-scroll-bottom');
            }

            if (scrolled !== 0) {
                updateStockFloatingAndSlot(lastClientY);
            }
        }

        drag.rafId = requestAnimationFrame(runStockAutoScrollStep);
    }

    async function finishStockCardDrag(pointerId) {
        const drag = activeStockDrag;
        if (!drag) return;
        if (pointerId !== undefined && drag.pointerId !== pointerId) return;

        activeStockDrag = null;
        if (drag.rafId) {
            cancelAnimationFrame(drag.rafId);
        }

        const { listEl, cardEl, floatingEl, targetGroup, initialOrderKey } = drag;
        try {
            if (listEl && listEl.hasPointerCapture(drag.pointerId)) {
                listEl.releasePointerCapture(drag.pointerId);
            }
        } catch (_) {}

        if (floatingEl && floatingEl.parentNode) {
            floatingEl.parentNode.removeChild(floatingEl);
        }
        if (cardEl) {
            cardEl.classList.remove('is-drag-placeholder');
        }
        if (listEl) {
            listEl.classList.remove('auto-scroll-top', 'auto-scroll-bottom');
        }
        isStockDragging = false;
        document.body.classList.remove('stock-reordering');

        if (!listEl) return;
        const orderedCodes = getStockOrderedCodes(listEl);
        if (orderedCodes.join(',') !== initialOrderKey) {
            const gid = (targetGroup && targetGroup.id) ? targetGroup.id : activeStockGroupId;
            if (targetGroup) {
                targetGroup.codes = orderedCodes;
            }
            if (window.eel && window.eel.reorder_stock_group_codes) {
                try {
                    const res = await window.eel.reorder_stock_group_codes(gid, orderedCodes)();
                    if (res && res.success && Array.isArray(res.groups)) {
                        stockGroups = res.groups;
                    }
                } catch (err) {
                    console.error('Failed to persist stock reorder:', err);
                }
            }
        }
    }

    function ensureStockListDragController(listEl) {
        if (!listEl || listEl.dataset.dragCtrlBound === '1') return;
        listEl.dataset.dragCtrlBound = '1';

        listEl.addEventListener('pointermove', (e) => {
            if (!activeStockDrag || e.pointerId !== activeStockDrag.pointerId) return;
            e.preventDefault();
            activeStockDrag.lastClientY = e.clientY;
            updateStockFloatingAndSlot(e.clientY);
        });

        listEl.addEventListener('pointerup', (e) => {
            if (!activeStockDrag || e.pointerId !== activeStockDrag.pointerId) return;
            finishStockCardDrag(e.pointerId);
        });

        listEl.addEventListener('pointercancel', (e) => {
            if (!activeStockDrag || e.pointerId !== activeStockDrag.pointerId) return;
            finishStockCardDrag(e.pointerId);
        });

        window.addEventListener('blur', () => {
            if (activeStockDrag) {
                finishStockCardDrag();
            }
        });
    }

    function bindStockCardDragHandle(handleEl, cardEl, listEl, targetGroup) {
        if (!handleEl || !cardEl || !listEl) return;
        ensureStockListDragController(listEl);

        handleEl.addEventListener('pointerdown', (e) => {
            if (e.button !== undefined && e.button !== 0) return;
            if (listEl.querySelectorAll('.stock-card').length <= 1) return;
            if (activeStockDrag) return;

            e.preventDefault();
            e.stopPropagation();

            const cardRect = cardEl.getBoundingClientRect();
            const floatingEl = cardEl.cloneNode(true);
            floatingEl.removeAttribute('data-code');
            floatingEl.className = 'stock-card stock-drag-floating';
            floatingEl.style.left = `${cardRect.left}px`;
            floatingEl.style.top = `${cardRect.top}px`;
            floatingEl.style.width = `${cardRect.width}px`;
            floatingEl.style.height = `${cardRect.height}px`;
            document.body.appendChild(floatingEl);

            cardEl.classList.add('is-drag-placeholder');
            isStockDragging = true;
            document.body.classList.add('stock-reordering');

            activeStockDrag = {
                pointerId: e.pointerId,
                listEl,
                cardEl,
                floatingEl,
                targetGroup,
                initialOrderKey: getStockOrderedCodes(listEl).join(','),
                cardRect,
                grabOffsetY: e.clientY - cardRect.top,
                lastClientY: e.clientY,
                rafId: null
            };

            try {
                listEl.setPointerCapture(e.pointerId);
            } catch (_) {}

            activeStockDrag.rafId = requestAnimationFrame(runStockAutoScrollStep);
        });
    }

    function renderStockCards() {
        const listEl = document.getElementById('stock-card-list');
        const badgeEl = document.getElementById('stock-count-badge');
        if (!listEl) return;

        const curGrp = stockGroups.find(g => g.id === activeStockGroupId) || stockGroups[0];
        const groupCodes = (curGrp && Array.isArray(curGrp.codes)) ? curGrp.codes : [];
        const watchlistMap = new Map(stockWatchlistData.map(item => [item.code, item]));
        const filteredList = groupCodes
            .map(code => watchlistMap.get(code))
            .filter(Boolean);

        if (badgeEl) badgeEl.textContent = filteredList.length;
        listEl.innerHTML = '';
        if (filteredList.length === 0) {
            listEl.innerHTML = '<div class="stock-empty">현재 그룹에 등록된 관심 종목이 없습니다. [+ 종목 추가]로 추가하세요.</div>';
            return;
        }

        filteredList.forEach((item) => {
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
            const sellInfo = computeSellPrices(
                (item.formatted_price && item.formatted_price !== '--') ? item.price : 0,
                isKrw
            );
            const scalpInfo = normalizeTrendInfo(item.scalp_trend, 'scalp');
            const swingInfo = normalizeTrendInfo(item.swing_trend, 'swing');

            card.innerHTML = `
                <button type="button" class="stock-drag-handle" title="드래그하여 순서 변경" aria-label="종목 순서 변경">
                    <svg viewBox="0 0 10 16" width="10" height="14" aria-hidden="true">
                        <circle cx="2.5" cy="3" r="1.2"/>
                        <circle cx="7.5" cy="3" r="1.2"/>
                        <circle cx="2.5" cy="8" r="1.2"/>
                        <circle cx="7.5" cy="8" r="1.2"/>
                        <circle cx="2.5" cy="13" r="1.2"/>
                        <circle cx="7.5" cy="13" r="1.2"/>
                    </svg>
                </button>
                <div class="stock-card-left">
                    <div class="stock-name-row">
                        <span class="stock-trend-icon stock-trend-scalp trend-${escapeAttr(scalpInfo.level)}" title="${escapeAttr(scalpInfo.tooltip)}">${escapeAttr(scalpInfo.emoji)}</span>
                        <span class="stock-name" title="${escapeAttr(item.name)}">${escapeAttr(item.name)}</span>
                        <span class="stock-market-tag ${mktClass}">${item.market}</span>
                    </div>
                    <div class="stock-code-row">
                        <span class="stock-trend-icon stock-trend-swing trend-${escapeAttr(swingInfo.level)}" title="${escapeAttr(swingInfo.tooltip)}">${escapeAttr(swingInfo.emoji)}</span>
                        <span class="stock-code">${escapeAttr(item.code)}</span>
                        <span class="session-badge ${sessClass}">${item.session || 'REG'}</span>
                    </div>
                </div>
                <div class="stock-card-right">
                    <div class="stock-breakeven-col">
                        <div class="stock-sell-row stock-sell-breakeven" title="${escapeAttr(sellInfo.breakeven.tooltip)}">
                            <span class="stock-sell-tag">본전</span>
                            <span class="stock-breakeven-price">${sellInfo.breakeven.formatted}</span>
                        </div>
                        <div class="stock-sell-row stock-sell-target" title="${escapeAttr(sellInfo.target.tooltip)}">
                            <span class="stock-sell-tag stock-target-tag">+${sellInfo.targetLabel}%</span>
                            <span class="stock-target-price">${sellInfo.target.formatted}</span>
                        </div>
                    </div>
                    <div class="stock-price-col">
                        <span class="stock-price">${item.formatted_price || '--'}</span>
                        <span class="stock-change ${chgClass}">${changeDisplay}</span>
                    </div>
                    <button class="stock-btn-del" title="관심 종목 삭제">✕</button>
                </div>
            `;

            const dragHandle = card.querySelector('.stock-drag-handle');
            if (dragHandle) {
                bindStockCardDragHandle(dragHandle, card, listEl, curGrp);
            }

            const delBtn = card.querySelector('.stock-btn-del');
            if (delBtn) {
                delBtn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    if (window.eel && window.eel.remove_stock_symbol) {
                        try {
                            const r = await window.eel.remove_stock_symbol(item.code, activeStockGroupId)();
                            if (r && r.success) {
                                if (curGrp && curGrp.codes) {
                                    curGrp.codes = curGrp.codes.filter(c => c !== item.code);
                                }
                                if (r.groups) stockGroups = r.groups;
                                renderStockGroupTabs();
                                renderStockCards();
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

    function refreshTargetPricesInCards() {
        const cards = document.querySelectorAll('#stock-card-list .stock-card');
        cards.forEach((card) => {
            const code = card.getAttribute('data-code');
            if (!code) return;
            const item = stockWatchlistData.find(w => w.code === code);
            if (!item) return;
            const isKrw = item.currency === 'KRW' || item.market === 'KR' || /^\d+$/.test(item.code);
            const priceVal = (item.formatted_price && item.formatted_price !== '--') ? item.price : 0;
            const sellInfo = computeSellPrices(priceVal, isKrw);

            const targetRow = card.querySelector('.stock-sell-target');
            const targetTagEl = card.querySelector('.stock-target-tag');
            const targetPriceEl = card.querySelector('.stock-target-price');
            if (targetRow) targetRow.title = sellInfo.target.tooltip;
            if (targetTagEl) targetTagEl.textContent = `+${sellInfo.targetLabel}%`;
            if (targetPriceEl) targetPriceEl.textContent = sellInfo.target.formatted;
        });
    }

    function initStockUI() {
        const btnStockRefresh = document.getElementById('btn-stock-refresh');
        const btnStockAdd = document.getElementById('btn-stock-add');
        const btnStockApiKey = document.getElementById('btn-stock-api-key');
        const btnNoticeConfig = document.getElementById('btn-stock-notice-config');

        const targetPresetsEl = document.getElementById('stock-target-presets');
        const inputTargetPct = document.getElementById('input-stock-target-pct');

        function applyTargetProfitPct(nextPct, syncInput = true) {
            const parsed = Number(nextPct);
            const clamped = Number.isFinite(parsed) ? Math.min(100, Math.max(0, parsed)) : 0;
            stockTargetProfitPct = clamped;
            try {
                localStorage.setItem(TARGET_PROFIT_STORAGE_KEY, String(clamped));
            } catch (e) {}

            if (syncInput && inputTargetPct) {
                inputTargetPct.value = formatTargetPctLabel(clamped);
            }
            if (targetPresetsEl) {
                targetPresetsEl.querySelectorAll('.target-preset-btn').forEach((btn) => {
                    const presetVal = parseFloat(btn.getAttribute('data-pct'));
                    btn.classList.toggle('active', Math.abs(presetVal - clamped) < 1e-6);
                });
            }
            refreshTargetPricesInCards();
        }

        if (inputTargetPct) {
            inputTargetPct.value = formatTargetPctLabel(stockTargetProfitPct);
            inputTargetPct.addEventListener('input', () => {
                const raw = inputTargetPct.value.trim();
                if (raw === '') return;
                const val = parseFloat(raw);
                if (Number.isFinite(val)) {
                    applyTargetProfitPct(val, false);
                }
            });
            inputTargetPct.addEventListener('blur', () => {
                const val = parseFloat(inputTargetPct.value);
                applyTargetProfitPct(Number.isFinite(val) ? val : 1, true);
            });
        }
        if (targetPresetsEl) {
            targetPresetsEl.querySelectorAll('.target-preset-btn').forEach((btn) => {
                const presetVal = parseFloat(btn.getAttribute('data-pct'));
                btn.classList.toggle('active', Math.abs(presetVal - stockTargetProfitPct) < 1e-6);
                btn.addEventListener('click', () => {
                    applyTargetProfitPct(presetVal, true);
                });
            });
        }

        const modalSearch = document.getElementById('modal-stock-search');
        const btnCloseSearch = document.getElementById('btn-close-stock-search');
        const inputSearch = document.getElementById('input-stock-search');
        const resultsContainer = document.getElementById('stock-search-results');

        const modalKey = document.getElementById('modal-stock-key');
        const btnCloseKey = document.getElementById('btn-close-stock-key');
        const btnCancelKey = document.getElementById('btn-stock-key-cancel');
        const btnSaveKey = document.getElementById('btn-stock-key-save');
        const modeToggleEl = document.getElementById('stock-mode-toggle');
        const paneLocal = document.getElementById('stock-pane-local');
        const paneRelay = document.getElementById('stock-pane-relay');
        const inputClientId = document.getElementById('input-stock-client-id');
        const inputClientSecret = document.getElementById('input-stock-client-secret');
        const inputRelayUrl = document.getElementById('input-stock-relay-url');
        const inputRelayToken = document.getElementById('input-stock-relay-token');
        const currentIpEl = document.getElementById('stock-current-ip');
        const keyStatus = document.getElementById('stock-key-status');
        let activeConnectionMode = 'local';
        let publicIpFetched = false;

        async function refreshPublicIpIfNeeded() {
            if (!currentIpEl || publicIpFetched) return;
            currentIpEl.textContent = '조회 중...';
            try {
                const resp = await fetch('https://api.ipify.org?format=json');
                const ipData = await resp.json();
                if (ipData && ipData.ip) {
                    currentIpEl.textContent = ipData.ip;
                    publicIpFetched = true;
                    return;
                }
            } catch (e) {}
            currentIpEl.textContent = '확인 불가 (포털 확인 요망)';
        }

        function setStockConnectionMode(mode) {
            activeConnectionMode = mode === 'relay' ? 'relay' : 'local';
            if (modeToggleEl) {
                modeToggleEl.querySelectorAll('.stock-mode-btn').forEach((btn) => {
                    btn.classList.toggle('active', btn.getAttribute('data-mode') === activeConnectionMode);
                });
            }
            if (paneLocal) paneLocal.style.display = activeConnectionMode === 'local' ? 'flex' : 'none';
            if (paneRelay) paneRelay.style.display = activeConnectionMode === 'relay' ? 'flex' : 'none';
            if (activeConnectionMode === 'local') {
                refreshPublicIpIfNeeded();
            }
        }

        if (modeToggleEl) {
            modeToggleEl.querySelectorAll('.stock-mode-btn').forEach((btn) => {
                btn.addEventListener('click', () => {
                    setStockConnectionMode(btn.getAttribute('data-mode'));
                    if (keyStatus) {
                        keyStatus.textContent = '';
                        keyStatus.className = 'stock-key-status';
                    }
                });
            });
        }

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

        // Key / Connection Modal
        async function openStockKeyModal() {
            if (!modalKey) return;
            isModalOpen = true;
            modalKey.style.display = 'flex';
            if (keyStatus) {
                keyStatus.textContent = '';
                keyStatus.className = 'stock-key-status';
            }

            if (window.eel && window.eel.get_stock_connection_config) {
                try {
                    const cfg = await window.eel.get_stock_connection_config()();
                    if (cfg) {
                        if (inputClientId) inputClientId.value = cfg.client_id || '';
                        if (inputClientSecret) inputClientSecret.value = cfg.client_secret || '';
                        if (inputRelayUrl) inputRelayUrl.value = cfg.relay_url || '';
                        if (inputRelayToken) inputRelayToken.value = cfg.relay_token || '';
                        setStockConnectionMode(cfg.connection_mode === 'relay' ? 'relay' : 'local');
                        return;
                    }
                } catch (e) {
                    console.error('Failed to load stock connection config:', e);
                }
            }
            setStockConnectionMode(activeConnectionMode);
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
                const rUrl = inputRelayUrl ? inputRelayUrl.value.trim() : '';
                const rTok = inputRelayToken ? inputRelayToken.value.trim() : '';

                if (keyStatus) {
                    keyStatus.textContent = activeConnectionMode === 'relay'
                        ? '릴레이 서버 연결 확인 중...'
                        : '인증 검증 중...';
                    keyStatus.className = 'stock-key-status';
                }

                try {
                    let res = null;
                    if (window.eel && window.eel.save_stock_connection_config) {
                        res = await window.eel.save_stock_connection_config(activeConnectionMode, cid, csec, rUrl, rTok)();
                    } else if (window.eel && window.eel.save_stock_api_keys) {
                        res = await window.eel.save_stock_api_keys(cid, csec)();
                    }

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
                            keyStatus.textContent = (res && res.error) ? res.error : '연결/인증 실패';
                            keyStatus.className = 'stock-key-status error';
                        }
                    }
                } catch (err) {
                    if (keyStatus) {
                        keyStatus.textContent = '네트워크/서버 오류';
                        keyStatus.className = 'stock-key-status error';
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

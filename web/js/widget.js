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
    let dwellTimer = null;
    let collapseTimer = null;
    let dragOccurred = false;
    let pointerDownPos = { x: 0, y: 0 };
    let sysMetricInterval = null;

    // DOM Elements
    const body = document.body;
    const edgeHandle = document.getElementById('edge-handle');
    const widgetPanel = document.getElementById('widget-panel');
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

    // =========================================================================
    // 2. Hover Dwell & Gesture Mediation
    // =========================================================================

    let isPointerDown = false;

    if (edgeHandle) {
        // Hover Dwell (250ms)
        const startDwell = () => {
            if (isCollapsed() && !dwellTimer) {
                dwellTimer = setTimeout(() => {
                    dwellTimer = null;
                    expandWidget();
                }, 250);
            }
        };

        edgeHandle.addEventListener('mouseenter', startDwell);
        edgeHandle.addEventListener('mouseover', startDwell);

        edgeHandle.addEventListener('mouseleave', () => {
            if (dwellTimer) {
                clearTimeout(dwellTimer);
                dwellTimer = null;
            }
        });

        // Mousedown 취소 (드래그 제스처 시작 시 호버 확장 즉시 취소)
        edgeHandle.addEventListener('mousedown', (e) => {
            if (dwellTimer) {
                clearTimeout(dwellTimer);
                dwellTimer = null;
            }
            isPointerDown = true;
            pointerDownPos = { x: e.screenX, y: e.screenY };
            dragOccurred = false;
        });

        window.addEventListener('mousemove', (e) => {
            if (isPointerDown) {
                if (Math.abs(e.screenX - pointerDownPos.x) > 6 || Math.abs(e.screenY - pointerDownPos.y) > 6) {
                    dragOccurred = true;
                }
            }
        });

        window.addEventListener('mouseup', () => {
            isPointerDown = false;
        });

        // 클릭 토글 (드래그하지 않고 클릭했을 때 즉시 확장)
        edgeHandle.addEventListener('click', (e) => {
            if (dragOccurred) {
                dragOccurred = false;
                return;
            }
            expandWidget();
        });
    }


    // Auto-collapse on MouseLeave (400ms delay if not pinned)
    if (widgetPanel) {
        widgetPanel.addEventListener('mouseleave', () => {
            if (!isPinned && !isCollapsed()) {
                collapseTimer = setTimeout(() => {
                    collapseWidget();
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
    // 8. Initialization
    // =========================================================================

    document.addEventListener('DOMContentLoaded', () => {
        initMemo();
        // pywebview ready 대기
        window.addEventListener('pywebviewready', async () => {
            if (window.pywebview && window.pywebview.api) {
                try {
                    const info = await window.pywebview.api.get_state();
                    if (info && info.edge) {
                        window.onEdgeChanged(info.edge);
                    }
                } catch (e) {
                    console.error('Failed to fetch initial widget state:', e);
                }
            }
        });
    });
})();

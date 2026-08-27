/**
 * CSV / TSV / 테이블 데이터 뷰어 (CSV Data Viewer) 모듈
 * - 초고속 대용량 테이블 렌더링, 인코딩/구분자 자동 감지
 * - 정렬(Sort), 전역 검색/필터링(Search), 페이지네이션
 * - Markdown / JSON / SQL Insert / CSV 변환 및 내보내기
 */

let csvState = {
    headers: [],
    rows: [],
    fileName: '',
    filePath: '',
    fileSize: 0,
    encoding: 'utf-8',
    delimiter: ',',
    filteredRows: [],
    searchQuery: '',
    sortCol: null,
    sortDir: 'asc',
    currentPage: 1,
    pageSize: 100
};

// ==========================================
// 1. 초기화 및 이벤트 리스너 등록
// ==========================================
function initCsvViewer() {
    const dropZone = document.getElementById('csv-drop-zone');
    const tableContainer = document.getElementById('csv-table-container');

    // 드래그 앤 드롭 파일 로드 지원
    ['dragenter', 'dragover'].forEach(eventName => {
        dropZone?.addEventListener(eventName, (e) => {
            e.preventDefault();
            e.stopPropagation();
            dropZone.classList.add('drag-over');
        });
        tableContainer?.addEventListener(eventName, (e) => {
            e.preventDefault();
            e.stopPropagation();
        });
    });

    ['dragleave', 'drop'].forEach(eventName => {
        dropZone?.addEventListener(eventName, (e) => {
            e.preventDefault();
            e.stopPropagation();
            dropZone.classList.remove('drag-over');
        });
    });

    dropZone?.addEventListener('drop', handleCsvFileDrop);
    tableContainer?.addEventListener('drop', handleCsvFileDrop);

    // 붙여넣기 단축키(Ctrl+V) 이벤트 리스너 (CSV 탭 활성화 시)
    window.addEventListener('paste', handleCsvPasteEvent);
}

function handleCsvPasteEvent(e) {
    const csvTab = document.getElementById('tab-csv');
    if (!csvTab || !csvTab.classList.contains('active')) return;

    // 입력 필드나 textarea에 포커스가 있을 때는 기본 붙여넣기 동작 유지
    const activeEl = document.activeElement;
    if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA')) {
        return;
    }

    const text = (e.clipboardData || window.clipboardData)?.getData('text');
    if (text && text.trim()) {
        e.preventDefault();
        loadCsvFromText(text, '클립보드 데이터');
    }
}

// ==========================================
// 2. CSV 파일 및 데이터 로드 핸들러
// ==========================================
async function openCsvFileDialog() {
    try {
        if (window.eel && typeof eel.select_and_read_csv_file === 'function') {
            const res = await eel.select_and_read_csv_file()();
            if (res.status === 'success') {
                applyLoadedCsvData(res);
                logToConsole('CSV 파일 로드 완료', `${res.file_name} (총 ${res.total_rows.toLocaleString()}행, ${res.encoding})`);
            } else if (res.status === 'error') {
                await showAppAlert(res.message, 'CSV 로드 실패', '❌');
            }
        } else {
            // Web fallback: input[type=file]
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = '.csv,.tsv,.txt,.tab,.dat';
            input.onchange = (e) => {
                const file = e.target.files[0];
                if (file) handleBrowserFileSelect(file);
            };
            input.click();
        }
    } catch (e) {
        logToConsole('CSV 열기 오류', e.message || e);
    }
}

function handleBrowserFileSelect(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
        const text = e.target.result;
        loadCsvFromText(text, file.name, file.size);
    };
    reader.readAsText(file);
}

function handleCsvFileDrop(e) {
    e.preventDefault();
    e.stopPropagation();
    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;

    const file = files[0];
    const forcedEncoding = document.getElementById('csv-encoding-select')?.value || 'auto';
    const forcedDelimiter = document.getElementById('csv-delimiter-select')?.value || 'auto';

    // Eel 백엔드로 직접 파일 경로 전달 (가장 빠르고 인코딩 자동 감지)
    if (window.eel && typeof eel.read_csv_from_path === 'function' && file.path) {
        eel.read_csv_from_path(file.path, forcedEncoding, forcedDelimiter)().then(res => {
            if (res.status === 'success') {
                applyLoadedCsvData(res);
                logToConsole('CSV 드롭 로드 완료', `${res.file_name} (총 ${res.total_rows.toLocaleString()}행)`);
            } else {
                handleBrowserFileSelect(file);
            }
        }).catch(() => handleBrowserFileSelect(file));
    } else {
        handleBrowserFileSelect(file);
    }
}

async function pasteCsvFromClipboard() {
    try {
        const text = await navigator.clipboard.readText();
        if (!text || !text.trim()) {
            await showAppAlert('클립보드에 복사된 텍스트/표 데이터가 없습니다.', '알림', '⚠️');
            return;
        }
        loadCsvFromText(text, '클립보드 붙여넣기');
    } catch (e) {
        // 브라우저 권한 에러 시 프롬프트 대체
        const manualText = prompt('붙여넣을 CSV / TSV 텍스트를 입력해주세요:');
        if (manualText && manualText.trim()) {
            loadCsvFromText(manualText, '직접 입력 데이터');
        }
    }
}

async function loadCsvFromText(rawText, sourceName = '텍스트 데이터', fileSize = 0) {
    const forcedDelimiter = document.getElementById('csv-delimiter-select')?.value || 'auto';

    if (window.eel && typeof eel.parse_raw_csv_text === 'function') {
        const res = await eel.parse_raw_csv_text(rawText, forcedDelimiter)();
        if (res.status === 'success') {
            res.file_name = sourceName;
            if (fileSize) res.file_size = fileSize;
            applyLoadedCsvData(res);
            logToConsole('데이터 파싱 완료', `${sourceName} (총 ${res.total_rows.toLocaleString()}행)`);
        } else {
            await showAppAlert(res.message, '파싱 실패', '❌');
        }
    } else {
        // JS 클라이언트 파서 fallback
        const parsed = parseCsvClientSide(rawText, forcedDelimiter);
        applyLoadedCsvData({
            file_name: sourceName,
            file_path: '',
            file_size: fileSize || rawText.length,
            encoding: 'utf-8',
            delimiter: parsed.delimiter,
            headers: parsed.headers,
            rows: parsed.rows,
            total_rows: parsed.rows.length,
            total_cols: parsed.headers.length
        });
    }
}

// 순수 JavaScript CSV/TSV 파서 (줄바꿈 및 따옴표 셀 완벽 지원)
function parseCsvClientSide(text, forcedDelimiter = 'auto') {
    let delimiter = forcedDelimiter;
    if (!delimiter || delimiter === 'auto') {
        const firstLine = text.split('\n')[0] || '';
        const counts = { ',': (firstLine.match(/,/g) || []).length, '\t': (firstLine.match(/\t/g) || []).length, ';': (firstLine.match(/;/g) || []).length, '|': (firstLine.match(/\|/g) || []).length };
        delimiter = Object.keys(counts).reduce((a, b) => counts[a] > counts[b] ? a : b) || ',';
        if (counts[delimiter] === 0) delimiter = ',';
    }

    const rows = [];
    let row = [];
    let cell = '';
    let inQuotes = false;

    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        const next = text[i + 1];

        if (c === '"') {
            if (inQuotes && next === '"') {
                cell += '"';
                i++;
            } else {
                inQuotes = !inQuotes;
            }
        } else if (c === delimiter && !inQuotes) {
            row.push(cell);
            cell = '';
        } else if ((c === '\r' || c === '\n') && !inQuotes) {
            if (c === '\r' && next === '\n') i++;
            row.push(cell);
            if (row.some(val => val.trim() !== '')) {
                rows.push(row);
            }
            row = [];
            cell = '';
        } else {
            cell += c;
        }
    }
    if (cell || row.length > 0) {
        row.push(cell);
        if (row.some(val => val.trim() !== '')) {
            rows.push(row);
        }
    }

    if (rows.length === 0) return { headers: [], rows: [], delimiter };
    const headers = rows[0];
    const dataRows = rows.slice(1);
    return { headers, rows: dataRows, delimiter };
}

function applyLoadedCsvData(data) {
    csvState.headers = data.headers || [];
    csvState.rows = data.rows || [];
    csvState.fileName = data.file_name || 'untitled.csv';
    csvState.filePath = data.file_path || '';
    csvState.fileSize = data.file_size || 0;
    csvState.encoding = data.encoding || 'utf-8';
    csvState.delimiter = data.delimiter || ',';
    csvState.searchQuery = '';
    csvState.sortCol = null;
    csvState.sortDir = 'asc';
    csvState.currentPage = 1;

    // 검색창 초기화
    const searchInput = document.getElementById('csv-search-input');
    if (searchInput) searchInput.value = '';

    // 구분자 선택박스 동기화
    const delSelect = document.getElementById('csv-delimiter-select');
    if (delSelect && data.delimiter) {
        delSelect.value = data.delimiter;
    }

    applyFilterAndSort();
}

// ==========================================
// 3. 샘플 데이터셋 로드
// ==========================================
function loadSampleCsvData() {
    const sampleHeaders = ["주문번호", "고객명", "상품명", "카테고리", "단가", "수량", "총결제금액", "결제수단", "주문상태", "주문일시"];
    const sampleRows = [
        ["ORD-20260825-001", "김민준", "무선 노이즈캔슬링 헤드폰 Pro", "전자기기", "289,000", "1", "289,000", "신용카드", "배송완료", "2026-08-25 09:15:20"],
        ["ORD-20260825-002", "이서연", "인체공학 버티컬 마우스", "주변기기", "45,000", "2", "90,000", "네이버페이", "배송중", "2026-08-25 09:32:11"],
        ["ORD-20260825-003", "박도윤", "4K UHD 32인치 모니터", "디스플레이", "450,000", "1", "450,000", "카카오페이", "결제완료", "2026-08-25 10:02:45"],
        ["ORD-20260825-004", "최지우", "기계식 갈축 게이밍 키보드", "주변기기", "128,000", "1", "128,000", "토스페이", "배송완료", "2026-08-25 10:14:02"],
        ["ORD-20260825-005", "정예준", "USB-C 고속 멀티허브 8in1", "악세서리", "38,500", "3", "115,500", "신용카드", "배송중", "2026-08-25 10:45:33"],
        ["ORD-20260825-006", "한서아", "알루미늄 노트북 거치대", "악세서리", "29,000", "1", "29,000", "계좌이체", "배송완료", "2026-08-25 11:10:08"],
        ["ORD-20260825-007", "윤시우", "GaN 65W 초고속 충전기", "충전기기", "24,000", "2", "48,000", "네이버페이", "결제완료", "2026-08-25 11:40:19"],
        ["ORD-20260825-008", "임지아", "대용량 NVMe M.2 SSD 2TB", "저장장치", "195,000", "1", "195,000", "신용카드", "배송중", "2026-08-25 12:05:55"],
        ["ORD-20260825-009", "강하준", "블루투스 기계식 텐키리스", "주변기기", "145,000", "1", "145,000", "카카오페이", "배송완료", "2026-08-25 12:30:12"],
        ["ORD-20260825-010", "오유진", "마그네틱 맥세이프 보조배터리", "충전기기", "42,000", "1", "42,000", "토스페이", "주문취소", "2026-08-25 13:00:40"],
        ["ORD-20260825-011", "조현우", "초경량 마그네슘 무선마우스", "주변기기", "89,000", "1", "89,000", "신용카드", "결제완료", "2026-08-25 13:25:18"],
        ["ORD-20260825-012", "송수아", "모니터 싱글 암 거치대", "악세서리", "55,000", "1", "55,000", "네이버페이", "배송완료", "2026-08-25 13:50:04"],
        ["ORD-20260825-013", "배주원", "데스크 매트 방수 가죽장패드", "악세서리", "19,800", "2", "39,600", "카카오페이", "배송중", "2026-08-25 14:15:30"],
        ["ORD-20260825-014", "유서진", "웹캠 4K 60FPS 스트리밍용", "전자기기", "135,000", "1", "135,000", "신용카드", "결제완료", "2026-08-25 14:40:50"],
        ["ORD-20260825-015", "안채원", "외장형 HDD 4TB 백업드라이브", "저장장치", "125,000", "1", "125,000", "토스페이", "배송완료", "2026-08-25 15:02:11"]
    ];

    applyLoadedCsvData({
        file_name: "2026_쇼핑몰_실시간_주문내역_샘플.csv",
        file_path: "",
        file_size: 1540,
        encoding: "utf-8",
        delimiter: ",",
        headers: sampleHeaders,
        rows: sampleRows,
        total_rows: sampleRows.length,
        total_cols: sampleHeaders.length
    });

    logToConsole('샘플 데이터 로드', '이커머스 실시간 주문 내역 15건이 로드되었습니다.');
}

function clearCsvViewer() {
    csvState.headers = [];
    csvState.rows = [];
    csvState.filteredRows = [];
    csvState.fileName = '';
    csvState.filePath = '';
    csvState.fileSize = 0;
    csvState.searchQuery = '';
    csvState.sortCol = null;
    csvState.currentPage = 1;

    const searchInput = document.getElementById('csv-search-input');
    if (searchInput) searchInput.value = '';

    renderCsvTable();
    updateCsvStats();
    logToConsole('CSV 뷰어 초기화', '데이터가 비워졌습니다.');
}

// ==========================================
// 4. 검색 & 정렬 & 필터링 로직 (디바운스 200ms)
// ==========================================
let csvSearchDebounceTimer = null;

function onCsvSearchInput(val) {
    const trimmed = (val || '').trim().toLowerCase();
    const clearBtn = document.getElementById('csv-search-clear-btn');
    if (clearBtn) {
        clearBtn.style.display = trimmed ? 'inline-block' : 'none';
    }

    clearTimeout(csvSearchDebounceTimer);
    if (!trimmed) {
        csvState.searchQuery = '';
        csvState.currentPage = 1;
        applyFilterAndSort();
        return;
    }

    csvSearchDebounceTimer = setTimeout(() => {
        csvState.searchQuery = trimmed;
        csvState.currentPage = 1;
        applyFilterAndSort();
    }, 200);
}

function clearCsvSearch() {
    clearTimeout(csvSearchDebounceTimer);
    const searchInput = document.getElementById('csv-search-input');
    if (searchInput) searchInput.value = '';
    onCsvSearchInput('');
    if (searchInput) searchInput.focus();
}

function sortCsvByColumn(colIndex) {
    if (csvState.sortCol === colIndex) {
        csvState.sortDir = csvState.sortDir === 'asc' ? 'desc' : 'asc';
    } else {
        csvState.sortCol = colIndex;
        csvState.sortDir = 'asc';
    }

    applyFilterAndSort();
}

function applyFilterAndSort() {
    let list = csvState.rows.slice();

    // 1) 전체 텍스트 검색 필터
    if (csvState.searchQuery) {
        const q = csvState.searchQuery;
        list = list.filter(row => {
            return row.some(cell => String(cell || '').toLowerCase().includes(q));
        });
    }

    // 2) 컬럼 정렬 (숫자/통화/날짜/문자열 자동 인식)
    if (csvState.sortCol !== null && csvState.sortCol >= 0) {
        const col = csvState.sortCol;
        const dir = csvState.sortDir === 'asc' ? 1 : -1;

        list.sort((a, b) => {
            const valA = String(a[col] || '').trim();
            const valB = String(b[col] || '').trim();

            // 콤마 제거 숫자 비교 (예: "1,250" -> 1250)
            const numA = Number(valA.replace(/,/g, ''));
            const numB = Number(valB.replace(/,/g, ''));
            if (!isNaN(numA) && !isNaN(numB) && valA !== '' && valB !== '') {
                return (numA - numB) * dir;
            }

            // 문자열 localeCompare
            return valA.localeCompare(valB, undefined, { numeric: true, sensitivity: 'base' }) * dir;
        });
    }

    csvState.filteredRows = list;
    renderCsvTable();
    updateCsvStats();
}

// ==========================================
// 5. 페이지네이션 제어
// ==========================================
function changeCsvPageSize(val) {
    csvState.pageSize = val === 'all' ? 9999999 : parseInt(val, 10) || 100;
    csvState.currentPage = 1;
    renderCsvTable();
    updateCsvStats();
}

function goToCsvPage(page) {
    const totalPages = Math.max(1, Math.ceil(csvState.filteredRows.length / csvState.pageSize));
    csvState.currentPage = Math.max(1, Math.min(totalPages, page));
    renderCsvTable();
    updateCsvStats();
}

function prevCsvPage() {
    if (csvState.currentPage > 1) {
        goToCsvPage(csvState.currentPage - 1);
    }
}

function nextCsvPage() {
    const totalPages = Math.max(1, Math.ceil(csvState.filteredRows.length / csvState.pageSize));
    if (csvState.currentPage < totalPages) {
        goToCsvPage(csvState.currentPage + 1);
    }
}

// ==========================================
// 6. UI 테이블 렌더링
// ==========================================
function renderCsvTable() {
    const dropZone = document.getElementById('csv-drop-zone');
    const tableWrapper = document.getElementById('csv-table-wrapper');
    const tableEl = document.getElementById('csv-main-table');
    const paginationBar = document.getElementById('csv-pagination-bar');

    if (!csvState.headers || csvState.headers.length === 0) {
        if (dropZone) dropZone.style.display = 'flex';
        if (tableWrapper) tableWrapper.style.display = 'none';
        if (paginationBar) paginationBar.style.display = 'none';
        return;
    }

    if (dropZone) dropZone.style.display = 'none';
    if (tableWrapper) tableWrapper.style.display = 'block';
    if (paginationBar) paginationBar.style.display = 'flex';

    // 페이지네이션 슬라이스
    const totalRows = csvState.filteredRows.length;
    const pageSize = csvState.pageSize;
    const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
    const startIdx = (csvState.currentPage - 1) * pageSize;
    const pageRows = csvState.filteredRows.slice(startIdx, startIdx + pageSize);

    // 1) Thead 렌더링
    let theadHtml = '<thead><tr>';
    theadHtml += '<th class="csv-th-index">#</th>';

    csvState.headers.forEach((header, idx) => {
        let sortIcon = '↕️';
        let sortClass = '';
        if (csvState.sortCol === idx) {
            sortIcon = csvState.sortDir === 'asc' ? '▲' : '▼';
            sortClass = 'sorted';
        }
        theadHtml += `
            <th class="${sortClass}" onclick="sortCsvByColumn(${idx})" title="'${escapeHtml(header)}' 기준 정렬">
                <div class="th-content">
                    <span class="th-title">${escapeHtml(header)}</span>
                    <span class="th-sort-icon">${sortIcon}</span>
                </div>
            </th>
        `;
    });
    theadHtml += '</tr></thead>';

    // 2) Tbody 렌더링
    let tbodyHtml = '<tbody>';
    if (pageRows.length === 0) {
        tbodyHtml += `
            <tr>
                <td colspan="${csvState.headers.length + 1}" class="csv-empty-cell">
                    검색 결과와 일치하는 데이터가 없습니다. (검색어: "${escapeHtml(csvState.searchQuery)}")
                </td>
            </tr>
        `;
    } else {
        const query = csvState.searchQuery;
        pageRows.forEach((row, rIdx) => {
            const rowNum = startIdx + rIdx + 1;
            tbodyHtml += `<tr><td class="csv-td-index">${rowNum}</td>`;
            
            row.forEach((cell) => {
                const rawVal = cell !== undefined && cell !== null ? String(cell) : '';
                let displayVal = escapeHtml(rawVal);

                // 검색어 하이라이팅
                if (query && displayVal.toLowerCase().includes(query)) {
                    const regex = new RegExp(`(${query.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')})`, 'gi');
                    displayVal = displayVal.replace(regex, '<mark class="csv-highlight">$1</mark>');
                }

                // 숫자형태 우측 정렬 클래스 판단
                const isNumeric = rawVal.trim() !== '' && !isNaN(Number(rawVal.replace(/,/g, '')));
                const alignClass = isNumeric ? 'class="cell-number"' : '';

                tbodyHtml += `<td ${alignClass} title="${escapeHtml(rawVal)}">${displayVal}</td>`;
            });
            tbodyHtml += '</tr>';
        });
    }
    tbodyHtml += '</tbody>';

    if (tableEl) {
        tableEl.innerHTML = theadHtml + tbodyHtml;
    }

    // 3) 페이지네이션 버튼 갱신
    const pageIndicator = document.getElementById('csv-page-indicator');
    const prevBtn = document.getElementById('csv-prev-page-btn');
    const nextBtn = document.getElementById('csv-next-page-btn');

    if (pageIndicator) {
        pageIndicator.textContent = `${csvState.currentPage} / ${totalPages} 페이지`;
    }
    if (prevBtn) prevBtn.disabled = csvState.currentPage <= 1;
    if (nextBtn) nextBtn.disabled = csvState.currentPage >= totalPages;
}

function updateCsvStats() {
    const statsEl = document.getElementById('csv-stats-summary');
    const fileBadge = document.getElementById('csv-file-badge');

    const total = csvState.rows.length;
    const filtered = csvState.filteredRows.length;
    const cols = csvState.headers.length;

    if (statsEl) {
        if (total === 0) {
            statsEl.innerHTML = `<span>📊 데이터 없음</span>`;
        } else if (csvState.searchQuery) {
            statsEl.innerHTML = `<span>📊 총 <b>${total.toLocaleString()}</b>행 × <b>${cols}</b>열 (필터 일치: <b>${filtered.toLocaleString()}</b>행)</span>`;
        } else {
            statsEl.innerHTML = `<span>📊 총 <b>${total.toLocaleString()}</b>행 × <b>${cols}</b>열</span>`;
        }
    }

    if (fileBadge) {
        if (csvState.fileName) {
            const sizeStr = csvState.fileSize > 0 ? ` (${(csvState.fileSize / 1024).toFixed(1)} KB)` : '';
            fileBadge.textContent = `📁 ${csvState.fileName}${sizeStr}`;
            fileBadge.style.display = 'inline-flex';
        } else {
            fileBadge.style.display = 'none';
        }
    }
}

// ==========================================
// 7. 데이터 변환 & 내보내기 (Export Studio)
// ==========================================
async function copyCsvAsMarkdown() {
    if (!csvState.headers || csvState.headers.length === 0) {
        await showAppAlert('내보낼 데이터가 없습니다.', '알림', '⚠️');
        return;
    }

    const rowsToExport = csvState.filteredRows;
    const headers = csvState.headers;

    const colWidths = headers.map((h, i) => {
        let maxLen = Math.max(h.length, 3);
        rowsToExport.forEach(r => {
            const cellLen = String(r[i] || '').length;
            if (cellLen > maxLen) maxLen = Math.min(cellLen, 40);
        });
        return maxLen;
    });

    let md = '| ' + headers.map((h, i) => h.padEnd(colWidths[i])).join(' | ') + ' |\n';
    md += '| ' + colWidths.map(w => '-'.repeat(w)).join(' | ') + ' |\n';

    rowsToExport.forEach(r => {
        md += '| ' + headers.map((_, i) => String(r[i] || '').padEnd(colWidths[i])).join(' | ') + ' |\n';
    });

    await navigator.clipboard.writeText(md);
    logToConsole('Markdown 변환 복사 완료', `총 ${rowsToExport.length}행의 Markdown 테이블이 복사되었습니다.`);
    showToast('복사 완료', `총 ${rowsToExport.length.toLocaleString()}행의 Markdown 테이블 코드가 복사되었습니다! 📋`, '✅');
}

async function copyCsvAsJson() {
    if (!csvState.headers || csvState.headers.length === 0) {
        await showAppAlert('내보낼 데이터가 없습니다.', '알림', '⚠️');
        return;
    }

    const rowsToExport = csvState.filteredRows;
    const headers = csvState.headers;

    const jsonArray = rowsToExport.map(row => {
        const obj = {};
        headers.forEach((h, idx) => {
            const val = row[idx];
            const num = Number(val);
            if (!isNaN(num) && val !== '' && !val.startsWith('0')) {
                obj[h] = num;
            } else if (val === 'true' || val === 'TRUE') {
                obj[h] = true;
            } else if (val === 'false' || val === 'FALSE') {
                obj[h] = false;
            } else {
                obj[h] = val || '';
            }
        });
        return obj;
    });

    const jsonStr = JSON.stringify(jsonArray, null, 2);
    await navigator.clipboard.writeText(jsonStr);
    logToConsole('JSON 변환 복사 완료', `총 ${rowsToExport.length}개 객체 배열이 복사되었습니다.`);
    showToast('복사 완료', `총 ${rowsToExport.length.toLocaleString()}개 레코드의 JSON 배열이 복사되었습니다! 📋`, '✅');
}

async function copyCsvAsSqlInsert() {
    if (!csvState.headers || csvState.headers.length === 0) {
        await showAppAlert('내보낼 데이터가 없습니다.', '알림', '⚠️');
        return;
    }

    const defaultTable = csvState.fileName.replace(/\.[^/.]+$/, "").replace(/[^a-zA-Z0-9_]/g, "_") || "my_table";
    const tableName = prompt("생성할 SQL 테이블명을 입력하세요:", defaultTable) || defaultTable;

    const rowsToExport = csvState.filteredRows;
    const headers = csvState.headers.map(h => `\`${h.replace(/`/g, '')}\``).join(', ');

    let sql = `/* Table: ${tableName} (Total ${rowsToExport.length} Rows) */\n`;
    rowsToExport.forEach(row => {
        const values = row.map(val => {
            if (val === null || val === undefined || val === '') return 'NULL';
            const num = Number(val);
            if (!isNaN(num) && !String(val).startsWith('0')) return num;
            return `'${String(val).replace(/'/g, "''")}'`;
        }).join(', ');

        sql += `INSERT INTO \`${tableName}\` (${headers}) VALUES (${values});\n`;
    });

    await navigator.clipboard.writeText(sql);
    logToConsole('SQL Insert 생성 완료', `${tableName} 테이블용 INSERT 쿼리가 클립보드에 복사되었습니다.`);
    showToast('복사 완료', `${tableName} 테이블용 SQL INSERT 문(${rowsToExport.length.toLocaleString()}건)이 복사되었습니다! 💾`, '✅');
}

async function downloadFilteredCsv() {
    if (!csvState.headers || csvState.headers.length === 0) {
        await showAppAlert('내보낼 데이터가 없습니다.', '알림', '⚠️');
        return;
    }

    const rowsToExport = csvState.filteredRows;
    const headers = csvState.headers;
    const delimiter = csvState.delimiter || ',';

    const escapeCell = (c) => {
        const s = String(c || '');
        if (s.includes(delimiter) || s.includes('"') || s.includes('\n') || s.includes('\r')) {
            return `"${s.replace(/"/g, '""')}"`;
        }
        return s;
    };

    let csvContent = headers.map(escapeCell).join(delimiter) + '\n';
    rowsToExport.forEach(row => {
        csvContent += row.map(escapeCell).join(delimiter) + '\n';
    });

    const exportName = `filtered_${csvState.fileName || 'export.csv'}`;

    if (window.eel && typeof eel.save_csv_to_file === 'function') {
        const res = await eel.save_csv_to_file(csvContent, exportName)();
        if (res && res.status === 'success') {
            logToConsole('CSV 파일 저장 완료', res.path);
            showToast('저장 완료', `CSV 파일이 안전하게 저장되었습니다! 💾\n(${res.path})`, '✅');
        }
    } else {
        // 브라우저 다운로드 fallback
        const blob = new Blob(['\uFEFF' + csvContent], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = exportName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }
}

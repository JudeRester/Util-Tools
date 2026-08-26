/**
 * 엑셀 및 모의 데이터(Mock Data) 대량 생성 스튜디오 모듈
 * - 한국인 이름, 전화번호, 이메일(커스텀 도메인 지정), 사용자 정의 문자열 목록(부서/직급/직책 등)
 * - 연계 키-값(Key-Value) 매핑: 부서:부서코드, 직급:직급코드, 결제수단:결제코드 등 종속 컬럼 완벽 연동
 * - 커스텀 템플릿 양식 SQLite 영구 저장, 불러오기 및 관리 기능
 * - 실시간 테이블 미리보기, openpyxl 기반 .xlsx 엑셀 다운로드, CSV 내보내기 지원
 */

let mockStudioSchema = [];
let currentMockPreviewRows = [];
let customMockTemplates = [];
let activeCustomTemplateId = null;

// ==========================================
// 1. 기본 시스템 프리셋 템플릿 정의
// ==========================================
const MOCK_PRESETS = {
    employee: {
        title: "임직원 / 인사 명부",
        filename: "임직원_명부",
        schema: [
            { id: "col_1", name: "사번", type: "sequence", options: { prefix: "EMP-", start_num: 1001, padding: 4 } },
            { id: "col_2", name: "이름", type: "name", options: { gender: "any" } },
            { id: "col_3", name: "부서명", type: "choices", options: { choices: "스마트개발팀, 웹서비스팀, AI연구팀, 품질보증팀, 경영기획팀, 인사총무팀, 영업마케팅팀" } },
            { id: "col_4", name: "부서코드", type: "key_value", options: { target_column: "부서명", output_part: "value", mapping: "스마트개발팀:DEV, 웹서비스팀:WEB, AI연구팀:AI, 품질보증팀:QA, 경영기획팀:MGT, 인사총무팀:HR, 영업마케팅팀:SAL" } },
            { id: "col_5", name: "직급", type: "choices", options: { choices: "사원, 주임, 선임연구원, 책임연구원, 수석연구원, 팀장" } },
            { id: "col_6", name: "직급코드", type: "key_value", options: { target_column: "직급", output_part: "value", mapping: "사원:J1, 주임:J2, 선임연구원:S1, 책임연구원:S2, 수석연구원:P1, 팀장:L1" } },
            { id: "col_7", name: "직책", type: "choices", options: { choices: "팀원, 파트장, 팀장, 실장" } },
            { id: "col_8", name: "이메일", type: "email", options: { domains: "cuchen.com" } },
            { id: "col_9", name: "연락처", type: "phone", options: { format: "010-XXXX-XXXX" } },
            { id: "col_10", name: "입사일", type: "date", options: { start_year: 2021, end_year: 2026, format: "%Y-%m-%d" } },
            { id: "col_11", name: "재직상태", type: "choices", options: { choices: "재직, 재택근무, 휴직" } },
            { id: "col_12", name: "기본급여", type: "number", options: { min: 3500000, max: 7500000, step: 100000 } }
        ]
    },
    customer: {
        title: "고객 / 회원 목록",
        filename: "회원목록",
        schema: [
            { id: "col_1", name: "회원번호", type: "sequence", options: { prefix: "CUST-", start_num: 10001, padding: 5 } },
            { id: "col_2", name: "고객명", type: "name", options: { gender: "any" } },
            { id: "col_3", name: "성별", type: "choices", options: { choices: "남성, 여성" } },
            { id: "col_4", name: "나이", type: "number", options: { min: 22, max: 62, step: 1 } },
            { id: "col_5", name: "이메일", type: "email", options: { domains: "gmail.com, naver.com, kakao.com" } },
            { id: "col_6", name: "휴대폰번호", type: "phone", options: { format: "010-XXXX-XXXX" } },
            { id: "col_7", name: "거주지주소", type: "address", options: { city: "" } },
            { id: "col_8", name: "가입일", type: "date", options: { start_year: 2022, end_year: 2026, format: "%Y-%m-%d" } },
            { id: "col_9", name: "회원등급", type: "choices", options: { choices: "VIP, GOLD, SILVER, BRONZE, 일반" } },
            { id: "col_10", name: "등급코드", type: "key_value", options: { target_column: "회원등급", output_part: "value", mapping: "VIP:LV5, GOLD:LV4, SILVER:LV3, BRONZE:LV2, 일반:LV1" } },
            { id: "col_11", name: "적립포인트", type: "number", options: { min: 500, max: 80000, step: 500 } }
        ]
    },
    partner: {
        title: "거래처 / 파트너사 목록",
        filename: "거래처_목록",
        schema: [
            { id: "col_1", name: "거래처코드", type: "sequence", options: { prefix: "VD-", start_num: 101, padding: 3 } },
            { id: "col_2", name: "상호명", type: "company", options: {} },
            { id: "col_3", name: "대표자", type: "name", options: { gender: "any" } },
            { id: "col_4", name: "사업자등록번호", type: "biz_no", options: {} },
            { id: "col_5", name: "업태종목", type: "choices", options: { choices: "제조업/생활가전, 도소매/전자상거래, 정보통신업/소프트웨어, 서비스업/물류" } },
            { id: "col_6", name: "담당자명", type: "name", options: { gender: "any" } },
            { id: "col_7", name: "담당자이메일", type: "email", options: { domains: "partner.co.kr, vendor.com" } },
            { id: "col_8", name: "대표연락처", type: "phone", options: { format: "02-XXX-XXXX" } },
            { id: "col_9", name: "거래상태", type: "choices", options: { choices: "정상거래, 신규계약, 심사중, 거래보류" } },
            { id: "col_10", name: "상태코드", type: "key_value", options: { target_column: "거래상태", output_part: "value", mapping: "정상거래:ACT, 신규계약:NEW, 심사중:REV, 거래보류:HOLD" } }
        ]
    },
    order: {
        title: "주문 / 결제 내역",
        filename: "주문내역",
        schema: [
            { id: "col_1", name: "주문번호", type: "sequence", options: { prefix: "ORD-2026-", start_num: 1001, padding: 4 } },
            { id: "col_2", name: "주문일시", type: "date", options: { start_year: 2026, end_year: 2026, format: "%Y-%m-%d" } },
            { id: "col_3", name: "구매자명", type: "name", options: { gender: "any" } },
            { id: "col_4", name: "상품명", type: "product", options: {} },
            { id: "col_5", name: "수량", type: "number", options: { min: 1, max: 4, step: 1 } },
            { id: "col_6", name: "결제금액", type: "number", options: { min: 45000, max: 690000, step: 1000 } },
            { id: "col_7", name: "결제수단", type: "choices", options: { choices: "신용카드, 카카오페이, 네이버페이, 계좌이체, 무통장입금" } },
            { id: "col_8", name: "결제코드", type: "key_value", options: { target_column: "결제수단", output_part: "value", mapping: "신용카드:CARD, 카카오페이:KPAY, 네이버페이:NPAY, 계좌이체:BANK, 무통장입금:VBANK" } },
            { id: "col_9", name: "배송상태", type: "choices", options: { choices: "결제완료, 배송준비중, 배송중, 배송완료, 구매확정" } },
            { id: "col_10", name: "배송코드", type: "key_value", options: { target_column: "배송상태", output_part: "value", mapping: "결제완료:PAID, 배송준비중:PREP, 배송중:SHIP, 배송완료:DONE, 구매확정:CONFIRM" } }
        ]
    }
};

// ==========================================
// 2. 초기화 및 서브탭 제어
// ==========================================
async function initMockDataStudio() {
    loadMockPreset('employee');
    await loadCustomMockTemplates();
}

function switchGenSubTab(subTab) {
    const singleBtn = document.getElementById('gen-subtab-single-btn');
    const excelBtn = document.getElementById('gen-subtab-excel-btn');
    const singlePane = document.getElementById('gen-pane-single');
    const excelPane = document.getElementById('gen-pane-excel');

    if (subTab === 'excel') {
        singleBtn?.classList.remove('active');
        excelBtn?.classList.add('active');
        if (singlePane) singlePane.style.display = 'none';
        if (excelPane) excelPane.style.display = 'block';

        if (mockStudioSchema.length === 0) {
            initMockDataStudio();
        }
    } else {
        excelBtn?.classList.remove('active');
        singleBtn?.classList.add('active');
        if (excelPane) excelPane.style.display = 'none';
        if (singlePane) singlePane.style.display = 'block';
    }
}

// 시스템 기본 프리셋 로드
function loadMockPreset(presetKey) {
    activeCustomTemplateId = null;
    document.querySelectorAll('.mock-preset-chip').forEach(chip => {
        chip.classList.toggle('active', chip.getAttribute('data-preset') === presetKey);
    });

    if (presetKey === 'empty') {
        mockStudioSchema = [
            { id: `col_${Date.now()}_1`, name: "부서명", type: "choices", options: { choices: "스마트개발팀, 웹서비스팀, AI연구팀, 품질보증팀" } },
            { id: `col_${Date.now()}_2`, name: "부서코드", type: "key_value", options: { target_column: "부서명", output_part: "value", mapping: "스마트개발팀:DEV, 웹서비스팀:WEB, AI연구팀:AI, 품질보증팀:QA" } },
            { id: `col_${Date.now()}_3`, name: "이름", type: "name", options: { gender: "any" } },
            { id: `col_${Date.now()}_4`, name: "이메일", type: "email", options: { domains: "cuchen.com" } }
        ];
    } else if (MOCK_PRESETS[presetKey]) {
        mockStudioSchema = JSON.parse(JSON.stringify(MOCK_PRESETS[presetKey].schema));
    }

    renderCustomPresetChips();
    renderMockSchemaBuilder();
    triggerMockPreview();
}

// ==========================================
// 3. 커스텀 템플릿(양식) 로드/저장/삭제
// ==========================================
async function loadCustomMockTemplates() {
    try {
        if (window.eel && typeof eel.get_custom_mock_templates === 'function') {
            const res = await eel.get_custom_mock_templates()();
            if (res.status === 'success') {
                customMockTemplates = res.templates || [];
                renderCustomPresetChips();
            }
        }
    } catch (e) {
        console.error("커스텀 템플릿 목록 로드 실패:", e);
    }
}

function renderCustomPresetChips() {
    const container = document.getElementById('mock-custom-presets-list');
    if (!container) return;

    if (customMockTemplates.length === 0) {
        container.innerHTML = `<span class="mock-no-custom-tip">(저장된 커스텀 양식이 없습니다)</span>`;
        return;
    }

    container.innerHTML = customMockTemplates.map(tpl => {
        const isActive = activeCustomTemplateId === tpl.id;
        const icon = tpl.icon || '⭐';
        return `
            <div class="mock-custom-chip-wrap">
                <button type="button" class="mock-preset-chip custom ${isActive ? 'active' : ''}" 
                        onclick="loadCustomTemplate('${tpl.id}')" title="${escapeHtml(tpl.description || tpl.title)}">
                    <span class="custom-chip-icon">${icon}</span>
                    <span class="custom-chip-title">${escapeHtml(tpl.title)}</span>
                    <span class="custom-chip-del" onclick="event.stopPropagation(); deleteCustomTemplate('${tpl.id}', '${escapeHtmlAttr(tpl.title)}')" title="템플릿 삭제">&times;</span>
                </button>
            </div>
        `;
    }).join('');
}

function loadCustomTemplate(tplId) {
    const tpl = customMockTemplates.find(t => t.id === tplId);
    if (!tpl || !tpl.schema) return;

    activeCustomTemplateId = tplId;
    document.querySelectorAll('.mock-preset-chip:not(.custom)').forEach(chip => {
        chip.classList.remove('active');
    });

    mockStudioSchema = JSON.parse(JSON.stringify(tpl.schema));
    renderCustomPresetChips();
    renderMockSchemaBuilder();
    triggerMockPreview();

    showAppToast(`"${tpl.title}" 커스텀 템플릿을 불러왔습니다! 📋`, "success");
}

function openSaveTemplateModal() {
    if (mockStudioSchema.length === 0) {
        showAppAlert("저장할 컬럼이 최소 1개 이상 필요합니다.", "알림", "⚠️");
        return;
    }

    const modal = document.getElementById('modal-save-mock-template');
    const titleInput = document.getElementById('mock-tpl-title-input');
    const descInput = document.getElementById('mock-tpl-desc-input');
    const summaryEl = document.getElementById('mock-tpl-save-summary');

    if (titleInput) titleInput.value = '';
    if (descInput) descInput.value = '';

    if (summaryEl) {
        const colNames = mockStudioSchema.map(c => c.name).join(', ');
        summaryEl.innerHTML = `
            <span class="mock-summary-count">총 ${mockStudioSchema.length}개 컬럼 저장</span>
            <span class="mock-summary-names">(${escapeHtml(colNames)})</span>
        `;
    }

    if (modal) {
        modal.style.display = 'flex';
        titleInput?.focus();
    }
}

function closeSaveTemplateModal() {
    const modal = document.getElementById('modal-save-mock-template');
    if (modal) modal.style.display = 'none';
}

async function submitSaveTemplate() {
    const titleInput = document.getElementById('mock-tpl-title-input');
    const descInput = document.getElementById('mock-tpl-desc-input');
    const selectedIcon = document.querySelector('input[name="mock-tpl-icon"]:checked')?.value || '⭐';

    const title = titleInput?.value?.trim();
    const desc = descInput?.value?.trim() || '';

    if (!title) {
        showAppAlert("템플릿 이름을 입력해주세요.", "알림", "⚠️");
        titleInput?.focus();
        return;
    }

    try {
        if (window.eel && typeof eel.save_custom_mock_template === 'function') {
            const res = await eel.save_custom_mock_template(title, desc, mockStudioSchema, null, selectedIcon)();
            if (res.status === 'success') {
                closeSaveTemplateModal();
                await loadCustomMockTemplates();
                if (res.template_id) {
                    loadCustomTemplate(res.template_id);
                }
                showAppToast(`"${title}" 템플릿이 성공적으로 저장되었습니다! 💾`, "success");
            } else {
                showAppAlert(`저장 실패: ${res.message}`, "오류", "❌");
            }
        }
    } catch (e) {
        console.error("템플릿 저장 오류:", e);
        showAppAlert(`템플릿 저장 중 오류가 발생했습니다: ${e.message}`, "오류", "❌");
    }
}

async function deleteCustomTemplate(tplId, tplTitle) {
    const confirmed = confirm(`"${tplTitle}" 템플릿을 삭제하시겠습니까?`);
    if (!confirmed) return;

    try {
        if (window.eel && typeof eel.delete_custom_mock_template === 'function') {
            const res = await eel.delete_custom_mock_template(tplId)();
            if (res.status === 'success') {
                if (activeCustomTemplateId === tplId) {
                    activeCustomTemplateId = null;
                }
                await loadCustomMockTemplates();
                showAppToast(`"${tplTitle}" 템플릿이 삭제되었습니다.`, "info");
            } else {
                showAppAlert(`삭제 실패: ${res.message}`, "오류", "❌");
            }
        }
    } catch (e) {
        console.error("템플릿 삭제 오류:", e);
    }
}

// ==========================================
// 4. 스키마(컬럼) 빌더 렌더링
// ==========================================
function renderMockSchemaBuilder() {
    const listEl = document.getElementById('mock-schema-columns-list');
    const countEl = document.getElementById('mock-column-count-badge');
    if (!listEl) return;

    if (countEl) countEl.textContent = `${mockStudioSchema.length}개 컬럼`;

    if (mockStudioSchema.length === 0) {
        listEl.innerHTML = `
            <div class="mock-schema-empty">
                <p>정의된 컬럼이 없습니다. 위의 프리셋을 선택하거나 [+ 새 컬럼 추가]를 눌러주세요.</p>
            </div>
        `;
        return;
    }

    listEl.innerHTML = mockStudioSchema.map((col, idx) => {
        const typeOptionsHtml = getColumnTypeOptionsHtml(col);
        return `
            <div class="mock-column-row" id="mock-col-row-${col.id}">
                <div class="mock-col-seq">${idx + 1}</div>
                <div class="mock-col-field mock-col-name-wrap">
                    <label class="mock-field-label">컬럼명</label>
                    <input type="text" class="mock-col-input mock-name-input" value="${escapeHtml(col.name)}" 
                           placeholder="컬럼명 (예: 부서, 이메일)" oninput="updateColumnName('${col.id}', this.value)">
                </div>
                <div class="mock-col-field mock-col-type-wrap">
                    <label class="mock-field-label">데이터 유형</label>
                    <select class="mock-col-select" onchange="updateColumnType('${col.id}', this.value)">
                        <option value="name" ${col.type === 'name' ? 'selected' : ''}>👤 한국인 이름</option>
                        <option value="choices" ${col.type === 'choices' ? 'selected' : ''}>🔘 사용자 지정 목록 (문자열 리스트)</option>
                        <option value="key_value" ${col.type === 'key_value' ? 'selected' : ''}>🔗 연계 키-값 (부서:코드 등 Key-Value 매핑)</option>
                        <option value="email" ${col.type === 'email' ? 'selected' : ''}>📧 이메일 (도메인 지정)</option>
                        <option value="phone" ${col.type === 'phone' ? 'selected' : ''}>📞 전화번호 (010)</option>
                        <option value="date" ${col.type === 'date' ? 'selected' : ''}>📅 날짜/일시</option>
                        <option value="number" ${col.type === 'number' ? 'selected' : ''}>💰 금액 / 숫자</option>
                        <option value="sequence" ${col.type === 'sequence' ? 'selected' : ''}>🔢 일련번호 (Auto ID)</option>
                        <option value="biz_no" ${col.type === 'biz_no' ? 'selected' : ''}>🏢 사업자등록번호</option>
                        <option value="address" ${col.type === 'address' ? 'selected' : ''}>📍 한국 도로명 주소</option>
                        <option value="company" ${col.type === 'company' ? 'selected' : ''}>🏢 회사명</option>
                        <option value="product" ${col.type === 'product' ? 'selected' : ''}>🛍️ 가전 상품명</option>
                        <option value="uuid" ${col.type === 'uuid' ? 'selected' : ''}>🆔 UUID 식별자</option>
                    </select>
                </div>
                <div class="mock-col-field mock-col-options-wrap">
                    <label class="mock-field-label">세부 조건 설정</label>
                    <div class="mock-type-options-container" id="mock-opts-${col.id}">
                        ${typeOptionsHtml}
                    </div>
                </div>
                <div class="mock-col-actions">
                    <button type="button" class="mock-row-btn" onclick="moveColumn(${idx}, -1)" title="위로 이동" ${idx === 0 ? 'disabled' : ''}>▲</button>
                    <button type="button" class="mock-row-btn" onclick="moveColumn(${idx}, 1)" title="아래로 이동" ${idx === mockStudioSchema.length - 1 ? 'disabled' : ''}>▼</button>
                    <button type="button" class="mock-row-btn danger" onclick="removeColumn('${col.id}')" title="컬럼 삭제">🗑️</button>
                </div>
            </div>
        `;
    }).join('');
}

// 각 데이터 타입별 인라인 세부 옵션 UI
function getColumnTypeOptionsHtml(col) {
    const opts = col.options || {};
    switch (col.type) {
        case 'key_value': {
            const otherCols = mockStudioSchema.filter(c => c.id !== col.id);
            const targetColOptions = otherCols.map(c => 
                `<option value="${escapeHtmlAttr(c.name)}" ${opts.target_column === c.name ? 'selected' : ''}>${escapeHtml(c.name)}</option>`
            ).join('');

            return `
                <div class="mock-opt-kv-block">
                    <div class="mock-opt-inline" style="margin-bottom: 4px;">
                        <span class="mock-opt-tag">🔗 참조 컬럼:</span>
                        <select class="mock-col-select opt-select-sm" style="width: 140px;" onchange="updateColumnOption('${col.id}', 'target_column', this.value)">
                            <option value="">(자동 랜덤 생성)</option>
                            ${targetColOptions}
                        </select>
                        <span class="mock-opt-tag" style="margin-left: 6px;">출력 형태:</span>
                        <select class="mock-col-select opt-select-sm" style="width: 100px;" onchange="updateColumnOption('${col.id}', 'output_part', this.value)">
                            <option value="value" ${opts.output_part !== 'key' ? 'selected' : ''}>값 (Value)</option>
                            <option value="key" ${opts.output_part === 'key' ? 'selected' : ''}>키 (Key)</option>
                        </select>
                    </div>
                    <div class="mock-opt-inline">
                        <span class="mock-opt-tag">키:값 매핑:</span>
                        <input type="text" class="mock-col-input opt-input" value="${escapeHtml(opts.mapping || '')}" 
                               placeholder="예: 스마트개발팀:DEV, 웹서비스팀:WEB, AI연구팀:AI, 인사팀:HR"
                               oninput="updateColumnOption('${col.id}', 'mapping', this.value)">
                    </div>
                    <div class="mock-opt-presets-row" style="margin-top: 3px;">
                        <span class="mock-opt-hint" style="margin-right: 4px;">프리셋:</span>
                        <button type="button" class="mock-kv-preset-btn" onclick="applyKvPreset('${col.id}', 'dept')">부서:코드</button>
                        <button type="button" class="mock-kv-preset-btn" onclick="applyKvPreset('${col.id}', 'position')">직급:코드</button>
                        <button type="button" class="mock-kv-preset-btn" onclick="applyKvPreset('${col.id}', 'region')">지역:지역번호</button>
                        <button type="button" class="mock-kv-preset-btn" onclick="applyKvPreset('${col.id}', 'bank')">은행:코드</button>
                        <button type="button" class="mock-kv-preset-btn" onclick="applyKvPreset('${col.id}', 'pay')">결제:코드</button>
                    </div>
                </div>
            `;
        }
        case 'email':
            return `
                <div class="mock-opt-inline">
                    <span class="mock-opt-tag">@도메인:</span>
                    <input type="text" class="mock-col-input opt-input" value="${escapeHtml(opts.domains || '')}" 
                           placeholder="예: cuchen.com 또는 cuchen.com, partner.co.kr"
                           oninput="updateColumnOption('${col.id}', 'domains', this.value)">
                </div>
            `;
        case 'choices':
            return `
                <div class="mock-opt-inline">
                    <span class="mock-opt-tag">선택 항목 (쉼표 구분):</span>
                    <input type="text" class="mock-col-input opt-input" value="${escapeHtml(opts.choices || '')}" 
                           placeholder="예: 개발팀, 기획팀, 디자인팀, QA팀, 인사팀, 영업팀"
                           oninput="updateColumnOption('${col.id}', 'choices', this.value)">
                </div>
            `;
        case 'name':
            return `
                <div class="mock-opt-inline">
                    <span class="mock-opt-tag">성별:</span>
                    <select class="mock-col-select opt-select" onchange="updateColumnOption('${col.id}', 'gender', this.value)">
                        <option value="any" ${opts.gender === 'any' ? 'selected' : ''}>남/여 전체</option>
                        <option value="male" ${opts.gender === 'male' ? 'selected' : ''}>남성 위주</option>
                        <option value="female" ${opts.gender === 'female' ? 'selected' : ''}>여성 위주</option>
                    </select>
                </div>
            `;
        case 'phone':
            return `
                <div class="mock-opt-inline">
                    <span class="mock-opt-tag">포맷:</span>
                    <select class="mock-col-select opt-select" onchange="updateColumnOption('${col.id}', 'format', this.value)">
                        <option value="010-XXXX-XXXX" ${opts.format === '010-XXXX-XXXX' ? 'selected' : ''}>010-XXXX-XXXX</option>
                        <option value="010XXXXXXXX" ${opts.format === '010XXXXXXXX' ? 'selected' : ''}>010XXXXXXXX (하이픈 제외)</option>
                        <option value="02-XXX-XXXX" ${opts.format === '02-XXX-XXXX' ? 'selected' : ''}>02-XXX-XXXX (서울 유선)</option>
                    </select>
                </div>
            `;
        case 'date':
            return `
                <div class="mock-opt-inline">
                    <span class="mock-opt-tag">기간:</span>
                    <input type="number" class="mock-col-input opt-num" value="${opts.start_year || 2021}" placeholder="시작연도" oninput="updateColumnOption('${col.id}', 'start_year', this.value)">
                    <span>~</span>
                    <input type="number" class="mock-col-input opt-num" value="${opts.end_year || 2026}" placeholder="종료연도" oninput="updateColumnOption('${col.id}', 'end_year', this.value)">
                </div>
            `;
        case 'number':
            return `
                <div class="mock-opt-inline">
                    <span class="mock-opt-tag">범위:</span>
                    <input type="number" class="mock-col-input opt-num" value="${opts.min || 10000}" placeholder="최소" oninput="updateColumnOption('${col.id}', 'min', this.value)">
                    <span>~</span>
                    <input type="number" class="mock-col-input opt-num" value="${opts.max || 1000000}" placeholder="최대" oninput="updateColumnOption('${col.id}', 'max', this.value)">
                    <span class="mock-opt-tag" style="margin-left:6px;">단위:</span>
                    <input type="number" class="mock-col-input opt-num" value="${opts.step || 1000}" placeholder="Step" oninput="updateColumnOption('${col.id}', 'step', this.value)">
                </div>
            `;
        case 'sequence':
            return `
                <div class="mock-opt-inline">
                    <span class="mock-opt-tag">접두사:</span>
                    <input type="text" class="mock-col-input opt-text-sm" value="${escapeHtml(opts.prefix || '')}" placeholder="예: EMP-" oninput="updateColumnOption('${col.id}', 'prefix', this.value)">
                    <span class="mock-opt-tag">시작값:</span>
                    <input type="number" class="mock-col-input opt-num-sm" value="${opts.start_num || 1}" oninput="updateColumnOption('${col.id}', 'start_num', this.value)">
                    <span class="mock-opt-tag">자릿수:</span>
                    <input type="number" class="mock-col-input opt-num-sm" value="${opts.padding || 4}" min="1" max="10" oninput="updateColumnOption('${col.id}', 'padding', this.value)">
                </div>
            `;
        default:
            return `<span class="mock-opt-hint">추가 설정 없음 (랜덤 자동 생성)</span>`;
    }
}

// 키-값 프리셋 적용
function applyKvPreset(colId, presetKey) {
    const col = mockStudioSchema.find(c => c.id === colId);
    if (!col) return;
    if (!col.options) col.options = {};

    if (presetKey === 'dept') {
        col.name = "부서코드";
        col.options.target_column = "부서명";
        col.options.output_part = "value";
        col.options.mapping = "스마트개발팀:DEV, 웹서비스팀:WEB, AI연구팀:AI, 품질보증팀:QA, 경영기획팀:MGT, 인사총무팀:HR, 영업마케팅팀:SAL";
    } else if (presetKey === 'position') {
        col.name = "직급코드";
        col.options.target_column = "직급";
        col.options.output_part = "value";
        col.options.mapping = "사원:J1, 주임:J2, 선임연구원:S1, 책임연구원:S2, 수석연구원:P1, 팀장:L1";
    } else if (presetKey === 'region') {
        col.name = "지역코드";
        col.options.target_column = "거주지주소";
        col.options.output_part = "value";
        col.options.mapping = "서울특별시:02, 경기도:031, 인천광역시:032, 부산광역시:051, 대구광역시:053, 대전광역시:042";
    } else if (presetKey === 'bank') {
        col.name = "은행코드";
        col.options.target_column = "은행명";
        col.options.output_part = "value";
        col.options.mapping = "국민은행:004, 신한은행:088, 우리은행:020, 하나은행:081, 농협은행:011, 카카오뱅크:090";
    } else if (presetKey === 'pay') {
        col.name = "결제코드";
        col.options.target_column = "결제수단";
        col.options.output_part = "value";
        col.options.mapping = "신용카드:CARD, 카카오페이:KPAY, 네이버페이:NPAY, 계좌이체:BANK, 무통장입금:VBANK";
    }

    renderMockSchemaBuilder();
    triggerMockPreview();
}

// ==========================================
// 5. 컬럼 추가/삭제/변경 이벤트
// ==========================================
function addNewMockColumn() {
    const newId = `col_${Date.now()}`;
    mockStudioSchema.push({
        id: newId,
        name: `새_컬럼_${mockStudioSchema.length + 1}`,
        type: "choices",
        options: { choices: "선택A, 선택B, 선택C" }
    });
    renderMockSchemaBuilder();
    triggerMockPreview();
}

function removeColumn(colId) {
    mockStudioSchema = mockStudioSchema.filter(c => c.id !== colId);
    renderMockSchemaBuilder();
    triggerMockPreview();
}

function moveColumn(idx, delta) {
    const targetIdx = idx + delta;
    if (targetIdx < 0 || targetIdx >= mockStudioSchema.length) return;
    const temp = mockStudioSchema[idx];
    mockStudioSchema[idx] = mockStudioSchema[targetIdx];
    mockStudioSchema[targetIdx] = temp;
    renderMockSchemaBuilder();
    triggerMockPreview();
}

function updateColumnName(colId, newName) {
    const col = mockStudioSchema.find(c => c.id === colId);
    if (col) {
        col.name = newName;
        debouncedMockPreview();
    }
}

function updateColumnType(colId, newType) {
    const col = mockStudioSchema.find(c => c.id === colId);
    if (col) {
        col.type = newType;
        if (newType === 'key_value') {
            if (!col.options?.mapping) {
                col.options = {
                    target_column: "",
                    output_part: "value",
                    mapping: "스마트개발팀:DEV, 웹서비스팀:WEB, AI연구팀:AI, 품질보증팀:QA, 경영지원팀:MGT"
                };
            }
        } else if (newType === 'email' && !col.options?.domains) {
            col.options = { domains: "cuchen.com" };
        } else if (newType === 'choices' && !col.options?.choices) {
            col.options = { choices: "스마트개발팀, 웹서비스팀, AI연구팀, 품질보증팀, 경영지원팀" };
        } else if (newType === 'date' && !col.options?.start_year) {
            col.options = { start_year: 2021, end_year: 2026, format: "%Y-%m-%d" };
        } else if (newType === 'number' && !col.options?.min) {
            col.options = { min: 10000, max: 1000000, step: 1000 };
        } else if (newType === 'sequence' && !col.options?.prefix) {
            col.options = { prefix: "ID-", start_num: 1001, padding: 4 };
        }

        const optsContainer = document.getElementById(`mock-opts-${colId}`);
        if (optsContainer) {
            optsContainer.innerHTML = getColumnTypeOptionsHtml(col);
        }
        triggerMockPreview();
    }
}

function updateColumnOption(colId, optKey, optVal) {
    const col = mockStudioSchema.find(c => c.id === colId);
    if (col) {
        if (!col.options) col.options = {};
        col.options[optKey] = optVal;
        debouncedMockPreview();
    }
}

// ==========================================
// 6. 실시간 미리보기 & 엑셀 저장
// ==========================================
let mockPreviewDebounceTimer = null;

function debouncedMockPreview() {
    clearTimeout(mockPreviewDebounceTimer);
    mockPreviewDebounceTimer = setTimeout(() => {
        triggerMockPreview();
    }, 250);
}

async function triggerMockPreview() {
    const previewContainer = document.getElementById('mock-preview-table-container');
    if (!previewContainer) return;

    if (mockStudioSchema.length === 0) {
        previewContainer.innerHTML = `<div class="mock-table-placeholder">컬럼을 추가하면 실시간 데이터가 여기에 표시됩니다.</div>`;
        return;
    }

    try {
        if (window.eel && typeof eel.preview_mock_data === 'function') {
            const res = await eel.preview_mock_data(mockStudioSchema, 6)();
            if (res.status === 'success' && res.rows) {
                currentMockPreviewRows = res.rows;
                renderMockPreviewTable(res.headers, res.rows);
            }
        }
    } catch (err) {
        console.error("모의 데이터 미리보기 오류:", err);
    }
}

function renderMockPreviewTable(headers, rows) {
    const previewContainer = document.getElementById('mock-preview-table-container');
    if (!previewContainer) return;

    if (!rows || rows.length === 0) {
        previewContainer.innerHTML = `<div class="mock-table-placeholder">생성된 미리보기 행이 없습니다.</div>`;
        return;
    }

    const ths = headers.map(h => `<th>${escapeHtml(h)}</th>`).join('');
    const trs = rows.map((row, rIdx) => {
        const tds = headers.map(h => {
            const val = row[h] !== undefined && row[h] !== null ? row[h] : '';
            const isNum = typeof val === 'number';
            const formatted = isNum ? val.toLocaleString() : escapeHtml(String(val));
            return `<td class="${isNum ? 'text-right' : ''}">${formatted}</td>`;
        }).join('');
        return `<tr><td class="row-num-cell">${rIdx + 1}</td>${tds}</tr>`;
    }).join('');

    previewContainer.innerHTML = `
        <div class="mock-table-scroll-box">
            <table class="mock-preview-table">
                <thead>
                    <tr>
                        <th style="width: 40px;">#</th>
                        ${ths}
                    </tr>
                </thead>
                <tbody>
                    ${trs}
                </tbody>
            </table>
        </div>
    `;
}

// 엑셀(.xlsx) 파일 생성 & 다운로드
async function downloadMockExcel() {
    const countInput = document.getElementById('mock-generate-count');
    const count = parseInt(countInput?.value || 100, 10);

    if (mockStudioSchema.length === 0) {
        showAppAlert("먼저 생성할 컬럼을 최소 1개 이상 추가해주세요.", "알림", "⚠️");
        return;
    }

    try {
        logToConsole("모의 데이터 생성", `엑셀(.xlsx) ${count}건 생성 다이얼로그 열기...`);
        if (window.eel && typeof eel.save_mock_data_excel_dialog === 'function') {
            const res = await eel.save_mock_data_excel_dialog(mockStudioSchema, count, "mock_data.xlsx")();
            if (res.status === 'success') {
                logToConsole("엑셀 저장 완료", `파일: ${res.file_path} (${res.row_count}건)`);
                showAppAlert(`총 ${res.row_count}건의 모의 데이터가 엑셀(.xlsx) 파일로 성공적으로 저장되었습니다! 💾\n\n저장 경로:\n${res.file_path}`, "저장 완료", "✅");
            } else if (res.status === 'error') {
                showAppAlert(`엑셀 저장 실패: ${res.message}`, "오류", "❌");
            }
        }
    } catch (err) {
        console.error("엑셀 저장 오류:", err);
        showAppAlert(`엑셀 저장 중 오류가 발생했습니다: ${err.message}`, "오류", "❌");
    }
}

// CSV 파일 생성 & 다운로드
async function downloadMockCsv() {
    const countInput = document.getElementById('mock-generate-count');
    const count = parseInt(countInput?.value || 100, 10);

    if (mockStudioSchema.length === 0) {
        showAppAlert("먼저 생성할 컬럼을 최소 1개 이상 추가해주세요.", "알림", "⚠️");
        return;
    }

    try {
        if (window.eel && typeof eel.save_mock_data_csv_dialog === 'function') {
            const res = await eel.save_mock_data_csv_dialog(mockStudioSchema, count, "mock_data.csv")();
            if (res.status === 'success') {
                logToConsole("CSV 저장 완료", `파일: ${res.file_path} (${res.row_count}건)`);
                showAppAlert(`총 ${res.row_count}건의 데이터가 CSV 파일로 성공적으로 저장되었습니다! 💾\n\n저장 경로:\n${res.file_path}`, "저장 완료", "✅");
            }
        }
    } catch (err) {
        console.error("CSV 저장 오류:", err);
    }
}

// JSON 클립보드 복사
async function copyMockJson() {
    if (currentMockPreviewRows.length === 0) {
        showAppAlert("복사할 모의 데이터가 없습니다.", "알림", "⚠️");
        return;
    }
    const jsonStr = JSON.stringify(currentMockPreviewRows, null, 2);
    try {
        await navigator.clipboard.writeText(jsonStr);
        showAppToast("미리보기 데이터(JSON)가 클립보드에 복사되었습니다! 📋", "success");
    } catch (e) {
        showAppAlert("클립보드 복사 실패", "오류", "❌");
    }
}

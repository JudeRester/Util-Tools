/**
 * JavaScript 플레이그라운드 / 샌드박스 실행 엔진 모듈
 */

const JS_TEMPLATES = {
    basic: `// 🧪 기본 JavaScript 테스트
const greet = (name) => \`안녕하세요, \${name}님!\`;
console.log(greet("개발자"));

const numbers = [1, 2, 3, 4, 5];
const doubled = numbers.map(n => n * 2);
console.log("2배 계산 결과:", doubled);

return { 
    status: "OK", 
    timestamp: new Date().toLocaleTimeString(),
    sum: doubled.reduce((a, b) => a + b, 0)
};`,

    array: `// 📊 배열 조작 & 고차함수 예제
const users = [
    { id: 1, name: "김철수", dept: "개발팀", score: 88 },
    { id: 2, name: "이영희", dept: "디자인팀", score: 95 },
    { id: 3, name: "박민수", dept: "개발팀", score: 92 },
    { id: 4, name: "최수진", dept: "기획팀", score: 84 }
];

// 개발팀 우수자(90점 이상) 필터링
const topDevs = users
    .filter(u => u.dept === "개발팀" && u.score >= 90)
    .map(u => \`\${u.name} (\${u.score}점)\`);

console.log("개발팀 우수 사원:", topDevs);

// 부서별 인원수 통계
const deptCount = users.reduce((acc, u) => {
    acc[u.dept] = (acc[u.dept] || 0) + 1;
    return acc;
}, {});

console.log("부서별 통계:", deptCount);
return { topDevs, deptCount };`,

    async: `// ⏳ 비동기 Async/Await & Promise 테스트
console.log("1. 비동기 작업 시작");

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

await sleep(300);
console.log("2. 300ms 경과 (작업 진행 중...)");

await sleep(200);
console.log("3. 500ms 경과 (작업 완료)");

return { success: true, message: "모든 비동기 처리가 성공했습니다." };`,

    json: `// 📦 JSON 데이터 파싱 & 가공
const rawJson = \`{
  "service": "Utility Toolkit",
  "version": "1.2.0",
  "active": true,
  "tags": ["desktop", "eel", "python", "javascript"]
}\`;

const parsed = JSON.parse(rawJson);
console.log("파싱된 객체:", parsed);

parsed.lastRun = new Date().toISOString();
parsed.tags.push("productivity");

const serialized = JSON.stringify(parsed, null, 2);
console.log("가공된 JSON:\\n" + serialized);

return parsed;`,

    regex: `// 🔍 정규표현식 매칭 & 유효성 검사
const sampleText = \`
  고객센터: support@test.com
  담당자 문의: help.admin@domain.co.kr
  전화번호: 010-1234-5678, 02-987-6543
\`;

// 1. 이메일 추출
const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}/g;
const emails = sampleText.match(emailRegex) || [];
console.log("발견된 이메일 목록:", emails);

// 2. 전화번호 추출
const phoneRegex = /\\b\\d{2,3}-\\d{3,4}-\\d{4}\\b/g;
const phones = sampleText.match(phoneRegex) || [];
console.log("발견된 전화번호 목록:", phones);

return { emails, phones };`
};

function initJsPlayground() {
    const editor = document.getElementById('js-code-editor');
    if (!editor) return;

    // 저장된 코드 복원 (없으면 기본 템플릿)
    const savedCode = localStorage.getItem('js_runner_code');
    editor.value = savedCode !== null ? savedCode : JS_TEMPLATES.basic;

    // 에디터 단축키 및 들여쓰기 처리
    editor.addEventListener('keydown', (e) => {
        // Tab 키 누를 때 4칸 들여쓰기
        if (e.key === 'Tab') {
            e.preventDefault();
            const start = editor.selectionStart;
            const end = editor.selectionEnd;
            editor.value = editor.value.substring(0, start) + '    ' + editor.value.substring(end);
            editor.selectionStart = editor.selectionEnd = start + 4;
            saveJsCodeToStorage();
        }

        // Ctrl + Enter (또는 Cmd + Enter)로 즉시 실행
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            e.preventDefault();
            runJsCode();
        }
    });

    editor.addEventListener('input', saveJsCodeToStorage);
}

function saveJsCodeToStorage() {
    const editor = document.getElementById('js-code-editor');
    if (editor) {
        localStorage.setItem('js_runner_code', editor.value);
    }
}

function loadJsTemplate(key) {
    const template = JS_TEMPLATES[key];
    if (template) {
        const editor = document.getElementById('js-code-editor');
        if (editor) {
            editor.value = template;
            saveJsCodeToStorage();
        }
    }
}

// 현재 작성된 JS 코드를 [빠른 메모] 탭의 새 메모로 영구 저장
async function saveJsCodeToNotes() {
    const editor = document.getElementById('js-code-editor');
    if (!editor) return;

    const code = editor.value.trim();
    if (!code) {
        alert('저장할 JavaScript 코드가 비어있습니다.');
        return;
    }

    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const noteTitle = `🧪 JS 코드 (${dateStr} ${timeStr})`;

    if (typeof createNoteWithContent === 'function') {
        await createNoteWithContent(noteTitle, editor.value);
        logToConsole('빠른 메모 저장 완료', `현재 JS 코드가 [빠른 메모] 탭에 "${noteTitle}"(으)로 안전하게 보관되었습니다.`);
        
        // 메모 탭으로 즉시 전환하여 확인
        if (typeof switchTab === 'function') {
            switchTab('notes');
        }
    } else {
        alert('메모 저장 기능을 찾을 수 없습니다.');
    }
}

function clearJsEditor() {
    const editor = document.getElementById('js-code-editor');
    if (editor) {
        editor.value = '';
        saveJsCodeToStorage();
        editor.focus();
    }
}

function formatOutputValue(val) {
    if (val === undefined) return 'undefined';
    if (val === null) return 'null';
    if (typeof val === 'object') {
        try {
            return JSON.stringify(val, null, 2);
        } catch (e) {
            return String(val);
        }
    }
    return String(val);
}

async function runJsCode() {
    const editor = document.getElementById('js-code-editor');
    const outputEl = document.getElementById('js-runner-output');
    if (!editor || !outputEl) return;

    const code = editor.value;
    outputEl.innerHTML = '';

    const logs = [];

    // 커스텀 콘솔 객체 (로그 캡처)
    const sandboxConsole = {
        log: (...args) => {
            const text = args.map(formatOutputValue).join(' ');
            logs.push({ type: 'log', text });
            appendOutputLine(text, 'out-log');
        },
        warn: (...args) => {
            const text = args.map(formatOutputValue).join(' ');
            logs.push({ type: 'warn', text });
            appendOutputLine('⚠️ ' + text, 'out-warn');
        },
        error: (...args) => {
            const text = args.map(formatOutputValue).join(' ');
            logs.push({ type: 'error', text });
            appendOutputLine('❌ ' + text, 'out-error');
        },
        info: (...args) => {
            const text = args.map(formatOutputValue).join(' ');
            logs.push({ type: 'log', text });
            appendOutputLine('ℹ️ ' + text, 'out-log');
        },
        table: (data) => {
            const text = formatOutputValue(data);
            logs.push({ type: 'log', text });
            appendOutputLine(text, 'out-log');
        }
    };

    function appendOutputLine(text, className) {
        const div = document.createElement('div');
        div.className = className;
        div.textContent = text;
        outputEl.appendChild(div);
        outputEl.scrollTop = outputEl.scrollHeight;
    }

    const startTime = performance.now();

    try {
        // 비동기 AsyncFunction 생성자로 실행
        const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
        const fn = new AsyncFunction('console', code);
        const result = await fn(sandboxConsole);
        const duration = (performance.now() - startTime).toFixed(2);

        // 반환값(return)이 있는 경우 표시
        if (result !== undefined) {
            appendOutputLine('↪ Return: ' + formatOutputValue(result), 'out-return');
        } else if (logs.length === 0) {
            appendOutputLine('(실행 완료: 출력이나 반환값이 없습니다)', 'output-placeholder');
        }

        // 실행 소요 시간
        appendOutputLine(`⏱️ ${duration}ms 에 실행 완료`, 'out-time');
    } catch (err) {
        const duration = (performance.now() - startTime).toFixed(2);
        appendOutputLine(`🚨 Runtime Error: ${err.name}\n${err.message}`, 'out-error');
        if (err.stack) {
            console.error(err);
        }
        appendOutputLine(`⏱️ ${duration}ms (오류 발생)`, 'out-time');
    }
}

async function copyJsOutput() {
    const outputEl = document.getElementById('js-runner-output');
    if (!outputEl) return;

    const text = outputEl.innerText;
    if (!text || text.includes('코드를 입력하고')) {
        alert('복사할 실행 결과가 없습니다.');
        return;
    }

    try {
        await navigator.clipboard.writeText(text);
        logToConsole('복사 완료', 'JS 실행 결과가 클립보드에 복사되었습니다.');
    } catch (e) {
        alert('클립보드 복사 실패: ' + e.message);
    }
}

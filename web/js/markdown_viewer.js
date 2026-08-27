/**
 * Markdown 뷰어 & 실시간 에디터 (Markdown Studio) 모듈
 * - 실시간 GFM(GitHub Flavored Markdown) 파싱 및 렌더링
 * - GitHub 스타일 Alerts ([!NOTE], [!TIP], [!WARNING], [!IMPORTANT], [!CAUTION])
 * - Mermaid 다이어그램 코드 블록 실시간 시각화
 * - GFM 테이블, 인터랙티브 태스크 체크박스, 구문 강조 코드블록
 * - 스플릿 뷰(Split) / 에디터(Editor) / 미리보기(Preview) 모드 및 동기화 스크롤
 * - 목차(TOC) 생성, 글자/단어/읽기 시간 통계, HTML/MD 복사 및 저장
 */

let mdState = {
    content: '',
    fileName: '',
    filePath: '',
    fileSize: 0,
    viewMode: 'split', // 'split' | 'editor' | 'preview'
    editorWidth: null,
    syncScroll: true,
    renderTimeout: null
};

// ==========================================
// 1. 초기화 및 이벤트 리스너 등록
// ==========================================
function initMarkdownViewer() {
    const editor = document.getElementById('markdown-editor-input');
    const dropZone = document.getElementById('markdown-drop-overlay');
    const container = document.getElementById('markdown-split-container');

    // 에디터 입력 시 실시간 디바운스 렌더링
    editor?.addEventListener('input', () => {
        onMarkdownEditorChange();
    });

    // Tab 키 들여쓰기 지원
    editor?.addEventListener('keydown', (e) => {
        if (e.key === 'Tab') {
            e.preventDefault();
            const start = editor.selectionStart;
            const end = editor.selectionEnd;
            editor.value = editor.value.substring(0, start) + '    ' + editor.value.substring(end);
            editor.selectionStart = editor.selectionEnd = start + 4;
            onMarkdownEditorChange();
        }
    });

    // 드래그 앤 드롭 파일 로드
    ['dragenter', 'dragover'].forEach(eventName => {
        container?.addEventListener(eventName, (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (dropZone) dropZone.style.display = 'flex';
        });
    });

    ['dragleave', 'drop'].forEach(eventName => {
        container?.addEventListener(eventName, (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (e.type === 'dragleave' && e.target === container) {
                if (dropZone) dropZone.style.display = 'none';
            }
        });
    });

    dropZone?.addEventListener('dragleave', (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropZone.style.display = 'none';
    });

    dropZone?.addEventListener('drop', handleMarkdownFileDrop);
    container?.addEventListener('drop', handleMarkdownFileDrop);

    // 스플리터 드래그 리사이저 초기화
    initMarkdownResizer();

    // 동기화 스크롤 초기화
    initMarkdownSyncScroll();

    // 초기 상태 복원 (로컬스토리지)
    const savedContent = localStorage.getItem('md_viewer_content');
    const savedMode = localStorage.getItem('md_viewer_mode') || 'split';
    
    setMarkdownViewMode(savedMode);

    if (savedContent && savedContent.trim()) {
        if (editor) editor.value = savedContent;
        mdState.content = savedContent;
        renderMarkdown();
    } else {
        loadSampleMarkdownData();
    }
}

// ==========================================
// 2. 파일 로드 & 클립보드 & 샘플 핸들러
// ==========================================
async function openMarkdownFileDialog() {
    try {
        if (window.eel && typeof eel.select_and_read_markdown_file === 'function') {
            const res = await eel.select_and_read_markdown_file()();
            if (res.status === 'success') {
                applyLoadedMarkdown(res.content, res.file_name, res.file_path, res.file_size);
                logToConsole('Markdown 파일 로드 완료', `${res.file_name} (${(res.file_size / 1024).toFixed(1)} KB)`);
            } else if (res.status === 'error') {
                await showAppAlert(res.message, '파일 열기 실패', '❌');
            }
        } else {
            // 브라우저 input[type=file] fallback
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = '.md,.markdown,.txt,.mdown,.mkd';
            input.onchange = (e) => {
                const file = e.target.files[0];
                if (file) {
                    const reader = new FileReader();
                    reader.onload = (ev) => {
                        applyLoadedMarkdown(ev.target.result, file.name, '', file.size);
                    };
                    reader.readAsText(file);
                }
            };
            input.click();
        }
    } catch (e) {
        logToConsole('Markdown 열기 오류', e.message || e);
    }
}

function handleMarkdownFileDrop(e) {
    e.preventDefault();
    e.stopPropagation();
    const dropZone = document.getElementById('markdown-drop-overlay');
    if (dropZone) dropZone.style.display = 'none';

    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;

    const file = files[0];
    if (window.eel && typeof eel.read_markdown_from_path === 'function' && file.path) {
        eel.read_markdown_from_path(file.path)().then(res => {
            if (res.status === 'success') {
                applyLoadedMarkdown(res.content, res.file_name, res.file_path, res.file_size);
                logToConsole('Markdown 드롭 로드 완료', res.file_name);
            } else {
                readBrowserFileText(file);
            }
        }).catch(() => {
            readBrowserFileText(file);
        });
    } else {
        readBrowserFileText(file);
    }
}

function readBrowserFileText(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
        applyLoadedMarkdown(e.target.result, file.name, '', file.size);
    };
    reader.readAsText(file);
}

async function pasteMarkdownFromClipboard() {
    try {
        const text = await navigator.clipboard.readText();
        if (!text || !text.trim()) {
            await showAppAlert('클립보드에 복사된 텍스트가 없습니다.', '알림', '⚠️');
            return;
        }
        applyLoadedMarkdown(text, '클립보드 텍스트');
    } catch (e) {
        const manual = prompt('붙여넣을 Markdown 텍스트를 입력하세요:');
        if (manual && manual.trim()) {
            applyLoadedMarkdown(manual, '직접 입력 텍스트');
        }
    }
}

function applyLoadedMarkdown(content, fileName = '', filePath = '', fileSize = 0) {
    mdState.content = content || '';
    mdState.fileName = fileName;
    mdState.filePath = filePath;
    mdState.fileSize = fileSize || content.length;

    const editor = document.getElementById('markdown-editor-input');
    if (editor) editor.value = mdState.content;

    localStorage.setItem('md_viewer_content', mdState.content);
    renderMarkdown();
    updateMarkdownStats();
    updateMarkdownFileBadge();
}

function clearMarkdownViewer() {
    applyLoadedMarkdown('', '', '', 0);
    logToConsole('Markdown 뷰어 초기화', '내용이 비워졌습니다.');
}

function loadSampleMarkdownData() {
    const sample = `# 🚀 Utility Toolkit Markdown Studio

> [!NOTE]
> 이 에디터는 **GitHub Flavored Markdown (GFM)** 규격을 완벽 지원하며, 실시간 렌더링 및 다이어그램 시각화를 제공합니다.

> [!TIP]
> 좌측 에디터에서 마크다운을 작성하거나 외부 \`.md\` 파일을 드래그 앤 드롭하여 즉시 열람할 수 있습니다.

---

## 📊 1. GFM 표 (Table) 지원

| 기능 명칭 | 지원 여부 | 단축키 / 설명 | 상태 |
| :--- | :---: | :--- | :---: |
| **실시간 렌더링** | ✅ | 150ms 디바운스 자동 갱신 | \`Active\` |
| **Mermaid 다이어그램** | ✅ | \`\`\`mermaid 코드 블록 자동 시각화 | \`Active\` |
| **GitHub Alerts** | ✅ | \`[!NOTE]\`, \`[!TIP]\`, \`[!WARNING]\` 등 5종 | \`Stable\` |
| **체크박스 토글** | ✅ | 미리보기에서 직접 클릭하여 소스 자동 수정 | \`Interactive\` |

---

## 📋 2. 인터랙티브 작업 목록 (Task List)

- [x] Python Eel 백엔드 서비스 아키텍처 구축
- [x] CSV / TSV 초고속 데이터 뷰어 완성
- [x] Mermaid 다이어그램 스튜디오 연동
- [x] Markdown 실시간 뷰어 및 에디터 개발
- [ ] Electron 패키징 및 단독 실행 배포

> [!WARNING]
> 체크박스는 미리보기 화면에서 **마우스로 직접 클릭**해도 좌측 마크다운 원본 코드가 즉시 동기화되어 수정됩니다!

---

## 📐 3. Mermaid 다이어그램 내장 시각화

\`\`\`mermaid
graph TD
    A[📂 Markdown / CSV 문서] --> B{파서 자동 분석}
    B -->|Markdown| C[📝 HTML & Mermaid 렌더러]
    B -->|CSV / TSV| D[📊 고성능 데이터 테이블]
    C --> E[🖥️ 다크 테마 고해상도 프리뷰]
    D --> E
    E --> F[💾 HTML / MD / PDF 내보내기]
\`\`\`

---

## 💻 4. 소스 코드 블록 (Syntax Highlighting)

\`\`\`python
import eel
import os

@eel.expose
def get_toolkit_status():
    return {
        "status": "online",
        "modules": ["system", "shortcuts", "quick_launch", "generator", "csv", "markdown", "diagram"]
    }
\`\`\`

---

## 🎯 5. 텍스트 서식 및 링크

* **굵은 글씨 (Bold)**, *기울임꼴 (Italic)*, ~~취소선 (Strikethrough)~~, \`인라인 코드 (Inline Code)\`
* [Google 웹사이트 방문](https://www.google.com)
* 인용구:
  > "단순함은 궁극의 정교함이다." — 레오나르도 다 빈치
`;

    applyLoadedMarkdown(sample, 'Markdown_Studio_가이드.md', '', sample.length);
}

// ==========================================
// 3. 실시간 파싱 & 렌더링 엔진
// ==========================================
function onMarkdownEditorChange() {
    const editor = document.getElementById('markdown-editor-input');
    if (!editor) return;

    mdState.content = editor.value;
    localStorage.setItem('md_viewer_content', mdState.content);

    clearTimeout(mdState.renderTimeout);
    mdState.renderTimeout = setTimeout(() => {
        renderMarkdown();
        updateMarkdownStats();
    }, 120);
}

function renderMarkdown() {
    const preview = document.getElementById('markdown-preview-output');
    if (!preview) return;

    const raw = mdState.content || '';
    if (!raw.trim()) {
        preview.innerHTML = `
            <div class="md-empty-placeholder">
                <div class="md-empty-icon">📝</div>
                <div class="md-empty-title">마크다운 내용이 비어 있습니다.</div>
                <div class="md-empty-desc">좌측 에디터에 텍스트를 입력하거나 <b>[📂 파일 열기]</b> / <b>[✨ 샘플 로드]</b>를 클릭하세요.</div>
            </div>
        `;
        return;
    }

    const html = parseMarkdownToHtml(raw);
    preview.innerHTML = html;

    // Mermaid 다이어그램 블록 렌더링
    renderMermaidBlocks(preview);

    // 인터랙티브 체크박스 클릭 이벤트 바인딩
    bindTaskCheckboxClicks(preview);

    // 코드 블록 복사 버튼 바인딩
    bindCodeCopyButtons(preview);
}

// 순수 JavaScript 경량 GFM 마크다운 파서
function parseMarkdownToHtml(md) {
    let text = md.replace(/\r\n/g, '\n');

    // 1) Code Blocks (```lang ... ```) 임시 토큰 치환 (마크다운 특수기호 없는 안전한 토큰 사용)
    const codeBlocks = [];
    text = text.replace(/```(\w*)\n([\s\S]*?)```/g, (match, lang, code) => {
        const id = `@@@MDCODEBLOCK${codeBlocks.length}@@@`;
        codeBlocks.push({ lang: lang.trim().toLowerCase(), code });
        return `\n\n${id}\n\n`;
    });

    // 2) Inline Code (`code`) 임시 토큰 치환 (언더스코어/별표 없는 안전한 토큰 사용)
    const inlineCodes = [];
    text = text.replace(/`([^`\n]+)`/g, (match, code) => {
        const id = `@@@MDINLINECODE${inlineCodes.length}@@@`;
        inlineCodes.push(code);
        return id;
    });

    // 3) HTML 특수문자 이스케이프 (코드 블록 제외 일반 텍스트)
    text = escapeHtml(text);

    // 4) GitHub Alert Callouts (> [!NOTE], > [!TIP], > [!IMPORTANT], > [!WARNING], > [!CAUTION])
    text = text.replace(/^&gt;\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\n((?:^&gt;.*(?:\n|$))+)/gim, (match, type, content) => {
        const cleanContent = content.replace(/^&gt;\s?/gm, '').trim();
        const alertClass = type.toLowerCase();
        const icons = {
            note: 'ℹ️',
            tip: '💡',
            important: '❗',
            warning: '⚠️',
            caution: '🚫'
        };
        const icon = icons[alertClass] || '📌';
        return `\n\n<div class="md-alert md-alert-${alertClass}"><div class="md-alert-header"><span class="md-alert-icon">${icon}</span> <span class="md-alert-title">${type}</span></div><div class="md-alert-body">${parseInlineMarkdown(cleanContent)}</div></div>\n\n`;
    });

    // 5) 일반 Blockquotes (> text)
    text = text.replace(/((?:^&gt;.*(?:\n|$))+)/gm, (match) => {
        const clean = match.replace(/^&gt;\s?/gm, '').trim();
        return `\n\n<blockquote>${parseInlineMarkdown(clean)}</blockquote>\n\n`;
    });

    // 6) Headers (# ~ ######)
    text = text.replace(/^(#{1,6})\s+(.+)$/gm, (match, hashes, title) => {
        const level = hashes.length;
        const rawTitle = title.replace(/@@@MDINLINECODE(\d+)@@@/g, (m, i) => inlineCodes[parseInt(i, 10)] || '');
        const slug = rawTitle.toLowerCase().replace(/[^\w가-힣0-9]+/g, '-').replace(/^-+|-+$/g, '');
        return `\n\n<h${level} id="${slug}">${parseInlineMarkdown(title)}</h${level}>\n\n`;
    });

    // 7) GFM Tables (| col | col |)
    text = text.replace(/((?:^\|.+?\|(?:\n|$))+)/gm, (match) => {
        const lines = match.trim().split('\n').filter(l => l.trim().startsWith('|'));
        if (lines.length < 2) return match;

        const headerLine = lines[0];
        const alignLine = lines[1];
        const dataLines = lines.slice(2);

        // 구분선(| --- | :---: |) 유효성 검사
        if (!/^\|(?:\s*:?-+:?\s*\|)+$/.test(alignLine.trim())) {
            return match;
        }

        const parseCells = (row) => row.split('|').slice(1, -1).map(c => c.trim());
        const headers = parseCells(headerLine);
        const aligns = parseCells(alignLine).map(c => {
            if (c.startsWith(':') && c.endsWith(':')) return 'center';
            if (c.endsWith(':')) return 'right';
            return 'left';
        });

        let html = '\n\n<div class="md-table-wrapper"><table class="md-table"><thead><tr>';
        headers.forEach((h, i) => {
            const align = aligns[i] ? ` style="text-align: ${aligns[i]}"` : '';
            html += `<th${align}>${parseInlineMarkdown(h)}</th>`;
        });
        html += '</tr></thead><tbody>';

        dataLines.forEach(row => {
            const cells = parseCells(row);
            html += '<tr>';
            cells.forEach((cell, i) => {
                const align = aligns[i] ? ` style="text-align: ${aligns[i]}"` : '';
                html += `<td${align}>${parseInlineMarkdown(cell)}</td>`;
            });
            html += '</tr>';
        });
        html += '</tbody></table></div>\n\n';
        return html;
    });

    // 8) Horizontal Rules (---, ***)
    text = text.replace(/^(?:---|\*\*\*|___)\s*$/gm, '\n\n<hr class="md-hr">\n\n');

    // 9) Task Lists & Unordered/Ordered Lists
    let taskIdx = 0;
    text = text.replace(/^(\s*)[-*+]\s+\[([ xX])\]\s+(.+)$/gm, (match, space, checked, label) => {
        const isChecked = checked.toLowerCase() === 'x';
        const checkedAttr = isChecked ? 'checked' : '';
        const curIdx = taskIdx++;
        return `${space}<li class="md-task-item"><label class="md-task-label"><input type="checkbox" class="md-task-checkbox" data-task-index="${curIdx}" ${checkedAttr}> <span>${parseInlineMarkdown(label)}</span></label></li>`;
    });

    // Standard list items (인라인 마크다운 적용)
    text = text.replace(/^(\s*)[-*+]\s+(.+)$/gm, (m, space, item) => `${space}<li class="md-list-item">${parseInlineMarkdown(item)}</li>`);
    text = text.replace(/^(\s*)\d+\.\s+(.+)$/gm, (m, space, item) => `${space}<li class="md-ordered-item">${parseInlineMarkdown(item)}</li>`);

    // Wrap consecutive list items in <ul> or <ol>
    text = text.replace(/((?:<li class="md-task-item">.*<\/li>\s*)+)/g, '\n\n<ul class="md-task-list">$1</ul>\n\n');
    text = text.replace(/((?:<li class="md-list-item">.*<\/li>\s*)+)/g, '\n\n<ul class="md-list">$1</ul>\n\n');
    text = text.replace(/((?:<li class="md-ordered-item">.*<\/li>\s*)+)/g, '\n\n<ol class="md-ordered-list">$1</ol>\n\n');

    // 10) Paragraphs
    const blocks = text.split(/\n{2,}/);
    text = blocks.map(block => {
        const trimmed = block.trim();
        if (!trimmed) return '';
        if (trimmed.startsWith('<h') || trimmed.startsWith('<blockquote') || trimmed.startsWith('<div') ||
            trimmed.startsWith('<ul') || trimmed.startsWith('<ol') || trimmed.startsWith('<table') ||
            trimmed.startsWith('<hr') || trimmed.startsWith('@@@MDCODEBLOCK') ||
            trimmed.endsWith('</ul>') || trimmed.endsWith('</ol>') || trimmed.endsWith('</div>')) {
            return trimmed;
        }
        return `<p>${parseInlineMarkdown(trimmed).replace(/\n/g, '<br>')}</p>`;
    }).join('\n\n');

    // 11) Code Blocks 복원
    text = text.replace(/@@@MDCODEBLOCK(\d+)@@@/g, (match, idx) => {
        const item = codeBlocks[parseInt(idx, 10)];
        if (!item) return '';

        // Mermaid 다이어그램 코드 블록 처리
        if (item.lang === 'mermaid') {
            return `<div class="md-mermaid-container"><pre class="mermaid">${escapeHtml(item.code.trim())}</pre></div>`;
        }

        const langBadge = item.lang ? `<span class="code-lang-badge">${escapeHtml(item.lang)}</span>` : '';
        const copyBtn = `<button class="code-copy-btn" onclick="copyCodeBlock(this)" title="코드 복사">📋 복사</button>`;
        return `
            <div class="md-code-block-wrapper">
                <div class="code-block-header">
                    ${langBadge}
                    ${copyBtn}
                </div>
                <pre class="md-code-pre"><code class="language-${escapeHtml(item.lang)}">${escapeHtml(item.code.trim())}</code></pre>
            </div>
        `;
    });

    // 12) Inline Code 복원
    text = text.replace(/@@@MDINLINECODE(\d+)@@@/g, (match, idx) => {
        const code = inlineCodes[parseInt(idx, 10)];
        return `<code class="md-inline-code">${escapeHtml(code || '')}</code>`;
    });

    return text;
}

function parseInlineMarkdown(str) {
    if (!str) return '';
    return str
        .replace(/!\[(.*?)\]\((.*?)\)/g, '<img src="$2" alt="$1" class="md-img" onerror="this.style.display=\'none\'">')
        .replace(/\[(.*?)\]\((.*?)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer" class="md-link">$1</a>')
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/__(.+?)__/g, '<strong>$1</strong>')
        .replace(/\*(.+?)\*/g, '<em>$1</em>')
        .replace(/_(.+?)_/g, '<em>$1</em>')
        .replace(/~~(.+?)~~/g, '<del>$1</del>');
}

// ==========================================
// 4. Mermaid 렌더링 & 체크박스 연동
// ==========================================
function renderMermaidBlocks(container) {
    const mermaidEls = container.querySelectorAll('.mermaid');
    if (mermaidEls.length === 0) return;

    if (window.mermaid && typeof mermaid.run === 'function') {
        try {
            mermaid.run({
                nodes: mermaidEls
            });
        } catch (e) {
            console.warn('Markdown 내 Mermaid 렌더링 오류:', e);
        }
    }
}

function bindTaskCheckboxClicks(container) {
    const checkboxes = container.querySelectorAll('.md-task-checkbox');
    checkboxes.forEach((cb) => {
        cb.addEventListener('change', (e) => {
            const isChecked = e.target.checked;
            const taskIndex = parseInt(e.target.getAttribute('data-task-index'), 10);
            toggleMarkdownTaskInSource(taskIndex, isChecked);
        });
    });
}

function toggleMarkdownTaskInSource(taskIndex, isChecked) {
    const editor = document.getElementById('markdown-editor-input');
    if (!editor) return;

    let currentIndex = 0;
    const lines = editor.value.split('\n');

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (/^\s*[-*+]\s+\[[ xX]\]\s+/.test(line)) {
            if (currentIndex === taskIndex) {
                const mark = isChecked ? 'x' : ' ';
                lines[i] = line.replace(/^(\s*[-*+]\s+\[)[ xX](\]\s+.*)$/, `$1${mark}$2`);
                break;
            }
            currentIndex++;
        }
    }

    editor.value = lines.join('\n');
    mdState.content = editor.value;
    localStorage.setItem('md_viewer_content', mdState.content);
    updateMarkdownStats();
}

function bindCodeCopyButtons(container) {
    // onclick 속성으로 처리됨
}

async function copyCodeBlock(btn) {
    const wrapper = btn.closest('.md-code-block-wrapper');
    const codeEl = wrapper?.querySelector('code');
    if (!codeEl) return;

    await navigator.clipboard.writeText(codeEl.textContent);
    const originalText = btn.innerHTML;
    btn.innerHTML = '✅ 복사됨!';
    btn.classList.add('copied');
    setTimeout(() => {
        btn.innerHTML = originalText;
        btn.classList.remove('copied');
    }, 1500);
}

// ==========================================
// 5. 뷰 모드 전환 (Split / Editor / Preview)
// ==========================================
function setMarkdownViewMode(mode) {
    mdState.viewMode = mode;
    localStorage.setItem('md_viewer_mode', mode);

    const editorPane = document.getElementById('markdown-editor-pane');
    const previewPane = document.getElementById('markdown-preview-pane');
    const resizer = document.getElementById('markdown-resizer');
    const modeBtns = document.querySelectorAll('.md-mode-btn');

    modeBtns.forEach(btn => {
        btn.classList.toggle('active', btn.getAttribute('data-mode') === mode);
    });

    if (mode === 'split') {
        if (editorPane) {
            editorPane.style.display = 'flex';
            editorPane.style.flex = '1';
        }
        if (previewPane) {
            previewPane.style.display = 'flex';
            previewPane.style.flex = '1';
        }
        if (resizer) resizer.style.display = 'flex';
    } else if (mode === 'editor') {
        if (editorPane) {
            editorPane.style.display = 'flex';
            editorPane.style.flex = '1';
        }
        if (previewPane) previewPane.style.display = 'none';
        if (resizer) resizer.style.display = 'none';
    } else if (mode === 'preview') {
        if (editorPane) editorPane.style.display = 'none';
        if (previewPane) {
            previewPane.style.display = 'flex';
            previewPane.style.flex = '1';
        }
        if (resizer) resizer.style.display = 'none';
    }
}

// ==========================================
// 6. 스플리터 드래그 조절기 & 동기화 스크롤
// ==========================================
function initMarkdownResizer() {
    const resizer = document.getElementById('markdown-resizer');
    const editorPane = document.getElementById('markdown-editor-pane');
    const container = document.getElementById('markdown-split-container');
    if (!resizer || !editorPane || !container) return;

    let isResizing = false;

    resizer.addEventListener('mousedown', (e) => {
        isResizing = true;
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
    });

    document.addEventListener('mousemove', (e) => {
        if (!isResizing || mdState.viewMode !== 'split') return;
        const containerRect = container.getBoundingClientRect();
        const newWidth = e.clientX - containerRect.left;

        if (newWidth > 200 && newWidth < containerRect.width - 200) {
            const percent = (newWidth / containerRect.width) * 100;
            editorPane.style.flex = `0 0 ${percent}%`;
            localStorage.setItem('md_editor_width', percent);
        }
    });

    document.addEventListener('mouseup', () => {
        if (isResizing) {
            isResizing = false;
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
        }
    });

    const savedWidth = localStorage.getItem('md_editor_width');
    if (savedWidth && mdState.viewMode === 'split') {
        editorPane.style.flex = `0 0 ${savedWidth}%`;
    }
}

function initMarkdownSyncScroll() {
    const editor = document.getElementById('markdown-editor-input');
    const preview = document.getElementById('markdown-preview-output');
    if (!editor || !preview) return;

    let isSyncingEditor = false;
    let isSyncingPreview = false;

    editor.addEventListener('scroll', () => {
        if (!mdState.syncScroll || isSyncingEditor) return;
        isSyncingPreview = true;
        const percentage = editor.scrollTop / (editor.scrollHeight - editor.clientHeight);
        preview.scrollTop = percentage * (preview.scrollHeight - preview.clientHeight);
        setTimeout(() => { isSyncingPreview = false; }, 50);
    });

    preview.addEventListener('scroll', () => {
        if (!mdState.syncScroll || isSyncingPreview) return;
        isSyncingEditor = true;
        const percentage = preview.scrollTop / (preview.scrollHeight - preview.clientHeight);
        editor.scrollTop = percentage * (editor.scrollHeight - editor.clientHeight);
        setTimeout(() => { isSyncingEditor = false; }, 50);
    });
}

// ==========================================
// 7. 문서 통계 및 목차(TOC) 생성
// ==========================================
function updateMarkdownStats() {
    const statsEl = document.getElementById('markdown-stats-summary');
    if (!statsEl) return;

    const text = mdState.content || '';
    const chars = text.length;
    const charsNoSpace = text.replace(/\s/g, '').length;
    const words = text.trim() ? text.trim().split(/\s+/).length : 0;
    const lines = text ? text.split('\n').length : 0;
    const readTimeMinutes = Math.max(1, Math.ceil(words / 200));

    statsEl.innerHTML = `<span>📝 <b>${chars.toLocaleString()}</b>자 (공백제외 <b>${charsNoSpace.toLocaleString()}</b>자) | <b>${words.toLocaleString()}</b>단어 | <b>${lines.toLocaleString()}</b>줄 | ⏱️ 예상 읽기 <b>${readTimeMinutes}</b>분</span>`;
}

function updateMarkdownFileBadge() {
    const badge = document.getElementById('markdown-file-badge');
    if (!badge) return;

    if (mdState.fileName) {
        const sizeStr = mdState.fileSize > 0 ? ` (${(mdState.fileSize / 1024).toFixed(1)} KB)` : '';
        badge.textContent = `📁 ${mdState.fileName}${sizeStr}`;
        badge.style.display = 'inline-flex';
    } else {
        badge.style.display = 'none';
    }
}

function openMarkdownTocModal() {
    const preview = document.getElementById('markdown-preview-output');
    const headings = preview?.querySelectorAll('h1, h2, h3, h4, h5, h6');
    if (!headings || headings.length === 0) {
        showAppAlert('문서에 제목(# 헤더)이 없습니다.\n마크다운 텍스트에 # 헤더를 추가해 주세요.', '목차 알림', 'ℹ️');
        return;
    }

    const listEl = document.getElementById('markdown-toc-modal-list');
    if (!listEl) return;

    let tocHtml = '';
    headings.forEach(h => {
        const level = h.tagName.toLowerCase();
        const text = h.textContent;
        const id = h.id;
        tocHtml += `<a class="md-toc-item md-toc-${level}" href="#${id}" onclick="jumpToMarkdownHeading('${id}'); return false;">${escapeHtml(text)}</a>`;
    });
    listEl.innerHTML = tocHtml;

    const modal = document.getElementById('markdown-toc-modal');
    if (modal) modal.classList.add('show');
}

function closeMarkdownTocModal() {
    const modal = document.getElementById('markdown-toc-modal');
    if (modal) modal.classList.remove('show');
}

function jumpToMarkdownHeading(id) {
    closeMarkdownTocModal();
    const headingEl = document.getElementById(id);
    if (headingEl) {
        headingEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
        headingEl.classList.add('md-heading-highlight');
        setTimeout(() => { headingEl.classList.remove('md-heading-highlight'); }, 1500);
    }
}

// ==========================================
// 8. 내보내기 & 복사 & 저장 액션
// ==========================================
async function copyMarkdownSource() {
    if (!mdState.content) {
        await showAppAlert('복사할 마크다운 내용이 없습니다.', '알림', '⚠️');
        return;
    }
    await navigator.clipboard.writeText(mdState.content);
    logToConsole('Markdown 원본 복사 완료', `${mdState.content.length.toLocaleString()}자`);
    showToast('복사 완료', 'Markdown 소스 코드가 클립보드에 복사되었습니다! 📋', '✅');
}

async function copyMarkdownRenderedHtml() {
    const preview = document.getElementById('markdown-preview-output');
    if (!preview || !preview.innerHTML) {
        await showAppAlert('복사할 렌더링 내용이 없습니다.', '알림', '⚠️');
        return;
    }

    const htmlContent = `<!DOCTYPE html>
<html lang="ko">
<head>
    <meta charset="UTF-8">
    <title>${escapeHtml(mdState.fileName || 'Markdown Document')}</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #1f2328; max-width: 900px; margin: 40px auto; padding: 0 20px; }
        table { border-collapse: collapse; width: 100%; margin: 16px 0; }
        th, td { border: 1px solid #d0d7de; padding: 6px 13px; }
        th { background: #f6f8fa; }
        blockquote { border-left: 4px solid #d0d7de; color: #656d76; padding: 0 16px; margin: 16px 0; }
        pre { background: #f6f8fa; padding: 16px; border-radius: 6px; overflow: auto; }
        code { background: rgba(175, 184, 193, 0.2); padding: 2px 4px; border-radius: 4px; font-family: monospace; }
        hr { border: none; border-top: 1px solid #d0d7de; margin: 24px 0; }
    </style>
</head>
<body>
${preview.innerHTML}
</body>
</html>`;

    await navigator.clipboard.writeText(htmlContent);
    logToConsole('HTML 복사 완료', '렌더링된 HTML 문서 코드가 클립보드에 복사되었습니다.');
    showToast('복사 완료', '렌더링된 전체 HTML 코드가 클립보드에 복사되었습니다! 🌐', '✅');
}

async function saveMarkdownToFile() {
    if (!mdState.content) {
        await showAppAlert('저장할 마크다운 내용이 없습니다.', '알림', '⚠️');
        return;
    }

    const defaultName = mdState.fileName || 'document.md';

    if (window.eel && typeof eel.save_markdown_to_file === 'function') {
        const res = await eel.save_markdown_to_file(mdState.content, defaultName)();
        if (res && res.status === 'success') {
            mdState.fileName = res.file_name;
            mdState.filePath = res.path;
            updateMarkdownFileBadge();
            logToConsole('Markdown 파일 저장 완료', res.path);
            showToast('저장 완료', `Markdown 파일이 안전하게 저장되었습니다! 💾\n(${res.path})`, '✅');
        }
    } else {
        const blob = new Blob([mdState.content], { type: 'text/markdown;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = defaultName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }
}

function printMarkdownDocument() {
    const preview = document.getElementById('markdown-preview-output');
    if (!preview || !preview.innerHTML.trim()) {
        showAppAlert('인쇄할 문서 내용이 없습니다.', '알림', '⚠️');
        return;
    }

    const printWin = window.open('', '_blank', 'width=900,height=800');
    if (!printWin) return;

    printWin.document.write(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>${escapeHtml(mdState.fileName || 'Markdown_Document')}</title>
            <style>
                body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #111; padding: 30px; }
                h1, h2, h3 { border-bottom: 1px solid #ddd; padding-bottom: 6px; }
                table { border-collapse: collapse; width: 100%; margin: 16px 0; }
                th, td { border: 1px solid #ccc; padding: 6px 10px; }
                th { background: #f0f0f0; }
                blockquote { border-left: 4px solid #4f46e5; background: #f8f9fc; padding: 10px 16px; margin: 16px 0; }
                pre { background: #f5f5f5; border: 1px solid #ddd; padding: 12px; border-radius: 6px; }
                code { background: #eee; padding: 2px 4px; border-radius: 4px; font-family: monospace; }
                .md-alert { border: 1px solid #ddd; border-left: 4px solid #4f46e5; padding: 12px; margin: 14px 0; border-radius: 4px; }
                .code-copy-btn, .code-lang-badge { display: none; }
            </style>
        </head>
        <body>
            ${preview.innerHTML}
            <script>
                window.onload = function() {
                    window.print();
                    setTimeout(() => window.close(), 500);
                };
            </script>
        </body>
        </html>
    `);
    printWin.document.close();
}

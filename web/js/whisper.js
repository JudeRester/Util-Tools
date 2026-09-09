/**
 * 음성 전사(STT) 및 다중 화자 분리(Diarization) 프론트엔드 제어 모듈 (web/js/whisper.js)
 * - faster-whisper 기반 고성능 로컬 STT 및 sherpa-onnx 화자 분리 스튜디오
 * - 원본 오디오 라이브러리 및 런 이력 듀얼 뷰
 * - Bottle 206 HTTP Range 네이티브 오디오 플레이어 연동 및 타임코드 점프
 * - Active Interval Sweep 기반 화자별 색상 뱃지 및 인라인 텍스트 편집 (SSOT)
 * - 실시간 EWMA RTF & ETA 진행률 추적
 * - 비차단 인레이어 UI 원칙(showAppAlert, showAppConfirm, showToast) 엄수
 */

const whisperState = {
    selectedAudioId: null,
    selectedRunId: null,
    audioLibrary: [],
    currentRuns: [],
    activeRunDetail: null,
    systemInfo: null,
    sidebarTab: 'audio', // 'audio' | 'runs'
    searchQueryAudio: '',
    searchQuerySegments: '',
    isTranscribing: false,
    activeRunId: null
};

// 화자별 고유 테마 색상 팔레트
const SPEAKER_COLORS = [
    { bg: 'rgba(56, 189, 248, 0.15)', text: '#38bdf8', border: 'rgba(56, 189, 248, 0.35)' }, // Blue
    { bg: 'rgba(52, 211, 153, 0.15)', text: '#34d399', border: 'rgba(52, 211, 153, 0.35)' }, // Emerald
    { bg: 'rgba(167, 139, 250, 0.15)', text: '#a78bfa', border: 'rgba(167, 139, 250, 0.35)' }, // Purple
    { bg: 'rgba(251, 146, 60, 0.15)', text: '#fb923c', border: 'rgba(251, 146, 60, 0.35)' }, // Amber
    { bg: 'rgba(244, 114, 182, 0.15)', text: '#f472b6', border: 'rgba(244, 114, 182, 0.35)' }, // Pink
    { bg: 'rgba(148, 163, 184, 0.15)', text: '#94a3b8', border: 'rgba(148, 163, 184, 0.35)' }  // Gray (Unknown)
];

function getSpeakerColor(speakerId) {
    if (!speakerId || speakerId === 'SPEAKER_UNKNOWN') {
        return SPEAKER_COLORS[5];
    }
    const match = speakerId.match(/\d+/);
    if (match) {
        const idx = parseInt(match[0], 10) % 5;
        return SPEAKER_COLORS[idx];
    }
    return SPEAKER_COLORS[0];
}

function formatSeconds(sec) {
    if (!sec || isNaN(sec)) return '00:00';
    sec = Math.max(0, Math.floor(sec));
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function formatFileSize(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}


// ==============================================================================
// 1. 초기화 및 라이프사이클 관리
// ==============================================================================
async function initWhisperStudio() {
    console.log('[Whisper] 음성 전사 & 화자 분리 스튜디오 초기화...');
    await loadWhisperSystemInfo();
    await refreshAudioLibrary();

    // 오디오 플레이어 타임 업데이트 시 자막 자동 하이라이트
    const player = document.getElementById('whisper-audio-player');
    if (player) {
        player.ontimeupdate = onAudioTimeUpdate;
    }

    // 드래그 앤 드롭 영역 바인딩
    setupAudioDropZone();
}

function teardownWhisperStudio() {
    const player = document.getElementById('whisper-audio-player');
    if (player && !player.paused) {
        player.pause();
    }
}

async function loadWhisperSystemInfo() {
    try {
        if (window.eel && typeof eel.get_whisper_system_info === 'function') {
            const info = await eel.get_whisper_system_info()();
            whisperState.systemInfo = info;
            updateHardwareBadges(info);
        }
    } catch (e) {
        console.warn('[Whisper] 시스템 정보 조회 실패:', e);
    }
}

function updateHardwareBadges(info) {
    const gpuBadge = document.getElementById('whisper-hardware-badge');
    const diarBadge = document.getElementById('whisper-diar-model-badge');
    const dlBtn = document.getElementById('whisper-dl-models-btn');
    const deviceSelect = document.getElementById('whisper-device-select');

    if (gpuBadge) {
        if (info.has_cuda) {
            gpuBadge.className = 'whisper-badge-gpu ready';
            gpuBadge.innerHTML = '<span>⚡</span> CUDA 가속 활성 (NVIDIA GPU)';
            gpuBadge.title = `CUDA 가속 사용 가능 (${info.cuda_device_count}개 장치)`;
            if (deviceSelect) deviceSelect.value = 'cuda';
        } else {
            gpuBadge.className = 'whisper-badge-gpu cpu';
            gpuBadge.innerHTML = '<span>💻</span> CPU 전사 모드';
            gpuBadge.title = 'CUDA 미검출 - CPU 모드로 동작합니다';
            if (deviceSelect) deviceSelect.value = 'cpu';
        }
    }

    if (diarBadge) {
        if (info.diarization_ready) {
            diarBadge.className = 'whisper-badge-model ready';
            diarBadge.innerHTML = '<span>🧠</span> 화자 분리 준비 완료';
            diarBadge.title = 'pyannote 3.0 & 3D-Speaker 모델 캐시 로드됨';
            if (dlBtn) dlBtn.style.display = 'none';
        } else {
            diarBadge.className = 'whisper-badge-model need-download';
            diarBadge.innerHTML = '<span>📥</span> 화자 모델 미다운로드';
            diarBadge.title = '다중 화자 분리를 위해 로컬 모델 다운로드가 필요합니다';
            if (dlBtn) dlBtn.style.display = 'inline-flex';
        }
    }
}


// ==============================================================================
// 2. 오디오 파일 등록 및 라이브러리 렌더링
// ==============================================================================
async function openWhisperFilePicker() {
    try {
        if (window.eel && typeof eel.select_audio_files_dialog === 'function') {
            const res = await eel.select_audio_files_dialog()();
            if (res.status === 'success' && res.paths && res.paths.length > 0) {
                await importAudioFiles(res.paths);
            }
        } else {
            showToast('파일 선택', '오디오 선택 대화상자를 열 수 없습니다.', '⚠️');
        }
    } catch (e) {
        console.error('[Whisper] 파일 선택 오류:', e);
        showAppAlert(`오디오 파일 선택 중 오류가 발생했습니다:\n${e.message}`, '오류', '❌');
    }
}

async function importAudioFiles(paths) {
    if (!paths || paths.length === 0) return;
    try {
        const res = await eel.add_audio_files(paths)();
        if (res.success) {
            const addedCount = (res.added || []).length;
            showToast('오디오 등록 완료', `${addedCount}개 파일이 라이브러리에 등록되었습니다.`, '🎵');
            await refreshAudioLibrary();
            if (addedCount > 0 && res.added[0].id) {
                selectAudioFile(res.added[0].id);
            }
        } else {
            showAppAlert(res.message || '오디오 등록 실패', '오류', '❌');
        }
    } catch (e) {
        console.error('[Whisper] add_audio_files 오류:', e);
        showAppAlert(`오디오 등록 중 오류가 발생했습니다:\n${e.message}`, '오류', '❌');
    }
}

const ALLOWED_AUDIO_EXTENSIONS = new Set([
    'mp3', 'wav', 'm4a', 'flac', 'ogg', 'aac', 'wma', 'opus', 'mp4', 'mkv', 'webm', 'avi'
]);
const MAX_AUDIO_FILE_SIZE_BYTES = 2 * 1024 * 1024 * 1024; // 2GB

function setupAudioDropZone() {
    const container = document.getElementById('tab-whisper');
    const dropZone = document.getElementById('whisper-drop-zone');
    const dropIcon = document.getElementById('whisper-drop-icon');
    const dropText = document.getElementById('whisper-drop-text');
    const dropSub = document.getElementById('whisper-drop-sub');
    if (!container) return;

    let dragCounter = 0;

    const setDragVisual = (isOver) => {
        if (!dropZone) return;
        if (isOver) {
            dropZone.classList.add('drag-over');
            if (dropIcon) dropIcon.textContent = '📥';
            if (dropText) dropText.innerHTML = '<b>여기에 오디오 파일을 놓으세요</b>';
            if (dropSub) dropSub.textContent = '드롭 시 라이브러리에 즉시 등록됩니다';
        } else {
            dropZone.classList.remove('drag-over');
            if (dropIcon) dropIcon.textContent = '🎙️';
            if (dropText) dropText.innerHTML = '<b>오디오 파일 드래그 앤 드롭</b>';
            if (dropSub) dropSub.textContent = '또는 클릭하여 파일 선택 (MP3, WAV, M4A 등)';
        }
    };

    // 브라우저 기본 파일 열기 동작 전역 방지
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
        container.addEventListener(eventName, (e) => {
            e.preventDefault();
            e.stopPropagation();
        });
    });

    container.addEventListener('dragenter', (e) => {
        dragCounter++;
        setDragVisual(true);
    });

    container.addEventListener('dragover', (e) => {
        e.dataTransfer.dropEffect = 'copy';
        if (dragCounter === 0) {
            dragCounter = 1;
            setDragVisual(true);
        }
    });

    container.addEventListener('dragleave', (e) => {
        dragCounter--;
        if (dragCounter <= 0) {
            dragCounter = 0;
            setDragVisual(false);
        }
    });

    container.addEventListener('drop', async (e) => {
        dragCounter = 0;
        setDragVisual(false);

        const dt = e.dataTransfer;
        if (!dt || !dt.files || dt.files.length === 0) return;

        // 드롭 시 사이드바 탭을 '오디오 목록'으로 자동 전환
        if (typeof switchWhisperSidebarTab === 'function') {
            switchWhisperSidebarTab('audio');
        }

        const validPaths = [];
        const invalidExtFiles = [];
        const emptyFiles = [];
        const oversizedFiles = [];

        for (let i = 0; i < dt.files.length; i++) {
            const file = dt.files[i];
            const filename = file.name || '';
            const ext = filename.split('.').pop()?.toLowerCase() || '';

            if (!ALLOWED_AUDIO_EXTENSIONS.has(ext)) {
                invalidExtFiles.push(filename);
                continue;
            }

            if (file.size === 0) {
                emptyFiles.push(filename);
                continue;
            }

            if (file.size > MAX_AUDIO_FILE_SIZE_BYTES) {
                oversizedFiles.push(filename);
                continue;
            }

            if (file.path) {
                validPaths.push(file.path);
            }
        }

        if (invalidExtFiles.length > 0) {
            const preview = invalidExtFiles.slice(0, 2).join(', ');
            const extra = invalidExtFiles.length > 2 ? ` 외 ${invalidExtFiles.length - 2}개` : '';
            showToast('지원되지 않는 파일 형식', `${preview}${extra}은(는) 지원되지 않는 오디오/비디오 형식입니다.`, 'warning');
        }

        if (emptyFiles.length > 0) {
            showToast('빈 파일 제외', `${emptyFiles.slice(0, 2).join(', ')} 파일 크기가 0바이트입니다.`, 'warning');
        }

        if (oversizedFiles.length > 0) {
            showToast('파일 크기 초과', `${oversizedFiles.join(', ')} 파일이 2GB 제한을 초과했습니다.`, 'warning');
        }

        if (validPaths.length > 0) {
            await importAudioFiles(validPaths);
        }
    });
}

async function refreshAudioLibrary() {
    try {
        if (window.eel && typeof eel.get_audio_library === 'function') {
            const rows = await eel.get_audio_library()();
            whisperState.audioLibrary = rows || [];
            renderAudioList();

            const countBadge = document.getElementById('whisper-audio-count-badge');
            if (countBadge) countBadge.textContent = whisperState.audioLibrary.length;

            // 현재 선택된 파일이 있으면 갱신, 없으면 첫 번째 파일 자동 선택
            if (whisperState.selectedAudioId) {
                const stillExists = whisperState.audioLibrary.some(a => a.id === whisperState.selectedAudioId);
                if (stillExists) {
                    await loadAudioRuns(whisperState.selectedAudioId);
                } else if (whisperState.audioLibrary.length > 0) {
                    selectAudioFile(whisperState.audioLibrary[0].id);
                }
            } else if (whisperState.audioLibrary.length > 0) {
                selectAudioFile(whisperState.audioLibrary[0].id);
            }
        }
    } catch (e) {
        console.warn('[Whisper] 오디오 라이브러리 새로고침 실패:', e);
    }
}

function renderAudioList() {
    const container = document.getElementById('whisper-audio-items');
    if (!container) return;

    const query = whisperState.searchQueryAudio.trim().toLowerCase();
    const filtered = whisperState.audioLibrary.filter(a => {
        if (!query) return true;
        return (a.filename || '').toLowerCase().includes(query);
    });

    if (filtered.length === 0) {
        container.innerHTML = `
            <div class="whisper-empty-state" onclick="openWhisperFilePicker()" style="cursor: pointer;" title="클릭하여 오디오 파일 선택">
                <div style="font-size: 1.6rem; margin-bottom: 6px;">🎙️</div>
                ${whisperState.audioLibrary.length === 0 ? '등록된 오디오 파일이 없습니다.<br>상단 드롭 영역으로 드래그하거나 <b>여기를 클릭</b>하세요.' : '검색 결과와 일치하는 오디오 파일이 없습니다.'}
            </div>
        `;
        return;
    }

    container.innerHTML = filtered.map(item => {
        const isSelected = item.id === whisperState.selectedAudioId;
        const durStr = formatSeconds(item.duration_sec);
        const sizeStr = formatFileSize(item.file_size);

        // 최신 런 상태 뱃지
        let statusBadge = '';
        if (item.latest_status === 'COMPLETED') {
            statusBadge = '<span class="status-pill completed">완료</span>';
        } else if (item.latest_status === 'TRANSCRIBING' || item.latest_status === 'DIARIZING' || item.latest_status === 'ALIGNING') {
            statusBadge = '<span class="status-pill in-progress">진행 중</span>';
        } else if (item.latest_status === 'FAILED') {
            statusBadge = '<span class="status-pill failed">실패</span>';
        } else if (item.latest_status === 'CANCELLED') {
            statusBadge = '<span class="status-pill cancelled">취소됨</span>';
        }

        return `
            <div class="whisper-list-item ${isSelected ? 'active' : ''}" onclick="selectAudioFile(${item.id})">
                <div class="item-main-row">
                    <span class="item-audio-icon">🎵</span>
                    <span class="item-filename" title="${escapeHtml(item.filename)}">${escapeHtml(item.filename)}</span>
                    <button type="button" class="item-del-btn" onclick="deleteAudioFilePrompt(${item.id}, event)" title="오디오 및 전사 이력 삭제">🗑️</button>
                </div>
                <div class="item-meta-row">
                    <span class="meta-duration">${durStr}</span>
                    <span class="meta-size">${sizeStr}</span>
                    ${statusBadge}
                </div>
            </div>
        `;
    }).join('');
}

function filterAudioList(q) {
    whisperState.searchQueryAudio = q || '';
    renderAudioList();
}

async function selectAudioFile(audioId) {
    whisperState.selectedAudioId = audioId;
    renderAudioList();

    const audioItem = whisperState.audioLibrary.find(a => a.id === audioId);
    if (!audioItem) return;

    // 상단 오디오 정보 갱신
    const titleEl = document.getElementById('whisper-current-filename');
    const metaEl = document.getElementById('whisper-current-meta');
    if (titleEl) titleEl.textContent = audioItem.filename;
    if (metaEl) {
        metaEl.textContent = `${formatSeconds(audioItem.duration_sec)} | ${formatFileSize(audioItem.file_size)} | ${audioItem.file_path}`;
    }

    // Bottle 206 Partial Content 스트리밍 오디오 플레이어 소스 바인딩
    const player = document.getElementById('whisper-audio-player');
    if (player) {
        const audioUrl = `/api/whisper/audio/${audioId}`;
        if (player.getAttribute('data-loaded-id') !== String(audioId)) {
            player.src = audioUrl;
            player.setAttribute('data-loaded-id', String(audioId));
            player.load();
        }
    }

    // 전사 런 이력 로드
    await loadAudioRuns(audioId);
}

async function deleteAudioFilePrompt(audioId, event) {
    if (event) event.stopPropagation();
    const item = whisperState.audioLibrary.find(a => a.id === audioId);
    const filename = item ? item.filename : '이 파일';

    const ok = await showAppConfirm(
        `'${filename}' 오디오 및 연관된 모든 전사 런을 영구 삭제하시겠습니까?\n(로컬 디스크의 원본 파일은 삭제되지 않습니다)`,
        { title: '오디오 삭제 확인', icon: '🗑️', confirmText: '삭제', cancelText: '취소' }
    );
    if (!ok) return;

    try {
        const res = await eel.delete_audio_file(audioId)();
        if (res.success) {
            showToast('삭제 완료', '오디오 파일이 라이브러리에서 제거되었습니다.', '🗑️');
            if (whisperState.selectedAudioId === audioId) {
                whisperState.selectedAudioId = null;
                whisperState.selectedRunId = null;
                whisperState.activeRunDetail = null;
                clearSegmentsViewer();
            }
            await refreshAudioLibrary();
        }
    } catch (e) {
        console.error('[Whisper] delete_audio_file 오류:', e);
        showAppAlert(`삭제 실패:\n${e.message}`, '오류', '❌');
    }
}


// ==============================================================================
// 3. 전사 런 이력 관리 및 선택
// ==============================================================================
async function loadAudioRuns(audioId) {
    try {
        if (window.eel && typeof eel.get_audio_runs === 'function') {
            const runs = await eel.get_audio_runs(audioId)();
            whisperState.currentRuns = runs || [];
            renderRunsList();

            const runsBadge = document.getElementById('whisper-runs-count-badge');
            if (runsBadge) runsBadge.textContent = whisperState.currentRuns.length;

            // 진행 중인 런이 있으면 자동 추적
            const activeRun = whisperState.currentRuns.find(r =>
                ['PENDING', 'TRANSCRIBING', 'DIARIZING', 'ALIGNING'].includes(r.status)
            );
            if (activeRun) {
                setTranscribingUiState(true, activeRun.id);
            } else {
                setTranscribingUiState(false);
            }

            // 최신 런 자동 선택 (기존 선택이 없거나 유효하지 않은 경우)
            if (whisperState.currentRuns.length > 0) {
                const stillValid = whisperState.currentRuns.some(r => r.id === whisperState.selectedRunId);
                if (!stillValid) {
                    selectRun(whisperState.currentRuns[0].id);
                } else {
                    selectRun(whisperState.selectedRunId);
                }
            } else {
                whisperState.selectedRunId = null;
                whisperState.activeRunDetail = null;
                clearSegmentsViewer();
            }
        }
    } catch (e) {
        console.warn('[Whisper] 전사 런 목록 로드 실패:', e);
    }
}

function renderRunsList() {
    const container = document.getElementById('whisper-runs-items');
    if (!container) return;

    if (whisperState.currentRuns.length === 0) {
        container.innerHTML = `
            <div class="whisper-empty-state">
                전사 런 이력이 없습니다.<br>우측 패널에서 [▶ 전사 실행] 버튼을 눌러주세요.
            </div>
        `;
        return;
    }

    container.innerHTML = whisperState.currentRuns.map(run => {
        const isSelected = run.id === whisperState.selectedRunId;
        const timeStr = (run.created_at || '').substring(5, 16);
        const diarStr = run.enable_diarization ? '화자분리' : 'STT';
        const modelStr = `${run.model_name || 'small'} (${run.stt_device || 'cuda'})`;

        let statusClass = 'pending';
        let statusText = run.status;
        if (run.status === 'COMPLETED') {
            statusClass = 'completed';
            statusText = '완료';
        } else if (['TRANSCRIBING', 'DIARIZING', 'ALIGNING'].includes(run.status)) {
            statusClass = 'in-progress';
            statusText = `${Math.round(run.progress || 0)}%`;
        } else if (run.status === 'FAILED') {
            statusClass = 'failed';
            statusText = '실패';
        } else if (run.status === 'CANCELLED') {
            statusClass = 'cancelled';
            statusText = '취소';
        }

        return `
            <div class="whisper-list-item ${isSelected ? 'active' : ''}" onclick="selectRun(${run.id})">
                <div class="item-main-row">
                    <span class="item-run-icon">📋</span>
                    <span class="item-run-title">Run #${run.id} · ${diarStr}</span>
                    <button type="button" class="item-del-btn" onclick="deleteRunPrompt(${run.id}, event)" title="런 삭제">🗑️</button>
                </div>
                <div class="item-meta-row">
                    <span class="meta-model">${modelStr}</span>
                    <span class="meta-time">${timeStr}</span>
                    <span class="status-pill ${statusClass}">${statusText}</span>
                </div>
            </div>
        `;
    }).join('');
}

async function selectRun(runId) {
    whisperState.selectedRunId = runId;
    renderRunsList();

    try {
        const detail = await eel.get_run_detail(runId)();
        whisperState.activeRunDetail = detail;
        renderSegmentsViewer(detail);
    } catch (e) {
        console.error('[Whisper] get_run_detail 오류:', e);
    }
}

async function deleteRunPrompt(runId, event) {
    if (event) event.stopPropagation();
    const ok = await showAppConfirm(
        `Run #${runId} 전사 결과 및 자막 데이터를 영구 삭제하시겠습니까?`,
        { title: '런 삭제 확인', icon: '🗑️', confirmText: '삭제', cancelText: '취소' }
    );
    if (!ok) return;

    try {
        const res = await eel.delete_transcription_run(runId)();
        if (res.success) {
            showToast('삭제 완료', `Run #${runId}이 삭제되었습니다.`, '🗑️');
            if (whisperState.selectedRunId === runId) {
                whisperState.selectedRunId = null;
                whisperState.activeRunDetail = null;
                clearSegmentsViewer();
            }
            if (whisperState.selectedAudioId) {
                await loadAudioRuns(whisperState.selectedAudioId);
            }
        }
    } catch (e) {
        console.error('[Whisper] delete_transcription_run 오류:', e);
        showAppAlert(`삭제 실패:\n${e.message}`, '오류', '❌');
    }
}

function switchWhisperSidebarTab(tab) {
    whisperState.sidebarTab = tab;
    const audioBtn = document.getElementById('whisper-tab-audio-btn');
    const runsBtn = document.getElementById('whisper-tab-runs-btn');
    const audioPanel = document.getElementById('whisper-audio-list-panel');
    const runsPanel = document.getElementById('whisper-runs-list-panel');

    if (tab === 'audio') {
        if (audioBtn) audioBtn.classList.add('active');
        if (runsBtn) runsBtn.classList.remove('active');
        if (audioPanel) audioPanel.classList.add('active');
        if (runsPanel) runsPanel.classList.remove('active');
    } else {
        if (audioBtn) audioBtn.classList.remove('active');
        if (runsBtn) runsBtn.classList.add('active');
        if (audioPanel) audioPanel.classList.remove('active');
        if (runsPanel) runsPanel.classList.add('active');
    }
}


// ==============================================================================
// 4. 전사 실행 및 취소 제어
// ==============================================================================
async function startWhisperRun() {
    if (!whisperState.selectedAudioId) {
        showAppAlert('전사할 오디오 파일을 좌측 목록에서 먼저 선택해주세요.', '안내', 'ℹ️');
        return;
    }

    const modelName = document.getElementById('whisper-model-select')?.value || 'small';
    const language = document.getElementById('whisper-lang-select')?.value || 'ko';
    const sttDevice = document.getElementById('whisper-device-select')?.value || 'cuda';
    const enableDiarization = document.getElementById('whisper-diar-checkbox')?.checked || false;
    const numSpeakers = parseInt(document.getElementById('whisper-speakers-select')?.value || '0', 10);

    // 화자 분리 활성화 시 모델 사전 존재 여부 확인
    if (enableDiarization && whisperState.systemInfo && !whisperState.systemInfo.diarization_ready) {
        const ok = await showAppConfirm(
            '다중 화자 분리를 위해 로컬 AI 모델(약 44MB) 다운로드가 필요합니다.\n지금 다운로드하여 전사를 계속 진행하시겠습니까?',
            { title: '화자 분리 모델 다운로드 안내', icon: '📥', confirmText: '다운로드 및 시작', cancelText: '취소' }
        );
        if (!ok) return;
    }

    const options = {
        model_name: modelName,
        language: language,
        stt_device: sttDevice,
        enable_diarization: enableDiarization,
        num_speakers: numSpeakers,
        cluster_threshold: 0.5
    };

    setTranscribingUiState(true);

    try {
        const res = await eel.start_transcription_run(whisperState.selectedAudioId, options)();
        if (res.success) {
            whisperState.activeRunId = res.run_id;
            showToast('전사 큐 등록', `Run #${res.run_id} 작업이 순차 큐에 등록되었습니다.`, '🎙️');
            await loadAudioRuns(whisperState.selectedAudioId);
            switchWhisperSidebarTab('runs');
        } else {
            setTranscribingUiState(false);
            showAppAlert(res.message || '전사 시작 실패', '오류', '❌');
        }
    } catch (e) {
        setTranscribingUiState(false);
        console.error('[Whisper] start_transcription_run 오류:', e);
        showAppAlert(`전사 시작 중 오류:\n${e.message}`, '오류', '❌');
    }
}

async function cancelWhisperRun() {
    const runId = whisperState.activeRunId || whisperState.selectedRunId;
    if (!runId) return;

    const ok = await showAppConfirm(
        `진행 중인 Run #${runId} 전사 작업을 취소하시겠습니까?`,
        { title: '작업 취소', icon: '⏹', confirmText: '취소 실행', cancelText: '계속 진행' }
    );
    if (!ok) return;

    try {
        await eel.cancel_transcription_run(runId)();
        showToast('작업 취소 요청', `Run #${runId} 취소 신호를 보냈습니다.`, '⏹');
    } catch (e) {
        console.error('[Whisper] cancel_transcription_run 오류:', e);
    }
}

function setTranscribingUiState(isBusy, runId = null) {
    whisperState.isTranscribing = isBusy;
    if (runId) whisperState.activeRunId = runId;

    const startBtn = document.getElementById('whisper-start-run-btn');
    const cancelBtn = document.getElementById('whisper-cancel-run-btn');
    const progressSection = document.getElementById('whisper-progress-section');

    if (isBusy) {
        if (startBtn) startBtn.style.display = 'none';
        if (cancelBtn) cancelBtn.style.display = 'inline-flex';
        if (progressSection) progressSection.style.display = 'block';
    } else {
        if (startBtn) startBtn.style.display = 'inline-flex';
        if (cancelBtn) cancelBtn.style.display = 'none';
        if (progressSection) progressSection.style.display = 'none';
    }
}

function onToggleDiarizationCheckbox(checked) {
    const speakersField = document.getElementById('whisper-speakers-field');
    if (speakersField) {
        speakersField.style.display = checked ? 'flex' : 'none';
    }
}


// ==============================================================================
// 5. 실시간 진행률 브로드캐스트 핸들러 (Eel Exposed)
// ==============================================================================
eel.expose(on_whisper_progress, 'on_whisper_progress');
function on_whisper_progress(payload) {
    if (!payload) return;

    const { run_id, audio_id, status, current_phase, progress, rtf, eta_sec, phase_message } = payload;

    // 현재 작업 중인 경우 UI 활성화
    if (['TRANSCRIBING', 'DIARIZING', 'ALIGNING'].includes(status)) {
        setTranscribingUiState(true, run_id);
    }

    const badgeEl = document.getElementById('whisper-phase-badge');
    const msgEl = document.getElementById('whisper-phase-msg');
    const rtfEl = document.getElementById('whisper-metric-rtf');
    const etaEl = document.getElementById('whisper-metric-eta');
    const pctEl = document.getElementById('whisper-metric-pct');
    const fillEl = document.getElementById('whisper-progress-bar-fill');

    if (badgeEl) {
        badgeEl.textContent = current_phase;
        badgeEl.className = `whisper-phase-badge phase-${(current_phase || '').toLowerCase()}`;
    }
    if (msgEl) msgEl.textContent = phase_message || '';
    if (rtfEl) rtfEl.textContent = rtf > 0 ? `RTF: ${rtf.toFixed(2)}x` : 'RTF: -';
    if (etaEl) etaEl.textContent = eta_sec > 0 ? `ETA: ${Math.round(eta_sec)}s` : 'ETA: -';
    if (pctEl) pctEl.textContent = `${Math.round(progress || 0)}%`;
    if (fillEl) fillEl.style.width = `${Math.min(100, Math.max(0, progress || 0))}%`;

    // 런 완료 / 실패 / 취소 시
    if (status === 'COMPLETED') {
        setTranscribingUiState(false);
        showToast('전사 완료', `Run #${run_id} 전사 및 화자 분리가 성공적으로 완료되었습니다.`, '✨');
        if (whisperState.selectedAudioId === audio_id) {
            loadAudioRuns(audio_id).then(() => {
                selectRun(run_id);
            });
        }
    } else if (status === 'FAILED') {
        setTranscribingUiState(false);
        showAppAlert(phase_message || '전사 작업 중 오류가 발생했습니다.', '전사 실패', '❌');
        if (whisperState.selectedAudioId === audio_id) {
            loadAudioRuns(audio_id);
        }
    } else if (status === 'CANCELLED') {
        setTranscribingUiState(false);
        showToast('작업 취소', `Run #${run_id}이 취소되었습니다.`, '⏹');
        if (whisperState.selectedAudioId === audio_id) {
            loadAudioRuns(audio_id);
        }
    }
}

// 화자 분리 모델 사전 다운로드 브로드캐스트 핸들러
eel.expose(on_diarization_model_download_progress, 'on_diarization_model_download_progress');
function on_diarization_model_download_progress(payload) {
    if (!payload) return;
    const dlBtn = document.getElementById('whisper-dl-models-btn');
    if (payload.success) {
        showToast('모델 다운로드 완료', '화자 분리 모델이 성공적으로 준비되었습니다.', '🎉');
        loadWhisperSystemInfo();
    } else if (payload.error) {
        showAppAlert(`화자 모델 다운로드 실패:\n${payload.error}`, '다운로드 오류', '❌');
        if (dlBtn) dlBtn.innerHTML = '<span>📥</span> 화자 분리 모델 다운로드';
    } else {
        if (dlBtn) {
            dlBtn.innerHTML = `<span>⏳</span> 다운로드 중 (${Math.round(payload.percent || 0)}%)...`;
        }
    }
}

async function triggerDiarizationModelDownload() {
    const ok = await showAppConfirm(
        '화자 분리(pyannote 3.0 + 3D-Speaker) 모델(약 44MB)을 다운로드하시겠습니까?',
        { title: '모델 다운로드 확인', icon: '📥', confirmText: '다운로드 시작', cancelText: '취소' }
    );
    if (!ok) return;

    const dlBtn = document.getElementById('whisper-dl-models-btn');
    if (dlBtn) dlBtn.innerHTML = '<span>⏳</span> 다운로드 시작 중...';

    try {
        await eel.download_diarization_models()();
        showToast('다운로드 시작', '백그라운드에서 모델 다운로드가 시작되었습니다.', '📥');
    } catch (e) {
        showAppAlert(`다운로드 시작 오류:\n${e.message}`, '오류', '❌');
    }
}


// ==============================================================================
// 6. 자막 세그먼트 타임라인 렌더링 & 인터랙션
// ==============================================================================
function renderSegmentsViewer(runDetail) {
    const listEl = document.getElementById('whisper-segments-list');
    const countBadge = document.getElementById('whisper-segment-count-badge');
    const renameBtn = document.getElementById('whisper-rename-speaker-btn');
    if (!listEl) return;

    if (!runDetail || !runDetail.segments || runDetail.segments.length === 0) {
        clearSegmentsViewer();
        return;
    }

    const segments = runDetail.segments;
    const speakerNames = runDetail.speaker_names || {};
    const query = whisperState.searchQuerySegments.trim().toLowerCase();

    if (countBadge) countBadge.textContent = `${segments.length}개 세그먼트`;
    if (renameBtn) renameBtn.style.display = Object.keys(speakerNames).length > 0 ? 'inline-flex' : 'none';

    const filtered = segments.filter(s => {
        if (!query) return true;
        const txt = (s.text || '').toLowerCase();
        const spk = (speakerNames[s.speaker] || s.speaker || '').toLowerCase();
        return txt.includes(query) || spk.includes(query);
    });

    if (filtered.length === 0) {
        listEl.innerHTML = `
            <div class="whisper-empty-segments">
                <span class="empty-icon">🔍</span>
                <p>검색어 '${escapeHtml(whisperState.searchQuerySegments)}'와 일치하는 세그먼트가 없습니다.</p>
            </div>
        `;
        return;
    }

    listEl.innerHTML = filtered.map(seg => {
        const spkId = seg.speaker || 'SPEAKER_00';
        const spkName = speakerNames[spkId] || (spkId === 'SPEAKER_UNKNOWN' ? '미확인 화자' : spkId);
        const col = getSpeakerColor(spkId);
        const startStr = formatSeconds(seg.start);
        const endStr = formatSeconds(seg.end);

        return `
            <div class="whisper-segment-item" data-seg-id="${seg.id}" data-start="${seg.start}" data-end="${seg.end}">
                <div class="seg-time-speaker-col">
                    <button type="button" class="seg-time-btn" onclick="jumpAudioToTime(${seg.start})" title="오디오 ${startStr}로 재생 점프">
                        <span class="play-mini-icon">▶</span> ${startStr}
                    </button>
                    <span class="seg-speaker-pill" style="background: ${col.bg}; color: ${col.text}; border: 1px solid ${col.border};" title="${spkId}">
                        ${escapeHtml(spkName)}
                    </span>
                </div>
                <div class="seg-content-col">
                    <div class="seg-text-display" id="seg-text-${seg.id}" contenteditable="true"
                         onblur="onSegmentTextBlur(${runDetail.id}, ${seg.id}, this)"
                         onkeydown="onSegmentTextKeydown(event, ${runDetail.id}, ${seg.id}, this)"
                         title="클릭하여 텍스트 직접 수정">${escapeHtml(seg.text)}</div>
                </div>
                <div class="seg-actions-col">
                    <button type="button" class="mini-tool-btn icon-only" onclick="copySegmentText('${escapeJsString(seg.text)}')" title="텍스트 복사">📋</button>
                </div>
            </div>
        `;
    }).join('');
}

function clearSegmentsViewer() {
    const listEl = document.getElementById('whisper-segments-list');
    const countBadge = document.getElementById('whisper-segment-count-badge');
    const renameBtn = document.getElementById('whisper-rename-speaker-btn');

    if (countBadge) countBadge.textContent = '0개 세그먼트';
    if (renameBtn) renameBtn.style.display = 'none';

    if (listEl) {
        listEl.innerHTML = `
            <div class="whisper-empty-segments">
                <span class="empty-icon">🎙️</span>
                <p>전사 결과를 선택하거나 상단에서 [전사 실행]을 눌러주세요.</p>
            </div>
        `;
    }
}

function filterSegmentsList(q) {
    whisperState.searchQuerySegments = q || '';
    if (whisperState.activeRunDetail) {
        renderSegmentsViewer(whisperState.activeRunDetail);
    }
}

function jumpAudioToTime(seconds) {
    const player = document.getElementById('whisper-audio-player');
    if (player) {
        player.currentTime = Math.max(0, seconds);
        if (player.paused) {
            player.play().catch(() => {});
        }
    }
}

function setWhisperPlaybackRate(rate) {
    const player = document.getElementById('whisper-audio-player');
    if (player) {
        player.playbackRate = rate;
    }
    const buttons = document.querySelectorAll('.whisper-rate-buttons .rate-btn');
    buttons.forEach(b => {
        if (parseFloat(b.textContent) === rate) {
            b.classList.add('active');
        } else {
            b.classList.remove('active');
        }
    });
}

function onAudioTimeUpdate() {
    const player = document.getElementById('whisper-audio-player');
    if (!player) return;
    const curTime = player.currentTime;

    const segmentItems = document.querySelectorAll('.whisper-segment-item');
    segmentItems.forEach(item => {
        const start = parseFloat(item.getAttribute('data-start') || '0');
        const end = parseFloat(item.getAttribute('data-end') || '0');
        if (curTime >= start && curTime <= end) {
            item.classList.add('playing-active');
        } else {
            item.classList.remove('playing-active');
        }
    });
}


// ==============================================================================
// 7. 세그먼트 인라인 텍스트 편집 (SSOT 동기화)
// ==============================================================================
async function onSegmentTextBlur(runId, segId, el) {
    const newText = (el.innerText || '').trim();
    await saveSegmentText(runId, segId, newText, el);
}

function onSegmentTextKeydown(event, runId, segId, el) {
    if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        el.blur(); // blur 트리거하여 자동 저장
    }
}

async function saveSegmentText(runId, segId, newText, el) {
    try {
        const res = await eel.update_segment_text(runId, segId, newText)();
        if (res.success) {
            // 로컬 캐시 갱신
            if (whisperState.activeRunDetail && whisperState.activeRunDetail.id === runId) {
                whisperState.activeRunDetail.segments = res.segments;
            }
            if (el) {
                el.classList.add('save-flash');
                setTimeout(() => el.classList.remove('save-flash'), 1000);
            }
        }
    } catch (e) {
        console.error('[Whisper] update_segment_text 실패:', e);
        showToast('저장 실패', e.message, '❌');
    }
}

function copySegmentText(text) {
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => {
        showToast('복사 완료', '클립보드에 자막 텍스트가 복사되었습니다.', '📋');
    }).catch(err => {
        console.warn('복사 실패:', err);
    });
}


// ==============================================================================
// 8. 화자 이름 일괄 매핑 모달
// ==============================================================================
function openSpeakerRenameModal() {
    const modal = document.getElementById('whisper-speaker-modal');
    const body = document.getElementById('whisper-speaker-modal-body');
    if (!modal || !body || !whisperState.activeRunDetail) return;

    const speakerNames = whisperState.activeRunDetail.speaker_names || {};
    const spkIds = Object.keys(speakerNames);

    if (spkIds.length === 0) {
        showToast('안내', '수정할 화자 목록이 없습니다.', 'ℹ️');
        return;
    }

    body.innerHTML = `
        <div class="whisper-speaker-form-list">
            <p class="whisper-help-text" style="color: var(--text-secondary); margin-bottom: 14px; font-size: 0.88rem;">
                각 화자별 표시 이름을 입력하세요. 전체 자막 타임라인 및 내보내기에 즉시 적용됩니다.
            </p>
            ${spkIds.map(spkId => {
                const col = getSpeakerColor(spkId);
                const currentName = speakerNames[spkId] || spkId;
                return `
                    <div class="speaker-rename-row" style="display: flex; align-items: center; gap: 10px; margin-bottom: 10px;">
                        <span class="seg-speaker-pill" style="background: ${col.bg}; color: ${col.text}; border: 1px solid ${col.border}; min-width: 100px; text-align: center;">
                            ${spkId}
                        </span>
                        <input type="text" class="form-input" id="input-rename-${spkId}" value="${escapeHtml(currentName)}" style="flex: 1;" placeholder="화자 이름 입력..." maxlength="30">
                        <button type="button" class="mini-tool-btn" onclick="saveSingleSpeakerName('${spkId}')">적용</button>
                    </div>
                `;
            }).join('')}
        </div>
    `;

    modal.classList.add('active');
}

function closeSpeakerRenameModal() {
    const modal = document.getElementById('whisper-speaker-modal');
    if (modal) modal.classList.remove('active');
}

async function saveSingleSpeakerName(spkId) {
    if (!whisperState.selectedRunId) return;
    const input = document.getElementById(`input-rename-${spkId}`);
    if (!input) return;

    const newName = input.value.trim() || spkId;
    try {
        const res = await eel.rename_speaker(whisperState.selectedRunId, spkId, newName)();
        if (res.success) {
            if (whisperState.activeRunDetail) {
                whisperState.activeRunDetail.speaker_names = res.speaker_names;
                renderSegmentsViewer(whisperState.activeRunDetail);
            }
            showToast('화자명 변경', `'${spkId}' ➔ '${newName}' 변경 완료`, '🏷️');
        }
    } catch (e) {
        console.error('[Whisper] rename_speaker 실패:', e);
        showAppAlert(`화자 이름 변경 오류:\n${e.message}`, '오류', '❌');
    }
}


// ==============================================================================
// 9. 자막 내보내기 (SRT, VTT, TXT)
// ==============================================================================
function toggleExportSubtitlesDropdown(event) {
    if (event) event.stopPropagation();
    const menu = document.getElementById('whisper-export-menu');
    if (menu) {
        menu.classList.toggle('open');
    }
}

document.addEventListener('click', () => {
    const menu = document.getElementById('whisper-export-menu');
    if (menu && menu.classList.contains('open')) {
        menu.classList.remove('open');
    }
});

async function exportSubtitlesRun(format) {
    if (!whisperState.selectedRunId) {
        showAppAlert('내보낼 전사 결과를 먼저 선택해주세요.', '안내', 'ℹ️');
        return;
    }

    try {
        const res = await eel.export_subtitles(whisperState.selectedRunId, format)();
        if (res.success && res.content) {
            // 브라우저 파일 다운로드 트리거
            const blob = new Blob([res.content], { type: 'text/plain;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = res.filename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);

            showToast('자막 다운로드', `'${res.filename}' 파일 다운로드가 완료되었습니다.`, '💾');
        } else {
            showAppAlert(res.message || '내보내기 실패', '오류', '❌');
        }
    } catch (e) {
        console.error('[Whisper] export_subtitles 오류:', e);
        showAppAlert(`자막 내보내기 오류:\n${e.message}`, '오류', '❌');
    }
}

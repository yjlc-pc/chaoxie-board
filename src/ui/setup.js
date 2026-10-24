/* ============================================================
   setup.js —— 输入页投影层
   只做两件事：把 settings 投影到控件、把控件事件交给 handlers。
   ============================================================ */

import { settings } from '../core/settings.js';
import { formatSpeed } from '../core/format.js';

const ui = {};
let handlers = {};

function el(id) {
    return document.getElementById(id);
}

function cache() {
    [
        'dropzone', 'file-input', 'preview', 'preview-img', 'preview-meta', 'btn-clear-image',
        'btn-pick', 'btn-camera', 'btn-recognize', 'btn-sample', 'btn-offline',
        'status', 'status-text', 'status-pct', 'status-bar', 'btn-cancel',
        'env-webgpu', 'env-cache', 'env-voice',
        'input-speed', 'input-math-seconds', 'input-full-doc', 'btn-theme'
    ].forEach(id => {
        ui[id.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = el(id);
    });
}

export function showScreen(name) {
    document.getElementById('setup-screen').classList.toggle('screen--active', name === 'setup');
    document.getElementById('board-screen').classList.toggle('screen--active', name === 'board');
    document.body.classList.toggle('on-board', name === 'board');
}

export function setPreview({ dataUrl, width, height, bytes, name }) {
    if (!ui.preview) return;
    if (!dataUrl) {
        ui.preview.hidden = true;
        ui.previewImg.removeAttribute('src');
        return;
    }
    ui.preview.hidden = false;
    ui.previewImg.src = dataUrl;
    const size = bytes ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : '';
    ui.previewMeta.textContent = `${name || '图片'} · ${width}×${height}${size ? ` · ${size}` : ''}`;
}

export function setBusy(busy) {
    if (ui.btnRecognize) ui.btnRecognize.disabled = busy;
    if (ui.btnSample) ui.btnSample.disabled = busy;
    if (ui.dropzone) ui.dropzone.classList.toggle('is-busy', busy);
}

export function showStatus(text, percent = null) {
    if (!ui.status) return;
    ui.status.hidden = false;
    ui.statusText.textContent = text;
    if (percent === null || Number.isNaN(percent)) {
        ui.statusPct.textContent = '';
    } else {
        ui.statusPct.textContent = `${Math.round(percent)}%`;
        ui.statusBar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
    }
}

export function hideStatus() {
    if (!ui.status) return;
    ui.status.hidden = true;
    ui.statusBar.style.width = '0%';
}

export function setEnv({ webgpu, cache, voice }) {
    if (ui.envWebgpu) {
        ui.envWebgpu.textContent = webgpu.label;
        ui.envWebgpu.className = `env-val ${webgpu.ok ? 'good' : 'bad'}`;
    }
    if (ui.envCache && cache !== undefined) ui.envCache.textContent = cache;
    if (ui.envVoice && voice !== undefined) ui.envVoice.textContent = voice;
}

export function setRecognizeEnabled(enabled) {
    if (ui.btnRecognize) ui.btnRecognize.disabled = !enabled;
}

function syncFromSettings() {
    if (ui.inputSpeed && document.activeElement !== ui.inputSpeed) {
        ui.inputSpeed.value = String(settings.get('speed'));
    }
    if (ui.inputMathSeconds && document.activeElement !== ui.inputMathSeconds) {
        ui.inputMathSeconds.value = String(settings.get('mathSeconds'));
    }
    if (ui.inputFullDoc) ui.inputFullDoc.checked = settings.get('fullDocument');
    if (ui.btnTheme) ui.btnTheme.textContent = settings.get('theme') === 'dark' ? '☾' : '☀';
    if (ui.btnOffline) {
        ui.btnOffline.title = `当前速度 ${formatSpeed(settings.get('speed'))}`;
    }
}

export function initSetup(nextHandlers) {
    handlers = nextHandlers || {};
    cache();
    syncFromSettings();

    if (ui.btnPick) ui.btnPick.addEventListener('click', event => {
        event.stopPropagation();
        ui.fileInput.click();
    });
    if (ui.dropzone) {
        ui.dropzone.addEventListener('click', () => ui.fileInput.click());
        ui.dropzone.addEventListener('keydown', event => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                ui.fileInput.click();
            }
        });
    }
    if (ui.fileInput) {
        ui.fileInput.addEventListener('change', () => {
            const file = ui.fileInput.files && ui.fileInput.files[0];
            if (file && handlers.onFile) handlers.onFile(file);
            ui.fileInput.value = '';
        });
    }
    if (ui.btnCamera) {
        ui.btnCamera.addEventListener('click', event => {
            event.stopPropagation();
            if (handlers.onCamera) handlers.onCamera();
        });
    }
    if (ui.btnClearImage) {
        ui.btnClearImage.addEventListener('click', () => {
            if (handlers.onClearImage) handlers.onClearImage();
        });
    }
    if (ui.btnRecognize) {
        ui.btnRecognize.addEventListener('click', () => {
            if (handlers.onRecognize) handlers.onRecognize();
        });
    }
    if (ui.btnSample) {
        ui.btnSample.addEventListener('click', () => {
            if (handlers.onSample) handlers.onSample();
        });
    }
    if (ui.btnOffline) {
        ui.btnOffline.addEventListener('click', () => {
            if (handlers.onOffline) handlers.onOffline();
        });
    }
    if (ui.btnCancel) {
        ui.btnCancel.addEventListener('click', () => {
            if (handlers.onCancel) handlers.onCancel();
        });
    }
    if (ui.inputSpeed) {
        ui.inputSpeed.addEventListener('change', () => settings.set('speed', ui.inputSpeed.value));
    }
    if (ui.inputMathSeconds) {
        ui.inputMathSeconds.addEventListener('change', () => settings.set('mathSeconds', ui.inputMathSeconds.value));
    }
    if (ui.inputFullDoc) {
        ui.inputFullDoc.addEventListener('change', () => settings.set('fullDocument', ui.inputFullDoc.checked));
    }
    if (ui.btnTheme) {
        ui.btnTheme.addEventListener('click', () => {
            settings.set('theme', settings.get('theme') === 'dark' ? 'light' : 'dark');
        });
    }

    settings.subscribe(syncFromSettings);

    /* 拖拽 */
    ['dragenter', 'dragover'].forEach(type => {
        document.addEventListener(type, event => {
            if (!event.dataTransfer) return;
            event.preventDefault();
            ui.dropzone.classList.add('is-over');
        });
    });
    ['dragleave', 'drop'].forEach(type => {
        document.addEventListener(type, event => {
            if (!event.dataTransfer) return;
            event.preventDefault();
            if (type === 'dragleave' && event.relatedTarget) return;
            ui.dropzone.classList.remove('is-over');
        });
    });
    document.addEventListener('drop', event => {
        const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
        if (file && handlers.onFile) handlers.onFile(file);
    });
    /* 粘贴 */
    document.addEventListener('paste', event => {
        const items = event.clipboardData && event.clipboardData.items;
        if (!items) return;
        for (const item of items) {
            if (item.type.startsWith('image/')) {
                const file = item.getAsFile();
                if (file && handlers.onFile) handlers.onFile(file);
                break;
            }
        }
    });
}

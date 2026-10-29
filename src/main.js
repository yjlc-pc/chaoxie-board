/* ============================================================
   main.js —— 唯一装配入口
   ============================================================ */

import { CONFIG } from './core/config.js';
import { initSettings, settings } from './core/settings.js';
import { storage } from './core/storage.js';
import { initSetup, showScreen, setPreview, setBusy, showStatus, hideStatus, setEnv, setRecognizeEnabled } from './ui/setup.js';
import { initBoard, startBoard, exitBoard, getLineCount, getPublicLines, applyVoiceCommand } from './ui/boardView.js';
import { initToast, toast } from './ui/toast.js';
import { recognize, prepareImage, isHeic, warmUp, setHandlers as setOcrHandlers } from './ocr/client.js';
import { initVoice, voiceAvailable, startListening, stopListening, warmUpVoice } from './voice/voice.js';
import { describe, EXAMPLES } from './voice/commands.js';

const state = {
    file: null,
    prepared: null,
    busy: false
};

/* ---------- 主题 ---------- */

function applyTheme() {
    document.body.classList.toggle('dark', settings.get('theme') === 'dark');
    document.body.classList.toggle('light', settings.get('theme') === 'light');
}

/* ---------- .tex 组装 ---------- */

const PREAMBLE = String.raw`\documentclass[11pt]{article}
\usepackage[a4paper,margin=2cm]{geometry}
\usepackage{amsmath,amssymb}
\usepackage{multicol}
\usepackage[UTF8]{ctex}
\pagestyle{empty}
\begin{document}
`;

function wrapTex(body) {
    if (!settings.get('fullDocument')) return body;
    return `${PREAMBLE}${body}\n\\end{document}\n`;
}

/* ---------- 环境探测 ---------- */

async function detectWebGPU() {
    if (!('gpu' in navigator)) return { ok: false, label: '不可用（浏览器不支持）' };
    try {
        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) return { ok: false, label: '不可用（没有适配器）' };
        const f16 = adapter.features.has('shader-f16');
        return { ok: true, label: f16 ? '可用（支持 f16）' : '可用（无 f16）' };
    } catch (error) {
        return { ok: false, label: '检测失败' };
    }
}

async function modelCached() {
    if (!('caches' in window)) return false;
    try {
        const keys = await caches.keys();
        return keys.some(key => key.includes('transformers'));
    } catch (error) {
        return false;
    }
}

async function refreshEnv() {
    const gpu = await detectWebGPU();
    const cached = await modelCached();
    state.gpu = gpu;
    setEnv({
        webgpu: gpu,
        cache: cached ? '已缓存' : '未下载',
        voice: voiceAvailable() ? '本地 Whisper' : '未接入'
    });
    if (!gpu.ok) {
        toast('这台机器的浏览器没有可用的 WebGPU，识别会退到 CPU（很慢）', { timeout: 8000 });
    }
    return gpu;
}

/* ---------- 图片 ---------- */

async function handleFile(file) {
    if (!file) return;
    if (!file.type.startsWith('image/') && !isHeic(file)) {
        toast('只支持图片文件');
        return;
    }
    if (isHeic(file)) {
        toast('HEIC 浏览器解不了，请用系统相册导出 JPG 再试', { timeout: 7000 });
        return;
    }

    state.file = file;
    try {
        const prepared = await prepareImage(file);
        state.prepared = prepared;
        setPreview({
            dataUrl: prepared.dataUrl,
            width: prepared.width,
            height: prepared.height,
            bytes: prepared.blob.size,
            name: file.name
        });
        setRecognizeEnabled(true);
    } catch (error) {
        console.error(error);
        toast('这张图片读不出来，换一张试试');
        state.prepared = null;
        setRecognizeEnabled(false);
    }
}

function clearImage() {
    state.file = null;
    state.prepared = null;
    setPreview(null);
    setRecognizeEnabled(false);
}

/* ---------- 识别 ---------- */

function progressText(info) {
    const mb = value => (value / 1024 / 1024).toFixed(1);
    return `下载 ${info.file || '模型'} ${mb(info.loaded)} / ${mb(info.total)} MB`;
}

async function recognizeFlow() {
    if (!state.prepared || state.busy) return;
    state.busy = true;
    setBusy(true);

    const cached = await modelCached();
    if (!cached) {
        const ok = await confirmModel();
        if (!ok) {
            state.busy = false;
            setBusy(false);
            return;
        }
    }

    setOcrHandlers({
        onProgress: info => {
            if (!info.total) return;
            showStatus(progressText(info), (info.loaded / info.total) * 100);
        },
        onStatus: data => {
            showStatus(data.message || '加载模型…');
        }
    });

    try {
        showStatus(cached ? '正在识别…' : '准备下载模型…', 0);
        const began = performance.now();
        const tex = await recognize(state.prepared.blob);
        const seconds = ((performance.now() - began) / 1000).toFixed(1);

        if (!tex || tex.length < 2) {
            hideStatus();
            toast('没识别出内容，换张更清晰的图试试');
            return;
        }

        storage.set(CONFIG.LS.doc, wrapTex(tex));
        hideStatus();
        await startBoard(wrapTex(tex));
        toast(`识别完成，用时 ${seconds} 秒`, { timeout: 3000 });
    } catch (error) {
        console.error(error);
        hideStatus();
        toast(`识别失败：${error.message || error}`, { timeout: 8000 });
    } finally {
        state.busy = false;
        setBusy(false);
    }
}

function confirmModel() {
    return new Promise(resolve => {
        const dialog = document.getElementById('dlg-model');
        if (!dialog) {
            resolve(true);
            return;
        }
        const ok = document.getElementById('btn-model-ok');
        const cancel = document.getElementById('btn-model-cancel');

        const finish = value => {
            ok.removeEventListener('click', onOk);
            cancel.removeEventListener('click', onCancel);
            dialog.close();
            resolve(value);
        };
        const onOk = () => finish(true);
        const onCancel = () => finish(false);

        ok.addEventListener('click', onOk);
        cancel.addEventListener('click', onCancel);
        dialog.showModal();
    });
}

/* ---------- 离线包 ---------- */

async function downloadOffline() {
    if (state.busy) return;
    state.busy = true;
    setBusy(true);
    setOcrHandlers({
        onProgress: info => {
            if (!info.total) return;
            showStatus(progressText(info), (info.loaded / info.total) * 100);
        },
        onStatus: data => showStatus(data.message || '准备中…')
    });
    try {
        showStatus('正在下载 OCR 模型…', 0);
        await warmUp();
        showStatus('正在下载语音模型…', 0);
        const voiceOk = await warmUpVoice();
        hideStatus();
        toast(
            voiceOk ? '离线包已就绪，断网也能识别和语音改稿' : 'OCR 已离线可用；语音模型没下成，联网后按住说话会自动补下',
            { timeout: 6000 }
        );
    } catch (error) {
        hideStatus();
        toast(`离线包下载失败：${error.message || error}`, { timeout: 8000 });
    } finally {
        state.busy = false;
        setBusy(false);
    }
}

/* ---------- 摄像头 ---------- */

let cameraStream = null;

async function openCamera() {
    const dialog = document.getElementById('dlg-camera');
    const video = document.getElementById('camera-video');
    try {
        cameraStream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: 'environment', width: { ideal: 2560 } },
            audio: false
        });
        video.srcObject = cameraStream;
        await video.play();
        dialog.showModal();
    } catch (error) {
        toast(`打不开摄像头：${error.message || error}`);
    }
}

function closeCamera() {
    if (cameraStream) {
        cameraStream.getTracks().forEach(track => track.stop());
        cameraStream = null;
    }
    const dialog = document.getElementById('dlg-camera');
    if (dialog && dialog.open) dialog.close();
}

async function shootPhoto() {
    const video = document.getElementById('camera-video');
    if (!video || !video.videoWidth) return;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.92));
    closeCamera();
    if (blob) await handleFile(new File([blob], 'camera.jpg', { type: 'image/jpeg' }));
}

/* ---------- 示例 ---------- */

function loadSample() {
    startBoard(CONFIG.DEFAULT_TEX);
}

/* ---------- 装配 ---------- */

function boot() {
    initSettings();
    initToast();
    applyTheme();
    settings.subscribe(changed => {
        if (changed.includes('theme')) applyTheme();
    });

    initSetup({
        onFile: handleFile,
        onCamera: openCamera,
        onClearImage: clearImage,
        onRecognize: recognizeFlow,
        onSample: loadSample,
        onOffline: downloadOffline,
        onCancel: () => {
            state.busy = false;
            setBusy(false);
            hideStatus();
            toast('已取消，下次会重新开始');
        }
    });

    initBoard({
        onExit: () => showScreen('setup'),
        onVoiceStart: handleVoiceStart,
        onVoiceEnd: handleVoiceEnd
    });

    initVoice({
        getLineCount,
        onCommand: handleCommand,
        onUnknown: handleVoiceUnknown,
        onTranscript: text => showCaption(text),
        onState: (state, caption) => {
            const button = document.getElementById('btn-voice');
            if (button) button.dataset.state = state;
            showCaption(state === 'listening' ? '正在听…' : caption || '');
        },
        onError: message => toast(message, { timeout: 6000 })
    });

    document.getElementById('btn-camera-cancel')?.addEventListener('click', closeCamera);
    document.getElementById('btn-camera-shot')?.addEventListener('click', shootPhoto);
    document.getElementById('dlg-camera')?.addEventListener('close', closeCamera);

    document.getElementById('btn-voice')?.toggleAttribute('hidden', !voiceAvailable());

    window.addEventListener('keydown', event => {
        if (document.getElementById('board-screen').classList.contains('screen--active')) {
            if (event.key === ' ') {
                event.preventDefault();
                document.getElementById('btn-toggle')?.click();
            }
            if (event.key === 'Escape') exitBoard();
        }
    });

    refreshEnv();

    /* PWA 文件关联：系统里双击图片会走这里 */
    if ('launchQueue' in window) {
        window.launchQueue.setConsumer(async params => {
            if (!params || !params.files || !params.files.length) return;
            try {
                const file = await params.files[0].getFile();
                await handleFile(file);
            } catch (error) {
                console.warn('launchQueue 读取文件失败', error);
            }
        });
    }

    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('sw.js').catch(error => {
            console.warn('Service Worker 注册失败', error);
        });
    }

    showScreen('setup');
    document.body.dataset.booted = '1';

    /* 方便手测：?sample=1 直接进大屏 */
    if (new URLSearchParams(location.search).has('sample')) loadSample();
}

/* ---------- 语音 ---------- */

const EDIT_OPS = ['setChar', 'setLine', 'delete', 'append'];
let confirmResolver = null;

function showCaption(text) {
    const caption = document.getElementById('voice-caption');
    const node = document.getElementById('voice-text');
    if (!caption || !node) return;
    if (!text) {
        caption.hidden = true;
        return;
    }
    caption.hidden = false;
    node.textContent = text;
}

function askConfirm(message) {
    return new Promise(resolve => {
        const dialog = document.getElementById('dlg-voice');
        const preview = document.getElementById('voice-preview');
        const ok = document.getElementById('btn-voice-ok');
        const cancel = document.getElementById('btn-voice-cancel');
        preview.textContent = message;

        const finish = value => {
            confirmResolver = null;
            ok.removeEventListener('click', onOk);
            cancel.removeEventListener('click', onCancel);
            if (dialog.open) dialog.close();
            resolve(value);
        };
        const onOk = () => finish(true);
        const onCancel = () => finish(false);

        ok.addEventListener('click', onOk);
        cancel.addEventListener('click', onCancel);
        confirmResolver = finish;
        dialog.showModal();
    });
}

async function handleCommand(command) {
    /* 弹窗开着的时候，“确认 / 取消”直接用嘴说也行 */
    if (confirmResolver && (command.op === 'confirm' || command.op === 'cancel')) {
        confirmResolver(command.op === 'confirm');
        return;
    }
    if (command.op === 'confirm' || command.op === 'cancel') return;

    showCaption('');

    if (EDIT_OPS.includes(command.op)) {
        const lines = getPublicLines();
        const message = describe(command, lines);
        /* 改稿前先停，确认后从当前行继续 */
        applyVoiceCommand({ op: 'pause' });
        const ok = await askConfirm(`${message}\n\n要说「确认」或「取消」。`);
        if (!ok) {
            toast('已取消');
            return;
        }
        const result = await applyVoiceCommand(command);
        if (!result.ok) {
            toast(result.message);
            return;
        }
        if (result.tex) storage.set(CONFIG.LS.doc, wrapTex(result.tex));
        toast('已修改，从当前行继续');
        return;
    }

    const result = await applyVoiceCommand(command);
    if (!result.ok) toast(result.message);
}

function handleVoiceStart(button) {
    button.dataset.state = 'listening';
    showCaption('正在听…');
    startListening();
}

function handleVoiceEnd() {
    const button = document.getElementById('btn-voice');
    if (button) button.dataset.state = 'idle';
    stopListening();
}

function handleVoiceUnknown(raw) {
    const controls = document.getElementById('controls');
    if (controls) controls.dataset.idle = 'false';
    const sample = EXAMPLES.slice(0, 3).join(' · ');
    toast(`没听懂「${raw || '空'}」。可以说：${sample}`, { timeout: 8000 });
}

boot();

export { boot };

/* ============================================================
   voice.js —— 录音、转写、指令分流
   按住说话 → Whisper tiny 转写 → 规则解析 →（不中）FunctionGemma → 确认
   ============================================================ */

import { settings } from '../core/settings.js';
import { parseRule } from './commands.js';

let handlers = {};
let available = false;
let worker = null;
let stream = null;
let recorder = null;
let chunks = [];
let listening = false;

export function initVoice(next) {
    handlers = next || {};
    available = Boolean(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
}

export function voiceAvailable() {
    return available && settings.get('voiceEnabled');
}

function ensureWorker() {
    if (worker) return worker;
    const base = new URL('../../', import.meta.url).href;
    worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    worker.postMessage({ type: 'init', base });
    worker.addEventListener('message', event => handleWorker(event.data));
    worker.addEventListener('error', event => {
        finishPreload(false);
        if (handlers.onError) handlers.onError(`语音模块出错：${event.message || '未知错误'}`);
        setListening(false);
    });
    return worker;
}

let awaiting = null;
let preloaded = false;
let preloadResolve = null;

/** 「下载离线包」：把语音模型也拉进缓存，返回 Promise<boolean> */
export function warmUpVoice() {
    if (!voiceAvailable()) return Promise.resolve(false);
    if (preloaded) return Promise.resolve(true);
    const worker = ensureWorker();
    return new Promise(resolve => {
        preloadResolve = resolve;
        worker.postMessage({ type: 'preload' });
    });
}

function finishPreload(ok) {
    if (ok) preloaded = true;
    if (preloadResolve) {
        preloadResolve(ok);
        preloadResolve = null;
    }
}

function handleWorker(data) {
    if (!data) return;
    if (data.type === 'progress') {
        if (handlers.onState) {
            handlers.onState('loading', `下载语音模型 ${(data.loaded / 1024 / 1024).toFixed(0)} MB`);
        }
        return;
    }
    if (data.type === 'status') {
        if (handlers.onState) handlers.onState('loading', data.message);
        return;
    }
    if (data.type === 'transcript') {
        const text = data.text || '';
        if (handlers.onTranscript) handlers.onTranscript(text);
        if (!text) {
            if (handlers.onError) handlers.onError('没听清，再说一次');
            return;
        }
        const rule = parseRule(text);
        if (rule) {
            deliver(rule);
            return;
        }
        /* 规则不中才叫 FunctionGemma */
        const lines = handlers.getLineCount ? handlers.getLineCount() : 0;
        awaiting = 'command';
        ensureWorker().postMessage({ type: 'parse', text, linesHint: lines });
        return;
    }
    if (data.type === 'command') {
        awaiting = null;
        if (data.command && data.command.op) {
            deliver(data.command);
        } else if (handlers.onUnknown) {
            handlers.onUnknown(data.raw || '');
        }
        return;
    }
    if (data.type === 'preloaded') {
        finishPreload(true);
        if (handlers.onState) handlers.onState('idle', '');
        return;
    }
    if (data.type === 'error') {
        finishPreload(false);
        if (handlers.onError) handlers.onError(data.message || '语音处理失败');
    }
}

function deliver(command) {
    if (handlers.onCommand) handlers.onCommand(command);
}

export async function startListening() {
    if (!voiceAvailable() || listening) return;
    try {
        stream = await navigator.mediaDevices.getUserMedia({
            audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }
        });
    } catch (error) {
        if (handlers.onError) handlers.onError(`麦克风打不开：${error.message || error}`);
        return;
    }

    chunks = [];
    recorder = new MediaRecorder(stream);
    recorder.addEventListener('dataavailable', event => {
        if (event.data && event.data.size) chunks.push(event.data);
    });
    recorder.start();
    listening = true;
    ensureWorker();
    if (handlers.onState) handlers.onState('listening', '正在听…');
}

export async function stopListening() {
    if (!listening || !recorder) return;
    listening = false;

    const blob = await new Promise(resolve => {
        recorder.addEventListener('stop', () => resolve(new Blob(chunks, { type: recorder.mimeType })), { once: true });
        recorder.stop();
    }).catch(() => null);

    if (stream) {
        stream.getTracks().forEach(track => track.stop());
        stream = null;
    }
    recorder = null;

    if (!blob || !blob.size) {
        if (handlers.onState) handlers.onState('idle', '');
        return;
    }

    if (handlers.onState) handlers.onState('loading', '识别中…');
    try {
        const audio = await toMono16k(blob);
        ensureWorker().postMessage(
            { type: 'transcribe', audio: audio.buffer, sampleRate: 16000 },
            [audio.buffer]
        );
    } catch (error) {
        if (handlers.onError) handlers.onError(`音频处理失败：${error.message || error}`);
    }
}

function setListening(value) {
    listening = value;
}

/** 任意采样率 → 16k 单声道 */
async function toMono16k(blob) {
    const arrayBuffer = await blob.arrayBuffer();
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const decoded = await ctx.decodeAudioData(arrayBuffer);
    ctx.close();

    const target = 16000;
    const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * target), target);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start();
    const rendered = await offline.startRendering();
    return rendered.getChannelData(0);
}

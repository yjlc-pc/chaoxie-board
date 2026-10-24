/* ============================================================
   ocr/client.js —— 主线程侧的 OCR 客户端
   负责：图片预处理、Worker 生命周期、进度聚合、超时与兜底。
   ============================================================ */

import { CONFIG } from '../core/config.js';

const O = CONFIG.OCR;

let worker = null;
let seq = 0;
let ready = null;
let handlers = { onProgress: null, onStatus: null };

export function isSupported() {
    return typeof Worker !== 'undefined' && 'WebGPU' in globalThis || 'gpu' in navigator;
}

function ensureWorker() {
    if (worker) return worker;
    worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    worker.addEventListener('message', event => handleMessage(event.data));
    worker.addEventListener('error', event => {
        console.error('OCR worker error', event);
        if (pending) pending.reject(new Error(event.message || 'Worker 崩溃'));
        pending = null;
    });
    return worker;
}

let pending = null;

function handleMessage(data) {
    if (!data) return;
    if (data.type === 'progress') {
        if (handlers.onProgress) handlers.onProgress(data);
        return;
    }
    if (data.type === 'status') {
        if (handlers.onStatus) handlers.onStatus(data);
        return;
    }
    if (data.type === 'ready') {
        return;
    }
    if (data.type === 'result') {
        if (pending && pending.id === data.id) {
            pending.resolve(data.text);
            pending = null;
        }
        return;
    }
    if (data.type === 'error') {
        if (pending && (!data.id || pending.id === data.id)) {
            pending.reject(new Error(data.message));
            pending = null;
        }
    }
}

export function setHandlers(next) {
    handlers = { ...handlers, ...next };
}

export function warmUp() {
    if (ready) return ready;
    const base = new URL('../../', import.meta.url).href;
    ready = new Promise((resolve, reject) => {
        const queue = [];
        const onMsg = event => {
            const data = event.data || {};
            if (data.type === 'ready') {
                worker.removeEventListener('message', onMsg);
                resolve(data);
            } else if (data.type === 'error') {
                worker.removeEventListener('message', onMsg);
                ready = null;
                reject(new Error(data.message || '初始化失败'));
            } else if (data.type === 'progress' && handlers.onProgress) {
                handlers.onProgress(data);
            } else if (data.type === 'status' && handlers.onStatus) {
                handlers.onStatus(data);
            }
        };
        worker = ensureWorker();
        worker.addEventListener('message', onMsg);
        worker.postMessage({
            type: 'init',
            base,
            dtypes: [...O.DTYPES],
            modelId: O.MODEL
        });
        void queue;
    });
    return ready;
}

/* ---------- 图片预处理 ---------- */

export function isHeic(file) {
    const name = (file.name || '').toLowerCase();
    return /\.(heic|heif)$/.test(name) || file.type === 'image/heic' || file.type === 'image/heif';
}

/**
 * 解码 + 按最长边缩放 + 转 JPEG。
 * 手机竖拍依赖 EXIF 方向，必须在解码时应用。
 */
export async function prepareImage(blob) {
    const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' }).catch(async () => {
        return await createImageBitmap(blob);
    });

    const scale = Math.min(1, O.MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0, width, height);
    if (typeof bitmap.close === 'function') bitmap.close();

    const out = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', O.JPEG_QUALITY));
    const result = out || (await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.8)));
    return {
        blob: result,
        width,
        height,
        dataUrl: canvas.toDataURL('image/jpeg', 0.62)
    };
}

/* ---------- 识别 ---------- */

function cleanup(text) {
    if (!text) return '';
    let out = String(text).trim();
    /* 模型偶尔会把整段包在 ```markdown 里 */
    out = out.replace(/^```[a-zA-Z]*\n?/, '').replace(/\n?```$/, '');
    /* 统一行内公式定界符 */
    out = out.replace(/\\\[([\s\S]*?)\\\]/g, (_, body) => `$$${body}$$`);
    out = out.replace(/\\\(([\s\S]*?)\\\)/g, (_, body) => `$${body}$`);
    return out.trim();
}

export async function recognize(blob) {
    await warmUp();
    const buffer = await blob.arrayBuffer();
    const id = `ocr-${++seq}`;

    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            if (pending && pending.id === id) {
                pending = null;
                reject(new Error('识别超时'));
            }
        }, O.TIMEOUT_MS);

        pending = {
            id,
            resolve: text => {
                clearTimeout(timer);
                resolve(cleanup(text));
            },
            reject: error => {
                clearTimeout(timer);
                reject(error);
            }
        };

        worker.postMessage(
            {
                type: 'run',
                id,
                buffer,
                mime: blob.type || 'image/jpeg',
                prompt: O.PROMPT
            },
            [buffer]
        );
    });
}

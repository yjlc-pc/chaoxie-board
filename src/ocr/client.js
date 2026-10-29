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
    return typeof Worker !== 'undefined';
}

function ensureWorker() {
    if (worker) return worker;
    worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    worker.addEventListener('message', event => handleMessage(event.data));
    worker.addEventListener('error', event => {
        console.error('OCR worker error', event);
        if (pending) pending.reject(new Error(event.message || 'Worker 崩溃'));
        pending = null;
        resetWorker();
    });
    return worker;
}

/** 丢掉这个 Worker（卡死或崩掉时）：下次识别会重建，GPU 上下文也跟着释放 */
function resetWorker() {
    if (worker) {
        try {
            worker.terminate();
        } catch (error) {
            /* 已经死了就算了 */
        }
    }
    worker = null;
    ready = null;
    pending = null;
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
        /* 记住真正跑通的档位：下次直接从它开始，不用再等 f16 失败一次 */
        if (data.dtype) {
            try {
                localStorage.setItem(CONFIG.LS.dtype, data.dtype);
            } catch (error) {
                /* 隐私模式下写不了就算了 */
            }
        }
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
        const current = pending;
        if (current && (!data.id || current.id === data.id)) {
            resetWorker();
            current.reject(new Error(data.message));
        }
    }
}

export function setHandlers(next) {
    handlers = { ...handlers, ...next };
}

/** 上次跑通的档位排最前，剩下的按配置顺序兜底 */
function preferredDtypes() {
    const list = [...O.DTYPES];
    let saved = null;
    try {
        saved = localStorage.getItem(CONFIG.LS.dtype);
    } catch (error) {
        saved = null;
    }
    if (saved && list.includes(saved)) {
        return [saved, ...list.filter(dtype => dtype !== saved)];
    }
    return list;
}

export function warmUp() {
    if (ready) return ready;
    const base = new URL('../../', import.meta.url).href;
    ready = new Promise((resolve, reject) => {
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
            dtypes: preferredDtypes(),
            modelId: O.MODEL
        });
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
export async function prepareImage(blob, maxEdge = O.MAX_EDGE) {
    const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' }).catch(async () => {
        return await createImageBitmap(blob);
    });

    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
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
    if (handlers.onStatus) handlers.onStatus({ message: '模型就绪，正在识别…' });
    const buffer = await blob.arrayBuffer();
    const id = `ocr-${++seq}`;

    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            if (pending && pending.id === id) {
                /* GPU 上卡住时 generate() 永远不返回，只能丢掉 Worker 重来 */
                resetWorker();
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

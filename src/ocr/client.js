/* ============================================================
   ocr/client.js —— 主线程侧的 OCR 客户端
   负责：图片预处理、Worker 生命周期、进度聚合、超时与兜底。
   ============================================================ */

import { CONFIG } from '../core/config.js';

const O = CONFIG.OCR;

let worker = null;
let seq = 0;
let ready = null;
/* 当前 worker 实际用上的档位：worker 重建后要重新等 ready，这里同步记一份 */
let readyInfo = null;
/* 已经让这台机器丢过设备（或建不起会话）的档位，下次直接跳过 */
const failedDtypes = new Set();
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
function resetWorker(notifyWarmUp = true) {
    if (worker) {
        try {
            worker.terminate();
        } catch (error) {
            /* 已经死了就算了 */
        }
    }
    worker = null;
    ready = null;
    readyInfo = null;
    pending = null;
    /* 初始化阶段就丢设备时，warmUp 的 Promise 否则会永远挂着。
       message 事件的 error 分支会自己 reject，所以那里传 false，
       免得被这里的兜底文案盖掉真实原因。 */
    if (notifyWarmUp) failWarmUp();
}

let pending = null;
let readyReject = null;

function failWarmUp(message = '模型加载中断，请重试') {
    if (readyReject) {
        const reject = readyReject;
        readyReject = null;
        reject(new Error(message));
    }
    ready = null;
}

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
        /* 只是会话建起来了，还不能说明能推理——真正的「可用档位」等 usable */
        readyInfo = { dtype: data.dtype, backend: data.backend, source: data.source };
        return;
    }
    if (data.type === 'usable') {
        /* 推理成功过一次，这一档才算真跑通，记住它下次优先用 */
        failedDtypes.delete(data.dtype);
        try {
            localStorage.setItem(CONFIG.LS.dtype, data.dtype);
        } catch (error) {
            /* 隐私模式下写不了就算了 */
        }
        return;
    }
    if (data.type === 'deviceLost') {
        /* 设备丢了：这个 worker 里所有 buffer 都失效，留着只会让后续每次识别都失败 */
        const dtype = readyInfo && readyInfo.dtype;
        if (dtype) failedDtypes.add(dtype);
        const current = pending;
        resetWorker();
        if (handlers.onStatus) {
            handlers.onStatus({ message: '显卡上下文丢了，正在重建…' });
        }
        if (current) {
            const error = new Error(`WebGPU 设备丢失（${data.reason || 'unknown'}）`);
            error.deviceLost = true;
            current.reject(error);
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
        if (data.deviceLost && data.dtype) failedDtypes.add(data.dtype);
        const current = pending;
        /* 不管是推理失败还是初始化失败，这个 worker 都不再可信，直接扔。
           初始化阶段由 warmUp 自己的监听器 reject，这里不覆盖它的原因。 */
        resetWorker(false);
        if (current && (!data.id || current.id === data.id)) {
            const error = new Error(data.message);
            error.deviceLost = Boolean(data.deviceLost);
            current.reject(error);
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

/**
 * 剔除这台机器上已经失败过的档位。
 * 全失败过一轮就清空重来——之前的失败可能只是当时显存压力大，不是这一档本身不行。
 */
function usableDtypes() {
    const all = preferredDtypes();
    const left = all.filter(dtype => !failedDtypes.has(dtype));
    if (left.length) return left;
    failedDtypes.clear();
    return all;
}

export function warmUp() {
    if (ready) return ready;
    const base = new URL('../../', import.meta.url).href;
    ready = new Promise((resolve, reject) => {
        /* 用局部引用：初始化失败时 worker 会被置空，这里再去 removeEventListener 会炸 */
        const own = ensureWorker();
        const onMsg = event => {
            const data = event.data || {};
            if (data.type === 'ready') {
                own.removeEventListener('message', onMsg);
                readyReject = null;
                resolve(data);
            } else if (data.type === 'error') {
                own.removeEventListener('message', onMsg);
                /* 自己 reject，不让 resetWorker 用「加载中断」顶掉真实原因 */
                readyReject = null;
                resetWorker();
                reject(new Error(data.message || '初始化失败'));
            } else if (data.type === 'progress' && handlers.onProgress) {
                handlers.onProgress(data);
            } else if (data.type === 'status' && handlers.onStatus) {
                handlers.onStatus(data);
            }
        };
        readyReject = reject;
        own.addEventListener('message', onMsg);
        own.postMessage({
            type: 'init',
            base,
            dtypes: usableDtypes(),
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
    if (!worker) throw new Error('OCR worker 已重建，请重试');
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

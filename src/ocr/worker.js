/* ============================================================
   ocr/worker.js —— GLM-OCR 推理（WebGPU，可选 WASM 兜底）
   只在 Worker 里跑，主线程不碰模型。
   消息：
     → { type:'init', base, dtypes:[...] }
     → { type:'run', id, buffer, mime, prompt }
     ← { type:'progress', file, loaded, total }
     ← { type:'status', message, dtype }
     ← { type:'ready', dtype, backend }
     ← { type:'result', id, text }
     ← { type:'error', id, message }
   ============================================================ */

import {
    AutoProcessor,
    AutoModelForImageTextToText,
    RawImage,
    TextStreamer,
    env
} from '../../vendor/transformers/transformers.web.min.js';
import { MODEL_SOURCES, applyModelSource } from '../core/modelSource.js';
import { CONFIG } from '../core/config.js';

let model = null;
let processor = null;
let readyDtype = null;
let backend = 'webgpu';
let initializing = null;
let modelId = null;
let baseUrl = '';
/* 推理成功过一次才上报 usable：能建会话 ≠ 能推理，q4f16 就是典型 */
let usableReported = false;
/* device lost 是不可逆的，旧 device 上的 session/buffer 全部失效。
   这里只负责如实上报，重建 worker（= 新 device）由 client 负责。 */
let lostInfo = null;


function configure(base) {
    env.allowLocalModels = false;
    env.allowRemoteModels = true;
    env.useBrowserCache = true;
    /* Worker 里必须单线程：否则 ORT 探测多线程会卡死（要 SharedArrayBuffer） */
    env.backends.onnx.wasm.numThreads = 1;
    /* remoteHost / remotePathTemplate 由 chooseSource 按源设置 */
}

async function detectWebGPU() {
    if (!('gpu' in navigator)) return null;
    try {
        const adapter = await navigator.gpu.requestAdapter();
        return adapter || null;
    } catch (error) {
        return null;
    }
}

async function hasShaderF16(adapter) {
    if (!adapter) return false;
    try {
        return adapter.features.has('shader-f16');
    } catch (error) {
        return false;
    }
}

function progressCallback(info) {
    if (info && info.status === 'progress' && info.total) {
        self.postMessage({
            type: 'progress',
            file: info.file,
            loaded: info.loaded,
            total: info.total
        });
    }
}

/**
 * 拿到 ORT 正在用的 GPUDevice（worker 内单例），监听它的 lost。
 * device.lost 只会 settle 一次，而且 reason 只有 'unknown'（驱动/OOM/TDR）
 * 和 'destroyed'（应用主动销毁）两种，能区分一部分情况。
 */
async function watchDevice() {
    let device = null;
    try {
        const webgpu = env.backends && env.backends.onnx && env.backends.onnx.webgpu;
        if (webgpu && webgpu.device) device = await webgpu.device;
    } catch (error) {
        return null;
    }
    if (!device || device.__cbWatched) return device;
    device.__cbWatched = true;

    /* 把真实 limits 打出来：排查时能立刻看出是缓冲区上限还是显存不够 */
    try {
        const l = device.limits || {};
        const mb = value => (typeof value === 'number' ? Math.round(value / 1048576) : '?');
        console.info(
            `[ocr] GPU limits: maxBufferSize=${mb(l.maxBufferSize)}MB, ` +
            `maxStorageBufferBindingSize=${mb(l.maxStorageBufferBindingSize)}MB, ` +
            `maxComputeWorkgroupStorageSize=${l.maxComputeWorkgroupStorageSize || '?'}B`
        );
    } catch (error) {
        /* limits 读不到不影响推理 */
    }

    try {
        if (device.lost && typeof device.lost.then === 'function') {
            device.lost.then(info => {
                lostInfo = {
                    reason: (info && info.reason) || 'unknown',
                    message: (info && info.message) || ''
                };
                console.error('[ocr] WebGPU device lost', lostInfo);
                self.postMessage({ type: 'deviceLost', ...lostInfo });
            });
        }
    } catch (error) {
        /* 拿不到 lost 就靠 OrtRun 抛错兜底 */
    }
    return device;
}

function isLostError(error) {
    const message = String((error && error.message) || error || '');
    return (
        /device\]?\s*is\s*lost/i.test(message) ||
        /mapAsync/i.test(message) ||
        /buffer_manager\.cc/i.test(message) ||
        /AbortError/i.test(message)
    );
}

async function init({ base, dtypes, modelId: id }) {
    if (model) return { dtype: readyDtype, backend };
    if (initializing) return initializing;
    if (id) modelId = id;
    if (base) baseUrl = base;

    /* device 已经丢了就不要再建 session：同一个 device 上建出来的 session 一推理就炸 */
    if (lostInfo) {
        throw new Error(`WebGPU 设备已丢失（${lostInfo.reason}），这台 worker 无法复用`);
    }

    initializing = (async () => {
        configure(base);
        const adapter = await detectWebGPU();
        const f16 = await hasShaderF16(adapter);
        backend = adapter ? 'webgpu' : 'wasm';

        const ordered = (dtypes || []).filter(dtype => !(dtype.includes('f16') && !f16));
        if (backend === 'wasm') {
            ordered.push('q8');
        }
        if (!ordered.length) ordered.push('q4');

        let lastError = null;
        /* 源 × 量化档：魔搭为主，hf-mirror 备用 */
        for (const source of MODEL_SOURCES) {
            applyModelSource(env, source);
            for (const dtype of ordered) {
                try {
                    self.postMessage({
                        type: 'status',
                        message: `从 ${source.label} 加载模型（${dtype}）…`,
                        dtype
                    });
                    processor = await AutoProcessor.from_pretrained(modelId, {
                        progress_callback: progressCallback
                    });
                    model = await AutoModelForImageTextToText.from_pretrained(modelId, {
                        dtype,
                        device: backend,
                        /* 权重是 .onnx + .onnx_data 拆分格式，必须显式声明才会去挂载 */
                        use_external_data_format: true,
                        progress_callback: progressCallback
                    });
                    await watchDevice();
                    readyDtype = dtype;
                    self.postMessage({ type: 'ready', dtype, backend, source: source.id });
                    return { dtype, backend, source: source.id };
                } catch (error) {
                    lastError = error;
                    console.warn(`${source.id} / ${dtype} 初始化失败`, error);
                    /* 设备都丢了，换 dtype 只是把同样的失败重演一遍 */
                    if (lostInfo) throw error;
                    self.postMessage({
                        type: 'status',
                        message: `${source.label} 的 ${dtype} 不可用（${error.message || error}），换下一个…`,
                        dtype
                    });
                }
            }
        }
        throw lastError || new Error('模型初始化失败：所有来源都不可用');
    })();

    try {
        return await initializing;
    } finally {
        initializing = null;
    }
}

function buildInputs(prompt) {
    const messages = [
        {
            role: 'user',
            content: [{ type: 'image' }, { type: 'text', text: prompt }]
        }
    ];
    try {
        return processor.apply_chat_template(messages, { add_generation_prompt: true });
    } catch (error) {
        return prompt;
    }
}

async function run({ id, buffer, mime, prompt }) {
    if (!model) throw new Error('模型尚未初始化');
    const blob = new Blob([buffer], { type: mime || 'image/jpeg' });
    const image = await RawImage.fromBlob(blob);
    const text = buildInputs(prompt);

    const inputs = await processor(text, [image]);

    /* 一边生成一边报进度：核显上一页可能几十秒，界面不该一直停在「识别中」 */
    let tokens = 0;
    let streamer = null;
    try {
        const tokenizer = processor.tokenizer;
        if (TextStreamer && tokenizer) {
            streamer = new TextStreamer(tokenizer, {
                skip_prompt: true,
                skip_special_tokens: true,
                callback_function: () => {
                    tokens += 1;
                    if (tokens % 20 === 0) {
                        self.postMessage({ type: 'status', message: `识别中… 已输出 ${tokens} 个词` });
                    }
                }
            });
        }
    } catch (error) {
        streamer = null;
    }

    const output = await model.generate({
        ...inputs,
        max_new_tokens: CONFIG.OCR.MAX_NEW_TOKENS,
        do_sample: false,
        ...(streamer ? { streamer } : {})
    });

    const inputLength = inputs.input_ids.dims[1];
    const decoded = processor.batch_decode(output.slice(null, [inputLength, null]), {
        skip_special_tokens: true
    });
    const result = (decoded && decoded[0] ? decoded[0] : '').trim();

    /* 到这里才算真正跑通这一档，之前 ready 只代表会话建起来了 */
    if (!usableReported) {
        usableReported = true;
        self.postMessage({ type: 'usable', dtype: readyDtype, backend });
    }

    self.postMessage({ type: 'result', id, text: result });
}

self.addEventListener('message', async event => {
    const data = event.data || {};
    try {
        if (data.type === 'init') {
            await init(data);
            return;
        }
        if (data.type === 'run') {
            await run(data);
            return;
        }
    } catch (error) {
        console.error(error);
        /* 把「设备丢了」和「图太大/识别失败」分开上报：
           前者必须换 worker（= 新 GPUDevice），后者换个尺寸重试就行 */
        const deviceLost = Boolean(lostInfo) || isLostError(error);
        self.postMessage({
            type: 'error',
            id: data.id,
            message: error.message || String(error),
            deviceLost,
            dtype: readyDtype
        });
    }
});


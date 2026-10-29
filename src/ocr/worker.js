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

let model = null;
let processor = null;
let readyDtype = null;
let backend = 'webgpu';
let initializing = null;
let modelId = null;
let baseUrl = '';
let downgradeTried = false;

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

async function init({ base, dtypes, modelId: id }) {
    if (model) return { dtype: readyDtype, backend };
    if (initializing) return initializing;
    if (id) modelId = id;
    if (base) baseUrl = base;

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
                    readyDtype = dtype;
                    self.postMessage({ type: 'ready', dtype, backend, source: source.id });
                    return { dtype, backend, source: source.id };
                } catch (error) {
                    lastError = error;
                    console.warn(`${source.id} / ${dtype} 初始化失败`, error);
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
        max_new_tokens: 1024,
        do_sample: false,
        ...(streamer ? { streamer } : {})
    });

    const inputLength = inputs.input_ids.dims[1];
    const decoded = processor.batch_decode(output.slice(null, [inputLength, null]), {
        skip_special_tokens: true
    });
    const result = (decoded && decoded[0] ? decoded[0] : '').trim();
    self.postMessage({ type: 'result', id, text: result });
}

async function releaseModel() {
    try {
        if (model && typeof model.dispose === 'function') model.dispose();
    } catch (error) {
        /* 释放失败不影响降档重试 */
    }
    model = null;
    processor = null;
    readyDtype = null;
}

self.addEventListener('message', async event => {
    const data = event.data || {};
    try {
        if (data.type === 'init') {
            await init(data);
            return;
        }
        if (data.type === 'run') {
            try {
                await run(data);
            } catch (error) {
                /* 推理阶段挂掉（常见于 f16 着色器）：降一档 q4 重试一次 */
                if (!downgradeTried && readyDtype && readyDtype !== 'q4') {
                    downgradeTried = true;
                    self.postMessage({
                        type: 'status',
                        message: `识别失败（${error.message || error}），换 q4 再试一次…`
                    });
                    await releaseModel();
                    await init({ base: baseUrl, dtypes: ['q4'] });
                    await run(data);
                    return;
                }
                throw error;
            }
            return;
        }
    } catch (error) {
        console.error(error);
        self.postMessage({ type: 'error', id: data.id, message: error.message || String(error) });
    }
});

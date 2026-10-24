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
    env
} from '../../vendor/transformers/transformers.web.min.js';

let model = null;
let processor = null;
let readyDtype = null;
let backend = 'webgpu';
let initializing = null;

function configure(base) {
    env.allowLocalModels = false;
    env.allowRemoteModels = true;
    /* 国内直连 huggingface.co 不可靠，统一走 mirror */
    env.remoteHost = 'https://hf-mirror.com/';
    env.remotePathTemplate = '{model}/resolve/{revision}/';
    /* 离线可用：权重进 Cache Storage */
    env.useBrowserCache = true;
    env.backends.onnx.wasm.wasmPaths = new URL('vendor/transformers/', base).href;
    env.backends.onnx.wasm.numThreads = 1;
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

async function init({ base, dtypes, modelId }) {
    if (model) return { dtype: readyDtype, backend };
    if (initializing) return initializing;

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
        for (const dtype of ordered) {
            try {
                self.postMessage({ type: 'status', message: `正在加载模型（${dtype}）…`, dtype });
                processor = await AutoProcessor.from_pretrained(modelId, {
                    progress_callback: progressCallback
                });
                model = await AutoModelForImageTextToText.from_pretrained(modelId, {
                    dtype,
                    device: backend,
                    progress_callback: progressCallback
                });
                readyDtype = dtype;
                self.postMessage({ type: 'ready', dtype, backend });
                return { dtype, backend };
            } catch (error) {
                lastError = error;
                console.warn(`dtype ${dtype} 初始化失败，尝试下一档`, error);
                self.postMessage({
                    type: 'status',
                    message: `${dtype} 不可用（${error.message || error}），自动降档…`,
                    dtype
                });
            }
        }
        throw lastError || new Error('模型初始化失败');
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
    const output = await model.generate({
        ...inputs,
        max_new_tokens: 3072,
        do_sample: false
    });

    const inputLength = inputs.input_ids.dims[1];
    const decoded = processor.batch_decode(output.slice(null, [inputLength, null]), {
        skip_special_tokens: true
    });
    const result = (decoded && decoded[0] ? decoded[0] : '').trim();
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
        self.postMessage({ type: 'error', id: data.id, message: error.message || String(error) });
    }
});

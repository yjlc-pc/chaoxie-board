/* 探针：确认 transformers 有没有把 externalData 传给 ORT */

import * as ort from '../vendor/transformers/ort.webgpu.mjs';
import { AutoProcessor, AutoModelForImageTextToText, env } from '../vendor/transformers/transformers.web.min.js';
import { MODEL_SOURCES, applyModelSource } from '../src/core/modelSource.js';

const post = msg => self.postMessage(String(msg));

const original = ort.InferenceSession.create;
ort.InferenceSession.create = async function patched(...args) {
    const options = args[1] || {};
    const external = options.externalData;
    post(`create(): externalData=${external ? external.length : 'none'}` +
        (external && external.length ? ` keys=${external.map(e => e.path || e).join('|')}` : ''));
    return original.apply(this, args);
};

env.allowLocalModels = false;
env.allowRemoteModels = true;
env.useBrowserCache = true;
/* Worker 里必须单线程：不设的话 ORT 会去探测多线程（要 SharedArrayBuffer），直接卡死 */
env.backends.onnx.wasm.numThreads = 1;
applyModelSource(env, MODEL_SOURCES[0]);

try {
    await AutoProcessor.from_pretrained('onnx-community/GLM-OCR-ONNX');
    post('processor ok');
    let lastPct = -1;
    const t0 = performance.now();
    const progress_callback = info => {
        if (info.status !== 'progress' || !info.total) return;
        const pct = Math.floor((info.loaded / info.total) * 100);
        if (pct !== lastPct && pct % 10 === 0) {
            lastPct = pct;
            post(`download ${info.file} ${pct}%`);
        }
    };
    post('开始加载模型…');
    await AutoModelForImageTextToText.from_pretrained('onnx-community/GLM-OCR-ONNX', {
        dtype: 'q4f16',
        device: 'webgpu',
        use_external_data_format: true,
        progress_callback
    });
    post(`模型加载完成，用时 ${((performance.now() - t0) / 1000).toFixed(1)}s`);
    post('MODEL OK');
} catch (error) {
    post(`FAIL ${error.message}`);
}

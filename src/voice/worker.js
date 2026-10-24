/* ============================================================
   voice/worker.js —— 本地语音：Whisper 转写 + FunctionGemma 指令解析
   两个模型都走 hf-mirror，缓存在 Cache Storage。
   ============================================================ */

import {
    pipeline,
    AutoTokenizer,
    AutoModelForCausalLM,
    env
} from '../../vendor/transformers/transformers.web.min.js';

const ASR_MODEL = 'onnx-community/whisper-tiny';
const PARSE_MODEL = 'onnx-community/functiongemma-270m-it-ONNX';

let transcriber = null;
let parser = null;
let parserLoading = null;
let base = '';

function configure() {
    env.allowLocalModels = false;
    env.allowRemoteModels = true;
    env.remoteHost = 'https://hf-mirror.com/';
    env.remotePathTemplate = '{model}/resolve/{revision}/';
    env.useBrowserCache = true;
    env.backends.onnx.wasm.wasmPaths = new URL('vendor/transformers/', base).href;
    env.backends.onnx.wasm.numThreads = 1;
}

function progress(file) {
    return info => {
        if (info && info.status === 'progress' && info.total) {
            self.postMessage({ type: 'progress', file, loaded: info.loaded, total: info.total });
        }
    };
}

async function loadAsr(device) {
    if (transcriber) return transcriber;
    self.postMessage({ type: 'status', message: '加载语音模型（Whisper tiny）…' });
    transcriber = await pipeline('automatic-speech-recognition', ASR_MODEL, {
        device,
        dtype: device === 'webgpu' ? 'q4f16' : 'q8',
        progress_callback: progress('whisper')
    });
    return transcriber;
}

async function transcribe({ audio, sampleRate }) {
    const device = 'gpu' in navigator ? 'webgpu' : 'wasm';
    await loadAsr(device);
    const output = await transcriber(new Float32Array(audio), {
        language: 'chinese',
        task: 'transcribe',
        chunk_length_s: 15,
        return_timestamps: false
    });
    const text = Array.isArray(output) ? output.map(item => item.text).join('') : output.text;
    self.postMessage({ type: 'transcript', text: String(text || '').trim() });
}

const SYSTEM = `You turn one Chinese sentence into ONE JSON object.
Allowed ops and keys:
{"op":"setChar","line":<int>,"from":"<char>","to":"<char>"}
{"op":"setLine","line":<int>,"text":"<text>"}
{"op":"delete","line":<int>}
{"op":"append","text":"<text>"}
{"op":"pause"} {"op":"resume"} {"op":"prev"} {"op":"next"} {"op":"faster"} {"op":"slower"}
Rules: line is 1-based. Output JSON only, no explanation, no code fence.`;

async function loadParser(device) {
    if (parser) return parser;
    if (parserLoading) return parserLoading;
    parserLoading = (async () => {
        self.postMessage({ type: 'status', message: '加载指令解析模型（FunctionGemma）…' });
        const tokenizer = await AutoTokenizer.from_pretrained(PARSE_MODEL, {
            progress_callback: progress('functiongemma')
        });
        const model = await AutoModelForCausalLM.from_pretrained(PARSE_MODEL, {
            device,
            dtype: device === 'webgpu' ? 'q4f16' : 'q8',
            progress_callback: progress('functiongemma')
        });
        parser = { tokenizer, model };
        return parser;
    })();
    try {
        return await parserLoading;
    } finally {
        parserLoading = null;
    }
}

async function parseCommand({ text, linesHint }) {
    const device = 'gpu' in navigator ? 'webgpu' : 'wasm';
    const { tokenizer, model } = await loadParser(device);

    const prompt = `${SYSTEM}\nThere are ${linesHint} lines.\nSentence: ${text}\nJSON:`;
    const inputs = await tokenizer(prompt, { return_tensors: 'pt' });
    const output = await model.generate({
        ...inputs,
        max_new_tokens: 96,
        do_sample: false
    });

    const inputLength = inputs.input_ids.dims[1];
    const decoded = tokenizer.batch_decode(output.slice(null, [inputLength, null]), {
        skip_special_tokens: true
    });
    const raw = String(decoded[0] || '');

    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    let command = null;
    if (start !== -1 && end > start) {
        try {
            command = JSON.parse(raw.slice(start, end + 1));
        } catch (error) {
            command = null;
        }
    }
    self.postMessage({ type: 'command', command, raw });
}

self.addEventListener('message', async event => {
    const data = event.data || {};
    if (data.type === 'init') {
        base = data.base;
        configure();
        return;
    }
    try {
        if (data.type === 'transcribe') await transcribe(data);
        else if (data.type === 'parse') await parseCommand(data);
    } catch (error) {
        console.error(error);
        self.postMessage({ type: 'error', message: error.message || String(error) });
    }
});

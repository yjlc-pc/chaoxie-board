/* 用 module worker 验证 vendor 里的 transformers.js + onnxruntime-web 能否解析 */

try {
    const T = await import('../vendor/transformers/transformers.web.min.js');
    const needed = ['AutoProcessor', 'AutoModelForImageTextToText', 'RawImage', 'pipeline', 'AutoTokenizer', 'AutoModelForCausalLM', 'env'];
    const missing = needed.filter(key => !(key in T));
    self.postMessage(JSON.stringify({
        missing,
        remoteHost: T.env.remoteHost,
        wasmKeys: Object.keys(T.env.backends?.onnx ?? {})
    }));
} catch (error) {
    self.postMessage(`IMPORT-ERROR ${error && (error.stack || error.message || error)}`);
}

#!/usr/bin/env node
/* ============================================================
   verify-gpu.mjs —— 一条命令验证 GLM-OCR 在本机能不能跑
   自己起静态服务 + 自己拉 Chromium，跑完打印体检报告。

   用法：
     node tools/verify-gpu.mjs                      # 用 testdata/page1.png
     node tools/verify-gpu.mjs testdata/x.png 300   # 指定图片和超时秒数
     CLEAN=1 node tools/verify-gpu.mjs              # 先清掉 dtype 记忆，模拟全新用户

   可选环境变量：
     APP_PORT=8770   本地端口
     CDP_PORT=9222   调试端口（已有浏览器在跑就直接复用，不会去关它）
     CHROME_BIN=...  浏览器可执行文件
     HEADLESS=1      无头模式（WebGPU 常不可用，仅用于看页面能不能加载）
   ============================================================ */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir, homedir } from 'node:os';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imagePath = path.resolve(ROOT, process.argv[2] || 'testdata/page1.png');
const timeoutS = Number(process.argv[3] || 600);
const APP_PORT = Number(process.env.APP_PORT || 8770);
const CDP_PORT = Number(process.env.CDP_PORT || 9222);
const appUrl = process.env.APP_URL || `http://127.0.0.1:${APP_PORT}/`;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const line = text => console.log(text);
const head = text => console.log(`\n=== ${text} ===`);

/* ---------------- 静态服务器 ---------------- */
const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.wasm': 'application/wasm',
    '.webmanifest': 'application/manifest+json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.map': 'application/json; charset=utf-8'
};

function startServer() {
    const server = http.createServer((req, res) => {
        const url = decodeURIComponent((req.url || '/').split('?')[0]);
        const relative = url === '/' ? 'index.html' : url.replace(/^\/+/, '');
        const target = path.resolve(ROOT, relative);
        if (!target.startsWith(ROOT)) {
            res.writeHead(403).end('forbidden');
            return;
        }
        fs.readFile(target, (error, data) => {
            if (error) {
                res.writeHead(404).end('not found');
                return;
            }
            res.writeHead(200, {
                'Content-Type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
                /* wasm 线程/SIMD 需要正确的 COOP/COEP 吗？这里不用 SharedArrayBuffer，保持宽松 */
                'Cache-Control': 'no-cache'
            });
            res.end(data);
        });
    });
    return new Promise(resolve => server.listen(APP_PORT, '127.0.0.1', () => resolve(server)));
}

async function probe(url) {
    try {
        const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
        return response.ok;
    } catch (error) {
        return false;
    }
}

/* ---------------- 浏览器 ---------------- */
function findChrome() {
    if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
    const candidates = [
        'chromium-browser',
        'chromium',
        'google-chrome',
        'google-chrome-stable',
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium',
        '/opt/google/chrome/chrome',
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    ];
    for (const candidate of candidates) {
        if (candidate.startsWith('/') && fs.existsSync(candidate)) return candidate;
        try {
            execFileSync('which', [candidate], { stdio: 'ignore' });
            return candidate;
        } catch (error) {
            /* 继续找 */
        }
    }
    return null;
}

let chromeProc = null;
let server = null;
let startedChrome = false;

function launchChrome(bin) {
    /* 固定 profile：模型权重缓存在 Cache Storage 里，每次都换新目录就要重下 650MB。
       只有 FRESH=1 才清空（想复现「全新用户下载」时用）。 */
    const profile = process.env.PROFILE_DIR
        || path.join(homedir(), '.cache', 'chaoxie-verify-profile');
    if (process.env.FRESH === '1') {
        fs.rmSync(profile, { recursive: true, force: true });
        line('已清空浏览器 profile（模型要重新下载）');
    }
    fs.mkdirSync(profile, { recursive: true });

    const headless = process.env.HEADLESS === '1' || !process.env.DISPLAY;
    const args = [
        `--remote-debugging-port=${CDP_PORT}`,
        `--user-data-dir=${profile}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--enable-unsafe-webgpu',
        '--ignore-gpu-blocklist',
        '--disable-dev-shm-usage',
        ...(headless ? ['--headless=new', '--enable-unsafe-swiftshader'] : []),
        'about:blank'
    ];
    line(`启动浏览器：${bin} ${headless ? '（无头，WebGPU 多半不可用）' : '（有头）'}`);
    line(`profile：${profile}（模型缓存会留在这里）`);
    chromeProc = spawn(bin, args, { stdio: 'ignore', detached: false });
    chromeProc.on('exit', code => {
        if (code && code !== 0) line(`⚠️ 浏览器退出，code=${code}`);
    });
    startedChrome = true;
    return headless;
}

/* ---------------- CDP ---------------- */
class Cdp {
    constructor(socket) {
        this.ws = socket;
        this.seq = 0;
        this.pending = new Map();
        this.logs = [];
        this.closed = false;
        socket.addEventListener('message', event => {
            const data = JSON.parse(event.data);
            if (data.id && this.pending.has(data.id)) {
                const { resolve, reject } = this.pending.get(data.id);
                this.pending.delete(data.id);
                if (data.error) reject(new Error(data.error.message));
                else resolve(data.result);
                return;
            }
            if (data.method === 'Runtime.consoleAPICalled') {
                this.logs.push((data.params.args || []).map(a => a.value ?? a.description ?? a.type).join(' '));
            }
            if (data.method === 'Runtime.exceptionThrown') {
                const details = data.params.exceptionDetails;
                this.logs.push('EXC ' + (details.exception?.description || details.text));
            }
        });
        socket.addEventListener('close', () => {
            this.closed = true;
            for (const { reject } of this.pending.values()) reject(new Error('CDP 连接断开'));
            this.pending.clear();
        });
    }
    send(method, params = {}, timeoutMs = 20000) {
        return new Promise((resolve, reject) => {
            if (this.closed) {
                reject(new Error('CDP 连接已断开'));
                return;
            }
            const id = ++this.seq;
            /* 页面卡死时 CDP 也不会回包，必须有超时，否则脚本永远不退出 */
            const timer = setTimeout(() => {
                if (this.pending.has(id)) {
                    this.pending.delete(id);
                    reject(new Error(`${method} 超时（页面可能已经卡死）`));
                }
            }, timeoutMs);
            this.pending.set(id, {
                resolve: value => {
                    clearTimeout(timer);
                    resolve(value);
                },
                reject: error => {
                    clearTimeout(timer);
                    reject(error);
                }
            });
            this.ws.send(JSON.stringify({ id, method, params }));
        });
    }
    async evaluate(expression) {
        const result = await this.send('Runtime.evaluate', {
            expression,
            awaitPromise: true,
            returnByValue: true
        });
        if (result.exceptionDetails) {
            throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
        }
        return result.result ? result.result.value : undefined;
    }
    async evaluateJson(expression) {
        /* CDP 的 Runtime.evaluate 不是 module 上下文，表达式里不能出现顶层 await；
           这里把 Promise 返回出去，靠 awaitPromise 等结果 */
        const raw = await this.evaluate(
            `(async () => { ${expression} })().then(value => JSON.stringify(value))`
        );
        return JSON.parse(raw);
    }
}

/* ---------------- 主流程 ---------------- */
const report = { gpu: null, dtype: null, events: [], ok: false, seconds: 0, lossCount: 0 };

async function main() {
    if (!fs.existsSync(imagePath)) {
        line(`找不到图片：${imagePath}`);
        process.exit(2);
    }

    head('环境');
    if (await probe(appUrl)) {
        line(`复用已有服务：${appUrl}`);
    } else {
        server = await startServer();
        line(`静态服务已启动：${appUrl}（目录 ${ROOT}）`);
    }

    let reuseBrowser = false;
    if (await probe(`http://127.0.0.1:${CDP_PORT}/json/version`)) {
        reuseBrowser = true;
        line(`复用已有浏览器：127.0.0.1:${CDP_PORT}`);
    } else {
        const bin = findChrome();
        if (!bin) {
            line('没找到 Chromium/Chrome，请用 CHROME_BIN 指定路径');
            process.exit(2);
        }
        launchChrome(bin);
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline) {
            if (await probe(`http://127.0.0.1:${CDP_PORT}/json/version`)) break;
            await sleep(300);
        }
        if (!(await probe(`http://127.0.0.1:${CDP_PORT}/json/version`))) {
            line('浏览器调试端口没起来，换 CDP_PORT 或手动启动浏览器');
            process.exit(2);
        }
    }

    const target = await (await fetch(
        `http://127.0.0.1:${CDP_PORT}/json/new?` + encodeURIComponent('about:blank'),
        { method: 'PUT' }
    )).json();

    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
        socket.addEventListener('open', resolve, { once: true });
        socket.addEventListener('error', () => reject(new Error('连不上页面调试端口')), { once: true });
    });
    const cdp = new Cdp(socket);

    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('DOM.enable');

    /* 在页面脚本之前挂探针：拦 Worker 的消息，能精确看到 ready / usable / deviceLost */
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
        source: `
            window.__ocrEvents = [];
            const NativeWorker = window.Worker;
            if (NativeWorker) {
                window.Worker = class extends NativeWorker {
                    constructor(...args) {
                        super(...args);
                        this.addEventListener('message', event => {
                            const data = event.data || {};
                            if (['ready', 'usable', 'deviceLost', 'error'].includes(data.type)) {
                                window.__ocrEvents.push({
                                    at: Math.round(performance.now()),
                                    type: data.type,
                                    dtype: data.dtype || null,
                                    backend: data.backend || null,
                                    reason: data.reason || null,
                                    message: (data.message || '').slice(0, 300)
                                });
                            }
                        });
                    }
                };
            }
        `
    });

    await cdp.send('Page.navigate', { url: appUrl });
    await sleep(2500);

    if (process.env.CLEAN === '1') {
        await cdp.evaluate(`localStorage.removeItem('cb.ocr.dtype.v1')`);
        line('已清空 dtype 记忆');
    }

    /* 页面没装配好就往下走会白等到超时，这里先确认 UI 真的在 */
    let uiReady = false;
    for (let attempt = 0; attempt < 12 && !uiReady; attempt += 1) {
        try {
            uiReady = await cdp.evaluate(
                `Boolean(window.__ocrEvents && document.getElementById('file-input') && document.getElementById('btn-recognize'))`
            );
        } catch (error) {
            /* 页面还在导航 */
        }
        if (!uiReady) await sleep(500);
    }
    if (!uiReady) {
        line(`页面没加载出输入界面：${appUrl}`);
        line('检查端口对不对，或者页面有没有报错（下面的 console 会有线索）。');
        await finish(cdp, 2);
        return;
    }

    head('WebGPU 体检');
    report.gpu = await cdp.evaluateJson(`
        const out = { ok: false, reason: '', features: [], limits: null, info: null };
        if (!navigator.gpu) { out.reason = 'navigator.gpu 不存在（浏览器没开 WebGPU）'; return out; }
        try {
            const adapter = await navigator.gpu.requestAdapter();
            if (!adapter) { out.reason = 'requestAdapter() 返回 null（显卡被禁用/不被支持）'; return out; }
            out.ok = true;
            out.info = adapter.info ? {
                vendor: adapter.info.vendor || '',
                architecture: adapter.info.architecture || '',
                device: adapter.info.device || '',
                description: adapter.info.description || '',
                isFallbackAdapter: Boolean(adapter.info.isFallbackAdapter)
            } : null;
            out.features = [...adapter.features];
            out.limits = {
                maxBufferSize: adapter.limits.maxBufferSize,
                maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
                maxComputeWorkgroupStorageSize: adapter.limits.maxComputeWorkgroupStorageSize
            };
        } catch (error) { out.reason = String(error); }
        return out;
    `);

    const mb = value => (typeof value === 'number' ? `${Math.round(value / 1048576)}MB` : '?');
    if (report.gpu.ok) {
        const limits = report.gpu.limits || {};
        line(`设备：${report.gpu.info?.description || report.gpu.info?.device || '未知'}`);
        line(`shader-f16：${report.gpu.features.includes('shader-f16') ? '支持' : '不支持'}`);
        line(`maxBufferSize：${mb(limits.maxBufferSize)}，maxStorageBufferBindingSize：${mb(limits.maxStorageBufferBindingSize)}`);
        const other = report.gpu.features.filter(name => name !== 'shader-f16');
        if (other.length) line(`其他特性：${other.join(', ')}`);
    } else {
        line(`❌ WebGPU 不可用：${report.gpu.reason}`);
        line('   这台机器上 OCR 只能走 wasm（会非常慢），或者换有 GPU 的环境。');
    }

    if (!report.gpu.ok) {
        await finish(cdp, 1);
        return;
    }

    /* 软件渲染（SwiftShader/llvmpipe）跑 0.9B 模型没有意义，别让脚本白等一小时 */
    const description = `${report.gpu.info?.description || ''} ${report.gpu.info?.device || ''} ${report.gpu.info?.architecture || ''}`.toLowerCase();
    const software = /swiftshader|llvmpipe|software|microsoft basic/.test(description) || report.gpu.info?.isFallbackAdapter;
    if (software && process.env.FORCE !== '1') {
        line('');
        line('⚠️ 当前是软件渲染（SwiftShader/llvmpipe），0.9B 模型在上面跑不动。');
        line('   确认要试就加 FORCE=1，否则请在有真实 GPU 的桌面环境跑。');
        await finish(cdp, 2);
        return;
    }

    head('识别');
    const document = await cdp.send('DOM.getDocument');
    const input = await cdp.send('DOM.querySelector', { nodeId: document.root.nodeId, selector: '#file-input' });
    if (!input.nodeId) {
        line('页面上找不到 #file-input');
        await finish(cdp, 2);
        return;
    }
    await cdp.send('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [imagePath] });
    line(`图片：${path.relative(ROOT, imagePath)}`);
    await sleep(1200);

    const canRecognize = await cdp.evaluate(`!document.getElementById('btn-recognize').disabled`);
    if (!canRecognize) {
        line('识别按钮还是禁用状态，图片没选上，先退出（不然只能干等）。');
        await finish(cdp, 2);
        return;
    }

    await cdp.evaluate(`document.getElementById('btn-recognize').click()`);

    /* 首次下载的确认框是异步弹出来的（要先查 Cache Storage），
       单次探测容易扑空，然后一直等到超时 */
    let started = false;
    for (let attempt = 0; attempt < 30; attempt += 1) {
        const state = await cdp.evaluateJson(`
            const dialog = document.getElementById('dlg-model');
            const status = document.getElementById('status');
            return {
                dialog: Boolean(dialog && dialog.open),
                started: Boolean(status && !status.hidden)
            };
        `);
        if (state.dialog) {
            line('首次下载，已点「开始下载」');
            await cdp.evaluate(`document.getElementById('btn-model-ok').click()`);
            started = true;
            break;
        }
        if (state.started) {
            started = true;
            break;
        }
        await sleep(300);
    }
    if (!started) line('既没看到确认框也没看到进度，继续等一会儿…');
    await sleep(600);

    const began = Date.now();
    const deadline = began + timeoutS * 1000;
    let lastStatus = '';
    let boardLines = 0;

    while (Date.now() < deadline) {
        if (cdp.closed) {
            line('\n⚠️ 页面连接断开（浏览器崩了？）');
            break;
        }
        let snapshot;
        try {
            snapshot = await cdp.evaluateJson(`
                return {
                    status: (document.getElementById('status-text') || {}).textContent || '',
                    pct: (document.getElementById('status-pct') || {}).textContent || '',
                    board: document.getElementById('board-screen').classList.contains('screen--active'),
                    lines: document.querySelectorAll('.line').length,
                    toast: (document.getElementById('toast') || {}).textContent || '',
                    events: window.__ocrEvents || []
                };
            `);
        } catch (error) {
            line(`\n⚠️ 读取页面状态失败：${error.message}`);
            break;
        }

        report.events = snapshot.events;
        const current = `${snapshot.status} ${snapshot.pct}`.trim();
        if (current && current !== lastStatus) {
            line(`[${((Date.now() - began) / 1000).toFixed(1)}s] ${current}`);
            lastStatus = current;
        }
        if (snapshot.board && snapshot.lines > 0) {
            boardLines = snapshot.lines;
            report.ok = true;
            report.seconds = (Date.now() - began) / 1000;
            break;
        }
        await sleep(1500);
    }

    if (!report.ok) {
        report.seconds = (Date.now() - began) / 1000;
        line('\n❌ 没进大屏');
        try {
            line(`toast：${await cdp.evaluate(`document.getElementById('toast').textContent`)}`);
        } catch (error) {
            /* 页面可能已经崩了 */
        }
    }

    await finish(cdp, report.ok ? 0 : 1, boardLines);
}

async function finish(cdp, code, boardLines = 0) {
    /* 收尾时浏览器不响应也不能拖着用户：5 秒后强制退出 */
    setTimeout(() => process.exit(code), 5000);

    head('报告');
    const seconds = report.seconds ? `${report.seconds.toFixed(1)}s` : '-';
    line(`结果：${report.ok ? `✅ 成功，${boardLines} 行，用时 ${seconds}` : `❌ 失败，用时 ${seconds}`}`);

    const ready = report.events.filter(event => event.type === 'ready');
    const usable = report.events.filter(event => event.type === 'usable');
    const lost = report.events.filter(event => event.type === 'deviceLost');
    const errors = report.events.filter(event => event.type === 'error');

    report.lossCount = lost.length;
    if (ready.length) {
        line(`建立会话：${ready.map(event => `${event.dtype}@${event.backend}`).join(' → ')}`);
    }
    if (usable.length) {
        report.dtype = usable[usable.length - 1].dtype;
        line(`真正跑通：${report.dtype}`);
    }
    line(`device lost：${lost.length} 次`);
    lost.forEach(event => line(`  · reason=${event.reason} ${event.message || ''}`));
    if (errors.length) {
        errors.forEach(event => line(`  · 错误 [${event.dtype || '-'}] ${event.message}`));
    }

    /* 是不是靠重建 worker 救回来的 */
    const rebuilt = ready.length > 1 || lost.length > 0;
    if (report.ok && rebuilt) {
        line('说明：本次是靠「丢掉 worker → 换新 GPUDevice → 换档重试」救回来的，属于预期行为。');
    }
    if (report.ok && lost.length > 0) {
        line(`提示：${lost[0].dtype} 在这台机器上会丢设备，已经自动跳过；想再试可以 CLEAN=1 重跑。`);
    }

    const tail = cdp.logs.slice(-25);
    if (tail.length) {
        head('浏览器 console（末 25 条）');
        tail.forEach(text => line('  ' + text));
    }

    try {
        await cdp.send('Page.close');
    } catch (error) {
        /* 页面可能已经关了 */
    }
    try {
        cdp.ws.close();
    } catch (error) {
        /* 已经断了 */
    }

    if (server) server.close();
    if (startedChrome && chromeProc) {
        try {
            chromeProc.kill('SIGTERM');
        } catch (error) {
            /* 已经退了 */
        }
    }
    process.exit(code);
}

main().catch(async error => {
    line(`\n脚本出错：${error.message}`);
    if (server) server.close();
    if (startedChrome && chromeProc) {
        try {
            chromeProc.kill('SIGTERM');
        } catch (inner) {
            /* 已经退了 */
        }
    }
    process.exit(2);
});

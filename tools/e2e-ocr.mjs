#!/usr/bin/env node
/* ============================================================
   e2e-ocr.mjs —— 真浏览器端到端：选图 → 下载模型 → 识别 → 大屏
   用法：node tools/e2e-ocr.mjs <图片路径> [超时秒数]
   前置：chromium --remote-debugging-port=9222 已启动，且 8770 静态服务在跑
   ============================================================ */

const imagePath = process.argv[2] || 'testdata/page1.png';
const timeoutS = Number(process.argv[3] || 900);
const appUrl = process.env.APP_URL || 'http://127.0.0.1:8770/';
const path = await import('node:path');

const target = await (await fetch('http://127.0.0.1:9222/json/new?' + encodeURIComponent(appUrl), { method: 'PUT' })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();
const logs = [];

ws.addEventListener('message', event => {
    const data = JSON.parse(event.data);
    if (data.id && pending.has(data.id)) {
        const { resolve, reject } = pending.get(data.id);
        pending.delete(data.id);
        if (data.error) reject(new Error(data.error.message));
        else resolve(data.result);
        return;
    }
    if (data.method === 'Runtime.consoleAPICalled') {
        logs.push((data.params.args || []).map(a => a.value ?? a.description ?? a.type).join(' '));
    }
    if (data.method === 'Runtime.exceptionThrown') {
        logs.push('EXC ' + (data.params.exceptionDetails.exception?.description || data.params.exceptionDetails.text));
    }
});

const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
});

/* 浏览器被关掉/页面崩掉时，把挂着的请求全部拒掉，别留未 settle 的 await */
let browserGone = false;
const abort = reason => {
    browserGone = true;
    for (const { reject } of pending.values()) reject(new Error(reason));
    pending.clear();
};
ws.addEventListener('close', () => abort('浏览器连接已断开（窗口被关或进程崩溃）'));
ws.addEventListener('error', () => abort('CDP 连接出错'));

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    return result.result ? result.result.value : undefined;
};

await new Promise(resolve => ws.addEventListener('open', resolve, { once: true }));
await send('Runtime.enable');
await send('DOM.enable');
await send('Page.enable');
await sleep(1500);

/* 1. 塞文件 */
const doc = await send('DOM.getDocument');
const node = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#file-input' });
await send('DOM.setFileInputFiles', { nodeId: node.nodeId, files: [path.resolve(imagePath)] });
console.log('已选择图片:', imagePath);
await sleep(1500);

/* 2. 点识别 */
await evaluate(`document.getElementById('btn-recognize').click()`);
await sleep(1500);

/* 3. 首次会弹模型确认 */
const needConfirm = await evaluate(`document.getElementById('dlg-model').open`);
if (needConfirm) {
    console.log('首次下载，确认对话框已出现 → 点开始下载');
    await evaluate(`document.getElementById('btn-model-ok').click()`);
}

/* 4. 轮询进度 */
const deadline = Date.now() + timeoutS * 1000;
let lastStatus = '';
let boardStarted = false;

while (Date.now() < deadline) {
    if (browserGone) break;
    let snapshot;
    try {
        snapshot = await evaluate(`JSON.stringify({
        status: (document.getElementById('status-text')||{}).textContent || '',
        pct: (document.getElementById('status-pct')||{}).textContent || '',
        statusHidden: (document.getElementById('status')||{}).hidden,
        board: document.getElementById('board-screen').classList.contains('screen--active'),
        lines: document.querySelectorAll('.line').length,
        font: getComputedStyle(document.getElementById('lines')).getPropertyValue('--line-font').trim(),
        toast: (document.getElementById('toast')||{}).textContent || ''
    })`);
    } catch (err) {
        console.log('\n⚠️ 浏览器中断：' + err.message);
        break;
    }
    const snap = JSON.parse(snapshot);
    const line = `${snap.status} ${snap.pct}`.trim();
    if (line && line !== lastStatus) {
        console.log(`[${new Date().toLocaleTimeString('zh-CN')}] ${line}`);
        lastStatus = line;
    }
    if (snap.board && snap.lines > 0) {
        boardStarted = true;
        console.log(`\n✅ 大屏已启动：${snap.lines} 行，字号 ${snap.font}`);
        const preview = await evaluate(`[...document.querySelectorAll('.line')].map(n=>n.textContent.trim()).join('\\n')`);
        console.log('--- 识别结果 ---\n' + preview);
        break;
    }
    await sleep(2000);
}

if (!boardStarted) {
    console.log('\n❌ 超时未进大屏');
    if (!browserGone) console.log('toast:', await evaluate(`document.getElementById('toast').textContent`));
}

console.log('\n--- console ---');
logs.slice(-30).forEach(line => console.log('  ' + line));

ws.close();
process.exit(boardStarted ? 0 : 1);

#!/usr/bin/env node
/* ============================================================
   cdp-check.mjs —— 用 CDP 在真浏览器里跑一次自检
   用法：node tools/cdp-check.mjs <url> [等待毫秒]
   需要一个已经带 --remote-debugging-port=9222 启动的 Chromium。
   ============================================================ */

const port = process.env.CDP_PORT || 9222;
const url = process.argv[2] || 'http://127.0.0.1:8770/';
const waitMs = Number(process.argv[3] || 4000);

const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
const target = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json();

const ws = new WebSocket(target.webSocketDebuggerUrl);
let id = 0;
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
        const args = (data.params.args || []).map(a => a.value ?? a.description ?? a.type).join(' ');
        logs.push(`[${data.params.type}] ${args}`);
    }
    if (data.method === 'Runtime.exceptionThrown') {
        const details = data.params.exceptionDetails;
        logs.push(`[exception] ${details.text} ${details.exception?.description || ''}`);
    }
    if (data.method === 'Log.entryAdded') {
        logs.push(`[log:${data.params.entry.level}] ${data.params.entry.text} ${data.params.entry.url || ''}`);
    }
    if (data.method === 'Network.responseReceived' && data.params.response.status >= 400) {
        logs.push(`[http ${data.params.response.status}] ${data.params.response.url}`);
    }
});

const send = (method, params = {}) => new Promise((resolve, reject) => {
    const messageId = ++id;
    pending.set(messageId, { resolve, reject });
    ws.send(JSON.stringify({ id: messageId, method, params }));
});

await new Promise(resolve => ws.addEventListener('open', resolve, { once: true }));
await send('Runtime.enable');
await send('Log.enable');
await send('Network.enable');
await send('Page.enable');
await send('Page.navigate', { url });

await new Promise(resolve => setTimeout(resolve, waitMs));

const result = await send('Runtime.evaluate', {
    expression: 'JSON.stringify({booted: document.body.dataset.booted||null, lines: document.querySelectorAll(".line").length, font: getComputedStyle(document.getElementById("lines")||document.body).getPropertyValue("--line-font"), out: document.getElementById("out")?.textContent||null, title: document.title})',
    returnByValue: true
});

console.log('RESULT', result.result.value);
console.log('LOGS');
logs.forEach(line => console.log('  ' + line));
console.log('BROWSER', version.Browser);

await send('Page.close').catch(() => {});
ws.close();
process.exit(0);

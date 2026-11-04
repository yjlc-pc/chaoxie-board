/* 用 mock Worker 验证 OCR 客户端的状态机：
   1) ready 不写 dtype 缓存，只有推理成功的 usable 才写
   2) deviceLost / error / 初始化失败 都会 terminate 当前 worker
   3) 丢过设备的 dtype 会被下一次 init 跳过（换新 device + 换档）
   跑法：node tools/ocr-state-test.mjs */
import assert from 'node:assert/strict';

/* ---------- 环境桩 ---------- */
const store = new Map();
globalThis.localStorage = {
    getItem: key => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: key => store.delete(key)
};

class MockWorker extends EventTarget {
    constructor(url) {
        super();
        this.url = String(url);
        this.terminated = false;
        this.sent = [];
        MockWorker.instances.push(this);
    }
    postMessage(message) {
        this.sent.push(message);
        /* 真实 Worker 的 postMessage 是异步的，同步派发会造成重入假象 */
        if (MockWorker.onPost) {
            queueMicrotask(() => {
                if (!this.terminated && MockWorker.onPost) MockWorker.onPost(this, message);
            });
        }
    }
    terminate() {
        this.terminated = true;
    }
    emit(data) {
        this.dispatchEvent(new MessageEvent('message', { data }));
    }
}
MockWorker.instances = [];
MockWorker.onPost = null;
globalThis.Worker = MockWorker;

const { warmUp, recognize, setHandlers } = await import('../src/ocr/client.js');

const DTYPE_KEY = 'cb.ocr.dtype.v1';
const last = () => MockWorker.instances[MockWorker.instances.length - 1];
const blob = () => new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' });

let pass = 0;
function ok(name) {
    pass += 1;
    console.log(`  ✓ ${name}`);
}

/* ---------- 1. ready 不等于可用 ---------- */
{
    MockWorker.onPost = (worker, message) => {
        if (message.type === 'init') {
            worker.emit({ type: 'ready', dtype: 'q4', backend: 'webgpu', source: 'modelscope' });
        }
    };
    const info = await warmUp();
    assert.equal(info.dtype, 'q4');
    assert.equal(store.get(DTYPE_KEY), undefined, 'ready 阶段不该写 dtype 缓存');
    ok('初始化 ready 不写 dtype 缓存');
}

/* ---------- 2. 推理成功才写 ---------- */
{
    MockWorker.onPost = (worker, message) => {
        if (message.type === 'run') {
            worker.emit({ type: 'usable', dtype: 'q4', backend: 'webgpu' });
            worker.emit({ type: 'result', id: message.id, text: '  落霞与孤鹜齐飞  ' });
        }
    };
    const text = await recognize(blob());
    assert.equal(text, '落霞与孤鹜齐飞');
    assert.equal(store.get(DTYPE_KEY), 'q4', '推理成功后才记录 dtype');
    ok('推理成功写入 dtype 并返回识别文本');
}

/* ---------- 3. device lost → 重建 worker 且换档 ---------- */
{
    const before = MockWorker.instances.length;
    const dead = last();
    MockWorker.onPost = (worker, message) => {
        if (message.type === 'run') {
            worker.emit({
                type: 'deviceLost',
                reason: 'unknown',
                message: "Failed to execute 'mapAsync' on 'GPUBuffer': [Device] is lost"
            });
        }
    };

    let caught = null;
    try {
        await recognize(blob());
    } catch (error) {
        caught = error;
    }
    assert.ok(caught, 'device lost 必须让本轮识别失败');
    assert.equal(caught.deviceLost, true, '错误要带 deviceLost 标记');
    assert.equal(dead.terminated, true, '坏 worker 必须被 terminate');
    ok('device lost 会丢弃 worker 并抛出带标记的错误');

    /* 下一次识别应该新建 worker，并跳过已经丢过设备的 q4 */
    MockWorker.onPost = (worker, message) => {
        if (message.type === 'init') {
            worker.emit({ type: 'ready', dtype: message.dtypes[0], backend: 'webgpu', source: 'modelscope' });
        }
        if (message.type === 'run') {
            worker.emit({ type: 'result', id: message.id, text: 'ok' });
        }
    };
    const text = await recognize(blob());
    assert.equal(text, 'ok');
    assert.ok(MockWorker.instances.length > before, '必须新建 worker（= 新 GPUDevice）');
    const init = last().sent.find(message => message.type === 'init');
    assert.deepEqual(init.dtypes, ['q4f16'], '应跳过丢过设备的 q4，换 q4f16');
    ok('重建 worker 时跳过丢过设备的量化档');
}

/* ---------- 4. 没有 pending 的 error 也要回收 worker ---------- */
{
    /* warmUp 成功后是幂等的；先制造一次「无 pending 的 deviceLost」把缓存清掉，
       顺带验证这条路径不会把 worker 留在原地 */
    MockWorker.onPost = null;
    const stale = last();
    stale.emit({ type: 'deviceLost', reason: 'unknown', message: 'background loss' });
    assert.equal(stale.terminated, true, '没有 pending 时收到 deviceLost 也要回收');

    let attempted = null;
    MockWorker.onPost = (worker, message) => {
        if (message.type === 'init') {
            attempted = worker;
            worker.emit({ type: 'error', message: '会话创建失败' });
        }
    };
    let caught = null;
    try {
        await warmUp();
    } catch (error) {
        caught = error;
    }
    assert.ok(caught && /会话创建失败/.test(caught.message), '应透出真实失败原因');
    assert.equal(attempted && attempted.terminated, true, '初始化失败的 worker 不该留给下一次');
    ok('初始化失败会 terminate 并透出真实原因');
}

/* ---------- 5. 推理期 error（无 deviceLost 标记）也要重建 ---------- */
{
    MockWorker.onPost = (worker, message) => {
        if (message.type === 'init') {
            worker.emit({ type: 'ready', dtype: 'q4', backend: 'webgpu', source: 'modelscope' });
        }
        if (message.type === 'run') {
            worker.emit({ type: 'error', id: message.id, message: '输入维度不匹配', deviceLost: false, dtype: 'q4' });
        }
    };
    await warmUp();
    const current = last();
    let caught = null;
    try {
        await recognize(blob());
    } catch (error) {
        caught = error;
    }
    assert.ok(caught && /输入维度不匹配/.test(caught.message));
    assert.equal(caught.deviceLost, false);
    assert.equal(current.terminated, true, '推理失败同样要丢弃 worker');
    ok('推理期报错也会丢弃 worker');
}

/* ---------- 6. 进度/状态不会被误当成结果 ---------- */
{
    const seen = [];
    setHandlers({ onStatus: data => seen.push(data.message) });
    MockWorker.onPost = (worker, message) => {
        if (message.type === 'init') {
            worker.emit({ type: 'ready', dtype: 'q4', backend: 'webgpu', source: 'modelscope' });
        }
        if (message.type === 'run') {
            worker.emit({ type: 'status', message: '识别中… 已输出 20 个词' });
            worker.emit({ type: 'result', id: message.id, text: '正文' });
        }
    };
    const text = await recognize(blob());
    assert.equal(text, '正文');
    assert.ok(seen.includes('识别中… 已输出 20 个词'), '状态消息应该转发给 UI');
    ok('状态消息正常转发且不干扰结果');
}

console.log(`\n全部通过：${pass} 项`);

/* ============================================================
   modelSource.js —— 权重来源（国内优先）
   实测（2026-10，本机网络）：
     hf-mirror.com  主站 TCP 连不上，只有 cdn-lfs 子域能过
     huggingface.co DNS 被污染
     modelscope.cn  可达、CORS *、LFS 走国内 CDN
   所以魔搭为主源，hf-mirror 只当备用。
   ============================================================ */

export const MODEL_SOURCES = Object.freeze([
    {
        id: 'modelscope',
        label: 'ModelScope 魔搭',
        host: 'https://modelscope.cn/',
        /* 魔搭默认分支是 master，不是 main */
        template: 'models/{model}/resolve/master/'
    },
    {
        id: 'hf-mirror',
        label: 'hf-mirror',
        host: 'https://hf-mirror.com/',
        template: '{model}/resolve/main/'
    }
]);

/** 把某个源写进 transformers.js 的 env */
export function applyModelSource(env, source) {
    env.remoteHost = source.host;
    env.remotePathTemplate = source.template;
    return source;
}

export function sourceLabel(id) {
    const hit = MODEL_SOURCES.find(source => source.id === id);
    return hit ? hit.label : id;
}

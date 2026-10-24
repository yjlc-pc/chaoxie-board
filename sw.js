/* ============================================================
   sw.js —— 应用外壳离线
   权重不在这里管：transformers.js 自己写 Cache Storage。
   ============================================================ */

const VERSION = 'cb-v1';
const SHELL = [
    './',
    'index.html',
    'manifest.webmanifest',
    'css/tokens.css',
    'css/base.css',
    'css/setup.css',
    'css/board.css',
    'src/main.js',
    'src/core/config.js',
    'src/core/settings.js',
    'src/core/storage.js',
    'src/core/format.js',
    'src/core/split.js',
    'src/core/layout.js',
    'src/core/strokes.js',
    'src/core/modelSource.js',
    'src/latex/parse.js',
    'src/latex/render.js',
    'src/board/Board.js',
    'src/ocr/client.js',
    'src/ocr/worker.js',
    'src/ui/setup.js',
    'src/ui/boardView.js',
    'src/ui/toast.js',
    'src/voice/voice.js',
    'src/voice/worker.js',
    'src/voice/commands.js',
    'data/strokes.json',
    'pwa/icon.svg',
    'pwa/icon-192.png',
    'pwa/icon-512.png'
];

self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(VERSION).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys()
            .then(keys => Promise.all(keys.filter(key => key !== VERSION).map(key => caches.delete(key))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', event => {
    const request = event.request;
    if (request.method !== 'GET') return;

    const url = new URL(request.url);
    if (url.origin !== self.location.origin) return;

    /* 导航请求：网络优先，断网回落到缓存的 index */
    if (request.mode === 'navigate') {
        event.respondWith(
            fetch(request)
                .then(response => {
                    const copy = response.clone();
                    caches.open(VERSION).then(cache => cache.put(request, copy));
                    return response;
                })
                .catch(() => caches.match('index.html'))
        );
        return;
    }

    /* 静态资源：缓存优先，后台补新 */
    event.respondWith(
        caches.match(request).then(hit => {
            if (hit) return hit;
            return fetch(request).then(response => {
                if (response.ok) {
                    const copy = response.clone();
                    caches.open(VERSION).then(cache => cache.put(request, copy));
                }
                return response;
            });
        })
    );
});

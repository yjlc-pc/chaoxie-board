/* ============================================================
   render.js —— KaTeX 懒加载与渲染（全部本地 vendor，无 CDN）
   ============================================================ */

import { CONFIG } from '../core/config.js';

const K = CONFIG.KATEX;

let loading = null;
let engine = null;

function injectCss() {
    if (document.querySelector('link[data-katex]')) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = `${K.DIR}katex.min.css`;
    link.dataset.katex = '1';
    document.head.appendChild(link);
}

export function loadKatex() {
    if (engine) return Promise.resolve(engine);
    if (loading) return loading;

    loading = new Promise((resolve, reject) => {
        injectCss();
        const script = document.createElement('script');
        script.src = `${K.DIR}katex.min.js`;
        script.async = true;
        const timer = setTimeout(() => {
            loading = null;
            reject(new Error('KaTeX 加载超时'));
        }, K.LOAD_TIMEOUT_MS);

        script.onload = () => {
            clearTimeout(timer);
            if (!window.katex) {
                loading = null;
                reject(new Error('KaTeX 未就绪'));
                return;
            }
            engine = window.katex;
            resolve(engine);
        };
        script.onerror = () => {
            clearTimeout(timer);
            loading = null;
            reject(new Error('KaTeX 加载失败'));
        };
        document.head.appendChild(script);
    });

    return loading;
}

/** 渲染到元素；失败时回落显示源码，不抛错 */
export async function renderMathInto(el, src, display = false) {
    try {
        const katex = await loadKatex();
        katex.render(src, el, {
            displayMode: display,
            throwOnError: false,
            strict: 'ignore',
            trust: false
        });
        return true;
    } catch (error) {
        el.textContent = src;
        el.classList.add('math-fallback');
        return false;
    }
}

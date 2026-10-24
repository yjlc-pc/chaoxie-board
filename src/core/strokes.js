/* ============================================================
   strokes.js —— 笔画数（只用于算时长，不画笔顺）
   数据来自 hanzi-writer-data，构建期压平成 data/strokes.json。
   ============================================================ */

import { CONFIG } from './config.js';

let table = null;
let loading = null;

export function loadStrokes() {
    if (table) return Promise.resolve(table);
    if (loading) return loading;

    loading = fetch('data/strokes.json')
        .then(response => {
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return response.json();
        })
        .then(json => {
            table = json;
            return table;
        })
        .catch(error => {
            console.warn('笔画表加载失败，全部按估算值计时', error);
            table = {};
            return table;
        })
        .finally(() => {
            loading = null;
        });

    return loading;
}

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const ALNUM = /[0-9A-Za-z]/;

export function strokeCountOf(char) {
    if (!table) return CONFIG.STROKE_FALLBACK;
    if (CJK.test(char)) {
        const value = table[char];
        return Number.isFinite(value) ? value : CONFIG.STROKE_FALLBACK;
    }
    if (ALNUM.test(char)) return 1;
    return 0;
}

export function countStrokes(text) {
    let total = 0;
    let estimated = 0;
    for (const char of String(text ?? '')) {
        const count = strokeCountOf(char);
        if (CJK.test(char) && (!table || !Number.isFinite(table[char]))) estimated += 1;
        total += count;
    }
    return { total, estimated };
}

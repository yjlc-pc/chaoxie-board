/* ============================================================
   layout.js —— 字号二分
   目标：一行装下一个句子（不溢出），且至少 MIN_VISIBLE_LINES 行完整可见。
   用真实 DOM 溢出测量（scrollWidth > clientWidth），不做公式估算。
   ============================================================ */

import { CONFIG } from './config.js';

const B = CONFIG.BOARD;

function fits(linesEl, fontPx, viewportH) {
    const lineHeight = fontPx * B.LINE_HEIGHT_RATIO;
    const visible = Math.floor(viewportH / lineHeight);
    if (visible < B.MIN_VISIBLE_LINES) return false;

    const items = linesEl.children;
    for (let i = 0; i < items.length; i += 1) {
        const el = items[i];
        /* +1 容忍亚像素舍入 */
        if (el.scrollWidth > el.clientWidth + 1) return false;
    }
    return true;
}

/**
 * 二分出最大可用字号。
 * 返回 { font, fits, overflow: 溢出行的下标数组 }
 */
export function fitFontSize({ linesEl, viewportH }) {
    let lo = B.MIN_FONT;
    let hi = B.MAX_FONT;
    let best = 0;

    /* 先试下界：连最小字号都放不下，说明需要二级/硬切分 */
    linesEl.style.setProperty('--line-font', `${B.MIN_FONT}px`);
    if (!fits(linesEl, B.MIN_FONT, viewportH)) {
        return {
            font: B.MIN_FONT,
            ok: false,
            overflow: collectOverflow(linesEl)
        };
    }

    best = B.MIN_FONT;
    while (lo <= hi) {
        const mid = Math.floor((lo + hi) / 2);
        linesEl.style.setProperty('--line-font', `${mid}px`);
        if (fits(linesEl, mid, viewportH)) {
            best = mid;
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }

    linesEl.style.setProperty('--line-font', `${best}px`);
    return { font: best, ok: true, overflow: [] };
}

export function collectOverflow(linesEl) {
    const out = [];
    const items = linesEl.children;
    for (let i = 0; i < items.length; i += 1) {
        if (items[i].scrollWidth > items[i].clientWidth + 1) out.push(i);
    }
    return out;
}

export function applyFont(linesEl, fontPx) {
    linesEl.style.setProperty('--line-font', `${fontPx}px`);
}

export function lineHeightOf(fontPx) {
    return fontPx * B.LINE_HEIGHT_RATIO;
}

/* ============================================================
   split.js —— .tex → 大屏行（一行 = 一个句子；公式独占一行）
   纯函数，不碰 DOM。
   ============================================================ */

import { CONFIG } from './config.js';
import { parse } from '../latex/parse.js';

const S = CONFIG.SENTENCE;

/** 按给定标点切分纯文本，标点留在前一句句尾 */
export function splitByPunct(text, marks) {
    const out = [];
    let buffer = '';
    for (const char of String(text ?? '')) {
        buffer += char;
        if (marks.includes(char)) {
            out.push(buffer);
            buffer = '';
        }
    }
    if (buffer) out.push(buffer);
    return out.map(part => part.trim()).filter(Boolean);
}

/**
 * 把一个单元（文字 + 行内公式混合）切成句子级 parts 列表。
 * math 片段跟随它所在的句子，不单独成行。
 */
export function splitPartsIntoLines(parts, marks = S.PRIMARY) {
    const lines = [];
    let current = [];

    const flush = () => {
        if (current.length) {
            lines.push(current);
            current = [];
        }
    };

    parts.forEach(part => {
        if (part.type === 'math') {
            current.push(part);
            return;
        }
        const sentences = splitByPunct(part.value, marks);
        sentences.forEach((sentence, index) => {
            current.push({ type: 'text', value: sentence });
            const isLast = index === sentences.length - 1;
            /* 只有真正的句末（原文以标点结束）才断行 */
            if (!isLast || /[。！？；…!?;]\s*$/.test(sentence)) flush();
        });
    });

    flush();
    return lines;
}

/**
 * .tex → lines[]
 * line = { kind: 'text'|'math'|'heading', parts: [{type,value|src}] }
 */
export function buildLines(tex) {
    const units = parse(tex);
    const lines = [];

    units.forEach((unit, unitIndex) => {
        if (unit.kind === 'math') {
            lines.push({ kind: 'math', parts: unit.parts, src: unit.src, unitIndex });
            return;
        }
        const sentences = splitPartsIntoLines(unit.parts);
        sentences.forEach(parts => {
            lines.push({
                kind: unit.kind === 'heading' ? 'heading' : 'text',
                parts,
                unitIndex
            });
        });
    });

    return lines;
}

/** 二级切分：长句在最小字号仍溢出时，按逗号类标点再切 */
export function splitLineSecondary(line) {
    if (line.kind === 'math') return [line];
    const sentences = splitPartsIntoLines(line.parts, S.SECONDARY);
    return sentences.map(parts => ({ ...line, parts }));
}

/** 兜底：整行按字数硬切（只对纯文本行有意义） */
export function hardSplitLine(line, maxChars) {
    if (line.kind === 'math') return [line];
    const text = line.parts.filter(p => p.type === 'text').map(p => p.value).join('');
    if (text.length <= maxChars) return [line];
    const out = [];
    for (let i = 0; i < text.length; i += maxChars) {
        out.push({ ...line, parts: [{ type: 'text', value: text.slice(i, i + maxChars) }] });
    }
    return out;
}

/** 行内可读文本（用于调试、日志与语音定位） */
export function lineText(line) {
    return line.parts
        .map(part => (part.type === 'math' ? `$${part.src}$` : part.value))
        .join('')
        .replace(/\s+/g, ' ')
        .trim();
}

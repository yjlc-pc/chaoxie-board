/* ============================================================
   parse.js —— LaTeX 文档 → 提词单元（纯函数，无浏览器依赖）
   ============================================================ */

import { CONFIG } from '../core/config.js';

const M = CONFIG.KATEX;

/** 整行丢弃的结构命令（在标题与 \item 之前判定） */
const SKIP_LINE = [
    /^\\documentclass\b/,
    /^\\usepackage\b/,
    /^\\begin\{/,
    /^\\end\{/,
    /^\\setcounter\{/,
    /^\\addtocounter\{/,
    /^\\vspace\b/,
    /^\\hspace\b/,
    /^\\vfill\b/,
    /^\\newpage\b/,
    /^\\clearpage\b/,
    /^\\noindent\b/,
    /^\\centering\b/,
    /^\\raggedright\b/,
    /^\\label\{/,
    /^\\ref\{/,
    /^\\pageref\{/,
    /^\\pagestyle\b/,
    /^\\geometry\b/,
    /^\\setlength\b/,
    /^\\newcommand\b/,
    /^\\renewcommand\b/,
    /^\\DeclareMathOperator\b/,
    /^\\def\b/,
    /^\\maketitle\b/,
    /^\\tableofcontents\b/,
    /^\\hrule\b/,
    /^\\par\b/
];

const HEADING_RE = /^\\(chapter|section|subsection|subsubsection|paragraph)\*?\s*\{(.*)\}\s*$/;
const TEXT_CMD_RE = /\\(?:textbf|textit|textsf|texttt|textrm|textsc|emph|underline|mbox|textnormal)\s*\{([^{}]*)\}/g;
const ENUM_BEGIN_RE = /^\\begin\{enumerate\}/;
const SETCOUNTER_RE = /^\\setcounter\{enumi\}\{(\d+)\}/;
const ITEM_RE = /^\\item\b\s*/;

/** 形如金额的内容不当作公式 */
export function isCurrencyLike(src) {
    return /^[\s\d.,]*$/.test(src);
}

/**
 * 把跨行的 $$...$$ / \[...\] 合并成一行。
 * 行间公式在源文件里经常写成三行，按行解析会把定界符当成正文。
 */
export function mergeDisplayMath(text) {
    let out = '';
    let index = 0;
    let close = null;

    while (index < text.length) {
        if (!close) {
            if (text.startsWith('$$', index) && text[index - 1] !== '\\') {
                if (text.indexOf('$$', index + 2) !== -1) {
                    close = '$$';
                    out += '$$';
                    index += 2;
                    continue;
                }
            } else if (text.startsWith('\\[', index)) {
                if (text.indexOf('\\]', index + 2) !== -1) {
                    close = '\\]';
                    out += '\\[';
                    index += 2;
                    continue;
                }
            }
        } else if (text.startsWith(close, index)) {
            out += close;
            index += close.length;
            close = null;
            continue;
        }

        const char = text[index];
        if (close && char === '\n') {
            out += ' ';
            index += 1;
            continue;
        }
        out += char;
        index += 1;
    }
    return out;
}

export function matchDelim(text, index) {
    for (const delimiter of M.DELIMITERS) {
        if (!text.startsWith(delimiter.open, index)) continue;
        const end = text.indexOf(delimiter.close, index + delimiter.open.length);
        if (end === -1) continue;
        const src = text.slice(index + delimiter.open.length, end);
        if (!src.trim()) continue;
        if (!delimiter.display) {
            if (isCurrencyLike(src)) continue;
            const after = text[end + delimiter.close.length];
            if (after && /[0-9]/.test(after)) continue;
        }
        return { delim: delimiter, src, end };
    }
    return null;
}

/** 把一段文本切成 [{ type:'text'|'math', ... }] */
export function splitMath(text) {
    const parts = [];
    let buffer = '';
    let index = 0;

    while (index < text.length) {
        const char = text[index];
        if (char === '\\' && text[index + 1] === '$') {
            buffer += '$';
            index += 2;
            continue;
        }
        const hit = matchDelim(text, index);
        if (hit) {
            if (buffer) {
                parts.push({ type: 'text', value: buffer });
                buffer = '';
            }
            parts.push({ type: 'math', src: hit.src, display: hit.delim.display });
            index = hit.end + hit.delim.close.length;
            continue;
        }
        buffer += char;
        index += 1;
    }
    if (buffer) parts.push({ type: 'text', value: buffer });
    return parts;
}

function stripTextCommands(value) {
    return value.replace(TEXT_CMD_RE, '$1');
}

export function cleanParts(parts) {
    const out = [];
    parts.forEach(part => {
        if (part.type === 'math') {
            if (part.src.trim()) {
                out.push({ type: 'math', src: part.src, display: Boolean(part.display) });
            }
            return;
        }
        const value = stripTextCommands(part.value).trim();
        if (value) out.push({ type: 'text', value });
    });
    return out;
}

/**
 * 主解析：公式模式下「一行 = 一个单元」，不逐字拆分。
 * enumerate 编号：counter 记录「下一个 \item 的编号 - 1」。
 */
export function parse(raw) {
    const text = mergeDisplayMath(String(raw ?? '').replace(/\r\n?/g, '\n'));
    const units = [];
    let buffer = null;
    let counter = -1;

    function pushChunk(chunk) {
        const parts = cleanParts(splitMath(chunk));
        if (!parts.length) return;
        if (parts.length === 1 && parts[0].type === 'math') {
            units.push({ kind: 'math', parts, src: parts[0].src });
        } else {
            units.push({ kind: 'group', parts });
        }
    }

    function flush() {
        if (buffer === null) return;
        pushChunk(buffer);
        buffer = null;
    }

    for (const rawLine of text.split('\n')) {
        const line = rawLine.trim();
        if (!line) {
            flush();
            continue;
        }

        if (ENUM_BEGIN_RE.test(line)) {
            flush();
            counter = 0;
            continue;
        }
        if (SETCOUNTER_RE.test(line)) {
            flush();
            counter = Number(SETCOUNTER_RE.exec(line)[1]);
            continue;
        }
        if (SKIP_LINE.some(re => re.test(line))) {
            flush();
            continue;
        }

        const heading = HEADING_RE.exec(line);
        if (heading) {
            flush();
            const parts = cleanParts([{ type: 'text', value: heading[2] }]);
            if (parts.length) units.push({ kind: 'heading', parts });
            continue;
        }

        if (ITEM_RE.test(line)) {
            flush();
            if (counter < 0) counter = 0;
            counter += 1;
            buffer = `${counter}. ${line.replace(ITEM_RE, '')}`;
            continue;
        }

        if (buffer !== null) {
            buffer += ' ' + line;
            continue;
        }

        pushChunk(line);
    }

    flush();
    return units;
}

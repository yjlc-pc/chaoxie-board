/* ============================================================
   commands.js —— 语音指令的规则解析（纯函数，可单测）
   规则解析不引入模型：命中就用，没命中再交给 FunctionGemma。
   ============================================================ */

const CN_DIGITS = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

export function parseChineseNumber(raw) {
    const text = String(raw ?? '').trim();
    if (!text) return NaN;
    if (/^\d+$/.test(text)) return Number(text);
    if (text === '十') return 10;
    const tenIndex = text.indexOf('十');
    if (tenIndex === -1) return CN_DIGITS[text[0]] ?? NaN;
    const tens = tenIndex === 0 ? 1 : CN_DIGITS[text[0]] ?? 0;
    const ones = text[tenIndex + 1] ? CN_DIGITS[text[tenIndex + 1]] ?? 0 : 0;
    return tens * 10 + ones;
}

function normalize(text) {
    return String(text ?? '')
        .replace(/[\s，。！？、；：,.!?;:]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

const REMOTE = [
    { op: 'pause', re: /(暂停|停一下|先停|别动|停住)/ },
    { op: 'resume', re: /(继续|接着|开始|往下走|播放)/ },
    { op: 'prev', re: /(上一[句行段]|往回)/ },
    { op: 'next', re: /(下一[句行段]|跳过这句|翻页)/ },
    { op: 'faster', re: /(快一?点|快些|加速|快点)/ },
    { op: 'slower', re: /(慢一?点|慢些|减速|慢点)/ }
];

const ANSWER = [
    { op: 'confirm', re: /^(确认|确定|对|好的?|可以|是|执行)$/ },
    { op: 'cancel', re: /^(取消|不用|算了|不对|否|别改)$/ }
];

const LINE_REF = '第\\s*([0-9零一两二三四五六七八九十]+)\\s*[句行段]';

/**
 * 返回 { op, line?, from?, to?, text? } 或 null。
 * line 为 1 基行号。
 */
export function parseRule(input) {
    const text = normalize(input);
    if (!text) return null;

    for (const rule of ANSWER) {
        if (rule.re.test(text)) return { op: rule.op };
    }

    /* 改字：把第 2 句的 x 改成 y */
    let match = new RegExp(`${LINE_REF}[^ ]* ?(?:的|里|中)? ?([^ ]) ?(?:改|换|写)成 ?(.+)$`).exec(text);
    if (match) {
        return {
            op: 'setChar',
            line: parseChineseNumber(match[1]),
            from: match[2],
            to: match[3].replace(/\s/g, '')
        };
    }

    /* 整句替换：第 2 句改成 xxx */
    match = new RegExp(`${LINE_REF} ?(?:改成|换成|改为|变成) ?(.+)$`).exec(text);
    if (match) {
        return {
            op: 'setLine',
            line: parseChineseNumber(match[1]),
            text: match[2].replace(/\s/g, '')
        };
    }

    /* 删除：删掉第 2 句 / 删除这句 */
    match = new RegExp(`(?:删掉|删除|去掉) ?(${LINE_REF})?`).exec(text);
    if (match) {
        const line = match[2] ? parseChineseNumber(match[2]) : null;
        return { op: 'delete', line };
    }

    /* 追加：加一句 xxx / 后面补一句 xxx */
    match = /(?:追?加|补|加) ?(?:一?句|一行)? ?(.+)$/.exec(text);
    if (match && match[1].length > 1) {
        return { op: 'append', text: match[1].replace(/\s/g, '') };
    }

    for (const rule of REMOTE) {
        if (rule.re.test(text)) return { op: rule.op };
    }

    return null;
}

export const OP_LABEL = {
    setChar: '改一个字',
    setLine: '整句替换',
    delete: '删掉一行',
    append: '追加一句',
    pause: '暂停',
    resume: '继续',
    prev: '上一行',
    next: '下一行',
    faster: '快一点',
    slower: '慢一点'
};

/** 把指令描述成人话，用于确认弹窗 */
export function describe(command, lines) {
    const lineOf = index => {
        if (!Number.isFinite(index) || index < 1) return null;
        const line = lines[index - 1];
        if (!line) return null;
        return line;
    };

    switch (command.op) {
        case 'setChar': {
            const target = lineOf(command.line);
            const preview = target ? target.text.slice(0, 18) : '（找不到这一行）';
            return `第 ${command.line} 行：把「${command.from}」改成「${command.to}」\n当前内容：${preview}`;
        }
        case 'setLine': {
            const target = lineOf(command.line);
            const preview = target ? target.text.slice(0, 18) : '（找不到这一行）';
            return `第 ${command.line} 行整句替换为：${command.text}\n原来是：${preview}`;
        }
        case 'delete': {
            const target = lineOf(command.line);
            return target ? `删掉第 ${command.line} 行：${target.text.slice(0, 24)}` : '删掉当前行';
        }
        case 'append':
            return `追加一句：${command.text}`;
        default:
            return OP_LABEL[command.op] || '未知操作';
    }
}

export const EXAMPLES = [
    '暂停 / 继续 / 下一段',
    '快一点 / 慢一点',
    '把第三句的「天」改成「云」',
    '第三句改成……',
    '删掉这句',
    '加一句……'
];

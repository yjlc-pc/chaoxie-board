/* ============================================================
   config.js —— 常量集中地（无副作用）
   大屏抄写板：图片 → .tex → 一屏多字滚动
   ============================================================ */

export const CONFIG = Object.freeze({
    /* ---------- 存储键 ---------- */
    LS: Object.freeze({
        settings: 'cb.settings.v1',
        doc: 'cb.doc.v1',
        lastInput: 'cb.last_input.v1',
        /* 上次真正跑通的量化档：q4f16 在部分核显上能加载但不能推理 */
        dtype: 'cb.ocr.dtype.v1'
    }),

    /* ---------- 权重来源：国内直连 HuggingFace 不稳，统一走 mirror ---------- */
    HF_MIRROR: 'https://hf-mirror.com',

    /* ---------- OCR ---------- */
    OCR: Object.freeze({
        MODEL: 'onnx-community/GLM-OCR-ONNX',
        /* 依次尝试：f16 不可用或推理失败就降一档 */
        DTYPES: Object.freeze(['q4']),
        PROMPT: 'Text Recognition:',
        TIMEOUT_MS: 300000,
        /* 送进模型前的最长边。核显上 1400 会在推理时 GPU 缓冲区分配失败，1000 稳 */
        MAX_EDGE: 1000,
        /* 大图识别失败（GPU 缓冲区不够）时自动降到这个尺寸重试 */
        FALLBACK_EDGE: 800,
        JPEG_QUALITY: 0.9,
        MAX_BYTES: 10 * 1024 * 1024
    }),

    /* ---------- KaTeX（本地 vendor，不依赖 CDN） ---------- */
    KATEX: Object.freeze({
        DIR: 'vendor/katex/dist/',
        LOAD_TIMEOUT_MS: 300000,
        DELIMITERS: Object.freeze([
            { open: '$$', close: '$$', display: true },
            { open: '\\[', close: '\\]', display: true },
            { open: '\\(', close: '\\)', display: false },
            { open: '$', close: '$', display: false }
        ])
    }),

    /* ---------- 大屏 ---------- */
    BOARD: Object.freeze({
        /* 速度：秒/笔 */
        MIN_SPEED: 0.05,
        MAX_SPEED: 3.0,
        DEFAULT_SPEED: 0.45,
        /* 公式独占整行，按固定的每式时长推进 */
        MATH_SECONDS: 6,
        /* 字号二分区间（px，按 4K 大屏设计，逻辑像素由浏览器缩放） */
        MIN_FONT: 16,
        MAX_FONT: 320,
        /* 至少几行完整可见 */
        MIN_VISIBLE_LINES: 3,
        LINE_HEIGHT_RATIO: 1.9,
        TICK_MS: 100,
        /* 控件静止多久后淡出 */
        IDLE_FADE_MS: 5000,
        SCROLL_MS: 620
    }),

    /* ---------- 切句 ---------- */
    SENTENCE: Object.freeze({
        /* 一级：整句 */
        PRIMARY: '。！？；…!?;',
        /* 二级：长句在被逼到最小字号时才用 */
        SECONDARY: '，、：,',
        /* 句末标点保留在行尾（大屏上是板书，标点该留着） */
        KEEP_TRAILING: '。！？；…'
    }),

    STROKE_FALLBACK: 6,

    /* 没有图片时的占位内容，方便首次打开就能看排版 */
    DEFAULT_TEX: String.raw`\section*{示例}
落霞与孤鹜齐飞，秋水共长天一色。
渔舟唱晚，响穷彭蠡之滨；雁阵惊寒，声断衡阳之浦。
$$\int_{0}^{1} x^{2}\,\mathrm{d}x=\frac{1}{3}$$
`
});

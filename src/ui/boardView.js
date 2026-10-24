/* ============================================================
   boardView.js —— 大屏渲染与交互
   流程：lines → DOM → KaTeX → 字号二分 → 起 Board
   ============================================================ */

import { CONFIG } from '../core/config.js';
import { settings } from '../core/settings.js';
import { buildLines, splitLineSecondary, hardSplitLine, lineText } from '../core/split.js';
import { fitFontSize, lineHeightOf, applyFont } from '../core/layout.js';
import { renderMathInto } from '../latex/render.js';
import { formatSpeed, formatDuration } from '../core/format.js';
import { Board } from '../board/Board.js';
import { showScreen } from './setup.js';
import { toast } from './toast.js';

const ui = {};
let board = null;
let handlers = {};
let lines = [];
let step = 0;
let idleTimer = null;

function cache() {
    ['board', 'viewport', 'lines', 'progress', 'progress-fill', 'controls',
        'btn-prev', 'btn-toggle', 'btn-next', 'btn-slower', 'btn-faster', 'btn-exit',
        'speed-label', 'meta-label', 'btn-voice', 'voice-caption', 'voice-text'
    ].forEach(id => {
        ui[id.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = document.getElementById(id);
    });
}

function icon(name) {
    return `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
}

async function renderLines(list) {
    ui.lines.textContent = '';
    const mathJobs = [];

    list.forEach(line => {
        const row = document.createElement('div');
        row.className = 'line';
        if (line.kind === 'math') row.classList.add('line--math');
        if (line.kind === 'heading') row.classList.add('line--heading');

        const isMathOnly = line.kind === 'math';

        line.parts.forEach(part => {
            if (part.type === 'text') {
                row.appendChild(document.createTextNode(part.value));
                return;
            }
            const span = document.createElement('span');
            row.appendChild(span);
            mathJobs.push(renderMathInto(span, part.src, isMathOnly && line.parts.length === 1));
        });

        ui.lines.appendChild(row);
    });

    await Promise.all(mathJobs);
}

/**
 * 先按句排；放不下就二级切（逗号），再放不下就硬切。
 * 每次切分后重新渲染再二分。
 */
async function layout(list, viewportH) {
    let current = list;
    for (let attempt = 0; attempt < 3; attempt += 1) {
        await renderLines(current);
        const result = fitFontSize({ linesEl: ui.lines, viewportH });
        if (result.ok) return { lines: current, font: result.font };

        if (attempt === 0) {
            current = current.flatMap((line, index) =>
                result.overflow.includes(index) ? splitLineSecondary(line) : [line]
            );
        } else {
            current = current.flatMap((line, index) =>
                result.overflow.includes(index)
                    ? hardSplitLine(line, Math.max(4, Math.ceil(lineText(line).length / 2)))
                    : [line]
            );
        }
    }
    return { lines: current, font: CONFIG.BOARD.MIN_FONT };
}

function updateLabels(state) {
    if (ui.speedLabel) ui.speedLabel.textContent = formatSpeed(settings.get('speed'));
    if (ui.metaLabel) {
        ui.metaLabel.textContent = `第 ${Math.min(state.index + 1, state.total)}/${state.total} 行 · 剩 ${formatDuration(state.remainingMs)}`;
    }
    if (ui.progressFill) ui.progressFill.style.width = `${(state.progress * 100).toFixed(1)}%`;
    if (ui.btnToggle) {
        ui.btnToggle.innerHTML = icon(state.paused ? 'play' : 'pause');
        ui.btnToggle.setAttribute('aria-label', state.paused ? '继续' : '暂停');
    }
}

function applyScroll(index) {
    const offset = Math.max(0, index - 1) * step;
    ui.lines.style.transform = `translate3d(0, ${-offset}px, 0)`;
}

function bumpControls() {
    if (!ui.controls) return;
    ui.controls.dataset.idle = 'false';
    clearTimeout(idleTimer);
    if (!settings.get('showControls')) return;
    idleTimer = setTimeout(() => {
        ui.controls.dataset.idle = 'true';
    }, CONFIG.BOARD.IDLE_FADE_MS);
}

export function initBoard(nextHandlers) {
    handlers = nextHandlers || {};
    cache();

    board = new Board({
        onUpdate: state => {
            applyScroll(state.index);
            updateLabels(state);
            if (state.finished) toast('已经抄完了');
        }
    });

    if (ui.btnToggle) ui.btnToggle.addEventListener('click', () => board.toggle());
    if (ui.btnPrev) ui.btnPrev.addEventListener('click', () => board.prev());
    if (ui.btnNext) ui.btnNext.addEventListener('click', () => board.next());
    if (ui.btnSlower) ui.btnSlower.addEventListener('click', () => settings.set('speed', settings.get('speed') - 0.05));
    if (ui.btnFaster) ui.btnFaster.addEventListener('click', () => settings.set('speed', settings.get('speed') + 0.05));
    if (ui.btnExit) ui.btnExit.addEventListener('click', () => exitBoard());

    ['pointermove', 'pointerdown', 'touchstart', 'keydown'].forEach(type => {
        document.addEventListener(type, bumpControls, { passive: true });
    });

    settings.subscribe(changed => {
        if (changed.includes('speed') && board) {
            board.setSpeed(settings.get('speed'));
            updateLabels({ index: board.index, total: board.lines.length, progress: 0, remainingMs: board.totalRemainingMs(), paused: board.paused });
        }
    });

    if (ui.btnVoice) {
        ui.btnVoice.addEventListener('pointerdown', event => {
            event.preventDefault();
            if (handlers.onVoiceStart) handlers.onVoiceStart(ui.btnVoice);
        });
        ui.btnVoice.addEventListener('pointerup', () => {
            if (handlers.onVoiceEnd) handlers.onVoiceEnd();
        });
        ui.btnVoice.addEventListener('pointercancel', () => {
            if (handlers.onVoiceEnd) handlers.onVoiceEnd();
        });
    }
}

export function setVoiceState(state, caption = '') {
    if (ui.btnVoice) ui.btnVoice.dataset.state = state;
    if (!ui.voiceCaption) return;
    if (!caption) {
        ui.voiceCaption.hidden = true;
        return;
    }
    ui.voiceCaption.hidden = false;
    ui.voiceText.textContent = caption;
}

export async function startBoard(tex) {
    showScreen('board');
    lines = buildLines(tex);

    if (!lines.length) {
        toast('这一页没识别出可展示的内容');
        showScreen('setup');
        return;
    }

    const viewportH = ui.viewport.clientHeight;
    const result = await layout(lines, viewportH);
    lines = result.lines;

    step = lineHeightOf(result.font);
    /* 用真实行高修正（字体 fallback 会影响行盒高度） */
    const first = ui.lines.firstElementChild;
    if (first && first.offsetHeight > 0) step = first.offsetHeight;

    board.load(lines, {
        speed: settings.get('speed'),
        mathSeconds: settings.get('mathSeconds')
    });

    applyScroll(0);
    bumpControls();
    board.start();
    updateLabels({
        index: 0,
        total: lines.length,
        progress: 0,
        remainingMs: board.totalRemainingMs(),
        paused: false
    });
}

export function exitBoard() {
    if (board) board.stop();
    setVoiceState('idle', '');
    showScreen('setup');
    if (handlers.onExit) handlers.onExit();
}

/* ---------- 供语音层调用 ---------- */

export function voicePause() {
    if (board) board.pause();
}

export function voiceResume() {
    if (board) board.start();
}

export function voiceNext() {
    if (board) board.next();
}

export function voicePrev() {
    if (board) board.prev();
}

export function currentLines() {
    return lines;
}

export function replaceLines(nextTex) {
    board.stop();
    startBoard(nextTex);
}

export { applyFont, lineHeightOf };

/* ============================================================
   board.js —— 大屏推进引擎（唯一的计时器）
   没有“当前字高亮”：整行可见，行内按笔画数计时，
   时间到就把下一行滚进视野。
   ============================================================ */

import { CONFIG } from '../core/config.js';
import { countStrokes } from '../core/strokes.js';
import { lineText } from '../core/split.js';

const B = CONFIG.BOARD;

export class Board {
    constructor(handlers = {}) {
        this.handlers = handlers;
        this.lines = [];
        this.durations = [];
        this.index = 0;
        this.elapsed = 0;
        this.paused = true;
        this.speed = B.DEFAULT_SPEED;
        this.mathSeconds = B.MATH_SECONDS;
        this.timer = null;
        this.lastTick = 0;
        this.finished = false;
    }

    load(lines, { speed = this.speed, mathSeconds = this.mathSeconds } = {}) {
        this.stop();
        this.lines = lines.map(line => {
            if (line.kind === 'math') {
                const text = lineText(line);
                return { ...line, strokes: 0, estimated: 0, text };
            }
            const { total, estimated } = countStrokes(lineText(line));
            return { ...line, strokes: total, estimated, text: lineText(line) };
        });

        this.speed = speed;
        this.mathSeconds = mathSeconds;
        this.index = 0;
        this.elapsed = 0;
        this.finished = false;
        this._recompute();
        this._emit();
        return this;
    }

    _recompute() {
        this.durations = this.lines.map(line => {
            if (line.kind === 'math') return Math.max(1, this.mathSeconds) * 1000;
            return Math.max(1, line.strokes) * this.speed * 1000;
        });
        this.totalMs = this.durations.reduce((sum, value) => sum + value, 0);
    }

    get current() {
        return this.lines[this.index] || null;
    }

    get duration() {
        return this.durations[this.index] || 0;
    }

    totalRemainingMs() {
        const currentLeft = Math.max(0, this.duration - this.elapsed);
        const rest = this.durations.slice(this.index + 1).reduce((sum, value) => sum + value, 0);
        return currentLeft + rest;
    }

    start() {
        if (!this.lines.length || this.finished) return;
        this.paused = false;
        this.lastTick = performance.now();
        this._arm();
        this._emit();
    }

    pause() {
        if (this.paused) return;
        this.paused = true;
        this._disarm();
        this._emit();
    }

    toggle() {
        if (this.paused) this.start();
        else this.pause();
    }

    stop() {
        this._disarm();
        this.paused = true;
    }

    seek(index) {
        const next = Math.max(0, Math.min(this.lines.length - 1, index));
        this.index = next;
        this.elapsed = 0;
        this.finished = false;
        this._emit();
    }

    next() {
        if (this.index >= this.lines.length - 1) {
            this._finish();
            return;
        }
        this.index += 1;
        this.elapsed = 0;
        this._emit();
    }

    prev() {
        if (this.index === 0) return;
        this.index -= 1;
        this.elapsed = 0;
        this._emit();
    }

    setSpeed(value) {
        const speed = Math.min(B.MAX_SPEED, Math.max(B.MIN_SPEED, Number(value) || this.speed));
        if (speed === this.speed) return;
        /* 已过去的比例不变，剩余时间按新速度重算 */
        const ratio = this.duration ? this.elapsed / this.duration : 0;
        this.speed = speed;
        this._recompute();
        this.elapsed = ratio * this.duration;
        this._emit();
    }

    restart() {
        this.index = 0;
        this.elapsed = 0;
        this.finished = false;
        this.start();
    }

    _arm() {
        this._disarm();
        this.timer = setInterval(() => this._tick(), B.TICK_MS);
    }

    _disarm() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    _tick() {
        if (this.paused || this.finished) return;
        const now = performance.now();
        const delta = Math.max(0, now - this.lastTick);
        this.lastTick = now;

        this.elapsed += delta;
        while (this.elapsed >= this.duration && !this.finished) {
            this.elapsed -= this.duration;
            if (this.index >= this.lines.length - 1) {
                this._finish();
                return;
            }
            this.index += 1;
            this._emit();
        }
        this._emit();
    }

    _finish() {
        this.finished = true;
        this._disarm();
        this.paused = true;
        this.elapsed = 0;
        this._emit();
        if (typeof this.handlers.onFinish === 'function') this.handlers.onFinish();
    }

    _emit() {
        if (typeof this.handlers.onUpdate !== 'function') return;
        this.handlers.onUpdate({
            index: this.index,
            total: this.lines.length,
            progress: this.duration ? Math.min(1, this.elapsed / this.duration) : 0,
            lineProgressMs: Math.max(0, this.duration - this.elapsed),
            remainingMs: this.totalRemainingMs(),
            paused: this.paused,
            finished: this.finished,
            strokes: this.current ? this.current.strokes : 0
        });
    }
}

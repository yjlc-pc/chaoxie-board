/* ============================================================
   settings.js —— 设置的唯一来源
   所有读写都走 get / set / patch / subscribe，自动夹取并持久化。
   ============================================================ */

import { CONFIG } from './config.js';
import { storage } from './storage.js';

const B = CONFIG.BOARD;

const DEFAULTS = Object.freeze({
    speed: B.DEFAULT_SPEED,
    mathSeconds: B.MATH_SECONDS,
    showControls: true,
    theme: 'dark',
    /* 决定 .tex 是否带导言区 */
    fullDocument: false,
    /* 语音 */
    voiceEnabled: true,
    voiceModel: 'tiny'
});

function clamp(value, min, max, fallback) {
    const num = Number(value);
    if (!Number.isFinite(num)) return fallback;
    return Math.min(max, Math.max(min, num));
}

const VALIDATORS = {
    speed: value => clamp(value, B.MIN_SPEED, B.MAX_SPEED, DEFAULTS.speed),
    mathSeconds: value => clamp(value, 1, 120, DEFAULTS.mathSeconds),
    showControls: value => Boolean(value),
    theme: value => (value === 'light' ? 'light' : 'dark'),
    fullDocument: value => Boolean(value),
    voiceEnabled: value => Boolean(value),
    voiceModel: value => (value === 'small' ? 'small' : 'tiny')
};

let state = { ...DEFAULTS };
const listeners = new Set();

function sanitize(input) {
    const next = {};
    Object.keys(DEFAULTS).forEach(key => {
        const validate = VALIDATORS[key] || (value => value);
        next[key] = validate(input && key in input ? input[key] : DEFAULTS[key]);
    });
    return next;
}

export const settings = {
    get(key) {
        return key in state ? state[key] : DEFAULTS[key];
    },

    set(key, value) {
        const validate = VALIDATORS[key];
        if (!validate) return;
        const next = validate(value);
        if (next === state[key]) return;
        state[key] = next;
        persist();
        notify([key]);
    },

    patch(partial) {
        const before = state;
        const next = sanitize({ ...state, ...partial });
        const changed = Object.keys(next).filter(key => next[key] !== before[key]);
        state = next;
        if (!changed.length) return;
        persist();
        notify(changed);
    },

    subscribe(fn) {
        listeners.add(fn);
        return () => listeners.delete(fn);
    },

    reset() {
        state = { ...DEFAULTS };
        persist();
        notify(Object.keys(state));
    }
};

function persist() {
    storage.set(CONFIG.LS.settings, state);
}

function notify(changed) {
    listeners.forEach(fn => {
        try {
            fn(changed);
        } catch (error) {
            console.error(error);
        }
    });
}

export function initSettings() {
    state = sanitize(storage.get(CONFIG.LS.settings, null));
    persist();
    return state;
}

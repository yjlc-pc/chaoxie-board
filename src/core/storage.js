/* ============================================================
   storage.js —— localStorage 的安全包装
   隐私模式 / 配额满 / JSON 损坏都不抛错，只降级。
   ============================================================ */

function ls() {
    try {
        return window.localStorage;
    } catch (error) {
        return null;
    }
}

export const storage = {
    get(key, fallback = null) {
        const store = ls();
        if (!store) return fallback;
        try {
            const raw = store.getItem(key);
            if (raw === null) return fallback;
            return JSON.parse(raw);
        } catch (error) {
            return fallback;
        }
    },

    set(key, value) {
        const store = ls();
        if (!store) return false;
        try {
            store.setItem(key, JSON.stringify(value));
            return true;
        } catch (error) {
            return false;
        }
    },

    remove(key) {
        const store = ls();
        if (!store) return;
        try {
            store.removeItem(key);
        } catch (error) {
            /* 忽略 */
        }
    }
};

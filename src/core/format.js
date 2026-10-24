/* ============================================================
   format.js —— 纯展示用的格式化
   ============================================================ */

export function formatNumber(value) {
    return Number(value || 0).toLocaleString('zh-CN');
}

export function formatDuration(ms) {
    const total = Math.max(0, Math.round(Number(ms) || 0) / 1000);
    const minutes = Math.floor(total / 60);
    const seconds = total - minutes * 60;
    if (minutes >= 60) {
        const hours = Math.floor(minutes / 60);
        const rest = minutes - hours * 60;
        return `${hours} 时 ${rest} 分`;
    }
    if (minutes > 0) return `${minutes} 分 ${seconds.toFixed(0)} 秒`;
    return `${seconds.toFixed(1)} 秒`;
}

export function formatSpeed(secondsPerStroke) {
    const value = Number(secondsPerStroke) || 0;
    return `${value.toFixed(2)} 秒/笔`;
}

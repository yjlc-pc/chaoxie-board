/* ============================================================
   voice.js —— 语音改稿与遥控（第二阶段）
   按住说话 → 本地 Whisper 转写 → （FunctionGemma / 规则）解析 → 确认 → 执行
   当前只落地骨架：接口齐备，模型未接入时 available() 返回 false。
   ============================================================ */

import { settings } from '../core/settings.js';

let handlers = {};
let available = false;

export function initVoice(next) {
    handlers = next || {};
    /* 第二阶段打开：把 available 置 true 并接入录音与解析 */
    available = false;
}

export function voiceAvailable() {
    return available && settings.get('voiceEnabled');
}

export function startListening() {
    if (!voiceAvailable()) return;
    /* TODO(第二阶段)：AudioContext 采集 16k 单声道 → Whisper → 解析 */
    if (handlers.onTranscript) handlers.onTranscript('语音模型尚未接入');
}

export function stopListening() {
    if (!voiceAvailable()) return;
}

export function applyCommand(command) {
    if (handlers.onAction) handlers.onAction(command);
}

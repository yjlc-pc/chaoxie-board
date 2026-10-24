/* ============================================================
   toast.js —— 轻提示（支持一个可选撤销动作）
   ============================================================ */

let timer = null;
let node = null;

export function initToast() {
    node = document.getElementById('toast');
}

export function toast(message, { timeout = 4000, actionLabel = '', onAction = null } = {}) {
    if (!node) return;
    node.textContent = message;
    node.hidden = false;

    if (actionLabel) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'btn-text';
        button.style.marginLeft = '0.75rem';
        button.textContent = actionLabel;
        button.addEventListener('click', () => {
            hide();
            if (onAction) onAction();
        });
        node.appendChild(button);
    }

    clearTimeout(timer);
    timer = setTimeout(hide, timeout);
}

export function hide() {
    if (!node) return;
    node.hidden = true;
    node.textContent = '';
}

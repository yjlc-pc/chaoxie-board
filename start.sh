#!/usr/bin/env bash
# 本地开发服务器：起静态服务并打开浏览器。
# GitHub Pages 上不需要它。可以指定端口：./start.sh 9000
set -euo pipefail
cd "$(dirname "$0")"

PORT="${1:-${PORT:-8770}}"

if ! command -v python3 >/dev/null 2>&1; then
    echo "需要 python3 才能启动本地静态服务。" >&2
    exit 1
fi

port_free() {
    python3 - "$1" <<'PY'
import socket, sys
s = socket.socket()
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
try:
    s.bind(("127.0.0.1", int(sys.argv[1])))
except OSError:
    sys.exit(1)
finally:
    s.close()
PY
}

if ! port_free "$PORT"; then
    PORT=$(python3 - <<'PY'
import socket
s = socket.socket()
s.bind(("127.0.0.1", 0))
print(s.getsockname()[1])
s.close()
PY
)
fi

python3 -m http.server "$PORT" --bind 127.0.0.1 >/dev/null 2>&1 &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT INT TERM

URL="http://127.0.0.1:${PORT}/"
echo "抄写大屏：${URL}"
echo "按 Ctrl+C 停止本地服务。"

if command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$URL" >/dev/null 2>&1 || true
elif command -v open >/dev/null 2>&1; then
    open "$URL" >/dev/null 2>&1 || true
fi

wait "$SERVER_PID"

#!/usr/bin/env python3
import json, sys, subprocess, os

def run_tool(tool, args):
    if tool == "read_file":
        p = args.get("path")
        if not os.path.exists(p): return f"Error: File {p} not found"
        with open(p, "r") as f: return f.read()
    elif tool == "write_file":
        p, c = args.get("path"), args.get("content")
        with open(p, "w") as f: f.write(c)
        return f"Success: 写入 {p}"
    elif tool == "run_command":
        r = subprocess.run(args.get("command"), shell=True, capture_output=True, text=True)
        return f"OUT:\n{r.stdout}\nERR:\n{r.stderr}"
    return f"Unknown tool: {tool}"

if __name__ == "__main__":
    print("🤖 等待 MCP 工具调用 (粘贴 JSON 后按 Ctrl+D):")
    try:
        data = json.loads(sys.stdin.read())
        calls = [data] if isinstance(data, dict) else data
        for call in calls:
            print(f"\n[Tool] {call.get('tool')} -> {call.get('args', {}).get('path', '')}")
            print(run_tool(call.get("tool"), call.get("args", {})))
    except Exception as e:
        print(f"Parse Error: {e}")

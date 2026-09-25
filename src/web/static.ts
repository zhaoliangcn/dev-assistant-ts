import type { Request, Response } from 'express'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'

/**
 * 静态资源托管（对齐设计文档 12.1 的 /static 段）。
 *
 * - 若存在 <workingDir>/.dev-assistant-web/ 目录（可放入 Vue 版前端构建产物），优先托管
 * - 否则使用内置最小聊天页（WS 客户端）
 */

const STATIC_DIR = '.dev-assistant-web'

/** 内置最小聊天页（无外部依赖；演示 WS 协议） */
const BUILTIN_PAGE = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>dev-assistant</title>
<style>
  body { font-family: ui-monospace, monospace; margin: 0; background: #111; color: #ddd; }
  #wrap { max-width: 860px; margin: 0 auto; padding: 16px; }
  #log { height: 60vh; overflow-y: auto; white-space: pre-wrap; border: 1px solid #333; padding: 8px; border-radius: 6px; }
  .tool { color: #c77; } .status { color: #888; } .err { color: #f66; } .done { color: #7c7; }
  #row { display: flex; gap: 8px; margin-top: 8px; }
  #input { flex: 1; padding: 8px; background: #1c1c1c; color: #ddd; border: 1px solid #333; border-radius: 4px; }
  button { padding: 8px 14px; background: #2a6; color: #fff; border: 0; border-radius: 4px; cursor: pointer; }
  #bar { margin-bottom: 8px; color: #888; font-size: 12px; }
</style>
</head>
<body>
<div id="wrap">
  <div id="bar">dev-assistant · <span id="sid">connecting…</span></div>
  <div id="log"></div>
  <div id="row">
    <input id="input" placeholder="输入消息…" autocomplete="off">
    <button id="send">发送</button>
  </div>
</div>
<script>
const logEl = document.getElementById('log');
const sidEl = document.getElementById('sid');
let ws;
function append(cls, text) {
  const div = document.createElement('div');
  if (cls) div.className = cls;
  div.textContent = text;
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
}
function connect() {
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws/chat');
  ws.onopen = () => append(null, '— connected —');
  ws.onmessage = (e) => {
    const ev = JSON.parse(e.data);
    switch (ev.type) {
      case 'session_ready': sidEl.textContent = ev.sessionId; break;
      case 'assistant_stream_delta': if (ev.delta) append(null, ev.delta); break;
      case 'reasoning_delta': append('status', ev.delta); break;
      case 'tool_call': append('tool', '🔧 ' + ev.toolName + ' ' + ev.args); break;
      case 'tool_result': append(ev.success ? 'done' : 'err', (ev.success ? '✓ ' : '✗ ') + ev.toolName + ' ' + ev.content.slice(0, 200)); break;
      case 'status': append('status', ev.content); break;
      case 'error': append('err', ev.content); break;
      case 'done': append('done', '— done —'); break;
    }
  };
  ws.onclose = () => { sidEl.textContent = 'disconnected'; setTimeout(connect, 2000); };
}
const input = document.getElementById('input');
function send() {
  const v = input.value.trim();
  if (!v || !ws || ws.readyState !== 1) return;
  append(null, '你 › ' + v);
  ws.send(JSON.stringify({ type: 'user_message', content: v }));
  input.value = '';
}
document.getElementById('send').onclick = send;
input.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
connect();
</script>
</body>
</html>
`

/** GET / → 页面路由（内置页或托管目录的 index.html） */
export function indexPageHandler(workingDir: string): (req: Request, res: Response) => void {
  return (_req, res) => {
    const idx = path.resolve(workingDir, STATIC_DIR, 'index.html')
    if (existsSync(idx)) {
      res.type('html').send(readFileSync(idx, 'utf8'))
      return
    }
    res.type('html').send(BUILTIN_PAGE)
  }
}

/** /static/* → 托管目录下的静态资源（不存在时 404） */
export function staticFileHandler(workingDir: string): (req: Request, res: Response) => void {
  return (req, res) => {
    const rel = (req.path || '').replace(/^\/+/, '')
    if (!rel || rel.includes('..')) {
      res.status(400).end('bad path')
      return
    }
    const abs = path.resolve(workingDir, STATIC_DIR, rel)
    const root = path.resolve(workingDir, STATIC_DIR)
    if (!abs.startsWith(root + path.sep) || !existsSync(abs)) {
      res.status(404).end('not found')
      return
    }
    res.sendFile(abs)
  }
}

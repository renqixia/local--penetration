#!/usr/bin/env node
// Shared local HTTP service for the macOS App and the browser launcher.
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { spawn, exec } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const LISTEN_PORT = 9800;
const appToken = process.argv.includes('--app') ? process.env.VOIDBRIDGE_APP_TOKEN : null;
const entry = appToken ? 'app' : 'web';
const browserOwned = entry === 'web' && process.argv.includes('--open');
const browserTabs = new Set();
let browserIdleTimer;
function waitForBrowser(delay) {
  clearTimeout(browserIdleTimer);
  browserIdleTimer = setTimeout(() => {
    if (!browserTabs.size) shutdown();
  }, delay);
}
const browserSessionScript = `
  var browserSession;
  function connectBrowserSession() {
    if (!browserSession) browserSession = new EventSource('/api/browser-session');
  }
  connectBrowserSession();
  window.addEventListener('pagehide', function(){
    browserSession?.close();
    browserSession = null;
  });
  window.addEventListener('pageshow', connectBrowserSession);
`;
const pageHeaders = { 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY' };
const TOOL_DIR = path.dirname(fileURLToPath(import.meta.url));
/* 隧道引擎（驱动）就放在工具文件夹自己的「组件」目录里：不再复制到用户主目录 ~/bin，
   整个文件夹自成一体，误删主目录内容、清理废纸篓都不影响工具运行 */
const COMPONENT_DIR = path.join(TOOL_DIR, '组件');
const localEngine = path.join(COMPONENT_DIR, os.platform() === 'win32' ? `隧道引擎-${os.platform()}-${os.arch()}.exe` : `隧道引擎-${os.platform()}-${os.arch()}`);
const CF_PATH = fs.existsSync(localEngine) ? localEngine :
  path.join(TOOL_DIR, '虚渡.app', 'Contents', 'Resources', '组件', path.basename(localEngine));
/* 历史记录改为内存存储：工具运行期间保留，重启自动清空，无需写文件 */
let historyList = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const USE_SHELL = os.platform() === 'win32';

/* ================= 隧道状态 ================= */
let stopGeneration = 0;
let busy = false; // 一次只跑一条完整流程（预检/建隧道）
let current = { running: false, url: null, localPort: null, startedAt: null, progress: null };

function now() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/* ================= 隧道引擎检测 ================= */
async function ensureCloudflared() {
  if (fs.existsSync(CF_PATH)) { try { fs.chmodSync(CF_PATH, 0o755); } catch {} return; }
  throw new Error('隧道引擎未找到：组件目录中缺少 ' + path.basename(CF_PATH) + '，请重新下载完整安装包');
}

/* ================= 本地端口预检 ================= */
function checkLocalPort(port, timeout = 1200) {
  return new Promise(resolve => {
    const s = net.connect({ port, host: '127.0.0.1', timeout });
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
    s.once('timeout', () => { s.destroy(); resolve(false); });
  });
}

async function ensureLocalService(port) {
  if (await checkLocalPort(port)) return; // 服务已在运行，无需处理
  throw new Error(`本地 ${port} 端口没有服务在运行。请先手动启动你的项目（如在项目目录执行 npm run dev），确认 localhost:${port} 能打开后，再回来点击「获取公网地址」`);
}

/* ================= 隧道生命周期（多地址并存） =================
   每次获取新开一条隧道，旧隧道保留运行——旧地址在工具运行期间继续可用，
   避免"点了一次新地址，刚发出去的旧地址就 530 失联"。上限 5 条，超出时淘汰最旧的。 */
let tunnelProcs = [];
const endingTunnels = new Map();

function endTunnel(proc) {
  if (endingTunnels.has(proc)) return endingTunnels.get(proc);
  if (proc.exitCode !== null || proc.signalCode !== null || !proc.pid) return Promise.resolve();
  const stopped = new Promise(resolve => {
    const timer = setTimeout(() => proc.kill('SIGKILL'), 1500);
    proc.once('exit', () => {
      clearTimeout(timer);
      endingTunnels.delete(proc);
      resolve();
    });
    proc.kill('SIGTERM');
  });
  endingTunnels.set(proc, stopped);
  return stopped;
}

async function stopTunnel() {
  stopGeneration++;
  const processes = [...tunnelProcs, ...endingTunnels.keys()];
  tunnelProcs = [];
  current = { running: false, url: null, localPort: null, startedAt: null, progress: null };
  await Promise.all(processes.map(endTunnel));
}

async function killTunnelByUrl(url) {
  const proc = tunnelProcs.find(p => p.tunnelUrl === url);
  if (!proc) return;
  tunnelProcs = tunnelProcs.filter(p => p !== proc);
  if (current.url === url) current = { running: false, url: null, localPort: null, startedAt: null, progress: null };
  await endTunnel(proc);
}

function startTunnel(localPort) {
  return new Promise((resolve, reject) => {
    // --protocol http2:走 TCP 443,国内网络下比默认 QUIC(UDP)稳定得多,避免 Cloudflare 1033 断连
    // --http-host-header:回源时把 Host 改写回 localhost。Vite/Webpack 等开发服务器有"允许域名"安全校验,
    //   不改写时它们会因 Host 是 xxx.trycloudflare.com 而直接拒绝(403 Blocked request),公网地址就"打不开"
    const proc = spawn(CF_PATH, ['tunnel', '--url', `http://localhost:${localPort}`, '--http-host-header', `localhost:${localPort}`, '--no-autoupdate', '--protocol', 'http2'], USE_SHELL ? { shell: true } : {});
    tunnelProcs.push(proc);
    let buf = '', url = null, settled = false;
    const onData = d => {
      if (settled) return;
      buf = (buf + d.toString()).slice(-8192);
      if (!url) {
        const m = buf.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
        if (m) {
          url = m[0];
          settled = true;
          proc.tunnelUrl = url; // 供 killTunnelByUrl 定位（验证不过时弃用死地址）
          proc.localPort = localPort;
          proc.createdAt = now();
          proc.health = 'pending';
          clearTimeout(timer);
          resolve(url);
        }
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    const ended = error => {
      clearTimeout(timer);
      tunnelProcs = tunnelProcs.filter(p => p !== proc);
      if (url && current.url === url) current.running = false;
      if (!settled) {
        settled = true;
        reject(error || new Error('隧道进程提前退出，请稍后重试'));
      }
    };
    proc.once('error', ended);
    proc.once('exit', () => ended());
    const timer = setTimeout(() => {
      if (!settled) {
        ended(new Error('60 秒内未取得公网地址，请检查网络后重试'));
        void endTunnel(proc);
      }
    }, 60000);

  });
}

/* ================= 历史记录：每获取一次地址都记一条（内存存储，重启清空） ================= */
function addHistory(port, url) {
  historyList.unshift({ time: now(), port, url });
  if (historyList.length > 100) historyList.length = 100;
}

// Use the same DNS and TLS path as a visitor on this network.
function probe(url) {
  return new Promise(resolve => {
    const req = https.get(url, res => {
      resolve(res.statusCode >= 200 && res.statusCode < 300);
      res.destroy();
    });
    const timer = setTimeout(() => { resolve(false); req.destroy(); }, 5000);
    req.once('close', () => clearTimeout(timer));
    req.once('error', () => resolve(false));
  });
}

const activeTunnels = () => tunnelProcs.filter(p => p.published);
let checkingHealth = false;
setInterval(async () => {
  if (checkingHealth) return;
  checkingHealth = true;
  try {
    await Promise.all(activeTunnels().map(async p => {
      const healthy = await probe(p.tunnelUrl);
      p.failures = healthy ? 0 : (p.failures || 0) + 1;
      if (healthy) p.health = 'reachable';
      else if (p.failures >= 2) p.health = 'unreachable';
    }));
  } finally {
    checkingHealth = false;
  }
}, 15000).unref();

async function fullStart(port, verify = true) {
  if (busy || shuttingDown) throw new Error('正在处理上一个请求，请稍候再试');
  busy = true;
  const generation = stopGeneration;
  let url;
  try {
    current.progress = '正在检查本地服务…';
    await ensureLocalService(port);
    await ensureCloudflared();
    for (let attempt = 1; attempt <= (verify ? 3 : 1); attempt++) {
      if (generation !== stopGeneration) throw new Error('已取消');
      current.progress = '正在建立隧道（第 ' + attempt + ' 次）…';
      url = await startTunnel(port);
      const proc = tunnelProcs.find(p => p.tunnelUrl === url);
      const stillActive = () => generation === stopGeneration && tunnelProcs.includes(proc);
      if (verify) {
        current.progress = '正在从本机验证公网首页…';
        const deadline = Date.now() + 30000;
        while (stillActive() && Date.now() < deadline) {
          if (await probe(url)) {
            proc.health = 'reachable';
            break;
          }
          if (stillActive()) await sleep(2000);
        }
      }
      if (stillActive() && (!verify || proc.health === 'reachable')) {
        proc.published = true;
        const active = activeTunnels();
        if (active.length > 5) await killTunnelByUrl(active[0].tunnelUrl);
        if (!stillActive()) throw new Error('已取消');
        current = { running: true, url, localPort: port, startedAt: Date.now(), progress: null };
        addHistory(port, url);
        return url;
      }
      await killTunnelByUrl(url);
    }
    throw new Error('公网首页验证失败：请确认本地首页返回 HTTP 2xx，或稍后重试');
  } finally {
    busy = false;
    current.progress = null;
  }
}

/* ================= HTTP 服务 ================= */
const ALLOWED_HOSTS = new Set([`127.0.0.1:${LISTEN_PORT}`, `localhost:${LISTEN_PORT}`]);
/* Origin 头带协议（http://…），与 Host（不含协议）分开两张白名单 */
const ALLOWED_ORIGINS = new Set([`http://127.0.0.1:${LISTEN_PORT}`, `http://localhost:${LISTEN_PORT}`]);
/* 敏感端口黑名单：系统/远程管理/数据库端口禁止公开（防止把 SSH、RDP 等暴露到公网） */
const BLOCKED_PORTS = new Set([21, 22, 23, 25, 110, 135, 139, 445, 1433, 3306, 3389, 5432, 5900, 6379, 27017]);

// Bound the retained data even if a local client streams an oversized body.
function readAction(req) {
  return new Promise(resolve => {
    let size = 0;
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => {
      size += Buffer.byteLength(chunk);
      if (size <= 4096) body += chunk;
      else resolve({ status: 413, error: '请求内容过长' });
    });
    req.once('error', () => resolve({ status: 400, error: '请求已中断' }));
    req.once('end', () => {
      if (size > 4096) return;
      try {
        const data = JSON.parse(body || '{}');
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
        resolve({ data });
      } catch {
        resolve({ status: 400, error: '请求内容无效' });
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const send = (code, data, type = 'application/json; charset=utf-8', extra = {}) => {
    res.writeHead(code, { ...pageHeaders, 'Content-Type': type, ...extra });
    res.end(typeof data === 'string' ? data : JSON.stringify(data));
  };

  // 安全门 1：Host 白名单，防 DNS 重绑定把本页接口暴露给恶意网站跨域读取
  if (!ALLOWED_HOSTS.has(String(req.headers.host || ''))) {
    return send(403, { error: 'forbidden host' });
  }
  const isPage = req.method === 'GET' && (req.url === '/' || req.url === '/index.html');
  if (req.method === 'GET' && req.url === '/api/instance') {
    return send(200, { product: 'VoidBridge', entry });
  }
  if (browserOwned && !shuttingDown && req.method === 'GET' && req.url === '/api/browser-session') {
    clearTimeout(browserIdleTimer);
    browserTabs.add(res);
    res.writeHead(200, { ...pageHeaders, 'Content-Type': 'text/event-stream' });
    res.write(': connected\n\n');
    const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 15000);
    res.once('close', () => {
      clearInterval(keepAlive);
      browserTabs.delete(res);
      if (!shuttingDown && !browserTabs.size) waitForBrowser(4000);
    });
    return;
  }
  const appNavigation = appToken && isPage && req.headers['x-voidbridge-app'] === appToken;
  const appSession = appToken && (req.headers.cookie || '').split(';').some(cookie =>
    cookie.trim() === 'voidbridge-app=' + appToken);
  if (appToken && !appNavigation && !appSession) {
    if (isPage) return send(409, APP_ACTIVE_HTML, 'text/html; charset=utf-8');
    return send(409, { error: '虚渡 App 正在运行。关闭 App 后，再双击「启动.command」。' });
  }

  // 安全门 2：写操作必须是本页发起（application/json + 同源 Origin），防恶意网页 CSRF 操纵本地工具
  if (req.method === 'POST') {
    if (!String(req.headers['content-type'] || '').includes('application/json')) {
      return send(415, { error: 'content-type 不支持' });
    }
    const origin = String(req.headers.origin || '');
    if (!ALLOWED_ORIGINS.has(origin) || origin !== 'http://' + req.headers.host) {
      return send(403, { error: 'forbidden origin' });
    }
  }

  if (req.method === 'GET' && String(req.url || '').split('?')[0] === '/media/voidbridge-promo.mp4') {
    const file = path.join(TOOL_DIR, '介绍页面', 'media', 'voidbridge-promo.mp4');
    let size;
    try { size = fs.statSync(file).size; } catch { return send(404, { error: '视频不可用' }); }
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
    const start = range ? Number(range[1]) : 0;
    const end = range && range[2] ? Math.min(size - 1, Number(range[2])) : size - 1;
    if (start > end) return send(416, { error: 'range' }, undefined, { 'Content-Range': 'bytes */' + size });
    res.writeHead(range ? 206 : 200, {
      'Content-Type':'video/mp4', 'Accept-Ranges':'bytes', 'Content-Length':end-start+1,
      'Cache-Control':'private, max-age=86400',
      ...(range ? { 'Content-Range':'bytes '+start+'-'+end+'/'+size } : {}),
    });
    const stream = fs.createReadStream(file, { start, end });
    stream.once('error', () => res.destroy());
    res.once('close', () => stream.destroy());
    stream.pipe(res);
    return;
  }
  if (isPage) {
    const headers = appNavigation ? {
      'Set-Cookie': 'voidbridge-app=' + appToken + '; HttpOnly; SameSite=Strict; Path=/',
    } : {};
    return send(200, PAGE_HTML.replace('<!-- ENTRY -->', entry === 'app' ? 'macOS App' : '本机网页')
      .replace('/* BROWSER_SESSION */', browserOwned ? browserSessionScript : ''), 'text/html; charset=utf-8', headers);
  }
  if (req.method === 'GET' && req.url === '/api/status') {
    return send(200, { ...current, busy, health: activeTunnels().find(p => p.tunnelUrl === current.url)?.health });
  }
  if (req.method === 'GET' && req.url === '/api/tunnels') {
    return send(200, activeTunnels().map(p => ({
      url: p.tunnelUrl, port: p.localPort, time: p.createdAt, health: p.health,
    })));
  }
  if (req.method === 'GET' && req.url === '/api/history') {
    return send(200, historyList);
  }
  if (req.method === 'POST') {
    const actions = new Set(['/api/history/clear', '/api/history/delete', '/api/tunnel/kill', '/api/start', '/api/stop']);
    if (!actions.has(req.url)) return send(404, { error: '请求不存在' });

    const input = await readAction(req);
    if (input.error) return send(input.status, { error: input.error });
    const data = input.data;
    if (req.url === '/api/history/clear') {
      historyList = [];
    } else if (req.url === '/api/history/delete') {
      if (typeof data.url !== 'string') return send(400, { error: '缺少链接' });
      historyList = historyList.filter(h => h.url !== data.url);
    } else if (req.url === '/api/tunnel/kill') {
      if (typeof data.url !== 'string') return send(400, { error: '缺少链接' });
      await killTunnelByUrl(data.url);
    } else if (req.url === '/api/stop') {
      await stopTunnel();
    } else {
      const port = data.port;
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        return send(400, { error: '端口无效：请输入 1–65535 之间的数字' });
      }
      if (port === LISTEN_PORT || BLOCKED_PORTS.has(port)) {
        return send(400, { error: '此端口不能公开。请填写你的网页服务端口，例如 3000 或 5173。' });
      }
      if (busy) return send(409, { error: '正在处理上一个请求，请稍候。' });
      try {
        const url = await fullStart(port, data.verify !== false);
        return send(200, { ok: true, url, localPort: port });
      } catch (error) {
        return send(500, { error: error.message || '启动失败' });
      }
    }
    return send(200, { ok: true });
  }
  send(404, { error: 'not found' });
});

// The port bind is the lock. A read-only probe explains who owns it.
function findActiveEntry() {
  return new Promise(resolve => {
    const request = http.get({ host: '127.0.0.1', port: LISTEN_PORT, path: '/api/instance', agent: false }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        body += chunk;
        if (body.length > 512) { resolve(null); request.destroy(); }
      });
      response.on('end', () => {
        try {
          const info = JSON.parse(body);
          resolve(response.statusCode === 200 && info.product === 'VoidBridge' ? info.entry : null);
        } catch { resolve(null); }
      });
      response.on('error', () => resolve(null));
    });
    const timer = setTimeout(() => { resolve(null); request.destroy(); }, 1200);
    request.once('close', () => clearTimeout(timer));
    request.once('error', () => resolve(null));
  });
}

server.on('error', async error => {
  if (error.code !== 'EADDRINUSE') {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }
  const activeEntry = await findActiveEntry();
  if (activeEntry === 'app') {
    console.error('虚渡 App 正在运行，请继续使用 App。切换到网页时，先退出 App，再双击「启动.command」。');
    process.exitCode = 73;
  } else if (activeEntry === 'web') {
    console.error('虚渡网页模式正在运行。请继续使用已打开的页面。关闭全部虚渡标签页后，网页模式会自动退出。');
    process.exitCode = 74;
  } else {
    console.error('端口 9800 已被其他程序占用。请检查占用程序，再重新启动虚渡。');
    process.exitCode = 75;
  }
});

server.listen(LISTEN_PORT, '127.0.0.1', () => {
  // 启动即清空历史记录：隐私保护。每次运行从空白待命开始，别人打开页面不会看到旧记录；
  // 仅保留本次运行期间新产生的公网地址（重启后旧地址与旧记录一并清空）。
  historyList = [];
  console.log(`虚渡 VoidBridge已就绪： http://127.0.0.1:${LISTEN_PORT}`);
  if (browserOwned) {
    waitForBrowser(45000);
    setTimeout(() => {
      const url = `http://127.0.0.1:${LISTEN_PORT}`;
      if (os.platform() === 'win32') {
        exec(`start "" "${url}"`);
      } else if (os.platform() === 'darwin') {
        exec(`open "${url}"`);
      } else {
        exec(`xdg-open "${url}"`);
      }
    }, 800);
  }
});

/* 退出时带走隧道子进程 */
let shuttingDown = false;
async function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  clearTimeout(browserIdleTimer);
  for (const tab of browserTabs) tab.end();
  server.close();
  await stopTunnel();
  process.exit(code);
}
for (const signal of ['SIGINT', 'SIGHUP', 'SIGTERM']) process.on(signal, () => shutdown());
const appParent = Number(process.env.VOIDBRIDGE_APP_PID);
if (entry === 'app' && Number.isSafeInteger(appParent) && appParent > 1) {
  // A force-quit skips AppKit's normal termination callback.
  const checkParent = () => { if (process.ppid !== appParent) shutdown(); };
  setInterval(checkParent, 1000).unref();
  checkParent();
}
process.on('uncaughtException', error => { console.error(error); shutdown(1); });

process.on('unhandledRejection', e => { console.error('[未处理的 Promise 拒绝]', e); });

const APP_ACTIVE_HTML = `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>虚渡 App 正在运行</title>
<style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f8f9fa;color:#202124;font:16px/1.65 system-ui,sans-serif}
main{width:min(30rem,85vw);padding:2rem;box-sizing:border-box;background:#fff;border:1px solid #f8f9fa;border-radius:24px}
small{color:#202124;font-weight:700;letter-spacing:.1em}h1{font-size:1.65rem;margin:.6rem 0}p{margin:.6rem 0}
</style>
<main><small>虚渡 VOIDBRIDGE</small><h1>虚渡 App 正在运行</h1>
<p>请继续在 App 里管理当前的分享链接。</p>
<p>想切换到网页？先退出 App，再双击「启动.command」。切换会结束本次会话的临时链接。</p></main></html>`;
 
/* ================= 内联页面（Google 彩虹风 · 纯 CSS/SVG 手绘 · 无 emoji） ================= */
const PAGE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>虚渡 VoidBridge</title>
<style>
  /* ===== Google Material Design · 单层干净样式 ===== */
  :root{color-scheme:light;accent-color:#1a73e8;
    --ink:#202124;--muted:#5f6368;--faint:#80868b;--paper:#f8f9fa;--white:#fff;--line:#e8eaed;--line-strong:#dadce0;
    --blue:#1a73e8;--blue-hover:#185abc;--blue-soft:#e8f0fe;--blue-ink:#174ea6;
    --green:#188038;--green-soft:#e6f4ea;--red:#d93025;--red-soft:#fce8e6;
    --shadow-1:0 1px 2px rgba(60,64,67,.3),0 1px 3px 1px rgba(60,64,67,.15);
    --shadow-2:0 1px 3px rgba(60,64,67,.12),0 8px 24px rgba(60,64,67,.12);
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    min-height: 100vh; display: flex; align-items: center; justify-content: center;
    font-family: "Google Sans", -apple-system, BlinkMacSystemFont, "PingFang SC", "Helvetica Neue", sans-serif;
    background: var(--paper); color: var(--ink); -webkit-font-smoothing: antialiased; padding: 24px;
  }
  .wrap { display: flex; gap: 20px; align-items: stretch; justify-content: center; width: 100%; max-width: 980px; }

  .card {
    width: min(600px, 100%); flex-shrink: 0; background: var(--white); border-radius: 24px;
    border: 1px solid var(--line); padding: 36px 36px 30px; box-shadow: var(--shadow-2);
    position: relative; overflow: hidden;
  }

  /* 右侧面板 */
  .right-panel {
    flex: 1; min-width: 260px; max-width: 330px; background: var(--white); border-radius: 24px;
    border: 1px solid var(--line); padding: 18px 18px 16px; box-shadow: var(--shadow-2);
    display: flex; flex-direction: column; position: relative;
  }
  .rp-tabs { display: flex; gap: 6px; background: #F1F3F4; border-radius: 999px; padding: 4px; flex-shrink: 0; margin-bottom: 12px; }
  .rp-tab {
    flex: 1; display: flex; align-items: center; justify-content: center; gap: 6px;
    border: none; cursor: pointer; background: transparent; color: var(--muted);
    border-radius: 999px; padding: 8px 6px; font-size: 12px; font-weight: 700; font-family: inherit;
    transition: background .2s ease, color .2s ease, box-shadow .2s ease;
  }
  .rp-tab:hover { color: var(--ink); }
  .rp-tab.active { background: var(--white); color: var(--blue); box-shadow: var(--shadow-1); }
  .rp-body { flex: 1; min-height: 0; display: flex; flex-direction: column; }
  .rp-pane { display: none; flex: 1; min-height: 0; flex-direction: column; }
  .rp-pane.show { display: flex; }

  .h-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; flex-shrink: 0; }
  .h-title { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 700; }
  .h-clear {
    border: none; cursor: pointer; background: #F1F3F4; color: var(--muted); font-family: inherit;
    border-radius: 999px; padding: 5px 12px; font-size: 11px; font-weight: 700; transition: background .2s ease, color .2s ease;
  }
  .h-clear:hover { background: var(--red-soft); color: var(--red); }
  .h-list { flex: 1; min-height: 0; max-height: 310px; overflow-y: auto; display: flex; flex-direction: column; gap: 10px; padding-right: 2px; }
  .h-list::-webkit-scrollbar { width: 6px; }
  .h-list::-webkit-scrollbar-thumb { background: var(--line); border-radius: 999px; }
  .h-item { background: var(--paper); border-radius: 16px; padding: 11px 13px; transition: background .2s ease; position: relative; }
  .h-item:hover { background: #F1F3F4; }
  .h-item-inner { margin-right: 24px; }
  .h-del { position:absolute; top:8px; right:8px; width:22px; height:22px; border:none; cursor:pointer;
    background:transparent; color:#9AA0A6; border-radius:50%; display:flex; align-items:center; justify-content:center;
    transition: background .2s ease, color .2s ease; padding:0; }
  .h-del:hover { background: var(--red-soft); color: var(--red); }
  .h-time { font-size: 10.5px; color: #9AA0A6; font-weight: 700; margin-bottom: 4px; letter-spacing: .3px; }
  .h-url { font-size: 12px; color: var(--blue-ink); font-weight: 700; word-break: break-all; cursor: pointer; line-height: 1.55; }
  .h-url:hover { text-decoration: underline; }
  .h-empty { font-size: 12px; color: var(--faint); text-align: center; padding: 30px 8px; line-height: 1.9; font-weight: 500; }

  /* 多线路模式 */
  .ml-scroll { flex: 1; min-height: 0; overflow-y: auto; padding-right: 2px; }
  .ml-scroll::-webkit-scrollbar { width: 6px; }
  .ml-scroll::-webkit-scrollbar-thumb { background: var(--line); border-radius: 999px; }
  .ml-grid { position: relative; padding: 6px 0 14px; }
  .ml-main-line {
    display: inline-flex; align-items: center; gap: 7px; position: relative; z-index: 2;
    background: var(--blue); color: #FFF; border-radius: 999px; padding: 8px 15px;
    font-size: 12px; font-weight: 700; box-shadow: var(--shadow-1);
  }
  .ml-main-line::before {
    content: ''; width: 8px; height: 8px; border-radius: 50%; background: #FFF;
    box-shadow: 0 0 0 3px rgba(255,255,255,.3);
  }
  .ml-count { background: #FFF; color: var(--blue); font-size: 11px; font-weight: 800; border-radius: 999px; padding: 1px 8px; min-width: 20px; text-align: center; }
  .ml-tree { display: flex; align-items: stretch; }
  .ml-trunk { width: 3px; border-radius: 999px; background: var(--line); margin: 2px 0 0 16px; flex-shrink: 0; }
  .ml-branches { display: flex; flex-direction: column; gap: 10px; flex: 1; padding-left: 14px; min-width: 0; }
  .ml-branch { display: flex; align-items: stretch; position: relative; }
  .ml-branch::before {
    content: ''; position: absolute; left: -14px; top: 50%; width: 14px; height: 2.5px;
    border-radius: 999px; background: var(--mlc, var(--blue)); opacity: .55;
  }
  .ml-node {
    flex: 1; display: flex; align-items: center; gap: 10px; text-align: left; font-family: inherit;
    background: var(--paper); border-radius: 16px; padding: 10px 12px; border: none; cursor: pointer;
    box-shadow: inset 0 0 0 1.5px var(--line); min-width: 0;
    transition: background .2s ease, box-shadow .2s ease, transform .15s ease;
  }
  .ml-node:hover { background: var(--white); box-shadow: inset 0 0 0 1.5px var(--mlc, var(--blue)); transform: translateX(2px); }
  .ml-node:active { transform: scale(.98); }
  .ml-dot { width: 10px; height: 10px; border-radius: 50%; background: var(--mlc, var(--blue)); flex-shrink: 0;
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--mlc, var(--blue)) 18%, transparent); }
  .ml-tx { flex: 1; min-width: 0; }
  .ml-tx b { display: block; font-size: 12px; font-weight: 700; color: var(--ink); }
  .ml-tx span { display: block; font-size: 10.5px; color: var(--faint); font-weight: 600; margin-top: 1px; }
  .ml-status { flex-shrink: 0; font-size: 9.5px; font-weight: 700; border-radius: 999px; padding: 3px 8px; background: var(--green-soft); color: var(--green); letter-spacing: .3px; }
  .ml-status.dead { background: var(--red-soft); color: var(--red); }
  .ml-empty { font-size: 12px; color: var(--faint); text-align: center; padding: 28px 8px 6px; line-height: 1.9; font-weight: 500; }
  .ml-popup {
    position: absolute; z-index: 30; left: 50%; top: 50%; transform: translate(-50%,-50%) scale(.96);
    width: min(260px, 86%); background: var(--white); border-radius: 20px; padding: 15px 16px;
    box-shadow: var(--shadow-2); opacity: 0; pointer-events: none;
    transition: opacity .18s ease, transform .18s ease;
  }
  .ml-popup.show { opacity: 1; pointer-events: auto; transform: translate(-50%,-50%) scale(1); }
  .ml-popup b { display: block; font-size: 12.5px; font-weight: 700; color: var(--ink); margin-bottom: 6px; }
  .ml-url { display: block; font-size: 11px; color: var(--blue-ink); font-weight: 700; word-break: break-all; line-height: 1.55; margin-bottom: 12px; }
  .ml-actions { display: flex; gap: 7px; }
  .ml-actions button {
    flex: 1; border: none; cursor: pointer; border-radius: 999px; padding: 8px 0; font-family: inherit;
    font-size: 11.5px; font-weight: 700; background: #F1F3F4; color: #3C4043;
    transition: background .2s ease, color .2s ease;
  }
  .ml-actions button:hover { background: var(--line); }
  .ml-actions button.danger { color: var(--red); }
  .ml-actions button.danger:hover { background: var(--red-soft); }
  .ml-actions button.primary { background: var(--blue); color: #FFF; }
  .ml-actions button.primary:hover { background: var(--blue-hover); }
  .ml-mask { position: absolute; inset: 0; z-index: 25; display: none; }
  .ml-mask.show { display: block; }

  /* 顶部品牌区：白底 + Google 蓝图标 */
  .head { display: flex; align-items: center; gap: 16px; margin-bottom: 8px; }
  .head .logo { width: 54px; height: 54px; flex-shrink: 0; display: grid; place-items: center; background: var(--blue-soft); border-radius: 16px; }
  .head h1 { font-size: 23px; font-weight: 700; letter-spacing: 0.3px; }
  .head p { font-size: 12.5px; color: var(--faint); margin-top: 4px; font-weight: 500; }
  .entry-badge { display: inline-block; padding: 2px 8px; margin-left: 6px; background: var(--blue-soft); color: var(--blue-ink); border-radius: 999px; font-size: 11px; font-weight: 600; }
  .brand-rule { display: flex; gap: 5px; margin: 16px 0 24px; }
  .brand-rule i { width: 26px; height: 6px; border-radius: 999px; }
  .brand-rule i:nth-child(1){ background:#4285f4; } .brand-rule i:nth-child(2){ background:#ea4335; }
  .brand-rule i:nth-child(3){ background:#fbbc04; } .brand-rule i:nth-child(4){ background:#34a853; }

  /* 输入行 */
  .row-input { display: flex; gap: 12px; }
  .field {
    flex: 1; display: flex; align-items: center; background: #F1F3F4;
    border-radius: 999px; padding: 0 22px;
    transition: box-shadow .25s ease, background .25s ease;
  }
  .field:focus-within { background: var(--white); box-shadow: inset 0 0 0 2px var(--blue); }
  .field input {
    flex: 1; border: none; outline: none; background: transparent; font-family: inherit;
    font-size: 15px; font-weight: 700; color: var(--ink); padding: 15px 0; min-width: 0;
  }
  .field input::placeholder { color: #9AA0A6; font-weight: 500; }
  .field .prefix { color: var(--muted); font-weight: 700; font-size: 15px; user-select: none; margin-right: 4px; }
  .btn-main {
    border: none; cursor: pointer; border-radius: 999px; padding: 0 26px; font-family: inherit;
    font-size: 14px; font-weight: 700; color: #FFF; background: var(--blue);
    transition: background .2s ease, transform .15s ease, box-shadow .2s ease; white-space: nowrap;
  }
  .btn-main:hover { background: var(--blue-hover); box-shadow: var(--shadow-1); }
  .btn-main:active { transform: scale(.96); }
  .btn-main:disabled { background: var(--line); color: var(--faint); cursor: default; box-shadow: none; }

  .secondary-row { display: flex; align-items: center; gap: 8px; margin: 10px 0 0; color: var(--faint); font-size: 12px; }
  .secondary-row button { border: 0; padding: 4px 0; background: none; color: var(--blue); font: inherit; font-weight: 700; text-decoration: underline; cursor: pointer; }
  .secondary-row button:disabled { color: var(--faint); cursor: default; text-decoration: none; }

  /* 结果区 */
  .result {
    margin-top: 24px; border-radius: 20px; padding: 22px 24px; background: var(--paper);
    box-shadow: inset 0 0 0 1px var(--line); display: flex; align-items: center; gap: 14px; min-height: 92px;
    transition: background .3s ease, box-shadow .3s ease; position: relative;
  }
  .result.ok { background: var(--green-soft); box-shadow: inset 0 0 0 1px #c2dfcd; }
  .result.error { background: var(--red-soft); box-shadow: inset 0 0 0 1px #f3c6c2; }
  .dot { width: 11px; height: 11px; border-radius: 50%; background: #9AA0A6; flex-shrink: 0; transition: background .3s ease; }
  .dot.on { background: var(--green); }
  .dot.loading { background: var(--blue); animation: pulse 1s ease-in-out infinite; }
  .dot.error { background: var(--red); }
  @keyframes pulse { 50% { opacity: .3; } }
  .addr { flex: 1; min-width: 0; }
  .addr .label { font-size: 12.5px; font-weight: 700; color: var(--faint); letter-spacing: .6px; margin-bottom: 5px; }
  .addr .link { font-size: 15px; font-weight: 700; color: var(--blue-ink); word-break: break-all; line-height: 1.5; cursor: pointer; }
  .addr .link:hover { text-decoration: underline; }
  .addr .hint { font-size: 14px; font-weight: 500; color: var(--faint); line-height: 1.6; }

  .acts { display: flex; gap: 8px; flex-shrink: 0; }
  .btn-pill {
    display: flex; align-items: center; gap: 6px; border: none; cursor: pointer; font-family: inherit;
    border-radius: 999px; padding: 10px 16px; font-size: 13px; font-weight: 700;
    transition: background .2s ease, transform .15s ease;
  }
  .btn-pill:active { transform: scale(.94); }
  .btn-pill svg { flex-shrink: 0; }
  .btn-copy { color: var(--blue-ink); background: var(--blue-soft); }
  .btn-copy:hover { background: #d2e3fc; }
  .btn-copy.done { color: var(--green); background: var(--green-soft); }
  .btn-open { color: var(--muted); background: #F1F3F4; }
  .btn-open:hover { background: var(--line); }

  .tips { margin-top: 22px; font-size: 12px; color: var(--faint); line-height: 1.9; }
  .feedback { margin-top: 10px; color: var(--blue-ink); font-size: 13px; font-weight: 600; }

  .promo-trigger {
    margin-top: 16px; border: 0; border-radius: 999px; background: var(--blue-soft); color: var(--blue-ink);
    padding: 10px 20px; font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; transition: background .2s;
  }
  .promo-trigger:hover { background: #d2e3fc; }

  .quick-help { margin-top: 14px; border-top: 1px solid var(--line); padding-top: 12px; font-size: 12px; line-height: 1.7; color: var(--muted); }
  .quick-help summary { cursor: pointer; font-weight: 600; }
  .quick-help summary:hover { color: var(--blue); }
  .quick-help p { margin-top: 8px; }

  /* 宣传片弹层：flex 全屏居中，WKWebView / 浏览器均稳定居中 */
  .promo-overlay { position: fixed; inset: 0; z-index: 100; display: none; align-items: center; justify-content: center; background: rgba(32,33,36,.55); padding: 24px; box-sizing: border-box; }
  .promo-overlay.show { display: flex; }
  .promo-box { background: var(--white); border-radius: 24px; box-shadow: var(--shadow-2); padding: 18px 20px 20px; width: min(860px, 100%); box-sizing: border-box; animation: promoIn .22s cubic-bezier(.2,0,0,1); }
  @keyframes promoIn { from { opacity: 0; transform: translateY(14px) scale(.98); } to { opacity: 1; transform: none; } }
  .promo-top { display: flex; justify-content: space-between; gap: 12px; align-items: center; margin-bottom: 14px; }
  .promo-top strong { font-size: 17px; font-weight: 600; }
  .promo-top button { border: 0; border-radius: 999px; background: var(--blue-soft); color: var(--blue-ink); padding: 9px 18px; font: inherit; font-weight: 600; cursor: pointer; transition: background .2s; }
  .promo-top button:hover { background: #d2e3fc; }
  .promo-box video { display: block; width: 100%; aspect-ratio: 16/9; background: #f1f3f4; border-radius: 14px; }

  :focus-visible { outline: 2px solid var(--blue); outline-offset: 3px; }
  @media (prefers-reduced-motion: reduce) { *,*::before,*::after { animation-duration: .01ms !important; transition-duration: .01ms !important; } }
  @media (max-width: 920px) {
    body { align-items: flex-start; }
    .wrap { flex-direction: column; align-items: center; }
    .right-panel { width: 100%; max-width: 600px; max-height: 360px; }
  }
  @media (max-width: 600px) {
    .card { padding: 25px 18px; }
    .row-input { flex-direction: column; }
    .btn-main { width: 100%; padding: 14px 0; }
    .result { flex-wrap: wrap; }
  }
</style>
</head>
<body>
  <div class="wrap">
    <main class="card">
      <div class="head">
        <span class="logo"><svg width="32" height="32" viewBox="0 0 52 52" fill="none">
          <path d="M14 34 C7 34 4 29 6 25 C8 21 13 20 15 22 C15 15 21 10 27 12 C32 13 35 17 35 21 C41 20 45 24 44 29 C43 33 39 34 36 34 Z"
                fill="#ffffff" stroke="#1a73e8" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M18 40 L16 46 M26 40 L25 47 M34 40 L36 46" stroke="#1a73e8" stroke-width="2.8" stroke-linecap="round"/>
        </svg></span>
        <div>
          <h1>虚渡 <span style="font-size:0.6em;font-weight:400;color:#80868b">VoidBridge</span></h1>
          <p>本地网页分享 <span class="entry-badge"><!-- ENTRY --></span></p>
        </div>
      </div>
      <div class="brand-rule"><i></i><i></i><i></i><i></i></div>

      <div class="row-input">
        <label class="field">
          <span class="prefix">localhost:</span>
          <input id="portNum" aria-label="本地 HTTP 端口" placeholder="填端口号，如 3000" inputmode="numeric" maxlength="5" autocomplete="off" />
        </label>
        <button class="btn-main" id="btnStart" type="button" disabled>验证并获取链接</button>
      </div>

      <div class="secondary-row"><button id="btnQuick" type="button" disabled>快速获取</button><span>跳过首次公网验证</span></div>
      <div class="result" id="result" aria-live="polite">
        <span class="dot" id="dot"></span>
        <div class="addr">
          <div class="label" id="addrLabel">公网访问地址</div>
          <div class="hint" id="mainText"></div>
        </div>
        <div class="acts">
          <button class="btn-pill btn-open" id="btnOpen" style="display:none" title="在新标签页打开公网地址">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
              <path d="M14 4 H20 V10"/><path d="M20 4 L11 13"/><path d="M9 6 H5 A2 2 0 0 0 3 8 V19 A2 2 0 0 0 5 21 H16 A2 2 0 0 0 18 19 V15"/>
            </svg>打开
          </button>
          <button class="btn-pill btn-copy" id="btnCopy" style="display:none">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
              <rect x="9" y="9" width="12" height="12" rx="3"/>
              <path d="M5 15 H4.5 A2.5 2.5 0 0 1 2 12.5 V4.5 A2.5 2.5 0 0 1 4.5 2 H12.5 A2.5 2.5 0 0 1 15 4.5 V5"/>
            </svg><span id="copyLabel">复制</span>
          </button>
        </div>
      </div>

      <div class="tips">
        先启动要分享的本地网页。验证从本机检查公网首页是否返回 HTTP 2xx。
      </div>

      <p id="feedback" role="status" class="feedback" hidden></p>
      <button class="promo-trigger" type="button">观看宣传片</button>
      <details class="quick-help">
        <summary>分享前须知</summary>
        <p>持有链接的人可以访问，请只分享允许公开的网页。每次最多保留 5 条活动隧道，第 6 条成功后会停止最早的一条。退出当前入口后，本次链接失效。</p>
      </details>
    </main>

    <!-- 右侧面板：历史记录 / 多线路模式 -->
    <aside class="right-panel" id="rightPanel">
      <div class="rp-tabs">
        <button class="rp-tab" id="tabHistory" type="button">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="9"/><path d="M12 7 V12 L15.5 14"/>
          </svg><span class="tab-label">历史记录</span>
        </button>
        <button class="rp-tab active" id="tabMulti" type="button">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 7 H21 M3 12 H21 M3 17 H21"/><circle cx="7" cy="7" r="2"/><circle cx="17" cy="12" r="2"/><circle cx="10" cy="17" r="2"/>
          </svg><span class="tab-label">活动隧道</span>
        </button>
      </div>
      <div class="rp-body">
        <div class="rp-pane" id="paneHistory">
          <div class="h-head">
            <div class="h-title">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#5F6368" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="9"/><path d="M12 7 V12 L15.5 14"/>
              </svg>本次会话
            </div>
            <button class="h-clear" id="histClear" title="清空全部历史记录">清空</button>
          </div>
          <div class="h-list" id="histList"></div>
        </div>
        <div class="rp-pane show" id="paneMulti">
          <div class="ml-scroll">
            <div class="ml-grid" id="mlGrid">
              <div class="ml-main-line">活动隧道<span class="ml-count" id="mlCount">0</span></div>
              <div class="ml-tree">
                <div class="ml-trunk" id="mlTrunk" style="display:none"></div>
                <div class="ml-branches" id="mlBranches"><div class="ml-empty">还没有活动隧道</div></div>
              </div>
              <div class="ml-mask" id="mlMask"></div>
              <div class="ml-popup" id="mlPopup">
                <b id="mlPopTitle"></b>
                <span class="ml-url" id="mlPopUrl"></span>
                <div class="ml-actions">
                  <button id="mlActCopy" type="button">复制</button>
                  <button id="mlActOpen" type="button" class="primary">打开</button>
                  <button id="mlActDel" type="button" class="danger">停止分享</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </aside>
  </div>

  <!-- 获取方式选择弹窗 -->
<script>
  var $ = function(id){ return document.getElementById(id); };
  var input=$('portNum'), btn=$('btnStart'), result=$('result'), dot=$('dot'), mainText=$('mainText'),
      btnOpen=$('btnOpen'), btnCopy=$('btnCopy'), copyLabel=$('copyLabel'), addrLabel=$('addrLabel');
  var currentUrl=null, pollTimer=null, stateUrl=null, lastHealth=null;
  function setState(state, text, url){
    dot.className='dot'+(state==='on'?' on':state==='loading'?' loading':state==='error'?' error':'');
    mainText.className = state==='on' ? 'link' : 'hint';
    mainText.style.color = state==='error' ? '#d93025' : '';
    if(mainText.textContent!==text) mainText.textContent=text;
    result.className='result'+(state==='on'?' ok':state==='error'?' error':'');
    currentUrl=url||null;
    btnOpen.style.display = url?'flex':'none';
    btnCopy.style.display = url?'flex':'none';
    copyLabel.textContent='复制'; btnCopy.classList.remove('done');
    mainText.onclick = url ? function(){ openOutside(url); } : null;
  }

  // 只允许数字：粘贴/输入一律过滤
  input.addEventListener('input', function(){
    var v = input.value.replace(/\D/g,'').slice(0,5);
    if(v !== input.value) input.value = v;
    updateButtons();
  });

  async function copyText(t){
    try{
      if(navigator.clipboard){ await navigator.clipboard.writeText(t); return true; }
    }catch(e){}
    var ta=document.createElement('textarea');
    ta.value=t; ta.style.position='fixed'; ta.style.opacity='0';
    document.body.appendChild(ta); ta.select();
    try{ return document.execCommand('copy'); }
    catch(e){ return false; }
    finally{ ta.remove(); }
  }

  async function copyLink(url){
    var copied=await copyText(url);
    feedback(copied ? '链接已复制' : '无法写入剪贴板，请手动选中链接复制。');
  }

  // APP 内优先用内置浏览器打开，网页端回退新标签页
  function openOutside(u){
    if(!u) return;
    if(window.VoidBridgeApp && window.VoidBridgeApp.openUrl){ window.VoidBridgeApp.openUrl(u); }
    else { window.open(u,'_blank','noopener'); }
  }

  var quick=$('btnQuick'), submitting=false, connected=true, statusBusy=false, revision=0, polling=false;
  var actionError=false;
  function updateButtons(){
    btn.disabled=quick.disabled=!connected || submitting || statusBusy || !input.value;
  }
  function feedback(text){
    var note=$('feedback');
    note.textContent=text;
    note.hidden=!text;
  }
  function request(path, body){
    var options={cache:'no-store'};
    if(body===undefined) options.signal=AbortSignal.timeout(4500);
    if(body!==undefined){
      options.method='POST';
      options.headers={'Content-Type':'application/json'};
      options.body=JSON.stringify(body);
    }
    return fetch(path, options).then(async function(r){
      var data=await r.json();
      if(!r.ok) throw new Error(data.error || '本机请求失败');
      return data;
    });
  }

  async function start(verify){
    if(btn.disabled) return;
    var p=Number(input.value);
    if(!Number.isInteger(p) || p<1 || p>65535){
      setState('error','请输入 1–65535 之间的端口号');
      return;
    }
    submitting=true;
    actionError=false;
    revision++;
    feedback('');
    updateButtons();
    setState('loading', verify ? '正在验证公网首页…' : '正在建立临时隧道…');
    try{
      var d=await request('/api/start',{port:p,verify:verify});
      showLink(d.url,verify?'reachable':'pending');
      switchTab('multi');
      loadHistory(); loadTunnels();
    }catch(e){
      actionError=true;
      setState('error',e.message || '启动失败，请重试');
    }finally{
      submitting=false;
      revision++;
      updateButtons();
    }
  }

  function showLink(url,health){
    stateUrl=url;
    lastHealth=health;
    if(health==='reachable') setState('on',url,url);
    else if(health==='unreachable') setState('error','公网首页探测未通过 · '+url,url);
    else setState('loading','已生成，尚未验证 · '+url,url);
  }

  async function poll(){
    if(polling) return;
    polling=true;
    var requestedAt=revision;
    try{
      var s=await request('/api/status');
      if(requestedAt!==revision) return;
      var wasOffline=!connected;
      connected=true;
      statusBusy=s.busy;
      if(s.busy) setState('loading',s.progress || '正在处理…');
      else if(!submitting && !actionError){
        if(s.running && s.url){
          if(s.url!==stateUrl || s.health!==lastHealth || !currentUrl) showLink(s.url,s.health);
        }else if(stateUrl || wasOffline){
          stateUrl=null;
          setState('idle','填入端口，建立一个临时分享链接');
        }
      }
    }catch(e){
      if(requestedAt!==revision) return;
      connected=false;
      statusBusy=false;
      actionError=false;
      setState('error',e.message.startsWith('虚渡 App') ? e.message : '本机控制台连接中断，请检查虚渡是否正在运行。');
    }finally{
      polling=false;
      updateButtons();
    }
  }
  function startPoll(){
    poll();
    setInterval(function(){ poll(); loadTunnels(); },3000);
  }

  // 历史记录
  function esc(s){ return String(s).replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
  function loadHistory(){
    request('/api/history').then(renderHistory).catch(function(){});
  }
  function loadTunnels(){
    request('/api/tunnels').then(renderMulti).catch(function(){renderMulti([]);});
  }
  function renderHistory(list){
    var box=$('histList');
    if(!list || !list.length){
      box.innerHTML='<div class="h-empty">还没有记录<br/>每获取一次公网地址<br/>都会在这里留一条</div>';
      return;
    }
    box.innerHTML=list.map(function(h, i){
      return '<div class="h-item"><div class="h-item-inner"><div class="h-time">'+esc(h.time)+' · 端口 '+esc(String(h.port))+'</div>'+
             '<div class="h-url" data-url="'+esc(h.url)+'" title="点击复制">'+esc(h.url)+'</div></div>'+
             '<button class="h-del" data-url="'+esc(h.url)+'" title="删除该条记录">'+
             '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M5 5 L19 19 M19 5 L5 19"/></svg></button></div>';
    }).join('');
  }
  $('histList').addEventListener('click', function(e){
    // 点击删除按钮
    var delBtn=e.target.closest ? e.target.closest('.h-del') : null;
    if(delBtn){
      request('/api/history/delete',{url:delBtn.getAttribute('data-url')})
        .then(loadHistory).catch(function(e){feedback(e.message);});
      return;
    }
    // 点击地址复制
    var el=e.target.closest ? e.target.closest('.h-url') : null;
    if(!el) return;
    copyLink(el.getAttribute('data-url'));
  });
  $('histClear').addEventListener('click', function(){
    request('/api/history/clear',{}).then(loadHistory).catch(function(e){feedback(e.message);});
  });

  // ===== 右侧面板：标签切换（历史记录 / 多线路模式） =====
  var tabHistory=$('tabHistory'), tabMulti=$('tabMulti');
  var paneHistory=$('paneHistory'), paneMulti=$('paneMulti');
  function switchTab(tab){
    var isHistory = tab === 'history';
    tabHistory.classList.toggle('active', isHistory);
    tabMulti.classList.toggle('active', !isHistory);
    paneHistory.classList.toggle('show', isHistory);
    paneMulti.classList.toggle('show', !isHistory);
  }
  tabHistory.addEventListener('click', function(){ switchTab('history'); });
  tabMulti.addEventListener('click', function(){ switchTab('multi'); });

  // ===== 多线路模式：思维导图看板（主干 + 彩虹分支） =====
  var ML_COLORS = ['#1a73e8','#188038','#b06000','#c5221f','#7b1fa2'];
  var mlData = [], mlSel = -1;
  var mlPopup=$('mlPopup'), mlMask=$('mlMask');

  function renderMulti(list){
    if (JSON.stringify(mlData) === JSON.stringify(list)) return;
    var selectedUrl=mlData[mlSel] && mlData[mlSel].url;
    mlData = list || [];
    if(selectedUrl){
      mlSel=mlData.findIndex(function(item){return item.url===selectedUrl;});
      if(mlSel<0) mlHide();
    }
    $('mlCount').textContent = mlData.length;
    var trunk=$('mlTrunk'), box=$('mlBranches');
    if(!mlData.length){
      trunk.style.display='none';
      box.innerHTML='<div class="ml-empty">还没有活动隧道<br/>获取公网地址后，可以在这里停止分享</div>';
      return;
    }
    trunk.style.display='';
    box.innerHTML = mlData.map(function(h, i){
      var c = ML_COLORS[i % ML_COLORS.length];
      return '<div class="ml-branch" style="--mlc:'+c+'">'+
        '<button class="ml-node" data-i="'+i+'" type="button" title="点击查看线路操作">'+
          '<span class="ml-dot"></span>'+
          '<span class="ml-tx"><b>线路 '+(i+1)+' · 端口 '+esc(String(h.port))+'</b><span>'+esc(h.time)+'</span></span>'+
          '<span class="ml-status '+(h.health==='unreachable'?'dead':'')+'">'+(h.health==='reachable'?'本机探测可达':h.health==='unreachable'?'探测失败':'待验证')+'</span>'+
        '</button></div>';
    }).join('');
  }

  function mlShow(i){
    if(i<0 || !mlData[i]) return;
    mlSel=i;
    var h=mlData[i];
    $('mlPopTitle').textContent='线路 '+(i+1)+' · 端口 '+h.port;
    $('mlPopUrl').textContent=h.url;
    mlPopup.classList.add('show'); mlMask.classList.add('show');
  }
  function mlHide(){ mlPopup.classList.remove('show'); mlMask.classList.remove('show'); mlSel=-1; }

  $('mlBranches').addEventListener('click', function(e){
    var n = e.target.closest ? e.target.closest('.ml-node') : null;
    if(n) mlShow(Number(n.getAttribute('data-i')));
  });
  mlMask.addEventListener('click', mlHide);

  $('mlActCopy').addEventListener('click', function(){
    if(mlSel<0 || !mlData[mlSel]) return;
    copyLink(mlData[mlSel].url);
  });
  $('mlActOpen').addEventListener('click', function(){
    if(mlSel<0 || !mlData[mlSel]) return;
    openOutside(mlData[mlSel].url);
    mlHide();
  });
  $('mlActDel').addEventListener('click', function(){
    if(mlSel<0 || !mlData[mlSel]) return;
    var u=mlData[mlSel].url;
    mlHide();
    request('/api/tunnel/kill',{url:u})
      .then(function(){ feedback('已停止分享'); })
      .catch(function(e){feedback(e.message);})
      .finally(function(){ poll(); loadTunnels(); });
  });

  btn.addEventListener('click',function(){start(true);});
  quick.addEventListener('click',function(){start(false);});
  input.addEventListener('keydown',function(e){ if(e.key==='Enter' && !e.isComposing) start(true); });
  btnOpen.addEventListener('click',function(){ openOutside(currentUrl); });
  btnCopy.addEventListener('click',function(){ if(currentUrl) copyLink(currentUrl); });

  // 页面一打开：先给出清晰的待办提示（此时还没有任何公网地址），再开始轮询 + 拉取历史
  setState('idle','填入本地端口，建立一个临时分享链接');
  /* BROWSER_SESSION */
  startPoll();
  loadHistory();
  loadTunnels();
</script>
<div class="promo-overlay" id="promoOverlay" role="dialog" aria-modal="true" aria-labelledby="promo-title"><div class="promo-box"><div class="promo-top"><strong id="promo-title">虚渡 · 30 秒产品介绍</strong><button type="button" id="promo-close">关闭</button></div><video controls playsinline preload="none" data-src="/media/voidbridge-promo.mp4?v=3"></video></div></div>
<script>
(()=>{
 const overlay=document.getElementById('promoOverlay'),video=overlay.querySelector('video');
 const key='voidbridge-console-promo-v3';
 function show(){
   if(overlay.classList.contains('show'))return;
   if(!video.src) video.src=video.dataset.src;
   overlay.classList.add('show');
   video.play().catch(()=>{});
 }
 function hide(){ overlay.classList.remove('show'); video.pause(); }
 document.getElementById('promo-close').addEventListener('click',hide);
 overlay.addEventListener('click',function(e){ if(e.target===overlay) hide(); });
 document.addEventListener('keydown',function(e){ if(e.key==='Escape') hide(); });
 document.querySelector('.promo-trigger').addEventListener('click',show);
 let firstVisit=true;
 try{ firstVisit=!localStorage.getItem(key); }catch(e){}
 if(firstVisit) requestAnimationFrame(()=>{
   show();
   try{localStorage.setItem(key,'1');}catch(e){}
 });
})();
</script>
</body>
</html>`;

#!/usr/bin/env node
/**
 * 隧道分享工具 v3 —— 单文件版（页面已内联，本文件即全部核心逻辑）
 *
 * 用法：
 *   node server.mjs            启动后手动打开 http://127.0.0.1:9800
 *   node server.mjs --open     启动后自动打开浏览器（"启动.command"双击走这条）
 *
 * 特性：
 *   - 零 npm 依赖，纯 Node 标准库；文件夹整体拷走、发给别人都能用
 *   - cloudflared 缺失自动下载（自动识别 Mac/Windows/Linux，国内镜像优先）
 *   - 每次请求都从头到尾重新打通，绝不复用旧隧道结果
 *   - 多地址并存：每次点击新开一条隧道，旧地址在工具运行期间继续可用（上限 5 条）
 *   - 两种获取方式：快速（立即返回）/ 验证后（确认地址能打开才返回，等待 DNS 全球生效）
 *   - 本地服务没起会按「启动配置.json」自动启动（含依赖自动安装）
 *   - 历史记录：每获取一次公网地址都留一条（时间 + 端口 + 地址），右侧面板可查
 *   - 绝不自动出地址：不输入端口并点击按钮，页面上不会出现任何公网地址
 *   - 仅监听 127.0.0.1，管理权不暴露公网；无任何 AI，纯既定流程
 */
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import { fileURLToPath } from 'node:url';

const LISTEN_PORT = 9800;
const TOOL_DIR = path.dirname(fileURLToPath(import.meta.url));
/* 隧道引擎（驱动）就放在工具文件夹自己的「组件」目录里：不再复制到用户主目录 ~/bin，
   整个文件夹自成一体，误删主目录内容、清理废纸篓都不影响工具运行 */
const COMPONENT_DIR = path.join(TOOL_DIR, '组件');
const CF_PATH = path.join(COMPONENT_DIR, os.platform() === 'win32' ? `隧道引擎-${os.platform()}-${os.arch()}.exe` : `隧道引擎-${os.platform()}-${os.arch()}`);
const HISTORY_FILE = path.join(TOOL_DIR, '历史记录.json');    // 每次获取公网地址都追加一条
const LAUNCH_CONFIG_FILE = path.join(TOOL_DIR, '启动配置.json'); // 端口 -> 自动启动方案
const sleep = ms => new Promise(r => setTimeout(r, ms));
const USE_SHELL = os.platform() === 'win32';

/* ================= 隧道状态 ================= */
let tunnelProc = null;
let busy = false; // 一次只跑一条完整流程（预检/自动启动/建隧道）
let current = { running: false, url: null, localPort: null, startedAt: null, progress: null };

/* ================= 小工具：JSON 读写 / 时间 ================= */
function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function saveJson(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }
  catch (e) { console.error(`[警告] 写入 ${path.basename(file)} 失败：${e.message}`); }
}
function now() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/* ================= cloudflared 自动安装 ================= */
function platformAsset() {
  const map = {
    'darwin-arm64': 'cloudflared-darwin-arm64.tgz',
    'darwin-x64': 'cloudflared-darwin-amd64.tgz',
    'linux-x64': 'cloudflared-linux-amd64',
    'linux-arm64': 'cloudflared-linux-arm64',
    'win32-x64': 'cloudflared-windows-amd64.exe',
  };
  return map[`${os.platform()}-${os.arch()}`] || null;
}

async function downloadTo(url, dest) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`下载失败 HTTP ${res.status}`);
  await pipeline(res.body, createWriteStream(dest));
}

function extractTgz(file) {
  return new Promise((resolve, reject) => {
    const t = spawn('tar', ['-xzf', file, '-C', os.tmpdir()], USE_SHELL ? { shell: true } : {});
    t.on('close', c => (c === 0 ? resolve() : reject(new Error('解压失败'))));
    t.on('error', reject);
  });
}

async function ensureCloudflared(onProgress) {
  if (fs.existsSync(CF_PATH)) { try { fs.chmodSync(CF_PATH, 0o755); } catch {} return; }
  fs.mkdirSync(COMPONENT_DIR, { recursive: true });
  // ① 优先用「组件」目录里自带的引擎/压缩包（发给他人零下载、离线可用），解压后也归位到「组件」目录
  const pf = os.platform(), arch = os.arch();
  const localCandidates = [
    path.join(COMPONENT_DIR, `隧道引擎-${pf}-${arch}.tgz`),
    path.join(COMPONENT_DIR, `cloudflared-${pf}-${arch}`),
    path.join(COMPONENT_DIR, `cloudflared-${pf}-${arch}.tgz`),
  ];
  for (const c of localCandidates) {
    if (!fs.existsSync(c)) continue;
    if (c.endsWith('.tgz')) {
      await extractTgz(c);
      fs.copyFileSync(path.join(os.tmpdir(), 'cloudflared'), CF_PATH);
      fs.rmSync(path.join(os.tmpdir(), 'cloudflared'), { force: true });
    } else {
      fs.copyFileSync(c, CF_PATH);
    }
    fs.chmodSync(CF_PATH, 0o755);
    return;
  }
  // ② 组件目录没有 → 网络下载，直接存进「组件」目录（所有驱动集中在工具文件夹内，不碰系统、不放主目录）
  const asset = platformAsset();
  if (!asset) throw new Error(`暂不支持 ${pf}-${arch}，请手动安装 cloudflared 后重试`);
  onProgress?.('首次使用：正在下载隧道组件（约 20MB，一次性，存进工具文件夹的「组件」目录）…');
  const tmp = path.join(os.tmpdir(), asset);
  // 官方源优先，第三方镜像仅作兜底；下载后校验大小（过小多半是错误页/被劫持内容），防供应链投毒
  const urls = [
    `https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}`,
    `https://ghfast.top/https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}`,
  ];
  let ok = false, lastErr = null;
  for (const u of urls) {
    try {
      await downloadTo(u, tmp);
      if (fs.existsSync(tmp) && fs.statSync(tmp).size >= 5 * 1024 * 1024) { ok = true; break; }
      lastErr = new Error('下载内容异常（文件过小），已弃用该来源');
      fs.rmSync(tmp, { force: true });
    } catch (e) { lastErr = e; }
  }
  if (!ok) throw lastErr || new Error('下载 cloudflared 失败，请检查网络');
  if (asset.endsWith('.tgz')) {
    await extractTgz(tmp);
    fs.copyFileSync(path.join(os.tmpdir(), 'cloudflared'), CF_PATH);
    fs.rmSync(path.join(os.tmpdir(), 'cloudflared'), { force: true });
  } else {
    fs.copyFileSync(tmp, CF_PATH);
  }
  fs.rmSync(tmp, { force: true });
  fs.chmodSync(CF_PATH, 0o755);
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

/* ================= 自动启动本地服务（含依赖自动安装） ================= */
function runCommand(cmd, args, cwd, timeoutMs, onProgress) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, stdio: 'ignore', shell: USE_SHELL });
    const t = setTimeout(() => { try { p.kill(); } catch {} reject(new Error(`${cmd} 执行超时`)); }, timeoutMs);
    p.on('exit', c => { clearTimeout(t); c === 0 ? resolve() : reject(new Error(`${cmd} 执行失败`)); });
    p.on('error', e => { clearTimeout(t); reject(e); });
  });
}

async function ensureLocalService(port, onProgress) {
  if (await checkLocalPort(port)) return; // 服务已在运行，无需处理
  const cfgs = loadJson(LAUNCH_CONFIG_FILE, {});
  const cfg = cfgs[String(port)];
  if (!cfg) throw new Error(`本地 ${port} 端口没有服务在运行，且没有为它配置自动启动方案（可在工具文件夹的「启动配置.json」里添加）`);
  const cwd = cfg.cwd && path.isAbsolute(cfg.cwd) ? cfg.cwd : path.resolve(TOOL_DIR, cfg.cwd || '.');
  // 换电脑使用：配置里写的还是原电脑的项目路径，这台电脑上没有 → 给出明确指引而不是报晦涩错误
  if (cfg.cwd && !fs.existsSync(cwd)) {
    throw new Error(`「启动配置.json」里为 ${port} 端口配置的路径在这台电脑上不存在（${cwd}）。请用文本编辑器打开该文件，把路径改成这台电脑上项目的实际位置；或先手动启动项目，再回来获取公网地址`);
  }
  // 诚实原则：宣称"正在自动启动"之前先做预检——条件不具备就直接说原因，绝不画饼
  const cmd = cfg.command || 'npm';
  const isNodeCmd = /^(npm|npx|node|pnpm|yarn|bun)$/.test(cmd);
  if (isNodeCmd && !fs.existsSync(path.join(cwd, 'package.json'))) {
    throw new Error(`「启动配置.json」为 ${port} 配置的目录里没有 package.json，无法用 ${cmd} 启动；请核对该端口对应的项目路径`);
  }
  if (isNodeCmd) {
    const cmdOk = await new Promise(resolve => {
      const p = spawn(cmd, ['-v'], USE_SHELL ? { shell: true, stdio: 'ignore' } : { stdio: 'ignore' });
      const t = setTimeout(() => { try { p.kill(); } catch {} resolve(false); }, 5000);
      p.on('exit', c => { clearTimeout(t); resolve(c === 0); });
      p.on('error', () => { clearTimeout(t); resolve(false); });
    });
    if (!cmdOk) throw new Error(`启动命令「${cmd}」不可用（未安装或不在 PATH 中）；请先安装，或修改「启动配置.json」里的启动命令`);
  }
  // 自动补齐依赖：Node 项目缺 node_modules 时先安装（即项目所需的"驱动"）
  if (cfg.autoInstallDeps !== false && fs.existsSync(path.join(cwd, 'package.json')) && !fs.existsSync(path.join(cwd, 'node_modules'))) {
    onProgress?.(`正在为「${cfg.name || '端口 ' + port}」安装所需依赖（首次约 1-3 分钟）…`);
    await runCommand('npm', ['install', '--no-audit', '--no-fund'], cwd, 10 * 60 * 1000);
  }
  onProgress?.(`本地 ${port} 没有服务，正在自动启动「${cfg.name || '端口 ' + port}」…`);
  const logPath = path.join(TOOL_DIR, `服务日志-端口${port}.log`);
  fs.appendFileSync(logPath, `\n===== ${now()} 自动启动 ${cfg.name || ''} =====\n`);
  // stdio 必须用"已打开的文件描述符"：createWriteStream 是异步打开（fd 短暂为 null），
  // 直接把流传给 spawn 会被 Node 拒绝（The argument 'stdio' is invalid）
  const logFd = fs.openSync(logPath, 'a');
  const child = spawn(cfg.command || 'npm', cfg.args || [], { cwd, detached: true, stdio: ['ignore', logFd, logFd], shell: USE_SHELL });
  child.unref();
  fs.closeSync(logFd); // 子进程已继承句柄副本，父进程随手关闭自己的那份
  child.on('error', e => console.error(`[自动启动] 命令启动失败（多半是路径或命令不对）：${e.message}`));
  // 启动即崩溃 → 秒级报错，不再干等 120 秒超时
  let exitCode = null;
  child.on('exit', c => { if (c !== 0 && c !== null) exitCode = c; });
  const timeout = (cfg.readyTimeout || 120) * 1000;
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    await sleep(1500);
    if (exitCode !== null) throw new Error(`「${cfg.name || '端口 ' + port}」启动失败，请检查启动配置是否正确（详情见「服务日志-端口${port}.log」）`);
    if (await checkLocalPort(port)) {
      onProgress?.(`「${cfg.name || '端口 ' + port}」已就绪，开始打通隧道…`);
      return;
    }
  }
  throw new Error(`等待「${cfg.name || '端口 ' + port}」启动超时，可查看工具文件夹里的「服务日志-端口${port}.log」排查`);
}

/* ================= 隧道生命周期（多地址并存） =================
   每次获取新开一条隧道，旧隧道保留运行——旧地址在工具运行期间继续可用，
   避免"点了一次新地址，刚发出去的旧地址就 530 失联"。上限 5 条，超出时淘汰最旧的。 */
let tunnelProcs = [];

function stopTunnel() {
  for (const p of tunnelProcs) { try { p.kill('SIGTERM'); } catch {} }
  tunnelProcs = [];
  current = { running: false, url: null, localPort: null, startedAt: null, progress: null };
}

/* 只杀指定地址对应的那条隧道（验证不通过、弃用死地址时用） */
function killTunnelByUrl(url) {
  const i = tunnelProcs.findIndex(p => p.tunnelUrl === url);
  if (i >= 0) {
    const p = tunnelProcs[i];
    tunnelProcs.splice(i, 1);
    try { p.kill('SIGTERM'); } catch {}
    if (current.url === url) current = { running: false, url: null, localPort: null, startedAt: null, progress: null };
  }
}

function startTunnel(localPort) {
  return new Promise((resolve, reject) => {
    while (tunnelProcs.length >= 5) { const oldest = tunnelProcs.shift(); try { oldest.kill('SIGTERM'); } catch {} }
    // --protocol http2:走 TCP 443,国内网络下比默认 QUIC(UDP)稳定得多,避免 Cloudflare 1033 断连
    // --http-host-header:回源时把 Host 改写回 localhost。Vite/Webpack 等开发服务器有"允许域名"安全校验,
    //   不改写时它们会因 Host 是 xxx.trycloudflare.com 而直接拒绝(403 Blocked request),公网地址就"打不开"
    const proc = spawn(CF_PATH, ['tunnel', '--url', `http://localhost:${localPort}`, '--http-host-header', `localhost:${localPort}`, '--no-autoupdate', '--protocol', 'http2'], USE_SHELL ? { shell: true } : {});
    tunnelProcs.push(proc);
    let buf = '', url = null, settled = false;
    const onData = d => {
      buf += d.toString();
      if (!url) {
        const m = buf.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
        if (m) {
          url = m[0];
          settled = true;
          proc.tunnelUrl = url; // 供 killTunnelByUrl 定位（验证不过时弃用死地址）
          current.url = url;
          current.running = true;
          current.startedAt = Date.now();
          current.progress = null;
          resolve(url);
        }
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('exit', () => {
      tunnelProcs = tunnelProcs.filter(p => p !== proc);
      // 只有"当前显示的这条"隧道挂了才提示断开；旧隧道退场不影响页面
      if (url && current.url === url) current.running = false;
      if (!settled) { settled = true; reject(new Error('隧道进程提前退出，请稍后重试')); }
    });
    setTimeout(() => {
      if (!settled) { settled = true; try { proc.kill(); } catch {} reject(new Error('60 秒内未取得公网地址，请检查网络后重试')); }
    }, 60000).unref?.();
  });
}

/* ================= 历史记录：每获取一次地址都记一条 ================= */
function addHistory(port, url) {
  const list = loadJson(HISTORY_FILE, []);
  list.unshift({ time: now(), port, url });
  if (list.length > 100) list.length = 100;
  saveJson(HISTORY_FILE, list);
}

/* ================= 地址生效自检：新隧道域名 DNS 需几秒到几十秒才全球生效 =================
   刚生成就访问会"域名不存在"，且失败结果会被系统/浏览器负缓存，用户就会觉得"地址是假的"。
   所以拿到地址后工具自己先验证可访问（resolve4 直查 DNS 服务器 + 按解析出的 IP 直连，
   绕开本机负缓存），确认通了才把地址交给用户。 */
function fetchViaIp(url, ip, timeoutMs = 10000) {
  return new Promise(resolve => {
    let settled = false;
    const done = (ok, code) => { if (!settled) { settled = true; resolve({ ok, code }); } };
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, port: 443, path: '/', method: 'GET', servername: u.hostname,
      timeout: timeoutMs,
      lookup: (host, opts, cb) => cb(null, [{ address: ip, family: 4 }]),
    }, res => { res.resume(); done(true, res.statusCode); });
    req.on('timeout', () => { req.destroy(); done(false, 0); });
    req.on('error', () => done(false, 0));
    req.end();
  });
}

/* 直查 trycloudflare.com 的权威 NS：源头即真相，且不会像打公共 DNS 那样把"无记录"缓存到递归服务器上 */
let trycfNsResolver = null;
async function getTrycfNsResolver() {
  if (trycfNsResolver) return trycfNsResolver;
  const r = new dns.promises.Resolver();
  try {
    const ns = await dns.promises.resolveNs('trycloudflare.com');
    if (ns.length) { r.setServers(ns.slice(0, 2)); trycfNsResolver = r; return r; }
  } catch {}
  r.setServers(['223.5.5.5', '119.29.29.29']); // 兜底：国内可靠公共 DNS
  trycfNsResolver = r;
  return r;
}

async function waitUrlLive(url, onProgress, timeoutMs = 90000) {
  const host = new URL(url).hostname;
  const nsResolver = await getTrycfNsResolver();
  // 权威侧配记录需要几秒缓冲：过早去查会连累递归 DNS 缓存"无记录"，反而拖慢生效
  await sleep(8000);
  const t0 = Date.now();
  let lastErr = '';
  while (Date.now() - t0 < timeoutMs) {
    let ips = [];
    try { ips = await nsResolver.resolve4(host); } catch { ips = []; }
    if (ips.length) {
      const r = await fetchViaIp(url, ips[0]);
      if (r.ok && r.code < 500) {
        // 权威已生效且能打开。再等本机网络的 DNS 同步（本机浏览器走的是这条路），最多加等 45 秒
        let systemOk = false;
        const ts = Date.now();
        while (Date.now() - ts < 45000) {
          try { if ((await dns.promises.resolve4(host)).length) { systemOk = true; break; } } catch {}
          onProgress?.('地址已全球生效，正在等本机网络 DNS 同步（同步完本机浏览器立即可开）…');
          await sleep(1500);
        }
        if (!systemOk) console.log('[生效自检] 本机 DNS 同步较慢：其他网络（手机/对方）已可打开，本机浏览器可能需再等片刻');
        return true;
      }
      lastErr = r.ok ? `源站返回 ${r.code}` : '连接未就绪';
    } else {
      lastErr = '权威 DNS 尚无记录';
    }
    onProgress?.(`公网地址已生成，正在等待全球生效（${lastErr}）…`);
    await sleep(6000);
  }
  console.log(`[生效自检] 超时：${url}（${lastErr}）`);
  return false;
}

/* ================= 完整流程：每次从头到尾走一遍，绝不复用 ================= */
async function fullStart(port, verify = true) {
  if (busy) throw new Error('正在处理上一个请求，请稍候再试');
  busy = true;
  try {
    current = { running: false, url: null, localPort: port, startedAt: null, progress: '正在检查本地服务…' };
    await ensureLocalService(port, m => { current.progress = m; console.log('[流程]', m); });
    current.progress = '正在打通公网隧道…';
    await ensureCloudflared(m => { current.progress = m; console.log('[流程]', m); });
    let url = await startTunnel(port);
    if (verify) {
      // 验证后获取：确认地址真正能打开才返回（新域名 DNS 需几秒到几十秒全球生效）。
      // cloudflared 偶尔分到"从未配好 DNS 的死地址"：验证超时就弃用它、换全新地址重试（最多 3 次）
      let live = false;
      for (let attempt = 1; attempt <= 3 && !live; attempt++) {
        if (attempt > 1) {
          current.progress = `上一个地址迟迟未生效，已弃用，正在更换新地址（第 ${attempt} 次）…`;
          console.log(`[验证重试] 弃用未生效地址 ${url}，更换新地址重试`);
          killTunnelByUrl(url);
          url = await startTunnel(port);
        }
        current.progress = '公网地址已生成，正在确认可访问…';
        live = await waitUrlLive(url, m => { current.progress = m; });
      }
      if (!live) console.log('[提示] 连续多个地址均未在时限内生效（多为 DNS 波动），最后一条仍按生成返回');
    } else {
      // 快速获取：立即返回；地址全球生效需几十秒，期间打开会提示无法访问
      console.log('[快速模式] 跳过生效验证，地址全球生效需几十秒');
    }
    current = { running: true, url, localPort: port, startedAt: Date.now(), progress: null };
    addHistory(port, url);
    return url;
  } finally {
    busy = false;
    if (!current.running) current = { running: false, url: null, localPort: null, startedAt: null, progress: null };
  }
}

/* ================= HTTP 服务 ================= */
const ALLOWED_HOSTS = new Set([`127.0.0.1:${LISTEN_PORT}`, `localhost:${LISTEN_PORT}`]);
/* Origin 头带协议（http://…），与 Host（不含协议）分开两张白名单 */
const ALLOWED_ORIGINS = new Set([`http://127.0.0.1:${LISTEN_PORT}`, `http://localhost:${LISTEN_PORT}`]);
/* 敏感端口黑名单：系统/远程管理/数据库端口禁止公开（防止把 SSH、RDP 等暴露到公网） */
const BLOCKED_PORTS = new Set([21, 22, 23, 25, 110, 135, 139, 445, 1433, 3306, 3389, 5432, 5900, 6379, 27017]);

const server = http.createServer(async (req, res) => {
  const send = (code, data, type = 'application/json; charset=utf-8', extra = {}) => {
    res.writeHead(code, { 'Content-Type': type, ...extra });
    res.end(typeof data === 'string' ? data : JSON.stringify(data));
  };

  // 安全门 1：Host 白名单，防 DNS 重绑定把本页接口暴露给恶意网站跨域读取
  if (!ALLOWED_HOSTS.has(String(req.headers.host || ''))) {
    return send(403, { error: 'forbidden host' });
  }
  // 安全门 2：写操作必须是本页发起（application/json + 同源 Origin），防恶意网页 CSRF 操纵本地工具
  if (req.method === 'POST') {
    if (!String(req.headers['content-type'] || '').includes('application/json')) {
      return send(415, { error: 'content-type 不支持' });
    }
    const origin = String(req.headers.origin || '');
    if (origin && !ALLOWED_ORIGINS.has(origin)) {
      return send(403, { error: 'forbidden origin' });
    }
  }

  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    // no-store：防止浏览器缓存旧版页面（改版后立刻生效）
    return send(200, PAGE_HTML, 'text/html; charset=utf-8', { 'Cache-Control': 'no-store' });
  }
  if (req.method === 'GET' && req.url === '/api/status') {
    return send(200, { ...current, busy });
  }
  if (req.method === 'GET' && req.url === '/api/history') {
    return send(200, loadJson(HISTORY_FILE, []));
  }
  if (req.method === 'POST' && req.url === '/api/history/clear') {
    saveJson(HISTORY_FILE, []);
    return send(200, { ok: true });
  }
  if (req.method === 'POST' && req.url === '/api/history/delete') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      try {
        const { index } = JSON.parse(body || '{}');
        const list = loadJson(HISTORY_FILE, []);
        if (Number.isInteger(index) && index >= 0 && index < list.length) {
          list.splice(index, 1);
          saveJson(HISTORY_FILE, list);
        }
        send(200, { ok: true });
      } catch { send(200, { ok: true }); }
    });
    return;
  }
  if (req.method === 'POST' && req.url === '/api/start') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', async () => {
      try {
        const { port, verify } = JSON.parse(body || '{}');
        const p = Number(port);
        if (!Number.isInteger(p) || p < 1 || p > 65535) return send(400, { error: '端口无效：请输入 1-65535 的数字' });
        if (BLOCKED_PORTS.has(p)) return send(400, { error: `端口 ${p} 属于系统/远程管理/数据库端口，为安全起见禁止公开。本工具用于分享网页项目，请填开发服务器端口（如 3000、5173）` });
        const url = await fullStart(p, verify !== false); // verify:false 为快速模式，其余（含缺省）都验证后返回
        send(200, { ok: true, url, localPort: p });
      } catch (e) {
        send(500, { error: e.message || '启动失败' });
      }
    });
    return;
  }
  if (req.method === 'POST' && req.url === '/api/stop') {
    stopTunnel();
    return send(200, { ok: true });
  }
  send(404, { error: 'not found' });
});

server.listen(LISTEN_PORT, '127.0.0.1', () => {
  console.log(`隧道分享工具已就绪： http://127.0.0.1:${LISTEN_PORT}`);
  if (process.argv.includes('--open')) {
    // win 的 start 是 cmd 内建命令，需经 cmd /c 调用
    const openCmd = os.platform() === 'darwin' ? 'open' : os.platform() === 'win32' ? 'cmd' : 'xdg-open';
    const openArgs = os.platform() === 'win32' ? ['/c', 'start', '', `http://127.0.0.1:${LISTEN_PORT}`] : [`http://127.0.0.1:${LISTEN_PORT}`];
    setTimeout(() => spawn(openCmd, openArgs, { detached: true, stdio: 'ignore' }).unref(), 800);
  }
});

/* 退出时带走隧道子进程（自动启动的本地服务保留运行，不打扰你的项目） */
process.on('SIGINT', () => { stopTunnel(); process.exit(0); });
process.on('SIGTERM', () => { stopTunnel(); process.exit(0); });
/* 兜底：未捕获异常也要先清掉全部隧道再退出，避免 cloudflared 成孤儿进程、公网暴露无人管理 */
process.on('uncaughtException', e => { console.error('[未捕获异常]', e); stopTunnel(); process.exit(1); });
process.on('unhandledRejection', e => { console.error('[未处理的 Promise 拒绝]', e); });

/* ================= 内联页面（Google 彩虹风 · 纯 CSS/SVG 手绘 · 无 emoji） ================= */
const PAGE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>隧道分享工具</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    min-height: 100vh; display: flex; align-items: center; justify-content: center;
    font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Helvetica Neue", sans-serif;
    background: #F6F8FC; color: #202124; -webkit-font-smoothing: antialiased; padding: 24px;
  }
  .wrap { display: flex; gap: 20px; align-items: stretch; justify-content: center; width: 100%; max-width: 980px; }

  .card {
    width: min(600px, 100%); flex-shrink: 0; background: #FFFFFF; border-radius: 36px;
    padding: 44px 44px 36px; box-shadow: 0 14px 44px rgba(32,33,36,0.10);
    position: relative; overflow: hidden;
  }

  /* 右侧：历史记录小圆角平面（3D 倾斜视角） */
  .history {
    flex: 1; min-width: 250px; max-width: 320px; background: #FFFFFF; border-radius: 32px;
    padding: 24px 20px 20px; box-shadow: 0 14px 44px rgba(32,33,36,0.10);
    display: flex; flex-direction: column;
    transform: perspective(800px) rotateY(-3deg) rotateX(1deg);
    transition: transform .3s ease;
  }
  .history:hover { transform: perspective(800px) rotateY(0deg) rotateX(0deg); }
  .h-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; flex-shrink: 0; }
  .h-title { display: flex; align-items: center; gap: 8px; font-size: 14.5px; font-weight: 800; }
  .h-clear {
    border: none; cursor: pointer; background: #F1F3F4; color: #5F6368;
    border-radius: 999px; padding: 6px 13px; font-size: 11.5px; font-weight: 700; transition: background .2s ease;
  }
  .h-clear:hover { background: #E8EAED; color: #D93025; }
  .h-list { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 10px; padding-right: 2px; }
  .h-list::-webkit-scrollbar { width: 6px; }
  .h-list::-webkit-scrollbar-thumb { background: #E8EAED; border-radius: 999px; }
  .h-item { background: #F8F9FA; border-radius: 16px; padding: 11px 13px; transition: background .2s ease; position: relative; }
  .h-item:hover { background: #F1F3F4; }
  .h-item-inner { margin-right: 24px; }
  .h-del { position:absolute; top:8px; right:8px; width:22px; height:22px; border:none; cursor:pointer;
    background:transparent; color:#9AA0A6; border-radius:50%; display:flex; align-items:center; justify-content:center;
    transition: background .2s ease, color .2s ease; padding:0; }
  .h-del:hover { background:#FCE8E6; color:#D93025; }
  .h-time { font-size: 10.5px; color: #9AA0A6; font-weight: 700; margin-bottom: 4px; letter-spacing: .3px; }
  .h-url { font-size: 12px; color: #1A73E8; font-weight: 700; word-break: break-all; cursor: pointer; line-height: 1.55; }
  .h-url:hover { text-decoration: underline; }
  .h-empty { font-size: 12px; color: #9AA0A6; text-align: center; padding: 30px 8px; line-height: 1.9; font-weight: 500; }

  /* 顶部：手绘云朵 */
  .head { display: flex; align-items: center; gap: 16px; margin-bottom: 8px; }
  .head h1 { font-size: 23px; font-weight: 800; letter-spacing: 0.5px; }
  .head p { font-size: 12.5px; color: #80868B; margin-top: 4px; font-weight: 500; }
  .rainbow { display: flex; gap: 5px; margin: 18px 0 26px; }
  .rainbow i { width: 26px; height: 6px; border-radius: 999px; }
  .rainbow i:nth-child(1){ background:#EA4335; } .rainbow i:nth-child(2){ background:#FBBC04; }
  .rainbow i:nth-child(3){ background:#34A853; } .rainbow i:nth-child(4){ background:#1A73E8; }

  /* 第一行：本地地址 */
  .row-input { display: flex; gap: 12px; }
  .field {
    flex: 1; display: flex; align-items: center; background: #F1F3F4;
    border-radius: 999px; padding: 0 22px;
    transition: box-shadow .25s ease, background .25s ease;
  }
  .field:focus-within { background:#FFF; box-shadow: inset 0 0 0 2px #1A73E8; }
  .field input {
    flex: 1; border: none; outline: none; background: transparent;
    font-size: 15px; font-weight: 700; color: #202124; padding: 15px 0; min-width: 0;
  }
  .field input::placeholder { color:#9AA0A6; font-weight:500; }
  .field .prefix { color:#5F6368; font-weight:800; font-size:15px; user-select:none; }
  .btn-main {
    border:none; cursor:pointer; border-radius:999px; padding:0 26px;
    font-size:14px; font-weight:800; color:#FFF; background:#1A73E8;
    transition: background .2s ease, transform .15s ease; white-space:nowrap;
  }
  .btn-main:hover{ background:#1765CC; } .btn-main:active{ transform:scale(.96); }
  .btn-main:disabled{ background:#A8C7FA; cursor:default; }

  /* 第二行：公网地址 */
  .result {
    margin-top: 24px; border-radius: 26px; padding: 22px 24px; background:#F8FBFF;
    box-shadow: inset 0 0 0 2px #D3E3FD; display:flex; align-items:center; gap:14px; min-height:92px;
    transition: background .3s ease, box-shadow .3s ease; position: relative;
  }
  .result.ok { background:#EDFAF1; box-shadow: inset 0 0 0 2px #B7E1C4; }
  .result.error { background:#FDF3F4; box-shadow: inset 0 0 0 2px #F6C9CB; }
  .dot { width:11px; height:11px; border-radius:50%; background:#9AA0A6; flex-shrink:0; transition: background .3s ease; }
  .dot.on{ background:#34A853; } .dot.loading{ background:#1A73E8; animation:pulse 1s ease-in-out infinite; }
  @keyframes pulse { 50%{ opacity:.3; } }
  .addr { flex:1; min-width:0; }
  .addr .label { font-size:12.5px; font-weight:800; color:#80868B; letter-spacing:.6px; margin-bottom:5px; }
  .addr .link { font-size:15px; font-weight:700; color:#1A73E8; word-break:break-all; line-height:1.5; cursor:pointer; }
  .addr .link:hover { text-decoration:underline; }
  .addr .hint { font-size:14px; font-weight:500; color:#9AA0A6; line-height:1.6; }

  .acts { display:flex; gap:8px; flex-shrink:0; }
  .btn-pill {
    display:flex; align-items:center; gap:6px; border:none; cursor:pointer;
    border-radius:999px; padding:10px 16px; font-size:13px; font-weight:800;
    transition: background .2s ease, transform .15s ease;
  }
  .btn-pill:active{ transform:scale(.94); }
  .btn-pill svg{ flex-shrink:0; }
  .btn-copy{ color:#1A73E8; background:#E8F0FE; } .btn-copy:hover{ background:#D2E3FC; }
  .btn-copy.done{ color:#137333; background:#E6F4EA; }
  .btn-open{ color:#5F6368; background:#F1F3F4; } .btn-open:hover{ background:#E8EAED; }

  /* "i" 信息按钮 + 气泡提示 */
  .btn-info {
    width: 34px; height: 34px; padding: 0; justify-content: center;
    color:#5F6368; background:#F1F3F4; border-radius: 50%;
  }
  .btn-info:hover{ background:#E8EAED; color:#1A73E8; }
  .info-pop {
    position: absolute; top: 50%; right: 118px; transform: translateY(-50%);
    width: 250px; background: #202124; color: #F1F3F4;
    border-radius: 16px; padding: 14px 16px; font-size: 12.5px; line-height: 1.7;
    font-weight: 500; z-index: 20; display: none;
    box-shadow: 0 10px 28px rgba(32,33,36,0.3);
  }
  .info-pop::after {
    content: ''; position: absolute; right: -6px; top: 50%; transform: translateY(-50%) rotate(45deg);
    width: 12px; height: 12px; background: #202124; border-radius: 2px;
  }
  .info-pop b { color: #8AB4F8; }

  .tips { margin-top:22px; font-size:12px; color:#9AA0A6; line-height:1.9; text-align:center; }

  /* 顶部「怎么用」按钮（窄屏自动换行到标题下方右侧） */
  .head { flex-wrap:wrap; }
  .btn-guide {
    margin-left:auto; display:flex; align-items:center; gap:7px; border:none; cursor:pointer;
    background:#F1F3F4; color:#3C4043; border-radius:999px; padding:9px 16px;
    font-size:12.5px; font-weight:800; flex-shrink:0; align-self:flex-start;
    transition: background .2s ease, color .2s ease, transform .15s ease;
  }
  .btn-guide:hover { background:#E8EAED; color:#1A73E8; }
  .btn-guide:active { transform:scale(.94); }

  /* 两张半透明圆角入口卡（点击弹出详情，图标圆保留通用） */
  .duo { margin-top:26px; display:grid; grid-template-columns:1fr 1fr; gap:12px; }
  .duo-card { display:flex; align-items:center; gap:12px; border:none; cursor:pointer; text-align:left;
    background:rgba(248,250,252,.78); box-shadow: inset 0 0 0 1.5px #E8EAED; border-radius:20px; padding:14px 15px;
    transition: box-shadow .2s ease, background .2s ease, transform .15s ease; }
  .duo-card:hover { background:rgba(232,240,254,.55); box-shadow: inset 0 0 0 1.5px #D2E3FC; }
  .duo-card:active { transform:scale(.98); }
  .duo-card .adv-ic { width:36px; height:36px; }
  .duo-tx { flex:1; min-width:0; }
  .duo-tx b { display:block; font-size:13px; font-weight:800; color:#202124; }
  .duo-tx i { display:block; font-style:normal; font-size:11.5px; color:#80868B; font-weight:600; margin-top:2px; }
  .duo-card .chev { color:#9AA0A6; flex-shrink:0; }
  .adv-ic { width:38px; height:38px; border-radius:50%; flex-shrink:0; display:flex; align-items:center; justify-content:center; }
  .adv-ic.b { background:#E8F0FE; color:#1A73E8; }
  .adv-ic.y { background:#FEF7E0; color:#EA8600; }
  .adv-ic.g { background:#E6F4EA; color:#137333; }
  .adv-ic.r { background:#FCE8E6; color:#D93025; }

  /* 「怎么用」引导浮层 */
  .guide-mask { position:fixed; inset:0; z-index:100; display:none; align-items:center; justify-content:center;
    background:rgba(32,33,36,.45); backdrop-filter:blur(6px); -webkit-backdrop-filter:blur(6px); padding:22px; }
  .guide-mask.show { display:flex; }
  .guide { position:relative; width:min(480px,100%); max-height:min(86vh,720px); overflow-y:auto;
    background:#FFF; border-radius:28px; padding:24px 22px 20px; box-shadow:0 24px 64px rgba(32,33,36,.28);
    scrollbar-width:none; -ms-overflow-style:none; }
  .guide::-webkit-scrollbar { display:none; }
  .g-close { position:absolute; top:14px; right:14px; width:30px; height:30px; border:none; cursor:pointer;
    background:#F1F3F4; color:#5F6368; border-radius:50%; display:flex; align-items:center; justify-content:center;
    transition:background .2s ease, color .2s ease; }
  .g-close:hover { background:#E8EAED; color:#202124; }
  .g-head h2 { font-size:18px; font-weight:800; padding-right:34px; }
  .g-head p { font-size:12px; color:#80868B; font-weight:500; margin-top:4px; }
  .g-steps { margin-top:16px; display:flex; flex-direction:column; gap:11px; }
  .g-step { display:flex; gap:11px; align-items:flex-start; }
  .g-num { width:24px; height:24px; border-radius:50%; flex-shrink:0; display:flex; align-items:center; justify-content:center;
    font-size:12.5px; font-weight:800; font-style:normal; margin-top:1px; }
  .g-num.b { background:#E8F0FE; color:#1A73E8; }
  .g-num.y { background:#FEF7E0; color:#EA8600; }
  .g-num.g { background:#E6F4EA; color:#137333; }
  .g-num.r { background:#FCE8E6; color:#D93025; }
  .g-step b { display:block; font-size:13px; font-weight:800; color:#202124; }
  .g-step span.d { display:block; font-size:12px; color:#5F6368; line-height:1.6; font-weight:500; margin-top:2px; }
  .g-sub { margin:18px 0 10px; display:flex; align-items:center; gap:10px; font-size:12.5px; font-weight:800; color:#3C4043; flex-shrink:0; }
  .g-line { flex:1; height:2px; border-radius:999px; background:#F1F3F4; }
  .g-conds { display:flex; flex-direction:column; gap:9px; }
  .g-cond { display:flex; gap:11px; align-items:flex-start; background:#F8F9FA; border-radius:16px; padding:11px 13px; }
  .g-cond .adv-ic { width:30px; height:30px; }
  .g-cond b { display:block; font-size:12.5px; font-weight:800; color:#202124; }
  .g-cond span.d { display:block; font-size:12px; color:#5F6368; line-height:1.55; font-weight:500; margin-top:2px; }
  .g-note { margin-top:12px; background:#F8F9FA; border-radius:12px; padding:10px 12px;
    font-size:12px; color:#5F6368; line-height:1.65; font-weight:500; }

  /* 获取方式选择弹窗（无动画，直接出现） */
  .mode-mask { position:fixed; inset:0; z-index:110; display:none; align-items:center; justify-content:center;
    background:rgba(32,33,36,.45); backdrop-filter:blur(6px); -webkit-backdrop-filter:blur(6px); padding:22px; }
  .mode-mask.show { display:flex; }
  .mode { position:relative; width:min(400px,100%); background:#FFF; border-radius:24px; padding:22px 20px 14px; box-shadow:0 24px 64px rgba(32,33,36,.28); }
  .mode-wide { width:min(500px,100%); max-height:min(86vh,720px); overflow-y:auto; scrollbar-width:none; -ms-overflow-style:none; }
  .mode-wide::-webkit-scrollbar { display:none; }
  .m-title { font-size:16.5px; font-weight:800; padding-right:36px; }
  .m-sub { font-size:12px; color:#80868B; font-weight:500; margin:4px 0 14px; }
  .m-opt { width:100%; display:flex; gap:12px; align-items:flex-start; text-align:left; border:none; cursor:pointer;
    background:#F8F9FA; border-radius:16px; padding:13px 14px; margin-bottom:9px; transition:background .2s ease; }
  .m-opt:hover { background:#F1F3F4; }
  .m-opt:active { transform:scale(.985); }
  .m-tx b { display:block; font-size:13px; font-weight:800; color:#202124; }
  .m-tx i { display:block; font-style:normal; font-size:12px; color:#5F6368; line-height:1.55; font-weight:500; margin-top:2px; }
  .m-tag { display:inline-block; font-size:10px; font-weight:800; padding:1px 7px; border-radius:999px; margin-left:6px; vertical-align:middle; }
  .m-tag.rec { background:#E6F4EA; color:#137333; }
  .m-caution { display:block; font-size:11.5px; color:#D93025; font-weight:700; margin-top:2px; }
  .m-cancel { display:block; margin:2px auto 0; border:none; background:none; cursor:pointer;
    font-size:12.5px; font-weight:700; color:#80868B; padding:8px 14px; border-radius:999px; transition:color .2s ease; }
  .m-cancel:hover { color:#202124; }

  @media (max-width: 920px) {
    body { align-items: flex-start; }
    .wrap { flex-direction: column; align-items: center; }
    .history { width: 100%; max-width: 600px; max-height: 340px; }
  }
  @media (max-width: 600px) {
    .duo { grid-template-columns: 1fr; }
    .card { padding: 32px 24px 28px; }
    .guide { padding: 20px 16px 16px; }
  }
</style>
</head>
<body>
  <div class="wrap">
    <main class="card">
      <div class="head">
        <svg width="54" height="54" viewBox="0 0 52 52" fill="none">
          <path d="M14 34 C7 34 4 29 6 25 C8 21 13 20 15 22 C15 15 21 10 27 12 C32 13 35 17 35 21 C41 20 45 24 44 29 C43 33 39 34 36 34 Z"
                fill="#E8F0FE" stroke="#1A73E8" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M18 40 L16 46 M26 40 L25 47 M34 40 L36 46" stroke="#34A853" stroke-width="2.4" stroke-linecap="round"/>
        </svg>
        <div>
          <h1>隧道分享工具</h1>
          <p>输入本地地址，一键获得公网访问链接</p>
        </div>
        <button class="btn-guide" id="btnGuide" type="button" title="查看使用方法">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="9.4"/><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/>
          </svg>怎么用
        </button>
      </div>
      <div class="rainbow"><i></i><i></i><i></i><i></i></div>

      <div class="row-input">
        <label class="field">
          <span class="prefix">localhost:</span>
          <input id="portNum" placeholder="填端口号，如 3000" inputmode="numeric" maxlength="5" autocomplete="off" />
        </label>
        <button class="btn-main" id="btnStart" disabled>获取公网地址</button>
      </div>

      <div class="result" id="result">
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
          <button class="btn-pill btn-info" id="btnInfo" type="button" title="小提示">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="9.4"/><path d="M12 11 V17"/><circle cx="12" cy="7.4" r="0.4" fill="currentColor"/>
            </svg>
          </button>
          <div class="info-pop" id="infoPop">
            <b>首次打开白屏？</b><br/>
            本地项目文件较大时，第一次打开可能白屏——这是正常现象，<b>刷新再试一次</b>即可（第二次会快很多）。
          </div>
          <button class="btn-pill btn-copy" id="btnCopy" style="display:none">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
              <rect x="9" y="9" width="12" height="12" rx="3"/>
              <path d="M5 15 H4.5 A2.5 2.5 0 0 1 2 12.5 V4.5 A2.5 2.5 0 0 1 4.5 2 H12.5 A2.5 2.5 0 0 1 15 4.5 V5"/>
            </svg><span id="copyLabel">复制</span>
          </button>
        </div>
      </div>

      <div class="tips">
        地址生成后复制发给对方即可，浏览器直接打开<br/>
        每次点击生成一个新地址，旧地址在工具运行期间继续有效；关闭工具后全部失效
      </div>

      <div class="duo">
        <button class="duo-card" id="btnAdv" type="button">
          <span class="adv-ic b">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round">
              <path d="M12 3 L13.8 10.2 L21 12 L13.8 13.8 L12 21 L10.2 13.8 L3 12 L10.2 10.2 Z"/>
            </svg>
          </span>
          <span class="duo-tx"><b>它能解决什么问题</b><i>四大核心优势</i></span>
          <svg class="chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5 L16 12 L9 19"/></svg>
        </button>
        <button class="duo-card" id="btnHow" type="button">
          <span class="adv-ic y">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="5" cy="12" r="2.6"/><circle cx="12" cy="12" r="2.6"/><circle cx="19" cy="12" r="2.6"/><path d="M7.6 12 H9.4 M14.6 12 H16.4"/>
            </svg>
          </span>
          <span class="duo-tx"><b>服务自动启动 · 工作原理</b><i>四步工作流</i></span>
          <svg class="chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5 L16 12 L9 19"/></svg>
        </button>
      </div>
    </main>

    <!-- 右侧：历史记录 -->
    <aside class="history">
      <div class="h-head">
        <div class="h-title">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#5F6368" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="9"/><path d="M12 7 V12 L15.5 14"/>
          </svg>历史记录
        </div>
        <button class="h-clear" id="histClear" title="清空全部历史记录">清空</button>
      </div>
      <div class="h-list" id="histList"></div>
    </aside>
  </div>

  <!-- 「怎么用」引导浮层 -->
  <div class="guide-mask" id="guideMask">
    <div class="guide">
      <button class="g-close" id="guideClose" type="button" title="关闭">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round">
          <path d="M5 5 L19 19 M19 5 L5 19"/>
        </svg>
      </button>
      <div class="g-head">
        <h2>怎么用</h2>
        <p>四步完成部署与分享；跨设备使用请参照下方说明</p>
      </div>
      <div class="g-steps">
        <div class="g-step">
          <i class="g-num b">1</i>
          <div><b>下载项目文件夹</b><span class="d">从 GitHub 仓库下载完整文件夹：点击仓库页绿色「Code」按钮，选择「Download ZIP」并解压（或使用 git clone 获取）</span></div>
        </div>
        <div class="g-step">
          <i class="g-num y">2</i>
          <div><b>启动工具</b><span class="d">进入解压后的文件夹，双击启动脚本：macOS 运行「启动.command」，Windows 运行「启动.bat」；浏览器自动打开工具页面，未打开则访问 http://127.0.0.1:9800</span></div>
        </div>
        <div class="g-step">
          <i class="g-num g">3</i>
          <div><b>生成地址</b><span class="d">在 localhost: 后输入本地服务端口号（如 3000），点击「获取公网地址」；本地服务未启动时，工具按「启动配置.json」自动启动</span></div>
        </div>
        <div class="g-step">
          <i class="g-num r">4</i>
          <div><b>分享地址</b><span class="d">复制生成的公网地址发送给访问者；对方通过浏览器直接打开即可，无需安装任何客户端</span></div>
        </div>
      </div>
      <div class="g-sub">跨设备使用说明<div class="g-line"></div></div>
      <div class="g-conds">
        <div class="g-cond">
          <span class="adv-ic b">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3.5 7 A2 2 0 0 1 5.5 5 H9 L11 7.5 H18.5 A2 2 0 0 1 20.5 9.5 V17 A2 2 0 0 1 18.5 19 H5.5 A2 2 0 0 1 3.5 17 Z"/>
            </svg>
          </span>
          <div><b>完整分发</b><span class="d">分发时保留完整文件夹结构：「组件」目录内含 macOS 与 Windows 双平台隧道引擎，接收方无需另行下载；Node.js 缺失时自动部署便携版，不改动系统环境</span></div>
        </div>
        <div class="g-cond">
          <span class="adv-ic y">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M15.5 4.5 L19.5 8.5 L8 20 H4 V16 Z"/><path d="M13 7 L17 11"/>
            </svg>
          </span>
          <div><b>路径配置</b><span class="d">「启动配置.json」中的项目路径因设备而异，跨设备使用时改为目标设备上的实际路径；服务已在运行时无需配置，直接填端口即可</span></div>
        </div>
        <div class="g-cond">
          <span class="adv-ic g">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="4.5" width="18" height="12.5" rx="2"/><path d="M9 20.5 H15 M12 17 V20.5"/>
            </svg>
          </span>
          <div><b>运行位置</b><span class="d">工具须与被分享的服务运行在同一台电脑上（隧道指向工具所在电脑的端口）</span></div>
        </div>
        <div class="g-cond">
          <span class="adv-ic r">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M4 7 H20"/><path d="M9 7 V4.8 A1.3 1.3 0 0 1 10.3 3.5 H13.7 A1.3 1.3 0 0 1 15 4.8 V7"/><path d="M6.5 7 L7.3 19 A2 2 0 0 0 9.3 21 H14.7 A2 2 0 0 0 16.7 19 L17.5 7"/>
            </svg>
          </span>
          <div><b>清除个人数据</b><span class="d">分发前建议删除「历史记录.json」等个人使用记录，不影响任何功能</span></div>
        </div>
      </div>
      <div class="g-note">首次运行的安全提示（仅出现一次）：macOS 提示"无法验证开发者"时，右键点击文件并选择"打开"；Windows 提示"已保护你的电脑"时，点击"更多信息"→"仍要运行"。</div>
    </div>
  </div>

  <!-- 获取方式选择弹窗 -->
  <div class="mode-mask" id="modeMask">
    <div class="mode">
      <div class="m-title">选择获取方式</div>
      <div class="m-sub">两种方式都会生成全新的公网地址，旧地址继续有效</div>
      <button class="m-opt" id="optFast" type="button">
        <span class="adv-ic y">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polygon points="13 2 3.5 13.5 11 13.5 11 22 20.5 10.5 13 10.5 13 2"/>
          </svg>
        </span>
        <span class="m-tx"><b>快速获取</b><i>地址立即返回，但 DNS 全球生效需等待数十秒</i><span class="m-caution">后果：返回后可能需重试 2-3 次才能稳定打开</span></span>
      </button>
      <button class="m-opt" id="optVerify" type="button">
        <span class="adv-ic b">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 2.8 L19 5.6 V11 C19 16.2 16.2 19.6 12 21.2 C7.8 19.6 5 16.2 5 11 V5.6 Z"/><path d="M9 11.6 L11.2 13.8 L15.3 9.4"/>
          </svg>
        </span>
        <span class="m-tx"><b>验证后获取<span class="m-tag rec">推荐</span></b><i>工具确认地址可访问后返回，只需等待 10 秒至 2 分钟；遇无效地址自动更换</i></span>
      </button>
      <button class="m-cancel" id="modeCancel" type="button">取消</button>
    </div>
  </div>

  <!-- 它能解决什么问题 · 弹窗 -->
  <div class="mode-mask" id="advMask">
    <div class="mode mode-wide">
      <button class="g-close" id="advClose" type="button" title="关闭">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round">
          <path d="M5 5 L19 19 M19 5 L5 19"/>
        </svg>
      </button>
      <div class="m-title">它能解决什么问题</div>
      <div class="m-sub">四大核心优势</div>
      <div class="g-conds">
        <div class="g-cond">
          <span class="adv-ic b">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="9.2"/><path d="M2.8 12 H21.2"/><path d="M12 2.8 C15.2 5.8 15.2 18.2 12 21.2 C8.8 18.2 8.8 5.8 12 2.8 Z"/>
            </svg>
          </span>
          <div><b>无需公网 IP</b><span class="d">不用路由器配置、不用找运维，家里或公司的普通网络都能把本地网站公开到外网</span></div>
        </div>
        <div class="g-cond">
          <span class="adv-ic y">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polygon points="13 2 3.5 13.5 11 13.5 11 22 20.5 10.5 13 10.5 13 2"/>
            </svg>
          </span>
          <div><b>全自动代劳</b><span class="d">本地服务没起会自动启动（详见下方工作原理），缺依赖自动安装、缺组件自动下载，点一下全办好</span></div>
        </div>
        <div class="g-cond">
          <span class="adv-ic g">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 2.8 L19 5.6 V11 C19 16.2 16.2 19.6 12 21.2 C7.8 19.6 5 16.2 5 11 V5.6 Z"/><path d="M9 11.6 L11.2 13.8 L15.3 9.4"/>
            </svg>
          </span>
          <div><b>免费安全通道</b><span class="d">走 Cloudflare 官方免费通道，生成 https 地址，对方用手机浏览器也能直接打开</span></div>
        </div>
        <div class="g-cond">
          <span class="adv-ic r">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M7 3.5 H17 V20.5 L12 16.5 L7 20.5 Z"/>
            </svg>
          </span>
          <div><b>地址留档可查</b><span class="d">每次获取的公网地址都自动留档，新旧地址随时对比、一键复制</span></div>
        </div>
      </div>
    </div>
  </div>

  <!-- 服务自动启动 · 工作原理 弹窗 -->
  <div class="mode-mask" id="howMask">
    <div class="mode mode-wide">
      <button class="g-close" id="howClose" type="button" title="关闭">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round">
          <path d="M5 5 L19 19 M19 5 L5 19"/>
        </svg>
      </button>
      <div class="m-title">服务自动启动 · 工作原理</div>
      <div class="m-sub">端口无服务时的四步工作流</div>
      <div class="g-steps">
        <div class="g-step">
          <i class="g-num b">1</i>
          <div><b>端口探测</b><span class="d">获取地址前，先探测本地端口是否已有服务在运行</span></div>
        </div>
        <div class="g-step">
          <i class="g-num y">2</i>
          <div><b>读取映射</b><span class="d">依据「启动配置.json」中端口与项目的对应关系，定位目标项目</span></div>
        </div>
        <div class="g-step">
          <i class="g-num g">3</i>
          <div><b>启动项目</b><span class="d">预检通过后在项目目录执行启动命令；依赖缺失时自动先行安装</span></div>
        </div>
        <div class="g-step">
          <i class="g-num r">4</i>
          <div><b>就绪接驳</b><span class="d">轮询确认端口就绪后，无缝接入公网隧道</span></div>
        </div>
      </div>
      <div class="g-note">未配置映射的端口不会自动启动，将以明确提示代替；如需为端口添加方案，编辑「启动配置.json」即可。</div>
    </div>
  </div>

<script>
  var $ = function(id){ return document.getElementById(id); };
  var input=$('portNum'), btn=$('btnStart'), result=$('result'), dot=$('dot'), mainText=$('mainText'),
      btnOpen=$('btnOpen'), btnCopy=$('btnCopy'), copyLabel=$('copyLabel'), addrLabel=$('addrLabel');
  var currentUrl=null, pollTimer=null, stateUrl=null;
  var infoPop=$('infoPop');

  // 「怎么用」引导浮层：按钮打开；点关闭、点遮罩、按 Esc 都能关
  var guideMask=$('guideMask');
  function closeGuide(){ guideMask.classList.remove('show'); }
  $('btnGuide').addEventListener('click', function(){ guideMask.classList.add('show'); });
  $('guideClose').addEventListener('click', closeGuide);
  guideMask.addEventListener('click', function(e){ if(e.target===guideMask) closeGuide(); });
  document.addEventListener('keydown', function(e){
    if(e.key!=='Escape') return;
    closeGuide();
    var pops=document.querySelectorAll('.mode-mask.show');
    for(var i=0;i<pops.length;i++) pops[i].classList.remove('show');
  });

  // "i" 小提示：点击开关气泡，点页面其他位置关闭
  $('btnInfo').addEventListener('click', function(e){
    e.stopPropagation();
    infoPop.style.display = infoPop.style.display==='block' ? 'none' : 'block';
  });
  document.addEventListener('click', function(e){
    if(!infoPop.contains(e.target)) infoPop.style.display='none';
  });

  function setState(state, text, url){
    dot.className='dot'+(state==='on'?' on':state==='loading'?' loading':'');
    // 没有公网地址时不再显示那行小字标签，有地址时才出现
    addrLabel.style.display = state==='on' ? '' : 'none';
    mainText.className = state==='on' ? 'link' : 'hint';
    mainText.style.color = state==='error' ? '#D93025' : '';
    mainText.textContent=text;
    result.className='result'+(state==='on'?' ok':state==='error'?' error':'');
    currentUrl=url||null;
    btnOpen.style.display = url?'flex':'none';
    btnCopy.style.display = url?'flex':'none';
    copyLabel.textContent='复制'; btnCopy.classList.remove('done');
    mainText.onclick = url ? function(){ window.open(url,'_blank'); } : null;
  }

  // 只允许数字：粘贴/输入一律过滤
  input.addEventListener('input', function(){
    var v = input.value.replace(/\\D/g,'').slice(0,5);
    if(v !== input.value) input.value = v;
    btn.disabled = v.length === 0;
  });

  function copyText(t){
    if(navigator.clipboard&&navigator.clipboard.writeText){ navigator.clipboard.writeText(t).catch(function(){}); }
    else{
      var ta=document.createElement('textarea'); ta.value=t; document.body.appendChild(ta);
      ta.select(); try{document.execCommand('copy');}catch(e){} ta.remove();
    }
  }

  // 获取方式选择弹窗：点击「获取公网地址」先选方式（快速 / 验证后），取消可关闭
  var modeMask=$('modeMask');
  function closeMode(){ modeMask.classList.remove('show'); }
  function askStart(){
    var p = input.value.replace(/\\D/g,'');
    if(!p){ setState('error','先在 localhost: 后面填上端口号，比如 3000'); return; }
    modeMask.classList.add('show');
  }
  $('optFast').addEventListener('click', function(){ closeMode(); start(false); });
  $('optVerify').addEventListener('click', function(){ closeMode(); start(true); });
  $('modeCancel').addEventListener('click', closeMode);
  modeMask.addEventListener('click', function(e){ if(e.target===modeMask) closeMode(); });

  // 两张入口卡 → 详情弹窗（优势 / 工作原理）：按钮开，点关闭、点遮罩关
  function bindPop(maskId, btnId, closeId){
    var m=$(maskId);
    $(btnId).addEventListener('click', function(){ m.classList.add('show'); });
    $(closeId).addEventListener('click', function(){ m.classList.remove('show'); });
    m.addEventListener('click', function(e){ if(e.target===m) m.classList.remove('show'); });
  }
  bindPop('advMask','btnAdv','advClose');
  bindPop('howMask','btnHow','howClose');

  function start(verify){
    var p = input.value.replace(/\\D/g,'');
    if(!p){ setState('error','先在 localhost: 后面填上端口号，比如 3000'); return; }
    btn.disabled=true;
    setState('loading', verify ? '正在从头打通…本地没起的服务会自动启动' : '快速模式正在打通…地址返回后需几十秒全球生效');
    fetch('/api/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({port:Number(p),verify:!!verify})})
      .then(function(r){ return r.json().then(function(d){ if(!r.ok) throw new Error(d.error||'启动失败'); return d; }); })
      .then(function(d){
        setState('on', d.url, d.url);
        stateUrl = d.url;
        loadHistory();
      })
      .catch(function(e){ setState('error', e.message||'出错了，请重试'); })
      .finally(function(){ btn.disabled = input.value.length === 0; });
  }

  // 轮询：处理中的进度文案 / 断线检测，实时反映到界面（不主动点击就永远不会有地址）
  function poll(){
    fetch('/api/status').then(function(r){return r.json();}).then(function(s){
      if(s.busy){
        setState('loading', s.progress || '正在处理…');
        stateUrl=null;
        return;
      }
      if(s.running && s.url){
        if(s.url!==stateUrl){ stateUrl=s.url; setState('on', s.url, s.url); }
        return;
      }
      if(stateUrl || currentUrl){
        setState('idle','隧道已断开（关机或程序重启会这样），点上方按钮重新获取');
        stateUrl=null;
      }
    }).catch(function(){});
  }
  function startPoll(){
    if(pollTimer) clearInterval(pollTimer);
    pollTimer=setInterval(poll,3000);
  }

  // 历史记录
  function esc(s){ return String(s).replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
  function loadHistory(){
    fetch('/api/history').then(function(r){return r.json();}).then(renderHistory).catch(function(){});
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
             '<button class="h-del" data-idx="'+i+'" title="删除该条记录">'+
             '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M5 5 L19 19 M19 5 L5 19"/></svg></button></div>';
    }).join('');
  }
  $('histList').addEventListener('click', function(e){
    // 点击删除按钮
    var delBtn=e.target.closest ? e.target.closest('.h-del') : null;
    if(delBtn){
      var idx=delBtn.getAttribute('data-idx');
      if(idx!==null){
        fetch('/api/history/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({index:Number(idx)})})
          .then(loadHistory).catch(function(){});
      }
      return;
    }
    // 点击地址复制
    var el=e.target.closest ? e.target.closest('.h-url') : null;
    if(!el) return;
    copyText(el.getAttribute('data-url'));
    var old=el.getAttribute('data-url');
    el.textContent='已复制';
    setTimeout(function(){ el.textContent=old; },1200);
  });
  $('histClear').addEventListener('click', function(){
    fetch('/api/history/clear',{method:'POST',headers:{'Content-Type':'application/json'}}).then(loadHistory).catch(function(){});
  });

  btn.addEventListener('click', askStart);
  input.addEventListener('keydown',function(e){ if(e.key==='Enter') askStart(); });
  btnOpen.addEventListener('click',function(){ if(currentUrl) window.open(currentUrl,'_blank'); });
  btnCopy.addEventListener('click',function(){
    if(!currentUrl) return;
    copyText(currentUrl);
    copyLabel.textContent='已复制'; btnCopy.classList.add('done');
    setTimeout(function(){ copyLabel.textContent='复制'; btnCopy.classList.remove('done'); },1800);
  });

  // 页面一打开：先给出清晰的待办提示（此时还没有任何公网地址），再开始轮询 + 拉取历史
  setState('idle','填好端口号、点「获取公网地址」，这里会出现能发给任何人的公网链接');
  startPoll();
  loadHistory();
</script>
</body>
</html>`;

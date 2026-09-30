// 日志收集器 —— 注入页面主世界，收集最后 2000 行 console 日志
//
// 功能：
//   1. 包装 console.log/info/warn/error/debug，把所有日志写入环形缓冲；
//   2. 每 800ms 或 20 条落盘一次到 localStorage（跨页面刷新保留，
//      刷新前的最后日志也能查，方便排查「每隔10分钟刷新」类问题）；
//   3. 提供 window.__reelaxLog 接口：
//        getText()  -> 返回日志文本
//        download() -> 下载成 .log 文件
//        clear()    -> 清空日志
//        size()     -> 当前条数
//
// 需在其它脚本之前注入（见 injector.js CORE_SCRIPTS 第一项）。

(() => {
  'use strict';
  if (window.__REELAX_LOG_COLLECTOR__) return;
  window.__REELAX_LOG_COLLECTOR__ = true;

  const KEY = 'reelax-console-log';
  const MAX = 2000;          // 最多保留 2000 行
  const FLUSH_INTERVAL = 800; // 落盘间隔(ms)
  const LINE_MAX = 500;       // 单条内容截断长度

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const arr = JSON.parse(raw);
        return Array.isArray(arr) ? arr : [];
      }
    } catch (_) {}
    return [];
  }

  let lines = load();
  let pending = [];
  let totalLogged = 0; // 累计日志条数（只增不减），用于判断是否有新增

  function flush() {
    if (pending.length === 0) return;
    lines = lines.concat(pending);
    pending = [];
    if (lines.length > MAX) lines = lines.slice(-MAX);
    try {
      localStorage.setItem(KEY, JSON.stringify(lines));
    } catch (_) {
      // 超限(可能是单条过大)：丢一半再存
      try {
        lines = lines.slice(-Math.floor(MAX / 2));
        localStorage.setItem(KEY, JSON.stringify(lines));
      } catch (_) {}
    }
  }

  function fmtArg(v) {
    if (typeof v === 'string') return v.length > LINE_MAX ? v.slice(0, LINE_MAX) + '…' : v;
    if (v instanceof Error) return (v.stack || v.message || String(v)).slice(0, LINE_MAX * 2);
    if (typeof v === 'object' && v !== null) {
      try {
        const s = JSON.stringify(v);
        return s && s.length > LINE_MAX ? s.slice(0, LINE_MAX) + '…' : s;
      } catch (_) { return String(v); }
    }
    return String(v);
  }

  function push(level, args) {
    const ts = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const time = `${pad(ts.getHours())}:${pad(ts.getMinutes())}:${pad(ts.getSeconds())}.${String(ts.getMilliseconds()).padStart(3, '0')}`;
    const body = Array.from(args).map(fmtArg).join(' ');
    totalLogged += 1;
    pending.push(`[${time}] [${level}] ${body}`);
    if (pending.length >= 20) flush();
  }

  const orig = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    debug: console.debug.bind(console),
  };

  console.log = (...a) => { push('log', a); orig.log(...a); };
  console.info = (...a) => { push('info', a); orig.info(...a); };
  console.warn = (...a) => { push('warn', a); orig.warn(...a); };
  console.error = (...a) => { push('error', a); orig.error(...a); };
  console.debug = (...a) => { push('debug', a); orig.debug(...a); };

  // 页面加载分隔标记（跨刷新可看出上一次页面在做什么）
  push('log', [`===== 页面加载 ${new Date().toString()} =====`]);

  window.addEventListener('beforeunload', () => flush());
  setInterval(flush, FLUSH_INTERVAL);

  // 自动保存到 <下载目录>/logs/：加载后 15 秒存一次（刷新后尽快落盘抓原因），
  // 之后每 30 分钟存一次（有新增才存）。内容为滚动缓冲（最后2000行≈近30分钟窗口）。
  const AUTO_SAVE_FIRST_DELAY = 15 * 1000;
  const AUTO_SAVE_INTERVAL = 30 * 60 * 1000;
  let lastSavedTotal = 0;

  function autoSave() {
    flush();
    if (totalLogged === lastSavedTotal) return; // 无新增不重复保存
    lastSavedTotal = totalLogged;
    const text = lines.join('\n');
    try {
      window.postMessage({ __reelaxLogSave: true, text }, '*');
    } catch (_) {}
  }
  setTimeout(autoSave, AUTO_SAVE_FIRST_DELAY);
  setInterval(autoSave, AUTO_SAVE_INTERVAL);

  // 保存成功确认：清空已保存的缓冲，避免下一份文件重复内容（保存失败则不清，防止丢日志）
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (data && data.__reelaxLogSaved === true) {
      lines = pending.slice();
      pending = [];
      totalLogged = 0;
      lastSavedTotal = 0;
      try { localStorage.removeItem(KEY); } catch (_) {}
    }
  });

  window.__reelaxLog = {
    getText: () => { flush(); return lines.join('\n'); },
    download: () => {
      flush();
      const text = lines.join('\n');
      const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `reelax-console-${Date.now()}.log`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    },
    autoSave: autoSave,
    clear: () => { pending = []; lines = []; try { localStorage.removeItem(KEY); } catch (_) {} },
    size: () => { flush(); return lines.length; },
  };
})();

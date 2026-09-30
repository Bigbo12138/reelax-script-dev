// ==UserScript==
// @name         奥术摸鱼大师·日报采集(页面版)
// @namespace    reelax-copilot
// @version      1.0.0
// @description  挂机日报「当日原始数据」在页面上下文采集，页面开着就一直累计、持久化到
//              localStorage，并经「页面自有 WebSocket」直推桥写 data/daily_raw.json。
//              彻底摆脱 MV3 Service Worker 休眠节流：只要钓鱼页开在，日报就不停更。
// @grant        none
// @run-at       document-idle
// ==/UserScript==
// 设计要点：
//  · 数据归属唯一来源 = 页面（localStorage['reelax-daily-raw']）。监控 SW 的 dailyTick/
//     reconnect 重推已停用，避免双写互相覆盖。
//  · 累计字段与 monitor.js dailyFresh() 逐字对齐，gaming/daily_report.py 无需改动。
//  · 杆数/金币：读 sync-hook 写入的 sessionStorage['reelax_sync_capture']（主世界共享同源，
//    与扩展后台读的是同一份），取其 dailyHarvest.casts / netGold。
//  · 出货/保底：经 injector 的 __reelaxApiRequest 签名前请求 /api/statistics（内容脚本在页面
//    上下文签名，不依赖后台 SW）。
//  · WS：页面自己连 127.0.0.1:55004（默认桥端口；改端口需在下面 PORTS 改），推 daily-report-raw。

(function () {
  'use strict';
  if (window.__REELAX_DAILY_JS__) return;
  window.__REELAX_DAILY_JS__ = true;

  const ENABLED = true;
  const LS_KEY = 'reelax-daily-raw';
  const SYNC_STORE_KEY = 'reelax_sync_capture';
  const SYNC_PATHS = ['/api/fishing/sync', '/api/fishing/state'];
  const BRIDGE_HOST = '127.0.0.1';
  const BRIDGE_PORTS = [55004];      // 可加多个，逐个尝试
  const TICK_MS = 60000;             // 累计/推送间隔（页面定时器不受 SW 节流）
  const STAT_MS = 300000;            // /api/statistics 采样间隔（与扩展保底同频，省频率预算）
  const WS_HEARTBEAT_MS = 20000;     // 11s 偏大的心跳间隔，避免刷屏
  const PITY_KEY = {
    arcane: { name: 'arcane' },
    exotic: { name: 'exotic' },
  };

  // -------------------- 日志 --------------------
  const TAG = '[Daily|page]';
  function dlog(...a) { try { console.log(TAG, ...a); } catch (_) {} }
  function dwarn(...a) { try { console.warn(TAG, ...a); } catch (_) {} }

  // -------------------- 日期/初始档 --------------------
  function dailyDateKey() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
  }
  function dailyFresh() {
    return {
      date: dailyDateKey(),
      startedAt: Date.now(),
      activeSec: 0,
      offlineSec: 0,
      refillOk: 0, refillNeeded: 0,
      switchOk: 0, switchTry: 0,
      totalCasts: 0, dailyNetGold: 0,
      rareCatches: { exotic: 0, arcane: 0 },
      statsBaseline: null,
      pity: null,
      lastTickAt: Date.now(),
    };
  }
  function lsLoad() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) {
        const j = JSON.parse(raw);
        if (j && j.date) return j;
      }
    } catch (_) {}
    return null;
  }
  function lsSave(d) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(d)); } catch (_) {}
  }

  let daily = ensureToday();

  function ensureToday() {
    const key = dailyDateKey();
    let d = lsLoad();
    if (d && d.date !== key) {
      // 跨天：原地保留下一天完全空档（统计基线冻结在昨天，届时每日报告读昨天）
      const fresh = dailyFresh();
      fresh.date = key;
      fresh._prevDaily = d;          // 供调试/日报交叉校验，可留
      d = fresh;
      lsSave(d);
    }
    return d || dailyFresh();
  }

  // -------------------- 读取游戏实时数据 --------------------
  // 玩家「在线」判定：最近一次 sync/state(或本地计时只要钓鱼页活着) 距今 < 90s。
  let lastActivityAt = Date.now();

  // 最新一份 fishing/sync|state 响应文本缓存：
  // 优先由 sync-hook 的 postMessage 通道（__reelaxSyncCapture）写入——该通道不会被
  // injector 轮询删除，可靠；sessionStorage 作兜底（见 readSyncHarvest）。
  let dailySyncText = null;
  let dailySyncAt = 0;

  function parseHarvestText(obj) {
    if (!obj || typeof obj.text !== 'string') return null;
    let url = '';
    try { url = new URL(obj.url, location.href).pathname; } catch (_e) { url = obj.url || ''; }
    if (!SYNC_PATHS.some((p) => url.indexOf(p) === 0)) return null;
    let body;
    try { body = JSON.parse(obj.text); } catch (_e) { return null; }
    if (!body || typeof body !== 'object') return null;
    lastActivityAt = Date.now();
    const harvest = (body.dailyHarvest) || {};
    return {
      totalCasts: (typeof harvest.casts === 'number') ? harvest.casts : null,
      dailyNetGold: (typeof harvest.netGold === 'number') ? harvest.netGold : null,
    };
  }

  function readSyncHarvest() {
    // 优先用 postMessage 通道缓存（不被 injector 删除，最可靠；限 30s 内新鲜）
    if (dailySyncText && (Date.now() - dailySyncAt) < 30000) {
      const r = parseHarvestText({ text: dailySyncText });
      if (r) return r;
    }
    // 兜底：读 sessionStorage（与扩展共用同源键；injector 会 1s 轮询后删除，易扑空）
    try {
      const raw = sessionStorage.getItem(SYNC_STORE_KEY);
      if (!raw) return null;
      const obj = JSON.parse(raw);
      return parseHarvestText(obj);
    } catch (_) { return null; }
  }

  // 经 injector 的 __reelaxApiRequest 签名 GET 一个 /api/* 路径（页面上下文签名，不依赖 SW）
  function signedGet(path) {
    return new Promise((resolve) => {
      const id = 'dl' + Date.now() + '_' + Math.floor(Math.random() * 1e9);
      const handler = (ev) => {
        const d = ev.data;
        if (!d || !d.__reelaxApiResponse || d.id !== id) return;
        window.removeEventListener('message', handler);
        clearTimeout(timer);
        resolve(d);
      };
      const timer = setTimeout(() => { window.removeEventListener('message', handler); resolve({ ok: false, status: 0, error: 'api-timeout' }); }, 20000);
      window.addEventListener('message', handler);
      try { window.postMessage({ __reelaxApiRequest: true, id, path, method: 'GET' }, '*'); } catch (e) { clearTimeout(timer); resolve({ ok: false, status: 0, error: String(e) }); }
    });
  }

  // 当日出货数：/api/statistics 的 rarities[].fishCaught 累计，「当日零点(或首次)」为基线做差值。
  let statsFetching = false;
  async function refreshPityAndStats() {
    if (!ENABLED) return;
    if (statsFetching) return;
    statsFetching = true;
    try {
      const r = await signedGet('/api/statistics');
      let data = null;
      if (r && r.ok && typeof r.body === 'string') { try { data = JSON.parse(r.body); } catch (_) {} }
      if (!data) {
        dwarn('statistics 获取失败:', r && r.error, 'status=', r && r.status);
        return;
      }
      const d = ensureToday();
      // ---- 稀有度基线/出货 ----
      if (Array.isArray(data.rarities)) {
        const cur = { exotic: undefined, arcane: undefined };
        for (const e of data.rarities) {
          if (e && (e.rarity === 'exotic' || e.rarity === 'arcane') && typeof e.fishCaught === 'number') cur[e.rarity] = e.fishCaught;
        }
        if (!d.statsBaseline || d.statsBaseline.date !== d.date) {
          d.statsBaseline = {
            date: d.date,
            exotic: (cur.exotic !== undefined ? cur.exotic : 0),
            arcane: (cur.arcane !== undefined ? cur.arcane : 0),
            at: Date.now(),
          };
        }
        const b = d.statsBaseline;
        if (b && b.date === d.date) {
          if (cur.exotic !== undefined && b.exotic != null) d.rareCatches.exotic = Math.max(0, cur.exotic - b.exotic);
          if (cur.arcane !== undefined && b.arcane != null) d.rareCatches.arcane = Math.max(0, cur.arcane - b.arcane);
        }
      }
      // ---- pity 快照（与 monitor 一致的结构）----
      const p = data.pity;
      if (p && p.arcane && p.exotic) {
        const pctOf = (c, h) => (c != null && h > 0) ? (c / h * 100) : null;
        const arc = {
          currentDry: p.arcane.currentDryCasts ?? null,
          maxDry: p.arcane.maxDryCasts ?? null,
          hardPity: p.arcane.hardPityCasts ?? null,
        };
        const exo = {
          currentDry: p.exotic.currentDryCasts ?? null,
          maxDry: p.exotic.maxDryCasts ?? null,
          hardPity: p.exotic.hardPityCasts ?? null,
        };
        arc.pct = pctOf(arc.currentDry, arc.hardPity);
        exo.pct = pctOf(exo.currentDry, exo.hardPity);
        d.pity = {
          updatedAt: Date.now(),
          effectiveLuck: p.effectiveLuck ?? null,
          baitId: p.baitId ?? null,
          weatherId: p.weatherId ?? null,
          arcane: arc,
          exotic: exo,
        };
      }
      d.lastTickAt = Date.now();
      lsSave(d);
      pushToBridge(d);
      maybePushPlayer();
    } catch (e) {
      dwarn('refreshPityAndStats 异常:', e);
    } finally {
      statsFetching = false;
    }
  }

  // 玩家快照（供日报显示运气/饵/天气）
  let lastPlayerPush = 0;
  function maybePushPlayer() {
    const now = Date.now();
    if (now - lastPlayerPush < 300000) return; // 5 分钟一次
    lastPlayerPush = now;
    const p = daily.pity || {};
    const player = { luck: p.effectiveLuck ?? null, bait: p.baitId ?? null, weather: p.weatherId ?? null, name: null };
    // 并入下一次 raw 推送即可，缺省无害。这里不计入。
  }

  // -------------------- WebSocket 直推桥 --------------------
  let ws = null;
  let wsReconnectDelay = 1000;
  let wsReconnecting = false;
  let wsHeartbeatTimer = null;
  let wsConnected = false;
  function pushToBridge(d) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const obj = { type: 'daily-report-raw', updatedAt: Date.now(), raw: d, player: playerFor(d) };
    try { ws.send(JSON.stringify(obj)); } catch (_) {}
  }
  function playerFor(d) {
    const p = d.pity || {};
    return { luck: p.effectiveLuck ?? null, bait: p.baitId ?? null, weather: p.weatherId ?? null, name: null };
  }
  function connectWs() {
    if (wsReconnecting || (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN))) return;
    wsReconnecting = true;
    tryWs(0);
  }
  function tryWs(idx) {
    if (idx >= BRIDGE_PORTS.length) {
      wsReconnecting = false;
      // 下轮重试（退了再连，避免紧贴）
      setTimeout(() => { connectWs(); }, wsReconnectDelay);
      return;
    }
    const port = BRIDGE_PORTS[idx];
    const sock = new WebSocket(`ws://${BRIDGE_HOST}:${port}`);
    let settled = false;
    const failPort = () => {
      if (settled) return;
      settled = true;
      try { sock.close(); } catch (_) {}
      tryWs(idx + 1);
    };
    sock.onopen = () => {
      if (settled) { try { sock.close(); } catch (_) {} return; }
      settled = true;
      ws = sock;
      wsReconnecting = false;
      wsReconnectDelay = 1000;
      wsConnected = true;
      dlog('WS 已连接:', port);
      clearInterval(wsHeartbeatTimer);
      wsHeartbeatTimer = setInterval(() => {
        try { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' })); } catch (_) {}
      }, WS_HEARTBEAT_MS);
      // 连上即推一次当前档（含跨天空档覆盖昨日残留）
      wsSendDaily();
    };
    sock.onmessage = (ev) => { /* 桥可能回 pong，无需处理 */ };
    sock.onclose = () => {
      if (!settled) { settled = true; return; }
      if (ws === sock) { ws = null; wsConnected = false; }
      wsReconnecting = false;
      setTimeout(() => { connectWs(); }, wsReconnectDelay);
      wsReconnectDelay = Math.min(wsReconnectDelay * 1.6, 30000);
    };
    sock.onerror = (ev) => { failPort(); };
  }
  let wsPushPending = false;
  function wsSendDaily() {
    if (wsPushPending) return;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    wsPushPending = true;
    const d = ensureToday();
    wsSendRaw(d);
    setTimeout(() => { wsPushPending = false; }, 2000);
  }
  function wsSendRaw(d) {
    const obj = { type: 'daily-report-raw', updatedAt: Date.now(), raw: d, player: playerFor(d) };
    try { ws.send(JSON.stringify(obj)); } catch (_) {}
  }

  // -------------------- 累计 tick --------------------
  let lastTickAt = daily.lastTickAt || Date.now();
  function tick() {
    if (!ENABLED) return;
    const d = ensureToday();
    const now = Date.now();

    // 在线/离线时长：钓鱼页开着则按心跳判定；本地只要有 sync 心跳就算 alive。
    const alive = (now - lastActivityAt) < 90 * 1000;
    let delta = Math.round((now - lastTickAt) / 1000);
    if (delta <= 0) delta = 0;
    if (delta > 0 && delta < 600) {
      if (alive) d.activeSec += delta; else d.offlineSec += delta;
    } else if (delta >= 600 && d.startedAt) {
      // 页面曾长时间没 tick（例如标签页被休眠），补算一段，上限 10 分钟
      const add = Math.min(600, Math.round((now - (d.lastTickAt || now)) / 1000));
      if (add > 0) { if (alive) d.activeSec += add; else d.offlineSec += add; }
    }
    d.lastTickAt = now;
    lastTickAt = now;

    // 杆数/金币
    const h = readSyncHarvest();
    if (h) {
      if (h.totalCasts != null) d.totalCasts = h.totalCasts;
      if (h.dailyNetGold != null) d.dailyNetGold = h.dailyNetGold;
    } else {
      // sync 暂不可用则保持在线计时（钓鱼页活着仍算在线）
      lastActivityAt = Date.now();
    }

    lsSave(d);
    pushToBridge(d);
  }

  // -------------------- postMessage 事件（补杆/切图计数） --------------------
  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const data = ev.data;
    if (!data || typeof data !== 'object') return;
    if (!ENABLED) return;
    // sync-hook postMessage 通道：缓存最新响应文本，供 readSyncHarvest 使用（不被 injector 删除）
    if (data.__reelaxSyncCapture && typeof data.text === 'string') {
      dailySyncText = data.text;
      dailySyncAt = Date.now();
      return;
    }
    const d = ensureToday();
    if (data.__reelaxDailyRefill) {
      d.refillNeeded = (d.refillNeeded || 0) + 1;
      if (data.ok) d.refillOk = (d.refillOk || 0) + 1;
      lsSave(d);
      return;
    }
    if (data.__reelaxWebhook && typeof data.text === 'string' && data.text.indexOf('[Reelax] 自动切图') === 0) {
      d.switchTry = (d.switchTry || 0) + 1;
      d.switchOk = (d.switchOk || 0) + 1;
      lsSave(d);
    }
  });

  // -------------------- 启动 --------------------
  function start() {
    if (!ENABLED) return;
    dlog('日报采集(页面版)启动，当日 date=' + daily.date,
      '已累计 activeSec=' + daily.activeSec + ' totalCasts=' + daily.totalCasts);
    connectWs();
    setInterval(tick, TICK_MS);
    setInterval(refreshPityAndStats, STAT_MS);
    // 首轮立即做一次，尽早把今日档推给桥
    setTimeout(() => { tick(); refreshPityAndStats(); }, 1000);
  }

  window.__REELAX_DAILY__ = {
    getDaily: () => ensureToday(),
    isWsConnected: () => wsConnected,
    raw: () => JSON.parse(JSON.stringify(ensureToday())),
  };

  start();
})();
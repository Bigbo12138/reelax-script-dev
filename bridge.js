// bridge.js —— 本地桥：持久 WebSocket（替代原 HTTP 长轮询）
//
// 原理：
//   Python（devtools/ws_bridge.py）在本机 127.0.0.1:PORT 起 WebSocket 服务端。
//   本脚本（扩展后台）作为 WebSocket 客户端主动连上并保持长连接，断线自动重连。
//   Python 下发请求消息 {id, method, path, body}，本脚本在页面上下文签名执行
//   （复用 api.js 的 ReelaxApi.pageSignedFetch，可正确通过写操作的 Referer 校验），
//   再回传 {id, status, ok, data, raw}。全双工、无轮询竞态。
//
//   附加功能：
//     - 定期轻量探测 /api/me 登录态（默认 5 分钟，设置页可配），失效时刷新页面
//     - 桥状态写入 window.__bridgeStatus，供 popup 展示
//     - proof 令牌维护：bridgeUpdateProof 供 monitor.js 回填最新 proof

// 桥状态（供 popup 读取）
window.__bridgeStatus = {
  connected: false,       // WebSocket 是否已连接
  transport: 'ws',        // 传输方式
  lastPollAt: null,       // 最近一次收到请求的时间（语义保留）
  lastTaskAt: null,       // 最近一次执行任务时间
  lastTaskMs: null,       // 最近一次任务耗时(ms)
  taskCount: 0,           // 累计执行任务数
  proofOk: false,         // proof 是否有效
  loginOk: false,         // 登录态是否正常
  lastError: null,        // 最近错误
};

let ws = null;
let wsUrl = null;
let bridgeProof = null;   // 会话级 proof 令牌缓存
let reconnectDelay = 1000;
let reconnectTimer = null;
let reconnecting = false;     // 防止 onclose/onerror 重入
let heartbeatTimer = null;    // 心跳定时器
let missCount = 0;            // 连续未收到 pong 的次数
const HEARTBEAT_INTERVAL_MS = 15000; // 心跳间隔 15s
const HEARTBEAT_MISS_LIMIT = 3;      // 连续 3 次无 pong → 认为连接已死，主动断开重连
const RECONNECT_MAX_DELAY = 30000;   // 重连上限 30s（原 3s 太短，服务端长时间重启时频繁失败）
let loginTimer = null;

// MV3 SW 休眠死锁修复：bridge.js 维系 WS 只靠 setInterval/setTimeout，
// 但 SW 休眠时这些 JS 定时器全被冻结、WS 随之断开；醒来又没人重新 bridgeConnect()，
// 导致 data/daily_raw.json 永远不再更新（早上日报因读到停写空档而全 0）。
// 用 chrome.alarms 每 1 分钟唤醒 SW，若 WS 未开则重连（onopen 会重推 storage 里的当日 raw）。
const BRIDGE_KEEP_ALARM = 'bridge-ws-keepalive';
const BRIDGE_KEEP_ALARM_MIN = 1;
let _bridgeKeepAliveRegistered = false;
function scheduleBridgeKeepAlive() {
  try {
    if (window.chrome && chrome.alarms && chrome.alarms.create) {
      chrome.alarms.create(BRIDGE_KEEP_ALARM, { delayInMinutes: BRIDGE_KEEP_ALARM_MIN, periodInMinutes: BRIDGE_KEEP_ALARM_MIN });
    }
  } catch (e) { /* 忽略 */ }
}
function registerBridgeKeepAliveListener() {
  if (_bridgeKeepAliveRegistered) return;
  _bridgeKeepAliveRegistered = true;
  try {
    if (window.chrome && chrome.alarms && chrome.alarms.onAlarm) {
      chrome.alarms.onAlarm.addListener((alarm) => {
        if (!alarm || alarm.name !== BRIDGE_KEEP_ALARM) return;
        // SW 被 alarm 唤醒是可靠的外部触发：若 WS 已死则无条件重连。
        // 不能再用 !reconnecting 守卫——SW 休眠时 scheduleReconnect 的
        // setTimeout 会随 SW 一起死掉，导致 reconnecting 永久卡在 true、
        // 以后每轮 alarm 都被跳过、WS 永远重连不上（旧版正是死在这里）。
        if (!(ws && ws.readyState === WebSocket.OPEN)) {
          stopHeartbeat();
          if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
          if (ws) { try { ws.close(); } catch (e) { /* 忽略 */ } ws = null; }
          reconnecting = false;
          reconnectDelay = 1000;
          bridgeConnect();
        }
      });
    }
  } catch (e) { /* 忽略 */ }
}

const BRIDGE_DEFAULT_PORT = 55004;
const LOGIN_CHECK_MIN_DEFAULT = 5;

async function bridgeLoadConfig() {
  try {
    const cfg = await browser.storage.local.get({
      bridgePort: BRIDGE_DEFAULT_PORT,
      loginCheckMin: LOGIN_CHECK_MIN_DEFAULT,
    });
    const port = Number(cfg.bridgePort) || BRIDGE_DEFAULT_PORT;
    wsUrl = `ws://127.0.0.1:${port}/`;
    return cfg;
  } catch (e) {
    wsUrl = `ws://127.0.0.1:${BRIDGE_DEFAULT_PORT}/`;
    return { bridgePort: BRIDGE_DEFAULT_PORT, loginCheckMin: LOGIN_CHECK_MIN_DEFAULT };
  }
}

// 浏览器 fetch 默认永不超时，所有 fetch 都要带 AbortController
const BRIDGE_FETCH_TIMEOUT_MS = 15000;
async function bridgeFetch(url, init = {}, timeoutMs = BRIDGE_FETCH_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ---- proof 令牌维护（monitor.js 会调用 bridgeUpdateProof 回填最新令牌）----
async function bridgeGetProof() {
  if (bridgeProof) return bridgeProof;
  const meRes = await bridgeFetch('https://reelax.cn/api/me', {
    credentials: 'include',
    headers: { Accept: 'application/json' },
  });
  const proof = meRes.headers.get('x-arcane-request-proof');
  if (proof) {
    bridgeProof = proof;
    window.__bridgeStatus.proofOk = true;
  }
  return proof;
}

function bridgeResetProof() {
  bridgeProof = null;
  window.__bridgeStatus.proofOk = false;
}

function bridgeUpdateProof(proof) {
  if (proof && proof !== bridgeProof) {
    bridgeProof = proof;
    window.__bridgeStatus.proofOk = true;
    window.__bridgeStatus.lastProofUpdatedAt = Date.now();
  }
}

// ---- 心跳保活 ----
// WebSocket 空闲时无任何流量，中间代理/OS 可能在空闲超时后静默切断 TCP（半开连接），
// onclose 不会立即触发，扩展以为还连着但实际已断。通过定时发 ping 帧保活 + 检测半开。
function startHeartbeat() {
  stopHeartbeat();
  missCount = 0;
  heartbeatTimer = setInterval(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    // WebSocket 浏览器 API 不支持自定义发 ping 帧，用应用层 ping 消息代替
    try {
      ws.send(JSON.stringify({ type: 'ping', ts: Date.now() }));
    } catch (e) { /* 忽略 */ }
    missCount++;
    // 连续多次无 pong 响应 → 连接已死，主动关闭触发重连
    if (missCount >= HEARTBEAT_MISS_LIMIT) {
      console.warn('[bridge] 心跳超时，连接可能已断，主动重连');
      window.__bridgeStatus.lastError = '心跳超时，主动重连';
      try { ws.close(); } catch (e) { /* 忽略 */ }
      // close 可能不触发 onclose（半开连接），直接走重连
      scheduleReconnect();
    }
  }, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

// 处理收到的 pong 消息（重置 miss 计数）
function handlePong() {
  missCount = 0;
}

// ---- WebSocket 客户端 ----
function bridgeSend(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify(obj)); } catch (e) { /* 忽略 */ }
  }
}

// 统一的重连调度（防重入、防多定时器）
function scheduleReconnect() {
  if (reconnecting) return;
  reconnecting = true;
  stopHeartbeat();
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  const delay = reconnectDelay;
  reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_DELAY);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    reconnecting = false;
    bridgeConnect();
  }, delay);
}

// 处理 Python 下发的请求：页面上下文签名执行后回传
async function bridgeHandleRequest(msg) {
  const t0 = Date.now();
  try {
    // 诊断虚拟路径：/__status 直接回传桥 + monitor 状态（不签名、不发 reelax 请求）
    if (msg.path === '/__status' && (msg.method || 'GET').toUpperCase() === 'GET') {
      bridgeSend({
        id: msg.id, status: 200, ok: true,
        data: { bridge: window.__bridgeStatus, monitor: window.__monitorStatus || null },
      });
      return;
    }
    // 通用 DOM 点击虚拟路径：/__domclick 调用 DomFallback.click(body) 在页面主世界点击任意元素
    // body: { selector, text?, all?, match?, beforeClick?, extraConfirm?, maxClicks? }
    if (msg.path === '/__domclick') {
      const body = (msg.body && typeof msg.body === 'object') ? msg.body : {};
      if (window.DomFallback && typeof window.DomFallback.click === 'function') {
        const out = await window.DomFallback.click(body);
        bridgeSend({ id: msg.id, status: out && out.ok ? 200 : 400, ok: !!(out && out.ok), data: out });
      } else {
        bridgeSend({ id: msg.id, status: 500, ok: false, error: 'DomFallback not available', data: null });
      }
      return;
    }
    const res = await ReelaxApi.pageSignedFetch(msg.path, msg.method || 'GET',
      msg.body === undefined ? null : msg.body);
    window.__bridgeStatus.taskCount += 1;
    window.__bridgeStatus.lastTaskMs = Date.now() - t0;
    window.__bridgeStatus.lastTaskAt = Date.now();
    window.__bridgeStatus.lastPollAt = Date.now();
    let data = null;
    if (res && res.body) {
      try { data = JSON.parse(res.body); } catch (e) { /* 非 JSON */ }
    }
    bridgeSend({
      id: msg.id,
      status: (res && res.status) || 0,
      ok: !!(res && res.ok),
      data,
      raw: (res && res.body) || '',
    });
  } catch (e) {
    window.__bridgeStatus.lastError = String(e);
    bridgeSend({ id: msg.id, status: 0, ok: false, error: String(e) });
  }
}

function bridgeConnect() {
  if (!wsUrl) return;
  // 清理旧连接及其回调（防止旧 onclose 触发意外重连）
  stopHeartbeat();
  if (ws) {
    try {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onclose = null;
      ws.onerror = null;
      ws.close();
    } catch (e) { /* 忽略 */ }
    ws = null;
  }
  // 重置重连延迟：如果上一次成功连接过，延迟应从 1s 开始
  // （reconnecting 路径已设置过延迟，这里不重置——由 scheduleReconnect 统一管理）
  try {
    ws = new WebSocket(wsUrl);
  } catch (e) {
    window.__bridgeStatus.lastError = 'ws 创建失败: ' + String(e);
    scheduleReconnect();
    return;
  }
  ws.onopen = () => {
    window.__bridgeStatus.connected = true;
    window.__bridgeStatus.lastError = null;
    reconnectDelay = 1000; // 连接成功，重置重连延迟
    reconnecting = false;
    console.log('[bridge] ws 已连接:', wsUrl);
    startHeartbeat();
    // 【页面版日报】停用 SW 重推：当日原始数据改由页面脚本 日报采集.js 用页面自有 WS 直推桥，
    // bridge 的 reconnect 重推（此前读 SW storage reelax-daily-raw）会推旧/空档与页面新档互相覆盖，
    // 故注释掉。SW 侧不再作为日报数据来源。
  };
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    if (!msg) return;
    // 心跳 pong 响应
    if (msg.type === 'pong') { handlePong(); return; }
    // 业务请求
    if (msg.id == null) return;
    bridgeHandleRequest(msg);
  };
  ws.onclose = () => {
    window.__bridgeStatus.connected = false;
    stopHeartbeat();
    // 只有非主动清理导致的 close 才重连（ws 已被置 null 说明是主动清理）
    if (ws !== null) {
      scheduleReconnect();
    }
  };
  ws.onerror = (e) => {
    window.__bridgeStatus.lastError = 'ws 连接错误';
    // onerror 后通常会跟一个 onclose，不在此处重连，避免双重调度
  };
}

// ---- 登录态探测（轻量，仅同步状态到 bridgeStatus，不做刷新操作）----
// 注意：页面刷新由 monitor.js 的 checkLoginAndProof 统一负责（带冷却），
// bridge.js 只同步登录态/proof 到 __bridgeStatus 供 popup 展示，避免两个模块同时刷新页面。
async function checkLogin() {
  try {
    const r = await bridgeFetch('https://reelax.cn/api/me', {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });
    window.__bridgeStatus.loginOk = r.ok;
    if (r.ok) {
      const proof = r.headers.get('x-arcane-request-proof');
      if (proof) {
        bridgeProof = proof;
        window.__bridgeStatus.proofOk = true;
      }
      window.__bridgeStatus.lastLoginCheckAt = Date.now();
      return;
    }
    // 会话失效：仅记录状态，刷新交给 monitor.js 统一处理（带冷却防死循环）
    window.__bridgeStatus.lastError = '登录态失效(HTTP ' + r.status + ')';
    bridgeResetProof();
  } catch (e) {
    /* 网络抖动忽略 */
  }
}

async function bridgeStart() {
  await bridgeLoadConfig();
  bridgeConnect();
  checkLogin();
  // MV3 SW 休眠会让 JS 定时器和 WS 一起死掉，导致 data/daily_raw.json 永远停写。
  // 用 chrome.alarms 每 1 分钟唤醒并自愈 WS，桥才一直能收到并写当日 raw。
  scheduleBridgeKeepAlive();
  registerBridgeKeepAliveListener();
  const cfg = await bridgeLoadConfig();
  const min = Number(cfg.loginCheckMin) > 0 ? Number(cfg.loginCheckMin) : LOGIN_CHECK_MIN_DEFAULT;
  loginTimer = setInterval(checkLogin, min * 60 * 1000);
}

// 设置变化时重载端口/间隔
browser.storage.onChanged.addListener((_changes, area) => {
  if (area === 'local') bridgeLoadConfig().then((cfg) => {
    const min = Number((_changes.loginCheckMin || {}).newValue);
    if (loginTimer && min > 0) {
      clearInterval(loginTimer);
      loginTimer = setInterval(checkLogin, min * 60 * 1000);
    }
    // 端口变了 → 重连（先取消待重连定时器，防止旧定时器再触发）
    if ((_changes.bridgePort || {}).newValue !== undefined) {
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      reconnecting = false;
      reconnectDelay = 1000;
      bridgeConnect();
    }
  });
});

// 后台脚本加载即开始连接
bridgeStart();

// ---- 市场实时事件转发（交易大屏数据源）----
// 游戏页面 market_events.js 订阅 SSE → injector.js → 本后台。
// 收到后经已有 55004 WS 连接推给 ws_bridge.py，再广播给大屏客户端。
// 若桥未连上则缓存最近 N 条，连上后补发。
const MARKET_EVENT_QUEUE_MAX = 200;
let marketEventQueue = [];
let marketEventCount = 0;
let marketEventSending = false;

function bridgeFlushMarketEvents() {
  if (marketEventSending || !ws || ws.readyState !== WebSocket.OPEN) return;
  marketEventSending = true;
  try {
    while (marketEventQueue.length > 0) {
      const item = marketEventQueue.shift();

      ws.send(JSON.stringify({ ...item, type: 'market-event' }));
    }
  } catch (e) {
    // 发送失败，把未发的放回队头（保留顺序）
    console.warn('[bridge] 市场事件发送失败:', e);
  } finally {
    marketEventSending = false;
  }
}

// 连接建立后立即补发缓存的 market 事件
const _origOnOpen = ws ? ws.onopen : null;
function hookMarketFlushOnOpen() {
  // 在 bridgeConnect 的 onopen 里联动：因为 onopen 每次重建，这里用一个定时器兜底
}
// 用定时器兜底：连接打开时清空队列（简单可靠）
setInterval(() => {
  if (ws && ws.readyState === WebSocket.OPEN && marketEventQueue.length > 0) {
    bridgeFlushMarketEvents();
  }
}, 2000);

browser.runtime.onMessage.addListener((msg, sender) => {
  // 处理 content script 请求背包鱼 fishId（供页面订阅盘口）
  if (msg && msg.type === 'get-fish-ids') {
    window.__bridgeStatus.getFishIdsCalled = (window.__bridgeStatus.getFishIdsCalled||0)+1;
    return fetch('http://127.0.0.1:55004/bigscreen/api/fish-ids')
      .then(r => { window.__bridgeStatus.getFishIdsStatus = r.status; return r.json(); })
      .then(j => { window.__bridgeStatus.getFishIdsCount = (j.fishIds||[]).length; return j.fishIds || []; })
      .catch(e => { window.__bridgeStatus.getFishIdsErr = String(e); return []; });
  }
  // 挂机日报：monitor 推当日原始数据 → 经 WS 给 ws_bridge 写 data/daily_raw.json
  // 【页面版日报】停用：数据由页面脚本 日报采集.js 用页面自有 WS 直推（type=daily-report-raw），
  // 此处不再转发 SW 的 reelax-daily-raw，避免双写互相覆盖。
  if (msg && msg.type === 'reelax-daily-raw' && msg.data) {
    return;
  }
  if (!msg || msg.type !== 'reelax-market-event' || !msg.data) return;
  const { type, data } = msg.data;
  // src 从 data.src 取(gear/fish)，或从 ev.assetType 兜底——不能从 type(=event) 判断
  const evObj = (data && data.ev) || data || {};
  const assetType = (data && data.src) || evObj.assetType || (evObj.gear ? 'gear' : 'fish');
  const entry = { src: assetType === 'gear' ? 'gear' : 'fish', at: Date.now(), type, data };
  // 限流：只推事件本体，避免队列无限膨胀
  if (marketEventQueue.length >= MARKET_EVENT_QUEUE_MAX) marketEventQueue.shift();
  marketEventQueue.push(entry);
  marketEventCount++;
  window.__bridgeStatus.marketEventCount = marketEventCount;
  bridgeFlushMarketEvents();
  return false;
});

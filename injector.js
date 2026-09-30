// injector.js —— 内容脚本：把核心脚本注入页面「主世界」
//
// 由 manifest.json 的 content_scripts 声明，Firefox 保证在目标网站的每个页面
// 加载时自动运行，不依赖后台脚本、存储配置或注入时机，因此 100% 生效。
//
// 核心脚本（自动登录、聚合面板）通过 <script> 标签注入页面主世界，
// 与油猴脚本 @grant none 的行为一致，可访问页面 DOM 和全局变量。

(() => {
  'use strict';

  const CORE_SCRIPTS = ['日志收集.js', '自动登录.js', '聚合.js', '日报采集.js']; // 强制脚本：始终注入（日志收集 / 自动登录 / 聚合主脚本 / 日报采集页版本）
  const ALL_SCRIPTS = ['日志收集.js', '自动登录.js', '聚合.js', '自动出售库存.js', '自动加点.js', '自动补满次数.js', '保底显示.js', '一键市场.js', '装备属性占比.js', '装备初始价显示.js', '以物易物价格.js']; // 可注入全集（含可选脚本）；market_events.js 已取消注入（游戏 SSE 不可用）; sync-hook.js 由 manifest 以 world:'MAIN' 注入

  // 登录凭据运行期配置：run.sh 依据环境变量 FISH_EMAIL / FISH_PASSWD（或 --login 参数）
  // 生成 scripts/login_credentials.js。此文件先于自动登录.js 注入主世界，供其读取；
  // 为运行期生成、不纳入版本库。未配置时自动登录.js 不执行自动登录（不硬编码账号密码）。
  const LOGIN_CRED_FILE = 'scripts/login_credentials.js';

  // 转发主世界「日志收集.js」的自动保存请求到后台（写下载目录/logs/）
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    // 主世界请求「一键市场」浮窗图片 URL（主世界无 chrome.runtime，由隔离世界 getURL 后回传）
    if (data && data.__reelaxGetFab) {
      let fabUrl = '';
      try {
        const g = (window.chrome && window.chrome.runtime && window.chrome.runtime.getURL);
        if (g) fabUrl = g('scripts/market-fab.png');
      } catch (_e) {}
      try { window.postMessage({ __reelaxFabUrl: data.__reelaxGetFab, url: fabUrl }, '*'); } catch (_) {}
      return;
    }
    if (data && data.__reelaxLogSave && typeof data.text === 'string') {
      browser.runtime.sendMessage({ type: 'reelax-save-log', text: data.text })
        .then((res) => {
          const ok = !!(res && res.ok);
          try { window.postMessage({ __reelaxLogSaved: ok }, '*'); } catch (_) {}
        })
        .catch(() => {
          try { window.postMessage({ __reelaxLogSaved: false }, '*'); } catch (_) {}
        });
    }
    // 转发主世界 webhook 通知请求到后台（monitor.js 统一发送）
    if (data && data.__reelaxWebhook && typeof data.text === 'string') {
      browser.runtime.sendMessage({ type: 'reelax-webhook', text: data.text }).catch(() => {});
    }
    // 转发主世界「市场实时事件」到后台（market_events.js → 桥 → 大屏）
    if (data && data.__reelaxMarketEvent) {
      browser.runtime.sendMessage({ type: 'reelax-market-event', data })
        .catch(() => { /* 后台未加载忽略 */ });
    }
    // 转发主世界「自动开增益」触发到后台（聚合.js 确定优选地图 → monitor.js 开增益）
    if (data && data.__reelaxAutoBoost) {
      browser.runtime.sendMessage({ type: 'reelax-auto-boost', data: data.__reelaxAutoBoost })
        .catch(() => { /* 后台未加载忽略 */ });
    }
    // 转发主世界「挂机日报：补杆结果」到后台（聚合.js → monitor.js 统计）
    // 聚合.js 发的结构是 { __reelaxDailyRefill:true, ok:bool }（__reelaxDailyRefill 为布尔标记，
    // ok 在顶层）。之前读 data.__reelaxDailyRefill.ok 时，布尔 true 无 .ok 属性 → 恒为 false，
    // 导致日报 refillOk 永远为 0。修为读顶层 data.ok。
    if (data && data.__reelaxDailyRefill) {
      browser.runtime.sendMessage({ type: 'reelax-daily-refill', ok: !!(data.ok) })
        .catch(() => { /* 后台未加载忽略 */ });
    }
    // 转发主世界「fishing/sync 响应体」（sync-hook.js 捕获）到后台（monitor.js 解析进 m.sync）
    if (data && data.__reelaxSyncCapture && typeof data.text === 'string') {
      browser.runtime.sendMessage({ type: 'reelax-sync-captured', text: data.text })
        .catch(() => { /* 后台未加载忽略 */ });
    }
    // 页面脚本的签名 API 请求（供 一键市场.js 等读写 /api/*）：用页面上下文签名 fetch 后回传结果。
    // 请求结构 { __reelaxApiRequest:true, id, path, method, body }；回传 { __reelaxApiResponse:true, id, ok, status, body, error }。
    if (data && data.__reelaxApiRequest && typeof data.path === 'string' && data.id != null) {
      _reelaxSignedFetch(data.path, data.method || 'GET', data.body)
        .then((r) => {
          try { window.postMessage(Object.assign({ __reelaxApiResponse: true, id: data.id }, r), '*'); } catch (_) {}
        })
        .catch((e) => {
          try { window.postMessage({ __reelaxApiResponse: true, id: data.id, ok: false, status: 0, error: String(e) }, '*'); } catch (_) {}
        });
    }
  });

  // 把核心脚本交给后台用 chrome.scripting.executeScript({world:'MAIN'}) 注入。
  // 原实现用 <script textContent=...> 内联注入，被页面 CSP（script-src 'self' ...）拦截，
  // 只在日志打印「已注入」但实际未执行；<script src="chrome-extension://..."> 因 CSP 未
  // 放行本扩展 ID 也可能被拦。chrome.scripting 注入不受页面 CSP 约束，world:'MAIN' 在
  // 页面主世界执行，是不可被 CSP 阻断的正规机制（签名 fetch 之类也不需要返回结果时可
  // 直接 fire-and-forget）。injector 通过请示后台执行，后台可从消息的 sender.tab.id 得知
  // 当前标签页。
  function inject(name) {
    return new Promise((resolve) => {
      const done = (ok) => {
        console.log(ok ? ('[Reelax 助手] 已注入 ' + name) : ('[Reelax 助手] 注入无结果: ' + name));
        resolve(ok);
      };
      try {
        // 用原生 chrome.runtime.sendMessage（回调式）：browser.* 是 polyfill 包装成
        // Promise 的版本，其 wrapMethod 会吞掉调用方回调，导致本回调永不触发从而
        // 卡住 CORE_SCRIPTS 的顺序注入，故这里必须走原生回调 API，与 _forwardSync 一致。
        if (window.chrome && window.chrome.runtime && window.chrome.runtime.sendMessage) {
          window.chrome.runtime.sendMessage({ type: 'reelax-run-script', name: name }, (res) => {
            void chrome.runtime.lastError;
            done(!!(res && res.frames && res.frames.length));
          });
        } else if (window.browser && window.browser.runtime.sendMessage) {
          window.browser.runtime.sendMessage({ type: 'reelax-run-script', name: name })
            .then((res) => done(!!(res && res.frames && res.frames.length)))
            .catch(() => done(false));
        } else {
          done(false);
        }
      } catch (e) {
        console.error('[Reelax 助手] 请示后台注入失败:', name, e);
        done(false);
      }
    });
  }

  (async () => {
    // 注入登录凭据配置（若 run.sh 已生成），再注入核心脚本
    // 注：主世界 sync-hook 已由 manifest 以 content_scripts + world:MAIN + document_start
    //     独立注入（见 scripts/sync-hook.js），无需在此处理。
    try {
      // login_credentials.js 为运行期可选生成（run.sh 生成），与核心脚本一样经后台
      // chrome.scripting.executeScript({world:'MAIN'}) 注入；不存在则后台注入无结果，忽略。
      await inject('login_credentials.js');
    } catch (e) {
      // 文件不存在/读取失败 → 自动登录.js 无凭据，跳过自动登录，忽略
    }
    for (const name of CORE_SCRIPTS) {
      await inject(name);
    }
    // 可选脚本：读设置页「enabledScripts」决定注入哪些。强制脚本始终注入。
    // 存储缺失（从未保存过设置）时，用默认集合：除『自动出售库存.js』（页面版已失效，改走后台 API 版）外用默认开。
    const TOGGLEABLE = ALL_SCRIPTS.filter((n) => !CORE_SCRIPTS.includes(n));
    const DEFAULT_TOGGLEABLE = TOGGLEABLE.filter((n) => n !== '自动出售库存.js');
    try {
      let enabled = [];
      try {
        const stored = await browser.storage.local.get('enabledScripts');
        if (Array.isArray(stored.enabledScripts) && stored.enabledScripts.length) enabled = stored.enabledScripts;
      } catch (_) { enabled = []; }
      const enabledSet = new Set(enabled);
      for (const name of TOGGLEABLE) {
        // 有存储记录：按勾选；无存储记录：用默认集合（不含自动出售库存.js）
        const shouldInject = enabled.length ? enabledSet.has(name) : DEFAULT_TOGGLEABLE.includes(name);
        if (shouldInject) await inject(name);
      }
    } catch (_) {}
    // 向后台请求背包鱼 fishId，注入页面主世界（market_events.js 订阅盘口用），带重试
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        const ids = await browser.runtime.sendMessage({ type: 'get-fish-ids' });
        if (Array.isArray(ids) && ids.length) {
          // 用 <script> 直接设置主世界变量（content script 无法直接写主世界 window）
          const s = document.createElement('script');
          s.textContent = 'window.__reelaxFishIds=' + JSON.stringify(ids) + ';';
          (document.head||document.documentElement).appendChild(s);
          s.remove();
          break;
        }
      } catch (e) {}
      await new Promise(r => setTimeout(r, 5000));
    }
  })();

  // ---- 轮询读取主世界 sync-hook 写入的 sessionStorage，转发给后台 ----
  // 主世界与扩展 content script 共享同源 sessionStorage；hook 捕获 fishing/sync|state
  // 响应体写入，这里定时读取并转发给后台 monitor.js 解析，读后清除键（保最新）。
  const SYNC_STORE_KEY = 'reelax_sync_capture';
  let lastSyncData = null;
  setInterval(() => {
    try {
      const raw = sessionStorage.getItem(SYNC_STORE_KEY);
      if (!raw) return;
      let obj = null;
      try { obj = JSON.parse(raw); } catch (e) { sessionStorage.removeItem(SYNC_STORE_KEY); return; }
      if (!obj || typeof obj.text !== 'string') { sessionStorage.removeItem(SYNC_STORE_KEY); return; }
      sessionStorage.removeItem(SYNC_STORE_KEY);
      // 去重：同一文本不重复发
      if (obj.text === lastSyncData) return;
      lastSyncData = obj.text;
      _forwardSync(obj.text);
    } catch (e) { /* 忽略 */ }
  }, 1000);

function _forwardSync(text) {
    try {
      if (window.chrome && window.chrome.runtime && window.chrome.runtime.sendMessage) {
        // 直接用原生 chrome.*（回调式）发送，规避 polyfill 层可能的差异
        window.chrome.runtime.sendMessage({ type: 'reelax-sync-captured', text: text }, () => {
          // 忽略 lastError（后台可能未及时响应）
          void chrome.runtime.lastError;
        });
      } else if (window.browser && window.browser.runtime.sendMessage) {
        window.browser.runtime.sendMessage({ type: 'reelax-sync-captured', text: text }).catch(() => {});
      }
    } catch (e) { /* 忽略 */ }
  }

  // ---- 签名 API 处理（Content script 驻留 handler） ----
  // 原 Firefox 版：后台 api.js 用 browser.tabs.executeScript 注入一段异步 IIFE 到页面，
  // Chrome 的 chrome.scripting.executeScript 无法等待注入函数的 Promise 返回，导致 no-result。
  // 改为：后台发 reelax-api 消息给本 content script，本文件在页面上下文（含同源 cookie /
  // crypto.subtle）执行签名 fetch，并用 sendResponse 返回结果。后台用 chrome.tabs.sendMessage
  // 发送，天然支持异步响应，Chrome 100% 可靠。
  const API_FETCH_TIMEOUT_MS = 20000;
  const API_PROOF_KEY = '__reelaxApiProof'; // 会话级 proof 缓存（isolated world 的 window）

  async function _reelaxSignedFetch(path, method, body) {
    const API_FETCH_TIMEOUT_MS_ = 20000;
    try {
      const mtd = (method || 'GET').toUpperCase();
      const bodyStr = (body === undefined || body === null) ? '' : JSON.stringify(body);
      const base = 'https://reelax.cn';

      const getProof = async () => {
        if (window[API_PROOF_KEY]) return window[API_PROOF_KEY];
        const me = await fetch(base + '/api/me', { credentials: 'include', headers: { Accept: 'application/json' } });
        const p = me.headers.get('x-arcane-request-proof');
        if (!p) return null;
        window[API_PROOF_KEY] = p;
        return p;
      };

      const doFetch = async (proof) => {
        const ts = String(Date.now());
        const msg = ['v1', mtd, path, ts, bodyStr].join('\n');
        const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(proof), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
        const sigBuf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
        let sigText = '';
        try {
          sigText = btoa(String.fromCharCode.apply(null, new Uint8Array(sigBuf)))
            .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        } catch (e) {
          // btoa 对某些编码失败时用分块转换
          const bytes = new Uint8Array(sigBuf);
          let bin = '';
          for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
          sigText = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        }
        const headers = {
          Accept: 'application/json',
          'x-arcane-request-proof': proof,
          'x-arcane-request-timestamp': ts,
          'x-arcane-request-signature': sigText,
          'idempotency-key': (crypto.randomUUID ? crypto.randomUUID() : '' + Date.now() + Math.random()),
        };
        if (bodyStr) headers['content-type'] = 'application/json';
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), API_FETCH_TIMEOUT_MS_);
        try {
          const r = await fetch(base + path, {
            method: mtd,
            credentials: 'include',
            headers: headers,
            body: bodyStr || undefined,
            signal: ctrl.signal,
          });
          return r;
        } finally {
          clearTimeout(timer);
        }
      };

      let proof = await getProof();
      if (!proof) return { ok: false, error: 'no-proof' };
      let r = await doFetch(proof);
      // proof 失效 → 重置重取一弊再试一次
      if (r.status === 403) {
        const probe = await r.clone().text();
        if (/REQUEST_SIGNATURE_INVALID/.test(probe)) {
          window[API_PROOF_KEY] = null;
          proof = await getProof();
          if (!proof) return { ok: false, error: 'no-proof' };
          r = await doFetch(proof);
        }
      }
      return { ok: r.ok, status: r.status, body: await r.text() };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  // 生命后台 reelax-api 消息，返回 { ok, status, body, error }
  try {
    window.browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg || msg.type !== 'reelax-api') return; // 不动
      if (typeof msg.path !== 'string') { sendResponse({ ok: false, status: 0, error: 'bad-path' }); return true; }
      _reelaxSignedFetch(msg.path, msg.method, msg.body)
        .then((r) => sendResponse(r))
        .catch((e) => sendResponse({ ok: false, status: 0, error: String(e) }));
      return true; // 异步 sendResponse
    });
  } catch (e) { console.warn('[Reelax] 注册 reelax-api handler 失败:', e); }

  // 转发后台「天气非最优→改去天气最优点」指令到页面主世界聚合.js：
  // monitor.js 拦截开增益后，经本 handler → window.postMessage({__reelaxSwitchTo}) → 聚合.js 监听并执行切图。
  try {
    window.browser.runtime.onMessage.addListener((msg) => {
      if (!msg || msg.type !== 'reelax-auto-switch-to' || !msg.biomeId) return;
      try { window.postMessage(Object.assign({ __reelaxSwitchTo: true }, msg), '*'); } catch (_e) {}
    });
  } catch (e) { console.warn('[Reelax] 注册 reelax-auto-switch-to handler 失败:', e); }
})();

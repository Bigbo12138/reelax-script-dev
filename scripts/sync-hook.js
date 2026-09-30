// sync-hook.js —— 注入到 reelax.cn 页面【主世界】的响应捕获脚本
//
// 背景：Firefox 版用 webRequest.filterResponseData 读取 fishing/sync | state 响应体，
// 但在 Chrome MV3 下该 API 不可用，导致弹窗「游戏状态」全部没数据。
// 本脚本在主世界包装 window.fetch 与 XMLHttpRequest，捕获 reelax.cn 的
//   /api/fishing/sync 和 /api/fishing/state 响应。
// 捕获到的响应体通过两条通道交给扩展：
//   a) sessionStorage['reelax_sync_capture']（主推，Chrome content script 的隔离世界
//      与主世界共享同源 localStorage/sessionStorage，content script 轮询读取，最稳）；
//   b) window.postMessage(__reelaxSyncCapture)（保留，兼容/备用）。
//
// 说明：
//   · 只在命中路径时才读取，其余请求零开销、不穿透。
//   · 不修改请求/响应本身，保证游戏前端行为不受影响。
//   · content script 读取键后会用 'reelax_sync_consumed' 回收，hook 据此决定是否写新值。

(function () {
  'use strict';

  var SYNC_PATHS = [
    '/api/fishing/sync',
    '/api/fishing/state',
  ];

  var STORE_KEY = 'reelax_sync_capture';
  var CONSUMED_KEY = 'reelax_sync_consumed';

  function isSyncUrl(url) {
    if (typeof url !== 'string' || !url) return false;
    // 兼容绝对与相对路径
    var path;
    try { path = new URL(url, location.href).pathname; } catch (e) { return false; }
    return SYNC_PATHS.some(function (p) { return path.indexOf(p) === 0; });
  }

  function emit(url, text) {
    if (!text) return;
    try {
      // 通道 a：写 sessionStorage（content script 轮询读取）
      var consumed = false;
      try { consumed = sessionStorage.getItem(CONSUMED_KEY) === '1'; } catch (e) {}
      if (!consumed) {
        // content script 尚未消费上一份，直接覆盖为最新（丢掉旧的没关系，保持最新即可）
        try { sessionStorage.setItem(STORE_KEY, JSON.stringify({ at: Date.now(), url: url, text: text })); } catch (e) {}
      }
    } catch (e) { /* 忽略 */ }
    try {
      // 通道 b：postMessage
      var msg = { __reelaxSyncCapture: true, url: url, text: text };
      window.postMessage(msg, '*');
    } catch (e) { /* 忽略 */ }
  }

  // ---- 包装 window.fetch ----
  var origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function (input, init) {
      var url = (typeof input === 'string') ? input
        : (input && input.url ? input.url : '');
      var p = origFetch.apply(this, arguments);
      if (!isSyncUrl(url)) return p;
      // 异步读取响应体克隆（不阻塞/不影响原响应）
      p.then(function (res) {
        try {
          if (!res || typeof res.clone !== 'function') return;
          res.clone().text().then(function (text) {
            if (text) emit(url, text);
          }).catch(function () { /* 忽略 */ });
        } catch (e) { /* 忽略 */ }
      }).catch(function () { /* 网络失败忽略 */ });
      return p;
    };
  }

  // ---- 包装 XMLHttpRequest ----
  var origXhrOpen = XMLHttpRequest.prototype.open;
  var origXhrSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__reelaxHookedUrl = (typeof url === 'string') ? url : '';
    return origXhrOpen.apply(this, arguments);
  };
  var origXhrAdd = XMLHttpRequest.prototype.addEventListener;
  // 保留原始 addEventListener 能力，额外监听 load 捕获响应文本
  XMLHttpRequest.prototype.send = function () {
    var self = this;
    try { self.addEventListener('load', onLoad); } catch (e) {}
    return origXhrSend.apply(this, arguments);
  };
  function onLoad() {
    var self = this;
    var url = self.__reelaxHookedUrl || '';
    if (!isSyncUrl(url)) return;
    try {
      var text = typeof self.responseText === 'string' ? self.responseText : '';
      if (text) emit(url, text);
    } catch (e) { /* 忽略 */ }
  }

  // 立即运行的守卫：避免重复注入（页面被多次注入时）
  if (window.__reelaxSyncHookInstalled) return;
  window.__reelaxSyncHookInstalled = true;
})();
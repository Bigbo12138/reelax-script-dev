// chrome-polyfill.js —— 把 Firefox 风格的 `browser.*`（Promise 版）桥接为 Chrome 的 `chrome.*`
//
// 用途：本扩展原为 Firefox（browser.*，全部返回 Promise）编写。Chrome 的 chrome.* 是回调
// 风格，且 Manifest V3 后台是 Service Worker（无 window、多脚本需共享全局）。
// 本文件：
//   1) 在 Service Worker 里 `self.window = self`，让后台各模块原有的 `window.xxx` 全局变量
//      （__bridgeStatus / __monitorStatus / ReelaxApi / DomFallback 等）落在同一全局作用域，
//      多模块可互相读写。
//   2) 提供 `browser` 命名空间，把常用 chrome.* 回调 API 包装成 Promise。
//   3) 把 browser.tabs.executeScript({code}) 桥接到 chrome.scripting.executeScript
//      （用 async func + new Function 执行字符串代码；Chrome 会 await 该 async 函数的返回 Promise）。
//   4) browser.webRequest 里 Chrome MV3 不存在的能力（filterResponseData / blocking）明确退化为空。
//
// 引入方式：
//   - 后台 Service Worker 入口：importScripts('chrome-polyfill.js');
//   - 扩展页面（popup/options）：<script src="chrome-polyfill.js"></script>

(function () {
  'use strict';

  var G = (typeof self !== 'undefined') ? self : (typeof window !== 'undefined' ? window : globalThis);

  // ---- Service Worker 兼容：让后台模块用 window.* 读写全局 ----
  if (typeof G.window === 'undefined') {
    try { G.window = G; } catch (e) { /* 只读全局忽略 */ }
  }

  var CHROME = (typeof chrome !== 'undefined') ? chrome : null;
  if (!CHROME) { G.browser = {}; return; }

  // ---- 通用：不传回调时返回 Promise ----
  function wrapMethod(raw, fn) {
    return function () {
      var args = Array.prototype.slice.call(arguments);
      if (typeof args[args.length - 1] === 'function') {
        // 调用方自带回调：原样透传（少见，兼容）
        return fn.apply(raw, args);
      }
      return new Promise(function (resolve, reject) {
        args.push(function (result) {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message || 'chrome API error'));
          } else {
            resolve(result);
          }
        });
        try { fn.apply(raw, args); } catch (e) { reject(e); }
      });
    };
  }

  // ---- 组装 browser 命名空间 ----
  var browser = {};

  // ---- 同步 Chrome API（返回值、无回调、不可 promisify）----
  // 这些 API 直接返回结果而非走回调，promisify 会因追加回调参数而报
  // "No matching signature"。故原样暴露。
  var SYNC_API = {
    runtime: { getURL: 1, getManifest: 1, id: 1, getBackgroundPage: 0 },
    extension: { getURL: 1, getBackgroundPage: 0, inIncognitoContext: 1, lastError: 1 },
  };

  function isSyncFunction(ns, key) {
    var s = SYNC_API[ns];
    if (!s || !(key in s)) return false;
    // 值=1 强制同步；=0 由实现自行处理（不在这里包裹）
    return true;
  }

  function buildNamespace(name) {
    var raw = CHROME[name];
    if (!raw) return {};
    var ret = {};
    Object.keys(raw).forEach(function (key) {
      var value = raw[key];
      if (typeof value === 'function') {
        // 事件对象（addListener/removeListener）保持原生（Chrome 事件不能包裹成 Promise）
        if (value.addListener) { ret[key] = value; return; }
        // 同步 API 不包裹（getURL 等），否则追加回调参数会报 No matching signature
        if (isSyncFunction(name, key)) { ret[key] = value; return; }
        ret[key] = wrapMethod(raw, value);
      } else if (value && typeof value === 'object' && value.addListener) {
        ret[key] = value;
      } else {
        ret[key] = value;
      }
    });
    return ret;
  }

  ['runtime', 'storage', 'tabs', 'webRequest', 'downloads', 'extension'].forEach(function (n) {
    if (CHROME[n]) browser[n] = buildNamespace(n);
  });

  // ---- storage.local / storage.session 是嵌套命名空间，需递归 promisify ----
  if (CHROME.storage) {
    ['local', 'session', 'sync'].forEach(function (area) {
      if (CHROME.storage[area]) {
        var api = {};
        Object.keys(CHROME.storage[area]).forEach(function (key) {
          var value = CHROME.storage[area][key];
          if (typeof value === 'function') {
            if (value.addListener) { api[key] = value; return; }
            api[key] = wrapMethod(CHROME.storage[area], value);
          } else if (value && typeof value === 'object' && value.addListener) {
            api[key] = value;
          } else {
            api[key] = value;
          }
        });
        if (!browser.storage) browser.storage = {};
        browser.storage[area] = api;
      }
    });
    if (!browser.storage.onChanged) browser.storage.onChanged = CHROME.storage.onChanged;
  }

  // ---- tabs.executeScript: 字符串代码 → chrome.scripting ----
  // Firefox 调用形式：browser.tabs.executeScript(tabId, { code, runAt, ... })；返回 [result]
  // Chrome MV3 用 chrome.scripting.executeScript({ target, func, args, world })，不直接支持
  // 字符串代码。这里用 async func + new Function(code) 执行，Chrome 会 await async 函数，
  // 从而能拿到注入 IIFE 返回的对象（与 Firefox 语义一致）。
  if (CHROME.scripting && CHROME.scripting.executeScript) {
    if (browser.tabs.executeScript) {
      // 覆盖默认包装（默认包装会直接调 chrome.tabs.executeScript 回调，但 MV3 无此 API）
      var _origExecuteScript = browser.tabs.executeScript;
    }
    browser.tabs.executeScript = function (tabId, details) {
      var id = (typeof tabId === 'number') ? tabId : (tabId && (tabId.tabId || tabId.id));
      details = details || {};
      var target = { tabId: id };
      // 若传入的是 { tabId, file } 对象形式
      if (details.file) {
        // file 形式：直接用 files 注入
        var optsFile = {
          target: target,
          files: [details.file],
          world: (details.world || 'ISOLATED'),
        };
        if (details.runAt) optsFile.injectImmediately = (details.runAt === 'document_start');
        return new Promise(function (resolve, reject) {
          CHROME.scripting.executeScript(optsFile, function (res) {
            if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
            resolve((res || []).map(function (r) { return r.result; }));
          });
        });
      }
      // code 形式：用 new Function 执行并 await
      var code = details.code || '';
      var runAt = details.runAt;
      var asyncFunc = async function (src) {
        // code 通常是 (async()=>{...})() 自调用表达式；new Function('return ('+src+')')() 返回其 Promise
        var fn = new Function('return (' + src + ');');
        return await fn();
      };
      var injection = { target: target, func: asyncFunc, args: [code], world: 'ISOLATED' };
      // executeScript 无 runAt 的直接等价；document_start 无法保证，忽略即可（文档完全加载后注入不会有影响）
      return new Promise(function (resolve, reject) {
        CHROME.scripting.executeScript(injection, function (res) {
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          resolve((res || []).map(function (r) { return r.result; }));
        });
      });
    };
  } else if (window.chrome && chrome.scripting && typeof chrome.scripting.executeScript === 'function') {
    // 其它分支……
  } else {
    if (!browser.tabs) browser.tabs = {};
    browser.tabs.executeScript = function () {
      return Promise.reject(new Error('executeScript 不可用'));
    };
  }

  // ---- runtime 补充：getBackgroundPage（MV3 返回 Service Worker 全局） ----
  if (CHROME.runtime) {
    if (!browser.runtime.getBackgroundPage) {
      browser.runtime.getBackgroundPage = function () {
        return new Promise(function (resolve) {
          try {
            if (CHROME.runtime.getBackgroundPage) {
              CHROME.runtime.getBackgroundPage(function (bg) { resolve(bg || G); });
            } else {
              resolve(G);
            }
          } catch (e) { resolve(G); }
        });
      };
    }
    if (!browser.runtime.getURL) {
      browser.runtime.getURL = function (p) { return CHROME.runtime.getURL(p); };
    }
  }

  // ---- 写入全局，供所有后台模块 / 页面使用 ----
  G.browser = browser;
  G.chrome = CHROME;
})();
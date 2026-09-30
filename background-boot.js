// background-boot.js —— Chrome MV3 Service Worker 入口
//
// Firefox 版用 manifest 的 background.scripts 在同一个持久后台页面里顺序载入多个脚本，
// 它们共享 window 全局（window.__bridgeStatus / window.ReelaxApi / window.DomFallback /
// window.__monitorStatus 等）。Chrome MV3 后台只能有一个 Service Worker，且没有 window。
//
// 这里：
//   1) 引入 chrome-polyfill.js：提供 browser.*（Promise）桥、并把 self.window 指向 SW 全局，
//      使各模块的 window.xxx 仍能共享。
//   2) 按与原 manifest 相同的顺序 importScripts 各模块：background → domclick → api → bridge → monitor。
//
// 各模块内部必须用经典脚本的全局共享方式（const/let 在 importScripts 里共享同一个全局词法作用域）——
// importScripts 在 SW 全局作用域内执行，顶层 let/const/function 会互相可见，与原后台页行为一致。

importScripts(
  'chrome-polyfill.js',
  'background.js',
  'domclick.js',
  'api.js',
  'bridge.js',
  'monitor.js'
);
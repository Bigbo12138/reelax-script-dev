// background.js —— Reelax 助手后台逻辑
//
// 职责：
//   1. 浏览器启动时自动打开目标网站（可在设置中关闭）。
//   2. 接收 content script(injector.js) 的 reelax-run-script 消息，用 chrome.scripting
//      executeScript({world:'MAIN'}) 注入核心/可选 userscript（CSP 免疫、Fire-and-forget）。
//   3. 可选的「自动刷新」：每隔 N 分钟自动刷新已打开的目标标签页。
//   4. 自定义代码（customCode）也经 chrome.scripting 主世界注入。
//
// 脚本注入统一由 injector.js（content script）经 reelax-run-script 触发，后台不再央接
// tab 加载去 loadScriptText + tabs.executeScript（Chrome 会被 CSP 拦截，见注释）。

const DEFAULTS = {
  targetUrl: 'https://reelax.cn/',
  autoOpenOnStartup: true,
  scriptFiles: [], // 额外脚本（聚合/登录为核心脚本，由 manifest 注入）
  customCode: '',
  autoRefreshMin: 0,
};

async function getConfig() {
  const stored = await browser.storage.local.get(DEFAULTS);
  return { ...DEFAULTS, ...stored };
}

function sameOrigin(url, target) {
  try {
    return new URL(url).origin === new URL(target).origin;
  } catch (e) {
    return false;
  }
}

// tabId -> 上一次注入时使用的 url，避免同一页面重复注入
const lastInjected = new Map();
let refreshTimer = null;

// 核心/可选脚本统一由 content script（injector.js）经 reelax-run-script 消息注入（CSP 免疫、
// world:'MAIN'）。原 Firefox 版的「后台 loadScriptText + tabs.executeScript({code})」在 Chrome 会
// 被页面 CSP 拦截且 tabs.executeScript 无法拿到注入结果，故此处不再由后台注入脚本。
// 仅保留自定义代码（customCode）支持，且改为走 chrome.scripting.executeScript 主世界注入。
async function injectInto(tabId, url) {
  const cfg = await getConfig();
  if (cfg.customCode && cfg.customCode.trim()) {
    try {
      await new Promise((resolve, reject) => {
        chrome.scripting.executeScript({
          target: { tabId },
          world: 'MAIN',
          func: new Function(cfg.customCode.trim()),
        }).then(resolve).catch(reject);
      });
      console.log('[Reelax 助手] 已注入自定义代码');
    } catch (e) {
      console.error('[Reelax 助手] 自定义代码注入失败:', e);
    }
  }
  lastInjected.set(tabId, url);
}

browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  const url = changeInfo.url || tab.url;
  if (!url) return;

  getConfig().then((cfg) => {
    if (!sameOrigin(url, cfg.targetUrl)) return;
    if (lastInjected.get(tabId) === url) return; // 同一页面已注入，跳过
    injectInto(tabId, url);
  });
});

browser.tabs.onRemoved.addListener((tabId) => {
  lastInjected.delete(tabId);
});

async function openTarget() {
  const cfg = await getConfig();
  if (!cfg.autoOpenOnStartup) return;
  const pattern = cfg.targetUrl + '*';
  let existing = [];
  try {
    existing = await browser.tabs.query({ url: pattern });
  } catch (e) {
    console.warn('[Reelax 助手] 查询标签页失败:', e);
  }
  if (existing.length === 0) {
    await browser.tabs.create({ url: cfg.targetUrl });
  }
}

browser.runtime.onStartup.addListener(openTarget);
browser.runtime.onInstalled.addListener(() => {
  // 首次安装时也打开一次，方便用户立即看到效果
  openTarget();
});

// ---------- 自动关闭非目标页面 ----------
// 只保留：目标网站(含其同站点子域，如登录跳转)、扩展自身页面(chrome-extension://)、
// 系统 about 页(about:addons/about:debugging 等)。空白/新标签页及其它网站标签页自动关闭。
const AUTO_CLOSE_OTHER_TABS = false; // 改为 true 可开启
const CHROME_EXT_SCHEME = 'chrome-extension://'; // Chrome/Edge 扩展页面协议
const EMPTY_PAGES = new Set([
  'about:blank',
  'about:newtab',
  'about:home',
  'about:start',
]);

// 是否为同一注册域名（reelax.cn 与 auth.abang666.com 算同一站点）
function sameSite(url, target) {
  try {
    const regDomain = (h) => h.split('.').slice(-2).join('.');
    return regDomain(new URL(url).hostname) === regDomain(new URL(target).hostname);
  } catch (e) {
    return false;
  }
}

async function maybeCloseTab(tab) {
  if (!AUTO_CLOSE_OTHER_TABS) return;
  if (!tab || tab.id == null || tab.id === browser.tabs.TAB_ID_NONE) return;
  const url = (tab.url || '').trim();
  if (!url) return; // 还没有 URL，等 onUpdated

  const cfg = await getConfig();
  if (sameOrigin(url, cfg.targetUrl)) return; // 目标页保留
  if (sameSite(url, cfg.targetUrl)) return;   // 同站点子域(登录/认证跳转)保留
  if (url.startsWith(CHROME_EXT_SCHEME)) return; // 扩展设置页等保留

  const scheme = url.split(':')[0];
  if (scheme === 'about') {
    if (EMPTY_PAGES.has(url)) browser.tabs.remove(tab.id);
    return; // 非空 about 页（addons/debugging 等）保留
  }
  // 系统/扩展内部页面保留
  if (scheme === 'chrome' || scheme === CHROME_EXT_SCHEME.replace(':', '')) return;

  // 其它任何页面（http/https/file、内部 IP 地址页如 0.0.2.208 等）一律自动关闭
  browser.tabs.remove(tab.id);
}

// 新标签页延迟 3 秒再判定，避免误关刚创建、还没导航到目标地址的标签页
function scheduleMaybeClose(tabId) {
  setTimeout(async () => {
    try {
      const tab = await browser.tabs.get(tabId);
      await maybeCloseTab(tab);
    } catch (e) {
      /* 标签页已关闭 */
    }
  }, 3000);
}

browser.tabs.onCreated.addListener((tab) => scheduleMaybeClose(tab.id));
browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.status === 'complete') maybeCloseTab(tab);
});

// ---------- 屏蔽 Cloudflare 分析信标 ----------
// 原 Firefox 版用 webRequest + "blocking" 拦截 static.cloudflareinsights.com。
// Chrome MV3 的 webRequestBlocking 仅对采用企业策略安装的扩展开放，普通扩展不可用，
// 故该拦截在 Chrome 版取消（信标仅用于访问统计，不影响游戏功能）。

// ---------- 自动保存控制台日志到 下载目录/logs/ ----------
// 由页面主世界的「日志收集.js」定期通过 postMessage 触发，
// 经 injector.js 转发到这里，静默下载到 <下载目录>/logs/reelax-<时间戳>.log。
browser.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.type !== 'reelax-save-log') return;
  const text = String(msg.text || '');
  if (!text) return;
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  // 文件名：logs/reelax-YYYYMMDD-HHMMSS.log（本地时间）
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const filename = 'logs/reelax-' + stamp + '.log';
  return browser.downloads
    .download({ url, filename, saveAs: false })
    .then(() => ({ ok: true }))
    .catch((e) => {
      console.error('[Reelax 助手] 保存日志失败:', e);
      return { ok: false };
    })
    .finally(() => setTimeout(() => URL.revokeObjectURL(url), 30000));
});

async function setupRefresh() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
  const cfg = await getConfig();
  const min = Number(cfg.autoRefreshMin) || 0;
  if (min <= 0) return;
  refreshTimer = setInterval(async () => {
    const c = await getConfig();
    const tabs = await browser.tabs.query({ url: c.targetUrl + '*' });
    for (const t of tabs) {
      browser.tabs.reload(t.id);
    }
  }, min * 60 * 1000);
}

browser.storage.onChanged.addListener((_changes, area) => {
  if (area === 'local') setupRefresh();
});

setupRefresh();

// ---------- 主世界核心脚本注入（CSP 免疫） ----------
// injector.js（content script）请求按名注入 scripts/ 下的泛赛脚本。它用
// chrome.scripting.executeScript({world:'MAIN', files}) 在页面主世界执行，不受页面
// CSP 约束、Fire-and-forget（无需返回结果）。sender.tab.id 给出目标标签页。
browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'reelax-run-script') return;
  const tabId = sender && sender.tab && sender.tab.id;
  // 只移除路径分隔和 ".."（防目录穿越），保留合法文件名（含 .js 扩展名）
  const name = String(msg.name || '').replace(/\.\./g, '').replace(/[/\\]/g, '');
  console.log('[Reelax 助手][SW] 收到 reelax-run-script:', name, 'tabId=', tabId);
  if (!tabId || !name) { sendResponse({ frames: [] }); return true; }
  const file = 'scripts/' + name;
  chrome.scripting.executeScript({
    target: { tabId, allFrames: false },
    files: [file],
    world: 'MAIN',
    injectImmediately: true,
  })
    .then((res) => {
      console.log('[Reelax 助手][SW] 注入成功:', name, 'frames=', res && res.length);
      sendResponse({ frames: (res && res.length) ? res : [] });
    })
    .catch((e) => {
      console.error('[Reelax 助手][SW] 注入失败:', name, e && e.message ? e.message : e);
      sendResponse({ frames: [], error: String(e && e.message || e) });
    });
  return true; // 异步 sendResponse
});

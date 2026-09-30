// domclick.js —— 扩展后台「DOM 兜底点击」机制
//
// 背景：部分写操作通过扩展后台 ReelaxApi 直连时，若服务端返回
//   INTERNAL_ERROR（"服务器暂时无法完成请求，请稍后重试"），直连重试往往同样失败，
//   但页面前端自己点击按钮发起的请求（带完整签名/Referer/前端上下文）有时能成功。
//   因此：当扩展后台的写操作返回 INTERNAL_ERROR 时，尝试在游戏页面 DOM 里匹配对应按钮并点击，
//   用「页面前端真实点击」兜底完成该操作。
//
// 架构：
//   · 本文件是扩展后台脚本（manifest background.scripts 的一员），**不是页面注入脚本**。
//   · 它不直接访问页面 DOM（background 无 DOM），而是用 browser.tabs.executeScript 把一段
//     点击代码注入到 reelax 游戏页面主世界执行。
//   · api.js 在所有写操作（POST/PUT/DELETE）返回 INTERNAL_ERROR 时调用 DomFallback.onApiError()。
//
// 用法（供 api.js 调用）：
//   DomFallback.onApiError({ path, method, body, status, bodyText, at });
//
// 扩展后台脚本加载顺序（manifest.json）：
//   background.js → domclick.js → api.js → bridge.js → monitor.js
//   （domclick.js 必须在 api.js 之前加载，api.js 才能调用到 DomFallback）

(function () {
  'use strict';

  // 该机制总开关；false 则所有 onApiError 直接返回，不尝试 DOM 点击。
  const ENABLED = true;

  // 两次同接口 DOM 兜底之间的最小间隔（毫秒），避免错误持续时反复点击刷屏。
  const THROTTLE_MS = 60 * 1000; // 1 分钟

  // 一次 DOM 点击后，相同 (path+method) 的兜底冷却（毫秒）。点击后给前端留出处理时间。
  const CLICK_COOLDOWN_MS = 3 * 60 * 1000; // 3 分钟

  // ---------------------------------------------------------------------------
  // 接口 → 按钮 映射表（可按需扩充）
  // 键：METHOD 路径（如 'POST /api/fishing/refill'）
  // 值：{ selector, match?, beforeClick?, maxClicks? }
  //   selector      : 在页面匹配要点击的按钮/元素（document.querySelector 选择器）
  //   match         : 可选，额外校验函数（字符串形式，注入页面后 eval）。入参 el=匹配到的元素，
  //                   返回 true 才点击。用于确认按钮状态（如"补满至"、未禁用、标题匹配）。
  //   beforeClick   : 可选，字符串形式的 js 片段，在点击前于页面主世界执行（如先滚动到按钮、
  //                   打开对应弹窗）。不返回或返回任意值。
  //   extraConfirm  : 可选，点击后是否可能有二次确认弹窗。true 时点击后会尝试匹配
  //                   页面上的「确认」类按钮再点一次（自动确认弹窗）。
  //   maxClicks     : 可选，单次兜底最多点击次数（默认 1）。
  // ---------------------------------------------------------------------------
  const RULES = {
    // 补满次数 / 补杆（钓鱼顶部栏按钮）
    // 该按钮点击即触发前端 refill（聚合.js 也是这么做的，无需二次确认）。
    // aria-label / title 形如 "444 / 456 杆，补满至 456 杆"。
    'POST /api/fishing/refill': {
      selector: 'button.topbar-fishing-status',
      match: 'function(el){ return !!el && !el.disabled && /补满至|补满次数/.test((el.title||"")+" "+(el.getAttribute("aria-label")||"")); }',
    },
  };

  // 最近一次各接口的兜底时间（节流/冷却）
  const lastAttemptAt = {};  // key → 上次尝试时间戳
  const lastClickAt = {};    // key → 上次实际点击时间戳

  // 公开状态（供 popup / monitor 读取）
  const status = {
    enabled: ENABLED,
    lastError: null,
    lastEvent: null, // { path, method, ruleKey, action:'matched'|'clicked'|'throttled'|'no-rule'|'no-tab'|'click-failed', at }
    clickCount: 0,
  };

  // ---- 内部：把一条规则转成在页面主世界执行的点击代码 ----
  // 返回一个字符串形式的 async 函数体，注入页面后执行；返回结果对象。
  // rule 扩展字段（通用点击也复用此逻辑）：
  //   all=true → querySelectorAll 匹配并点击所有元素（默认只点第一个）；
  //   text=<子串> → 仅在匹配元素中筛选其可见文本包含该子串的（不区分大小写）；
  //   其余字段与 RULES 条目一致（match / beforeClick / extraConfirm / maxClicks）。
  function buildClickCode(rule) {
    const selector = rule.selector;
    const matchFn = rule.match || null;
    const beforeClick = rule.beforeClick || null;
    const extraConfirm = rule.extraConfirm === true;
    const maxClicks = rule.maxClicks || 1;
    const all = rule.all === true;
    const text = rule.text || null;

    // 拼接页面内执行的代码
    let code = '(async()=>{';
    code += 'const out={found:false,clicked:false,matched:false,reason:""};';
    code += 'try{';
    if (all) {
      // 多元素模式：匹配所有元素，逐个筛选后点击
      code += 'const els=document.querySelectorAll(' + JSON.stringify(selector) + ');';
      code += 'if(!els||!els.length){out.reason="no-element";return out;}';
      code += 'out.found=true;';
      code += 'out.total=els.length;';
      code += 'let anyMatch=false,anyDisabled=false,clickedCount=0;';
      code += 'for(let idx=0;idx<els.length;idx++){';
      code += 'const el=els[idx];';
      // 文本筛选
      if (text) {
        code += 'let t=(el.textContent||"").trim().toLowerCase();';
        code += 'if(t.indexOf(' + JSON.stringify(String(text).toLowerCase()) + ')===-1){continue;}';
      }
      // 额外匹配校验
      if (matchFn) {
        code += 'let matched=false;try{matched=' + matchFn + '(el);}catch(e){matched=false;}';
        code += 'if(!matched){continue;}';
      }
      code += 'anyMatch=true;';
      code += 'if(el.disabled){anyDisabled=true;continue;}';
      code += 'try{if(typeof el.scrollIntoView==="function")el.scrollIntoView({block:"center"});}catch(e){}';
      code += 'let c=0;for(let i=0;i<' + maxClicks + ';i++){try{el.click();c++;}catch(e){break;}}';
      code += 'clickedCount+=c;';
      code += '}';
      code += 'out.matched=anyMatch;';
      code += 'out.clicked=clickedCount>0;out.clicks=clickedCount;';
      code += 'if(!anyMatch){out.reason="not-match";return out;}';
      code += 'if(clickedCount===0){out.reason=anyDisabled?"disabled":"no-click";return out;}';
    } else {
      // 单元素模式（原逻辑 + 可选文本筛选）
      code += 'const el=document.querySelector(' + JSON.stringify(selector) + ');';
      code += 'if(!el){out.reason="no-element";return out;}';
      code += 'out.found=true;';
      if (text) {
        code += 'if(((el.textContent||"").trim().toLowerCase().indexOf(' + JSON.stringify(String(text).toLowerCase()) + '))===-1){out.reason="not-match";return out;}';
      }
      // 可选前置脚本（如滚动到元素、打开弹窗）
      if (beforeClick) {
        code += 'try{' + beforeClick + '}catch(e){out.beforeError=String(e);}';
      }
      // 额外匹配校验
      if (matchFn) {
        code += 'let matched=false;try{matched=' + matchFn + '(el);}catch(e){matched=false;}';
        code += 'out.matched=!!matched;';
        code += 'if(!matched){out.reason="not-match";return out;}';
      } else {
        code += 'out.matched=true;';
      }
      code += 'if(el.disabled){out.reason="disabled";return out;}';
      // 可选滚动到元素，确保可见
      code += 'try{if(typeof el.scrollIntoView==="function")el.scrollIntoView({block:"center"});}catch(e){}';
      // 点击（默认一次，支持多次）
      code += 'let clicks=0;';
      code += 'for(let i=0;i<' + maxClicks + ';i++){';
      code += 'try{el.click();clicks++;}catch(e){out.clickError=String(e);break;}';
      code += '}';
      code += 'out.clicked=clicks>0;out.clicks=clicks;';
      // 若有二次确认弹窗，尝试点「确认」
      if (extraConfirm) {
        code += 'await new Promise(r=>setTimeout(r,300));';
        code += 'let cf=document.querySelector("button.primary-button")||document.querySelector("button[class*=confirm]");';
        code += 'if(cf&&!cf.disabled){try{cf.click();out.confirmed=true;}catch(e){}}';
      }
    }
    code += '}catch(e){out.reason="error:"+String(e);}';
    code += 'return out;';
    code += '})()';

    return code;
  }

  // ---- 内部：在游戏页面执行点击 ----
  async function clickInPage(rule, ruleKey) {
    try {
      const tabs = await browser.tabs.query({ url: '*://reelax.cn/*' });
      if (!tabs || !tabs.length) {
        return { ok: false, reason: 'no-tab' };
      }
      const code = buildClickCode(rule);
      const res = await browser.tabs.executeScript(tabs[0].id, { code });
      const out = (res && res[0]) || {};
      return { ok: true, out: out, reason: out.reason || '' };
    } catch (e) {
      return { ok: false, reason: String(e) };
    }
  }

  // ---- 对外入口：api.js 写操作返回 INTERNAL_ERROR 时调用 ----
  async function onApiError(info) {
    if (!ENABLED) return { ok: false, reason: 'disabled' };
    const path = (info && info.path) || '';
    const method = ((info && info.method) || 'GET').toUpperCase();
    // 只对写操作兜底（GET 不点击按钮）
    if (!['POST', 'PUT', 'DELETE', 'PATCH'].includes(method)) {
      return { ok: false, reason: 'read-only' };
    }
    const key = method + ' ' + path;
    const rule = RULES[key];
    if (!rule) {
      status.lastEvent = { path: path, method: method, action: 'no-rule', at: Date.now() };
      return { ok: false, reason: 'no-rule' };
    }
    const now = Date.now();
    // 节流：同接口短时间内不重复尝试
    const lastAttempt = lastAttemptAt[key] || 0;
    if (now - lastAttempt < THROTTLE_MS) {
      status.lastEvent = { path: path, method: method, action: 'throttled', at: now };
      return { ok: false, reason: 'throttled' };
    }
    lastAttemptAt[key] = now;
    // 冷却：刚点击过的接口不立刻再点
    const lastClick = lastClickAt[key] || 0;
    if (now - lastClick < CLICK_COOLDOWN_MS) {
      status.lastEvent = { path: path, method: method, action: 'cooldown', at: now };
      return { ok: false, reason: 'cooldown' };
    }

    const r = await clickInPage(rule, key);
    if (r.ok && r.out && r.out.clicked) {
      lastClickAt[key] = now;
      status.clickCount += 1;
      status.lastEvent = { path: path, method: method, action: 'clicked', out: r.out, at: now };
      status.lastError = null;
      console.log('[DomFallback] 已 DOM 兜底点击:', key, r.out);
      return { ok: true, reason: 'clicked', out: r.out };
    }
    status.lastError = (r && (r.reason || (r.out && r.out.reason))) || 'click-failed';
    status.lastEvent = { path: path, method: method, action: 'click-failed', reason: status.lastError, at: now };
    console.warn('[DomFallback] DOM 兜底点击失败:', key, r);
    return { ok: false, reason: status.lastError, out: r.out };
  }

  // ---- 通用点击：按任意 selector/文本/选项，在游戏页面主世界点击元素 ----
  // 供 monitor.js / 其它扩展后台脚本按需调用（“以后想点啥就点啥”）。
  // 用法：
  //   DomFallback.click('button.topbar-fishing-status')                 // 按 selector 点第一个匹配项
  //   DomFallback.click({ selector: 'a[href="/events?event=world-boss"]', text: '前往围猎', all: true })
  //   DomFallback.click({ selector: '.foo button', all: true, extraConfirm: true })
  // opts 可为字符串（当作 selector）或对象 { selector, text?, all?, match?, beforeClick?, extraConfirm?, maxClicks? }
  // 返回 { ok, reason?, out? }；out.clicked=true 表示至少点到一个元素。
  async function click(opts) {
    if (!ENABLED) return { ok: false, reason: 'disabled' };
    let rule;
    if (typeof opts === 'string') {
      rule = { selector: opts };
    } else if (opts && typeof opts === 'object') {
      rule = {
        selector: opts.selector,
        match: opts.match || null,
        beforeClick: opts.beforeClick || null,
        extraConfirm: opts.extraConfirm === true,
        maxClicks: opts.maxClicks || 1,
        all: opts.all === true,
        text: opts.text || null,
      };
    } else {
      return { ok: false, reason: 'bad-arg' };
    }
    if (!rule.selector) return { ok: false, reason: 'no-selector' };

    const key = 'CLICK ' + rule.selector;
    const r = await clickInPage(rule, key);
    if (r.ok && r.out && r.out.clicked) {
      status.clickCount += 1;
      status.lastEvent = { action: 'click', selector: rule.selector, out: r.out, at: Date.now() };
      status.lastError = null;
      console.log('[DomFallback] 通用点击:', rule.selector, r.out);
      return { ok: true, reason: 'clicked', out: r.out };
    }
    status.lastError = (r && (r.reason || (r.out && r.out.reason))) || 'click-failed';
    status.lastEvent = { action: 'click-failed', selector: rule.selector, reason: status.lastError, at: Date.now() };
    return { ok: false, reason: status.lastError, out: r.out };
  }

  // ---- 挂到全局，供 api.js / monitor.js 使用 ----
  window.DomFallback = {
    onApiError: onApiError,
    click: click,
    status: status,
    RULES: RULES,
  };
  // 同时挂到 __monitorStatus（popup 读取 status 的对象里）
  try {
    if (!window.__monitorStatus) window.__monitorStatus = {};
    window.__monitorStatus.domFallback = status;
  } catch (e) { /* ignore */ }
})();

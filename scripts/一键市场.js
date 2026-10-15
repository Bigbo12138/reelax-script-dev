// ==UserScript==
// @name         Reelax 一键市场（批量挂单出售）
// @namespace    reelax-oneclick-market
// @version      1.4.0
// @description  在背包「渔获」页的「锁定专精鱼」按钮后加「一键市场」按钮。点击后按你的设定
//               （品级多选 / 单个鱼数量下限 / 市场最低卖价±金额）批量筛选背包鱼，并按该价格挂单出售。
//               面板含「挂单」与「捡漏」两页签：捡漏可查某稀有度（奇异/奥秘）所有鱼的市场最低价并升序列出、点击跳转。
//               非渔获页（钓鱼/市场等）显示左下角悬浮「捡漏」按钮。已整合「最低价检测」与「一键下架非最低价」为单一按钮：
//               点检测扫完切为一键下架，下架完恢复；对已有挂单的鱼会先下架旧单再合并重挂一单；
//               达到活动挂单数量上限（market/config，含服务端 activeOrderCount）时自动停止。
// @match        https://reelax.cn/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  if (window.__reelaxOneClickMarket__) return;
  window.__reelaxOneClickMarket__ = true;

  const TAG = '[一键市场]';
  const RARITY_ORDER = ['common', 'uncommon', 'fine', 'rare', 'epic', 'legendary', 'mythic', 'exotic', 'arcane'];
  const RARITY_CN = { common: '普通', uncommon: '罕见', fine: '精良', rare: '稀有', epic: '史诗', legendary: '传说', mythic: '神话', exotic: '奇异', arcane: '奥秘' };
  const DEFAULT_RARITIES = [];

  // ---------- 签名 API 中继（经 injector.js 页面上下文签名 fetch） ----------
  let _reqSeq = 0;
  const _pending = new Map();
  window.addEventListener('message', (ev) => {
    const d = ev.data;
    if (d && d.__reelaxApiResponse && _pending.has(d.id)) {
      const cb = _pending.get(d.id);
      _pending.delete(d.id);
      cb(d);
    }
  });
  // GET 解析 JSON → { ok, data }；POST/PUT/DELETE 返回原始 { ok, status, body }
  function api(path, method, body) {
    const id = ++_reqSeq;
    const payload = { __reelaxApiRequest: true, id, path, method: method || 'GET', body: (body === undefined ? null : body) };
    if (!window.postMessage) return Promise.resolve({ ok: false, error: 'no-postMessage' });
    window.postMessage(payload, '*');
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { if (_pending.has(id)) { _pending.delete(id); resolve({ ok: false, error: 'api-timeout', path }); } }, 20000);
      _pending.set(id, (r) => { clearTimeout(timeout); resolve(r); });
    });
  }
  async function getJSON(path) {
    const r = await api(path, 'GET', null);
    if (!r || !r.ok) return { ok: false, error: (r && r.error) || r && String(r.status) || 'http' };
    try { return { ok: true, data: JSON.parse(r.body) }; }
    catch (e) { return { ok: false, error: 'parse' }; }
  }
  async function postJSON(path, method, body) {
    const r = await api(path, method || 'POST', body === undefined ? null : body);
    if (!r) return { ok: false, error: 'no-response' };
    if (!r.ok) return { ok: false, status: r.status, body: r.body, error: r.error || 'http' };
    return { ok: true, status: r.status, body: r.body };
  }

  // ---------- 工具 ----------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  function el(id) { return document.getElementById(id); }
  function fmtGold(n) { return (n == null ? '—' : Number(n).toLocaleString() + '金'); }

  // ---------- 状态 ----------
let cfg = null;           // { rarities:[], minQty:Number, priceAdj:Number(±金额) }
let running = false;
let bargainState = null;  // 捡漏扫描结果 { sorted:[{fishId,name,mapTag,biomeId,ask,bid}], checked:Set<fishId>, render:fn }

  // ---------- 配置持久化（localStorage：品级/数量/±金额，避免每次重新填写） ----------
  const STORAGE_KEY = 'r1cm-cfg';
  function loadCfg() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const o = JSON.parse(raw);
        const rars = Array.isArray(o.rarities) ? o.rarities.filter((r) => RARITY_ORDER.includes(r)) : [];
        return {
          rarities: rars.length ? rars : null,
          minQty: (Number(o.minQty) >= 0 ? Number(o.minQty) : null),
          adj: (Number(o.adj) || Number(o.adj) === 0 ? Number(o.adj) : null),
          minPrice: (Number(o.minPrice) >= 0 ? Number(o.minPrice) : null),
          minPriceLimit: o.minPriceLimit === true,
        };
      }
    } catch (_e) {}
    return {};
  }
  function saveCfg(c) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ rarities: c.rars, minQty: c.minQty, adj: c.adj, minPrice: c.minPrice, minPriceLimit: c.minPriceLimit })); } catch (_e) {}
  }
  // 每次打开面板时从 localStorage 读取最新值，避免读到旧快照
  function savedCfg() { return loadCfg(); }

  // ---------- 捡漏结果持久化（localStorage，缓存 30 分钟；关窗重开不丢，超时清空） ----------
  const BARGAIN_CACHE_KEY = 'r1cm-bargain-cache';
  const BARGAIN_CACHE_TTL = 30 * 60 * 1000;
  // 专精鱼 fishId 集合持久化（localStorage）。捡漏恢复时本地秒读即可标 * / 「仅拉取专精鱼」，
  // 不必等 /api/mastery 网络往返，也不因该请求失败而丢失专精鱼标记。
  const MASTERY_CACHE_KEY = 'r1cm-mastery-fish';
  const MASTERY_CACHE_TTL = 30 * 60 * 1000;
  function saveMasteryIds(ids) {
    try { localStorage.setItem(MASTERY_CACHE_KEY, JSON.stringify({ ts: Date.now(), ids: Array.isArray(ids) ? ids : [] })); } catch (_e) {}
  }
  // 返回 Set 或 null
  function loadMasteryIds() {
    try {
      const o = JSON.parse(localStorage.getItem(MASTERY_CACHE_KEY) || 'null');
      if (!o || typeof o !== 'object' || !Array.isArray(o.ids) || o.ids.length === 0) return null;
      if (Date.now() - o.ts > MASTERY_CACHE_TTL) return null;
      return new Set(o.ids);
    } catch (_e) { return null; }
  }
  // ---------- 捡漏筛选/勾选控件持久化（localStorage，关窗重开恢复） ----------
  const BARGAIN_CFG_KEY = 'r1cm-bargain-cfg';
  function saveBargainCfg() {
    try {
      const getCb = (id) => { const e = el(id); return e ? e.checked : false; };
      const getVal = (id, dft) => { const e = el(id); if (!e) return dft; const n = Number(e.value); return (e.value !== '' && !isNaN(n)) ? n : dft; };
      localStorage.setItem(BARGAIN_CFG_KEY, JSON.stringify({
        rarity: (el('rlb-tab-rarity') ? el('rlb-tab-rarity').value : ''),
        biome: (el('rlb-tab-biome') ? el('rlb-tab-biome').value : ''),
        mastery: getCb('rlb-tab-mastery'),
        usebid: getCb('rlb-tab-usebid'),
        adjust: getVal('rlb-bid-adjust', 1),
        qty: getVal('rlb-bid-qty', 1),
        masterymax: getCb('rlb-bid-masterymax'),
      }));
    } catch (_e) {}
  }
  function loadBargainCfg() {
    try {
      const o = JSON.parse(localStorage.getItem(BARGAIN_CFG_KEY) || 'null');
      if (!o || typeof o !== 'object') return null;
      return o;
    } catch (_e) { return null; }
  }
  function restoreBargainCfg() {
    const o = loadBargainCfg();
    if (!o) return;
    const setCb = (id, v) => { const e = el(id); if (e) e.checked = !!v; };
    const setVal = (id, v) => { const e = el(id); if (e && v != null) e.value = v; };
    if (o.rarity && el('rlb-tab-rarity')) {
      // 仅当持久化品级仍在选项里才恢复（下拉默认第一项否则）
      const keys = objBargainRarities().map((r) => r.key);
      if (keys.includes(o.rarity)) el('rlb-tab-rarity').value = o.rarity;
    }
    setCb('rlb-tab-mastery', o.mastery);
    setCb('rlb-tab-usebid', o.usebid);
    setVal('rlb-bid-adjust', o.adjust);
    setVal('rlb-bid-qty', o.qty);
    setCb('rlb-bid-masterymax', o.masterymax);
  }

  // 分页拉取「我的鱼挂单」全部页（/api/market/me/orders 用 cursor 翻页，limit 每页上限 100）
  // 返回 { ok, orders:[...], raw, error }；ok=false 时 error 携带首个失败信息
  async function fetchMyFishOrders() {
    const all = [];
    let cursor = null, firstErr = null;
    for (let page = 0; page < 50; page++) { // 防御性上限，避免死循环
      let path = '/api/market/me/orders?assetType=fish&limit=100';
      if (cursor) path += '&cursor=' + encodeURIComponent(String(cursor));
      const mine = await getJSON(path);
      if (mine.ok && mine.data) {
        const orders = Array.isArray(mine.data.orders) ? mine.data.orders : [];
        all.push.apply(all, orders);
        cursor = mine.data.nextCursor; // 服务端在同页返回的下一页游标；无则为 null 结束
        if (!cursor) break;
        await sleep(60);
      } else {
        if (!firstErr) firstErr = { error: mine.error, body: mine.body };
        break;
      }
    }
    return { ok: all.length > 0 || !firstErr, orders: all, raw: all, error: firstErr ? firstErr.error : undefined, body: firstErr ? firstErr.body : undefined };
  }
  function saveBargainCache(rarity, sorted, myBuyIds) {
    try {
      localStorage.setItem(BARGAIN_CACHE_KEY, JSON.stringify({ ts: Date.now(), rarity: rarity, rows: sorted, myBuyIds: myBuyIds }));
    } catch (_e) {}
  }
  // 返回 { rarity, rows, myBuyIds }（未过期）或 null
  function loadBargainCache() {
    try {
      const o = JSON.parse(localStorage.getItem(BARGAIN_CACHE_KEY) || 'null');
      if (!o || typeof o !== 'object' || !Array.isArray(o.rows)) return null;
      if (Date.now() - o.ts > BARGAIN_CACHE_TTL) return null; // 超时视为无缓存
      return { rarity: o.rarity, rows: o.rows, myBuyIds: (Array.isArray(o.myBuyIds) ? o.myBuyIds : null) };
    } catch (_e) { return null; }
  }

  // ---------- 查找「按键」按钮并插入「一键市场」 ----------
  // 注意：只在背包-渔获页的 .inventory-actionbar 内找「锁定专精鱼」锚点。
  // 否则会被专精页等界面的“锁定/专精鱼”按钮误命中（例如 .target-sacrifice-lock）。
  function findMasteryLockBtn(root) {
    root = root || document.body;
    const bar = document.querySelector('.inventory-actionbar');
    if (!bar) return null; // 不在渔获页操作栏，不注入
    const scope = bar;
    const sel = 'button, [role="button"], a, [class*="btn"]';
    const candy = ['锁定专精鱼', '锁定专精', '专精鱼', '锁定'];
    const els = Array.from(scope.querySelectorAll(sel));
    for (const c of candy) {
      const hit = els.find((b) => {
        const t = (b.textContent || b.getAttribute('aria-label') || '').trim();
        return t && t.includes(c);
      });
      if (hit) return hit;
    }
    return null;
  }

  function isFishPage() {
  // 装备页 / 周赛奖励兑换页 不注入：它们导航里常含「背包/渔获/库存」等文案，会被下方宽松判断误命中。
  if (/\/gear(\/|$)/.test(location.pathname)) return false;
  if (/\/tournaments(\/|$)/.test(location.pathname)) return false;
  // 明确的背包/渔获页路由
  if (/\/inventory(\/|$)/.test(location.pathname)
    || /\/bag(\/|$)/.test(location.pathname)
    || /\/storage(\/|$)/.test(location.pathname)) return true;
  // 其它页面：仅当本页真的存在「锁定/专精鱼」锚按钮才注入，避免在装备/周赛兑换等页误装按钮
  return !!(document.body && findMasteryLockBtn());
}

  function ensureButton() {
    if (el('r1cm-btn')) return el('r1cm-btn');
    const anchor = findMasteryLockBtn();
    if (!anchor) return null;
    const btn = document.createElement('button');
    btn.id = 'r1cm-btn';
    btn.type = 'button';
    btn.textContent = '一键市场';
    Object.assign(btn.style, {
      margin: '0 2px', padding: '3px 9px', borderRadius: '4px', border: '1px solid #d97a12',
      background: '#ff8c1a', color: '#fff', fontSize: '12px', cursor: 'pointer',
    });
    btn.addEventListener('click', (e) => { e.stopPropagation(); openPanel(); });
    anchor.parentNode.insertBefore(btn, anchor.nextSibling);
    return btn;
  }

  // ---------- 配置面板 ----------
  let panel = null;
  function openPanel(tab) {
    removePanel();
    const saved = savedCfg(); // 每次打开都重新从 localStorage 读取，保证拿到最新保存值
    panel = document.createElement('div');
    panel.id = 'r1cm-panel';
    panel.dataset.tab = (tab || 'sell');
    // 深色主题（对齐遗物商店 UI）：夜间模式也能看清内容
    Object.assign(panel.style, {
      position: 'fixed', right: '16px', top: '90px', zIndex: '1000000', // 需高于聚合面板(999999)以免被遮挡吞掉点击
      width: '380px', background: '#1e1e24', border: '1px solid #3a3a42', borderRadius: '10px',
      boxShadow: '0 6px 20px rgba(0,0,0,.5)', padding: '14px 16px', fontFamily: 'inherit',
      color: '#e8e8e8',
    });
    const savedRars = (saved.rarities && saved.rarities.length) ? saved.rarities : DEFAULT_RARITIES;
    const rarChips = RARITY_ORDER.map((r) => {
      const checked = savedRars.includes(r);
      return `<label style="margin-right:10px;font-size:13px;display:inline-flex;align-items:center;gap:3px;vertical-align:middle;line-height:1;cursor:pointer;">
        <input type="checkbox" data-rar="${r}" ${checked ? 'checked' : ''} style="cursor:pointer;"/><span>${RARITY_CN[r] || r}</span></label>`;
    }).join('');
    const savedMinQty = (saved.minQty != null) ? saved.minQty : 50;
    const savedAdj = (saved.adj != null) ? saved.adj : -1;
    // 单鱼挂牌价下限（0/空=不限制）：挂单价低于此值则跳过该鱼挂单
    const savedMinPrice = (saved.minPrice != null) ? saved.minPrice : 0;
    // 单鱼挂牌价「不限制」勾选：勾选=禁用挂牌价下限（视为0=不限制）
    const savedMinPriceLimit = saved.minPriceLimit === true;
    // 页签头：挂单 / 捡漏
    const tabHtml = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
        <b style="font-size:14px;">一键市场</b>
        <span id="r1cm-close" style="cursor:pointer;color:#aaa;">✕</span>
      </div>
      <div style="display:flex;gap:6px;margin-bottom:10px;">
        <button type="button" data-tab="sell" style="flex:1;border:1px solid #4a4a52;border-radius:6px;padding:5px 0;font-size:13px;cursor:pointer;">挂单</button>
        <button type="button" data-tab="bargain" style="flex:1;border:1px solid #4a4a52;border-radius:6px;padding:5px 0;font-size:13px;cursor:pointer;">捡漏</button>
      </div>`;
    panel.innerHTML = tabHtml + `<div id="r1cm-tab-sell"></div><div id="r1cm-tab-bargain"></div>`;
    // 挂单页签内容（面板尚未 append 到 document，必须用 panel 作用域查找）
    const sellView = panel.querySelector('#r1cm-tab-sell');
    sellView.innerHTML = `
      <div style="font-size:13px;margin-bottom:4px;">品级（勾选的才会挂单）</div>
      <div style="display:flex;flex-wrap:wrap;margin-bottom:10px;">${rarChips}</div>
      <div style="display:flex;gap:10px;margin-bottom:10px;align-items:flex-start;">
        <div style="flex:1;min-width:0;">
          <div style="font-size:13px;height:17px;line-height:17px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">单个鱼数量 ≥</div>
          <div style="font-size:11px;color:#888;margin-bottom:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">少于不挂单</div>
          <input id="r1cm-minqty" type="number" min="0" step="1" value="${savedMinQty}"
            style="width:100%;box-sizing:border-box;padding:5px 8px;border:1px solid #4a4a52;border-radius:6px;background:#2a2a30;color:#e8e8e8;" />
        </div>
        <div style="flex:1;min-width:0;">
          <div style="display:flex;align-items:center;font-size:13px;height:17px;line-height:17px;">
            <span style="flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">单鱼挂牌价 ≥</span>
            <label style="display:inline-flex;align-items:center;gap:2px;font-size:12px;color:#888;cursor:pointer;white-space:nowrap;line-height:17px;">
              <input id="r1cm-minprice-limit" type="checkbox" ${savedMinPriceLimit ? 'checked' : ''} style="width:13px;height:13px;margin:0;accent-color:#4aa3ff;cursor:pointer;">不限制
            </label>
          </div>
          <div style="font-size:11px;color:#888;margin-bottom:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">低于则跳过</div>
          <input id="r1cm-minprice" type="number" min="0" step="1" value="${savedMinPrice}"
            style="width:100%;box-sizing:border-box;padding:5px 8px;border:1px solid #4a4a52;border-radius:6px;background:#2a2a30;color:#e8e8e8;" />
        </div>
      </div>
      <div style="font-size:13px;margin-bottom:4px;">
        挂单价 = 市场最低卖价 <span style="color:#888;">±</span>
        <input id="r1cm-adj" type="number" value="${savedAdj}" style="width:80px;padding:4px 6px;border:1px solid #4a4a52;border-radius:6px;background:#2a2a30;color:#e8e8e8;" /> 金
        <div style="font-size:12px;color:#888;margin-top:3px;">正=挂更高（更赚但难成交）；负=挂更低（易成交）</div>
      </div>
      <div id="r1cm-status" style="font-size:12px;color:#58a6ff;margin-bottom:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">就绪。</div>
      <div id="r1cm-log" style="max-height:280px;overflow:auto;background:#17171b;border:1px solid #3a3a42;border-radius:6px;padding:8px;font-size:12px;margin-top:6px;color:#d0d0d0;">就绪。</div>
      <div style="display:flex;gap:8px;margin-top:12px;">
        <button id="r1cm-run" style="flex:1;background:#ff8c1a;color:#fff;border:none;border-radius:6px;padding:8px;font-size:14px;cursor:pointer;">开始挂单</button>
        <button id="r1cm-relist" style="flex:1;background:#2f9e44;color:#fff;border:none;border-radius:6px;padding:8px;font-size:13px;cursor:pointer;">勾选重挂（按设置挂单)</button>
      </div>
      <div style="display:flex;gap:8px;margin-top:8px;">
        <button id="r1cm-cheap" style="flex:1;background:#1e5aa8;color:#fff;border:none;border-radius:6px;padding:8px;font-size:13px;cursor:pointer;">最低价检测</button>
      </div>`;
    // 捡漏页签内容（面板尚未 append 到 document，必须用 panel 作用域查找）
    const bargainView = panel.querySelector('#r1cm-tab-bargain');
    bargainView.innerHTML = bargainPanelHtml();
    document.body.appendChild(panel);

    // 页签切换
    panel.querySelectorAll('button[data-tab]').forEach((tb) => {
      tb.addEventListener('click', () => switchPanelTab(tb.getAttribute('data-tab')));
    });
    // 挂单页签控件
    el('r1cm-close').addEventListener('click', removePanel);
    el('r1cm-relist').addEventListener('click', onRelistNonMin); // 勾选重挂
    el('r1cm-run').addEventListener('click', onRun);
    el('r1cm-cheap').addEventListener('click', onCheapToggle);
    const autoSave = () => { const c = readPanel(); saveCfg(c); };
    sellView.querySelectorAll('input[data-rar]').forEach((cb) => cb.addEventListener('change', autoSave));
    el('r1cm-minqty').addEventListener('input', autoSave);
    el('r1cm-adj').addEventListener('input', autoSave);
    el('r1cm-minprice').addEventListener('input', autoSave);
    // 勾选「单鱼挂牌价 不限制」→ 挂牌价下限输入框置灰（视为0=不限制），取消则恢复可输入
    (function () {
      const limitCb = el('r1cm-minprice-limit');
      const priceEl = el('r1cm-minprice');
      if (!limitCb || !priceEl) return;
      const apply = () => {
        if (limitCb.checked) {
          priceEl.disabled = true;
          priceEl.value = '';
          priceEl.style.background = '#24242a';
          priceEl.style.color = '#666';
        } else {
          priceEl.disabled = false;
          priceEl.style.background = '#2a2a30';
          priceEl.style.color = '#e8e8e8';
          if (!priceEl.value) priceEl.value = '0';
        }
      };
      apply(); // 打开面板时按保存状态恢复
      limitCb.addEventListener('change', () => { apply(); autoSave(); });
    })();
    // 捡漏页签控件
    el('r1cm-max').addEventListener('click', onMaxToggle);
    el('rlb-tab-start').addEventListener('click', onBargainStart);
    el('rlb-bid-batch').addEventListener('click', onBatchBid);
    // 捡漏筛选/勾选控件持久化：任一变更即时写 localStorage，重开面板恢复
    const autoSaveBargain = () => { saveBargainCfg(); };
    ['rlb-tab-rarity', 'rlb-tab-biome', 'rlb-tab-mastery', 'rlb-tab-usebid', 'rlb-bid-masterymax'].forEach((id) => {
      const e = el(id);
      if (e) e.addEventListener('change', autoSaveBargain);
    });
    ['rlb-bid-adjust', 'rlb-bid-qty'].forEach((id) => {
      const e = el(id);
      if (e) e.addEventListener('input', autoSaveBargain);
    });
    // 勾选「×专精鱼用当前最大值」→ 每单数量输入框置灰不可输入；取消则恢复
    (function () {
      const qtyEl = el('rlb-bid-qty');
      const mxEl = el('rlb-bid-masterymax');
      if (!qtyEl || !mxEl) return;
      const apply = () => {
        if (mxEl.checked) {
          qtyEl.disabled = true;
          qtyEl.value = '';
          qtyEl.style.background = '#24242a';
          qtyEl.style.color = '#666';
        } else {
          qtyEl.disabled = false;
          qtyEl.style.background = '#2a2a30';
          qtyEl.style.color = '#e8e8e8';
          if (!qtyEl.value) qtyEl.value = '1';
        }
      };
      mxEl.addEventListener('change', apply);
    })();
    // 勾选「求购价」时若已扫描出列表则立刻按求购价重排
    const usebidCb = el('rlb-tab-usebid');
    if (usebidCb) usebidCb.addEventListener('change', () => {
      if (bargainState && bargainState.sorted.length && bargainState.render) bargainState.render();
      autoSaveBargain();
    });
    // 勾选/取消「仅拉取专精鱼」时，直接在当前已拉取的单子中筛/放回专精鱼（不重新扫描）
    const masteryCb = el('rlb-tab-mastery');
    if (masteryCb) masteryCb.addEventListener('change', () => {
      if (bargainState && bargainState.sorted.length && bargainState.render) {
        bargainState.render();
        const showing = el('rlb-list');
        if (showing) {
          const only = masteryCb.checked;
          const visibleN = only ? bargainState.sorted.filter((it) => (bargainState.masterySet || new Set()).has(it.fishId)).length : bargainState.sorted.length;
          const st = el('rlb-status');
          if (st && visibleN === 0) st.textContent = only ? 'ℹ️ 当前拉取单中没有专精鱼' : 'ℹ️ 当前单中没有鱼在售';
          else if (st && bargainState.sorted.length) st.textContent = `已筛选：共 ${visibleN} 种${only ? '专精' : ''}鱼（当前拉取单共 ${bargainState.sorted.length} 种）`;
        }
      }
      autoSaveBargain();
    });
    // 面板可拖动（改进：整条头栏可拖、防选中、阈值区分点击/拖动、drag 反馈、限制在视口内）
    let dragging = false, movedDrag = false, ox = 0, oy = 0, sx = 0, sy = 0;
    const dragBar = panel.querySelector('div:nth-child(1)') || panel;
    dragBar.style.cursor = 'grab';
    dragBar.style.userSelect = 'none';
    const onMoveDrag = (e) => {
      if (!dragging) return;
      e.preventDefault();
      if (!movedDrag && (Math.abs(e.clientX - sx) > 3 || Math.abs(e.clientY - sy) > 3)) {
        movedDrag = true;
        dragBar.style.cursor = 'grabbing';
      }
      if (!movedDrag) return; // 未产生位移视为点击，不移动面板（保留 ✕ 关闭等点击能力）
      const x = e.clientX - ox, y = e.clientY - oy;
      panel.style.left = Math.max(0, Math.min(window.innerWidth - 60, x)) + 'px';
      panel.style.top = Math.max(0, Math.min(window.innerHeight - 40, y)) + 'px';
      panel.style.right = 'auto';
    };
    const onUpDrag = () => {
      if (dragging) { dragBar.style.cursor = 'grab'; }
      dragging = false; movedDrag = false;
      document.removeEventListener('mousemove', onMoveDrag);
      document.removeEventListener('mouseup', onUpDrag);
    };
    dragBar.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return; // 仅左键
      e.preventDefault();
      dragging = true; movedDrag = false;
      sx = e.clientX; sy = e.clientY;
      const r = panel.getBoundingClientRect();
      ox = e.clientX - r.left; oy = e.clientY - r.top;
      document.addEventListener('mousemove', onMoveDrag);
      document.addEventListener('mouseup', onUpDrag);
    });
    // 默认打开的页签（捡漏按钮打开时优先捡漏）
    switchPanelTab(panel.dataset.tab || 'sell');
    // 恢复上次捡漏的筛选/勾选控件状态（重开不丢）
    restoreBargainCfg();
    // 填充捡漏地图下拉（异步加载地图列表；完成后再应用持久化选择）
    populateBiomeSelect();
    // 「专精鱼用当前最大值」勾选态恢复后同步数量框置灰
    (function () {
      const qtyEl = el('rlb-bid-qty');
      const mxEl = el('rlb-bid-masterymax');
      if (qtyEl && mxEl && mxEl.checked) {
        qtyEl.disabled = true; qtyEl.value = ''; qtyEl.style.background = '#24242a'; qtyEl.style.color = '#666';
      }
    })();
    // 尝试恢复上次的捡漏扫描结果（30 分钟内有效）
    restoreBargainCache();
  }
  function removePanel() { if (panel && panel.parentNode) panel.parentNode.removeChild(panel); panel = null; }

  function log(msg) {
    const box = el('r1cm-log');
    if (box) {
      // 用 appendChild 追加单条日志，绝不整体重写 innerHTML，
      // 否则会销毁 r1cm-cheap-region 等动态 append 进日志盒的节点及其事件委托。
      const row = document.createElement('div');
      row.textContent = msg;
      box.appendChild(row);
      box.scrollTop = box.scrollHeight;
    }
    console.log(TAG, msg);
  }

  // ---------- 主流程 ----------
  function readPanel() {
    const rars = RARITY_ORDER.filter((r) => {
      const c = document.querySelector(`#r1cm-panel input[data-rar="${r}"]`);
      return c && c.checked;
    });
    const minQty = Math.max(0, Number(el('r1cm-minqty').value) || 0);
    const adj = Number(el('r1cm-adj').value) || 0;
    // 勾选「单鱼挂牌价 不限制」时挂牌价下限强制为 0（不限）
    const minPriceLimit = el('r1cm-minprice-limit') ? el('r1cm-minprice-limit').checked : false;
    const minPrice = minPriceLimit ? 0 : (Math.max(0, Number(el('r1cm-minprice').value) || 0));
    return { rars, minQty, adj, minPrice, minPriceLimit };
  }

  async function onRun() {
    if (running) return;
    cfg = readPanel();
    if (!cfg.rars.length) { log('⚠️ 请至少勾选一个品级'); return; }
    saveCfg(cfg);
    running = true;
    const runBtn = el('r1cm-run');
    if (runBtn) runBtn.disabled = true;
    try {
      await runSell(cfg);
    } catch (e) {
      log('❌ 流程异常: ' + e);
    } finally {
      running = false;
      if (runBtn) runBtn.disabled = false;
    }
  }

  async function runSell(c) {
    log('▶ 拉取背包鱼…');
    const inv = await getJSON('/api/inventory/fish?limit=200');
    if (!inv.ok) { log('❌ 读取背包失败: ' + inv.error); return; }
    const fish = Array.isArray(inv.data && inv.data.fish) ? inv.data.fish : (Array.isArray(inv.data) ? inv.data : []);
    if (!fish.length) { log('信息: 背包鱼为空'); return; }

    // 拉取我的在售卖单（同一鱼如已有挂单：先下架原单，再与本批库存数量合并后重新挂单）
    // 接口需 assetType 参数（鱼=fish），且 limit 每页上限 100（缺 assetType 会读失败）
    const listed = new Map(); // fishId -> [ {id, remainingQuantity} ]（我的活跃鱼卖单）
    const mine = await fetchMyFishOrders();
    if (mine.ok) {
      const orders = mine.orders || [];
      for (const o of orders) {
        if (o && o.side === 'sell' && o.status === 'active' && o.asset && o.asset.fish) {
          const fid = o.asset.fish.fishId;
          if (!listed.has(fid)) listed.set(fid, []);
          listed.get(fid).push({ id: (o.id || o.orderId), remainingQuantity: (o.remainingQuantity || 0) });
        }
      }
    } else {
      log('⚠️ 读取我的挂单失败(' + mine.error + ')，将视为无重复挂单继续（风险：同鱼会新增并列挂单）');
    }

    // 读取市场配置：活动挂单数量上限。达到上限即停止后续挂单。
    let maxOrders = 50; // 兜底值（对齐当前配置）
    let serverActive = 0;
    const cfgRes = await getJSON('/api/market/config');
    if (cfgRes.ok && cfgRes.data) {
      if (cfgRes.data.maxActiveOrdersPerPlayer > 0) maxOrders = cfgRes.data.maxActiveOrdersPerPlayer;
      if (typeof cfgRes.data.activeOrderCount === 'number') serverActive = cfgRes.data.activeOrderCount;
    } else {
      log('⚠️ 读取市场配置失败(' + (cfgRes.error || 'unknown') + ')，活动单上限按 ' + maxOrders + ' 计');
    }
    // 当前我的活跃单数：优先采用服务端统计（跨鱼/装备/买卖全类型），失败时退回鱼卖单数
    let activeCount = serverActive;
    if (!activeCount) {
      listed.forEach((arr) => { activeCount += arr.length; });
    }
    log(`市场活动挂单上限 ${maxOrders}，服务端当前 ${serverActive} 单（本地统计 ${[...listed.values()].reduce((n, a) => n + a.length, 0)} 单）`);

    // 筛选：品级 + 数量下限 + 未锁定（已有挂单的鱼也会进入，待下架后重组合并）
    const candidates = fish.filter((f) =>
      c.rars.includes(f.rarity)
      && (f.quantity || 0) >= c.minQty
      && !f.isLocked && !f.isManuallyLocked && !f.isMasteryLocked
    );
    const duplicateCount = fish.reduce((n, f) => n + (listed.has(f.fishId) ? 1 : 0), 0);
    log(`筛选：共 ${fish.length} 种，符合 ${candidates.length} 种（品级 ${c.rars.map((r)=>RARITY_CN[r]||r).join('/')}，数量≥${c.minQty}，其中有既有挂单将先下架再合并 ${duplicateCount} 种）`);

    if (!candidates.length) { log('信息: 没有符合条件可处理的鱼'); return; }

    // 逐个拉盘口拿最低卖价，算出挂单价；若该鱼已有我的挂单，先下架旧单再以合并后的数量重挂
    // （串行 + 节奏控制，避免撞频率预算）
    const placed = [], skipped = [], failed = [], delisted = [];
    let capacityHit = false; // 服务端返回「活动订单数量上限」→ 直接终止挂单
    for (let i = 0; i < candidates.length; i++) {
      const f = candidates[i];
      try {
        // 1) 拉盘口拿最低卖价，算出挂单价（先算价，满足门槛才去动旧单，避免为跳过的鱼白白下架）
        const ob = await getJSON('/api/market/fish/' + encodeURIComponent(f.fishId) + '/order-book');
        let ask = null;
        if (ob.ok && ob.data && Array.isArray(ob.data.sellLevels) && ob.data.sellLevels.length) {
          ask = ob.data.sellLevels[0].unitPrice;
        }
        if (ask == null) { skipped.push({ f, why: '无在售盘口(ask)' }); log(`↪ ${f.name}(${f.fishId}) 跳过：无市场最低卖价`); await sleep(150); continue; }
        const limitPrice = Math.max(1, Math.round(ask + c.adj)); // ±正负金额（负=降价更易成）
        // 1.5) 单鱼挂牌价 ≥ 门槛：实际挂单价低于设置价格则跳过挂单（不碰旧单）
        if (Number(c.minPrice) > 0 && limitPrice < Number(c.minPrice)) {
          skipped.push({ f, why: `挂价低于门槛 ${c.minPrice}` });
          log(`↪ ${f.name}(${f.fishId}) 跳过：挂单价 ${fmtGold(limitPrice)} < 门槛 ${fmtGold(c.minPrice)}`);
          await sleep(150);
          continue;
        }
        // 2) 活动挂单数已达上限：停止，不再继续挂
        if (activeCount >= maxOrders) {
          log(`⛔ 活动挂单数已达上限 ${maxOrders}，停止后续挂单`);
          break;
        }
        // 3) 下架该鱼已有活跃卖单（重复挂单：先下架，再合并数量重挂）
        const myOrders = listed.get(f.fishId) || [];
        let listedRemaining = 0;
        let delAllOk = true;
        if (myOrders.length) {
          for (const mo of myOrders) {
            let del = await postJSON('/api/market/orders/' + encodeURIComponent(String(mo.id)), 'DELETE', null);
            if (!(del && del.ok && del.status === 200) && (await backoffIfRateLimited(del))) {
              del = await postJSON('/api/market/orders/' + encodeURIComponent(String(mo.id)), 'DELETE', null);
            }
            if (del && del.ok && del.status === 200) {
              listedRemaining += (mo.remainingQuantity || 0);
              delisted.push(f.name);
              activeCount = Math.max(0, activeCount - 1); // 下架一单，释放一个活动单位
              log(`↧ ${f.name} 已有挂单(余${mo.remainingQuantity})，已下架`);
            } else {
              delAllOk = false;
              const whyD = safeErr(del.body, del.error);
              failed.push({ f, why: '下架旧单失败:' + whyD });
              log(`❌ ${f.name} 下架旧单失败: ${whyD}，跳过避免重复挂`);
              break;
            }
            await sleep(300);
          }
        }
        if (!delAllOk) continue;

        // 4) 合并数量：库存 + 已下架旧单的剩余数量，统一重挂一单
        const totalQty = (f.quantity || 0) + listedRemaining;
        let sell = await postJSON('/api/market/orders', 'POST', {
          assetType: 'fish', side: 'sell', limitUnitPrice: limitPrice, fishId: f.fishId, quantity: totalQty,
        });
        // 挂单命中限流（操作过于频繁）→ 等 5 秒重试一次
        if (!(sell && sell.ok) && (await backoffIfRateLimited(sell))) {
          sell = await postJSON('/api/market/orders', 'POST', {
            assetType: 'fish', side: 'sell', limitUnitPrice: limitPrice, fishId: f.fishId, quantity: totalQty,
          });
        }
        if (sell.ok) {
          placed.push({ f, price: limitPrice, ask });
          activeCount += 1; // 新挂一单，占用一个活动单位
          const combineTag = listedRemaining > 0 ? `（已合并旧单余${listedRemaining}→共${totalQty}）` : '';
          log(`✅ ${f.name}(${f.rarity}×${totalQty}) ask=${fmtGold(ask)} → 挂 ${fmtGold(limitPrice)}${combineTag}`);
        } else {
          const why = safeErr(sell.body, sell.error);
          failed.push({ f, why });
          log(`❌ ${f.name} 挂单失败: ${why}`);
          // 服务端已拒：达到市场活动订单数量上限。说明本地计数/配置已失效（含装备/其它类型单），
          // 继续挂必然同样被拒 → 直接终止本轮挂单，不浪费后续请求。
          if (/已达到市场活动订单数量上限/.test(String(why))) {
            log('⛔ 已达到市场活动订单数量上限，终止挂单');
            capacityHit = true;
            break;
          }
        }
      } catch (e) {
        failed.push({ f, why: String(e) });
        log(`❌ ${f.name} 异常: ${e}`);
      }
      await sleep(500); // 节奏控制：每单间隔，避免撞会话频率预算
    }

    log(`—— 完成：成功 ${placed.length} / 下架旧单 ${delisted.length} / 跳过 ${skipped.length} / 失败 ${failed.length}${capacityHit ? '（已达市场活动订单上限，提前终止）' : ''} ——`);
  }

  // ================== 整合：最低价检测 + 一键下架非最低价 ==================

  let _nonMin = []; // 最近一次最低价检测记录的非最低价挂单 [{id, name, myPrice, lowest, fishId, quantity}]
  let _nonMax = []; // 最近一次最高价检测记录的非最高价求购单 [{id, name, myBid, highest}]
  let _maxChecked = new Set(); // 最高价列表中被勾选的求购单 id（跨重渲染保持）
  let _nonMinChecked = new Set(); // 最低价列表中被勾选的挂单 id（跨重渲染保持）
  // 可议价（市场断层大且我为最优第一名）列表：检测到即入；独立于「非最优下架」。
  // 项形状：{ id, name, pure, fishId, quantity, side, m1, m2, gapRatio, suggest }
  let _gapList = [];
  let _gapChecked = new Set();
  // 内置分档表：按「我的挂价 P」落在哪一档，取该档断层百分比阈值（价越高容忍断层越小）[pMin, pMax, threshold]
  const GAP_BRACKETS = [
    [0, 1000, 0.05],
    [1000, 10000, 0.03],
    [10000, 100000, 0.02],
    [100000, 1000000, 0.015],
    [1000000, 10000000, 0.01],
    [10000000, Infinity, 0.005],
  ];
  // 取某个挂价对应的分档阈值
  function gapThreshold(price) {
    const p = Number(price) || 0;
    for (const [lo, hi, t] of GAP_BRACKETS) {
      if (p >= lo && p < hi) return t;
    }
    return 0.005;
  }
  // 从盘口解析「最优价 M1」与「次优价 M2」（买卖两方向共用）。
  // 买方向：M1=最高求购、M2=次高求购；卖方向：M1=最低卖、M2=次低卖。
  // 返回 { m1, m2 }；仅一档时 m2 为 null。
  function bestTwoLevels(ob, side) {
    if (!(ob && ob.ok && ob.data)) return { m1: null, m2: null };
    const d = (ob.data && ob.data.data && typeof ob.data.data === 'object') ? ob.data.data : ob.data;
    let levels = null;
    if (side === 'buy') {
      if (d && Array.isArray(d.buyLevels) && d.buyLevels.length) levels = d.buyLevels.map((l) => Number(l.unitPrice));
      else if (d && Array.isArray(d.buyOrders) && d.buyOrders.length) levels = d.buyOrders.map((o) => Number(o.limitUnitPrice));
    } else {
      if (d && Array.isArray(d.sellLevels) && d.sellLevels.length) levels = d.sellLevels.map((l) => Number(l.unitPrice));
      else if (d && Array.isArray(d.sellOrders) && d.sellOrders.length) levels = d.sellOrders.map((o) => Number(o.limitUnitPrice));
    }
    if (!levels) return { m1: null, m2: null };
    levels = levels.filter((n) => Number.isFinite(n) && n >= 0).sort((a, b) => (side === 'buy' ? b - a : a - b));
    if (!levels[0]) return { m1: null, m2: null };
    return { m1: levels[0], m2: (levels[1] != null ? levels[1] : null) };
  }
  // 忽略状态：sessionIgnored（本次扫描内，每次扫描重置）与 permIgnored（永久，跨扫描持久化，localStorage）
  const PERM_IGNORE_KEY = 'r1cm-perm-ignored';
  let _sessionIgnored = new Set(); // 本次「忽略」的鱼名（每次扫描重置）
  function loadPermIgnored() {
    try { return new Set(JSON.parse(localStorage.getItem(PERM_IGNORE_KEY) || '[]') || []); }
    catch (_e) { return new Set(); }
  }
  function savePermIgnored() {
    try { localStorage.setItem(PERM_IGNORE_KEY, JSON.stringify(Array.from(_permIgnored))); } catch (_e) {}
  }
  let _permIgnored = loadPermIgnored(); // 「永久忽略」的鱼名（跨扫描保持）

  // fishId 形如 b_010_arcane_05 → 地图号 b_010 → [B10]；无匹配返回 ''
  function mapPrefixFromFishId(fishId) {
    const m = /^b_0*(\d+)_/.exec(String(fishId || ''));
    return m ? ('[B' + String(Number(m[1])) + ']') : '';
  }
  // 去掉名称中已有的 [Bxx] 前缀
  function stripBracket(name) {
    const m = /^\s*\[[A-Za-z0-9]+\]\s*/.exec(name);
    return m ? name.slice(m[0].length) : name;
  }
  // 拼装展示名：品质 + 地图前缀 + 纯鱼名，如「【神话】[B10] 无门归港龟」
  function displayFishName(o) {
    const fish = (o && o.asset && o.asset.fish) || {};
    const rar = fish.rarity ? (RARITY_CN[fish.rarity] || fish.rarity) : '';
    const rarTag = rar ? ('【' + rar + '】') : '【未知名】';
    const raw = fish.name || fish.fishId || '';
    const pure = stripBracket(String(raw));
    const prefix = mapPrefixFromFishId(fish.fishId);
    return rarTag + prefix + pure;
  }

  // 从 order-book 解析市场最低卖价（兼容 sellLevels / sellOrders 两种结构）
  function lowestAskFromBook(ob) {
    if (!(ob && ob.ok && ob.data)) return null;
    const d = (ob.data && ob.data.data && typeof ob.data.data === 'object') ? ob.data.data : ob.data;
    if (d && Array.isArray(d.sellLevels) && d.sellLevels.length) {
      return d.sellLevels[0].unitPrice; // 卖价档最低
    }
    if (d && Array.isArray(d.sellOrders) && d.sellOrders.length) {
      let m = null;
      for (const so of d.sellOrders) {
        if (so && typeof so.limitUnitPrice === 'number') m = (m == null ? so.limitUnitPrice : Math.min(m, so.limitUnitPrice));
      }
      return m;
    }
    return null;
  }

  // 从 order-book 解析最高求购价（buyLevels 最大档；兼容 buyOrders 结构），无求购返回 null
  function highestBidFromBook(ob) {
    if (!(ob && ob.ok && ob.data)) return null;
    const d = (ob.data && ob.data.data && typeof ob.data.data === 'object') ? ob.data.data : ob.data;
    if (d && Array.isArray(d.buyLevels) && d.buyLevels.length) {
      let m = null;
      for (const lvl of d.buyLevels) {
        if (lvl && typeof lvl.unitPrice === 'number') m = (m == null ? lvl.unitPrice : Math.max(m, lvl.unitPrice));
      }
      return m;
    }
    if (d && Array.isArray(d.buyOrders) && d.buyOrders.length) {
      let m = null;
      for (const bo of d.buyOrders) {
        if (bo && typeof bo.limitUnitPrice === 'number') m = (m == null ? bo.limitUnitPrice : Math.max(m, bo.limitUnitPrice));
      }
      return m;
    }
    return null;
  }

  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  // 按钮两种状态（最高求购价检测）：check（最高价检测）/ delist（一键下架非最高价求购）
  function setMaxMode(mode) {
    const b = el('r1cm-max');
    if (!b) return;
    if (mode === 'delist') {
      b.textContent = '一键下架选中求购';
      b.style.background = '#e74c3c';
    } else {
      b.textContent = '最高价检测';
      b.style.background = '#6a4fa3';
    }
  }

  // 是否已被忽略（本次扫描 session 或永久）：被忽略的不参与一键重挂/下架
  function isIgnored(item) {
    return _sessionIgnored.has(item.name) || _permIgnored.has(item.name);
  }
  // 渲染「非最优价挂单/求购」列表（每行：名称 + 忽略 / 永久忽略 两个可点击按钮）
  // list: 该列表条目的数组；listId: 渲染到的容器 id；priceOf(item): 返回展示价文案
  function renderIgnoreList(list, listId, priceOf) {
    const box = el(listId);
    if (!box) return;
    if (!list.length) { box.innerHTML = ''; return; }
    box.innerHTML = list.map((it) => {
      const k = escapeHtml(it.name);
      const isSess = _sessionIgnored.has(it.name);
      const isPerm = _permIgnored.has(it.name);
      const rowStyle = (isSess || isPerm) ? 'opacity:.55;text-decoration:line-through;' : '';
      return `<div data-name="${escapeHtml(it.name)}" style="display:flex;align-items:center;gap:6px;padding:4px 6px;border-bottom:1px solid #2a2a30;font-size:12px;color:#d0d0d0;${rowStyle}">
        <span style="flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${k}（${priceOf(it)}）</span>
        <span class="r1cm-ign" style="color:#aaa;cursor:pointer;user-select:none;white-space:nowrap;">${isSess ? '已忽略' : '忽略'}</span>
        <span class="r1cm-pign" style="color:#aaa;cursor:pointer;user-select:none;white-space:nowrap;">${isPerm ? '已永久忽略' : '永久忽略'}</span>
      </div>`;
    }).join('');
    box.onclick = (e) => {
      const row = e.target.closest && e.target.closest('[data-name]');
      if (!row) return;
      const name = row.getAttribute('data-name');
      const it = list.find((x) => x.name === name);
      if (!it) return;
      if (e.target.classList.contains('r1cm-ign')) {
        if (_sessionIgnored.has(name)) _sessionIgnored.delete(name); else _sessionIgnored.add(name);
      } else if (e.target.classList.contains('r1cm-pign')) {
        if (_permIgnored.has(name)) { _permIgnored.delete(name); savePermIgnored(); }
        else { _permIgnored.add(name); savePermIgnored(); }
        // 永久忽略：清除本次 session 忽略，使状态与「永久」一致
        if (_permIgnored.has(name)) _sessionIgnored.delete(name);
      } else { return; }
      renderIgnoreList(list, listId, priceOf);
    };
  }
  // 清空忽略结果区
  function clearIgnoreList(listId) {
    const box = el(listId);
    if (box) box.innerHTML = '';
  }

  // 最低价侧（非最低价卖单）渲染兼容封装
  // 最低价侧（非最低价卖单）列表：每行复选框 + 名称 + 市场最低价 + 忽略，勾选后可一键重挂/下架
  function renderCheapList() {
    const box = el('r1cm-log');
    if (!box) return;
    // 独立区块区：状态日志保留，只刷区块内容（避免清日志、也不重复叠加）
    let region = document.getElementById('r1cm-cheap-region');
    if (!region) { region = document.createElement('div'); region.id = 'r1cm-cheap-region'; box.appendChild(region); }
    region.onclick = null;
    region.innerHTML = '';
    if (!_nonMin.length) { renderGapSection('sell', 'r1cm-log'); return; }
    const normal = _nonMin.filter((x) => !isIgnored(x));
    const ignoreds = _nonMin.filter((x) => isIgnored(x));
    const renderRow = (it) => {
      const idStr = escapeHtml(String(it.id));
      const k = escapeHtml(it.name);
      const pureRaw = it.pure || it.name || String(it.fishId || '');
      const linkUrl = it.url || ('https://reelax.cn/market?fishSearch=' + encodeURIComponent(pureRaw));
      const ign = isIgnored(it);
      const rowStyle = ign ? 'opacity:.55;' : '';
      const ignTag = ign ? '<span style="color:#ff9800;margin-left:6px;">(已忽略)</span>' : '';
      const ck = (!ign && _nonMinChecked.has(String(it.id))) ? ' checked' : '';
      const dis = ign ? ' disabled' : '';
      const isPerm = _permIgnored.has(it.name);
      const isSess = _sessionIgnored.has(it.name);
      // 永久忽略的只显示「取消永久忽略」；否则按 session 忽略状态显示忽略/取消忽略
      let ignLinks = '';
      if (isPerm) {
        ignLinks = `<span class="r1cm-pign" style="color:#aaa;cursor:pointer;user-select:none;white-space:nowrap;">取消永久忽略</span>`;
      } else {
        ignLinks = `<span class="r1cm-ign" style="color:#aaa;cursor:pointer;user-select:none;white-space:nowrap;">${isSess ? '取消忽略' : '忽略'}</span>
            <span class="r1cm-pign" style="color:#aaa;cursor:pointer;user-select:none;white-space:nowrap;">永久忽略</span>`;
      }
      return `<div data-id="${idStr}" style="padding:5px 4px;border-bottom:1px solid #2a2a30;font-size:12px;color:#d0d0d0;${rowStyle}">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:6px;">
          <input type="checkbox" class="r1cm-min-check" data-id="${idStr}"${ck}${dis} style="width:14px;height:14px;accent-color:#2f9e44;margin:0;cursor:pointer;" title="勾选后可一键重挂"/>
          <span class="rlb-link" data-url="${escapeHtml(linkUrl)}" title="跳到市场查看 ${escapeHtml(pureRaw)}"
            style="flex:1;color:#4fc3f7;font-weight:bold;text-decoration:underline;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer;display:block;">${k}${ignTag}</span>
          <span style="font-size:12px;color:#2e7d32;font-weight:bold;white-space:nowrap;margin-left:6px;" title="市场最低卖价">最低 ${fmtGold(it.lowest)}</span>
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center;gap:6px;margin-top:2px;margin-left:20px;">
          <span style="display:flex;gap:10px;">
            ${ignLinks}
          </span>
          <span style="font-size:12px;color:#888;white-space:nowrap;" title="我的挂价 ×数量">我的 ${fmtGold(it.myPrice)} ×${it.quantity}</span>
        </div>
      </div>`;
    };
    let html = normal.map(renderRow).join('');
    // 被忽略的鱼统一归到最下方分组展示，便于排查，不再混在正常列表里
    if (ignoreds.length) {
      html += `<div style="margin-top:8px;font-size:12px;color:#ff9800;background:#2a1d0d;border:1px solid #8a5a1a;border-radius:6px;padding:4px 6px;">已忽略 ${ignoreds.length} 条（不参与重挂/下架）</div>` + ignoreds.map(renderRow).join('');
    }
    region.innerHTML = '<div style="font-size:12px;color:#4fc3f7;background:#0d2230;border:1px solid #2e7d8a;border-radius:6px;padding:4px 6px;margin-bottom:6px;">最低价检测：以下挂单非市场最低价，勾选后点「勾选重挂（按设置挂单）」统一重挂</div>' + html + '<div id="r1cm-cheap-region-gap"></div>';
    renderGapSection('sell', 'r1cm-log'); // 追加「可议价」建议区块（订单区之后）
    region.onclick = (e) => {
      const row = e.target.closest && e.target.closest('[data-id]');
      if (!row) return;
      const idStr = row.getAttribute('data-id');
      const it = _nonMin.find((x) => String(x.id) === idStr);
      if (!it) return;
      const link = e.target && e.target.closest ? e.target.closest('.rlb-link') : null;
      if (link) { e.preventDefault(); window.location.assign(link.getAttribute('data-url')); return; }
      if (e.target.classList.contains('r1cm-ign')) {
        const nowIgn = _sessionIgnored.has(it.name);
        if (nowIgn) _sessionIgnored.delete(it.name); else _sessionIgnored.add(it.name);
        _nonMinChecked.delete(String(it.id)); // 忽略时取消勾选，避免误重挂
        renderCheapList(); return;
      }
      if (e.target.classList.contains('r1cm-pign')) {
        if (_permIgnored.has(it.name)) _permIgnored.delete(it.name); else _permIgnored.add(it.name);
        if (_permIgnored.has(it.name)) _sessionIgnored.delete(it.name);
        if (_permIgnored.has(it.name)) _nonMinChecked.delete(String(it.id));
        savePermIgnored();
        renderCheapList(); return;
      }
    };
    region.querySelectorAll('.r1cm-min-check').forEach((c) => {
      c.addEventListener('change', () => {
        const id = c.getAttribute('data-id');
        if (c.checked) _nonMinChecked.add(id); else _nonMinChecked.delete(id);
      });
    });
    // 不强制滚动到底部：忽略/勾选后保持当前滚动位置，避免用户反复上滑
  }
  function clearCheapList() { clearGapSection('r1cm-log'); const r = document.getElementById('r1cm-cheap-region'); if (r) r.remove(); }

  // 渲染「可议价」区块（追加到指定容器末尾）：勾选后可按建议价一键重挂
  // side: 该容器对应的方向（'buy' 最高求购 / 'sell' 最低卖价）；listId: 容器 id
  function renderGapSection(side, listId) {
    const box = el(listId);
    if (!box) return;
    const items = _gapList.filter((g) => g.side === side);
    if (!items.length) return;
    const rows = items.map((g) => {
      const checked = _gapChecked.has(String(g.id)) ? ' checked' : '';
      const dirTag = side === 'buy' ? '求购' : '卖';
      const move = side === 'buy' ? '↑' : '↓';
      return `<div data-gapid="${escapeHtml(String(g.id))}" style="padding:5px 4px;border-bottom:1px solid #2a2a30;font-size:12px;color:#e8f5e9;">
        <div style="display:flex;align-items:center;gap:6px;">
          <input type="checkbox" class="r1cm-gap-check" data-gapid="${escapeHtml(String(g.id))}"${checked} style="width:14px;height:14px;accent-color:#2e7d32;margin:0;cursor:pointer;" title="勾选后可按建议价重挂"/>
          <span style="flex:1;min-width:0;white-space:normal;word-break:break-word;line-height:1.5;">
            <b>${escapeHtml(g.name)}</b>
            <span style="display:block;color:#9e9e9e;margin-top:2px;">市场断层 ${(g.gapRatio * 100).toFixed(1)}%</span>
            <span style="display:block;color:#4caf50;margin-top:2px;">${dirTag}价 ${fmtGold(g.m1)} → 建议 ${fmtGold(g.suggest)}</span>
          </span>
        </div>
      </div>`;
    }).join('');
    const btnId = side === 'buy' ? 'r1cm-gap-relist-max' : 'r1cm-gap-relist-cheap';
    const wrapId = listId + '-gapctl';
    box.querySelector('#' + wrapId) && box.querySelector('#' + wrapId).remove();
    box.insertAdjacentHTML('beforeend',
      `<div id="${wrapId}" style="font-size:12px;color:#2e7d32;background:#14261a;border:1px solid #2e7d32;border-radius:6px;padding:6px;margin-top:6px;">
        <div style="margin-bottom:6px;color:#66bb6a;">可议价（市场断层大且我为最优，建议借机改价）：共 ${items.length} 条</div>
        ${rows}
        <button id="${btnId}" style="width:100%;background:#2e7d32;color:#fff;border:none;border-radius:6px;padding:6px;font-size:12px;cursor:pointer;">按建议价一键重挂选中</button>
      </div>`
    );
    // 事件委托到容器 box（r1cm-log / rlb-list 常驻，不随子节点重建而丢失），
    // 彻底规避 el(btnId) 取到旧节点 / 渲染后事件未绑定导致的按钮点不动。
    if (!box._gapRelistBound) {
      box._gapRelistBound = true;
      box.addEventListener('click', (e) => {
        const b = (e.target && e.target.closest ? e.target.closest('[id="r1cm-gap-relist-cheap"], [id="r1cm-gap-relist-max"]') : null);
        if (b) {
          e.preventDefault(); e.stopPropagation();
          console.log(TAG, '[gap-delegated] 捕获按钮点击 side=', b.id === 'r1cm-gap-relist-max' ? 'buy' : 'sell');
          relistGap(b.id === 'r1cm-gap-relist-max' ? 'buy' : 'sell');
        }
      });
      box.addEventListener('change', (e) => {
        const c = e.target;
        if (!c || !c.classList || !c.classList.contains('r1cm-gap-check')) return;
        const id = c.getAttribute('data-gapid');
        if (c.checked) _gapChecked.add(id); else _gapChecked.delete(id);
      });
    }
  }
  function clearGapSection(listId) {
    const box = el(listId);
    if (!box) return;
    const wrap = box.querySelector('#' + listId + '-gapctl');
    if (wrap) wrap.remove();
  }

  // 按建议价一键重挂：把该方向被勾选的可议价单撤掉，再按建议价重新挂单（仍保持我为最优第一名）
  async function relistGap(side) {
    const targets = _gapList.filter((g) => g.side === side && _gapChecked.has(String(g.id)));
    if (!targets.length) {
      const which = (side === 'buy' ? '求购' : '卖');
      log(`ℹ️ 未勾选任何可议价${which}单。请先勾选后再「按建议价一键重挂」。`);
      return;
    }
    log(`▶ 准备重挂 ${targets.length} 条可议价${side === 'buy' ? '求购' : '卖'}单…`);
    let okN = 0, failN = 0;
    const labelOf = (g) => `${g.name}(${g.side === 'buy' ? '求购' : '卖'})`;
    for (const g of targets) {
      const which = (side === 'buy' ? '求购' : '卖');
      // 1) 撤掉旧单
      const del = await postJSON('/api/market/orders/' + encodeURIComponent(g.id), 'DELETE', {});
      if (!del.ok) {
        failN++;
        log(`❌ ${labelOf(g)} 撤单失败: ${safeErr(del.body, del.error)}，跳过`);
        continue;
      }
      await sleep(200);
      // 2) 按建议价重挂
      const relist = await postJSON('/api/market/orders', 'POST', {
        assetType: 'fish', side, limitUnitPrice: Math.max(1, g.suggest), fishId: g.fishId, quantity: g.quantity,
      });
      if (!relist.ok) {
        failN++;
        log(`❌ ${labelOf(g)} 重挂失败: ${safeErr(relist.body, relist.error)}`);
        continue;
      }
      okN++;
      log(`✅ ${labelOf(g)} ×${g.quantity}　重挂成功　${which}价 ${fmtGold(g.m1)} → ${fmtGold(g.suggest)}`);
      await sleep(300);
    }
    log(`—— 重挂完成：成功 ${okN} 条 / 失败 ${failN} 条 ——`);
    // 刷新：清空该方向可议价列表与勾选
    _gapList = _gapList.filter((g) => g.side !== side);
    _gapChecked = new Set(Array.from(_gapChecked).filter((id) => !targets.some((t) => String(t.id) === id)));
    if (side === 'buy') { renderMaxList(); }
    else { renderCheapList(); }
  }

  // 最高价侧：非最高价求购单显示在捡漏共用列表 rlb-list，顶部加来源横幅区分
  function renderMaxList() {
    const box = el('rlb-list');
    if (!box) return;
    const hasGap = _gapList.some((g) => g.side === 'buy');
    if (!_nonMax.length && !hasGap) { box.innerHTML = ''; box.dataset.maxMode = ''; return; }
    box.dataset.maxMode = '1';
    const html = _nonMax.map((it) => {
      const k = escapeHtml(it.name);
      const idStr = escapeHtml(String(it.id));
      const ck = _maxChecked.has(String(it.id)) ? ' checked' : '';
      const isSess = _sessionIgnored.has(it.name);
      const isPerm = _permIgnored.has(it.name);
      const rowStyle = (isSess || isPerm) ? 'opacity:.55;' : '';
      const ignTag = (isSess || isPerm) ? '<span style="color:#ff9800;margin-left:6px;">(已忽略)</span>' : '';
      return `<div data-id="${idStr}" style="padding:5px 4px;border-bottom:1px solid #2a2a30;font-size:12px;color:#e0d6f5;${rowStyle}">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:6px;">
          <input type="checkbox" class="r1cm-max-check" data-id="${idStr}"${ck} style="width:14px;height:14px;accent-color:#6a4fa3;margin:0;cursor:pointer;" title="勾选后可下架该求购"/>
          <span class="rlb-link" data-url="${escapeHtml(it.url || '')}" title="跳到市场查看 ${escapeHtml(it.pure || it.name)}"
            style="flex:1;color:#d4a520;font-weight:bold;text-decoration:underline;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer;display:block;">${k}${ignTag}</span>
          <span class="rlb-bidprice" data-fid="${escapeHtml(it.fishId)}" data-bid="${it.highest == null ? 0 : it.highest}"
            data-name="${escapeHtml(it.pure || it.name)}"
            style="font-size:12px;color:#9b59b6;font-weight:bold;white-space:nowrap;margin-left:6px;cursor:pointer;text-decoration:underline;padding:2px 4px;border-radius:4px;"
            title="点击设置求购价并发求购单">最高求购 ${fmtGold(it.highest)}</span>
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center;gap:6px;margin-top:2px;">
          <span style="display:flex;gap:10px;">
            <span class="r1cm-ign" style="color:#aaa;cursor:pointer;user-select:none;">${isSess ? '取消忽略' : '忽略'}</span>
            <span class="r1cm-pign" style="color:#aaa;cursor:pointer;user-select:none;">${isPerm ? '取消永久忽略' : '永久忽略'}</span>
          </span>
          <span style="font-size:12px;color:#888;white-space:nowrap;" title="我的求购价">我的求购 ${fmtGold(it.myBid)}</span>
        </div>
      </div>`;
    }).join('');
    box.innerHTML = '<div style="font-size:12px;color:#c084fc;background:#221a33;border:1px solid #6a4fa3;border-radius:6px;padding:4px 6px;margin-bottom:6px;">最高价检测：以下求购单非市场最高价，勾选后可「一键下架选中求购」或直接批量重挂</div>' + html;
    box.onclick = (e) => {
      const row = e.target.closest && e.target.closest('[data-id]');
      if (!row) return;
      const idStr = row.getAttribute('data-id');
      const it = _nonMax.find((x) => String(x.id) === idStr);
      if (!it) return;
      const priceEl = e.target && e.target.closest ? e.target.closest('.rlb-bidprice') : null;
      if (priceEl) {
        e.preventDefault();
        e.stopPropagation();
        openBidModal({
          fishId: priceEl.getAttribute('data-fid'),
          name: priceEl.getAttribute('data-name') || priceEl.getAttribute('data-fid'),
          bid: Number(priceEl.getAttribute('data-bid')) || 0,
        });
        return;
      }
      const link = e.target && e.target.closest ? e.target.closest('.rlb-link') : null;
      if (link) {
        e.preventDefault();
        window.location.assign(link.getAttribute('data-url'));
        return;
      }
      if (e.target.classList.contains('r1cm-ign')) {
        if (_sessionIgnored.has(it.name)) _sessionIgnored.delete(it.name); else _sessionIgnored.add(it.name);
        renderMaxList(); return;
      }
      if (e.target.classList.contains('r1cm-pign')) {
        if (_permIgnored.has(it.name)) { _permIgnored.delete(it.name); savePermIgnored(); }
        else { _permIgnored.add(it.name); savePermIgnored(); }
        if (_permIgnored.has(it.name)) _sessionIgnored.delete(it.name);
        renderMaxList(); return;
      }
    };
    box.querySelectorAll('.r1cm-max-check').forEach((c) => {
      c.addEventListener('change', () => {
        const id = c.getAttribute('data-id');
        if (c.checked) _maxChecked.add(id); else _maxChecked.delete(id);
      });
    });
    renderGapSection('buy', 'rlb-list');
  }
  function clearMaxList() {
    const box = el('rlb-list');
    if (box && box.dataset.maxMode) { box.innerHTML = ''; box.dataset.maxMode = ''; }
  }

  // 合并按钮入口（最高价检测）：点扫描完全后自动切为一键下架；下架完成后恢复为最高价检测
  async function onMaxToggle() {
    const btn = el('r1cm-max');
    if (btn) btn.disabled = true;
    try {
      const isCheckMode = btn && btn.textContent.indexOf('下架') === -1;
      if (isCheckMode) {
        await onMaxCheck();
        // 扫出非最高价求购 → 按钮切为一键下架；无则保持最高价检测
        setMaxMode(_nonMax.length ? 'delist' : 'check');
      } else {
        await onDelistNonMax();
        setMaxMode('check'); // 下架完成后恢复
      }
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  // 最高价检测：检查我的在求购买单是否为市场最高求购价，记录非最高价求购单到 _nonMax
  async function onMaxCheck() {
    const st = el('rlb-status');
    if (st) st.textContent = '▶ 拉取我的求购单…';
    _nonMax = [];
    _maxChecked = new Set(); // 新扫描默认全部勾选，便于一键下架
    _gapList = [];
    _gapChecked = new Set();
    clearMaxList();
    _sessionIgnored = new Set(); // 每次扫描：忽略（本次）重置为初始，永久忽略保持
    _permIgnored = loadPermIgnored(); // 重新读取，保证跨会话一致
    // 分页拉取我的全部鱼挂单（min/max 共用 helper，避免只读一页漏单）
    const mine = await fetchMyFishOrders();
    const orders = (mine.ok && Array.isArray(mine.orders)) ? mine.orders : null;
    if (!orders) {
      if (st) st.textContent = '❌ 读取求购单失败: ' + (mine.error || 'unknown');
      return;
    }
    const buys = orders.filter((o) => o && o.side === 'buy' && o.status === 'active'
      && o.asset && o.asset.fish && (o.remainingQuantity || 0) > 0);
    if (!buys.length) { if (st) st.textContent = 'ℹ️ 你没有在求购中的鱼买单'; return; }
    if (st) st.textContent = `共 ${buys.length} 条求购中的鱼买单，逐条核对市场最高求购价…`;

    let ok = 0, notMax = 0, skipped = 0;
    for (let i = 0; i < buys.length; i++) {
      const o = buys[i];
      const fid = o.asset.fish.fishId;
      const name = displayFishName(o);
      const myBid = o.limitUnitPrice;
      const qty = o.remainingQuantity || 1;
      try {
        const ob = await getJSON('/api/market/fish/' + encodeURIComponent(fid) + '/order-book');
        const two = bestTwoLevels(ob, 'buy');
        const highest = two.m1;
        if (highest == null) {
          ok++;
        } else if (myBid === highest) {
          ok++;
          // 可议价：我为最高求购、存在次高档、且市场断层达阈值 → 建议改价
          if (two.m2 != null) {
            const gapRatio = Math.abs(highest - two.m2) / Math.max(two.m2, 1);
            if (gapRatio >= gapThreshold(myBid)) {
              _gapList.push({
                id: (o.id || o.orderId), name, pure: stripBracket(String((o.asset.fish && o.asset.fish.name) || fid || '')),
                fishId: fid, quantity: qty, side: 'buy',
                m1: highest, m2: two.m2, gapRatio,
                suggest: two.m2 + 1, // 次高档 +1：仍最高求购、降低成本
              });
              log(`💡 ${escapeHtml(name)}　断层 ${(gapRatio * 100).toFixed(1)}% ｜ 建议改价 ${fmtGold(two.m2 + 1)}`);
            }
          }
        } else {
          notMax++;
          const fish = o.asset.fish || {};
          const pureRaw = stripBracket(String(fish.name || fish.fishId || ''));
          // 与市场最高求购价的差距（比例）在「分档阈值 gapThreshold」内 → 默认勾选；超出则不勾选
          const gapRatio = (highest - myBid) / Math.max(highest, 1);
          _nonMax.push({
            id: (o.id || o.orderId), name, myBid, highest, gapRatio, fishId: fid,
            pure: pureRaw, quantity: qty,
            url: 'https://reelax.cn/market?fishSearch=' + encodeURIComponent(pureRaw),
          });
          if (gapRatio <= gapThreshold(myBid)) _maxChecked.add(String(o.id || o.orderId));
        }
      } catch (e) {
        skipped++;
      }
      if (st) st.textContent = `${i + 1}/${buys.length} ｜ 非最高 ${notMax} 条`;
      await sleep(180); // 节奏控制
    }
    renderMaxList();
    if (st) st.textContent = `最高价 ${ok} 条 / 非最高 ${notMax} 条 / 可议价 ${_gapList.length} 条 / 异常 ${skipped} 条`;
  }

  // 一键下架非最高价求购：把上次最高价检测勾选的非最高价求购单全部撤掉
  async function onDelistNonMax() {
    const st = el('rlb-status');
    const targets = _nonMax.filter((x) => _maxChecked.has(String(x.id)));
    if (!targets.length) { if (st) st.textContent = 'ℹ️ 未勾选任何求购单。请先在列表中勾选（默认全选）要下架的单。'; return; }
    if (st) st.textContent = `▶ 准备下架 ${targets.length} 条非最高价求购单…`;
    let okN = 0, failN = 0;
    for (const it of targets) {
      // 被忽略（本次或永久）的挂单不下架：从待处理里移除（已视作处理），其余项保留并继续显示
      if (isIgnored(it)) {
        _nonMax = _nonMax.filter((x) => String(x.id) !== String(it.id));
        _maxChecked.delete(String(it.id));
        renderMaxList();
        continue;
      }
      const res = await postJSON('/api/market/orders/' + encodeURIComponent(String(it.id)), 'DELETE', null);
      _maxChecked.delete(String(it.id));
      // 仅下架成功的才从待处理列表移除；失败的保留显示（未勾选，可改价或稍后再次下架），不做「处理过就消失」
      if (res && res.ok && res.status === 200) {
        okN++;
        _nonMax = _nonMax.filter((x) => String(x.id) !== String(it.id));
      } else {
        failN++;
      }
      renderMaxList();
      if (st) st.textContent = `下架中：成功 ${okN} 条 / 失败 ${failN} 条`;
      await sleep(300);
    }
    if (st) st.textContent = `—— 下架完成：成功 ${okN} 条 / 失败 ${failN} 条 ——`;
// 若仍有未处理（未勾选 / 下架失败 / 其余）的非最高价求购，保持列表与「一键下架」按钮，便于继续逐条处理；
    // 仅剩已忽略项视作处理完毕，切回「最高价检测」。
    const remaining = _nonMax.filter((x) => !isIgnored(x));
    if (remaining.length) {
      if (st) st.textContent = `仍有 ${remaining.length} 条未处理（勾选后可继续「一键下架」）。`;
      renderMaxList();
      setMaxMode('delist');
      return;
    }
    _nonMax = [];
    _maxChecked = new Set();
    clearMaxList();
    setMaxMode('check'); // 全部处理完后按钮恢复为「最高价检测」
  }

  // 最低价检测按钮（参照最高价）：检测/下架两种模式共用 r1cm-cheap，扫描后自动切为「一键下架勾选」，下架完恢复
  function setCheapMode(mode) {
    const b = el('r1cm-cheap');
    if (!b) return;
    if (mode === 'delist') {
      b.textContent = '一键下架勾选';
      b.style.background = '#e74c3c';
    } else {
      b.textContent = '最低价检测';
      b.style.background = '#1e5aa8';
    }
  }

  async function onCheapToggle() {
    const btn = el('r1cm-cheap');
    if (btn) btn.disabled = true;
    try {
      const isCheckMode = btn && btn.textContent.indexOf('下架') === -1;
      if (isCheckMode) {
        await onCheapCheck();
        // 扫出非最低价挂单 → 按钮切为一键下架；无则保持最低价检测
        setCheapMode(_nonMin.length ? 'delist' : 'check');
      } else {
        await onDelistNonMin();
        setCheapMode('check'); // 下架完成后恢复
      }
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  // 最低价检测：检查我的上架鱼卖单是否为市场最低价，记录非最低价挂单到 _nonMin
  async function onCheapCheck() {
    const st = el('r1cm-status');
    setStatus(st, '▶ 拉取我的挂单…');
    _nonMin = [];
    _nonMinChecked = new Set(); // 新扫描默认全部勾选，便于一键勾选重挂/下架
    clearCheapList();
    _gapList = [];
    _gapChecked = new Set();
    _sessionIgnored = new Set(); // 每次扫描：忽略（本次）重置为初始，永久忽略保持
    _permIgnored = loadPermIgnored(); // 重新读取，保证跨会话一致
    // 分页拉取我的全部鱼挂单（min/max 共用 helper）
    const mine = await fetchMyFishOrders();
    const orders = (mine.ok && Array.isArray(mine.orders)) ? mine.orders : null;
    if (!orders) {
      setStatus(st, '❌ 读取挂单失败: ' + (mine.error || 'unknown') + (mine.body ? ' body:' + String(mine.body).slice(0, 150) : ''));
      return;
    }
    const sells = orders.filter((o) => o && o.side === 'sell' && o.status === 'active'
      && o.asset && o.asset.fish && (o.remainingQuantity || 0) > 0);
    if (!sells.length) { setStatus(st, 'ℹ️ 你没有上架中的鱼卖单'); return; }

    let ok = 0, notMin = 0, skipped = 0;
    for (let i = 0; i < sells.length; i++) {
      const o = sells[i];
      const fid = o.asset.fish.fishId;
      const name = displayFishName(o);
      const myPrice = o.limitUnitPrice;
      const qty = o.remainingQuantity || 1;
      try {
        const ob = await getJSON('/api/market/fish/' + encodeURIComponent(fid) + '/order-book');
        const lowest = lowestAskFromBook(ob);
        if (lowest == null) {
          ok++;
        } else if (myPrice === lowest) {
          ok++;
          // 可议价：我为最低卖、存在次低档、且市场断层达阈值 → 建议改价
          const two = bestTwoLevels(ob, 'sell');
          if (two.m2 != null) {
            const gapRatio = Math.abs(lowest - two.m2) / Math.max(two.m2, 1);
            if (gapRatio >= gapThreshold(myPrice)) {
              _gapList.push({
                id: (o.id || o.orderId), name,
                pure: stripBracket(String((o.asset.fish && o.asset.fish.name) || fid || '')),
                fishId: fid, quantity: qty, side: 'sell',
                m1: lowest, m2: two.m2, gapRatio,
                suggest: two.m2 - 1, // 次低档 -1：仍最低卖、更高价成交
              });
            }
          }
        } else {
          notMin++;
          const nmId = String(o.id || o.orderId);
          // 与市场最低价的差距（比例）在「分档阈值 gapThreshold」内 → 默认勾选；超出则不勾选
          const gapRatio = (myPrice - lowest) / Math.max(lowest, 1);
          _nonMin.push({ id: nmId, name, myPrice, lowest, gapRatio, fishId: fid, quantity: qty, pure: stripBracket(String((o.asset.fish && o.asset.fish.name) || fid || '')) });
          if (gapRatio <= gapThreshold(myPrice)) _nonMinChecked.add(nmId);
        }
      } catch (e) {
        skipped++;
      }
      setStatus(st, `扫描 ${i + 1}/${sells.length} ｜ 非最低 ${notMin} 条 ｜ 可议价 ${_gapList.length} 条`);
      await sleep(180); // 节奏控制
    }
    renderCheapList();
    setStatus(st, `最低价 ${ok} 条 / 非最低 ${notMin} 条 / 可议价 ${_gapList.length} 条 / 异常 ${skipped} 条`);
    if (_nonMin.length) {
      const cfgNow = readPanel();
      const adj = Number(cfgNow.adj) || 0;
      const minPrice = Number(cfgNow.minPrice) || 0;
      const adjTxt = (adj >= 0 ? '+' : '') + adj;
      log('💡 检测出 ' + _nonMin.length + ' 条非最低价挂单（见上方列表），勾选后点「勾选重挂（按设置挂单）」即可按门槛 [' + (minPrice > 0 ? fmtGold(minPrice) : '不限') + '] 与 ±[' + adjTxt + '] 统一重挂');
    }
  }

  // 状态行写值：r1cm-status 显示于列表之上，不占用日志流
  function setStatus(st, text) {
    if (st) st.textContent = text;
    console.log(TAG, text);
  }

  // 勾选重挂非最低价：把勾选的非最低价挂单先下架，再按「市场最低卖价 ± 设置」重挂（低于设置门槛则跳过）；
  // 重挂成功的从清单移除（仅保留未处理/失败的），过程不刷日志，只更新状态行
  async function onRelistNonMin() {
    const st = el('r1cm-status');
    if (!_nonMin.length) { setStatus(st, 'ℹ️ 暂无待重挂的非最低价挂单。请先点击「最低价检测」后再操作。'); return; }
    const targets = _nonMin.filter((x) => _nonMinChecked.has(String(x.id)) && !isIgnored(x));
    if (!targets.length) { setStatus(st, 'ℹ️ 未勾选任何可重挂的挂单（已忽略的不会重挂）。请先在列表中勾选。'); return; }
    const cfgNow = readPanel();
    const adj = Number(cfgNow.adj) || 0;
    const minPrice = Number(cfgNow.minPrice) || 0;
    let okN = 0, failN = 0, skipN = 0;
    for (let i = 0; i < targets.length; i++) {
      const it = targets[i];
      if (isIgnored(it)) {
        _nonMin = _nonMin.filter((x) => String(x.id) !== String(it.id));
        _nonMinChecked.delete(String(it.id));
        renderCheapList();
        continue;
      }
      // 重挂价 = 市场最低卖价 ± 设置（负=更低更易成交），并遵守单鱼价格门槛
      const limitPrice = Math.max(1, Math.round((it.lowest == null ? 0 : it.lowest) + adj));
      if (minPrice > 0 && limitPrice < minPrice) {
        skipN++;
        _nonMinChecked.delete(String(it.id));
        renderCheapList();
        setStatus(st, `重挂中 ${i + 1}/${targets.length} ｜ 成功 ${okN} / 失败 ${failN} / 跳过 ${skipN}`);
        await sleep(200);
        continue;
      }
      // 1) 下架旧单
      let del = await postJSON('/api/market/orders/' + encodeURIComponent(String(it.id)), 'DELETE', null);
      if (!(del && del.ok && del.status === 200) && (await backoffIfRateLimited(del))) {
        del = await postJSON('/api/market/orders/' + encodeURIComponent(String(it.id)), 'DELETE', null);
      }
      if (!(del && del.ok && del.status === 200)) {
        failN++;
        _nonMinChecked.delete(String(it.id)); // 失败保留显示但取消勾选，可稍后重试
        renderCheapList();
        setStatus(st, `重挂中 ${i + 1}/${targets.length} ｜ 失败：${escapeHtml(it.name)} 下架未成功（可稍后重试）`);
        await sleep(300);
        continue;
      }
      // 2) 按设置价重挂；成功后从清单移除
      const r = await placeSellOrder(it.fishId, it.name, limitPrice, it.quantity);
      _nonMin = _nonMin.filter((x) => String(x.id) !== String(it.id));
      _nonMinChecked.delete(String(it.id));
      if (r.ok) { okN++; } else { failN++; _nonMin.push(it); _nonMinChecked.add(String(it.id)); }
      renderCheapList();
      setStatus(st, `重挂中 ${i + 1}/${targets.length} ｜ 成功 ${okN} / 失败 ${failN} / 跳过 ${skipN}`);
      await sleep(300);
    }
    setStatus(st, `—— 重挂完成：成功 ${okN} 条 / 失败 ${failN} 条 / 跳过 ${skipN} 条 ——`);
    // 剩余的未处理（未勾选 / 失败）非最低价挂单继续在清单显示；全部处理完或仅剩已忽略才清空
    if (_nonMin.some((x) => !isIgnored(x))) {
      renderCheapList();
      return;
    }
    _nonMin = [];
    _nonMinChecked = new Set();
    clearCheapList();
  }

  // 一键下架勾选的非最低价卖单（只撤单，不重挂）
  async function onDelistNonMin() {
    const st = el('r1cm-status');
    const targets = _nonMin.filter((x) => _nonMinChecked.has(String(x.id)) && !isIgnored(x));
    if (!targets.length) {
      setStatus(st, 'ℹ️ 未勾选任何可下架的挂单（已忽略的不会下架）。请先在列表中勾选。');
      return;
    }
    setStatus(st, `▶ 准备下架 ${targets.length} 条非最低价卖单…`);
    let okN = 0, failN = 0;
    for (let i = 0; i < targets.length; i++) {
      const it = targets[i];
      if (isIgnored(it)) { _nonMin = _nonMin.filter((x) => String(x.id) !== String(it.id)); _nonMinChecked.delete(String(it.id)); renderCheapList(); continue; }
      let del = await postJSON('/api/market/orders/' + encodeURIComponent(String(it.id)), 'DELETE', null);
      if (!(del && del.ok && del.status === 200) && (await backoffIfRateLimited(del))) {
        del = await postJSON('/api/market/orders/' + encodeURIComponent(String(it.id)), 'DELETE', null);
      }
      _nonMinChecked.delete(String(it.id));
      if (del && del.ok && del.status === 200) {
        okN++;
        _nonMin = _nonMin.filter((x) => String(x.id) !== String(it.id));
      } else {
        failN++;
        log(`❌ ${escapeHtml(it.name)} 下架失败: ${safeErr(del && del.body, del && del.error)}`);
      }
      renderCheapList();
      setStatus(st, `下架中 ${i + 1}/${targets.length} ｜ 成功 ${okN} 条 / 失败 ${failN} 条`);
      await sleep(300);
    }
    setStatus(st, `—— 下架完成：成功 ${okN} 条 / 失败 ${failN} 条 ——`);
    if (_nonMin.some((x) => !isIgnored(x))) {
      log(`仍有 ${_nonMin.filter((x) => !isIgnored(x)).length} 条未处理（失败/未勾选），可勾选后再次下架或重挂。`);
      renderCheapList();
      return;
    }
    _nonMin = [];
    _nonMinChecked = new Set();
    clearCheapList();
  }

  function safeErr(body, fallback) {
    try {
      const o = JSON.parse(body);
      const msg = (o && o.error && (o.error.message || o.error.code || o.error)) || (o && o.message);
      if (msg) return String(msg);
    } catch (_e) {}
    return (fallback || 'http');
  }

  // 判断响应是否为「操作过于频繁」类限流
  function isRateLimited(res) {
    const txt = safeErr(res && res.body, res && res.error) || '';
    return /过于频繁|操作太频繁|频率|稍后重试|限流|too (many|frequent)/i.test(txt);
  }

  // 限流退避：命中限流则提示并停顿 5 秒，返回是否命中（供调用方决定重试/继续）
  async function backoffIfRateLimited(res) {
    if (isRateLimited(res)) {
      log('⏳ 命中限流（操作过于频繁），等待 5 秒后继续…');
      await sleep(5000);
      return true;
    }
    return false;
  }

  // ================== 捡漏：面板页签 + 非渔获页悬浮按钮 ==================

  // 页签切换（挂单 sell / 捡漏 bargain）
  function switchPanelTab(tab) {
    const p = el('r1cm-panel');
    if (!p) return;
    ['sell', 'bargain'].forEach((t) => {
      const v = document.getElementById('r1cm-tab-' + t);
      if (v) v.style.display = (t === tab) ? '' : 'none';
      const tb = p.querySelector('button[data-tab="' + t + '"]');
      if (tb) tb.style.background = (t === tab ? (t === 'bargain' ? '#8b5cf6' : '#ff8c1a') : '#2a2a30');
    });
    if (tab === 'bargain') { const s = el('rlb-status'); if (s && !s.textContent) s.textContent = '选择稀有度后点「开始」查询各鱼市场最低价，按价格升序列出。'; }
  }

  function bargainPanelHtml() {
    const rlbOpts = objBargainRarities().map((r) => `<option value="${r.key}">${r.name}</option>`).join('');
    return `
      <div style="font-size:13px;margin-bottom:4px;">稀有度（列出该品级所有鱼的当前市场最低挂单价）</div>
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
        <select id="rlb-tab-rarity" title="筛选鱼品级" style="flex:1.2;padding:5px 6px;border:1px solid #4a4a52;border-radius:6px;background:#2a2a30;color:#e8e8e8;">${rlbOpts}</select>
        <select id="rlb-tab-biome" title="筛选地图（仅拉取该地图的鱼）" style="flex:1;padding:5px 6px;border:1px solid #4a4a52;border-radius:6px;background:#2a2a30;color:#e8e8e8;"><option value="">全部地图</option></select>
        <button id="rlb-tab-start" type="button" style="padding:5px 14px;border-radius:6px;border:1px solid #8b5cf6;background:#8b5cf6;color:#fff;font-size:13px;cursor:pointer;">开始</button>
      </div>
      <div style="display:flex;align-items:center;gap:14px;margin-bottom:8px;">
        <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:#c4b5fd;cursor:pointer;user-select:none;">
          <input type="checkbox" id="rlb-tab-mastery" style="width:14px;height:14px;accent-color:#8b5cf6;cursor:pointer;">
          仅拉取专精鱼
        </label>
        <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:#c4b5fd;cursor:pointer;user-select:none;">
          <input type="checkbox" id="rlb-tab-usebid" style="width:14px;height:14px;accent-color:#2f9e44;cursor:pointer;">
          求购价
        </label>
      </div>
      <div id="rlb-status" style="font-size:12px;color:#aaa;margin-bottom:6px;"></div>
      <div id="rlb-list" style="max-height:300px;overflow:auto;background:#17171b;border:1px solid #3a3a42;border-radius:6px;padding:6px;font-size:12px;"></div>
<div style="display:flex;align-items:center;gap:8px;margin-top:8px;font-size:12px;color:#aaa;flex-wrap:wrap;">
        <span style="white-space:nowrap;">快速±</span>
        <input id="rlb-bid-adjust" type="number" step="1" value="1" title="在最高求购价上 ±此数" style="width:64px;padding:4px 6px;border:1px solid #4a4a52;border-radius:6px;background:#2a2a30;color:#e8e8e8;"/>
        <span style="white-space:nowrap;">元求购</span>
        <span style="white-space:nowrap;margin-left:8px;">每单数量</span>
        <input id="rlb-bid-qty" type="number" min="1" step="1" value="1" style="width:64px;padding:4px 6px;border:1px solid #4a4a52;border-radius:6px;background:#2a2a30;color:#e8e8e8;"/>
        <label style="display:inline-flex;align-items:center;gap:4px;cursor:pointer;color:#4aa3ff;white-space:nowrap;">
          <input id="rlb-bid-masterymax" type="checkbox" style="width:14px;height:14px;accent-color:#4aa3ff;cursor:pointer;"/>
          专精鱼用当前最大值
        </label>
      </div>
      <div style="margin-top:6px;">
        <button id="rlb-bid-batch" type="button" style="width:100%;padding:6px;border:none;border-radius:6px;background:#2f9e44;color:#fff;font-size:13px;cursor:pointer;">为已勾选的鱼批量发布求购单</button>
      </div>
      
      <div style="margin-top:10px;border-top:1px solid #2a2a30;padding-top:8px;">
        <button id="r1cm-max" type="button" style="width:100%;padding:6px;border:none;border-radius:6px;background:#6a4fa3;color:#fff;font-size:13px;cursor:pointer;">最高价检测</button>
      </div>`;
  }

  function objBargainRarities() {
    return [
      { key: '*', name: '全部品级' },
      { key: 'arcane', name: '奥秘' },
      { key: 'exotic', name: '奇异' },
      { key: 'mythic', name: '神话' },
      { key: 'legendary', name: '传说' },
      { key: 'epic', name: '史诗' },
      { key: 'rare', name: '稀有' },
      { key: 'fine', name: '精良' },
      { key: 'uncommon', name: '罕见' },
      { key: 'common', name: '普通' },
    ];
  }
  function objBargainRarityName(key) { const r = objBargainRarities().find((x) => x.key === key); return r ? r.name : key; }

  // fishId b_007_exotic_01 → 地图号 b_007 → [B7] 的 mapTag
  function biomeIdToTag(biomeId) {
    const p = String(biomeId || '').split('_');
    if (p.length >= 2) {
      const num = (p[1] || '').replace(/^0+/, '');
      return '[' + p[0].replace(/^b/i, 'B') + (num || '') + ']';
    }
    return '';
  }

  // 采集所有地图的 biomeId 列表（与 ensureAllFish 同源，用于捡漏地图下拉）
  let _biomeList = null; // [{ biomeId, mapTag }]
  let _biomeTs = 0;
  const BIOME_TTL = 10 * 60 * 1000;
  async function ensureBiomeList() {
    if (_biomeList && (Date.now() - _biomeTs) < BIOME_TTL) return _biomeList;
    let biomeIds = [];
    const bioResp = await getJSON('/api/biomes');
    if (bioResp.ok && bioResp.data) {
      const bw = (bioResp.data && bioResp.data.data && typeof bioResp.data.data === 'object') ? bioResp.data.data : bioResp.data;
      const arr = (bw && Array.isArray(bw.biomes)) ? bw.biomes : (Array.isArray(bw) ? bw : null);
      biomeIds = (arr || []).map((b) => b.biomeId || b.id).filter(Boolean);
    }
    if (!biomeIds.length) {
      const mResp = await getJSON('/api/mastery');
      const mw = (mResp.ok && mResp.data) ? ((mResp.data.data && typeof mResp.data.data === 'object') ? mResp.data.data : mResp.data) : null;
      const mb = (mw && Array.isArray(mw.biomes)) ? mw.biomes : null;
      biomeIds = (mb || []).map((b) => b.biomeId || b.id).filter(Boolean);
    }
    // 去重保序；mapTag 用连贯格式 [B7]
    const seen = new Set();
    _biomeList = [];
    for (const bid of biomeIds) {
      if (seen.has(bid)) continue;
      seen.add(bid);
      _biomeList.push({ biomeId: bid, mapTag: biomeIdToTag(bid) });
    }
    _biomeTs = Date.now();
    return _biomeList;
  }

  // 面板打开时填充捡漏地图下拉（保留「全部地图」为首项），并恢复持久化选择
  async function populateBiomeSelect() {
    const sel = el('rlb-tab-biome');
    if (!sel) return;
    try {
      const list = await ensureBiomeList();
      if (list.length) {
        sel.innerHTML = '<option value="">全部地图</option>' +
          list.map((b) => `<option value="${escapeHtml(b.biomeId)}">${b.mapTag || escapeHtml(b.biomeId)}</option>`).join('');
      }
    } catch (_e) {}
    const saved = loadBargainCfg();
    if (saved && saved.biome && [...sel.options].some((o) => o.value === saved.biome)) sel.value = saved.biome;
  }

  // fishId b_007_exotic_01 → 地图号 b_007 → [B7]；稀有度 = 第 3 段
  function parseFishId(fishId) {
    const p = String(fishId || '').split('_');
    const biomeId = p.length >= 2 ? (p[0] + '_' + p[1]) : '';
    const rarity = p.length >= 3 ? p[2] : '';
    const num = (p[1] || '').replace(/^0+/, '');
    const mapTag = p.length >= 2 ? ('[B' + (num || '') + ']') : '';
    return { biomeId, rarity, mapTag };
  }

  // 鱼种硬编码表 [fishId, name] —— 由 /api/fishpedia 一次性采集（共 990 种）。游戏更新鱼种后手动更新。
  const HARD_FISH = [
    ['b_001_arcane_01', '水车纪元鲟'],
    ['b_001_arcane_02', '月桂星河鳐'],
    ['b_001_arcane_03', '蚀月溪歌姬'],
    ['b_001_arcane_04', '溪源三相龙鲤'],
    ['b_001_arcane_05', '银潮梦鹿鲸'],
    ['b_001_common_01', '银星溪鲦'],
    ['b_001_common_02', '青苔石鳅'],
    ['b_001_common_03', '水车纹鲫'],
    ['b_001_common_04', '柳叶青鳉'],
    ['b_001_common_05', '泉须小鲶'],
    ['b_001_common_06', '赤鳍马口'],
    ['b_001_common_07', '月点麦穗鱼'],
    ['b_001_common_08', '圆石吻虾虎'],
    ['b_001_common_09', '浅湾花鳅'],
    ['b_001_common_10', '溪铃白条'],
    ['b_001_common_11', '苇影鳉'],
    ['b_001_common_12', '露背小鳟'],
    ['b_001_epic_01', '玻璃鳍溪龙鱼'],
    ['b_001_epic_02', '月桂王冠鳜'],
    ['b_001_epic_03', '银瀑织流鲤'],
    ['b_001_epic_04', '星钟灯鱼'],
    ['b_001_epic_05', '夜灯王鳗'],
    ['b_001_epic_06', '虹脊古鲟'],
    ['b_001_epic_07', '月轮翼鳐'],
    ['b_001_epic_08', '水车圣轮鲑'],
    ['b_001_exotic_01', '月影双生斗鱼'],
    ['b_001_exotic_02', '露相千折鳐'],
    ['b_001_exotic_03', '逆瀑琴尾鲶'],
    ['b_001_exotic_04', '梦藻无眠鲤'],
    ['b_001_exotic_05', '溪星拾光蟹'],
    ['b_001_fine_01', '星斑鳜'],
    ['b_001_fine_02', '玉鳍光唇鱼'],
    ['b_001_fine_03', '月盏河鲀'],
    ['b_001_fine_04', '霜翼溪鳟'],
    ['b_001_fine_05', '镜尾弓背鱼'],
    ['b_001_fine_06', '苔舟翘嘴鲌'],
    ['b_001_fine_07', '银冠溪鲈'],
    ['b_001_fine_08', '蓝焰月鳗'],
    ['b_001_legendary_01', '月角河鳐'],
    ['b_001_legendary_02', '古渠镇水鲟'],
    ['b_001_legendary_03', '银瀑九尾鲤'],
    ['b_001_legendary_04', '水车心核鳜'],
    ['b_001_legendary_05', '巡月玄龟'],
    ['b_001_mythic_01', '命轮月鳗'],
    ['b_001_mythic_02', '初潮轮羽龙鱼'],
    ['b_001_mythic_03', '神谕镜甲鲟'],
    ['b_001_mythic_04', '赤曜睡莲灵'],
    ['b_001_mythic_05', '霜月古龙鲑'],
    ['b_001_rare_01', '月藤蛇鳝'],
    ['b_001_rare_02', '露冠飞鳍鱼'],
    ['b_001_rare_03', '紫弦虹鳟'],
    ['b_001_rare_04', '梦涡六须鲶'],
    ['b_001_rare_05', '镜鳞月鳊'],
    ['b_001_rare_06', '月笛长鳗'],
    ['b_001_rare_07', '苔背骨舌鱼'],
    ['b_001_rare_08', '流萤羽鳃鲑'],
    ['b_001_uncommon_01', '月纱溪鲤'],
    ['b_001_uncommon_02', '苔冠溪鱲'],
    ['b_001_uncommon_03', '涟轮月鳊'],
    ['b_001_uncommon_04', '银梭青鳉'],
    ['b_001_uncommon_05', '石鼓杜父鱼'],
    ['b_001_uncommon_06', '月露灯眼鱼'],
    ['b_001_uncommon_07', '苇刀针鱼'],
    ['b_001_uncommon_08', '溪琴鳑鲏'],
    ['b_001_uncommon_09', '泉眼沙塘鳢'],
    ['b_001_uncommon_10', '水轮鳗鲡'],
    ['b_002_arcane_01', '雾冠六鳃天鳢'],
    ['b_002_arcane_02', '万苇听潮鲶'],
    ['b_002_arcane_03', '荷灯水母娘'],
    ['b_002_arcane_04', '洪季年轮骨舌鱼'],
    ['b_002_arcane_05', '泽心脉络鳐'],
    ['b_002_common_01', '雾苇泥鳅'],
    ['b_002_common_02', '灰腹鳑鲏'],
    ['b_002_common_03', '芦影青鳉'],
    ['b_002_common_04', '泥湾小鲫'],
    ['b_002_common_05', '荷梗麦穗鱼'],
    ['b_002_common_06', '沼须小鲶'],
    ['b_002_common_07', '睡莲鳉'],
    ['b_002_common_08', '腐木虾虎'],
    ['b_002_common_09', '苔背月鳢'],
    ['b_002_common_10', '浅泥银鳊'],
    ['b_002_common_11', '露鳍溪鱲'],
    ['b_002_common_12', '雾点泽虾'],
    ['b_002_epic_01', '玻璃荷冠鳜'],
    ['b_002_epic_02', '雾钟灯笼鱼'],
    ['b_002_epic_03', '芦海织流鲤'],
    ['b_002_epic_04', '夜沼王鳗'],
    ['b_002_epic_05', '古荷虹脊鲟'],
    ['b_002_epic_06', '泥宫圣轮鲑'],
    ['b_002_epic_07', '百泡淡水蚌'],
    ['b_002_epic_08', '雾幕水母'],
    ['b_002_exotic_01', '沉雾灯笼鳢'],
    ['b_002_exotic_02', '倒生芦骨鳗'],
    ['b_002_exotic_03', '宿雨空腔鲶'],
    ['b_002_exotic_04', '泥梦折扇章'],
    ['b_002_exotic_05', '百刻睡莲鼋'],
    ['b_002_fine_01', '青灯七鳃鳗'],
    ['b_002_fine_02', '翡翠荷鳍鲤'],
    ['b_002_fine_03', '霜苇长吻鳅'],
    ['b_002_fine_04', '泥金冠鳢'],
    ['b_002_fine_05', '镜荷月鲫'],
    ['b_002_fine_06', '紫雾丝足鲈'],
    ['b_002_fine_07', '腐木铠鲶'],
    ['b_002_fine_08', '荷灯水母'],
    ['b_002_legendary_01', '芦王巨鳢'],
    ['b_002_legendary_02', '古沼泥甲鲟'],
    ['b_002_legendary_03', '百叶莲鲤'],
    ['b_002_legendary_04', '雾潮六须鲶'],
    ['b_002_legendary_05', '守沼老鼋'],
    ['b_002_mythic_01', '万苇听风鳗'],
    ['b_002_mythic_02', '初泥四环古鱼'],
    ['b_002_mythic_03', '神谕荷镜鲤'],
    ['b_002_mythic_04', '腐木轮回鲟'],
    ['b_002_mythic_05', '万荷梦姬'],
    ['b_002_rare_01', '梦雾六须鲶'],
    ['b_002_rare_02', '千叶鳍鲤'],
    ['b_002_rare_03', '泥月镜鳢'],
    ['b_002_rare_04', '芦笛长鳗'],
    ['b_002_rare_05', '萤河骨舌鱼'],
    ['b_002_rare_06', '荷露飞鳍鱼'],
    ['b_002_rare_07', '紫沼河蟹'],
    ['b_002_rare_08', '苔宫沼螺'],
    ['b_002_uncommon_01', '雾纱斗鱼'],
    ['b_002_uncommon_02', '芦刀针鱼'],
    ['b_002_uncommon_03', '泥镜月鳢'],
    ['b_002_uncommon_04', '萤腹塘鳢'],
    ['b_002_uncommon_05', '苇琴鳑鲏'],
    ['b_002_uncommon_06', '荷冠溪鲤'],
    ['b_002_uncommon_07', '泡眼沼鲶'],
    ['b_002_uncommon_08', '灰羽翘嘴鲌'],
    ['b_002_uncommon_09', '沼纹鳗鲡'],
    ['b_002_uncommon_10', '冷露田螺'],
    ['b_003_arcane_01', '白礁圣冠海龙'],
    ['b_003_arcane_02', '日轮虹帆旗鱼'],
    ['b_003_arcane_03', '珠潮人鱼祭司'],
    ['b_003_arcane_04', '千礁共生巨鳐'],
    ['b_003_arcane_05', '万潮镜瞳鲸鲨'],
    ['b_003_common_01', '珠沙小鳀'],
    ['b_003_common_02', '镜湾银鲳'],
    ['b_003_common_03', '珊枝虾虎'],
    ['b_003_common_04', '白礁隆头鱼'],
    ['b_003_common_05', '潮池青鳉'],
    ['b_003_common_06', '玻鳍小鳀'],
    ['b_003_common_07', '贝纹小石斑'],
    ['b_003_common_08', '盐线针鱼'],
    ['b_003_common_09', '蓝沫幼鲷'],
    ['b_003_common_10', '海窗鳚'],
    ['b_003_common_11', '晴礁雀鲷'],
    ['b_003_common_12', '透尾樱虾'],
    ['b_003_epic_01', '万镜鳞鲤'],
    ['b_003_epic_02', '珊瑚王冠鳜'],
    ['b_003_epic_03', '珠海织流鲷'],
    ['b_003_epic_04', '星窗灯鱼'],
    ['b_003_epic_05', '镜夜王鳗'],
    ['b_003_epic_06', '圣礁轮鳐'],
    ['b_003_epic_07', '虹脊砗磲'],
    ['b_003_epic_08', '潮宫章鱼'],
    ['b_003_exotic_01', '棱潮万色蝶鱼'],
    ['b_003_exotic_02', '贝壳迷宫河鲀'],
    ['b_003_exotic_03', '昼夜双面翻车鱼'],
    ['b_003_exotic_04', '轨星珠链章'],
    ['b_003_exotic_05', '潮历书甲龟'],
    ['b_003_fine_01', '虹膜月鱼'],
    ['b_003_fine_02', '玻璃珊鲈'],
    ['b_003_fine_03', '珠冠刺尾鱼'],
    ['b_003_fine_04', '潮盏河鲀'],
    ['b_003_fine_05', '镜翼燕鱼'],
    ['b_003_fine_06', '盐花狮子鱼'],
    ['b_003_fine_07', '珊琴石斑'],
    ['b_003_fine_08', '蓝窗海兔'],
    ['b_003_legendary_01', '镜海月鳐'],
    ['b_003_legendary_02', '白礁镇潮鲟'],
    ['b_003_legendary_03', '珊王九尾鲷'],
    ['b_003_legendary_04', '珠心巨鳜'],
    ['b_003_legendary_05', '守潮砗磲'],
    ['b_003_mythic_01', '万潮听海鳗'],
    ['b_003_mythic_02', '初礁环鳍龙鱼'],
    ['b_003_mythic_03', '神谕珠镜鲤'],
    ['b_003_mythic_04', '千窗轮回鲟'],
    ['b_003_mythic_05', '珊宫潮姬'],
    ['b_003_rare_01', '镜潮六翼鲷'],
    ['b_003_rare_02', '珊宫龙鱼'],
    ['b_003_rare_03', '珠月灯笼鱼'],
    ['b_003_rare_04', '盐镜王鲳'],
    ['b_003_rare_05', '潮笛绸带鳗'],
    ['b_003_rare_06', '玻璃礁鳐'],
    ['b_003_rare_07', '虹珊海星'],
    ['b_003_rare_08', '海沫羽鳃海蛞蝓'],
    ['b_003_uncommon_01', '镜鳞蝴蝶鱼'],
    ['b_003_uncommon_02', '珊冠红娘鱼'],
    ['b_003_uncommon_03', '潮纱海马'],
    ['b_003_uncommon_04', '盐晶河鲀'],
    ['b_003_uncommon_05', '贝歌石首鱼'],
    ['b_003_uncommon_06', '晴浪鹦嘴鱼'],
    ['b_003_uncommon_07', '镜潮鳗鲡'],
    ['b_003_uncommon_08', '珠帘须鲷'],
    ['b_003_uncommon_09', '海窗四眼鱼'],
    ['b_003_uncommon_10', '珊影寄居蟹'],
    ['b_004_arcane_01', '裂云九帆龙鱼'],
    ['b_004_arcane_02', '霆瀑铸脊帝鲑'],
    ['b_004_arcane_03', '风暴鳐翼姬'],
    ['b_004_arcane_04', '天衡双翼巨鳐'],
    ['b_004_arcane_05', '雷脉王骨鳕'],
    ['b_004_common_01', '铁背小鳕'],
    ['b_004_common_02', '崖影幼鲑'],
    ['b_004_common_03', '风鳍青花鱼'],
    ['b_004_common_04', '岩吻虾虎'],
    ['b_004_common_05', '雷点溪鳟'],
    ['b_004_common_06', '裂湾小鲱'],
    ['b_004_common_07', '冷流针鱼'],
    ['b_004_common_08', '云腹鳕'],
    ['b_004_common_09', '锚纹杜父鱼'],
    ['b_004_common_10', '暴雨银鱼'],
    ['b_004_common_11', '黑礁鳚'],
    ['b_004_common_12', '闪尾磷虾'],
    ['b_004_epic_01', '玻璃雷鳍龙鱼'],
    ['b_004_epic_02', '风暴王冠鳜'],
    ['b_004_epic_03', '银瀑织流鲑'],
    ['b_004_epic_04', '雷钟星灯鱼'],
    ['b_004_epic_05', '永夜霆鳗'],
    ['b_004_epic_06', '虹脊古鳕'],
    ['b_004_epic_07', '峡湾圣轮水母'],
    ['b_004_epic_08', '雷痕巨章鱼'],
    ['b_004_exotic_01', '雷前闪鲭'],
    ['b_004_exotic_02', '风眼盘鳗'],
    ['b_004_exotic_03', '极性锚甲鲟'],
    ['b_004_exotic_04', '断雷八臂章'],
    ['b_004_exotic_05', '静界霆冠水母'],
    ['b_004_fine_01', '雷冠狮子鱼'],
    ['b_004_fine_02', '风壁鳐'],
    ['b_004_fine_03', '霆纹鳄雀鳝'],
    ['b_004_fine_04', '崖钟灯鱼'],
    ['b_004_fine_05', '银锚大比目鱼'],
    ['b_004_fine_06', '暴雨琴鲭'],
    ['b_004_fine_07', '铁甲狼鳗'],
    ['b_004_fine_08', '冷虹海葵'],
    ['b_004_legendary_01', '月角风暴鳐'],
    ['b_004_legendary_02', '古峡镇流鲟'],
    ['b_004_legendary_03', '银瀑九尾鲑'],
    ['b_004_legendary_04', '雷心巨鳕'],
    ['b_004_legendary_05', '雷甲海龟'],
    ['b_004_mythic_01', '万风听海鳗'],
    ['b_004_mythic_02', '初雷四环电鳗'],
    ['b_004_mythic_03', '神谕风镜鲑'],
    ['b_004_mythic_04', '终崖轮回鲟'],
    ['b_004_mythic_05', '雷潮风暴姬'],
    ['b_004_rare_01', '雷幕六鳍鳕'],
    ['b_004_rare_02', '裂峡龙鱼'],
    ['b_004_rare_03', '风笛长鳗'],
    ['b_004_rare_04', '镜雷王鳟'],
    ['b_004_rare_05', '云铠古鲟'],
    ['b_004_rare_06', '霆羽飞鳍鱼'],
    ['b_004_rare_07', '怒潮帝王蟹'],
    ['b_004_rare_08', '闪石海胆'],
    ['b_004_uncommon_01', '风锚石斑'],
    ['b_004_uncommon_02', '雷线青鳕'],
    ['b_004_uncommon_03', '裂浪梭鱼'],
    ['b_004_uncommon_04', '崖冠虹鳟'],
    ['b_004_uncommon_05', '电泡河鲀'],
    ['b_004_uncommon_06', '冷雾长鳗'],
    ['b_004_uncommon_07', '云裂飞鱼'],
    ['b_004_uncommon_08', '铁须海鲶'],
    ['b_004_uncommon_09', '暴潮圆鲳'],
    ['b_004_uncommon_10', '闪脊海螺'],
    ['b_005_arcane_01', '万根归海鲟'],
    ['b_005_arcane_02', '星髓王冠腔棘鱼'],
    ['b_005_arcane_03', '晶根洞螈女王'],
    ['b_005_arcane_04', '地心脉动翼灵'],
    ['b_005_arcane_05', '无昼创世盲龙鱼'],
    ['b_005_common_01', '幽苔盲鳅'],
    ['b_005_common_02', '晶须穴鲶'],
    ['b_005_common_03', '星点洞鳉'],
    ['b_005_common_04', '根影虾虎'],
    ['b_005_common_05', '暗河银鱼'],
    ['b_005_common_06', '石吻鳢'],
    ['b_005_common_07', '萤腹小鳟'],
    ['b_005_common_08', '洞泉鲫'],
    ['b_005_common_09', '退目鳚'],
    ['b_005_common_10', '岩缝麦穗鱼'],
    ['b_005_common_11', '夜晶鳊'],
    ['b_005_common_12', '苔尾洞虾'],
    ['b_005_epic_01', '星根圣冠鱼'],
    ['b_005_epic_02', '无昼月鳗'],
    ['b_005_epic_03', '晶河帝王鲑'],
    ['b_005_epic_04', '地脉龙首鳅'],
    ['b_005_epic_05', '万年苔甲鲟'],
    ['b_005_epic_06', '星窟玻璃水母'],
    ['b_005_epic_07', '根王巨螯蟹'],
    ['b_005_epic_08', '夜晶十二鳍'],
    ['b_005_exotic_01', '盲星回声鲶'],
    ['b_005_exotic_02', '反重晶腹鳐'],
    ['b_005_exotic_03', '食光苔冠鳢'],
    ['b_005_exotic_04', '根脉折跃鳗'],
    ['b_005_exotic_05', '地晶梦壳螈'],
    ['b_005_fine_01', '星根骨舌鱼'],
    ['b_005_fine_02', '月窟银龙鱼'],
    ['b_005_fine_03', '晶盔狼鳗'],
    ['b_005_fine_04', '萤幕六鳍鲶'],
    ['b_005_fine_05', '地脉赤鳟'],
    ['b_005_fine_06', '石花比目鱼'],
    ['b_005_fine_07', '夜髓古鲟'],
    ['b_005_fine_08', '根笛洞螈'],
    ['b_005_legendary_01', '月髓皇冠鲈'],
    ['b_005_legendary_02', '星根盘龙鳗'],
    ['b_005_legendary_03', '万晶地宫鳐'],
    ['b_005_legendary_04', '初泉祖鲟'],
    ['b_005_legendary_05', '背碑洞鼋'],
    ['b_005_mythic_01', '地心星脉鱼'],
    ['b_005_mythic_02', '万夜守灯鳗'],
    ['b_005_mythic_03', '神木根冠鲑'],
    ['b_005_mythic_04', '无声晶翼蝠鲼'],
    ['b_005_mythic_05', '星根梦灵'],
    ['b_005_rare_01', '万晶王鲤'],
    ['b_005_rare_02', '星井吞光鳗'],
    ['b_005_rare_03', '古根六须鲶'],
    ['b_005_rare_04', '月脉盲鳐'],
    ['b_005_rare_05', '晶冠洞鳢'],
    ['b_005_rare_06', '地心镜鲑'],
    ['b_005_rare_07', '萤河盲蟹'],
    ['b_005_rare_08', '黑曜洞螯虾'],
    ['b_005_uncommon_01', '月髓盲鲈'],
    ['b_005_uncommon_02', '晶簇石斑'],
    ['b_005_uncommon_03', '根须长鳗'],
    ['b_005_uncommon_04', '萤线虹鳟'],
    ['b_005_uncommon_05', '暗泉玻璃鲶'],
    ['b_005_uncommon_06', '星砂鳅'],
    ['b_005_uncommon_07', '石环七鳃鳗'],
    ['b_005_uncommon_08', '苔冠月鱼'],
    ['b_005_uncommon_09', '洞钟灯鱼'],
    ['b_005_uncommon_10', '晶脊洞螺'],
    ['b_006_arcane_01', '天候编纬鲤'],
    ['b_006_arcane_02', '百鸟归航龙鱼'],
    ['b_006_arcane_03', '湖心倒悬鼋'],
    ['b_006_arcane_04', '四野息风巨鲶'],
    ['b_006_arcane_05', '霞原候鸟姬'],
    ['b_006_common_01', '霞鳞湖鲫'],
    ['b_006_common_02', '风尾白鲦'],
    ['b_006_common_03', '苇影小鲈'],
    ['b_006_common_04', '晴腹鳑鲏'],
    ['b_006_common_05', '花斑泥鳅'],
    ['b_006_common_06', '雁羽麦穗鱼'],
    ['b_006_common_07', '暖湾鳟'],
    ['b_006_common_08', '露珠虾虎'],
    ['b_006_common_09', '云底银鱼'],
    ['b_006_common_10', '草香鳢'],
    ['b_006_common_11', '夕照小鳊'],
    ['b_006_common_12', '铃尾湖虾'],
    ['b_006_epic_01', '霞栖圣羽鱼'],
    ['b_006_epic_02', '万风巡湖旗鱼'],
    ['b_006_epic_03', '晴空镜龙鱼'],
    ['b_006_epic_04', '百花冠王鲤'],
    ['b_006_epic_05', '雁门破浪鲑'],
    ['b_006_epic_06', '金露帝王鲶'],
    ['b_006_epic_07', '虹原羽鳃螺'],
    ['b_006_epic_08', '夕阳绒螯蟹'],
    ['b_006_exotic_01', '迟暮跳时鱼'],
    ['b_006_exotic_02', '借季花鳞鲫'],
    ['b_006_exotic_03', '风洞回声鲶'],
    ['b_006_exotic_04', '断岸跃门鲑'],
    ['b_006_exotic_05', '云脚露囊章鱼'],
    ['b_006_fine_01', '霞幕六鳍鱼'],
    ['b_006_fine_02', '风车鳍鲈'],
    ['b_006_fine_03', '晴穹骨舌鱼'],
    ['b_006_fine_04', '百花王鲤'],
    ['b_006_fine_05', '雁书长鳗'],
    ['b_006_fine_06', '金露灯鱼'],
    ['b_006_fine_07', '湖原角鲶'],
    ['b_006_fine_08', '夕虹水母'],
    ['b_006_legendary_01', '九霞天衣鲤'],
    ['b_006_legendary_02', '牧风神鳟'],
    ['b_006_legendary_03', '万花湖心鲈'],
    ['b_006_legendary_04', '日轮金龙鱼'],
    ['b_006_legendary_05', '驮岬老鼋'],
    ['b_006_mythic_01', '北汀驼峰鲑'],
    ['b_006_mythic_02', '雁路司南鳗'],
    ['b_006_mythic_03', '暮霞蓄光鲤'],
    ['b_006_mythic_04', '苇海鸣簧鲈'],
    ['b_006_mythic_05', '牧风毡翼鳐'],
    ['b_006_rare_01', '万霞织鳍鲑'],
    ['b_006_rare_02', '风庭王鲈'],
    ['b_006_rare_03', '花海巨鲤'],
    ['b_006_rare_04', '晴日金枪鱼'],
    ['b_006_rare_05', '雁回月鳗'],
    ['b_006_rare_06', '草原六须鲶'],
    ['b_006_rare_07', '朝露湖蟹'],
    ['b_006_rare_08', '湖歌淡水蚌'],
    ['b_006_uncommon_01', '霞冠虹鳟'],
    ['b_006_uncommon_02', '风纹草鱼'],
    ['b_006_uncommon_03', '草原芦笛鳗'],
    ['b_006_uncommon_04', '晴镜圆鲳'],
    ['b_006_uncommon_05', '花原锦鲤'],
    ['b_006_uncommon_06', '雁阵梭鱼'],
    ['b_006_uncommon_07', '露环鲶'],
    ['b_006_uncommon_08', '暖云月鱼'],
    ['b_006_uncommon_09', '牧风银鲑'],
    ['b_006_uncommon_10', '芳草湖螺'],
    ['b_007_arcane_01', '穹湖脉络龙鱼'],
    ['b_007_arcane_02', '万阶升潮鳐'],
    ['b_007_arcane_03', '天底倒映鲲'],
    ['b_007_arcane_04', '雷虹播种鲟'],
    ['b_007_arcane_05', '悬湖守汐姬'],
    ['b_007_common_01', '云腹小鲫'],
    ['b_007_common_02', '汐纹银鲦'],
    ['b_007_common_03', '浮叶鳑鲏'],
    ['b_007_common_04', '天光鳉'],
    ['b_007_common_05', '瀑尾小鳟'],
    ['b_007_common_06', '风铃虾虎'],
    ['b_007_common_07', '悬湖泥鳅'],
    ['b_007_common_08', '云影小鲈'],
    ['b_007_common_09', '露珠银鱼'],
    ['b_007_common_10', '岚鳍鳚'],
    ['b_007_common_11', '天池麦穗鱼'],
    ['b_007_common_12', '羽尾云虾'],
    ['b_007_epic_01', '九霄云龙鱼'],
    ['b_007_epic_02', '万风圣翼鳐'],
    ['b_007_epic_03', '浮岛王鲟'],
    ['b_007_epic_04', '天河倒游鲑'],
    ['b_007_epic_05', '云门冠鳢'],
    ['b_007_epic_06', '虹梯六翼飞鱼'],
    ['b_007_epic_07', '风铃浮螺'],
    ['b_007_epic_08', '星露云水母'],
    ['b_007_exotic_01', '落向未定鱼'],
    ['b_007_exotic_02', '缺岸洄游鲑'],
    ['b_007_exotic_03', '零重壳月螺'],
    ['b_007_exotic_04', '云层剪影乌贼'],
    ['b_007_exotic_05', '反瀑滴轮水母'],
    ['b_007_fine_01', '天河银龙鱼'],
    ['b_007_fine_02', '云梯九鳍鲑'],
    ['b_007_fine_03', '风眼镜鳐'],
    ['b_007_fine_04', '浮光帝王鲤'],
    ['b_007_fine_05', '瀑琴长鳗'],
    ['b_007_fine_06', '云港锚纹鲟'],
    ['b_007_fine_07', '天露六须鲶'],
    ['b_007_fine_08', '虹桥水母'],
    ['b_007_legendary_01', '云汐天冠龙鱼'],
    ['b_007_legendary_02', '万瀑归一鳗'],
    ['b_007_legendary_03', '神风镜翼鳐'],
    ['b_007_legendary_04', '天岛祖鲟'],
    ['b_007_legendary_05', '浮岛云龟'],
    ['b_007_mythic_01', '升瀑银梭'],
    ['b_007_mythic_02', '浮囊琴鲂'],
    ['b_007_mythic_03', '云脊帆鲟'],
    ['b_007_mythic_04', '虹汐螺旋鳗'],
    ['b_007_mythic_05', '岛根抱石鲶'],
    ['b_007_rare_01', '云海王冠鲈'],
    ['b_007_rare_02', '天穹织风鳟'],
    ['b_007_rare_03', '无岸浮岛鱼'],
    ['b_007_rare_04', '汐月双尾鲑'],
    ['b_007_rare_05', '瀑门龙鳗'],
    ['b_007_rare_06', '浮岛古鲟'],
    ['b_007_rare_07', '风羽云蟹'],
    ['b_007_rare_08', '天镜星海兔'],
    ['b_007_uncommon_01', '云冠虹鳟'],
    ['b_007_uncommon_02', '风帆草鱼'],
    ['b_007_uncommon_03', '悬瀑长鳗'],
    ['b_007_uncommon_04', '天镜圆鲳'],
    ['b_007_uncommon_05', '浮岛石斑'],
    ['b_007_uncommon_06', '汐钟灯鱼'],
    ['b_007_uncommon_07', '云须鲶'],
    ['b_007_uncommon_08', '羽翼飞鱼'],
    ['b_007_uncommon_09', '晴空骨舌鱼'],
    ['b_007_uncommon_10', '雾环天螺'],
    ['b_008_arcane_01', '赤海回春龙鱼'],
    ['b_008_arcane_02', '地核冷泉鲟'],
    ['b_008_arcane_03', '千绿洲星盘鳐'],
    ['b_008_arcane_04', '沙暴饮潮海牛'],
    ['b_008_arcane_05', '泉脉司水姬'],
    ['b_008_common_01', '赤砂小鲫'],
    ['b_008_common_02', '泉眼青鳉'],
    ['b_008_common_03', '金背泥鳅'],
    ['b_008_common_04', '绿洲鳑鲏'],
    ['b_008_common_05', '沙纹虾虎'],
    ['b_008_common_06', '暖泉小鳟'],
    ['b_008_common_07', '日斑麦穗鱼'],
    ['b_008_common_08', '苇尾鳢'],
    ['b_008_common_09', '砾吻鲶'],
    ['b_008_common_10', '涌泉银鱼'],
    ['b_008_common_11', '赤鳍鳚'],
    ['b_008_common_12', '琥珀泉虾'],
    ['b_008_epic_01', '九阳赤龙鱼'],
    ['b_008_epic_02', '万泉织流鲑'],
    ['b_008_epic_03', '绿洲圣冠鲤'],
    ['b_008_epic_04', '赤砂风暴鳐'],
    ['b_008_epic_05', '地火王甲鲟'],
    ['b_008_epic_06', '蜃楼镜鳢'],
    ['b_008_epic_07', '熔砂巨虾'],
    ['b_008_epic_08', '日轮章鱼'],
    ['b_008_exotic_01', '沸点漂移鲈'],
    ['b_008_exotic_02', '失水仍游鳐'],
    ['b_008_exotic_03', '百井同声鲶'],
    ['b_008_exotic_04', '沙纹自改章鱼'],
    ['b_008_exotic_05', '夜泉倒影龟'],
    ['b_008_fine_01', '日轮骨舌鱼'],
    ['b_008_fine_02', '赤脉龙鱼'],
    ['b_008_fine_03', '绿洲花冠鲤'],
    ['b_008_fine_04', '涌泉六翼鳐'],
    ['b_008_fine_05', '沙钟灯笼鱼'],
    ['b_008_fine_06', '赤砾狼鳗'],
    ['b_008_fine_07', '晴热王鲈'],
    ['b_008_fine_08', '火脉绒螯蟹'],
    ['b_008_legendary_01', '赤砂天冠肺鱼'],
    ['b_008_legendary_02', '万泉祖龙鱼'],
    ['b_008_legendary_03', '绿洲神树鲤'],
    ['b_008_legendary_04', '日蚀赤鳐'],
    ['b_008_legendary_05', '驮泉沙龟'],
    ['b_008_mythic_01', '盐冠储潮鲷'],
    ['b_008_mythic_02', '昼夜换鳃鲶'],
    ['b_008_mythic_03', '赤砾钻泉鳗'],
    ['b_008_mythic_04', '蜃叶呼雨鱼'],
    ['b_008_mythic_05', '琥珀沙钟螈'],
    ['b_008_rare_01', '万砂星鳞鲤'],
    ['b_008_rare_02', '地泉龙首鳅'],
    ['b_008_rare_03', '赤日镜鳐'],
    ['b_008_rare_04', '绿洲帝王鲑'],
    ['b_008_rare_05', '沙海长鬃鳗'],
    ['b_008_rare_06', '泉冠古鲟'],
    ['b_008_rare_07', '绿洲月贝'],
    ['b_008_rare_08', '蜃幕水母'],
    ['b_008_uncommon_01', '赤霞虹鳟'],
    ['b_008_uncommon_02', '泉脉草鱼'],
    ['b_008_uncommon_03', '沙帆月鱼'],
    ['b_008_uncommon_04', '绿洲镜鲤'],
    ['b_008_uncommon_05', '热雾长鳗'],
    ['b_008_uncommon_06', '日针梭鱼'],
    ['b_008_uncommon_07', '泉铃灯鱼'],
    ['b_008_uncommon_08', '砂甲小鲟'],
    ['b_008_uncommon_09', '苇影六须鲶'],
    ['b_008_uncommon_10', '沙铃泉螺'],
    ['b_009_arcane_01', '极冠定星龙鳕'],
    ['b_009_arcane_02', '万载浮冰鼋'],
    ['b_009_arcane_03', '曙线开海鳐'],
    ['b_009_arcane_04', '极夜孵光鲸'],
    ['b_009_arcane_05', '极光巡湾姬'],
    ['b_009_common_01', '霜鳞小鳕'],
    ['b_009_common_02', '冰湾幼鲑'],
    ['b_009_common_03', '雪腹小鲱'],
    ['b_009_common_04', '极光青花鱼'],
    ['b_009_common_05', '冰缝虾虎'],
    ['b_009_common_06', '冻露针鱼'],
    ['b_009_common_07', '白夜银鱼'],
    ['b_009_common_08', '冰砂泥鳅'],
    ['b_009_common_09', '雪冠鳚'],
    ['b_009_common_10', '寒潮小鲈'],
    ['b_009_common_11', '冰晶麦穗鱼'],
    ['b_009_common_12', '蓝雪磷虾'],
    ['b_009_epic_01', '九曜极光鱼'],
    ['b_009_epic_02', '冰湾圣冠旗鱼'],
    ['b_009_epic_03', '永昼天镜鳐'],
    ['b_009_epic_04', '雪原祖龙鱼'],
    ['b_009_epic_05', '寒潮帝王鲑'],
    ['b_009_epic_06', '极星王甲鲟'],
    ['b_009_epic_07', '冰瀑巨乌贼'],
    ['b_009_epic_08', '曙光海豹'],
    ['b_009_exotic_01', '无影低日鳐'],
    ['b_009_exotic_02', '温度交换鲈'],
    ['b_009_exotic_03', '折光七色鳗'],
    ['b_009_exotic_04', '未冻先裂蟹'],
    ['b_009_exotic_05', '逆融海豹'],
    ['b_009_fine_01', '极光骨舌鱼'],
    ['b_009_fine_02', '冰冠王鲑'],
    ['b_009_fine_03', '雪原狼鳗'],
    ['b_009_fine_04', '永昼镜鳐'],
    ['b_009_fine_05', '霜月灯笼鱼'],
    ['b_009_fine_06', '冰河龙鱼'],
    ['b_009_fine_07', '寒风琴鳟'],
    ['b_009_fine_08', '极光海天使'],
    ['b_009_legendary_01', '极昼皇冠鳕'],
    ['b_009_legendary_02', '万冰归流鲑'],
    ['b_009_legendary_03', '极光神翼鳐'],
    ['b_009_legendary_04', '初雪祖鲟'],
    ['b_009_legendary_05', '极昼冰龟'],
    ['b_009_mythic_01', '白昼藏夜鳕'],
    ['b_009_mythic_02', '磁潮冠鲑'],
    ['b_009_mythic_03', '冰层年轮鲟'],
    ['b_009_mythic_04', '雪音鼓腹鱼'],
    ['b_009_mythic_05', '霜灯海天使'],
    ['b_009_rare_01', '万霜王鳕'],
    ['b_009_rare_02', '极昼日轮鲑'],
    ['b_009_rare_03', '冰脉古鲟'],
    ['b_009_rare_04', '雪幕六翼鳐'],
    ['b_009_rare_05', '极光长鬃鳗'],
    ['b_009_rare_06', '寒星巨口鲈'],
    ['b_009_rare_07', '霜甲帝王蟹'],
    ['b_009_rare_08', '蓝夜冰灯水母'],
    ['b_009_uncommon_01', '极昼虹鳟'],
    ['b_009_uncommon_02', '冰帆青鳕'],
    ['b_009_uncommon_03', '雪线长鳗'],
    ['b_009_uncommon_04', '霜镜圆鲳'],
    ['b_009_uncommon_05', '冰铃灯鱼'],
    ['b_009_uncommon_06', '寒羽飞鱼'],
    ['b_009_uncommon_07', '极光六须鲶'],
    ['b_009_uncommon_08', '冻潮河鲀'],
    ['b_009_uncommon_09', '白湾古鲟'],
    ['b_009_uncommon_10', '雪铃海螺'],
    ['b_010_arcane_01', '万钟共鸣龙鱼'],
    ['b_010_arcane_02', '沉城负碑巨鳐'],
    ['b_010_arcane_03', '失航图书鲟'],
    ['b_010_arcane_04', '潮墓复苏帝王蟹'],
    ['b_010_arcane_05', '古港守钟姬'],
    ['b_010_common_01', '锈鳞小鲷'],
    ['b_010_common_02', '钟影银鲱'],
    ['b_010_common_03', '缆纹虾虎'],
    ['b_010_common_04', '青铜鳚'],
    ['b_010_common_05', '旧港鳑鲏'],
    ['b_010_common_06', '沉木小鲈'],
    ['b_010_common_07', '潮钟青鳉'],
    ['b_010_common_08', '盐雾针鱼'],
    ['b_010_common_09', '锚尾泥鳅'],
    ['b_010_common_10', '月窗银鱼'],
    ['b_010_common_11', '钟舌小鳕'],
    ['b_010_common_12', '锈壳港虾'],
    ['b_010_epic_01', '九钟王冠鱼'],
    ['b_010_epic_02', '沉城圣甲鲟'],
    ['b_010_epic_03', '万缆织流鳗'],
    ['b_010_epic_04', '潮钟帝王鲑'],
    ['b_010_epic_05', '月锚神翼鳐'],
    ['b_010_epic_06', '旧港龙冠鲷'],
    ['b_010_epic_07', '钟楼章鱼'],
    ['b_010_epic_08', '沉港帝王蟹'],
    ['b_010_exotic_01', '空舱回游鱼'],
    ['b_010_exotic_02', '借壳记忆章鱼'],
    ['b_010_exotic_03', '钟声先至鲑'],
    ['b_010_exotic_04', '无门归港龟'],
    ['b_010_exotic_05', '倒灌街巷水母'],
    ['b_010_fine_01', '沉城骨舌鱼'],
    ['b_010_fine_02', '青铜王鲑'],
    ['b_010_fine_03', '锚链狼鳗'],
    ['b_010_fine_04', '钟楼灯鱼'],
    ['b_010_fine_05', '月港镜鳐'],
    ['b_010_fine_06', '潮轮六鳍鲷'],
    ['b_010_fine_07', '旧王冠鳜'],
    ['b_010_fine_08', '铜铃寄居蟹'],
    ['b_010_legendary_01', '古港天冠龙鱼'],
    ['b_010_legendary_02', '万锚守潮鲟'],
    ['b_010_legendary_03', '月钟神鳗'],
    ['b_010_legendary_04', '沉城九尾鲑'],
    ['b_010_legendary_05', '驮钟海龟'],
    ['b_010_mythic_01', '潮汐铸钟鲷'],
    ['b_010_mythic_02', '拱桥穿影鳗'],
    ['b_010_mythic_03', '船墓护灯鲉'],
    ['b_010_mythic_04', '石塔刻度鲟'],
    ['b_010_mythic_05', '缆结潮蟹'],
    ['b_010_rare_01', '万钟听潮鳗'],
    ['b_010_rare_02', '沉港龙鱼'],
    ['b_010_rare_03', '月锚帝王鲑'],
    ['b_010_rare_04', '青铜镜鲟'],
    ['b_010_rare_05', '潮宫王鲈'],
    ['b_010_rare_06', '锈月巨口鱼'],
    ['b_010_rare_07', '古锚海星'],
    ['b_010_rare_08', '月窗水母'],
    ['b_010_uncommon_01', '铜铃虹鳟'],
    ['b_010_uncommon_02', '沉钟石斑'],
    ['b_010_uncommon_03', '缆索长鳗'],
    ['b_010_uncommon_04', '海窗蝴蝶鱼'],
    ['b_010_uncommon_05', '锚冠鲈'],
    ['b_010_uncommon_06', '港灯鮟鱇'],
    ['b_010_uncommon_07', '铜甲河鲀'],
    ['b_010_uncommon_08', '潮笛须鲷'],
    ['b_010_uncommon_09', '旧帆燕鱼'],
    ['b_010_uncommon_10', '钟纹海螺'],
    ['b_011_arcane_01', '母河种脉鲟'],
    ['b_011_arcane_02', '万林潮肺森蚺'],
    ['b_011_arcane_03', '初绿种心鲤'],
    ['b_011_arcane_04', '昼雨双生叶鳐'],
    ['b_011_arcane_05', '万根雨幕水灵'],
    ['b_011_common_01', '翠纹小鲫'],
    ['b_011_common_02', '雨点灯鳉'],
    ['b_011_common_03', '根须泥鳅'],
    ['b_011_common_04', '藤影虾虎'],
    ['b_011_common_05', '洪流银鱼'],
    ['b_011_common_06', '叶腹鳑鲏'],
    ['b_011_common_07', '翡翠小鲈'],
    ['b_011_common_08', '雨林短鲶'],
    ['b_011_common_09', '花尾麦穗鱼'],
    ['b_011_common_10', '树洞鳚'],
    ['b_011_common_11', '雾腹小鳟'],
    ['b_011_common_12', '翠叶河虾'],
    ['b_011_epic_01', '层叶冠骨舌鱼'],
    ['b_011_epic_02', '万河归流龙鱼'],
    ['b_011_epic_03', '旱湾送雨鳐'],
    ['b_011_epic_04', '盘根镇床鲟'],
    ['b_011_epic_05', '返青双尾鲑'],
    ['b_011_epic_06', '花海长鬃鳗'],
    ['b_011_epic_07', '雨鼓巨河虾'],
    ['b_011_epic_08', '树宫章鱼'],
    ['b_011_exotic_01', '叶生归鳞鱼'],
    ['b_011_exotic_02', '倒悬根海鳐'],
    ['b_011_exotic_03', '并河结鳗'],
    ['b_011_exotic_04', '千树跃门蛙'],
    ['b_011_exotic_05', '空叶河图章鱼'],
    ['b_011_fine_01', '翡翠龙鱼'],
    ['b_011_fine_02', '万叶王鲤'],
    ['b_011_fine_03', '洪林六翼鳐'],
    ['b_011_fine_04', '雨鼓帝王鲑'],
    ['b_011_fine_05', '藤笛长鳗'],
    ['b_011_fine_06', '根冠古鲟'],
    ['b_011_fine_07', '花影王鲈'],
    ['b_011_fine_08', '翠冠树蛙'],
    ['b_011_legendary_01', '雨棚巨骨舌鱼'],
    ['b_011_legendary_02', '瀑帘银鲑'],
    ['b_011_legendary_03', '绝种种库龙鱼'],
    ['b_011_legendary_04', '洪痕碑鲟'],
    ['b_011_legendary_05', '驮林巨鼋'],
    ['b_011_mythic_01', '初霖肺鱼'],
    ['b_011_mythic_02', '共根神鲶'],
    ['b_011_mythic_03', '花历巨鲤'],
    ['b_011_mythic_04', '蜕季藤鳗'],
    ['b_011_mythic_05', '雨冠蹼尾蛙姬'],
    ['b_011_rare_01', '万雨织鳍鲑'],
    ['b_011_rare_02', '翡翠圣冠鲤'],
    ['b_011_rare_03', '洪流巨口鲶'],
    ['b_011_rare_04', '树海镜鳐'],
    ['b_011_rare_05', '古藤龙鳗'],
    ['b_011_rare_06', '雨夜灯冠鱼'],
    ['b_011_rare_07', '洪林绒螯蟹'],
    ['b_011_rare_08', '翡翠伞水母'],
    ['b_011_uncommon_01', '雨冠虹鳟'],
    ['b_011_uncommon_02', '藤鞭长鳗'],
    ['b_011_uncommon_03', '翡翠镜鲤'],
    ['b_011_uncommon_04', '洪钟石首鱼'],
    ['b_011_uncommon_05', '根甲小鲟'],
    ['b_011_uncommon_06', '花冠月鱼'],
    ['b_011_uncommon_07', '雨幕飞鱼'],
    ['b_011_uncommon_08', '林灯骨舌鱼'],
    ['b_011_uncommon_09', '红果河鲀'],
    ['b_011_uncommon_10', '雨林河螺'],
    ['b_012_arcane_01', '太阳熔心鱼'],
    ['b_012_arcane_02', '地火泄压凰尾鱼'],
    ['b_012_arcane_03', '造礁熔笔龙鱼'],
    ['b_012_arcane_04', '昼熔夜泉鳐'],
    ['b_012_arcane_05', '环礁火山海龙'],
    ['b_012_common_01', '熔斑小鲷'],
    ['b_012_common_02', '火泉青鳉'],
    ['b_012_common_03', '灰礁虾虎'],
    ['b_012_common_04', '赤尾雀鲷'],
    ['b_012_common_05', '硫纹鳚'],
    ['b_012_common_06', '环礁鳑鲏'],
    ['b_012_common_07', '暖流小鳀'],
    ['b_012_common_08', '黑砂泥鳅'],
    ['b_012_common_09', '焰点隆头鱼'],
    ['b_012_common_10', '赤潮银鱼'],
    ['b_012_common_11', '焦岩小石斑'],
    ['b_012_common_12', '余烬礁虾'],
    ['b_012_epic_01', '冷焰扇鳍鲷'],
    ['b_012_epic_02', '万礁守护隆头鱼'],
    ['b_012_epic_03', '热障黑帆鳐'],
    ['b_012_epic_04', '熔层纪甲鲟'],
    ['b_012_epic_05', '双泉泵尾鲑'],
    ['b_012_epic_06', '日蚀龙鳗'],
    ['b_012_epic_07', '岩浆环章鱼'],
    ['b_012_epic_08', '火环巨砗磲'],
    ['b_012_exotic_01', '吞热冷焰鱼'],
    ['b_012_exotic_02', '先沸镜鳐'],
    ['b_012_exotic_03', '缝界礁鳗'],
    ['b_012_exotic_04', '胎礁门章鱼'],
    ['b_012_exotic_05', '悖温玻璃海兔姬'],
    ['b_012_fine_01', '熔潮龙鱼'],
    ['b_012_fine_02', '日焰王鲑'],
    ['b_012_fine_03', '火山镜鳐'],
    ['b_012_fine_04', '灰冠古鲟'],
    ['b_012_fine_05', '赤珊狮子鱼'],
    ['b_012_fine_06', '熔钟灯鱼'],
    ['b_012_fine_07', '热浪狼鳗'],
    ['b_012_fine_08', '熔脉绒螯蟹'],
    ['b_012_legendary_01', '熔雨鬃狮子鱼'],
    ['b_012_legendary_02', '火脉测温龙鱼'],
    ['b_012_legendary_03', '珊枝缝礁鲑'],
    ['b_012_legendary_04', '黑曜镇潮鲟'],
    ['b_012_legendary_05', '熔甲海龟'],
    ['b_012_mythic_01', '原焰肺鱼'],
    ['b_012_mythic_02', '火眼地脉鳐'],
    ['b_012_mythic_03', '白灰预兆鲑'],
    ['b_012_mythic_04', '涅礁熔鳗'],
    ['b_012_mythic_05', '熔潮海葵姬'],
    ['b_012_rare_01', '万焰鳞鲤'],
    ['b_012_rare_02', '环火帝王鲑'],
    ['b_012_rare_03', '黑曜圣甲鲟'],
    ['b_012_rare_04', '熔海龙鳗'],
    ['b_012_rare_05', '火冠王鲈'],
    ['b_012_rare_06', '赤潮六翼鳐'],
    ['b_012_rare_07', '焰心海胆'],
    ['b_012_rare_08', '灰烬水母'],
    ['b_012_uncommon_01', '熔冠虹鳟'],
    ['b_012_uncommon_02', '火脉鹦嘴鱼'],
    ['b_012_uncommon_03', '灰烬长鳗'],
    ['b_012_uncommon_04', '赤环河鲀'],
    ['b_012_uncommon_05', '熔镜圆鲳'],
    ['b_012_uncommon_06', '温泉六须鲶'],
    ['b_012_uncommon_07', '焰翼飞鱼'],
    ['b_012_uncommon_08', '黑曜骨舌鱼'],
    ['b_012_uncommon_09', '熔潮石首鱼'],
    ['b_012_uncommon_10', '熔锥海螺'],
    ['b_013_arcane_01', '天河产湖鱼'],
    ['b_013_arcane_02', '万界共夜海龙'],
    ['b_013_arcane_03', '昼夜升降鳐'],
    ['b_013_arcane_04', '原声云生鲑'],
    ['b_013_arcane_05', '天穹祖鲸'],
    ['b_013_common_01', '云鳞小鲫'],
    ['b_013_common_02', '星点青鳉'],
    ['b_013_common_03', '风尾银鲦'],
    ['b_013_common_04', '天河泥鳅'],
    ['b_013_common_05', '鲸影小鲱'],
    ['b_013_common_06', '浮星虾虎'],
    ['b_013_common_07', '晴空鳑鲏'],
    ['b_013_common_08', '羽腹小鳟'],
    ['b_013_common_09', '云礁鳚'],
    ['b_013_common_10', '天光银鱼'],
    ['b_013_common_11', '天星须鲶'],
    ['b_013_common_12', '云羽浮虾'],
    ['b_013_epic_01', '云阶帆龙鱼'],
    ['b_013_epic_02', '万鲸听歌鲑'],
    ['b_013_epic_03', '夜幕帆翼鳐'],
    ['b_013_epic_04', '浮陆脊甲鲟'],
    ['b_013_epic_05', '风环巡天鲨'],
    ['b_013_epic_06', '日月双尾鱼'],
    ['b_013_epic_07', '极光天乌贼'],
    ['b_013_epic_08', '浮陆巨砗磲'],
    ['b_013_exotic_01', '上坠星鱼'],
    ['b_013_exotic_02', '穹中穹鳐'],
    ['b_013_exotic_03', '穿层梭鳗'],
    ['b_013_exotic_04', '无重云汐水精灵'],
    ['b_013_exotic_05', '虚空章鱼'],
    ['b_013_fine_01', '鲸海龙鱼'],
    ['b_013_fine_02', '星冠帝王鲑'],
    ['b_013_fine_03', '万云镜鳐'],
    ['b_013_fine_04', '风环六鳍鲼'],
    ['b_013_fine_05', '天琴长鳗'],
    ['b_013_fine_06', '浮陆古鲟'],
    ['b_013_fine_07', '星门王鲈'],
    ['b_013_fine_08', '流星水母'],
    ['b_013_legendary_01', '压暴穹帆鱼'],
    ['b_013_legendary_02', '航星脊龙鱼'],
    ['b_013_legendary_03', '鲸语远播鲑'],
    ['b_013_legendary_04', '寻岛风眼鳐'],
    ['b_013_legendary_05', '浮陆天龟'],
    ['b_013_mythic_01', '澄空鳞羽鱼'],
    ['b_013_mythic_02', '纵层巡游鲲'],
    ['b_013_mythic_03', '梦航额舵鲑'],
    ['b_013_mythic_04', '无重聚河鳗'],
    ['b_013_mythic_05', '星风鲸歌姬'],
    ['b_013_rare_01', '万星织鳍鱼'],
    ['b_013_rare_02', '云海帝王鲑'],
    ['b_013_rare_03', '鲸影圣冠鲨'],
    ['b_013_rare_04', '天穹镜龙鱼'],
    ['b_013_rare_05', '风暴王甲鲟'],
    ['b_013_rare_06', '星歌巨口鲈'],
    ['b_013_rare_07', '风羽天蟹'],
    ['b_013_rare_08', '云海兔'],
    ['b_013_uncommon_01', '天冠虹鳟'],
    ['b_013_uncommon_02', '云帆月鱼'],
    ['b_013_uncommon_03', '星河长鳗'],
    ['b_013_uncommon_04', '鲸歌石首鱼'],
    ['b_013_uncommon_05', '浮岛镜鲤'],
    ['b_013_uncommon_06', '风翼飞鱼'],
    ['b_013_uncommon_07', '天灯骨舌鱼'],
    ['b_013_uncommon_08', '云钟河鲀'],
    ['b_013_uncommon_09', '星帆小鲟'],
    ['b_013_uncommon_10', '天穹云螺'],
    ['b_014_arcane_01', '永恒瞬鱼'],
    ['b_014_arcane_02', '万古时冠鹦鹉螺'],
    ['b_014_arcane_03', '原历刻鳞龙鱼'],
    ['b_014_arcane_04', '终末返晨鳐'],
    ['b_014_arcane_05', '纪元回流海天使'],
    ['b_014_common_01', '回纹小鲫'],
    ['b_014_common_02', '时点青鳉'],
    ['b_014_common_03', '镜腹鳑鲏'],
    ['b_014_common_04', '逆流泥鳅'],
    ['b_014_common_05', '春鳞小鲈'],
    ['b_014_common_06', '夏尾银鲦'],
    ['b_014_common_07', '秋斑虾虎'],
    ['b_014_common_08', '冬腹小鳟'],
    ['b_014_common_09', '秒针针鱼'],
    ['b_014_common_10', '旧影银鱼'],
    ['b_014_common_11', '镜岸鳚'],
    ['b_014_common_12', '刻度回流虾'],
    ['b_014_epic_01', '叠世背鳍鱼'],
    ['b_014_epic_02', '万年巡游古鱼'],
    ['b_014_epic_03', '双岸校流鳐'],
    ['b_014_epic_04', '四季蜕鳞龙鱼'],
    ['b_014_epic_05', '旧水回补鲑'],
    ['b_014_epic_06', '城史浮雕鲟'],
    ['b_014_epic_07', '倒时章鱼'],
    ['b_014_epic_08', '轮回钟水母'],
    ['b_014_exotic_01', '因果倒游鱼'],
    ['b_014_exotic_02', '他择镜鳐'],
    ['b_014_exotic_03', '年结刻度鳗'],
    ['b_014_exotic_04', '异年钟水母'],
    ['b_014_exotic_05', '悖论章鱼'],
    ['b_014_fine_01', '时镜龙鱼'],
    ['b_014_fine_02', '四季王鲤'],
    ['b_014_fine_03', '逆瀑六翼鳐'],
    ['b_014_fine_04', '年轮冠鲑'],
    ['b_014_fine_05', '回声长鳗'],
    ['b_014_fine_06', '镜湖古鲟'],
    ['b_014_fine_07', '昼夜王鲈'],
    ['b_014_fine_08', '四季镜蟹'],
    ['b_014_legendary_01', '今线分海鱼'],
    ['b_014_legendary_02', '遗形鳞库鱼'],
    ['b_014_legendary_03', '昼夜校准鲑'],
    ['b_014_legendary_04', '岔路空影鳐'],
    ['b_014_legendary_05', '年轮古龟'],
    ['b_014_mythic_01', '第一刻心鱼'],
    ['b_014_mythic_02', '纪元剖面龙鱼'],
    ['b_014_mythic_03', '万路终点鲑'],
    ['b_014_mythic_04', '莫比乌斯鳗'],
    ['b_014_mythic_05', '四季回流海马姬'],
    ['b_014_rare_01', '万刻织鳍鱼'],
    ['b_014_rare_02', '回流帝王鲑'],
    ['b_014_rare_03', '未来镜鳐'],
    ['b_014_rare_04', '纪年王甲鲟'],
    ['b_014_rare_05', '轮回龙鳗'],
    ['b_014_rare_06', '时针巨口鲈'],
    ['b_014_rare_07', '沙漏月贝'],
    ['b_014_rare_08', '昨日水母'],
    ['b_014_uncommon_01', '四季虹鳟'],
    ['b_014_uncommon_02', '时钟月鱼'],
    ['b_014_uncommon_03', '镜线长鳗'],
    ['b_014_uncommon_04', '回潮石首鱼'],
    ['b_014_uncommon_05', '年轮小鲟'],
    ['b_014_uncommon_06', '春秋双尾鲑'],
    ['b_014_uncommon_07', '镜门飞鱼'],
    ['b_014_uncommon_08', '沙漏灯鱼'],
    ['b_014_uncommon_09', '往日骨舌鱼'],
    ['b_014_uncommon_10', '时环镜螺'],
    ['b_015_arcane_01', '心跳新海鱼'],
    ['b_015_arcane_02', '诸界潮汐海龙'],
    ['b_015_arcane_03', '初日终月鳐'],
    ['b_015_arcane_04', '万灵圣枝龙鱼'],
    ['b_015_arcane_05', '世界心鲸'],
    ['b_015_common_01', '星砂小鲫'],
    ['b_015_common_02', '圣泉青鳉'],
    ['b_015_common_03', '渊影泥鳅'],
    ['b_015_common_04', '星环鳑鲏'],
    ['b_015_common_05', '月尘虾虎'],
    ['b_015_common_06', '祈愿小鳟'],
    ['b_015_common_07', '圣羽银鱼'],
    ['b_015_common_08', '渊蓝小鲈'],
    ['b_015_common_09', '星须小鲶'],
    ['b_015_common_10', '银冠鳚'],
    ['b_015_common_11', '圣纹麦穗鱼'],
    ['b_015_common_12', '星屑圣泉虾'],
    ['b_015_epic_01', '守星灯冠鮟鱇'],
    ['b_015_epic_02', '万愿圣鲤'],
    ['b_015_epic_03', '月潮静翼鳐'],
    ['b_015_epic_04', '圣枝脉龙鱼'],
    ['b_015_epic_05', '疗环双尾鲑'],
    ['b_015_epic_06', '陨光墓甲鲟'],
    ['b_015_epic_07', '银河圣章鱼'],
    ['b_015_epic_08', '世界珍珠砗磲'],
    ['b_015_exotic_01', '归星逆鳞鱼'],
    ['b_015_exotic_02', '噬光明界鳐'],
    ['b_015_exotic_03', '无底短路鳗'],
    ['b_015_exotic_04', '异海瞳水母'],
    ['b_015_exotic_05', '虚空圣乌贼魅姬'],
    ['b_015_fine_01', '星渊龙鱼'],
    ['b_015_fine_02', '圣冠帝王鲑'],
    ['b_015_fine_03', '月海镜鳐'],
    ['b_015_fine_04', '星环六鳍鲼'],
    ['b_015_fine_05', '祷琴长鳗'],
    ['b_015_fine_06', '圣殿古鲟'],
    ['b_015_fine_07', '渊冠王鲈'],
    ['b_015_fine_08', '星渊月水母'],
    ['b_015_legendary_01', '渊空灯塔鮟鱇'],
    ['b_015_legendary_02', '愿史鳞库鱼'],
    ['b_015_legendary_03', '白潮开路鲑'],
    ['b_015_legendary_04', '万月息潮鳐'],
    ['b_015_legendary_05', '圣环星龟'],
    ['b_015_mythic_01', '初星育海鱼'],
    ['b_015_mythic_02', '九渊鳃门龙鱼'],
    ['b_015_mythic_03', '真愿额镜鲑'],
    ['b_015_mythic_04', '无源圣河鳗'],
    ['b_015_mythic_05', '星渊圣歌人鱼'],
    ['b_015_rare_01', '万星织鳍鲑'],
    ['b_015_rare_02', '圣泉帝王鱼'],
    ['b_015_rare_03', '星殿镜翼鳐'],
    ['b_015_rare_04', '渊海王甲鲟'],
    ['b_015_rare_05', '祈愿龙鳗'],
    ['b_015_rare_06', '圣歌巨口鲈'],
    ['b_015_rare_07', '星甲渊蟹'],
    ['b_015_rare_08', '圣辉海参'],
    ['b_015_uncommon_01', '星冠虹鳟'],
    ['b_015_uncommon_02', '圣镜月鱼'],
    ['b_015_uncommon_03', '渊河长鳗'],
    ['b_015_uncommon_04', '祷歌石首鱼'],
    ['b_015_uncommon_05', '星殿镜鲤'],
    ['b_015_uncommon_06', '圣翼飞鱼'],
    ['b_015_uncommon_07', '月灯骨舌鱼'],
    ['b_015_uncommon_08', '星刺河鲀'],
    ['b_015_uncommon_09', '圣甲小鲟'],
    ['b_015_uncommon_10', '圣环星螺'],
  ];
  let _allFish = null; // [{fishId,name,biomeId,rarity,mapTag}]
  let _allTs = 0;
  const ALL_TTL = 3 * 60 * 1000;
  async function ensureAllFish() {
    if (_allFish && (Date.now() - _allTs) < ALL_TTL) return _allFish;
    const result = [];
    if (HARD_FISH && HARD_FISH.length) {
      for (const [fishId, name] of HARD_FISH) {
        const parsed = parseFishId(fishId);
        result.push({ fishId: fishId, name: String(name), biomeId: parsed.biomeId, rarity: parsed.rarity, mapTag: parsed.mapTag });
      }
    }
    _allFish = result;
    _allTs = Date.now();
    return _allFish;
  }

  // ---------- 开始捡漏：查对应稀有度鱼的最低价并按升序列出 ----------
  let _masteryFish = null; // 专精鱼 fishId 集合（玩家的专精目标鱼）
  let _masteryTs = 0;
  const MASTERY_TTL = 5 * 60 * 1000;
  async function masteryFishIds() {
    if (_masteryFish && (Date.now() - _masteryTs) < MASTERY_TTL) return _masteryFish;
    const s = new Set();
    // 专精鱼 = 地图专精页里每个稀有度当前的目标鱼（/api/mastery biomes[].rarities[].fish）。
    // 之前只取 isFishLocked:true 会漏掉「已设为专精目标但未 locked」的鱼（尤其奥秘），
    // 故改为收集 /api/mastery 里所有带 fish 的稀有度目标条目。
    const r = await getJSON('/api/mastery');
    if (r.ok) {
      const d = (r.data && r.data.data && typeof r.data.data === 'object') ? r.data.data : r.data;
      collectTargetFish(d, s);
      console.log(TAG, '专精鱼(地图专精页全部目标鱼) count=' + s.size);
      _masteryFish = s;
      _masteryTs = Date.now();
      saveMasteryIds(Array.from(s)); // 同时持久化，供下次捡漏恢复本地秒读
      return s;
    }
    // 专精数据获取失败：不要缓存空集合（否则会持续 5 分钟把「专精鱼」误判为空 → 误报「该条件下没有专精鱼」）。
    // 优先用本会话缓存，其次用 localStorage 持久化缓存；都无则返回 null 让调用方区分「无数据」与「确实没有专精鱼」。
    if (_masteryFish) return _masteryFish;
    const lc = loadMasteryIds();
    if (lc) { _masteryFish = lc; _masteryTs = Date.now(); return lc; }
    console.warn(TAG, '专精数据获取失败(免签/超时), 无缓存可用');
    return null;
  }
  // 收集 /api/mastery 中所有稀有度目标条目的 fish.id（每条目标鱼都算专精鱼）
  function collectTargetFish(node, set, depth) {
    if (node == null || depth > 8) return;
    if (Array.isArray(node)) { node.forEach((n) => collectTargetFish(n, set, depth + 1)); return; }
    if (typeof node === 'object') {
      if (node.fish && typeof node.fish === 'object' && typeof node.fish.id === 'string') {
        set.add(node.fish.id);
      }
      for (const k of Object.keys(node)) collectTargetFish(node[k], set, depth + 1);
    }
  }

  // /api/mastery 返回 Map<fishId, remainingQuantity>（当前专精目标鱼每类还差多少条）。非目标鱼不在 map 中
  let _masteryRem = null;
  let _masteryRemTs = 0;
  async function masteryRemainingMap() {
    if (_masteryRem && (Date.now() - _masteryRemTs) < MASTERY_TTL) return _masteryRem;
    const m = new Map();
    const r = await getJSON('/api/mastery');
    if (r.ok) {
      const d = (r.data && r.data.data && typeof r.data.data === 'object') ? r.data.data : r.data;
      collectRemaining(d, m);
      _masteryRem = m;
      _masteryRemTs = Date.now();
      return m;
    }
    return _masteryRem || m; // 获取失败：沿用缓存；无缓存则返回空 Map（不缓存）
  }
  function collectRemaining(node, map, depth) {
    if (node == null || depth > 8) return;
    if (Array.isArray(node)) { node.forEach((n) => collectRemaining(n, map, depth + 1)); return; }
    if (typeof node === 'object') {
      if (node.fish && typeof node.fish === 'object' && typeof node.fish.id === 'string'
          && typeof node.remainingQuantity === 'number') {
        map.set(node.fish.id, node.remainingQuantity);
      }
      for (const k of Object.keys(node)) collectRemaining(node[k], map, depth + 1);
    }
  }

  // /api/mastery 返回 Map<fishId, 当前专精等级>（每稀有度当前档 achieved 的等级，如奥秘 Lv2）。非专精鱼不在 map 中
  let _masteryLvl = null;
  let _masteryLvlTs = 0;
  async function masteryLevelMap() {
    if (_masteryLvl && (Date.now() - _masteryLvlTs) < MASTERY_TTL) return _masteryLvl;
    const m = new Map();
    const r = await getJSON('/api/mastery');
    if (r.ok) {
      const d = (r.data && r.data.data && typeof r.data.data === 'object') ? r.data.data : r.data;
      collectLevel(d, m);
      _masteryLvl = m;
      _masteryLvlTs = Date.now();
      return m;
    }
    return _masteryLvl || m; // 获取失败：沿用缓存；无缓存则返回空 Map（不缓存）
  }
  function collectLevel(node, map, depth) {
    if (node == null || depth > 8) return;
    if (Array.isArray(node)) { node.forEach((n) => collectLevel(n, map, depth + 1)); return; }
    if (typeof node === 'object') {
      if (node.fish && typeof node.fish === 'object' && typeof node.fish.id === 'string'
          && typeof node.completedLevel === 'number') {
        map.set(node.fish.id, node.completedLevel);
      }
      for (const k of Object.keys(node)) collectLevel(node[k], map, depth + 1);
    }
  }

  // 我在求购中的鱼 fishId 集合（side=buy 且 active），用于把已求购的鱼标记为「已求」
  let _myBuyFish = null;
  let _myBuyFishTs = 0;
  const MY_BUY_TTL = 60 * 1000;
  async function myActiveBuyFishIds() {
    if (_myBuyFish && (Date.now() - _myBuyFishTs) < MY_BUY_TTL) return _myBuyFish;
    const s = new Set();
    const mine = await fetchMyFishOrders();
    if (mine.ok) {
      for (const o of (mine.orders || [])) {
        if (o && o.side === 'buy' && o.status === 'active' && o.asset && o.asset.fish) {
          s.add(o.asset.fish.fishId);
        }
      }
      _myBuyFish = s;
      _myBuyFishTs = Date.now();
      return s;
    }
    // 拉取失败：返回 null 以区分「确实没有求购单」与「网络/超时失败」，
    // 避免调用方用空集合把已持久化的「已求」标记误清空。
    console.warn(TAG, '我的求购单拉取失败，返回 null（不更新已求标记）');
    return null;
  }

  async function onBargainStart() {
    const rarity = el('rlb-tab-rarity').value;
    const listBox = el('rlb-list');
    const st = el('rlb-status');
    if (listBox) listBox.innerHTML = '';
    if (st) st.textContent = '正在采集鱼种…';

    const allFish = await ensureAllFish();
    if (!allFish.length) { if (st) st.textContent = '❌ 未采集到鱼种数据'; return; }
    // rarity === '*' 表示「全部品级」，不按稀有度过滤；否则筛选对应品级
    const isAll = (rarity === '*');
    let targets = isAll ? allFish.slice() : allFish.filter((f) => f.rarity === rarity);
    // 地图筛选：选中地图则仅保留该地图的鱼
    const biomeSel = el('rlb-tab-biome');
    const biome = biomeSel ? biomeSel.value : '';
    if (biome) targets = targets.filter((f) => f.biomeId === biome);
    // 勾选「仅拉取专精鱼」时，仅保留玩家专精链目标鱼（masteryFishIds 返回的 fishId 集合）
    const onlyMastery = el('rlb-tab-mastery') ? el('rlb-tab-mastery').checked : false;
    // —— 鱼种已硬编码（不拉 fishpedia）；专精/等级/已求也不再串行阻塞扫描。
    //    先用「本地持久化专精集合」秒出 * 标记，再把 /api/mastery×2 与 /api/market/my-orders
    //    拉到的数据后台并行补齐后重渲染（仅影响 * / LV / 已求，不影响扫描本身）。——
    let mset = loadMasteryIds() || null; // 本地持久化专精集合（瞬读）；null=暂无本地数据待后台拉
    const lvlMap = new Map();            // 专精等级：后台拉取后填充
    let myBuy = new Set();               // 已求：后台刷新后填充
    // 仅「只拉专精鱼」才需要真实 /api/mastery 才能筛得出目标 → 这种情况等这 3 个网络请求（并行）。
    // 普通扫描：立刻用本地数据开始，3 个请求全部放后台回调里刷新标记即可。
    const [mm] = await (onlyMastery
      ? Promise.all([masteryFishIds(), masteryLevelMap(), myActiveBuyFishIds()])
      : [null, null, null]);
    if (onlyMastery) {
      if (mm) { mset = mm; }            // 专精集合就绪（可能此刻才有本地）
      targets = targets.filter((f) => mset && mset.has(f.fishId));
    }
    if (!targets.length) {
      if (st) st.textContent = onlyMastery ? 'ℹ️ 该条件下没有专精鱼' : 'ℹ️ 该条件下没有鱼';
      return;
    }
    // 后台并行补齐专精/等级/已求（普通扫描非阻塞）：各自就绪即覆写即时值并重渲染
    if (!onlyMastery) {
      (async () => {
        const [mf, ml] = await Promise.all([masteryFishIds(), masteryLevelMap()]);
        if (mf) mset = mf;
        if (ml) for (const [k, v] of ml.entries()) lvlMap.set(k, v);
        renderBargainList();
        saveBargainCache(rarity, sorted, myBuy ? Array.from(myBuy) : null);
      })();
      (async () => { const mb = await myActiveBuyFishIds(); if (mb) myBuy = mb; })();
    }
    console.log(TAG, `捡漏: rarity=${rarity}, biome=${biome}, allFish=${allFish.length}, targets=${targets.length}, onlyMastery=${onlyMastery}`);
    const rarityName = isAll ? '全部品级' : objBargainRarityName(rarity);
    const biomeName = biome ? biomeIdToTag(biome) : '';
    if (st) st.textContent = `0/${targets.length} ｜ 共 ${targets.length} 种${onlyMastery ? '专精' : ''}「${rarityName}」${biomeName ? biomeName + ' ' : ''}鱼…`;

    // 有序列表：每查到一条就按 ask（未勾求购价）或 bid（勾求购价）升序插入并实时渲染
    const sorted = [];
    const checkedBoxes = new Set(); // 被勾选的 fishId（跨重渲染保持）
    let done = 0;
    const renderBargainList = () => {
      if (!listBox) return;
      const useBid = el('rlb-tab-usebid') ? el('rlb-tab-usebid').checked : false;
      // 「仅拉取专精鱼」为视图层筛选：从不改动 sorted，仅在渲染时按专精集合过滤，
      // 这样勾选/取消勾选能直接在已拉取的单子中切换，无需重新扫描。
      const nurMon = el('rlb-tab-mastery') ? el('rlb-tab-mastery').checked : false;
      const visible = (nurMon && mset) ? sorted.filter((it) => mset.has(it.fishId)) : sorted;
      visible.sort((a, b) => {
        const pa = useBid ? (a.bid == null ? -1 : a.bid) : (a.ask == null ? Infinity : a.ask);
        const pb = useBid ? (b.bid == null ? -1 : b.bid) : (b.ask == null ? Infinity : b.ask);
        return pa - pb;
      });
      const html = visible.map((it, idx) => {
        const pure = stripBracket(it.name);
        const url = 'https://reelax.cn/market?fishSearch=' + encodeURIComponent(pure) +
          '&fishBiome=' + encodeURIComponent(it.biomeId);
        const star = mset && mset.has(it.fishId) ? '*' : '';
        const linkColor = star ? '#4aa3ff' : '#d4a520';
        const price = useBid ? (it.bid == null ? 0 : it.bid) : (it.ask == null ? null : it.ask);
        const priceColor = useBid ? '#9b59b6' : '#2f9e44';
        const ck = checkedBoxes.has(it.fishId) ? ' checked' : '';
        // 专精鱼：括号外直接追加当前专精等级 LV{n}
        const lvlTxt = star && lvlMap.has(it.fishId) ? ` LV${lvlMap.get(it.fishId)}` : '';
        const priceTxt = useBid ? ((myBuy.has(it.fishId) ? '已求' : '求') + ':' + fmtGold(price)) : fmtGold(price);
        return `<div style="display:flex;justify-content:space-between;align-items:center;padding:4px 4px;border-bottom:1px solid #2a2a30;">
        <span style="font-size:12px;color:#d4a520;">#${idx + 1}</span>
        <input type="checkbox" class="rlb-check" data-fid="${escapeHtml(it.fishId)}"${ck}
           style="width:14px;height:14px;accent-color:#2f9e44;margin:0 6px;cursor:pointer;" title="勾选后可按该鱼求购价批量发布求购"/>
        <span class="rlb-link" data-url="${escapeHtml(url)}" title="跳到市场查看 ${pure}${star ? '（专精鱼）' : ''}"
           style="flex:1;color:${linkColor};text-decoration:underline;font-size:12px;white-space:normal;word-break:break-all;cursor:pointer;display:block;">${escapeHtml(it.mapTag)} ${escapeHtml(pure)}（${star}${escapeHtml(objBargainRarityName(it.rarity))}）${escapeHtml(lvlTxt)}</span>
        <span class="rlb-bidprice" data-fid="${escapeHtml(it.fishId)}" data-bid="${it.bid == null ? 0 : it.bid}"
           data-name="${escapeHtml(pure)}"
           style="font-size:12px;color:${priceColor};font-weight:bold;white-space:nowrap;margin-left:6px;cursor:pointer;text-decoration:underline;padding:2px 4px;border-radius:4px;"
           title="点击设置求购价并发求购单">${priceTxt}</span>
      </div>`;
      }).join('');
      listBox.innerHTML = html;
      listBox.querySelectorAll('.rlb-check').forEach((c) => {
        c.addEventListener('change', () => {
          if (c.checked) checkedBoxes.add(c.getAttribute('data-fid'));
          else checkedBoxes.delete(c.getAttribute('data-fid'));
        });
      });
      listBox.onclick = (ev) => {
        const priceEl = ev.target && ev.target.closest ? ev.target.closest('.rlb-bidprice') : null;
        if (priceEl) {
          ev.preventDefault();
          ev.stopPropagation();
          openBidModal({
            fishId: priceEl.getAttribute('data-fid'),
            name: priceEl.getAttribute('data-name') || priceEl.getAttribute('data-fid'),
            bid: Number(priceEl.getAttribute('data-bid')) || 0,
          });
          return;
        }
        const link = ev.target && ev.target.closest ? ev.target.closest('.rlb-link') : null;
        if (!link) return;
        ev.preventDefault();
        window.location.assign(link.getAttribute('data-url'));
      };
    };
    bargainState = { sorted: sorted, checked: checkedBoxes, render: renderBargainList, masterySet: mset };

    // 节流与恢复策略：默认 200ms 一条；单条失败自动重试（300/800ms 退避）；
    // 连续 4 次失败视为被限流 → 熔断暂缓并逐步拉大间隔；连续成功 8 条后回落间隔。
    let failsInRow = 0, successes = 0;
    let pauseMs = 200;
    const MAX_PAUSE = 1400;
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
      let q = null;
      try {
        for (let attempt = 0; attempt < 3; attempt++) {
          q = await fetchAskRobust(t.fishId);
          if (q.ok) break;
          if (attempt < 2) await sleep(300 + attempt * 500); // 300 / 800ms 重试退避
        }
      } catch (e) {
        console.warn(TAG + ' 查询异常:', t.fishId, e);
        q = { ok: false, status: 'exception' };
      }
      if (q.ok) {
        sorted.push({ ...t, ask: q.ask, bid: q.bid });
        renderBargainList();
saveBargainCache(rarity, sorted, myBuy ? Array.from(myBuy) : null);
      } else {
        // 报价失败/暂无盘口（ok:false）：不丢弃该鱼类目。仍是合法鱼种（来自 fishpedia），
        // 可能只是暂时限流或该鱼暂无在售。保留条目、价格按「无数据」显示，否则物种数会静默变少。
        sorted.push({ ...t, ask: null, bid: null });
        renderBargainList();
      }
      done++;
      if (q.ok) { successes++; failsInRow = 0; }
      else { failsInRow++; }

      // 进度顶栏 + 节流
      if (failsInRow >= 4) {
        // 疑似被限流：熔断暂缓 + 拉大间隔，避免继续撞频
        failsInRow = 0;
        pauseMs = Math.min(MAX_PAUSE, pauseMs + 300);
        if (st) st.textContent = `${done}/${targets.length} · 请求受限，暂缓 ${(pauseMs / 1000).toFixed(1)}s…`;
        await sleep(1600 + pauseMs);
      } else {
        if (successes >= 8) { successes = 0; pauseMs = Math.max(200, pauseMs - 150); }
        if (st) st.textContent = `${done}/${targets.length}`;
        await sleep(pauseMs);
      }
    }

    if (st) st.textContent = `${done}/${targets.length} ｜ 在售 ${sorted.length} 种`;
    saveBargainCache(rarity, sorted, myBuy ? Array.from(myBuy) : null);
    if (!sorted.length && listBox) listBox.innerHTML = '<div style="color:#aaa;padding:6px;">该稀有度暂无鱼在售</div>';
  }

  // 发布一笔求购单（数量 1）；返回 { ok, msg }
  async function placeBuyOrder(fishId, name, limitUnitPrice, quantity) {
    quantity = Math.max(1, Math.round(Number(quantity) || 1));
    try {
      let res = await postJSON('/api/market/orders', 'POST', {
        assetType: 'fish', side: 'buy', limitUnitPrice: limitUnitPrice, fishId: fishId, quantity: quantity,
      });
      // 限流（操作过于频繁）→ 等 5 秒重试一次
      if (!(res && res.ok && res.status === 200) && (await backoffIfRateLimited(res))) {
        res = await postJSON('/api/market/orders', 'POST', {
          assetType: 'fish', side: 'buy', limitUnitPrice: limitUnitPrice, fishId: fishId, quantity: quantity,
        });
      }
      if (res && res.ok && res.status === 200) return { ok: true, msg: `${escapeHtml(name || fishId)} 求购 ${quantity} 条 @ ${fmtGold(limitUnitPrice)}` };
      return { ok: false, msg: `${escapeHtml(name || fishId)} 失败: ${safeErr(res && res.body, res && res.error)}` };
    } catch (e) {
      return { ok: false, msg: `${escapeHtml(name || fishId)} 异常: ${String(e)}` };
    }
  }

  // 发布卖鱼挂单（重挂非最低价单 / 一般挂单共用）
  async function placeSellOrder(fishId, name, limitUnitPrice, quantity) {
    quantity = Math.max(1, Math.round(Number(quantity) || 1));
    try {
      let res = await postJSON('/api/market/orders', 'POST', {
        assetType: 'fish', side: 'sell', limitUnitPrice: limitUnitPrice, fishId: fishId, quantity: quantity,
      });
      // 限流（操作过于频繁）→ 等 5 秒重试一次
      if (!(res && res.ok && res.status === 200) && (await backoffIfRateLimited(res))) {
        res = await postJSON('/api/market/orders', 'POST', {
          assetType: 'fish', side: 'sell', limitUnitPrice: limitUnitPrice, fishId: fishId, quantity: quantity,
        });
      }
      if (res && res.ok && res.status === 200) return { ok: true, msg: `${escapeHtml(name || fishId)} 挂单 ${quantity} 条 @ ${fmtGold(limitUnitPrice)}` };
      return { ok: false, msg: `${escapeHtml(name || fishId)} 失败: ${safeErr(res && res.body, res && res.error)}` };
    } catch (e) {
      return { ok: false, msg: `${escapeHtml(name || fishId)} 异常: ${String(e)}` };
    }
  }

  // 点击行内求购价 → 弹出窗口，输入价格后点「发布」发布该鱼求购单
  function openBidModal(it) {
    // 复用一个可复用弹窗
    let wrap = el('rlb-bid-modal');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.id = 'rlb-bid-modal';
      Object.assign(wrap.style, {
        position: 'fixed', left: 0, top: 0, width: '100%', height: '100%',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(0,0,0,.55)', zIndex: '100000',
      });
      wrap.innerHTML = `
        <div style="width:320px;background:#1e1e24;border:1px solid #3a3a42;border-radius:10px;padding:16px;color:#e8e8e8;font-size:13px;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
            <b style="font-size:14px;">发布求购单</b>
            <span data-close style="cursor:pointer;color:#aaa;">✕</span>
          </div>
          <div data-name style="margin-bottom:8px;font-size:13px;color:#eee;"></div>
          <div style="font-size:12px;color:#888;margin-bottom:4px;">求购单价（金）</div>
          <input type="number" min="1" step="1" style="width:100%;padding:6px 8px;border:1px solid #4a4a52;border-radius:6px;background:#2a2a30;color:#e8e8e8;box-sizing:border-box;margin-bottom:4px;"/>
          <div data-unit style="font-size:11px;color:#9cd;margin-bottom:4px;"></div>
          <div style="font-size:12px;color:#888;margin-bottom:4px;margin-top:8px;">求购数量（条）</div>
          <input type="number" min="1" step="1" value="1" data-qty style="width:100%;padding:6px 8px;border:1px solid #4a4a52;border-radius:6px;background:#2a2a30;color:#e8e8e8;box-sizing:border-box;margin-bottom:4px;"/>
          <div data-qtyline style="font-size:11px;color:#888;margin-bottom:4px;"></div>
          <div data-hint style="font-size:11px;color:#888;margin-bottom:10px;"></div>
          <button data-pub type="button" style="width:100%;padding:8px;border:none;border-radius:6px;background:#2f9e44;color:#fff;font-size:13px;cursor:pointer;">发布求购单</button>
        </div>`;
      wrap.addEventListener('mousedown', (e) => {
        // 记录本次按压起点是否在卡片（弹窗内容）内；若在则释放到遮罩上不触发关闭
        wrap._fromCard = !(e.target === wrap);
      });
      wrap.addEventListener('click', (e) => {
        if (e.target === wrap && !wrap._fromCard) removeBidModal();
        if (e.target.getAttribute && e.target.getAttribute('data-close') != null) removeBidModal();
      });
      document.body.appendChild(wrap);
    }
    wrap.querySelector('[data-name]').textContent = '鱼：' + it.name;
    const input = wrap.querySelector('input');
    input.value = it.bid || 1;
    const unitEl = wrap.querySelector('[data-unit]');
    const bidUnit = (v) => {
      const abs = Math.abs(v);
      if (abs >= 1000000000) return '十亿';
      if (abs >= 100000000) return '亿';
      if (abs >= 10000000) return '千万';
      if (abs >= 1000000) return '百万';
      if (abs >= 100000) return '十万';
      if (abs >= 10000) return '万';
      if (abs >= 1000) return '千';
      if (abs >= 100) return '百';
      if (abs >= 10) return '十';
      return '个';
    };
    const refreshBidUnit = () => { if (unitEl) unitEl.textContent = '单位：' + bidUnit(Number(input.value) || 0); };
    input.addEventListener('input', refreshBidUnit);
    refreshBidUnit();
    // 数量输入 + 专精最大值选项
    const qtyInput = wrap.querySelector('[data-qty]');
    const qtyLine = wrap.querySelector('[data-qtyline]');
    qtyInput.value = 1;
    qtyInput.disabled = false;
    qtyLine.innerHTML = '';
    (async () => {
      try {
        const rem = await masteryRemainingMap();
        const need = rem.get(it.fishId);
        if (need == null) { qtyLine.textContent = '非专精鱼（默认求购 1 条）'; return; }
        qtyLine.innerHTML = `<label style="display:inline-flex;align-items:center;gap:4px;cursor:pointer;color:#4aa3ff;">
            <input type="checkbox" data-mastery-max style="width:14px;height:14px;accent-color:#4aa3ff;cursor:pointer;"/>
            当前专精最大值（还差 ${need} 条）
          </label>`;
        const maxCk = qtyLine.querySelector('[data-mastery-max]');
        maxCk.addEventListener('change', () => {
          if (maxCk.checked) { qtyInput.value = need; qtyInput.disabled = true; }
          else qtyInput.disabled = false;
        });
      } catch (e) {
        qtyLine.textContent = '专精数据获取失败：' + String(e);
      }
    })();
    wrap.querySelector('[data-hint]').textContent = '当前最高求购价 ' + fmtGold(it.bid) + '，留空或 0 则为该价';
    const pub = wrap.querySelector('[data-pub]');
    pub.disabled = false;
    const st = el('rlb-status');
    const onPub = async () => {
      const v = Math.round(Number(input.value) || 0);
      if (v <= 0) { wrap.querySelector('[data-hint]').textContent = '请输入大于 0 的价格'; return; }
      let qty = Math.round(Number(qtyInput.value) || 1);
      if (qty < 1) qty = 1;
      const maxCk = qtyLine.querySelector && qtyLine.querySelector('[data-mastery-max]');
      if (maxCk && maxCk.checked) {
        const rem = await masteryRemainingMap();
        const need = rem.get(it.fishId);
        if (need != null) qty = need;
      }
      pub.disabled = true;
      if (st) st.textContent = '▶ 正在发布求购…';
      const r = await placeBuyOrder(it.fishId, it.name, v, qty);
      if (st) st.textContent = (r.ok ? '✅ ' : '❌ ') + r.msg;
      pub.disabled = false;
      if (r.ok) removeBidModal(); // 发布成功后关闭弹窗
    };
    pub.onclick = onPub;
    input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); onPub(); } };
  }

  function removeBidModal() {
    const wrap = el('rlb-bid-modal');
    if (wrap && wrap.parentNode) wrap.parentNode.removeChild(wrap);
  }

  // 面板打开时恢复上次的捡漏扫描结果（30 分钟内有效）；无则忽略
  async function restoreBargainCache() {
    const cache = loadBargainCache();
    if (!cache || !cache.rows.length) return;
    const listBox = el('rlb-list');
    const st = el('rlb-status');
    if (!listBox) return;
    const rarity = cache.rarity;
    const rarityName = objBargainRarityName(rarity);
    const sorted = cache.rows;
    const checkedBoxes = new Set();
    // 立即渲染：先用本地可同步拿到的数据（持久化专精集合）秒出列表，避免被 3 个网络请求拖慢。
    // 随后各份网络数据就绪后再重渲染一次补齐 * / LV / 已求标记。
    let mset = loadMasteryIds(); // 优先本地（瞬读）；无则由下方异步拉取后补
    let lvlMap = new Map();
    // 用扫描时持久化的「我的求购」集合秒标「已求」（避免一次网络失败就丢标）；后台再刷新
    let myBuy = new Set(Array.isArray(cache.myBuyIds) ? cache.myBuyIds : []);
    const render = () => {
      const useBid = el('rlb-tab-usebid') ? el('rlb-tab-usebid').checked : false;
      // 「仅拉取专精鱼」为视图层筛选，从不改动 sorted（已恢复的单子可直接切换筛/放回）
      const nurMon = el('rlb-tab-mastery') ? el('rlb-tab-mastery').checked : false;
      const visible = (nurMon && mset) ? sorted.filter((it) => mset.has(it.fishId)) : sorted;
      visible.sort((a, b) => {
        const pa = useBid ? (a.bid == null ? -1 : a.bid) : (a.ask == null ? Infinity : a.ask);
        const pb = useBid ? (b.bid == null ? -1 : b.bid) : (b.ask == null ? Infinity : b.ask);
        return pa - pb;
      });
      listBox.innerHTML = visible.map((it, idx) => {
        const pure = stripBracket(it.name);
        const url = 'https://reelax.cn/market?fishSearch=' + encodeURIComponent(pure) +
          '&fishBiome=' + encodeURIComponent(it.biomeId || '');
        const star = mset && mset.has(it.fishId) ? '*' : '';
        const linkColor = star ? '#4aa3ff' : '#d4a520';
        const price = useBid ? (it.bid == null ? 0 : it.bid) : (it.ask == null ? null : it.ask);
        const priceColor = useBid ? '#9b59b6' : '#2f9e44';
        const ck = checkedBoxes.has(it.fishId) ? ' checked' : '';
        // 专精鱼：括号外直接追加当前专精等级 LV{n}
        const lvlTxt = star && lvlMap.has(it.fishId) ? ` LV${lvlMap.get(it.fishId)}` : '';
        const priceTxt = useBid ? ((myBuy.has(it.fishId) ? '已求' : '求') + ':' + fmtGold(price)) : fmtGold(price);
        return `<div style="display:flex;justify-content:space-between;align-items:center;padding:4px 4px;border-bottom:1px solid #2a2a30;">
        <span style="font-size:12px;color:#d4a520;">#${idx + 1}</span>
        <input type="checkbox" class="rlb-check" data-fid="${escapeHtml(it.fishId)}"${ck}
           style="width:14px;height:14px;accent-color:#2f9e44;margin:0 6px;cursor:pointer;" title="勾选后可按该鱼求购价批量发布求购"/>
        <span class="rlb-link" data-url="${escapeHtml(url)}" title="跳到市场查看 ${pure}${star ? '（专精鱼）' : ''}"
           style="flex:1;color:${linkColor};text-decoration:underline;font-size:12px;white-space:normal;word-break:break-all;cursor:pointer;display:block;">${escapeHtml(it.mapTag || '')} ${escapeHtml(pure)}（${star}${escapeHtml(objBargainRarityName(it.rarity))}）${escapeHtml(lvlTxt)}</span>
        <span class="rlb-bidprice" data-fid="${escapeHtml(it.fishId)}" data-bid="${it.bid == null ? 0 : it.bid}"
           data-name="${escapeHtml(pure)}"
           style="font-size:12px;color:${priceColor};font-weight:bold;white-space:nowrap;margin-left:6px;cursor:pointer;text-decoration:underline;padding:2px 4px;border-radius:4px;"
           title="点击设置求购价并发求购单">${priceTxt}</span>
      </div>`;
      }).join('');
      listBox.querySelectorAll('.rlb-check').forEach((c) => {
        c.addEventListener('change', () => {
          if (c.checked) checkedBoxes.add(c.getAttribute('data-fid'));
          else checkedBoxes.delete(c.getAttribute('data-fid'));
        });
      });
      listBox.onclick = (ev) => {
        const priceEl = ev.target && ev.target.closest ? ev.target.closest('.rlb-bidprice') : null;
        if (priceEl) {
          ev.preventDefault(); ev.stopPropagation();
          openBidModal({
            fishId: priceEl.getAttribute('data-fid'),
            name: priceEl.getAttribute('data-name') || priceEl.getAttribute('data-fid'),
            bid: Number(priceEl.getAttribute('data-bid')) || 0,
          });
          return;
        }
        const link = ev.target && ev.target.closest ? ev.target.closest('.rlb-link') : null;
        if (!link) return;
        ev.preventDefault();
        window.location.assign(link.getAttribute('data-url'));
      };
    };
    bargainState = { sorted: sorted, checked: checkedBoxes, render: render, masterySet: mset };
    if (el('rlb-tab-rarity')) el('rlb-tab-rarity').value = rarity;
    render(); // 先秒出本地缓存列表（含持久化的专精 *）
    if (st) st.textContent = `已恢复上次扫描：共 ${sorted.length} 种「${rarityName}」鱼（30 分钟内有效）`;
    // 后台异步补齐最新数据：专精集合 / 专精等级 / 我的求购，就绪后再重渲染一次（不阻塞列表显示）
    (async () => {
      const [fmset, fmap, fbuy] = await Promise.all([
        masteryFishIds(),
        masteryLevelMap(),
        myActiveBuyFishIds(),
      ]);
      if (fmset) mset = fmset;
      if (fmap) lvlMap = fmap;
      if (fbuy) myBuy = fbuy;
      bargainState.masterySet = mset;
      render();
    })();
  }

  // 批量发布求购单：对勾选的鱼，按「最高求购价(无求购则0) + X 元」作为求购单价发布买单一笔（数量 1）
  async function onBatchBid() {
    const st = el('rlb-status');
    const btn = el('rlb-bid-batch');
    const x = Number((el('rlb-bid-adjust') || {}).value) || 0;

    // —— 最高价检测模式：勾选的非最高价求购单 → 先下架旧单，再按「最高求购价 + X」重挂 ——
    if (_nonMax.length) {
      const targets = _nonMax.filter((it) => _maxChecked.has(String(it.id)));
      if (!targets.length) { if (st) st.textContent = 'ℹ️ 请先在最高价列表勾选要重挂的求购单'; return; }
      if (btn) btn.disabled = true;
      const label = (t) => escapeHtml(t.name);
      let okN = 0, failN = 0;
      if (st) st.textContent = `▶ 开始重挂 ${targets.length} 条：先下架旧求购，再按最高求购价 ${x >= 0 ? '+' : ''}${x} 发布…`;
      for (let i = 0; i < targets.length; i++) {
        const it = targets[i];
        if (isIgnored(it)) { if (st) st.textContent = `${i + 1}/${targets.length} ⊘ ${label(it)} 已忽略，跳过`; _nonMax = _nonMax.filter((x) => String(x.id) !== String(it.id)); _maxChecked.delete(String(it.id)); continue; }
        // 1) 下架旧求购单
        const del = await postJSON('/api/market/orders/' + encodeURIComponent(String(it.id)), 'DELETE', null);
        if (!(del && del.ok && del.status === 200)) {
          failN++;
          _maxChecked.delete(String(it.id)); // 失败保留显示但取消勾选，避免误重试；可改价或稍后再次处理
          if (st) st.textContent = `${i + 1}/${targets.length} ❌ ${label(it)} 下架失败, 停止重挂该条`;
          await sleep(300);
          continue;
        }
        // 2) 按「市场最高求购价 + X」发布新单（无求购→bid 视 0+X），数量恢复原单剩余量
        const limitUnitPrice = (it.highest == null ? 0 : it.highest) + x;
        const r = await placeBuyOrder(it.fishId, it.name, limitUnitPrice, it.quantity);
        // 无论发布成败，旧单已下架，该条不再属「待重挂」；发布失败的另由新单状态决定（不再折叠回 _nonMax）
        _nonMax = _nonMax.filter((x) => String(x.id) !== String(it.id));
        _maxChecked.delete(String(it.id));
        if (r.ok) {
          okN++;
          if (st) st.textContent = `${i + 1}/${targets.length} ✅ ${label(it)} 已下架并重挂 @ ${fmtGold(limitUnitPrice)}`;
        } else {
          failN++;
          if (st) st.textContent = `${i + 1}/${targets.length} ❌ ${label(it)} 下架成功但发布失败: ${r.msg}`;
        }
        await sleep(300);
      }
      if (st) st.textContent = `—— 重挂完成：成功 ${okN} / 失败 ${failN} ——`;
      // 仍有未处理（未勾选 / 失败 / 忽略跳过）的非最高价求购时，保留列表与按钮，便于继续逐条处理；
      // 仅剩已忽略项视作处理完毕，切回「最高价检测」。
      const remaining = _nonMax.filter((x) => !isIgnored(x));
      if (remaining.length) {
        if (st) st.textContent = `仍有 ${remaining.length} 条未处理（勾选后可继续重挂/下架）。`;
        renderMaxList();
        setMaxMode('delist');
        if (btn) btn.disabled = false;
        return;
      }
      _nonMax = [];
      _maxChecked = new Set();
      clearMaxList();
      setMaxMode('check'); // 全部处理完后按钮复位为「最高价检测」
      if (btn) btn.disabled = false;
      return;
    }

    // —— 捡漏模式：对勾选鱼按「最高求购价 + X」发布求购 ——
    if (!bargainState || !bargainState.sorted.length) { if (st) st.textContent = 'ℹ️ 请先运行捡漏扫描出鱼后，再勾选发布求购'; return; }
    const idList = Array.from(bargainState.checked);
    if (!idList.length) { if (st) st.textContent = 'ℹ️ 请先勾选要发布求购的鱼（点鱼名前的框）'; return; }
    if (btn) btn.disabled = true;
    const qty = Math.max(1, Math.round(Number((el('rlb-bid-qty') || {}).value) || 1));
    const masteryMax = el('rlb-bid-masterymax') ? el('rlb-bid-masterymax').checked : false;
    const remMap = masteryMax ? await masteryRemainingMap() : null;
    let okN = 0, failN = 0, skippedN = 0;
    if (st) st.textContent = `▶ 开始为 ${idList.length} 条鱼发布求购（求购价 = 最高求购价 ${x >= 0 ? '+' : ''}${x}，每单 ${masteryMax ? '专精按剩余量' : qty + ' 条'}）…`;
    for (let i = 0; i < idList.length; i++) {
      const fid = idList[i];
      const it = bargainState.sorted.find((s) => s.fishId === fid);
      if (!it) { skippedN++; continue; }
      // 无求购 → bid 视为 0，则求购价 = 0 + x = x
      const bid = (it.bid == null ? 0 : it.bid);
      const limitUnitPrice = bid + x;
      let quantity = qty;
      if (masteryMax && remMap) {
        const need = remMap.get(fid);
        if (need != null) quantity = need;
      }
      const r = await placeBuyOrder(fid, it.name, limitUnitPrice, quantity);
      if (r.ok) {
        okN++;
        if (st) st.textContent = `${i + 1}/${idList.length} ✅ ${r.msg}`;
      } else {
        failN++;
        if (st) st.textContent = `${i + 1}/${idList.length} ❌ ${r.msg}`;
      }
      await sleep(300);
    }
    if (st) st.textContent = `—— 求购完成：成功 ${okN} / 失败 ${failN} / 跳过 ${skippedN} ——`;
    if (btn) btn.disabled = false;
  }

  // 从 order-book 解析最低卖价（捡漏用，兼容 sellLevels / sellOrders）
  function lowestAsk(fishId) {
    return getJSON('/api/market/fish/' + encodeURIComponent(fishId) + '/order-book')
      .then((ob) => lowestAskFromBook(ob));
  }

  // 稳健取报价：区分「请求失败/被限流」(ok:false) 与「无在售」(ok:true, ask:null)，供捡漏做重试与节流
  async function fetchAskRobust(fishId) {
    const res = await getJSON('/api/market/fish/' + encodeURIComponent(fishId) + '/order-book');
    if (res && res.ok) {
      const d = (res.data && res.data.data && typeof res.data.data === 'object') ? res.data.data : res.data;
      return { ok: true, ask: lowestAskFromBook({ ok: true, data: d }), bid: highestBidFromBook({ ok: true, data: d }) };
    }
    return { ok: false, ask: null, bid: null, status: (res && (res.status || res.error)) || 'fail' };
  }

  // ---------- 页面右上角悬浮「一键市场」按钮（与渔获页内嵌按钮共用同一面板） ----------
  // 支持拖动：按住按钮可移动位置；点击（无拖动）打开一键市场面板（挂单页签，切「捡漏」页签见全部功能）。
  let fab = null;
  function ensureFab() {
    if (el('r1cm-fab')) return el('r1cm-fab');
    fab = document.createElement('button');
    fab.id = 'r1cm-fab';
    fab.type = 'button';
    // 先以文字按钮兜底显示；随后异步向 injector 请求图片 URL，拿到后升级为圆形图片按钮
    Object.assign(fab.style, {
      position: 'fixed', right: '8px', top: '140px', zIndex: '99998',
      padding: '6px 14px', borderRadius: '6px', border: '1px solid #d97a12',
      background: '#ff8c1a', color: '#fff', fontSize: '13px', cursor: 'grab', userSelect: 'none',
    });
    fab.textContent = '一键市场';
    document.body.appendChild(fab);

    // 请求浮窗图片 URL（主世界 → injector 隔离世界 → chrome.runtime.getURL 回传）
    requestFabImage();

    // 拖动逻辑（区分点击/拖动）
    let draggingFab = false, movedFab = false, ofx = 0, ofy = 0, startX = 0, startY = 0;
    fab.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      // 把当前 left 显式固定后再清除 right，避免转到纯 left 定位时按钮闪到左上角
      const r = fab.getBoundingClientRect();
      fab.style.left = r.left + 'px';
      fab.style.right = 'auto';
      draggingFab = true; movedFab = false; ofx = e.clientX - r.left; ofy = e.clientY - r.top;
      startX = e.clientX; startY = e.clientY;
    });
    document.addEventListener('mousemove', (e) => {
      if (!draggingFab) return;
      if (Math.abs(e.clientX - startX) > 3 || Math.abs(e.clientY - startY) > 3) movedFab = true;
      const nx = Math.max(0, Math.min(window.innerWidth - fab.offsetWidth, e.clientX - ofx));
      const ny = Math.max(0, Math.min(window.innerHeight - fab.offsetHeight, e.clientY - ofy));
      fab.style.left = nx + 'px';
      fab.style.top = ny + 'px';
      fab.style.bottom = 'auto';
    });
    document.addEventListener('mouseup', () => { draggingFab = false; });

    // 点击 — 若刚拖动过则不打开面板
    fab.addEventListener('click', (e) => {
      e.stopPropagation(); e.preventDefault();
      if (movedFab) return;
      openPanelOn('sell');
    });
    return fab;
  }

  // 主世界请求浮窗图片 URL；injector 收到 __reelaxGetFab 后回传 {__reelaxFabUrl, url}
  let _fabReqId = 0;
  function requestFabImage() {
    const id = ++_fabReqId;
    const onMsg = (ev) => {
      const d = ev.data;
      if (d && d.__reelaxFabUrl === id) {
        window.removeEventListener('message', onMsg);
        if (d.url && fab && fab.id === 'r1cm-fab') upgradeFabToImage(d.url);
      }
    };
    window.addEventListener('message', onMsg);
    try { window.postMessage({ __reelaxGetFab: id }, '*'); } catch (_e) {}
    // 兜底超时：5 秒后无响应不再等待（保持文字按钮）
    setTimeout(() => window.removeEventListener('message', onMsg), 5000);
  }
  function upgradeFabToImage(url) {
    if (!fab) return;
    fab.textContent = '';
    Object.assign(fab.style, {
      padding: '0', border: 'none', background: 'transparent', overflow: 'hidden',
      borderRadius: '50%', width: '56px', height: '56px',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    });
    const im = document.createElement('img');
    im.alt = '一键市场';
    im.src = url;
    im.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block;pointer-events:none;';
    fab.appendChild(im);
  }

  // 打开面板并默认切到指定页签
  function openPanelOn(tab) {
    openPanel(tab || 'sell');
  }

  // ---------- 注入时机 ----------
  function tryInject() {
    try {
      // 悬浮「一键市场」按钮：所有页面右上角都注入（与渔获页内嵌按钮共用同一面板）
      if (document.body && !el('r1cm-fab')) ensureFab();
      if (isFishPage()) {
        // 渔获页：额外注入内嵌「一键市场」按钮（点击面板含挂单/捡漏两页签）
        if (!ensureButton()) return; // 锚按钮未出现，等下一轮
        if (!window.__r1cmInjected) {
          window.__r1cmInjected = true;
          console.log(TAG, '已在渔获页注入「一键市场」按钮');
        }
      }
    } catch (_e) {}
  }
  // 渔获tab是异步渲染，轮询等「锁定专精鱼」按钮出现；非渔获页不注入。
  setInterval(() => { try { tryInject(); } catch (_e) {} }, 1500);
  try { tryInject(); } catch (_e) {}

  console.log(TAG, '已加载');
})();
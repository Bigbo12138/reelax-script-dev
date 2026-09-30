// ==UserScript==
// @name         Reelax 以物易物市场最低价
// @namespace    reelax-barter-price
// @version      1.0.0
// @description  在「以物易物（barter）交换列表」的每张卡片 footer 加「更新价格」按钮。
//               点击后查询当前整页所有卡片里每条鱼的市场最低卖价，并显示在鱼名下方。
//               仅在用户点击时才发起查询，不做自动轮询。
// @match        https://reelax.cn/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  if (window.__reelaxBarterPrice__) return;
  window.__reelaxBarterPrice__ = true;

  const TAG = '[以物易物价格]';

  // ---------- 签名 API 中继（经 injector.js 页面上下文签名 fetch，与一键市场.js 同模式） ----------
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
  function api(path, method, body) {
    const id = ++_reqSeq;
    const payload = {
      __reelaxApiRequest: true, id, path,
      method: method || 'GET', body: (body === undefined ? null : body),
    };
    if (!window.postMessage) return Promise.resolve({ ok: false, error: 'no-postMessage' });
    window.postMessage(payload, '*');
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        if (_pending.has(id)) { _pending.delete(id); resolve({ ok: false, error: 'api-timeout', path }); }
      }, 20000);
      _pending.set(id, (r) => { clearTimeout(timeout); resolve(r); });
    });
  }
  // 返回增强版结果，含诊断字段：{ ok, data, error, status, body, rawBody }
  async function getJSON(path) {
    const r = await api(path, 'GET', null);
    if (!r) return { ok: false, error: 'no-response' };
    if (!r.ok) return { ok: false, error: r.error || ('status:' + r.status), status: r.status, body: r.body };
    try { return { ok: true, data: JSON.parse(r.body), rawBody: r.body }; }
    catch (e) { return { ok: false, error: 'json-parse-fail', body: (r.body || '').slice(0, 400) }; }
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  function fmtGold(n) { return (n == null || n === '' ? '—' : Number(n).toLocaleString()); }
  let _debuggedMiss = new Set(); // 已诊断过「未匹配」的鱼名，避免刷屏

  // ---------- 名称 → fishId 映射（拉一次 fishpedia 缓存，避免频繁请求） ----------
  // overview 接口返回的 fish 只有 fishId/latestTradeUnitPrice 等，**没有 name**；
  // 名称→fishId 需经 /api/fishpedia?biomeId=X（每图鉴鱼含 name + fishId）逐图拉取汇总。
  let _nameMap = null;
  let _mapTs = 0;
  const MAP_TTL_MS = 2 * 60 * 1000;
  let _mapDiag = null; // 最近一次名字映射构建诊断

  function stripBracket(name) {
    const m = /^\s*\[[A-Za-z0-9]+\]\s*/.exec(name);
    return m ? name.slice(m[0].length) : name;
  }

  // 游戏接口返回可能带 { data: {...} } 包装（桥有时剥一层）；这里统一兼容取 .data 下的内容
  function unwrap(obj) { return (obj && obj.data && typeof obj.data === 'object') ? obj.data : obj; }

  async function ensureNameMap() {
    if (_nameMap && (Date.now() - _mapTs) < MAP_TTL_MS) return _nameMap;
    const map = {};

    // 1) 全部地图列表。优先 /api/biomes（文档标注“所有地图”，含未解锁），拿不到再回退 /api/mastery 的 biomes。
    //    不按 isUnlocked 过滤 —— 未解锁地图的鱼也要能查价，否则该图鱼会“未匹配到鱼”。
    let biomeIds = [];
    const bioResp = await getJSON('/api/biomes');
    if (bioResp.ok && bioResp.data) {
      const bw = unwrap(bioResp.data);
      const arr = (bw && Array.isArray(bw.biomes)) ? bw.biomes : (Array.isArray(bw) ? bw : null);
      biomeIds = (arr || []).map((b) => b.biomeId || b.id).filter(Boolean);
    }
    if (!biomeIds.length) {
      const mResp = await getJSON('/api/mastery');
      const mw = (mResp.ok && mResp.data) ? unwrap(mResp.data) : null;
      const mb = (mw && Array.isArray(mw.biomes)) ? mw.biomes : null;
      biomeIds = (mb || []).map((b) => b.biomeId || b.id).filter(Boolean);
    }

    // 2) 逐图拉 fishpedia 汇总 name→fishId
    let fpLoaded = 0, fpFails = 0;
    for (const bid of biomeIds) {
      const r = await getJSON('/api/fishpedia?biomeId=' + encodeURIComponent(bid));
      const uw = (r.ok && r.data) ? unwrap(r.data) : null;
      const fl = (uw && Array.isArray(uw.fish)) ? uw.fish : null;
      if (fl) {
        fpLoaded++;
        for (const f of fl) {
          if (f && f.fishId && f.name) {
            map[f.name] = f.fishId;                       // 完整名直查
            const stripped = stripBracket(String(f.name));
            if (stripped !== f.name) map[stripped] = f.fishId; // 兜底：去掉 [B2]/[B13] 前缀再匹配
          }
        }
      } else {
        fpFails++;
      }
      await sleep(80); // 节奏控制
    }

    _mapDiag = {
      biomesGot: biomeIds.length,
      fishpediaLoaded: fpLoaded,
      fishpediaFails: fpFails,
      mapSize: Object.keys(map).length,
    };
    _nameMap = map;
    _mapTs = Date.now();
    console.log(TAG, 'name-map diag:', JSON.stringify(_mapDiag));
    return map;
  }

  async function fishIdFor(displayName) {
    const map = await ensureNameMap();
    if (map[displayName]) return map[displayName];
    const stripped = stripBracket(displayName);
    if (map[stripped]) return map[stripped];
    return null;
  }

  // ---------- 查询单条鱼的价位 ----------
  // 返回 { ask, bid }：ask = 最低在售价（sellLevels 最低档），bid = 最高求购价（buyLevels 最大档）
  async function getPrices(fishId) {
    const ob = await getJSON('/api/market/fish/' + encodeURIComponent(fishId) + '/order-book');
    const d = (ob.ok && ob.data) ? unwrap(ob.data) : null;
    let ask = null, bid = null;
    if (d) {
      if (Array.isArray(d.sellLevels) && d.sellLevels.length) {
        ask = d.sellLevels[0].unitPrice; // 最低卖一档
      }
      if (Array.isArray(d.buyLevels) && d.buyLevels.length) {
        let bm = null;
        for (const lvl of d.buyLevels) {
          if (lvl && typeof lvl.unitPrice === 'number') bm = (bm == null ? lvl.unitPrice : Math.max(bm, lvl.unitPrice));
        }
        bid = bm; // 最高求购价
      }
    }
    return { ask, bid };
  }

  // ---------- 拆鱼名 + 导航辅助 ----------
  function fishNameText(fishNameEl) {
    const b = fishNameEl.querySelector('.barter-fish-name > b') || fishNameEl;
    return (b.textContent || '').trim();
  }

  // 判断该鱼格是否已无货（剩余数量为 0）：依据 .barter-fish-chip 的 data-exhausted 或其中的「剩余 N」
  function isExhausted(fishNameEl) {
    const chip = fishNameEl.closest('.barter-fish-chip');
    if (chip) {
      if (chip.getAttribute('data-exhausted') === 'true') return true;
      const small = chip.querySelector('small');
      if (small) {
        const m = /剩余\s*(\d+)/.exec(small.textContent || '');
        if (m && Number(m[1]) === 0) return true;
      }
    }
    return false;
  }

// ============ 跳转到鱼类市场并自动搜索 ============
  // 不依赖 SPA 路由/URL：直接点「鱼类市场」tab 切过去，等其渲染出过滤控件后，
  // 显式设置「地图」下拉 +「名称」搜索框的值并派发事件，让组件重新查询过滤列表。
  function setNativeValue(el, value) {
    const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype
      : (el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype);
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    try { setter.call(el, value); } catch (_e) { el.value = value; }
  }
  function findLabelControl(index, labelText) {
    const lab = Array.from(index.querySelectorAll('label')).find((l) => {
      const firstNode = l.firstChild && l.firstChild.nodeType === 3 ? l.firstChild.textContent : (l.childNodes[0] && l.childNodes[0].textContent);
      return (firstNode || '').trim() === labelText;
    });
    if (!lab) return null;
    return lab.querySelector('input') || lab.querySelector('select');
  }
  function applyMarketFilters(search, biome) {
    let tries = 0;
    (function poll() {
      const index = document.querySelector('.fish-market-index');
      if (!index) { if (++tries < 40) setTimeout(poll, 120); return; }
      const mapSel = findLabelControl(index, '地图');
      const nameInp = findLabelControl(index, '名称');
      if (!mapSel && !nameInp) { if (++tries < 40) setTimeout(poll, 120); return; }
      // 等市场组件完成初始化再设值，避免被初始渲染覆盖
      setTimeout(() => {
        if (mapSel && biome && Array.from(mapSel.options).some((o) => o.value === biome)) {
          setNativeValue(mapSel, biome);
          mapSel.dispatchEvent(new Event('change', { bubbles: true }));
        }
        if (nameInp && search) {
          setNativeValue(nameInp, search);
          nameInp.dispatchEvent(new Event('input', { bubbles: true }));
          nameInp.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }, 500);
    })();
  }
  function gotoMarket(url) {
    // 切到「鱼类市场」主 tab
    const tabs = Array.from(document.querySelectorAll('.market-tabs [role="tab"]'));
    const fishTab = tabs.find((t) => /鱼类市场/.test(t.getAttribute('aria-label') || t.textContent || ''));
    if (fishTab) { try { fishTab.click(); } catch (_e) {} }
    // 拦截点 tab 后 SPA 自己的 URL 写入（可能覆盖我们地址栏的目标 query），这里不强求 URL，
    // 因为过滤完全靠控件显式设置。
    let search = '', biome = '';
    try {
      const u = new URL(url);
      search = u.searchParams.get('fishSearch') || '';
      biome = u.searchParams.get('fishBiome') || '';
    } catch (_e) {}
    if (search || biome) applyMarketFilters(search, biome);
  }

  // 给单个 .barter-fish-name 元素创建/复用价格行，插在名字下方（block 换行，不挤占鱼名）
  const _priceElemByEl = new WeakMap();
  function priceElFor(fishNameEl) {
    if (_priceElemByEl.has(fishNameEl)) return _priceElemByEl.get(fishNameEl);
    const line = document.createElement('div');
    line.className = 'reelax-barter-price';
    // 强制另起一行显示在鱼名正下方：block + flex-basis:100%（父为 flex 时占满整行换行）
    line.style.cssText = 'display:block!important;width:100%;flex-basis:100%;flex-shrink:0;' +
      'box-sizing:border-box;white-space:normal;line-height:1.3;' +
      'font-size:11px;color:#9bd1ff;margin-top:1px;font-weight:normal;text-align:left;';
    // 若父级(.barter-fish-name)是 flex/inline 容器，也强制转块以便内部换行
    try { fishNameEl.style.display = 'block'; } catch (_e) {}
    fishNameEl.appendChild(line);
    _priceElemByEl.set(fishNameEl, line);
    return line;
  }

  // ---------- 更新价格（只更新当前这一张卡片；并统计两区极值标红 + 差价） ----------
  async function onUpdatePrices(btn) {
    const scope = btn.closest('.barter-order-card'); // 当前卡片 = 作用域
    if (!scope) return;
    // 分区：第一个 .barter-order-side = 「挂单人想要之一」，第二个 = 「你可以获得之一」；按通用取两区
    const sides = Array.from(scope.querySelectorAll('.barter-order-side'));
    const wantEls = sides[0] ? Array.from(sides[0].querySelectorAll('.barter-fish-name')) : [];
    const getEls = sides[1] ? Array.from(sides[1].querySelectorAll('.barter-fish-name')) : [];
    const nameEls = wantEls.concat(getEls);
    const diffLab = scope.querySelector('.reelax-barter-diff');

    if (!nameEls.length) {
      btn.textContent = '仅交换列表可用';
      setTimeout(() => { btn.textContent = '更新价格'; }, 1500);
      return;
    }

    btn.disabled = true;
    const orig = btn.textContent;
    btn.textContent = '查询中…';

    const askByEl = new Map(); // .barter-fish-name 元素 -> ask(最低在售价) 或 null
    const bidByEl = new Map(); // .barter-fish-name 元素 -> bid(最高求购价) 或 null
    const fishIdByEl = new Map(); // .barter-fish-name 元素 -> fishId（供跳转链接提取地图）
    const getElSet = new Set(getEls); // 用于区分可获区两行渲染

    const setLoading = (el, text, color) => {
      const line = priceElFor(el);
      line.textContent = text;
      line.style.color = color || '#9bd1ff';
    };
    nameEls.forEach((el) => setLoading(el, '…'));

    // 按鱼名去重，同名只查一次，结果回填到所有同名格，并记录每格 ask/bid
    const groups = new Map(); // name -> [fishNameEl, ...]
    for (const el of nameEls) {
      const nm = fishNameText(el);
      if (!nm) continue;
      if (!groups.has(nm)) groups.set(nm, []);
      groups.get(nm).push(el);
    }

    // 渲染一格：可获区显示「在售 / 求购」两行，想要区显示在售单行；err 时显示错误文本
    const renderFish = (el, ask, bid, err) => {
      const line = priceElFor(el);
      line.innerHTML = '';
      if (err) {
        line.textContent = err;
        line.style.color = '#ff8f8f';
        return;
      }
      if (getElSet.has(el)) {
        const r1 = document.createElement('div');
        r1.textContent = '在售 ' + (ask == null ? '无' : fmtGold(ask));
        r1.style.cssText = 'color:' + (ask == null ? '#ccc' : '#d4a520') + ';'; // 在售用深黄色
        const r2 = document.createElement('div');
        r2.textContent = '求购 ' + (bid == null ? '无' : fmtGold(bid));
        r2.style.cssText = 'color:' + (bid == null ? '#ccc' : '#59d95a') + ';'; // 求购用绿色区分
        line.appendChild(r1);
        line.appendChild(r2);
      } else {
        line.textContent = ask == null ? '无在售' : fmtGold(ask);
        line.style.color = (ask == null ? '#ccc' : '#d4a520'); // 想要区售价用深黄色
      }
    };

    const total = groups.size;
    let done = 0;
    try {
      const nameMap = await ensureNameMap();
      const hasMap = !!Object.keys(nameMap).length;
      for (const [nm, els] of groups) {
        let ask = null, bid = null, matched = false, fishId = null, err = null;
        if (!hasMap) {
          err = '价格获取失败';
          if (_mapDiag) {
            const d = _mapDiag;
            console.error(TAG, '名字映射失败详情:', d);
            if (els[0]) {
              const line = priceElFor(els[0]);
              line.title = JSON.stringify(d);
              line.innerHTML = '';
              line.textContent = '映射失败: ' + JSON.stringify(d);
              line.style.color = '#ff8f8f';
            }
          }
        }
        else {
          fishId = await fishIdFor(nm);
          if (!fishId) {
            err = '未匹配到鱼';
            if (!_debuggedMiss.has(nm)) {
              _debuggedMiss.add(nm);
              const sampleKeys = Object.keys(nameMap).slice(0, 6);
              console.error(TAG, '未匹配:', JSON.stringify(nm),
                '| 页面名去掉前缀后:', JSON.stringify(stripBracket(nm)),
                '| map 是否有去前缀键:', !!(nameMap[stripBracket(nm)]),
                '| map 键样例:', JSON.stringify(sampleKeys));
            }
          }
          else {
            matched = true;
            const p = await getPrices(fishId);
            ask = p.ask;
            bid = p.bid;
          }
        }
        for (const el of els) {
          renderFish(el, ask, bid, err);
          askByEl.set(el, (matched && ask != null) ? ask : null);
          bidByEl.set(el, (matched && bid != null) ? bid : null);
          fishIdByEl.set(el, matched ? fishId : null);
        }
        done++;
        btn.textContent = `查询中… ${done}/${total}`;
        await sleep(150); // 节奏控制
      }

      // ---- 极值统计与标红 ----
      // 想要区：最低卖价（红）；可获区：最高卖价（红）、最高求购价（用于稳赚）；差价 = 可获最高在售 − 想要最低
      //   稳赚 = 可获区最高求购价 − 想要区那条最低价鱼的出售价
      // 注：两区数量为 0 的鱼（已换完）都不计入判断。
      let wantMin = null, getMax = null, bidMax = null;
      for (const el of wantEls) {
        if (isExhausted(el)) continue; // 无货的鱼不算
        const a = askByEl.get(el);
        if (a != null) wantMin = (wantMin == null ? a : Math.min(wantMin, a));
      }
      for (const el of getEls) {
        if (isExhausted(el)) continue; // 无货的鱼不算
        const a = askByEl.get(el);
        if (a != null) getMax = (getMax == null ? a : Math.max(getMax, a));
        const b = bidByEl.get(el);
        if (b != null) bidMax = (bidMax == null ? b : Math.max(bidMax, b));
      }
      for (const el of wantEls) {
        if (isExhausted(el)) continue; // 无货的鱼不参与标红
        const a = askByEl.get(el);
        if (a != null && a === wantMin) { const l = priceElFor(el); l.style.color = '#ff5a5a'; }
      }
      for (const el of getEls) {
        if (isExhausted(el)) continue; // 无货的鱼不参与标红
        const a = askByEl.get(el);
        if (a != null && a === getMax) {
          const l = priceElFor(el);
          // 可获区为两行，标红作用于「在售」行（第一个子元素）
          const first = l.firstElementChild;
          if (first) first.style.color = '#ff5a5a'; else l.style.color = '#ff5a5a';
        }
      }
      if (diffLab) {
        if (wantMin != null && getMax != null) {
          const d = getMax - wantMin;
          diffLab.textContent = '差价：' + fmtGold(d);
          diffLab.style.color = (d >= 0 ? '#2f9e44' : '#c0392b'); // 赚=深绿，亏=深红
          diffLab.title = '可获最高在售 ' + fmtGold(getMax) + ' − 想要最低 ' + fmtGold(wantMin);
        } else {
          diffLab.textContent = '差价：缺在售';
          diffLab.style.color = '#aaa';
        }
      }
      // 差价左边：显示「想要区最低价」那条鱼的鱼名 + 地图前缀，如「[B13] 星风鲸歌姬」，点击跳转市场
      let minAsk = null; // 想要区最低价那条鱼的出售价
      const fishLab = scope.querySelector('.reelax-barter-diff-fish');
      if (fishLab) {
        let minName = null, minFishId = null;
        if (wantMin != null) {
          for (const el of wantEls) {
            const a = askByEl.get(el);
            if (a != null && a === wantMin) {
              minName = fishNameText(el); // 页面原始鱼名，含 [B13] 前缀
              minFishId = fishIdByEl.get(el); // 该格对应的 fishId
              minAsk = askByEl.get(el); // 那条鱼的出售价
              break;
            }
          }
        }
        if (minName && minFishId) {
          // fishId 形如 b_007_exotic_01 → biomeId 取其前两段
          const segs = String(minFishId).split('_');
          const biome = segs.length >= 2 ? segs.slice(0, 2).join('_') : '';
          const search = stripBracket(minName); // 去掉 [Bxx] 前缀（用于搜索链接）
          const url = 'https://reelax.cn/market?fishSearch=' + encodeURIComponent(search) +
            '&fishBiome=' + encodeURIComponent(biome);
          fishLab.textContent = minName; // 显示为「[B13] 星风鲸歌姬」
          // 不走 <a> 默认导航（会被 SPA 路由拦截导致不跳转），改用控件显式设置跳转
          fishLab.removeAttribute('href');
          fishLab.title = '在市场中跳转到 ' + search;
          fishLab.style.cursor = 'pointer';
          fishLab.style.textDecoration = 'underline';
          if (!fishLab.__reelaxNavBound) {
            fishLab.__reelaxNavBound = true;
            fishLab.addEventListener('click', (e) => {
              e.preventDefault();
              e.stopPropagation();
              gotoMarket(url);
            });
          }
        } else {
          fishLab.textContent = '';
          fishLab.removeAttribute('href');
          fishLab.title = '';
          fishLab.style.cursor = 'default';
        }
      }

      // ---- 稳赚：可获区最高求购价 − 想要区最低价那条鱼的出售价 ----
      const stableLab = scope.querySelector('.reelax-barter-stable');
      if (stableLab) {
        if (bidMax != null && minAsk != null) {
          const s = bidMax - minAsk;
          stableLab.textContent = '稳赚：' + fmtGold(s);
          stableLab.style.color = (s >= 0 ? '#2f9e44' : '#c0392b'); // 赚=深绿 亏=深红
          stableLab.title = '可获区最高求购 ' + fmtGold(bidMax) + ' − 想要鱼出售 ' + fmtGold(minAsk);
        } else {
          stableLab.textContent = '';
          stableLab.title = '';
        }
      }
    } catch (e) {
      nameEls.forEach((el) => setLoading(el, '查询异常', '#ff8f8f'));
    } finally {
      btn.disabled = false;
      btn.textContent = orig;
    }
  }

  // ---------- 注入按钮到每张卡片 footer（选择交换按钮左边） ----------
  // 布局（都在「选择交换」按钮左边）：
  //   第1行：差价  [B13]鱼名链接
  //   第2行：稳赚 X
  //   更新价格 按钮
  function ensureButtons() {
    document.querySelectorAll('.barter-order-card').forEach((card) => {
      if (card.querySelector('.reelax-barter-refresh')) return;
      const footer = card.querySelector('footer');
      if (!footer) return;
      const exchangeBtn = footer.querySelector('button'); // 主按钮「选择交换」

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'reelax-barter-refresh';
      btn.textContent = '更新价格';
      btn.style.cssText = 'margin:0 8px 0 0;padding:4px 12px;border-radius:6px;' +
        'border:1px solid #174a8f;background:#1e5aa8;color:#fff;' +
        'font-size:13px;cursor:pointer;white-space:nowrap;';
      btn.addEventListener('click', (e) => { e.stopPropagation(); onUpdatePrices(btn); });

      // 差价标签
      const diffLab = document.createElement('span');
      diffLab.className = 'reelax-barter-diff';
      diffLab.textContent = '差价：—';
      diffLab.style.cssText = 'margin:0 8px 0 0;font-size:13px;font-weight:bold;color:#d4a520;white-space:nowrap;';
      // 鱼名链接（在差价后面）
      const fishLab = document.createElement('span');
      fishLab.className = 'reelax-barter-diff-fish';
      fishLab.textContent = '';
      fishLab.style.cssText = 'font-size:12px;color:#d4a520;white-space:nowrap;cursor:pointer;text-decoration:underline;';
      // 稳赚标签（独立一行）
      const stableLab = document.createElement('span');
      stableLab.className = 'reelax-barter-stable';
      stableLab.textContent = '';
      stableLab.style.cssText = 'font-size:13px;font-weight:bold;white-space:nowrap;';

      // 容器：两行（第1行 差价+链接，第2行 稳赚）
      const wrapper = document.createElement('div');
      wrapper.className = 'reelax-barter-rows';
      wrapper.style.cssText = 'display:inline-flex;flex-direction:column;align-items:flex-start;' +
        'gap:2px;margin:0 8px 0 0;vertical-align:middle;';
      const row1 = document.createElement('div');
      row1.style.cssText = 'display:flex;align-items:baseline;flex-wrap:nowrap;';
      row1.appendChild(diffLab);
      row1.appendChild(fishLab);
      const row2 = document.createElement('div');
      row2.style.cssText = 'display:block;';
      row2.appendChild(stableLab);
      wrapper.appendChild(row1);
      wrapper.appendChild(row2);

      // 插入：先 wrapper（在左），再 btn（紧贴选择交换）
      footer.insertBefore(wrapper, exchangeBtn || footer.firstChild);
      footer.insertBefore(btn, exchangeBtn || footer.firstChild);
    });
  }

  // ---------- 轮询注入（barter 列表异步渲染） ----------
  function tryInject() {
    if (!document.body) return;
    if (document.querySelector('.barter-order-card')) ensureButtons();
  }

  setInterval(() => { try { tryInject(); } catch (_e) {} }, 1200);
  try { tryInject(); } catch (_e) {}

  console.log(TAG, '已加载：交换列表卡片上将出现「更新价格」按钮');
})();
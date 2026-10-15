// ==UserScript==
// @name         奥术摸鱼大师 · 鱼换鱼交换填单助手（自动循环版）
// @namespace    reelax.barter-helper
// @version      1.0.8
// @description  跨图配单版：全部「想要」（专精缺口）与「可提供」（多余鱼）汇总成池自动组单，每单尽量填满5收+5给；给鱼规则=想收N图时可给图号≤N+3（低图鱼可换任意高图鱼，高图鱼最多下降3张图，图号按地图名的[B编号]计算）；同单内任意一对收/给都满足跨度；数量写入后自动回读校验（不匹配则重试/放弃本单，防止托管数超持有数无法发布）；面板分组排版，预览仿游戏换鱼弹窗格式（左右两栏、显示B图号、缺N/可用N、数量）。
// @author       you
// @match        https://reelax.cn/*
// @grant        none
// @run-at       document-idle
// @noframes
// ==/UserScript==

/* 说明
 * - 数据层：window.arcaneReelax.inventory.getFish()（官方内置 API），
 *   isLocked=绑定，isMasteryLocked=专精锁定；表单里「专精缺 N」「可用 N」为权威标记。
 * - 【v0.8 跨图配单】不再按"同图收同图给"组单，改为：
 *   1) 扫描全部地图，汇总两个池：
 *      想要池 = 各图专精缺口鱼（数量=缺口）；提供池 = 各图非专精多余鱼（数量=多余，逐单扣减，避免重复托管）。
 *   2) 组单规则：每单最多 5 行想要 + 5 行提供，尽量填满。
 *      想要按图号从高到低分组（保证同单内图号接近）；
 *      一单的提供鱼必须满足 图号 ≤ 本单想收的最低图号 + maxMapDrop（默认3）——
 *      即：低图鱼可以换任意高图鱼；高图鱼最多下降3张图使用（如收9图鱼可给1~12图，收1图鱼只能给1~4图）。
 *   3) 提供鱼优先消耗"高图号"的：高图鱼只能用于高图单，先把它们用掉，低图鱼留给受限的低图单。
 * - 自动循环：按设定间隔（默认20分钟，可调）执行 下架旧单→缓冲→发布新单；请求间隔可调，避免服务器繁忙。
 * - 交易操作为 DOM 驱动，发布前有倒计时可取消；最终由游戏服务端校验。
 */
(function () {
  'use strict';

  // ---------------- 配置 ----------------
  const CFG = {
    rarities: ['mythic', 'exotic'],    // 执行的稀有度（可多选，按此顺序逐个扫描发布）
    rarity: 'mythic',                  // 运行时当前稀有度（runCycle 自动切换，勿手改）
    keepPerFish: 0,                    // 每种非专精鱼保留条数；0=直接沿用游戏选鱼后自动填充的数量（最稳，不会和"可用数"对不上）
    includeBoundInProvide: false,      // 是否允许拿绑定鱼（游戏本身不允许，勿开）

    wantType: 'specialized',           // 我想要：specialized/nonSpecialized/all
    wantQtyMode: 'shortage',           // 数量：shortage(缺口) / fixed
    wantQtyFixed: 1,
    provideType: 'nonSpecialized',     // 我拿出去：specialized/nonSpecialized/all
    provideQtyMode: 'surplus',         // 数量：surplus(多余) / fixed
    provideQtyFixed: 1,

    maxMaps: 0,                        // 0=全部15图（调试时可限制）
    maxRows: 5,                        // 每单每侧最多行数（游戏上限5）
    maxMapDrop: 3,                     // 跨图规则：给鱼图号 ≤ 想收最低图号 + N（默认3：高图鱼最多下降3张图）
    maxPlanOrders: 15,                 // 最多生成多少张跨图单（超出部分轮换周期覆盖不到，意义不大）
    maxOrdersPerCycle: 9999,           // 每轮发布张数（默认勾选「当前可用最多」=9999，即发完计划全部）
    rotateOffset: (() => { try { return +localStorage.getItem('rh_rotate_offset') || 0; } catch (e) { return 0; } })(),

    autoPublish: true,                 // 填单后自动发布（有倒计时可取消）
    userStopped: false,                // 用户点了「停止」——立即中断当前填单/发布流程（无论手动还是自动模式）
    busy: false,                       // 「开始」正在运行中（防重复点击）
    publishDelaySec: 5,                // 发布倒计时秒数
    unlistFirst: false,                // 发布前先下架旧单（默认不勾选）
    bufferSec: 8,                      // 下架与上架之间的缓冲秒数
    rateDelayMs: 2500,                 // 请求间隔（下架/上架之间的停顿），避免服务器繁忙
    loopIntervalMin: 20,               // 自动循环间隔（分钟），默认20
    loopRunning: false,                // 循环状态
  };

  const RARITY_LABEL = { mythic: '神话', exotic: '奇异', arcane: '奥秘' };
  const TYPE_LABEL = { specialized: '专精', nonSpecialized: '非专精', all: '全部' };
  const PANEL_STYLE = `
    position:fixed; z-index:999999; left:16px; top:16px; width:450px;
    max-height:92vh; display:flex; flex-direction:column;
    background:#101826f2; color:#e8eef8; border:1px solid #2c3a55; border-radius:14px;
    font:12px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
    box-shadow:0 8px 30px rgba(0,0,0,.45); backdrop-filter:blur(4px);
  `;

  // 面板 / 预览统一样式（一次注入 <head>）
  function ensureStyles() {
    if ($('#rh-style')) return;
    const s = document.createElement('style');
    s.id = 'rh-style';
    s.textContent = `
      #reelax-helper-panel .rh-btnrow{display:flex;gap:6px;margin-bottom:8px;}
      #reelax-helper-panel .rh-btn{background:#1c2740;color:#dbe6f8;border:1px solid #33456b;border-radius:9px;padding:7px 10px;cursor:pointer;font:12px system-ui;transition:background .15s;}
      #reelax-helper-panel .rh-btn:hover{background:#26365c;}
      #reelax-helper-panel .rh-btn-pri{background:#274a8f;border-color:#3a63b8;}
      #reelax-helper-panel .rh-btn-pri:hover{background:#3059ad;}
      #reelax-helper-panel .rh-card{background:#0c1424;border:1px solid #24324d;border-radius:12px;padding:10px 12px;margin-bottom:8px;}
      #reelax-helper-panel .rh-card h3{margin:0 0 8px;font-size:12px;color:#9db4d9;font-weight:600;letter-spacing:.5px;}
      #reelax-helper-panel .rh-card-want{border-color:#2f4a6e;flex:1;min-width:0;}
      #reelax-helper-panel .rh-card-give{border-color:#6e4a2f;flex:1;min-width:0;}
      #reelax-helper-panel .rh-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px 10px;}
      #reelax-helper-panel .rh-field{display:flex;flex-direction:column;gap:3px;min-width:0;}
      #reelax-helper-panel .rh-field label{font-size:10px;color:#8fa5c8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
      #rh-body select,#rh-body input[type=number]{background:#16233a;color:#e8eef8;border:1px solid #2c3a55;border-radius:7px;padding:4px 6px;font:12px system-ui;width:100%;box-sizing:border-box;}
      #rh-body input[type=number]{-moz-appearance:textfield;}
      #rh-body .rh-chk{display:inline-flex;align-items:center;gap:5px;background:#16233a;border:1px solid #2c3a55;border-radius:999px;padding:4px 12px;cursor:pointer;font-size:11px;color:#c6d4ee;}
      #rh-body .rh-chk input{accent-color:#4a7bd0;margin:0;}
      #rh-body .rh-step{background:#16233a;color:#dbe6f8;border:1px solid #2c3a55;border-radius:7px;width:28px;height:27px;cursor:pointer;font:14px/1 system-ui;flex:none;}
      #rh-body .rh-step:hover{background:#24365c;border-color:#3a63b8;}
      #rh-body .rh-mini{background:#16233a;color:#9db4d9;border:1px dashed #33456b;border-radius:7px;padding:4px 8px;cursor:pointer;font:10px system-ui;margin-top:5px;width:100%;}
      #rh-body .rh-mini:hover{color:#ffd479;background:#1c2a44;}
      #reelax-helper-panel .rh-two{display:flex;gap:8px;}
      #reelax-helper-panel .rh-two .rh-card{margin-bottom:8px;}
      /* —— 预览：仿游戏内换鱼弹窗 —— */
      .rh-order{background:#0c1424;border:1px solid #24324d;border-radius:12px;padding:9px 11px;margin-bottom:8px;}
      .rh-order.rh-win{border-color:#3a63b8;background:#111d36;box-shadow:0 0 0 1px #3a63b866;}
      .rh-order-head{font-size:11px;color:#ffd479;font-weight:600;margin-bottom:7px;display:flex;align-items:center;gap:6px;}
      .rh-order-head .rh-cap{background:#1c2a44;border-radius:5px;padding:1px 7px;color:#9db4d9;font-weight:500;}
      .rh-order-cols{display:flex;gap:12px;}
      .rh-ocol{flex:1;min-width:0;}
      .rh-ocol-title{font-size:10px;margin-bottom:3px;font-weight:600;}
      .rh-line{display:flex;align-items:center;gap:5px;padding:3px 0;border-top:1px dashed #1c2a44;font-size:11px;color:#dfe8f8;}
      .rh-btag{background:#1c2a44;color:#8fb8e8;border-radius:4px;padding:0 5px;font-size:10px;flex:none;font-weight:600;}
      .rh-fname{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
      .rh-note{color:#6d84ab;font-size:10px;margin-left:auto;flex:none;}
      .rh-qty{background:#16233a;border:1px solid #2c3a55;border-radius:5px;padding:0 6px;color:#ffd479;font-size:11px;flex:none;min-width:26px;text-align:center;}
      .rh-star{color:#ffc94d;flex:none;}
    `;
    document.head.appendChild(s);
  }

  // ---------------- 工具 ----------------
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const sleepMs = (ms) => new Promise(r => setTimeout(r, ms));
  const tick = (ms = 120) => new Promise(r => setTimeout(r, ms));

  function toast(msg, ms = 3600) {
    let t = $('#reelax-helper-toast');
    if (!t) { t = document.createElement('div'); t.id = 'reelax-helper-toast'; t.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:1000000;background:#111a2b;color:#eaf;border:1px solid #38517a;padding:9px 16px;border-radius:8px;font:13px system-ui;box-shadow:0 6px 20px rgba(0,0,0,.4);max-width:80vw'; document.body.appendChild(t); }
    t.textContent = msg; t.style.display = 'block';
    clearTimeout(t._h); t._h = setTimeout(() => { t.style.display = 'none'; }, ms);
  }

  function getGameApi() {
    const w = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    const resolve = () => w.arcaneReelax.ready ? w.arcaneReelax.ready.then(() => w.arcaneReelax) : Promise.resolve(w.arcaneReelax);
    if (w.arcaneReelax) return resolve();
    return new Promise(res => {
      const h = () => { if (w.arcaneReelax) { document.removeEventListener('arcane-reelax:ready', h); res(resolve()); } };
      document.addEventListener('arcane-reelax:ready', h, { once: true });
      setTimeout(h, 9000);
    });
  }

  // ---------------- 数据 ----------------
  let inventory = [];
  let inventoryLoaded = false;
  let invByFishId = {};
  let plan = [];   // 预览计划

  async function loadInventory(force) {
    if (inventoryLoaded && !force) return inventory;
    try {
      const g = await getGameApi();
      const f = await g.inventory.getFish();
      inventory = Array.isArray(f) ? f : [];
      invByFishId = {}; inventory.forEach(x => { invByFishId[x.fishId] = x; });
      inventoryLoaded = true;
      return inventory;
    } catch (e) { toast('读取背包失败：' + e.message); return []; }
  }

  function isSpecialized(fish, mapSpecSet) {
    if (fish && fish.isMasteryLocked) return true;
    if (mapSpecSet && fish) return mapSpecSet.has(fish.fishId);
    return false;
  }

  // ---------------- 表单操作 ----------------
  function createSections() {
    const body = $('div.barter-dialog-body');
    if (!body) return null;
    const cols = $('div.barter-entry-columns', body);
    if (!cols) return null;
    const secs = $$('section.barter-entry-column', cols);
    return { body, raritySel: $('label.barter-rarity-field select', body), want: secs[0], provide: secs[1] };
  }
  const rowsOf = (idx) => { const s = sectionByIdx(idx); return s ? $$('div.barter-entry-row', s) : []; };
  function sectionByIdx(idx) { const s = createSections(); return s ? (idx === 0 ? s.want : s.provide) : null; }
  function addBtnOf(idx) {
    const s = sectionByIdx(idx);
    return s ? $$('div.barter-entry-list > button', s).find(b => (b.textContent || '').trim().includes('增加鱼种')) : null;
  }

  function setSelect(sel, value) {
    if (!sel) return false;
    const idx = [...sel.options].findIndex(o => o.value === value || o.text.trim() === value);
    if (idx < 0) return false;
    sel.selectedIndex = idx;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  // （旧 setQtyInput 已删除：同时派发 input+change 两个事件，叠加游戏选鱼时的自动填充，
  //   导致数量被放大（如可用6→18）。新逻辑见 setQtyRobust：回读校验、逐策略重试。）

  function waitFishPopulated(fishSel, tries = 25) {
    return new Promise(res => { let n = 0; const iv = setInterval(() => { if (fishSel.options.length > 1 || n++ > tries) { clearInterval(iv); res(); } }, 80); });
  }

  // 等下拉框有选项（新增行的地图下拉是异步填充的，立刻选会失败留下空行）
  async function waitSelectOptions(sel, tries = 30) {
    for (let n = 0; n < tries; n++) { if (sel.options.length > 1) return true; await sleepMs(80); }
    return sel.options.length > 1;
  }

  // 在地图下拉里找到目标地图：先按 value 精确匹配，失败再按选项文本里的 [B编号] 兜底
  // （游戏重新打开表单后 option 的 value 可能重新生成，只有 B 编号是稳定的）
  // getSel 是"获取当前下拉元素"的函数——游戏重渲染会替换元素，每次尝试都必须重新抓取，
  // 否则拿着死元素的引用找选项，等再久也找不到
  async function resolveMapOption(getSel, item, tries = 40) {
    for (let n = 0; n < tries; n++) {
      const sel = getSel();
      if (sel) {
        let opt = [...sel.options].find(o => o.value === item.mapId);
        if (!opt && item.mapB != null) opt = [...sel.options].find(o => { const m = /B\s*(\d+)/i.exec(o.text || ''); return m && +m[1] === item.mapB; });
        if (opt) return opt.value;
      }
      await sleepMs(120);
    }
    // 失败诊断：把下拉里实际有的选项打出来
    const sel = getSel();
    const seen = sel ? [...sel.options].map(o => (o.text || '').trim()).filter(Boolean).slice(0, 6).join(' / ') : '';
    log(`  ↳ 诊断：地图下拉当前可见选项 → ${seen || '（空）'}`);
    return null;
  }

  // 在鱼种下拉里找到目标鱼：先按 value，再按鱼名兜底（同样每次重新抓元素）
  async function resolveFishOption(getSel, fishId, name, tries = 20) {
    for (let n = 0; n < tries; n++) {
      const sel = getSel();
      if (sel) {
        let opt = [...sel.options].find(o => o.value === fishId);
        if (!opt && name) opt = [...sel.options].find(o => (o.text || '').includes(name));
        if (opt) return opt.value;
      }
      await sleepMs(120);
    }
    const sel = getSel();
    const seen = sel ? [...sel.options].map(o => (o.text || '').trim()).filter(Boolean).slice(0, 6).join(' / ') : '';
    log(`  ↳ 诊断：鱼种下拉当前可见选项 → ${seen || '（空）'}`);
    return null;
  }

  // 鱼列表签名 + 等列表真正切换到新地图（切图后列表异步刷新，不等就会读到上一张图的鱼）
  const fishListSig = (sel) => sel.options.length + '|' + (sel.options[1] ? sel.options[1].value : '');
  async function waitFishListChanged(sel, prevSig, tries = 30) {
    for (let n = 0; n < tries; n++) {
      if (fishListSig(sel) !== prevSig) { await tick(120); return true; } // 再缓冲一下让列表渲染完
      await sleepMs(80);
    }
    return false;
  }

  // 删除表单里的某一行（垃圾桶按钮）。必须以"行数确实减少"为准——
  // 游戏重渲染会让元素身份变化，按元素判断会误判成功 → 无限加删循环
  async function removeEntryRow(sectionIdx, rowIdx) {
    const row = rowsOf(sectionIdx)[rowIdx];
    if (!row) return true;
    const before = rowsOf(sectionIdx).length;
    const cands = $$('button,[role="button"],[class*="trash"],[class*="remove"],[class*="delete"],[class*="del"]', row);
    const btn = cands[cands.length - 1]; // 垃圾桶通常在行尾
    if (!btn) return false;
    btn.click();
    for (let n = 0; n < 10; n++) {
      await sleepMs(150);
      if (rowsOf(sectionIdx).length < before) return true;
    }
    return false;
  }

  function getTotals() {
    const strip = $('div.barter-total-strip');
    if (!strip) return null;
    const t = strip.textContent;
    const g = (re) => { const m = re.exec(t); return m ? +m[1] : 0; };
    return { demand: g(/需求总量\s*(\d+)/), escrow: g(/托管总量\s*(\d+)/), maxTrade: g(/最多成交\s*(\d+)/) };
  }

  function clickTab(tabText) {
    const btn = $$('button').find(e => (e.textContent || '').trim() === tabText);
    if (btn) { btn.click(); return true; }
    const el = $$('div,span,a').find(e => (e.textContent || '').trim() === tabText && e.children.length === 0);
    if (el) { el.click(); return true; }
    return false;
  }

  async function waitForDialog(dialogSel, tries = 30) {
    for (let i = 0; i < tries; i++) { if ($(dialogSel)) return true; await tick(100); }
    return false;
  }

  async function ensureCreateForm() {
    if (!location.search.includes('panel=listing')) { clickTab('发布交换'); await sleepMs(900); }
    if (!$('div.barter-dialog-body')) {
      const t = $$('*').find(e => (e.textContent || '').trim() === '创建交换单');
      if (t) { t.click(); await sleepMs(700); }
    }
    return !!$('div.barter-dialog-body');
  }

  async function closeCreateForm() {
    const btn = $$('div.barter-dialog-actions button').find(b => (b.textContent || '').trim() === '返回');
    if (btn) { btn.click(); await sleepMs(400); }
  }

  // ---------------- 计划：读取15图数据 ----------------
  function parseWantOptions(fishSel) {
    return [...fishSel.options].slice(1).map(o => {
      const t = o.text; const m = /专精缺\s*(\d+)/.exec(t);
      return { fishId: o.value, name: t.split(' ·')[0].trim(), shortage: m ? +m[1] : null };
    });
  }
  function parseProvideOptions(fishSel) {
    return [...fishSel.options].slice(1).map(o => {
      const t = o.text; const m = /可用\s*(\d+)/.exec(t);
      return { fishId: o.value, name: t.split(' ·')[0].trim(), available: m ? +m[1] : 0 };
    });
  }

  function matchType(fishId, type, mapSpecSet) {
    const spec = mapSpecSet.has(fishId) || (invByFishId[fishId] && invByFishId[fishId].isMasteryLocked);
    if (type === 'specialized') return spec;
    if (type === 'nonSpecialized') return !spec;
    return true;
  }

  // 扫描创建表单：逐图读取 想要的鱼（专精缺标记）与 可提供的鱼（可用数），
  // 汇总成「想要池 / 提供池」，再按跨图规则组单。
  async function buildMapPlan() {
    if (!(await ensureCreateForm())) { toast('无法打开创建交换单表单'); return []; }
    const sec = createSections();
    if (!sec) return [];
    setSelect(sec.raritySel, CFG.rarity); await sleepMs(200);
    const wantRow = rowsOf(0)[0];
    const provRow = rowsOf(1)[0];
    if (!wantRow || !provRow) return [];
    const wantMapSel = $('select.barter-biome-select', wantRow);
    const provMapSel = $('select.barter-biome-select', provRow);

    // 关键认知：发布表单的地图下拉是【动态过滤】的——只列出你当前持有可交易鱼的地图，
    // 而且打开后可能先给全量再异步过滤。必须等选项数稳定后，以实际下拉为准，
    // 否则组出的单里会出现表单里根本选不了的地图（如你没有B15的鱼，下拉里就没有B15）。
    const settleBiome = async (sel) => {
      let prev = -1;
      for (let n = 0; n < 25; n++) {
        await sleepMs(200);
        const cur = sel.options.length;
        if (cur === prev && cur > 1) return;
        prev = cur;
      }
    };
    await settleBiome(wantMapSel);
    const mapOpts = [...wantMapSel.options].slice(1); // 跳过"先选择地图"占位
    log(`表单可用地图（按你当前背包）：${mapOpts.map(o => (o.text || '').trim()).join('、') || '（无——该稀有度下可能没有可交易鱼）'}`);
    if (!mapOpts.length) { await closeCreateForm(); toast('表单里没有可选地图，无法组单'); return []; }
    const mapLimit = CFG.maxMaps > 0 ? Math.min(CFG.maxMaps, mapOpts.length) : mapOpts.length;

    const wantPool = [];     // {fishId,name,mapId,mapName,mapB,rank,shortage}
    const providePool = [];  // {fishId,name,mapId,mapName,mapB,rank,avail,qty}
    const specByRank = {};   // rank(B编号) -> 该图专精鱼集合（判断"非专精"用本图的专精标记）

    // 真实图号必须取地图名里的 [Bxx] 编号，不能用下拉框的选项序号——两者顺序可能不一致，
    // 跨度规则（给鱼≤收图+跨度）依赖的是 B 编号。
    const parseMapB = (text, fallback) => {
      const m = /\[\s*B\s*(\d+)\s*\]/i.exec(text) || /B\s*(\d+)/i.exec(text);
      return m ? +m[1] : fallback;
    };
    // 在某个地图下拉里定位目标地图（value 优先，B编号兜底），找不到返回 null
    const findMapVal = (sel, mapId, mapB) => {
      let opt = [...sel.options].find(o => o.value === mapId);
      if (!opt && mapB != null) opt = [...sel.options].find(o => { const m = /B\s*(\d+)/i.exec(o.text || ''); return m && +m[1] === mapB; });
      return opt ? opt.value : null;
    };

    // 切换地图后，游戏的鱼列表是异步刷新的——必须等到列表内容真正变化再解析，
    // 否则会把上一张图的鱼又读一遍（同一条鱼被当成多张图的鱼重复计数，
    // 合并时数量累加 → 可用6被算成×18，超过持有量根本发布不了）。
    const fishSig = (sel) => sel.options.length + '|' + (sel.options[1] ? sel.options[1].value : '');
    async function waitFishListChanged(sel, prevSig, tries = 30) {
      for (let n = 0; n < tries; n++) {
        if (fishSig(sel) !== prevSig) { await tick(120); return; } // 再缓冲一下让列表渲染完
        await sleepMs(80);
      }
    }
    const sigOf = (sel) => fishSig(sel);

    for (let idx = 0; idx < mapLimit; idx++) {
      const opt0 = mapOpts[idx];
      const rawName = (opt0.text || '').trim();
      const mapB = parseMapB(rawName, idx + 1);
      const mapName = rawName.replace(/\[\s*B\s*\d+\s*\]\s*/i, '').trim() || rawName;
      const rank = mapB;

      // 想要侧：读该图「专精缺」（两侧下拉可能各自过滤，逐侧定位，定位不到就跳过该侧）
      const wVal = findMapVal(wantMapSel, opt0.value, mapB);
      if (!wVal) { log(`  跳过 ${mapName}：想要侧下拉无此图`); continue; }
      const wPrev = sigOf($('select.barter-rarity-select', wantRow) || wantMapSel);
      setSelect(wantMapSel, wVal);
      const wfSel = $('select.barter-rarity-select', wantRow);
      await waitFishPopulated(wfSel);
      await waitFishListChanged(wfSel, wPrev);
      const wOpts = parseWantOptions(wfSel);
      const specSet = new Set(wOpts.filter(o => o.shortage !== null).map(o => o.fishId));
      specByRank[rank] = specSet;
      for (const o of wOpts) {
        if (!matchType(o.fishId, CFG.wantType, specSet)) continue;
        // 同一条鱼只会属于一张图——若因列表刷新时机被重复读到，跳过（保留缺口更大的记录）
        const dup = wantPool.find(w => w.fishId === o.fishId);
        if (dup) { dup.shortage = Math.max(dup.shortage, o.shortage == null ? 1 : o.shortage); continue; }
        wantPool.push({ fishId: o.fishId, name: o.name, mapId: wVal, mapName, mapB, rank, shortage: o.shortage == null ? 1 : o.shortage });
      }

      // 提供侧：读该图「可用数」
      const pVal = findMapVal(provMapSel, opt0.value, mapB);
      if (!pVal) { log(`  跳过 ${mapName}：提供侧下拉无此图`); continue; }
      const pPrev = sigOf($('select.barter-rarity-select', provRow) || provMapSel);
      setSelect(provMapSel, pVal);
      const pfSel = $('select.barter-rarity-select', provRow);
      await waitFishPopulated(pfSel);
      await waitFishListChanged(pfSel, pPrev);
      for (const o of parseProvideOptions(pfSel)) {
        if (!matchType(o.fishId, CFG.provideType, specByRank[rank])) continue;
        const qty = CFG.provideQtyMode === 'fixed' ? CFG.provideQtyFixed : Math.max(0, o.available - CFG.keepPerFish);
        if (qty > 0) providePool.push({ fishId: o.fishId, name: o.name, mapId: pVal, mapName, mapB, rank, avail: o.available, qty });
      }
      if (CFG.userStopped) { log('⏹ 已停止，中止扫描'); await closeCreateForm(); return []; }
      await sleepMs(80);
    }
    await closeCreateForm();
    const planOut = allocateOrders(wantPool, providePool);
    log(`扫描完成：想要 ${wantPool.length} 种 / 可提供 ${providePool.length} 种 → 组成 ${planOut.length} 张跨图单`);
    return planOut;
  }

  // ---------------- 跨图组单 ----------------
  // 目标优先级：① 清空背包——每一种多余鱼都要有单可去（给鱼 5 种/单，需要多少单开多少单，
  //             想要的缺口允许拆分到多张单做"收口"，如缺10 → 一单收5、另一单收5）；
  //             ② 梯度规则——单内任意一对 收/给 都要"门当户对"：
  //                游戏硬规则：给 ≤ 收 + 3（想收N图最多收N+3图以内的鱼）；
  //                梯度约束（=跨度设置）：给 ≥ 收 - 跨度（收B12的鱼最低也只配B9的给鱼，
  //                拿B1换B15虽然合法但根本没人会来换）。
  // 组单以"给鱼"驱动：给鱼按图号从高到低排队，每 5 种一单，且单内给鱼图号跨度 ≤ span（梯度紧凑）；
  // 本单想收图号必须在 [最高给鱼-3, 最低给鱼+跨度] 区间内，收的数量从剩余缺口里取（优先高图号），
  // 目标覆盖本单托管量，缺口不够时有多少收多少。
  function allocateOrders(wantPool, providePool) {
    const span = CFG.maxMapDrop;
    const GAME_MAX_UP = 3; // 游戏硬规则：给鱼最多比想收高 3 张图
    // 给鱼池：同种鱼去重（"可用数"全背包统一，不累加），数量封顶 ≤ 可用数
    const gives = [];
    const seen = new Map();
    for (const p of providePool) {
      const prev = seen.get(p.fishId);
      if (prev) {
        prev.avail = Math.max(prev.avail || 0, p.avail || 0);
        prev.qty = Math.max(prev.qty, p.qty);
        if (p.rank > prev.rank) { prev.rank = p.rank; prev.mapB = p.mapB; prev.mapId = p.mapId; prev.mapName = p.mapName; }
      } else { const c = { ...p }; seen.set(p.fishId, c); gives.push(c); }
    }
    gives.sort((a, b) => b.rank - a.rank || b.qty - a.qty);
    gives.forEach(g => { g.qty = Math.max(0, Math.min(g.qty, g.avail != null ? g.avail : g.qty)); });
    const giveList = gives.filter(g => g.qty > 0);
    // 想要池：缺口可拆分
    const wants = wantPool
      .map(w => ({ ...w, qty: CFG.wantQtyMode === 'fixed' ? CFG.wantQtyFixed : (w.shortage || 1) }))
      .filter(w => w.qty > 0)
      .sort((a, b) => b.rank - a.rank || b.qty - a.qty);

    const orders = [];
    const ROWS = CFG.maxRows;
    // 阶段1：梯度内组单（门当户对）
    let idx = 0;
    while (idx < giveList.length && orders.length < CFG.maxPlanOrders) {
      const start = idx;
      // 取给鱼：从高到低，单内图号差不超过 span（梯度紧凑）
      const giveChunk = [giveList[idx]]; idx++;
      while (idx < giveList.length && giveChunk.length < ROWS && giveChunk[0].rank - giveList[idx].rank <= span) {
        giveChunk.push(giveList[idx]); idx++;
      }
      const giveMax = giveChunk[0].rank;
      const minGive = giveChunk[giveChunk.length - 1].rank;
      const wantLo = giveMax - GAME_MAX_UP;   // 想收下限（游戏硬规则）
      const wantHi = minGive + span;          // 想收上限（梯度约束）
      const escrowQty = giveChunk.reduce((s, g) => s + g.qty, 0);
      // 收口：从剩余缺口里选想收（图号 ∈ [wantLo, wantHi]，优先高图号），目标覆盖托管量
      const wantRows = [];
      let demand = 0;
      for (const w of wants) {
        if (wantRows.length >= ROWS) break;
        if (w.qty <= 0 || w.rank < wantLo || w.rank > wantHi) continue;
        const take = Math.min(w.qty, Math.max(1, escrowQty - demand));
        wantRows.push({ fishId: w.fishId, name: w.name, mapId: w.mapId, mapName: w.mapName, mapB: w.mapB, rank: w.rank, shortage: w.shortage, qty: take });
        w.qty -= take; demand += take;
        if (demand >= escrowQty) break;
      }
      if (!wantRows.length) { idx = start; break; } // 梯度内没缺口了 → 回退未消费的给鱼，交给兜底阶段
      orders.push({
        mapName: `跨图单${orders.length + 1}`,
        maxGive: giveMax,
        want: wantRows,
        provide: giveChunk.map(g => ({ fishId: g.fishId, name: g.name, mapId: g.mapId, mapName: g.mapName, mapB: g.mapB, rank: g.rank, avail: g.avail, qty: g.qty })),
      });
    }
    // 阶段2 兜底：梯度内的缺口用完后，剩余给鱼按"只守游戏规则（给 ≤ 收+3）"强行组单——
    // 最终目的是清空背包，对方划不划算不考虑；选缺口时优先离给鱼图号最近的，让坏单尽量不那么坏
    let relaxedUsed = false;
    while (idx < giveList.length && orders.length < CFG.maxPlanOrders) {
      const giveChunk = [giveList[idx]]; idx++;
      while (idx < giveList.length && giveChunk.length < ROWS) { giveChunk.push(giveList[idx]); idx++; }
      const giveMax = giveChunk[0].rank;
      const wantLo = giveMax - GAME_MAX_UP;
      const escrowQty = giveChunk.reduce((s, g) => s + g.qty, 0);
      const elig = wants.filter(w => w.qty > 0 && w.rank >= wantLo).sort((a, b) => a.rank - b.rank);
      const wantRows = [];
      let demand = 0;
      for (const w of elig) {
        if (wantRows.length >= ROWS) break;
        const take = Math.min(w.qty, Math.max(1, escrowQty - demand));
        wantRows.push({ fishId: w.fishId, name: w.name, mapId: w.mapId, mapName: w.mapName, mapB: w.mapB, rank: w.rank, shortage: w.shortage, qty: take });
        w.qty -= take; demand += take;
        if (demand >= escrowQty) break;
      }
      if (!wantRows.length) { log(`⚠ 剩余 ${giveChunk.length} 种给鱼连游戏规则下的缺口都没有（缺口已全部用完），无法挂单`); break; }
      if (!relaxedUsed) { relaxedUsed = true; log(`⚠ 梯度破例启动：剩余给鱼没有门当户对的缺口，改按"只守游戏规则"组单（清背包优先，单内收/给图号差可能较大）`); }
      orders.push({
        mapName: `跨图单${orders.length + 1}`,
        maxGive: giveMax,
        relaxed: true,
        want: wantRows,
        provide: giveChunk.map(g => ({ fishId: g.fishId, name: g.name, mapId: g.mapId, mapName: g.mapName, mapB: g.mapB, rank: g.rank, avail: g.avail, qty: g.qty })),
      });
    }
    return orders;
  }

  // ---------------- 发布 ----------------
  // 跨图版：每行鱼用各自的 mapId（不再整单同一张图）。
  // 关键教训：切换地图/选择鱼后，游戏可能重建行内元素并自动填充数量——
  // 所以每一步都重新抓取当前行的元素，数量写入后必须回读校验。
  async function fillOrderSection(sectionIdx, items) {
    let ok = 0;
    let i = 0;
    while (i < items.length) {
      if (CFG.userStopped) { log('⏹ 用户已停止，中止填单'); return ok > 0; }
      let rows = rowsOf(sectionIdx);
      if (i >= rows.length) {
        const b = addBtnOf(sectionIdx);
        if (!b) break;
        b.click(); await sleepMs(300);
        rows = rowsOf(sectionIdx);
        if (i >= rows.length) break;
      }
      let row = rows[i];
      const getMapSel = () => { const r = rowsOf(sectionIdx)[i]; return r ? $('select.barter-biome-select', r) : null; };
      const getFishSel = () => { const r = rowsOf(sectionIdx)[i]; return r ? $('select.barter-rarity-select', r) : null; };
      if (!getMapSel()) break;

      // 找地图：按 value，找不到按 [B编号] 兜底；每次尝试重新抓元素（游戏会重渲染替换节点）
      const mapVal = await resolveMapOption(getMapSel, items[i]);
      if (!mapVal) {
        log(`⚠ 地图下拉里始终没有 ${items[i].mapName}（B${items[i].mapB}），跳过这条鱼`);
        if (!(await removeEntryRow(sectionIdx, i))) { log('⚠ 该行无法删除（留空将由发布前校验兜底）'); i++; }
        continue; // 删行成功时 i 不变（下一项顶上来的行）；删行失败时 i++ 保证前进，不会死循环
      }
      setSelect(getMapSel(), mapVal);

      // 等鱼列表真正切到这张图（防读到上一张图的鱼）
      let fishSel = getFishSel() || $('select.barter-rarity-select', row);
      const prevSig = fishListSig(fishSel);
      await waitFishPopulated(fishSel);
      await waitFishListChanged(fishSel, prevSig);
      const fishVal = await resolveFishOption(getFishSel, items[i].fishId, items[i].name);
      if (!fishVal) {
        log(`⚠ ${items[i].name} 不在 ${items[i].mapName} 的鱼种下拉里，跳过这条鱼`);
        if (!(await removeEntryRow(sectionIdx, i))) { log('⚠ 该行无法删除（留空将由发布前校验兜底）'); i++; }
        continue;
      }
      setSelect(getFishSel() || fishSel, fishVal);
      await tick(150); // 等游戏自动填充数量
      if (!(await setQtyRobust(sectionIdx, i, items[i].qty))) {
        log(`⚠ 「${items[i].name}」数量无法设为 ${items[i].qty}（实际为 ${qtyOf(sectionIdx, i)}），放弃本单，避免发布后无法成交`);
        return false;
      }
      ok++;
      i++;
    }
    return ok > 0;
  }

  // 读取某行当前的数量输入框值（每次重新抓取，防元素重建）
  function qtyOf(sectionIdx, rowIdx) {
    const row = rowsOf(sectionIdx)[rowIdx];
    const inp = row && $('input[type=number]', row);
    return inp ? Math.floor(+inp.value || 0) : -1;
  }

  // 数量写入 + 回读校验。游戏会在选鱼时自动填充数量（想要=缺口数 / 提供=可用数），
  // 程序直接设值+派发事件可能与自动填充叠加导致数量翻倍（如可用6被写成18）。
  // 策略：自动填充已等于目标→不碰；否则设值→回读→不对就换策略重试；最终不匹配返回 false。
  async function setQtyRobust(sectionIdx, rowIdx, target) {
    target = Math.max(1, Math.floor(+target || 1));
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    if (qtyOf(sectionIdx, rowIdx) === target) return true; // 游戏自动填充正好是目标值

    // 策略1：直接设值 + input 事件
    for (let a = 0; a < 2; a++) {
      const row = rowsOf(sectionIdx)[rowIdx]; const inp = row && $('input[type=number]', row);
      if (!inp) return false;
      setter.call(inp, String(target));
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      await tick(160);
      if (qtyOf(sectionIdx, rowIdx) === target) return true;
    }
    // 策略2：先清空再设（应对在旧值上累加的组件）
    {
      const row = rowsOf(sectionIdx)[rowIdx]; const inp = row && $('input[type=number]', row);
      if (inp) {
        setter.call(inp, ''); inp.dispatchEvent(new Event('input', { bubbles: true })); await tick(120);
        setter.call(inp, String(target)); inp.dispatchEvent(new Event('input', { bubbles: true })); await tick(160);
        if (qtyOf(sectionIdx, rowIdx) === target) return true;
      }
    }
    // 策略3：change 事件变体
    {
      const row = rowsOf(sectionIdx)[rowIdx]; const inp = row && $('input[type=number]', row);
      if (inp) {
        setter.call(inp, String(target));
        inp.dispatchEvent(new Event('change', { bubbles: true }));
        await tick(160);
        if (qtyOf(sectionIdx, rowIdx) === target) return true;
      }
    }
    return qtyOf(sectionIdx, rowIdx) === target;
  }

  async function publishOneOrder(item) {
    if (!(await ensureCreateForm())) return false;
    const sec = createSections();
    if (!sec) return false;
    setSelect(sec.raritySel, CFG.rarity); await sleepMs(200);

    const wantOk = await fillOrderSection(0, item.want);
    const provOk = await fillOrderSection(1, item.provide);
    if (!wantOk || !provOk) { log('跳过 ' + item.mapName + '（表单未填完整）'); await closeCreateForm(); return false; }
    // 填单中途被用户停止 → 半填的单也不发，直接关表单
    if (CFG.userStopped) { log('⏹ 已停止，不发布 ' + item.mapName + '（表单已丢弃）'); await closeCreateForm(); return false; }

    // 发布前最终校验：任何一行没选好地图/鱼种都不要点发布——游戏只会报"未知原因"
    const bad = [];
    for (let s = 0; s < 2; s++) {
      rowsOf(s).forEach((r, ri) => {
        const ms = $('select.barter-biome-select', r);
        const fs = $('select.barter-rarity-select', r);
        if (!ms || ms.selectedIndex <= 0) bad.push(`${s === 0 ? '想要' : '提供'}第${ri + 1}行缺地图`);
        else if (!fs || fs.selectedIndex <= 0) bad.push(`${s === 0 ? '想要' : '提供'}第${ri + 1}行缺鱼种`);
      });
    }
    if (bad.length) { log('⚠ 表单有空行（' + bad.join('；') + '），放弃发布'); await closeCreateForm(); return false; }

    const totals = getTotals();
    if (!totals || totals.demand < 1 || totals.escrow < 1) {
      log('跳过 ' + item.mapName + '（需求/托管总量为0）'); await closeCreateForm(); return false;
    }
    log(`准备发布 ${item.mapName}：需求 ${totals.demand} / 托管 ${totals.escrow} / 最多成交 ${totals.maxTrade}`);

    if (CFG.autoPublish) {
      const go = await showPublishCountdown(item.mapName);
      if (!go) { log('已取消发布 ' + item.mapName); await closeCreateForm(); return false; }
    }
    if (CFG.userStopped) { log('⏹ 已停止，不发布 ' + item.mapName); await closeCreateForm(); return false; }
    const pubBtn = $('div.barter-dialog-actions button.primary-button');
    if (!pubBtn) { await closeCreateForm(); return false; }
    pubBtn.click();
    log('已点「发布交换单」（' + item.mapName + '），等待确认…');
    let closed = false;
    for (let i = 0; i < 40; i++) { await sleepMs(200); if (!$('div.barter-dialog-body')) { closed = true; break; } }
    if (!closed) {
      // 读取弹窗内的校验/错误提示
      const err = [...document.querySelectorAll('div.barter-dialog-body *')]
        .filter(e => e.children.length === 0 && /上限|失败|错误|繁忙|不足|不可|超过|数量|至少|至多|无法/.test(e.textContent || '') && e.textContent.trim().length < 60)
        .map(e => e.textContent.trim());
      log(`⚠ ${item.mapName} 发布未成功：${err.length ? err.join('；') : '未知原因（弹窗未关闭）'}`);
      await closeCreateForm();
      return false;
    }
    log('✅ ' + item.mapName + ' 发布成功');
    await sleepMs(CFG.rateDelayMs); // 请求间隔，避免服务器繁忙
    return true;
  }

  // 手动发布：发布计划中的全部订单
  // （已被 runCycle 取代，保留仅作兼容调用）
  async function publishAll() {
    if (!plan.length) { toast('计划为空，请先「生成预览」'); return 0; }
    let ok = 0;
    for (const item of getWindow(plan)) {
      if (CFG.userStopped) { log('⏹ 已停止，中止发布'); break; }
      if (await publishOneOrder(item)) ok++;
    }
    return ok;
  }

  // 自动发布倒计时（可取消）
  function showPublishCountdown(mapName) {
    return new Promise(res => {
      let left = Math.max(3, CFG.publishDelaySec);
      const bar = document.createElement('div');
      bar.id = 'rh-publish-bar';
      bar.style.cssText = 'position:fixed;left:50%;bottom:64px;transform:translateX(-50%);z-index:1000001;background:#1c2740;color:#ffd;border:1px solid #ffc94d;padding:10px 16px;border-radius:10px;font:13px system-ui;box-shadow:0 8px 24px rgba(0,0,0,.5);display:flex;align-items:center;gap:12px;';
      bar.innerHTML = `<span id="rh-cd">⏳ ${left} 秒后发布 ${esc(mapName)}</span><button id="rh-cd-cancel" style="background:#5a3b3b;color:#fff;border:none;border-radius:6px;padding:5px 12px;cursor:pointer;">取消</button>`;
      document.body.appendChild(bar);
      let cancelled = false;
      bar.querySelector('#rh-cd-cancel').onclick = () => { cancelled = true; bar.remove(); res(false); };
      const iv = setInterval(() => {
        left--;
        if (CFG.userStopped) { clearInterval(iv); bar.remove(); log('⏹ 已停止，取消倒计时'); res(false); return; }
        const el = bar.querySelector('#rh-cd');
        if (el) el.textContent = `⏳ ${left} 秒后发布 ${mapName}`;
        if (left <= 0) { clearInterval(iv); bar.remove(); res(!cancelled); }
      }, 1000);
    });
  }

  // ---------------- 下架旧单 ----------------
  async function unlistAll() {
    if (!location.search.includes('panel=orders')) { clickTab('我的交换单'); await sleepMs(1000); }
    let cancelled = 0;
    for (let round = 0; round < 40; round++) {
      const btn = $$('button.danger-button').find(b => (b.textContent || '').trim().includes('取消并返还') && !b.disabled);
      if (!btn) break;
      btn.click(); await sleepMs(500);
      if (!(await waitForDialog('section.market-confirm-dialog'))) break;
      const confirmBtn = $$('section.market-confirm-dialog button').find(b => (b.textContent || '').trim() === '确认取消');
      if (!confirmBtn) { toast('未找到确认取消按钮，下架中止'); break; }
      confirmBtn.click();
      let closed = false;
      for (let i = 0; i < 40; i++) { await sleepMs(200); if (!$('section.market-confirm-dialog')) { closed = true; break; } }
      if (closed) { cancelled++; log('已下架第 ' + cancelled + ' 张旧单（鱼已返还）'); }
      else log('第 ' + (cancelled + 1) + ' 单下架可能未完成，继续…');
      if (CFG.userStopped) { log('⏹ 已停止，中止下架'); break; }
      await sleepMs(CFG.rateDelayMs); // 请求间隔
    }
    return cancelled;
  }

  // ---------------- 循环 ----------------
  // 轮转窗口：每轮取计划中的连续 N 张发布（N=每轮发布张数；"当前可用最多"时=计划全量）
  function getWindow(planList) {
    const m = Math.max(1, Math.min(planList.length || 1, Math.floor(+CFG.maxOrdersPerCycle || 1)));
    if (!planList.length) return [];
    if (planList.length <= m) return planList;
    const start = CFG.rotateOffset % planList.length;
    const win = [];
    for (let i = 0; i < m; i++) win.push(planList[(start + i) % planList.length]);
    return win;
  }
  function advanceRotation(planList) {
    if (!planList.length) return;
    CFG.rotateOffset = (CFG.rotateOffset + Math.max(1, Math.floor(+CFG.maxOrdersPerCycle || 1))) % planList.length;
    try { localStorage.setItem('rh_rotate_offset', String(CFG.rotateOffset)); } catch (e) { }
  }

  async function runCycle() {
    log('—— 新一轮开始 ——');
    loadInventory(true).then(renderSummary).catch(() => {}); // 静默刷新背包（摘要用，计划数据以表单实时读取为准）
    if (CFG.unlistFirst) {
      const n = await unlistAll();
      log(n ? `已下架 ${n} 张旧单，缓冲 ${CFG.bufferSec}s 后上新` : '无旧单');
      await sleepMs(CFG.bufferSec * 1000);
      if (CFG.userStopped) { log('⏹ 已停止'); return; }
    }
    // 按勾选的稀有度逐个扫描+发布（神话→奇异→奥秘）
    const rarities = CFG.rarities.length ? CFG.rarities : ['mythic'];
    for (const r of rarities) {
      if (CFG.userStopped) break;
      CFG.rarity = r;
      log(`【${RARITY_LABEL[r]}】开始扫描…`);
      plan = await buildMapPlan();
      const win = getWindow(plan);
      renderPreview(win);
      log(`【${RARITY_LABEL[r]}】计划共 ${plan.length} 张跨图单，本轮发布 ${win.length} 张`);
      for (const item of win) {
        if (CFG.userStopped) break;
        await publishOneOrder(item);
      }
      if (!CFG.userStopped) advanceRotation(plan);
    }
    log(CFG.userStopped ? '⏹ 本轮已停止。' : '本轮发布完成（' + rarities.map(r => RARITY_LABEL[r]).join('、') + '）。');
  }

  // （旧 runLoop 已删除：开始/循环逻辑统一收进「开始」按钮——
  //   勾选「自动循环」= 循环发布直到停止；不勾选 = 只发布一轮（每轮发布张数））

  function stopLoop() {
    CFG.loopRunning = false;
    CFG.userStopped = true;
    const b = $('#rh-puball'); if (b) b.textContent = '🚀 开始';
    log('⏹ 已停止（正在进行的动作会立即中断）');
  }

  // ---------------- 面板 ----------------
  function buildPanel() {
    if ($('#reelax-helper-panel')) return;
    const panel = document.createElement('div');
    panel.id = 'reelax-helper-panel';
    panel.style.cssText = PANEL_STYLE;
    ensureStyles();
    panel.innerHTML = `
      <div id="rh-head" style="display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid #24324d;cursor:move;user-select:none;">
        <span style="font-weight:700;font-size:13px;flex:1;">🐟 交换填单助手</span>
        <button id="rh-collapse" style="background:none;border:none;color:#9db4d9;cursor:pointer;font-size:14px;line-height:1;">–</button>
      </div>
      <div id="rh-body" style="overflow:auto;padding:10px 12px;">
        <div class="rh-btnrow">
          <button id="rh-preview" class="rh-btn" style="flex:1;">📋 生成预览</button>
          <button id="rh-puball" class="rh-btn rh-btn-pri" style="flex:1;">🚀 开始</button>
          <button id="rh-stop" class="rh-btn" style="flex:0.6;">■ 停止</button>
        </div>

        <div class="rh-card">
          <h3>发布规则</h3>
          <div class="rh-grid">
            <div class="rh-field"><label>稀有度（可多选，按顺序执行）</label>
              <div style="display:flex;gap:4px;">
                <label class="rh-chk" style="padding:3px 8px;flex:1;justify-content:center;" title="交易神话鱼"><input type="checkbox" id="rh-rar-mythic" checked> 神话</label>
                <label class="rh-chk" style="padding:3px 8px;flex:1;justify-content:center;" title="交易奇异鱼"><input type="checkbox" id="rh-rar-exotic" checked> 奇异</label>
                <label class="rh-chk" style="padding:3px 8px;flex:1;justify-content:center;" title="交易奥秘鱼"><input type="checkbox" id="rh-rar-arcane"> 奥秘</label>
              </div>
            </div>
            <div class="rh-field"><label>每轮发布张数</label>
              <div style="display:flex;gap:4px;align-items:center;">
                <button id="rh-onum-dec" class="rh-step" title="减 1">−</button>
                <input id="rh-onum" type="number" min="1" max="50" value="${CFG.maxOrdersPerCycle}" style="flex:1;text-align:center;">
                <button id="rh-onum-inc" class="rh-step" title="加 1">＋</button>
              </div>
            </div>
            <div style="display:flex;align-items:flex-start;">
              <label class="rh-chk" title="发布新单前，先下架我的交换单里所有旧单"><input type="checkbox" id="rh-unlist"> 发布前先下架旧单</label>
            </div>
            <div style="display:flex;align-items:flex-start;">
              <label class="rh-chk" title="勾选后不限张数：本轮把计划里的单全部发出（发到没鱼为止）"><input type="checkbox" id="rh-onum-max" checked> 当前可用最多</label>
            </div>
            <div class="rh-field"><label>跨图跨度</label>
              <input id="rh-drop" type="number" min="0" value="${CFG.maxMapDrop}">
            </div>
            <div class="rh-field"><label>每种保留条数</label>
              <input id="rh-keep" type="number" min="0" value="${CFG.keepPerFish}">
            </div>
          </div>
        </div>

        <label class="rh-chk" style="margin-bottom:8px;" title="勾选：点「开始」后循环发布（间隔见下方设置），直到点「停止」；不勾选：点「开始」只发布一轮（张数=每轮发布张数）"><input type="checkbox" id="rh-loopset"> 🔁 自动循环</label>
        <div class="rh-card" id="rh-loopcard" style="display:none;">
          <h3>自动循环</h3>
          <div class="rh-grid">
            <div class="rh-field"><label>循环间隔（分钟）</label>
              <input id="rh-interval" type="number" min="1" value="${CFG.loopIntervalMin}">
            </div>
            <div class="rh-field"><label>发布倒计时（秒）</label>
              <input id="rh-pubdelay" type="number" min="1" value="${CFG.publishDelaySec}">
            </div>
            <div class="rh-field"><label>请求间隔（秒）</label>
              <input id="rh-rate" type="number" min="0.5" step="0.5" value="${CFG.rateDelayMs/1000}">
            </div>
          </div>
        </div>

        <div class="rh-two">
          <div class="rh-card rh-card-want">
            <h3 style="color:#7fd0a8;">← 我想要（收）</h3>
            <div class="rh-field" style="margin-bottom:6px;"><label>鱼类型</label>
              <select id="rh-wanttype"><option value="specialized" selected>专精</option><option value="nonSpecialized">非专精</option><option value="all">全部</option></select>
            </div>
            <div class="rh-field"><label>数量</label>
              <div style="display:flex;gap:4px;">
                <select id="rh-wantqty" style="flex:1;" title="按缺口 = 每种鱼填游戏显示的「专精缺 N」（还缺几条填几条）；固定 = 每种鱼都填右边输入框的数字">
                  <option value="shortage" selected>按缺口</option><option value="fixed">固定</option>
                </select>
                <input id="rh-wantfixed" type="number" min="1" value="${CFG.wantQtyFixed}" title="仅「固定」模式生效：每种想要鱼都填这个数量" style="width:52px;">
              </div>
            </div>
          </div>
          <div class="rh-card rh-card-give">
            <h3 style="color:#f0b17f;">我拿出去的（给）→</h3>
            <div class="rh-field" style="margin-bottom:6px;"><label>鱼类型</label>
              <select id="rh-providetype"><option value="nonSpecialized" selected>非专精</option><option value="specialized">专精</option><option value="all">全部</option></select>
            </div>
            <div class="rh-field"><label>数量</label>
              <div style="display:flex;gap:4px;">
                <select id="rh-provideqty" style="flex:1;" title="按多余 = 每种鱼填「可用 N − 保留条数」（不占用自己的库存）；固定 = 每种鱼都填右边输入框的数字">
                  <option value="surplus" selected>按多余</option><option value="fixed">固定</option>
                </select>
                <input id="rh-providefixed" type="number" min="1" value="${CFG.provideQtyFixed}" title="仅「固定」模式生效：每种提供鱼都填这个数量" style="width:52px;">
              </div>
            </div>
          </div>
        </div>

        <div id="rh-summary" class="rh-card" style="color:#c6d4ee;font-size:11px;"></div>
        <div id="rh-prevhead" style="display:flex;align-items:center;gap:6px;margin:10px 0 6px;font-weight:600;font-size:12px;color:#9db4d9;cursor:pointer;user-select:none;" title="点击展开/收起计划预览">
          <span id="rh-prevarrow">▶</span> 📋 计划预览（共 <span id="rh-plantotal">0</span> 单）
        </div>
        <div id="rh-prevbody" style="display:none;">
          <div id="rh-table" style="max-height:38vh;overflow:auto;"></div>
        </div>
        <div id="rh-log" style="margin-top:8px;color:#7f93b8;font-size:11px;max-height:100px;overflow:auto;border-top:1px dashed #24324d;padding-top:6px;"></div>
      </div>
    `;
    document.body.appendChild(panel);

    // 拖拽：展开时抓标题栏，悬浮球时抓球体
    const drag = { moving: false, moved: false, sx: 0, sy: 0, ox: 0, oy: 0 };
    const dragStart = (e) => {
      drag.moving = true; drag.moved = false;
      drag.sx = e.clientX; drag.sy = e.clientY;
      const r = panel.getBoundingClientRect(); drag.ox = r.left; drag.oy = r.top;
      e.preventDefault(); // 防止拖拽时选中文字
    };
    document.addEventListener('mousemove', (e) => {
      if (!drag.moving) return;
      if (Math.abs(e.clientX - drag.sx) + Math.abs(e.clientY - drag.sy) > 4) drag.moved = true;
      panel.style.left = (drag.ox + e.clientX - drag.sx) + 'px';
      panel.style.top = (drag.oy + e.clientY - drag.sy) + 'px';
    });
    document.addEventListener('mouseup', () => { drag.moving = false; });
    $('#rh-head', panel).addEventListener('mousedown', dragStart);

    // 折叠：默认收起成圆形蓝色🐟按钮，点击展开
    const setCollapsed = (c) => {
      const head = $('#rh-head', panel), body = $('#rh-body', panel);
      let fish = $('#rh-fishbtn', panel);
      if (c) {
        head.style.display = 'none';
        body.style.display = 'none';
        if (!fish) {
          fish = document.createElement('div');
          fish.id = 'rh-fishbtn';
          fish.textContent = '🐟';
          fish.style.cssText = 'flex:1;display:flex;align-items:center;justify-content:center;font-size:28px;cursor:pointer;user-select:none;';
          fish.addEventListener('mousedown', dragStart);
          fish.addEventListener('click', () => { if (drag.moved) { drag.moved = false; return; } setCollapsed(false); }); // 拖拽松手不展开
          panel.appendChild(fish);
        }
        fish.style.display = 'flex';
        panel.style.width = '56px';
        panel.style.height = '56px';
        panel.style.maxHeight = '56px';
        panel.style.borderRadius = '50%';
        panel.style.background = 'radial-gradient(circle at 32% 28%, #4d86e8, #1d3f8f 72%)';
        panel.style.boxShadow = '0 4px 18px rgba(58,111,216,.55)';
        panel.style.border = '1px solid #5a8ce8';
        panel.title = '打开交换填单助手（可拖动）';
        panel.onclick = null;
      } else {
        if (fish) fish.style.display = 'none';
        head.style.display = 'flex';
        body.style.display = 'block';
        panel.style.width = '450px';
        panel.style.height = '';
        panel.style.maxHeight = '92vh';
        panel.style.borderRadius = '14px';
        panel.style.background = '#101826f2';
        panel.style.boxShadow = '0 8px 30px rgba(0,0,0,.45)';
        panel.style.border = '1px solid #2c3a55';
        panel.title = '';
        panel.onclick = null;
      }
    };
    $('#rh-collapse', panel).onclick = (e) => { e.stopPropagation(); setCollapsed(true); }; // 阻止冒泡：否则收起后同一击会立刻冒泡到面板的"点击展开"，一收一开等于没动
    setCollapsed(true); // 默认收起
    const bindNum = (id, fn) => { const el = $(id, panel); el.onchange = e => fn(el, e); };
    // 「以物易物」发布交换页判定：.barter 面板 + panel=listing
    const isOnBarterListing = () => location.pathname.replace(/\/+$/, '') === '/market'
      && location.search.includes('market=barter')
      && location.search.includes('panel=listing');
    // 不在该页则自动跳转，并用 sessionStorage 记下待办，落地后脚本重注入自动续跑
    const ensureBarterPage = (pending) => {
      if (isOnBarterListing()) return true;
      try { sessionStorage.setItem('rh_pending', pending); } catch (e) {}
      toast('↪ 正在切换到「以物易物」发布交换页面…', 2500);
      log('↪ 未在发布交换页，跳转到 https://reelax.cn/market?market=barter&panel=listing');
      location.href = 'https://reelax.cn/market?market=barter&panel=listing';
      return false;
    };
    // 「生成预览」：不在发布交换页则先跳转，落地后自动重放预览
    $('#rh-preview', panel).onclick = async () => {
      if (!ensureBarterPage('preview')) return;
      plan = await buildMapPlan(); renderPreview(); setPreviewOpen(true);
    };
    // 「开始」：勾选「自动循环」→ 循环发布直到点「停止」；不勾选 → 只发布一轮（张数=每轮发布张数）
    const startRun = async (loopMode) => {
      if (CFG.busy) return;
      // 表单操作依赖「以物易物」发布交换页面的 DOM：不在该页则自动跳转，落地后自动续跑
      if (!ensureBarterPage(loopMode ? 'start-loop' : 'start-once')) return;
      CFG.busy = true; CFG.userStopped = false;
      const btn = $('#rh-puball', panel);
      btn.textContent = '■ 运行中…';
      try {
        if (loopMode) {
          CFG.loopRunning = true;
          let round = 0;
          while (CFG.loopRunning && !CFG.userStopped) {
            round++;
            log(`🔁 自动循环 · 第 ${round} 轮`);
            await runCycle();
            if (!CFG.loopRunning || CFG.userStopped) break;
            log(`休眠 ${CFG.loopIntervalMin} 分钟后开始下一轮（点「停止」随时中断）`);
            const end = Date.now() + CFG.loopIntervalMin * 60000;
            while (CFG.loopRunning && !CFG.userStopped && Date.now() < end) await sleepMs(500);
          }
        } else {
          await runCycle();
        }
      } finally {
        CFG.loopRunning = false; CFG.busy = false;
        btn.textContent = '🚀 开始';
      }
    };
    $('#rh-puball', panel).onclick = () => startRun($('#rh-loopset', panel).checked);
    $('#rh-stop', panel).onclick = () => stopLoop();
    // 稀有度多选：勾选哪些就执行哪些（按 神话→奇异→奥秘 顺序）
    const syncRarities = () => { CFG.rarities = ['mythic', 'exotic', 'arcane'].filter(r => $('#rh-rar-' + r, panel).checked); };
    ['mythic', 'exotic', 'arcane'].forEach(r => { $('#rh-rar-' + r, panel).onchange = syncRarities; });
    syncRarities();
    bindNum('#rh-interval', (el) => { CFG.loopIntervalMin = Math.max(1, +el.value || 20); });
    bindNum('#rh-pubdelay', (el) => { CFG.publishDelaySec = Math.max(1, +el.value || 5); });
    bindNum('#rh-rate', (el) => { CFG.rateDelayMs = Math.max(500, Math.round((+el.value || 2.5) * 1000)); });
    bindNum('#rh-keep', (el) => { CFG.keepPerFish = Math.max(0, +el.value || 0); });
    // 每轮发布张数：步进器（−/＋）+ 手动输入；勾选「当前可用最多」= 不限张数（计划里有多少发多少）
    const onumEl = $('#rh-onum', panel);
    const maxChk = $('#rh-onum-max', panel);
    let lastOnum = Math.max(1, Math.min(50, Math.floor(+CFG.maxOrdersPerCycle || 1)));
    const syncOrderNum = () => { CFG.maxOrdersPerCycle = maxChk.checked ? 9999 : Math.max(1, Math.min(50, Math.floor(+onumEl.value || 1))); };
    const syncOnumVis = () => {
      onumEl.disabled = maxChk.checked;
      onumEl.style.opacity = maxChk.checked ? '.4' : '';
      $('#rh-onum-dec', panel).disabled = maxChk.checked;
      $('#rh-onum-inc', panel).disabled = maxChk.checked;
      if (maxChk.checked) { onumEl.value = ''; onumEl.placeholder = '最多'; }
      else { onumEl.value = lastOnum; }
      syncOrderNum();
    };
    onumEl.onchange = syncOrderNum;
    $('#rh-onum-dec', panel).onclick = () => { if (!maxChk.checked) { lastOnum = Math.max(1, Math.floor(+onumEl.value || 1) - 1); syncOnumVis(); } };
    $('#rh-onum-inc', panel).onclick = () => { if (!maxChk.checked) { lastOnum = Math.min(50, Math.floor(+onumEl.value || 1) + 1); syncOnumVis(); } };
    maxChk.onchange = () => { syncOnumVis(); toast(maxChk.checked ? '⚡ 当前可用最多：每轮发布计划里的全部单子（发到没鱼）' : '已恢复手动张数'); };
    syncOnumVis();
    bindNum('#rh-drop', (el) => { CFG.maxMapDrop = Math.max(0, Math.floor(+el.value || 0)); });
    bindNum('#rh-unlist', (el) => { CFG.unlistFirst = el.checked; });
    bindNum('#rh-wanttype', (el) => { CFG.wantType = el.value; });
    bindNum('#rh-wantqty', (el) => { CFG.wantQtyMode = el.value; });
    bindNum('#rh-wantfixed', (el) => { CFG.wantQtyFixed = Math.max(1, +el.value || 1); });
    bindNum('#rh-providetype', (el) => { CFG.provideType = el.value; });
    bindNum('#rh-provideqty', (el) => { CFG.provideQtyMode = el.value; });
    bindNum('#rh-providefixed', (el) => { CFG.provideQtyFixed = Math.max(1, +el.value || 1); });

    // 「固定数量」输入框只在数量模式选「固定」时显示；按缺口/按多余的数量由游戏数据决定，输入框无意义
    const syncQtyVis = () => {
      const wq = $('#rh-wantqty', panel), pq = $('#rh-provideqty', panel);
      const wf = $('#rh-wantfixed', panel), pf = $('#rh-providefixed', panel);
      if (wq && wf) wf.style.display = wq.value === 'fixed' ? '' : 'none';
      if (pq && pf) pf.style.display = pq.value === 'fixed' ? '' : 'none';
    };
    $('#rh-wantqty', panel).onchange = (e) => { CFG.wantQtyMode = e.target.value; syncQtyVis(); };
    $('#rh-provideqty', panel).onchange = (e) => { CFG.provideQtyMode = e.target.value; syncQtyVis(); };
    syncQtyVis();

    // 计划预览：默认收起，点标题开合；只有点「生成预览」才会自动展开（发布流程只刷新内容）
    $('#rh-prevhead', panel).onclick = () => setPreviewOpen(!previewOpen);
    // 自动循环设置：默认隐藏，勾选才展开
    $('#rh-loopset', panel).onchange = (e) => { $('#rh-loopcard', panel).style.display = e.target.checked ? '' : 'none'; };

    log('面板就绪（v1.0 多稀有度）。点「生成预览」查看跨图组单，或直接「开始」。');
  }

  function renderSummary() {
    if (!inventoryLoaded) { $('#rh-summary').textContent = '尚未加载背包，点「刷新背包」。'; return; }
    const tradable = inventory.filter(f => ['mythic','exotic','arcane'].includes(f.rarity));
    const bindN = tradable.filter(f => f.isLocked).length;
    const totalQ = tradable.reduce((s, f) => s + (f.quantity || 0), 0);
    $('#rh-summary').innerHTML =
      `背包：<b>${tradable.length}</b> 种可交易鱼 / <b>${totalQ.toLocaleString()}</b> 条 · ` +
      `绑定 <b>${bindN}</b> · 非绑定 <b>${tradable.length - bindN}</b> · ` +
      `当前循环间隔 <b>${CFG.loopIntervalMin}</b> 分钟`;
  }

  // 计划预览折叠状态：默认收起；只有点「生成预览」会自动展开，发布流程只更新内容不展开
  let previewOpen = false;
  function setPreviewOpen(open) {
    previewOpen = open;
    const body = $('#rh-prevbody'), arrow = $('#rh-prevarrow');
    if (body) body.style.display = open ? '' : 'none';
    if (arrow) arrow.textContent = open ? '▼' : '▶';
  }

  // 预览：仿游戏内「挂需求单」弹窗格式——左「我想要」右「我愿意提供」两栏，
  // 每行显示 [B图号] 鱼名 · 缺N/可用N · 数量框
  function renderPreview(win) {
    $('#rh-plantotal').textContent = plan.length;
    const box = $('#rh-table');
    if (!plan.length) { box.innerHTML = '<div style="color:#7f93b8;padding:4px;">暂无计划，点「生成预览」或「发布全部」自动生成。</div>'; return; }
    const winNames = new Set((win || getWindow(plan)).map(m => m.mapName));
    let html = '';
    for (const m of plan) {
      const isWin = winNames.has(m.mapName);
      const wantBs = [...new Set(m.want.map(x => x.mapB != null ? x.mapB : x.rank))].join('·');
      const giveBs = [...new Set(m.provide.map(x => x.mapB != null ? x.mapB : x.rank))].join('·');
      const line = (x, side) => {
        const b = x.mapB != null ? x.mapB : x.rank;
        const note = side === 'w'
          ? (x.shortage != null ? `专精缺${x.shortage}` : '')
          : (x.avail != null ? `可用${x.avail}` : '');
        const star = side === 'w' ? '<span class="rh-star">★</span>' : '';
        return `<div class="rh-line">${star}<span class="rh-btag">B${b}</span><span class="rh-fname" title="${esc(x.name)}">${esc(x.name)}</span><span class="rh-note">${note}</span><span class="rh-qty">×${x.qty}</span></div>`;
      };
      html += `<div class="rh-order ${isWin ? 'rh-win' : ''}">
        <div class="rh-order-head">${isWin ? '🎯' : ''} ${esc(m.mapName)}
          <span class="rh-cap">收 B${wantBs} ↓</span><span class="rh-cap">给 ≤ B${m.maxGive}</span><span class="rh-cap" style="color:#7fd0a8">给 B${giveBs}</span>${m.relaxed ? '<span class="rh-cap" style="color:#ff9d9d">⚠梯度破例</span>' : ''}
        </div>
        <div class="rh-order-cols">
          <div class="rh-ocol"><div class="rh-ocol-title" style="color:#7fd0a8">我想要（专精目标优先）</div>${m.want.map(x => line(x, 'w')).join('')}</div>
          <div class="rh-ocol"><div class="rh-ocol-title" style="color:#f0b17f">我愿意提供</div>${m.provide.map(x => line(x, 'p')).join('')}</div>
        </div>
      </div>`;
    }
    box.innerHTML = html;
  }

  function log(msg) {
    const l = $('#rh-log'); if (!l) return;
    const d = document.createElement('div'); d.textContent = '· ' + msg; l.appendChild(d);
    while (l.children.length > 200) l.removeChild(l.firstChild);
    l.scrollTop = l.scrollHeight;
  }

  // ---------------- 启动 ----------------
  function init() {
    buildPanel();
    // 若刚由本脚本从其它页跳到发布交换页：落地后自动续跑之前点的操作
    let pending = null;
    try { pending = sessionStorage.getItem('rh_pending'); } catch (e) {}
    if (pending) {
      try { sessionStorage.removeItem('rh_pending'); } catch (e) {}
      // 等页面/表单 DOM 稳定后再续跑；不走 startRun 变量（它在 buildPanel 闭包内，init 作用域不可见），
      // 直接把真实「生成预览 / 开始」按钮的 DOM click 打下去，与用户手点路径完全一致。
      setTimeout(() => {
        const p = $('#reelax-helper-panel');
        if (!p) return;
        if (pending === 'preview') {
          $('#rh-preview', p).click();
        } else {
          $('#rh-loopset', p).checked = (pending === 'start-loop'); // 恢复原点击的循环意图
          $('#rh-puball', p).click();
        }
      }, 1200);
    }
    loadInventory(false).then(renderSummary);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  // 调试/高级调整钩子：控制台可执行 window.__rhDebug.CFG.maxMaps = 2 等
  window.__rhDebug = { CFG, getPlan: () => plan };
})();

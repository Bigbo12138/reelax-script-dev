// ==UserScript==
// @name         Reelax 装备初始价显示
// @namespace    reelax-gear-base-price
// @version      1.0.0
// @description  在装备市场的每张装备卡片上，显示该装备的"初始价"（售价 - 强化累计花费）。
//               负数用红色。仅覆盖 legendary / mythic / exotic / arcane 四档。
// @match        https://reelax.cn/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  if (window.__reelaxGearBasePrice__) return;
  window.__reelaxGearBasePrice__ = true;

  // ---------- 强化价格表（单位：金） ----------
  const UPGRADE_COST = {
    legendary: {
      0: 0, 1: 350000, 2: 612500, 3: 1071875, 4: 1875781, 5: 3282617,
      6: 5744580, 7: 10053015, 8: 17592776, 9: 30787359, 10: 53877878,
    },
    mythic: {
      0: 0, 1: 612500, 2: 1071875, 3: 1875781, 4: 3282617, 5: 5744580,
      6: 10053015, 7: 17592776, 8: 30787359, 9: 53877878, 10: 94286286,
    },
    exotic: {
      0: 0, 1: 1225000, 2: 2143750, 3: 3751563, 4: 6565234, 5: 11489160,
      6: 20106030, 7: 35185553, 8: 61574718, 9: 107755756, 10: 188572573,
    },
    arcane: {
      0: 0, 1: 2450000, 2: 4287500, 3: 7503125, 4: 13130469, 5: 22978320,
      6: 40212061, 7: 70371106, 8: 123149435, 9: 215511512, 10: 377145146,
    },
  };

  // ---------- 稀有度映射 ----------
  const RARITY_CN = {
    legendary: '传说', mythic: '神话', exotic: '奇异', arcane: '奥秘',
  };
  const RARITY_CN_SET = new Set(Object.values(RARITY_CN));
  const RARITY_KEYS = Object.keys(RARITY_CN);
  const CN_TO_RARITY = {};
  for (const [k, v] of Object.entries(RARITY_CN)) CN_TO_RARITY[v] = k;

  // ---------- 工具 ----------
  const ATTRS = new Set(['力量', '智力', '运气', '耐力']);
  const UPGRADE_RE = /\+(\d+)\s*$/;

  // 是否在装备市场页（https://reelax.cn/market）。仅在 market 页才拉数据与渲染。
  function isMarketPage() {
    const p = (window.location.pathname || '').replace(/\/+$/, '');
    return p === '/market' || /^\/market(\/|$)/.test(p);
  }

  function fmtGold(n) {
    if (n == null || !Number.isFinite(n)) return '—';
    const s = Math.abs(Math.round(n)).toLocaleString('en-US');
    return (n < 0 ? '-' : '') + s;
  }

  function sumUpgradeCost(rarity, level) {
    const table = UPGRADE_COST[rarity];
    if (!table) return { total: null, incomplete: true };
    let total = 0, incomplete = false;
    for (let i = 1; i <= level; i++) {
      const c = table[i];
      if (c == null || c < 0) { incomplete = true; continue; }
      total += c;
    }
    return { total, incomplete };
  }

  // ---------- 读装备卡片上的四维数值（参考 装备属性占比.js 的 valueTarget） ----------
  // 返回 { luck, strength, endurance, intelligence }，某个读不到则缺键（缺键=0 参与指纹，尽力精确）
  // 数值解析：参考 装备属性占比.js 的 valueTarget/parseValue ——
  //   同行 <b>/strong 优先、其次相邻兄弟、再次行内其它元素，且止于容器边界；
  //   排除脚本自己加的 .arc-gear-baseprice 标签。
  const ATTR_KEYS = { '力量': 'strength', '智力': 'intelligence', '运气': 'luck', '耐力': 'endurance' };
  const numRe = /^[+＋\-－]?\s*[\d,]+$/;
  function parseNum(s) {
    if (!s || !numRe.test(s.trim())) return null;
    const v = Number(s.trim().replace(/[+＋\-－\s,]/g, ''));
    return Number.isFinite(v) ? v : null;
  }
  function valueTarget(label, container) {
    let row = label;
    for (let depth = 0; row && row !== container && depth < 4; depth++, row = row.parentElement) {
      const labels = [];
      const w = document.createTreeWalker(row, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          if (node.parentElement && node.parentElement.closest('.arc-gear-baseprice')) return NodeFilter.FILTER_REJECT;
          if (node.parentElement && node.parentElement.closest('.stat-comparison')) return NodeFilter.FILTER_REJECT;
          return ATTRS.has(node.nodeValue.trim()) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        }
      });
      while (w.nextNode()) labels.push(w.currentNode.parentElement);
      if (labels.length !== 1) continue; // 行里只能有一个属性标签，否则跳过（对齐占比.js）
      for (const cand of [
        row.querySelector(':scope > b, :scope > strong'),
        label.nextElementSibling,
      ]) {
        if (cand && !cand.closest('.arc-gear-baseprice')) {
          const p = parseNum(cand.textContent.trim());
          if (p != null) return p;
        }
      }
      for (const el of Array.from(row.children)) {
        if (el === label || /^(svg|path)$/i.test(el.tagName)) continue;
        const p = parseNum(el.textContent.trim());
        if (p != null) return p;
      }
    }
    return null;
  }
  function readCardStats(card) {
    const result = {};
    const w = document.createTreeWalker(card, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (node.parentElement && node.parentElement.closest('.arc-gear-baseprice')) return NodeFilter.FILTER_REJECT;
        if (node.parentElement && node.parentElement.closest('.stat-comparison')) return NodeFilter.FILTER_REJECT;
        return ATTRS.has(node.nodeValue.trim()) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    });
    const labelEls = [];
    while (w.nextNode()) labelEls.push(w.currentNode.parentElement);
    for (const label of labelEls) {
      const key = ATTR_KEYS[label.textContent.trim()];
      if (!key) continue;
      const value = valueTarget(label, card);
      result[key] = value;
    }
    return result;
  }

  // ---------- 收集元素内所有文本（去重、trim、过滤空） ----------
  function collectTexts(el, skipSelector) {
    const result = [];
    if (!el) return result;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (skipSelector && node.parentElement && node.parentElement.closest(skipSelector)) return NodeFilter.FILTER_REJECT;
        const t = node.nodeValue.trim();
        return t ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    });
    const seen = new Set();
    let n;
    while ((n = walker.nextNode())) {
      const t = n.nodeValue.trim();
      if (!seen.has(t)) { seen.add(t); result.push(t); }
    }
    return result;
  }

  // ---------- 从某元素向上找"装备市场卡片容器"： ----------
  // 市场卡片不展示四维标签（实测 scan 找不到），因此改按市场页特征定位——
  // 同时满足"出现一个稀有度中文词" + "出现一个 ≥10万 的大数字"的最近祖先。
  // 金币余额/页头通常不同时含稀有度词，可避免误判。
  function findCardContainer(startEl) {
    let node = startEl;
    for (let depth = 0; node && depth < 12; depth++, node = node.parentElement) {
      const texts = collectTexts(node, '.arc-gear-baseprice');
      const hasRarity = texts.some((t) => RARITY_CN_SET.has(t));
      const hasBigNumber = texts.some((t) => {
        if (!/[\d,]{4,}/.test(t)) return false;
        if (/^\d+(\.\d+)?%$/.test(t)) return false;
        if (/^[+＋\-－]/.test(t)) return false;
        const num = parseInt(t.replace(/[,\s]/g, ''), 10);
        return Number.isFinite(num) && num >= 100000;
      });
      if (hasRarity && hasBigNumber) return node;
    }
    return null;
  }

  // ---------- 从卡片容器提取装备信息 ----------
  function extractGearInfo(card) {
    if (!card) return null;
    const texts = collectTexts(card, '.arc-gear-baseprice');

    // 1. 稀有度：优先从 [data-rarity] 属性取，fallback 到中文文本
    let rarity = null, rarityEl = null;
    const rarityLabel = card.querySelector('[data-rarity]');
    if (rarityLabel) {
      const r = rarityLabel.getAttribute('data-rarity');
      if (r && RARITY_KEYS.includes(r)) { rarity = r; rarityEl = rarityLabel; }
    }
    if (!rarity) {
      const wR = document.createTreeWalker(card, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          if (node.parentElement && node.parentElement.closest('.arc-gear-baseprice')) return NodeFilter.FILTER_REJECT;
          const t = node.nodeValue.trim();
          return RARITY_CN_SET.has(t) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        }
      });
      const rn = wR.nextNode();
      if (rn) { rarity = CN_TO_RARITY[rn.nodeValue.trim()]; rarityEl = rn.parentElement; }
    }

    // 2. 强化等级：优先从 <h2 class="rarity-text">装备名 <small>+N</small></h2> 提取
    //    fallback：遍历所有 <small> 标签匹配 /\+(\d+)/，取 N∈[0,10]
    let upgradeLevel = 0, upgradeEl = null;
    const h2 = card.querySelector('h2.rarity-text');
    if (h2) {
      const small = h2.querySelector('small');
      if (small) {
        const m = small.textContent.trim().match(/\+(\d+)/);
        if (m) {
          const lv = parseInt(m[1], 10);
          if (lv >= 0 && lv <= 10) { upgradeLevel = lv; upgradeEl = small; }
        }
      }
    }
    if (upgradeLevel === 0 && !upgradeEl) {
      // fallback: 找所有 <small> 或含 +N 的文本节点
      const wU = document.createTreeWalker(card, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          if (node.parentElement && node.parentElement.closest('.arc-gear-baseprice')) return NodeFilter.FILTER_REJECT;
          const t = node.nodeValue.trim();
          return /\+\d+/.test(t) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        }
      });
      let un;
      while ((un = wU.nextNode())) {
        const parent = un.parentElement;
        // 排除属性行
        const parentAttrs = collectTexts(parent, '.arc-gear-baseprice').filter((x) => ATTRS.has(x));
        if (parentAttrs.length > 0) continue;
        const m = un.nodeValue.trim().match(/\+(\d+)/);
        if (m) {
          const lv = parseInt(m[1], 10);
          if (lv >= 0 && lv <= 10) { upgradeLevel = lv; upgradeEl = parent; break; }
        }
      }
    }

    // 3. 售价：找卡片里"最像在售价格数字"的那个文本（排除百分比/属性值/±/小数/强化等级）。
    //    改良：售价几乎都带千位分隔符(如 1,234,567)，而属性/词条值不带，所以优先取"带 `,` 的最大整数"；
    //    无带 `,` 数字时再回退取卡内最大整数。
    let sellPrice = null, priceEl = null;
    const priceCandidates = [];
    const wP = document.createTreeWalker(card, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (node.parentElement && node.parentElement.closest('.arc-gear-baseprice')) return NodeFilter.FILTER_REJECT;
        if (node.parentElement && node.parentElement.closest('.resource-balance')) return NodeFilter.FILTER_REJECT;
        if (node.parentElement && node.parentElement.closest('.resource-panel, [class*="balance-panel"]')) return NodeFilter.FILTER_REJECT;
        const t = node.nodeValue.trim();
        if (!/[\d,]{3,}/.test(t)) return NodeFilter.FILTER_REJECT;
        if (/^\d+(\.\d+)?%$/.test(t)) return NodeFilter.FILTER_REJECT;
        if (/^[+＋\-－]\s*[\d,]+/.test(t)) return NodeFilter.FILTER_REJECT;
        if (/^\d+\.\d+$/.test(t)) return NodeFilter.FILTER_REJECT; // 排除百分比小数
        const num = parseInt(t.replace(/[,\s]/g, ''), 10);
        if (!Number.isFinite(num) || num < 100000) return NodeFilter.FILTER_REJECT;
        priceCandidates.push({ node, num, hasComma: t.includes(',') });
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    while (wP.nextNode()) {}
    if (priceCandidates.length) {
      const withComma = priceCandidates.filter((c) => c.hasComma);
      const pool = withComma.length ? withComma : priceCandidates;
      pool.sort((a, b) => b.num - a.num);
      const best = pool[0];
      sellPrice = best.num;
      priceEl = best.node.parentElement;
    }

    // 3.5 装备名：从 h2.rarity-text 取第一个文本节点（排除 small 的 +N 强化等级），用于订单指纹匹配
    let name = '';
    if (h2) {
      const cn = Array.from(h2.childNodes).find((n) => n.nodeType === Node.TEXT_NODE && n.nodeValue.trim());
      if (cn) name = cn.nodeValue.trim();
    }

    // 3.6 四维数值（参考 装备属性占比.js）：用于精确匹配"这一件"同名同稀有同强化的装备
    const stats = readCardStats(card);

    return { rarity, rarityEl, upgradeLevel, upgradeEl, sellPrice, priceEl, name, nameEl: h2, stats };
  }

  // ---------- 渲染单张卡片 ----------
  function renderCard(card) {
    const info = extractGearInfo(card);
    if (!info || !info.rarity) return;
    if (!RARITY_KEYS.includes(info.rarity)) return;
    if (!info.nameEl || !info.name) return;
    const sellPrice = info.sellPrice;
    if (sellPrice == null) return;
    const { total: upgradeTotal, incomplete } = sumUpgradeCost(info.rarity, info.upgradeLevel);
    if (upgradeTotal == null) return;

    const basePrice = sellPrice - upgradeTotal;
    const signature = `${info.rarity}|${info.upgradeLevel}|${sellPrice}|${upgradeTotal}`;
    if (card.dataset.arcGearBasepriceSignature === signature) return;

    card.dataset.arcGearBasepriceSignature = signature;
    card.querySelectorAll('.arc-gear-baseprice').forEach((el) => el.remove());

    const label = document.createElement('span');
    label.className = 'arc-gear-baseprice';
    const isNeg = basePrice < 0;
    label.textContent = fmtGold(basePrice);
    // 字体/字号和售价保持一致：复制售价元素(priceEl/<strong>)的计算样式。
    if (info.priceEl) {
      const cs = (typeof getComputedStyle === 'function') ? getComputedStyle(info.priceEl) : null;
      if (cs) {
        label.style.setProperty('font-size', cs.fontSize, 'important');
        label.style.setProperty('font-weight', cs.fontWeight, 'important');
        label.style.setProperty('font-family', cs.fontFamily, 'important');
      }
    }
    if (isNeg) {
      label.style.setProperty('color', '#ff4444', 'important');
      label.style.setProperty('-webkit-text-fill-color', '#ff4444', 'important');
    } else {
      label.style.setProperty('color', '#2d8a4e', 'important');
      label.style.setProperty('-webkit-text-fill-color', '#2d8a4e', 'important');
    }
    if (incomplete) label.title = `强化表不全: rarity=${info.rarity} level=${info.upgradeLevel}，仅供参考`;
    else label.title = `强化累计 ${fmtGold(upgradeTotal)}`;

    // 方案：把 footer 改成 2 列 grid。
    //   · 标签 grid-column:1/-1 → 独占首行（在售价上方）
    //   · 售价与购买按钮自动依序落到第 2 行 [售价][购买] → 按钮在售价右边、同一行
    // 关键：不搬动/移除任何原节点（只在 footer 上加 grid 样式 + 新增标签），因此不会串价、
    // 售价/按钮都是原 DOM 节点原位参与 grid 排版。拿不到 footer 才退回售价/装备名。
    const footer = card.querySelector('.market-gear-card-footer') || card.querySelector('footer');
    if (footer && info.priceEl) {
      footer.style.setProperty('display', 'grid', 'important');
      footer.style.setProperty('grid-template-columns', '1fr auto', 'important');
      footer.style.setProperty('align-items', 'center', 'important');
      footer.style.setProperty('column-gap', '8px', 'important');
      footer.style.setProperty('row-gap', '0', 'important');
      label.style.setProperty('grid-column', '1 / -1', 'important');
      info.priceEl.insertAdjacentElement('beforebegin', label);
    } else {
      const anchor = footer || info.nameEl;
      if (anchor) anchor.insertAdjacentElement('beforebegin', label);
      else card.appendChild(label);
    }
  }

  // ---------- 扫描 ----------
  function scan(root) {
    if (!root) return;
    if (!isMarketPage()) return; // 仅 market 页处理
    // 找所有稀有度中文词文本节点 → 向上走到卡片容器（市场卡片以稀有度词为特征起点）。
    const seedEls = [];
    if (root.nodeType === Node.ELEMENT_NODE || root.nodeType === Node.DOCUMENT_NODE) {
      const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          if (node.parentElement && node.parentElement.closest('.arc-gear-baseprice')) return NodeFilter.FILTER_REJECT;
          return RARITY_CN_SET.has(node.nodeValue.trim()) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        }
      });
      let n;
      while ((n = w.nextNode())) seedEls.push(n.parentElement);
    } else if (root.nodeType === Node.TEXT_NODE && RARITY_CN_SET.has(root.nodeValue.trim())) {
      seedEls.push(root.parentElement);
    }

    const cards = new Set();
    for (const seed of seedEls) {
      const card = findCardContainer(seed);
      if (card) cards.add(card);
    }
    // 增量渲染：signature 没变就跳过，变了才更新
    cards.forEach(renderCard);

    // 清理：仅移除「已脱离文档」的卡片上的标签。
    // 不再用「本次 cards 集合没覆盖」判孤立——列表/懒加载时 scope 常只覆盖部分卡片，
    // 用引用不属于本次集合会把仍在页面上的卡片误删导致「突然消失」。
    if (root.querySelectorAll) {
      root.querySelectorAll('[data-arc-gear-baseprice-signature]').forEach((el) => {
        if (!el.isConnected) {
          el.querySelectorAll('.arc-gear-baseprice').forEach((t) => t.remove());
          delete el.dataset.arcGearBasepriceSignature;
        }
      });
    }
  }

  // ---------- 批量刷新（100ms 合并） ----------
  let timer = null;
  let roots = new Set();
  function flush() {
    timer = null;
    const scopes = [...roots];
    roots.clear();
    scopes.forEach(scan);
  }
  function refreshScope(root) {
    if (root && root.nodeType === Node.TEXT_NODE) root = root.parentElement;
    if (root && root.nodeType !== Node.ELEMENT_NODE) return root;
    if (root) {
      const known = root.closest('[data-arc-gear-baseprice-signature]');
      if (known) return known;
      return root.closest('.market-page, .gear-market, .gear-page, [class*="market"]') || root;
    }
    return root;
  }
  function queue(root) {
    if (!isMarketPage()) return; // 非 market 页不排队渲染
    root = refreshScope(root);
    if (root && (root.nodeType === Node.ELEMENT_NODE || root.nodeType === Node.DOCUMENT_NODE)) roots.add(root);
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, 100);
  }

  // ---------- 启动 ----------
  let observer = null;
  function start() {
    if (observer) return;
    let style = document.getElementById('arc-gear-baseprice-style');
    if (!style) {
      style = document.createElement('style');
      style.id = 'arc-gear-baseprice-style';
      style.textContent = [
        '.arc-gear-baseprice{',
        '  display:inline-block;',
        '  text-align:left;',
        '  font-size:.68em;',
        '  font-weight:700;',
        '  white-space:nowrap;',
        '  margin:0;',
        '  padding:0;',
        '  line-height:1;',
        '}',
      ].join('');
      (document.head || document.documentElement).appendChild(style);
    }
    observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'characterData') queue(mutation.target.parentElement);
        else {
          queue(mutation.target);
          for (const node of mutation.addedNodes) queue(node);
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    queue(document.body);

    // 售价走卡片 DOM，不请求任何 API。SPA 无整页刷新，用轻量轮询检测路由进出，
    // 进出 market 页时重扫渲染（不产生网络请求）。
    let lastPath = window.location.pathname;
    setInterval(() => {
      const now = window.location.pathname;
      if (now === lastPath) return;
      lastPath = now;
      if (isMarketPage() && document.body) queue(document.body);
    }, 1000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();

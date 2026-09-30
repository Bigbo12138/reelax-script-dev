// ==UserScript==
// @name         Reelax 装备属性占比显示
// @namespace    reelax-gear-percent
// @version      1.0.0
// @description  在装备详情卡片的 力量/智力/运气/耐力 数值后，显示该属性占这件装备四维属性总和的百分比（数值百分比染色）。
// @match        https://reelax.cn/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  if (window.__reelaxGearPercentDisplay__) return;
  window.__reelaxGearPercentDisplay__ = true;

  const DECIMALS = 1; // 百分比小数位（0~3）

  // ---------- 四维属性标签 ----------
  const ATTRS = new Set(['力量', '智力', '运气', '耐力']);

  // ---------- 找「属性标签」文本节点对应的元素 ----------
  function walkLabels(root) {
    const labels = [];
    if (!root) return labels;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (node.parentElement && node.parentElement.closest('.arc-gear-stat-percent')) return NodeFilter.FILTER_REJECT;
        if (node.parentElement && node.parentElement.closest('.stat-comparison')) return NodeFilter.FILTER_REJECT;
        return ATTRS.has(node.nodeValue.trim()) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    });
    while (walker.nextNode()) labels.push(walker.currentNode.parentElement);
    return labels;
  }

  // ---------- 从标签向上找「装备容器」：含 2~4 个不重复四维标签的最近祖先 ----------
  function containerFor(label) {
    let node = label;
    for (let depth = 0; node && depth < 7; depth++, node = node.parentElement) {
      const names = walkLabels(node).map((el) => el.textContent.trim()).filter((x) => ATTRS.has(x));
      if (names.length >= 2 && names.length <= 4 && new Set(names).size === names.length) return node;
    }
    return null;
  }

  // ---------- 取某属性对应的「数值元素」 ----------
  function parseValue(el) {
    if (!el || el.closest('.arc-gear-stat-percent')) return null;
    const text = el.textContent.trim();
    if (!/^[+＋\-－]?\s*[\d,]+$/.test(text)) return null;
    const value = Number(text.replace(/[+＋\-－\s,]/g, ''));
    return Number.isFinite(value) ? { el, value } : null;
  }
  function valueTarget(label, container) {
    let row = label;
    for (let depth = 0; row && row !== container && depth < 4; depth++, row = row.parentElement) {
      const labels = walkLabels(row);
      if (labels.length !== 1) continue;
      const rerolled = parseValue(row.querySelector(':scope > b'));
      if (rerolled) return rerolled;
      const adjacent = parseValue(label.nextElementSibling);
      if (adjacent) return adjacent;
      for (const el of row.children) {
        if (el === label || el.tagName === 'SVG') continue;
        const parsed = parseValue(el);
        if (parsed) return parsed;
      }
    }
    return null;
  }

  // ---------- 百分比 → 颜色渐变（低蓝→中青→高红粉） ----------
  function percentColor(percent) {
    const t = Math.min(1, Math.max(0, percent / 100));
    const m = (from, to) => Math.round(from + (to - from) * t);
    return `rgb(${m(176, 255)}, ${m(176, 215)}, ${m(176, 0)})`;
  }

  // ---------- 渲染单个容器（装备卡片） ----------
  function renderContainer(container) {
    const rows = [];
    for (const label of walkLabels(container)) {
      const name = label.textContent.trim();
      const target = valueTarget(label, container);
      if (target && Number.isFinite(target.value)) rows.push({ name, ...target });
    }
    if (rows.length < 2 || new Set(rows.map((r) => r.name)).size !== rows.length) return;
    const total = rows.reduce((sum, row) => sum + Math.max(0, row.value), 0);
    if (total <= 0) return;
    const signature = `${DECIMALS}|${rows.map((r) => `${r.name}:${r.value}`).join('|')}`;
    if (container.dataset.arcGearPercentSignature === signature) return;
    container.dataset.arcGearPercentSignature = signature;
    container.querySelectorAll('.arc-gear-stat-percent').forEach((el) => el.remove());
    for (const row of rows) {
      const percent = row.value / total * 100;
      const badge = document.createElement('span');
      badge.className = 'arc-gear-stat-percent';
      badge.textContent = `${percent.toFixed(DECIMALS)}%`;
      badge.style.color = percentColor(percent);
      badge.title = `${row.name}占这件装备四维属性总和的${percent.toFixed(1)}%`;
      row.el.insertAdjacentElement('afterend', badge);
    }
  }

  // ---------- 扫描一段根节点下的所有装备容器 ----------
  function scan(root) {
    if (!root) return;
    if (root.matches && root.matches('.stat-comparison')) {
      root.querySelectorAll('.arc-gear-stat-percent').forEach((el) => el.remove());
      delete root.dataset.arcGearPercentSignature;
      return;
    }
    if (root.querySelectorAll) {
      root.querySelectorAll('.stat-comparison .arc-gear-stat-percent').forEach((el) => el.remove());
      root.querySelectorAll('.stat-comparison[data-arc-gear-percent-signature]').forEach((el) => delete el.dataset.arcGearPercentSignature);
    }
    const containers = new Set();
    for (const label of walkLabels(root)) {
      const container = containerFor(label);
      if (container) containers.add(container);
    }
    containers.forEach(renderContainer);
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
      const known = root.closest('.stat-comparison, .gear-slot-stats');
      if (known) return known;
      let node = root;
      for (let depth = 0; node && depth < 9; depth++, node = node.parentElement) {
        const names = walkLabels(node).map((el) => el.textContent.trim()).filter((x) => ATTRS.has(x));
        if (names.length >= 2 && names.length <= 4 && new Set(names).size === names.length) return node;
      }
      return root.closest('.gear-workshop, .gear-page') || root;
    }
    return root;
  }
  function queue(root) {
    root = refreshScope(root);
    if (root && (root.nodeType === Node.ELEMENT_NODE || root.nodeType === Node.DOCUMENT_NODE)) roots.add(root);
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, 100);
  }
  function forceRefresh(scope) {
    if (!observer || !scope || !scope.isConnected) return;
    scope.querySelectorAll('[data-arc-gear-percent-signature]').forEach((el) => delete el.dataset.arcGearPercentSignature);
    queue(scope);
  }

  // ---------- 启动/停止 ----------
  let observer = null;
  function start() {
    if (observer) return;
    let style = document.getElementById('arc-gear-percent-style');
    if (!style) {
      style = document.createElement('style');
      style.id = 'arc-gear-percent-style';
      style.textContent = '.arc-gear-stat-percent{display:inline-block;margin-left:5px;font-size:.82em;font-weight:700;white-space:nowrap;}';
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
    document.addEventListener('click', (event) => {
      const button = event.target.closest('button');
      if (!button || !/重铸/.test(button.textContent || '')) return;
      const scope = button.closest('.gear-workshop, .gear-page') || document.body;
      [0, 180, 700, 1600].forEach((delay) => setTimeout(() => forceRefresh(scope), delay));
    }, true);
    queue(document.body);
  }
  function stop() {
    if (observer) observer.disconnect();
    observer = null;
    if (timer) clearTimeout(timer);
    timer = null;
    roots.clear();
    document.querySelectorAll('.arc-gear-stat-percent').forEach((el) => el.remove());
    document.querySelectorAll('[data-arc-gear-percent-signature]').forEach((el) => delete el.dataset.arcGearPercentSignature);
  }

  // 页面就绪后启动
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
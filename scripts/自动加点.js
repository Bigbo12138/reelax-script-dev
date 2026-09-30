// ==UserScript==
// @name         Reelax 自动加点
// @namespace    reelax-auto-stat
// @version      1.0.0
// @description  检测到待分配属性点（导航红点），自动去属性页给 运气 加 1 点，再回钓鱼页
// @match        https://reelax.cn/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  const BASE = 'https://reelax.cn';
  const STATS = '/stats';
  const FISHING = '/fishing';

  // 调试模式：URL 带 ?fast 或 ?dev 时，检查间隔缩短为 15 秒；默认每 10 分钟检测一次
  const FAST = /[?&](fast|dev)\b/.test(location.search);
  const INTERVAL_MS = FAST ? 15000 : 10 * 60 * 1000;

  const POLL_MS = 500;            // 轮询按钮的间隔
  const CLICK_TIMEOUT_MS = 15000; // 单个步骤最长等待
  const AFTER_ALLOCATE_MS = 1500; // 分配后等待请求完成再切回

  const TAG = '[Reelax 自动加点]';

  // 防止同一页面被重复执行（扩展可能多次注入）
  if (window.__reelaxAutoStat__) {
    console.log(TAG, '已运行，跳过重复注入');
    return;
  }
  window.__reelaxAutoStat__ = true;

  // 分配方案：属性名 -> 点数
  // 力量（注释掉即为停用，需要时取消注释即可）
  // const ALLOCATIONS = { 力量: 1, 运气: 1 };
  const ALLOCATIONS = { 运气: 2 };

  let allocating = false; // 分配中标记，防止主循环重复触发
  let waiting = false;    // 等待属性页渲染标记，防止重复触发 waitForStatsReady 链

  function currentPage() {
    const p = location.pathname.replace(/\/+$/, '');
    if (p === STATS) return 'stats';
    if (p === FISHING || p.startsWith(FISHING + '/')) return 'fishing';
    return 'other';
  }

  // 站内点击导航（SPA，不刷新页面），点击失败才回退硬跳转
  function spaNavigate(path) {
    const clean = path.replace(/\?.*$/, '');
    if (location.pathname.replace(/\/+$/, '') === clean) return; // 已经在目标页
    const link = document.querySelector('a[href="' + clean + '"]');
    if (link) {
      console.log(TAG, 'SPA 导航到', clean);
      link.click();
      // 兜底：2 秒后仍未跳转（链接失效/被拦截），改硬跳转
      setTimeout(() => {
        if (location.pathname.replace(/\/+$/, '') !== clean) {
          console.log(TAG, 'SPA 导航未生效，回退硬跳转', clean);
          location.href = BASE + clean;
        }
      }, 2000);
      return;
    }
    console.log(TAG, '未找到导航链接，回退硬跳转', clean);
    location.href = BASE + clean;
  }

  // 从任意文本中提取数字（找不到返回 0）
  function extractNumber(text) {
    const m = String(text || '').replace(/[^\d]/g, '');
    return m ? parseInt(m, 10) : 0;
  }

  // 读取当前“待分配点数”的真实数值：优先属性页上的“分配 N 点”按钮里的 N，其次导航红点数字
  function getPendingPointCount() {
    const btns = Array.from(document.querySelectorAll('button, input[type="button"], [role="button"]'))
      .filter((el) => /分配/.test(el.textContent || el.value || el.getAttribute('aria-label') || ''));
    for (const b of btns) {
      const n = extractNumber(b.textContent || b.value || b.getAttribute('aria-label') || '');
      if (n > 0) return n;
    }
    const dot = document.querySelector('a.nav-item[href="' + STATS + '"] .notification-dot');
    if (dot) {
      const n = extractNumber(dot.textContent);
      return n > 0 ? n : 1; // 有红点但无数字，视作有待分配
    }
    return 0;
  }

  // 是否有待分配点数：
  // 1) 属性导航项上出现通知红点（.notification-dot）
  // 2) 属性页上存在“分配 N 点”且 N >= 1 的按钮
  function hasPendingPoints() {
    if (currentPage() === 'stats') return getPendingPointCount() > 0;
    // 非属性页只能通过导航红点判断
    const dot = document.querySelector('a.nav-item[href="' + STATS + '"] .notification-dot');
    if (dot) {
      const n = extractNumber(dot.textContent);
      return n > 0 ? true : true; // 有红点即视为有待分配
    }
    return false;
  }

  // 按文字正则找按钮
  function findButton(pattern) {
    const sel = 'button, input[type="button"], [role="button"]';
    return Array.from(document.querySelectorAll(sel)).find((el) =>
      pattern.test((el.textContent || el.value || el.getAttribute('aria-label') || '').trim()),
    );
  }

  // 找确认按钮：先弹窗内找；不在弹窗时，页面上含“确认/确定”的按钮也算
  // （点击“分配 N 点”后，按钮可能原地变成“确认分配 N 点”之类的形态）
  function findConfirmButton() {
    const modal = document.querySelector(
      '[role="dialog"], .modal, .dialog, [class*="modal"], [class*="dialog"], [class*="confirm"]',
    );
    if (modal) {
      const b = Array.from(modal.querySelectorAll('button, [role="button"]')).find((el) =>
        /确认|确定|Confirm|OK/.test((el.textContent || el.getAttribute('aria-label') || '').trim()),
      );
      if (b) return b;
    }
    return Array.from(document.querySelectorAll('button, [role="button"]')).find((el) =>
      /确认|确定/.test((el.textContent || el.getAttribute('aria-label') || '').trim()),
    );
  }

  // 轮询直到 finder() 找到（且可用）并点击；成功或超时后回调 onDone(ok)
  function clickWhenReady(finder, label, onDone, timeoutMs) {
    const limit = timeoutMs || CLICK_TIMEOUT_MS;
    let waited = 0;
    const timer = setInterval(() => {
      waited += POLL_MS;
      const btn = finder();
      if (btn && !btn.disabled) {
        console.log(TAG, '点击：', label);
        btn.click();
        clearInterval(timer);
        onDone(true);
        return;
      }
      if (waited >= limit) {
        console.warn(TAG, '超时未找到按钮：', label);
        clearInterval(timer);
        onDone(false);
      }
    }, POLL_MS);
  }

  // 等待属性卡片渲染出来（页面异步加载）
  function waitForStatsReady(onReady) {
    let waited = 0;
    const timer = setInterval(() => {
      if (document.querySelectorAll('.stat-allocation').length > 0) {
        clearInterval(timer);
        console.log(TAG, '属性卡片已渲染，等待 ' + waited + 'ms');
        onReady();
        return;
      }
      waited += 300;
      if (waited >= 10000) {
        console.warn(TAG, '等待 10s 属性卡片未出现，继续');
        clearInterval(timer);
        onReady();
      }
    }, 300);
  }

  // 设置某个属性的分配输入框（原生 setter 触发 React onChange）
  function setInput(statName, points) {
    const card = Array.from(document.querySelectorAll('.stat-allocation')).find((el) => {
      const h2 = el.querySelector('.stat-description h2');
      return h2 && h2.textContent.trim() === statName;
    });
    if (!card) {
      console.warn(TAG, '未找到属性卡片：', statName);
      return false;
    }
    const input = card.querySelector('.stat-allocation-control input[type="number"]');
    if (!input) {
      console.warn(TAG, '未找到分配输入框：', statName);
      return false;
    }
    // 用原型上的 value setter 赋值，绕过 React 对 value 的接管，确保 onChange 收到
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, String(points));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    console.log(TAG, '设置', statName, '分配 =', points, '（max=', input.max, '）');
    return true;
  }

  function goFishing() {
    console.log(TAG, '切回钓鱼页', FISHING);
    spaNavigate(FISHING);
  }

  function handleStats() {
    if (allocating) return;
    if (waiting) return;     // 已有 waitForStatsReady 链在跑，避免重复触发
    waiting = true;
    // 诊断：先等属性页 DOM 渲染完成，再判定是否有待分配点数（修复 SPA 竞态）
    console.log(TAG, '[加点诊断] 等待属性页渲染…');
    waitForStatsReady(() => {
      // 无论是否还有待分配点，结束等待都要复位 guard，避免挂死
      waiting = false;
      console.log(TAG, '[加点诊断] 待分配点数=', getPendingPointCount());
      // 诊断：属性页渲染后到底检测到了什么
      const navDot = !!document.querySelector('a.nav-item[href="' + STATS + '"] .notification-dot');
      const allocBtn = findButton(/^分配\s*[1-9]\d*\s*点/);
      console.log(
        TAG, '[加点诊断] 进入属性页 | 导航红点=', navDot,
        '| 分配按钮=', allocBtn ? JSON.stringify((allocBtn.textContent || '').trim()) : '未找到',
      );
      if (!hasPendingPoints()) {
        console.log(TAG, '属性页无待分配点数，返回钓鱼页');
        setTimeout(goFishing, 500);
        return;
      }
      allocating = true;
      console.log(TAG, '[加点诊断] 属性页就绪，有待分配点，开始分配');
      console.log(TAG, '有待分配点数，开始分配 运气 2 点');
      tryAllocate(0);
    });
  }

  // 循环分配：设输入框 → 点“分配 N 点” → 处理确认弹窗 → 轮询点数真正减少
  function tryAllocate(round, lastCount, noProgress) {
    noProgress = noProgress || 0;
    const count = getPendingPointCount();
    if (count <= 0) {
      console.log(TAG, '[加点诊断] 分配完成，无剩余待分配点数');
      allocating = false;
      setTimeout(goFishing, AFTER_ALLOCATE_MS);
      return;
    }
    if (noProgress >= 2) {
      console.warn(TAG, '连续 ' + noProgress + ' 轮分配无进展（剩余 ' + count + ' 点），放弃并回钓鱼页');
      allocating = false;
      setTimeout(goFishing, 1000);
      return;
    }
    if (round >= 30) {
      console.warn(TAG, '超过最大尝试次数，剩余 ' + count + ' 点，放弃');
      allocating = false;
      setTimeout(goFishing, 1000);
      return;
    }
    console.log(TAG, '[加点诊断] 第 ' + (round + 1) + ' 轮分配，剩余 ' + count + ' 点');
    Object.keys(ALLOCATIONS).forEach((name) => setInput(name, ALLOCATIONS[name]));
    clickWhenReady(
      () => findButton(/分配/),
      '分配按钮（第 ' + (round + 1) + ' 次）',
      (ok) => {
        if (!ok) {
          console.warn(TAG, '未找到分配按钮');
          allocating = false;
          setTimeout(goFishing, 1000);
          return;
        }
        // 处理确认弹窗：复用 findConfirmButton（全页搜索确认/确定按钮），最多等 3 秒
        clickWhenReady(
          () => findConfirmButton(),
          '确认分配按钮',
          (okConfirm) => {
            if (okConfirm) {
              console.log(TAG, '[加点诊断] 已点击确认分配按钮');
            } else {
              console.log(TAG, '[加点诊断] 未出现确认弹窗，视为点击直接生效');
            }
            // 等待点数真正减少（异步请求），最多等 4 秒
            let waited = 0;
            const probe = setInterval(() => {
              waited += 400;
              const now = getPendingPointCount();
              if (now < count || now <= 0) {
                clearInterval(probe);
                setTimeout(() => tryAllocate(round + 1, count, 0), 400);
              } else if (waited >= 4000) {
                clearInterval(probe);
                setTimeout(() => tryAllocate(round + 1, count, noProgress + 1), 400);
              }
            }, 400);
          },
          3000,
        );
      },
    );
  }

  // 每次触发的入口：进入属性页立即分配；只在钓鱼页且有待分配点时才主动去属性页。
  // 闸在"只在钓鱼页"：1 秒 SPA 监听会捕捉到所有路径变化（包括自动出售切到库存页、
  // 手动点进市场页等），若此时有红点就跳 /stats，会把这些流程劫持顶掉。
  // 限定只从钓鱼页出发后，出售在库存页忙碌 / 用户在其它页面时都不会被抢导航。
  function handlePage() {
    if (allocating) return;
    if (currentPage() === 'stats') {
      handleStats(); // 属性页：有待分配点数就分配（内部会自检）
    } else if (currentPage() === 'fishing' && hasPendingPoints()) {
      console.log(TAG, '检测到待分配属性点，去属性页');
      spaNavigate(STATS);
    }
  }

  // 监听 SPA 客户端路由变化（纯前端跳转时内容脚本不会重新注入，必须自己盯）
  let lastPath = location.pathname;
  setInterval(() => {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      handlePage();
    }
  }, 1000);

  // 兜底主循环：每隔 INTERVAL_MS 再整体检查一遍。
  // 起始偏移 2.5 分钟，避免与“自动出售库存”每 5 分钟 / 每 10 分钟整点撞车
  // （两者都随扩展一起注入，否则会在 10/20/30… 分钟整点同时抢着导航页面）。
  const START_OFFSET_MS = 2.5 * 60 * 1000;
  setTimeout(() => {
    handlePage();
    setInterval(handlePage, INTERVAL_MS);
  }, START_OFFSET_MS);

  console.log(TAG, '已启动 | 当前页面：', currentPage(), '| 调试模式：', FAST);
})();

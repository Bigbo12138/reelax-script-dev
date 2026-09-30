// ==UserScript==
// @name         Reelax 库存自动出售
// @namespace    reelax-auto-sell
// @version      1.0.0
// @description  每 5 分钟切到库存页，点击“出售当前筛选的”并确认，再切回钓鱼页
// @match        https://reelax.cn/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  const BASE = 'https://reelax.cn';
  const FISHING = '/fishing';
  const INVENTORY = '/inventory';

  // 调试模式：首次打开的 URL 带 ?fast 或 ?dev 时，间隔缩短为 8 秒、
  // 并在页面跳转时自动带上该标记，方便本地快速验证整套流程。
  const FAST = /[?&](fast|dev)\b/.test(location.search);
  const INTERVAL_MS = FAST ? 8000 : 5 * 60 * 1000;

  const POLL_MS = 500;            // 轮询按钮的间隔
  const CLICK_TIMEOUT_MS = 20000; // 单个步骤最多等待 20 秒
  const AFTER_CONFIRM_MS = 1500;  // 确认后留点时间让请求发出，再切回

  const TAG = '[Reelax 自动出售]';

  // 防止同一页面被重复执行（扩展可能多次注入）
  if (window.__reelaxAutoSell__) {
    console.log(TAG, '已运行，跳过重复注入');
    return;
  }
  window.__reelaxAutoSell__ = true;

  function navUrl(path) {
    return BASE + path + (FAST ? '?fast' : '');
  }

  // 前端路由跳转（不整页刷新，避免浏览器一直转圈 / 卡在加载）。
  // 优先点击站内导航链接；找不到或点击未生效时，回退到硬跳转。
  function spaNavigate(path) {
    const clean = path.replace(/\?.*$/, '');
    if (location.pathname.replace(/\/+$/, '') === clean) return; // 已经在目标页
    const link = document.querySelector('a[href="' + clean + '"]');
    if (link) {
      console.log(TAG, 'SPA 导航到', clean);
      link.click();
      // 兜底：2 秒后仍未跳转（链接失效/被拦截），改硬跳转，避免卡死
      setTimeout(() => {
        if (location.pathname.replace(/\/+$/, '') !== clean) {
          console.log(TAG, 'SPA 导航未生效，回退硬跳转', navUrl(clean));
          location.href = navUrl(clean);
        }
      }, 2000);
      return;
    }
    console.log(TAG, '未找到导航链接，回退硬跳转', navUrl(clean));
    location.href = navUrl(clean);
  }

  // 根据路径判断当前所处页面
  function currentPage() {
    const p = location.pathname.replace(/\/+$/, '');
    if (p === FISHING || p.startsWith(FISHING + '/')) return 'fishing';
    if (p === INVENTORY || p.startsWith(INVENTORY + '/')) return 'inventory';
    return 'other';
  }

  // 在 root 范围内按文字找按钮；candidates 为候选子串，按顺序优先匹配
  function findButton(candidates, root) {
    root = root || document;
    const sel = 'button, input[type="button"], input[type="submit"], [role="button"], a.btn';
    const els = Array.from(root.querySelectorAll(sel));
    for (const text of candidates) {
      const hit = els.find((el) => {
        const t = (el.textContent || el.value || el.getAttribute('aria-label') || '').trim();
        return t && t.includes(text);
      });
      if (hit) return hit;
    }
    return null;
  }

  // 确认按钮可能出现在弹窗里：先全页精确匹配，退而在模态框容器内找“确认/Confirm”
  function findConfirmButton() {
    let b = findButton(['确认出售', '确认卖出', '确定出售']);
    if (b) return b;
    const modal = document.querySelector(
      '[role="dialog"], .modal, .dialog, .confirm, .confirm-dialog, [class*="modal"], [class*="dialog"]',
    );
    if (modal) {
      b = findButton(['确认', '确定', 'Confirm', 'OK'], modal);
      if (b) return b;
    }
    return null;
  }

  // 轮询直到 finder() 找到按钮并点击；成功或超时后回调 onDone(ok)
  function clickWhenReady(finder, label, onDone) {
    let waited = 0;
    const timer = setInterval(() => {
      waited += POLL_MS;
      const btn = finder();
      if (btn) {
        console.log(TAG, '点击：', label);
        btn.click();
        clearInterval(timer);
        onDone(true);
        return;
      }
      if (waited >= CLICK_TIMEOUT_MS) {
        console.warn(TAG, '超时未找到按钮：', label);
        clearInterval(timer);
        onDone(false);
      }
    }, POLL_MS);
  }

  function goFishing() {
    console.log(TAG, '切回钓鱼页', FISHING);
    spaNavigate(FISHING);
  }

  // 售卖前只保留的稀有度（按芯片 <span> 文字简单匹配）
  const KEEP_RARITIES = ['普通', '精良', '稀有', '史诗', '传说'];

  // 按 <span> 文字找稀有度筛选芯片
  function rarityChip(label) {
    return Array.from(
      document.querySelectorAll('.inventory-rarity-all, button[data-rarity]'),
    ).find((el) => (el.querySelector('span')?.textContent || '').trim() === label);
  }

  // 读取“全部”芯片是否勾选（每次重新查询，避免 React 重渲染后引用失效）
  function isAllOn() {
    const all = document.querySelector('.inventory-rarity-all');
    return !!all && all.getAttribute('aria-pressed') === 'true';
  }

  // 读取某个稀有度芯片是否勾选
  function isRarityOn(label) {
    const chip = rarityChip(label);
    return !!chip && chip.getAttribute('aria-pressed') === 'true';
  }

  // 卖出前校验：目标稀有度必须全部勾选，且"全部"必须"未勾选"。
  // 若"全部"仍勾选，意味着会连传说等高端鱼一起卖，必须中止，避免误卖。
  function verifyFilter() {
    const allOn = isAllOn();
    const allTargetsOn = KEEP_RARITIES.every((l) => isRarityOn(l));
    console.log(
      TAG, '[筛选校验] 全部=', allOn ? '勾选' : '未勾选',
      '| 目标(', KEEP_RARITIES.length, '种)=', allTargetsOn ? '全勾' : '未全勾',
    );
    if (allOn) {
      console.warn(TAG, '[筛选校验] 失败：全部仍勾选，停止出售（会误卖传说鱼）');
      return false;
    }
    if (!allTargetsOn) {
      console.warn(TAG, '[筛选校验] 失败：目标稀有度未全部勾选');
      return false;
    }
    return true;
  }

  // 售前校准筛选：绝不去点“全部”芯片，只按顺序慢慢点目标稀有度芯片（KEEP_RARITIES）。
  // 当“全部”勾选时四个芯片显示的是“虚拟全选态”，首轮先点第一个芯片把它切出全选
  // （点单个芯片游戏会自动取消“全部”），之后每步按真实态只补点未勾选的，
  // 避免重复点击把已勾选的芯片 toggle 关掉。校验不过会自动重试，仍不过则中止出售。
  function applyRarityFilter(onDone) {
    const targets = KEEP_RARITIES.slice();
    const MAX_PASS = 3;
    let pass = 0;

    const runPass = () => {
      const step = (idx) => {
        if (idx >= targets.length) {
          // 一遍点完，校验后再决定：通过则出售；不过则重试，超出次数则中止
          if (verifyFilter()) {
            console.log(TAG, '[筛选诊断] 目标稀有度校验通过，开始出售');
            onDone(true);
          } else if (pass < MAX_PASS - 1) {
            pass++;
            console.warn(TAG, '[筛选诊断] 校验未通过，重试校准第', pass + 1, '遍');
            setTimeout(runPass, 350);
          } else {
            console.warn(TAG, '[筛选诊断] 多次校验未通过，中止出售');
            onDone(false);
          }
          return;
        }
        const label = targets[idx];
        const allOn = isAllOn();
        // “全部”勾选态下虚拟态不可信，首轮第一个芯片必须点一下切出全选；
        // 其余情况只在“该芯片未勾选”时才点击，绝不重复点已勾选的芯片。
        const mustClick = allOn && idx === 0 ? true : !isRarityOn(label);
        if (mustClick) {
          const chip = rarityChip(label);
          if (chip) {
            console.log(TAG, '[筛选诊断] 点击', label, allOn ? '(从全部态切出)' : '(补齐未勾选)');
            chip.click();
          } else {
            console.warn(TAG, '[筛选诊断] 未找到芯片：', JSON.stringify(label));
          }
        } else {
          console.log(TAG, '[筛选诊断]', label, '已勾选，跳过');
        }
        setTimeout(() => step(idx + 1), 350); // 慢慢点，等筛选 UI 刷新完再点下一个
      };
      step(0);
    };

    runPass();
  }

  // 等待筛选芯片出现：进背包后筛选行可能是异步渲染的，先等它出来再校准
  function waitForChips(onReady) {
    let waited = 0;
    const timer = setInterval(() => {
      const chip = document.querySelector('.inventory-rarity-all, button[data-rarity]');
      if (chip) {
        clearInterval(timer);
        console.log(TAG, '[筛选诊断] 筛选芯片已渲染，等待 ' + waited + 'ms');
        onReady();
        return;
      }
      waited += 300;
      if (waited >= 10000) {
        console.warn(TAG, '[筛选诊断] 等待 10s 仍未出现筛选芯片，继续执行');
        clearInterval(timer);
        onReady(); // 超时也继续，避免卡死整个出售流程
      }
    }, 300);
  }

  function handleInventory() {
    console.log(TAG, '在库存页，准备出售当前筛选');

    // 第零步：等筛选芯片渲染出来，再校准稀有度筛选
    waitForChips(() => {
      applyRarityFilter((ok) => {
        if (!ok) {
          console.warn(TAG, '筛选校验未通过，跳过本次出售，稍后切回钓鱼页');
          setTimeout(goFishing, 2000);
          return;
        }
        // 第一步：点击“出售当前筛选的”
        clickWhenReady(
        () => findButton(['出售当前筛选', '卖出当前筛选', 'Sell filtered']),
        '出售当前筛选的',
        (ok) => {
          if (!ok) {
            console.warn(TAG, '未找到出售按钮，稍后切回钓鱼页');
            setTimeout(goFishing, 2000);
            return;
          }
          // 第二步：弹出确认框，点击“确认出售”
          clickWhenReady(
            findConfirmButton,
            '确认出售',
            (ok2) => {
              if (ok2) console.log(TAG, '已确认出售，等待请求完成');
              else console.warn(TAG, '未找到确认出售按钮');
              setTimeout(goFishing, AFTER_CONFIRM_MS);
            },
          );
        },
      );
      });
    });
  }

  function handleFishing() {
    console.log(TAG, '在钓鱼页，' + (FAST ? '8 秒' : '5 分钟') + '后切到库存页');
    setTimeout(() => {
      console.log(TAG, '切到库存页', INVENTORY);
      spaNavigate(INVENTORY);
    }, INTERVAL_MS);
  }

  // 同一页面只处理一次，避免重复点击 / 重复计时
  let lastHandled = null;
  function handlePage() {
    const page = currentPage();
    if (page === lastHandled) return;
    lastHandled = page;
    if (page === 'fishing') handleFishing();
    else if (page === 'inventory') handleInventory();
    else console.log(TAG, '非目标页面（' + location.pathname + '），不动作');
  }

  // 初始处理；并监听 SPA 客户端路由变化（内容脚本在纯前端跳转时不会重新注入）
  handlePage();
  let lastPath = location.pathname;
  setInterval(() => {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      handlePage();
    }
  }, 1000);

  console.log(TAG, '已启动 | 当前页面：', currentPage(), '| 调试模式：', FAST);
})();

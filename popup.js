// popup.js —— 工具栏弹窗逻辑
const DEFAULTS = {
  targetUrl: 'https://reelax.cn/',
};

function el(id) { return document.getElementById(id); }

// ---------- 比赛加点逻辑（与 monitor.js 的 computeStatPlan 保持一致，供 popup 预览）----------
// opts: { totalPoints, flatBonusStrength, strengthTarget, multiplier, enduranceBase, secondary }
// 计算赛后加点方案：力量补到 strengthTarget(总力量)，剩余全给 secondary(默认运气)。
function computeStatPlan(opts) {
  const STAT_KEYS = ['strength', 'intelligence', 'luck', 'endurance'];
  const totalPoints = Math.max(0, (opts.totalPoints | 0));
  const flatBonus = Math.max(0, opts.flatBonusStrength || 0);
  const target = Math.max(0, opts.strengthTarget || 0);
  const mult = (opts.multiplier > 0) ? opts.multiplier : 1;
  // 总点先扣耐力预留（如 4596−100=4496 参与力量/智力分配），点数不足时耐力不超发
  const endurance = Math.min(Math.max(0, opts.enduranceBase | 0), totalPoints);
  const secondary = STAT_KEYS.includes(opts.secondary) ? opts.secondary : 'luck';
  const needRaw = Math.floor((target - flatBonus) / mult);
  const needStrength = Math.max(0, Math.min(needRaw, totalPoints - endurance));
  const remain = Math.max(0, totalPoints - needStrength - endurance);
  // 耐力预留只是计算用（从总点里扣除这部分不参与力量/运气分配），
  // 真正分配时不发给耐力，全部点数只投力量+次要属性
  const body = { strength: needStrength, intelligence: 0, luck: 0, endurance: 0 };
  if (remain > 0) body[secondary] = remain;
  return {
    body, needStrength, secondaryPoints: remain > 0 ? remain : 0,
    flatBonusStrength: flatBonus, strengthTarget: target,
    reachedStrength: flatBonus + needStrength * mult, endurance, secondary,
    capped: needRaw > needStrength,
  };
}
const STAT_CN = { strength: '力量', intelligence: '智力', luck: '运气', endurance: '耐力' };

// 比赛加点面板渲染
function renderAlloc() {
  const m = window.__monitorStatus || {};
  const compEl = el('al-comp');
  if (compEl) {
    if (m.compActive) { compEl.textContent = '🏁 比赛中'; compEl.className = 'bad'; }
    else { compEl.textContent = '未比赛'; compEl.className = ''; }
  }
  // 输入框仅在尚未被用户编辑时同步后台值，避免打断输入
  const tEl = el('al-str-target');
  if (tEl && document.activeElement !== tEl && m.strengthTarget != null) tEl.value = m.strengthTarget;
  const sEl = el('al-secondary');
  if (sEl && m.allocSecondary) sEl.value = m.allocSecondary;
  const eEl = el('al-endurance');
  if (eEl && document.activeElement !== eEl && m.enduranceBase != null) eEl.value = m.enduranceBase;
  const aEl = el('al-auto');
  if (aEl) aEl.checked = !!m.compAutoRespec;
  const pEl = el('al-personal');
  if (pEl) pEl.checked = !!m.compPersonalRespec;

  // 洗点结果
  const rEl = el('al-result');
  if (rEl) {
    const r = m.lastRespecResult;
    if (r && r.at) {
      const t = new Date(r.at).toLocaleTimeString();
      if (r.ok) {
        const phase = r.phase === 'start' ? '赛前' : '赛后';
        const detail = r.phase === 'end' && r.body
          ? `力${r.body.strength} ${(STAT_CN[r.secondary] || r.secondary || '智')}${r.body[r.secondary] || 0}`
          : (r.body ? `运${r.body.luck}` : '');
        rEl.textContent = `✅ ${phase} ${detail} ${t}`;
        rEl.className = 'ok';
      } else {
        rEl.textContent = `❌ ${r.reason || '失败'} ${t}`;
        rEl.className = 'bad';
      }
    } else {
      rEl.textContent = '—';
      rEl.className = '';
    }
  }
}

// 向后台请求赛后预览（需读页面 stats，故走消息，由 monitor 代算）
async function refreshAllocPlan() {
  try {
    const res = await browser.runtime.sendMessage({ type: 'reelax-stat-plan' });
    if (!res || !res.ok) {
      const b = el('al-bonus'); if (b) b.textContent = '读取失败';
      const p = el('al-preview'); if (p) p.textContent = '—';
      return;
    }
    const bonusEl = el('al-bonus');
    if (bonusEl) bonusEl.textContent = (res.estFlatBonusStrength != null ? Number(res.estFlatBonusStrength).toLocaleString() : '—') + ' / 总点 ' + Number(res.totalPoints || 0).toLocaleString();
    const p = res.plan;
    const prevEl = el('al-preview');
    if (prevEl && p) {
      const cn = STAT_CN[p.secondary] || p.secondary;
      let txt = `力量 +${p.needStrength}`;
      txt += ` ；${cn} +${p.secondaryPoints}`;
      if (p.capped) txt += '（点数不足，未达标）';
      prevEl.textContent = txt;
      prevEl.title = `加成(力量)=${p.flatBonusStrength}，可用总点=${res.totalPoints}`;
    }
  } catch (e) {
    console.error('[popup] 预览失败', e);
  }
}

function setupAllocControls() {
  const tEl = el('al-str-target');
  if (tEl) tEl.addEventListener('change', () => {
    const v = Number(tEl.value) || 0;
    browser.storage.local.set({ strengthTarget: v }).then(refreshAllocPlan);
  });
  const sEl = el('al-secondary');
  if (sEl) sEl.addEventListener('change', () => {
    browser.storage.local.set({ allocSecondary: sEl.value }).then(refreshAllocPlan);
  });
  const eEl = el('al-endurance');
  if (eEl) eEl.addEventListener('change', () => {
    browser.storage.local.set({ enduranceBase: Number(eEl.value) || 0 }).then(refreshAllocPlan);
  });
  const aEl = el('al-auto');
  if (aEl) aEl.addEventListener('change', () => {
    browser.storage.local.set({ compAutoRespec: aEl.checked, allocStrategy: aEl.checked ? 'competition' : 'manual' });
  });
  const pEl = el('al-personal');
  if (pEl) pEl.addEventListener('change', () => {
    browser.storage.local.set({ compPersonalRespec: pEl.checked });
  });
  const startBtn = el('al-start');
  if (startBtn) startBtn.addEventListener('click', async () => {
    startBtn.disabled = true;
    try { await browser.runtime.sendMessage({ type: 'reelax-stat-allocate', mode: 'comp-start' }); }
    finally { startBtn.disabled = false; refreshAllocPlan(); }
  });
  const endBtn = el('al-end');
  if (endBtn) endBtn.addEventListener('click', async () => {
    endBtn.disabled = true;
    try { await browser.runtime.sendMessage({ type: 'reelax-stat-allocate', mode: 'comp-end' }); }
    finally { endBtn.disabled = false; refreshAllocPlan(); }
  });
}

function renderStatus() {
  const s = window.__bridgeStatus || {};
  const fmt = (v) => v == null ? '—' : v;

  const conn = el('st-conn');
  conn.textContent = s.connected ? '✅ 已连接' : '❌ 未连接';
  conn.className = s.connected ? 'ok' : 'bad';

  const login = el('st-login');
  login.textContent = s.loginOk ? '✅ 正常' : (s.loginOk === false ? '❌ 失效' : '…');
  login.className = s.loginOk ? 'ok' : (s.loginOk === false ? 'bad' : '');

  const proof = el('st-proof');
  proof.textContent = s.proofOk ? '✅ 有效' : (s.proofOk === false ? '❌ 过期' : '…');
  proof.className = s.proofOk ? 'ok' : (s.proofOk === false ? 'bad' : '');

  el('st-count').textContent = fmt(s.taskCount);

  const ms = el('st-ms');
  if (s.lastTaskMs != null) {
    ms.textContent = (s.lastTaskMs >= 1000 ? (s.lastTaskMs / 1000).toFixed(2) + 's' : s.lastTaskMs + 'ms');
  } else {
    ms.textContent = '—';
  }

  el('st-poll').textContent = s.lastPollAt
    ? new Date(s.lastPollAt).toLocaleTimeString()
    : '—';

  el('st-err').textContent = s.lastError || '无';
  el('st-err').style.color = s.lastError ? '#c62828' : '#2e7d32';
}

// 监控状态渲染（读 background 里 monitor.js 维护的 __monitorStatus）
function renderMonitor() {
  const mon = window.__monitorStatus || {};
  const monEl = el('st-mon');
  if (mon.enabled === false) {
    monEl.textContent = '⏸ 已关闭';
    monEl.className = '';
  } else {
    monEl.textContent = '✅ 启用';
    monEl.className = 'ok';
  }

  const heartEl = el('st-heart');
  if (mon.lastActivityAt) {
    const idle = mon.idleSec != null ? `（空闲 ${mon.idleSec}s）` : '';
    heartEl.textContent = new Date(mon.lastActivityAt).toLocaleTimeString() + idle;
    heartEl.className = (mon.idleSec != null && mon.idleSec > (mon.offlineCheckMin || 2) * 60)
      ? 'bad' : 'ok';
  } else {
    heartEl.textContent = '—';
  }

  // 现失联时间 / 总失联合计（monitor 每 15s 维护）
  const fmtDur = (sec) => {
    if (sec == null) return '—';
    const s = Math.round(sec);
    if (s < 60) return s + 's';
    const mm = Math.floor(s / 60), ss = s % 60;
    return mm + '分' + (ss ? ss + '秒' : '');
  };
  const idleNowEl = el('st-idle-now');
  if (mon.idleSec != null && mon.idleSec > 0) {
    idleNowEl.textContent = fmtDur(mon.idleSec);
    idleNowEl.className = (mon.idleSec > (mon.offlineCheckMin || 2) * 60) ? 'bad' : 'ok';
  } else {
    idleNowEl.textContent = '—';
    idleNowEl.className = 'ok';
  }
  const idleTotalEl = el('st-idle-total');
  idleTotalEl.textContent = mon.offlineTotalSec > 0 ? fmtDur(mon.offlineTotalSec) : '—';

  el('st-proof-at').textContent = mon.proofUpdatedAt
    ? new Date(mon.proofUpdatedAt).toLocaleTimeString()
    : (mon.proofOk ? '有效' : '—');

  const reloadEl = el('st-reload');
  if (mon.reloadCount > 0) {
    const reason = mon.lastReloadReason === 'offline' ? '掉线' : (mon.lastReloadReason === 'login' ? '登录失效' : mon.lastReloadReason);
    const at = mon.lastReloadAt ? new Date(mon.lastReloadAt).toLocaleTimeString() : '';
    reloadEl.textContent = `${mon.reloadCount}次（${reason} ${at}）`;
    reloadEl.className = 'bad';
  } else {
    reloadEl.textContent = '0次';
    reloadEl.className = 'ok';
  }

  // 页面刷新总次数（含手动 F5 与扩展自动刷新）
  const pageReloadEl = el('st-page-reload');
  pageReloadEl.textContent = mon.pageReloadCount > 0 ? mon.pageReloadCount + ' 次' : '—';
  pageReloadEl.className = mon.pageReloadCount > 0 ? 'ok' : '';

  // 最近 URL 切换（显示最近一条路径 + 累计切换次数，如 fishing / 5）
  const urlHistEl = el('st-url-history');
  if (Array.isArray(mon.urlHistory) && mon.urlHistory.length > 0) {
    const latest = mon.urlHistory[0];
    let path = latest.url;
    try {
      const u = new URL(latest.url);
      path = u.pathname === '/' ? '/' : u.pathname;
    } catch (_) {}
    const clean = path === '/' ? '首页' : path.replace(/^\//, '');
    const count = mon.urlCount && mon.urlCount[path] != null ? mon.urlCount[path] : 0;
    urlHistEl.textContent = `${clean} / ${count}`;
    urlHistEl.className = 'ok';
    urlHistEl.title = mon.urlHistory.map((h) => `${new Date(h.ts).toLocaleTimeString()} ${h.url}`).join('\n');
  } else {
    urlHistEl.textContent = '—';
    urlHistEl.className = '';
  }

  // 自动加点（显示最近结果：成功/失败/等待）
  const reasonMap = { disabled: '已关', 'no-points': '等待点数', throttled: '节流中', locked: '锁中', allocating: '分配中', 'stats-fetch-failed': '查点失败' };
  const allocEl = el('st-alloc');
  if (mon.autoAllocate === false) {
    allocEl.textContent = '⏸ 已关闭';
    allocEl.className = '';
    allocEl.title = '';
  } else if (mon.lastAllocateResult) {
    const r = mon.lastAllocateResult;
    const t = new Date(r.at).toLocaleTimeString();
    if (r.ok === true) {
      allocEl.textContent = `✅ +${r.added}点 ${t}`;
      allocEl.className = 'ok';
      allocEl.title = '最近一次加点成功';
    } else if (r.ok === false) {
      const why = r.status != null ? `HTTP ${r.status}` : (r.reason || '失败');
      allocEl.textContent = `❌ ${why} ${t}`;
      allocEl.className = 'bad';
      allocEl.title = [r.errorBody, r.proofUsed ? 'proof:' + r.proofUsed : '', r.status != null ? 'HTTP ' + r.status : ''].filter(Boolean).join(' | ');
    } else {
      const why = reasonMap[r.reason] || r.reason || '—';
      allocEl.textContent = `… ${why} ${t}`;
      allocEl.className = '';
      allocEl.title = '最近一次检查未加点';
    }
  } else {
    allocEl.textContent = '✅ 启用';
    allocEl.className = 'ok';
    allocEl.title = '等待首次检查';
  }
}

// sync 数据渲染（monitor.js 从 fishing/sync 响应提取的精选字段）
function renderSync() {
  const s = (window.__monitorStatus || {}).sync || {};
  const fmtNum = (v) => (v == null ? '—' : Number(v).toLocaleString());
  const fmtGold = (v) => (v == null ? '—' : Number(v).toLocaleString() + ' 金');
  const statusMap = { running: '运行中', completed: '已完成', stopped: '已停止' };
  const modeMap = { online: '在线', offline: '离线' };
  const roleMap = { captain: '船长', helmsman: '舵手', crew: '船员' };

  // 游戏状态：运行中·在线
  let statusText = s.runStatus ? (statusMap[s.runStatus] || s.runStatus) : '—';
  if (s.runMode && statusMap[s.runStatus]) statusText += '·' + (modeMap[s.runMode] || s.runMode);
  const stEl = el('sy-status');
  stEl.textContent = statusText;
  stEl.className = s.runStatus === 'running' ? 'ok' : (s.runStatus ? 'bad' : '');

  // 剩余杆数：237 / 500
  const castsEl = el('sy-casts');
  if (s.remainingCasts != null && s.totalCasts != null) {
    castsEl.textContent = `${fmtNum(s.remainingCasts)} / ${fmtNum(s.totalCasts)}`;
  } else {
    castsEl.textContent = s.remainingCasts != null ? fmtNum(s.remainingCasts) : '—';
  }

  // 本批次：19,740 金 / 55 杆
  const batchEl = el('sy-batch');
  if (s.batchGold != null && s.batchCasts != null) {
    batchEl.textContent = `${fmtGold(s.batchGold)} / ${fmtNum(s.batchCasts)} 杆`;
  } else {
    batchEl.textContent = s.batchGold != null ? fmtGold(s.batchGold) : '—';
  }

  // 今日净赚
  el('sy-daily').textContent = fmtGold(s.dailyNetGold);

  // 今日总杆数（sync 的 dailyHarvest.casts） + 期望杆数（今日0点起按 6.5s/杆折算）
  const dailyCastsEl = el('sy-daily-casts');
  if (s.dailyCasts != null && s.expectedCasts != null) {
    dailyCastsEl.textContent = `${fmtNum(s.dailyCasts)}/${fmtNum(s.expectedCasts)}`;
    dailyCastsEl.className = 'ok';
  } else if (s.dailyCasts != null) {
    dailyCastsEl.textContent = fmtNum(s.dailyCasts) + ' 杆';
    dailyCastsEl.className = '';
  } else {
    dailyCastsEl.textContent = '—';
    dailyCastsEl.className = '';
  }

  // 等级/金币
  const playerEl = el('sy-player');
  if (s.level != null && s.gold != null) {
    playerEl.textContent = `Lv${fmtNum(s.level)} · ${fmtGold(s.gold)}`;
  } else {
    playerEl.textContent = s.level != null ? `Lv${fmtNum(s.level)}` : (s.gold != null ? fmtGold(s.gold) : '—');
  }

  // 未分配点数（自动加点触发依据）
  const unspentEl = el('sy-unspent');
  if (s.unspentStatPoints != null && s.unspentStatPoints > 0) {
    unspentEl.textContent = fmtNum(s.unspentStatPoints) + ' 点';
    unspentEl.className = 'bad'; // 有待加点
  } else {
    unspentEl.textContent = '0 点';
    unspentEl.className = 'ok';
  }

  // 最近一杆
  const rarityMap = { common: '普通', uncommon: '罕见', fine: '精良', rare: '稀有', epic: '史诗', legendary: '传说', mythic: '神话', exotic: '奇异', arcane: '奥秘' };
  const lastEl = el('sy-last');
  if (s.lastResult && (s.lastResult.gold != null || s.lastResult.fishId || s.lastResult.kind)) {
    const r = s.lastResult;
    let lastText = r.kind && r.kind !== 'fish' ? r.kind : '';
    if (r.rarity) lastText += (lastText ? ' · ' : '') + (rarityMap[r.rarity] || r.rarity);
    if (r.quantity != null) lastText += (lastText ? ' ×' : '×') + fmtNum(r.quantity);
    if (r.gold != null) lastText += ' · +' + fmtGold(r.gold);
    if (r.experience != null) lastText += ' · +' + fmtNum(r.experience) + 'XP';
    lastEl.textContent = lastText || '—';
  } else {
    lastEl.textContent = '—';
  }

  // 升级进度（数值 + 进度条）
  const expEl = el('sy-exp');
  const expBar = el('sy-exp-bar');
  if (s.exp != null && s.expToNext) {
    const pct = Math.min(100, Math.max(0, (s.exp / s.expToNext) * 100));
    expEl.textContent = `${fmtNum(s.exp)} / ${fmtNum(s.expToNext)}`;
    if (expBar) expBar.style.width = pct.toFixed(1) + '%';
  } else {
    expEl.textContent = '—';
    if (expBar) expBar.style.width = '0';
  }

  // 公会税/毛收
  const taxEl = el('sy-tax');
  if (s.guildTax == null && s.directGoldGross == null) {
    taxEl.textContent = '—';
  } else {
    taxEl.textContent = `税 ${fmtGold(s.guildTax)} / 毛 ${fmtGold(s.directGoldGross)}`;
  }

  // 下1/下5级预测（monitor 按最近 N 杆收益 + 经验公式推算）
  const fmtDur = (sec) => {
    if (sec < 60) return `${sec} 秒`;
    const min = Math.round(sec / 60);
    if (min < 60) return `${min} 分钟`;
    const h = Math.floor(min / 60), mm = min % 60;
    return `${h} 小时${mm ? ' ' + mm + ' 分' : ''}`;
  };
  const avgEl = el('sy-avg');
  if (s.eta && s.eta.avgExp != null) {
    avgEl.textContent = `${fmtNum(s.eta.avgExp)} XP · ${fmtGold(s.eta.avgGold)}`;
  } else {
    avgEl.textContent = '—';
  }
  const lvRanks = [1, 5, 1000];
  if (Array.isArray(s.levels) && s.levels.length) {
    for (const rank of lvRanks) {
      const lv = s.levels.find((x) => x.rank === rank);
      const lvEl = el('sy-lv' + rank);
      if (!lvEl) continue;
      if (lv) {
        // 等级居左、时间居右
        lvEl.textContent = `Lv${fmtNum(lv.level)}`;
        const tEl = el('sy-lvt' + rank);
        if (tEl) tEl.textContent = fmtDur(lv.seconds);
        lvEl.title = `还需 ${fmtNum(lv.neededExp)} 经验`;
      } else {
        lvEl.textContent = '—';
        const tEl = el('sy-lvt' + rank);
        if (tEl) tEl.textContent = '';
      }
    }
  } else {
    for (const rank of lvRanks) {
      const lvEl = el('sy-lv' + rank);
      if (lvEl) lvEl.textContent = '采样中…';
      const tEl = el('sy-lvt' + rank);
      if (tEl) tEl.textContent = '';
    }
  }

  // 组队船
  const boatEl = el('sy-boat');
  if (s.boatName) {
    const role = s.partyRole ? (roleMap[s.partyRole] || s.partyRole) : '';
    const biome = s.boatBiomeId ? ` · ${s.boatBiomeId}` : '';
    boatEl.textContent = s.boatName + (role ? ` · ${role}` : '') + biome;
  } else {
    boatEl.textContent = '未组队';
  }

  // 在线人数
  el('sy-online').textContent = s.onlinePlayers != null ? fmtNum(s.onlinePlayers) + ' 人' : '—';

  // 服务器时钟校准状态（聚合.js 每轮上报 → monitor.js → 这里展示，2s 刷新）
  const clk = (window.__monitorStatus || {}).clock;
  const fmtClock = (iso) => {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getUTCHours() + 8 > 23 ? d.getUTCHours() + 8 - 24 : d.getUTCHours() + 8)}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
  };
  el('sy-clock-server').textContent = fmtClock(clk && clk.serverTime);
  el('sy-clock-local').textContent = fmtClock(clk && clk.local);
  el('sy-clock-delta').textContent = clk && typeof clk.deltaMs === 'number'
    ? (clk.deltaMs > 0 ? '+' : '') + clk.deltaMs.toLocaleString() + ' ms'
    : '—';
}

// 保底状态渲染（monitor.js 从 /api/statistics 提取的 pity 字段）
// 主显示 = 进度百分比（currentDry / hardPity，到硬保底 100%，可超过）
//         + 距硬保底剩余时间（剩余杆数 × 6 秒/杆）；
// 悬停 title 看当前杆数 / 软保底 / 硬保底 / 有效运气。
function renderPity() {
  const mon = window.__monitorStatus || {};
  const p = mon.pity || {};
  const fmtNum = (v) => (v == null ? '—' : Number(v).toLocaleString());
  const hardMargin = mon.pityHardMargin != null ? mon.pityHardMargin : 1000;
  // 剩余时间：剩余杆数 × 6 秒/杆，返回裸时长（如 "30分" / "21时16分"）
  const fmtRemain = (cur, hard) => {
    if (cur == null || hard == null || hard <= 0) return '';
    const remainCasts = hard - cur;
    if (remainCasts <= 0) return '已到期';
    const mm = Math.round(remainCasts * 6 / 60);
    if (mm < 60) return mm + '分';
    return Math.floor(mm / 60) + '时' + (mm % 60 ? (mm % 60) + '分' : '');
  };

  const renderRow = (key, name, cnName) => {
    const elRow = document.getElementById(key);
    if (!elRow) return;
    const d = p[name];
    if (!d || d.currentDry == null || d.hardPity == null) {
      elRow.textContent = mon.pityMonitor === false ? '已关闭' : '—';
      elRow.className = '';
      elRow.title = '';
      return;
    }
    const pct = d.pct != null ? d.pct : (d.hardPity > 0 ? d.currentDry / d.hardPity * 100 : null);
    let cls = 'ok';
    if (d.currentDry >= d.hardPity) cls = 'bad';                          // 已超硬保底
    else if (d.currentDry >= d.hardPity - hardMargin) cls = 'bad';        // 临近硬保底
    else if (d.maxDry != null && d.currentDry >= d.maxDry) cls = 'bad';   // 软保底已满
    let text = pct != null ? pct.toFixed(1) + '%' : '—';
    const remain = fmtRemain(d.currentDry, d.hardPity);
    if (remain) text += ' · 约' + remain;
    elRow.textContent = text;
    elRow.className = cls;
    const bits = [`${cnName}鱼保底`, `当前 ${fmtNum(d.currentDry)} 杆`];
    if (d.hardPity != null) bits.push(`硬保底 ${fmtNum(d.hardPity)}`);
    if (d.maxDry != null) bits.push(`软保底 ${fmtNum(d.maxDry)}`);
    if (d.currentDry != null && d.hardPity != null) {
      const rc = d.hardPity - d.currentDry;
      bits.push(rc > 0 ? `距硬保底 ${fmtNum(rc)} 杆（约${fmtRemain(d.currentDry, d.hardPity)}）` : '已到硬保底');
    }
    if (p.effectiveLuck != null) bits.push(`有效运气 ${p.effectiveLuck}`);
    if (p.updatedAt) bits.push(new Date(p.updatedAt).toLocaleTimeString());
    elRow.title = bits.join(' · ');
  };

  renderRow('py-arcane', 'arcane', '奥秘');
  renderRow('py-exotic', 'exotic', '奇异');

  // 保底触发状态行
  const tgEl = document.getElementById('py-trigger');
  if (tgEl) {
    const t = mon.pityTrigger || {};
    const ref = t.ref || {};
    const arcOn = mon.pityTriggerArcane === true;
    const exoOn = mon.pityTriggerExotic === true;
    const surgeOnly = mon.pityTriggerSurgeOnly === true;
    const topBait = mon.pityTriggerTopBait === true;
    if (!arcOn && !exoOn) {
      tgEl.textContent = '关闭';
      tgEl.className = '';
      tgEl.title = '设置页开启「保底触发·奥秘/奇异」后启用（仅记录奥秘涌流·全运气硬保底基准；非全运气时杆数达基准→洗全运气→出货洗回）';
      return;
    }
    const who = (arcOn && exoOn) ? '奥秘&奇异' : (arcOn ? '奥秘' : '奇异');
    const baitNote = topBait ? ' · 顶级饵' : '';
    const inSurge = !!(mon.arcaneSacrifice && mon.arcaneSacrifice.surge && mon.arcaneSacrifice.surge.isActive);
    const refTxt = ref.built
      ? (`涌流基准:奥秘${ref.arcane != null ? ref.arcane : '-'}/奇异${ref.exotic != null ? ref.exotic : '-'}`)
      : '涌流基准未建立';
    if (t.active) {
      tgEl.textContent = '🏮 全运气锁（' + who + baitNote + '）';
      tgEl.className = 'bad';
      tgEl.title = '已洗点全加运气' + (topBait ? '并切顶级饵' : '') + '，等待保底出货后洗回原加点' + (topBait ? '/原饵' : '') + '；此期间自动加点已暂停 · ' + refTxt;
    } else if (surgeOnly && !inSurge) {
      tgEl.textContent = '等涌流 (' + who + baitNote + ')';
      tgEl.className = '';
      tgEl.title = '已开启「仅奥秘涌流触发」：当前非涌流，涌流期间才会触发保底洗点' + (topBait ? '（含换顶级饵）' : '') + ' · ' + refTxt;
    } else {
      tgEl.textContent = '待命';
      tgEl.className = 'ok';
      tgEl.title = '启用 ' + who + (surgeOnly ? '（仅涌流期间）' : '') + (topBait ? '（顶级饵）' : '') + '；基准仅于奥秘涌流·全运气时记录，非全运气时杆数≥涌流基准→洗点全加运气，出货后洗回 · ' + refTxt;
    }
  }
}

// 鱼自动出售状态渲染（monitor.js 维护的 fishSell / fishSoldTotal / fishSellChecks）
// 「自动卖鱼」行显示：状态 + 上次检查时间；悬停看上次检查时的罕见鱼总数/保留上限/轮次。
// 「已售出」行显示：累计售出条数 + 最近一次卖出条数。
function renderFishSell() {
  const mon = window.__monitorStatus || {};
  const fmt = (v) => (v == null ? '—' : Number(v).toLocaleString());
  const setTxt = (id, t, cls, title) => {
    const e = document.getElementById(id);
    if (e) { e.textContent = t; e.className = cls || ''; e.title = title || ''; }
  };
  const rarityCN = { common: '普通', uncommon: '罕见', fine: '精良', rare: '稀有', epic: '史诗' };
  const selRars = (Array.isArray(mon.fishSellRarities) && mon.fishSellRarities.length)
    ? mon.fishSellRarities : (mon.fishSellRarity ? [mon.fishSellRarity] : ['uncommon']);
  const rar = selRars.map((r) => rarityCN[r] || r).join(' / ');
  const keepMax = mon.fishKeepMax != null ? mon.fishKeepMax : 20000;
  // 最近一次实际结果里各稀有度的销售明细（若有）→ 拼进 tooltip
 
  const per = (mon.fishSell && mon.fishSell.perRarity) || {};
  const perBits = Object.keys(per).length
    ? '\n' + Object.keys(per).map((k) => `  ${rarityCN[k] || k}:卖${fmt(per[k].sold)}/共${fmt(per[k].total)}/留${fmt(per[k].kept)}`).join('\n')
    : '';

  // 自动卖鱼行（精简：状态 + 时间；详情放悬停 title）
  if (mon.fishAutoSell === false) {
    setTxt('sy-fish-sell', '⏸ 已关闭', '');
  } else {
    const r = mon.fishSell;
    if (!r || !r.at) {
      setTxt('sy-fish-sell', '✅ 启用', 'ok', '等待首次检查');
    } else if (r.ok === false) {
      const why = r.status != null ? 'HTTP ' + r.status : (r.reason === 'fetch-failed' ? '查询失败' : (r.reason || '失败'));
      setTxt('sy-fish-sell', '❌ ' + why, 'bad', [r.error, r.errorBody, r.reason].filter(Boolean).join(' | ') || '查询/出售失败');
    } else {
      // ok === true：empty / under-limit / sold
      let txt;
      if (r.reason === 'sold') txt = '✅ 已卖 ' + fmt(r.sold);
      else if (r.reason === 'under-limit') txt = '✅ 未超上限';
      else if (r.reason === 'empty') txt = '✅ 库存空';
      else txt = '✅ 启用';
      const chk = r.checkedAt ? ' · ' + new Date(r.checkedAt).toLocaleTimeString() : '';
      setTxt('sy-fish-sell', txt + chk, 'ok',
        (r.checkedAt ? '上次检查 ' + new Date(r.checkedAt).toLocaleString() + '\n' : '') +
        '所选 ' + rar + '（各保留 ' + fmt(keepMax) + '）' +
        (r.reason === 'sold' ? '\n本次共卖 ' + fmt(r.sold) + ' 条' : '') +
        perBits +
        '｜已循环 ' + fmt(mon.fishSellChecks || 0) + ' 次');
    }
  }

  // 已售出行：累计已售出条数（持久化）
  const soldEl = el('sy-fish-sold');
  if (mon.fishSoldTotal > 0) {
    soldEl.textContent = fmt(mon.fishSoldTotal) + ' 条';
    soldEl.className = 'ok';
    soldEl.title = '累计自动售出条数（持久化，重启不丢）';
  } else {
    soldEl.textContent = '—';
    soldEl.className = '';
    soldEl.title = '尚未卖出过鱼';
  }
}

// 市场装备监测状态行
function renderGearWatch() {
  const mon = window.__monitorStatus || {};
  const el = document.getElementById('gear-watch');
  if (!el) return;
  const fmt = (v) => (v == null ? '—' : Number(v).toLocaleString());
  const rarityCN = { common: '普通', uncommon: '罕见', fine: '精良', rare: '稀有', epic: '史诗', legendary: '传说', mythic: '神话', exotic: '奇异', arcane: '奥秘' };
  const slotCN = { head: '头冠', chest: '上衣', legs: '绑腿', boots: '靴子', gloves: '手套', ring: '戒指', amulet: '项链', charm: '护符' };
  if (mon.gearWatchEnabled === false) {
    el.textContent = '⏸ 已关闭';
    el.className = '';
    el.title = '设置页开启「市场装备监测」后启用';
    return;
  }
  const r = mon.gearWatch;
  if (!r || !r.at) {
    el.textContent = '✅ 启用';
    el.className = 'ok';
    el.title = '待首次扫描';
    return;
  }
  const rar = rarityCN[mon.gearWatchRarity] || mon.gearWatchRarity || '?';
  const slots = (Array.isArray(mon.gearWatchSlots) && mon.gearWatchSlots.length)
    ? mon.gearWatchSlots.map((s) => slotCN[s] || s).join('/') : '全部';
  const maxP = mon.gearWatchMaxPrice ? ' ≤' + fmt(mon.gearWatchMaxPrice) + '金' : '';
  // 多条需求单：简化为「N 条需求单」汇总；旧字段仅为兼容保留
  const ruleCount = Array.isArray(mon.gearWatchRules) ? mon.gearWatchRules.length : 0;
  const watchDesc = ruleCount ? (ruleCount + ' 条需求单') : (rar + '·' + slots + maxP);
  if (r.ok === false) {
    el.textContent = '❌ 扫描失败';
    el.className = 'bad';
    el.title = '上次扫描失败: ' + (r.reason || '未知') + '\n监控 ' + watchDesc;
    return;
  }
  const hits = Array.isArray(mon.gearWatchHits) ? mon.gearWatchHits : [];
  const time = r.checkedAt ? new Date(r.checkedAt).toLocaleTimeString() : '';
  const hitLine = (h) => {
    const g2 = h.gear || {};
    return `${h.rule ? '[' + h.rule + '] ' : ''}${g2.name || '?'}(${slotCN[g2.slot] || g2.slot || '?'}) ${fmt(h.order.limitUnitPrice)}金 Q${g2.quality || 0} +${g2.upgradeLevel || 0}`;
  };
  if (hits.length) {
    const top = hits[0];
    const g = (top.gear) || {};
    const title = ['本次命中 ' + hits.length + ' 件（最近）:', '']
      .concat(hits.slice(0, 6).map(hitLine))
      .join('\n');
    el.textContent = '🎯 ' + fmt(hits.length) + ' (最低 ' + fmt(top.order.limitUnitPrice) + ') · ' + time;
    el.className = 'bad';
    el.title = title + '\n\n监控 ' + watchDesc;
  } else {
    el.textContent = '✅ 无命中 · ' + time;
    el.className = 'ok';
    el.title = '扫描 ' + fmt(r.scanned) + ' 条装备无满足条件的低价目标\n监控 ' + watchDesc;
  }
}

// 鱼自动出售手动按钮：立即卖一次 / 刷新状态
function setupFishSellControls() {
  const nowBtn = el('fish-sell-now');
  const refBtn = el('fish-sell-refresh');
  const resultEl = el('sy-fish-sell');
  if (nowBtn) nowBtn.addEventListener('click', async () => {
    nowBtn.disabled = true;
    if (resultEl) { resultEl.textContent = '… 检查中'; resultEl.className = ''; }
    try {
      const res = await browser.runtime.sendMessage({ type: 'reelax-fish-sell-now' });
      if (res && res.result) {
        const r = res.result;
        const fmt = (v) => (v == null ? '—' : Number(v).toLocaleString());
        if (r.ok === true && r.reason === 'sold') {
          resultEl.textContent = '✅ 已卖 ' + fmt(r.sold);
          resultEl.className = 'ok';
          resultEl.title = '累计 ' + fmt(res.soldTotal) + ' 条';
        } else if (r.ok === true && r.reason === 'under-limit') {
          resultEl.textContent = '✅ 未超上限';
          resultEl.className = 'ok';
          resultEl.title = '罕见 ' + fmt(r.total) + '（保留 ' + fmt(res.keepMax) + '）｜已循环 ' + fmt(res.checks) + ' 次';
        } else if (r.ok === true && r.reason === 'empty') {
          resultEl.textContent = '✅ 库存空';
          resultEl.className = 'ok';
        } else {
          const why = r.status != null ? 'HTTP ' + r.status : (r.reason === 'fetch-failed' ? '查询失败' : (r.reason || '失败'));
          resultEl.textContent = '❌ ' + why;
          resultEl.className = 'bad';
          resultEl.title = [r.error, r.errorBody, r.reason].filter(Boolean).join(' | ') || '失败';
        }
      } else {
        if (resultEl) { resultEl.textContent = '❌ 无响应'; resultEl.className = 'bad'; }
      }
    } catch (e) {
      if (resultEl) { resultEl.textContent = '❌ ' + String(e); resultEl.className = 'bad'; }
    } finally {
      nowBtn.disabled = false;
      setTimeout(renderFishSell, 300);
    }
  });
  // 「刷新」= 真正重新拉取一次库存并判断（跟「立即卖一次」一样触发后台检查，但按阈值自动决定是否卖）
  if (refBtn) refBtn.addEventListener('click', async () => {
    refBtn.disabled = true;
    if (resultEl) { resultEl.textContent = '… 检查中'; resultEl.className = ''; }
    try {
      const res = await browser.runtime.sendMessage({ type: 'reelax-fish-sell-now' });
      if (res && res.result) {
        const r = res.result;
        const fmt = (v) => (v == null ? '—' : Number(v).toLocaleString());
        if (r.ok === true && r.reason === 'sold') {
          resultEl.textContent = '✅ 已卖 ' + fmt(r.sold);
          resultEl.className = 'ok';
          resultEl.title = '累计 ' + fmt(res.soldTotal) + ' 条';
        } else if (r.ok === true && r.reason === 'under-limit') {
          resultEl.textContent = '✅ 未超上限';
          resultEl.className = 'ok';
          resultEl.title = '罕见 ' + fmt(r.total) + '（保留 ' + fmt(res.keepMax) + '）｜已循环 ' + fmt(res.checks) + ' 次';
        } else if (r.ok === true && r.reason === 'empty') {
          resultEl.textContent = '✅ 库存空';
          resultEl.className = 'ok';
        } else {
          const why = r.status != null ? 'HTTP ' + r.status : (r.reason === 'fetch-failed' ? '查询失败' : (r.reason || '失败'));
          resultEl.textContent = '❌ ' + why;
          resultEl.className = 'bad';
          resultEl.title = [r.error, r.errorBody, r.reason].filter(Boolean).join(' | ') || '失败';
        }
      } else {
        if (resultEl) { resultEl.textContent = '❌ 无响应'; resultEl.className = 'bad'; }
      }
    } catch (e) {
      if (resultEl) { resultEl.textContent = '❌ ' + String(e); resultEl.className = 'bad'; }
    } finally {
      refBtn.disabled = false;
      setTimeout(renderFishSell, 300);
    }
  });
}

// ---------- 奥术献祭一键贡献（读 monitor 的 m.arcaneSacrifice） ----------
const SACRIFICE_CN = { relic: '遗物', fish: '鱼', gold: '金币' };

function renderSacrifice() {
  const mon = window.__monitorStatus || {};
  const s = mon.arcaneSacrifice;
  const fmt = (v) => (v == null ? '—' : Number(v).toLocaleString());
  const setTxt = (id, t, cls) => { const e = el(id); if (e) { e.textContent = t; if (cls) e.className = cls; } };

  if (!s) {
    setTxt('sf-status', mon.lastSacrificeError ? '读取失败' : '—', mon.lastSacrificeError ? 'bad' : 'ok');
    setTxt('sf-day', '—'); setTxt('sf-round', '—'); setTxt('sf-surge', '—');
    setTxt('sf-server', '—'); setTxt('sf-auto', '—');
    setTxt('sf-relic', '—'); setTxt('sf-fish', '—'); setTxt('sf-gold', '—');
    setTxt('sf-result', '—'); setTxt('sf-err', mon.lastSacrificeError || '无', mon.lastSacrificeError ? 'bad' : '');
    return;
  }
  const ok = s.status === 'ready';
  setTxt('sf-status', ok ? '✅ 进行中' : (s.status || '—'), ok ? 'ok' : 'bad');
  setTxt('sf-day', s.day ? s.day.date : '—');
  const cr = s.currentRound;
  setTxt('sf-round', cr
    ? '第' + cr.roundNumber + '轮 ' + (SACRIFICE_CN[cr.resourceType] || cr.resourceType) + ' 目标' + fmt(cr.target)
    : (s.nextResourceType ? '已完·下轮' + (SACRIFICE_CN[s.nextResourceType] || s.nextResourceType) : '已完'));
  setTxt('sf-surge', s.surge && s.surge.isActive ? '🔥 生效中（' + new Date(s.surge.endsAt).toLocaleTimeString() + ' 止）' : '未生效');

  // 全服进度比例（progress/target，只显示百分比）
  const serverEl = el('sf-server');
  if (cr && cr.target > 0 && cr.progress != null) {
    const pct = cr.progress / cr.target * 100;
    serverEl.textContent = pct.toFixed(1) + '%';
    serverEl.className = (mon.sacrificeServerPct != null && pct >= mon.sacrificeServerPct) ? 'ok' : '';
    serverEl.title = '全服进度；达到 ' + (mon.sacrificeServerPct != null ? mon.sacrificeServerPct : 60) + '% 后自动贡献';
  } else {
    serverEl.textContent = '—';
    serverEl.className = '';
  }

  // 自动贡献状态
  const autoEl = el('sf-auto');
  if (mon.sacrificeAuto === false) {
    autoEl.textContent = '⏸ 已关闭';
    autoEl.className = '';
    autoEl.title = '';
  } else {
    const a = mon.lastSacrificeAuto;
    const reasonMap = { 'server-under-threshold': '等全服', 'already-met': '已达标', 'no-open-round': '无开放轮', 'no-plan': '无方案' };
    if (!a || !a.at) {
      autoEl.textContent = '✅ 启用';
      autoEl.className = 'ok';
      autoEl.title = '等待首次检查';
    } else if (a.ok === true) {
      if (a.contributed > 0) {
        autoEl.textContent = '✅ 已捐 ' + fmt(a.contributed);
        autoEl.className = 'ok';
        autoEl.title = (a.resourceType || '') + ' 自动贡献 ' + fmt(a.contributed) + '，全服 ' + (a.serverPct != null ? a.serverPct.toFixed(1) + '%' : '?') + ' · ' + new Date(a.at).toLocaleTimeString();
      } else {
        autoEl.textContent = (a.reason === 'already-met' ? '✅ 已达标' : '… 等待');
        autoEl.className = a.reason === 'already-met' ? 'ok' : '';
        autoEl.title = (reasonMap[a.reason] || a.reason || '') + ' · 全服 ' + (a.serverPct != null ? a.serverPct.toFixed(1) + '%' : '?') + ' · ' + new Date(a.at).toLocaleTimeString();
      }
    } else {
      autoEl.textContent = '❌ ' + (reasonMap[a.reason] || a.reason || '失败');
      autoEl.className = 'bad';
      autoEl.title = new Date(a.at).toLocaleTimeString();
    }
  }

  // 每资源一行（精简）：√已达标（参考/库存） / × 还差 N [原因]
  function setBtn(type, p) {
    const btn = el('sf-btn-' + type);
    if (!btn) return;
    const cn = SACRIFICE_CN[type] || type;
    if (!p) { btn.disabled = true; btn.title = ''; return; }
    const can = !!(p.canContribute && p.need > 0);
    btn.disabled = !can;
    btn.title = can ? ('一键贡献 ' + cn + ' ' + fmt(p.need) + (p.unit || '')) : ((p.reason) || '已达标');
  }
  const renderRow = (type) => {
    const p = s.perResource[type];
    const cn = SACRIFICE_CN[type] || type;
    const setRow = (t, cls) => setTxt('sf-' + type, t, cls);
    // 状态型（非本轮/本期已完/未开始/未开放/无目标）：只显示状态文案，无 √/×
    const statusReasons = ['非本轮', '本期已完', '未开始', '未开放', '无目标'];
    if (!p) { setRow(cn + ' 未开'); setBtn(type, null); return; }
    if (statusReasons.includes(p.reason)) { setRow(p.reason); setBtn(type, null); return; }
    if (p.target == null) { setRow(p.reason || (cn + ' 未开')); setBtn(type, null); return; }
    if (p.need == null || p.need <= 0) {
      // 已达标：√（参考/库存）
      const av = p.available != null ? fmt(p.available) : '?';
      setRow('√（' + fmt(p.reference) + '/' + av + '）', 'ok');
    } else {
      // 未达标：× 还差 N [原因]
      let t = '× 还差 ' + fmt(p.need);
      if (p.reason && p.reason !== '已达标') t += ' ' + p.reason;
      setRow(t, 'bad');
    }
    setBtn(type, p);
  };
  renderRow('relic'); renderRow('fish'); renderRow('gold');

  // 鱼献祭品级提示：显示当前勾选的可献祭品级，避免误以为会捐全部品级
  const sfp = s.perResource && s.perResource.fish;
  const fishTip = el('sf-fish-tip');
  if (fishTip) {
    const chosen = (Array.isArray(mon.sacrificeFishRarities) && mon.sacrificeFishRarities.length)
      ? mon.sacrificeFishRarities : ['uncommon'];
    fishTip.textContent = '只捐品级：' + chosen.map((r) => ({ common: '普通', uncommon: '罕见', fine: '精良', rare: '稀有', epic: '史诗' }[r] || r)).join('、');
    fishTip.title = '仅捐献勾选品级的鱼；只有 普通/罕见/精良/稀有/史诗 五档可献祭（传说+ 不可）。';
  }

  // 错误
  setTxt('sf-err', mon.lastSacrificeError || '无', mon.lastSacrificeError ? 'bad' : '');
}

// ---------- 世界Boss（读 monitor 的 m.worldBoss） ----------
const WB_CN = { strength: '力量', intelligence: '智力', luck: '运气', endurance: '耐力' };
const WB_STATUS_CN = { preparing: '准备中', active: '进行中', defeated: '已击败', ended: '已结束', fleeing: '逃逸中' };

function renderWorldBoss() {
  const mon = window.__monitorStatus || {};
  const w = mon.worldBoss;
  const setTxt = (id, t, cls) => { const e = el(id); if (e) { e.textContent = t; if (cls) e.className = cls; } };

  if (!w || !w.hasSession) {
    setTxt('wb-status', mon.lastWorldBossError ? '读取失败' : '暂无场次', mon.lastWorldBossError ? 'bad' : '');
    setTxt('wb-boss', '—'); setTxt('wb-selected', '—'); setTxt('wb-target', '—');
    setTxt('wb-auto', mon.worldBossAuto === false ? '⏸ 已关闭' : '✅ 启用');
    setTxt('wb-err', mon.lastWorldBossError || '无', mon.lastWorldBossError ? 'bad' : '');
    return;
  }
  const ok = w.status === 'preparing' || w.status === 'active';
  setTxt('wb-status', (WB_STATUS_CN[w.status] || w.status), ok ? 'ok' : (w.status === 'defeated' ? '' : 'bad'));
  setTxt('wb-boss', (w.boss.epithet ? w.boss.epithet + '·' : '') + w.boss.name);
  const sel = w.player.selectedStat;
  const selPct = w.player.multiplierPct != null ? ' ×' + w.player.multiplierPct + '%' : '';
  setTxt('wb-selected', sel ? (WB_CN[sel] || sel) + selPct : '未报名');
  const target = w.targetStat;
  const isWeak = w.boss && w.boss.weaknessStat === target;
  // 目标属性伤害期望明细（各属性 属性值×倍率 的期望值）
  let detail = '';
  if (w.expected) {
    detail = '（' + ['strength','intelligence','luck','endurance'].map(k => (WB_CN[k]||k) + '×' + w.expected[k]).join(' / ') + '）';
  }
  setTxt('wb-target', target ? (WB_CN[target] || target) + (isWeak ? ' ×200%(弱点)' : ' ×伤害最大') + detail : '—');

  // 自动报名状态
  const autoEl = el('wb-auto');
  if (mon.worldBossAuto === false) {
    autoEl.textContent = '⏸ 已关闭';
    autoEl.className = '';
    autoEl.title = '';
  } else {
    const a = mon.lastWorldBossAuto;
    const reasonMap = { 'no-session': '暂无场次', 'not-open': '未开放', 'locked': '已锁定', 'already-optimal': '已最优', 'no-target': '无目标属性', 'changed': '已报名', 'select-failed': '报名失败' };
    if (!a || !a.at) {
      autoEl.textContent = '✅ 启用';
      autoEl.className = 'ok';
      autoEl.title = '等待首次检查（每10分钟）';
    } else if (a.ok === true) {
      if (a.changed) {
        autoEl.textContent = '✅ 已报 ' + (WB_CN[a.targetStat] || a.targetStat);
        autoEl.className = 'ok';
      } else {
        autoEl.textContent = (a.reason === 'already-optimal' ? '✅ 已最优' : (reasonMap[a.reason] || '等待'));
        autoEl.className = a.reason === 'already-optimal' ? 'ok' : '';
      }
      autoEl.title = 'Boss ' + (a.boss || '') + ' · 目标 ' + (WB_CN[a.targetStat] || a.targetStat) + ' · ' + new Date(a.at).toLocaleTimeString();
    } else {
      autoEl.textContent = '❌ ' + (reasonMap[a.reason] || a.reason || '失败');
      autoEl.className = 'bad';
      autoEl.title = new Date(a.at).toLocaleTimeString();
    }
  }
  setTxt('wb-err', mon.lastWorldBossError || '无', mon.lastWorldBossError ? 'bad' : '');
}

// ---------- 自动开增益（读 monitor 的 m.autoBoost） ----------
const AB_BIOME_CN = { b_001:'月落溪谷', b_002:'雾语湿地', b_003:'镜潮海岸', b_004:'雷痕峡湾', b_005:'星根洞窟', b_006:'霞栖湖原', b_007:'云汐悬湖', b_008:'赤砂涌泉', b_009:'极昼冰湾', b_010:'沉钟古港', b_011:'翡翠洪林', b_012:'熔潮环礁', b_013:'天穹鲸海', b_014:'时镜回流', b_015:'星渊圣海' };
const AB_REASON_CN = { '优选-赛事':'优选·赛事', '优选-最优图':'优选·最优图', '优选图':'优选图' };
const AB_FAIL_CN = {
  'already-active':'已有增益未过期，未新开',
  'cooldown':'冷却中，暂未开',
  'weather-too-short':'天气剩余不足30分钟',
  'no-active-tournament':'无进行中赛事',
  'purchase-failed':'开增益失败',
  'no-data':'无数据',
  'locked':'正在处理中',
};

// 弹窗里直接切换「区域经验增益自动开启」开关：发消息给后台写 storage，随后重渲染
function setupAutoBoostControl() {
  const sw = el('ab-switch');
  if (!sw) return;
  sw.addEventListener('click', async () => {
    const now = (window.__monitorStatus || {}).guildBoostAuto;
    const target = now === false; // 当前关 → 开，否则关
    sw.textContent = '… 切换中';
    try {
      await browser.runtime.sendMessage({ type: 'reelax-toggle-guild-boost', enabled: target });
    } catch (e) { /* 忽略 */ }
    setTimeout(renderAutoBoost, 300);
  });
}

// 公会增益剩余秒级倒计时：HH:MM:SS（endsAt 非法/缺失返回 null）
function fmtCountdown(endAt) {
  if (endAt == null) return null;
  const end = (typeof endAt === 'number') ? endAt : Date.parse(endAt); // 兼容 ms 时间戳与 ISO 字符串
  if (!Number.isFinite(end)) return null;
  let sec = Math.max(0, Math.ceil((end - Date.now()) / 1000));
  const ss = String(sec % 60).padStart(2, '0');
  const mm = String(Math.floor(sec / 60) % 60).padStart(2, '0');
  const hh = String(Math.floor(sec / 3600)).padStart(2, '0');
  return hh + ':' + mm + ':' + ss;
}
// 每 1 秒刷新：
//   · #cs-guildboost：公会增益剩余倒计时
//   · #ab-poll-countdown：距下次「每5分钟巡检」剩余倒计时
//   · #ab-history：监测结果历史（最近10条）
let gbCountdownTimer = null;
function refreshBoostResultUI() {
  const mon = window.__monitorStatus || {};
  const pe = el('ab-poll-countdown');
  if (pe) {
    const next = mon.autoBoostPollNextAt;
    const cd = fmtCountdown(next);
    pe.textContent = cd != null ? ('剩 ' + cd) : '—';
  }
  const histEl = el('ab-history');
  if (histEl) {
    const hist = Array.isArray(mon.autoBoostHistory) ? mon.autoBoostHistory : [];
    if (!hist.length) {
      histEl.textContent = '暂无检查记录';
    } else {
      const lines = hist.slice(0, 10).map(function (h) {
        const t = new Date(h.at).toLocaleTimeString();
        const src = h.label || AB_REASON_CN[h.reason] || h.reason || '';
        const act = h.ok === true
          ? ('✅ ' + (src || '已开') + (h.units != null ? ' ' + h.units + '份' : ''))
          : ('✖ ' + (src ? src + '·' : '') + (AB_FAIL_CN[h.reason] || h.reason || 'check'));
        const hm = h.biomeId ? (' ' + (AB_BIOME_CN[h.biomeId] || h.biomeId)) : '';
        return t + ' ' + act + hm;
      });
      histEl.innerHTML = lines.join('<br>');
    }
  }
}
function startGuildBoostCountdown() {
  if (gbCountdownTimer) return;
  gbCountdownTimer = setInterval(() => {
    const mon = window.__monitorStatus || {};
    const cs = mon.currentStatus;
    // 公会增益剩余
    if (cs && cs.guildBoost && cs.guildBoost.isActive) {
      const e = el('cs-guildboost');
      if (e) {
        const cd = fmtCountdown(cs.guildBoost.endsAt);
        e.textContent = '🕒 剩 ' + (cd != null ? cd : (cs.guildBoost.remainingMin ? '剩' + cs.guildBoost.remainingMin : '—'));
      } else {
        el('cs-guildboost') && (el('cs-guildboost').textContent = '无');
      }
    }
    // 每次巡检后 handleAutoBoost 会更新 mon.autoBoost/autoBoostHistory；这里每 3s 刷新监测结果 + 历史
    refreshBoostResultUI();
  }, 1000);
}

function renderAutoBoost() {
  const mon = window.__monitorStatus || {};
  const a = mon.autoBoost;
  const setTxt = (id, t, cls) => { const e = el(id); if (e) { e.textContent = t; if (cls) e.className = cls; } };

  // 「公会增益监测倒计时」初始值：距下次每5分钟巡检剩余时间（之后由 startGuildBoostCountdown 每秒刷新）
  {
    const next = mon.autoBoostPollNextAt;
    const cd = fmtCountdown(next);
    setTxt('ab-poll-countdown', cd != null ? ('剩 ' + cd) : '—');
  }

  // 开关状态（区域经验增益自动开启），可点击切换
  const sw = el('ab-switch');
  if (sw) {
    sw.style.cursor = 'pointer';
    sw.title = '点击切换 区域经验增益自动开启（会写入设置并立即生效）';
    if (mon.guildBoostAuto === false) {
      sw.textContent = '⏸ 已关闭 · 点击开启';
      sw.className = '';
    } else {
      sw.textContent = '✅ 开启 · 点击关闭';
      sw.className = 'ok';
    }
  }

  // 当前状态总览（monitor.js refreshCurrentStatus 维护，30s 刷新）
  const cs = mon.currentStatus;
  if (cs && cs.currentBiome) {
    setTxt('cs-biome', (cs.currentBiome.name || cs.currentBiome.id || '—') + ' (' + (cs.currentBiome.id || '') + ')');
    if (cs.weather && cs.weather.name) {
      setTxt('cs-weather', (cs.weather.name || '—') + (cs.weather.remainingMin != null ? ' · 剩' + cs.weather.remainingMin : ''), cs.weather.weatherId === 'arcane_surge' ? 'ok' : '');
    } else {
      setTxt('cs-weather', '—');
    }
    if (cs.guildBoost && cs.guildBoost.isActive) {
      // 有增益：显示实时倒计时（秒级，由 startGuildBoostCountdown 每秒刷新）
      setTxt('cs-guildboost', '🕒 剩 ' + fmtCountdown(cs.guildBoost.endsAt), 'ok');
    } else {
      setTxt('cs-guildboost', '无', '');
    }
    if (cs.activeTournament) {
      const kindCn = cs.activeTournament.kind === 'guild' ? '工会赛' : (cs.activeTournament.kind === 'personal' ? '个人赛' : cs.activeTournament.kind);
      setTxt('cs-tournament', kindCn + ' #' + cs.activeTournament.sequence + ' · ' + (cs.activeTournament.biomeName || cs.activeTournament.biomeId || ''), 'bad');
    } else {
      setTxt('cs-tournament', '无', '');
    }
  } else {
    setTxt('cs-biome', '—'); setTxt('cs-weather', '—'); setTxt('cs-guildboost', '—'); setTxt('cs-tournament', '—');
  }

  if (!a || !a.at) {
    setTxt('ab-status', '—', '');
    setTxt('ab-last', '暂无记录', '');
    setTxt('ab-biome', '—', '');
    setTxt('ab-trigger', '—', '');
    setTxt('ab-at', '—', '');
    return;
  }
  // 状态：成功=✅ 已开 / 失败=❌ 原因
  if (a.ok === true) {
    setTxt('ab-status', '✅ 已开增益', 'ok');
    setTxt('ab-last', (a.units != null ? a.units + ' 份' : '') + (a.units != null && a.units * 30 >= 60 ? '（' + (a.units * 30 / 60) + 'h）' : ''), 'ok');
  } else {
    setTxt('ab-status', '❌ ' + (AB_FAIL_CN[a.reason] || a.reason || '未开'), 'bad');
    setTxt('ab-last', AB_FAIL_CN[a.reason] || a.reason || '—', 'bad');
  }
  const bName = a.biomeName || (a.biomeId ? (AB_BIOME_CN[a.biomeId] || a.biomeId) : '—');
  setTxt('ab-biome', (a.biomeId ? bName + ' (' + a.biomeId + ')' : '—'));
  // 触发来源标签优先取 a.label（openAutoBoost 里 reason 已改为存真实动作/失败码）
  setTxt('ab-trigger', a.label || AB_REASON_CN[a.reason] || a.reason || '—');
  setTxt('ab-at', new Date(a.at).toLocaleTimeString());

  // 历史（含未触发的 check）：最近 10 条
  const hist = Array.isArray(mon.autoBoostHistory) ? mon.autoBoostHistory : [];
  const histEl = el('ab-history');
  if (histEl) {
    if (!hist.length) {
      histEl.textContent = '暂无检查记录（等待聚合确定优选地图触发）';
    } else {
      const lines = hist.slice(0, 10).map(function (h) {
        const t = new Date(h.at).toLocaleTimeString();
        const src = h.label || AB_REASON_CN[h.reason] || h.reason || '';
        const act = h.ok === true
          ? ('✅ ' + (src || '已开') + (h.units != null ? ' ' + h.units + '份' : ''))
          : ('✖ ' + (src ? src + '·' : '') + (AB_FAIL_CN[h.reason] || h.reason || 'check'));
        const hm = h.biomeId ? (' ' + (AB_BIOME_CN[h.biomeId] || h.biomeId)) : '';
        return t + ' ' + act + hm;
      });
      histEl.innerHTML = lines.join('<br>');
    }
  }
}

// 一键贡献按钮
function setupSacrificeButtons() {
  const bind = (type, btnId) => {
    const btn = el(btnId);
    if (!btn) return;
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      const rEl = el('sf-result');
      if (rEl) { rEl.textContent = '提交中…'; rEl.className = ''; }
      try {
        const res = await browser.runtime.sendMessage({ type: 'reelax-sacrifice-contribute', resourceType: type });
        if (res && res.ok) {
          if (rEl) {
            if (type === 'fish' && Array.isArray(res.list) && res.list.length) {
              rEl.textContent = '✅ 已贡献 ' + (res.quantity != null ? Number(res.quantity).toLocaleString() : '') + ' 尾（' + res.list.map((i) => (i.cn || i.rarity) + '×' + i.quantity).join('、') + '）';
            } else {
              rEl.textContent = '✅ 已贡献 ' + (res.quantity != null ? Number(res.quantity).toLocaleString() : '');
            }
            rEl.className = 'ok';
          }
        } else {
          const why = (res && res.reason) || '失败';
          if (rEl) { rEl.textContent = '❌ ' + why; rEl.className = 'bad'; }
        }
        // 贡献后刷新展示
        try { await browser.runtime.sendMessage({ type: 'reelax-sacrifice-refresh' }); } catch (_) {}
        renderSacrifice();
      } catch (e) {
        if (rEl) { rEl.textContent = '❌ ' + String(e); rEl.className = 'bad'; }
      } finally {
        btn.disabled = false;
        renderSacrifice();
      }
    });
  };
  bind('relic', 'sf-btn-relic');
  bind('fish', 'sf-btn-fish');
  bind('gold', 'sf-btn-gold');
}

// 打开弹窗时刷新一次事件状态，保证数字最新
async function refreshSacrifice() {
  try {
    await browser.runtime.sendMessage({ type: 'reelax-sacrifice-refresh' });
  } catch (_) {}
  renderSacrifice();
}

async function refreshWorldBoss() {
  try {
    await browser.runtime.sendMessage({ type: 'reelax-worldboss-refresh' });
  } catch (_) {}
  renderWorldBoss();
}

async function refreshAutoBoost() {
  renderAutoBoost(); // 直接读 __monitorStatus.autoBoost（后台已实时写入）
}

// tab 切换：游戏 / 监控
function setupTabs() {
  const tabGame = document.getElementById('tab-game');
  const tabMonitor = document.getElementById('tab-monitor');
  const panelGame = document.getElementById('sync-status');
  const panelMonitor = document.getElementById('status');
  const panelAlloc = document.getElementById('alloc-panel');
  const panelSacrifice = document.getElementById('sacrifice-panel');
  const panelWorldBoss = document.getElementById('worldboss-panel');
  const panelAutoBoost = document.getElementById('autoboost-panel');
  const switchTo = (name) => {
    tabGame.classList.toggle('active', name === 'game');
    tabMonitor.classList.toggle('active', name === 'monitor');
    panelGame.hidden = name !== 'game';
    panelMonitor.hidden = name !== 'monitor';
    if (panelAlloc) panelAlloc.hidden = name !== 'game';
    if (panelSacrifice) panelSacrifice.hidden = name !== 'monitor';
    if (panelWorldBoss) panelWorldBoss.hidden = name !== 'monitor';
    if (panelAutoBoost) panelAutoBoost.hidden = name !== 'monitor';
  };
  tabGame.addEventListener('click', () => switchTo('game'));
  tabMonitor.addEventListener('click', () => switchTo('monitor'));
  switchTo('game'); // 默认显示游戏
}

document.addEventListener('DOMContentLoaded', () => {
  // 按钮先注册（不依赖任何异步数据，保证任何时候可点）
  const openBtn = document.getElementById('open');
  if (openBtn) {
    openBtn.addEventListener('click', async () => {
      try {
        const cfg = { ...DEFAULTS, ...(await browser.storage.local.get(DEFAULTS)) };
        // 已有目标页则激活，否则新建（避免重复开标签）
        const tabs = await browser.tabs.query({ url: cfg.targetUrl + '*' });
        if (tabs && tabs.length) {
          await browser.tabs.update(tabs[0].id, { active: true });
        } else {
          await browser.tabs.create({ url: cfg.targetUrl });
        }
      } catch (e) {
        console.error('[popup] 打开目标失败:', e);
      }
      window.close();
    });
  }

  const optBtn = document.getElementById('options');
  if (optBtn) {
    optBtn.addEventListener('click', () => {
      try { browser.runtime.openOptionsPage(); } catch (e) { console.error('[popup] 打开设置失败:', e); }
      window.close();
    });
  }

  // 异步初始化数据渲染（失败不阻塞按钮）
  (async () => {
    try {
      const cfg = { ...DEFAULTS, ...(await browser.storage.local.get(DEFAULTS)) };
      const urlEl = el('url');
      if (urlEl) urlEl.textContent = cfg.targetUrl;
    } catch (e) { console.error('[popup] 读取配置失败:', e); }

    // 读取后台 UI 状态快照。
    // Chrome MV3 下 Service Worker 会休眠，getBackgroundPage / 内存态不可靠，
    // 因此：① 优先发 reelax-ui-state 消息向后台实时拉取；② 失败/无响应则读 storage 兜底。
    const UI_STATE_KEY = 'reelax_ui_state';
    async function loadUiState() {
      try {
        const viaMsg = await browser.runtime.sendMessage({ type: 'reelax-ui-state' });
        if (viaMsg && (viaMsg.monitor || viaMsg.bridge)) return viaMsg;
      } catch (e) { /* SW 未响应，走 storage */ }
      try {
        const { [UI_STATE_KEY]: stored } = await browser.storage.local.get(UI_STATE_KEY);
        if (stored && (stored.monitor || stored.bridge)) return stored;
      } catch (e) { /* 忽略 */ }
      return null;
    }
    async function applyUiState() {
      const s = await loadUiState();
      window.__bridgeStatus = (s && s.bridge) || {};
      window.__monitorStatus = (s && s.monitor) || {};
      try {
        const bg = await browser.runtime.getBackgroundPage();
        window.__bridgeStatus = (bg && bg.__bridgeStatus) || window.__bridgeStatus;
        window.__monitorStatus = (bg && bg.__monitorStatus) || window.__monitorStatus;
      } catch (e) { /* 忽略 */ }
    }
    await applyUiState();
    setInterval(applyUiState, 3000); // 周期性刷新（后台每 1.5s 写 storage）

    renderStatus();
    renderMonitor();
    renderSync();
    renderPity();
    renderFishSell();
    renderGearWatch();
    setupFishSellControls();
    setupAutoBoostControl();
    startGuildBoostCountdown(); // 公会增益剩余秒级倒计时
    setupTabs();
    setupAllocControls();
    renderAlloc();
    refreshAllocPlan();
    setupSacrificeButtons();
    refreshSacrifice();
    refreshWorldBoss();
    renderAutoBoost();
    setInterval(renderStatus, 1000);
    setInterval(renderMonitor, 1000);
    setInterval(renderSync, 2000);
    setInterval(renderPity, 2000);
    setInterval(renderFishSell, 2000);
    setInterval(renderGearWatch, 2000);
    setInterval(renderAlloc, 1000);
    setInterval(refreshAllocPlan, 15000);
    setInterval(renderSacrifice, 5000);
    setInterval(renderWorldBoss, 5000);
    setInterval(renderAutoBoost, 2000);
  })();
});

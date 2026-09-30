// options.js —— 设置页逻辑

// 核心脚本（始终注入，不可关闭）：
//   日志收集.js —— 控制台日志落盘（诊断用）
//   自动登录.js —— 检测登录表单并自动登录
//   聚合.js     —— 右下角悬浮面板（自动地图切换/补满/签到等）
const MANDATORY_SCRIPTS = ['日志收集.js', '自动登录.js', '聚合.js'];

// 可选注入脚本（可在设置页勾选启停）。与 injector.js 的 ALL_SCRIPTS 保持一致。
// 描述字段仅用于界面展示。
const TOGGLEABLE_SCRIPTS = [
  { file: '自动出售库存.js', label: '自动出售库存（页面点击版，切到库存页卖鱼）' },
  { file: '自动补满次数.js', label: '杆数/次数自动补满（独立版）' },
  { file: '自动加点.js',     label: '自动加点（旧版，已迁移到后台 monitor，一般可关）' },
  { file: '保底显示.js',     label: '保底进度面板（页面展示保底计数）' },
  { file: '一键市场.js',     label: '一键市场（渔获页批量挂单出售 + 捡漏）' },
  { file: '以物易物价格.js', label: '以物易物价格（交换列表卡片显示市场最低价，点更新价格才会查询）' },
  { file: '装备属性占比.js', label: '装备属性占比（装备详情四维数值后显示各属性占总和百分比）' },
  { file: '装备初始价显示.js', label: '装备初始价显示（装备市场卡片上方显示 售价-强化累计 差价）' },
];
const ALL_SCRIPTS = MANDATORY_SCRIPTS.concat(TOGGLEABLE_SCRIPTS.map((s) => s.file));

const DEFAULTS = {
  targetUrl: 'https://reelax.cn/',
  autoOpenOnStartup: true,
  scriptFiles: [],
  enabledScripts: ['日志收集.js', '自动登录.js', '聚合.js', '自动补满次数.js', '自动加点.js', '保底显示.js', '一键市场.js', '装备属性占比.js'], // 启用的脚本（含强制+可选）；自动出售库存.js 默认关闭（页面版已失效）
  customCode: '',
  autoRefreshMin: 0,
  bridgePort: 55004,
  loginCheckMin: 5,
  monitorEnabled: true,
  offlineCheckMin: 2,
  proofCheckSec: 30,
  reloadCooldownSec: 60,
  webhookUrl: '',  // 企微 webhook 完整 URL；由 run.sh 依据环境变量 FISH_WEBHOOK 生成 scripts/webhook_config.js 注入
  feishuEnabled: false,        // 飞书通知开关
  feishuAppId: '',             // 飞书自建应用 App ID
  feishuAppSecret: '',         // 飞书自建应用 App Secret
  feishuReceiveIdType: 'open_id', // receive_id_type：open_id|user_id|email|chat_id|department_id
  feishuReceiveId: '',         // 接收人标识（如 open_id）
  autoAllocate: true,
  autoMastery: false,
  statTarget: 'luck',
  allocSecondary: 'luck',
  primaryTotalTarget: 0,
  pityMonitor: true,
  pityCheckSec: 300,
  pityHardMargin: 1000,
  pityTriggerArcane: false,
  pityTriggerExotic: false,
  pityTriggerSurgeOnly: false,
  pityTriggerTopBait: false,
fishAutoSell: true,
  fishSellRarity: 'uncommon',
  fishSellRarities: ['uncommon'],
  fishKeepMax: 20000,
  fishSellCheckSec: 600,
  gearAutoSell: true,
  gearSellRarities: ['common', 'uncommon', 'fine', 'rare', 'epic'],
  gearSellNotify: true,
  sacrificeAuto: true,
  sacrificeRelicPct: 0.5,       // 遗物参与门槛百分比（% of target）
  sacrificeFishPct: 0.5,        // 鱼分参与门槛百分比（% of target）
  sacrificeGoldPct: 0.5,        // 金币参与门槛百分比（% of target）
  sacrificeFishRarities: ['uncommon'],  // 鱼献祭只捐勾选品级（多选）；仅 common~epic 可献祭
  guildBoostAuto: true,
  worldBossAuto: true,
  sacrificeServerPct: 60,
  dailyReportWebhook: false, // 挂机日报 webhook 开关
  dailyReportTimes: '',      // 日报推送时间（北京时间，逗号分隔，如 09:30,18:30）
  gearWatchEnabled: false,   // 市场装备监测开关（10 分钟轮询）
  gearWatchRules: [          // 市场装备监测·多条需求单（每条独立监测市场价格）
    { name: '装备低价', rarity: 'exotic', slots: [], minQuality: 0, minUpgrade: 0, maxPrice: 0 },
  ],
  gearWatchCheckSec: 600,    // 市场装备监测·轮询间隔（秒，默认 10 分钟）
  gearWatchNotify: true,     // 市场装备监测·命中后 webhook 通知
};

const $ = (id) => document.getElementById(id);

function renderScriptList(enabledSet, mandatorySet) {
  const container = $('scriptList');
  container.innerHTML = '';
  if (TOGGLEABLE_SCRIPTS.length === 0) {
    container.innerHTML = '<p class="hint">（扩展内无可选脚本）</p>';
    return;
  }
  for (const item of TOGGLEABLE_SCRIPTS) {
    const label = document.createElement('label');
    label.className = 'script-item';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = item.file;
    cb.checked = enabledSet.has(item.file);
    label.appendChild(cb);
    label.appendChild(document.createTextNode(' ' + item.label));
    container.appendChild(label);
  }
}

async function load() {
  const cfg = { ...DEFAULTS, ...(await browser.storage.local.get(DEFAULTS)) };
  $('targetUrl').value = cfg.targetUrl;
  $('autoOpen').checked = !!cfg.autoOpenOnStartup;
  $('customCode').value = cfg.customCode || '';
  $('autoRefreshMin').value = cfg.autoRefreshMin || 0;
  $('bridgePort').value = cfg.bridgePort || 55004;
  $('loginCheckMin').value = cfg.loginCheckMin != null ? cfg.loginCheckMin : 5;
  $('monitorEnabled').checked = cfg.monitorEnabled !== false;
  $('offlineCheckMin').value = cfg.offlineCheckMin || 2;
  $('proofCheckSec').value = cfg.proofCheckSec || 30;
  $('reloadCooldownSec').value = cfg.reloadCooldownSec || 60;
  $('webhookUrl').value = cfg.webhookUrl || '';
  $('feishuEnabled').checked = !!cfg.feishuEnabled;
  $('feishuAppId').value = cfg.feishuAppId || '';
  $('feishuAppSecret').value = cfg.feishuAppSecret || '';
  $('feishuReceiveIdType').value = cfg.feishuReceiveIdType || 'open_id';
  $('feishuReceiveId').value = cfg.feishuReceiveId || '';
  $('autoAllocate').checked = cfg.autoAllocate !== false;
  $('autoMastery').checked = cfg.autoMastery !== false;
  $('statTarget').value = cfg.statTarget || 'luck';
  $('allocSecondary').value = cfg.allocSecondary || 'luck';
  $('primaryTotalTarget').value = cfg.primaryTotalTarget != null ? cfg.primaryTotalTarget : 0;
  $('pityMonitor').checked = cfg.pityMonitor !== false;
  $('pityCheckSec').value = cfg.pityCheckSec != null ? cfg.pityCheckSec : 300;
  $('pityHardMargin').value = cfg.pityHardMargin != null ? cfg.pityHardMargin : 1000;
  $('pityTriggerArcane').checked = cfg.pityTriggerArcane === true;
  $('pityTriggerExotic').checked = cfg.pityTriggerExotic === true;
  $('pityTriggerSurgeOnly').checked = cfg.pityTriggerSurgeOnly === true;
  $('pityTriggerTopBait').checked = cfg.pityTriggerTopBait === true;
  $('fishAutoSell').checked = cfg.fishAutoSell !== false;
  const fishRars = (Array.isArray(cfg.fishSellRarities) && cfg.fishSellRarities.length)
    ? cfg.fishSellRarities
    : ((cfg.fishSellRarity) ? [cfg.fishSellRarity] : ['common', 'uncommon', 'fine', 'rare', 'epic']);
  for (const r of ['common', 'uncommon', 'fine', 'rare', 'epic']) {
    const el = document.querySelector(`[data-fishsell-${r}]`);
    if (el) el.checked = fishRars.includes(r);
  }
  $('fishKeepMax').value = cfg.fishKeepMax != null ? cfg.fishKeepMax : 20000;
  $('fishSellCheckSec').value = cfg.fishSellCheckSec != null ? cfg.fishSellCheckSec : 600;
  $('gearAutoSell').checked = cfg.gearAutoSell !== false;
  $('gearSellNotify').checked = cfg.gearSellNotify !== false;
  for (const r of ['common', 'uncommon', 'fine', 'rare', 'epic', 'legendary']) {
    const el = document.querySelector(`[data-gearsell-${r}]`);
    if (el) el.checked = (Array.isArray(cfg.gearSellRarities) ? cfg.gearSellRarities : ['common','uncommon','fine','rare','epic']).includes(r);
  }
  $('sacrificeAuto').checked = cfg.sacrificeAuto !== false;
  $('sacrificeServerPct').value = cfg.sacrificeServerPct != null ? cfg.sacrificeServerPct : 60;
  $('sacrificeRelicPct').value = cfg.sacrificeRelicPct != null ? cfg.sacrificeRelicPct : 0.5;
  $('sacrificeFishPct').value = cfg.sacrificeFishPct != null ? cfg.sacrificeFishPct : 0.5;
  $('sacrificeGoldPct').value = cfg.sacrificeGoldPct != null ? cfg.sacrificeGoldPct : 0.5;
  for (const r of ['common', 'uncommon', 'fine', 'rare', 'epic']) {
    const el = document.querySelector(`[data-sacrificefish-${r}]`);
    if (el) el.checked = (Array.isArray(cfg.sacrificeFishRarities) ? cfg.sacrificeFishRarities : ['uncommon']).includes(r);
  }
  $('guildBoostAuto').checked = cfg.guildBoostAuto !== false;
  $('worldBossAuto').checked = cfg.worldBossAuto !== false;
  $('dailyReportWebhook').checked = !!cfg.dailyReportWebhook;
  $('dailyReportTimes').value = cfg.dailyReportTimes || '';
  // ---- 市场装备监测 ----
  $('gearWatchEnabled').checked = cfg.gearWatchEnabled === true;
  $('gearWatchCheckSec').value = cfg.gearWatchCheckSec != null ? cfg.gearWatchCheckSec : 600;
  $('gearWatchNotify').checked = cfg.gearWatchNotify !== false;
  renderGearWatchRules(Array.isArray(cfg.gearWatchRules) ? cfg.gearWatchRules : []);

  // 可选脚本勾选态；强制脚本始终启用，不计入可开关集合
  const enabledList = Array.isArray(cfg.enabledScripts) ? cfg.enabledScripts : [];
  const enabledSet = new Set(ALL_SCRIPTS.filter((n) => enabledList.includes(n) || MANDATORY_SCRIPTS.includes(n)));
  renderScriptList(enabledSet, new Set(MANDATORY_SCRIPTS));

  // 兼容旧配置：scriptFiles 里曾是「额外脚本文本框」填的值，合并进来作为启用
  const legacyExtra = (Array.isArray(cfg.scriptFiles) ? cfg.scriptFiles : []);
  $('extraScripts').value = legacyExtra.join('\n');
}

function save() {
  const checked = Array.from(
    document.querySelectorAll('#scriptList input[type="checkbox"]:checked'),
  ).map((cb) => cb.value);

  const extraText = $('extraScripts').value.trim();
  const extra = extraText
    ? extraText
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

  // enabledScripts = 强制脚本 + 勾选的可选脚本 + 文本框手填的额外脚本
  const enabledScripts = Array.from(new Set([
    ...MANDATORY_SCRIPTS,
    ...checked,
    ...extra.filter((n) => !MANDATORY_SCRIPTS.includes(n)),
  ]));

  const cfg = {
    targetUrl: $('targetUrl').value.trim() || DEFAULTS.targetUrl,
    autoOpenOnStartup: $('autoOpen').checked,
    scriptFiles: extra, // 兼容旧字段：文本框内容
    enabledScripts,
    customCode: $('customCode').value,
    autoRefreshMin: Number($('autoRefreshMin').value) || 0,
    bridgePort: Number($('bridgePort').value) || 55004,
    loginCheckMin: Number($('loginCheckMin').value),
    monitorEnabled: $('monitorEnabled').checked,
    offlineCheckMin: Number($('offlineCheckMin').value) || 2,
    proofCheckSec: Number($('proofCheckSec').value) || 30,
    reloadCooldownSec: Number($('reloadCooldownSec').value) || 60,
    webhookUrl: $('webhookUrl').value.trim(),
    feishuEnabled: $('feishuEnabled').checked,
    feishuAppId: $('feishuAppId').value.trim(),
    feishuAppSecret: $('feishuAppSecret').value.trim(),
    feishuReceiveIdType: $('feishuReceiveIdType').value,
    feishuReceiveId: $('feishuReceiveId').value.trim(),
    autoAllocate: $('autoAllocate').checked,
    autoMastery: $('autoMastery').checked,
    statTarget: $('statTarget').value,
    allocSecondary: $('allocSecondary').value,
    primaryTotalTarget: Number($('primaryTotalTarget').value) >= 0 ? Number($('primaryTotalTarget').value) : 0,
    pityMonitor: $('pityMonitor').checked,
    pityCheckSec: Number($('pityCheckSec').value) || 300,
    pityHardMargin: Number($('pityHardMargin').value) >= 0 ? Number($('pityHardMargin').value) : 1000,
    pityTriggerArcane: $('pityTriggerArcane').checked,
    pityTriggerExotic: $('pityTriggerExotic').checked,
    pityTriggerSurgeOnly: $('pityTriggerSurgeOnly').checked,
    pityTriggerTopBait: $('pityTriggerTopBait').checked,
    fishAutoSell: $('fishAutoSell').checked,
    fishSellRarities: ['common', 'uncommon', 'fine', 'rare', 'epic'].filter(
      (r) => document.querySelector(`[data-fishsell-${r}]`)?.checked,),
    fishKeepMax: Number($('fishKeepMax').value) >= 0 ? Number($('fishKeepMax').value) : 20000,
    fishSellCheckSec: Number($('fishSellCheckSec').value) >= 60 ? Number($('fishSellCheckSec').value) : 600,
    gearAutoSell: $('gearAutoSell').checked,
    gearSellNotify: $('gearSellNotify').checked,
    gearSellRarities: ['common', 'uncommon', 'fine', 'rare', 'epic', 'legendary'].filter(
      (r) => document.querySelector(`[data-gearsell-${r}]`)?.checked,
    ),
    sacrificeAuto: $('sacrificeAuto').checked,
    sacrificeServerPct: Number($('sacrificeServerPct').value) >= 0 ? Number($('sacrificeServerPct').value) : 60,
    sacrificeRelicPct: Number($('sacrificeRelicPct').value) >= 0 ? Number($('sacrificeRelicPct').value) : 0.5,
    sacrificeFishPct: Number($('sacrificeFishPct').value) >= 0 ? Number($('sacrificeFishPct').value) : 0.5,
    sacrificeGoldPct: Number($('sacrificeGoldPct').value) >= 0 ? Number($('sacrificeGoldPct').value) : 0.5,
    sacrificeFishRarities: ['common', 'uncommon', 'fine', 'rare', 'epic'].filter(
      (r) => document.querySelector(`[data-sacrificefish-${r}]`)?.checked,),
    guildBoostAuto: $('guildBoostAuto').checked,
    worldBossAuto: $('worldBossAuto').checked,
    dailyReportWebhook: $('dailyReportWebhook').checked,
    dailyReportTimes: $('dailyReportTimes').value.trim(),
    gearWatchEnabled: $('gearWatchEnabled').checked,
    gearWatchRules: collectGearWatchRules(),
    gearWatchCheckSec: Number($('gearWatchCheckSec').value) >= 60 ? Number($('gearWatchCheckSec').value) : 600,
    gearWatchNotify: $('gearWatchNotify').checked,
  };

  browser.storage.local.set(cfg).then(() => {
    const s = $('status');
    s.textContent = '已保存 ✓';
    setTimeout(() => (s.textContent = ''), 2000);
  });
}

async function testNotify() {
  const out = $('notifyResult');
  out.textContent = '发送中…';
  try {
    // 先把当前表单里的通知配置写进 storage，后台 monitor 再重载配置并发送，保证用到的
    // 是最新的（即使还没点「保存」）。
    const cfg = {
      webhookUrl: $('webhookUrl').value.trim(),
      feishuEnabled: $('feishuEnabled').checked,
      feishuAppId: $('feishuAppId').value.trim(),
      feishuAppSecret: $('feishuAppSecret').value.trim(),
      feishuReceiveIdType: $('feishuReceiveIdType').value,
      feishuReceiveId: $('feishuReceiveId').value.trim(),
    };
    await browser.storage.local.set(cfg);
    const res = await browser.runtime.sendMessage({ type: 'reelax-test-notify' });
    const ok = !!(res && res.ok);
    const via = res && res.via ? ('（' + res.via + '）') : '';
    out.textContent = ok ? ('✓ 已发送' + via) : ('✗ 发送失败: ' + ((res && res.error) || '无响应'));
    out.style.color = ok ? '#2e7d32' : '#c62828';
  } catch (e) {
    out.textContent = '✗ 发送失败: ' + (e && e.message ? e.message : e);
    out.style.color = '#c62828';
  }
}

// ---- 市场装备监测·多条需求单（模块级，供 load/save 调用）：动态渲染列表卡 + 收集 ----
const GEAR_RARITY_CN_M = { common: '普通', uncommon: '罕见', fine: '精良', rare: '稀有', epic: '史诗', legendary: '传说', mythic: '神话', exotic: '奇异', arcane: '奥秘' };
const GEAR_SLOT_OPTIONS_M = [
  ['head', '头冠'], ['chest', '上衣'], ['legs', '绑腿'], ['boots', '靴子'],
  ['gloves', '手套'], ['ring', '戒指'], ['amulet', '项链'], ['charm', '护符'],
];

function gearWatchContainer() { return $('gearWatchRulesContainer'); }

function gearWatchRowHtml(rule, idx) {
  const r = rule || {};
  const raritySel = Object.keys(GEAR_RARITY_CN_M).map((k) =>
    `<option value="${k}" ${r.rarity === k ? 'selected' : ''}>${GEAR_RARITY_CN_M[k]}</option>`).join('');
  const slotCbs = GEAR_SLOT_OPTIONS_M.map(([s, cn]) =>
    `<label style="margin-right:10px;"><input type="checkbox" data-gw-slot="${s}" ${(r.slots || []).includes(s) ? 'checked' : ''}/>${cn}</label>`).join('');
  const inputStyle = 'padding:4px 6px;border:1px solid #ccc;border-radius:6px;';
  return `
    <div class="gearwatch-rule" data-idx="${idx}" style="border:1px solid #ddd;border-radius:8px;padding:10px 12px;margin-bottom:10px;background:#fff;">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px;">
        <input type="text" data-gw-name placeholder="需求单名（如 低价戒指）" value="${(r.name || '').replace(/"/g, '&quot;')}" style="${inputStyle}width:200px;" />
        <label>品级：<select data-gw-rarity style="${inputStyle}">${raritySel}</select></label>
        <button type="button" data-gw-del style="margin-left:auto;background:#e74c3c;color:#fff;border:none;border-radius:6px;padding:5px 10px;cursor:pointer;">删除</button>
      </div>
      <div style="margin-bottom:6px;">部位（勾选才监控；不勾=全部）：<span style="display:inline-flex;flex-wrap:wrap;gap:4px;">${slotCbs}</span></div>
      <div style="display:flex;gap:12px;flex-wrap:wrap;">
        <label>最低品质：<input type="number" data-gw-q min="0" max="100" step="1" value="${r.minQuality || 0}" style="${inputStyle}width:70px;" /></label>
        <label>最低强化：<input type="number" data-gw-up min="0" max="20" step="1" value="${r.minUpgrade || 0}" style="${inputStyle}width:70px;" /></label>
        <label>最高期望价（含本数，0=不限）：<input type="number" data-gw-price min="0" step="1" value="${r.maxPrice || 0}" style="${inputStyle}width:130px;" /></label>
      </div>
    </div>`;
}

function renderGearWatchRules(rules) {
  const c = gearWatchContainer();
  if (!c) return;
  const list = rules && rules.length ? rules : [{ name: '装备低价', rarity: 'exotic', slots: [], minQuality: 0, minUpgrade: 0, maxPrice: 0 }];
  c.innerHTML = list.map((r, i) => gearWatchRowHtml(r, i)).join('');
  c.querySelectorAll('[data-gw-del]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const row = btn.closest('.gearwatch-rule');
      if (row) row.remove();
    });
  });
}

function collectGearWatchRules() {
  const c = gearWatchContainer();
  if (!c) return [];
  return Array.from(c.querySelectorAll('.gearwatch-rule')).map((row) => ({
    name: (row.querySelector('[data-gw-name]').value || '').trim() || '需求单',
    rarity: row.querySelector('[data-gw-rarity]').value || '',
    slots: Array.from(row.querySelectorAll('input[data-gw-slot]:checked')).map((cb) => cb.dataset.gwSlot),
    minQuality: Number(row.querySelector('[data-gw-q]').value) >= 0 ? Number(row.querySelector('[data-gw-q]').value) : 0,
    minUpgrade: Number(row.querySelector('[data-gw-up]').value) >= 0 ? Number(row.querySelector('[data-gw-up]').value) : 0,
    maxPrice: Number(row.querySelector('[data-gw-price]').value) > 0 ? Number(row.querySelector('[data-gw-price]').value) : 0,
  })).filter((r) => r.rarity || r.slots.length || r.maxPrice || r.minQuality || r.minUpgrade);
}

document.addEventListener('DOMContentLoaded', () => {
  $('save').addEventListener('click', save);
  $('testNotify').addEventListener('click', testNotify);
  load();

  // 鱼自动出售（API 版）：勾选稀有度/保留上限/间隔改动即自动保存，
  // 免去每次点「保存」；重载插件/刷新设置页后仍保持所选。
  const autoSaveFish = () => {
    const patch = {
      fishAutoSell: $('fishAutoSell').checked,
      fishSellRarities: ['common', 'uncommon', 'fine', 'rare', 'epic'].filter(
        (r) => document.querySelector(`[data-fishsell-${r}]`)?.checked),
      fishKeepMax: Number($('fishKeepMax').value) >= 0 ? Number($('fishKeepMax').value) : 20000,
      fishSellCheckSec: Number($('fishSellCheckSec').value) >= 60 ? Number($('fishSellCheckSec').value) : 600,
    };
    browser.storage.local.get().then((cur) => browser.storage.local.set({ ...cur, ...patch }));
  };
  const fishFieldset = $('fishKeepMax') ? $('fishKeepMax').closest('fieldset') : null;
  if (fishFieldset) {
    fishFieldset.addEventListener('change', () => autoSaveFish());
    fishFieldset.addEventListener('input', (e) => { if (e.target && ['fishKeepMax', 'fishSellCheckSec'].includes(e.target.id)) autoSaveFish(); });
  }

  // 「添加需求单」按钮（renderGearWatchRules/collectGearWatchRules 在模块顶层定义）
  const addBtn = $('gearWatchAddRule');
  if (addBtn) {
    addBtn.addEventListener('click', () => {
      const c = gearWatchContainer();
      if (!c) return;
      const div = document.createElement('div');
      div.innerHTML = gearWatchRowHtml({ name: '', rarity: 'exotic', slots: [], minQuality: 0, minUpgrade: 0, maxPrice: 0 }, c.children.length);
      const row = div.firstElementChild;
      c.appendChild(row);
      row.querySelector('[data-gw-del]').addEventListener('click', () => row.remove());
    });
  }
});

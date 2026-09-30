// monitor.js —— Reelax 助手扩展后台监控模块
//
// 职责（统一由扩展接管在线监控，页面脚本不再各自刷新）：
//   1. 心跳监控：webRequest 监听 reelax.cn 的 fishing/sync|state 请求，作为游戏在线心跳
//   2. proof 自动验证（双通道）：
//      - 被动：任何 /api 响应头里的 x-arcane-request-proof 实时捕获
//      - 主动：每 proofCheckSec（默认 30s）fetch /api/me 验证登录态并刷新 proof
//   3. 掉线检测：超过 offlineCheckMin 分钟无心跳 → 刷新所有 reelax.cn 标签页恢复
//   4. 登录失效检测：/api/me 非 200 → 刷新标签页恢复登录态
//
// 刷新带冷却（reloadCooldownSec），防止掉线死循环反复刷新。
// 状态挂到 window.__monitorStatus，供 popup 读取展示。

const MONITOR_DEFAULTS = {
  monitorEnabled: true,   // 监控总开关
  offlineCheckMin: 2,     // 掉线阈值（分钟）
  proofCheckSec: 30,      // 登录态/proof 主动验证间隔（秒）
  reloadCooldownSec: 60,  // 刷新冷却（秒）
  webhookUrl: '',  // 企微 webhook 完整 URL；由 run.sh 依据环境变量 FISH_WEBHOOK 写入 login_credentials.js，后台 fetch 读取
  feishuEnabled: false,      // 飞书通知开关（开启后优先用飞书应用发送；仍保留企微）
  feishuAppId: '',           // 飞书自建应用 App ID
  feishuAppSecret: '',       // 飞书自建应用 App Secret
  feishuReceiveIdType: 'open_id', // 接收人标识类型：open_id | user_id | email | chat_id | department_id
  feishuReceiveId: '',       // 接收人标识（如 open_id）
  autoAllocate: true,     // 自动加点（检测 unspentStatPoints>0 自动分配）
  statTarget: 'luck',         // 加点目标属性（主属性）：strength/intelligence/luck/endurance
  primaryTotalTarget: 0,      // 主属性总计阈值：主属性总计达到该值后，剩余点数分给副属性；0=不启用（全加主属性，保持旧行为）
  allocStrategy: 'manual',   // 加点策略：manual=沿用 statTarget；competition=比赛专用(开始全运气/结束赛后加点)
  strengthTarget: 10500,     // 赛后目标总力量（total 已含图腾3%等倍率加成，无需手动扣减）
  allocSecondary: 'luck',     // 赛后剩余点数投入的属性
  enduranceBase: 0,          // 赛后保留的耐力 base 点数（计算用，不实际分配；0=全部点数投力量+运气）
  compAutoRespec: false,    // 公会赛比赛自动洗点开关（开始全运气 / 结束赛后加点）；默认关，需要时手动开启
  compPersonalRespec: false, // 个人赛比赛自动洗点（同公会赛逻辑，对 /api/tournaments/overview 的个人赛生效）；默认关
  gearAutoSell: true,        // 装备自动出售（API 版，每 6 分钟卖出所选品级）
  gearSellRarities: ['common', 'uncommon', 'fine', 'rare', 'epic'], // 装备自动出售的品级白名单（默认普通~史诗，留传说+）
  gearSellNotify: true,      // 装备自动出售后是否发 webhook 通知
  fishAutoSell: true,        // 鱼自动出售（API 版：只卖指定稀有度的鱼，超过 keep 上限的部分才卖）
  fishSellRarity: 'uncommon',// （兼容旧配置/旧弹窗展示）单稀有度，_legacy→归一进 fishSellRarities
  fishSellRarities: ['uncommon'],// 自动出售的鱼稀有度白名单（多选：仅对勾选稀有度各自保留上限、卖出超出部分）
  fishKeepMax: 20000,        // 该稀有度鱼总数超过该值时，卖出超过的部分（保留此数量作库存）
  fishSellCheckSec: 600,     // 鱼自动出售检查间隔（秒，默认 10 分钟）
  autoMastery: false,     // 自动加专精（默认关，改成手动决定；每 10 分钟把当前地图专精点全部投入）
  pityMonitor: true,      // 保底监控（查 /api/statistics 的 pity 字段）
  pityCheckSec: 300,      // 保底检查间隔（秒）：出货通知按 rarities.fishCaught 差值触发（累计计数差值在任意间隔下都不漏），300s 足够且省请求
  pityHardMargin: 1000,   // 距硬保底 ≤ 该杆数时发 webhook 通知
  pityTriggerArcane: false, // 保底触发·奥秘：非全运气时杆数≥全运气硬保底基准(ref) 洗点全加运气，直到奥秘出货才洗回
  pityTriggerExotic: false, // 保底触发·奇异：同上，针对奇异；两开关任一在等就保持全运气，最后的那个出了才洗回
  pityTriggerSurgeOnly: false, // 保底触发·仅在奥秘涌流期间触发：开启后保底触发只在涌流(surge)生效时跑，涌流结束自动洗回
  pityTriggerTopBait: false, // 保底触发·自动用顶级饵：开启后洗点期间自动换顶级饵(bait_supreme)，库存为0自动买100个，买不起则用当前设定饵；功能关闭/洗回时恢复开启前饵
  sacrificeAuto: true,    // 奥术献祭自动贡献：每天 10:01 触发首轮，11:30 探测第二轮开轮时间并自动排定，全服进度达阈值后才自动贡献到参与门槛
  sacrificeServerPct: 60, // 全服进度百分比阈值：超过才自动贡献（progress/target）
  sacrificeRelicPct: 0.5, // 遗物参与门槛百分比（占该轮目标 target 的 %）
  sacrificeFishPct: 0.5,  // 鱼分参与门槛百分比（占该轮目标 target 的 %）
  sacrificeGoldPct: 0.5,  // 金币参与门槛百分比（占该轮目标 target 的 %）
  sacrificeFishRarities: ['uncommon'], // 鱼献祭只捐勾选品级（多选）；仅 common~epic 可献祭
  guildBoostAuto: true,   // 区域经验增益自动开启（公会增益）：由聚合优选地图通知驱动自动开
  worldBossAuto: true,    // 世界Boss自动报名：每 10 分钟检测，按「各属性 属性值×倍率」伤害最大化报名/改选（弱点×200%仅在该属性实际数值最高时才会被选中）
  dailyReportWebhook: false, // 挂机日报 webhook 开关（开启后在指定北京时报若干推送当日日报摘要）
  dailyReportTimes: '',      // 日报推送时间（北京时，24h，多个用英文逗号分隔），如 "09:30,18:30"；空=不推送
  gearWatchEnabled: false,    // 市场装备监测开关（10 分钟轮询；命中任意需求单 → webhook 通知）
  gearWatchRules: [           // 市场装备监测·多条需求单（每条独立监测市场价格）
    { name: '装备低价', rarity: 'exotic', slots: [], minQuality: 0, minUpgrade: 0, maxPrice: 0 },
  ],
  gearWatchCheckSec: 600,     // 市场装备监测·轮询间隔（秒，默认 10 分钟）
  gearWatchNotify: true,      // 市场装备监测·命中后是否 webhook 通知
};

const m = window.__monitorStatus = {
  enabled: MONITOR_DEFAULTS.monitorEnabled,
  lastActivityAt: null,   // 最近一次 fishing/sync|state 心跳时间
  activityCount: 0,       // 累计心跳数
  idleSec: null,          // 当前空闲秒数（每 15s 刷新）
  offlineTotalSec: 0,     // 总失联合计（秒，只增不清零）
  pageReloadCount: 0,     // 页面刷新总次数（含用户手动 F5 与扩展自动刷新）
  urlHistory: [],         // 最近 URL 切换记录 [{url, ts}]（最多 20 条）
  urlCount: {},           // 各路径累计切换次数 {path: count}（如 '/fishing': 5）
  offlineCheckMin: MONITOR_DEFAULTS.offlineCheckMin,
  loginOk: null,          // 最近 /api/me 结果
  proofOk: null,          // proof 是否有效
  proofUpdatedAt: null,   // proof 最近更新时间（主动或被动）
  proofCheckSec: MONITOR_DEFAULTS.proofCheckSec,
  reloadCooldownSec: MONITOR_DEFAULTS.reloadCooldownSec,
  lastReloadAt: null,     // 最近一次刷新时间
  reloadCount: 0,         // 累计刷新次数
  lastReloadReason: null, // 最近刷新原因（'offline'|'login'）
  lastError: null,
  sync: null,             // 最近一次 fishing/sync 响应的精选字段
  webhookUrl: MONITOR_DEFAULTS.webhookUrl, // 企微 webhook（扩展统一发通知）
  feishuEnabled: MONITOR_DEFAULTS.feishuEnabled,   // 飞书通知开关
  feishuAppId: MONITOR_DEFAULTS.feishuAppId,       // 飞书 App ID
  feishuAppSecret: MONITOR_DEFAULTS.feishuAppSecret, // 飞书 App Secret
  feishuReceiveIdType: MONITOR_DEFAULTS.feishuReceiveIdType, // receive_id_type
  feishuReceiveId: MONITOR_DEFAULTS.feishuReceiveId, // 接收人 open_id/user_id 等
  autoAllocate: MONITOR_DEFAULTS.autoAllocate, // 自动加点开关
  statTarget: MONITOR_DEFAULTS.statTarget,     // 加点目标属性
  primaryTotalTarget: MONITOR_DEFAULTS.primaryTotalTarget, // 主属性总计阈值（达后分给副属性）
  allocStrategy: MONITOR_DEFAULTS.allocStrategy,
  strengthTarget: MONITOR_DEFAULTS.strengthTarget,
  allocSecondary: MONITOR_DEFAULTS.allocSecondary,
  enduranceBase: MONITOR_DEFAULTS.enduranceBase,
  compAutoRespec: MONITOR_DEFAULTS.compAutoRespec,
  compPersonalRespec: MONITOR_DEFAULTS.compPersonalRespec,
  compActive: false,           // 当前是否处于比赛（复用游戏比赛状态，公会赛或个人赛任一进行中即真）
  compPersonalActive: false,   // 个人赛是否进行中
  lastRespecResult: null,      // 赛前/赛后洗点结果 {ok, phase, at, body/plan}
  lastRegisterResult: null,    // 赛事一键报名结果 {ok, at}
  gearAutoSell: MONITOR_DEFAULTS.gearAutoSell, // 装备自动出售开关
  gearSellRarities: MONITOR_DEFAULTS.gearSellRarities, // 装备自动出售品级白名单
  gearSellNotify: MONITOR_DEFAULTS.gearSellNotify,     // 装备自动出售后的 webhook 通知开关
  lastGearSell: null,          // 最近装备出售结果 {ok, sold, count, at}
  fishAutoSell: MONITOR_DEFAULTS.fishAutoSell,   // 鱼自动出售开关
  fishSellRarity: MONITOR_DEFAULTS.fishSellRarity, // 兼容旧值（单）
  fishSellRarities: MONITOR_DEFAULTS.fishSellRarities, // 鱼自动出售稀有度白名单（多选）
  fishKeepMax: MONITOR_DEFAULTS.fishKeepMax,       // 保留的鱼数量上限
  fishSellCheckSec: MONITOR_DEFAULTS.fishSellCheckSec, // 检查间隔（秒）
  fishSell: null,              // 最近一次鱼自动出售结果 {ok, reason, sold, total, kept, checkedAt, at}
  fishSoldTotal: 0,            // 累计已售出鱼条数（本次会话累计，只增不清零）
  fishSellChecks: 0,           // 鱼自动出售已执行的检查轮次计数（含未超上限；弹窗用来看循环是否在跑）
  autoMastery: MONITOR_DEFAULTS.autoMastery,   // 自动加专精开关
  lastAllocateAt: 0,     // 最近一次加点尝试时间（节流）
  lastAllocateResult: null, // 最近加点结果 {ok, reason, status, added, at}
  lastMasteryResult: null,  // 最近加专精结果 {ok, reason, status, mapId, at}
  pityMonitor: MONITOR_DEFAULTS.pityMonitor, // 保底监控开关
  pityCheckSec: MONITOR_DEFAULTS.pityCheckSec, // 保底检查间隔（秒）
  pityHardMargin: MONITOR_DEFAULTS.pityHardMargin, // 距硬保底通知余量（杆）
  pityTriggerArcane: MONITOR_DEFAULTS.pityTriggerArcane, // 保底触发·奥秘开关
  pityTriggerExotic: MONITOR_DEFAULTS.pityTriggerExotic, // 保底触发·奇异开关
  pityTriggerSurgeOnly: MONITOR_DEFAULTS.pityTriggerSurgeOnly, // 保底触发·仅涌流触发开关
  pityTriggerTopBait: MONITOR_DEFAULTS.pityTriggerTopBait, // 保底触发·自动用顶级饵开关
pityTrigger: {          // 保底触发运行时状态机（见 evaluatePityTrigger）
    active: false,        // 当前处于「洗点全加运气」锁定（等出货）
    pending: false,       // 洗点/洗回/建基 API 进行中（防并发）
    armed: { arcane: false, exotic: false }, // 各类型是否「已达标(≥全运气硬保底)且尚未出货」（出货即解除）
    ref: {                // 全加运气状态下的硬保底杆数基准（持久化，见 buildRefBaseline/updateRefFromStats）
      arcane: null,       // 全运气时奥秘 hardPityCasts
      exotic: null,       // 全运气时奇异 hardPityCasts
      built: false,       // 是否已建立过基准
      builtAt: null,      // 最近一次基准建立/更新时间
    },
    preBait: null,        // 洗点触发前记录的原装备饵（洗回时恢复；仅 pityTriggerTopBait 时用到）
    savedFlatBonus: null, // 洗点前记录的 flatBonusStrength（洗回时用 computeStatPlan）
    savedTotalPts: null,  // 洗点时的总可分配点
    washedAt: null,       // 最近一次洗点时间
    restoredAt: null,     // 最近一次洗回时间
  },
  pity: null,             // 最近一次保底状态（见 checkPity）
  lastPityError: null,    // 最近保底检查错误
  statsRarities: null,    // 最近 /api/statistics 的 rarities 各稀有度累计渔获数（{exotic,arcane,serverTime,at}），用于日报按差值算当日出货
  arcaneSacrifice: null,  // 奥术献祭事件状态+贡献方案（见 checkSacrifice）
  lastSacrificeError: null, // 最近奥术献祭检查/贡献错误
  sacrificeAuto: MONITOR_DEFAULTS.sacrificeAuto,   // 奥术献祭自动贡献开关
  sacrificeServerPct: MONITOR_DEFAULTS.sacrificeServerPct, // 全服进度阈值（%）
  sacrificeRelicPct: MONITOR_DEFAULTS.sacrificeRelicPct,   // 遗物参与门槛百分比
  sacrificeFishPct: MONITOR_DEFAULTS.sacrificeFishPct,     // 鱼分参与门槛百分比
  sacrificeGoldPct: MONITOR_DEFAULTS.sacrificeGoldPct,     // 金币参与门槛百分比
  sacrificeFishRarities: MONITOR_DEFAULTS.sacrificeFishRarities, // 鱼献祭品级勾选（仅 common~epic）
  lastSacrificeAuto: null,  // 最近一次自动贡献结果 {ok, reason, resourceType, serverPct, contributed, at}
  guildBoostAuto: MONITOR_DEFAULTS.guildBoostAuto,   // 区域经验增益(公会增益)自动开启开关
  worldBossAuto: MONITOR_DEFAULTS.worldBossAuto, // 世界Boss自动报名开关
  dailyReportWebhook: MONITOR_DEFAULTS.dailyReportWebhook, // 挂机日报 webhook 开关
  dailyReportTimes: MONITOR_DEFAULTS.dailyReportTimes,     // 日报推送时间（北京时，逗号分隔）
  gearWatchEnabled: MONITOR_DEFAULTS.gearWatchEnabled,    // 市场装备监测开关
  gearWatchRules: MONITOR_DEFAULTS.gearWatchRules,        // 市场装备监测·多条需求单
  gearWatchCheckSec: MONITOR_DEFAULTS.gearWatchCheckSec,  // 轮询间隔（秒）
  gearWatchNotify: MONITOR_DEFAULTS.gearWatchNotify,      // 命中后 webhook 通知开关
  gearWatch: null,             // 最近一次市场监测结果 {ok, scanned, hits, checkedAt, at}
  gearWatchHits: [],           // 最近一次扫描命中的装备列表（供 popup 展示）
  worldBoss: null,            // 世界Boss当前状态+选角方案（见 checkWorldBoss）
  lastWorldBossError: null,   // 最近世界Boss检查/报名错误
  lastWorldBossAuto: null,    // 最近一次自动报名结果 {ok, reason, boss, targetStat, prevStat, changed, at}
  autoBoost: null,            // 最近一次自动开公会增益结果（见 openAutoBoost）
  autoBoostHistory: [],       // 自动开增益检查历史（含未触发），持久化到本地存储，重启不丢
  currentStatus: null,        // 当前状态总览（当前地图/天气/赛事/增益），见 refreshCurrentStatus
};

// 签名与加点内部状态（不暴露给 popup）
let allocateInProgress = false;

const OFFLINE_CHECK_MS = 15000;        // 掉线检测周期
const INITIAL_GRACE_MS = 60000;        // 启动宽限期（页面刚打开还没心跳时不误判）
const ETA_WINDOW = 30;                 // 升级预测采样窗口（最近 N 杆）

let checkTimer = null;
let proofTimer = null;
let initializedAt = Date.now();

// 从 run.sh 依据环境变量 FISH_WEBHOOK 生成到 scripts/login_credentials.js（与登录凭据同一份文件）
// 读取 webhook 完整 URL。该文件是 web-accessible 资源（manifest web_accessible_resources: scripts/*），
// 内容形如：window.__REELAX_LOGIN__ = { email: "...", password: "...", webhook: "https://..." };
async function loadEnvWebhookUrl() {
  try {
    const res = await fetch(browser.runtime.getURL('scripts/login_credentials.js'), { cache: 'no-store' });
    if (!res.ok) return '';
    const text = await res.text();
    const m = text.match(/webhook:\s*"([^"]*)"/);
    return (m && m[1]) ? m[1].trim() : '';
  } catch (e) {
    return '';
  }
}

// ---------- 配置加载 ----------
async function monitorLoadConfig() {
  try {
    const cfg = await browser.storage.local.get(MONITOR_DEFAULTS);
    m.enabled = cfg.monitorEnabled !== false;
    m.offlineCheckMin = Number(cfg.offlineCheckMin) > 0 ? Number(cfg.offlineCheckMin) : MONITOR_DEFAULTS.offlineCheckMin;
    m.proofCheckSec = Number(cfg.proofCheckSec) > 0 ? Number(cfg.proofCheckSec) : MONITOR_DEFAULTS.proofCheckSec;
    m.reloadCooldownSec = Number(cfg.reloadCooldownSec) > 0 ? Number(cfg.reloadCooldownSec) : MONITOR_DEFAULTS.reloadCooldownSec;
    // webhook URL 优先级：环境变量(FISH_WEBHOOK) > storage 用户设置 > 空
    const envWebhook = await loadEnvWebhookUrl();
    m.webhookUrl = envWebhook || ((cfg.webhookUrl && typeof cfg.webhookUrl === 'string') ? cfg.webhookUrl : '');
    // ---- 飞书通知配置（App ID/Secret + 接收人）----
    m.feishuEnabled = !!cfg.feishuEnabled;
    m.feishuAppId = String(cfg.feishuAppId || '').trim();
    m.feishuAppSecret = String(cfg.feishuAppSecret || '').trim();
    const rt = String(cfg.feishuReceiveIdType || '').trim();
    m.feishuReceiveIdType = ['open_id', 'user_id', 'email', 'chat_id', 'department_id'].includes(rt) ? rt : 'open_id';
    m.feishuReceiveId = String(cfg.feishuReceiveId || '').trim();
    m.autoAllocate = cfg.autoAllocate !== false;
    m.autoMastery = cfg.autoMastery !== false;
    m.statTarget = ['strength', 'intelligence', 'luck', 'endurance'].includes(cfg.statTarget)
      ? cfg.statTarget : MONITOR_DEFAULTS.statTarget;
    m.allocStrategy = ['manual', 'competition'].includes(cfg.allocStrategy)
      ? cfg.allocStrategy : MONITOR_DEFAULTS.allocStrategy;
    m.primaryTotalTarget = Number(cfg.primaryTotalTarget) > 0 ? Number(cfg.primaryTotalTarget) : 0;
    m.strengthTarget = Number(cfg.strengthTarget) > 0 ? Number(cfg.strengthTarget) : MONITOR_DEFAULTS.strengthTarget;
    m.allocSecondary = ['strength', 'intelligence', 'luck', 'endurance'].includes(cfg.allocSecondary)
      ? cfg.allocSecondary : MONITOR_DEFAULTS.allocSecondary;
    m.enduranceBase = Number(cfg.enduranceBase) >= 0 ? Number(cfg.enduranceBase) : MONITOR_DEFAULTS.enduranceBase;
    m.compAutoRespec = cfg.compAutoRespec === true;
    m.compPersonalRespec = cfg.compPersonalRespec === true;
    m.gearAutoSell = cfg.gearAutoSell !== false;
    m.gearSellNotify = cfg.gearSellNotify !== false;
    m.gearSellRarities = (Array.isArray(cfg.gearSellRarities) && cfg.gearSellRarities.some((r) => GEAR_SELL_RARITIES.has(r)))
      ? cfg.gearSellRarities.filter((r) => GEAR_SELL_RARITIES.has(r)) : MONITOR_DEFAULTS.gearSellRarities;
    m.fishAutoSell = cfg.fishAutoSell !== false;
    if (Array.isArray(cfg.fishSellRarities) && cfg.fishSellRarities.some((r) => FISH_RARITIES.has(r))) {
      m.fishSellRarities = cfg.fishSellRarities.filter((r) => FISH_RARITIES.has(r));
    } else {
      // 兼容旧配置：仅配了 fishSellRarity（或数组非法）时回退到旧单值
      const legacy = (cfg.fishSellRarity && FISH_RARITIES.has(cfg.fishSellRarity)) ? cfg.fishSellRarity : 'uncommon';
      m.fishSellRarities = [legacy];
    }
    m.fishSellRarity = m.fishSellRarities[0] || 'uncommon';
    m.fishKeepMax = Number(cfg.fishKeepMax) >= 0 ? Number(cfg.fishKeepMax) : MONITOR_DEFAULTS.fishKeepMax;
    m.fishSellCheckSec = Number(cfg.fishSellCheckSec) >= 60 ? Number(cfg.fishSellCheckSec) : MONITOR_DEFAULTS.fishSellCheckSec;
    m.pityMonitor = cfg.pityMonitor !== false;
    m.pityCheckSec = Number(cfg.pityCheckSec) >= 60 ? Number(cfg.pityCheckSec) : MONITOR_DEFAULTS.pityCheckSec;
    m.worldBossAuto = cfg.worldBossAuto !== false;
    m.dailyReportWebhook = !!cfg.dailyReportWebhook;
    m.dailyReportTimes = String(cfg.dailyReportTimes || '').trim();
    // ---- 市场装备监测 ----
    m.gearWatchEnabled = cfg.gearWatchEnabled === true;
    m.gearWatchCheckSec = Number(cfg.gearWatchCheckSec) >= 60 ? Number(cfg.gearWatchCheckSec) : MONITOR_DEFAULTS.gearWatchCheckSec;
    m.gearWatchNotify = cfg.gearWatchNotify !== false;
    // 需求单数组：gearWatchRules。旧版单值字段存在时迁移为第一条需求单，避免升级丢配置。
    let rules = Array.isArray(cfg.gearWatchRules) ? cfg.gearWatchRules : [];
    rules = rules.map((r) => ({
      name: (r && typeof r.name === 'string') ? r.name : '需求单',
      rarity: (r && typeof r.rarity === 'string') ? r.rarity : '',
      slots: (r && Array.isArray(r.slots)) ? r.slots.filter((s) => typeof s === 'string') : [],
      minQuality: (r && Number(r.minQuality) >= 0) ? Number(r.minQuality) : 0,
      minUpgrade: (r && Number(r.minUpgrade) >= 0) ? Number(r.minUpgrade) : 0,
      maxPrice: (r && Number(r.maxPrice) > 0) ? Number(r.maxPrice) : 0,
    })).filter((r) => r.rarity || r.slots.length || r.maxPrice || r.minQuality || r.minUpgrade);
    if (!rules.length) {
      // 迁就旧版单值配置
      const legacyHas = cfg.gearWatchRarity || (Array.isArray(cfg.gearWatchSlots) && cfg.gearWatchSlots.length)
        || cfg.gearWatchMinQuality || cfg.gearWatchMinUpgrade || cfg.gearWatchMaxPrice;
      if (legacyHas) {
        rules.push({
          name: '需求单',
          rarity: String(cfg.gearWatchRarity || '').trim() || MONITOR_DEFAULTS.gearWatchRules[0].rarity,
          slots: (Array.isArray(cfg.gearWatchSlots) ? cfg.gearWatchSlots : []).filter((s) => typeof s === 'string'),
          minQuality: Number(cfg.gearWatchMinQuality) >= 0 ? Number(cfg.gearWatchMinQuality) : 0,
          minUpgrade: Number(cfg.gearWatchMinUpgrade) >= 0 ? Number(cfg.gearWatchMinUpgrade) : 0,
          maxPrice: Number(cfg.gearWatchMaxPrice) > 0 ? Number(cfg.gearWatchMaxPrice) : 0,
        });
      } else {
        rules = MONITOR_DEFAULTS.gearWatchRules.map((r) => ({ ...r }));
      }
    }
    if (!rules.length) rules = MONITOR_DEFAULTS.gearWatchRules.map((r) => ({ ...r }));
    m.gearWatchRules = rules;
    m.pityHardMargin = Number(cfg.pityHardMargin) >= 0 ? Number(cfg.pityHardMargin) : MONITOR_DEFAULTS.pityHardMargin;
    m.pityTriggerArcane = cfg.pityTriggerArcane === true;
    m.pityTriggerExotic = cfg.pityTriggerExotic === true;
    m.pityTriggerSurgeOnly = cfg.pityTriggerSurgeOnly === true;
    m.pityTriggerTopBait = cfg.pityTriggerTopBait === true;
    m.sacrificeAuto = cfg.sacrificeAuto !== false;
    m.sacrificeServerPct = Number(cfg.sacrificeServerPct) >= 0 ? Number(cfg.sacrificeServerPct) : MONITOR_DEFAULTS.sacrificeServerPct;
    m.sacrificeRelicPct = Number(cfg.sacrificeRelicPct) >= 0 ? Number(cfg.sacrificeRelicPct) : MONITOR_DEFAULTS.sacrificeRelicPct;
    m.sacrificeFishPct = Number(cfg.sacrificeFishPct) >= 0 ? Number(cfg.sacrificeFishPct) : MONITOR_DEFAULTS.sacrificeFishPct;
    m.sacrificeGoldPct = Number(cfg.sacrificeGoldPct) >= 0 ? Number(cfg.sacrificeGoldPct) : MONITOR_DEFAULTS.sacrificeGoldPct;
    // 鱼献祭品级勾选（数组，仅 common~epic 可献祭；勾选为空则回退默认 ['uncommon']）
    if (Array.isArray(cfg.sacrificeFishRarities)) {
      const kept = cfg.sacrificeFishRarities.filter((r) => SACRIFICE_SACRIFICABLE.has(r));
      m.sacrificeFishRarities = kept.length ? kept : MONITOR_DEFAULTS.sacrificeFishRarities.slice();
    } else {
      m.sacrificeFishRarities = MONITOR_DEFAULTS.sacrificeFishRarities.slice();
    }
    m.guildBoostAuto = cfg.guildBoostAuto !== false;
  } catch (e) {
    m.lastError = String(e);
  }
}

// ---------- webhook / 飞书 通知（扩展统一发送） ----------
// 企微：https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...
// 飞书：postToFeishu() 通过自建应用 tenant_access_token 调 im/v1/messages 发给指定接收人
// feishuEnabled 为 true 且 AppID/Secret/接收人齐全时走飞书，否则回退企微。
let _feishuToken = null;
let _feishuTokenExpiresAt = 0;

async function _feishuTenantToken() {
  const now = Date.now();
  if (_feishuToken && now < _feishuTokenExpiresAt) return _feishuToken;
  const r = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: m.feishuAppId, app_secret: m.feishuAppSecret }),
  });
  const j = await r.json().catch(() => null);
  if (!j || j.code !== 0 || !j.tenant_access_token) {
    throw new Error('飞书获取 tenant_access_token 失败: ' + (j && (j.msg || j.code) || 'bad-response'));
  }
  _feishuToken = j.tenant_access_token;
  _feishuTokenExpiresAt = now + (Number(j.expire) > 0 ? (j.expire - 60) : 7000) * 1000;
  return _feishuToken;
}

async function sendFeishu(text) {
  if (!m.feishuAppId || !m.feishuAppSecret || !m.feishuReceiveId) return false;
  const token = await _feishuTenantToken();
  const r = await fetch('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=' + m.feishuReceiveIdType, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + token,
    },
    body: JSON.stringify({
      receive_id: m.feishuReceiveId,
      msg_type: 'text',
      content: JSON.stringify({ text }),
    }),
  });
  const j = await r.json().catch(() => null);
  if (!j || j.code !== 0) {
    // 214003/214010 等错误（接收人不可用）或 token 失效 → 清空缓存重试一次
    if (j && (j.code === 99991663 || j.code === 214003 || j.code === 214010)) {
      _feishuToken = null;
      const token2 = await _feishuTenantToken();
      const r2 = await fetch('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=' + m.feishuReceiveIdType, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token2 },
        body: JSON.stringify({ receive_id: m.feishuReceiveId, msg_type: 'text', content: JSON.stringify({ text }) }),
      });
      const j2 = await r2.json().catch(() => null);
      if (!j2 || j2.code !== 0) throw new Error('飞书发送失败: ' + (j2 && (j2.msg || j2.code) || 'bad-response'));
    } else {
      throw new Error('飞书发送失败: ' + (j && (j.msg || j.code) || 'bad-response'));
    }
  }
  return true;
}

async function sendWebhook(text) {
  if (!text) return false;
  // 统一末尾追加统计数据（总杆/期望杆、下5级时间、刷新次数、最近URL切换）
  const suffix = buildStatsSuffix();
  const content = suffix ? `${text}\n${suffix}` : text;
  // 飞书优先（若开启且配置齐全）
  if (m.feishuEnabled) {
    try {
      await sendFeishu(content);
      return true;
    } catch (e) {
      console.warn('[Reelax] 飞书通知发送失败，改用企微:', e && e.message ? e.message : e);
      // 失败回退企微
    }
  }
  const url = m.webhookUrl;
  if (!url) return false;
  try {
    await fetch(url, {
      method: 'POST',
      mode: 'no-cors',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ msgtype: 'text', text: { content } }),
    });
    return true;
  } catch (e) {
    return false;
  }
}

// 测试通知：选项页「发送测试通知」触发。先重载配置（用最新表单值，可能未点保存），
// 再按当前飞书/企微配置发送一条测试消息，并把结果（成功/通道/错误）返回给选项页。
browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'reelax-test-notify') return;
  (async () => {
    try {
      await monitorLoadConfig();
      const via = m.feishuEnabled ? '飞书' : (m.webhookUrl ? '企业微信' : '未配置');
      const result = await sendWebhook('[Reelax] 这是一条测试通知，若你收到说明通知通道配置正常。');
      sendResponse({ ok: !!result, via: result ? via : undefined, error: result ? undefined : '通知发送失败（检查凭据/接收人/网络）' });
    } catch (e) {
      sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
    }
  })();
  return true; // 异步 sendResponse
});

// 其他扩展脚本/页面脚本通过 runtime 消息调扩展发通知
browser.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'reelax-webhook' && typeof msg.text === 'string') {
    sendWebhook(msg.text);
    // 挂机日报：统计切图（聚合.js 切图成功会发 [Reelax] 自动切图）
    if (msg.text.indexOf('[Reelax] 自动切图') === 0) dailyRecordSwitch(true);
  }
  // 挂机日报：聚合.js 上报补杆结果
  if (msg && msg.type === 'reelax-daily-refill') {
    dailyRecordRefill(!!(msg.ok));
  }
  // —— Chrome 版：主世界 sync-hook 捕获的 fishing/sync|state 响应体，解析进 m.sync ——
  // （Firefox 版走 webRequest.filterResponseData，Chrome MV3 无此 API，故由页面 hook 补充）
  if (msg && msg.type === 'reelax-sync-captured' && typeof msg.text === 'string') {
    try {
      parseSync(msg.text);
      console.log('[monitor] 收到 sync 捕获，m.sync 已更新:', m.sync && m.sync.runStatus, m.sync && m.sync.remainingCasts, '/', m.sync && m.sync.totalCasts);
    } catch (e) {
      m.lastError = 'sync-parse: ' + String(e);
      console.warn('[monitor] sync 解析失败:', e);
    }
    // 日报 webhook：sync 消息是 SW 最频繁的唤醒点，用它兜底触发到点检查。
    // （MV3 SW 会休眠，60s setInterval 不可靠；只要页面在线、sync 持续送达，就能对时推送。）
    maybePushDailyWebhookThrottled();
    // 日报数据采集：同理，用 sync 消息兜底驱动 dailyTick（60s interval 在 SW 休眠下不 tick），
    // 否则 activeSec/offlineSec/totalCasts 等不累积，桥生成的日报全是 0。
    dailyTickThrottled();
    // 保底/出货检测：同样用 sync 唤醒驱动（setInterval 在 SW 休眠下不跑，导致出货瞬间的
    // currentDry 回落永远不被 parsePity 观察到 → 出货 webhook 与日报出货 全 0）。节流 ~55s。
    checkPityThrottled();
  }
});

// 挂机日报：桥/其它脚本实时查询当日原始数据
browser.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'reelax-daily-raw') {
    ensureDaily().then((d) => { sendResponse({ ok: true, data: d, player: dailyPlayerSnapshot() }); });
    return true;
  }
  if (msg && msg.type === 'reelax-daily-player') {
    sendResponse({ ok: true, data: dailyPlayerSnapshot() });
    return true;
  }
});

// popup 比赛加点交互：获取预览方案 / 触发赛前(全运气)或赛后加点
browser.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || !msg.type) return;
  if (msg.type === 'reelax-stat-plan') {
    (async () => {
      const pre = await ReelaxApi.playerStats();
      if (!pre.ok) { sendResponse({ ok: false, reason: pre.error || 'stats-failed' }); return; }
      const baseSum = pre.player.stats?.base
        ? STAT_KEYS.reduce((s, k) => s + (pre.player.stats.base[k] || 0), 0) : 0;
      const totalPts = (pre.player.unspentStatPoints || 0) + baseSum; // 洗点后可用总点数
      // 力量加成 ≈ 总力量 − base力量（只看力量维度的 base；忽略遗物倍率，预览够用）
      const estFlat = Math.max(0, (pre.player.stats?.total?.strength || 0) - (pre.player.stats?.base?.strength || 0));
      const plan = computeStatPlan({
        totalPoints: totalPts,
        flatBonusStrength: estFlat,
        strengthTarget: m.strengthTarget,
        multiplier: 1,
        enduranceBase: m.enduranceBase,
        secondary: m.allocSecondary,
      });
      sendResponse({
        ok: true,
        compActive: m.compActive,
        current: { unspent: pre.player.unspentStatPoints, base: pre.player.stats?.base, total: pre.player.stats?.total },
        estFlatBonusStrength: estFlat,
        totalPoints: totalPts,
        plan,
      });
    })();
    return true; // 异步 sendResponse
  }
  if (msg.type === 'reelax-stat-allocate') {
    (async () => {
      const r = msg.mode === 'comp-start' ? await executeCompStart() : await executeCompEnd();
      sendResponse(r || { ok: false, reason: 'no-result' });
    })();
    return true;
  }
  // 奥术献祭：刷新事件状态 / 一键贡献
  if (msg.type === 'reelax-sacrifice-refresh') {
    (async () => {
      await checkSacrifice();
      sendResponse({ ok: true, data: m.arcaneSacrifice });
    })();
    return true;
  }
  if (msg.type === 'reelax-sacrifice-contribute') {
    (async () => {
      const r = await contributeSacrifice(msg.resourceType, msg.rarity);
      sendResponse(r);
    })();
    return true;
  }
  // 世界Boss：刷新状态 / 一键报名
  if (msg.type === 'reelax-worldboss-refresh') {
    (async () => {
      await checkWorldBoss();
      sendResponse({ ok: true, data: m.worldBoss });
    })();
    return true;
  }
  if (msg.type === 'reelax-worldboss-select') {
    (async () => {
      const r = await selectWorldBoss(msg.stat);
      sendResponse(r);
    })();
    return true;
  }
  // 自动开公会增益：由聚合.js 确定「优选地图」时通知触发
  if (msg.type === 'reelax-auto-boost') {
    (async () => {
      const r = await handleAutoBoost(msg.data);
      sendResponse(r);
    })();
    return true;
  }
  // 鱼自动出售：手动触发一次检查（弹窗「立即卖一次」用），返回诊断信息
  if (msg.type === 'reelax-fish-sell-now') {
    (async () => {
      const before = { total: m.fishSell && m.fishSell.total, checks: m.fishSellChecks || 0 };
      await checkAndSellFish();
      sendResponse({
        ok: true,
        result: m.fishSell || null,
        soldTotal: m.fishSoldTotal,
        checks: m.fishSellChecks || 0,
        before: before,
        keepMax: m.fishKeepMax,
        rarity: m.fishSellRarity,
      });
    })();
    return true;
  }
  // 区域经验增益开关：弹窗直接切（写 storage → storage.onChanged → monitorLoadConfig 热应用）
  if (msg.type === 'reelax-toggle-guild-boost') {
    const enabled = msg.enabled !== false;
    m.guildBoostAuto = enabled;
    browser.storage.local.set({ guildBoostAuto: enabled }).catch(() => {});
    sendResponse({ ok: true, enabled: enabled });
    return true;
  }
});

// ---------- 刷新标签页（带冷却） ----------
async function reloadTabs(reason) {
  if (Date.now() - (m.lastReloadAt || 0) < m.reloadCooldownSec * 1000) {
    console.warn('[monitor] 刷新冷却中，跳过:', reason);
    return;
  }
  m.lastReloadAt = Date.now();
  m.reloadCount++;
  m.lastReloadReason = reason;
  const reasonText = reason === 'offline' ? '掉线' : '登录失效';
  console.warn(`[monitor] ${reasonText}，刷新 reelax 页面恢复`);
  sendWebhook(`[Reelax] ${reasonText}，已自动刷新页面恢复`);
  try {
    const tabs = await browser.tabs.query({ url: '*://reelax.cn/*' });
    for (const t of tabs) browser.tabs.reload(t.id);
  } catch (e) {
    m.lastError = String(e);
  }
}

// 拼接刷新通知末尾的统计数据（总杆/期望杆、下5级所需时间、刷新次数、最近URL切换）
function buildStatsSuffix() {
  const fmtNum = (v) => (v == null ? '—' : Number(v).toLocaleString());
  const fmtDur = (sec) => {
    if (sec == null) return '—';
    const s = Math.round(sec);
    if (s < 60) return s + '秒';
    const mm = Math.floor(s / 60), ss = s % 60;
    if (mm < 60) return mm + '分' + (ss ? ss + '秒' : '');
    const h = Math.floor(mm / 60), mmm = mm % 60;
    return h + '时' + (mmm ? mmm + '分' : '');
  };

  const sync = m.sync || {};
  const parts = [];

  // 1. 总杆/期望杆
  if (sync.dailyCasts != null && sync.expectedCasts != null) {
    parts.push(`今日杆数 ${fmtNum(sync.dailyCasts)}/${fmtNum(sync.expectedCasts)}`);
  } else if (sync.dailyCasts != null) {
    parts.push(`今日杆数 ${fmtNum(sync.dailyCasts)}`);
  }

  // 2. 下5级所需时间
  if (Array.isArray(sync.levels)) {
    const lv5 = sync.levels.find((x) => x.rank === 5);
    if (lv5) parts.push(`下5级 ${fmtDur(lv5.seconds)}`);
    const lv1k = sync.levels.find((x) => x.rank === 1000);
    if (lv1k) parts.push(`Lv${lv1k.level} ${fmtDur(lv1k.seconds)}`);
  }

  // 3. 页面刷新次数
  parts.push(`刷新 ${m.pageReloadCount || 0}次`);

  // 4. 最近URL切换（path / 累计次数）
  if (Array.isArray(m.urlHistory) && m.urlHistory.length > 0) {
    const latest = m.urlHistory[0];
    let path = '/';
    try { path = new URL(latest.url).pathname; } catch (_) {}
    const clean = path === '/' ? '首页' : path.replace(/^\//, '');
    const count = m.urlCount && m.urlCount[path] != null ? m.urlCount[path] : 0;
    parts.push(`最近 ${clean}/${count}`);
  }

  return parts.join(' | ');
}

// ---------- 1. 心跳 + proof 被动捕获 ----------
browser.webRequest.onCompleted.addListener((details) => {
  if (!m.enabled) return;
  const url = details.url || '';
  // 心跳信号：fishing/sync 或 fishing/state
  if (/\/api\/fishing\/(sync|state)(\?|$)/.test(url)) {
    m.lastActivityAt = Date.now();
    m.activityCount++;
  }
  // 日报采集：webRequest 是 SW 最可靠的唤醒源（游戏每杆 API 请求都会走到这里）。
  // 用它驱动 dailyTick（含 10 分钟眺幅自愈），彻底规避 SW 休眠后 dailyTick 不接续的根因。
  if (/\/api\//.test(url)) dailyTickThrottledSelfHeal();
  // proof 被动捕获：任何 /api 响应头里的新 proof（保证永远最新）
  try {
    const h = (details.responseHeaders || []).find(
      (x) => x.name.toLowerCase() === 'x-arcane-request-proof',
    );
    if (h && h.value) {
      m.proofOk = true;
      m.proofUpdatedAt = Date.now();
      // 回填 bridge.js 的 proof 缓存，让桥签名一直用最新令牌
      if (typeof bridgeUpdateProof === 'function') bridgeUpdateProof(h.value);
    }
  } catch (e) { /* 忽略 */ }
}, { urls: ['*://reelax.cn/api/*'] }, ['responseHeaders']);

// ---------- 签名请求 ----------
// 统一走 api.js 的 ReelaxApi.*（页面上下文签名）。proof 令牌由 bridge.js 维护，
// monitor 在 webRequest 捕获到新 proof 时回填 bridgeUpdateProof（见下方心跳监听）。

const STAT_LABELS = { strength: '力量', intelligence: '智力', luck: '运气', endurance: '耐力' };
const ALLOCATE_MIN_INTERVAL_MS = 30000; // 加点失败重试节流

// 签名请求统一走 api.js 的 ReelaxApi.*（页面上下文签名，规避写操作 Referer 校验）。

// 自动加点：检测到待分配属性点 → 页面上下文签名分配（一次性全加）
async function autoAllocate(unspent) {
  m.lastAllocateResult = { at: Date.now() };
  if (!m.autoAllocate) { m.lastAllocateResult.reason = 'disabled'; return; }
  // 保底触发 active 期间暂停自动加点：以防洗成全运气后又把新点加到别的属性（直到保底出货洗回才恢复）
  if (m.pityTrigger && m.pityTrigger.active) { m.lastAllocateResult.reason = 'pity-trigger-locked'; return; }
  if (allocateInProgress) { m.lastAllocateResult.reason = 'locked'; return; }
  if (!unspent || unspent <= 0) { m.lastAllocateResult.reason = 'no-points'; return; }
  if (Date.now() - m.lastAllocateAt < ALLOCATE_MIN_INTERVAL_MS) { m.lastAllocateResult.reason = 'throttled'; return; }
  m.lastAllocateAt = Date.now();
  allocateInProgress = true;
  m.lastAllocateResult = { at: Date.now(), reason: 'allocating' };
  try {
    // 比赛进行中：所有待分配点全加运气（运气影响爆率/保底），覆盖手动设定的 statTarget
    const target = (m.compActive && m.allocStrategy === 'competition') ? 'luck' : m.statTarget;
    const secondary = m.allocSecondary;
    let body = { strength: 0, intelligence: 0, luck: 0, endurance: 0 };
    let addedSecondary = 0;

    // 主属性总计阈值：主属性达阈值后，剩余点分给副属性（target 与 secondary 相同则全加主属性）
    const usePrimaryThreshold = !!(m.primaryTotalTarget > 0) && secondary && secondary !== target;
    if (usePrimaryThreshold) {
      let curTotal = 0;
      try {
        const st = await ReelaxApi.playerStats();
        if (st && st.ok && st.player && st.player.stats && st.player.stats.total) {
          curTotal = Number(st.player.stats.total[target]) || 0;
        }
      } catch (_e) { /* 读取当前属性失败则全加主属性，保守不误分 */ }
      const needToReach = m.primaryTotalTarget - curTotal;
      const toPrimary = Math.max(0, Math.min(needToReach, unspent));
      const toSecondary = unspent - toPrimary;
      body[target] = toPrimary;
      if (toSecondary > 0) {
        body[secondary] = toSecondary;
        addedSecondary = toSecondary;
      }
    } else {
      body[target] = unspent;
    }

    const res = await ReelaxApi.allocateStats(body);
    if (res && res.ok) {
      try {
        const data = JSON.parse(res.body);
        if (data.player && data.player.unspentStatPoints !== undefined) {
          if (m.sync) m.sync.unspentStatPoints = data.player.unspentStatPoints;
        }
      } catch (_) {}
      const label = STAT_LABELS[target] || target;
      const secLabel = addedSecondary > 0 ? ('，副属性 +' + addedSecondary + ' ' + (STAT_LABELS[secondary] || secondary)) : '';
      m.lastAllocateResult = { ok: true, status: res.status, added: unspent, addedSecondary, at: Date.now() };
      console.log(`[monitor] 自动加点完成: 主属性 +${unspent - addedSecondary} ${label}${secLabel}`);
    } else {
      m.lastAllocateResult = {
        ok: false,
        reason: (res && res.error) || 'http',
        status: res ? res.status : null,
        errorBody: (res && res.body) || (res && res.error) || '',
        at: Date.now(),
      };
      console.warn(`[monitor] 自动加点失败: ${m.lastAllocateResult.reason} ${m.lastAllocateResult.errorBody}`);
    }
  } catch (e) {
    m.lastAllocateResult = { ok: false, reason: String(e), at: Date.now() };
    console.warn('[monitor] 自动加点异常:', e);
  } finally {
    allocateInProgress = false;
  }
}

// ---------- 比赛加点（competition respec） ----------
// 思路复用 user.js（奥术摸鱼大师辅助）：
//   · 比赛期间：洗点后全加运气（运气影响爆率/保底）
//   · 比赛结束：洗点 → 读 stats.total 当已有加成(flatBonus)
//     → 计算需补多少 base 力量，使"总力量"达到 strengthTarget
//     → 剩余点数全给 allocSecondary（默认智力）
const STAT_KEYS = ['strength', 'intelligence', 'luck', 'endurance'];
const COMP_CHECK_MS = 30000;        // 比赛状态轮询周期
let compCheckTimer = null;
let respecInProgress = false;
let _compStartSig = {};   // kind → 已做过"赛前全运气"的比赛签名
let _compEndSig = {};     // kind → 已做过"赛后加点"的比赛签名

// —— 纯函数：赛后加点方案（popup 侧也有一份副本用于预览）——
// opts: { totalPoints, flatBonusStrength, strengthTarget, multiplier, enduranceBase, secondary }
//   flatBonusStrength: 洗点后 stats.total.strength（base=0，即所有加成之和）
//   multiplier:        力量加成倍率（遗物 +10%/+25% → 1.1/1.25；无则 1）
// 返回 base 分配方案 + 关键中间量，便于 UI 展示
function computeStatPlan(opts) {
  const totalPoints = Math.max(0, opts.totalPoints | 0);
  const flatBonus = Math.max(0, opts.flatBonusStrength || 0);
  const target = Math.max(0, opts.strengthTarget || 0);
  const mult = (opts.multiplier > 0) ? opts.multiplier : 1;
  // 总点先扣耐力预留（如 4596−100=4496 参与力量/运气分配），点数不足时耐力不超发
  const endurance = Math.min(Math.max(0, opts.enduranceBase | 0), totalPoints);
  const secondary = STAT_KEYS.includes(opts.secondary) ? opts.secondary : 'luck';
  // 需补 base 力量 = (目标总力量 - 已有加成) / 倍率（向下取整，绝不超目标，避免图腾等加成造成越界）
  const needRaw = Math.floor((target - flatBonus) / mult);
  const needStrength = Math.max(0, Math.min(needRaw, totalPoints - endurance));
  const remain = Math.max(0, totalPoints - needStrength - endurance);
  const body = { strength: needStrength, intelligence: 0, luck: 0, endurance: 0 };
  if (remain > 0) body[secondary] = remain;
  return {
    body,
    needStrength,
    secondaryPoints: remain > 0 ? remain : 0,
    flatBonusStrength: flatBonus,
    strengthTarget: target,
    reachedStrength: flatBonus + needStrength * mult,
    capped: needRaw > needStrength, // 点数不足以达成目标总力量
    multiplierUsed: mult,
    endurance,
    secondary,
  };
}

// —— 纯函数：赛前全运气方案 ——
// 耐力预留只是计算用（从总点扣除不参与运气分配），实际 body 不给耐力加点
function planCompStart(totalPoints, enduranceBase) {
  const endurance = Math.max(0, enduranceBase | 0);
  return { strength: 0, intelligence: 0, luck: Math.max(0, totalPoints - endurance), endurance: 0 };
}

// 复用游戏比赛状态：按 kind 判定对应赛事（guild=公会赛 / personal=个人赛）是否进行中。
// 公会赛调 /api/guild-tournaments/overview，个人赛调 /api/tournaments/overview。
// 两个接口的 active 赛事可能以「current」单对象 或「upcoming[] 里 status==='active' 的条目」存在
// （实测非进行中时 current=null，数据都在 upcoming[]），故两条路径都认。
async function getCompetitionState(kind) {
  const isPersonal = kind === 'personal';
  let active = false, endAt = null, signature = null;
  const regCheck = (o) => !!(o && (o.isRegistered || o.entryStatus === 'registered' || o.entered === true));
  const inWindow = (o) => {
    const starts = o.startAt ? new Date(o.startAt).getTime() : 0;
    const ends = o.endAt ? new Date(o.endAt).getTime() : 0;
    return !!ends && Date.now() <= ends && (!starts || Date.now() >= starts); // 开始 ≤ 现在 ≤ 结束
  };
  const adopt = (o) => {
    active = true;
    endAt = o.endAt ? new Date(o.endAt).getTime() : 0;
    signature = (isPersonal ? 'personal:' : 'guild:') + (o.id || o.sequence || 'current');
  };
  try {
    const r = isPersonal ? await ReelaxApi.tournamentOverview() : await ReelaxApi.guildCompetitionOverview();
    const data = r.ok && r.data ? r.data : null;
    // 候选：current 单对象 + upcoming[] 里 status==='active' 的条目（个人赛实测进行中可能在 upcoming 里）
    const candidates = [];
    if (data) {
      if (data.current) candidates.push(data.current);
      if (Array.isArray(data.upcoming)) {
        for (const t of data.upcoming) if (t && t.status === 'active') candidates.push(t);
      }
    }
    for (const o of candidates) {
      if (regCheck(o) && inWindow(o)) { adopt(o); break; }
    }
  } catch (e) { /* 单场查询失败按未进行中处理 */ }
  return { active, endAt, signature, kind: isPersonal ? 'personal' : 'guild' };
}

// 重置+分配期间，临时停用内置自动加点，避免被 checkAndAllocate 抢占；ms 后恢复原设定
const REALLOC_PAUSE_MS = 60000;
function pauseBuiltinAllocate(ms) {
  const prev = m.autoAllocate;
  m.autoAllocate = false;
  setTimeout(() => { m.autoAllocate = prev; }, ms);
}

// 比赛开始：洗点 → 全加运气
async function executeCompStart() {
  if (respecInProgress) return { ok: false, reason: 'locked' };
  respecInProgress = true;
  pityTriggerRelease(); // 比赛接管洗点 → 先释放保底触发（冻结于比赛窗口，结束再评估）
  pauseBuiltinAllocate(REALLOC_PAUSE_MS); // 重置前先停用内置自动加点 1 分钟
  m.lastRespecResult = { at: Date.now(), phase: 'start', reason: 'allocating' };
  try {
    const stats = await ReelaxApi.playerStats();
    if (!stats.ok) { m.lastRespecResult = { ok: false, reason: 'stats-failed', at: Date.now() }; return m.lastRespecResult; }
    const resetR = await ReelaxApi.resetStats();
    if (!resetR || !resetR.ok) { m.lastRespecResult = { ok: false, reason: 'reset-failed', at: Date.now() }; return m.lastRespecResult; }
    const after = ReelaxApi.safeParseJSON(resetR.body) || {};
    if (!after.player) { m.lastRespecResult = { ok: false, reason: 'reset-parse-failed', body: resetR.body, at: Date.now() }; return m.lastRespecResult; }
    const totalPts = after.player?.unspentStatPoints ?? (stats.player.unspentStatPoints || 0);
    const body = planCompStart(totalPts, m.enduranceBase);
    const allocR = await ReelaxApi.allocateStats(body);
    const ok = !!(allocR && allocR.ok);
    m.lastRespecResult = { ok, phase: 'start', at: Date.now(), body, totalPoints: totalPts };
    return m.lastRespecResult;
  } catch (e) {
    m.lastRespecResult = { ok: false, reason: String(e), at: Date.now() };
    return m.lastRespecResult;
  } finally {
    respecInProgress = false;
  }
}

// 比赛结束：洗点 → 读加成 → 力量补到 strengthTarget，剩余给 allocSecondary
async function executeCompEnd() {
  if (respecInProgress) return { ok: false, reason: 'locked' };
  respecInProgress = true;
  pityTriggerRelease(); // 比赛结束也会洗点 → 同样释放保底触发
  pauseBuiltinAllocate(REALLOC_PAUSE_MS); // 重置前先停用内置自动加点 1 分钟
  m.lastRespecResult = { at: Date.now(), phase: 'end', reason: 'allocating' };
  try {
    const pre = await ReelaxApi.playerStats();
    if (!pre.ok) { m.lastRespecResult = { ok: false, reason: 'stats-failed', at: Date.now() }; return m.lastRespecResult; }
    const resetR = await ReelaxApi.resetStats();
    if (!resetR || !resetR.ok) { m.lastRespecResult = { ok: false, reason: 'reset-failed', at: Date.now() }; return m.lastRespecResult; }
    // 洗点后仍拉一次最新 playerStats 作「总可分配点」来源（unspentStatPoints 最准）。
    const fresh = await ReelaxApi.playerStats();
    const after = (fresh && fresh.ok && fresh.player)
      ? fresh.player
      : (ReelaxApi.safeParseJSON(resetR.body) || {}).player || null;
    if (!after) { m.lastRespecResult = { ok: false, reason: 'reset-parse-failed', body: resetR.body, at: Date.now() }; return m.lastRespecResult; }
    const totalPts = after.unspentStatPoints != null ? after.unspentStatPoints : (pre.player.unspentStatPoints || 0);
    const baseStr = pre.player.stats?.base?.strength || 0;
    const totalStr = pre.player.stats?.total?.strength || 0;
    // 纯加成 flatBonus：用「洗点前 total − base」（两者同刻、加成完整加载）。
    // 不要用洗点后 total.strength —— reset 后 guild/图腾等加成可能瞬时未同步，读到偏低
    // → 多分配 → 赛后超目标（实测 4500→4580/→4578，缺的加成数即超量）。
    // 力量实测为纯加法 total = base + flat（图腾/遗物%不作用于 base），故 total−base = flat。
    const flatBonus = baseStr > 0
      ? (totalStr - baseStr)
      : ((after.stats?.total?.strength != null) ? after.stats.total.strength : (totalStr || 0));
    // 倍率：实测游戏力量按「total = base + flat」纯加法，分配 base 点 1:1 计入 total，mult 恒为 1。
    const mult = 1;
    const plan = computeStatPlan({
      totalPoints: totalPts,
      flatBonusStrength: flatBonus,
      strengthTarget: m.strengthTarget,
      multiplier: mult,
      enduranceBase: m.enduranceBase,
      secondary: m.allocSecondary,
    });
    const allocR = await ReelaxApi.allocateStats(plan.body);
    let ok = !!(allocR && allocR.ok);
    let finalTotal = null;
    // 二次校准：mult=1 时 total=flat+base，flatBonus 读取若有微小漂移（pre/after 状态差），
    // 一次分配会差 1~n 点（实测 4498 vs 4500 差 2）。分配后重读，若仍低于目标、且有余点，
    // 补足差额到恰好 target（不越界）。
    try {
      const chk = await ReelaxApi.playerStats();
      const ts = chk.player?.stats?.total?.strength;
      if (ts != null) {
        finalTotal = ts;
        if (ts < m.strengthTarget) {
          const need = m.strengthTarget - ts;
          const unspent = chk.player?.unspentStatPoints ?? 0;
          if (unspent >= need) {
            await ReelaxApi.allocateStats({ strength: need, intelligence: 0, luck: 0, endurance: 0 });
            // 补点后再确认一次最终值
            const chk2 = await ReelaxApi.playerStats();
            if (chk2.player?.stats?.total?.strength != null) finalTotal = chk2.player.stats.total.strength;
          }
        }
      }
    } catch (_e) { /* 二次校准失败则保留一次分配结果 */ }
    // ok = 已达到目标总力量（或首次分配已成功且无法补足时按已覆盖处理）
    if (finalTotal != null) ok = finalTotal >= m.strengthTarget - 0.5;
    m.lastRespecResult = {
      ok, phase: 'end', at: Date.now(), plan, body: plan.body, secondary: plan.secondary,
      totalPoints: totalPts, flatBonusStrength: flatBonus, multiplier: mult,
      // 记录本次洗点后实际读到的纯加成细分，便于核对 flatBonus 是否漏算某加成（曾致超目标）
      flatDetail: (after.stats && after.stats.total) ? after.stats.total : null,
      afterBase: after.stats?.base || null,
    };
    return m.lastRespecResult;
  } catch (e) {
    m.lastRespecResult = { ok: false, reason: String(e), at: Date.now() };
    return m.lastRespecResult;
  } finally {
    respecInProgress = false;
  }
}

// 周期检查比赛状态，自动触发赛前/赛后加点（复用游戏比赛状态）。
// 公会赛（compAutoRespec 开关）与个人赛（compPersonalRespec 开关）各自独立判定、互不干扰；
// 任一进行中都会置起 m.compActive（供自动加点切「比赛策略」）。
async function checkCompetitionRespec() {
  const guildOn = m.compAutoRespec === true;
  const personalOn = m.compPersonalRespec === true;
  if (!guildOn && !personalOn) { m.compActive = false; m.compPersonalActive = false; return; }

  const wasGuildActive = m.compActive;
  const wasPersonalActive = m.compPersonalActive;

  // 公会赛
  let guildActive = false, guildSig = null;
  if (guildOn) {
    try {
      const g = await getCompetitionState('guild');
      guildActive = !!g.active; guildSig = g.signature;
      if (guildActive) {
        if (_compStartSig.guild !== guildSig) {
          await executeCompStart();
          _compStartSig.guild = guildSig;
          _compEndSig.guild = null;
          console.log('[monitor] 公会赛开始洗点(全运气)');
        }
      } else if (m.compActive && _compStartSig.guild && (_compEndSig.guild !== _compStartSig.guild)) {
        await executeCompEnd();
        _compEndSig.guild = _compStartSig.guild;
        console.log('[monitor] 公会赛结束赛后加点');
      } else if (!m.compActive && !guildActive) {
        _compStartSig.guild = null;
        _compEndSig.guild = null;
      }
    } catch (e) { guildActive = false; /* 单场查询失败按未进行中 */ }
  }

  // 个人赛
  let personalActive = false, personalSig = null;
  if (personalOn) {
    try {
      const p = await getCompetitionState('personal');
      personalActive = !!p.active; personalSig = p.signature;
      if (personalActive) {
        if (_compStartSig.personal !== personalSig) {
          await executeCompStart();
          _compStartSig.personal = personalSig;
          _compEndSig.personal = null;
          console.log('[monitor] 个人赛开始洗点(全运气)');
        }
      } else if (m.compPersonalActive && _compStartSig.personal && (_compEndSig.personal !== _compStartSig.personal)) {
        await executeCompEnd();
        _compEndSig.personal = _compStartSig.personal;
        console.log('[monitor] 个人赛结束赛后加点');
      } else if (!m.compPersonalActive && !personalActive) {
        _compStartSig.personal = null;
        _compEndSig.personal = null;
      }
    } catch (e) { personalActive = false; /* 单场查询失败按未进行中 */ }
  }

  m.compActive = guildActive || personalActive;
  m.compPersonalActive = personalActive;
}

function startCompetitionCheck() {
  if (compCheckTimer) clearInterval(compCheckTimer);
  compCheckTimer = setInterval(checkCompetitionRespec, COMP_CHECK_MS);
}

// ---------- 保底触发（pity-trigger）：基于「全运气硬保底基准 ref」洗点，出货后洗回 ----------
// 开关 pityTriggerArcane（奥秘）/ pityTriggerExotic（奇异）各自独立：
//   · 记录「全加运气状态」的硬保底杆数作基准 ref（首次未记录→自动建基；后每当正处全运气自动刷新，持久化）。
//   · 非全运气时该类型 currentDry ≥ ref 硬保底 → 洗点 → 全点运气，直到「对应鱼出货」才洗回。
//   · 两开关任一在等就保持全运气；只剩最后的那个时等它出；全部对应的鱼都出货后才洗回。
//   · 洗回复用比赛后加点方案 computeStatPlan：力量补到 strengthTarget，剩余给 allocSecondary。
//   · 可叠加 pityTriggerSurgeOnly（仅涌流触发）：开启后只在奥秘涌流(surge)期间跑，涌流结束视为功能关、洗回。
//   · 比赛中（m.compActive）此功能整体冻结；比赛洗点时先 pityTriggerRelease 让位，比赛结束再评估。
//   · active 期间抑制内置自动加点 autoAllocate，防止点到别的属性。
let pityTriggerLock = false;

// ---------- 保底触发·自动顶级饵 ----------
// pityTriggerTopBait 开启时，洗点期间自动用顶级饵 bait_supreme：
//   · 顶级饵库存>0 → 直接装备；
//   · 库存为0 → 自动买 100 个后再装备（单价 1000 金 ≈ 10 万金/次）；
//   · 买不起/购买失败 → 保持当前设定饵（不改动），洗回时也回原饵。
const TOP_BAIT_ID = 'bait_supreme';
const BAIT_AUTO_BUY_QTY = 100;

// 读 /api/baits：返回当前装备饵 + 顶级饵库存情况
async function readBaitState() {
  try {
    const r = await ReelaxApi.getJSON('/api/baits');
    const d = r && r.ok ? r.data : null;
    const arr = Array.isArray(d) ? d : (Array.isArray(d && d.baits) ? d.baits : []);
    if (!arr.length) return { ok: false };
    const selected = arr.find((b) => b && b.isSelected) || null;
    const top = arr.find((b) => b && b.id === TOP_BAIT_ID) || null;
    return {
      ok: true,
      currentBait: (selected && selected.id) || null,
      topExists: !!top,
      // 库存>0（或无限）即认为「够用」
      topHasStock: !!(top && (top.isUnlimited || (top.quantity != null && top.quantity > 0))),
    };
  } catch (e) {
    return { ok: false };
  }
}

// 确保装备顶级饵：返回 { ok, changed, keepCurrent }
async function ensureTopBait() {
  const st = await readBaitState();
  if (!st.ok) return { ok: false, reason: 'bait-state-failed', changed: false, keepCurrent: true };
  if (!st.topExists) return { ok: false, reason: 'no-top-bait', changed: false, keepCurrent: true };
  if (st.currentBait === TOP_BAIT_ID) return { ok: true, changed: false, keepCurrent: true };
  let eq;
  if (st.topHasStock) {
    eq = await ReelaxApi.post('/api/baits/' + TOP_BAIT_ID + '/equip');
    return { ok: !!(eq && eq.ok), changed: !!(eq && eq.ok), keepCurrent: !(eq && eq.ok), reason: (eq && eq.ok) ? null : 'equip-failed' };
  }
  // 库存0 → 自动购买 100 个
  const buy = await ReelaxApi.post('/api/baits/' + TOP_BAIT_ID + '/purchase', { quantity: BAIT_AUTO_BUY_QTY });
  if (!(buy && buy.ok)) return { ok: false, reason: 'buy-failed', changed: false, keepCurrent: true }; // 买不起→用当前设定饵
  eq = await ReelaxApi.post('/api/baits/' + TOP_BAIT_ID + '/equip');
  return { ok: !!(eq && eq.ok), changed: !!(eq && eq.ok), keepCurrent: !(eq && eq.ok), reason: (eq && eq.ok) ? null : 'equip-after-buy-failed' };
}

// 恢复开启前的鱼饵（等保底出货/功能关闭/比赛接管时）
async function restoreTopBait(baitId) {
  if (!baitId) return { ok: false, reason: 'no-remembered-bait' };
  const r = await ReelaxApi.post('/api/baits/' + baitId + '/equip');
  return { ok: !!(r && r.ok) };
}

// ---------- 全运气硬保底基准（ref）机制 ----------
// 硬保底杆数是服务端按「当前有效运气」动态下发的（见 /api/statistics 的 pity.*.hardPityCasts）。
// 本功能记「全加运气状态」下的硬保底作为触发基准 ref：
//   · 未记录时，首次运行自动「洗全运气 → 读 statistics → 洗回」建立基准（buildRefBaseline）；
//   · 之后每当检测到用户正处于全运气加点（isAllLuckNow，base 运气占比≥80%，如比赛/涌流全点运气），
//     自动把当前硬保底刷新进 ref（updateRefFromStats）。
// 触发改为：非全运气时，currentDry ≥ 对应类型 ref 硬保底 → 洗点全加运气，直到出货再洗回。

// 读 /api/player/stats，判断基础点是否已基本全加运气（base.luck / sum(base) ≥ 0.8）
async function isAllLuckNow() {
  try {
    const r = await ReelaxApi.playerStats();
    const base = r && r.ok && r.player && r.player.stats && r.player.stats.base;
    if (!base) return false;
    const sum = (base.strength || 0) + (base.intelligence || 0) + (base.luck || 0) + (base.endurance || 0);
    if (sum <= 0) return false;
    return (base.luck || 0) / sum >= 0.8;
  } catch (e) {
    return false;
  }
}

// 读 /api/statistics 当前硬保底杆数（仅当正处全运气时调用才能代表全运气下的值）
// 返回 { arcane, exotic }（服务端值，可为 null）
async function readHardPityCasts() {
  try {
    const r = await ReelaxApi.statistics();
    if (!(r && r.ok)) return { arcane: null, exotic: null };
    const p = (ReelaxApi.safeParseJSON(r.body) || {}).pity;
    if (!p) return { arcane: null, exotic: null };
    return {
      arcane: (p.arcane && p.arcane.hardPityCasts != null) ? Number(p.arcane.hardPityCasts) : null,
      exotic: (p.exotic && p.exotic.hardPityCasts != null) ? Number(p.exotic.hardPityCasts) : null,
    };
  } catch (e) {
    return { arcane: null, exotic: null };
  }
}

// 刷新 ref 基准为当前读数（调用前应确保正处全运气；缺失类型保留旧值）
function storeRef(hard) {
  const ref = m.pityTrigger.ref || (m.pityTrigger.ref = { arcane: null, exotic: null, built: false, builtAt: null });
  if (hard) {
    if (hard.arcane != null) ref.arcane = hard.arcane;
    if (hard.exotic != null) ref.exotic = hard.exotic;
    ref.built = true;
    ref.builtAt = Date.now();
  }
  persistStats();
  return ref;
}

// 当检测到正处全运气时，用当前 statistics 硬保底刷新 ref（含蓄比赛/涌流期间自动全点运气的情况）
async function updateRefFromStats() {
  const hard = await readHardPityCasts();
  const stored = storeRef(hard);
  m.pityTrigger.lastRefUpdateAt = Date.now();
  console.log('[monitor] 保底触发: 全运气观测，更新硬保底基准 → 奥秘', stored.arcane, '/ 奇异', stored.exotic);
  return stored;
}

// 首次建基：洗点→全加运气→读 statistics→存 ref→洗回。
// 前提：仅在「奥秘涌流」期间调用（记录的是涌流下的硬保底，涌流外观测不具意义）。
// 注意：不设置 active（不是等出货，只是取基准），建完立即洗回；任何分支都保证洗回，避免留下全运气残留。
async function buildRefBaseline() {
  if (m.pityTrigger && m.pityTrigger.pending) return { ok: false, reason: 'locked' };
  const inSurge = !!(
    m.arcaneSacrifice && m.arcaneSacrifice.surge && m.arcaneSacrifice.surge.isActive
  );
  if (!inSurge) return { ok: false, reason: 'not-surge' };   // 涌流外不建基，等下一个涌流窗口
  console.log('[monitor] 保底触发: 未记录全运气硬保底基准，首次自动建基（洗点→读保底→洗回）');
  try {
    const w = await pityTriggerWash();      // 洗成纯运气
    if (!(w && w.ok)) return { ok: false, reason: 'wash-failed' };
    const hard = await readHardPityCasts(); // 全运气下读硬保底
    const stored = storeRef(hard);          // 存基准（缺失类型保留旧值）
    m.pityTrigger.lastRefUpdateAt = Date.now();
    console.log('[monitor] 保底触发: 建基完成 → 奥秘', stored.arcane, '/ 奇异', stored.exotic);
    sendWebhook(`[Reelax] 📊 保底触发已记录全运气硬保底：奥秘 ${stored.arcane} / 奇异 ${stored.exotic}（第一次建基）`);
    return { ok: true, ref: stored };
  } finally {
    // 无论读取/存基准结果如何，都洗回原加点/原饵（清除 wash 设置的 active 残留）
    await pityTriggerRestore().catch(() => {});
  }
}

// 洗点 → 全加运气；洗点前记录 flatBonusStrength / totalPoints，供出货后洗回
// 若开启 pityTriggerTopBait，洗点前记录原饵，洗点成功后自动切顶级饵
async function pityTriggerWash() {
  if (pityTriggerLock) return { ok: false, reason: 'locked' };
  pityTriggerLock = true;
  try {
    const useTopBait = m.pityTriggerTopBait === true;
    // 若要用顶级饵，先记录开启前原饵（同一刻读 /api/baits，避免用陈旧的 pity.baitId）
    let preBait = null;
    if (useTopBait) {
      const st = await readBaitState();
      if (st && st.ok) preBait = st.currentBait;
    }
    const pre = await ReelaxApi.playerStats();
    if (!pre.ok || !pre.player) return { ok: false, reason: 'stats-failed' };
    const resetR = await ReelaxApi.resetStats();
    if (!resetR || !resetR.ok) return { ok: false, reason: 'reset-failed' };
    const fresh = await ReelaxApi.playerStats();
    const player = (fresh && fresh.ok && fresh.player) ? fresh.player : (ReelaxApi.safeParseJSON(resetR.body) || {}).player;
    const totalPts = player && player.unspentStatPoints != null ? player.unspentStatPoints : (pre.player.unspentStatPoints || 0);
    const baseStr = pre.player.stats?.base?.strength || 0;
    const totalStr = pre.player.stats?.total?.strength || 0;
    // 加成 flatBonus = total − base（洗点前同一刻读，加成完整加载）；同 executeCompEnd 口径
    const flatBonus = baseStr > 0 ? (totalStr - baseStr) : (totalStr || 0);
    const body = planCompStart(totalPts, m.enduranceBase);
    const allocR = await ReelaxApi.allocateStats(body);
    const ok = !!(allocR && allocR.ok);
    m.pityTrigger.active = ok;
    m.pityTrigger.savedFlatBonus = ok ? flatBonus : null;
    m.pityTrigger.savedTotalPts = ok ? totalPts : null;
    m.pityTrigger.preBait = (ok && useTopBait) ? preBait : null;
    let baitResult = null;
    if (ok && useTopBait) {
      baitResult = await ensureTopBait().catch(() => ({ ok: false, reason: 'bait-error', keepCurrent: true }));
    }
    if (ok) { m.pityTrigger.washedAt = Date.now(); persistStats(); }
    return { ok, flatBonus, totalPts, baitResult, useTopBait };
  } catch (e) {
    return { ok: false, reason: String(e) };
  } finally {
    pityTriggerLock = false;
  }
}

// 洗回原加点（复用比赛后加点方案）：reset → computeStatPlan → allocate
// 若开启 pityTriggerTopBait，洗回后恢复开启前的鱼饵
async function pityTriggerRestore() {
  if (pityTriggerLock) return { ok: false, reason: 'locked' };
  pityTriggerLock = true;
  try {
    const preBait = m.pityTrigger.preBait;   // 洗点前原饵（洗回后恢复）
    const useTopBait = m.pityTriggerTopBait === true;
    const pre = await ReelaxApi.playerStats();
    if (!pre.ok) return { ok: false, reason: 'stats-failed' };
    const resetR = await ReelaxApi.resetStats();
    if (!resetR || !resetR.ok) return { ok: false, reason: 'reset-failed' };
    const fresh = await ReelaxApi.playerStats();
    const player = (fresh && fresh.ok && fresh.player) ? fresh.player : (ReelaxApi.safeParseJSON(resetR.body) || {}).player;
    const totalPts = player && player.unspentStatPoints != null ? player.unspentStatPoints : (pre.player.unspentStatPoints || 0);
    const plan = computeStatPlan({
      totalPoints: totalPts,
      flatBonusStrength: m.pityTrigger.savedFlatBonus != null ? m.pityTrigger.savedFlatBonus : 0,
      strengthTarget: m.strengthTarget,
      multiplier: 1,
      enduranceBase: m.enduranceBase,
      secondary: m.allocSecondary,
    });
    const allocR = await ReelaxApi.allocateStats(plan.body);
    const ok = !!(allocR && allocR.ok);
    let baitRestored = false;
    if (ok && useTopBait && preBait) {
      const br = await restoreTopBait(preBait).catch(() => ({ ok: false }));
      baitRestored = !!(br && br.ok);
    }
    m.pityTrigger.active = false;
    m.pityTrigger.savedFlatBonus = null;
    m.pityTrigger.savedTotalPts = null;
    m.pityTrigger.preBait = null;
    if (ok) { m.pityTrigger.restoredAt = Date.now(); persistStats(); }
    return { ok, plan, useTopBait, baitRestored };
  } catch (e) {
    return { ok: false, reason: String(e) };
  } finally {
    pityTriggerLock = false;
  }
}

// 释放保底触发锁定（比赛/手动接管时让位）：清 active 与恢复所需快照
// 若开启顶级饵且记录过原饵，异步尽力恢复（比赛接管时不阻塞）
function pityTriggerRelease() {
  const shouldRestoreBait = m.pityTriggerTopBait === true && m.pityTrigger && m.pityTrigger.preBait;
  const rememberedBait = shouldRestoreBait ? m.pityTrigger.preBait : null;
  m.pityTrigger.active = false;
  m.pityTrigger.pending = false;
  m.pityTrigger.armed = { arcane: false, exotic: false };
  m.pityTrigger.savedFlatBonus = null;
  m.pityTrigger.savedTotalPts = null;
  m.pityTrigger.preBait = null;
  if (rememberedBait) {
    restoreTopBait(rememberedBait).catch(() => {});
  }
}

// 由 parsePity 调用：推进「保底触发」状态机（基于「奥秘涌流·全运气」硬保底基准 ref）。
// opts: { arcaneDrop, exoticDrop } 为本采样检测到的出货标志（deltaDrop / detectDrop）。
//
// 新逻辑（取代旧的「进度≥90%」触发）：
//   · 只在「奥秘涌流 + 全加运气」窗口记录硬保底基准 ref（未记录→涌流内首个窗口自动建基；
//     之后每当该窗口自动刷新）。涌流外的全运气读数不代表涌流保底，不清/不更 ref。
//   · 非全运气时，currentDry ≥ 对应类型 ref 硬保底 → 洗点全加运气，直到出货再洗回。
//   · 比赛中冻结「主动洗点/洗回」（让比赛自己管加点），但若正处涌流全运气仍更新 ref。
//   · active 期间抑制自动加点、按是否全运气判断等。
async function evaluatePityTrigger(now, opts) {
  const t = m.pityTrigger;
  if (!t) return;
  const arcOn = m.pityTriggerArcane === true;
  const exoOn = m.pityTriggerExotic === true;
  const surgeOnly = m.pityTriggerSurgeOnly === true;
  const inSurge = !!(
    m.arcaneSacrifice && m.arcaneSacrifice.surge && m.arcaneSacrifice.surge.isActive
  );
  // 功能是否启用：至少一个类型开关开，且（非仅涌流 或 正处于涌流）。
  const featureOn = (arcOn || exoOn) && (!surgeOnly || inSurge);
  // 功能未启用（开关全关 或 仅涌流模式且当前非涌流）：若正处洗点锁定，则洗回释放
  // （避免自动加点被永久抑制），并清空在等标记。
  if (!featureOn) {
    t.armed = { arcane: false, exotic: false };
    if (t.active && !t.pending) {
      pityTriggerRestore().catch(() => {});
    }
    return;
  }

  const arcDrop = !!(opts && opts.arcaneDrop);
  const exoDrop = !!(opts && opts.exoticDrop);
  const ref = t.ref;

  // 当前是否「正处于全运气加点」（base 运气占比≥80%）。
  const allLuckNow = await isAllLuckNow();
  // 「可记录/刷新全运气硬保底基准」的窗口：仅当「正处于奥秘涌流」且「正处全运气」。
  // 硬保底杆数只在奥秘涌流天气下有意义，涌流外的全运气读数不代表涌流保底，故不记录。
  const recordRefNow = inSurge && allLuckNow;

  // ---- 已洗成全运气（active，等出货）----
  if (t.active) {
    if (t.pending) return;                       // 洗回/建基进行中，别重复操作
    // 处于涌流+全运气窗口才刷新基准（读当前硬保底；涌流外不更动，保留既有涌流基准）
    if (recordRefNow) updateRefFromStats().catch(() => {});
    // 出货 → 解除对应的 armed
    if (arcOn && arcDrop) t.armed.arcane = false;
    if (exoOn && exoDrop) t.armed.exotic = false;
    // 比赛接管时让比赛自己洗回，我们冻结恢复；非比赛且所有在等类型都出货 → 洗回
    if (!m.compActive && !t.armed.arcane && !t.armed.exotic) {
      t.pending = true;
      pityTriggerRestore().then((r) => {
        t.pending = false;
        if (r && r.ok) {
          let baitNote = '';
          if (r.useTopBait) baitNote = r.baitRestored ? '，已恢复原饵' : '，鱼饵未恢复';
          console.log('[monitor] 保底触发: 已出货，洗回原加点' + baitNote);
          sendWebhook('[Reelax] 🎯 保底触发：已出货，洗回原加点' + baitNote);
        } else {
          console.warn('[monitor] 保底触发洗回失败:', r && r.reason);
        }
      }).catch((e) => { t.pending = false; console.warn('[monitor] 保底触发洗回异常:', e); });
    } else if (m.compActive && !t.armed.arcane && !t.armed.exotic) {
      // 比赛接管：清 active（由其 respec 负责洗回），我们不再干预
      t.active = false;
    }
    return;
  }

  // ---- 未 active ----
  if (t.pending) return;
  // 正处全运气（用户/比赛/涌流手动全点运气）：不需我们洗点；只在涌流+全运气窗口记录/刷新基准。
  // 全运气时不触发洗点（本已全运气）。未建基时若正处涌流全运气，这里即完成首建，免多洗一次点。
  if (allLuckNow) {
    if (recordRefNow) updateRefFromStats().catch(() => {});
    return;
  }
  // 未建立基准 → 首次自动建基（洗全运气→读→洗回）；仅在奥秘涌流内建（记录的是涌流保底），
  // 非涌流/比赛中先不开火，等下次涌流窗口补建。
  if (!ref || !ref.built) {
    if (m.compActive || !inSurge) return;
    t.pending = true;
    buildRefBaseline().finally(() => { t.pending = false; }).catch(() => { t.pending = false; });
    return;
  }
  // 非全运气：比赛中不主动洗点（让比赛自己管）；比赛外才触发
  if (m.compActive) return;

  // 触发判定：currentDry ≥ 对应类型全运气硬保底基准
  const arcReach = arcOn && ref.arcane != null && now.arcane.currentDry != null && now.arcane.currentDry >= ref.arcane;
  const exoReach = exoOn && ref.exotic != null && now.exotic.currentDry != null && now.exotic.currentDry >= ref.exotic;
  if (!arcReach && !exoReach) return;   // 未达基准，保持现状

  t.armed.arcane = arcReach;
  t.armed.exotic = exoReach;
  if (arcDrop) t.armed.arcane = false;  // 若本次已达但也出货，不洗
  if (exoDrop) t.armed.exotic = false;
  if (!t.armed.arcane && !t.armed.exotic) return;

  t.pending = true;
  pityTriggerWash().then((r) => {
    t.pending = false;
    if (r && r.ok) {
      t.active = true;
      const who = t.armed.arcane && t.armed.exotic ? '奥秘&奇异' : (t.armed.arcane ? '奥秘' : '奇异');
      let baitNote = '';
      if (r.useTopBait) {
        baitNote = (r.baitResult && r.baitResult.ok) ? '，已切顶级饵' : '，顶级饵不可用（改当前设定饵）';
      }
      console.log(`[monitor] 保底触发: ${who} 已达全运气硬保底基准，已洗点全加运气${baitNote}`);
      sendWebhook(`[Reelax] 🎯 保底触发：${who} 已达全运气硬保底（奥秘 ${ref.arcane}/奇异 ${ref.exotic}），已洗点全加运气${baitNote}`);
      // 刚洗成全运气：若正处涌流窗口即刷新基准（涌流外洗点不更动 ref，避免被非涌流值污染）
      if (recordRefNow) updateRefFromStats().catch(() => {});
    } else {
      console.warn('[monitor] 保底触发洗点失败:', r && r.reason);
    }
  }).catch((e) => { t.pending = false; console.warn('[monitor] 保底触发洗点异常:', e); });
}

// ---------- 装备自动出售（API 版，替代 DOM 点击） ----------
// 与 scripts/自动出售库存.js 的筛选一致：卖 普通~史诗（common/uncommon/fine/rare/epic），
// 留 传说+；跳过已装备 / 已锁定 / 正在市场挂单的装备。
const GEAR_SELL_RARITIES = new Set(['common', 'uncommon', 'fine', 'rare', 'epic']);
const GEAR_SELL_INTERVAL_MS = 6 * 60 * 1000; // 每 6 分钟
let gearSellTimer = null;
let gearSellInProgress = false;

// 分页拉全量装备（接口单页上限 100，用 nextCursor 翻页）
async function fetchAllGear() {
  const out = [];
  let cursor = null;
  for (let i = 0; i < 20; i++) {
    const q = cursor ? `?limit=100&cursor=${encodeURIComponent(cursor)}` : '?limit=100';
    const r = await ReelaxApi.getJSON('/api/inventory/gear' + q);
    if (!r.ok || !r.data) break;
    const gear = Array.isArray(r.data.gear) ? r.data.gear : [];
    out.push(...gear);
    if (r.data.nextCursor && gear.length) { cursor = r.data.nextCursor; continue; }
    break;
  }
  return out;
}

async function autoSellGear() {
  if (!m.gearAutoSell) return;
  if (gearSellInProgress) return;
  gearSellInProgress = true;
  try {
    const gear = await fetchAllGear();
    const allowed = (Array.isArray(m.gearSellRarities) && m.gearSellRarities.length)
      ? new Set(m.gearSellRarities) : GEAR_SELL_RARITIES;
    const toSell = gear.filter((g) =>
      allowed.has(g.rarity) && !g.equippedSlot && !g.isLocked && !g.marketOrderId
    );
    if (!toSell.length) { m.lastGearSell = { ok: true, sold: 0, at: Date.now() }; return; }
    const res = await ReelaxApi.sellGear(toSell.map((g) => g.id));
    const ok = !!(res && res.ok);
    m.lastGearSell = { ok, sold: ok ? toSell.length : 0, count: toSell.length, at: Date.now() };
    console.log(`[monitor] 装备自动出售: ${ok ? '✅ 卖出 ' + toSell.length + ' 件' : '❌ ' + ((res && (res.body || res.error)) || '失败')}`);
    if (ok && m.gearSellNotify) {
      const byRarity = {};
      for (const g of toSell) byRarity[g.rarity] = (byRarity[g.rarity] || 0) + 1;
      const detail = Object.keys(byRarity).map((r) => `${r}×${byRarity[r]}`).join('、');
      sendWebhook(`[Reelax] ⚙️ 自动出售装备 ${toSell.length} 件（${detail}）`);
    }
  } catch (e) {
    m.lastGearSell = { ok: false, reason: String(e), at: Date.now() };
    console.warn('[monitor] 装备自动出售异常:', e);
  } finally {
    gearSellInProgress = false;
  }
}

function startGearSell() {
  if (gearSellTimer) clearInterval(gearSellTimer);
  gearSellTimer = setInterval(autoSellGear, GEAR_SELL_INTERVAL_MS);
}

// ---------- 鱼自动出售（API 版：只卖指定稀有度，超过保留上限的部分） ----------
// 需求口径：对勾选的每个稀有度（fishSellRarities，默认 ['uncommon']），各自保留 fishKeepMax 条，
// 卖出「超过的部分」，其余保留库存。卖鱼走 /api/inventory/fish/sell，body: { items: [{fishId, quantity}] }。
const FISH_RARITIES = new Set(['common', 'uncommon', 'fine', 'rare', 'epic']); // 参与自动出售的鱼稀有度全集
const FISH_SELL_LOCK_MS = 10000; // 单轮出售完成后锁 10 秒，防连续触发
let fishSellTimer = null;
let fishSellInProgress = false;
let fishSellLastAt = 0;

// 分页拉全量鱼库存（接口单响应返回全部鱼；有 nextCursor 则翻页兜底）。
// 返回 { fish, error }：fish 为鱼数组；error 非空表示拉取失败（无 reelax 页 / 签名失败 / 网络等），
// 此时 fish 为空但不代表库存真的为空，调用方需区分「拉取失败」与「库存为空」。
async function fetchAllFish() {
  const out = [];
  let cursor = null;
  let firstErr = null;
  for (let i = 0; i < 20; i++) {
    const r = await ReelaxApi.inventoryFish(500, cursor);
    if (!r.ok || !r.data) {
      if (i === 0) firstErr = (r && (r.error || 'http')) || 'http';
      break;
    }
    const fish = Array.isArray(r.data.fish) ? r.data.fish : [];
    out.push(...fish);
    if (r.data.nextCursor && fish.length) { cursor = r.data.nextCursor; continue; }
    break;
  }
  return { fish: out, error: firstErr };
}

// 纯函数：算要卖哪些鱼、卖多少（保留 keepMax 条该档鱼，卖出超出的部分）
// fishList: 该稀有度鱼数组 [{fishId, quantity, ...}]（未锁定、quantity>0 的）。
// 返回 { items, sold, total }：items 为 sell API 的 body 数组，sold 为本次卖出的条数，total 为该档总数。
// 策略：总数量 - keepMax = 需卖数量；按数量降序逐种处理，尽量少动鱼种、需要时用部分数量凑齐。
function buildFishSellItems(fishList, keepMax) {
  const total = fishList.reduce((s, f) => s + (f.quantity || 0), 0);
  if (total <= keepMax) return { items: [], sold: 0, total };
  let toSell = total - keepMax;
  const items = [];
  let sold = 0;
  const sorted = fishList.slice().sort((a, b) => (b.quantity || 0) - (a.quantity || 0));
  for (const f of sorted) {
    if (toSell <= 0) break;
    const q = Math.min(f.quantity || 0, toSell);
    if (q > 0) {
      items.push({ fishId: f.fishId, quantity: q });
      sold += q;
      toSell -= q;
    }
  }
  return { items, sold, total };
}

async function checkAndSellFish() {
  if (!m.fishAutoSell || !m.enabled) return;
  if (fishSellInProgress) return;
  if (Date.now() - fishSellLastAt < FISH_SELL_LOCK_MS) return;
  fishSellInProgress = true;
  const checkedAt = Date.now();
  m.fishSellChecks = (m.fishSellChecks || 0) + 1; // 每轮真实执行计数（含未超上限），popup 可验证循环在跑
  try {
    const rarities = (Array.isArray(m.fishSellRarities) && m.fishSellRarities.length)
      ? m.fishSellRarities.filter((r) => FISH_RARITIES.has(r)) : ['uncommon'];
    const keepMax = Number(m.fishKeepMax) > 0 ? Number(m.fishKeepMax) : 20000;
    const { fish: all, error } = await fetchAllFish();
    // 拉取失败（无 reelax 页 / 签名失败等）→ 显示为「查询失败」，不要伪装成「未超上限」
    if (error) {
      m.fishSell = { ok: false, reason: 'fetch-failed', error: error, checkedAt, at: checkedAt };
      console.warn('[monitor] 鱼自动出售: 库存查询失败(' + error + ')，跳过本轮');
      return;
    }
    if (!all.length) {
      // 库存确实为空
      m.fishSell = { ok: true, reason: 'empty', sold: 0, total: 0, kept: 0, rarities, checkedAt, at: checkedAt };
      console.log('[monitor] 鱼自动出售: 库存为空，不卖');
      return;
    }
    // 对每个目标稀有度：各自保留 keepMax、卖出超出部分，累计汇总
    let sold = 0, keptAll = 0, totalAll = 0;
    const allItems = [];
    const perRarity = {};
    for (const rarity of rarities) {
      const target = all.filter((f) =>
        f.rarity === rarity && !f.isLocked && !f.isManuallyLocked && !f.isMasteryLocked && (f.quantity || 0) > 0
      );
      const plan = buildFishSellItems(target, keepMax);
      allItems.push(...plan.items);
      if (plan.items.length) {
        perRarity[rarity] = { sold: plan.sold, total: plan.total, kept: Math.max(0, plan.total - plan.sold) };
        sold += plan.sold;
      }
      totalAll += plan.total;
      keptAll += Math.max(0, plan.total - plan.sold);
    }
    if (!allItems.length) {
      // 各档总数均未超过 keepMax → 不卖，但记录真实总数，popup 展示「共 X / 保留 Y」便于核对
      m.fishSell = { ok: true, reason: 'under-limit', sold: 0, total: totalAll, kept: keepMax, rarities, checkedAt, at: checkedAt };
      console.log('[monitor] 鱼自动出售: ' + rarities.join('/') + ' 合计 ' + totalAll + ' 条，未超过 ' + keepMax + '，不卖');
      return;
    }
    const res = await ReelaxApi.sellFish(allItems);
    const ok = !!(res && res.ok);
    if (ok) {
      m.fishSoldTotal += sold;
      persistStats(); // 卖出后立即持久化累计计数，重启不丢
    }
    m.fishSell = {
      ok,
      reason: ok ? 'sold' : (res && (res.error || (res.body || '').slice(0, 120))) || 'http',
      status: res ? res.status : null,
      errorBody: res ? res.body : '',
      sold,
      total: totalAll,
      kept: Math.max(0, totalAll - sold),
      rarities,
      perRarity,
      checkedAt,
      at: checkedAt,
    };
    fishSellLastAt = checkedAt;
    if (ok) {
      console.log('[monitor] 鱼自动出售: ' + rarities.join('/') + ' 卖出 ' + sold + ' 条（合计 ' + totalAll + '，保留 ' + Math.max(0, totalAll - sold) + '）', perRarity);
    } else {
      console.warn('[monitor] 鱼自动出售失败: ' + m.fishSell.reason + ' ' + m.fishSell.errorBody);
    }
  } catch (e) {
    m.fishSell = { ok: false, reason: String(e), checkedAt, at: checkedAt };
    console.warn('[monitor] 鱼自动出售异常:', e);
  } finally {
    fishSellInProgress = false;
  }
}

function startFishSell() {
  if (fishSellTimer) clearInterval(fishSellTimer);
  fishSellTimer = null;
  if (!m.fishAutoSell || !m.enabled) return;
  fishSellTimer = setInterval(checkAndSellFish, Math.max(60000, m.fishSellCheckSec * 1000));
}

// ---------- 自动加专精（mastery contribute-all） ----------
// 自动加专精：地图 id 取 sync.boatBiomeId（即 b_004 这类 biome id）
const MASTERY_CHECK_MS = 600000; // 10 分钟
let masteryCheckTimer = null;
let masteryInProgress = false;

async function contributeMastery() {
  m.lastMasteryResult = { at: Date.now() };
  if (!m.autoMastery) { m.lastMasteryResult.reason = 'disabled'; return; }
  if (masteryInProgress) { m.lastMasteryResult.reason = 'locked'; return; }
  const mapId = m.sync && m.sync.boatBiomeId;
  if (!mapId) { m.lastMasteryResult.reason = 'no-map'; return; }
  masteryInProgress = true;
  m.lastMasteryResult = { at: Date.now(), reason: 'contributing', mapId };
  try {
    // 无请求体：传 null 时不带 content-type，与前端空贡献一致
    const res = await ReelaxApi.contributeMastery(mapId);
    if (res && res.ok) {
      m.lastMasteryResult = { ok: true, status: res.status, mapId, at: Date.now() };
      console.log(`[monitor] 自动加专精完成: ${mapId}`);
    } else {
      m.lastMasteryResult = {
        ok: false,
        reason: (res && res.error) || 'http',
        status: res ? res.status : null,
        errorBody: (res && res.body) || (res && res.error) || '',
        mapId,
        at: Date.now(),
      };
      console.warn(`[monitor] 自动加专精失败: ${m.lastMasteryResult.reason} ${m.lastMasteryResult.errorBody}`);
    }
  } catch (e) {
    m.lastMasteryResult = { ok: false, reason: String(e), mapId, at: Date.now() };
    console.warn('[monitor] 自动加专精异常:', e);
  } finally {
    masteryInProgress = false;
  }
}

function startMasteryCheck() {
  if (masteryCheckTimer) clearInterval(masteryCheckTimer);
  masteryCheckTimer = setInterval(contributeMastery, MASTERY_CHECK_MS);
}

// ---------- 5. 保底监控（奥秘/奇异鱼出货通知） ----------
// 数据源：/api/statistics 的 pity 字段（服务端保底计数器，需签名）。
//
// 【保底是什么（大白话）】奥秘/奇异鱼这类稀有不保证每杆都出，游戏有个
// 「连续没出」计数器：
//   - currentDryCasts（currentDry）：距上次出货已连续多少杆没出。
//   - 软保底 maxDryCasts（maxDry）：干涸计数达到这个值后，出货概率爬到
//     最高，之后「随时可能出」，但还不是必出。
//   - 硬保底 hardPityCasts（hardPity）：干涸计数达到这个值后「必出」（100%）。
//   - 进度百分比 pct = currentDry / hardPity × 100%：到硬保底正好 100%，
//     超过硬保底会显示 >100%（比如 105% 就是已超硬保底 5%）。
//     日志/通知里同时保留 X/Y 原始杆数，方便看「当前到底多少杆了」。
//
// 事件判定（对照两次采样）：
//   - 出货：currentDryCasts 大幅回落（计数器重置）→ webhook 通知
//   - 软保底满：currentDryCasts >= maxDryCasts（概率已满，随时可能出）
//   - 逼近硬保底：硬保底 - currentDryCasts <= pityHardMargin
// 每种事件每「保底循环」只通知一次（出货后重新武装标志位）。
const PITY_CHECK_MS_MIN = 60000; // 检查间隔下限 60 秒
// 保底检查 + 日报采集共用的间隔：跟随设置页 pityCheckSec（最小 60s），两者同频共用一次 /api/statistics
function pityIntervalMs() {
  return Math.max(PITY_CHECK_MS_MIN, (m && m.pityCheckSec > 0 ? m.pityCheckSec : 300) * 1000);
}
let pityCheckTimer = null;
let pityInProgress = false;

async function checkPity() {
  if (!m.pityMonitor || !m.enabled) return;
  if (pityInProgress) return;
  pityInProgress = true;
  try {
    // 带超时保护：页面重载/executeScript 卡住时，30s 后强制结束本轮，
    // 避免 pityInProgress 永久占用导致后续检查全部被拦（保底一直显示—）。
    const res = await Promise.race([
      ReelaxApi.statistics(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('pity-check-timeout(30s)')), 30000)),
    ]);
    if (res && res.ok) {
      try {
        parsePity(JSON.parse(res.body));
      } catch (e) {
        m.lastPityError = 'parse: ' + String(e);
        console.warn('[monitor] 保底解析失败:', e);
      }
    } else {
      m.lastPityError = (res && (res.error || (res.body || '').slice(0, 120))) || 'fetch-failed';
      console.warn(`[monitor] 保底查询失败: ${m.lastPityError}`);
    }
  } catch (e) {
    m.lastPityError = String(e);
    console.warn('[monitor] 保底查询异常:', e);
  } finally {
    pityInProgress = false;
  }
}

function parsePity(data) {
  const p = data && data.pity;
  const prevStats = m.statsRarities; // 上一次采样的「各稀有度累计渔获数」（用于 fishCaught 差值触发出货通知）
  // 数量通道加固：rarities 数组偶发缺一项/某 fishCaught 非 number 时，绝不把累计基准清成 0 或错乱。
  // 仅对「解析到合法 number」的稀有度更新；缺失/非法的稀有度继承上一轮基准（prevStats）。
  if (data && Array.isArray(data.rarities)) {
    const rars = { exotic: undefined, arcane: undefined };
    for (const r of data.rarities) {
      if (r && (r.rarity === 'exotic' || r.rarity === 'arcane') && typeof r.fishCaught === 'number') rars[r.rarity] = r.fishCaught;
    }
    const nextExo = rars.exotic !== undefined ? rars.exotic : (prevStats && prevStats.exotic);
    const nextArc = rars.arcane !== undefined ? rars.arcane : (prevStats && prevStats.arcane);
    if (nextExo !== undefined || nextArc !== undefined) {
      m.statsRarities = {
        exotic: nextExo,
        arcane: nextArc,
        serverTime: data.serverTime || null,
        at: Date.now(),
      };
    }
  }
  if (!p || !p.arcane || !p.exotic) return;
  const prev = m.pity;
  // 出货触发（新方法）：鱼获计数比上一采样增加 1+ 即判定出货（累计计数在任意采样间隔下都不漏）。
  // 兼保留杆数回落 detectDrop 作为兜底（统计未就绪时也能触发）。
  const deltaDrop = (key) => (!!prevStats && !!m.statsRarities
    && prevStats[key] != null && m.statsRarities[key] != null
    && m.statsRarities[key] > prevStats[key]);
  // 进度百分比 = currentDry / hardPity（到硬保底 = 100%，可以超过 100%）
  // hardPityCasts 为 null = 当前不追踪硬保底（例如道具不带保底），此时 pct=null、不触发 90%/逼近必出通知，属预期。
  const pctOf = (cur, hard) => (cur != null && hard > 0) ? cur / hard * 100 : null;
  const now = {
    updatedAt: Date.now(),
    effectiveLuck: p.effectiveLuck ?? null,
    luckTier: p.luckTier ?? null,
    baitId: p.baitId ?? null,
    weatherId: p.weatherId ?? null,
    arcane: {
      currentDry: p.arcane.currentDryCasts ?? null,
      maxDry: p.arcane.maxDryCasts ?? null,
      hardPity: p.arcane.hardPityCasts ?? null,
    },
    exotic: {
      currentDry: p.exotic.currentDryCasts ?? null,
      maxDry: p.exotic.maxDryCasts ?? null,
      hardPity: p.exotic.hardPityCasts ?? null,
    },
    // 通知标志跨循环/跨重启保留（storage 持久化），避免重复轰炸
    notified: (prev && prev.notified)
      ? { ...prev.notified }
      : { arc90: false, hardArcane: false, exo90: false, arcDrop: false, exoDrop: false },
  };
  now.arcane.pct = pctOf(now.arcane.currentDry, now.arcane.hardPity);
  now.exotic.pct = pctOf(now.exotic.currentDry, now.exotic.hardPity);

  // ---- 挂机日报：宽松出货检测（独立于 webhook 的严格 detectDrop）----
  // webhook 的 detectDrop 要求「旧值 >300 且回落超一半」，会漏掉中短杆出货（如 150 杆就出）。
  // 这里只要上一轮 currentDry 高于一个「远离正常单轮噪声」的地板(60)，且本轮回落到其 30% 以下
  // （计数器大幅重置）就判定一次出货计入日报。用 _dailyDropMarks 去重，避免同一次出货重复计数。
  const DAILY_DROP_FLOOR = 10;   // 上一轮干涸计数 RESET 判定的低地板：>此值才可能判定出货（防止把初始 ~0 基线误判），但降到 ~10 以便连出的几次都能各自被计到
  const DAILY_DROP_RATIO = 0.30; // 本轮回落至上一轮的 30% 以下视为出货
  const DAILY_REARM_FLOOR = 10;  // 出货后干涸计数爬过此值即“重新武装”，允许计数下一次出货（低于检测地板无关，只要一次出货复位后重新采集到即可）
  if (!m._dailyDropMarksReactive) {
    m._dailyDropMarksReactive = { arcane: false, exotic: false };
  }
  const dailyDrop = (key, cur) => {
    const oldDry = prev && prev[key] && prev[key].currentDry;
    if (oldDry == null || oldDry <= DAILY_DROP_FLOOR) return false;
    const dropped = cur.currentDry != null && cur.currentDry < oldDry * DAILY_DROP_RATIO;
    if (!dropped) return false;
    if (m._dailyDropMarksReactive[key]) return false; // 已为本次出货记过
    m._dailyDropMarksReactive[key] = true;
    return true;
  };
  if (dailyDrop('arcane', now.arcane)) dailyRecordDrop('arcane');
  if (dailyDrop('exotic', now.exotic)) dailyRecordDrop('exotic');
  // 出货接收：新一轮干涸重新爬过低地板后解除标记（允许下一次出货再记；低地板让连出都能被记到）
  if (now.arcane.currentDry != null && now.arcane.currentDry > DAILY_REARM_FLOOR) m._dailyDropMarksReactive.arcane = false;
  if (now.exotic.currentDry != null && now.exotic.currentDry > DAILY_REARM_FLOOR) m._dailyDropMarksReactive.exotic = false;

  // 距硬保底剩余时间：剩余杆数 × 6 秒/杆（在线循环周期固定 6s），返回裸时长
  const fmtRemain = (cur, cap) => {
    if (cur == null || cap == null || cap <= 0) return '';
    const remainCasts = cap - cur;
    if (remainCasts <= 0) return '已到期';
    const mm = Math.round(remainCasts * 6 / 60);
    if (mm < 60) return mm + '分';
    return Math.floor(mm / 60) + '时' + (mm % 60 ? (mm % 60) + '分' : '');
  };
  // 出货检测：上一轮干涸计数明显很高(>300)且本轮回落超过一半 → 判定为出货（计数器重置）。
  // 收窄判定：在线钓鱼 6s/杆、检查间隔 ≥60s，正常单轮 currentDry 只 +10 左右；
  // 旧逻辑容差仅 100 杆，网络/缓存乱序导致读数偶降 100+ 即误判出货、反复轰炸。
  // 改为「旧值够高 + 回落超一半」大幅降低噪声误触（奥秘杆数长更易踩旧逻辑，故奇异相对好些）。
  const detectDrop = (key, cur) => {
    if (!prev || !prev[key]) return false;
    const oldDry = prev[key].currentDry;
    return oldDry != null && oldDry > 300 && cur.currentDry != null && cur.currentDry < oldDry * 0.5;
  };

  // 出货通知去重武装：
//   · 新方法(fishCaught 差值)：一旦检测到该稀有度计数比上采样增加（新出货），先解除武装 → 本次就会发通知。
//   · 兜底(detectDrop 杆数回落)：干捞计数重新爬过地板(>300)才解除武装。
// 阈值须高于 detectDrop 下限(300)，且远高于正常单轮噪声，避免边界反复解除/触发。
  const REARM_DROP_CASTS = 300;
  if (deltaDrop('arcane')) now.notified.arcDrop = false;   // 新出货出现 → 本次允许通知
  if (deltaDrop('exotic')) now.notified.exoDrop = false;
  // 无新增渔获时：仅当干捞计数爬回地板才为 detectDrop 兜底重新武装
  if (!deltaDrop('arcane') && now.arcane.currentDry != null && now.arcane.currentDry > REARM_DROP_CASTS) now.notified.arcDrop = false;
  if (!deltaDrop('exotic') && now.exotic.currentDry != null && now.exotic.currentDry > REARM_DROP_CASTS) now.notified.exoDrop = false;

  // 终极兜底：同稀有度出货通知最小间隔（5 分钟），防止任何边界噪声仍导致重复轰炸。
  const DROP_MIN_INTERVAL_MS = 5 * 60 * 1000;
  const dropTooSoon = (k) => {
    const at = (m.pityNotifiedAt && m.pityNotifiedAt[k]) ? m.pityNotifiedAt[k] : 0;
    return !!at && (Date.now() - at) < DROP_MIN_INTERVAL_MS;
  };

  if ((deltaDrop('arcane') || detectDrop('arcane', now.arcane)) && !now.notified.arcDrop && !dropTooSoon('arcane')) {
    sendWebhook(`[Reelax] 🎉 奥秘鱼出货！距上次奥秘已连续 ${prev.arcane.currentDry} 杆未出`);
    now.notified.arcDrop = true;   // 已通知，同一次出货不重复播报
    now.notified.arc90 = false;    // 新循环重新武装
    now.notified.hardArcane = false;
    if (!m.pityNotifiedAt) m.pityNotifiedAt = {};
    m.pityNotifiedAt.arcane = Date.now();  // 记录本次通知时间（最小间隔兜底）
  }
  if ((deltaDrop('exotic') || detectDrop('exotic', now.exotic)) && !now.notified.exoDrop && !dropTooSoon('exotic')) {
    sendWebhook(`[Reelax] ✨ 奇异鱼出货！距上次奇异已连续 ${prev.exotic.currentDry} 杆未出`);
    now.notified.exoDrop = true;   // 已通知，同一次出货不重复播报
    now.notified.exo90 = false;
    if (!m.pityNotifiedAt) m.pityNotifiedAt = {};
    m.pityNotifiedAt.exotic = Date.now();  // 记录本次通知时间（最小间隔兜底）
  }

  // 进度达 90%：接近硬保底提醒一次（原“软保底满”在 ~18% 就触发，过早；改为 90% 才提醒）
  if (now.arcane.pct != null && now.arcane.pct >= 90 && !now.notified.arc90) {
    sendWebhook(`[Reelax] ⚠️ 奥秘进度达 90%：已连续 ${now.arcane.currentDry} 杆未出（进度 ${now.arcane.pct.toFixed(1)}%，约${fmtRemain(now.arcane.currentDry, now.arcane.hardPity)}后到硬保底）`);
    now.notified.arc90 = true;
  }
  // 逼近硬保底：剩余 ≤ pityHardMargin 杆，必出预警
  if (now.arcane.hardPity != null && now.arcane.currentDry != null
    && now.arcane.hardPity - now.arcane.currentDry <= m.pityHardMargin && !now.notified.hardArcane) {
    sendWebhook(`[Reelax] 🚨 距奥秘硬保底仅剩 ${now.arcane.hardPity - now.arcane.currentDry} 杆（进度 ${now.arcane.pct.toFixed(1)}%），约${fmtRemain(now.arcane.currentDry, now.arcane.hardPity)}后必出！`);
    now.notified.hardArcane = true;
  }
  // 奇异进度达 90%（原“软保底满”过早触发，改为 90% 才提醒）
  if (now.exotic.pct != null && now.exotic.pct >= 90 && !now.notified.exo90) {
    sendWebhook(`[Reelax] ⚠️ 奇异进度达 90%：已连续 ${now.exotic.currentDry} 杆未出（进度 ${now.exotic.pct.toFixed(1)}%，约${fmtRemain(now.exotic.currentDry, now.exotic.hardPity)}后到硬保底）`);
    now.notified.exo90 = true;
  }

  // 保底触发状态机推进（基于全运气硬保底基准 洗点全运气/出货洗回）；比赛期间由 evaluatePityTrigger 自行冻结
  evaluatePityTrigger(now, {
    arcaneDrop: deltaDrop('arcane') || detectDrop('arcane', now.arcane),
    exoticDrop: deltaDrop('exotic') || detectDrop('exotic', now.exotic),
  });

  m.pity = now;
  m.lastPityError = null;
  // 展示格式：进度百分比为主（到保底=100%，可超100%），括号里保留 X/Y 当前杆数 + 剩余时间
  const arcPct = now.arcane.pct != null ? `${now.arcane.pct.toFixed(1)}%` : '-';
  const exoPct = now.exotic.pct != null ? `${now.exotic.pct.toFixed(1)}%` : '-';
  const arcRemain = fmtRemain(now.arcane.currentDry, now.arcane.hardPity);
  const exoRemain = fmtRemain(now.exotic.currentDry, now.exotic.hardPity);
  console.log(
    `[monitor] 保底: 奥秘 ${arcPct}（${now.arcane.currentDry}/${now.arcane.hardPity}，约${arcRemain}） | 奇异 ${exoPct}（${now.exotic.currentDry}/${now.exotic.hardPity}，约${exoRemain}） | 有效运气 ${now.effectiveLuck}`,
  );
}

function startPityCheck() {
  if (pityCheckTimer) clearInterval(pityCheckTimer);
  pityCheckTimer = null;
  if (!m.pityMonitor || !m.enabled) return;
  pityCheckTimer = setInterval(checkPity, pityIntervalMs());
  checkPity(); // 启动即查一次，建立基线
}

// 节流版保底检查：挂在 sync 唤醒路径上（setInterval 在 SW 休眠下不跑，靠这个保证出货不漏判）。
// 节流到 pityCheckSec（>=最小值）避免打爆 /api/statistics 频率预算。
let _pityLastThrottleAt = 0;
function checkPityThrottled() {
  const interval = pityIntervalMs();
  const now = Date.now();
  if (now - _pityLastThrottleAt < interval) return;
  _pityLastThrottleAt = now;
  if (!m.pityMonitor || !m.enabled) return;
  try { checkPity(); } catch (e) { console.warn('[monitor] sync 触发保底检查异常:', e); }
}

// 定时查 /api/player/stats 拿真实未分配点数并加点（不依赖 sync 补丁字段，更可靠）
const ALLOCATE_CHECK_MS = 60000;
let allocateCheckTimer = null;

async function checkAndAllocate() {
  if (!m.autoAllocate) return;
  try {
    const r = await ReelaxApi.playerStats();
    if (r.ok) {
      const unspent = r.player && r.player.unspentStatPoints;
      if (m.sync && unspent != null) m.sync.unspentStatPoints = unspent;
      if (unspent > 0) await autoAllocate(unspent);
    } else {
      m.lastAllocateResult = {
        ok: false,
        reason: r.error || 'stats-fetch-failed',
        status: r.status || null,
        errorBody: r.body || '',
        at: Date.now(),
      };
      console.warn(`[monitor] 查点数失败: ${m.lastAllocateResult.reason} ${m.lastAllocateResult.errorBody}`);
    }
  } catch (e) {
    m.lastAllocateResult = { ok: false, reason: String(e), at: Date.now() };
    console.warn('[monitor] 查点数异常:', e);
  }
}

function startAllocateCheck() {
  if (allocateCheckTimer) clearInterval(allocateCheckTimer);
  allocateCheckTimer = setInterval(checkAndAllocate, ALLOCATE_CHECK_MS);
}

// ---------- 2. sync 数据捕获（filterResponseData 读取响应体） ----------
// 从 fishing/sync 响应里提取精选字段，存入 m.sync 供 popup 展示。
// 注意：必须把数据原样 write 回响应流，否则页面请求会被挂起；任何异常都 disconnect 释放。
function setupSyncCapture() {
  if (!browser.webRequest || typeof browser.webRequest.filterResponseData !== 'function') return;
  browser.webRequest.onBeforeRequest.addListener((details) => {
    const filter = browser.webRequest.filterResponseData(details.requestId);
    const decoder = new TextDecoder('utf-8');
    let text = '';
    filter.ondata = (event) => {
      text += decoder.decode(event.data, { stream: true });
      filter.write(event.data); // 原样透传，不改动响应
    };
    filter.onstop = () => {
      text += decoder.decode();
      try { parseSync(text); } catch (e) { /* 非 JSON 忽略 */ }
      try { filter.disconnect(); } catch (_) {}
    };
    filter.onerror = () => {
      try { filter.disconnect(); } catch (_) {}
    };
  }, { urls: ['*://reelax.cn/api/fishing/sync*', '*://reelax.cn/api/fishing/state*'] }, ['blocking']);
}

// 从 sync 响应体提取展示字段
function parseSync(raw) {
  let body;
  try { body = JSON.parse(raw); } catch (e) { return; }
  if (!body || typeof body !== 'object') return;
  const run = body.run || {};
  const batch = body.batchSummary || {};
  const harvest = body.dailyHarvest || {};
  const player = body.playerPatch || {};
  const party = body.party || {};
  const last = body.lastResult || {};

  // 期望杆数：今日0点 → 当前时刻，按 6.1 秒/杆折算取整。
  // 今日0点 = nextDailyHarvestResetAt 往前推 24h（服务器每天 16:00Z 重置，即北京时间 0 点），
  // 时间基准用服务器时间，避免本地时钟偏差。
  const CAST_INTERVAL_MS = 6100;
  let expectedCasts = null;
  const resetAtMs = body.nextDailyHarvestResetAt ? Date.parse(body.nextDailyHarvestResetAt) : NaN;
  const serverNowMs = body.serverTime ? Date.parse(body.serverTime) : NaN;
  if (Number.isFinite(resetAtMs) && Number.isFinite(serverNowMs)) {
    const dayStartMs = resetAtMs - 24 * 60 * 60 * 1000; // 今日 0 点
    const elapsedMs = serverNowMs - dayStartMs;
    if (elapsedMs > 0) expectedCasts = Math.floor(elapsedMs / CAST_INTERVAL_MS);
  }

  m.sync = {
    updatedAt: Date.now(),
    runStatus: run.status ?? null,
    runMode: run.mode ?? null,
    remainingCasts: run.remainingCasts ?? null,
    totalCasts: run.totalCasts ?? null,
    batchGold: batch.gold ?? null,
    batchCasts: batch.casts ?? null,
    batchExp: batch.experience ?? null,
    guildTax: batch.guildTaxGold ?? null,
    directGoldGross: batch.directGoldGross ?? null,
    dailyNetGold: harvest.netGold ?? null,
    dailyCasts: harvest.casts ?? null,
    expectedCasts, // 今日期望杆数（按 6.1s/杆折算）
    level: player.level ?? null,
    gold: player.gold ?? null,
    relics: player.relics ?? null,
    fragments: player.fragments ?? null,
    exp: player.experience ?? null,
    expToNext: player.experienceToNextLevel ?? null,
    unspentStatPoints: player.unspentStatPoints ?? null,
    lastResult: (last.gold != null || last.fishId) ? {
      kind: last.kind ?? null,
      fishId: last.fishId ?? null,
      rarity: last.rarity ?? null,
      quantity: last.quantity ?? null,
      gold: last.gold ?? null,
      experience: last.experience ?? null,
    } : null,
    boatName: party.boatName ?? null,
    partyRole: party.role ?? null,
    boatBiomeId: party.boatBiomeId ?? null,
    rentalEndsAt: party.rentalEndsAt ?? null,
    onlinePlayers: body.onlinePlayerCount ?? null,
    lastN: m.sync && Array.isArray(m.sync.lastN) ? m.sync.lastN : [], // 近N杆采样 {exp,gold,ts}
    // 无新杆（lastResult 为空）时保留上次预测，避免 levels 被重置后 webhook 拿不到下5级
    eta: (m.sync && m.sync.eta) || null, // 预计升级 {seconds, avgExp, avgGold, casts, neededExp}
    levels: (m.sync && m.sync.levels) || null, // 下1~5级预测 [{rank, level, neededExp, seconds}]
  };

  // 升级后不清空采样窗口：仅经验条上限变化，收益节奏不变，滑动窗口应沿用

  // 累积最近一杆收益（环形缓冲）
  if (last.gold != null || last.experience != null) {
    m.sync.lastN.push({ exp: last.experience ?? 0, gold: last.gold ?? 0, ts: Date.now() });
    if (m.sync.lastN.length > ETA_WINDOW) m.sync.lastN.shift();
    computeEta(m.sync);
  }

  // 有待分配属性点 → 触发自动加点（sync 补丁快速路径；定时查 stats 兜底）
  if (m.sync.unspentStatPoints > 0) setTimeout(() => autoAllocate(m.sync.unspentStatPoints), 0);
}

// 升到下一级所需经验公式（游戏固定公式）：floor(100 + 29.0908424 × level^1.5614014)
function expForNextLevel(level) {
  if (level == null || level <= 0) return null;
  return Math.floor(100 + 29.0908424 * Math.pow(level, 1.5614014));
}

// 下一个 1000 级里程碑：严格大于当前等级的最小 1000 倍数
// 例：2160 → 3000（中间差 840 级）
function nextThousandLevel(level) {
  if (level == null || level <= 0) return null;
  return Math.floor(level / 1000) * 1000 + 1000;
}

// 用最近 N 杆平均收益预测升级所需时间（下 1~5 级）
function computeEta(sync) {
  const arr = sync.lastN || [];
  const n = arr.length;
  if (n < 3) { sync.eta = null; sync.levels = null; return; } // 样本太少，先不算
  let expSum = 0, goldSum = 0;
  for (const r of arr) { expSum += r.exp; goldSum += r.gold; }
  const avgExp = expSum / n;
  // 每杆间隔：相邻采样时间差平均值（防跳变，>60s 的间隔丢弃）
  let tsSum = 0, cnt = 0;
  for (let i = 1; i < n; i++) {
    const d = arr[i].ts - arr[i - 1].ts;
    if (d > 0 && d < 60000) { tsSum += d; cnt++; }
  }
  const avgMs = cnt ? tsSum / cnt : 6000;
  const needed = (sync.expToNext != null ? sync.expToNext : 0) - (sync.exp ?? 0);
  if (needed <= 0 || avgExp <= 0) { sync.eta = null; sync.levels = null; return; }
  const seconds = (needed / avgExp) * (avgMs / 1000);
  sync.eta = {
    seconds: Math.round(seconds),
    avgExp: Math.round(avgExp),
    avgGold: Math.round(goldSum / n),
    casts: n,
    neededExp: Math.round(needed),
  };

  // 下 1~5 级：逐级累加所需经验（当前剩余 + 各级公式值），折算到达时间
  const levels = [];
  if (sync.level != null) {
    let cumulative = needed;
    for (let k = 1; k <= 5; k++) {
      if (k > 1) {
        const nextReq = expForNextLevel(sync.level + k - 1);
        if (nextReq == null) break;
        cumulative += nextReq;
      }
      levels.push({
        rank: k,
        level: sync.level + k,
        neededExp: Math.round(cumulative),
        seconds: Math.round((cumulative / avgExp) * (avgMs / 1000)),
      });
    }

    // 下一个 1000 级里程碑：累计当前剩余 + 中间每一级的升级经验
    const thousand = nextThousandLevel(sync.level);
    if (thousand != null) {
      const diff = thousand - sync.level; // 跨越的等级数，例：2160→3000 为 840
      let cum = needed;
      for (let i = sync.level + 1; i < thousand; i++) {
        const req = expForNextLevel(i);
        if (req == null) break;
        cum += req;
      }
      levels.push({
        rank: 1000,
        level: thousand,
        neededExp: Math.round(cum),
        seconds: Math.round((cum / avgExp) * (avgMs / 1000)),
        milestone: true,
      });
    }
  }
  sync.levels = levels.length ? levels : null;
}

// ---------- 3. 掉线检测 ----------
function startOfflineCheck() {
  if (checkTimer) clearInterval(checkTimer);
  let prevIdleMs = 0; // 上次检查时的失联时长，用于累计失联增量
  checkTimer = setInterval(() => {
    if (!m.enabled || !m.lastActivityAt) return;
    const now = Date.now();
    const idleMs = now - m.lastActivityAt;
    m.idleSec = Math.floor(idleMs / 1000);
    // 失联累计：仅当真正失联（超过一个检查周期无心跳）时，把失联增量计入总失联合计。
    // idleMs > prevIdleMs 保证心跳恢复（idleMs 回落）时停止累计。
    if (idleMs > OFFLINE_CHECK_MS && idleMs > prevIdleMs) {
      m.offlineTotalSec += (idleMs - prevIdleMs) / 1000;
    }
    prevIdleMs = idleMs;
    // 启动宽限期：刚打开页面还没首个心跳时不判掉线
    if (now - initializedAt < INITIAL_GRACE_MS) return;
    if (idleMs >= m.offlineCheckMin * 60 * 1000) {
      // 【SW 休眠/唤醒误判保护】心跳停可能只是 MV3 SW 休眠期间 lastActivityAt 停滞
      // （SW 休眠时页面可能仍在前端发请求，但 webRequest 不触发、心跳不更新），
      // 而非真掉线。判掉线前先主动探测网站是否可达：
      //   · 网站可达(HTTP 2xx) → 说明是 SW 休眠造成的"假掉线"，只重置心跳、不刷新页面；
      //   · 网站不可达 → 才是真掉线，刷新页面恢复。
      doProbeBeforeReload(reloadTabs);
      return;
    }
  }, OFFLINE_CHECK_MS);
}

// 掉线前探活：异步 fetch /api/me，按结果决定 重置心跳 或 真正刷新。
function doProbeBeforeReload(doReload) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  fetch('https://reelax.cn/api/me', {
    credentials: 'include',
    headers: { Accept: 'application/json' },
    signal: ctrl.signal,
  }).then((r) => {
    clearTimeout(timer);
    if (r && r.ok) {
      // 网站可达 → SW 休眠误判，重置心跳不刷新
      console.warn('[monitor] 心跳超时但网站可达（疑似 SW 休眠误判），重置心跳不刷新');
      m.lastActivityAt = Date.now();
      m.idleSec = 0;
    } else {
      // 网站 4xx/5xx（登录失效等）：不刷新，交给 checkLoginAndProof 统一处理
      console.warn('[monitor] 心跳超时且网站异常，暂不刷新(HTTP ' + (r && r.status) + ')');
    }
  }).catch(() => {
    clearTimeout(timer);
    // 网站不可达 → 真掉线，刷新恢复；刷新后清空失联时间，从此刻重新计时
    doReload('offline');
    m.lastActivityAt = Date.now();
    m.idleSec = 0;
}).finally(() => {
    clearTimeout(timer);
  });
}

// ---------- 3. 登录态 + proof 主动验证 ----------
async function checkLoginAndProof() {
  if (!m.enabled) return;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    const r = await fetch('https://reelax.cn/api/me', {
      credentials: 'include',
      headers: { Accept: 'application/json' },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    m.loginOk = r.ok;
    // 同步给 bridge 状态，popup「登录态」读的就是它（bridge 自身 5 分钟才探测一次，
    // 启动竞态时会显示过期结果；这里 30 秒探测为准，实时纠正）
    if (window.__bridgeStatus) {
      window.__bridgeStatus.loginOk = r.ok;
      if (r.ok) window.__bridgeStatus.lastError = null;
    }
    if (r.ok) {
      const proof = r.headers.get('x-arcane-request-proof');
      if (proof) {
        m.proofOk = true;
        m.proofUpdatedAt = Date.now();
        if (window.__bridgeStatus) window.__bridgeStatus.proofOk = true;
      }
      m.lastError = null;
      return;
    }
    // 操作频繁/限流/瞬时错误不误判为登出：仅 401/403（明确未认证）才算登录失效并刷新。
    // 429 限流、5xx 服务端瞬时错误、其它非认证状态只记录，等下一轮再验，避免整页刷新抖动。
    if (r.status === 401 || r.status === 403) {
      m.lastError = `登录态失效(HTTP ${r.status})`;
      reloadTabs('login');
    } else {
      m.lastError = `登录校验非 2xx(HTTP ${r.status})，暂不刷新`;
      console.warn('[monitor] 登录校验非 2xx 不刷新（避免误判登出）:', r.status);
    }
  } catch (e) {
    // 网络抖动忽略，下一轮再试
  }
}

function startProofCheck() {
  if (proofTimer) clearInterval(proofTimer);
  proofTimer = setInterval(checkLoginAndProof, m.proofCheckSec * 1000);
  checkLoginAndProof();
}

// ---------- 统计持久化 + URL/刷新记录 ----------
// 监控统计（总失联合计/刷新次数/URL历史）持久化到 storage.local，
// 浏览器重启后恢复，不会丢失。键名 reelax-monitor-stats。
const MONITOR_STATS_KEY = 'reelax-monitor-stats';
const URL_HISTORY_MAX = 20;

function persistStats() {
  try {
    browser.storage.local.set({
      [MONITOR_STATS_KEY]: {
        offlineTotalSec: m.offlineTotalSec,
        pageReloadCount: m.pageReloadCount,
        urlHistory: m.urlHistory,
        urlCount: m.urlCount,
        fishSoldTotal: m.fishSoldTotal, // 累计已售出鱼条数（持久化，重启不丢）
        lastN: (m.sync && Array.isArray(m.sync.lastN) && m.sync.lastN.length > 0) ? m.sync.lastN : undefined,
        pityNotified: (m.pity && m.pity.notified) || undefined,
        pityBaseline: (m.pity && m.pity.arcane && m.pity.exotic)
          ? { arcane: m.pity.arcane.currentDry, exotic: m.pity.exotic.currentDry }
          : undefined,
        statsRaritiesBase: (m.statsRarities && (m.statsRarities.exotic != null || m.statsRarities.arcane != null))
          ? { exotic: m.statsRarities.exotic, arcane: m.statsRarities.arcane }
          : undefined,
        pityTrigger: (m.pityTrigger)
          ? {
              active: m.pityTrigger.active === true,
              armed: { arcane: !!m.pityTrigger.armed?.arcane, exotic: !!m.pityTrigger.armed?.exotic },
              // 全运气硬保底基准始终持久化（与 active 无关，SW 重启不丢）
              ref: {
                arcane: (m.pityTrigger.ref && m.pityTrigger.ref.arcane != null) ? m.pityTrigger.ref.arcane : null,
                exotic: (m.pityTrigger.ref && m.pityTrigger.ref.exotic != null) ? m.pityTrigger.ref.exotic : null,
                built: !!(m.pityTrigger.ref && m.pityTrigger.ref.built),
                builtAt: (m.pityTrigger.ref && m.pityTrigger.ref.builtAt) || null,
              },
              preBait: m.pityTrigger.preBait || undefined,
              savedFlatBonus: m.pityTrigger.savedFlatBonus,
              savedTotalPts: m.pityTrigger.savedTotalPts,
              washedAt: m.pityTrigger.washedAt,
            }
          : undefined,
        savedAt: Date.now(),
      },
    }).catch(() => { /* 存储失败忽略 */ });
  } catch (e) { /* 忽略 */ }
}

function restoreStats() {
  // 返回 promise：让 monitorStart 先 await 恢复完成，再开始首个 checkPity——
  // 否则首个采样会跑赢异步存储读回，m.pity 基线(null)被首采样盖掉，
  // SW 打盹期间发生的出货永久漏报（对比不到复位）。
  try {
    return (browser.storage.local.get(MONITOR_STATS_KEY) || Promise.resolve()).then((res) => {
      const d = res && res[MONITOR_STATS_KEY];
      if (!d) return;
      if (typeof d.offlineTotalSec === 'number') m.offlineTotalSec = d.offlineTotalSec;
      if (typeof d.pageReloadCount === 'number') m.pageReloadCount = d.pageReloadCount;
      if (typeof d.fishSoldTotal === 'number') m.fishSoldTotal = d.fishSoldTotal; // 恢复累计已售出
      if (Array.isArray(d.urlHistory)) m.urlHistory = d.urlHistory.slice(0, URL_HISTORY_MAX);
      if (d.urlCount && typeof d.urlCount === 'object') m.urlCount = d.urlCount;
      if (Array.isArray(d.lastN) && d.lastN.length > 0) {
        if (!m.sync) m.sync = {};
        m.sync.lastN = d.lastN.slice(-ETA_WINDOW);
        // 不在此处 computeEta：restore 时 m.sync 缺 level/exp/expToNext，算出来是 NaN。
        // 等下一个真实 sync 响应（带 playerPatch）到达后 parseSync 会自然重算下5级。
      }
      // 恢复保底通知标志 + 上次干涸计数基线：
      //   - 通知标志跨重启不重复轰炸同一事件；
      //   - 干涸基线用于检测「扩展关闭期间」是否出货（计数器重置），避免漏报。
      if (d.pityNotified && typeof d.pityNotified === 'object') {
        const baseline = (d.pityBaseline && d.pityBaseline.arcane != null && d.pityBaseline.exotic != null)
          ? { arcane: { currentDry: d.pityBaseline.arcane }, exotic: { currentDry: d.pityBaseline.exotic } }
          : {};
        m.pity = { notified: d.pityNotified, ...baseline };
      }
      // 恢复上次「各稀有度累计渔获数」，让 SW 重启后首个采样能用 fishCaught 差值检测「打盹期间的出货」
      if (!m.statsRarities && d.statsRaritiesBase && (d.statsRaritiesBase.exotic != null || d.statsRaritiesBase.arcane != null)) {
        m.statsRarities = { exotic: d.statsRaritiesBase.exotic != null ? d.statsRaritiesBase.exotic : 0, arcane: d.statsRaritiesBase.arcane != null ? d.statsRaritiesBase.arcane : 0 };
      }
      // 恢复保底触发的「全运气硬保底基准」与激活态：
      //   ref(built/arcane/exotic) 在任何情况下都恢复（SW 重启不丢基准）；
      //   active 仅在重启时正处「洗点全运气」锁定才恢复（保持等出货、能洗回）。
      if (d.pityTrigger && m.pityTrigger) {
        // 基准
        const pr = d.pityTrigger.ref || {};
        if (typeof pr.built === 'boolean') {
          m.pityTrigger.ref.built = pr.built;
          m.pityTrigger.ref.arcane = pr.arcane != null ? pr.arcane : null;
          m.pityTrigger.ref.exotic = pr.exotic != null ? pr.exotic : null;
          m.pityTrigger.ref.builtAt = pr.builtAt || null;
        }
        // 激活态
        if (d.pityTrigger.active) {
          m.pityTrigger.active = true;
          m.pityTrigger.armed = {
            arcane: !!(d.pityTrigger.armed && d.pityTrigger.armed.arcane),
            exotic: !!(d.pityTrigger.armed && d.pityTrigger.armed.exotic),
          };
          m.pityTrigger.savedFlatBonus = d.pityTrigger.savedFlatBonus != null ? d.pityTrigger.savedFlatBonus : null;
          m.pityTrigger.savedTotalPts = d.pityTrigger.savedTotalPts != null ? d.pityTrigger.savedTotalPts : null;
          m.pityTrigger.preBait = d.pityTrigger.preBait || null;
          m.pityTrigger.washedAt = d.pityTrigger.washedAt || null;
        }
      }
    }).catch(() => { /* 忽略 */ });
  } catch (e) { return Promise.resolve(); }
}

// 记录 reelax 页面 URL 切换与刷新次数（含用户手动 F5）
function setupTabRecord() {
  browser.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
    const url = changeInfo.url || tab.url;
    if (!url || !/^https?:\/\/(reelax\.cn|.*\.reelax\.cn)\//.test(url)) return;
    // 页面刷新（含手动 F5 / 扩展自动刷新）：状态回到 loading 即计一次
    if (changeInfo.status === 'loading') {
      m.pageReloadCount += 1;
    }
    // URL 切换记录（去重：与上一条相同 URL 不重复记；累计各路径切换次数）
    if (changeInfo.url && changeInfo.url !== (m.urlHistory[0] && m.urlHistory[0].url)) {
      m.urlHistory.unshift({ url: changeInfo.url, ts: Date.now() });
      if (m.urlHistory.length > URL_HISTORY_MAX) m.urlHistory.length = URL_HISTORY_MAX;
      try {
        const path = new URL(changeInfo.url).pathname;
        m.urlCount[path] = (m.urlCount[path] || 0) + 1;
      } catch (e) { /* URL 解析失败忽略 */ }
    }
    persistStats();
  });
}

// ---------- 奥术献祭（arcane-sacrifice 世界事件）一键贡献 ----------
// 机制（按用户口径）：
//   每种资源（遗物 relic / 鱼 fish / 金币 gold）有一个目标分 target，
//   参与奖励门槛 = 目标分的 0.5%（participationShareThresholdBasisPoints=50）。
//   参考贡献值 = ceil(门槛) + 1（多 1 保险）；实际「还差」= 参考值 − 今日已捐。
//   鱼按稀有度积分换算成尾数：common=1/uncommon=3/fine=5/rare=15/epic=30。
//   一键贡献：遗物/金币 POST {resourceType, quantity}；鱼 POST {resourceType, rarity, quantity}。
//   鱼按用户勾选的品级（sacrificeFishRarities，多选，默认 uncommon）贡献；只有 common~epic 五档可献祭，
//   无库存则不捐那档（不硬凑）。
const SACRIFICE_CHECK_MS = 5 * 60 * 1000;   // 事件状态刷新间隔 5 分钟
const SACRIFICE_FISH_POINTS = { common: 1, uncommon: 3, fine: 5, rare: 15, epic: 30 };
const SACRIFICE_RARITY_CN = { common: '普通', uncommon: '罕见', fine: '精良', rare: '稀有', epic: '史诗' };
// 「可献祭」品级集合：接口只接受 common~epic；传说/神话/奇异/奥秘 不可献祭。
const SACRIFICE_SACRIFICABLE = new Set(Object.keys(SACRIFICE_FISH_POINTS));
let sacrificeCheckTimer = null;
let sacrificeInProgress = false;
let sacrificeContributeInProgress = false;

// 【新版机制】轮次「可否继续捐」判定（全局复用）：达标(100%)后 1 小时内仍可献祭并参与排名，
// 直到 rewardSettlesAt 才关闭。now ∈ [opensAt, rewardSettlesAt) 视为尚可贡献；rewardSettlesAt 缺失时
// 未 settle(settledAt 空) 且未 completed 视为开着。这样不再因为 status!=='open' / progress 达 100% 就提前停。
function isRoundContributable(rnd, now) {
  if (!rnd) return false;
  const nowMs = now || Date.now();
  const open = rnd.opensAt ? new Date(rnd.opensAt).getTime() : 0;
  if (nowMs < open) return false;
  if (rnd.rewardSettlesAt) return nowMs < new Date(rnd.rewardSettlesAt).getTime();
  if (rnd.settledAt && nowMs >= new Date(rnd.settledAt).getTime()) return false;
  return !!(rnd.status === 'open' || rnd.status === 'in_progress' || !rnd.completedAt);
}

// 纯函数：从 /api/events/arcane-sacrifice 响应算每个资源的目标分/门槛/还差
// 精准口径（B 方案）：
//   · 只有「当前轮 currentRound.status==='open'」的那个资源才能贡献；
//   · 用 currentPlayerRoundContribution（当前轮我的贡献/剩余额度，含单人上限）算还差，
//     不再用 todayContributions（今日累计跨轮，会误导）。
//   · 可贡献量 = min(还差, 我的剩余额度 remaining, 我的可用资产)。
// data: 接口响应 data 字段。opts: {}（保留签名以兼容调用；无更多覆盖参数）。
// 返回 { status, day, rounds, currentRound, perResource, updatedAt }
function computeSacrificePlan(data, opts) {
  // 每个资源的参与门槛百分比（用户设置，各资源独立；默认 0.5%）
  const pctOf = function (type) {
    const key = 'sacrifice' + type.charAt(0).toUpperCase() + type.slice(1) + 'Pct'; // relic→sacrificeRelicPct
    const v = Number(m[key]);
    return (v > 0) ? v : 0.5;
  };
  const day = data && data.day ? { date: data.day.date, startsAt: data.day.startsAt, endsAt: data.day.endsAt } : null;
  const rounds = (data && Array.isArray(data.rounds)) ? data.rounds.map(function (r) { return {
    roundNumber: r.roundNumber, status: r.status, resourceType: r.resourceType,
    target: r.target, progress: r.progress, completedAt: r.completedAt, opensAt: r.opensAt,
    rewardSettlesAt: r.rewardSettlesAt, settledAt: r.settledAt, effectEndsAt: r.effectEndsAt,
  }; }) : [];
  const assets = (data && data.availableAssets) || {};
  const cpc = (data && data.currentPlayerRoundContribution) || {};
  // 当前轮（可能为 null）
  const currentRound = data && data.currentRound ? {
    roundNumber: data.currentRound.roundNumber,
    resourceType: data.currentRound.resourceType,
    target: data.currentRound.target,
    progress: data.currentRound.progress,
    status: data.currentRound.status,
    opensAt: data.currentRound.opensAt,
    rewardSettlesAt: data.currentRound.rewardSettlesAt,
    settledAt: data.currentRound.settledAt,
    effectEndsAt: data.currentRound.effectEndsAt,
    completedAt: data.currentRound.completedAt,
  } : null;
  const nextResourceType = data && data.nextResourceType ? data.nextResourceType : null;

  // 轮次「可否继续捐」：达标(100%)后 1 小时内仍可捐到 rewardSettlesAt，不再只看 status==='open'。
  const roundOpen = isRoundContributable(currentRound);

  // 每个资源的目标分：取该资源最后一次出现的目标（当前轮优先）。
  const targetByType = {};
  for (const r of rounds) { if (r.target != null) targetByType[r.resourceType] = r.target; }
  if (currentRound && currentRound.target != null) targetByType[currentRound.resourceType] = currentRound.target;

  // 当前轮我的已贡献 / 剩余额度（单位：fish=鱼分；relic/gold=数量）
  const roundContribution = cpc.contribution != null ? cpc.contribution : 0;
  const roundRemaining = cpc.remaining != null ? cpc.remaining : 0;
  const roundLimitPct = cpc.limitBasisPoints != null ? cpc.limitBasisPoints / 100 : null; // 单人上限 %

  const perResource = {};
  for (const type of ['relic', 'fish', 'gold']) {
    const target = targetByType[type];
    const plan = { type: type, target: target, reference: null, threshold: null, need: null, available: null, canContribute: false, reason: '' };

    // 只有「当前开放轮次对应资源」才能贡献；其它资源一律只标注状态、不可捐
    const isCurrentOpenType = roundOpen && currentRound.resourceType === type;
    if (target == null || !isCurrentOpenType) {
      if (target == null) {
        plan.reason = (nextResourceType === type) ? '未开始' : '无目标';
      } else if (roundOpen && currentRound.resourceType !== type) {
        plan.reason = '非本轮';
      } else if (currentRound && currentRound.status !== 'open') {
        plan.reason = '未开放';
      } else {
        plan.reason = '本期已完';
      }
      perResource[type] = plan;
      continue;
    }

    const thresholdPct = pctOf(type);
    const threshold = Math.ceil(target * (thresholdPct / 100)); // 参与门槛（单位同 target：分/数量）
    const reference = threshold + 1;                          // 参考值 = 门槛 + 多 1 保险
    // 目标/还差参考量：遗物、金币这类按「数值精确」的资源 → 就捐恰好门槛(threshold)；
    // 鱼按「分」拼凑（会略过冲一点点），才用 门槛+1 的保险参考，避免因分值粒度卡在门槛下差一点。
    let refForPlan = (type === 'fish') ? reference : threshold;
    plan.threshold = threshold;
    plan.reference = reference;

    // 还差（单位：分/数量）——以「当前轮我的贡献」为准（refForPlan 首次事件取目标百分比/绝对量较大者）
    const needRaw = Math.max(0, refForPlan - roundContribution);
    // 可贡献上限 = min(还差(门槛), 单人上限内还能贡献, 我的剩余额度)。三者都取 min。
    let capLimit = needRaw; // 还差（门槛参考 - 当前轮已贡献）
    if (roundLimitPct != null && roundLimitPct > 0) {
      const capAmount = Math.ceil(target * (roundLimitPct / 100)); // 单人上限（单位同 target）
      capLimit = Math.min(capLimit, Math.max(0, capAmount - roundContribution)); // 与单人上限内还能贡献取小
    }
    if (roundRemaining > 0) capLimit = Math.min(capLimit, roundRemaining);        // 与剩余额度取小

    if (type === 'relic') {
      const available = assets.relics != null ? assets.relics : null;
      plan.available = available;
      plan.unit = '个';
      let cap = Math.max(0, Math.min(capLimit, available != null ? available : capLimit));
      plan.need = cap;
      if (roundContribution >= refForPlan || cap === 0) plan.reason = '已达标';
      else if (available != null && available < capLimit) plan.reason = '遗物不足';
      else plan.canContribute = true;
    } else if (type === 'gold') {
      const available = assets.gold != null ? assets.gold : null;
      plan.available = available;
      plan.unit = '金';
      let cap = Math.max(0, Math.min(capLimit, available != null ? available : capLimit));
      plan.need = cap;
      if (roundContribution >= refForPlan || cap === 0) plan.reason = '已达标';
      else if (available != null && available < capLimit) plan.reason = '金币不足';
      else plan.canContribute = true;
    } else if (type === 'fish') {
      // 鱼：capLimit 是「分」。用多稀有度鱼拼凑到目标（尽量不超太多），
      // **优先捐罕见(uncommon)**：罕见分量 3分/90金≈30金/分，是四级里单点成本最低（普通50/精良47/稀有45），
      // 罕见不够再退而求其次用普通/fine/rare/epic 补缺口。传说/神话/奇异/奥秘不参与拼凑。
      // 填充逻辑：先尽量不超目标地加，差一点就用当前稀有度补一尾跨过（过冲最小）。
      plan.unit = '尾';
      const targetPts = Math.max(0, Math.min(capLimit, Math.max(0, refForPlan - roundContribution)));
      const availFish = (assets.fish && typeof assets.fish === 'object') ? assets.fish : {};
      // 只捐用户勾选的品级（sacrificeFishRarities，多选）；与可献祭集合求交集以防非法值。
      // 缺省回退 ['uncommon']；对勾选内仍按「罕见优先、其余按分值升序」的低成本优先逻辑拼凑。
      const chosen = (Array.isArray(m.sacrificeFishRarities) && m.sacrificeFishRarities.length)
        ? m.sacrificeFishRarities.filter((r) => SACRIFICE_SACRIFICABLE.has(r))
        : ['uncommon'];
      const fishOrder = (chosen.includes('uncommon') ? ['uncommon'] : []).concat(
        chosen.filter((r) => r !== 'uncommon').sort((a, b) => SACRIFICE_FISH_POINTS[a] - SACRIFICE_FISH_POINTS[b]));
      if (!fishOrder.length) fishOrder.push('uncommon');
      const alloc = []; // {rarity, quantity, pts, cn}
      let contributedPts = 0;
      for (const rarity of fishOrder) {
        const per = SACRIFICE_FISH_POINTS[rarity];
        if (!per) continue;
        const av = (availFish[rarity] != null) ? availFish[rarity] : 0;
        if (av <= 0) continue;
        // 先取「不超目标」的量
        const fitQty = Math.min(av, Math.floor((targetPts - contributedPts) / per));
        let qty = fitQty;
        contributedPts += per * qty;
        // 还差一点且还有鱼：补一尾该稀有度跨过目标（过冲 = 单尾分值，尽量小）
        if (contributedPts < targetPts && qty < av) {
          qty += 1;
          contributedPts += per;
        }
        if (qty > 0) alloc.push({ rarity, quantity: qty, pts: per * qty, cn: SACRIFICE_RARITY_CN[rarity] || rarity });
        if (contributedPts >= targetPts) break;
      }
      plan.fishPlan = alloc;
      plan.needPoints = contributedPts;
      plan.need = alloc.reduce((s, a) => s + a.quantity, 0);
      plan.available = plan.need;
      if (roundContribution >= refForPlan) { plan.reason = '已达标'; }
      else if (plan.need <= 0) { plan.reason = '无可用鱼'; }
      else plan.canContribute = true;
    }
    perResource[type] = plan;
  }

  return {
    status: data && data.status ? data.status : null,
    serverTime: data && data.serverTime ? data.serverTime : null,
    day: day, rounds: rounds, currentRound: currentRound, nextResourceType: nextResourceType,
    roundOpen: roundOpen,
    surge: data && data.surge ? { isActive: data.surge.isActive, endsAt: data.surge.endsAt } : null,
    roundContribution: roundContribution, roundRemaining: roundRemaining,
    todayContrib: (data && data.todayContributions) || {},
    perResource: perResource,
    updatedAt: Date.now(),
  };
}

// 拉取事件状态并刷新方案（供 popup 展示）
async function checkSacrifice() {
  if (sacrificeInProgress) return;
  sacrificeInProgress = true;
  try {
    const res = await ReelaxApi.arcaneSacrificeOverview();
    if (res && res.ok && res.data) {
      m.arcaneSacrifice = computeSacrificePlan(res.data);
      m.lastSacrificeError = null;
      console.log('[monitor] 奥术献祭状态已刷新:', m.arcaneSacrifice.status, m.arcaneSacrifice.day && m.arcaneSacrifice.day.date);
    } else {
      m.lastSacrificeError = (res && (res.error || (res.body || '').slice(0, 120))) || 'fetch-failed';
      console.warn('[monitor] 奥术献祭状态查询失败:', m.lastSacrificeError);
    }
  } catch (e) {
    m.lastSacrificeError = String(e);
    console.warn('[monitor] 奥术献祭检查异常:', e);
  } finally {
    sacrificeInProgress = false;
  }
}

// 一键贡献：resourceType = 'relic'|'fish'|'gold'；fish 按 plan.fishPlan 多稀有度拼凑提交
async function contributeSacrifice(resourceType, rarity) {
  if (sacrificeContributeInProgress) return { ok: false, reason: 'locked' };
  sacrificeContributeInProgress = true;
  try {
    // 先刷新一次最新事件状态（拿今日已捐/可用资产），避免基于过期数据
    if (!m.arcaneSacrifice || Date.now() - m.arcaneSacrifice.updatedAt > 30000) {
      await checkSacrifice();
    }
    const plan = m.arcaneSacrifice && m.arcaneSacrifice.perResource && m.arcaneSacrifice.perResource[resourceType];
    if (!plan) return { ok: false, reason: 'no-event' };
    if (!plan.canContribute) return { ok: false, reason: plan.reason || 'insufficient' };

    // 鱼：按多稀有度组合逐类提交（低价值优先），累计总量
    if (resourceType === 'fish') {
      const list = (Array.isArray(plan.fishPlan) && plan.fishPlan.length) ? plan.fishPlan : [];
      if (!list.length) return { ok: false, reason: 'insufficient' };
      let totalQty = 0;
      for (const it of list) {
        const body = { resourceType: 'fish', rarity: it.rarity, quantity: it.quantity };
        const res = await ReelaxApi.arcaneSacrificeContribute(body);
        if (res && res.ok) {
          totalQty += it.quantity;
        } else {
          console.warn('[monitor] 奥术献祭鱼贡献部分失败:', it.rarity, res && (res.error || res.body));
          // 为不浪费/不卡死，继续下一稀有度（其中某档可能因并发被占用）
        }
      }
      if (totalQty > 0) {
        console.log('[monitor] 奥术献祭贡献成功:', resourceType, '共', totalQty, '尾鱼（' + list.map((i) => i.cn + 'x' + i.quantity).join('、') + '）');
        sendWebhook('[Reelax] 🎁 奥术献祭自动贡献鱼 ' + totalQty.toLocaleString() + ' 尾（' + list.map((i) => i.cn + '×' + i.quantity).join('、') + '）');
        await checkSacrifice();
        return { ok: true, resourceType, quantity: totalQty, list };
      }
      return { ok: false, reason: 'no-fish-contributed' };
    }

    // relic / gold：单资源单量
    if (plan.need == null || plan.need <= 0) return { ok: false, reason: 'already-done', need: 0 };
    const body = { resourceType: resourceType, quantity: plan.need };
    const res = await ReelaxApi.arcaneSacrificeContribute(body);
    if (res && res.ok) {
      const name = ({ relic: '遗物', gold: '金币', fish: '鱼' })[resourceType] || resourceType;
      console.log('[monitor] 奥术献祭贡献成功:', resourceType, 'x', plan.need, res.body);
      sendWebhook('[Reelax] 🎁 奥术献祭自动贡献 ' + name + ' x' + plan.need.toLocaleString() + '（参与门槛 ' + (plan.threshold || 0) + '）');
      await checkSacrifice();
      return { ok: true, resourceType, quantity: plan.need, body: res.body };
    }
    return { ok: false, reason: (res && res.error) || 'http', status: res ? res.status : null, errorBody: (res && res.body) || '', resourceType, quantity: plan.need };
  } catch (e) {
    return { ok: false, reason: String(e) };
  } finally {
    sacrificeContributeInProgress = false;
  }
}

// ---------- 奥术献祭「每日两轮」统一自动贡献 ----------
// 用户口径（简化版，不以闹钟/状态驱动，纯粹每 5 分钟无条件轮询一次）：
//   每 5 分钟固定刷新一次事件状态（startSacrificePolling 常驻 setInterval），
//   只要当前存在「可继续捐」的轮（isRoundContributable：now ∈ [opensAt, rewardSettlesAt)，
//   即开启后、达标后 1 小时结算前都可捐），且全服进度达标、该轮未达门槛，就自动补捐。
//   每轮捐献物（relic 遗物 / fish 鱼 / gold 金币）通过 /api 事件状态自动识别（当前开放轮 currentRound.resourceType）。
//   参与门槛 = 该资源 target × 用户设置的对应百分比（sacrificeRelicPct / sacrificeFishPct / sacrificeGoldPct，默认 0.5%）。
//   全服进度阈值保留：仅当 serverPct ≥ sacrificeServerPct（默认 60%）才捐献。
//   不再区分配置闹钟/状态驱动；统一样本由 computeSacrificePlan 算门槛，autoContributeSacrifice 执行。
//   由于轮询常驻且每 5 分钟刷新，当前轮无论何时开（含后续轮）都会被轮询感知并按时捐出。

// —— 统一捐献执行：刷新状态 → 若存在当前可捐轮且全服进度达标，则按该资源百分比把当前轮补捐到门槛。
// 由 startSacrificePolling 每 5 分钟无条件调用一次（也由 popup 手动刷新/一键贡献复用）。
async function autoContributeSacrifice() {
  if (!m.sacrificeAuto || !m.enabled) return;
  if (!m.arcaneSacrifice || Date.now() - m.arcaneSacrifice.updatedAt > SACRIFICE_CHECK_MS) {
    await checkSacrifice();
  }
  const s = m.arcaneSacrifice;
  if (!s) return;
  const cr = s.currentRound;
  if (!cr || !isRoundContributable(cr) || !cr.resourceType || !cr.target) {
    m.lastSacrificeAuto = { ok: false, reason: 'no-open-round', at: Date.now() };
    return;
  }
  const serverPct = cr.target > 0 ? (cr.progress || 0) / cr.target * 100 : 0;
  const th = Number(m.sacrificeServerPct) || 60;
  if (serverPct < th) {
    m.lastSacrificeAuto = { ok: true, reason: 'server-under-threshold', resourceType: cr.resourceType, serverPct: serverPct, contributed: 0, at: Date.now() };
    console.log('[monitor] 奥术献祭自动贡献: 全服进度 ' + serverPct.toFixed(1) + '% < ' + th + '%，暂不贡献(' + cr.resourceType + ')');
    return;
  }
  const plan = s.perResource && s.perResource[cr.resourceType];
  if (!plan) {
    m.lastSacrificeAuto = { ok: false, reason: 'no-plan', resourceType: cr.resourceType, serverPct: serverPct, at: Date.now() };
    return;
  }
  if (!plan.canContribute || plan.need == null || plan.need <= 0) {
    m.lastSacrificeAuto = { ok: true, reason: 'already-met', resourceType: cr.resourceType, serverPct: serverPct, contributed: 0, at: Date.now() };
    console.log('[monitor] 奥术献祭自动贡献: ' + cr.resourceType + ' 已达标(' + (plan.reason || 'done') + ')，全服 ' + serverPct.toFixed(1) + '%，不再贡献');
    return;
  }
  console.log('[monitor] 奥术献祭自动贡献: 全服 ' + serverPct.toFixed(1) + '% ≥ ' + th + '%，贡献 ' + cr.resourceType + ' x' + plan.need + '（门槛 ' + plan.threshold + ' = target ' + plan.target + ' × ' + (m['sacrifice' + cr.resourceType.charAt(0).toUpperCase() + cr.resourceType.slice(1) + 'Pct'] || 0.5) + '%）');
  const r = await contributeSacrifice(cr.resourceType);
  m.lastSacrificeAuto = { ok: !!(r && r.ok), reason: (r && r.reason) || 'contributed', resourceType: cr.resourceType, serverPct: serverPct, contributed: (r && r.ok && r.quantity) ? r.quantity : 0, at: Date.now() };
  return r;
}

// —— 简单常驻轮询：每 5 分钟无条件刷新+捐献一次（不以闹钟/状态驱动，杜绝「下一轮漏捐」）。
// SW 深度休眠时 setInterval 会被挂起，因此靠 daily-tick 闹钟(每1分钟)间接唤醒兜底；
// 只要浏览器在跑，每 5 分钟必然查一次事件状态，任一可捐轮（含后续轮）都会被感知并按时捐出。
function sacrificeTick() {
  checkSacrifice().then(() => autoContributeSacrifice()).catch((e) => {});
}
function startSacrificePolling() {
  if (sacrificeCheckTimer) return;      // 已在跑，避免重复
  sacrificeCheckTimer = setInterval(sacrificeTick, SACRIFICE_CHECK_MS);
  sacrificeTick();                      // 启动立即先跑一次
}

// ---------- 世界Boss（world-boss 围猎事件）自动报名 ----------
// 机制（按前端口径）：
//   · 每场可从力量/智力/运气/耐力中选一项攻击属性报名（POST /api/events/world-boss/selection {stat}）；
//   · 伤害倍率：Boss「弱点」属性 ×200%、普通 ×100%、「防御」属性 ×50%；
//   · 报名后第一次攻击前可改（isLocked=false）；第一次攻击后锁定（isLocked=true）无法再改。
//   伤害 = 我方该属性总值 × 倍率。弱点虽然 ×200%，但若我方该属性总值偏低，
//   可能不如另一个 ×100% 的高数值属性打得多（如弱点属性 500×200%=1000 < 某属性 1800×100%=1800）。
//   因此不再盲目选弱点，而是按「各属性 属性值×倍率 的期望值」选最大值（伤害最大化）。
const WORLD_BOSS_CHECK_MS = 10 * 60 * 1000;   // 检测间隔 10 分钟
const WORLD_BOSS_ACTIVE_STATUS = ['preparing', 'active']; // 报名窗口（preparing 准备期 / active 开战未锁定）
// 倍率：弱点 ×200%、防御 ×50%、其余普通 ×100%（与后端口径一致）
const WORLD_BOSS_MULT = { weakness: 2.0, normal: 1.0, defense: 0.5 };
let worldBossCheckTimer = null;
let worldBossInProgress = false;
let worldBossSelectInProgress = false;
let worldBossHandledSig = null;   // 最近一次成功报名的 (sessionId, targetStat) 签名，用于去重（避免同一场重复报名+通知）

// 根据 boss 的 weakness/defense 标记，给 4 个属性各自配倍率。
// 返回 { strength:2.0, intelligence:1.0, ... }；既非弱点也非防御的属性取 normal(1.0)。
function worldBossStatMultipliers(boss) {
  const m = { strength: WORLD_BOSS_MULT.normal, intelligence: WORLD_BOSS_MULT.normal, luck: WORLD_BOSS_MULT.normal, endurance: WORLD_BOSS_MULT.normal };
  if (boss && boss.weaknessStat && m[boss.weaknessStat] != null) m[boss.weaknessStat] = WORLD_BOSS_MULT.weakness;
  if (boss && boss.defenseStat && m[boss.defenseStat] != null) m[boss.defenseStat] = WORLD_BOSS_MULT.defense;
  return m;
}

// 选最优攻击属性：在 4 个属性里取「属性值 × 倍率」最大者。
// playerTotals: { strength, intelligence, luck, endurance }（我方各属性总值）；
// 若缺 playerTotals 则退化回「弱点属性」（保持旧行为，不报错）。
// 返回 { targetStat, expected:{stat:val}, best }
function computeWorldBossBestStat(boss, playerTotals) {
  const mults = worldBossStatMultipliers(boss);
  const keys = ['strength', 'intelligence', 'luck', 'endurance'];
  const expected = {};
  let targetStat = (boss && boss.weaknessStat) || null; // 退化值：弱点
  let best = -Infinity;
  const haveTotals = !!(playerTotals && Object.keys(playerTotals).length);
  for (const k of keys) {
    const val = haveTotals ? Number(playerTotals[k] || 0) : 0;
    const exp = val * mults[k];
    expected[k] = Math.round(exp);
    if (haveTotals && exp > best) { best = exp; targetStat = k; }
  }
  return { targetStat, expected, best: best === -Infinity ? null : Math.round(best) };
}

// 从 /api/events/world-boss 响应提取当前场次+选角方案（供 popup 展示）
// data: 接口响应 data 字段；playerTotals: 我方各属性总值（用于伤害最大化选角）。
// 返回 { session, boss, player, targetStat, shouldChange, changedAt, expected, best }
function computeWorldBossPlan(data, playerTotals) {
  const s = data && data.session ? data.session : null;
  if (!s) return { status: null, hasSession: false };
  const b = s.boss || {};
  const p = s.player || {};
  const bestPlan = computeWorldBossBestStat(b, playerTotals);
  const targetStat = bestPlan.targetStat; // 伤害最大化目标属性（可能是弱点，也可能不是）
  const selectedStat = p.selectedStat || null;
  const isLocked = p.isLocked === true;
  const inWindow = WORLD_BOSS_ACTIVE_STATUS.indexOf(s.status) !== -1;
  // 可报名/改选条件：处于报名窗口 && 未锁定 && 已选属性不是目标（伤害最大化）属性
  const shouldChange = !!(inWindow && !isLocked && targetStat && selectedStat !== targetStat);
  const multBP = p.multiplierBasisPoints != null ? p.multiplierBasisPoints : null;
  return {
    hasSession: true,
    status: s.status,
    sessionId: s.id,
    boss: { id: b.id, name: b.name, epithet: b.epithet, weaknessStat: b.weaknessStat, defenseStat: b.defenseStat },
    player: {
      selectedStat: selectedStat,
      isLocked: isLocked,
      multiplierBasisPoints: multBP,
      multiplierPct: multBP != null ? (multBP / 100) : null,
    },
    targetStat: targetStat,
    expected: bestPlan.expected,
    best: bestPlan.best,
    inWindow: inWindow,
    shouldChange: shouldChange,
    battleAt: s.battleAt,
    escapeAt: s.escapeAt,
    updatedAt: Date.now(),
  };
}

// 取我方 4 属性总值（total），优先用 m.sync 里的实时数据，否则查 /api/player/stats。
// 返回 { strength, intelligence, luck, endurance } 或 null（取不到时）。
let worldBossPlayerTotalsCache = null; // { totals, at } 简单缓存，避免每次检查都打 stats 接口
const WORLD_BOSS_TOTALS_TTL_MS = 5 * 60 * 1000;
function worldBossPlayerTotals() {
  const now = Date.now();
  if (worldBossPlayerTotalsCache && now - worldBossPlayerTotalsCache.at < WORLD_BOSS_TOTALS_TTL_MS) {
    return worldBossPlayerTotalsCache.totals;
  }
  let totals = null;
  if (m.sync && m.sync.player && m.sync.player.stats && m.sync.player.stats.total) {
    const t = m.sync.player.stats.total;
    totals = { strength: t.strength || 0, intelligence: t.intelligence || 0, luck: t.luck || 0, endurance: t.endurance || 0 };
  } else if (m.sync && m.sync.stats && m.sync.stats.total) {
    const t = m.sync.stats.total;
    totals = { strength: t.strength || 0, intelligence: t.intelligence || 0, luck: t.luck || 0, endurance: t.endurance || 0 };
  }
  if (totals) worldBossPlayerTotalsCache = { totals, at: now };
  return totals;
}
async function refreshWorldBossPlayerTotals() {
  try {
    const r = await ReelaxApi.playerStats();
    if (r && r.ok && r.player && r.player.stats && r.player.stats.total) {
      const t = r.player.stats.total;
      const totals = { strength: t.strength || 0, intelligence: t.intelligence || 0, luck: t.luck || 0, endurance: t.endurance || 0 };
      worldBossPlayerTotalsCache = { totals, at: Date.now() };
      return totals;
    }
  } catch (e) { /* 忽略，回退到 sync 缓存 */ }
  return worldBossPlayerTotals();
}

// 拉取世界Boss状态并刷新方案（供 popup 展示）
async function checkWorldBoss() {
  if (worldBossInProgress) return;
  worldBossInProgress = true;
  try {
    const res = await ReelaxApi.worldBossOverview();
    if (res && res.ok && res.data) {
      // 取我方属性总值用于「伤害最大化」选角（优先同步缓存，必要时回查）
      let totals = worldBossPlayerTotals();
      if (!totals) totals = await refreshWorldBossPlayerTotals();
      m.worldBoss = computeWorldBossPlan(res.data, totals);
      m.lastWorldBossError = null;
      const s = m.worldBoss;
      const expStr = s.expected
        ? (' 期望: ' + STAT_KEYS.map(k => STAT_LABELS[k] + '=' + s.expected[k]).join('/') + ' → 选' + (s.targetStat ? STAT_LABELS[s.targetStat] : '-'))
        : '';
      console.log('[monitor] 世界Boss状态已刷新:',
        s.hasSession ? (s.boss.name + '·' + (s.status || '') + ' 已选:' + (s.player.selectedStat || '未报名') + ' 目标:' + (s.targetStat || '-') + expStr) : '无进行中场次');
    } else {
      m.lastWorldBossError = (res && (res.error || (res.body || '').slice(0, 120))) || 'fetch-failed';
      console.warn('[monitor] 世界Boss状态查询失败:', m.lastWorldBossError);
    }
  } catch (e) {
    m.lastWorldBossError = String(e);
    console.warn('[monitor] 世界Boss检查异常:', e);
  } finally {
    worldBossInProgress = false;
  }
}

// 一键报名/改选：把攻击属性设为 stat（默认 Boss 弱点属性）
async function selectWorldBoss(stat) {
  if (worldBossSelectInProgress) return { ok: false, reason: 'locked' };
  worldBossSelectInProgress = true;
  try {
    const target = stat || (m.worldBoss && m.worldBoss.targetStat);
    if (!target) return { ok: false, reason: 'no-target-stat' };
    const res = await ReelaxApi.worldBossSelect(target);
    if (res && res.ok) {
      console.log('[monitor] 世界Boss报名成功:', target, res.body);
      // 报名成功后刷新一次（确认服务器已更新 selectedStat）
      await checkWorldBoss();
      return { ok: true, stat: target, body: res.body };
    }
    return { ok: false, reason: (res && res.error) || 'http', status: res ? res.status : null, stat: target, errorBody: (res && res.body) || '' };
  } catch (e) {
    return { ok: false, reason: String(e), stat: stat };
  } finally {
    worldBossSelectInProgress = false;
  }
}

// 世界Boss自动报名：每 10 分钟跑一次。
// 逻辑（伤害最大化，按用户口径）：
//   · 只有「进行中/准备期」场次才处理；
//   · 目标属性 = 各属性「属性值 × 倍率(弱点×2/普通×1/防御×0.5)」的最大值，
//     不再盲目选弱点（弱点 ×200% 未必收益最高，取决于我方该属性实际数值）；
//   · 若未报名或已选不是目标属性且未锁定 → 自动报名/改选；
//   · 已锁定或已是最优（即目标属性）则不动。
// 把期望伤害明细拼成可读字符串（供日志/通知）
function worldBossExpectedStr(w) {
  if (!w || !w.expected) return '';
  return STAT_KEYS.map(k => STAT_LABELS[k] + '×' + w.expected[k]).join(' ');
}
async function autoSelectWorldBoss() {
  if (!m.worldBossAuto || !m.enabled) return;
  if (!m.worldBoss || Date.now() - m.worldBoss.updatedAt > WORLD_BOSS_CHECK_MS) {
    await checkWorldBoss();
  }
  const w = m.worldBoss;
  if (!w || !w.hasSession) {
    m.lastWorldBossAuto = { ok: true, reason: 'no-session', changed: false, at: Date.now() };
    return;
  }
  if (!w.inWindow) {
    m.lastWorldBossAuto = { ok: true, reason: 'not-open', boss: w.boss.name, status: w.status, changed: false, at: Date.now() };
    console.log('[monitor] 世界Boss自动报名: 场次未开放(' + w.status + ')，跳过');
    return;
  }
  if (w.player.isLocked) {
    m.lastWorldBossAuto = { ok: true, reason: 'locked', boss: w.boss.name, targetStat: w.targetStat, prevStat: w.player.selectedStat, changed: false, at: Date.now() };
    console.log('[monitor] 世界Boss自动报名: 本场已锁定(' + w.player.selectedStat + ')，不再改选');
    return;
  }
  if (!w.targetStat) {
    m.lastWorldBossAuto = { ok: false, reason: 'no-target', boss: w.boss.name, changed: false, at: Date.now() };
    return;
  }
  // 去重：同一场已成功报名过该目标属性（即使刷新未及时回显），不再重复报名+通知
  const sig = w.sessionId + '|' + w.targetStat;
  if (worldBossHandledSig === sig) {
    m.lastWorldBossAuto = { ok: true, reason: 'already-optimal', boss: w.boss.name, targetStat: w.targetStat, prevStat: w.player.selectedStat, changed: false, at: Date.now() };
    console.log('[monitor] 世界Boss自动报名: 本场已报 ' + STAT_LABELS[w.targetStat] + '，去重跳过');
    return;
  }
  if (!w.shouldChange) {
    // 已是最优（目标属性）或已选为目标
    m.lastWorldBossAuto = { ok: true, reason: 'already-optimal', boss: w.boss.name, targetStat: w.targetStat, prevStat: w.player.selectedStat, changed: false, at: Date.now() };
    console.log('[monitor] 世界Boss自动报名: 已选最优属性 ' + (w.player.selectedStat || w.targetStat) + '(' + STAT_LABELS[w.targetStat] + ')，无需改选。期望: ' + worldBossExpectedStr(w));
    return;
  }
  const isWeak = w.boss && w.boss.weaknessStat === w.targetStat;
  console.log('[monitor] 世界Boss自动报名: ' + w.boss.name + ' 弱点=' + (w.boss.weaknessStat ? STAT_LABELS[w.boss.weaknessStat] : '-')
    + (isWeak ? '(×200%)' : '(弱点非最优，改选伤害最大属性)') + '，当前 ' + (w.player.selectedStat || '未报名')
    + ' → 报名 ' + w.targetStat + '(' + STAT_LABELS[w.targetStat] + ')。期望: ' + worldBossExpectedStr(w));
  const r = await selectWorldBoss(w.targetStat);
  m.lastWorldBossAuto = {
    ok: !!(r && r.ok),
    reason: (r && r.ok) ? 'changed' : (r && r.reason) || 'select-failed',
    boss: w.boss.name,
    targetStat: w.targetStat,
    prevStat: w.player.selectedStat,
    changed: !!(r && r.ok),
    at: Date.now(),
  };
  if (r && r.ok) {
    worldBossHandledSig = w.sessionId + '|' + w.targetStat; // 记录本次成功签名，后续去重
    sendWebhook('[Reelax] ⚔️ 世界Boss自动报名: ' + w.boss.name + ' 已选 ' + STAT_LABELS[w.targetStat]
      + (isWeak ? '（弱点 ×200%）' : '（伤害最大化，非弱点）'));
  }
  return r;
}

function startWorldBossCheck() {
  if (worldBossCheckTimer) clearInterval(worldBossCheckTimer);
  worldBossCheckTimer = setInterval(() => {
    checkWorldBoss().then(autoSelectWorldBoss);
  }, WORLD_BOSS_CHECK_MS);
  // 启动即查一次并尝试自动报名
  checkWorldBoss().then(autoSelectWorldBoss);
}

// ---------- 市场装备监测（gear watch） ----------
// 每 gearWatchCheckSec（默认 10 分钟）扫一次市场装备卖单：按 品级/部位多选/最低品质/最低强化等级/
// 最高期望价 筛选，命中且单价低于最高期望价 → webhook 推送该装备详情；同一条订单只通知一次（去重）。
// 每个品级组用 nextCursor 翻页拉取「整个市场」该品级的卖单（不再只取前 100 件：按价格升序时，
// 前面更便宜的低质装备会把目标高品质订单挤出首页）；品质/强化不下推服务端（高品值如 99/100 的
// 服务端筛选不可靠），统一拉全量后在本地按各条需求单兜底过滤。
const GEAR_SLOT_CN = {
  head: '头冠', chest: '上衣', legs: '绑腿', boots: '靴子', gloves: '手套',
  ring: '戒指', amulet: '项链', charm: '护符',
};
const GEAR_WATCH_PAGE_LIMIT = 100;     // 单页条数（接口单页上限 100）
const GEAR_WATCH_MAX_PAGES = 50;       // 每个品级组最多翻多少页（≤5000 件，游标异常/超大市场时兜底防刷爆请求）
const GEAR_WATCH_PAGE_DELAY_MS = 800;  // 翻页请求之间的基础间隔（风控：串行 + 随机抖动，避开固定周期特征）
const GEAR_WATCH_PAGE_JITTER_MS = 700; // 实际间隔 = 800 + random(0,700) ms
let gearWatchTimer = null;
let gearWatchInProgress = false;
let gearWatchNotified = new Set(); // 已通知的订单 id（去重，SW 会话内）

function gearSlotCN(slot) {
  return GEAR_SLOT_CN[slot] || slot || '?';
}

function formatGearGold(v) {
  if (v == null) return '?';
  return Number(v).toLocaleString('en-US') + ' 金';
}

// 构建一条装备的 webhook 详情文本
function gearWatchDetailText(o) {
  const gear = (o && o.asset && o.asset.gear) || {};
  const base = gear.baseStats || gear.effectiveStats || {};
  const statStr = Object.keys(base).map((k) => {
    const cn = STAT_LABELS[k] || k;
    return `${cn} ${base[k]}`;
  }).join(' / ');
  const stars = gear.qualityStars ? '★'.repeat(Math.max(1, Number(gear.qualityStars) || 1)) : '';
  return `${gear.name || '未知装备'}(${gear.rarity || '?'}·${gearSlotCN(gear.slot)})`
    + ` 品质${gear.quality || 0} ${stars} 强化+${gear.upgradeLevel || 0}`
    + `\n价格 ${formatGearGold(o.limitUnitPrice)} · ${statStr}`
    + (o.ownerNickname ? `\n卖家 ${o.ownerNickname}` : '');
}

// 按品级组的查询条件翻页拉取「整个市场」该品级的全部卖单（nextCursor 翻页）。
// 服务端只下推 rarity / maxPrice（品质/强化改由本地过滤）；sort=price&asc 让最便宜的在前。
// 返回 { orders, failed, reason }：
//   · 无 nextCursor、本页为空、或已出现 > 组内上限价的订单 → 正常结束（挂单价=上限价仍算命中，需继续翻完同价单）；
//   · 翻够 GEAR_WATCH_MAX_PAGES 页强制停止（游标异常/市场超大时的请求量兜底）；
//   · 任一页 3 次重试仍失败 → failed=true，调用方按整轮失败处理。
async function fetchAllGearWatchOrders(q) {
  const orders = [];
  let cursor = null;
  for (let page = 0; page < GEAR_WATCH_MAX_PAGES; page++) {
    // 页面代理可能暂不可用（no-handler：reelax 页加载中/节能挂起）→ 短暂重试几次再判定失败。
    let res = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      res = await ReelaxApi.marketOrders({
        assetType: 'gear', side: 'sell',
        rarities: q.rarity ? [q.rarity] : undefined,
        maxPrice: q.maxPrice || undefined,
        sort: 'price', direction: 'asc',
        limit: GEAR_WATCH_PAGE_LIMIT,
        cursor: cursor || undefined,
      });
      if (res && res.ok) break;
      if (attempt < 2) await new Promise((r) => setTimeout(r, 2500 + attempt * 2500)); // 2.5s / 5s 后重试
    }
    if (!res || !res.ok) {
      return { orders, failed: true, reason: (res && (res.error || res.body)) || 'fetch-failed' };
    }
    const pageOrders = (res.data && res.data.orders) || [];
    orders.push(...pageOrders);
    // price 升序兜底：一旦本页出现「严格高于」组内上限价（或缺价格）的单，后面只会更贵，直接结束；
    // 注意等于上限价的单仍属命中范围（期望价含本数），要继续翻页把同价单收全。
    if (q.maxPrice && pageOrders.some((o) => o.limitUnitPrice == null || o.limitUnitPrice > q.maxPrice)) break;
    cursor = res.data && res.data.nextCursor;
    if (!cursor || !pageOrders.length) break;
    // 页间节流（风控：串行 + 抖动，最后一页不等）
    await new Promise((r) => setTimeout(r, GEAR_WATCH_PAGE_DELAY_MS + Math.random() * GEAR_WATCH_PAGE_JITTER_MS));
  }
  return { orders, failed: false };
}

async function checkGearWatch() {
  if (!m.gearWatchEnabled) { m.gearWatch = null; return; }
  if (gearWatchInProgress) return;
  gearWatchInProgress = true;
  try {
    const rules = (Array.isArray(m.gearWatchRules) ? m.gearWatchRules : []).filter((r) => r.rarity || (r.slots && r.slots.length) || r.maxPrice || r.minQuality || r.minUpgrade);
    if (!rules.length) { m.gearWatch = { ok: true, scanned: 0, hits: 0, checkedAt: Date.now(), at: Date.now() }; return; }

    // ---- 合并优化：按「品级」分组，每组翻页拉「整个市场」，再在本地按各条收紧过滤 ----
    // 服务端只下推 rarity / maxPrice；品质/强化不下推（高品值如 99/100 的服务端筛选不可靠），
    // 拉全量后本地兜底。maxPrice：任一需求单不限价则整组不下推（此时靠页数上限兜底），否则取组内最大值。
    const groups = new Map(); // key: rarity → { rules:[{rule,maxPrice,minQuality,minUpgrade}], query:{rarity,maxPrice} }
    for (const rule of rules) {
      const rarity = String(rule.rarity || '').trim();
      const maxPrice = Number(rule.maxPrice) > 0 ? Number(rule.maxPrice) : 0; // 0=不限
      const minQuality = Number(rule.minQuality) > 0 ? Number(rule.minQuality) : 0;
      const minUpgrade = Number(rule.minUpgrade) > 0 ? Number(rule.minUpgrade) : 0;
      if (!groups.has(rarity)) groups.set(rarity, { rarity, rules: [] });
      groups.get(rarity).rules.push({ rule, maxPrice, minQuality, minUpgrade });
    }
    for (const g of groups.values()) {
      let mp = 0;
      for (const it of g.rules) {
        if (it.maxPrice === 0) { mp = 0; break; } // 任一单不限价 → 整组不下推
        if (it.maxPrice > mp) mp = it.maxPrice;
      }
      g.query = { rarity: g.rarity, maxPrice: mp };
    }

    const allHits = [];
    let scannedTotal = 0;
    for (const g of groups.values()) {
      // 翻页拉取该品级整个市场的卖单（sort=price&asc，失败带已拉数量，便于 popup 排查）
      const fetched = await fetchAllGearWatchOrders(g.query);
      scannedTotal += fetched.orders.length;
      if (fetched.failed) {
        m.gearWatch = { ok: false, reason: fetched.reason, scanned: scannedTotal, checkedAt: Date.now(), at: Date.now() };
        return;
      }
      // 对拉回的每条订单，分别用组内每条需求单的收紧条件过滤
      for (const o of fetched.orders) {
        if (o.isOwnOrder) continue;
        const gear = (o.asset && o.asset.gear) || {};
        for (const item of g.rules) {
          const slots = (Array.isArray(item.rule.slots) ? item.rule.slots : []).filter(Boolean);
          if (slots.length && !slots.includes(gear.slot)) continue;
          if (!gear.quality || (item.minQuality && gear.quality < item.minQuality)) continue;
          if ((gear.upgradeLevel || 0) < item.minUpgrade) continue;
          if (item.maxPrice && (o.limitUnitPrice == null || o.limitUnitPrice > item.maxPrice)) continue; // 期望价含本数：挂单价 > 上限才排除
          allHits.push({ order: o, gear, rule: (item.rule.name || '需求单') });
          break; // 一条订单一旦命中该组任一条需求单即可，避免重复
        }
      }
    }

    // 去重（同一条订单只通知一次）+ webhook；hit 携带命中的需求单名
    const seen = new Set();
    const uniqueHits = [];
    for (const h of allHits) {
      if (seen.has(h.order.id)) continue;
      seen.add(h.order.id);
      uniqueHits.push(h);
    }
    const fresh = uniqueHits.filter((h) => !gearWatchNotified.has(h.order.id));
    for (const h of fresh) {
      gearWatchNotified.add(h.order.id);
      if (gearWatchNotified.size > 3000) {
        // 防无限增长：清掉最老的一半
        const arr = Array.from(gearWatchNotified);
        arr.splice(0, Math.floor(arr.length / 2));
        gearWatchNotified = new Set(arr);
      }
      if (m.gearWatchNotify) {
        try {
          await sendWebhook('[Reelax] 🛒 市场装备命中（' + (h.rule || '需求单') + '）：\n' + gearWatchDetailText(h.order));
        } catch (e) {
          console.warn('[monitor] 市场装备命中通知发送异常:', e);
        }
      }
    }
    m.gearWatchHits = uniqueHits.slice(0, 20); // popup 展示排序后的最近命中（去重后）
    m.gearWatch = { ok: true, scanned: scannedTotal, hits: uniqueHits.length, rules: rules.length, checkedAt: Date.now(), at: Date.now() };
  } catch (e) {
    m.gearWatch = { ok: false, reason: String(e), checkedAt: Date.now(), at: Date.now() };
    console.warn('[monitor] 市场装备监测异常:', e);
  } finally {
    gearWatchInProgress = false;
  }
}

function startGearWatch() {
  if (gearWatchTimer) clearInterval(gearWatchTimer);
  const ms = Math.max(60000, (m.gearWatchCheckSec || 600) * 1000);
  gearWatchTimer = setInterval(checkGearWatch, ms);
  checkGearWatch(); // 启动即扫一次
}

// ---------- 自动开公会区域增益（由聚合优选地图驱动） ----------
// 由聚合.js 在确定「优选地图」（含赛事/跟船/最优图等一切选图决策）时，
// 经 injector.js 转发到后台，本模块直接对目标图调用 guildBoostPurchase 开增益。
// 不再自行匹配赛事/天气（原有的天气/赛事事件驱动与 60s 定时兜底已移除）。
// 份数规则（用户口径）：
//   · 赛事图：固定 2 份(1h)（无脑开，不看天气）。每场比赛持续 60 分钟，正好 2 份(2×30min)。
//   · 非赛事：所有天气都允许开增益（不限制天气）；
//     份数按目标图天气剩余分钟折算：先向下取整到30分钟整份，若剩余零头 ≥ AUTO_BOOST_CEIL_THRESHOLD_MIN
//     （20分，即离下一份整点剩不到10分）则向上多开 1 份，让接近整点的图吃满（如 1h40 → 3 份；1h50 → 4 份）；
//     天气剩余不足 1 份(<30分钟) 不开。
//   · 开前验证：目标地图已有未过期增益(isActive=true)则不新开，防止多开。
const AUTO_BOOST_UNITS_TOURNAMENT = 2;  // 赛事固定 2 份(1h)，匹配每场 60 分钟赛制（新版按赛程剩余动态折算，见 currentCompetitionEndMs）
const AUTO_BOOST_UNIT_MIN = 30;         // 1 份增益 = 30 分钟
const AUTO_BOOST_CEIL_THRESHOLD_MIN = 20; // 非赛事：零头 ≥ 20分(离下一份整点剩不到10分) 则向上多开 1 份
const AUTO_BOOST_WEATHER_IDS = 'all';   // 非赛事所有天气都允许开增益（不限制）
const AUTO_BOOST_COOLDOWN_MS = 5 * 60 * 1000; // 同一地图开增益冷却 5 分钟
// 比赛开始时间（北京时间，每天固定）：
//   个人赛：10:00 开赛、15:00 开赛，每场持续 60 分钟；
//   公会赛：取消下午场，仅保留每天 20:00 一场，持续 60 分钟。
const AUTO_BOOST_COMP_START_HOURS = [10, 15, 20]; // 真正的比赛开始时刻：个人赛 10:00/15:00，公会赛 20:00

// 北京当前时刻 → 最近下一场比赛开始的时间戳（毫秒）
function nextCompetitionStartMs(now) {
  // 用北京时间计算：本地时间 + 8h 取 UTC 小时
  const bj = now + 8 * 3600 * 1000;
  const bjDate = new Date(bj);
  const bjHour = bjDate.getUTCHours();
  const bjMin = bjDate.getUTCMinutes();
  let best = null;
  for (const h of AUTO_BOOST_COMP_START_HOURS) {
    let ts;
    if (h > bjHour || (h === bjHour && bjMin === 0)) {
      // 今天这场还没开始（或正好开始）
      ts = Date.UTC(bjDate.getUTCFullYear(), bjDate.getUTCMonth(), bjDate.getUTCDate(), h, 0, 0) - 8 * 3600 * 1000;
    } else {
      // 已过，取明天
      const tomorrow = new Date(bjDate.getTime() + 24 * 3600 * 1000);
      ts = Date.UTC(tomorrow.getUTCFullYear(), tomorrow.getUTCMonth(), tomorrow.getUTCDate(), h, 0, 0) - 8 * 3600 * 1000;
    }
    if (!best || ts < best) best = ts;
  }
  return best;
}

const AUTO_BOOST_COMP_DURATION_MIN = 60; // 每场比赛时长（分钟）：个人赛 10-11/15-16、公会赛 20-21，均 60 分钟

// 当前「正在进行」的比赛场次结束时刻（毫秒时间戳）。
// 复用 nextCompetitionStartMs 的北京时间规则：取最近一次已开始的比赛开始点 + 时长。
// 用于按赛程剩余时间动态折算赛事增益份数（不再固定 2 份）。
function currentCompetitionEndMs(now) {
  const bj = now + 8 * 3600 * 1000;
  const bjDate = new Date(bj);
  const bjHour = bjDate.getUTCHours();
  const bjMin = bjDate.getUTCMinutes();
  let start = null;
  for (const h of AUTO_BOOST_COMP_START_HOURS) {
    if (h < bjHour || (h === bjHour && bjMin >= 0)) {
      // 今天 h:00 这场可能已开始（含正好开始）
      const ts = Date.UTC(bjDate.getUTCFullYear(), bjDate.getUTCMonth(), bjDate.getUTCDate(), h, 0, 0) - 8 * 3600 * 1000;
      if (ts <= now && (!start || ts > start)) start = ts;
    }
  }
  if (!start) return null; // 当前不在任何比赛时段
  return start + AUTO_BOOST_COMP_DURATION_MIN * 60000;
}

let autoBoostInProgress = false;
let autoBoostLastAt = {}; // biomeId → 上次开增益时间戳

// 自动开增益状态持久化：把「最近一次结果 + 检查历史」存到浏览器本地存储，重启不丢。
// 键 reelax-auto-boost。历史含未触发增益的各种 check（便于排查为何没开）。
const AUTO_BOOST_STORAGE_KEY = 'reelax-auto-boost';
const AUTO_BOOST_HISTORY_MAX = 50; // 历史最多保留条数

// 把最近结果+历史写入 storage.local（浏览器本地存储，跨重启）
function persistAutoBoost() {
  try {
    browser.storage.local.set({
      [AUTO_BOOST_STORAGE_KEY]: {
        last: m.autoBoost || null,
        history: (Array.isArray(m.autoBoostHistory) ? m.autoBoostHistory : []).slice(0, AUTO_BOOST_HISTORY_MAX),
        savedAt: Date.now(),
      },
    }).catch(function () { /* 存储失败忽略 */ });
  } catch (e) { /* 忽略 */ }
}

// 启动时从 storage.local 恢复最近结果与历史（浏览器重启后不丢）
function restoreAutoBoost() {
  try {
    browser.storage.local.get(AUTO_BOOST_STORAGE_KEY).then(function (res) {
      const d = res && res[AUTO_BOOST_STORAGE_KEY];
      if (!d) return;
      if (d.last && typeof d.last === 'object') m.autoBoost = d.last;
      if (Array.isArray(d.history)) m.autoBoostHistory = d.history.slice(0, AUTO_BOOST_HISTORY_MAX);
      if (!m.autoBoostHistory || m.autoBoostHistory.length === 0) m.autoBoostHistory = [];
      console.log('[AutoBoost] 已从本地存储恢复状态，历史条数:', (m.autoBoostHistory || []).length);
    }).catch(function () { /* 忽略 */ });
  } catch (e) { /* 忽略 */ }
}

// 记录一条自动增益的 check 结果（含未触发）；返回记录本身
function recordAutoBoost(record) {
  m.autoBoost = record;
  if (!Array.isArray(m.autoBoostHistory)) m.autoBoostHistory = [];
  m.autoBoostHistory.unshift(record); // 最新在前
  if (m.autoBoostHistory.length > AUTO_BOOST_HISTORY_MAX) m.autoBoostHistory.length = AUTO_BOOST_HISTORY_MAX;
  persistAutoBoost();
  return record;
}


// ---------- 自动开增益：不再有定时兜底检查 ----------
// 开增益完全由聚合.js 的「优选地图」通知驱动（notifyPreferredBoost），
// 此处不再自行查询赛事/天气兜底，避免与聚合的选图逻辑冲突。

// ---------- 当前状态总览（供 popup「自动开增益」面板展示） ----------
// 当前地图/天气/赛事/增益概览，30 秒刷新一次，仅用于展示，不做开增益决策。
const CURRENT_STATUS_BIOME_CN = { b_001:'月落溪谷', b_002:'雾语湿地', b_003:'镜潮海岸', b_004:'雷痕峡湾', b_005:'星根洞窟', b_006:'霞栖湖原', b_007:'云汐悬湖', b_008:'赤砂涌泉', b_009:'极昼冰湾', b_010:'沉钟古港', b_011:'翡翠洪林', b_012:'熔潮环礁', b_013:'天穹鲸海', b_014:'时镜回流', b_015:'星渊圣海' };
let currentStatusTimer = null;
let currentStatusInProgress = false;

function fmtRemainMin(endsAt) {
  if (!endsAt) return null;
  const end = Date.parse(endsAt);
  if (!Number.isFinite(end)) return null;
  const mm = (end - Date.now()) / 60000;
  if (mm <= 0) return 0;
  if (mm < 60) return Math.round(mm) + '分';
  const h = Math.floor(mm / 60), rest = Math.round(mm % 60);
  return h + '时' + (rest ? rest + '分' : '');
}

// 刷新当前状态：当前地图 + 天气剩余 + 当前地图公会增益 + 是否有 active 赛事
async function refreshCurrentStatus() {
  if (currentStatusInProgress) return;
  currentStatusInProgress = true;
  try {
    const [overviewRes, guildCompRes, personalRes] = await Promise.all([
      ReelaxApi.guildOverview(),
      ReelaxApi.guildCompetitionOverview().catch(function(){ return null; }),
      ReelaxApi.tournamentOverview().catch(function(){ return null; }),
    ]);

    const overview = overviewRes && overviewRes.ok ? overviewRes : null;
    const cur = overview && overview.currentBiome ? overview.currentBiome : null;

    // 当前地图天气剩余
    let weather = null;
    if (cur && cur.weather) {
      weather = {
        name: cur.weather.name || cur.weather.weatherId || null,
        weatherId: cur.weather.weatherId || null,
        endsAt: cur.weather.endsAt || null,
        remainingMin: cur.weatherRemainingMin != null ? cur.weatherRemainingMin : fmtRemainMin(cur.weather.endsAt),
      };
    }
    // 当前地图公会增益（isActive 从 overview.maps 里找当前地图）
    let guildBoost = null;
    if (overview && Array.isArray(overview.maps)) {
      const b = overview.maps.find(function (x) { return x.biomeId === (cur && cur.biomeId); });
      if (b) {
        guildBoost = { isActive: b.isActive === true, endsAt: b.boostEndsAt || null, remainingMin: fmtRemainMin(b.boostEndsAt) };
      } else if (cur && cur.guildBoostEndsAt) {
        // 兜底：biomes 的 guildBoostEndsAt 有值视为有增益
        guildBoost = { isActive: true, endsAt: cur.guildBoostEndsAt, remainingMin: fmtRemainMin(cur.guildBoostEndsAt) };
      }
    }
    // active 赛事（工会赛 > 个人赛）
    let activeTournament = null;
    const g = (guildCompRes && guildCompRes.ok && guildCompRes.data && guildCompRes.data.current) ? guildCompRes.data.current : null;
    const p = (personalRes && personalRes.ok && personalRes.data && personalRes.data.current) ? personalRes.data.current : null;
    if (g && g.status === 'active') {
      activeTournament = { kind: 'guild', biomeId: g.biomeId, biomeName: CURRENT_STATUS_BIOME_CN[g.biomeId] || g.biomeId, sequence: g.sequence, endAt: g.endAt };
    } else if (p && p.status === 'active') {
      activeTournament = { kind: 'personal', biomeId: p.biomeId, biomeName: CURRENT_STATUS_BIOME_CN[p.biomeId] || p.biomeId, sequence: p.sequence, endAt: p.endAt };
    }

    m.currentStatus = {
      updatedAt: Date.now(),
      currentBiome: cur ? { id: cur.biomeId, name: cur.name || CURRENT_STATUS_BIOME_CN[cur.biomeId] || cur.biomeId } : null,
      weather: weather,
      guildBoost: guildBoost,
      activeTournament: activeTournament,
    };
  } catch (e) {
    // 刷新失败保留上次状态
  } finally {
    currentStatusInProgress = false;
    // 幂等兜底：复用已有的 30s 状态刷新（不新增轮询），保证 7/15/23 整点窗口内必开一次自定义统计。
    // 仅在整点 [00,30] 分窗口内才发请求（见 openCustomStatIfDue 的 min>30 + 小时判断），其余时间零开销。
    ensureCustomStatIfDue().catch(function () {});
    // 幂等兜底：献祭已改为每 5 分钟常驻轮询（startSacrificePolling），无需此处额外兜底。
  }
}

function startCurrentStatusCheck() {
  if (currentStatusTimer) clearInterval(currentStatusTimer);
  currentStatusTimer = setInterval(refreshCurrentStatus, 30 * 1000);
  refreshCurrentStatus(); // 启动即查一次
}


// 天气剩余分钟 → 增益份数：先向下取整到 30 分钟整份，若余数 ≥ 半份(15分) 则向上多开 1 份，
// 让接近整点的图吃满（1h40→3份；1h50→4份）。天气未知或剩余不足 1 份(<30分钟) 返回 0（不开）。
function computeAutoBoostUnits(endsAt) {
  const end = Date.parse(endsAt);
  if (!Number.isFinite(end)) return 0;
  const remainMin = (end - Date.now()) / 60000;
  if (remainMin < AUTO_BOOST_UNIT_MIN) return 0;
  const fullUnits = Math.floor(remainMin / AUTO_BOOST_UNIT_MIN);
  const leftover = remainMin - fullUnits * AUTO_BOOST_UNIT_MIN; // 不足整份的零头（分钟）
  return leftover >= AUTO_BOOST_CEIL_THRESHOLD_MIN ? fullUnits + 1 : fullUnits;
}

// 给指定地图开增益（开前校验：冷却 + 目标地图是否已有未过期增益）
// 注意：第三个参数是「触发来源标签」（如 优选-赛事/优选-最优图），仅用于展示；
//       返回对象的 reason 字段固定保存真实动作/失败码（already-active/cooldown/purchase-failed/...），
//       两者分开，避免对象字面量里重复的 reason 键把失败码覆盖掉，导致历史里看不到真实失败原因。
// 「已有未过期增益则不新开」即为防止多开的关键校验。
async function openAutoBoost(biomeId, units, label) {
  const now = Date.now();
  const last = autoBoostLastAt[biomeId] || 0;
  if (now - last < AUTO_BOOST_COOLDOWN_MS) {
    return { ok: false, reason: 'cooldown', label, biomeId, units };
  }
  // 校验目标地图是否已有未过期增益
  try {
    const boostsRes = await ReelaxApi.guildBoosts();
    if (boostsRes && boostsRes.ok && boostsRes.data && Array.isArray(boostsRes.data.boosts)) {
      const b = boostsRes.data.boosts.find(function (x) { return x.biomeId === biomeId; });
      if (b && b.isActive === true) {
        console.log('[AutoBoost] 目标地图已有未过期增益，不新开:', biomeId, 'endsAt:', b.endsAt);
        return { ok: false, reason: 'already-active', label, biomeId, endsAt: b.endsAt, units };
      }
    }
  } catch (e) {
    console.warn('[AutoBoost] 查询增益状态失败，仍尝试开:', e);
  }
  const res = await ReelaxApi.guildBoostPurchase(biomeId, units);
  if (res && res.ok) {
    autoBoostLastAt[biomeId] = now;
    console.log('[AutoBoost] 已开增益:', biomeId, units + '份', '(' + label + ')', res.body);
    const boostBiomeName = CURRENT_STATUS_BIOME_CN[biomeId] || biomeId;
    sendWebhook('[Reelax] ⚔️ 自动开启公会增益: ' + boostBiomeName + ' (' + biomeId + ') x' + units + '份');
    return { ok: true, reason: 'opened', label, biomeId, units };
  }
  return { ok: false, reason: 'purchase-failed', label, biomeId, units, body: (res && res.body) || '' };
}

// ---------- 经验优选开增益前「天气最优」校验 ----------
// 用户口径（weather-not-optimal 拦截）：
//   经验优选模式下，开增益前校验目标地图天气是否为「纯天气倍率最大」；
//   若有多个相同天气地图，则选择船能到达最远的地图（requiredLevel 最大，受 crewLowestLevel 木桶上限限制）。
//   纯天气 = WEATHER_DEFS.xpMultiplier（不乘专精/公会）。目标图天气非最优时仅拦截不开，
//   并通知聚合.js 改去该天气最优图（不应开在原目标图上）。
// 注意：本校验仅对 priorityType==='experience' 生效；赛事/最优图/跟船等其它分支维持原行为。
const AUTO_BOOST_WEATHER_XP = {
  'clear': 1.00, 'rain': 1.05, 'gale': 1.10, 'mist': 1.20,
  'heatwave': 1.30, 'tempest': 1.50, 'wither_tide': 0.50,
  'gilded_current': 0.75, 'arcane_surge': 1.75,
};

// 从天气对象取纯天气倍率：优先 weatherId 查静态表；响应直接带 xpMultiplier 时取它；未知按晴朗 1.00。
function _weatherXp(weather) {
  if (weather && typeof weather.xpMultiplier === 'number') return weather.xpMultiplier;
  const id = (weather && (weather.id || weather.weatherId)) || null;
  if (id && typeof AUTO_BOOST_WEATHER_XP[id] === 'number') return AUTO_BOOST_WEATHER_XP[id];
  return 1.00;
}

// 后台 GET 一把，解析 JSON（失败返回 null；path 仅限只读接口）
async function _monitorFetchJSON(path) {
  try {
    const res = await ReelaxApi.raw(path, 'GET', null);
    if (!res || !res.ok) return null;
    return ReelaxApi.safeParseJSON(res.body);
  } catch (_e) { return null; }
}

// 计算「纯天气倍率最大 · 船可达最远」的目标图（经验优选开增益校验用）。
// 船可达 = requiredLevel ≤ crewLowestLevel（木桶上限，从 /api/party-boats/overview 的 crew.members 最低等级推导）；
//         无船/无船员数据或 crewLowestLevel 未知时退化为全部已解锁图（与聚合贪婪模式一致）。
// 相同纯天气倍率取 requiredLevel 最大者（船可达最远）；天气未知按 1.00 参与排序但不高于有明确天气的图。
// 返回 { biomeId, biomeName, xp, rl, weatherId } 或 null（取不到 /api/biomes 时）。
async function findBoostWeatherOptimalBiome() {
  const bio = await _monitorFetchJSON('/api/biomes');
  const biomes = bio && Array.isArray(bio.biomes) ? bio.biomes : null;
  if (!biomes || !biomes.length) return null;

  let crewLowestLevel = null;
  try {
    const pb = await _monitorFetchJSON('/api/party-boats/overview');
    const body = pb || null;
    const crew = body && (body.crew || (body.party && body.party.crew));
    if (crew && Array.isArray(crew.members) && crew.members.length) {
      let lowest = Infinity;
      for (const m of crew.members) {
        const lv = m && m.identity && typeof m.identity.level === 'number' ? m.identity.level : NaN;
        if (Number.isFinite(lv) && lv < lowest) lowest = lv;
      }
      crewLowestLevel = Number.isFinite(lowest) ? lowest : null;
    }
  } catch (_e) { /* 船数据取不到则不做木桶过滤 */ }

  let best = null;
  for (const b of biomes) {
    if (!b || b.isUnlocked !== true) continue;
    const rl = typeof b.requiredLevel === 'number' ? b.requiredLevel : 0;
    if (typeof crewLowestLevel === 'number' && rl > crewLowestLevel) continue;
    const xp = _weatherXp(b.weather);
    if (!best || xp > best.xp || (xp === best.xp && rl > best.rl)) {
      best = { biomeId: b.id, biomeName: b.name || b.id, xp, rl, weatherId: (b.weather && (b.weather.id || b.weather.weatherId)) || null };
    }
  }
  return best;
}

// 通知页面主世界聚合.js：改去指定地图（经 injector.js 转发到 window.postMessage({__reelaxSwitchTo})）。
// 用于「目标图天气非最优 → 让聚合切到纯天气最优点」。对匹配的 reelax 标签页逐一尝试。
function notifyReelaxSwitchBiome(biomeId, biomeName, weatherId, xp, fromBiomeId) {
  try {
    browser.tabs.query({ url: '*://reelax.cn/*' }).then(function (tabs) {
      if (!tabs || !tabs.length) return;
      for (const t of tabs) {
        browser.tabs.sendMessage(t.id, {
          type: 'reelax-auto-switch-to',
          biomeId,
          biomeName,
          weatherId,
          xp,
          fromBiomeId,
        }).catch(function () { /* 该tab未注入handler则忽略 */ });
      }
    }).catch(function () { /* 无tab忽略 */ });
  } catch (e) { console.warn('[AutoBoost] 通知聚合切图失败:', e); }
}

// 自动开增益主入口：data = { type:'preferred', biomeId, biomeName, priorityType, reason, weatherEndsAt }
// 由聚合.js 在确定「优选地图」时经 injector.js 转发过来；不再自行匹配赛事/天气。
// 目标地图由聚合的选图/切图逻辑给出，这里只负责折算份数并开增益。
// 结果统一写入 m.autoBoost（最近一次自动开增益结果，供 popup 展示）
async function handleAutoBoost(data) {
  if (!data || data.type !== 'preferred' || !data.biomeId) return { ok: false, reason: 'no-data' };
  if (!m.guildBoostAuto) return { ok: false, reason: 'disabled' }; // 区域经验增益开关关闭时不自动开
  if (autoBoostInProgress) return { ok: false, reason: 'locked' };
  autoBoostInProgress = true;
  let result = null;
  try {
    const biomeId = data.biomeId;
    // 份数规则：赛事图固定 2 份(1h)；非赛事份数按目标图天气剩余分钟折算（向下取整到30整份，零头≥半份多开1份，如 1h40 → 3 份、1h50 → 4 份）；
    // 天气未知或剩余不足 1 份(<30分钟) 时不开（避免浪费）。开前仍校验已有增益（already-active）防多开。
    let units, label;
    if (data.priorityType === 'competition') {
      // 赛事：直接开（不校验献祭进度/天气，比赛收益优先），但份数按赛程剩余时长动态折算
      // （如赛程剩 25 分钟只开 1 份，不浪费；不足 1 份<30分钟 的零头也按 computeAutoBoostUnits 规则多开/不开）。
      const compEnd = currentCompetitionEndMs(Date.now());
      units = (compEnd && compEnd > Date.now())
        ? computeAutoBoostUnits(new Date(compEnd).toISOString())
        : AUTO_BOOST_UNITS_TOURNAMENT; // 不在比赛时段/算不出赛程时仍按固定 2 份兜底
      label = '优选-赛事' + '(剩' + Math.max(0, Math.floor(((compEnd || 0) - Date.now()) / 60000)) + '分)';
    } else {
      // 经验优选开增益前「天气最优」校验：目标图须为纯天气倍率最大的船可达最远图。
      // 若聚合选出的经验最优图天气非最优，仅拦截不开并通知聚合改去天气最优点（用户口径）。
      if (data.priorityType === 'experience') {
        let weatherOpt = null;
        try { weatherOpt = await findBoostWeatherOptimalBiome(); } catch (_e) { /* 取数失败则跳过校验，不误拦 */ }
        if (weatherOpt && weatherOpt.biomeId !== biomeId) {
          console.log('[AutoBoost] 目标图天气非最优，拦截不开。当前:', biomeId, '| 天气最优·船可达最远:', weatherOpt.biomeId, weatherOpt.biomeName, weatherOpt.weatherId, 'x' + weatherOpt.xp);
          notifyReelaxSwitchBiome(weatherOpt.biomeId, weatherOpt.biomeName, weatherOpt.weatherId, weatherOpt.xp, biomeId);
          result = {
            ok: false,
            reason: 'weather-not-optimal',
            label: '优选-经验',
            biomeId,
            units: 0,
            weatherOpt: { biomeId: weatherOpt.biomeId, biomeName: weatherOpt.biomeName, weatherId: weatherOpt.weatherId, xp: weatherOpt.xp },
          };
          return result;
        }
      }
      // 奥术献祭未满 100% 时不开增益（仅非赛事；赛事跳过，见上）：
      // 献祭阶段开增益是浪费，等整服推进到 100%（progress >= target）后才值得开。
      // 【修复】此前直接读 m.arcaneSacrifice（每 5 分钟才刷新的缓存）的 currentRound：在「第一轮已
      // 结束、第二轮未开」的轮次间隙里，缓存可能是旧的低进度快照 → 误判为「未满100%」而拦截开增益。
      // 现在开增益判定前实时刷新一次献祭状态，并只对「真正有开放可续捐轮、且进度未满」才拦截；
      // 无开放轮（间隙/未开）时用旧快照拦截没有意义，应放行正常开增益。刷新失败（拿不到数据）仍放行。
      try { await checkSacrifice(); } catch (_e) {}
      const sr = m.arcaneSacrifice && m.arcaneSacrifice.currentRound;
      const srContrib = sr && isRoundContributable(sr) && sr.status === 'open';
      if (srContrib && typeof sr.progress === 'number' && typeof sr.target === 'number' && sr.target > 0 && sr.progress < sr.target) {
        const srPct = Math.round((sr.progress / sr.target) * 100);
        console.log('[AutoBoost] 奥术献祭未满100%（当前' + srPct + '%），非赛事不开增益:', biomeId);
        result = { ok: false, reason: 'arcane-not-complete', label: data.priorityType === 'optimal' ? '优选-最优图' : (data.reason || '优选图'), biomeId, units: 0, sacrificePct: srPct };
        return result;
      }
      // 非赛事：所有天气都允许开增益（AUTO_BOOST_WEATHER_IDS='all' 即不限制天气）；
      // 份数仍按目标图天气剩余分钟向下取整到 30 的倍数，不足 1 份(<30分钟) 不开。
      const wid = data.weatherId || null;
      let byWeather = computeAutoBoostUnits(data.weatherEndsAt);
      if (byWeather <= 0) {
        console.log('[AutoBoost] 优选图非赛事但天气剩余不足30分钟或未知，不开:', biomeId, data.weatherEndsAt);
        result = { ok: false, reason: 'weather-too-short', label: data.priorityType === 'optimal' ? '优选-最优图' : (data.reason || '优选图'), biomeId, units: 0 };
        return result;
      }
      // 截断：增益不能越过最近一场比赛开始时间（10:00/15:00/20:00）。
      // 复用份数折算同一个 20 分钟缓冲(AUTO_BOOST_CEIL_THRESHOLD_MIN)：开 N 份覆盖 N×30 分钟，
      // 距比赛开始只需 ≥ N×30 − 20 即可（多留的 20 当容差），即 maxUnits = floor((距赛 + 30 − 20)/30)。
      // 例：距赛 50 分 → floor((50+10)/30)=2 份；40~49 分 → 1 份。
      const compStart = nextCompetitionStartMs(Date.now());
      if (compStart) {
        const maxUnitsByComp = Math.floor((compStart - Date.now() + (AUTO_BOOST_UNIT_MIN - AUTO_BOOST_CEIL_THRESHOLD_MIN) * 60000) / (AUTO_BOOST_UNIT_MIN * 60000));
        if (maxUnitsByComp <= 0) {
          console.log('[AutoBoost] 距下一场比赛开始不足30分钟，非赛事不开增益:', biomeId);
          result = { ok: false, reason: 'comp-too-soon', label: data.priorityType === 'optimal' ? '优选-最优图' : (data.reason || '优选图'), biomeId, units: 0 };
          return result;
        }
        if (byWeather > maxUnitsByComp) byWeather = maxUnitsByComp;
      }
      units = byWeather;
      label = data.priorityType === 'optimal' ? '优选-最优图' : (data.reason || '优选图');
    }
    // 贪婪模式封顶（经验优选·贪婪）：只按专精×天气选出的基础最优图，开增益最多 1 份；
    // 但「船就在该图」时按原模式开足（船图本身就能吃到船队加成，值当开满）。
    if (data.greedy === true && data.boatOnMap !== true && units > 1) {
      console.log('[AutoBoost] 贪婪模式：优选取图只开1份增益:', biomeId, units + '->1');
      units = 1;
      label = (label || data.reason || '优选图') + '·贪婪1份';
    }
    result = await openAutoBoost(biomeId, units, label);
    return result;
  } finally {
    // 记录最近一次自动开增益结果（含触发类型/时间戳/诊断信息），并写入历史 + 本地存储持久化。
    // 未触发的情况（如 already-active / cooldown / purchase-failed）也会记录，便于排查「为什么没开增益」。
    if (result) {
      recordAutoBoost(Object.assign({
        at: Date.now(),
        triggerType: 'preferred',
        biomeName: data.biomeName || null,
        diag: { priorityType: data.priorityType || null, reason: data.reason || null, weatherEndsAt: data.weatherEndsAt || null },
      }, result));
    }
    autoBoostInProgress = false;
  }
}

// 赛事一键报名：只在启动时跑一次（register-all 对已报名赛事幂等，重复调用无副作用）
let _registerAllDone = false;
async function registerAllOnce() {
  if (_registerAllDone) return;
  _registerAllDone = true;
  try {
    const res = await ReelaxApi.registerAllTournaments();
    if (res && res.ok) {
      m.lastRegisterResult = { ok: true, status: res.status, at: Date.now() };
      console.log('[monitor] 赛事一键报名成功');
    } else {
      m.lastRegisterResult = { ok: false, reason: (res && res.error) || 'http', status: res ? res.status : null, at: Date.now() };
      console.warn('[monitor] 赛事一键报名失败:', m.lastRegisterResult.reason, res && (res.body || ''));
    }
  } catch (e) {
    m.lastRegisterResult = { ok: false, reason: String(e), at: Date.now() };
    console.warn('[monitor] 赛事一键报名异常:', e);
  }
}

function monitorStart() {
  // 先恢复持久化基线和保底通知标志，再起各类检查——否则首个 checkPity 会跑赢 restoreStats
  // 的异步读回，把 m.pity 基线盖成 null，SW 打盹期间的出货漏报。
  Promise.resolve(restoreStats()).then(() => {
    restoreAutoBoost();
    monitorLoadConfig().then(() => {
    setupSyncCapture();
    startOfflineCheck();
    startProofCheck();
    startAllocateCheck();
    checkAndAllocate(); // 启动即查一次
    startCompetitionCheck();
    checkCompetitionRespec(); // 启动即查一次比赛状态
    registerAllOnce();
    startGearSell();
    autoSellGear(); // 启动即卖一次（页面未就绪时 no-tab 静默跳过）
    startFishSell();
    checkAndSellFish(); // 启动即查一次鱼库存并出售
    startMasteryCheck();
    contributeMastery(); // 启动即贡献一次
    startPityCheck();
    startSacrificePolling();                       // 常驻：每 5 分钟无条件刷一次事件状态并自动捐献（任何可捐轮都会按时捐）
    startWorldBossCheck();
    startCurrentStatusCheck();
    startGearWatch();                                     // 市场装备监测（默认 10 分钟轮询 + webhook）
    setupTabRecord();
    // 挂机日报（总开关，默认关闭以隔离验证登录稳定性；开启后启用每日采集+调度）
    if (DAILY_REPORT_ENABLED) {
      startDailyCollect();
      startDailyReportScheduler();
      registerDailyResetAlarmListener(); // 注册一次 00:00 重置闹钟监听
      scheduleDailyReset();              // 午夜(北京)清档开新：到点唤醒 SW 强制覆写今天空档
      registerDailyTickAlarmListener();  // 注册「每 1 分钟」在线时长累计闹钟监听（SW 休眠兜底）
      scheduleDailyTickAlarm();          // 到点唤醒 SW 跑 dailyTick，持续累计在线/离线时长
    }
    startCustomStatScheduler();
    startDailyWebhookScheduler(); // 日报 webhook（按选项页开关/指定北京时报）
    registerDailyReportAlarmListener(); // 日报定时唤醒（SW 休眠下 setInterval 不跑，靠 alarms）
    });
  });
}

// 配置热更新
// 注意：storage.onChanged 会在任何 storage 写入时触发（包括 persistStats、tab 记录、URL 记录等），
// 非常频繁。若每次都无条件 clearInterval+setInterval 重建定时器，长间隔定时器会被反复重置、
// 永远到不了触发点（鱼/保底 10 分钟就踩过这个坑）。因此**只在该定时器相关的配置键真正变化时**才重启，
// 其它无关的 storage 写入（落盘统计、URL 记录）一律不干扰定时器。
const TIMER_CONFIG_KEYS = {
  proof: ['proofCheckSec'],
  pity: ['pityMonitor', 'pityCheckSec', 'pityHardMargin'],
  fish: ['fishAutoSell', 'fishSellRarity', 'fishSellRarities', 'fishKeepMax', 'fishSellCheckSec'],
  gearWatch: ['gearWatchEnabled', 'gearWatchRules', 'gearWatchCheckSec', 'gearWatchNotify'],
};
browser.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  const changedKeys = Object.keys(changes || {});
  const anyChanged = (keys) => keys.some((k) => changedKeys.includes(k));
  const proofChanged = anyChanged(TIMER_CONFIG_KEYS.proof);
  const pityChanged = anyChanged(TIMER_CONFIG_KEYS.pity);
  const fishChanged = anyChanged(TIMER_CONFIG_KEYS.fish);
  const gearWatchChanged = anyChanged(TIMER_CONFIG_KEYS.gearWatch);
  monitorLoadConfig().then(() => {
    if (m.enabled) {
      if (proofChanged) {
        if (proofTimer) clearInterval(proofTimer);
        startProofCheck();
      }
      if (pityChanged) {
        // 保底间隔/开关变化 → 重启保底定时器（内部会 clearInterval + 立即查一次）；
        // 日报采集也跟随 same interval（pityIntervalMs），故一并重启到新间隔。
        startPityCheck();
        if (DAILY_REPORT_ENABLED) startDailyCollect();
      }
      if (fishChanged) {
        // 仅当鱼出售配置真的变了才重启定时器，避免反复重置导致 10 分钟到不了
        startFishSell();
      }
      if (gearWatchChanged) {
        // 市场装备监测配置变化 → 重启定时器并立即扫一次
        startGearWatch();
      }
    }
    // 日报 webhook 配置（开关/时间）变化 → 重启定时器
    startDailyWebhookScheduler();
  });
});


// ---------- 挂机日报数据采集（供 gaming/daily_report.py 分析） ----------
// 每天累计原始数据（在线/离线时长、补杆、切图、保底、出货、上杆经济），持久化到 storage，
// 并写出 data/daily_raw.json + player 快照供 Python 模型生成日报。
// 数据通道：①浏览器 storage(reelax-daily-raw) ②写下载目录 data/*.json ③桥实时查(reelax-daily-raw 消息)。
// 挂机日报总开关。开启后 monitor 才会做每日采集 + 2小时分析 + 7/15/23自定义统计。
// （关闭用于隔离验证登录稳定性；现在桥已在线、要出真实日报，故开启。）
// 【页面版日报】2026-09-23：当日原始数据改由页面脚本 日报采集.js 负责（localStorage 唯一来源 +
// 页面自有 WS 直推桥），monitor 的 dailyTick/dailyWriteFile/reconnect 重推全部停用，避免双写
// 互相覆盖。这里 DAILY_REPORT_ENABLED 置 false 让 SW 不再推 raw；日报 webhook/others 不受影响。
const DAILY_REPORT_ENABLED = false;
const DAILY_RAW_KEY = 'reelax-daily-raw';
let dailyTickTimer = null;
let _dailyLastTickAt = 0;
// 已持久化到 storage 的上次 tick 时间戳的内存缓存；SW 重启后首个 dailyTick 通过它接续计时基准。
let _dailyLastTickPersisted = 0;

function dailyDateKey() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

function dailyFresh() {
  return {
    date: dailyDateKey(),
    startedAt: Date.now(),
    activeSec: 0,
    offlineSec: 0,
    refillOk: 0, refillNeeded: 0,
    switchOk: 0, switchTry: 0,
    totalCasts: 0, dailyNetGold: 0,
    rareCatches: { exotic: 0, arcane: 0 },
    pity: null,
    lastTickAt: Date.now(),
  };
}

let daily = null;
let _dailyNeedsForcePush = false; // 跨天重建后置真：下次 dailyWriteFile 强制推新档，覆盖桥上旧档

async function ensureDaily() {
  const key = dailyDateKey();
  // 仅当「已有旧档且日期不同」时才算真正的跨天重建，才需要强制推新档；
  // SW 冷启动（daily 为 null）时 dailyFresh 是空档，不强推，避免空快照覆盖桥上的真实当日数据。
  const rolledOver = !!daily && daily.date !== key;
  if (!daily || daily.date !== key) {
    const wasWarmRollover = rolledOver;
    daily = dailyFresh();
    // 关键修复：await 本次 storage 读回，避免「冷启动先新建空档 → 然后异步用存储里的旧档覆盖」的竞态：
    // 若不一致覆盖，会把并发到达的补杆/切图/出货事件(已写进临时空档并 persist)给冲掉 → 日报这些计数归 ~0。
    try {
      const r = await browser.storage.local.get(DAILY_RAW_KEY);
      const d = r && r[DAILY_RAW_KEY];
      if (d && d.date === key) { daily = d; _dailyNeedsForcePush = false; }
      else if (d && d.date !== key) {
        // storage 仍是「更早一天」的记录（SW 跨天冷启动：daily 为 null 所以 rolledOver 没置位，
        // 内存 fresh 空档是今天的）。必须强制推今天的空档，否则桥的 daily_raw.json 一直留着
        // 昨天的 activeSec/rareCatches → 早上 8:55 日报读到的是昨天的在线时长/出货，看着错误。
        _dailyNeedsForcePush = true;
      }
    } catch (_) {}
    if (wasWarmRollover || _dailyNeedsForcePush) {
      // 跨天/跨天冷启动重建：让 dailyWriteFile 立即把新(空=今天)档推给桥，覆盖桥上隔夜旧档，
      // 否则旧的跨天档会一直留在桥的 daily_raw.json，导致早上日报读到昨天的数据（看着像没重置）。
      _dailyNeedsForcePush = true;
    }
  }
  // SW 重启后把上次持久化的 tick 基准读回内存，供 dailyTick 接续累计在线/离线时长
  if (daily && typeof daily.lastTickAt === 'number') _dailyLastTickPersisted = daily.lastTickAt;
  return daily;
}

async function dailyPersist() {
  const d = await ensureDaily();
  try { browser.storage.local.set({ [DAILY_RAW_KEY]: d }).catch(() => {}); } catch (_) {}
}

function dailyPlayerSnapshot() {
  const p = m.pity || {};
  return { luck: p.effectiveLuck ?? null, bait: p.baitId ?? null, weather: p.weatherId ?? null, name: null };
}

// 把当日原始数据通过桥推给 Python（ws_bridge 写 data/daily_raw.json），不产生下载副本
// 【页面版日报】已停用：原始数据改由页面脚本 日报采集.js 直推桥；本函数不再发消息，避免双写。
async function dailyWriteFile() {
  if (DAILY_REPORT_ENABLED) {
    const d = await ensureDaily();
    const rc = d.rareCatches || {};
    const hasData = (d.activeSec > 0 || d.offlineSec > 0 || (d.totalCasts || 0) > 0
      || (d.dailyNetGold || 0) !== 0 || (d.refillOk || 0) > 0 || (d.switchOk || 0) > 0
      || (rc.exotic || 0) > 0 || (rc.arcane || 0) > 0);
    // 跨天重建时虽全 0，也强制推一次：让桥的 daily_raw.json 立即切到新日期，覆盖隔夜的旧档
    // （否则早上日报会读到昨天数据，看起来像日报没按天重置）。
    if (!hasData && !_dailyNeedsForcePush) return;
    _dailyNeedsForcePush = false;
    const obj = { updatedAt: Date.now(), raw: daily, player: dailyPlayerSnapshot() };
    try {
      browser.runtime.sendMessage({ type: 'reelax-daily-raw', data: obj }).catch(() => {});
    } catch (_) {}
  }
}

async function dailyRecordDrop(rarityKey) {
  if (!DAILY_REPORT_ENABLED) return;
  const d = await ensureDaily();
  if (rarityKey === 'arcane') d.rareCatches.arcane = (d.rareCatches.arcane || 0) + 1;
  else if (rarityKey === 'exotic') d.rareCatches.exotic = (d.rareCatches.exotic || 0) + 1;
  await dailyPersist();
}
async function dailyRecordRefill(ok) {
  if (!DAILY_REPORT_ENABLED) return;
  const d = await ensureDaily(); d.refillNeeded = (d.refillNeeded || 0) + 1; if (ok) d.refillOk = (d.refillOk || 0) + 1; await dailyPersist();
}
async function dailyRecordSwitch(ok) {
  if (!DAILY_REPORT_ENABLED) return;
  const d = await ensureDaily(); d.switchTry = (d.switchTry || 0) + 1; if (ok) d.switchOk = (d.switchOk || 0) + 1; await dailyPersist();
}

// 当日出货数的权威来源：直接用 /api/statistics 的 rarities[].fishCaught（各稀有度累计渔获数）做「当日零点差值」。
// 不再靠观察 currentDryCasts 回落来推断——那在快速连出/采样稀疏时会漏数（8 个只记到 5）。
//   · 基线 statsBaseline = 当天零点(或当天首次拿到统计)时 exotic/arcane 的累计数；
//   · 当日出货 = 当前累计数 − 基线。
// 基线与档案日期绑定，跨天自动重置（新日期首次 apply 时重建基线）。
function ensureStatsBaseline(d) {
  const cur = m.statsRarities;
  if (!cur) return;
  if (!d.statsBaseline || d.statsBaseline.date !== d.date) {
    d.statsBaseline = { date: d.date, exotic: cur.exotic || 0, arcane: cur.arcane || 0, at: Date.now() };
  }
}
function applyRareCatchesFromStats(d) {
  ensureStatsBaseline(d);
  const cur = m.statsRarities;
  const b = d.statsBaseline;
  if (!cur || !b || b.date !== d.date) return;
  if (cur.exotic != null && b.exotic != null) d.rareCatches.exotic = Math.max(0, cur.exotic - b.exotic);
  if (cur.arcane != null && b.arcane != null) d.rareCatches.arcane = Math.max(0, cur.arcane - b.arcane);
}

async function dailyTick() {
  const d = await ensureDaily();
  const now = Date.now();
  // 计时基准持久化到 storage：MV3 SW 会休眠重启，内存变量 _dailyLastTickAt 会被清零，
  // 若 `last = _dailyLastTickAt || now` 就会把本次唤醒窗口的 delta 算成 0 → 在线/离线时长漏计。
  // 改为从 storage 恢复上次 tick 时间戳，SW 重启后能接着上次基准继续累计。
  const last = _dailyLastTickAt || _dailyLastTickPersisted || now;
  const delta = Math.round((now - last) / 1000);
  _dailyLastTickAt = now;
  if (delta > 0 && delta < 600) {
    const alive = m.lastActivityAt && (now - m.lastActivityAt) < 90 * 1000;
    if (alive) d.activeSec += delta; else d.offlineSec += delta;
  } else if (delta >= 600 && d.startedAt) {
    // SW 长时间休眠恢复（超过 10 分钟）：把「上次 tick 到这次 tick」的整段时间也补算。
    // 仍按心跳判定在线/离线，避免休眠期全算离线或全算在线。
    const alive = m.lastActivityAt && (now - m.lastActivityAt) < 90 * 1000;
    const add = Math.min(600, Math.round((now - (d.lastTickAt || now)) / 1000));
    if (add > 0) { if (alive) d.activeSec += add; else d.offlineSec += add; }
  }
  if (m.sync) {
    if (typeof m.sync.dailyCasts === 'number') d.totalCasts = m.sync.dailyCasts;
    if (typeof m.sync.dailyNetGold === 'number') d.dailyNetGold = m.sync.dailyNetGold;
  }
  if (m.pity) {
    d.pity = {
      arcane: { currentDry: m.pity.arcane && m.pity.arcane.currentDry, hardPity: m.pity.arcane && m.pity.arcane.hardPity },
      exotic: { currentDry: m.pity.exotic && m.pity.exotic.currentDry, hardPity: m.pity.exotic && m.pity.exotic.hardPity },
    };
  }
  // 当日出货数改用“统计差值”权威值（覆盖掉 old currentDry 回落推断的计数，避免漏数）
  applyRareCatchesFromStats(d);
  d.lastTickAt = now;          // 本档最近一次累计的时间戳（持久化）
  await dailyPersist();
  _dailyLastTickPersisted = now;   // 同步内存态，供 SW 重启后的首个 tick 读取
  await dailyWriteFile();
}


function startDailyCollect() {
  if (dailyTickTimer) clearInterval(dailyTickTimer);
  ensureDaily();
  dailyTick();
  dailyTickTimer = setInterval(dailyTick, pityIntervalMs()); // 跟随设置页：与保底检查同频共用一次 /api/statistics
}

// 【日报 00:00 重置】用 chrome.alarms 在本地午夜(北京)唤醒 SW 并精确清档开新。
// setInterval 在 MV3 SW 休眠时不跑，而 chrome.alarms 到点能唤醒 SW——否则跨天冷启动时
// dailyWriteFile 常因「空档但未置强推」直接 return，桥的 daily_raw.json 一直留着昨天的
// activeSec/rareCatches → 早上日报读到昨天数据（在线时长爆表、出货对不上）。
const DAILY_RESET_ALARM = 'daily-reset-midnight';

// 距下一次本地 00:00:01 的绝对毫秒时间戳（用与 dailyDateKey 相同的本地时区，保证与日报日期一致）
function nextDailyResetEpoch() {
  const d = new Date();
  const now = Date.now();
  let t = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 1).getTime();
  if (t <= now) t += 24 * 3600 * 1000;
  return t;
}

// 到点强制清档开新：直接把内存 daily 切到今天的空档并立推桥端，再重排明天
async function resetDailyForNewDay() {
  _dailyNeedsForcePush = true;      // 强制让 dailyWriteFile 覆写桥上的旧档
  await ensureDaily();               // ensureDaily 内会因日期不同建今天空档 + 保留强推标志
  // 用最近一次 /api/statistics 的 exotic/arcane 累计数作为今天出货基线的「零点值」（采集间隔 300s，误差≤5分钟）
  ensureStatsBaseline(daily);
  _dailyNeedsForcePush = true;       // ensureDaily 命中当天档时可能清掉标志，这里再置一次
  await dailyPersist();              // 先把今天的空档持久化到 storage，避免后续 SW 重启又从昨天重建
  await dailyWriteFile();            // 立即把今天的空档推给桥（覆盖昨天）
  console.log('[Daily|dbg] 00:00 日报重置完成，新档日期=' + (daily && daily.date));
}

function scheduleDailyReset() {
  try {
    if (window.chrome && chrome.alarms && chrome.alarms.create) {
      chrome.alarms.create(DAILY_RESET_ALARM, { when: nextDailyResetEpoch() });
    }
  } catch (e) { /* alarms 不可用时退化为普通跨天 lazy 重置 */ }
}

let _dailyResetAlarmRegistered = false;
function registerDailyResetAlarmListener() {
  if (_dailyResetAlarmRegistered) return;
  _dailyResetAlarmRegistered = true;
  try {
    if (window.chrome && chrome.alarms && chrome.alarms.onAlarm) {
      chrome.alarms.onAlarm.addListener((alarm) => {
        if (!alarm || alarm.name !== DAILY_RESET_ALARM) return;
        resetDailyForNewDay().catch((e) => console.error('[Daily|dbg] 00:00 重置异常:', e));
        scheduleDailyReset(); // 重排明天
      });
    }
  } catch (e) { /* 忽略 */ }
}

// 【在线时长持续累计兜底】dailyTick 靠 setInterval 驱动，但 MV3 SW 深度休眠时 setInterval 会被挂起，
// 若没有每次的周期性唤醒（比如献祭改条件轮询、30s 状态刷新等唤醒源变少），dailyTick 会长时间不跑，
// 导致 daily_raw 的 activeSec 一直停在旧值 → 早上日报在线时长/杆数全 0。
// 用 chrome.alarms 每 1 分钟唤醒 SW 跑一次 dailyTick，脱离 setInterval，保证在线时长持续累计。
const DAILY_TICK_ALARM = 'daily-tick-every-minute';
const DAILY_ALARM_MIN = 1; // 1 分钟一次（累计精度 1 分钟足够，避免过度唤醒）
function scheduleDailyTickAlarm() {
  try {
    if (window.chrome && chrome.alarms && chrome.alarms.create) {
      // 同名 alarm 每次重排会覆盖旧的；periodInMinutes 让它是周期性重复，SW 休眠到点也能唤醒。
      chrome.alarms.create(DAILY_TICK_ALARM, { delayInMinutes: DAILY_ALARM_MIN, periodInMinutes: DAILY_ALARM_MIN });
    }
  } catch (e) { /* 忽略 */ }
}
let _dailyTickAlarmRegistered = false;
function registerDailyTickAlarmListener() {
  if (_dailyTickAlarmRegistered) return;
  _dailyTickAlarmRegistered = true;
  try {
    if (window.chrome && chrome.alarms && chrome.alarms.onAlarm) {
      chrome.alarms.onAlarm.addListener((alarm) => {
        if (!alarm || alarm.name !== DAILY_TICK_ALARM) return;
        // 到点唤醒：跑一次 dailyTick 累计在线/离线时长，并 lazy 跨天重置。
        dailyTick().catch((e) => console.error('[Daily|dbg] daily-tick alarm 异常:', e));
        ensureDaily().catch(() => {});
      });
    }
  } catch (e) { /* 忽略 */ }
}
// 节流版：sync 消息是 SW 最可靠的唤醒点（60s setInterval 在 MV3 休眠下不 tick）。
// 用它兜底驱动日报采集，最多每 ~55s 一次，避免每次 sync 都推桥刷屏。
let _dailyLastThrottleAt = 0;
let _dailyLastDbgAt = 0;
function dailyTickThrottled() {
  const now = Date.now();
  if (now - _dailyLastThrottleAt < pityIntervalMs()) return;
  _dailyLastThrottleAt = now;
  try { dailyTick(); } catch (e) { console.error('[Daily|dbg] sync 触发 dailyTick 异常:', e); }
  // 每 ~5 分钟打一条采集进度，便于确认 raw 在累积（否则桥日报会是 0）
  if (now - _dailyLastDbgAt >= 5 * 60 * 1000) {
    _dailyLastDbgAt = now;
    const d = daily || {};
    console.log('[Daily|dbg] 采集进度:', JSON.stringify({
      activeSec: d.activeSec || 0, offlineSec: d.offlineSec || 0,
      totalCasts: d.totalCasts || 0, netGold: d.dailyNetGold || 0,
      refill: (d.refillOk||0) + '/' + (d.refillNeeded||0),
      switch: (d.switchOk||0) + '/' + (d.switchTry||0),
      drops: (d.rareCatches || {}),
    }));
  }
}

// 自愈式 dailyTick 驱动：挂在 webRequest.onCompleted（游戏每杆 API 请求都会唤醒 SW 走到这里）。
// 它是比 content-script sync 消息 / setInterval / chrome.alarms 更可靠的唤醒源——
// 只要游戏在钓鱼（持续产生 reelax.cn/api/* 请求），SW 就一定会被 webRequest 唤起，
// 彻底绕开「SW 休眠后 dailyTick 不接续」的根因。
// 逻辑：平时复用 dailyTickThrottled 的 5 分钟节流；若发现 daily 已超过 10 分钟没更新
// （stall），则强制跑一次 dailyTick 自愈，哪怕未到节流窗口。
function dailyTickThrottledSelfHeal() {
  if (!m.enabled || !DAILY_REPORT_ENABLED) return;
  const now = Date.now();
  const d = daily;
  // 强自愈：daily 长时间没 tick（SW 曾休眠/该 tick 被跳过）→ 绕过节流补跑一次
  if (d && d.lastTickAt && (now - d.lastTickAt) > 10 * 60 * 1000) {
    try { dailyTick(); } catch (e) { console.error('[Daily|dbg] webRequest 强触发 dailyTick 异常:', e); }
    return;
  }
  dailyTickThrottled();
}

// ---------- 挂机日报：调度（2小时分析 + 7/15/23自定义统计 + webhook(默认关)） ----------
// 适配机器 12 小时重启：55004 桥重启后，扩展 monitor 也会随之重连并重新注册定时器。
const CUSTOM_STAT_HOURS = [7, 15, 23];   // 北京 7/15/23 点开自定义统计窗口
const CUSTOM_STAT_DURATION = 8;          // 每次开 8 小时
let customStatSchedEnabled = true;       // 强行停止开关：false 时主路径+兜底都不自动开（当前窗口 8h 到点自然结束）
const REPORT_TRIGGER_URL = 'http://127.0.0.1:55004/report/api/trigger';
const REPORT_DAILY_URL = 'http://127.0.0.1:55004/report/api/daily';
let reportSchedTimer = null;
let reportAnalysisTimer = null;

// 北京当前小时
function bjHour() { return new Date(Date.now() + 8 * 3600 * 1000).getUTCHours(); }
function bjDate() { const d = new Date(Date.now() + 8 * 3600 * 1000); const p=(n)=>String(n).padStart(2,'0'); return d.getUTCFullYear()+p(d.getUTCMonth()+1)+p(d.getUTCDate()); }

// 对齐 7/15/23 点 + 8小时：开窗口前做幂等检查（已有活跃窗口则跳过）。
// min > 30 保护：仅整点后 30 分钟内才允许开，避免重启/重连错位补开（过了 30 分就安静等下一个点）。
// 注意：本函数不负责「保证触发」，触发由两路驱动：
//   ① startCustomStatScheduler 的一次性 setTimeout（精确优化，失败无所谓）；
//   ② refreshCurrentStatus 的 30s 幂等兜底 ensureCustomStatIfDue（抗重连/抗漂移的主力，保证 7/15/23 真能开）。
// 两路都先查 active 窗口做幂等，重复触发不会多开。
// 开对比后冷却（分钟）：避免限流/已有 active 时被 30s 兜底 + 调度器反复重试打成风暴
let _customStatNextAllowAt = 0;
async function openCustomStatIfDue() {
  if (!customStatSchedEnabled) return;
  // 限流保护：距上次尝试不足 5 分钟直接跳过，静默等待冷却
  if (Date.now() < _customStatNextAllowAt) return;
  const now = new Date(Date.now() + 8 * 3600 * 1000);
  const h = now.getUTCHours();
  if (CUSTOM_STAT_HOURS.indexOf(h) === -1) return;
  if (now.getUTCMinutes() > 30) return;
  try {
    const hist = await ReelaxApi.customStatisticsHistory();
    const items = hist && hist.ok && hist.data && hist.data.items ? hist.data.items : [];
    const active = items.some((it) => it.status === 'active');
    if (active) {
      console.log('[Daily] 已有活跃自定义统计窗口，跳过自动开');
      _customStatNextAllowAt = Date.now() + 10 * 60 * 1000; // 已有 active：10 分钟后再看
      return;
    }
    const r = await ReelaxApi.customStatisticsStart(CUSTOM_STAT_DURATION);
    console.log('[Daily] 自动开启自定义统计窗口:', CUSTOM_STAT_DURATION + 'h', r && (r.ok ? 'ok' : r.body));
    // 无论成功与否都进入冷却，避免同一窗口内重复打 start（尤其 RATE_LIMITED）
    _customStatNextAllowAt = Date.now() + 10 * 60 * 1000;
  } catch (e) {
    console.warn('[Daily] 自动开自定义统计失败:', e);
    _customStatNextAllowAt = Date.now() + 5 * 60 * 1000;
  }
}

// 幂等兜底：挂到已有 30s 状态刷新里（不新增任何轮询）。
// 纯本地时间判断：仅当北京小时∈{7,15,23} 且分钟≤30 时才发 history 请求，其余时间零请求零开销。
// 这是「7/15/23 真能开」的主力保障：环境频繁重启/重连时，一次性 setTimeout 可能被 clearTimeout 取消或
// 因 nextCustomStatDelayMs 的「find(p>curMin)」逻辑跳过今天的点；而本兜底只要进程在整点 0~30 分内活着就必开。
async function ensureCustomStatIfDue() {
  await openCustomStatIfDue();
}

// 计算距下一个开窗点（7/15/23 点，北京）的毫秒延迟，用于一次定时触发（非轮询）。
// 修复旧逻辑「find(p > curMin)」会在整点后误跳到明天的 bug：
//   若当前落在某点的 [00,30] 分窗口内，排到「今天这个点」（补开）；否则排到下一个严格未来的点。
function nextCustomStatDelayMs() {
  const bj = new Date(Date.now() + 8 * 3600 * 1000);
  const curMin = bj.getUTCHours() * 60 + bj.getUTCMinutes();
  const points = CUSTOM_STAT_HOURS.map((h) => h * 60); // [420, 900, 1380]
  // 找「严格大于当前」的下一个点（正常的未来点）
  let future = points.find((p) => p > curMin);
  if (future === undefined) future = points[0] + 1440; // 今天都过了 → 明天第一个点
  // 若当前落在某点的 [00,30] 分窗口内，优先排到「今天这个点」（补开）
  const inWindow = points.find((p) => curMin >= p && curMin <= p + 30);
  let target = (inWindow !== undefined) ? inWindow : future;
  // 修复：负延迟会让 setTimeout 立即触发而疯狂重试（打在限流/active 上造成风暴）。
  // 一旦目标点已不再严格未来（如在窗口内已尝试过、或恰好整点），就顺延到真正的未来点，
  // 并保证至少 5 分钟后再试，既不错过当日窗口、也绝不紧循环刷接口。
  const rawDelay = (target - curMin) * 60 * 1000;
  if (rawDelay <= 60 * 1000) {
    // 距当前点不足 1 分钟（含已过）→ 取「严格未来」的那个点；若那也是已过/即将到，
    // 顺到下一天，保证正向大间隔。
    if (future > curMin + 10) target = future;
    else target = points[0] + 1440; // 明天第一个点
  }
  let finalDelay = (target - curMin) * 60 * 1000;
  if (finalDelay < 5 * 60 * 1000) finalDelay = 5 * 60 * 1000; // 至少 5 分钟后
  return finalDelay;
}

// 每 2 小时触发 55004 重新分析生成日报
async function triggerReportAnalysis() {
  try {
    const r = await fetch(REPORT_TRIGGER_URL, { method: 'POST', mode: 'no-cors' });
    console.log('[Daily] 已触发日报分析');
  } catch (e) { console.warn('[Daily] 触发日报分析失败:', e); }
}

// 日报 webhook 推送：由选项页开关 dailyReportWebhook + 指定北京时间（dailyReportTimes，逗号分隔 HH:MM）驱动。
// 到点（分钟完全匹配）且该「日期|时间」尚未推过，拉取日报文本并 sendWebhook；次日自动重置去重。
let _reportWebhookPushed = {};  // 去重键：date|HH:MM

// 解析 dailyReportTimes（支持 "09:30"、"09:30,18:30"；空/非法忽略），返回 HH:MM 集合
function parseDailyReportTimes() {
  const out = new Set();
  const src = String(m.dailyReportTimes || '').trim();
  if (!src) return out;
  src.split(/[,，;；]+/).forEach((t) => {
    const s = String(t).trim();
    const mm = s.match(/^(\d{1,2}):(\d{2})$/);
    if (!mm) return;
    const h = Number(mm[1]), mi = Number(mm[2]);
    if (h >= 0 && h <= 23 && mi >= 0 && mi <= 59) out.add((h < 10 ? '0' : '') + h + ':' + (mi < 10 ? '0' : '') + mi);
  });
  return out;
}

function bjHM() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return d.getUTCHours().toString().padStart(2, '0') + ':' + d.getUTCMinutes().toString().padStart(2, '0');
}

async function maybePushDailyWebhook() {
  const dbg = { t: Date.now(), sw: m.dailyReportWebhook, times: Array.from(parseDailyReportTimes()), bj: bjHM() };
  if (!m.dailyReportWebhook) { console.log('[Daily|dbg] 跳过：dailyReportWebhook 未开启 =', dbg); return; }
  const times = parseDailyReportTimes();
  if (times.size === 0) { console.warn('[Daily|dbg] 未命中：无有效时间配置 =', dbg); return; }
  const hm = bjHM();
  if (!times.has(hm)) { console.log('[Daily|dbg] 未命中当前分钟（检查是否整分匹配）=', dbg); return; }
  const key = bjDate() + '|' + hm;
  if (_reportWebhookPushed[key]) { console.log('[Daily|dbg] 该时间已推送/占位，去重跳过 key=', key); return; }
  _reportWebhookPushed[key] = true; // 先占位去重，避免重复拉取（失败不强推，下次同一时间点到才有机会）
  console.log('[Daily|dbg] 命中时间，开始拉取日报 key=', key);
  try {
    // 拉桥端日报前，先把 monitor 当前的「今日」档推给桥，避免桥读到的还是昨天的 old 档
    // （跨天后若 SW 一直没 tick，桥 daily_raw.json 会停留昨天 → 日报错配日期显示昨天数据）。
    try { await dailyWriteFile(); } catch (_e) {}
    // 【联动修复】推完当日 raw 后必须先触发重新生成 daily_report.json，再读 /report/api/daily：
    // /report/api/daily 只读「上次生成的」JSON，而生成只靠每 2 小时 /report/api/trigger；
    // 若不重新生成，这里会读到昨天基于 09-01 raw 生成的旧日报 → 在线时长显示昨天的值。
    // 触发端是同步(await asyncio.to_thread)的，POST 返回即代表已重新生成。
    try { await triggerReportAnalysis(); } catch (_e) {}
    const r = await fetch(REPORT_DAILY_URL, { cache: 'no-store' });
    const d = await r.json().catch(() => null);
    const txt = d && d.webhookText;
    if (txt) { console.log('[Daily|dbg] 拉到 webhookText，开始发送'); await sendWebhook(String(txt)); console.log('[Daily|dbg] 发送完成'); }
    else console.warn('[Daily|dbg] 55004 返回无 webhookText，跳过推送');
  } catch (e) {
    console.warn('[Daily|dbg] 拉取/发送失败:', e);
  }
}

// 每日 00:00（北京）后清理昨天的去重记录，避免内存累积
function pruneDailyWebhookDedup() {
  const today = bjDate();
  Object.keys(_reportWebhookPushed).forEach((k) => {
    if (!k.startsWith(today)) delete _reportWebhookPushed[k];
  });
}

let dailyWebhookTimer = null;
function startDailyWebhookScheduler() {
  if (dailyWebhookTimer) clearInterval(dailyWebhookTimer);
  // 无论开关状态都排闹钟：MV3 SW 休眠时 setInterval 不跑，只有 chrome.alarms 能到点唤醒。
  // maybePushDailyWebhook 内部会再校验开关/时间匹配，关着时闹钟触发只是空转。
  scheduleDailyReportAlarms();
  if (!m.dailyReportWebhook) {
    dailyWebhookTimer = null;
    console.log('[Daily|dbg] 调度器未启动（开关未开启）：', JSON.stringify({ sw: m.dailyReportWebhook, times: m.dailyReportTimes }));
    return;
  }
  pruneDailyWebhookDedup();
  console.log('[Daily|dbg] 日报 webhook 调度器已启动，每分钟检查。配置:', JSON.stringify({ times: m.dailyReportTimes, nowBJ: bjHM() }));
  dailyWebhookTimer = setInterval(async () => {
    try {
      console.log('[Daily|dbg] tick ...', Date.now());
      pruneDailyWebhookDedup();
      await maybePushDailyWebhook();
    } catch (e) {
      console.error('[Daily|dbg] 轮询回调异常:', e);
    }
  }, 60 * 1000);
}

function reconfigDailyWebhookScheduler() {
  startDailyWebhookScheduler();
}

// 日报 webhook 的 MV3 SW 休眠修复：setInterval(60s) 在 SW 打盹时不执行，到点(如 08:55)就错过。
// 改用 chrome.alarms 按配置的每个北京时刻定点排（每日重复），到点唤醒失神 SW 触发 maybePushDailyWebhook。
const DAILY_REPORT_ALARM_PREFIX = 'daily-report-';
let _dailyReportAlarmListenerRegistered = false;
let _dailyReportAlarmsSynced = false;
let _dailyReportAlarmSig = ''; // 已排闹钟的「时间配置签名」，配置没变就不重建（避免 storage 频繁变动刷闹钟）

// 下一个「北京 HH:MM」的绝对毫秒时间戳（已过则算明天）
function nextBeijingEpochForHM(hh, mm) {
  const bj = Date.now() + 8 * 3600 * 1000;
  const d = new Date(bj);
  let t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hh, mm, 0) - 8 * 3600 * 1000;
  if (t <= Date.now()) t += 24 * 3600 * 1000;
  return t;
}

function scheduleDailyReportAlarms() {
  try {
    if (!window.chrome || !chrome.alarms || !chrome.alarms.create) return;
    const times = parseDailyReportTimes();
    const sig = Array.from(times).sort().join(',');
    if (_dailyReportAlarmsSynced && sig === _dailyReportAlarmSig) return; // 配置没变，保持现有闹钟
    _dailyReportAlarmsSynced = true;
    _dailyReportAlarmSig = sig;
    // 配置变了：清掉旧的所有日报闹钟，再按最新配置重建
    if (chrome.alarms.clear) {
      chrome.alarms.getAll((list) => {
        (list || []).forEach((a) => {
          if (a && a.name && a.name.indexOf(DAILY_REPORT_ALARM_PREFIX) === 0) { chrome.alarms.clear(a.name); }
        });
      });
    }
    times.forEach((hm) => {
      const mm = hm.match(/^(\d{1,2}):(\d{2})$/);
      if (!mm) return;
      const epoch = nextBeijingEpochForHM(Number(mm[1]), Number(mm[2]));
      chrome.alarms.create(DAILY_REPORT_ALARM_PREFIX + hm, { when: epoch, periodInMinutes: 24 * 60 });
    });
    if (times.size) {
      console.log('[Daily|dbg] 已排日报 webhook 闹钟（每日重复）: ' + JSON.stringify(Array.from(times)));
    }
  } catch (e) { /* 忽略 */ }
}

function registerDailyReportAlarmListener() {
  if (_dailyReportAlarmListenerRegistered) return;
  _dailyReportAlarmListenerRegistered = true;
  try {
    if (window.chrome && chrome.alarms && chrome.alarms.onAlarm) {
      chrome.alarms.onAlarm.addListener((alarm) => {
        if (!alarm || !alarm.name || alarm.name.indexOf(DAILY_REPORT_ALARM_PREFIX) !== 0) return;
        // 到点唤醒：推送逻辑内部会再校验开关/时间匹配/去重，这里只管触发
        maybePushDailyWebhook().catch((e) => console.error('[Daily|dbg] 闹钟触发日报异常:', e));
      });
    }
  } catch (e) { /* 忽略 */ }
}

// 节流版：sync 消息非常频繁，用它兜底对时，但真正的检查+日志最多每 ~55s 一次，避免刷屏。
let _dailyWebhookLastCheck = 0;
function maybePushDailyWebhookThrottled() {
  const now = Date.now();
  if (now - _dailyWebhookLastCheck < 55 * 1000) return;
  _dailyWebhookLastCheck = now;
  maybePushDailyWebhook().catch((e) => console.error('[Daily|dbg] sync 触发日报检查异常:', e));
}

function startDailyReportScheduler() {
  if (reportSchedTimer) clearInterval(reportSchedTimer);
  if (reportAnalysisTimer) clearInterval(reportAnalysisTimer);
  // 自定义统计开窗不再用 5 分钟轮询：由 startCustomStatScheduler（一次性 setTimeout）+
  // refreshCurrentStatus 的 30s 幂等兜底（ensureCustomStatIfDue）保障，零空转轮询。
  triggerReportAnalysis();
  reportAnalysisTimer = setInterval(triggerReportAnalysis, 2 * 60 * 60 * 1000);
}

// 单独启用「自动开自定义统计」调度：一次性 setTimeout 精确触发（非轮询），作为精确优化路径；
// 真正「保证 7/15/23 能开」的主力是 refreshCurrentStatus 里的 30s 幂等兜底 ensureCustomStatIfDue（抗重连/抗漂移）。
// 重启/重连后重算延迟（本函数被启动链调用即自愈）；回调用 try/finally 保证无论成败都重排下一次。
let customStatSchedTimer = null;
function startCustomStatScheduler() {
  if (customStatSchedTimer) clearTimeout(customStatSchedTimer);
  if (!customStatSchedEnabled) return;
  const delay = nextCustomStatDelayMs();
  console.log('[Daily] 已启用自定义统计调度，下次开窗将在', Math.round(delay / 60000), '分钟后触发（7/15/23 点，兜底由30s状态刷新保障）');
  customStatSchedTimer = setTimeout(async () => {
    try { await openCustomStatIfDue(); }
    finally { startCustomStatScheduler(); } // 无论成败都重排下一次（重算绝对延迟，非累加，不漂移）
  }, delay);
}

// 强行停止：clearTimeout + 关标志，零资源占用；当前活跃窗口 8h 到点自然结束（官方无 stop 端点）。
function stopCustomStatScheduler() {
  if (customStatSchedTimer) { clearTimeout(customStatSchedTimer); customStatSchedTimer = null; }
  customStatSchedEnabled = false;
  console.log('[Daily] 已强行停止自定义统计自动调度（当前窗口如已开，8h 后自然结束）');
}

// 重新启用（配置热更新打开开关时调用）
function enableCustomStatScheduler() {
  customStatSchedEnabled = true;
  startCustomStatScheduler();
}

// ---------- UI 状态持久化（Chrome MV3 下 Service Worker 会休眠/重启） ----------
// 弹窗不再依赖 browser.runtime.getBackgroundPage() 拿内存态（SW 休眠后为空），
// 改为：①popup 主动发 reelax-ui-state 消息拉取；②后台定期把快照写入 storage.local 兜底。
const UI_STATE_KEY = 'reelax_ui_state';

function snapshotUiState() {
  // 深拷贝一份轻量快照，避免把大对象引用暴露给 storage（storage 仅接受可序列化数据）
  try {
    return JSON.parse(JSON.stringify({ monitor: m, bridge: window.__bridgeStatus || null }));
  } catch (e) {
    return null;
  }
}

// 生成剔除「高频易变时间戳」后的比较签名（单次序列化 + 正则归一，避免二次序列化大对象徒增 CPU）。
// 只作「是否该写盘」的判定，不等于存储内容。命中不了的字段不碍事——顶多偶尔多写一次。
const UI_VOLATILE_NUM_KEYS = ['savedAt', 'lastActivityAt', 'lastPityError', 'lastSacrificeError',
  'lastRefUpdateAt', 'washedAt', 'restoredAt'];
function uiStateSignature() {
  try {
    let s = JSON.stringify({ monitor: m, bridge: window.__bridgeStatus || null });
    for (const k of UI_VOLATILE_NUM_KEYS) {
      // 数值型易变字段：`"key":<数字>` → 归零，使不同时刻的纯时间戳变化不产生“伪变化”
      s = s.replace(new RegExp('"' + k + '":[-0-9.]+', 'g'), '"' + k + '":0');
    }
    return s;
  } catch (e) { return null; }
}

let _uiPrevSig = null;
let _uiLastWriteAt = 0;
const UI_SYNC_INTERVAL_MS = 5000; // 写盘最小间隔：状态变化时也限制每 5s 至多写一次，压制 SW 持续写盘
function persistUiState() {
  const snap = snapshotUiState();
  if (!snap) return;
  const now = Date.now();
  try {
    const sig = uiStateSignature();
    // 剔除易变时间戳后状态未变 → 跳过（静态时几乎不写盘）；
    // 状态变了但距上次 <最小间隔 → 本次先不写，下一 tick 再落（限流到每 5s 一次）。
    if (sig == null || sig === _uiPrevSig) return;
    if ((now - _uiLastWriteAt) < UI_SYNC_INTERVAL_MS) return;
    _uiPrevSig = sig;
    snap.savedAt = now;
    _uiLastWriteAt = now;
    chrome.storage.local.set({ [UI_STATE_KEY]: snap }).catch(function () {});
  } catch (e) { /* 忽略 */ }
}

function startUiStateSync() {
  // 仅在状态实质变化时写快照（剔除易变时间戳后），SW 休眠期间 popup 仍可从 storage 读
  const t = setInterval(persistUiState, 2000);
  try { t.unref && t.unref(); } catch (e) {}
  // popup 主动拉取（SW 存活时最实时）
  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (msg && msg.type === 'reelax-ui-state') {
      sendResponse(snapshotUiState());
      return true; // 异步响应
    }
  });
}

monitorStart();
startUiStateSync();

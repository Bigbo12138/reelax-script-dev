// ==UserScript==
// @name         奥术摸鱼大师聚合
// @namespace    reelax-copilot
// @version      2.10.0
// @description  自动切换钓鱼地图 + 杆数自动补满：使用游戏内置API(window.arcaneReelax)从内存缓存读取数据，大幅减少HTTP请求；可配置优先级(赛事>跟船>雷暴>优选)，优选=经验60%+金币40%统一评分(地图编号越大金币越高，金风天气金币权重额外+20%)；船长/舵手自动开船到最优图(船员仅跟随)；杆数低于批次一半时调用游戏内 refill() 自动补满；按地图类型(赛事/雷暴/优选)自动选择鱼饵；未加入公会时不跳转公会赛事地图；离线结算弹窗自动点击去钓鱼或关闭；切换地图走游戏内UI不刷新页面，切鱼饵不刷新页面，切换后自动回到钓鱼界面(失败自动回退刷新)
// @author       valetzx
// @match        https://reelax.cn/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // 主世界防重复注入：同一文档只初始化一次。
  // 扩展热重载会重新执行内容脚本并再次注入本脚本，若无此守卫，
  // 面板/定时器会被反复创建，右下角越堆越多。
  if (window.__REELAX_AGG_INJECTED__) return;
  window.__REELAX_AGG_INJECTED__ = true;

  // ==================== 配置 ====================
  const CONFIG = {
    pollInterval: 30000,       // 默认检查间隔(毫秒)
    frontendVersion: '0.17.2', // 启动时会从 /api/meta/frontend-release 动态刷新
    maxLogEntries: 5,          // 最大日志条数
    weatherTimeout: 8000,      // 单个天气请求超时
    refillLockTime: 10000,     // 补满后锁定时间(毫秒)
    rodCheckInterval: 1000,    // 杆数元素未找到时的重试间隔
    rodThrottleMs: 30000,      // DOM兜底补杆检查最小间隔(毫秒)：服务端精确调度为主，兜底拉长避免频繁触发
    refillRetryMs: 5000,       // 补杆失败重试间隔(毫秒)
    refillSyncPaddingMs: 2000, // 补杆时刻提前量(毫秒)，容客户端/服务端时钟偏差
    travelRetryMs: 30000,      // 切图/开船同一目标重试冷却(毫秒)
  };

  // localStorage 持久化键名
  const STORAGE_KEY = 'reelax-auto-map-state';

  // 地图名称映射 (静态定义，用于B编号)
  const BIOME_NAMES = {
    'b_001': '\u6708\u843d\u6eaa\u8c37',
    'b_002': '\u96fe\u8bed\u6e7f\u5730',
    'b_003': '\u955c\u6f6e\u6d77\u5cb8',
    'b_004': '\u96f7\u75d5\u5ce1\u6e7e',
    'b_005': '\u661f\u6839\u6d1e\u7a9f',
    'b_006': '\u971e\u6816\u6e56\u539f',
    'b_007': '\u4e91\u6c50\u60ac\u6e56',
    'b_008': '\u8d64\u7802\u6d8c\u6cc9',
    'b_009': '\u6781\u663c\u51b0\u6e7e',
    'b_010': '\u6c89\u949f\u53e4\u6e2f',
    'b_011': '\u7fe1\u7fe0\u6d2a\u6797',
    'b_012': '\u7194\u6f6e\u73af\u7901',
    'b_013': '\u5929\u7a79\u9cb8\u6d77',
    'b_014': '\u65f6\u955c\u56de\u6d41',
    'b_015': '\u661f\u6e0a\u5723\u6d77',
  };

  // 天气静态定义 (从前端JS提取，xpMultiplier不在API响应中，需通过weatherId查找)
  const WEATHER_DEFS = {
    'clear':          { name: '晴朗',     xpMultiplier: 1.00 },
    'rain':           { name: '雨幕',     xpMultiplier: 1.05 },
    'gale':           { name: '强风',     xpMultiplier: 1.10 },
    'mist':           { name: '浓雾',     xpMultiplier: 1.20 },
    'heatwave':       { name: '热浪',     xpMultiplier: 1.30 },
    'tempest':        { name: '雷暴',     xpMultiplier: 1.50 },
    'wither_tide':    { name: '枯潮',     xpMultiplier: 0.50 },
    'gilded_current': { name: '金风',     xpMultiplier: 0.75, goldRangeBonus: [300, 500] },
    'arcane_surge':   { name: '奥术涌动', xpMultiplier: 1.75 },
  };

  // 天气鱼系数（对稀有度权重的净效应，相对晴朗，来自《聚合脚本寻路权重算法.md》表1）
  // 仅用于新优选评分：金币分 = 地图倍率 × 天气鱼系数
  const WEATHER_FISH_MULT = {
    'tempest': 1.20, 'heatwave': 1.10, 'mist': 1.08, 'rain': 1.05, 'gale': 1.03,
    'clear': 1.00, 'gilded_current': 0.98, 'wither_tide': 0.92,
  };
  // 新优选评分权重（文档校准：金币0.55/经验0.45）
  const W_GOLD_NEW = 0.55, W_EXP_NEW = 0.45;
  // 地图倍率（金币产出倍率）：线上实测为严格线性 1 + 0.05×序号（b_001=1.00 … b_015=1.70）。
  // 直接写死，不依赖 API 快照是否透传 valueMultiplier 字段，保证新旧两条数据路径行为一致。
  function getBiomeValueMultiplier(biomeId, biomes) {
    if (Array.isArray(biomes)) {
      const idx = biomes.findIndex(bi => bi.id === biomeId);
      if (idx >= 0) return 1 + 0.05 * (idx + 1);
    }
    // 兜底：从编号末两位数字推断（b_001 -> 1）
    const m = /^b_0*(\d+)$/.exec(biomeId || '');
    if (m) return 1 + 0.05 * parseInt(m[1], 10);
    return 1;
  }

  // 鱼饵静态定义 (从前端JS提取，tier→id映射)
  const BAIT_TIERS = [
    { id: 'bait_basic',   name: '基础饵', luck: 0,    desc: '无限' },
    { id: 'bait_low',     name: '低级饵', luck: 0,    desc: '40金币/个' },
    { id: 'bait_medium',  name: '中级饵', luck: 250,  desc: '100金币/个, 运气+250' },
    { id: 'bait_high',    name: '高级饵', luck: 500,  desc: '200金币/个, 运气+500' },
    { id: 'bait_supreme', name: '顶级饵', luck: 1000, desc: '1000金币/个, 运气+1000' },
  ];

  // ==================== 状态 ====================
  const state = {
    autoSwitch: true,
    isChecking: false,
    checkPending: false,   // 检查进行中收到事件时置位，检查结束立即补检（避免丢事件）
    minimized: false,
    showDetail: false,       // 地图列表默认折叠（只显示地图+综合分）
    showLog: true,
    logEntries: [],
    lastCheckTime: null,
    lastCheckStatus: null, // 'idle' | 'success' | 'error' | 'switched'
    currentBiomeId: null,
    bestBiomeId: null,
    bestReason: '',
    biomeDetails: [], // [{id, name, label, isUnlocked, isCurrent, hasCompetition, expBonus, breakdown}]
    pollInterval: CONFIG.pollInterval,
    errorMessage: null,
    iconPos: null, // 最小化图标位置 {left, top}
    autoRefill: true,       // 杆数自动补满开关
    autoDismissCompetition: true, // 赛事弹窗自动稍后处理(默认开启)
    autoCheckIn: true,         // 每日签到自动领取(默认开启)
    autoDismissOffline: true,  // 离线结算弹窗自动处理(默认开启)
    mapPriority: ['official', 'competition', 'followboat', 'optimal'], // 地图优先级(从高到低)：官方航线置顶(不参与选图时不生效) > 赛事 > 跟随船 > 新优选(倍率×天气鱼系数评分)；关闭useNewScoring时官方航线>赛事>跟随船>雷暴>优选(旧编号即金币评分)；可另排入 experience(经验优选)
    baitMap: {},              // 鱼饵配置 {priorityType: baitId}，key为'competition'/'tempest'/'optimal'，空=不自动切换
    currentBaitId: null,      // 当前已装备的鱼饵ID
    currentBaitType: null,    // 当前地图所属的优先级类型(用于鱼饵匹配)
    preGoldwindBaitId: null,  // 进入金风图前使用的鱼饵ID（离开金风时恢复用）
    inGoldwind: false,        // 是否处于金风地图（用于判断离开金风时恢复鱼饵）
    collapsedSections: { priority: false, bait: false }, // 可折叠区域状态
    activePage: 'status',     // 当前页面(仅内存)
    guildCompetitionSkipped: false, // 本次检查是否因未加入公会而跳过了公会赛事地图(仅内存)
    partyInfo: null,          // 组队船信息（快照 party，未组队为 null）
    lastPartyKey: '',         // 上次组队船状态 key（boatBiomeId|role），用于检测变化发webhook
    crewLowestLevel: null,  // 整船等级最低船员的等级（木桶上限：船最远只能开到该船员可解锁的最高图）；从 /api/party-boats/overview 的 crew.members 解析
    crewCount: 0,           // 当前船员数（overview crew.members 长度），0=未获取到/非在船
    boatWebhookSeeded: false, // 船webhook首查已播种（避免刷新页面后误发船状态）
    followBoatFallback: null, // 跟随船 fallback 原因（船过期/船图未解锁），无则 null（仅内存）
    autoSail: true,           // 船长/舵手自动开船总开关（默认开启，船员无效）
    excludeMasteryInSelect: true, // 优选选图时剔除地图专精点增益（默认开启）
    useNewScoring: true,       // 优选评分算法开关：true=新算法(倍率×天气鱼系数，0.55/0.45)；false=旧算法(编号即金币，0.6/0.4，含雷暴独立优先级)
    useOfficialRoute: false,   // 官方航线开关（默认关）：开启后把官方 routeAssistant.travel() 服务端推荐的目标图纳入选图优先级
    expPriorityIncludePartyBonus: true, // 经验优选是否计入船队加成（跟船才加成；仅对船队当前所在图计入，参与图间排序）
    expPriorityIncludeMapLevel: false,  // 经验优选是否计入「地图号位经验」可调倍率（无官方明确字段，默认关；开启后按地图号位乘一个可选倍率）
    expGreedyMode: false,       // 经验优选贪婪模式（默认关）：经验优选只看「专精×天气」选图，开增益最多1份；船也在该图时仍按原开增益模式
    officialRoute: null,       // 官方航线服务端规划缓存 { targetBiomeId, status, reason, executeAt, reevaluateAt, serverTime, fetchedAt }（仅内存）
    lastTravelAttempt: null,  // 同一目标切图/开船重试冷却 {biomeId, at}
    competitionCache: { personal: null, guild: null }, // 赛事总览缓存（拦截 /api/{guild-,}tournaments/overview 响应），用于精准归属选图
    gameApi: null,            // window.arcaneReelax API引用
    gameApiReady: false,      // API是否已就绪
    eventUnsubscribers: [],   // 事件取消订阅函数列表
    netFailStreak: 0,         // 连续网络层失败次数（达到阈值则刷新页面）
  };

  let pollTimer = null;
  let initialPollTimer = null; // 首次检查的随机延时定时器（stopPolling 一并清除，避免手动关闭后仍触发）
  let panelEl = null;
  let minimizedIconEl = null;
  let rodObserver = null;      // 杆数 MutationObserver
  let rodRetryTimer = null;    // 杆数元素未找到时的重试定时器
  let refillLocked = false;    // 补满后锁定状态
  let refillTimer = null;      // 服务端时间精确调度补杆的定时器
  let lastRodCheckTime = 0;    // DOM兜底补杆上次检查时间(节流用)
  let competitionObserver = null; // 赛事弹窗 MutationObserver
  let compLastCheck = 0;        // 赛事弹窗监控节流（对齐 offlineObserver，避免钓鱼页 DOM 高频变化时无节制回调）
  let checkInObserver = null;   // 每日签到弹窗 MutationObserver
  let checkInLastCheck = 0;     // 签到监控节流（同上）
  let checkInRetryTimer = null; // 签到领取重试定时器
  let offlineObserver = null;   // 离线结算弹窗 MutationObserver
  let biomes403Count = 0;       // /api/biomes 连续 403 计数（达 2 次刷新页面自愈）
  let biomes403Reloading = false; // 已触发刷新的标记，防止重复刷新

  // ==================== 状态持久化 ====================

  // ==================== 游戏API初始化 ====================

  // 等待游戏API就绪并订阅事件
  async function initGameApi() {
    try {
      console.log('[AutoMap] 等待游戏API就绪...');
      state.gameApi = window.arcaneReelax;
      if (!state.gameApi) {
        console.warn('[AutoMap] window.arcaneReelax 不存在，将使用API直调模式');
        return false;
      }

      // 等待初始快照
      await state.gameApi.ready;
      state.gameApiReady = true;
      console.log('[AutoMap] 游戏API已就绪，apiVersion:', state.gameApi.apiVersion);

      // 订阅天气变化事件
      const unsubWeather = state.gameApi.on('weather:changed', ({ biomeId, previous, current }) => {
        console.log(`[AutoMap] 天气变化: ${biomeId} ${previous?.name || '?'} -> ${current?.name || '?'}`);
        // 天气变化时触发检查（事件驱动，走快检 + 不丢事件）
        if (state.autoSwitch) requestCheck({ fast: true });
      });
      state.eventUnsubscribers.push(unsubWeather);

      // 订阅赛事开始事件
      const unsubCompetition = state.gameApi.on('competition:started', ({ biomeId, competition }) => {
        console.log(`[AutoMap] 赛事开始: ${biomeId} ${competition.kind} #${competition.sequence}`);
        // 赛事开始时触发检查（事件驱动，走快检 + 不丢事件）
        if (state.autoSwitch) requestCheck({ fast: true });
      });
      state.eventUnsubscribers.push(unsubCompetition);

      // 订阅公会增益开始事件
      const unsubGuildBoostStart = state.gameApi.on('guild-boost:started', ({ biomeId, current }) => {
        console.log(`[AutoMap] 公会增益开始: ${biomeId} 结束于 ${current.endsAt}`);
        if (state.autoSwitch) requestCheck({ fast: true });
      });
      state.eventUnsubscribers.push(unsubGuildBoostStart);

      // 订阅公会增益结束事件
      const unsubGuildBoostEnd = state.gameApi.on('guild-boost:ended', ({ biomeId }) => {
        console.log(`[AutoMap] 公会增益结束: ${biomeId}`);
        if (state.autoSwitch) requestCheck({ fast: true });
      });
      state.eventUnsubscribers.push(unsubGuildBoostEnd);

      log('游戏API已连接，使用内存缓存模式', 'success');
      return true;
    } catch (e) {
      console.error('[AutoMap] 游戏API初始化失败:', e);
      log(`游戏API初始化失败: ${e.message}`, 'error');
      return false;
    }
  }

  // 清理事件订阅
  function cleanupGameApiEvents() {
    for (const unsub of state.eventUnsubscribers) {
      try { unsub(); } catch (_) {}
    }
    state.eventUnsubscribers = [];
  }

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        autoSwitch: state.autoSwitch,
        pollInterval: state.pollInterval,
        minimized: state.minimized,
        iconPos: state.iconPos,
        autoRefill: state.autoRefill,
        autoDismissCompetition: state.autoDismissCompetition,
        autoCheckIn: state.autoCheckIn,
        mapPriority: state.mapPriority,
        baitMap: state.baitMap,
        collapsedSections: state.collapsedSections,
        autoSail: state.autoSail,
        excludeMasteryInSelect: state.excludeMasteryInSelect,
        useNewScoring: state.useNewScoring,
        useOfficialRoute: state.useOfficialRoute,
        expPriorityIncludePartyBonus: state.expPriorityIncludePartyBonus,
        expPriorityIncludeMapLevel: state.expPriorityIncludeMapLevel,
        expGreedyMode: state.expGreedyMode,
      }));
    } catch (_) { /* 忽略存储错误 */ }
  }

  function loadSavedState() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (!saved) return;
      const parsed = JSON.parse(saved);
      state.autoSwitch = parsed.autoSwitch !== false;
      state.pollInterval = parsed.pollInterval || CONFIG.pollInterval;
      state.minimized = !!parsed.minimized;
      state.iconPos = parsed.iconPos || null;
      state.autoRefill = !!parsed.autoRefill;
      state.autoDismissCompetition = parsed.autoDismissCompetition != null ? !!parsed.autoDismissCompetition : true;
      state.autoCheckIn = parsed.autoCheckIn != null ? !!parsed.autoCheckIn : true;
      // 迁移旧数据：确保mapPriority包含所有选项（赛事>跟船>雷暴>优选）
      // 【修复】完全尊重用户在 UI 里排定的顺序，不再强制置顶 official/competition/followboat。
      const allPriorityOptions = ['competition', 'followboat', 'official', 'tempest', 'optimal', 'experience'];
      if (Array.isArray(parsed.mapPriority)) {
        state.mapPriority = parsed.mapPriority.filter(p => allPriorityOptions.includes(p));
        // 补全缺失的选项(追加到末尾)
        for (const opt of allPriorityOptions) {
          if (!state.mapPriority.includes(opt)) {
            state.mapPriority.push(opt);
          }
        }
      }
      // 迁移旧数据：baitMap从per-biome改为per-priority-type
      if (parsed.baitMap && typeof parsed.baitMap === 'object') {
        const validTypes = ['competition', 'followboat', 'tempest', 'optimal', 'goldwind', 'arcane'];
        const oldKeys = Object.keys(parsed.baitMap);
        const hasOldBiomeKeys = oldKeys.some(k => k.startsWith('b_'));
        if (hasOldBiomeKeys) {
          // 旧格式(per-biome)，清空重新配置
          state.baitMap = {};
        } else {
          // 新格式(per-priority-type)或空对象
          state.baitMap = {};
          for (const k of oldKeys) {
            if (validTypes.includes(k)) state.baitMap[k] = parsed.baitMap[k];
          }
        }
      }
      state.collapsedSections = (parsed.collapsedSections && typeof parsed.collapsedSections === 'object')
        ? { priority: !!parsed.collapsedSections.priority, bait: !!parsed.collapsedSections.bait }
        : { priority: false, bait: false };
      state.autoSail = parsed.autoSail !== false;
      state.excludeMasteryInSelect = parsed.excludeMasteryInSelect !== false;
      state.useNewScoring = parsed.useNewScoring !== false;
      state.useOfficialRoute = parsed.useOfficialRoute === true; // 默认关（未保存过/历史数据视为关）
      state.expPriorityIncludePartyBonus = parsed.expPriorityIncludePartyBonus !== false;
      state.expPriorityIncludeMapLevel = parsed.expPriorityIncludeMapLevel === true;
      state.expGreedyMode = parsed.expGreedyMode === true;
      // 按当前算法归一化优先级链【修复：保留用户顺序，仅剔除当前算法不允许的类型、补足缺失】：
      // 新算法 -> 允许 赛事/跟船/官方/新优选（剔除 tempest）；旧算法 -> 额外允许 雷暴(tempest)。经验优选(experience)两种算法均可。
      // 不做任何强制置顶——优先级顺序完全以用户在 UI 中排列的为准。
      const fullChain = state.useNewScoring
        ? ['competition', 'followboat', 'official', 'optimal', 'experience']
        : ['competition', 'followboat', 'official', 'tempest', 'optimal', 'experience'];
      // 保留用户实际顺序，只去掉当前算法不允许的类型
      state.mapPriority = state.mapPriority.filter(p => fullChain.includes(p));
      // 补足当前算法允许但用户未保留的类型（追加到末尾，不影响已有顺序）
      for (const p of fullChain) {
        if (!state.mapPriority.includes(p)) state.mapPriority.push(p);
      }
    } catch (_) { /* 忽略解析错误 */ }
  }

  // ==================== API 辅助 ====================
  async function api(path, options = {}) {
    const headers = {
      'Accept': 'application/json',
      'x-frontend-version': CONFIG.frontendVersion,
    };
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    if (options.idempotent) {
      headers['Idempotency-Key'] = crypto.randomUUID();
    }

    const fetchOptions = {
      method: options.method || 'GET',
      headers,
      credentials: 'include',
    };
    if (options.body !== undefined) {
      fetchOptions.body = JSON.stringify(options.body);
    }

    console.log(`[AutoMap] API ${fetchOptions.method} ${path}`, options.body ? { body: options.body } : '');

    let response;
    try {
      response = await fetch(path, fetchOptions);
    } catch (e) {
      // 网络层失败（NetworkError / 超时 / 页面卸载中）：不打印堆栈噪音，只透传简明错误
      const err = new Error(`网络请求失败 ${path}: ${e.message}`);
      err.isNetworkError = true;
      throw err;
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      // /api/biomes 连续 403（签名/会话过期）达 2 次时刷新页面自愈
      if (path.includes('/api/biomes') && response.status === 403) {
        biomes403Count += 1;
        console.warn(`[AutoMap] /api/biomes 403 第 ${biomes403Count} 次:`, text.slice(0, 200));
        log(`/api/biomes 403 第 ${biomes403Count} 次`, 'warn');
        if (biomes403Count >= 2 && !biomes403Reloading) {
          biomes403Reloading = true;
          log('连续 403，跳转首页恢复会话', 'warn');
          // 落到站点首页（https://reelax.cn/）做整页冷启动，重建会话与签名
          setTimeout(() => {
            window.location.href = 'https://reelax.cn/';
          }, 500);
        }
      }
      console.error(`[AutoMap] API错误 ${path}: ${response.status}`, text.slice(0, 500));
      throw new Error(`API ${path} ${response.status}: ${text.slice(0, 200)}`);
    }

    const json = await response.json();
    // /api/biomes 成功即清零连续 403 计数
    if (path.includes('/api/biomes')) {
      biomes403Count = 0;
    }
    console.log(`[AutoMap] API响应 ${path}:`, json);
    return json;
  }

  // 带超时的API调用
  async function apiWithTimeout(path, options, timeoutMs) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs || 15000);
    try {
      const mergedOptions = { ...options, signal: controller.signal };
      return await api(path, mergedOptions);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // ==================== 赛事总览拦截（精准归属选图）====================
  // 包装 window.fetch，缓存游戏自身发起的 /api/tournaments/overview 与
  // /api/guild-tournaments/overview 响应。这样不额外发请求（游戏自己会拉），
  // 又能拿到官方赛事实体里的归属字段（assignedBiomeId / groups[myGroupId].biomeId），
  // 用于「两个赛事地图时精准去属于我们的那张」。思路对齐上游 1.8.0 的 competitionCache。
  let _compOverviewInstalled = false;
  function installCompetitionOverviewInterceptor() {
    if (_compOverviewInstalled) return;
    _compOverviewInstalled = true;
    const nativeFetch = window.fetch ? window.fetch.bind(window) : null;
    if (!nativeFetch) return;
    window.fetch = async function (input, init) {
      let resp;
      try {
        resp = await nativeFetch(input, init);
      } catch (e) {
        throw e; // 网络失败原样透传，不拦截
      }
      try {
        const url = (typeof input === 'string') ? input : (input && input.url) || '';
        if (url.includes('/api/tournaments/overview')) {
          const d = await resp.clone().json().catch(() => null);
          if (d) {
            state.competitionCache.personal = d;
            console.log('[AutoMap] 赛事总览已缓存(个人赛)');
          }
        } else if (url.includes('/api/guild-tournaments/overview')) {
          const d = await resp.clone().json().catch(() => null);
          if (d) {
            state.competitionCache.guild = d;
            console.log('[AutoMap] 赛事总览已缓存(公会赛)');
          }
        }
      } catch (_) { /* 解析失败不影响原响应 */ }
      return resp;
    };
  }

  // 从官方赛事实体解析「属于当前玩家的赛事地图」：
  //  1) 优先 assignedBiomeId（赛事分配地图）
  //  2) 否则取本玩家所属分组 groups[myGroupId||defaultGroupId].biomeId
  //  3) 兜底 c.biomeId
  function getCompetitionBiomeId(c) {
    if (!c) return null;
    if (c.assignedBiomeId) return c.assignedBiomeId;
    if (Array.isArray(c.groups) && c.groups.length) {
      const gid = c.myGroupId || c.defaultGroupId;
      const g = gid ? c.groups.find((x) => x.id === gid) : null;
      if (g && g.biomeId) return g.biomeId;
      // 无本组信息时回退到首个分组的 biomeId
      if (c.groups[0] && c.groups[0].biomeId) return c.groups[0].biomeId;
    }
    return c.biomeId || null;
  }

  // 从缓存的赛事总览里挑「已报名且正在进行」的赛事，返回 {biomeId, kind} 列表。
  // 仅返回我们真正归属的赛事图，天然排除「别人公会的赛事 / 未报名的赛事」。
  function getActiveCompetitionTargets() {
    const now = Date.now();
    const out = [];
    const kinds = ['personal', 'guild'];
    for (const kind of kinds) {
      const cc = state.competitionCache[kind];
      if (!cc) continue;
      // 【比赛时间窗，对齐镜像】固定每日比赛时段：个人赛 10-11/15-16 点、公会赛 20-21 点（北京）。
      // 非该时段直接认定无进行中的本类赛事，避免缓存里「endAt 陈旧偏晚」的赛事实体在空档期被误判为进行中，
      // 从而在比赛图与经验最优图间反复横跳。
      if (!_bjInCompWindow(kind)) continue;
      const isReg = kind === 'personal'
        ? (c) => !!c.isRegistered
        : (c) => c.entryStatus === 'registered';
      const all = [cc.current, ...(cc.upcoming || [])].filter(Boolean);
      for (const c of all) {
        if (!isReg(c)) continue;
        const s = c.startAt ? Date.parse(c.startAt) : NaN;
        const e = c.endAt ? Date.parse(c.endAt) : NaN;
        // 进行中（开始前 5 分钟算预热，已报名即可前往）
        if (Number.isFinite(s) && Number.isFinite(e) && now >= s - 5 * 60 * 1000 && now <= e) {
          const biomeId = getCompetitionBiomeId(c);
          if (biomeId) out.push({ biomeId, kind, startAt: s });
        }
      }
    }
    out.sort((a, b) => a.startAt - b.startAt);
    return out;
  }

  // ---- 比赛时间窗（对齐镜像 COMP_SCHEDULE）----
  // 个人赛：每天 10:00-11:00(600-660min)、15:00-16:00(900-960min)
  // 公会赛：每天 20:00-21:00(1200-1260min)
  const COMP_SCHEDULE = { personal: [[600, 660], [900, 960]], guild: [[1200, 1260]] };
  function _bjNowMin() {
    const d = new Date(Date.now() + 8 * 3600 * 1e3);
    return d.getUTCHours() * 60 + d.getUTCMinutes();
  }
  function _bjInCompWindow(kind) {
    const min = _bjNowMin();
    return (COMP_SCHEDULE[kind] || []).some((w) => min >= w[0] - 5 && min < w[1]);
  }

  // 赛事总览主动补拉（方案A根因修复）
  // 背景：赛事识别依赖 state.competitionCache（fetch 拦截缓存）。若游戏不重新拉
  // /api/tournaments/overview（比赛进行中前端常不再发起），或页面/脚本重载把缓存清空，
  // 会让 getActiveCompetitionTargets 返回空 → pickCompetition 返回 null → 短路落到经验
  // → 在比赛图 b_011 与经验最优图间反复横跳。
  // 修复：选图前若发现某 kind 的缓存缺失（或没有「进行中」的已报名赛事），主动补拉一次
  // overview 刷新缓存，让赛事识别稳定。带节流避免每个检查周期都发请求。
  const COMP_OVERVIEW_REFRESH_MIN = 3 * 60 * 1000; // 每个 kind 补拉最小间隔 3 分钟
  const _compLastRefreshAt = { personal: 0, guild: 0 };

  // 判断某 kind 的赛事缓存是否「疑似缺/旧」——没有可用的进行中已报名赛事就算需补拉
  function _compCacheMaybeStale(kind) {
    const cc = state.competitionCache[kind];
    if (!cc) return true; // 缓存缺失
    const now = Date.now();
    const isReg = kind === 'personal'
      ? (c) => !!c.isRegistered
      : (c) => c.entryStatus === 'registered';
    const all = [cc.current, ...(cc.upcoming || [])].filter(Boolean);
    for (const c of all) {
      if (!isReg(c)) continue;
      const s = c.startAt ? Date.parse(c.startAt) : NaN;
      const e = c.endAt ? Date.parse(c.endAt) : NaN;
      if (Number.isFinite(s) && Number.isFinite(e) && now >= s - 5 * 60 * 1000 && now <= e) {
        return false; // 存在进行中的已报名赛事，缓存可用
      }
    }
    return true; // 没有进行中的赛事 → 可能缺拉（比赛漏识别），补拉确认
  }

  // 主动补拉一次赛事总览刷新缓存（带节流）；拉取失败静默保留旧缓存
  async function _refreshCompetitionCache(kind) {
    const now = Date.now();
    if (now - _compLastRefreshAt[kind] < COMP_OVERVIEW_REFRESH_MIN) return;
    _compLastRefreshAt[kind] = now;
    const path = kind === 'personal' ? '/api/tournaments/overview' : '/api/guild-tournaments/overview';
    try {
      const d = await signedGet(path, 12000);
      if (d && typeof d === 'object') {
        state.competitionCache[kind] = d;
        console.log('[AutoMap] 赛事总览主动补拉成功(' + kind + '):', { current: d.current && d.current.id, biome: getCompetitionBiomeId(d.current), upcoming: (d.upcoming || []).length });
      }
    } catch (e) {
      console.warn('[AutoMap] 赛事总览补拉失败(' + kind + '):', e && e.message ? e.message : e);
    }
  }

  // 选图前统一保证 personal+guild 两类赛事缓存尽量新鲜（有节流，不会每轮都拉）
  async function ensureCompetitionCacheFresh() {
    // 仅当赛事在优先级链里才需要补拉（无赛事优先级则不必）
    if (!Array.isArray(state.mapPriority) || !state.mapPriority.includes('competition')) return;
    const p = _compCacheMaybeStale('personal');
    const g = _compCacheMaybeStale('guild');
    if (p) await _refreshCompetitionCache('personal');
    if (g) await _refreshCompetitionCache('guild');
  }

  // 拉取真实前端版本号（免签白名单接口 /api/meta/frontend-release），
  // 回填 CONFIG.frontendVersion，避免写死的旧版本号(0.8.0)与线上脱节。
  // 接口返回 { latestVersion, release:{ version, ... } }，取 latestVersion 优先。
  async function refreshFrontendVersion() {
    try {
      const res = await fetch('/api/meta/frontend-release', {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
        credentials: 'include',
      });
      if (!res.ok) {
        console.warn(`[AutoMap] 获取前端版本失败 ${res.status}`);
        return;
      }
      const data = await res.json();
      const v = data && (data.latestVersion || (data.release && data.release.version));
      if (v && v !== CONFIG.frontendVersion) {
        console.log(`[AutoMap] 前端版本更新: ${CONFIG.frontendVersion} → ${v}`);
        CONFIG.frontendVersion = v;
      }
    } catch (e) {
      console.warn('[AutoMap] 获取前端版本异常:', e);
    }
  }

  // ---- 短时签名请求（/api/fishing/state 等需签名的只读接口）----
  // 签名规则（与 devtools/sign.js 一致）：
  //   proof 由 /api/me 响应头 x-arcane-request-proof 下发（会话级，免签端点）；
  //   待签明文 = "v1\n" + METHOD大写 + "\n" + path + "\n" + 毫秒时间戳 + "\n" + body
  //   签名     = base64url( HMAC-SHA256( key=proof, msg=待签明文 ) )
  //   请求头   = x-arcane-request-proof / x-arcane-request-timestamp / x-arcane-request-signature
  // 服务器要求用户脚本使用内置 API，但对少数必须 HTTP 直调的只读接口（如取
  // fishing/state 的 run.effects），带签名可绕过 403 REQUEST_SIGNATURE_INVALID。
  // 每次调用都会消耗会话共享频率预算，务必低频使用。

  let _signedProof = null;   // 会话级 proof 缓存（同一页面内复用）
  let _signedProofPromise = null; // 并发去重：同时多个请求只取一次 proof

  function _signedB64Url(u8) {
    let bin = '';
    for (const x of u8) bin += String.fromCharCode(x);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  // 从 /api/me 响应头拿 proof（免签端点，用于引导后续签名）
  async function _signedGetProof() {
    if (_signedProof) return _signedProof;
    if (_signedProofPromise) return _signedProofPromise;
    _signedProofPromise = (async () => {
      const meRes = await fetch('/api/me', {
        credentials: 'include',
        headers: { Accept: 'application/json' },
      });
      const proof = meRes.headers.get('x-arcane-request-proof');
      if (proof) _signedProof = proof;
      return proof;
    })().finally(() => { _signedProofPromise = null; });
    return _signedProofPromise;
  }

  function _signedResetProof() {
    _signedProof = null;
  }

  // 计算签名并返回三个请求头
  async function _signedSign(method, path, body) {
    const proof = await _signedGetProof();
    if (!proof) throw new Error('no-proof-from-/api/me');
    const ts = String(Date.now());
    const msg = ['v1', method.toUpperCase(), path, ts, body || ''].join('\n');
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(proof),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
    );
    const sigBuf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
    return {
      Accept: 'application/json',
      'x-arcane-request-proof': proof,
      'x-arcane-request-timestamp': ts,
      'x-arcane-request-signature': _signedB64Url(new Uint8Array(sigBuf)),
    };
  }

  // 签名后 GET，返回 JSON；403 REQUEST_SIGNATURE_INVALID 时自动重置 proof 重试一次
  async function signedGet(path, timeoutMs = 15000) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const attempt = async (retried) => {
        const sigHeaders = await _signedSign('GET', path, null);
        const res = await fetch(path, {
          method: 'GET',
          credentials: 'include',
          headers: sigHeaders,
          signal: controller.signal,
        });
        if (res.status === 403 && !retried) {
          const probe = await res.clone().text();
          if (/REQUEST_SIGNATURE_INVALID/.test(probe)) {
            _signedResetProof();
            return attempt(true);
          }
        }
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw new Error(`API ${path} ${res.status}: ${text.slice(0, 200)}`);
        }
        return await res.json();
      };
      return await attempt(false);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // ==================== 数据获取 ====================
  async function fetchAllData(fast) {
    console.log('[AutoMap] fetchAllData 开始...' + (fast ? '（快检模式）' : ''));

    // 优先使用游戏API（从内存缓存读取，零HTTP请求）
    if (state.gameApiReady && state.gameApi) {
      try {
        const snapshot = state.gameApi.getSnapshot();
        if (!snapshot) {
          throw new Error('游戏API快照为空，可能未登录或会话过期');
        }

        console.log('[AutoMap] 使用游戏API快照（零HTTP请求）');

        const biomes = snapshot.biomes || [];
        if (biomes.length === 0) {
          throw new Error('地图数据为空');
        }

        // 筛选已解锁的地图
        const unlockedBiomes = biomes.filter(b => b.isUnlocked);
        console.log('[AutoMap] 已解锁地图:', unlockedBiomes.map(b => `${b.id}(${b.name})`));

        if (unlockedBiomes.length === 0) {
          throw new Error('没有已解锁的地图');
        }

        // 构建天气Map（快照中每个biome已包含weather字段）
        const weatherMap = new Map();
        for (const biome of unlockedBiomes) {
          if (biome.weather) {
            weatherMap.set(biome.id, { weather: biome.weather });
          }
        }

        // 鱼饵：快照已包含全部鱼饵及选中状态（含 isSelected），无需额外 HTTP 请求
        const baitsList = snapshot.baits || [];
        const selectedBait = baitsList.find(b => b.isSelected);
        if (selectedBait) {
          state.currentBaitId = selectedBait.id;
        }
        console.log('[AutoMap] currentBaitId:', state.currentBaitId);

        // 钓鱼批次与组队状态（快照自带，读取它们不会触发任何请求）
        const fishingState = snapshot.fishing || null;
        const party = snapshot.party || null;
        state.partyInfo = party;
        const serverTime = snapshot.serverTime || new Date().toISOString();

        // 公会图腾经验加成：快照的 fishing 是精简版（无 run.effects），补一次签名只读请求拿服务器算好的加成。
        // 失败不影响主流程（图腾加成缺失时按 0 处理，所有地图一致，不影响排序）。
        let guildTotemBasisPoints = null;
        // 全局经验加成 buff（万流共鸣等）与智力 stat：也来自 /api/fishing/state（快照精简版无 stats/activeBuffs），
        // 与公会图腾同源同上一次签名请求，解析失败按 0（全局，不影响地图间排序，只影响倍率显示）。
        let totalBuffBonus = 0;
        let intelStat = 0;
        // 快检模式（fast，事件驱动）跳过此 HTTP：图腾/buff/智力均为「全局或与地图无关」，
        // 不影响地图间排序，缺省按 0 不影响选对最优图（只短暂压低展示倍率，下次完整轮询即纠正）。
        if (!fast) {
          try {
            const st = await signedGet('/api/fishing/state', 15000);
            const effGuild = st && st.run && st.run.effects && st.run.effects.guild;
            if (effGuild && typeof effGuild.experienceBonusBasisPoints === 'number') {
              guildTotemBasisPoints = effGuild.experienceBonusBasisPoints;
            }
            if (Array.isArray(st && st.activeBuffs)) {
              totalBuffBonus = st.activeBuffs
                .filter(b => b && b.buffType === 'experience')
                .reduce((s, b) => s + (Number(b.bonusBasisPoints) || 0), 0);
            }
            const is = st && st.run && st.run.stats && st.run.stats.intelligence;
            if (typeof is === 'number') intelStat = is;
          } catch (_) { /* 忽略，图腾/全局buff/智力缺省按 0 */ }
        }

        // 船队加成（跟船才有）：从 /api/party-boats/overview 的 catalog 按本船艇型查 maximumPartyBonusBasisPoints。
        // 该加成仅作用于船队当前所在图（calcExpPriority 里再按 boatBiomeId 过滤），缺失按 0。
        // 限频 30s：船型固定、加成基准不变，只需保证船图新鲜即可。
        let partyBonusBasisPoints = 0;
        try {
          if (Date.now() - (state._pbCacheAt || 0) > 30000) {
            state._pbCacheAt = Date.now();
            const pb = typeof signedGet === 'function' ? await signedGet('/api/party-boats/overview', 10000) : null;
            const def = (pb && pb.party && pb.party.boatDefinitionId && pb.catalog || null)
              ? (pb.catalog.find(c => c.id === pb.party.boatDefinitionId) || null) : null;
            if (def && typeof def.maximumPartyBonusBasisPoints === 'number') {
              state._pbMaxPartyBonus = def.maximumPartyBonusBasisPoints;
            } else {
              state._pbMaxPartyBonus = 0;
            }
            // 木桶效应：整船最远可到 = 等级最低船员可解锁的最高图（requiredLevel 门槛）。
            // 与船队加成同一次 /api/party-boats/overview 响应解析（不额外发请求），缓存供贪婪模式选图过滤。
            if (pb && pb.crew && Array.isArray(pb.crew.members) && pb.crew.members.length > 0) {
              let lowest = Infinity;
              for (const m of pb.crew.members) {
                const lv = m && m.identity && typeof m.identity.level === 'number' ? m.identity.level : NaN;
                if (Number.isFinite(lv) && lv < lowest) lowest = lv;
              }
              state.crewLowestLevel = Number.isFinite(lowest) ? lowest : null;
              state.crewCount = pb.crew.members.length;
            } else {
              state.crewLowestLevel = null;
            }
          }
if (typeof state._pbMaxPartyBonus === 'number') partyBonusBasisPoints = state._pbMaxPartyBonus;
        } catch (_) { /* 加成缺失按 0 */ }

        return {
          biomes,
          unlockedBiomes,
          player: {},                                   // 快照不暴露玩家对象，保留兼容占位
          serverTime,
          fishingState,
          guild: null,                                  // 公会区域增益已内嵌在 biome.guildBoost
          guildTotemBasisPoints,
          mastery: null,                                // 地图专精已内嵌在 biome.masteryExperienceBonusBasisPoints
          weatherMap,
          totalBuffBonus,
          totalTalentBonus: 0,                          // 快照未暴露天赋，保持 0
          intelStat,
          baits: baitsList,
          party,
          partyBonusBasisPoints,
          crewLowestLevel: state.crewLowestLevel,
          crewCount: state.crewCount,
        };
      } catch (e) {
        console.warn('[AutoMap] 游戏API快照读取失败，回退到API直调:', e.message);
      }
    }

    // 回退模式：API直调（兼容旧版本或API不可用时）
    console.log('[AutoMap] 使用API直调模式');
    const [biomesRes, sessionRes, fishingState, guildRes, masteryRes, baitsRes, talentsRes] = await Promise.all([
      apiWithTimeout('/api/biomes', {}, 15000),
      apiWithTimeout('/api/me', {}, 15000).catch(e => { console.warn('[AutoMap] /api/me 失败:', e.message); return null; }),
      signedGet('/api/fishing/state', 15000).catch(e => { console.warn('[AutoMap] /api/fishing/state 失败:', e.message); return null; }),
      apiWithTimeout('/api/guilds/me', {}, 15000).catch(e => { console.warn('[AutoMap] /api/guilds/me 失败:', e.message); return null; }),
      apiWithTimeout('/api/mastery', {}, 15000).catch(e => { console.warn('[AutoMap] /api/mastery 失败:', e.message); return null; }),
      apiWithTimeout('/api/baits', {}, 15000).catch(e => { console.warn('[AutoMap] /api/baits 失败:', e.message); return null; }),
      apiWithTimeout('/api/mastery/talents', {}, 15000).catch(e => { console.warn('[AutoMap] /api/mastery/talents 失败:', e.message); return null; }),
    ]);

    const biomes = biomesRes?.biomes || [];
    if (biomes.length === 0) {
      throw new Error('地图数据为空，可能未登录或API返回异常');
    }

    const player = sessionRes?.player || sessionRes || {};
    const serverTime = biomesRes?.serverTime || sessionRes?.serverTime || new Date().toISOString();

    // 筛选已解锁的地图
    const unlockedBiomes = biomes.filter(b => b.isUnlocked);
    console.log('[AutoMap] 已解锁地图:', unlockedBiomes.map(b => `${b.id}(${b.name})`));

    if (unlockedBiomes.length === 0) {
      throw new Error('没有已解锁的地图');
    }

    // 并行获取每个已解锁地图的天气
    const weatherEntries = await Promise.all(
      unlockedBiomes.map(b =>
        apiWithTimeout(`/api/weather?biomeId=${encodeURIComponent(b.id)}`, {}, 15000)
          .then(w => ({ biomeId: b.id, weather: w }))
          .catch(() => ({ biomeId: b.id, weather: null }))
      )
    );
    const weatherMap = new Map(weatherEntries.map(e => [e.biomeId, e.weather]));

    // 活跃经验buff (全局)
    const activeExpBuffs = (fishingState?.activeBuffs || []).filter(b => b.buffType === 'experience');
    const totalBuffBonus = activeExpBuffs.reduce((sum, b) => sum + (b.bonusBasisPoints || 0), 0);

    // 天赋全局经验加成 (全局)
    const talentsList = talentsRes?.talents || [];
    const totalTalentBonus = talentsList.reduce((sum, t) => {
      if (t.effectKind === 'global_xp_basis_points') return sum + (t.currentEffect || 0);
      return sum;
    }, 0);

    // 获取当前鱼饵
    const baitsList = baitsRes?.baits || [];
    const selectedBait = baitsList.find(b => b.isSelected);
    if (selectedBait) {
      state.currentBaitId = selectedBait.id;
    }

    // 原始API直调模式不取组队信息，保持空
    state.partyInfo = null;

    return {
      biomes,
      unlockedBiomes,
      player,
      serverTime,
      fishingState,
      guild: guildRes,
      // 公会图腾加成（服务器算好的，含图腾等级）：fishing-state 的 run.effects.guild
      guildTotemBasisPoints: (fishingState && fishingState.run && fishingState.run.effects && fishingState.run.effects.guild
        && typeof fishingState.run.effects.guild.experienceBonusBasisPoints === 'number')
        ? fishingState.run.effects.guild.experienceBonusBasisPoints
        : null,
      mastery: masteryRes,
      weatherMap,
      totalBuffBonus,
      totalTalentBonus,
      intelStat: (fishingState && fishingState.run && fishingState.run.stats
        && typeof fishingState.run.stats.intelligence === 'number')
        ? fishingState.run.stats.intelligence
        : 0,
      baits: baitsList,
      // 船队加成（跟船才有）：fishing-state 的 lastResult.partyBonusBasisPoints；缺失按 0
      partyBonusBasisPoints: (fishingState && fishingState.lastResult
        && typeof fishingState.lastResult.partyBonusBasisPoints === 'number')
        ? fishingState.lastResult.partyBonusBasisPoints
        : 0,
      party: (fishingState && fishingState.party) || null,
    };
  }

  // ==================== 经验加成计算 ====================
  function calculateExpBonus(biome, data) {
    const breakdown = {
      weather: 0,
      guildTotem: 0,
      guildBoost: 0,
      mastery: 0,
      talents: 0,
      buffs: 0,
    };

    // 天气加成 (per-biome)
    // 天气API返回 {weather: {weatherId, name, effect, xpMultiplier, endsAt}, serverTime}
    // xpMultiplier不在API响应中，需通过weatherId从静态定义查找
    const weatherRes = data.weatherMap.get(biome.id);
    let weatherId = null;
    if (weatherRes) {
      // 兼容两种可能的响应结构
      if (weatherRes.weather && weatherRes.weather.id) {
        weatherId = weatherRes.weather.id;
      } else if (weatherRes.weather && weatherRes.weather.weatherId) {
        weatherId = weatherRes.weather.weatherId;
      } else if (weatherRes.weatherId) {
        weatherId = weatherRes.weatherId;
      } else if (weatherRes.weather && typeof weatherRes.weather.xpMultiplier === 'number') {
        // 如果API直接返回了xpMultiplier
        breakdown.weather = Math.round((weatherRes.weather.xpMultiplier - 1) * 10000);
      }
    }
    if (weatherId && WEATHER_DEFS[weatherId]) {
      breakdown.weather = Math.round((WEATHER_DEFS[weatherId].xpMultiplier - 1) * 10000);
    }

    // 公会图腾加成 (全局，所有地图相同)
    // 优先取 /api/fishing/state 的 run.effects.guild.experienceBonusBasisPoints（服务器已算好，含图腾等级）；
    // 兼容 {guild:{...}} 包装结构和扁平结构
    if (data.guildTotemBasisPoints != null) {
      breakdown.guildTotem = data.guildTotemBasisPoints;
    } else if (data.guild) {
      const guildObj = (data.guild.guild && typeof data.guild.guild === 'object') ? data.guild.guild : data.guild;
      breakdown.guildTotem = guildObj.experienceBonusBasisPoints || 0;
    }

    // 公会区域增益 (per-biome)
    // 快照格式: biome.guildBoost = {isActive, experienceBonusBasisPoints, endsAt}
    // API格式: biome.guildXpBonusBasisPoints + biome.guildBoostEndsAt
    if (biome.guildBoost && biome.guildBoost.endsAt && (biome.guildBoost.isActive || biome.guildBoost.active)) {
      breakdown.guildBoost = biome.guildBoost.experienceBonusBasisPoints ?? biome.guildBoost.xpBonusBasisPoints ?? 0;
    } else if (typeof biome.guildXpBonusBasisPoints === 'number' && biome.guildXpBonusBasisPoints > 0 && biome.guildBoostEndsAt) {
      breakdown.guildBoost = biome.guildXpBonusBasisPoints;
    }

    // 地图专精加成 (per-biome)
    // 快照格式: biome.masteryExperienceBonusBasisPoints
    // API格式: biome.masteryXpBonusBasisPoints，fallback 到 /api/mastery
    if (typeof biome.masteryExperienceBonusBasisPoints === 'number') {
      breakdown.mastery = biome.masteryExperienceBonusBasisPoints;
    } else if (typeof biome.masteryXpBonusBasisPoints === 'number') {
      breakdown.mastery = biome.masteryXpBonusBasisPoints;
    } else if (data.mastery && data.mastery.biomes) {
      const masteryBiome = data.mastery.biomes.find(m => m.biomeId === biome.id);
      if (masteryBiome) {
        breakdown.mastery = masteryBiome.xpBonusBasisPoints || 0;
      }
    }

    // 优选选图剔除专精点增益（默认开）：
    // 专精点是长期投入、会持续推高个别地图的经验评分，让「最优图」长期锁死在同一张图。
    // 剔除后选图只看天气/公会/天赋等临时可漂移加成，切图策略更稳定。
    if (state.excludeMasteryInSelect) {
      breakdown.mastery = 0;
    }

    // 天赋全局经验加成 (全局，所有地图相同)
    breakdown.talents = data.totalTalentBonus || 0;

    // 活跃经验buff (全局，所有地图相同)
    breakdown.buffs = data.totalBuffBonus;

    // 总经验加成 = 各乘区相乘（游戏实际经验为乘算），以基点返回。
    // 例如 天气+50%、公会增益+50% → (1.5 × 1.5 - 1) = +125%，而非加法的 +100%。
    // 全局项(图腾/天赋/buff)所有地图相同，不影响地图间排序。
    const total = Math.round(
      (
        (1 + breakdown.weather / 10000)
        * (1 + breakdown.guildTotem / 10000)
        * (1 + breakdown.guildBoost / 10000)
        * (1 + breakdown.mastery / 10000)
        * (1 + breakdown.talents / 10000)
        * (1 + breakdown.buffs / 10000)
        - 1
      ) * 10000
    );

    return { total, breakdown };
  }

  // ==================== 经验优选评分（experience 优先级专用） ====================
  // 参考 dip.js / 上游 calculateTotalExpBonus：纯经验乘算（不混金币）：
  //   天气 × 地图专精 × 公会区域 × 公会图腾 × buff/天赋 × 智力stat × 船队加成 × (可选)地图号位倍率
  // 区别于 calculateExpBonus(优选)：
  //   · 专精点不再被 excludeMasteryInSelect 剔除（用户明确要求经验优选取入地图专精）；
  //   · 额外计入船队加成 partyBonusBasisPoints（跟船才有；仅对船队当前所在图计入，从而参与图间排序）；
  //   · 可选按地图号位乘一个经验倍率（expPriorityIncludeMapLevel，默认关，因无官方明确字段）。
  //   · 贪婪模式(expGreedyMode)：只看「专精×天气」两项，忽略船加成/图腾/天赋/buff/智力/图序——选真正的
  //     基础最优图，避免船图因船加成虚高而与更好基础图抢选；开增益份数受控见 handleAutoBoost(greedy)。
  //     仅当本图天气「够开至少 1 份增益(剩余≥30分且可解析)」才用贪婪评分，否则退回下方完整评分。
  // 返回 { multiplier, total, breakdown }，multiplier=实际经验倍率(基点倍)，total=倍率表超出部分百分比。

  // 某图天气「是否够开至少 1 份增益」：与后台 computeAutoBoostUnits 对齐，
  // 剩余 ≥ 30 分钟（1 份=30min）且时间可解析才视为够开。贪婪评分仅对这种图生效；
  // 不足/未知则贪婪图开不出增益，退回原经验优选完整评分。
  function canOpenBoostUnit(endsAt) {
    const end = Date.parse(endsAt);
    if (!Number.isFinite(end)) return false;
    return (end - Date.now()) / 60000 >= 30;
  }

  function calculateExpPriority(biome, data) {
    const breakdown = { weather: 0, mastery: 0, guildBoost: 0, guildTotem: 0, talents: 0, buffs: 0, party: 0, mapLevel: 0, intel: 0 };

    // 天气 (per-biome)：由 weatherId 查静态表（与 calculateExpBonus 一致）
    const weatherRes = data.weatherMap && data.weatherMap.get(biome.id);
    let weatherId = null;
    let weatherEndsAt = null;
    if (weatherRes) {
      if (weatherRes.weather && weatherRes.weather.id) weatherId = weatherRes.weather.id;
      else if (weatherRes.weather && weatherRes.weather.weatherId) weatherId = weatherRes.weather.weatherId;
      else if (weatherRes.weatherId) weatherId = weatherRes.weatherId;
      if (weatherRes.weather && weatherRes.weather.endsAt) weatherEndsAt = weatherRes.weather.endsAt;
      else if (weatherRes.endsAt) weatherEndsAt = weatherRes.endsAt;
    }
    if (weatherId && WEATHER_DEFS[weatherId]) {
      breakdown.weather = Math.round((WEATHER_DEFS[weatherId].xpMultiplier - 1) * 10000);
    }

    // 地图专精 (per-biome)：经验优先始终计入专精（不随 excludeMasteryInSelect 剔除）
    if (typeof biome.masteryXpBonusBasisPoints === 'number') breakdown.mastery = biome.masteryXpBonusBasisPoints;
    else if (typeof biome.masteryExperienceBonusBasisPoints === 'number') breakdown.mastery = biome.masteryExperienceBonusBasisPoints;
    else if (data.mastery && data.mastery.biomes) {
      const mb = data.mastery.biomes.find(m => m.biomeId === biome.id);
      if (mb) breakdown.mastery = mb.xpBonusBasisPoints || 0;
    }

    // 贪婪模式（经验优选）：只看「专精×天气」两项，仅对本图天气够开至少1份增益(≥30分)的图生效，
    // 早退返回，忽略船加成/图腾/天赋/buff/智力/图序，避免船图高加成虚抬而与更好的基础图抢选。
    if (state.expGreedyMode && canOpenBoostUnit(weatherEndsAt)) {
      const greedyMultiplier = (1 + breakdown.weather / 10000) * (1 + breakdown.mastery / 10000);
      const total = Math.round((greedyMultiplier - 1) * 10000);
      return { multiplier: greedyMultiplier, total, breakdown, greedy: true };
    }

    // 公会区域增益 (per-biome)
    if (biome.guildBoost && biome.guildBoost.endsAt && (biome.guildBoost.isActive || biome.guildBoost.active)) {
      breakdown.guildBoost = biome.guildBoost.experienceBonusBasisPoints ?? biome.guildBoost.xpBonusBasisPoints ?? 0;
    } else if (typeof biome.guildXpBonusBasisPoints === 'number' && biome.guildXpBonusBasisPoints > 0 && biome.guildBoostEndsAt) {
      breakdown.guildBoost = biome.guildXpBonusBasisPoints;
    }

    // 公会图腾 (全局)
    if (data.guildTotemBasisPoints != null) breakdown.guildTotem = data.guildTotemBasisPoints;
    else if (data.guild) { const g = (data.guild.guild && typeof data.guild.guild === 'object') ? data.guild.guild : data.guild; breakdown.guildTotem = g.experienceBonusBasisPoints || 0; }

    // 天赋 / buff (全局)
    breakdown.talents = data.totalTalentBonus || 0;
    breakdown.buffs = data.totalBuffBonus || 0;

    // 智力 stat 经验加成 (全局)：fishing-state run.stats.intelligence 即「+智力的百分比基底×100」
    // （如 18860 = +188.60% → 乘区 1+188.60/100）。累乘为独立乘区，对所有地图相同、不改变选图排序，
    // 只让算出的经验倍率贴合游戏实际显示。
    let intelBase = (data && typeof data.intelStat === 'number' && data.intelStat > 0) ? data.intelStat : 0;
    if (!intelBase) {
      const fsStats = data && data.fishingState && data.fishingState.run && data.fishingState.run.stats;
      if (fsStats && typeof fsStats.intelligence === 'number') intelBase = fsStats.intelligence;
    }
    if (intelBase > 0) breakdown.intel = Math.round(intelBase);

    // 船队加成 (跟船才有)：仅对「船队当前所在图」计入 —— 人跟着船，船在哪个图该图才吃到 party 加成，
    // 从而真正拉开图间差异，让经验优选取更合算的船队所在图（如 b010 有船队加成、b008 无），
    // 而非像之前那样当作全局常量只抬人均总额、被基础倍率左右而漏选船队所在的高经验图。
    if (state.expPriorityIncludePartyBonus && data && typeof data.partyBonusBasisPoints === 'number' && data.partyBonusBasisPoints > 0) {
      const boatBiomeId = (data.party && data.party.boatBiomeId) || (state.partyInfo && state.partyInfo.boatBiomeId);
      if (boatBiomeId && boatBiomeId === biome.id) {
        breakdown.party = data.partyBonusBasisPoints;
      }
    }

    // 地图号位经验倍率（可选，默认关）：把 valueMultiplier 当经验倍率用（无官方明确经验字段，做成开关）
    if (state.expPriorityIncludeMapLevel) {
      breakdown.mapLevel = Math.round((getBiomeValueMultiplier(biome.id, (data && data.biomes)) - 1) * 10000);
    }

    // 乘算总倍率（基点倍）：multiplier 表示「最终经验 = 基础 × multiplier」
    const multiplier = (1 + breakdown.weather / 10000)
      * (1 + breakdown.mastery / 10000)
      * (1 + breakdown.guildBoost / 10000)
      * (1 + breakdown.guildTotem / 10000)
      * (1 + breakdown.talents / 10000)
      * (1 + breakdown.buffs / 10000)
      * (1 + breakdown.party / 10000)
      * (1 + breakdown.intel / 10000)
      * (1 + breakdown.mapLevel / 10000);
    const total = Math.round((multiplier - 1) * 10000);
    return { multiplier, total, breakdown };
  }

  // ==================== B编号获取 ====================
  function getBiomeLabel(biomeId, biomes) {
    const index = biomes.findIndex(b => b.id === biomeId);
    return index >= 0 ? `B${index + 1}` : 'B?';
  }

  function getBiomeName(biomeId) {
    return BIOME_NAMES[biomeId] || biomeId;
  }

  // ==================== 最优地图查找 ====================
  // 判断玩家是否已加入公会（兼容 {guild:{...}} 包装结构和扁平结构）
  function isGuildMember(data) {
    // 官方快照不直接暴露公会成员身份，用两个信号联合判断：
    //  1) 公会区域增益生效（guildBoost.active 仅对公会成员生效）；
    //  2) 某张已解锁地图上存在公会赛事（通常仅对公会成员展示）。
    // 任一命中即视为公会成员，避免无增益窗口期间误判导致公会赛事地图被跳过。
    const biomes = data.unlockedBiomes || data.biomes || [];
    const hasBoost = biomes.some(b => b.guildBoost && (b.guildBoost.isActive || b.guildBoost.active));
    const hasGuildComp = biomes.some(b =>
      (b.activeCompetitions || []).some(c => (c.type || c.kind) === 'guild')
    );
    return hasBoost || hasGuildComp;
  }

  function findBestBiome(data) {
    const { biomes, unlockedBiomes } = data;

    // 每次检查重置公会赛跳过标记（仅当检查到赛事优先级时才会被重新设置）
    state.guildCompetitionSkipped = false;

    // 赛事地图
    const competitionBiomes = unlockedBiomes.filter(b => b.activeCompetitions && b.activeCompetitions.length > 0);

    function pickCompetition() {
      if (competitionBiomes.length === 0) return null;

      // ---- 精准归属优先：用官方赛事总览缓存（已报名且进行中的赛事）----
      // 两个赛事地图同时存在时，优先去「属于我们（已报名/本公会分组）」的那张，
      // 而非盲目选编号靠后的。缓存缺失或未报名时回退到下方 activeCompetitions 兜底。
      const targets = getActiveCompetitionTargets();
      if (targets.length > 0) {
        // ---- 选图粘性（对齐镜像）：当前已在某张「进行中的赛事目标图」上，
        // 且该比赛仍有效，则保持不动 —— 避免刚切过去又因缓存抖动被带回经验最优图而反复横跳。----
        const curCompTarget = targets.find(t => t.biomeId === state.currentBiomeId);
        if (curCompTarget) {
          const biome = unlockedBiomes.find(b => b.id === curCompTarget.biomeId);
          if (biome) {
            const kindCn = curCompTarget.kind === 'guild' ? '\u516c\u4f1a\u8d5b' : '\u4e2a\u4eba\u8d5b';
            console.log('[AutoMap] 赛事图为当前图，粘性保持:', curCompTarget.biomeId, `(${kindCn})`);
            return {
              biome: biome,
              reason: `\u5f52\u5c5e${kindCn}\u5730\u56fe(${curCompTarget.biomeId})\uff08\u5df2\u5728\uff0c\u7c98\u6027\u4fdd\u6301\uff09`,
              priorityType: 'competition',
              expBonus: calculateExpBonus(biome, data),
            };
          }
        }
        for (const t of targets) {
          const biome = unlockedBiomes.find(b => b.id === t.biomeId);
          if (biome) {
            const kindCn = t.kind === 'guild' ? '\u516c\u4f1a\u8d5b' : '\u4e2a\u4eba\u8d5b';
            const reason = `\u5f52\u5c5e${kindCn}\u5730\u56fe(${t.biomeId})`;
            console.log('[AutoMap] 赛事精准归属命中:', reason);
            return {
              biome: biome,
              reason: reason,
              priorityType: 'competition',
              expBonus: calculateExpBonus(biome, data),
            };
          }
        }
        // 命中了赛事但目标图未解锁：不强行去（进不去），继续走兜底
        console.log('[AutoMap] 赛事精准归属目标未解锁，回退 activeCompetitions 兜底');
      }

      // ---- 兜底：基于快照 biomes[].activeCompetitions（兼容缓存缺失/未报名）----
      // 未加入公会时，跳过包含公会赛事的比赛地图（公会赛需要公会成员身份）
      let candidates = competitionBiomes;
      const member = isGuildMember(data);
      if (!member) {
        candidates = competitionBiomes.filter(b =>
          (b.activeCompetitions || []).every(c => (c.type || c.kind) !== 'guild')
        );
        state.guildCompetitionSkipped = candidates.length === 0;
        if (candidates.length === 0) return null;
      } else {
        state.guildCompetitionSkipped = false;
      }
      // 多个赛事地图时，选编号靠后的
      candidates.sort((a, b) => {
        const idxA = biomes.findIndex(bi => bi.id === a.id);
        const idxB = biomes.findIndex(bi => bi.id === b.id);
        return idxB - idxA; // 降序，编号靠后的优先
      });
      const best = candidates[0];
      const competitions = best.activeCompetitions;
      const kinds = competitions.map(c => c.type || c.kind).filter(Boolean);
      const kindStr = kinds.length > 0
        ? kinds.map(k => k === 'personal' ? '\u4e2a\u4eba\u8d5b' : '\u516c\u4f1a\u8d5b').join('/')
        : '\u8d5b\u4e8b';
      return {
        biome: best,
        reason: `${kindStr}\u5730\u56fe`,
        priorityType: 'competition',
        expBonus: calculateExpBonus(best, data),
      };
    }

    // 跟船：在组队船中时不主动换图，保持随船（目标=船的当前地图）
    function pickFollowBoat() {
      const party = data.party;
      if (!party || !party.isInParty) {
        state.followBoatFallback = null;
        return null; // 无船：继续下一优先级
      }

      // 船过期判定：租赁到期(rentalEndsAt) 或 保养逾期(maintenanceDueAt)
      // 过期后不再跟随，fallback 到后续优先级(雷暴/优选)
      const now = Date.now();
      const rentalExpired = party.rentalEndsAt && new Date(party.rentalEndsAt).getTime() <= now;
      const maintenanceDue = party.maintenanceDueAt && new Date(party.maintenanceDueAt).getTime() <= now;
      if (rentalExpired || maintenanceDue) {
        const reason = rentalExpired ? '船租赁已到期' : '船保养已逾期';
        if (state.followBoatFallback !== reason) log(`${reason}，不再跟随，fallback 到雷暴/优选`, 'info');
        state.followBoatFallback = reason;
        return null; // 继续循环到 tempest/optimal
      }

      // 船长/舵手自动开船判定：整船开往"忽略跟随船优先级"的最优图（判定与本人切图一致）
      const canSail = state.autoSail
        && (party.role === 'captain' || party.role === 'helmsman')
        && party.canChangeBoatBiome && party.status === 'active';
      if (canSail) {
        // 船长跟随本人当前图：本人图与船图不一致时，整船开往本人图（手动切图船立即跟随）
        const myBiome = (data.biomes || []).find(b => b.isCurrent);
        const myId = myBiome ? myBiome.id : null;
        if (myId && party.boatBiomeId && myId !== party.boatBiomeId) {
          const canEnter = (data.unlockedBiomes || []).some(b => b.id === myId);
          if (canEnter) {
            state.followBoatFallback = null;
            return {
              biome: myBiome,
              reason: '跟随船长',
              priorityType: getBiomePriorityType(myId, data) || 'optimal',
              expBonus: calculateExpBonus(myBiome, data),
              sail: true, // 标记：整船开往船长本人当前图
              role: party.role,
            };
          }
          // 本人图未解锁（理论上不会发生，isCurrent 必已解锁）→ 退回脚本最优
        }
        // 本人图已与船图一致（或无法跟随）→ 退回脚本算出的整船最优图
        const optimal = pickBestIgnoringBoat();
        if (!optimal) {
          state.followBoatFallback = null;
          return null; // 无匹配优先级，保持船现状
        }
        state.followBoatFallback = null;
        return {
          biome: optimal.biome,
          reason: optimal.reason,
          priorityType: optimal.priorityType,
          expBonus: optimal.expBonus,
          sail: true, // 标记：不个人换图，整船开往最优图
          role: party.role,
        };
      }

      let boatBiome = (data.biomes || []).find(b => b.id === party.boatBiomeId);
      if (!boatBiome) {
        // 船的当前地图未知，退回当前地图（同样不切换）
        boatBiome = (data.biomes || []).find(b => b.isCurrent) || null;
      }
      if (!boatBiome) {
        state.followBoatFallback = null;
        return null;
      }

      // 玩家自身未解锁该船图 → 进不去，fallback 到雷暴/优选
      const canEnter = (data.unlockedBiomes || []).some(b => b.id === boatBiome.id);
      if (!canEnter) {
        const reason = `船图[${getBiomeName(boatBiome.id)}]未解锁，进不去`;
        if (state.followBoatFallback !== reason) log(`${reason}，fallback 到雷暴/优选`, 'info');
        state.followBoatFallback = reason;
        return null;
      }

      state.followBoatFallback = null;

      // 计算「若不跟船时的最优图」，仅用于对比展示（不实际切换）
      const optimal = pickBestIgnoringBoat();
      // 符合「新优选(倍率×天气)」：只有船所在图 == 待开增益最优图时才值得开增益。
      // 最优图候选限制为「船能到达的范围」(≤ 船当前图的 requiredLevel)，不拿玩家个人可去
      // 的更高等级最优图（如玩家能去 b_015、但船最高只能去 b_014）来判定 —— 否则会把
      // 船可达范围内的真最优图误判成「非最优」而拒绝开增益。
      // 同时忽略「已有增益」：带增益的图经验分虚高、会永久锁死为最优，导致没有增益的
      // 图（如当前倍率最高的 b_014）反而永远开不出新增益。剔除后 b_014 才是最佳增益投放点。
      const newOpt = pickOptimal(
        typeof boatBiome.requiredLevel === 'number' ? boatBiome.requiredLevel : undefined,
        true
      );
      const boatIsOptimal = !!(newOpt && newOpt.biome && newOpt.biome.id === boatBiome.id);
      return {
        biome: boatBiome,
        reason: '\u8ddf\u968f\u8239',
        priorityType: getBiomePriorityType(boatBiome.id, data) || 'optimal',
        followBoat: true, // 标记：不执行换图，仅保持随船
        boostIfOptimal: boatIsOptimal, // 跟随船：仅当船图是新优选最优图才开增益
        expBonus: calculateExpBonus(boatBiome, data),
        optimalBiome: optimal ? optimal.biome : null,
        optimalExpBonus: optimal ? optimal.expBonus : null,
        optimalReason: optimal ? optimal.reason : null,
        rentalEndsAt: party.rentalEndsAt || null,
        maintenanceDueAt: party.maintenanceDueAt || null,
      };
    }

    // 通用天气pick函数：查找当前天气匹配的地图，多个时选编号靠后的（用于雷暴）
    function pickByWeather(weatherId, priorityType, reasonLabel) {
      const matchedBiomes = unlockedBiomes.filter(b => {
        const weatherRes = data.weatherMap.get(b.id);
        let wid = null;
        if (weatherRes) {
          if (weatherRes.weather && weatherRes.weather.id) {
            wid = weatherRes.weather.id;
          } else if (weatherRes.weather && weatherRes.weather.weatherId) {
            wid = weatherRes.weather.weatherId;
          } else if (weatherRes.weatherId) {
            wid = weatherRes.weatherId;
          }
        }
        return wid === weatherId;
      });
      if (matchedBiomes.length === 0) return null;
      // 多个匹配时，选编号靠后的
      matchedBiomes.sort((a, b) => {
        const idxA = biomes.findIndex(bi => bi.id === a.id);
        const idxB = biomes.findIndex(bi => bi.id === b.id);
        return idxB - idxA;
      });
      const best = matchedBiomes[0];
      return {
        biome: best,
        reason: reasonLabel,
        priorityType: priorityType,
        expBonus: calculateExpBonus(best, data),
      };
    }

    // 统一评分函数（优选）：根据 useNewScoring 切换新旧两版算法
    // 新算法(默认)：金币 = 地图倍率 × 天气鱼系数，经验/金币各归一化后按 0.55/0.45 加权（见《聚合脚本寻路权重算法.md》）
    // 旧算法：金币 = 地图编号越大越高（编号即金币），经验/金币按 0.6/0.4 加权，金风额外 +0.6
    function pickOptimal(maxRequiredLevel, ignoreExistingGuildBoost) {
      let __pool = unlockedBiomes;
      if (typeof maxRequiredLevel === 'number') {
        // 限制候选范围为「可达最高等级 ≤ 上限」的图（用于跟随船判定：只比较船能到达的地图，
        // 不拿玩家个人可去的更高等级图（如玩家能去 b_015 但船最高只能去 b_014）来比）。
        __pool = unlockedBiomes.filter(b => (typeof b.requiredLevel === 'number' ? b.requiredLevel : 0) <= maxRequiredLevel);
        if (__pool.length === 0) __pool = unlockedBiomes;
      }
      const candidates = __pool.map(b => {
        // 开增益的「最优图」判定可选忽略「已有增益」：
        // 若某图已带着增益参与评比，它经验分虚高、永远锁定为最优，反而让「还没有增益、
        // 但更值得现在开一份」的图永远轮不到。剔除已有增益后，最优 = 当前最值得开增益的图。
        const evalBiome = (ignoreExistingGuildBoost === true)
          ? (function () {
              const clone = Object.assign({}, b);
              const gb = (b.guildBoost && typeof b.guildBoost === 'object') ? Object.assign({}, b.guildBoost) : b.guildBoost;
              if (gb && typeof gb === 'object') { clone.guildBoost = Object.assign(gb, { isActive: false, active: false }); }
              clone.guildXpBonusBasisPoints = 0;
              clone.guildBoostEndsAt = null;
              return clone;
            })()
          : b;
        const expBonus = calculateExpBonus(evalBiome, data);
        const weatherRes = data.weatherMap.get(b.id);
        let weatherId = null;
        if (weatherRes) {
          if (weatherRes.weather && weatherRes.weather.id) {
            weatherId = weatherRes.weather.id;
          } else if (weatherRes.weather && weatherRes.weather.weatherId) {
            weatherId = weatherRes.weather.weatherId;
          } else if (weatherRes.weatherId) {
            weatherId = weatherRes.weatherId;
          }
        }
        return {
          biome: b,
          expBonus,
          weatherId,
          index: biomes.findIndex(bi => bi.id === b.id),
          // 地图倍率：直接写死（1 + 0.05×序号），不依赖 API 字段
          mult: getBiomeValueMultiplier(b.id, biomes),
        };
      });
      if (candidates.length === 0) return null;

      // 经验归一化：对称归一化到[-1,1]（除以绝对值最大），负天气(枯潮)也对称，不会无限放大
      const expVals = candidates.map(c => c.expBonus.total);
      const expAbsMax = Math.max(...expVals.map(v => Math.abs(v)), 1);

      let best = null;
      let bestScore = -1;
      if (state.useNewScoring) {
        // ---- 新算法：金币 = 倍率 × 天气鱼系数 ----
        const maxGold = Math.max(...candidates.map(c => c.mult * (WEATHER_FISH_MULT[c.weatherId] ?? 1)), 0.0001);
        for (const c of candidates) {
          const expScore = expAbsMax > 0 ? c.expBonus.total / expAbsMax : 1;
          const goldEff = c.mult * (WEATHER_FISH_MULT[c.weatherId] ?? 1);
          const goldScore = maxGold > 0 ? goldEff / maxGold : 0.5;
          const score = W_GOLD_NEW * goldScore + W_EXP_NEW * expScore;
          if (score > bestScore) {
            bestScore = score;
            best = { ...c, score, expScore, goldScore };
          }
        }
      } else {
        // ---- 旧算法：金币 = 编号即金币 + 金风额外加成 ----
        const maxIndex = biomes.length - 1;
        for (const c of candidates) {
          const expScore = expAbsMax > 0 ? c.expBonus.total / expAbsMax : 1;
          let goldScore = maxIndex > 0 ? c.index / maxIndex : 0.5;
          if (c.weatherId === 'gilded_current') {
            // 金风天气有金币加成（goldRangeBonus 300~500），额外加权重
            goldScore = Math.min(1, goldScore + 0.6);
          }
          const score = 0.6 * expScore + 0.4 * goldScore;
          if (score > bestScore) {
            bestScore = score;
            best = { ...c, score, expScore, goldScore };
          }
        }
      }
      return {
        biome: best.biome,
        reason: state.useNewScoring ? '新优选' : '优选',
        priorityType: 'optimal',
        expBonus: best.expBonus,
        score: best.score,
      };
    }

    // 经验优选：纯经验乘算排序（见 calculateExpPriority），只挑经验加成最大的已解锁图。
    // 返回结构与 pickOptimal 一致，priorityType='experience'。
    function pickExperience() {
      // 贪婪模式木桶范围：只看「整船船员都能到」的图。
      // 船上最远可到 = 等级最低船员能解锁的最高图（requiredLevel 门槛）。从中剔除更高门槛的图，
      // 避免贪婪选出一张船根本开不过去（如最低船员 6179 级、b_013 要 7250 级时不能选 b_013）。
      // 仅贪婪模式应用此过滤（正常经验优选仍按原逻辑，给非开船场景完整选择空间）。
      let candidates = (unlockedBiomes || []).map(b => ({
        biome: b,
        exp: calculateExpPriority(b, data),
        index: biomes.findIndex(bi => bi.id === b.id),
      }));
      if (state.expGreedyMode && typeof data.crewLowestLevel === 'number' && data.crewLowestLevel > 0) {
        const reachableCandidates = candidates.filter(c => {
          const rl = c.biome.requiredLevel;
          // 无 requiredLevel 字段（个别快照形态）时视为可达，不误伤
          return typeof rl !== 'number' || rl <= data.crewLowestLevel;
        });
        if (reachableCandidates.length > 0) {
          // 若过滤后任意图都不可达，回退到原始全集（该场景极少，避免选不出图）
          candidates = reachableCandidates;
        }
      }
      if (candidates.length === 0) return null;
      // 经验倍率降序；同分按地图编号升序（越靠前越早解锁/越基础，稳定不飘）
      const ranked = candidates.sort((a, b) =>
        (b.exp.multiplier - a.exp.multiplier) || (a.index - b.index));
      const best = ranked[0];
      return {
        biome: best.biome,
        reason: '经验优选',
        priorityType: 'experience',
        expBonus: { total: best.exp.total, breakdown: best.exp.breakdown },
        multiplier: best.exp.multiplier,
        greedy: best.exp.greedy === true, // 贪婪模式：只看专精×天气选出的图（供后台控开增益份数）
      };
    }

    // 官方航线：读 checkAndSwitch 里预取的 routeAssistant.travel() 服务端规划缓存。
    // 服务端返回 targetBiomeId 即官方推荐目标图；图未解锁或 status=no_target 时返回 null（继续下一优先级）。
    function pickOfficialRoute() {
      const plan = state.officialRoute;
      if (!plan || !plan.targetBiomeId) return null;
      const target = (data.unlockedBiomes || []).find(b => b.id === plan.targetBiomeId);
      if (!target) {
        console.log('[AutoMap] 官方航线目标图未解锁/不可达，跳过:', plan.targetBiomeId);
        return null;
      }
      const reason = plan.reason === 'competition' ? '官方·比赛'
        : plan.reason === 'golden' ? '官方·金风'
        : plan.reason === 'experience' ? '官方·经验' : '官方航线';
      return {
        biome: target,
        reason,
        priorityType: getBiomePriorityType(target.id, data) || 'optimal',
        expBonus: calculateExpBonus(target, data),
        official: true, // 标记：来自官方服务端规划
        officialPlan: plan,
      };
    }

    // 计算「若不跟船时的最优图」：复用完整优先级链，但跳过 followboat 自身。
    // 用于船长/舵手开船判定，以及跟随船时对比展示「船图 vs 最优图」的加成差。
    function pickBestIgnoringBoat() {
      for (const priority of state.mapPriority) {
        if (priority === 'followboat') continue; // 跳过跟船自身
        const result = pickByPriority(priority);
        if (result) return result;
      }
      return null;
    }

    // 按单一优先级类型决策（供主循环 / 忽略跟船复用）
    function pickByPriority(priority) {
      if (priority === 'competition') return pickCompetition();
      if (priority === 'followboat') return pickFollowBoat();
      if (priority === 'official') return state.useOfficialRoute ? pickOfficialRoute() : null;
      if (priority === 'tempest') return pickByWeather('tempest', 'tempest', '雷暴地图');
      if (priority === 'optimal') return pickOptimal();
      if (priority === 'experience') return pickExperience();
      return null;
    }

    // 遍历优先级链：
    // 新算法(useNewScoring) = 赛事 > 跟船 > 新优选（统一评分，tempest 已并入优选）
    // 旧算法            = 赛事 > 跟船 > 雷暴 > 优选（编号即金币评分）
    for (const priority of state.mapPriority) {
      const result = pickByPriority(priority);
      if (result) return result;
    }

    // 无匹配时返回null，不进行切换(不切换到兜底地图)
    return null;
  }

  // ==================== 地图切换 ====================
  async function switchBiome(biomeId) {
    console.log('[AutoMap] switchBiome: 切换到', biomeId);

    // 优先使用游戏API（复用前端换图逻辑，自动处理批次结算）
    if (state.gameApiReady && state.gameApi) {
      try {
        const result = await state.gameApi.biomes.travelTo(biomeId);
        console.log('[AutoMap] switchBiome 响应:', result);
        return result;
      } catch (e) {
        // TRAVEL_IN_PROGRESS 表示已有换图请求在处理中，等待后重试一次
        if (e.code === 'TRAVEL_IN_PROGRESS') {
          console.warn('[AutoMap] 换图请求冲突，等待1秒后重试');
          await sleep(1000);
          try {
            const result = await state.gameApi.biomes.travelTo(biomeId);
            console.log('[AutoMap] switchBiome 重试成功:', result);
            return result;
          } catch (e2) {
            console.error('[AutoMap] switchBiome 重试失败:', e2);
            throw e2;
          }
        }
        // NOT_READY 表示API未就绪，回退到直接API调用
        if (e.code === 'NOT_READY') {
          console.warn('[AutoMap] 游戏API未就绪，回退到直接API调用');
        } else {
          // 其他错误直接抛出
          throw e;
        }
      }
    }

    // 回退模式：直接API调用
    const result = await api('/api/player/current-biome', {
      method: 'PUT',
      body: { biomeId },
    });
    console.log('[AutoMap] switchBiome 响应:', result);
    return result;
  }

  // 开船（船长/舵手整船切图）：仅走游戏API party.travelTo。
  // party 数据只存在于游戏API快照，无 gameApi 时本就不该开船，故不做 HTTP 兜底。
  async function sailBoat(biomeId) {
    console.log('[AutoMap] sailBoat: 开船前往', biomeId);

    if (state.gameApiReady && state.gameApi && state.gameApi.party
        && typeof state.gameApi.party.travelTo === 'function') {
      try {
        const result = await state.gameApi.party.travelTo(biomeId);
        console.log('[AutoMap] sailBoat 响应:', result);
        return result;
      } catch (e) {
        // TRAVEL_IN_PROGRESS 表示已有请求在处理中，等待后重试一次
        if (e.code === 'TRAVEL_IN_PROGRESS') {
          console.warn('[AutoMap] 开船请求冲突，等待1秒后重试');
          await sleep(1000);
          try {
            const result = await state.gameApi.party.travelTo(biomeId);
            console.log('[AutoMap] sailBoat 重试成功:', result);
            return result;
          } catch (e2) {
            console.error('[AutoMap] sailBoat 重试失败:', e2);
            throw e2;
          }
        }
        throw e;
      }
    }

    throw new Error('party.travelTo 不可用（无游戏API）');
  }

  // 整船开船（船长/舵手）：封装开船逻辑，供「跟船优先级胜出」与「船长模式下脚本自动切图」复用。
  // 统一处理：已在目标图跳过 / 30秒重试冷却 / 先切鱼饵 / party.travelTo / 触发刷新 / webhook / 切后确认。
  async function executeSail(best, data, party) {
    const targetId = best.biome.id;
    if (party && party.boatBiomeId === targetId) {
      state.lastCheckStatus = 'success';
      updateStatusIndicator('success');
      console.log('[AutoMap] 船已在目标图:', targetId);
      log(`船已在目标图: ${getBiomeName(targetId)}（${best.reason}，经验 ${formatExpPct(best.expBonus.total)}）`, 'info');
      await checkAndSwitchBait(best.priorityType, data, false);
      return;
    }
    // 同一目标 30 秒重试冷却（防止事件高频触发反复开船）
    const retryAt = state.lastTravelAttempt && state.lastTravelAttempt.biomeId === targetId
      ? state.lastTravelAttempt.at : 0;
    if (retryAt && Date.now() - retryAt < CONFIG.travelRetryMs) {
      console.log('[AutoMap] 开船冷却中，跳过:', targetId);
      log(`开船冷却中（30秒内已尝试 ${getBiomeName(targetId)}），跳过`, 'info');
      state.lastCheckStatus = 'success';
      updateStatusIndicator('success');
      await checkAndSwitchBait(best.priorityType, data, false);
      return;
    }
    const fromName = party ? getBiomeName(party.boatBiomeId) : '?';
    const toLabel = getBiomeLabel(targetId, data.biomes);
    const toName = getBiomeName(targetId);
    log(`开船: [船]${fromName} → [${toLabel}]${toName} （${best.reason}，经验 ${formatExpPct(best.expBonus.total)}）`, 'action');
    console.log('[AutoMap] 执行开船:', fromName, '->', targetId);
    // 先切换鱼饵（API直调，服务器即时生效）
    await checkAndSwitchBait(best.priorityType, data, true);
    try {
      await sailBoat(targetId);
      state.lastTravelAttempt = { biomeId: targetId, at: Date.now() };
      log(`开船成功（party.travelTo，不刷新页面）`, 'success');
      // 触发前端重新拉取数据
      try { window.dispatchEvent(new Event('focus')); } catch (_) {}
      // 开船成功发送 webhook 通知
      sendWebhook(buildMapSwitchText(best));
      state.lastCheckStatus = 'switched';
      updateStatusIndicator('switched');
      // 切后确认：比对船当前图，不匹配则 webhook 告警
      verifyBiomeSwitch(targetId, 'party');
    } catch (e) {
      console.warn('[AutoMap] party.travelTo 失败:', e.message);
      log(`开船失败: ${e.message}`, 'error');
      state.lastCheckStatus = 'error';
      updateStatusIndicator('error');
    }
  }

  // 切图/开船后确认：延迟拉快照比对目标图，不匹配则 webhook 告警（不弹窗，不阻塞主流程）
  function verifyBiomeSwitch(targetId, mode) {
    setTimeout(async () => {
      try {
        const ok = await waitFor(() => {
          const s = state.gameApi && state.gameApiReady ? state.gameApi.getSnapshot() : null;
          if (!s) return false;
          return mode === 'party'
            ? (s.party && s.party.boatBiomeId === targetId)
            : (s.currentBiomeId === targetId);
        }, 6000, 500);
        if (ok) {
          console.log('[AutoMap] 切图确认成功:', targetId);
          return;
        }
        const s = state.gameApi && state.gameApiReady ? state.gameApi.getSnapshot() : null;
        const actual = mode === 'party'
          ? (s && s.party ? s.party.boatBiomeId : null)
          : (s ? s.currentBiomeId : null);
        const actualName = actual ? getBiomeName(actual) : '未知';
        log(`切图确认失败: 目标[${getBiomeName(targetId)}](${targetId}) 实际[${actualName}](${actual || '?'})`, 'warn');
        sendWebhook(`[Reelax] 切图异常：目标 ${getBiomeName(targetId)}(${targetId})，实际 ${actualName}(${actual || '?'})`);
      } catch (e) {
        console.warn('[AutoMap] 切图确认异常:', e);
      }
    }, 800);
  }

  // 简易延时
  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // 轮询等待条件满足，超时返回false
  function waitFor(cond, timeoutMs, intervalMs) {
    return new Promise(resolve => {
      const start = Date.now();
      const timer = setInterval(() => {
        if (cond()) {
          clearInterval(timer);
          resolve(true);
        } else if (Date.now() - start > timeoutMs) {
          clearInterval(timer);
          resolve(false);
        }
      }, intervalMs || 300);
    });
  }

  // 通过点击游戏内UI切换地图（前端mutation会自动更新缓存并跳回钓鱼页，无需刷新页面）
  // 返回true表示UI切换成功；false表示失败（调用方应回退到API切换+刷新）
  async function switchBiomeViaUI(biomeId) {
    const targetName = getBiomeName(biomeId);
    console.log('[AutoMap] switchBiomeViaUI: 尝试通过UI切换到', biomeId, targetName);

    // 1. 确保在地图页(/biomes)
    if (!location.pathname.startsWith('/biomes')) {
      const navLink = document.querySelector('a[href="/biomes"]');
      if (!navLink) {
        console.warn('[AutoMap] 未找到"切换地图"链接');
        return false;
      }
      navLink.click();
      const navOk = await waitFor(() => location.pathname.startsWith('/biomes'), 5000);
      if (!navOk) {
        console.warn('[AutoMap] 等待进入地图页超时');
        return false;
      }
    }

    // 2. 轮询等待目标地图卡片出现并点击切换按钮
    let clicked = false;
    for (let i = 0; i < 40; i++) { // 最长约12秒
      const cards = document.querySelectorAll('article.biome-card');
      for (const card of cards) {
        const h2 = card.querySelector('h2');
        if (!h2 || !h2.textContent.includes(targetName)) continue;
        // 普通图:"选择地图"(secondary-button)；赛事图:"前往比赛"(biome-competition-travel)
        const btn = card.querySelector('button.secondary-button, button.biome-competition-travel');
        if (btn && !btn.disabled) {
          btn.click();
          clicked = true;
          break;
        }
      }
      if (clicked) break;
      await sleep(300);
    }
    if (!clicked) {
      console.warn('[AutoMap] 未找到目标地图的切换按钮');
      return false;
    }
    console.log('[AutoMap] 已点击切换按钮，等待前端完成切换...');

    // 3. 等待前端完成切换并跳回钓鱼页(/fishing)
    const ok = await waitFor(() => location.pathname.startsWith('/fishing'), 15000);
    if (!ok) {
      console.warn('[AutoMap] 等待跳转钓鱼页超时');
      return false;
    }

    // 4. 触发前端重新拉取数据（refetchOnWindowFocus），同步最新状态（含脚本已切换的鱼饵）
    try { window.dispatchEvent(new Event('focus')); } catch (_) {}
    console.log('[AutoMap] 地图切换完成(UI方式)，无需刷新页面');
    return true;
  }

  // ==================== 鱼饵切换 ====================
  // 判断当前地图属于哪种优先级类型
  function getBiomePriorityType(biomeId, data) {
    const biome = data.unlockedBiomes.find(b => b.id === biomeId);
    if (!biome) return null;
    // 赛事地图
    if (biome.activeCompetitions && biome.activeCompetitions.length > 0) return 'competition';
    // 雷暴 单独优先
    const weatherRes = data.weatherMap.get(biomeId);
    let weatherId = null;
    if (weatherRes) {
      if (weatherRes.weather && weatherRes.weather.id) {
        weatherId = weatherRes.weather.id;
      } else if (weatherRes.weather && weatherRes.weather.weatherId) {
        weatherId = weatherRes.weather.weatherId;
      } else if (weatherRes.weatherId) {
        weatherId = weatherRes.weatherId;
      }
    }
    if (weatherId === 'tempest') return 'tempest';
    // 其余（含金风）统一为优选
    return 'optimal';
  }

  async function switchBait(baitId) {
    console.log('[AutoMap] switchBait: 切换到', baitId);
    // 优先使用官方 API：game.fishing.selectBait（复用 POST /api/baits/:baitId/equip 并更新前端缓存）
    if (state.gameApiReady && state.gameApi) {
      try {
        const didSelect = await state.gameApi.fishing.selectBait(baitId);
        console.log('[AutoMap] switchBait 响应:', didSelect);
        if (didSelect) state.currentBaitId = baitId;
        return didSelect;
      } catch (e) {
        // NOT_READY 等情况下回退到原始 HTTP（仍受服务端校验约束）
        if (e.code !== 'NOT_READY') {
          console.warn('[AutoMap] selectBait 失败，回退到 /api 直调:', e.message);
        }
      }
    }
    // 回退：官方 API 不可用时直接调用原始接口
    const result = await api(`/api/baits/${baitId}/equip`, { method: 'POST' });
    console.log('[AutoMap] switchBait 响应:', result);
    state.currentBaitId = baitId;
    return result;
  }

  // 获取鱼饵名称
  function getBaitName(baitId) {
    const tier = BAIT_TIERS.find(t => t.id === baitId);
    return tier ? tier.name : baitId;
  }

  // 检查并切换鱼饵（根据优先级类型配置）
  async function checkAndSwitchBait(priorityType, data, isAfterBiomeSwitch, targetBiomeId) {
    if (!priorityType) return false;
    // 金风/奥术涌流天气鱼饵切换：目标图天气为「金风(gilded_current)」→ 用 baitMap.goldwind、
    // 「奥术涌流(arcane_surge)」→ 用 baitMap.arcane；未配置对应饵则回退 original priority 配饵（行为不变）。
    const WEATHER_BAIT_TYPE = {
      'gilded_current': 'goldwind',
      'arcane_surge': 'arcane',
      'tempest': 'tempest',
    };
    let effectiveType = priorityType;
    if (targetBiomeId && data && data.weatherMap) {
      try {
        const tw = data.weatherMap.get(targetBiomeId);
        let twId = null;
        if (tw) {
          if (tw.weather && tw.weather.weatherId) twId = tw.weather.weatherId;
          else if (tw.weather && tw.weather.id) twId = tw.weather.id;
          else if (tw.weatherId) twId = tw.weatherId;
        }
        const wb = WEATHER_BAIT_TYPE[twId];
        if (wb && state.baitMap && state.baitMap[wb]) {
          effectiveType = wb;
        }
      } catch (_) {}
    }
    // 金风进出鱼饵逻辑：
    //  进入金风：记录进入前的鱼饵(preGoldwindBaitId)，再切到金风饵。
    //  离开金风：目标非金风 → 恢复进入金风前的鱼饵。
    if (effectiveType === 'goldwind') {
      if (!state.inGoldwind) {
        state.inGoldwind = true;
        state.preGoldwindBaitId = state.currentBaitId;
      }
    } else if (state.inGoldwind) {
      // 正离开金风：恢复进入金风前的鱼饵
      state.inGoldwind = false;
      const restoreBaitId = state.preGoldwindBaitId;
      state.preGoldwindBaitId = null;
      if (restoreBaitId && restoreBaitId !== state.currentBaitId) {
        console.log('[AutoMap] 离开金风，恢复鱼饵:', state.currentBaitId, '->', restoreBaitId);
        try {
          const didRestore = await switchBait(restoreBaitId);
          if (didRestore || state.currentBaitId === restoreBaitId) {
            log(`离开金风，恢复鱼饵: ${getBaitName(restoreBaitId)}`, 'action');
            try { window.dispatchEvent(new Event('focus')); } catch (_) {}
          }
        } catch (e) {
          console.error('[AutoMap] 恢复金风前鱼饵失败:', e);
          log(`恢复金风前鱼饵失败: ${e.message}`, 'error');
        }
        return true;
      }
      // preGoldwindBaitId 为空（如脚本启动时已在金风），回退到常规配饵逻辑
    }
    const configuredBaitId = state.baitMap[effectiveType];
    if (!configuredBaitId) return false; // 未配置鱼饵

    // 检查当前鱼饵是否已是目标
    if (state.currentBaitId === configuredBaitId) return false;

    console.log('[AutoMap] 鱼饵需要切换:', state.currentBaitId, '->', configuredBaitId);

    // 检查鱼饵是否有库存
    const baitData = data.baits?.find(b => b.id === configuredBaitId);
    if (baitData && !baitData.isUnlimited && (baitData.quantity ?? 0) <= 0) {
      log(`鱼饵 ${getBaitName(configuredBaitId)} 库存为0，跳过切换`, 'warn');
      return false;
    }

    try {
      await switchBait(configuredBaitId);
      const baitName = getBaitName(configuredBaitId);
      if (isAfterBiomeSwitch) {
        log(`鱼饵已切换: ${baitName}`, 'action');
      } else {
        log(`鱼饵已切换: ${baitName}（${PRIORITY_LABELS[priorityType] || priorityType}配置）`, 'action');
        // 不刷新页面：触发前端重新拉取数据(refetchOnWindowFocus)同步鱼饵显示
        try { window.dispatchEvent(new Event('focus')); } catch (_) {}
      }
      return true;
    } catch (e) {
      console.error('[AutoMap] 鱼饵切换失败:', e);
      log(`鱼饵切换失败: ${e.message}`, 'error');
      return false;
    }
  }

  // ==================== Webhook 通知 ====================
  // 通知统一由扩展 monitor.js 发送（webhook 配置在设置页），页面脚本只 postMessage 转发

  // 拼接切换通知文本：目标地图 / 赛事 / 天气 / 经验加成 / 当前鱼饵
  function buildMapSwitchText(best) {
    const biome = best.biome;
    const lines = [];

    lines.push('[Reelax] 自动切图');
    lines.push(`切换到地图: ${getBiomeName(biome.id)} (${biome.id})`);

    // 赛事（快照 biome.activeCompetitions）
    const comps = biome.activeCompetitions || [];
    lines.push('赛事: ' + (comps.length > 0
      ? comps.map(c => {
          const isGuild = (c.kind === 'guild' || c.type === 'guild');
          const seq = c.sequence != null ? `#${c.sequence}` : '';
          const name = c.name ? ` (${c.name})` : '';
          return `${isGuild ? '公会赛' : '个人赛'}${seq}${name}`;
        }).join('、')
      : '无'));

    // 天气（快照 weather.name，回退到静态定义）
    const weather = biome.weather;
    let weatherName = '未知';
    if (weather && weather.name) {
      weatherName = weather.name;
    } else if (weather && weather.id && WEATHER_DEFS[weather.id]) {
      weatherName = WEATHER_DEFS[weather.id].name;
    }
    lines.push(`天气: ${weatherName}`);

    // 经验加成（基点转百分比）
    lines.push(`经验加成: ${formatExpPct((best.expBonus && best.expBonus.total) || 0)}`);

    // 当前鱼饵（切鱼饵发生在切图之前，此时已是最新）
    const baitName = state.currentBaitId ? getBaitName(state.currentBaitId) : '未知';
    lines.push(`当前鱼饵: ${baitName}`);

    // 组队船信息（无船则不显示）
    if (state.partyInfo && state.partyInfo.isInParty) {
      const p = state.partyInfo;
      const roleName = p.role === 'captain' ? '船长' : (p.role === 'helmsman' ? '舵手' : '船员');
      lines.push(`组队船: ${p.boatName || '船'} · ${roleName} · ${getBiomeName(p.boatBiomeId)}`);
    }

    return lines.join('\n');
  }

  // 把 ISO/UTC 时间转成北京时间(UTC+8)显示，如 2026-08-07 18:00
  function formatCNTime(value) {
    if (!value) return '';
    const d = new Date(value);
    if (isNaN(d.getTime())) return String(value);
    try {
      return new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: false,
      }).format(d).replace(/\//g, '-');
    } catch (_) {
      // 兜底：UTC 手动加 8 小时换算
      const t = new Date(d.getTime() + 8 * 3600 * 1000);
      const pad = (n) => String(n).padStart(2, '0');
      return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())} ${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}`;
    }
  }

  // 组队船状态通知文本（仅在有船时调用）
  function buildBoatStatusText(party) {
    const roleName = party.role === 'captain' ? '船长' : (party.role === 'helmsman' ? '舵手' : '船员');
    const lines = [];
    lines.push('[Reelax] 组队船状态');
    lines.push(`船只: ${party.boatName || '未知'}`);
    lines.push(`身份: ${roleName}`);
    lines.push(`所在图: ${getBiomeName(party.boatBiomeId)} (${party.boatBiomeId})`);
    if (party.status) lines.push(`状态: ${party.status}`);
    if (party.rentalEndsAt) lines.push(`租期截止: ${formatCNTime(party.rentalEndsAt)}`);
    return lines.join('\n');
  }

  // 发送通知：转发给扩展统一发 webhook（webhook 配置在扩展设置页，页面无需关心）
  function sendWebhook(content) {
    if (!content) return;
    try {
      window.postMessage({ __reelaxWebhook: true, text: content }, '*');
    } catch (e) {
      console.error('[AutoMap] 通知发送失败:', e);
    }
  }

  // 通知扩展后台给「聚合选定的优选地图」开公会增益（只按选图/切图逻辑触发）。
  // 后台收到后仍会先检测目标地图是否已有未过期增益，有则不重复开，防止多开。
  // 去重：目标图变化立即通知；同一目标图距上次通知超过冷却才补通知（供后台补开已过期增益）。
  let lastBoostNotify = { biomeId: null, at: 0 };
  const BOOST_NOTIFY_COOLDOWN_MS = 5 * 60 * 1000; // 与后台开增益冷却一致，避免频繁上报
  function notifyPreferredBoost(best, data) {
    if (!best || !best.biome || !best.biome.id) return;
    const biomeId = best.biome.id;
    // 跟随船增益对齐新优选(倍率×天气)：仅当船所在图是新优选最优图才开增益；
    // 船停在普通图时不浪费增益（不通知后台）。
    // 例外：赛事地图恒开增益（赛事优先级必然高于优选/跟船，船图若是赛事图则直接开）。
    if (best.followBoat === true && best.priorityType !== 'competition' && best.boostIfOptimal !== true) {
      console.log('[AutoMap] 跟随船：船图[' + getBiomeName(biomeId) + ']非新优选最优，不开增益');
      return;
    }
    const now = Date.now();
    if (lastBoostNotify.biomeId === biomeId && now - lastBoostNotify.at < BOOST_NOTIFY_COOLDOWN_MS) return;
    // 取目标图天气（供后台判断是否奥秘/雷暴才开增益）
    // 天气结构兼容：快照={weather:{id}} / API={weatherId} 两种 weatherMap 形态
    let weatherEndsAt = null, weatherId = null;
    const w = data && data.weatherMap ? data.weatherMap.get(biomeId) : null;
    const we = (w && w.weather) || w || null; // 兼容 {weather:{...}} 和 裸天气对象
    if (we) {
      weatherEndsAt = we.endsAt || (w && w.endsAt) || null;
      weatherId = we.id || we.weatherId || (w && (w.id || w.weatherId)) || null;
    }
    if (!weatherId) console.warn('[AutoMap] notifyPreferredBoost 取天气失败: biomeId=', biomeId, 'w=', JSON.stringify(w));
    lastBoostNotify = { biomeId, at: now };
    // 贪婪模式标志：由选图结果带出（经验优选·只看专精×天气）。
    // 船是否就在本图：若船队当前所在图正是本图，则按原模式开增益（不受贪婪封顶限制）。
    const greedy = best.greedy === true;
    const boatOnMap = !!((data && data.party && data.party.boatBiomeId && data.party.boatBiomeId === biomeId)
      || (state.partyInfo && state.partyInfo.boatBiomeId === biomeId));
    try {
      window.postMessage({
        __reelaxAutoBoost: {
          type: 'preferred',
          biomeId,
          biomeName: best.biome.name || getBiomeName(biomeId),
          priorityType: best.priorityType || null,
          reason: best.reason || null,
          weatherEndsAt,
          weatherId,
          greedy,
          boatOnMap,
        },
      }, '*');
      log('已通知后台给优选图[' + getBiomeName(biomeId) + ']开增益', 'action');
    } catch (e) {
      console.warn('[AutoMap] 通知后台开增益失败:', e);
    }
  }

  // ==================== 天气最优切图（由后台「天气非最优」指令驱动） ====================
  // monitor.js 在经验优选开增益前校验目标图天气非最优时，会拦截并回发 __reelaxSwitchTo，
  // 让聚合把船/人切去「纯天气倍率最大·船可达最远」的图。此处仅负责执行切图，
  // 不重复计算天气最优图（后台已算好并随消息带出 biomeId）。
  async function handleBoostSwitchRequest(biomeId) {
    if (!biomeId) return;
    console.log('[AutoMap][boost-switch] 收到后台天气最优切图指令:', biomeId);
    // 主循环进行中时延后重试一次，避免与在途检查并发切图；仍忙则放弃（后台冷却5分钟后会再触发）
    if (state.isChecking) {
      await sleep(1500);
      if (state.isChecking) return;
    }
    try {
      const data = await fetchAllData(false);
      if (!data || !data.biomes) return;
      const target = (data.unlockedBiomes || data.biomes).find(b => b.id === biomeId);
      if (!target) {
        console.warn('[AutoMap][boost-switch] 目标图不可达/未解锁，忽略:', biomeId);
        return;
      }
      const party = data.party || state.partyInfo || null;
      const best = {
        biome: target,
        reason: '天气优先',
        priorityType: 'experience',
        expBonus: resultOfExperienceBest(target, data),
        greedy: false,
      };
      // 船长/舵手且可开船：整船跟随；否则个人切图
      const captainCanSail = state.autoSail && party && party.isInParty
        && (party.role === 'captain' || party.role === 'helmsman')
        && party.canChangeBoatBiome && party.status === 'active';
      if (captainCanSail) {
        await executeSail(best, data, party);
      } else {
        const retryAt = state.lastTravelAttempt && state.lastTravelAttempt.biomeId === biomeId
          ? state.lastTravelAttempt.at : 0;
        if (retryAt && Date.now() - retryAt < CONFIG.travelRetryMs) {
          console.log('[AutoMap][boost-switch] 切换冷却中，跳过:', biomeId);
          return;
        }
        await checkAndSwitchBait('experience', data, true, biomeId);
        try {
          await switchBiome(biomeId);
          state.lastTravelAttempt = { biomeId, at: Date.now() };
          sendWebhook(buildMapSwitchText(best));
          state.lastCheckStatus = 'switched';
          updateStatusIndicator('switched');
          verifyBiomeSwitch(biomeId, 'personal');
        } catch (e) {
          console.warn('[AutoMap][boost-switch] 切图失败:', e.message);
          state.lastCheckStatus = 'error';
          updateStatusIndicator('error');
        }
      }
    } catch (e) {
      console.warn('[AutoMap][boost-switch] 处理天气最优切图失败:', e);
    }
  }
  // 供 handleBoostSwitchRequest 计算目标图经验加成（仅用于展示/通知文案，不开增益决策）
  function resultOfExperienceBest(biome, data) {
    try { return calculateExpBonus(biome, data).total; } catch (_e) { return 0; }
  }
  // 监听后台经 injector.js 转发的天气最优切图指令
  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (d && d.__reelaxSwitchTo && d.biomeId) {
      handleBoostSwitchRequest(d.biomeId);
    }
  });

  // ==================== 主逻辑 ====================
  // 网络异常处理：连续 N 次网络层失败（NetworkError 等）后直接刷新页面，
  // 借重新加载恢复会话/网络（与 403 自愈同理）。阈值设 3 次，给瞬断留余量。
  const NETWORK_RELOAD_THRESHOLD = 3;

  // 预取官方航线服务端规划（routeAssistant.travel()），结果缓存到 state.officialRoute，
  // 供 findBestBiome 里的 pickOfficialRoute 同步读取，以及地图列表顶部「官方推荐」参考展示。
  // 始终预取（无论官方航线开关是否开启），失败/不可用时清空缓存，不影响其他优先级。
  // 是否参与选图由 pickByPriority('official') 里的 useOfficialRoute 控制，与显示解耦。
  async function prefetchOfficialRoute() {
    if (!(state.gameApiReady && state.gameApi && state.gameApi.routeAssistant
        && typeof state.gameApi.routeAssistant.travel === 'function')) {
      state.officialRoute = null;
      return null;
    }
    try {
      const plan = await state.gameApi.routeAssistant.travel();
      state.officialRoute = plan && plan.targetBiomeId ? {
        targetBiomeId: plan.targetBiomeId,
        status: plan.status || null,
        reason: plan.reason || null,
        executeAt: plan.executeAt || null,
        reevaluateAt: plan.reevaluateAt || null,
        serverTime: plan.serverTime || null,
        fetchedAt: Date.now(),
      } : null;
      if (state.officialRoute) {
        console.log('[AutoMap] 官方航线规划:', state.officialRoute);
      }
      return state.officialRoute;
    } catch (e) {
      console.warn('[AutoMap] 官方航线规划获取失败:', e && e.message ? e.message : e);
      state.officialRoute = null;
      return null;
    }
  }

  // 事件/手动/轮询统一入口：避免繁忙时丢事件。
  // fast=true 表示事件驱动的快检（只读内存快照，不吃 HTTP），
  // 若当前正有一轮检查在跑，则置 checkPending，结束后立即补检。
  function requestCheck(opts) {
    const fast = opts && opts.fast === true;
    if (state.isChecking) {
      state.checkPending = true;
      console.log('[AutoMap] 检查进行中，标记待补检（fast=' + fast + '）');
      return;
    }
    checkAndSwitch(fast);
  }

  async function checkAndSwitch(fast) {
    if (state.isChecking) return;
    state.isChecking = true;
    updateStatusIndicator('checking');

    // 看门狗：防止某个接口永久挂起导致 isChecking 卡死，
    // 进而让后续所有（含手动）检查都静默失效
    const watchdog = setTimeout(() => {
      if (state.isChecking) {
        console.warn('[AutoMap] checkAndSwitch 超时（接口可能无响应），强制解锁');
        state.isChecking = false;
        state.lastCheckStatus = 'error';
        state.errorMessage = '检查超时（接口无响应）';
        updateStatusIndicator('error');
        updateUI();
      }
    }, 25000);

    console.log('[AutoMap] checkAndSwitch \u5f00\u59cb');

    try {
      const data = await fetchAllData(fast);
      const currentBiome = data.biomes.find(b => b.isCurrent) || data.unlockedBiomes[0];

      console.log('[AutoMap] currentBiome:', currentBiome);

      if (!currentBiome) {
        log('\u672a\u627e\u5230\u5f53\u524d\u5730\u56fe\uff0c\u8df3\u8fc7\u672c\u6b21\u68c0\u67e5', 'warn');
        state.lastCheckStatus = 'error';
        updateStatusIndicator('error');
        return;
      }

      state.currentBiomeId = currentBiome.id;

      // 服务端时间精确调度补杆（若启用补满）：用快照 fishing 算下次补杆时刻
      if (state.autoRefill) scheduleRefillFromSnapshot(data.fishingState, data.serverTime);

      // 计算所有已解锁地图的详情
      // 综合分与 pickOptimal 完全一致（随 useNewScoring 切换新/旧两版算法）
      const _expAll = data.unlockedBiomes.map(b => calculateExpBonus(b, data).total);
      const _expAbsMax = Math.max(..._expAll.map(v => Math.abs(v)), 1);
      state.biomeDetails = data.unlockedBiomes.map(b => {
        const expBonus = calculateExpBonus(b, data);
        const hasComp = !!(b.activeCompetitions && b.activeCompetitions.length > 0);
        // 检测金风天气
        const weatherRes = data.weatherMap.get(b.id);
        let weatherId = null;
        if (weatherRes) {
          if (weatherRes.weather && weatherRes.weather.id) {
            weatherId = weatherRes.weather.id;
          } else if (weatherRes.weather && weatherRes.weather.weatherId) {
            weatherId = weatherRes.weather.weatherId;
          } else if (weatherRes.weatherId) {
            weatherId = weatherRes.weatherId;
          }
        }
        const hasGoldWind = weatherId === 'gilded_current';
        const hasArcane = weatherId === 'arcane_surge';
        // 金币权重（与 pickOptimal 一致，随 useNewScoring 切换）
        const idx = data.biomes.findIndex(bi => bi.id === b.id);
        const maxIdx = data.biomes.length - 1;
        const mult = getBiomeValueMultiplier(b.id, data.biomes);
        let goldScore;
        let score;
        if (state.useNewScoring) {
          const goldEff = mult * (WEATHER_FISH_MULT[weatherId] != null ? WEATHER_FISH_MULT[weatherId] : 1);
          const maxGold = Math.max.apply(null, data.unlockedBiomes.map(function (bi) {
            const m = getBiomeValueMultiplier(bi.id, data.biomes);
            const w = data.weatherMap.get(bi.id);
            const wid = (w && w.weather && w.weather.id) ? w.weather.id : (w && w.weather && w.weather.weatherId) ? w.weather.weatherId : (w && w.weatherId) ? w.weatherId : null;
            const wm = (wid && WEATHER_FISH_MULT[wid] != null) ? WEATHER_FISH_MULT[wid] : 1;
            return m * wm;
          }).concat([0.0001]));
          goldScore = maxGold > 0 ? goldEff / maxGold : 0.5;
          score = W_GOLD_NEW * goldScore + W_EXP_NEW * (expBonus.total / _expAbsMax);
        } else {
          goldScore = maxIdx > 0 ? idx / maxIdx : 0.5;
          if (hasGoldWind) goldScore = Math.min(1, goldScore + 0.6);
          score = 0.6 * (expBonus.total / _expAbsMax) + 0.4 * goldScore;
        }
        return {
          id: b.id,
          name: getBiomeName(b.id),
          label: getBiomeLabel(b.id, data.biomes),
          isUnlocked: b.isUnlocked,
          isCurrent: b.isCurrent,
          hasCompetition: hasComp,
          hasGoldWind: hasGoldWind,
          hasArcane: hasArcane,
          expBonus: expBonus.total,
          breakdown: expBonus.breakdown,
          goldScore: goldScore,
          score: score,
          index: idx,
        };
      });

      // 预取官方航线服务端规划（若启用官方航线开关）
      await prefetchOfficialRoute();

      // 赛事总览主动补拉（方案A根因修复）：选图前确保赛事识别稳定，
      // 避免比赛期间因缓存缺失/陈旧导致 pickCompetition 落空 → 误切到经验最优图。
      await ensureCompetitionCacheFresh();

      // 查找最优地图
      const best = findBestBiome(data);

      // [诊断] 记录每次选图决策：来源 / 目标 / 当前图 / 是否真的切换+推送
      console.log('[AutoMap][diag] current=' + currentBiome.id + ' best=' + (best ? (best.biome.id + '/' + best.reason + '/priority=' + best.priorityType + '/followBoat=' + !!best.followBoat + '/sail=' + !!best.sail + '/official=' + !!best.official) : 'NULL') + ' mapPriority=' + JSON.stringify(state.mapPriority));

      // 聚合确定目标优选图 → 通知后台给该图开公会增益（仅按选图/切图逻辑触发；后台会检测已有增益防多开）
      if (best) notifyPreferredBoost(best, data);

      // 组队船状态变化（入队/换船图/身份变化）时发送 webhook 通知
      const party = data.party;
      const partyKey = party && party.isInParty ? `${party.boatBiomeId}|${party.role}` : '';
      if (!state.boatWebhookSeeded) {
        // 首次检查只记录当前状态、不发送——避免刷新页面后重复推送船状态
        state.boatWebhookSeeded = true;
        state.lastPartyKey = partyKey;
      } else if (partyKey !== state.lastPartyKey) {
        state.lastPartyKey = partyKey;
        if (party && party.isInParty) {
          sendWebhook(buildBoatStatusText(party));
        }
      }

      // 无匹配优先级时，不切换地图
      if (!best) {
        state.bestBiomeId = null;
        state.bestReason = '无需切换';
        state.lastCheckStatus = 'success';
        updateStatusIndicator('success');
        console.log('[AutoMap] 无匹配优先级，保持当前地图');
        // 无匹配时，检查鱼饵是否需要切换
        const currentType = getBiomePriorityType(currentBiome.id, data);
        state.currentBaitType = currentType;
        await checkAndSwitchBait(currentType, data, false, currentBiome.id);
      } else {
        state.bestBiomeId = best.biome.id;
        state.bestReason = best.reason;
        state.currentBaitType = best.priorityType;

        console.log('[AutoMap] bestBiome:', best.biome.id, best.biome.name, 'reason:', best.reason);
        console.log('[AutoMap] currentBiome.id:', currentBiome.id, 'bestBiome.id:', best.biome.id);

        // 跟随船：检测到船在哪就去哪。人已在船图 → 保持随船（只切鱼饵）；人不在船图 → 走下方真实换图逻辑切到船的当前地图
        if (best.followBoat && currentBiome.id === best.biome.id) {
          state.lastCheckStatus = 'success';
          updateStatusIndicator('success');
          console.log('[AutoMap] 跟随船，已在船图，保持随船:', best.biome.id);
          // 展示船图 vs 最优图加成对比
          let cmp = `（船图经验 ${formatExpPct(best.expBonus.total)}）`;
          // 船过期时间（租赁到期 / 保养逾期）
          if (best.rentalEndsAt) cmp += ` 租期截止 ${formatCNTime(best.rentalEndsAt)}`;
          if (best.maintenanceDueAt) cmp += ` 保养截止 ${formatCNTime(best.maintenanceDueAt)}`;
          if (best.optimalBiome && best.optimalExpBonus) {
            const diff = (best.optimalExpBonus.total - best.expBonus.total) / 100;
            const diffStr = (diff >= 0 ? '+' : '') + diff.toFixed(1);
            const optName = getBiomeName(best.optimalBiome.id);
            cmp += ` ｜ 若不跟船最优[${optName}]经验 ${formatExpPct(best.optimalExpBonus.total)}（差 ${diffStr}%）`;
            if (diff === 0) cmp += '（船已在最优图）';
          }
          log(`跟随船: ${getBiomeName(best.biome.id)} ${cmp}`, 'info');
          await checkAndSwitchBait(best.priorityType, data, false, best.biome.id);
        } else if (best.sail) {
          // 船长/舵手自动开船（跟船优先级胜出）：整船开往目标图
          console.log('[AutoMap][diag] BRANCH=sail 目标=' + best.biome.id);
          await executeSail(best, data, party);
        } else if (currentBiome.id === best.biome.id) {
          state.lastCheckStatus = 'success';
          updateStatusIndicator('success');
          // 地图未切换，检查鱼饵是否需要切换（【不推送】分支——若目标是雾语湿地且此处命中，即说明“切图2不推”）
          console.log('[AutoMap][diag] BRANCH=nochange(当前已是最优) 目标=' + best.biome.id + ' reason=' + best.reason);
          await checkAndSwitchBait(best.priorityType, data, false, best.biome.id);
        } else {
          // 船长且具备开船条件：任何脚本触发的切图都整船跟随（赛事/雷暴/优选均带船），不走个人切图
          const captainCanSail = state.autoSail && party && party.isInParty
            && (party.role === 'captain' || party.role === 'helmsman')
            && party.canChangeBoatBiome && party.status === 'active';
          if (captainCanSail) {
            await executeSail(best, data, party);
          } else {
          // 同一目标 30 秒重试冷却（防止事件高频触发反复切图）
          const retryAt = state.lastTravelAttempt && state.lastTravelAttempt.biomeId === best.biome.id
            ? state.lastTravelAttempt.at : 0;
          if (retryAt && Date.now() - retryAt < CONFIG.travelRetryMs) {
            console.log('[AutoMap] 切换冷却中，跳过:', best.biome.id);
            log(`切换冷却中（30秒内已尝试 ${getBiomeName(best.biome.id)}），跳过`, 'info');
            state.lastCheckStatus = 'success';
            updateStatusIndicator('success');
            await checkAndSwitchBait(best.priorityType, data, false, best.biome.id);
          } else {
            // 执行切换
            const fromLabel = getBiomeLabel(currentBiome.id, data.biomes);
            const toLabel = getBiomeLabel(best.biome.id, data.biomes);
            const fromName = getBiomeName(currentBiome.id);
            const toName = getBiomeName(best.biome.id);

            log(`切换: [${fromLabel}]${fromName} → [${toLabel}]${toName} （${best.reason}，经验 ${formatExpPct(best.expBonus.total)}）`, 'action');
            console.log('[AutoMap][diag] BRANCH=realswitch(会推送) 目标=' + best.biome.id + ' reason=' + best.reason);
            console.log('[AutoMap] 执行切换:', currentBiome.id, '->', best.biome.id);

            // 先切换鱼饵（API直调，服务器即时生效）
            await checkAndSwitchBait(best.priorityType, data, true, best.biome.id);

            // 切换地图：优先travelTo（服务端+前端缓存同步），其次UI点击，最后API直调+刷新
            let switched = false;
            if (state.gameApiReady && state.gameApi) {
              try {
                await switchBiome(best.biome.id); // 内部调用travelTo
                log(`切换成功（travelTo，不刷新页面）`, 'success');
                switched = true;
                // 触发前端重新拉取数据
                try { window.dispatchEvent(new Event('focus')); } catch (_) {}
              } catch (e) {
                console.warn('[AutoMap] travelTo失败，回退到UI切换:', e.message);
              }
            }

            if (!switched) {
              const switchedViaUI = await switchBiomeViaUI(best.biome.id);
              if (switchedViaUI) {
                log(`切换成功（UI点击，不刷新页面）`, 'success');
                switched = true;
              }
            }

            if (!switched) {
              log('UI切换失败，回退到API直调', 'warn');
              await switchBiome(best.biome.id);
              log(`切换成功，页面即将刷新...`, 'success');
              navigateToFishing();
              triggerPageRefresh();
            }

            // 切换成功后发送 webhook 通知（目标地图 / 赛事 / 天气 / 当前鱼饵）
            sendWebhook(buildMapSwitchText(best));
            state.lastTravelAttempt = { biomeId: best.biome.id, at: Date.now() };

            state.lastCheckStatus = 'switched';
            updateStatusIndicator('switched');
            // 切后确认：比对当前图，不匹配则 webhook 告警
            verifyBiomeSwitch(best.biome.id, 'personal');
          }
        }
        }
      }

      state.lastCheckTime = new Date();
      state.errorMessage = null;
      // 成功：清零网络失败计数（若此前处于暂停，已在上文探测恢复时清零）
      state.netFailStreak = 0;
    } catch (error) {
      // 不再打印完整堆栈（堆栈噪音大且无信息量），只记录简明消息
      log(`检查失败: ${error.message}`, 'error');
      state.lastCheckStatus = 'error';
      state.errorMessage = error.message;
      updateStatusIndicator('error');
      if (error.isNetworkError) {
        state.netFailStreak += 1;
        if (state.netFailStreak >= NETWORK_RELOAD_THRESHOLD) {
          state.netFailStreak = 0;
          log('网络持续异常，刷新页面以恢复会话/网络', 'warn');
          setTimeout(() => { window.location.reload(); }, 500);
        } else {
          log('网络请求失败（reelax.cn 暂时不可达），将自动重试', 'warn');
        }
      }
    } finally {
      clearTimeout(watchdog);
      state.isChecking = false;
      updateUI();
      // 检查期间收到事件则立即补检一次（不丢事件）
      if (state.checkPending) {
        state.checkPending = false;
        console.log('[AutoMap] 补检一次（checkPending）');
        setTimeout(() => requestCheck({ fast: true }), 0);
      }
    }
  }

  // 触发页面数据刷新
  function triggerPageRefresh() {
    // 切换地图后必须刷新页面，因为React Query不知道外部API调用，
    // 不会自动更新缓存。最可靠的方式是重新加载页面。
    console.log('[AutoMap] triggerPageRefresh: 刷新页面以同步地图状态');
    setTimeout(() => {
      window.location.reload();
    }, 500);
  }

  // 导航回钓鱼页（SPA点击导航链接，不依赖服务器SPA fallback）
  function navigateToFishing() {
    if (location.pathname.startsWith('/fishing')) return;
    const link = document.querySelector('a[href="/fishing"]');
    if (link) {
      link.click();
      console.log('[AutoMap] navigateToFishing: 已点击"钓鱼"导航');
      return;
    }
    // fallback: 直接整页导航到钓鱼页
    window.location.href = '/fishing';
  }

  // ==================== 轮询控制 ====================
  function startPolling() {
    stopPolling();

    // 游戏API已连接时，延长轮询间隔并添加随机抖动（减少服务器负载）
    let effectiveInterval = state.pollInterval;
    if (state.gameApiReady && state.gameApi) {
      effectiveInterval = Math.max(state.pollInterval, 60000); // 最少60秒
    }

    // 首次检查添加随机延迟（0-30秒），避免多客户端同时请求
    const initialDelay = Math.floor(Math.random() * 30000);
    initialPollTimer = setTimeout(() => {
      initialPollTimer = null;
      if (!state.autoSwitch) return; // 已在延时期间被手动关闭，不再执行
      checkAndSwitch();

      // 后续检查添加随机抖动（±15%），防止惊群效应
      pollTimer = setInterval(() => {
        if (state.autoSwitch && !state.isChecking) {
          const jitter = effectiveInterval * (0.85 + Math.random() * 0.3);
          setTimeout(() => checkAndSwitch(), jitter - effectiveInterval);
        }
      }, effectiveInterval);
    }, initialDelay);
  }

  function stopPolling() {
    if (initialPollTimer) {
      clearTimeout(initialPollTimer);
      initialPollTimer = null;
    }
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  // ==================== 杆数自动补满 ====================

  // 解析当前杆数，从按钮内b标签的 "214 / 236" 格式
  function parseRodCount(button) {
    if (!button) return null;
    const bEl = button.querySelector('b');
    if (!bEl) return null;
    const text = bEl.textContent.trim().replace(/,/g, '');
    const match = text.match(/^(\d+)\s*\/\s*(\d+)$/);
    if (match) {
      return { current: parseInt(match[1], 10), max: parseInt(match[2], 10) };
    }
    return null;
  }

  // 从 fishingState 提取平铺的钓鱼对象（兼容快照平铺 / API直调 {run:{...}} 包装）
  function normalizeFishing(fishingState) {
    if (!fishingState) return null;
    if (fishingState.run && typeof fishingState.run === 'object') return fishingState.run;
    return fishingState;
  }

  // 计算下次补杆的服务端时刻：剩余次数将「严格少于批次总次数一半」的那一杆
  // 返回 serverNow 表示现在就该补；null 表示当前状态无需/无法调度
  function computeRefillDueAt(fishingState, serverNow) {
    const fishing = normalizeFishing(fishingState);
    if (!fishing || fishing.status === 'stopped' || fishing.totalCasts <= 0) return null;
    if (fishing.status === 'completed' || fishing.remainingCasts < fishing.totalCasts / 2) return serverNow;
    if (fishing.status !== 'running' || !fishing.nextCastAt || fishing.cycleDurationMs <= 0) return null;
    const nextCastAt = Date.parse(fishing.nextCastAt);
    if (!Number.isFinite(nextCastAt)) return null;
    const castsUntilEligible = Math.floor(fishing.remainingCasts - fishing.totalCasts / 2) + 1;
    return nextCastAt + Math.max(0, castsUntilEligible - 1) * fishing.cycleDurationMs;
  }

  // 服务端时间精确调度补杆：用 snapshot.fishing 算下次补杆时刻，setTimeout 到点触发 attemptRefill。
  // 返回 true 表示已安排定时器；false 表示无需/无法调度（DOM 兜底继续）。
  function scheduleRefillFromSnapshot(fishingState, serverTime) {
    if (refillTimer !== null) {
      clearTimeout(refillTimer);
      refillTimer = null;
    }
    if (!state.autoRefill || !fishingState) return false;
    const serverNow = serverTime ? Date.parse(serverTime) : Date.now();
    if (!Number.isFinite(serverNow)) return false;
    const dueAt = computeRefillDueAt(fishingState, serverNow);
    if (dueAt === null) return false;
    const delay = Math.max(0, dueAt - serverNow) + CONFIG.refillSyncPaddingMs;
    refillTimer = setTimeout(() => {
      refillTimer = null;
      void attemptRefill();
    }, Math.min(delay, 2147483647));
    return true;
  }

  // 到点补杆：优先官方 API refill()，失败回退 DOM 点击
  // 日报计数：无论 API 还是 DOM 兜底，只要成功补满就发 ok:true；尝试但失败发 ok:false，
  // 让 monitor 的 refillNeeded/refillOk 如实反映（修复之前只在 API 成功时上报导致全 0）。
  function notifyRefill(ok) {
    try { window.postMessage({ __reelaxDailyRefill: true, ok: !!ok }, '*'); } catch (_e) {}
  }
  async function attemptRefill() {
    if (refillLocked || !state.autoRefill) return;
    if (state.gameApiReady && state.gameApi && state.gameApi.fishing && typeof state.gameApi.fishing.refill === 'function') {
      try {
        const didRefill = await state.gameApi.fishing.refill();
        if (didRefill) {
          log('剩余次数低于一半，已按服务端调度调用游戏内补满', 'action');
          notifyRefill(true);
        } else {
          // API 返回 false（未低于一半/服务端拒绝）——不视为一次“补满尝试”，不计数
          console.log('[AutoMap] refill API 返回 false，未真正补满');
        }
        refillLocked = true;
        setTimeout(() => { refillLocked = false; }, CONFIG.refillLockTime);
        return;
      } catch (e) {
        console.warn('[AutoMap] refill API 失败，回退 DOM 点击:', e.message);
      }
    }

    // 回退：DOM 点击（API 不可用时）。低于一半时触发
    const button = document.querySelector('button.topbar-fishing-status');
    if (!button || button.disabled) return;
    const counts = parseRodCount(button);
    if (!counts || counts.max <= 0) return;
    if (counts.current >= counts.max / 2) return;
    log(`杆数 ${counts.current}/${counts.max} 低于一半，自动补满（DOM 回退）`, 'action');
    button.click();
    notifyRefill(true);
    refillLocked = true;
    setTimeout(() => {
      refillLocked = false;
    }, CONFIG.refillLockTime);
  }

  // 处理杆数变化：优先用服务端时间精确调度补杆（快照模式）；
  // DOM 仅作兜底，且节流拉长到 rodThrottleMs（避免每杆触发）。
  async function handleRodCountChange(button) {
    if (refillLocked) return;
    if (!state.autoRefill) return;

    // 优先服务端调度：从游戏API快照读取 fishing，精确安排下次补杆时刻
    let serverScheduled = false;
    if (state.gameApiReady && state.gameApi) {
      const snap = state.gameApi.getSnapshot();
      if (snap && snap.fishing) {
        serverScheduled = scheduleRefillFromSnapshot(snap.fishing, snap.serverTime);
      }
    }

    // DOM 兜底节流：服务端调度为主，DOM 至少间隔 rodThrottleMs 才检查一次
    const now = Date.now();
    if (now - lastRodCheckTime < CONFIG.rodThrottleMs) return;
    lastRodCheckTime = now;

    // 服务端已安排定时补杆时，DOM 无需立即触发
    if (serverScheduled) return;

    await attemptRefill();
  }

  // 启动杆数监控
  function startRodMonitor() {
    stopRodMonitor();

    function tryInit() {
      const button = document.querySelector('button.topbar-fishing-status');
      if (!button) {
        // 按钮未加载，稍后重试
        rodRetryTimer = setTimeout(tryInit, CONFIG.rodCheckInterval);
        return;
      }

      // 初始检查
      handleRodCountChange(button);

      // 监控杆数文本变化
      const countEl = button.querySelector('b');
      const target = countEl || button;
      rodObserver = new MutationObserver(() => {
        handleRodCountChange(button);
      });
      rodObserver.observe(target, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: !countEl,
        attributeFilter: countEl ? undefined : ['title', 'aria-label'],
      });
      console.log('[AutoMap] 杆数监控已启动, 触发条件: 剩余低于批次一半时调用 refill()');
    }

    tryInit();
  }

  // 停止杆数监控
  function stopRodMonitor() {
    if (rodObserver) {
      rodObserver.disconnect();
      rodObserver = null;
    }
    if (rodRetryTimer) {
      clearTimeout(rodRetryTimer);
      rodRetryTimer = null;
    }
    if (refillTimer) {
      clearTimeout(refillTimer);
      refillTimer = null;
    }
    refillLocked = false;
  }

  // ==================== 赛事弹窗自动稍后处理 ====================
  // 注：开增益改由「聚合确定优选地图」驱动（见 notifyPreferredBoost），
  // 比赛弹窗这里只负责点击"稍后处理"，不再单独通知后台开增益。

  // 查找并点击"稍后处理"按钮
  function dismissCompetitionPopup() {
    const dialog = document.querySelector('.competition-reminder-dialog');
    if (!dialog) return false;

    // 在弹窗内查找 secondary-button（即"稍后处理"按钮）
    const btn = dialog.querySelector('button.secondary-button');
    if (!btn) return false;

    // 按钮可能处于 disabled 状态（loading中），跳过等待下次检测
    if (btn.disabled) return false;

    btn.click();
    log('赛事弹窗已自动点击"稍后处理"', 'action');
    return true;
  }

  // 启动赛事弹窗监控
  function startCompetitionPopupMonitor() {
    stopCompetitionPopupMonitor();
    // 先检查当前是否已有弹窗
    dismissCompetitionPopup();
// 监听 DOM 变化，检测弹窗出现（节流：钓鱼页 DOM 高频变化，1 秒内只处理一次）
  competitionObserver = new MutationObserver(() => {
    if (!state.autoDismissCompetition) return;
    const now = Date.now();
    if (now - compLastCheck < 1000) return;
    compLastCheck = now;
    dismissCompetitionPopup();
  });
  competitionObserver.observe(document.body, {
    childList: true,
    subtree: true,
  });
    console.log('[AutoMap] 赛事弹窗监控已启动');
  }

  // 停止赛事弹窗监控
  function stopCompetitionPopupMonitor() {
    if (competitionObserver) {
      competitionObserver.disconnect();
      competitionObserver = null;
    }
  }

  // ==================== 每日签到自动领取 ====================

  // 尝试在签到弹窗中点击领取按钮（识别后延时10-15秒再领取）
  // 每日签到：优先官方 API（快照模式 dailyCheckIn.claim()），失败/不可用时回退 DOM 点击
  async function performDailyCheckIn() {
    // 优先官方 API：直接读快照判断是否可领取，不依赖弹窗 DOM
    if (state.gameApiReady && state.gameApi
        && state.gameApi.dailyCheckIn && typeof state.gameApi.dailyCheckIn.claim === 'function') {
      try {
        const snapshot = state.gameApi.getSnapshot();
        if (snapshot?.dailyCheckIn?.canClaim) {
          // 已安排延时领取，避免重复调度
          if (checkInRetryTimer) return true;

          const delayMs = 10000 + Math.floor(Math.random() * 5001);
          log(`签到可领取（官方API），${Math.round(delayMs / 1000)}秒后自动领取`, 'info');

          checkInRetryTimer = setTimeout(async () => {
            checkInRetryTimer = null;
            try {
              const didClaim = await state.gameApi.dailyCheckIn.claim();
              if (didClaim) {
                log('每日签到领取完成（官方API），弹窗已关闭', 'success');
                // 通过官方 API 关闭签到提醒
                state.gameApi.ui?.dismissReminder?.('daily-check-in');
              } else {
                console.log('[AutoMap] 官方API签到返回 false（可能在途/未到可领状态），稍后重试');
                checkInRetryTimer = setTimeout(() => {
                  checkInRetryTimer = null;
                  void performDailyCheckIn();
                }, CONFIG.refillRetryMs);
              }
            } catch (e) {
              console.warn('[AutoMap] 官方API签到失败，回退 DOM 点击:', e.message);
              domCheckIn();
            }
          }, delayMs);
          return true;
        }
        // 快照明确不可领取（未到时间/已领），无需走 DOM
        return false;
      } catch (e) {
        console.warn('[AutoMap] 官方API签到快照读取失败，回退 DOM:', e.message);
      }
    }

    // 兜底：DOM 点击
    return domCheckIn();
  }

  // 签到 DOM 兜底逻辑（官方 API 不可用时）
  function domCheckIn() {
    const dialog = document.querySelector('dialog.daily-check-in-dialog');
    if (!dialog) return false;

    // 查找领取按钮
    const claimBtn = dialog.querySelector('button.daily-check-in-claim-button');
    if (!claimBtn) return false;

    // 已领取或正在领取中，按钮disabled
    if (claimBtn.disabled) return false;

    // 检查按钮文字，只有"领取第X天奖励"才点击
    const btnText = claimBtn.textContent.trim();
    if (!btnText.includes('领取')) return false;

    // 已安排延时领取，避免重复调度
    if (checkInRetryTimer) return false;

    // 随机延时10-15秒再领取
    const delayMs = 10000 + Math.floor(Math.random() * 5001);
    log(`签到弹窗已识别，${Math.round(delayMs / 1000)}秒后自动领取`, 'info');
    console.log(`[AutoMap] 签到弹窗已识别，${(delayMs / 1000).toFixed(1)}秒后自动领取`);

    checkInRetryTimer = setTimeout(() => {
      checkInRetryTimer = null;
      // 延时后再次确认弹窗和按钮仍存在且可用
      const dialog2 = document.querySelector('dialog.daily-check-in-dialog');
      if (!dialog2) return;
      const claimBtn2 = dialog2.querySelector('button.daily-check-in-claim-button');
      if (!claimBtn2 || claimBtn2.disabled) return;
      const btnText2 = claimBtn2.textContent.trim();
      if (!btnText2.includes('领取')) return;

      claimBtn2.click();
      log('每日签到自动领取中...', 'action');
      console.log('[AutoMap] 每日签到已自动点击领取');

      // 领取后等待2秒，然后关闭弹窗
      setTimeout(() => {
        const closeBtn = dialog2.querySelector('button[aria-label="关闭每日签到"]');
        if (closeBtn && !closeBtn.disabled) {
          closeBtn.click();
          log('每日签到领取完成，弹窗已关闭', 'success');
          console.log('[AutoMap] 签到弹窗已关闭');
        } else {
          // 关闭按钮可能还是disabled(正在领取)，再等2秒
          setTimeout(() => {
            const closeBtn2 = dialog2.querySelector('button[aria-label="关闭每日签到"]');
            if (closeBtn2 && !closeBtn2.disabled) {
              closeBtn2.click();
              log('每日签到领取完成，弹窗已关闭', 'success');
            }
          }, 2000);
        }
      }, 2000);
    }, delayMs);

    return true;
  }

  // 启动每日签到监控
  function startCheckInMonitor() {
    stopCheckInMonitor();
    // 先检查当前是否已有弹窗
    performDailyCheckIn();
// 监听 DOM 变化，检测弹窗出现（节流：钓鱼页 DOM 高频变化，1 秒内只处理一次）
  checkInObserver = new MutationObserver(() => {
    if (!state.autoCheckIn) return;
    const now = Date.now();
    if (now - checkInLastCheck < 1000) return;
    checkInLastCheck = now;
    performDailyCheckIn();
  });
  checkInObserver.observe(document.body, {
    childList: true,
    subtree: true,
  });
    console.log('[AutoMap] 每日签到监控已启动');
  }

  // 停止每日签到监控
  function stopCheckInMonitor() {
    if (checkInObserver) {
      checkInObserver.disconnect();
      checkInObserver = null;
    }
    if (checkInRetryTimer) {
      clearTimeout(checkInRetryTimer);
      checkInRetryTimer = null;
    }
  }

  // ==================== 离线结算弹窗自动处理 ====================

  // 尝试处理离线结算弹窗：优先点"继续去钓鱼"，其次"完成"/关闭按钮，最后兜底关闭
  function dismissOfflineSummary() {
    const dialog = document.querySelector('dialog.offline-summary-dialog');
    if (!dialog) return false;

    // 1. 优先点击"继续去钓鱼"(primary-button)，恢复在线继续钓鱼
    const primaryBtn = dialog.querySelector('footer button.primary-button');
    if (primaryBtn && !primaryBtn.disabled) {
      primaryBtn.click();
      log('离线结算弹窗已自动点击"继续去钓鱼"', 'action');
      console.log('[AutoMap] 离线结算弹窗已点击"继续去钓鱼"');
      return true;
    }

    // 2. 其次点击"完成"(secondary-button)，关闭弹窗
    const secondaryBtn = dialog.querySelector('footer button.secondary-button');
    if (secondaryBtn && !secondaryBtn.disabled) {
      secondaryBtn.click();
      log('离线结算弹窗已自动点击"完成"', 'info');
      console.log('[AutoMap] 离线结算弹窗已点击"完成"');
      return true;
    }

    // 3. 再次点击标题栏关闭按钮
    const closeBtn = dialog.querySelector('header button.icon-button[aria-label="关闭离线结算汇总"]');
    if (closeBtn && !closeBtn.disabled) {
      closeBtn.click();
      log('离线结算弹窗已自动关闭', 'info');
      console.log('[AutoMap] 离线结算弹窗已点击关闭按钮');
      return true;
    }

    // 4. 兜底：原生关闭 dialog
    try {
      dialog.close();
      log('离线结算弹窗已自动关闭', 'info');
      console.log('[AutoMap] 离线结算弹窗已调用close()');
      return true;
    } catch (_) {}

    return false;
  }

  // 启动离线结算弹窗监控
  function startOfflineSummaryMonitor() {
    stopOfflineSummaryMonitor();
    // 先检查当前是否已有弹窗
    dismissOfflineSummary();
    let lastCheck = 0;
    // 监听 DOM 变化，检测弹窗出现或按钮状态变化
    offlineObserver = new MutationObserver(() => {
      if (!state.autoDismissOffline) return;
      // 节流：钓鱼页面DOM高频变化，1秒内只处理一次
      const now = Date.now();
      if (now - lastCheck < 1000) return;
      lastCheck = now;
      dismissOfflineSummary();
    });
    offlineObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
    });
    console.log('[AutoMap] 离线结算弹窗监控已启动');
  }

  // 停止离线结算弹窗监控
  function stopOfflineSummaryMonitor() {
    if (offlineObserver) {
      offlineObserver.disconnect();
      offlineObserver = null;
    }
  }

  // ==================== 日志 ====================
  function log(message, type) {
    const now = new Date();
    const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
    state.logEntries.unshift({ time: timeStr, message, type: type || 'info' });
    if (state.logEntries.length > CONFIG.maxLogEntries) {
      state.logEntries.length = CONFIG.maxLogEntries;
    }
    updateLogUI();
  }

  // ==================== UI ====================
  function getThemeColors() {
    return {
      bg: 'rgba(18, 18, 24, 0.94)',
      bgHeader: 'rgba(255, 255, 255, 0.04)',
      bgHover: 'rgba(255, 255, 255, 0.06)',
      bgInput: '#252530',
      text: 'rgba(255, 255, 255, 0.92)',
      textSub: 'rgba(255, 255, 255, 0.72)',
      textDim: 'rgba(255, 255, 255, 0.58)',
      border: 'rgba(255, 255, 255, 0.18)',
      accent: '#6d5dfc',
      accentBg: 'rgba(109, 93, 252, 0.12)',
      accentBgHover: 'rgba(109, 93, 252, 0.22)',
      success: '#4ade80',
      warn: '#fbbf24',
      error: '#f87171',
      action: '#9ea5ff',
      danger: '#d34848',
      dangerBg: 'rgba(211, 72, 72, 0.12)',
      shadow: '0 10px 32px rgba(0, 0, 0, 0.42)',
    };
  }

  function createUI() {
    const colors = getThemeColors();

    // 防御：若已有面板/图标（历史重复注入残留），先移除，避免右下角堆积
    document.getElementById('reelax-auto-map-panel')?.remove();
    document.getElementById('reelax-auto-map-icon')?.remove();

    // 主容器
    panelEl = document.createElement('div');
    panelEl.id = 'reelax-auto-map-panel';
    panelEl.style.cssText = `
      position: fixed;
      top: 16px;
      right: 16px;
      z-index: 999999;
      width: 280px;
      max-height: 90vh;
      background: ${colors.bg};
      color: ${colors.text};
      border: 1px solid ${colors.border};
      border-radius: 12px;
      box-shadow: ${colors.shadow};
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 13px;
      line-height: 1.5;
      overflow: hidden;
      transition: max-height 0.3s ease, opacity 0.2s ease;
      display: flex;
      flex-direction: column;
    `;


    panelEl.innerHTML = `
      <style>
        #reelax-auto-map-panel * { box-sizing: border-box; margin: 0; padding: 0; }
        #reelax-auto-map-panel .ramp-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 10px 14px 6px;
          cursor: move;
          user-select: none;
        }
        #reelax-auto-map-panel .ramp-header-actions {
          display: flex;
          align-items: center;
          gap: 6px;
        }
        #reelax-auto-map-panel .ramp-title {
          display: flex;
          align-items: center;
          gap: 5px;
          font-weight: 700;
          font-size: 15px;
          color: ${colors.text};
        }
        #reelax-auto-map-panel .ramp-collapse-toggle {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 26px;
          height: 26px;
          flex-shrink: 0;
          padding: 0;
          border: 1px solid rgba(255, 255, 255, 0.16);
          border-radius: 7px;
          background: rgba(255, 255, 255, 0.08);
          color: rgba(255, 255, 255, 0.88);
          font-size: 16px;
          line-height: 1;
          cursor: pointer;
          font-family: inherit;
        }
        #reelax-auto-map-panel .ramp-collapse-toggle:hover {
          background: rgba(255, 255, 255, 0.14);
        }
        #reelax-auto-map-panel .ramp-body {
          max-height: calc(100vh - 96px);
          overflow-x: hidden;
          overflow-y: auto;
          overscroll-behavior: contain;
          padding: 8px 14px 14px;
        }
        #reelax-auto-map-panel .ramp-body::-webkit-scrollbar { width: 6px; height: 0; }
        #reelax-auto-map-panel .ramp-body::-webkit-scrollbar-track { background: transparent; }
        #reelax-auto-map-panel .ramp-body::-webkit-scrollbar-thumb {
          border-radius: 999px;
          background: rgba(255, 255, 255, 0.24);
        }
        #reelax-auto-map-panel .ramp-body::-webkit-scrollbar-thumb:hover {
          background: rgba(255, 255, 255, 0.38);
        }
        #reelax-auto-map-panel .ramp-tabbar {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 4px;
          padding: 3px;
          margin: 0 14px;
          border-radius: 8px;
          background: rgba(255, 255, 255, 0.07);
        }
        #reelax-auto-map-panel .ramp-tab {
          padding: 6px 8px;
          border: 0;
          border-radius: 6px;
          background: transparent;
          color: rgba(255, 255, 255, 0.56);
          font-size: 12px;
          font-weight: 700;
          font-family: inherit;
          cursor: pointer;
          text-align: center;
          transition: background 0.15s, color 0.15s;
          user-select: none;
        }
        #reelax-auto-map-panel .ramp-tab:hover { color: rgba(255, 255, 255, 0.8); }
        #reelax-auto-map-panel .ramp-tab.active {
          background: ${colors.accent};
          color: #fff;
        }
        #reelax-auto-map-panel .ramp-page { display: none; }
        #reelax-auto-map-panel .ramp-page.active { display: block; }
        #reelax-auto-map-panel .ramp-page[hidden] { display: none; }
        /* Status rows */
        #reelax-auto-map-panel .ramp-row {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 10px;
          margin-top: 7px;
          font-size: 12px;
        }
        #reelax-auto-map-panel .ramp-label {
          color: rgba(255, 255, 255, 0.58);
          flex-shrink: 0;
        }
        #reelax-auto-map-panel .ramp-value {
          text-align: right;
          color: rgba(255, 255, 255, 0.92);
          overflow-wrap: anywhere;
        }
        #reelax-auto-map-panel .ramp-bonus { color: ${colors.success}; }
        #reelax-auto-map-panel .ramp-bonus-negative { color: ${colors.textDim}; }
        /* Option rows + Switch */
        #reelax-auto-map-panel .ramp-option-row {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 10px;
          margin-top: 10px;
          font-size: 12px;
          cursor: pointer;
          color: rgba(255, 255, 255, 0.88);
          user-select: none;
        }
        #reelax-auto-map-panel .ramp-option-row .ramp-option-text {
          flex: 1;
          min-width: 0;
        }
        #reelax-auto-map-panel .ramp-option-desc {
          font-size: 10px;
          color: ${colors.textDim};
          margin-top: 1px;
        }
        #reelax-auto-map-panel .ramp-switch {
          position: relative;
          display: inline-block;
          width: 38px;
          height: 22px;
          flex-shrink: 0;
        }
        #reelax-auto-map-panel .ramp-switch input {
          position: absolute;
          width: 1px;
          height: 1px;
          opacity: 0;
          margin: -1px;
          overflow: hidden;
          clip: rect(0, 0, 0, 0);
        }
        #reelax-auto-map-panel .ramp-switch-track {
          display: block;
          width: 100%;
          height: 100%;
          border-radius: 999px;
          background: rgba(255, 255, 255, 0.2);
          transition: background 0.15s;
        }
        #reelax-auto-map-panel .ramp-switch-track::after {
          content: '';
          position: absolute;
          top: 3px;
          left: 3px;
          width: 16px;
          height: 16px;
          border-radius: 50%;
          background: #fff;
          transition: transform 0.15s;
        }
        #reelax-auto-map-panel .ramp-switch input:checked + .ramp-switch-track {
          background: ${colors.accent};
        }
        #reelax-auto-map-panel .ramp-switch input:checked + .ramp-switch-track::after {
          transform: translateX(16px);
        }
        /* Form fields */
        #reelax-auto-map-panel .ramp-field { display: block; margin-top: 12px; }
        #reelax-auto-map-panel .ramp-field-label {
          display: block;
          margin-bottom: 5px;
          color: rgba(255, 255, 255, 0.58);
          font-size: 12px;
        }
        #reelax-auto-map-panel .ramp-input {
          width: 100%;
          padding: 8px 9px;
          border: 1px solid rgba(255, 255, 255, 0.18);
          border-radius: 7px;
          background: ${colors.bgInput};
          color: rgba(255, 255, 255, 0.92);
          font-size: 12px;
          font-family: inherit;
          outline: none;
        }
        #reelax-auto-map-panel .ramp-input:focus { border-color: ${colors.accent}; }
        #reelax-auto-map-panel .ramp-number-input {
          width: 56px;
          padding: 5px 7px;
          border: 1px solid rgba(255, 255, 255, 0.18);
          border-radius: 6px;
          background: ${colors.bgInput};
          color: rgba(255, 255, 255, 0.92);
          font-size: 12px;
          font-family: inherit;
          text-align: center;
          outline: none;
          font-variant-numeric: tabular-nums;
        }
        #reelax-auto-map-panel .ramp-number-input:focus { border-color: ${colors.accent}; }
        #reelax-auto-map-panel .ramp-interval-select {
          padding: 4px 8px;
          border: 1px solid rgba(255, 255, 255, 0.18);
          border-radius: 6px;
          background: ${colors.bgInput};
          color: rgba(255, 255, 255, 0.92);
          font-size: 11px;
          font-family: inherit;
          cursor: pointer;
          outline: none;
        }
        #reelax-auto-map-panel .ramp-interval-select:focus { border-color: ${colors.accent}; }
        /* Row with inline input + switch */
        #reelax-auto-map-panel .ramp-option-row-inline {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 10px;
          margin-top: 10px;
          font-size: 12px;
        }
        #reelax-auto-map-panel .ramp-option-row-inline .ramp-switch {
          flex-shrink: 0;
        }
        /* Settings sections */
        #reelax-auto-map-panel .ramp-section {
          margin-top: 14px;
          padding-top: 14px;
          border-top: 1px solid rgba(255, 255, 255, 0.1);
        }
        #reelax-auto-map-panel .ramp-section-title {
          display: flex;
          justify-content: space-between;
          align-items: center;
          color: rgba(255, 255, 255, 0.88);
          font-size: 12px;
          font-weight: 700;
        }
        /* Collapsible */
        #reelax-auto-map-panel .ramp-collapsible-header {
          cursor: pointer;
          user-select: none;
          display: flex;
          align-items: center;
          justify-content: space-between;
          color: rgba(255, 255, 255, 0.88);
          font-size: 12px;
          font-weight: 700;
        }
        #reelax-auto-map-panel .ramp-collapsible-header:hover { opacity: 0.7; }
        #reelax-auto-map-panel .ramp-collapse-arrow {
          font-size: 18px;
          color: ${colors.textSub};
          transition: transform 160ms;
          line-height: 1;
        }
        #reelax-auto-map-panel .ramp-section.collapsed .ramp-collapse-arrow {
          transform: rotate(-90deg);
        }
        #reelax-auto-map-panel .ramp-section.collapsed .ramp-collapsible-content {
          display: none;
        }
        /* Priority list */
        #reelax-auto-map-panel .ramp-priority-list { display: grid; gap: 5px; }
        #reelax-auto-map-panel .ramp-priority-item {
          display: grid;
          grid-template-columns: auto minmax(0, 1fr) auto;
          align-items: center;
          gap: 6px;
          min-height: 34px;
          padding: 5px 6px;
          border: 1px solid rgba(255, 255, 255, 0.12);
          border-radius: 7px;
          background: rgba(255, 255, 255, 0.045);
          font-size: 11px;
        }
        #reelax-auto-map-panel .ramp-priority-rank {
          color: rgba(255, 255, 255, 0.38);
          font-size: 15px;
          flex-shrink: 0;
          width: 20px;
          text-align: center;
        }
        #reelax-auto-map-panel .ramp-priority-label {
          font-weight: 700;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        #reelax-auto-map-panel .ramp-priority-btns { display: inline-flex; gap: 3px; }
        #reelax-auto-map-panel .ramp-priority-btn {
          width: 22px;
          height: 22px;
          border: 1px solid rgba(255, 255, 255, 0.14);
          border-radius: 5px;
          background: rgba(255, 255, 255, 0.06);
          color: rgba(255, 255, 255, 0.72);
          font-size: 11px;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          font-family: inherit;
          line-height: 1;
        }
        #reelax-auto-map-panel .ramp-priority-btn:hover:not(:disabled) {
          background: ${colors.accentBgHover};
          border-color: ${colors.accent};
          color: #fff;
        }
        #reelax-auto-map-panel .ramp-priority-btn:disabled { opacity: 0.28; cursor: not-allowed; }
        #reelax-auto-map-panel .ramp-priority-hint {
          font-size: 10px;
          color: rgba(255, 255, 255, 0.42);
          text-align: center;
          margin-top: 6px;
        }
        /* Bait list */
        #reelax-auto-map-panel .ramp-bait-list { display: grid; gap: 6px; }
        #reelax-auto-map-panel .ramp-bait-item {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 6px;
          padding: 7px 8px;
          border: 1px solid rgba(255, 255, 255, 0.12);
          border-radius: 7px;
          font-size: 11px;
        }
        #reelax-auto-map-panel .ramp-bait-item-label {
          font-size: 11px;
          color: rgba(255, 255, 255, 0.88);
          flex: 1;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        #reelax-auto-map-panel .ramp-bait-select {
          font-size: 11px;
          padding: 4px 8px;
          border: 1px solid rgba(255, 255, 255, 0.18);
          border-radius: 6px;
          background: ${colors.bgInput};
          color: rgba(255, 255, 255, 0.92);
          cursor: pointer;
          font-family: inherit;
          outline: none;
          max-width: 120px;
        }
        #reelax-auto-map-panel .ramp-bait-select:focus { border-color: ${colors.accent}; }
        /* Badges */
        #reelax-auto-map-panel .ramp-badge {
          display: inline-block;
          padding: 2px 5px;
          border-radius: 999px;
          font-size: 9px;
          font-weight: 600;
          margin-left: 3px;
          vertical-align: middle;
        }
        #reelax-auto-map-panel .ramp-badge-comp {
          background: rgba(251, 191, 36, 0.12);
          color: #fcd34d;
        }
        #reelax-auto-map-panel .ramp-badge-best {
          background: rgba(109, 93, 252, 0.16);
          color: #d8d8df;
        }
        #reelax-auto-map-panel .ramp-badge-gold {
          background: rgba(251, 191, 36, 0.12);
          color: #fcd34d;
        }
        #reelax-auto-map-panel .ramp-badge-arcane {
          background: rgba(168, 85, 247, 0.16);
          color: #e9d5ff;
        }
        /* Detail table */
        #reelax-auto-map-panel .ramp-detail-table {
          width: 100%;
          border-collapse: collapse;
          font-size: 11px;
        }
        #reelax-auto-map-panel .ramp-detail-table th {
          text-align: left;
          padding: 5px 6px;
          color: ${colors.textDim};
          font-weight: 600;
          border-bottom: 1px solid rgba(255, 255, 255, 0.1);
          font-size: 10px;
        }
        #reelax-auto-map-panel .ramp-detail-table td {
          padding: 5px 6px;
          color: ${colors.textSub};
          border-bottom: 1px solid rgba(255, 255, 255, 0.08);
          font-variant-numeric: tabular-nums;
        }
        #reelax-auto-map-panel .ramp-detail-table tr:hover td { background: ${colors.bgHover}; }
        #reelax-auto-map-panel .ramp-detail-table tr.current td { color: ${colors.success}; font-weight: 600; }
        #reelax-auto-map-panel .ramp-detail-table tr.best td { color: ${colors.accent}; font-weight: 600; }
        /* 地图列表折叠态（精简：地图名 + 综合分） */
        #reelax-auto-map-panel .ramp-detail-mini-list {
          font-size: 11px;
          font-variant-numeric: tabular-nums;
        }
        #reelax-auto-map-panel .ramp-detail-mini {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 4px 6px;
          border-bottom: 1px solid rgba(255, 255, 255, 0.08);
          color: ${colors.textSub};
        }
        #reelax-auto-map-panel .ramp-detail-mini:last-child { border-bottom: none; }
        #reelax-auto-map-panel .ramp-detail-mini:hover { background: ${colors.bgHover}; }
        #reelax-auto-map-panel .ramp-detail-mini.current { color: ${colors.success}; font-weight: 600; }
        #reelax-auto-map-panel .ramp-detail-mini.best { color: ${colors.accent}; font-weight: 600; }
        #reelax-auto-map-panel .ramp-detail-mini-score { color: ${colors.textDim}; font-size: 11px; }
        /* 官方推荐线路横幅（地图列表顶部，始终显示参考，三行布局） */
        #reelax-auto-map-panel .ramp-official-route {
          display: flex;
          flex-direction: column;
          gap: 2px;
          padding: 6px 8px;
          margin-bottom: 6px;
          border-radius: 6px;
          background: rgba(80, 140, 255, 0.12);
          border: 1px solid rgba(80, 140, 255, 0.35);
          font-size: 11px;
          line-height: 1.5;
        }
        #reelax-auto-map-panel .ramp-official-route-line { color: ${colors.text}; }
        #reelax-auto-map-panel .ramp-official-route-tag {
          display: inline-block;
          padding: 0 5px;
          margin-right: 5px;
          border-radius: 4px;
          background: rgba(80, 140, 255, 0.3);
          color: #cfe0ff;
          font-weight: 600;
        }
        #reelax-auto-map-panel .ramp-official-route-plan { color: ${colors.textDim}; }
        /* Log */
        #reelax-auto-map-panel .ramp-log {
          max-height: 120px;
          overflow-y: auto;
          font-size: 11px;
        }
        #reelax-auto-map-panel .ramp-log::-webkit-scrollbar { width: 3px; }
        #reelax-auto-map-panel .ramp-log::-webkit-scrollbar-thumb {
          background: rgba(255, 255, 255, 0.2);
          border-radius: 2px;
        }
        #reelax-auto-map-panel .ramp-log-entry {
          display: flex;
          gap: 6px;
          padding: 3px 0;
          color: ${colors.textSub};
          line-height: 1.4;
        }
        #reelax-auto-map-panel .ramp-log-time { color: ${colors.textDim}; flex-shrink: 0; font-size: 10px; padding-top: 1px; }
        #reelax-auto-map-panel .ramp-log-entry.action .ramp-log-msg { color: ${colors.action}; }
        #reelax-auto-map-panel .ramp-log-entry.success .ramp-log-msg { color: ${colors.success}; }
        #reelax-auto-map-panel .ramp-log-entry.error .ramp-log-msg { color: ${colors.error}; }
        #reelax-auto-map-panel .ramp-log-entry.warn .ramp-log-msg { color: ${colors.warn}; }
        /* Buttons */
        #reelax-auto-map-panel .ramp-toggle-btn {
          width: 100%;
          margin-top: 12px;
          padding: 9px 12px;
          border: 0;
          border-radius: 8px;
          background: rgba(109, 93, 252, 0.12);
          color: #fff;
          font-size: 13px;
          font-weight: 700;
          cursor: pointer;
          font-family: inherit;
          transition: background 0.15s;
        }
        #reelax-auto-map-panel .ramp-toggle-btn:hover { opacity: 0.9; }
        #reelax-auto-map-panel .ramp-toggle-btn[data-enabled='true'] {
          background: ${colors.accent};
        }
        #reelax-auto-map-panel .ramp-secondary-btn {
          width: 100%;
          margin-top: 9px;
          padding: 7px 10px;
          border: 1px solid rgba(109, 93, 252, 0.55);
          border-radius: 7px;
          background: rgba(109, 93, 252, 0.12);
          color: #b9b5ff;
          font-size: 11px;
          font-weight: 700;
          cursor: pointer;
          font-family: inherit;
          transition: background 0.15s;
        }
        #reelax-auto-map-panel .ramp-secondary-btn:hover {
          background: rgba(109, 93, 252, 0.22);
        }
        #reelax-auto-map-panel .ramp-secondary-btn:disabled { opacity: 0.5; cursor: not-allowed; }
        /* Hint */
        #reelax-auto-map-panel .ramp-hint {
          text-align: center;
          color: rgba(255, 255, 255, 0.42);
          font-size: 11px;
          margin-top: 9px;
        }
        /* Indicator */
        #reelax-auto-map-panel .ramp-indicator {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          display: inline-block;
          margin-right: 5px;
          vertical-align: middle;
        }
        #reelax-auto-map-panel .ramp-indicator.idle { background: ${colors.textDim}; }
        #reelax-auto-map-panel .ramp-indicator.checking { background: ${colors.warn}; animation: ramp-pulse 1s infinite; }
        #reelax-auto-map-panel .ramp-indicator.success { background: ${colors.success}; }
        #reelax-auto-map-panel .ramp-indicator.switched { background: ${colors.accent}; }
        #reelax-auto-map-panel .ramp-indicator.error { background: ${colors.error}; }
        @keyframes ramp-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
        /* Error message */
        #reelax-auto-map-panel .ramp-error-msg {
          padding: 8px 12px;
          background: rgba(248, 113, 113, 0.1);
          border-radius: 7px;
          color: ${colors.error};
          font-size: 11px;
          margin-bottom: 8px;
        }
        /* Log/detail toggle */
        #reelax-auto-map-panel .ramp-section-toggle {
          cursor: pointer;
          color: ${colors.accent};
          font-weight: 600;
          font-family: inherit;
          font-size: 12px;
          user-select: none;
        }
        /* Minimized icon */
        #reelax-auto-map-icon {
          position: fixed;
          top: 16px;
          right: 16px;
          z-index: 999999;
          min-width: 48px;
          height: 48px;
          border-radius: 12px;
          background: rgba(18, 18, 24, 0.94);
          border: 1px solid rgba(255, 255, 255, 0.18);
          box-shadow: 0 10px 32px rgba(0, 0, 0, 0.42);
          backdrop-filter: blur(12px);
          -webkit-backdrop-filter: blur(12px);
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 5px;
          padding: 0 14px;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          transition: transform 0.2s ease, box-shadow 0.2s ease;
          user-select: none;
        }
        #reelax-auto-map-icon:hover {
          transform: scale(1.05);
          box-shadow: 0 6px 28px rgba(0, 0, 0, 0.5);
        }
        #reelax-auto-map-icon .ramp-icon-emoji { font-size: 22px; flex-shrink: 0; }
        #reelax-auto-map-icon .ramp-icon-indicator {
          position: absolute;
          bottom: 2px;
          right: 2px;
          width: 10px;
          height: 10px;
          border-radius: 50%;
          border: 2px solid rgba(18, 18, 24, 0.94);
        }
        #reelax-auto-map-icon .ramp-icon-indicator.idle { background: ${colors.textDim}; }
        #reelax-auto-map-icon .ramp-icon-indicator.checking { background: ${colors.warn}; animation: ramp-pulse 1s infinite; }
        #reelax-auto-map-icon .ramp-icon-indicator.success { background: ${colors.success}; }
        #reelax-auto-map-icon .ramp-icon-indicator.switched { background: ${colors.accent}; }
        #reelax-auto-map-icon .ramp-icon-indicator.error { background: ${colors.error}; }
        /* Refill inline row */
        #reelax-auto-map-panel .ramp-inline-group {
          display: flex;
          align-items: center;
          gap: 8px;
          margin-top: 10px;
        }
        #reelax-auto-map-panel .ramp-inline-label {
          font-size: 11px;
          color: rgba(255, 255, 255, 0.58);
          flex-shrink: 0;
        }
      </style>
      <div class="ramp-header">
        <div class="ramp-title">
          <span aria-hidden="true">🎣</span>
          <span>自动地图切换</span>
        </div>
        <div class="ramp-header-actions">
          <button class="ramp-collapse-toggle" id="ramp-export-log" type="button" title="导出控制台日志(.log文件)">⤓</button>
          <button class="ramp-collapse-toggle" id="ramp-minimize" type="button" title="最小化">−</button>
        </div>
      </div>
      <div class="ramp-tabbar" role="tablist">
        <button class="ramp-tab active" id="ramp-tab-status" type="button" role="tab">状态</button>
        <button class="ramp-tab" id="ramp-tab-settings" type="button" role="tab">设置</button>
      </div>
      <div class="ramp-body" id="ramp-body">
        <div class="ramp-page" id="ramp-page-settings" hidden>
          <div class="ramp-option-row" id="ramp-option-row-switch">
            <span class="ramp-option-text">
              <span>地图自动切换</span>
              <div class="ramp-option-desc">开启后自动选择最优地图</div>
            </span>
            <span class="ramp-switch" id="ramp-switch">
              <input type="checkbox" role="switch" aria-label="地图自动切换">
              <span class="ramp-switch-track"></span>
            </span>
          </div>

          <div class="ramp-option-row" id="ramp-option-row-sail">
            <span class="ramp-option-text">
              <span>船长自动开船</span>
              <div class="ramp-option-desc">船长/舵手时自动开船到最优图</div>
            </span>
            <span class="ramp-switch" id="ramp-sail-switch">
              <input type="checkbox" role="switch" aria-label="船长/舵手自动开船">
              <span class="ramp-switch-track"></span>
            </span>
          </div>

          <div class="ramp-option-row" id="ramp-option-row-mastery-select">
            <span class="ramp-option-text">
              <span>优选剔除专精增益</span>
              <div class="ramp-option-desc">选最优图时忽略地图专精点加成</div>
            </span>
            <span class="ramp-switch" id="ramp-mastery-select-switch">
              <input type="checkbox" role="switch" aria-label="优选剔除专精点增益">
              <span class="ramp-switch-track"></span>
            </span>
          </div>

          <div class="ramp-option-row" id="ramp-option-row-newscoring">
            <span class="ramp-option-text">
              <span>新优选评分(倍率×天气)</span>
              <div class="ramp-option-desc">开：金币=地图倍率×天气鱼系数(0.55/0.45)；关：旧编号即金币(0.6/0.4，保留雷暴优先级)</div>
            </span>
            <span class="ramp-switch" id="ramp-newscoring-switch">
              <input type="checkbox" role="switch" aria-label="新优选评分算法">
              <span class="ramp-switch-track"></span>
            </span>
          </div>

          <div class="ramp-option-row" id="ramp-option-row-official">
            <span class="ramp-option-text">
              <span>官方航线</span>
              <div class="ramp-option-desc">开启后把官方 routeAssistant 服务端推荐的目标图纳入选图（需在下方优先级链中保留“官方航线”）</div>
            </span>
            <span class="ramp-switch" id="ramp-official-switch">
              <input type="checkbox" role="switch" aria-label="官方航线">
              <span class="ramp-switch-track"></span>
            </span>
          </div>

          <div class="ramp-option-row" id="ramp-option-row-expparty">
            <span class="ramp-option-text">
              <span>经验优选·计船队加成</span>
              <div class="ramp-option-desc">经验优选评分时按船队加成(partyBonus)计入总额；跟船才加成</div>
            </span>
            <span class="ramp-switch" id="ramp-expparty-switch">
              <input type="checkbox" role="switch" aria-label="经验优选计船队加成">
              <span class="ramp-switch-track"></span>
            </span>
          </div>

          <div class="ramp-option-row" id="ramp-option-row-expmaplvl">
            <span class="ramp-option-text">
              <span>经验优选·计地图号位</span>
              <div class="ramp-option-desc">经验优选额外按地图号位乘一个经验倍率（无官方明确字段，默认关）</div>
            </span>
            <span class="ramp-switch" id="ramp-expmaplvl-switch">
              <input type="checkbox" role="switch" aria-label="经验优选计地图号位">
              <span class="ramp-switch-track"></span>
            </span>
          </div>

          <div class="ramp-option-row" id="ramp-option-row-expgreedy">
            <span class="ramp-option-text">
              <span>经验优选·贪婪模式</span>
              <div class="ramp-option-desc">经验优选只看「专精×天气」选图；仅天气剩≥30分才生效，开增益最多1份，船在该图则按原模式开足</div>
            </span>
            <span class="ramp-switch" id="ramp-expgreedy-switch">
              <input type="checkbox" role="switch" aria-label="经验优选贪婪模式">
              <span class="ramp-switch-track"></span>
            </span>
          </div>

          <div class="ramp-option-row" id="ramp-option-row-refill">
            <span class="ramp-option-text">
              <span>杆数自动补满</span>
              <div class="ramp-option-desc">杆数低于阈值时自动点击补满</div>
            </span>
            <span class="ramp-switch" id="ramp-refill-switch">
              <input type="checkbox" role="switch" aria-label="杆数自动补满">
              <span class="ramp-switch-track"></span>
            </span>
          </div>

          <div class="ramp-option-row" id="ramp-option-row-dismiss">
            <span class="ramp-option-text">
              <span>赛事弹窗稍后处理</span>
              <div class="ramp-option-desc">比赛弹窗自动点击稍后处理</div>
            </span>
            <span class="ramp-switch" id="ramp-dismiss-switch">
              <input type="checkbox" role="switch" aria-label="赛事弹窗稍后处理">
              <span class="ramp-switch-track"></span>
            </span>
          </div>

          <div class="ramp-option-row" id="ramp-option-row-checkin">
            <span class="ramp-option-text">
              <span>每日签到自动领取</span>
              <div class="ramp-option-desc">凌晨签到弹窗自动领取奖励</div>
            </span>
            <span class="ramp-switch" id="ramp-checkin-switch">
              <input type="checkbox" role="switch" aria-label="每日签到自动领取">
              <span class="ramp-switch-track"></span>
            </span>
          </div>

          <div class="ramp-option-row" id="ramp-option-row-offline">
            <span class="ramp-option-text">
              <span>离线结算弹窗自动处理</span>
              <div class="ramp-option-desc">离线结算弹窗自动点击去钓鱼或关闭</div>
            </span>
            <span class="ramp-switch" id="ramp-offline-switch">
              <input type="checkbox" role="switch" aria-label="离线结算弹窗自动处理">
              <span class="ramp-switch-track"></span>
            </span>
          </div>

          <div class="ramp-section" id="ramp-section-priority">
            <div class="ramp-collapsible-header" id="ramp-collapse-priority">
              <span>地图优先级</span>
              <span class="ramp-collapse-arrow">›</span>
            </div>
            <div class="ramp-collapsible-content">
              <div class="ramp-priority-list" id="ramp-priority-list"></div>
              <div class="ramp-priority-hint">点击箭头调整顺序，上方优先级更高。默认：赛事 > 跟船 > 官方航线 > 优选（官方航线需先在上方开启“官方航线”开关才会参与选图）</div>
            </div>
          </div>

          <div class="ramp-section" id="ramp-section-bait">
            <div class="ramp-collapsible-header" id="ramp-collapse-bait">
              <span>地图鱼饵</span>
              <span class="ramp-collapse-arrow">›</span>
            </div>
            <div class="ramp-collapsible-content">
              <div class="ramp-bait-list" id="ramp-bait-list"></div>
              <div class="ramp-priority-hint">按地图类型配置鱼饵，切换地图时自动选择对应鱼饵</div>
            </div>
          </div>
        </div>
        <div class="ramp-page active" id="ramp-page-status">
        <div class="ramp-section">
          <div class="ramp-section-title">
            <span>
              <span class="ramp-indicator idle" id="ramp-indicator"></span>
              运行状态
            </span>
            <select class="ramp-interval-select" id="ramp-interval">
              <option value="15000">15秒</option>
              <option value="30000" selected>30秒</option>
              <option value="60000">60秒</option>
              <option value="120000">2分钟</option>
            </select>
          </div>
          <div id="ramp-error-display"></div>
          <div id="ramp-status"></div>
        </div>

        <div class="ramp-section">
          <div class="ramp-section-title">
            <span>地图列表</span>
            <span style="display:flex;align-items:center;gap:10px;">
              <span class="ramp-section-toggle" id="ramp-detail-copy" title="复制地图详情">复制</span>
              <span class="ramp-section-toggle" id="ramp-detail-toggle">详情</span>
            </span>
          </div>
          <div id="ramp-detail"></div>
        </div>

        <div class="ramp-section">
          <div class="ramp-section-title">
            <span>操作日志</span>
            <span class="ramp-section-toggle" id="ramp-log-toggle">折叠</span>
          </div>
          <div class="ramp-log" id="ramp-log"></div>
        </div>

        <button class="ramp-toggle-btn" id="ramp-switch-now" type="button">立即切换</button>
        <button class="ramp-secondary-btn" id="ramp-check-now" type="button">手动检查</button>
        <div class="ramp-hint" id="ramp-hint-text"></div>
        </div>
      </div>
    `;
    document.body.appendChild(panelEl);

    // 创建最小化图标
    minimizedIconEl = document.createElement('div');
    minimizedIconEl.id = 'reelax-auto-map-icon';
    minimizedIconEl.title = '展开面板';
    minimizedIconEl.innerHTML = '<span class="ramp-icon-emoji">\ud83c\udfa3</span><span class="ramp-icon-indicator idle"></span>';
    minimizedIconEl.style.display = 'none';
    // 恢复保存的图标位置
    if (state.iconPos) {
      minimizedIconEl.style.left = state.iconPos.left + 'px';
      minimizedIconEl.style.top = state.iconPos.top + 'px';
      minimizedIconEl.style.right = 'auto';
      minimizedIconEl.style.bottom = 'auto';
    }
    document.body.appendChild(minimizedIconEl);

    // 加载持久化状态
    loadSavedState();

    // 应用已保存的轮询间隔
    const intervalSelect = document.getElementById('ramp-interval');
    if (intervalSelect) {
      intervalSelect.value = String(state.pollInterval);
    }

    // 应用日志折叠初始状态
    const logToggle = document.getElementById('ramp-log-toggle');
    if (logToggle) {
      logToggle.textContent = state.showLog ? '\u6298\u53e0' : '\u5c55\u5f00';
      document.getElementById('ramp-log').style.display = state.showLog ? 'block' : 'none';
    }

    // 绑定事件
    bindEvents();
    makeDraggable();

    // 初始UI更新
    updateUI();

    // 应用最小化状态
    if (state.minimized) {
      applyMinimized(true);
    }

    // 如果之前开启了自动切换，恢复运行
    if (state.autoSwitch) {
      console.log('[AutoMap] 恢复自动切换状态');
      startPolling();
      log('\u81ea\u52a8\u5207\u6362\u5df2\u6062\u590d', 'success');
    }

    // 如果之前开启了杆数补满，恢复运行
    if (state.autoRefill) {
      console.log('[AutoMap] 恢复杆数自动补满');
      startRodMonitor();
      log(`\u6746\u6570\u81ea\u52a8\u8865\u6ee1\u5df2\u6062\u590d\uff0c\u8865\u6ee1\u9608\u503c\u4e3a\u5269\u4f59\u4e0d\u8db3\u4e00\u534a`, 'success');
    }

    // 如果之前开启了赛事弹窗稍后处理，恢复运行（默认开启）
    if (state.autoDismissCompetition) {
      console.log('[AutoMap] 恢复赛事弹窗自动稍后处理');
      startCompetitionPopupMonitor();
      log('\u8d5b\u4e8b\u5f39\u7a97\u81ea\u52a8\u7a0d\u540e\u5904\u7406\u5df2\u6062\u590d', 'success');
    }

    // 如果之前开启了每日签到自动领取，恢复运行（默认开启）
    if (state.autoCheckIn) {
      console.log('[AutoMap] 恢复每日签到自动领取');
      startCheckInMonitor();
      log('每日签到自动领取已恢复', 'success');
    }

    // 如果之前开启了离线结算弹窗自动处理，恢复运行（默认开启）
    if (state.autoDismissOffline) {
      console.log('[AutoMap] 恢复离线结算弹窗自动处理');
      startOfflineSummaryMonitor();
      log('离线结算弹窗自动处理已恢复', 'success');
    }

    // 渲染优先级列表
    renderPriorityList();

    // 渲染鱼饵配置列表
    renderBaitList();

    // 应用可折叠区域状态
    applyCollapseState();

    // 绑定折叠点击事件
    bindCollapseToggles();

    // 应用初始页面
    switchPage('status');

    if (!state.autoSwitch && !state.autoRefill) {
      log('\u811a\u672c\u5df2\u52a0\u8f7d\uff0c\u70b9\u51fb\u5f00\u5173\u542f\u7528\u529f\u80fd', 'info');
    }
  }

  function bindEvents() {
    // Tab 切换
    document.getElementById('ramp-tab-status').addEventListener('click', () => {
      switchPage('status');
    });
    document.getElementById('ramp-tab-settings').addEventListener('click', () => {
      switchPage('settings');
    });

    // 导出控制台日志（由 scripts/日志收集.js 提供）
    const exportLogBtn = document.getElementById('ramp-export-log');
    if (exportLogBtn) {
      exportLogBtn.addEventListener('click', () => {
        if (window.__reelaxLog && window.__reelaxLog.download) {
          window.__reelaxLog.download();
          log(`已导出控制台日志 (${window.__reelaxLog.size()} 行)`, 'success');
        } else {
          log('日志收集器未注入，请刷新页面', 'error');
        }
      });
    }

    // 开关
    document.getElementById('ramp-switch').addEventListener('click', () => {
      state.autoSwitch = !state.autoSwitch;
      if (state.autoSwitch) {
        startPolling();
        log('\u81ea\u52a8\u5207\u6362\u5df2\u5f00\u542f', 'success');
      } else {
        stopPolling();
        log('\u81ea\u52a8\u5207\u6362\u5df2\u5173\u95ed', 'info');
      }
      saveState();
      updateUI();
    });

    // 船长/舵手自动开船开关
    document.getElementById('ramp-sail-switch').addEventListener('click', () => {
      state.autoSail = !state.autoSail;
      if (state.autoSail) {
        log('\u8239\u957f/\u8238\u624b\u81ea\u52a8\u5f00\u8239\u5df2\u5f00\u542f', 'success');
      } else {
        log('\u8239\u957f/\u8238\u624b\u81ea\u52a8\u5f00\u8239\u5df2\u5173\u95ed', 'info');
      }
      saveState();
      updateUI();
    });

    // 优选选图剔除专精增益开关（默认开：选最优图时忽略地图专精点加成）
    document.getElementById('ramp-mastery-select-switch').addEventListener('click', () => {
      state.excludeMasteryInSelect = !state.excludeMasteryInSelect;
      if (state.excludeMasteryInSelect) {
        log('\u4f18\u9009\u5df2\u5254\u9664\u4e13\u7cbe\u70b9\u589e\u76ca', 'success');
      } else {
        log('\u4f18\u9009\u6062\u590d\u8ba1\u5165\u4e13\u7cbe\u70b9\u589e\u76ca', 'info');
      }
      saveState();
      updateUI();
    });

    // 新优选评分算法开关：开=新算法(倍率×天气鱼系数)；关=旧算法(编号即金币+雷暴优先级)
    document.getElementById('ramp-newscoring-switch').addEventListener('click', () => {
      state.useNewScoring = !state.useNewScoring;
      // 切换算法后按当前算法归一化优先级链（新算法移除 tempest，旧算法加入 tempest）——【修复：保留用户顺序，不重置默认】
      const fullChain = state.useNewScoring
        ? ['competition', 'followboat', 'official', 'optimal', 'experience']
        : ['competition', 'followboat', 'official', 'tempest', 'optimal', 'experience'];
      state.mapPriority = state.mapPriority.filter(p => fullChain.includes(p));
      for (const p of fullChain) { if (!state.mapPriority.includes(p)) state.mapPriority.push(p); }
      if (state.useNewScoring) {
        log('优选评分=新算法(倍率×天气鱼系数, 0.55/0.45)', 'success');
      } else {
        log('优选评分=旧算法(编号即金币, 0.6/0.4, 保留雷暴)', 'info');
      }
      saveState();
      updateUI();
    });

    // 官方航线开关：默认关。开启后把官方 routeAssistant.travel() 服务端推荐的目标图纳入选图；
    // 关闭时仅不参与选图，但仍会在地图列表顶部显示官方推荐（参考）。
    document.getElementById('ramp-official-switch').addEventListener('click', () => {
      state.useOfficialRoute = !state.useOfficialRoute;
      if (state.useOfficialRoute) {
        log('官方航线已开启（按优先级链使用官方服务端推荐目标图）', 'success');
      } else {
        log('官方航线已关闭（地图列表仍显示官方推荐，仅供参考）', 'info');
      }
      // 开关变化后刷新一次官方规划缓存（关闭时保留显示，不用清空）
      prefetchOfficialRoute().then(() => updateUI()).catch(() => {});
      saveState();
      updateUI();
    });

    // 经验优选·计船队加成开关
    document.getElementById('ramp-expparty-switch').addEventListener('click', () => {
      state.expPriorityIncludePartyBonus = !state.expPriorityIncludePartyBonus;
      log(state.expPriorityIncludePartyBonus ? '经验优选已计入船队加成（跟船才加成）' : '经验优选不计船队加成', state.expPriorityIncludePartyBonus ? 'success' : 'info');
      saveState();
      updateUI();
    });

    // 经验优选·计地图号位开关
    document.getElementById('ramp-expmaplvl-switch').addEventListener('click', () => {
      state.expPriorityIncludeMapLevel = !state.expPriorityIncludeMapLevel;
      log(state.expPriorityIncludeMapLevel ? '经验优选已计入地图号位经验倍率' : '经验优选不计地图号位经验倍率', state.expPriorityIncludeMapLevel ? 'success' : 'info');
      saveState();
      updateUI();
    });

    // 经验优选贪婪模式开关
    document.getElementById('ramp-expgreedy-switch').addEventListener('click', () => {
      state.expGreedyMode = !state.expGreedyMode;
      log(state.expGreedyMode ? '经验优选贪婪模式已开启：只按专精×天气选图，增益最多1份' : '经验优选贪婪模式已关闭', state.expGreedyMode ? 'success' : 'info');
      saveState();
      updateUI();
    });

    // 杆数自动补满开关
    document.getElementById('ramp-refill-switch').addEventListener('click', () => {
      state.autoRefill = !state.autoRefill;
      if (state.autoRefill) {
        startRodMonitor();
        log(`\u6746\u6570\u81ea\u52a8\u8865\u6ee1\u5df2\u5f00\u542f\uff0c\u8865\u6ee1\u9608\u503c\u4e3a\u5269\u4f59\u4e0d\u8db3\u4e00\u534a`, 'success');
      } else {
        stopRodMonitor();
        log('\u6746\u6570\u81ea\u52a8\u8865\u6ee1\u5df2\u5173\u95ed', 'info');
      }
      saveState();
      updateUI();
    });

    // 最小化 - 收起为图标
    document.getElementById('ramp-minimize').addEventListener('click', () => {
      applyMinimized(true);
      saveState();
    });

    // 点击图标展开 / 拖拽移动
    makeIconDraggable();

    // 间隔选择
    document.getElementById('ramp-interval').addEventListener('change', (e) => {
      state.pollInterval = parseInt(e.target.value);
      saveState();
      if (state.autoSwitch) {
        startPolling();
        log(`\u68c0\u67e5\u95f4\u9694\u5df2\u8c03\u6574\u4e3a ${state.pollInterval / 1000}\u79d2`, 'info');
      }
    });

    // 手动检查
    document.getElementById('ramp-check-now').addEventListener('click', () => {
      if (!state.isChecking) {
        checkAndSwitch();
      }
    });

    // 立即切换
    document.getElementById('ramp-switch-now').addEventListener('click', async () => {
      if (state.isChecking) return;
      if (!state.bestBiomeId || state.bestBiomeId === state.currentBiomeId) {
        // 没有缓存数据，先检查
        await checkAndSwitch();
      }
      // 检查完后如果需要切换
      if (state.bestBiomeId && state.bestBiomeId !== state.currentBiomeId) {
        // checkAndSwitch已经执行了切换
      }
    });

    // 详情展开/折叠（渲染由 updateDetailUI 统一处理：折叠=精简列表，展开=完整表格）
    document.getElementById('ramp-detail-toggle').addEventListener('click', () => {
      state.showDetail = !state.showDetail;
      updateDetailUI();
    });

    // 复制地图详情
    document.getElementById('ramp-detail-copy').addEventListener('click', () => {
      const rows = state.biomeDetails.map(d => {
        const compMark = d.hasCompetition ? ' \u2693' : '';
        const goldMark = d.hasGoldWind ? ' \u{1fa99}' : '';
        const arcaneMark = d.hasArcane ? ' \u2726' : '';
        const goldPct = Math.round(d.goldScore * 100) + '%';
        const scorePct = Math.round(d.score * 100) + '%';
        return [
          `${d.label} ${d.name}${compMark}${goldMark}${arcaneMark}`,
          formatBonus(d.breakdown.weather),
          formatBonus(d.breakdown.guildTotem + d.breakdown.guildBoost),
          formatBonus(d.breakdown.mastery),
          goldPct,
          formatBonus(d.expBonus),
          scorePct,
        ].join('\t');
      });
      const header = ['地图', '天气', '公会', '精通', '金币', '总计', '综合'].join('\t');
      const text = '地图列表\n' + header + '\n' + rows.join('\n');
      navigator.clipboard.writeText(text).then(() => {
        log('地图详情已复制到剪贴板', 'success');
      }).catch(() => {
        // 降级：textarea 方式复制
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        try {
          document.execCommand('copy');
          log('地图详情已复制到剪贴板', 'success');
        } catch (_) {
          log('复制失败，请手动复制', 'warn');
        }
        document.body.removeChild(ta);
      });
    });

    // 日志展开/折叠
    document.getElementById('ramp-log-toggle').addEventListener('click', () => {
      state.showLog = !state.showLog;
      const el = document.getElementById('ramp-log');
      const toggle = document.getElementById('ramp-log-toggle');
      el.style.display = state.showLog ? 'block' : 'none';
      toggle.textContent = state.showLog ? '\u6298\u53e0' : '\u5c55\u5f00';
    });

    // 赛事弹窗稍后处理开关
    document.getElementById('ramp-dismiss-switch').addEventListener('click', () => {
      state.autoDismissCompetition = !state.autoDismissCompetition;
      if (state.autoDismissCompetition) {
        startCompetitionPopupMonitor();
        log('\u8d5b\u4e8b\u5f39\u7a97\u81ea\u52a8\u7a0d\u540e\u5904\u7406\u5df2\u5f00\u542f', 'success');
      } else {
        stopCompetitionPopupMonitor();
        log('\u8d5b\u4e8b\u5f39\u7a97\u81ea\u52a8\u7a0d\u540e\u5904\u7406\u5df2\u5173\u95ed', 'info');
      }
      saveState();
      updateUI();
    });

    // 每日签到自动领取开关
    document.getElementById('ramp-checkin-switch').addEventListener('click', () => {
      state.autoCheckIn = !state.autoCheckIn;
      if (state.autoCheckIn) {
        startCheckInMonitor();
        log('每日签到自动领取已开启', 'success');
      } else {
        stopCheckInMonitor();
        log('每日签到自动领取已关闭', 'info');
      }
      saveState();
      updateUI();
    });

    // 离线结算弹窗自动处理开关
    document.getElementById('ramp-offline-switch').addEventListener('click', () => {
      state.autoDismissOffline = !state.autoDismissOffline;
      if (state.autoDismissOffline) {
        startOfflineSummaryMonitor();
        log('离线结算弹窗自动处理已开启', 'success');
      } else {
        stopOfflineSummaryMonitor();
        log('离线结算弹窗自动处理已关闭', 'info');
      }
      saveState();
      updateUI();
    });
  }

  function makeDraggable() {
    const header = panelEl.querySelector('.ramp-header');
    let isDragging = false;
    let startX, startY, startLeft, startTop;

    header.addEventListener('mousedown', (e) => {
      if (e.target.tagName === 'BUTTON') return;
      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      const rect = panelEl.getBoundingClientRect();
      startLeft = rect.left;
      startTop = rect.top;
      panelEl.style.transition = 'none';
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      let newLeft = startLeft + dx;
      let newTop = startTop + dy;
      // 边界约束
      newLeft = Math.max(0, Math.min(window.innerWidth - 60, newLeft));
      newTop = Math.max(0, Math.min(window.innerHeight - 40, newTop));
      panelEl.style.left = newLeft + 'px';
      panelEl.style.top = newTop + 'px';
      panelEl.style.right = 'auto';
      panelEl.style.bottom = 'auto';
    });

    document.addEventListener('mouseup', () => {
      if (isDragging) {
        isDragging = false;
        panelEl.style.transition = '';
      }
    });
  }

  function makeIconDraggable() {
    let isDragging = false;
    let hasMoved = false;
    let startX, startY, startLeft, startTop;

    minimizedIconEl.addEventListener('mousedown', (e) => {
      isDragging = true;
      hasMoved = false;
      startX = e.clientX;
      startY = e.clientY;
      const rect = minimizedIconEl.getBoundingClientRect();
      startLeft = rect.left;
      startTop = rect.top;
      minimizedIconEl.style.transition = 'none';
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      // 移动超过4px才视为拖拽
      if (!hasMoved && Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
      hasMoved = true;
      const iconWidth = minimizedIconEl.offsetWidth || 48;
      let newLeft = startLeft + dx;
      let newTop = startTop + dy;
      // 边界约束
      newLeft = Math.max(0, Math.min(window.innerWidth - iconWidth, newLeft));
      newTop = Math.max(0, Math.min(window.innerHeight - 48, newTop));
      minimizedIconEl.style.left = newLeft + 'px';
      minimizedIconEl.style.top = newTop + 'px';
      minimizedIconEl.style.right = 'auto';
      minimizedIconEl.style.bottom = 'auto';
    });

    document.addEventListener('mouseup', () => {
      if (!isDragging) return;
      isDragging = false;
      minimizedIconEl.style.transition = '';
      if (hasMoved) {
        // 拖拽结束，保存位置
        const rect = minimizedIconEl.getBoundingClientRect();
        state.iconPos = { left: rect.left, top: rect.top };
        saveState();
      } else {
        // 未拖动，视为点击 → 展开面板
        applyMinimized(false);
        saveState();
      }
    });
  }

  function updateStatusIndicator(status) {
    const el = document.getElementById('ramp-indicator');
    if (el) {
      el.className = 'ramp-indicator ' + status;
    }
    // 同步更新最小化图标上的指示器
    const iconIndicator = minimizedIconEl?.querySelector('.ramp-icon-indicator');
    if (iconIndicator) {
      iconIndicator.className = 'ramp-icon-indicator ' + status;
    }
  }

  // 应用最小化/展开状态
  function applyMinimized(minimized) {
    state.minimized = minimized;
    if (minimized) {
      panelEl.style.display = 'none';
      minimizedIconEl.style.display = 'flex';
    } else {
      panelEl.style.display = 'flex';
      minimizedIconEl.style.display = 'none';
    }
  }

  function formatBonus(basisPoints) {
    if (basisPoints === 0) return '+0%';
    const pct = (basisPoints / 100).toFixed(1);
    // 负数加成（如金风 -25%）：显示 -25.0% 而非 +-25.0%
    return (basisPoints > 0 ? '+' : '') + pct + '%';
  }

  // 带符号经验百分比：+50.0% / -25.0% / +0.0%（用于日志拼接）
  function formatExpPct(basisPoints) {
    if (!basisPoints) return '+0.0%';
    const pct = (basisPoints / 100).toFixed(1);
    return (basisPoints > 0 ? '+' : '') + pct + '%';
  }

  function updateUI() {
    updateStatusUI();
    updateDetailUI();
    renderBaitList();
  }

  function updateStatusUI() {
    const el = document.getElementById('ramp-status');
    if (!el) return;

    // 更新复选框开关状态
    const setSwitchChecked = (id, checked) => {
      const wrapper = document.getElementById(id);
      if (wrapper) {
        const input = wrapper.querySelector('input[type="checkbox"]');
        if (input) input.checked = checked;
      }
    };
    setSwitchChecked('ramp-switch', state.autoSwitch);
    setSwitchChecked('ramp-sail-switch', state.autoSail);
    setSwitchChecked('ramp-mastery-select-switch', state.excludeMasteryInSelect);
    setSwitchChecked('ramp-newscoring-switch', state.useNewScoring);
    setSwitchChecked('ramp-official-switch', state.useOfficialRoute);
    setSwitchChecked('ramp-expparty-switch', state.expPriorityIncludePartyBonus);
    setSwitchChecked('ramp-expmaplvl-switch', state.expPriorityIncludeMapLevel);
    setSwitchChecked('ramp-expgreedy-switch', state.expGreedyMode);
    setSwitchChecked('ramp-refill-switch', state.autoRefill);
    setSwitchChecked('ramp-dismiss-switch', state.autoDismissCompetition);
    setSwitchChecked('ramp-checkin-switch', state.autoCheckIn);
    setSwitchChecked('ramp-offline-switch', state.autoDismissOffline);

    let html = '';

    // 错误信息
    if (state.errorMessage) {
      const errorEl = document.getElementById('ramp-error-display');
      if (errorEl) {
        errorEl.innerHTML = `<div class="ramp-error-msg">${state.errorMessage}</div>`;
      }
    } else {
      const errorEl = document.getElementById('ramp-error-display');
      if (errorEl) errorEl.innerHTML = '';
    }

    // 当前地图
    if (state.currentBiomeId) {
      const detail = state.biomeDetails.find(d => d.id === state.currentBiomeId);
      const bonus = detail ? formatBonus(detail.expBonus) : '--';
      const compBadge = detail && detail.hasCompetition ? '<span class="ramp-badge ramp-badge-comp">\u8d5b\u4e8b</span>' : '';
      const goldBadge = detail && detail.hasGoldWind ? '<span class="ramp-badge ramp-badge-gold">\u91d1\u98ce</span>' : '';
      const arcaneBadge = detail && detail.hasArcane ? '<span class="ramp-badge ramp-badge-arcane">\u5965\u672f\u6d8c\u52a8</span>' : '';
      html += `
        <div class="ramp-row">
          <span class="ramp-label">\u5f53\u524d\u5730\u56fe</span>
          <span class="ramp-value">${detail ? detail.label : ''} ${detail ? detail.name : state.currentBiomeId}${compBadge}${goldBadge}${arcaneBadge}</span>
        </div>
        <div class="ramp-row">
          <span class="ramp-label">\u5f53\u524d\u7ecf\u9a8c\u52a0\u6210</span>
          <span class="ramp-value ramp-bonus">${bonus}</span>
        </div>
      `;
    } else {
      html += `
        <div class="ramp-row">
          <span class="ramp-label">\u5f53\u524d\u5730\u56fe</span>
          <span class="ramp-value">\u672a\u77e5</span>
        </div>
      `;
    }

    // 组队船信息（无船则不显示）
    if (state.partyInfo && state.partyInfo.isInParty) {
      const p = state.partyInfo;
      const roleName = p.role === 'captain' ? '\u8239\u957f' : (p.role === 'helmsman' ? '\u8238\u624b' : '\u8239\u5458');
      const sailHint = state.autoSail && (p.role === 'captain' || p.role === 'helmsman') ? ' \u00b7 \u81ea\u52a8\u5f00\u8239' : '';
      html += `
        <div class="ramp-row">
          <span class="ramp-label">\u7ec4\u961f\u8239</span>
          <span class="ramp-value">${p.boatName || '\u8239'} \u00b7 ${roleName}${sailHint} \u00b7 ${getBiomeName(p.boatBiomeId)} (${p.boatBiomeId})</span>
        </div>
      `;
    }

    // 最优地图
    if (state.bestBiomeId) {
      const detail = state.biomeDetails.find(d => d.id === state.bestBiomeId);
      const bonus = detail ? formatBonus(detail.expBonus) : '--';
      const compBadge = detail && detail.hasCompetition ? '<span class="ramp-badge ramp-badge-comp">\u8d5b\u4e8b</span>' : '';
      const goldBadge = detail && detail.hasGoldWind ? '<span class="ramp-badge ramp-badge-gold">\u91d1\u98ce</span>' : '';
      const arcaneBadge = detail && detail.hasArcane ? '<span class="ramp-badge ramp-badge-arcane">\u5965\u672f\u6d8c\u52a8</span>' : '';
      html += `
        <div class="ramp-row">
          <span class="ramp-label">\u6700\u4f18\u5730\u56fe</span>
          <span class="ramp-value">${detail ? detail.label : ''} ${detail ? detail.name : state.bestBiomeId}<span class="ramp-badge ramp-badge-best">${state.bestReason}</span>${compBadge}${goldBadge}${arcaneBadge}</span>
        </div>
        <div class="ramp-row">
          <span class="ramp-label">\u6700\u4f18\u7ecf\u9a8c\u52a0\u6210</span>
          <span class="ramp-value ramp-bonus">${bonus}</span>
        </div>
      `;
    } else if (state.bestReason === '无需切换') {
      // 未加入公会且存在公会赛事地图时，显示跳过提示
      const noGuildHint = state.guildCompetitionSkipped
        ? '<span style="color:' + getThemeColors().textDim + ';">（未加入公会，已跳过公会赛事地图）</span>'
        : '';
      html += `
        <div class="ramp-row">
          <span class="ramp-label">\u6700\u4f18\u5730\u56fe</span>
          <span class="ramp-value" style="color:${getThemeColors().textDim};">无需切换，保持当前地图 ${noGuildHint}</span>
        </div>
      `;
    }

    // 当前鱼饵
    if (state.currentBaitId) {
      const baitName = getBaitName(state.currentBaitId);
      const configuredBait = state.currentBaitType ? state.baitMap[state.currentBaitType] : null;
      const mismatch = configuredBait && configuredBait !== state.currentBaitId;
      const baitStyle = mismatch ? `color:${getThemeColors().accent};font-weight:600;` : '';
      html += `
        <div class="ramp-row">
          <span class="ramp-label">\u5f53\u524d\u9c7c\u9975</span>
          <span class="ramp-value" style="${baitStyle}">${baitName}${mismatch ? ` → ${getBaitName(configuredBait)}` : ''}</span>
        </div>
      `;
    }

    // 最后检查时间
    if (state.lastCheckTime) {
      const timeStr = `${String(state.lastCheckTime.getHours()).padStart(2, '0')}:${String(state.lastCheckTime.getMinutes()).padStart(2, '0')}:${String(state.lastCheckTime.getSeconds()).padStart(2, '0')}`;
      html += `
        <div class="ramp-row">
          <span class="ramp-label">\u4e0a\u6b21\u68c0\u67e5</span>
          <span class="ramp-value" style="font-size:11px;color:${getThemeColors().textDim};">${timeStr}</span>
        </div>
      `;
    }

    el.innerHTML = html;

    // 设置切换按钮状态指示
    const toggleBtn = document.getElementById('ramp-switch-now');
    if (toggleBtn) {
      toggleBtn.setAttribute('data-enabled', state.autoSwitch ? 'true' : 'false');
    }
  }

  function updateDetailUI() {
    const el = document.getElementById('ramp-detail');
    const toggle = document.getElementById('ramp-detail-toggle');
    if (!el) return;

    // 官方推荐线路横幅（始终显示：无论官方航线开关是否开启，只要服务端有规划就展示）
    // 与「是否参与选图」解耦——这里只做参考展示。
    // 三行布局：①推荐理由 ②目标图 ③计划时间（仅当服务端返回 deferred 且给定 executeAt 时才有）。
    // executeAt 含义：服务端预约「延后到该绝对时刻再换图」的执行点（比赛前/天气窗口前），非倒计时过程字段；
    // 其余状态（已换图/不变/无目标）不显示计划行。
    let officialBanner = '';
    const oPlan = state.officialRoute;
    if (oPlan && oPlan.targetBiomeId) {
      const oName = getBiomeName(oPlan.targetBiomeId);
      const oReason = oPlan.reason === 'competition' ? '比赛优先'
        : oPlan.reason === 'golden' ? '金风'
        : oPlan.reason === 'experience' ? '经验优先' : '官方推荐';
      // 计划行：仅 deferred + executeAt 存在时显示（服务端预约换图时刻）
      const oPlanLine = (oPlan.status === 'deferred' && oPlan.executeAt)
        ? '<div class="ramp-official-route-line ramp-official-route-plan">计划：'
          + (new Date(oPlan.executeAt).toLocaleString('zh-CN', { hour12: false }))
          + '</div>'
        : '';
      officialBanner = `
        <div class="ramp-official-route" role="status">
          <div class="ramp-official-route-line"><span class="ramp-official-route-tag">官方</span>${oReason}　目标：${oName}</div>
          ${oPlanLine}
        </div>
      `;
    }

    // 折叠态只显示地图+综合分；展开态显示完整详情表格
    const toggleText = state.showDetail ? '\u6298\u53e0' : '\u8be6\u60c5';
    if (toggle) toggle.textContent = toggleText;

    if (state.biomeDetails.length === 0) {
      el.innerHTML = officialBanner + '<div style="color:' + getThemeColors().textDim + ';font-size:11px;padding:8px 0;">\u70b9\u51fb\u201c\u624b\u52a8\u68c0\u67e5\u201d\u83b7\u53d6\u6570\u636e</div>';
      return;
    }

    if (!state.showDetail) {
      // 折叠：精简列表（地图名 + 综合分），best/current 高亮
      let rows = '';
      for (const d of state.biomeDetails) {
        const cls = [];
        if (d.isCurrent) cls.push('current');
        if (d.id === state.bestBiomeId) cls.push('best');
        const compMark = d.hasCompetition ? ' \u2693' : '';
        const goldMark = d.hasGoldWind ? ' \u{1fa99}' : '';
        const arcaneMark = d.hasArcane ? ' \u2726' : '';
        const scorePct = Math.round(d.score * 100) + '%';
        rows += `
          <div class="ramp-detail-mini ${cls.join(' ')}">
            <span>${d.label} ${d.name}${compMark}${goldMark}${arcaneMark}</span>
            <span class="ramp-detail-mini-score">${scorePct}</span>
          </div>
        `;
      }
      el.innerHTML = officialBanner + `
        <div class="ramp-detail-mini-list">
          ${rows}
        </div>
        <div style="font-size:10px;color:${getThemeColors().textDim};margin-top:4px;">
          \u70b9\u201c\u8be6\u60c5\u201d\u5c55\u5f00\u5b8c\u6574\u5206\u6790 | \u540d\u540e\u6570\u5b57=\u7efc\u5408(${state.useNewScoring ? '0.55×经验+0.45×倍率×天气' : '0.6×经验+0.4×编号金币'})
        </div>
      `;
      return;
    }

    let html = `
      <table class="ramp-detail-table">
        <thead>
          <tr>
            <th>\u5730\u56fe</th>
            <th>\u5929\u6c14</th>
            <th>\u516c\u4f1a</th>
            <th>\u7cbe\u901a</th>
            <th>\u91d1\u5e01</th>
            <th>\u603b\u8ba1</th>
          </tr>
        </thead>
        <tbody>
    `;

    for (const d of state.biomeDetails) {
      const cls = [];
      if (d.isCurrent) cls.push('current');
      if (d.id === state.bestBiomeId) cls.push('best');
      const compMark = d.hasCompetition ? ' \u2693' : '';
      const goldMark = d.hasGoldWind ? ' \u{1fa99}' : '';
      const arcaneMark = d.hasArcane ? ' \u2726' : '';
      const goldPct = Math.round(d.goldScore * 100) + '%';
      const scorePct = Math.round(d.score * 100) + '%';
      html += `
        <tr class="${cls.join(' ')}">
          <td>${d.label} ${d.name}${compMark}${goldMark}${arcaneMark} <span style="color:${getThemeColors().textDim};font-size:10px;">${scorePct}</span></td>
          <td>${formatBonus(d.breakdown.weather)}</td>
          <td>${formatBonus(d.breakdown.guildTotem + d.breakdown.guildBoost)}</td>
          <td>${formatBonus(d.breakdown.mastery)}</td>
          <td>${goldPct}</td>
          <td><strong>${formatBonus(d.expBonus)}</strong></td>
        </tr>
      `;
    }

    html += `
        </tbody>
      </table>
      <div style="font-size:10px;color:${getThemeColors().textDim};margin-top:4px;">
        ⚓=赛事 | \u{1fa99}=金风(金币加成) | ✦=奥术涌动(经验+75%) | 公会=图腾+区域增益 | ${state.useNewScoring ? '金币=倍率×天气鱼系数' : '金币=编号权重(越大越高)'} | 名后数字=综合(${state.useNewScoring ? '0.55×经验+0.45×金币' : '0.6×经验+0.4×金币，金风额外金币+60%'}) | buff+天赋加成: ${formatBonus((state.biomeDetails[0]?.breakdown?.buffs || 0) + (state.biomeDetails[0]?.breakdown?.talents || 0))}
      </div>
    `;

    el.innerHTML = officialBanner + html;
  }

  function updateLogUI() {
    const el = document.getElementById('ramp-log');
    if (!el) return;

    if (state.logEntries.length === 0) {
      el.innerHTML = officialBanner + '<div style="color:' + getThemeColors().textDim + ';font-size:11px;padding:4px 0;">\u6682\u65e0\u65e5\u5fd7</div>';
      return;
    }

    let html = '';
    for (const entry of state.logEntries) {
      html += `
        <div class="ramp-log-entry ${entry.type}">
          <span class="ramp-log-time">${entry.time}</span>
          <span class="ramp-log-msg">${entry.message}</span>
        </div>
      `;
    }
    el.innerHTML = html;
  }

  // ==================== 优先级列表 ====================
  const PRIORITY_LABELS = {
    competition: '赛事地图',
    followboat: '跟随船',
    official: '官方航线',
    tempest: '雷暴地图',
    optimal: '优选',
    experience: '经验优选',
    goldwind: '金风天气',
    arcane: '奥术涌流天气',
  };

  // 按当前算法显示“优选”标签，反映评分口径
  function getOptimalLabel() {
    return state.useNewScoring ? '新优选(倍率×天气)' : '优选(编号即金币)';
  }

  function renderPriorityList() {
    const el = document.getElementById('ramp-priority-list');
    if (!el) return;
    let html = '';
    const total = state.mapPriority.length;
    state.mapPriority.forEach((key, i) => {
      const canUp = i > 0;
      const canDown = i < total - 1;
      const label = key === 'optimal' ? getOptimalLabel() : (PRIORITY_LABELS[key] || key);
      html += `
        <div class="ramp-priority-item" data-priority="${key}">
          <span class="ramp-priority-rank">${i + 1}</span>
          <span class="ramp-priority-label">${label}</span>
          <div class="ramp-priority-btns">
            <button class="ramp-priority-btn" data-action="up" data-index="${i}" ${canUp ? '' : 'disabled'} title="上移">↑</button>
            <button class="ramp-priority-btn" data-action="down" data-index="${i}" ${canDown ? '' : 'disabled'} title="下移">↓</button>
          </div>
        </div>
      `;
    });
    el.innerHTML = html;
    bindPriorityButtons();
  }

  function bindPriorityButtons() {
    const el = document.getElementById('ramp-priority-list');
    if (!el) return;
    el.querySelectorAll('.ramp-priority-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (btn.disabled) return;
        const action = btn.dataset.action;
        const index = parseInt(btn.dataset.index, 10);
        const newPriority = [...state.mapPriority];
        const targetIndex = action === 'up' ? index - 1 : index + 1;
        if (targetIndex < 0 || targetIndex >= newPriority.length) return;
        [newPriority[index], newPriority[targetIndex]] = [newPriority[targetIndex], newPriority[index]];
        state.mapPriority = newPriority;
        saveState();
        renderPriorityList();
      });
    });
  }

  // ==================== 鱼饵配置列表 ====================
  function renderBaitList() {
    const el = document.getElementById('ramp-bait-list');
    if (!el) return;
    let html = '';
    // 鱼饵配置：赛事/雷暴/优选 + 金风（金风天气专用，独立于优选）
    const priorityOrder = ['competition', 'tempest', 'optimal', 'goldwind', 'arcane'];
    for (const ptype of priorityOrder) {
      const selectedBaitId = state.baitMap[ptype] || '';
      // 构建鱼饵选项
      const options = ['<option value="">不切换</option>']
        .concat(BAIT_TIERS.map(t => {
          const sel = t.id === selectedBaitId ? ' selected' : '';
          return `<option value="${t.id}"${sel}>${t.name}</option>`;
        }))
        .join('');
      html += `
        <div class="ramp-bait-item" data-priority="${ptype}">
          <span class="ramp-bait-item-label">${PRIORITY_LABELS[ptype] || ptype}</span>
          <select class="ramp-bait-select" data-priority="${ptype}">${options}</select>
        </div>
      `;
    }
    el.innerHTML = html;
    bindBaitSelects();
  }

  function bindBaitSelects() {
    const el = document.getElementById('ramp-bait-list');
    if (!el) return;
    el.querySelectorAll('.ramp-bait-select').forEach(sel => {
      sel.addEventListener('change', (e) => {
        e.stopPropagation();
        const ptype = sel.dataset.priority;
        const baitId = sel.value;
        if (baitId) {
          state.baitMap[ptype] = baitId;
        } else {
          delete state.baitMap[ptype];
        }
        saveState();
        const baitName = baitId ? getBaitName(baitId) : '不切换';
        log(`鱼饵配置: ${PRIORITY_LABELS[ptype] || ptype} → ${baitName}`, 'info');
      });
    });
  }

  // ==================== 可折叠区域 ====================
  function applyCollapseState() {
    const prioritySection = document.getElementById('ramp-section-priority');
    const baitSection = document.getElementById('ramp-section-bait');
    if (prioritySection) {
      if (state.collapsedSections.priority) prioritySection.classList.add('collapsed');
      else prioritySection.classList.remove('collapsed');
    }
    if (baitSection) {
      if (state.collapsedSections.bait) baitSection.classList.add('collapsed');
      else baitSection.classList.remove('collapsed');
    }
  }

  function bindCollapseToggles() {
    const priorityHeader = document.getElementById('ramp-collapse-priority');
    const baitHeader = document.getElementById('ramp-collapse-bait');
    if (priorityHeader) {
      priorityHeader.addEventListener('click', (e) => {
        e.stopPropagation();
        state.collapsedSections.priority = !state.collapsedSections.priority;
        saveState();
        applyCollapseState();
      });
    }
    if (baitHeader) {
      baitHeader.addEventListener('click', (e) => {
        e.stopPropagation();
        state.collapsedSections.bait = !state.collapsedSections.bait;
        saveState();
        applyCollapseState();
      });
    }
  }

  // ==================== 页面切换 ====================
  function switchPage(page) {
    state.activePage = page;
    const tabStatus = document.getElementById('ramp-tab-status');
    const tabSettings = document.getElementById('ramp-tab-settings');
    const pageStatus = document.getElementById('ramp-page-status');
    const pageSettings = document.getElementById('ramp-page-settings');
    if (page === 'status') {
      if (tabStatus) tabStatus.classList.add('active');
      if (tabSettings) tabSettings.classList.remove('active');
      if (pageStatus) { pageStatus.classList.add('active'); pageStatus.style.display = 'block'; }
      if (pageSettings) { pageSettings.classList.remove('active'); pageSettings.style.display = 'none'; }
    } else {
      if (tabStatus) tabStatus.classList.remove('active');
      if (tabSettings) tabSettings.classList.add('active');
      if (pageStatus) { pageStatus.classList.remove('active'); pageStatus.style.display = 'none'; }
      if (pageSettings) { pageSettings.classList.add('active'); pageSettings.style.display = 'block'; }
    }
  }

  // ==================== 初始化 ====================
  async function init() {
    // 拦截赛事总览响应，缓存归属数据用于精准选图（须尽早装，覆盖游戏自身请求）
    installCompetitionOverviewInterceptor();

    // 拉取最新前端版本号（填充 x-frontend-version 头，与线上保持一致）
    refreshFrontendVersion();

    // 初始化游戏API（优先使用内存缓存，减少HTTP请求）
    await initGameApi();

    // 等待页面加载完成
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', createUI);
    } else {
      createUI();
    }
  }

  init();
})();

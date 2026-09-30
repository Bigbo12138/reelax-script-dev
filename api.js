// api.js —— 统一的 Reelax API 请求层（后台上下文）
//
// 所有对 reelax.cn 的请求都从这里走，业务模块（monitor.js 等）只调 ReelaxApi.*，
// 不再各自重复「取 proof + HMAC 签名 + 页面上下文执行」的逻辑。
//
// 为什么必须「页面上下文执行」：
//   服务端校验写操作请求来源必须是游戏页面（Referer=reelax.cn），background 直接
//   fetch 会被拒（VALIDATION_ERROR: 当前请求来源不受信任），所以用 tabs.executeScript
//   在 reelax 页面里完成 取proof + HMAC-SHA256 签名 + fetch，签名/幂等键/Content-Type
//   与前端点击完全一致。
//
// 用法：
//   const r = await ReelaxApi.playerStats();            // → { ok, player }
//   const r = await ReelaxApi.allocateStats({ strength:0, intelligence:10, luck:0, endurance:0 });
//   const r = await ReelaxApi.raw('/api/account', 'GET');
//
// 扩展背景脚本加载顺序（manifest.json）：background.js → domclick.js → api.js → bridge.js → monitor.js
// （domclick.js 先于 api.js 加载，post() 在写操作返回 INTERNAL_ERROR 时调用 DomFallback.onApiError）

const ReelaxApi = (() => {
  'use strict';

  const STAT_KEYS = ['strength', 'intelligence', 'luck', 'endurance'];

  function safeParseJSON(s) {
    if (s == null) return null;
    if (typeof s !== 'string') return s;
    try { return JSON.parse(s); } catch (_) { return null; }
  }

  // ---- 低层传输：把签名请求交给 reelax 页面的 content script 执行 ----
  // 原 Firefox 版：用 browser.tabs.executeScript 注入异步 IIFE 到页面拿结果；Chrome MV3
  // 的 chrome.scripting.executeScript 无法 await 注入函数的 Promise 返回，拿不到结果。
  // 改为：后台把 { type:'reelax-api', path, method, body } 通过 chrome.tabs.sendMessage
  // 发给页面 content script（injector.js 的驻留 handler），由它在页面上下文（同源
  // cookie + crypto.subtle）签名 fetch 并 sendResponse 返回 { ok, status, body }。
  // 依次向匹配的 reelax tab 发送，取第一个有响应的。
  async function pageSignedFetch(path, method, body) {
    try {
      const tabs = await browser.tabs.query({ url: '*://reelax.cn/*' });
      if (!tabs || !tabs.length) return { ok: false, error: 'no-tab' };
      const mtd = (method || 'GET').toUpperCase();
      const bodyPayload = (body === undefined || body === null) ? null : body;
      for (const t of tabs) {
        try {
          const r = await browser.tabs.sendMessage(t.id, {
            type: 'reelax-api',
            path,
            method: mtd,
            body: bodyPayload,
          });
          if (r && (r.ok !== undefined || r.status !== undefined || r.body !== undefined || r.error)) {
            return r;
          }
        } catch (e) {
          // 该 tab 未注入 handler（页面未加载/未匹配），尝试下一个
        }
      }
      return { ok: false, error: 'no-handler' };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  // GET 并解析 JSON → { ok, data } 或 { ok:false, error, status }
  async function getJSON(path) {
    const res = await pageSignedFetch(path, 'GET', null);
    if (!res || !res.ok) {
      return { ok: false, error: (res && res.error) || 'http', status: res ? res.status : null };
    }
    const data = safeParseJSON(res.body);
    if (data === null) return { ok: false, error: 'parse', body: res.body };
    return { ok: true, data };
  }

  // POST/PUT/DELETE 原始结果（含 Idempotency-Key，由页面上下文自动生成）
  // 注意：前端多数写接口（reset/claim/register-all）不带 body，传 undefined/null 则
  // 不带 Content-Type、不发 body，与前端一致（带 {} 会被部分接口校验拒绝）。
  async function post(path, body, method) {
    const r = await pageSignedFetch(path, method || 'POST', body === undefined ? null : body);
    // 兜底：写操作返回 INTERNAL_ERROR（"服务器暂时无法完成请求"）时，
    // 触发扩展后台 DomFallback 用页面 DOM 匹配按钮点击兜底（若映射表有对应规则）。
    // DomFallback 由 manifest 里先于本文件的 domclick.js 提供。
    if (r && !r.ok && r.body) {
      const parsed = safeParseJSON(r.body);
      if (parsed && parsed.error && parsed.error.code === 'INTERNAL_ERROR') {
        try {
          if (window.DomFallback && typeof window.DomFallback.onApiError === 'function') {
            // 不 await，后台异步兜底，不阻塞调用方
            window.DomFallback.onApiError({ path: path, method: method || 'POST', body: body, status: r.status, bodyText: r.body });
          }
        } catch (e) { /* 兜底失败不影响原结果 */ }
      }
    }
    return r;
  }

  // ---- 业务端点封装 ----

  // 玩家属性：{ ok, player }，player 含 unspentStatPoints / stats.base / stats.total
  async function playerStats() {
    const r = await getJSON('/api/player/stats');
    if (!r.ok) return r;
    if (!r.data || !r.data.player) return { ok: false, error: 'no-player' };
    return { ok: true, player: r.data.player };
  }

  // 市场订单查询（只读）：卖出侧装备挂单，支持按品级/部位/最高价/品质/强化筛。
  // 返回 { ok, data }，data.orders = [...]
  async function marketOrders(opts = {}) {
    const q = {};
    if (opts.assetType) q.assetType = opts.assetType;
    if (opts.side) q.side = opts.side;
    if (opts.rarities) q.rarities = Array.isArray(opts.rarities) ? opts.rarities.join(',') : String(opts.rarities);
    if (opts.maxPrice != null && opts.maxPrice > 0) q.maxPrice = opts.maxPrice;
    if (opts.minPrice != null && opts.minPrice > 0) q.minPrice = opts.minPrice;
    if (opts.slot) q.slot = opts.slot;
    if (opts.stat) q.stat = opts.stat;
    if (opts.minQuality != null && opts.minQuality > 0) q.minQuality = opts.minQuality;
    if (opts.minUpgrade != null && opts.minUpgrade > 0) q.minUpgradeLevel = opts.minUpgrade;
    if (opts.sort) q.sort = opts.sort;
    if (opts.direction) q.direction = opts.direction;
    if (opts.cursor) q.cursor = opts.cursor; // nextCursor 翻页（接口单页上限 100）
    q.limit = opts.limit || 20;
    const path = '/api/market/orders?' + Object.keys(q).map((k) => `${k}=${encodeURIComponent(q[k])}`).join('&');
    const r = await getJSON(path);
    if (!r.ok) return r;
    return { ok: true, data: r.data };
  }

  async function resetStats() {
    // 前端 reset 无 body（带 {} 会被服务器校验拒绝，导致重置失败、加点全进次要属性）
    return pageSignedFetch('/api/player/stats/reset', 'POST', null);
  }

  async function allocateStats(body) {
    return pageSignedFetch('/api/player/stats/allocate', 'POST', body);
  }

  // 公会赛总览（当前赛事：isRegistered / startAt / endAt 等）
  async function guildCompetitionOverview() {
    return getJSON('/api/guild-tournaments/overview');
  }

  // 个人赛总览
  async function tournamentOverview() {
    return getJSON('/api/tournaments/overview');
  }

  // 一键报名所有赛事（前端无 body）
  async function registerAllTournaments() {
    return post('/api/tournaments/register-all');
  }

  // 账户信息：{ email, serverTime }
  async function account() {
    return getJSON('/api/account');
  }

  // 出售装备（gearIds 取 /api/inventory/gear 返回的 id 数组；body: { gearIds: [...] }）
  async function sellGear(gearIds) {
    return post('/api/inventory/gear/sell', { gearIds: Array.isArray(gearIds) ? gearIds : [gearIds] });
  }

  // 鱼库存（/api/inventory/fish，单响应返回全部鱼；鱼在 data.fish[]，每项含 fishId/rarity/quantity/isLocked 等）
  async function inventoryFish(limit, cursor) {
    const q = [];
    if (limit != null) q.push('limit=' + limit);
    if (cursor) q.push('cursor=' + encodeURIComponent(cursor));
    return getJSON('/api/inventory/fish' + (q.length ? '?' + q.join('&') : ''));
  }

  // 卖鱼（body: { items: [{ fishId, quantity }, ...] }，与前端「出售当前筛选/全部出售」一致；
  // quantity 传该鱼种要卖出的条数，支持部分数量。幂等键由页面上下文自动生成）
  async function sellFish(items) {
    return post('/api/inventory/fish/sell', { items: Array.isArray(items) ? items : [] });
  }

  // 装备出售估价预览
  async function gearSalePreview() {
    return getJSON('/api/inventory/gear/sale-preview');
  }

  // 成就一键领取（前端无 body）
  async function achievementsClaimAll() {
    return post('/api/achievements/claim-all');
  }

  // 每日签到
  async function dailyCheckIn() {
    return getJSON('/api/daily-check-in');
  }
  // 签到领取（前端无 body）
  async function dailyCheckInClaim() {
    return post('/api/daily-check-in/claim');
  }

  // 任务列表
  async function quests() {
    return getJSON('/api/quests');
  }

  // 统计（保底等）
  async function statistics() {
    return pageSignedFetch('/api/statistics', 'GET');
  }

  // 自定义统计：开启一个统计窗口（body: { durationHours }，幂等）
  // 前端：POST /api/fishing/custom-statistics/start  body {durationHours:N}
  async function customStatisticsStart(durationHours) {
    return post('/api/fishing/custom-statistics/start', { durationHours: durationHours || 8 });
  }

  // 自定义统计历史（列表：{ items:[{id,durationHours,startedAt,scheduledEndAt,status,harvest}] }）
  async function customStatisticsHistory() {
    return getJSON('/api/fishing/custom-statistics/history');
  }

  // 自定义统计单窗口详情（含 harvest: casts/fishByRarity/gear/chests/relics/gold）
  async function customStatisticsDetail(id) {
    return getJSON('/api/fishing/custom-statistics/' + encodeURIComponent(id));
  }

  // 专精贡献
  async function contributeMastery(mapId) {
    return pageSignedFetch(`/api/mastery/${mapId}/contribute-all`, 'POST', null);
  }

  // 奥术献祭活动总览（目标分/轮次/今日贡献/可用资产）
  async function arcaneSacrificeOverview() {
    return getJSON('/api/events/arcane-sacrifice');
  }

  // 奥术献祭贡献（body: {resourceType:'relic'|'fish'|'gold', rarity?, quantity}）
  // fish 需带 rarity(common/uncommon/fine/rare/epic)；gold/relic 只需 quantity。
  // 接口幂等（自动带 idempotency-key）。
  async function arcaneSacrificeContribute(body) {
    return post('/api/events/arcane-sacrifice/contributions', body);
  }

  // 世界Boss总览（当前场次：status/boss 弱点防御/我的已选属性 selectedStat/isLocked 等）
  async function worldBossOverview() {
    return getJSON('/api/events/world-boss');
  }

  // 世界Boss报名/改选攻击属性（body: {stat:'strength'|'intelligence'|'luck'|'endurance'}）
  // 报名后第一次攻击前可改；第一次攻击后 isLocked=true 无法再改。
  async function worldBossSelect(stat) {
    return post('/api/events/world-boss/selection', { stat: stat });
  }

  // 公会区域增益总览：GET /api/guilds/me/boosts
  // 返回 data.boosts[]，每项 { biomeId, isActive, startsAt, endsAt, memberCount, ... }，
  // 用 biomeId 区分地图（如 b_010=沉钟古港）。
  async function guildBoosts() {
    return getJSON('/api/guilds/me/boosts');
  }

  // 购买/开启/延长公会区域增益：POST /api/guilds/me/boosts/{biomeId}
  // biomeId: 地图ID（如 'b_010' 沉钟古港）；units: 购买份数（1 份 = unitDurationMinutes 分钟）。
  // 该地图无增益时=开启，已有增益时=延长；购买后立即更新该地图正在运行的公会钓鱼批次。
  // 幂等（自动带 idempotency-key）。
  async function guildBoostPurchase(biomeId, units) {
    return post('/api/guilds/me/boosts/' + biomeId, { units: units });
  }

  // 公会总览：聚合 公会信息 + 各地图公会增益 + 各地图人数分布，一次拿到看板所需数据。
  // 内部并发请求三个只读接口，单个失败不拖垮整体（对应字段置 null）。
  // 返回 { ok, guild, boosts, biomes, boostMeta, maps, activeBoost, serverTime }
  //   guild      : 公会信息（name/level/taxRate/treasuryGold/memberCount/memberCapacity/...）
  //   boosts     : /api/guilds/me/boosts 的 data.boosts[]（各地图 memberCount/isActive/endsAt）
  //   biomes     : /api/biomes 的 data.biomes[]（id/name/fishingCount/guildBoostEndsAt/weather）
  //   boostMeta  : 增益单价/时长/上限 { unitCost, unitDurationMinutes, maxUnits }
  //   maps       : 按 biomeId 合并后的地图看板 [{ biomeId, name, memberCount, isActive,
  //                boostStartsAt, boostEndsAt, fishingCount, weather }]（按 memberCount 降序）
  //   activeBoost: 当前有活跃增益的地图（null 则无）
  async function guildOverview() {
    const [guildRes, boostsRes, biomesRes] = await Promise.all([
      getJSON('/api/guilds/me'),
      getJSON('/api/guilds/me/boosts'),
      getJSON('/api/biomes'),
    ]);

    const guild = (guildRes && guildRes.ok && guildRes.data && guildRes.data.guild) ? guildRes.data.guild : null;
    const boosts = (boostsRes && boostsRes.ok && boostsRes.data && Array.isArray(boostsRes.data.boosts))
      ? boostsRes.data.boosts : null;
    const biomes = (biomesRes && biomesRes.ok && biomesRes.data && Array.isArray(biomesRes.data.biomes))
      ? biomesRes.data.biomes : null;
    const boostMeta = (boostsRes && boostsRes.ok && boostsRes.data)
      ? { unitCost: boostsRes.data.unitCost, unitDurationMinutes: boostsRes.data.unitDurationMinutes, maxUnits: boostsRes.data.maxUnits }
      : null;

    // biomeId → 地图名（来自 /api/biomes）
    const nameById = {};
    if (biomes) { for (const b of biomes) { if (b && b.id) nameById[b.id] = b.name; } }

    // 天气剩余时长（分钟）：用 startsAt/endsAt 算；无天气或已结束返回 0。
    // 基准时间优先用服务器时间（biomes 响应的 serverTime），否则本地时间。
    const serverNow = (biomesRes && biomesRes.ok && biomesRes.data && biomesRes.data.serverTime)
      ? Date.parse(biomesRes.data.serverTime) : Date.now();
    function weatherRemainingMin(w) {
      // 字段名注意：天气用的是 startedAt（过去式），这里兼容两种命名。
      if (!w || !w.endsAt) return null;
      const end = Date.parse(w.endsAt);
      if (!Number.isFinite(end)) return null;
      return Math.max(0, Math.round((end - serverNow) / 60000));
    }

    // 合并：以 boosts 为主线，补充地图名 / 全服钓鱼人数 / 天气
    let maps = [];
    let currentBiome = null;
    if (boosts) {
      maps = boosts.map(function (bo) {
        const bio = biomes ? (biomes.find(function (x) { return x.id === bo.biomeId; }) || null) : null;
        const weather = bio && bio.weather ? bio.weather : null;
        return {
          biomeId: bo.biomeId,
          name: nameById[bo.biomeId] || bo.biomeId,
          memberCount: bo.memberCount != null ? bo.memberCount : (bio ? bio.memberCount : null),
          isActive: bo.isActive === true,
          isQueued: bo.isQueued === true,
          boostStartsAt: bo.startsAt || null,
          boostEndsAt: bo.endsAt || (bio ? (bio.guildBoostEndsAt || null) : null),
          fishingCount: bio && bio.fishingCount ? bio.fishingCount : null,
          weather: weather,
          weatherRemainingMin: weatherRemainingMin(weather), // 天气剩余分钟（null=无天气）
        };
      });
      // 按公会成员在该地图钓的人数降序
      maps.sort(function (a, b) { return (b.memberCount || 0) - (a.memberCount || 0); });
      // 当前所在地图（biomes 的 isCurrent=true）
      const curBio = biomes ? (biomes.find(function (x) { return x.isCurrent === true; }) || null) : null;
      if (curBio) {
        const curWeather = curBio.weather || null;
        currentBiome = {
          biomeId: curBio.id,
          name: nameById[curBio.id] || curBio.id,
          isCurrent: true,
          weather: curWeather,
          weatherRemainingMin: weatherRemainingMin(curWeather), // 当前地图天气剩余分钟
          guildBoostEndsAt: curBio.guildBoostEndsAt || null,
          fishingCount: curBio.fishingCount || null,
        };
      }
    }

    const activeBoost = boosts ? (boosts.find(function (b) { return b.isActive === true; }) || null) : null;

    return {
      ok: !!(guild || boosts || biomes),
      guild: guild,
      boosts: boosts,
      biomes: biomes,
      boostMeta: boostMeta,
      maps: maps,
      currentBiome: currentBiome, // 当前所在地图 + 天气剩余时长
      activeBoost: activeBoost ? {
        biomeId: activeBoost.biomeId,
        name: nameById[activeBoost.biomeId] || activeBoost.biomeId,
        memberCount: activeBoost.memberCount,
        startsAt: activeBoost.startsAt,
        endsAt: activeBoost.endsAt,
      } : null,
    };
  }

  // 万能入口
  async function raw(path, method, body) {
    return pageSignedFetch(path, method || 'GET', body === undefined ? null : body);
  }

  return {
    STAT_KEYS,
    safeParseJSON,
    pageSignedFetch,
    getJSON,
    post,
    playerStats,
    resetStats,
    allocateStats,
    guildCompetitionOverview,
    tournamentOverview,
    registerAllTournaments,
    account,
    sellGear,
    inventoryFish,
    sellFish,
    gearSalePreview,
    marketOrders,
    achievementsClaimAll,
    dailyCheckIn,
    dailyCheckInClaim,
    quests,
    statistics,
    contributeMastery,
    customStatisticsStart,
    customStatisticsHistory,
    customStatisticsDetail,
    arcaneSacrificeOverview,
    arcaneSacrificeContribute,
    worldBossOverview,
    worldBossSelect,
    guildBoosts,
    guildBoostPurchase,
    guildOverview,
    raw,
  };
})();

// 显式挂到 window，供后续加载的后台脚本（monitor.js 等）直接使用
window.ReelaxApi = ReelaxApi;

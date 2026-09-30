// market_events.js —— 市场实时行情采集（交易大屏数据源）🍊
// 注入游戏页面主世界，订阅 market SSE，把事件经 postMessage → bridge → ws_bridge(55004) 转发给大屏。
//
// 全量利用 SSE：
//   1. fishIds 盘口订阅  → order-book-updated（背包鱼完整买卖盘口，多价位）
//   2. 低价鱼监控        → listing-created（低价鱼新挂单）
//   3. 低价装备监控      → listing-created（低价装备新挂单）
(() => {
  'use strict';
  if (window.__reelaxMarketStarted) return;
  window.__reelaxMarketStarted = true;

  const CONFIG = {
    fishMultiplier: 2.0,   // 低价鱼监控：回收价 ≤2.0 倍
    gearMultiplier: 1.5,   // 低价装备监控：回收价 ≤1.5 倍
    maxFishIdsPerConn: 20, // 每条 fishIds 连接最多鱼数
    maxEvents: 800,        // 页面缓冲上限
  };

  let stopFishOrder = null;
  let stopFishLow = null;
  let stopGearLow = null;
  let buffer = [];
  let hasFishIds = false;
  let status = { connected: false, startedAt: null, err: null, fishEvents: 0, gearEvents: 0, orderEvents: 0, mode: 'fishIds+low' };

  function post(type, data) {
    try { window.postMessage({ __reelaxMarketEvent: true, type, data }, '*'); } catch (e) {}
  }

  // 订阅盘口（order-book-updated）
  function subscribeOrderBook(game, ids){
    if(stopFishOrder || !ids || !ids.length) return;
    const orderIds = ids.slice(0, CONFIG.maxFishIdsPerConn);
    try {
      stopFishOrder = game.market.subscribeFish({ fishIds: orderIds }, (ev) => {
        status.orderEvents += 1;
        if (buffer.length < CONFIG.maxEvents) buffer.push({ src: 'fish', kind: 'order', at: Date.now(), ev });
        post('event', { src: 'fish', kind: 'order', at: Date.now(), ev });
      });
      status.fishIdCount = orderIds.length;
      hasFishIds = true;
      post('status', { ...status });
    } catch(e){ status.err = '盘口订阅失败: '+String(e); post('status',{...status}); }
  }

  async function start() {
    let game;
    try {
      game = window.arcaneReelax;
      await game.ready;
    } catch (e) {
      status.err = 'arcaneReelax 不可用: ' + String(e);
      post('status', { ...status });
      return;
    }
    try {
      // 盘口订阅：优先用 injector 注入的 window.__reelaxFishIds
      const injected = window.__reelaxFishIds;
      if(Array.isArray(injected) && injected.length){
        subscribeOrderBook(game, injected);
      }

      // 低价鱼监控（listing-created）
      stopFishLow = game.market.subscribeFish({ maxShopPriceMultiplier: CONFIG.fishMultiplier }, (ev) => {
        status.fishEvents += 1;
        if (buffer.length < CONFIG.maxEvents) buffer.push({ src: 'fish', kind: 'low', at: Date.now(), ev });
        post('event', { src: 'fish', kind: 'low', at: Date.now(), ev });
      });

      // 低价装备监控（listing-created）
      stopGearLow = game.market.subscribeGear({ maxShopPriceMultiplier: CONFIG.gearMultiplier }, (ev) => {
        status.gearEvents += 1;
        if (buffer.length < CONFIG.maxEvents) buffer.push({ src: 'gear', kind: 'low', at: Date.now(), ev });
        post('event', { src: 'gear', kind: 'low', at: Date.now(), ev });
      });

      status.connected = true;
      status.startedAt = Date.now();
      post('status', { ...status });
      post('ready', { connected: true });
    } catch (e) {
      status.err = String(e);
      post('status', { ...status });
    }
  }

  // 监听 injector 注入的背包鱼 fishId，收到后补订阅盘口
  window.addEventListener('message', (ev) => {
    const d = ev.data;
    if (d && d.__reelaxFishIds && Array.isArray(d.__reelaxFishIds) && !hasFishIds && window.arcaneReelax){
      subscribeOrderBook(window.arcaneReelax, d.__reelaxFishIds);
    }
  });

  window.__reelaxMarketCtrl = {
    start,
    stop() { try{stopFishOrder&&stopFishOrder();}catch(e){} try{stopFishLow&&stopFishLow();}catch(e){} try{stopGearLow&&stopGearLow();}catch(e){} status.connected=false; post('status',{...status}); },
    getStatus: () => ({ ...status }),
    getBuffer: () => buffer.slice(),
    setFishIds: (ids)=>{ if(window.arcaneReelax) subscribeOrderBook(window.arcaneReelax, ids); },
  };

  start();
})();
